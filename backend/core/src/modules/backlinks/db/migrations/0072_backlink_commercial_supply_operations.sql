BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE IF NOT EXISTS backlink_commercial_supply_operations (
  id text PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  project_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  job_id uuid NOT NULL,
  provider text NOT NULL,
  authorization_snapshot jsonb NOT NULL,
  authorization_hash text NOT NULL,
  status text NOT NULL DEFAULT 'authorized',
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_supply_operation_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_supply_operation_job_uq UNIQUE (
    organization_id, workspace_id, website_project_id, job_id
  ),
  CONSTRAINT backlink_supply_operation_idempotency_uq UNIQUE (
    organization_id, workspace_id, website_project_id, idempotency_key
  ),
  CONSTRAINT backlink_supply_operation_job_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, job_id
  ) REFERENCES backlink_jobs (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_supply_operation_context_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    project_context_version_id
  ) REFERENCES backlink_project_context_snapshots (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_supply_operation_values_ck CHECK (
    id = 'commercial-refill-operation:' || job_id::text
    AND visible_pool_generation > 0
    AND provider = 'dataforseo'
    AND jsonb_typeof(authorization_snapshot) = 'object'
    AND authorization_snapshot->>'provider' = provider
    AND authorization_hash ~ '^[0-9a-f]{64}$'
    AND status = 'authorized'
    AND length(btrim(idempotency_key)) > 0
  )
);

ALTER TABLE backlink_commercial_supply_operations
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_supply_operations
  FORCE ROW LEVEL SECURITY;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'backlinks'
       AND tablename = 'backlink_commercial_supply_operations'
       AND policyname = 'backlink_supply_operation_tenant_policy'
  ) THEN
    CREATE POLICY backlink_supply_operation_tenant_policy
    ON backlink_commercial_supply_operations
    USING (
      organization_id =
        NULLIF(current_setting(
          'app.current_organization_id', true
        ), '')::uuid
      AND workspace_id =
        NULLIF(current_setting(
          'app.current_workspace_id', true
        ), '')::uuid
      AND website_project_id =
        NULLIF(current_setting(
          'app.current_website_project_id', true
        ), '')::uuid
    )
    WITH CHECK (
      organization_id =
        NULLIF(current_setting(
          'app.current_organization_id', true
        ), '')::uuid
      AND workspace_id =
        NULLIF(current_setting(
          'app.current_workspace_id', true
        ), '')::uuid
      AND website_project_id =
        NULLIF(current_setting(
          'app.current_website_project_id', true
        ), '')::uuid
    );
  END IF;
END
$migration$;

REVOKE ALL ON backlink_commercial_supply_operations FROM PUBLIC;
GRANT SELECT, INSERT
  ON backlink_commercial_supply_operations
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_commercial_supply_operations
  TO growthos_reporting_reader;

COMMIT;
