export type ProjectTaskHealth = Readonly<{
  activeJobs: number;
  recoverableQueuedProjectAnalysis: number;
  unrecoverableStaleQueuedProjectAnalysis: number;
  staleRunningJobs: number;
  waitingProviderJobs: number;
  oldestActiveAt: string | null;
}>;

export type ProjectAnalysisRecovery = Readonly<{
  rearm(input: Readonly<{
    workerId: string;
    staleBefore: Date;
    limit: number;
  }>): Promise<number>;
  health(staleBefore: Date): Promise<ProjectTaskHealth>;
}>;

export type ProjectAnalysisRecoveryQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.length > 0 ? value : null;
}

function taskHealth(row: Record<string, unknown> | undefined): ProjectTaskHealth {
  return Object.freeze({
    activeJobs: count(row?.activeJobs),
    recoverableQueuedProjectAnalysis: count(
      row?.recoverableQueuedProjectAnalysis,
    ),
    unrecoverableStaleQueuedProjectAnalysis: count(
      row?.unrecoverableStaleQueuedProjectAnalysis,
    ),
    staleRunningJobs: count(row?.staleRunningJobs),
    waitingProviderJobs: count(row?.waitingProviderJobs),
    oldestActiveAt: timestamp(row?.oldestActiveAt),
  });
}

const scopedHealthSql = `
  WITH active AS (
    SELECT
      job.*,
      (
        job.source_object_type = 'project-context-snapshot'
        AND source.id IS NOT NULL
        AND (
          source.id,
          source.snapshot_version
        ) = (
          latest.id,
          latest.snapshot_version
        )
        AND event.status = 'published'
        AND CASE
          WHEN event.payload->>'snapshotVersion' ~ '^[1-9][0-9]*$'
            THEN (event.payload->>'snapshotVersion')::numeric =
              source.snapshot_version
          ELSE false
        END
      ) AS has_recoverable_event
      FROM backlink_jobs AS job
      LEFT JOIN backlink_project_context_snapshots AS source
        ON (
          source.organization_id,
          source.workspace_id,
          source.website_project_id,
          source.id
        ) = (
          job.organization_id,
          job.workspace_id,
          job.website_project_id,
          job.source_object_id
        )
      LEFT JOIN LATERAL (
        SELECT snapshot.id, snapshot.snapshot_version
          FROM backlink_project_context_snapshots AS snapshot
         WHERE (
           snapshot.organization_id,
           snapshot.workspace_id,
           snapshot.website_project_id
         ) = (
           job.organization_id,
           job.workspace_id,
           job.website_project_id
         )
         ORDER BY snapshot.snapshot_version DESC,
                  snapshot.created_at DESC,
                  snapshot.id DESC
         LIMIT 1
      ) AS latest ON true
      LEFT JOIN LATERAL (
        SELECT outbox.status, outbox.payload
          FROM backlink_outbox_events AS outbox
         WHERE (
           outbox.organization_id,
           outbox.workspace_id,
           outbox.website_project_id
         ) = (
           job.organization_id,
           job.workspace_id,
           job.website_project_id
         )
           AND outbox.event_type =
             'backlinks.project-analysis.requested.v1'
           AND outbox.payload->>'jobId' = job.id::text
           AND outbox.payload->>'workflowId' = job.workflow_id
         ORDER BY outbox.created_at DESC, outbox.id DESC
         LIMIT 1
      ) AS event ON true
     WHERE job.status IN ('queued', 'running', 'waiting_provider')
  )
  SELECT
    count(*)::integer AS "activeJobs",
    count(*) FILTER (
      WHERE job_type = 'project-analysis'
        AND status = 'queued'
        AND updated_at <= $1
        AND has_recoverable_event
    )::integer AS "recoverableQueuedProjectAnalysis",
    count(*) FILTER (
      WHERE job_type = 'project-analysis'
        AND status = 'queued'
        AND updated_at <= $1
        AND NOT has_recoverable_event
    )::integer AS "unrecoverableStaleQueuedProjectAnalysis",
    count(*) FILTER (
      WHERE status = 'running'
        AND updated_at <= $1
    )::integer AS "staleRunningJobs",
    count(*) FILTER (
      WHERE status = 'waiting_provider'
    )::integer AS "waitingProviderJobs",
    min(updated_at) AS "oldestActiveAt"
  FROM active`;

export function createGlobalProjectAnalysisRecovery(
  client: ProjectAnalysisRecoveryQueryClient,
): ProjectAnalysisRecovery {
  return Object.freeze({
    async rearm(input) {
      const result = await client.query(
        `SELECT backlink_rearm_stale_project_analysis_events(
           $1,$2,$3
         ) AS "rearmedCount"`,
        [input.workerId, input.staleBefore, input.limit],
      );
      return count(result.rows[0]?.rearmedCount);
    },
    async health(staleBefore) {
      const result = await client.query(
        `SELECT
           active_jobs AS "activeJobs",
           recoverable_queued_project_analysis AS
             "recoverableQueuedProjectAnalysis",
           unrecoverable_stale_queued_project_analysis AS
             "unrecoverableStaleQueuedProjectAnalysis",
           stale_running_jobs AS "staleRunningJobs",
           waiting_provider_jobs AS "waitingProviderJobs",
           oldest_active_at AS "oldestActiveAt"
         FROM backlink_project_task_runtime_health($1)`,
        [staleBefore],
      );
      return taskHealth(result.rows[0]);
    },
  });
}

export function createScopedProjectAnalysisRecovery(
  client: ProjectAnalysisRecoveryQueryClient,
): ProjectAnalysisRecovery {
  return Object.freeze({
    async rearm(input) {
      await client.query(
        `WITH candidates AS (
           SELECT
             job.organization_id,
             job.workspace_id,
             job.website_project_id,
             job.id AS job_id,
             job.source_object_type,
             source.id AS source_snapshot_id,
             source.snapshot_version AS source_snapshot_version,
             latest.id AS latest_snapshot_id,
             latest.snapshot_version AS latest_snapshot_version,
             event.id AS event_id,
             event.status AS event_status,
             event.payload->>'snapshotVersion' AS event_snapshot_version
             FROM backlink_jobs AS job
             LEFT JOIN backlink_project_context_snapshots AS source
               ON (
                 source.organization_id,
                 source.workspace_id,
                 source.website_project_id,
                 source.id
               ) = (
                 job.organization_id,
                 job.workspace_id,
                 job.website_project_id,
                 job.source_object_id
               )
             LEFT JOIN LATERAL (
               SELECT snapshot.id, snapshot.snapshot_version
                 FROM backlink_project_context_snapshots AS snapshot
                WHERE (
                  snapshot.organization_id,
                  snapshot.workspace_id,
                  snapshot.website_project_id
                ) = (
                  job.organization_id,
                  job.workspace_id,
                  job.website_project_id
                )
                ORDER BY snapshot.snapshot_version DESC,
                         snapshot.created_at DESC,
                         snapshot.id DESC
                LIMIT 1
             ) AS latest ON true
             LEFT JOIN LATERAL (
               SELECT outbox.id, outbox.status, outbox.payload
                 FROM backlink_outbox_events AS outbox
                WHERE (
                  outbox.organization_id,
                  outbox.workspace_id,
                  outbox.website_project_id
                ) = (
                  job.organization_id,
                  job.workspace_id,
                  job.website_project_id
                )
                  AND outbox.event_type =
                    'backlinks.project-analysis.requested.v1'
                  AND outbox.payload->>'jobId' = job.id::text
                  AND outbox.payload->>'workflowId' = job.workflow_id
                ORDER BY outbox.created_at DESC, outbox.id DESC
                LIMIT 1
             ) AS event ON true
            WHERE job.job_type = 'project-analysis'
              AND job.status = 'queued'
              AND job.updated_at <= $1
            ORDER BY job.updated_at, job.id
            FOR UPDATE OF job SKIP LOCKED
            LIMIT $2
         ),
         classified AS (
           SELECT candidate.*,
             CASE
               WHEN candidate.source_object_type <>
                 'project-context-snapshot'
                 THEN 'BACKLINK_PROJECT_CONTEXT_SOURCE_TYPE_INVALID'
               WHEN candidate.source_snapshot_id IS NULL
                 THEN 'BACKLINK_PROJECT_CONTEXT_SNAPSHOT_NOT_FOUND'
               WHEN candidate.latest_snapshot_id IS NULL
                 THEN 'BACKLINK_PROJECT_CONTEXT_SNAPSHOT_NOT_FOUND'
               WHEN candidate.event_id IS NULL
                 THEN 'BACKLINK_PROJECT_ANALYSIS_EVENT_NOT_FOUND'
               WHEN candidate.event_status = 'failed'
                 THEN 'BACKLINK_PROJECT_ANALYSIS_EVENT_FAILED'
               WHEN NOT (
                 CASE
                   WHEN candidate.event_snapshot_version ~
                     '^[1-9][0-9]*$'
                     THEN candidate.event_snapshot_version::numeric =
                       candidate.source_snapshot_version
                   ELSE false
                 END
               )
                 THEN 'BACKLINK_PROJECT_CONTEXT_EVENT_VERSION_INVALID'
               WHEN (
                 candidate.source_snapshot_id,
                 candidate.source_snapshot_version
               ) <> (
                 candidate.latest_snapshot_id,
                 candidate.latest_snapshot_version
               )
                 THEN 'BACKLINK_PROJECT_CONTEXT_SNAPSHOT_SUPERSEDED'
               ELSE NULL
             END AS close_code
             FROM candidates AS candidate
         )
         UPDATE backlink_jobs AS job
            SET status = CASE
                  WHEN classified.close_code =
                    'BACKLINK_PROJECT_CONTEXT_SNAPSHOT_SUPERSEDED'
                    THEN 'cancelled'
                  ELSE 'failed'
                END,
                step = CASE
                  WHEN classified.close_code =
                    'BACKLINK_PROJECT_CONTEXT_SNAPSHOT_SUPERSEDED'
                    THEN 'superseded_project_context'
                  ELSE 'project_context_snapshot_invalid'
                END,
                progress = 100,
                result_summary = jsonb_strip_nulls(jsonb_build_object(
                  'outcome', CASE
                    WHEN classified.close_code =
                      'BACKLINK_PROJECT_CONTEXT_SNAPSHOT_SUPERSEDED'
                      THEN 'superseded'
                    ELSE 'input_invalid'
                  END,
                  'requestedSnapshotVersion',
                    classified.event_snapshot_version,
                  'sourceSnapshotId',
                    classified.source_snapshot_id,
                  'sourceSnapshotVersion',
                    classified.source_snapshot_version,
                  'authoritativeSnapshotId',
                    classified.latest_snapshot_id,
                  'authoritativeSnapshotVersion',
                    classified.latest_snapshot_version
                )),
                error = CASE
                  WHEN classified.close_code =
                    'BACKLINK_PROJECT_CONTEXT_SNAPSHOT_SUPERSEDED'
                    THEN NULL
                  ELSE jsonb_build_object(
                    'code', classified.close_code,
                    'retryable', false
                  )
                END,
                finished_at = now(),
                version = job.version + 1,
                updated_at = now(),
                updated_by = $3
           FROM classified
          WHERE classified.close_code IS NOT NULL
            AND (
              job.organization_id,
              job.workspace_id,
              job.website_project_id,
              job.id
            ) = (
              classified.organization_id,
              classified.workspace_id,
              classified.website_project_id,
              classified.job_id
            )`,
        [input.staleBefore, input.limit, input.workerId],
      );
      const result = await client.query(
        `WITH candidates AS (
           SELECT event.id AS event_id, job.id AS job_id
             FROM backlink_jobs AS job
             JOIN backlink_project_context_snapshots AS source
               ON (
                 source.organization_id,
                 source.workspace_id,
                 source.website_project_id,
                 source.id
               ) = (
                 job.organization_id,
                 job.workspace_id,
                 job.website_project_id,
                 job.source_object_id
               )
             JOIN LATERAL (
               SELECT snapshot.id, snapshot.snapshot_version
                 FROM backlink_project_context_snapshots AS snapshot
                WHERE (
                  snapshot.organization_id,
                  snapshot.workspace_id,
                  snapshot.website_project_id
                ) = (
                  job.organization_id,
                  job.workspace_id,
                  job.website_project_id
                )
                ORDER BY snapshot.snapshot_version DESC,
                         snapshot.created_at DESC,
                         snapshot.id DESC
                LIMIT 1
             ) AS latest
               ON (
                 latest.id,
                 latest.snapshot_version
               ) = (
                 source.id,
                 source.snapshot_version
               )
             JOIN backlink_outbox_events AS event
               ON (
                 event.organization_id,
                 event.workspace_id,
                 event.website_project_id
               ) = (
                 job.organization_id,
                 job.workspace_id,
                 job.website_project_id
               )
              AND event.event_type =
                'backlinks.project-analysis.requested.v1'
              AND event.payload->>'jobId' = job.id::text
              AND event.payload->>'workflowId' = job.workflow_id
            WHERE job.job_type = 'project-analysis'
              AND job.source_object_type = 'project-context-snapshot'
              AND job.status = 'queued'
              AND job.updated_at <= $1
              AND event.status = 'published'
              AND CASE
                WHEN event.payload->>'snapshotVersion' ~ '^[1-9][0-9]*$'
                  THEN (event.payload->>'snapshotVersion')::numeric =
                    source.snapshot_version
                ELSE false
              END
            ORDER BY job.updated_at, job.id
            FOR UPDATE OF job, event SKIP LOCKED
            LIMIT $2
         ),
         rearmed AS (
           UPDATE backlink_outbox_events AS event
              SET status = 'pending',
                  available_at = now(),
                  claimed_at = NULL,
                  claimed_by = NULL,
                  published_at = NULL,
                  updated_at = now(),
                  updated_by = $3
             FROM candidates
            WHERE event.id = candidates.event_id
           RETURNING candidates.job_id
         )
         UPDATE backlink_jobs AS job
            SET step = 'recovery_queued',
                retry_count = job.retry_count + 1,
                version = job.version + 1,
                updated_at = now(),
                updated_by = $3
           FROM rearmed
          WHERE job.id = rearmed.job_id
        RETURNING job.id`,
        [input.staleBefore, input.limit, input.workerId],
      );
      return result.rows.length;
    },
    async health(staleBefore) {
      const result = await client.query(scopedHealthSql, [staleBefore]);
      return taskHealth(result.rows[0]);
    },
  });
}

export function combineProjectTaskHealth(
  snapshots: readonly ProjectTaskHealth[],
): ProjectTaskHealth {
  const oldest = snapshots
    .map((snapshot) => snapshot.oldestActiveAt)
    .filter((value): value is string => value !== null)
    .sort()[0] ?? null;
  return Object.freeze({
    activeJobs: snapshots.reduce((sum, item) => sum + item.activeJobs, 0),
    recoverableQueuedProjectAnalysis: snapshots.reduce(
      (sum, item) => sum + item.recoverableQueuedProjectAnalysis,
      0,
    ),
    unrecoverableStaleQueuedProjectAnalysis: snapshots.reduce(
      (sum, item) => sum + item.unrecoverableStaleQueuedProjectAnalysis,
      0,
    ),
    staleRunningJobs: snapshots.reduce(
      (sum, item) => sum + item.staleRunningJobs,
      0,
    ),
    waitingProviderJobs: snapshots.reduce(
      (sum, item) => sum + item.waitingProviderJobs,
      0,
    ),
    oldestActiveAt: oldest,
  });
}
