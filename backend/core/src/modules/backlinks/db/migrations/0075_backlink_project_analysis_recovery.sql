BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE FUNCTION backlink_rearm_stale_project_analysis_events(
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

  WITH candidates AS (
    SELECT
      event.id AS event_id,
      job.organization_id,
      job.workspace_id,
      job.website_project_id,
      job.id AS job_id
    FROM backlink_jobs AS job
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
      AND job.status = 'queued'
      AND job.updated_at <= p_stale_before
      AND event.status = 'published'
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

CREATE FUNCTION backlink_project_task_runtime_health(
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
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH active AS (
    SELECT
      job.*,
      EXISTS (
        SELECT 1
        FROM backlink_outbox_events AS event
        WHERE (
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
          AND event.status = 'published'
      ) AS has_recoverable_event
    FROM backlink_jobs AS job
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
  ON FUNCTION backlink_rearm_stale_project_analysis_events(
    text, timestamptz, integer
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_project_task_runtime_health(timestamptz)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION backlink_rearm_stale_project_analysis_events(
    text, timestamptz, integer
  )
  TO growthos_backlinks_writer;
GRANT EXECUTE
  ON FUNCTION backlink_project_task_runtime_health(timestamptz)
  TO growthos_backlinks_writer;

COMMIT;
