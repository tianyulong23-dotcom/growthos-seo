BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_evidence_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  evidence_items jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  schema_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_evidence_snapshot_items_check CHECK (
    jsonb_typeof(evidence_items) = 'array'
    AND jsonb_array_length(evidence_items) > 0
  ),
  CONSTRAINT backlink_evidence_snapshot_hash_check
    CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT backlink_evidence_snapshot_schema_check
    CHECK (schema_version > 0),
  CONSTRAINT backlink_evidence_snapshot_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  ),
  CONSTRAINT backlink_evidence_snapshot_content_uq UNIQUE (
    organization_id, workspace_id, website_project_id, opportunity_id,
    snapshot_hash
  ),
  CONSTRAINT backlink_evidence_snapshot_opportunity_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_email_drafts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  logical_draft_key text NOT NULL,
  status text NOT NULL DEFAULT 'generating',
  version integer NOT NULL DEFAULT 1,
  current_version_id uuid,
  approved_version_id uuid,
  last_successful_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_email_draft_key_check
    CHECK (length(btrim(logical_draft_key)) > 0),
  CONSTRAINT backlink_email_draft_status_check CHECK (
    status IN ('generating', 'draft', 'approved', 'rejected', 'sent')
  ),
  CONSTRAINT backlink_email_draft_version_check CHECK (version > 0),
  CONSTRAINT backlink_email_draft_approval_check CHECK (
    (status = 'approved' AND approved_version_id IS NOT NULL)
    OR status <> 'approved'
  ),
  CONSTRAINT backlink_email_draft_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  ),
  CONSTRAINT backlink_email_draft_logical_key_uq UNIQUE (
    workspace_id, logical_draft_key
  ),
  CONSTRAINT backlink_email_draft_opportunity_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_model_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  evidence_snapshot_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  provider_ref text,
  model_id text,
  model_version text,
  prompt_version text NOT NULL,
  output_schema_version text NOT NULL,
  base_draft_version integer NOT NULL DEFAULT 1,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(14, 6),
  latency_ms integer,
  attempt_count integer NOT NULL DEFAULT 0,
  repair_count integer NOT NULL DEFAULT 0,
  error_class text,
  error_code text,
  quality_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_model_run_versions_check CHECK (
    length(btrim(prompt_version)) > 0
    AND length(btrim(output_schema_version)) > 0
  ),
  CONSTRAINT backlink_model_run_request_hash_check
    CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT backlink_model_run_status_check CHECK (
    status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'REFUSED')
  ),
  CONSTRAINT backlink_model_run_attempt_check CHECK (
    attempt_count >= 0
    AND base_draft_version > 0
    AND repair_count >= 0
    AND repair_count <= 1
    AND repair_count <= attempt_count
  ),
  CONSTRAINT backlink_model_run_usage_check CHECK (
    (input_tokens IS NULL OR input_tokens >= 0)
    AND (output_tokens IS NULL OR output_tokens >= 0)
    AND (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0)
    AND (latency_ms IS NULL OR latency_ms >= 0)
  ),
  CONSTRAINT backlink_model_run_quality_check
    CHECK (jsonb_typeof(quality_result) = 'object'),
  CONSTRAINT backlink_model_run_timing_check CHECK (
    (
      status = 'QUEUED'
      AND started_at IS NULL
      AND finished_at IS NULL
    )
    OR (
      status = 'RUNNING'
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
  CONSTRAINT backlink_model_run_error_check CHECK (
    (status IN ('FAILED', 'REFUSED') AND length(btrim(error_code)) > 0)
    OR (status NOT IN ('FAILED', 'REFUSED') AND error_code IS NULL)
  ),
  CONSTRAINT backlink_model_run_success_check CHECK (
    status <> 'SUCCEEDED'
    OR (
      length(btrim(provider_ref)) > 0
      AND length(btrim(model_id)) > 0
      AND length(btrim(model_version)) > 0
      AND input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL
      AND latency_ms IS NOT NULL
      AND attempt_count > 0
    )
  ),
  CONSTRAINT backlink_model_run_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, draft_id,
    opportunity_id, evidence_snapshot_id
  ),
  CONSTRAINT backlink_model_run_idempotency_uq UNIQUE (
    workspace_id, idempotency_key
  ),
  CONSTRAINT backlink_model_run_draft_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, draft_id,
    opportunity_id
  ) REFERENCES backlink_email_drafts (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  ),
  CONSTRAINT backlink_model_run_evidence_snapshot_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, evidence_snapshot_id,
    opportunity_id
  ) REFERENCES backlink_evidence_snapshots (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  )
);

CREATE TABLE backlink_draft_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  version_no integer NOT NULL,
  parent_version_id uuid,
  source text NOT NULL,
  model_run_id uuid,
  evidence_snapshot_id uuid NOT NULL,
  subject_text text NOT NULL,
  body_text text NOT NULL,
  structured_output jsonb NOT NULL,
  evidence_ids jsonb NOT NULL,
  prompt_version text NOT NULL,
  output_schema_version text NOT NULL,
  model_id text,
  model_version text,
  requires_user_confirmation boolean NOT NULL DEFAULT true,
  can_auto_send boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_draft_version_number_check CHECK (version_no > 0),
  CONSTRAINT backlink_draft_version_source_check CHECK (
    source IN ('MODEL', 'MANUAL', 'RESTORED')
  ),
  CONSTRAINT backlink_draft_version_content_check CHECK (
    length(btrim(subject_text)) > 0
    AND length(btrim(body_text)) > 0
  ),
  CONSTRAINT backlink_draft_version_output_check CHECK (
    jsonb_typeof(structured_output) = 'object'
    AND jsonb_typeof(evidence_ids) = 'array'
  ),
  CONSTRAINT backlink_draft_version_safety_check CHECK (
    requires_user_confirmation = true
    AND can_auto_send = false
  ),
  CONSTRAINT backlink_draft_version_model_check CHECK (
    (
      source = 'MODEL'
      AND model_run_id IS NOT NULL
      AND length(btrim(model_id)) > 0
      AND length(btrim(model_version)) > 0
    )
    OR (
      source IN ('MANUAL', 'RESTORED')
      AND model_run_id IS NULL
      AND model_id IS NULL
      AND model_version IS NULL
    )
  ),
  CONSTRAINT backlink_draft_version_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, draft_id,
    opportunity_id
  ),
  CONSTRAINT backlink_draft_version_number_uq UNIQUE (
    organization_id, workspace_id, website_project_id, draft_id, version_no
  ),
  CONSTRAINT backlink_draft_version_draft_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, draft_id,
    opportunity_id
  ) REFERENCES backlink_email_drafts (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  ),
  CONSTRAINT backlink_draft_version_parent_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, parent_version_id,
    draft_id, opportunity_id
  ) REFERENCES backlink_draft_versions (
    organization_id, workspace_id, website_project_id, id, draft_id,
    opportunity_id
  ),
  CONSTRAINT backlink_draft_version_model_run_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, model_run_id,
    draft_id, opportunity_id, evidence_snapshot_id
  ) REFERENCES backlink_model_runs (
    organization_id, workspace_id, website_project_id, id, draft_id,
    opportunity_id, evidence_snapshot_id
  ),
  CONSTRAINT backlink_draft_version_evidence_snapshot_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, evidence_snapshot_id,
    opportunity_id
  ) REFERENCES backlink_evidence_snapshots (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  )
);

ALTER TABLE backlink_email_drafts
  ADD CONSTRAINT backlink_email_draft_current_version_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, current_version_id,
    id, opportunity_id
  ) REFERENCES backlink_draft_versions (
    organization_id, workspace_id, website_project_id, id, draft_id,
    opportunity_id
  ),
  ADD CONSTRAINT backlink_email_draft_approved_version_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, approved_version_id,
    id, opportunity_id
  ) REFERENCES backlink_draft_versions (
    organization_id, workspace_id, website_project_id, id, draft_id,
    opportunity_id
  ),
  ADD CONSTRAINT backlink_email_draft_last_successful_version_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    last_successful_version_id, id, opportunity_id
  ) REFERENCES backlink_draft_versions (
    organization_id, workspace_id, website_project_id, id, draft_id,
    opportunity_id
  );

CREATE FUNCTION backlink_reject_draft_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER backlink_evidence_snapshot_immutable
BEFORE UPDATE OR DELETE ON backlink_evidence_snapshots
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_draft_immutable_mutation();

CREATE TRIGGER backlink_draft_version_immutable
BEFORE UPDATE OR DELETE ON backlink_draft_versions
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_draft_immutable_mutation();

ALTER TABLE backlink_evidence_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_evidence_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_email_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_email_drafts FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_model_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_model_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_draft_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_draft_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_evidence_snapshot_tenant_policy
  ON backlink_evidence_snapshots
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

CREATE POLICY backlink_email_draft_tenant_policy
  ON backlink_email_drafts
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

CREATE POLICY backlink_model_run_tenant_policy
  ON backlink_model_runs
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

CREATE POLICY backlink_draft_version_tenant_policy
  ON backlink_draft_versions
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

REVOKE ALL ON backlink_evidence_snapshots FROM PUBLIC;
REVOKE ALL ON backlink_email_drafts FROM PUBLIC;
REVOKE ALL ON backlink_model_runs FROM PUBLIC;
REVOKE ALL ON backlink_draft_versions FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_reject_draft_immutable_mutation()
  FROM PUBLIC;
REVOKE UPDATE, DELETE
  ON backlink_evidence_snapshots, backlink_draft_versions
  FROM growthos_backlinks_writer;

GRANT SELECT, INSERT
  ON backlink_evidence_snapshots, backlink_draft_versions
  TO growthos_backlinks_writer;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON backlink_email_drafts, backlink_model_runs
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_evidence_snapshots, backlink_email_drafts,
    backlink_model_runs, backlink_draft_versions
  TO growthos_reporting_reader;

COMMIT;
