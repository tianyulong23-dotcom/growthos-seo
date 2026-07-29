BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_assessment_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  policy_version text NOT NULL,
  evidence_contract_version text NOT NULL,
  source_release_ids jsonb NOT NULL,
  input_evidence_refs jsonb NOT NULL,
  input_evidence_hash text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  attempt_count integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  last_successful_snapshot_id uuid,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_assessment_run_versions_check CHECK (
    length(btrim(policy_version)) > 0
    AND length(btrim(evidence_contract_version)) > 0
    AND schema_version > 0
  ),
  CONSTRAINT backlink_assessment_run_source_releases_check CHECK (
    jsonb_typeof(source_release_ids) = 'array'
    AND jsonb_array_length(source_release_ids) > 0
  ),
  CONSTRAINT backlink_assessment_run_evidence_refs_check CHECK (
    jsonb_typeof(input_evidence_refs) = 'array'
    AND jsonb_array_length(input_evidence_refs) > 0
  ),
  CONSTRAINT backlink_assessment_run_evidence_hash_check
    CHECK (input_evidence_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT backlink_assessment_run_status_check CHECK (
    status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')
  ),
  CONSTRAINT backlink_assessment_run_attempt_check
    CHECK (attempt_count >= 0),
  CONSTRAINT backlink_assessment_run_timing_check CHECK (
    (
      status = 'QUEUED'
      AND attempt_count = 0
      AND started_at IS NULL
      AND finished_at IS NULL
    )
    OR (
      status = 'RUNNING'
      AND attempt_count > 0
      AND started_at IS NOT NULL
      AND finished_at IS NULL
    )
    OR (
      status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
      AND attempt_count > 0
      AND started_at IS NOT NULL
      AND finished_at IS NOT NULL
      AND finished_at >= started_at
    )
  ),
  CONSTRAINT backlink_assessment_run_error_check CHECK (
    (status = 'FAILED' AND length(btrim(error_code)) > 0)
    OR (status <> 'FAILED' AND error_code IS NULL)
  ),
  CONSTRAINT backlink_assessment_run_success_check CHECK (
    status <> 'SUCCEEDED' OR last_successful_snapshot_id IS NOT NULL
  ),
  CONSTRAINT backlink_assessment_run_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    opportunity_id, policy_version, input_evidence_hash
  ),
  CONSTRAINT backlink_assessment_run_input_uq UNIQUE (
    organization_id, workspace_id, website_project_id, opportunity_id,
    policy_version, input_evidence_hash
  ),
  CONSTRAINT backlink_assessment_run_opportunity_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_assessment_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  policy_version text NOT NULL,
  input_evidence_hash text NOT NULL,
  snapshot_version integer NOT NULL,
  source_release_ids jsonb NOT NULL,
  availability text NOT NULL,
  confidence numeric(5, 4) NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  unavailable_reason text,
  stale boolean NOT NULL DEFAULT false,
  result_payload jsonb NOT NULL,
  result_hash text NOT NULL,
  generated_at timestamptz NOT NULL,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_assessment_snapshot_versions_check CHECK (
    snapshot_version > 0
    AND schema_version > 0
    AND length(btrim(policy_version)) > 0
  ),
  CONSTRAINT backlink_assessment_snapshot_source_releases_check CHECK (
    jsonb_typeof(source_release_ids) = 'array'
    AND jsonb_array_length(source_release_ids) > 0
  ),
  CONSTRAINT backlink_assessment_snapshot_availability_check CHECK (
    availability IN ('available', 'partial', 'unavailable')
  ),
  CONSTRAINT backlink_assessment_snapshot_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT backlink_assessment_snapshot_evidence_refs_check CHECK (
    jsonb_typeof(evidence_refs) = 'array'
    AND (
      availability = 'unavailable'
      OR jsonb_array_length(evidence_refs) > 0
    )
  ),
  CONSTRAINT backlink_assessment_snapshot_availability_detail_check CHECK (
    (
      availability IN ('available', 'partial')
      AND confidence > 0
      AND unavailable_reason IS NULL
    )
    OR (
      availability = 'unavailable'
      AND confidence = 0
      AND length(btrim(unavailable_reason)) > 0
    )
  ),
  CONSTRAINT backlink_assessment_snapshot_payload_check
    CHECK (jsonb_typeof(result_payload) = 'object'),
  CONSTRAINT backlink_assessment_snapshot_hashes_check CHECK (
    input_evidence_hash ~ '^[a-f0-9]{64}$'
    AND result_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT backlink_assessment_snapshot_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  ),
  CONSTRAINT backlink_assessment_snapshot_run_uq UNIQUE (
    organization_id, workspace_id, website_project_id, run_id
  ),
  CONSTRAINT backlink_assessment_snapshot_version_uq UNIQUE (
    organization_id, workspace_id, website_project_id, opportunity_id,
    snapshot_version
  ),
  CONSTRAINT backlink_assessment_snapshot_run_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, run_id,
    opportunity_id, policy_version, input_evidence_hash
  ) REFERENCES backlink_assessment_runs (
    organization_id, workspace_id, website_project_id, id,
    opportunity_id, policy_version, input_evidence_hash
  )
);

ALTER TABLE backlink_assessment_runs
  ADD CONSTRAINT backlink_assessment_run_last_success_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    last_successful_snapshot_id, opportunity_id
  ) REFERENCES backlink_assessment_snapshots (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  );

CREATE FUNCTION backlink_reject_assessment_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Assessment snapshots are immutable'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER backlink_assessment_snapshot_immutable
BEFORE UPDATE OR DELETE ON backlink_assessment_snapshots
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_assessment_snapshot_mutation();

ALTER TABLE backlink_assessment_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_assessment_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_assessment_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_assessment_snapshots FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_assessment_run_tenant_policy
  ON backlink_assessment_runs
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

CREATE POLICY backlink_assessment_snapshot_tenant_policy
  ON backlink_assessment_snapshots
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

REVOKE ALL ON backlink_assessment_runs FROM PUBLIC;
REVOKE ALL ON backlink_assessment_snapshots FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_reject_assessment_snapshot_mutation()
  FROM PUBLIC;
REVOKE UPDATE, DELETE
  ON backlink_assessment_snapshots
  FROM growthos_backlinks_writer;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON backlink_assessment_runs
  TO growthos_backlinks_writer;
GRANT SELECT, INSERT
  ON backlink_assessment_snapshots
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_assessment_runs, backlink_assessment_snapshots
  TO growthos_reporting_reader;

COMMIT;
