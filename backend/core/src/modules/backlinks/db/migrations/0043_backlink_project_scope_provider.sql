BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE POLICY backlink_job_internal_policy
  ON backlink_jobs TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);

WITH active_legacy_workflows AS (
  SELECT event.id,
         event.organization_id,
         event.workspace_id,
         event.website_project_id,
         event.payload->>'workflowId' AS legacy_workflow_id,
         format(
           'backlinks:%s:%s',
           event.organization_id,
           substring(
             event.payload->>'workflowId'
             FROM length('backlinks:') + 1
           )
         ) AS scoped_workflow_id
    FROM backlink_outbox_events AS event
   WHERE event.status IN ('pending', 'processing', 'failed')
     AND event.idempotency_key = event.payload->>'workflowId'
     AND event.payload->>'workflowId' LIKE 'backlinks:%'
     AND regexp_count(event.payload->>'workflowId', ':') = 5
),
updated_jobs AS (
  UPDATE backlink_jobs AS job
     SET workflow_id = workflow.scoped_workflow_id,
         updated_at = now(),
         updated_by = 'LOCAL-PRODUCT-014'
    FROM active_legacy_workflows AS workflow
   WHERE job.organization_id = workflow.organization_id
     AND job.workspace_id = workflow.workspace_id
     AND job.website_project_id = workflow.website_project_id
     AND job.workflow_id = workflow.legacy_workflow_id
  RETURNING job.id
)
UPDATE backlink_outbox_events AS event
   SET idempotency_key = workflow.scoped_workflow_id,
       payload = jsonb_set(
         event.payload,
         '{workflowId}',
         to_jsonb(workflow.scoped_workflow_id)
       ),
       updated_at = now(),
       updated_by = 'LOCAL-PRODUCT-014'
  FROM active_legacy_workflows AS workflow
 WHERE event.id = workflow.id;

CREATE POLICY backlink_project_context_snapshot_internal_policy
  ON backlink_project_context_snapshots TO growthos_backlinks_owner
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  );

CREATE FUNCTION backlink_list_active_project_scopes(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_after_website_project_id uuid,
  p_limit integer
)
RETURNS TABLE (
  organization_id uuid,
  workspace_id uuid,
  website_project_id uuid,
  project_context_snapshot_id uuid,
  project_context_snapshot_version integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH authorized AS (
    SELECT 1
     WHERE p_organization_id =
       NULLIF(
         current_setting('app.current_organization_id', true),
         ''
       )::uuid
       AND p_workspace_id =
         NULLIF(
           current_setting('app.current_workspace_id', true),
           ''
         )::uuid
  ),
  latest AS (
    SELECT DISTINCT ON (snapshot.website_project_id)
           snapshot.organization_id,
           snapshot.workspace_id,
           snapshot.website_project_id,
           snapshot.id,
           snapshot.snapshot_version,
           snapshot.project_status
      FROM authorized
      JOIN backlink_project_context_snapshots AS snapshot
        ON snapshot.organization_id = p_organization_id
       AND snapshot.workspace_id = p_workspace_id
     ORDER BY snapshot.website_project_id,
              snapshot.snapshot_version DESC,
              snapshot.created_at DESC,
              snapshot.id DESC
  )
  SELECT latest.organization_id,
         latest.workspace_id,
         latest.website_project_id,
         latest.id,
         latest.snapshot_version
    FROM latest
   WHERE latest.project_status = 'ACTIVE'
     AND (
       p_after_website_project_id IS NULL
       OR latest.website_project_id > p_after_website_project_id
     )
   ORDER BY latest.website_project_id
   LIMIT LEAST(GREATEST(p_limit, 0), 101);
$function$;

REVOKE ALL
  ON FUNCTION backlink_list_active_project_scopes(
    uuid, uuid, uuid, integer
  )
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION backlink_list_active_project_scopes(
    uuid, uuid, uuid, integer
  )
  TO growthos_backlinks_writer;

ALTER TABLE backlink_contact_enrichment_jobs
  DROP CONSTRAINT backlink_contact_enrichment_job_status_check,
  ADD CONSTRAINT backlink_contact_enrichment_job_status_check CHECK (
    status IN (
      'pending', 'running', 'completed', 'partially_completed',
      'no_contact_found', 'retry_scheduled', 'stale_context'
    )
  );

COMMIT;
