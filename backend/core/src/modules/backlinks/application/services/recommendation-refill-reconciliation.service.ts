import {
  withBacklinkTenantTransaction,
  type BacklinkTenantContext,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";

export type RecommendationRefillWorkflowState =
  | "running"
  | "closed"
  | "missing"
  | "unknown";

export type RecommendationRefillWorkflowProbe = Readonly<{
  inspect(workflowId: string): Promise<RecommendationRefillWorkflowState>;
}>;

export type RecommendationRefillReconciliationMode = "dry-run" | "apply";

export type RecommendationRefillReconciliationEntry = Readonly<{
  websiteProjectId: string;
  projectContextVersionId: string;
  state: "running";
  reason:
    | "LIVE_JOB"
    | "PENDING_WORKFLOW_START"
    | "LIVE_PROVIDER_LEASE"
    | "PROVIDER_SIDE_EFFECT"
    | "LIVE_WORKFLOW"
    | "WORKFLOW_LIVENESS_UNKNOWN"
    | "NO_LIVE_JOB_WORKFLOW_OR_LEASE";
  plannedAction: "NO_CHANGE" | "RESET_RUNNING_TO_IDLE";
  applied: boolean;
}>;

export type RecommendationRefillReconciliationResult = Readonly<{
  mode: RecommendationRefillReconciliationMode;
  scannedRunningCount: number;
  projectCount: number;
  plannedChangeCount: number;
  appliedChangeCount: number;
  entries: readonly RecommendationRefillReconciliationEntry[];
}>;

type WorkflowExecution = Readonly<{
  jobId: string;
  workflowId: string;
  status: string;
}>;

type RunningState = Readonly<{
  websiteProjectId: string;
  projectContextVersionId: string;
  workflowExecutions: readonly WorkflowExecution[];
  hasPendingOutbox: boolean;
  hasLiveLease: boolean;
  hasProviderSideEffect: boolean;
}>;

const reconciliationLockSql =
  `SELECT pg_advisory_xact_lock(
     hashtextextended($1::uuid::text||':'||$2::uuid::text||
       ':recommendation-refill-reconcile',0)
   )`;

const runningStatesSql =
  `WITH candidate_contexts AS (
     SELECT policy.website_project_id,
            policy.project_context_version_id
       FROM backlink_commercial_inventory_policies AS policy
      WHERE (policy.organization_id,policy.workspace_id,
             policy.website_project_id)=($4,$1,$2)
        AND policy.refill_state='running'
     UNION
     SELECT job.website_project_id,job.source_object_id
       FROM backlink_jobs AS job
      WHERE (job.organization_id,job.workspace_id,
             job.website_project_id)=($4,$1,$2)
        AND job.job_type='recommendation_refill'
        AND job.source_object_type='recommendation_context'
        AND job.status IN ('queued','running','waiting_provider')
   )
   SELECT candidate.website_project_id "websiteProjectId",
          candidate.project_context_version_id "projectContextVersionId",
          COALESCE((
            SELECT jsonb_agg(
                     jsonb_build_object(
                       'jobId',job.id::text,
                       'workflowId',job.workflow_id,
                       'status',job.status
                     )
                     ORDER BY job.created_at DESC
                   )
              FROM backlink_jobs AS job
             WHERE (job.organization_id,job.workspace_id,
                    job.website_project_id)=
                   ($4,$1,candidate.website_project_id)
               AND job.job_type='recommendation_refill'
               AND job.source_object_type='recommendation_context'
               AND job.source_object_id=
                   candidate.project_context_version_id
          ),'[]'::jsonb) "workflowExecutions",
          EXISTS (
            SELECT 1
              FROM backlink_jobs AS job
              JOIN backlink_outbox_events AS event
                ON (event.organization_id,event.workspace_id,
                    event.website_project_id,event.aggregate_id)=
                   (job.organization_id,job.workspace_id,
                    job.website_project_id,job.id)
               AND event.event_type=
                   'backlinks.recommendation-refill.requested.v1'
             WHERE (job.organization_id,job.workspace_id,
                    job.website_project_id)=
                   ($4,$1,candidate.website_project_id)
               AND job.job_type='recommendation_refill'
               AND job.source_object_type='recommendation_context'
               AND job.source_object_id=
                   candidate.project_context_version_id
               AND event.status IN ('pending','processing')
          ) "hasPendingOutbox",
          EXISTS (
            SELECT 1
              FROM backlink_jobs AS job
              JOIN backlink_recommendation_refills AS refill
                ON (refill.organization_id,refill.workspace_id,
                    refill.website_project_id,refill.job_id)=
                   (job.organization_id,job.workspace_id,
                    job.website_project_id,job.id)
              JOIN provider_fetch_leases AS lease
                ON lease.owner_request_id LIKE refill.refill_window_key||':%'
             WHERE (job.organization_id,job.workspace_id,
                    job.website_project_id)=
                   ($4,$1,candidate.website_project_id)
               AND job.job_type='recommendation_refill'
               AND job.source_object_type='recommendation_context'
               AND job.source_object_id=
                   candidate.project_context_version_id
               AND job.status IN ('queued','running','waiting_provider')
               AND lease.status='acquired'
               AND lease.lease_expires_at>$3
          ) "hasLiveLease",
          (
            EXISTS (
              SELECT 1
                FROM backlink_jobs AS job
                JOIN backlink_recommendation_refills AS refill
                  ON (refill.organization_id,refill.workspace_id,
                      refill.website_project_id,refill.job_id)=
                     (job.organization_id,job.workspace_id,
                      job.website_project_id,job.id)
                JOIN backlink_provider_usage_ledger AS usage
                  ON (usage.organization_id,usage.workspace_id,
                      usage.website_project_id)=
                     (job.organization_id,job.workspace_id,
                      job.website_project_id)
                 AND usage.provider='dataforseo'
                 AND usage.reservation_key LIKE
                     refill.refill_window_key||':%'
                 AND usage.status='reserved'
               WHERE (job.organization_id,job.workspace_id,
                      job.website_project_id)=
                     ($4,$1,candidate.website_project_id)
                 AND job.job_type='recommendation_refill'
                 AND job.source_object_type='recommendation_context'
                 AND job.source_object_id=
                     candidate.project_context_version_id
                 AND job.status IN ('queued','running','waiting_provider')
            )
            OR EXISTS (
              SELECT 1
                FROM backlink_jobs AS job
                JOIN backlink_recommendation_refills AS refill
                  ON (refill.organization_id,refill.workspace_id,
                      refill.website_project_id,refill.job_id)=
                     (job.organization_id,job.workspace_id,
                      job.website_project_id,job.id)
                JOIN provider_batch_requests AS request
                  ON (request.organization_id,request.workspace_id,
                      request.website_project_id)=
                     (job.organization_id,job.workspace_id,
                      job.website_project_id)
                 AND request.request_id LIKE
                     refill.refill_window_key||':%'
               WHERE (job.organization_id,job.workspace_id,
                      job.website_project_id)=
                     ($4,$1,candidate.website_project_id)
                 AND job.job_type='recommendation_refill'
                 AND job.source_object_type='recommendation_context'
                 AND job.source_object_id=
                     candidate.project_context_version_id
                 AND job.status IN ('queued','running','waiting_provider')
                 AND request.status IN ('running','unknown_charge')
            )
          ) "hasProviderSideEffect"
     FROM candidate_contexts AS candidate
    ORDER BY candidate.project_context_version_id`;

const applyReconciliationSql =
  `WITH orphan_jobs AS (
     UPDATE backlink_jobs AS job
        SET status='failed',
            step='orphan_operation_reconciled',
            progress=100,
            error=jsonb_build_object(
              'code','ORPHAN_REFILL_OPERATION',
              'rootCause','ORPHAN_OPERATION',
              'recovery','RESTART_SERVICE',
              'providerCallOccurred',false,
              'diagnosticId',
                'refill-'||left(replace(job.id::text,'-',''),12)||'-orphan',
              'message',
                'The operation has no live owner. Reconcile or restart the service.'
            ),
            finished_at=$5,
            updated_at=$5,
            updated_by=$6,
            version=version+1
      WHERE (job.organization_id,job.workspace_id,
             job.website_project_id,job.source_object_id)=($1,$2,$3,$4)
        AND job.id=ANY($7::uuid[])
        AND job.job_type='recommendation_refill'
        AND job.source_object_type='recommendation_context'
        AND job.status IN ('queued','running','waiting_provider')
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_outbox_events AS event
           WHERE (event.organization_id,event.workspace_id,
                  event.website_project_id,event.aggregate_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id,job.id)
             AND event.event_type=
                 'backlinks.recommendation-refill.requested.v1'
             AND event.status IN ('pending','processing')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_recommendation_refills AS refill
            JOIN backlink_provider_usage_ledger AS usage
              ON (usage.organization_id,usage.workspace_id,
                  usage.website_project_id)=
                 (refill.organization_id,refill.workspace_id,
                  refill.website_project_id)
             AND usage.provider='dataforseo'
             AND usage.reservation_key LIKE
                 refill.refill_window_key||':%'
             AND usage.status='reserved'
           WHERE (refill.organization_id,refill.workspace_id,
                  refill.website_project_id,refill.job_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id,job.id)
        )
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_recommendation_refills AS refill
            JOIN provider_batch_requests AS request
              ON (request.organization_id,request.workspace_id,
                  request.website_project_id)=
                 (refill.organization_id,refill.workspace_id,
                  refill.website_project_id)
             AND request.request_id LIKE
                 refill.refill_window_key||':%'
           WHERE (refill.organization_id,refill.workspace_id,
                  refill.website_project_id,refill.job_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id,job.id)
             AND request.status IN ('running','unknown_charge')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_recommendation_refills AS refill
            JOIN provider_fetch_leases AS lease
              ON lease.owner_request_id LIKE refill.refill_window_key||':%'
           WHERE (refill.organization_id,refill.workspace_id,
                  refill.website_project_id,refill.job_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id,job.id)
             AND lease.status='acquired'
             AND lease.lease_expires_at>$5
        )
    RETURNING job.id
   ),
   reconciled_policy AS (
     UPDATE backlink_commercial_inventory_policies AS policy
        SET refill_state='idle',
            pause_reason='orphan_operation_reconciled',
            termination_reason=NULL,
            next_refill_at=$5,
            updated_at=$5,
            updated_by=$6,
            version=version+1
      WHERE (policy.organization_id,policy.workspace_id,
             policy.website_project_id,
             policy.project_context_version_id)=($1,$2,$3,$4)
        AND policy.refill_state='running'
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_jobs AS job
           WHERE (job.organization_id,job.workspace_id,
                  job.website_project_id)=
                 (policy.organization_id,policy.workspace_id,
                  policy.website_project_id)
             AND job.job_type='recommendation_refill'
             AND job.source_object_type='recommendation_context'
             AND job.source_object_id=policy.project_context_version_id
             AND job.status IN ('queued','running','waiting_provider')
             AND NOT EXISTS (
               SELECT 1
                 FROM orphan_jobs
                WHERE orphan_jobs.id=job.id
             )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_jobs AS job
            JOIN backlink_outbox_events AS event
              ON (event.organization_id,event.workspace_id,
                  event.website_project_id,event.aggregate_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id,job.id)
             AND event.event_type=
                 'backlinks.recommendation-refill.requested.v1'
           WHERE (job.organization_id,job.workspace_id,
                  job.website_project_id)=
                 (policy.organization_id,policy.workspace_id,
                  policy.website_project_id)
             AND job.job_type='recommendation_refill'
             AND job.source_object_type='recommendation_context'
             AND job.source_object_id=policy.project_context_version_id
             AND event.status IN ('pending','processing')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_jobs AS job
            JOIN backlink_recommendation_refills AS refill
              ON (refill.organization_id,refill.workspace_id,
                  refill.website_project_id,refill.job_id)=
                 (job.organization_id,job.workspace_id,
                  job.website_project_id,job.id)
            JOIN provider_fetch_leases AS lease
              ON lease.owner_request_id LIKE refill.refill_window_key||':%'
           WHERE (job.organization_id,job.workspace_id,
                  job.website_project_id)=
                 (policy.organization_id,policy.workspace_id,
                  policy.website_project_id)
             AND job.job_type='recommendation_refill'
             AND job.source_object_type='recommendation_context'
             AND job.source_object_id=policy.project_context_version_id
             AND lease.status='acquired'
             AND lease.lease_expires_at>$5
        )
    RETURNING policy.project_context_version_id
   ),
   closed_batches AS (
     UPDATE backlink_commercial_discovery_batches AS batch
        SET status='failed',
            pause_reason='orphan_operation_reconciled',
            finished_at=COALESCE(batch.finished_at,$5)
      WHERE (batch.organization_id,batch.workspace_id,
             batch.website_project_id,
             batch.project_context_version_id)=($1,$2,$3,$4)
        AND batch.status='running'
        AND (
          EXISTS (SELECT 1 FROM reconciled_policy)
          OR EXISTS (SELECT 1 FROM orphan_jobs)
        )
    RETURNING batch.id
   )
   SELECT (
            EXISTS (SELECT 1 FROM orphan_jobs)
            OR EXISTS (SELECT 1 FROM reconciled_policy)
          ) applied,
          (SELECT count(*)::integer FROM closed_batches) "closedBatchCount"`;

function boolean(value: unknown): boolean {
  return value === true || value === "true";
}

function workflowExecutions(value: unknown): readonly WorkflowExecution[] {
  if (typeof value === "string") {
    try {
      return workflowExecutions(JSON.parse(value) as unknown);
    } catch {
      return Object.freeze([]);
    }
  }
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.jobId !== "string"
      || typeof record.workflowId !== "string"
      || typeof record.status !== "string"
    ) {
      return [];
    }
    return [Object.freeze({
      jobId: record.jobId,
      workflowId: record.workflowId,
      status: record.status,
    })];
  }));
}

async function listRunningStates(
  client: BacklinkTransactionClient,
  scope: BacklinkTenantContext,
  observedAt: Date,
): Promise<readonly RunningState[]> {
  await client.query(reconciliationLockSql, [
    scope.workspaceId,
    scope.websiteProjectId,
  ]);
  const result = await client.query(runningStatesSql, [
    scope.workspaceId,
    scope.websiteProjectId,
    observedAt,
    scope.organizationId,
  ]);
  return Object.freeze(result.rows.map((row) => Object.freeze({
    websiteProjectId: String(row.websiteProjectId),
    projectContextVersionId: String(row.projectContextVersionId),
    workflowExecutions: workflowExecutions(row.workflowExecutions),
    hasPendingOutbox: boolean(row.hasPendingOutbox),
    hasLiveLease: boolean(row.hasLiveLease),
    hasProviderSideEffect: boolean(row.hasProviderSideEffect),
  })));
}

async function inspectWorkflows(
  states: readonly RunningState[],
  probe: RecommendationRefillWorkflowProbe,
): Promise<ReadonlyMap<string, RecommendationRefillWorkflowState>> {
  const workflowIds = [...new Set(states.flatMap((state) =>
    state.workflowExecutions.map(({ workflowId }) => workflowId)
  ))];
  const statuses = await Promise.all(workflowIds.map(async (workflowId) => [
    workflowId,
    await probe.inspect(workflowId),
  ] as const));
  return new Map(statuses);
}

function classify(
  state: RunningState,
  workflowStates: ReadonlyMap<string, RecommendationRefillWorkflowState>,
): RecommendationRefillReconciliationEntry["reason"] {
  if (state.hasPendingOutbox) return "PENDING_WORKFLOW_START";
  if (state.hasLiveLease) return "LIVE_PROVIDER_LEASE";
  if (state.hasProviderSideEffect) return "PROVIDER_SIDE_EFFECT";
  const liveExecutions = state.workflowExecutions.filter(({ status }) =>
    status === "queued" || status === "running" || status === "waiting_provider"
  );
  const inspected = liveExecutions.length > 0
    ? liveExecutions
    : state.workflowExecutions;
  const statuses = inspected.map(({ workflowId }) =>
    workflowStates.get(workflowId) ?? "unknown"
  );
  if (statuses.includes("running")) return "LIVE_WORKFLOW";
  if (statuses.includes("unknown")) return "WORKFLOW_LIVENESS_UNKNOWN";
  return "NO_LIVE_JOB_WORKFLOW_OR_LEASE";
}

function orphanJobIds(
  state: RunningState,
  workflowStates: ReadonlyMap<string, RecommendationRefillWorkflowState>,
): readonly string[] {
  return Object.freeze(state.workflowExecutions
    .filter(({ status, workflowId }) =>
      (
        status === "queued"
        || status === "running"
        || status === "waiting_provider"
      )
      && ["closed", "missing"].includes(
        workflowStates.get(workflowId) ?? "unknown",
      )
    )
    .map(({ jobId }) => jobId));
}

function entry(
  state: RunningState,
  workflowStates: ReadonlyMap<string, RecommendationRefillWorkflowState>,
  applied: boolean,
): RecommendationRefillReconciliationEntry {
  const reason = classify(state, workflowStates);
  return Object.freeze({
    websiteProjectId: state.websiteProjectId,
    projectContextVersionId: state.projectContextVersionId,
    state: "running",
    reason,
    plannedAction: reason === "NO_LIVE_JOB_WORKFLOW_OR_LEASE"
      ? "RESET_RUNNING_TO_IDLE"
      : "NO_CHANGE",
    applied,
  });
}

function result(
  mode: RecommendationRefillReconciliationMode,
  entries: readonly RecommendationRefillReconciliationEntry[],
): RecommendationRefillReconciliationResult {
  const planned = entries.filter(
    ({ plannedAction }) => plannedAction === "RESET_RUNNING_TO_IDLE",
  );
  return Object.freeze({
    mode,
    scannedRunningCount: entries.length,
    projectCount: new Set(planned.map(({ websiteProjectId }) =>
      websiteProjectId
    )).size,
    plannedChangeCount: planned.length,
    appliedChangeCount: entries.filter(({ applied }) => applied).length,
    entries: Object.freeze(entries),
  });
}

export async function reconcileRecommendationRefillOrphans(
  input: Readonly<{
    pool: BacklinkTenantPool;
    scope: BacklinkTenantContext;
    actorId: string;
    mode: RecommendationRefillReconciliationMode;
    workflowProbe: RecommendationRefillWorkflowProbe;
    now?: () => Date;
  }>,
): Promise<RecommendationRefillReconciliationResult> {
  const observedAt = (input.now ?? (() => new Date()))();
  return withBacklinkTenantTransaction(
    input.pool,
    input.scope,
    async (client) => {
      const current = await listRunningStates(
        client,
        input.scope,
        observedAt,
      );
      const workflowStates = await inspectWorkflows(
        current,
        input.workflowProbe,
      );
      if (input.mode === "dry-run") {
        return result(
          input.mode,
          current.map((state) => entry(state, workflowStates, false)),
        );
      }

      const reconciled: RecommendationRefillReconciliationEntry[] = [];
      for (const state of current) {
        const candidate = entry(state, workflowStates, false);
        if (candidate.plannedAction === "NO_CHANGE") {
          reconciled.push(candidate);
          continue;
        }
        const applied = await client.query(applyReconciliationSql, [
          input.scope.organizationId,
          input.scope.workspaceId,
          input.scope.websiteProjectId,
          state.projectContextVersionId,
          observedAt,
          input.actorId,
          orphanJobIds(state, workflowStates),
        ]);
        reconciled.push(entry(
          state,
          workflowStates,
          boolean(applied.rows[0]?.applied),
        ));
      }
      return result(input.mode, reconciled);
    },
  );
}
