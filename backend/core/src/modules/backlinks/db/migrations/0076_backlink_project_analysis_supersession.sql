BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE FUNCTION backlink_project_analysis_snapshot_binding(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_website_project_id uuid,
  p_source_snapshot_id uuid
)
RETURNS TABLE (
  source_snapshot_id uuid,
  source_snapshot_version integer,
  latest_snapshot_id uuid,
  latest_snapshot_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF p_organization_id IS NULL
     OR p_workspace_id IS NULL
     OR p_website_project_id IS NULL
     OR p_source_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'Invalid project-analysis snapshot binding request'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config(
    'app.current_organization_id',
    p_organization_id::text,
    true
  );
  PERFORM set_config(
    'app.current_workspace_id',
    p_workspace_id::text,
    true
  );
  PERFORM set_config(
    'app.current_website_project_id',
    p_website_project_id::text,
    true
  );

  RETURN QUERY
  SELECT
    source.id,
    source.snapshot_version,
    latest.id,
    latest.snapshot_version
  FROM (SELECT 1) AS anchor
  LEFT JOIN backlink_project_context_snapshots AS source
    ON (
      source.organization_id,
      source.workspace_id,
      source.website_project_id,
      source.id
    ) = (
      p_organization_id,
      p_workspace_id,
      p_website_project_id,
      p_source_snapshot_id
    )
  LEFT JOIN LATERAL (
    SELECT snapshot.id, snapshot.snapshot_version
    FROM backlink_project_context_snapshots AS snapshot
    WHERE (
      snapshot.organization_id,
      snapshot.workspace_id,
      snapshot.website_project_id
    ) = (
      p_organization_id,
      p_workspace_id,
      p_website_project_id
    )
    ORDER BY
      snapshot.snapshot_version DESC,
      snapshot.created_at DESC,
      snapshot.id DESC
    LIMIT 1
  ) AS latest ON true;
END;
$function$;

CREATE FUNCTION backlink_close_invalid_project_analysis_jobs(
  p_worker_id text,
  p_stale_before timestamptz,
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  closed_count integer;
BEGIN
  IF p_worker_id IS NULL
     OR length(btrim(p_worker_id)) = 0
     OR p_stale_before IS NULL
     OR p_limit < 1 THEN
    RAISE EXCEPTION 'Invalid project-analysis closure request'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT
      job.organization_id,
      job.workspace_id,
      job.website_project_id,
      job.id AS job_id,
      job.source_object_type,
      binding.source_snapshot_id,
      binding.source_snapshot_version,
      binding.latest_snapshot_id,
      binding.latest_snapshot_version,
      event.id AS event_id,
      event.status AS event_status,
      event.payload->>'snapshotVersion' AS event_snapshot_version
    FROM backlink_jobs AS job
    LEFT JOIN LATERAL (
      SELECT *
      FROM backlink_project_analysis_snapshot_binding(
        job.organization_id,
        job.workspace_id,
        job.website_project_id,
        job.source_object_id
      )
    ) AS binding ON true
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
      AND job.updated_at <= p_stale_before
    ORDER BY job.updated_at, job.id
    FOR UPDATE OF job SKIP LOCKED
    LIMIT p_limit
  ),
  classified AS (
    SELECT
      candidate.*,
      CASE
        WHEN candidate.source_object_type <> 'project-context-snapshot'
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
            WHEN candidate.event_snapshot_version ~ '^[1-9][0-9]*$'
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
  ),
  closed AS (
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
             'sourceSnapshotId', classified.source_snapshot_id,
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
           updated_by = p_worker_id
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
       )
    RETURNING job.id
  )
  SELECT count(*)::integer
    INTO closed_count
    FROM closed;

  RETURN closed_count;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_rearm_stale_project_analysis_events(
  p_worker_id text,
  p_stale_before timestamptz,
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  rearmed_count integer;
BEGIN
  IF p_worker_id IS NULL
     OR length(btrim(p_worker_id)) = 0
     OR p_stale_before IS NULL
     OR p_limit < 1 THEN
    RAISE EXCEPTION 'Invalid project-analysis recovery request'
      USING ERRCODE = '22023';
  END IF;

  PERFORM backlink_close_invalid_project_analysis_jobs(
    p_worker_id,
    p_stale_before,
    p_limit
  );

  WITH candidates AS (
    SELECT
      event.id AS event_id,
      job.organization_id,
      job.workspace_id,
      job.website_project_id,
      job.id AS job_id
    FROM backlink_jobs AS job
    JOIN LATERAL (
      SELECT *
      FROM backlink_project_analysis_snapshot_binding(
        job.organization_id,
        job.workspace_id,
        job.website_project_id,
        job.source_object_id
      )
    ) AS binding
      ON (
        binding.source_snapshot_id,
        binding.source_snapshot_version
      ) = (
        binding.latest_snapshot_id,
        binding.latest_snapshot_version
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
     AND event.event_type = 'backlinks.project-analysis.requested.v1'
     AND event.payload->>'jobId' = job.id::text
     AND event.payload->>'workflowId' = job.workflow_id
    WHERE job.job_type = 'project-analysis'
      AND job.source_object_type = 'project-context-snapshot'
      AND job.status = 'queued'
      AND job.updated_at <= p_stale_before
      AND event.status = 'published'
      AND CASE
        WHEN event.payload->>'snapshotVersion' ~ '^[1-9][0-9]*$'
          THEN (event.payload->>'snapshotVersion')::numeric =
            binding.source_snapshot_version
        ELSE false
      END
    ORDER BY job.updated_at, job.id
    FOR UPDATE OF job, event SKIP LOCKED
    LIMIT p_limit
  ),
  rearmed AS (
    UPDATE backlink_outbox_events AS event
       SET status = 'pending',
           available_at = now(),
           claimed_at = NULL,
           claimed_by = NULL,
           published_at = NULL,
           updated_at = now(),
           updated_by = p_worker_id
      FROM candidates
     WHERE event.id = candidates.event_id
    RETURNING
      candidates.organization_id,
      candidates.workspace_id,
      candidates.website_project_id,
      candidates.job_id
  )
  UPDATE backlink_jobs AS job
     SET step = 'recovery_queued',
         retry_count = job.retry_count + 1,
         version = job.version + 1,
         updated_at = now(),
         updated_by = p_worker_id
    FROM rearmed
   WHERE (
     job.organization_id,
     job.workspace_id,
     job.website_project_id,
     job.id
   ) = (
     rearmed.organization_id,
     rearmed.workspace_id,
     rearmed.website_project_id,
     rearmed.job_id
   );

  GET DIAGNOSTICS rearmed_count = ROW_COUNT;
  RETURN rearmed_count;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_project_task_runtime_health(
  p_stale_before timestamptz
)
RETURNS TABLE (
  active_jobs integer,
  recoverable_queued_project_analysis integer,
  unrecoverable_stale_queued_project_analysis integer,
  stale_running_jobs integer,
  waiting_provider_jobs integer,
  oldest_active_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH active AS (
    SELECT
      job.*,
      (
        job.source_object_type = 'project-context-snapshot'
        AND binding.source_snapshot_id IS NOT NULL
        AND (
          binding.source_snapshot_id,
          binding.source_snapshot_version
        ) = (
          binding.latest_snapshot_id,
          binding.latest_snapshot_version
        )
        AND event.status = 'published'
        AND CASE
          WHEN event.payload->>'snapshotVersion' ~ '^[1-9][0-9]*$'
            THEN (event.payload->>'snapshotVersion')::numeric =
              binding.source_snapshot_version
          ELSE false
        END
      ) AS has_recoverable_event
    FROM backlink_jobs AS job
    LEFT JOIN LATERAL (
      SELECT *
      FROM backlink_project_analysis_snapshot_binding(
        job.organization_id,
        job.workspace_id,
        job.website_project_id,
        job.source_object_id
      )
    ) AS binding ON true
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
    count(*)::integer AS active_jobs,
    count(*) FILTER (
      WHERE job_type = 'project-analysis'
        AND status = 'queued'
        AND updated_at <= p_stale_before
        AND has_recoverable_event
    )::integer AS recoverable_queued_project_analysis,
    count(*) FILTER (
      WHERE job_type = 'project-analysis'
        AND status = 'queued'
        AND updated_at <= p_stale_before
        AND NOT has_recoverable_event
    )::integer AS unrecoverable_stale_queued_project_analysis,
    count(*) FILTER (
      WHERE status = 'running'
        AND updated_at <= p_stale_before
    )::integer AS stale_running_jobs,
    count(*) FILTER (
      WHERE status = 'waiting_provider'
    )::integer AS waiting_provider_jobs,
    min(updated_at) AS oldest_active_at
  FROM active;
$function$;

REVOKE ALL
  ON FUNCTION backlink_project_analysis_snapshot_binding(
    uuid, uuid, uuid, uuid
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_close_invalid_project_analysis_jobs(
    text, timestamptz, integer
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION backlink_close_invalid_project_analysis_jobs(
    text, timestamptz, integer
  )
  TO growthos_backlinks_writer;

SELECT backlink_close_invalid_project_analysis_jobs(
  'backlinks-migration-0076',
  now(),
  10000
);

COMMIT;
