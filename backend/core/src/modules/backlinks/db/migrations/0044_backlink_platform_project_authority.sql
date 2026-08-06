BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE OR REPLACE FUNCTION backlink_list_active_project_scopes(
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
  authoritative_projects AS (
    SELECT authority.website_project_id,
           authority.context_version
      FROM authorized
      CROSS JOIN LATERAL
        platform.backlink_list_active_website_projects(
          p_organization_id::text,
          p_workspace_id::text
        ) AS authority
  ),
  latest AS (
    SELECT DISTINCT ON (snapshot.website_project_id)
           snapshot.organization_id,
           snapshot.workspace_id,
           snapshot.website_project_id,
           snapshot.id,
           snapshot.snapshot_version,
           snapshot.project_status
      FROM backlink_project_context_snapshots AS snapshot
     WHERE snapshot.organization_id = p_organization_id
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
    JOIN authoritative_projects AS authority
      ON authority.website_project_id = latest.website_project_id::text
     AND authority.context_version = latest.snapshot_version
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

COMMIT;
