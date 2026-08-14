BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_draft_request_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  contact_version integer NOT NULL,
  request_payload jsonb NOT NULL,
  request_hash text NOT NULL,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_draft_request_payload_check CHECK (
    jsonb_typeof(request_payload) = 'object'
  ),
  CONSTRAINT backlink_draft_request_hash_check
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT backlink_draft_request_version_check CHECK (
    contact_version > 0 AND schema_version > 0
  ),
  CONSTRAINT backlink_draft_request_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  ),
  CONSTRAINT backlink_draft_request_content_uq UNIQUE (
    organization_id, workspace_id, website_project_id, opportunity_id,
    contact_id, contact_version, request_hash
  ),
  CONSTRAINT backlink_draft_request_opportunity_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_draft_request_contact_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, contact_id
  ) REFERENCES backlink_contacts (
    organization_id, workspace_id, website_project_id, id
  )
);

ALTER TABLE backlink_evidence_snapshots
  ADD COLUMN context_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT backlink_evidence_snapshot_context_check
    CHECK (jsonb_typeof(context_data) = 'object');

ALTER TABLE backlink_model_runs
  ADD COLUMN request_snapshot_id uuid;

ALTER TABLE backlink_model_runs
  ADD CONSTRAINT backlink_model_run_request_snapshot_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, request_snapshot_id,
    opportunity_id
  ) REFERENCES backlink_draft_request_snapshots (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  );

ALTER TABLE backlink_draft_versions
  ADD COLUMN request_snapshot_id uuid;

ALTER TABLE backlink_draft_versions
  ADD CONSTRAINT backlink_draft_version_request_snapshot_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, request_snapshot_id,
    opportunity_id
  ) REFERENCES backlink_draft_request_snapshots (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  );

ALTER TABLE backlink_model_runs
  DROP CONSTRAINT backlink_model_run_status_check,
  DROP CONSTRAINT backlink_model_run_timing_check,
  DROP CONSTRAINT backlink_model_run_error_check,
  ADD CONSTRAINT backlink_model_run_status_check CHECK (
    status IN (
      'QUEUED', 'RUNNING', 'RETRY_SCHEDULED',
      'SUCCEEDED', 'FAILED', 'REFUSED'
    )
  ),
  ADD CONSTRAINT backlink_model_run_timing_check CHECK (
    (
      status = 'QUEUED'
      AND started_at IS NULL
      AND finished_at IS NULL
    )
    OR (
      status IN ('RUNNING', 'RETRY_SCHEDULED')
      AND started_at IS NOT NULL
      AND finished_at IS NULL
    )
    OR (
      status IN ('SUCCEEDED', 'FAILED', 'REFUSED')
      AND started_at IS NOT NULL
      AND finished_at IS NOT NULL
      AND finished_at >= started_at
    )
  ),
  ADD CONSTRAINT backlink_model_run_error_check CHECK (
    (
      status IN ('RETRY_SCHEDULED', 'FAILED', 'REFUSED')
      AND length(btrim(error_code)) > 0
    )
    OR (
      status NOT IN ('RETRY_SCHEDULED', 'FAILED', 'REFUSED')
      AND error_code IS NULL
    )
  );

ALTER TABLE backlink_draft_versions
  DROP CONSTRAINT backlink_draft_version_source_check,
  DROP CONSTRAINT backlink_draft_version_model_check,
  ADD CONSTRAINT backlink_draft_version_source_check CHECK (
    source IN ('MODEL', 'TEMPLATE_FALLBACK', 'MANUAL', 'RESTORED')
  ),
  ADD CONSTRAINT backlink_draft_version_model_check CHECK (
    (
      source IN ('MODEL', 'TEMPLATE_FALLBACK')
      AND model_run_id IS NOT NULL
      AND request_snapshot_id IS NOT NULL
      AND length(btrim(model_id)) > 0
      AND length(btrim(model_version)) > 0
    )
    OR (
      source IN ('MANUAL', 'RESTORED')
      AND model_run_id IS NULL
      AND model_id IS NULL
      AND model_version IS NULL
    )
  ) NOT VALID;

CREATE TRIGGER backlink_draft_request_snapshot_immutable
BEFORE UPDATE OR DELETE ON backlink_draft_request_snapshots
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_draft_immutable_mutation();

ALTER TABLE backlink_draft_request_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_draft_request_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_draft_request_snapshot_tenant_policy
  ON backlink_draft_request_snapshots
  USING (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  )
  WITH CHECK (
    workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

REVOKE ALL ON backlink_draft_request_snapshots FROM PUBLIC;
REVOKE UPDATE, DELETE
  ON backlink_draft_request_snapshots
  FROM growthos_backlinks_writer;

GRANT SELECT, INSERT
  ON backlink_draft_request_snapshots
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_draft_request_snapshots
  TO growthos_reporting_reader;

COMMIT;
