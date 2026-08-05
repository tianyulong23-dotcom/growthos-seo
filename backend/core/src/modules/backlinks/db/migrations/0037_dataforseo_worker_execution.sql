BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE POLICY provider_batch_request_worker_policy
  ON provider_batch_requests
  FOR ALL
  TO growthos_backlinks_writer
  USING (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(current_setting('app.current_organization_id', true), '')::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY provider_artifact_worker_select_policy
  ON provider_artifacts
  FOR SELECT
  TO growthos_backlinks_writer
  USING (true);

CREATE POLICY provider_artifact_worker_insert_policy
  ON provider_artifacts
  FOR INSERT
  TO growthos_backlinks_writer
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM provider_batch_requests AS batch
      WHERE batch.id = source_batch_id
        AND batch.organization_id =
          NULLIF(
            current_setting('app.current_organization_id', true),
            ''
          )::uuid
        AND batch.workspace_id =
          NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
        AND batch.website_project_id =
          NULLIF(
            current_setting('app.current_website_project_id', true),
            ''
          )::uuid
    )
  );

CREATE POLICY provider_artifact_worker_update_policy
  ON provider_artifacts
  FOR UPDATE
  TO growthos_backlinks_writer
  USING (true)
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM provider_batch_requests AS batch
      WHERE batch.id = source_batch_id
        AND batch.organization_id =
          NULLIF(
            current_setting('app.current_organization_id', true),
            ''
          )::uuid
        AND batch.workspace_id =
          NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
        AND batch.website_project_id =
          NULLIF(
            current_setting('app.current_website_project_id', true),
            ''
          )::uuid
    )
  );

CREATE POLICY provider_fetch_lease_worker_policy
  ON provider_fetch_leases
  FOR ALL
  TO growthos_backlinks_writer
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE
  ON provider_batch_requests, provider_artifacts, provider_fetch_leases
  TO growthos_backlinks_writer;

COMMIT;
