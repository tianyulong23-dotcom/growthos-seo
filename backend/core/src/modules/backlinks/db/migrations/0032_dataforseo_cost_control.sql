BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE provider_batch_requests (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  provider text NOT NULL,
  endpoint text NOT NULL,
  request_intent text NOT NULL,
  refresh_mode text NOT NULL,
  location_code text NOT NULL,
  language_code text NOT NULL,
  request_schema_version integer NOT NULL,
  response_schema_version text NOT NULL,
  normalized_request_hash text NOT NULL,
  request_count integer NOT NULL,
  succeeded_count integer NOT NULL DEFAULT 0,
  negative_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  estimated_cost_micros bigint NOT NULL,
  actual_cost_micros bigint,
  raw_payload_hash text,
  provider_task_id text,
  result_summary jsonb,
  status text NOT NULL DEFAULT 'running',
  failure_code text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  request_id text NOT NULL,
  budget_reservation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT provider_batch_request_values_check CHECK (
    provider = 'dataforseo'
    AND length(btrim(endpoint)) > 0
    AND request_intent IN (
      'DISCOVERY', 'CARD_ENRICHMENT', 'DEEP_ASSESSMENT', 'MONITORING'
    )
    AND refresh_mode IN (
      'CACHE_PREFERRED', 'BACKGROUND_REFRESH', 'FORCE_LIVE'
    )
    AND length(btrim(location_code)) > 0
    AND length(btrim(language_code)) > 0
    AND request_schema_version > 0
    AND length(btrim(response_schema_version)) > 0
    AND normalized_request_hash ~ '^[a-f0-9]{64}$'
    AND request_count > 0
    AND succeeded_count >= 0
    AND negative_count >= 0
    AND failed_count >= 0
    AND succeeded_count + negative_count + failed_count <= request_count
    AND estimated_cost_micros >= 0
    AND (actual_cost_micros IS NULL OR actual_cost_micros >= 0)
    AND (
      raw_payload_hash IS NULL
      OR raw_payload_hash ~ '^[a-f0-9]{64}$'
    )
    AND (
      result_summary IS NULL
      OR jsonb_typeof(result_summary) = 'array'
    )
    AND status IN ('running', 'succeeded', 'partial', 'failed', 'unknown_charge')
    AND length(btrim(request_id)) > 0
    AND length(btrim(budget_reservation_id)) > 0
    AND length(btrim(created_by)) > 0
  ),
  CONSTRAINT provider_batch_request_state_check CHECK (
    (status = 'running' AND finished_at IS NULL)
    OR (status <> 'running' AND finished_at IS NOT NULL)
  ),
  CONSTRAINT provider_batch_request_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE INDEX provider_batch_request_trace_idx
  ON provider_batch_requests (
    organization_id, workspace_id, website_project_id,
    request_intent, started_at DESC
  );

CREATE TABLE provider_artifacts (
  id uuid PRIMARY KEY,
  artifact_fingerprint text NOT NULL UNIQUE,
  provider text NOT NULL,
  endpoint text NOT NULL,
  subject_type text NOT NULL,
  subject_key text NOT NULL,
  location_code text NOT NULL,
  language_code text NOT NULL,
  request_schema_version integer NOT NULL,
  response_schema_version text NOT NULL,
  normalized_payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  quality_status text NOT NULL,
  observed_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  stale_until timestamptz NOT NULL,
  source_batch_id uuid NOT NULL REFERENCES provider_batch_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_artifact_public_identity_check CHECK (
    artifact_fingerprint ~ '^[a-f0-9]{64}$'
    AND provider = 'dataforseo'
    AND length(btrim(endpoint)) > 0
    AND subject_type IN ('domain', 'page')
    AND length(btrim(subject_key)) > 0
    AND length(btrim(location_code)) > 0
    AND length(btrim(language_code)) > 0
    AND request_schema_version > 0
    AND length(btrim(response_schema_version)) > 0
    AND jsonb_typeof(normalized_payload) = 'object'
    AND payload_hash ~ '^[a-f0-9]{64}$'
    AND quality_status IN ('complete', 'negative')
    AND observed_at <= fresh_until
    AND fresh_until < stale_until
  )
);

CREATE INDEX provider_artifact_subject_idx
  ON provider_artifacts (
    provider, endpoint, subject_type, subject_key,
    location_code, language_code, observed_at DESC
  );

CREATE TABLE workspace_evidence_projections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  artifact_id uuid NOT NULL REFERENCES provider_artifacts(id),
  project_context_version integer NOT NULL,
  recommendation_context_version_id uuid,
  opportunity_id uuid,
  usage_purpose text NOT NULL,
  first_served_at timestamptz NOT NULL,
  last_served_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_evidence_projection_values_check CHECK (
    project_context_version > 0
    AND length(btrim(usage_purpose)) > 0
    AND first_served_at <= last_served_at
    AND version > 0
  ),
  CONSTRAINT workspace_evidence_projection_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT workspace_evidence_projection_artifact_uq UNIQUE (
    organization_id, workspace_id, website_project_id, artifact_id,
    project_context_version, usage_purpose
  )
);

CREATE INDEX workspace_evidence_projection_context_idx
  ON workspace_evidence_projections (
    organization_id, workspace_id, website_project_id,
    project_context_version, last_served_at DESC
  );

CREATE TABLE provider_artifact_usages (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  artifact_id uuid NOT NULL REFERENCES provider_artifacts(id),
  batch_request_id uuid REFERENCES provider_batch_requests(id),
  request_intent text NOT NULL,
  refresh_mode text NOT NULL,
  served_from text NOT NULL,
  allocated_cost_micros bigint NOT NULL,
  used_at timestamptz NOT NULL,
  usage_purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_artifact_usage_values_check CHECK (
    request_intent IN (
      'DISCOVERY', 'CARD_ENRICHMENT', 'DEEP_ASSESSMENT', 'MONITORING'
    )
    AND refresh_mode IN (
      'CACHE_PREFERRED', 'BACKGROUND_REFRESH', 'FORCE_LIVE'
    )
    AND served_from IN (
      'provider_live', 'provider_bulk', 'fresh_cache', 'stale_cache',
      'single_flight', 'negative_cache'
    )
    AND allocated_cost_micros >= 0
    AND length(btrim(usage_purpose)) > 0
  ),
  CONSTRAINT provider_artifact_usage_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE INDEX provider_artifact_usage_cost_idx
  ON provider_artifact_usages (
    organization_id, workspace_id, website_project_id,
    request_intent, used_at DESC
  );

CREATE TABLE provider_fetch_leases (
  artifact_fingerprint text PRIMARY KEY,
  status text NOT NULL,
  owner_request_id text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 1,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_fetch_lease_values_check CHECK (
    artifact_fingerprint ~ '^[a-f0-9]{64}$'
    AND status IN (
      'acquired', 'completed', 'failed', 'expired', 'unknown_charge'
    )
    AND length(btrim(owner_request_id)) > 0
    AND lease_expires_at >= heartbeat_at
    AND attempt_count > 0
  )
);

ALTER TABLE provider_batch_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_batch_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_evidence_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_evidence_projections FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_artifact_usages ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_artifact_usages FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_fetch_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_fetch_leases FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_batch_request_internal_policy
  ON provider_batch_requests TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY provider_artifact_internal_policy
  ON provider_artifacts TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY provider_fetch_lease_internal_policy
  ON provider_fetch_leases TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY workspace_evidence_projection_internal_policy
  ON workspace_evidence_projections TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY provider_artifact_usage_internal_policy
  ON provider_artifact_usages TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_provider_request_cost_control_internal_policy
  ON backlink_provider_requests TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_provider_budget_cost_control_internal_policy
  ON backlink_provider_budgets TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_provider_usage_cost_control_internal_policy
  ON backlink_provider_usage_ledger TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);

CREATE POLICY workspace_evidence_projection_tenant_policy
  ON workspace_evidence_projections
  TO growthos_backlinks_writer, growthos_reporting_reader
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

CREATE POLICY provider_artifact_usage_tenant_policy
  ON provider_artifact_usages
  TO growthos_backlinks_writer, growthos_reporting_reader
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

REVOKE ALL ON provider_batch_requests FROM PUBLIC;
REVOKE ALL ON provider_artifacts FROM PUBLIC;
REVOKE ALL ON workspace_evidence_projections FROM PUBLIC;
REVOKE ALL ON provider_artifact_usages FROM PUBLIC;
REVOKE ALL ON provider_fetch_leases FROM PUBLIC;
REVOKE ALL ON provider_batch_requests
  FROM growthos_backlinks_writer, growthos_reporting_reader;
REVOKE ALL ON provider_artifacts
  FROM growthos_backlinks_writer, growthos_reporting_reader;
REVOKE ALL ON provider_fetch_leases
  FROM growthos_backlinks_writer, growthos_reporting_reader;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON workspace_evidence_projections, provider_artifact_usages
  TO growthos_backlinks_writer;
GRANT SELECT
  ON workspace_evidence_projections, provider_artifact_usages
  TO growthos_reporting_reader;

COMMIT;
