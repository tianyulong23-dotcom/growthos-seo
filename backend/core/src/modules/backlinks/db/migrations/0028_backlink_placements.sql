BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_placement_candidates (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  opportunity_id uuid,
  source_type text NOT NULL,
  source_external_id text,
  source_page_url text,
  normalized_source_url text,
  normalized_source_url_hash text,
  target_url text NOT NULL,
  normalized_target_url text NOT NULL,
  normalized_target_url_hash text NOT NULL,
  url_normalization_version text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_MATCH',
  match_status text NOT NULL DEFAULT 'UNMATCHED',
  initial_validation_status text NOT NULL DEFAULT 'PENDING',
  discovery_evidence_snapshot jsonb NOT NULL,
  discovery_evidence_hash text NOT NULL,
  evidence_contract_version text NOT NULL,
  evidence_schema_version integer NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_placement_candidate_source_type_check CHECK (
    source_type IN (
      'manual', 'dataforseo',
      'crawler_discovery', 'search_discovery', 'import'
    )
  ),
  CONSTRAINT backlink_placement_candidate_source_url_check CHECK (
    (
      source_page_url IS NULL
      AND normalized_source_url IS NULL
      AND normalized_source_url_hash IS NULL
    )
    OR (
      length(btrim(source_page_url)) > 0
      AND length(btrim(normalized_source_url)) > 0
      AND normalized_source_url_hash ~ '^[a-f0-9]{64}$'
    )
  ),
  CONSTRAINT backlink_placement_candidate_target_url_check CHECK (
    length(btrim(target_url)) > 0
    AND length(btrim(normalized_target_url)) > 0
    AND normalized_target_url_hash ~ '^[a-f0-9]{64}$'
    AND length(btrim(url_normalization_version)) > 0
  ),
  CONSTRAINT backlink_placement_candidate_status_check CHECK (
    status IN (
      'PENDING_MATCH', 'PENDING_VALIDATION', 'REVIEW_REQUIRED',
      'REJECTED', 'PROMOTED'
    )
  ),
  CONSTRAINT backlink_placement_candidate_match_status_check CHECK (
    match_status IN (
      'AUTO_MATCHED', 'REVIEW_REQUIRED', 'UNMATCHED', 'CONFLICTED'
    )
  ),
  CONSTRAINT backlink_placement_candidate_validation_status_check CHECK (
    initial_validation_status IN (
      'PENDING', 'VALID', 'INVALID', 'INCONCLUSIVE',
      'MANUALLY_CONFIRMED'
    )
  ),
  CONSTRAINT backlink_placement_candidate_state_check CHECK (
    (match_status <> 'AUTO_MATCHED' OR opportunity_id IS NOT NULL)
    AND (
      status NOT IN ('PENDING_VALIDATION', 'PROMOTED')
      OR opportunity_id IS NOT NULL
    )
    AND (
      status <> 'PROMOTED'
      OR initial_validation_status IN ('VALID', 'MANUALLY_CONFIRMED')
    )
  ),
  CONSTRAINT backlink_placement_candidate_evidence_check CHECK (
    jsonb_typeof(discovery_evidence_snapshot) = 'object'
    AND discovery_evidence_hash ~ '^[a-f0-9]{64}$'
    AND length(btrim(evidence_contract_version)) > 0
    AND evidence_schema_version > 0
  ),
  CONSTRAINT backlink_placement_candidate_version_check
    CHECK (version > 0),
  CONSTRAINT backlink_placement_candidate_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_placement_candidate_match_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  ),
  CONSTRAINT backlink_placement_candidate_opportunity_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_placement_validation_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  run_number integer NOT NULL,
  validation_method text NOT NULL,
  status text NOT NULL,
  source_page_url text NOT NULL,
  normalized_source_url text NOT NULL,
  normalized_source_url_hash text NOT NULL,
  target_url text NOT NULL,
  normalized_target_url text NOT NULL,
  normalized_target_url_hash text NOT NULL,
  url_normalization_version text NOT NULL,
  evidence_snapshot jsonb NOT NULL,
  evidence_snapshot_hash text NOT NULL,
  evidence_contract_version text NOT NULL,
  evidence_schema_version integer NOT NULL,
  evidence_observed_at timestamptz NOT NULL,
  verified_by text NOT NULL,
  verified_at timestamptz NOT NULL,
  audit_event_id text NOT NULL,
  initial_evidence_ref text NOT NULL,
  manual_confirmation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_placement_validation_run_number_check
    CHECK (run_number > 0),
  CONSTRAINT backlink_placement_validation_method_check CHECK (
    validation_method IN ('direct_page_check', 'manual_confirmation')
  ),
  CONSTRAINT backlink_placement_validation_status_check CHECK (
    status IN ('VALID', 'INVALID', 'INCONCLUSIVE', 'MANUALLY_CONFIRMED')
  ),
  CONSTRAINT backlink_placement_validation_method_result_check CHECK (
    (
      validation_method = 'direct_page_check'
      AND status IN ('VALID', 'INVALID', 'INCONCLUSIVE')
      AND manual_confirmation_reason IS NULL
    )
    OR (
      validation_method = 'manual_confirmation'
      AND status = 'MANUALLY_CONFIRMED'
      AND length(btrim(manual_confirmation_reason)) > 0
    )
  ),
  CONSTRAINT backlink_placement_validation_urls_check CHECK (
    length(btrim(source_page_url)) > 0
    AND length(btrim(normalized_source_url)) > 0
    AND normalized_source_url_hash ~ '^[a-f0-9]{64}$'
    AND length(btrim(target_url)) > 0
    AND length(btrim(normalized_target_url)) > 0
    AND normalized_target_url_hash ~ '^[a-f0-9]{64}$'
    AND length(btrim(url_normalization_version)) > 0
  ),
  CONSTRAINT backlink_placement_validation_evidence_check CHECK (
    jsonb_typeof(evidence_snapshot) = 'object'
    AND evidence_snapshot_hash ~ '^[a-f0-9]{64}$'
    AND length(btrim(evidence_contract_version)) > 0
    AND evidence_schema_version > 0
    AND evidence_observed_at <= verified_at
    AND length(btrim(verified_by)) > 0
    AND length(btrim(audit_event_id)) > 0
    AND length(btrim(initial_evidence_ref)) > 0
  ),
  CONSTRAINT backlink_placement_validation_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_placement_validation_run_number_uq UNIQUE (
    organization_id, workspace_id, website_project_id, candidate_id,
    run_number
  ),
  CONSTRAINT backlink_placement_validation_initial_evidence_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, candidate_id,
    opportunity_id, status, normalized_source_url_hash,
    normalized_target_url_hash, url_normalization_version,
    evidence_snapshot_hash, evidence_contract_version,
    evidence_schema_version
  ),
  CONSTRAINT backlink_placement_validation_candidate_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, candidate_id,
    opportunity_id
  ) REFERENCES backlink_placement_candidates (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  )
);

CREATE TABLE backlink_placements (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  opportunity_id uuid NOT NULL,
  initial_validation_id uuid NOT NULL,
  initial_validation_status text NOT NULL,
  source_page_url text NOT NULL,
  normalized_source_url text NOT NULL,
  normalized_source_url_hash text NOT NULL,
  target_url text NOT NULL,
  normalized_target_url text NOT NULL,
  normalized_target_url_hash text NOT NULL,
  url_normalization_version text NOT NULL,
  initial_evidence_snapshot_hash text NOT NULL,
  evidence_contract_version text NOT NULL,
  initial_evidence_schema_version integer NOT NULL,
  health_status text NOT NULL DEFAULT 'active',
  monitoring_status text NOT NULL DEFAULT 'enabled',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  CONSTRAINT backlink_placement_initial_validation_status_check CHECK (
    initial_validation_status IN ('VALID', 'MANUALLY_CONFIRMED')
  ),
  CONSTRAINT backlink_placement_urls_check CHECK (
    length(btrim(source_page_url)) > 0
    AND length(btrim(normalized_source_url)) > 0
    AND normalized_source_url_hash ~ '^[a-f0-9]{64}$'
    AND length(btrim(target_url)) > 0
    AND length(btrim(normalized_target_url)) > 0
    AND normalized_target_url_hash ~ '^[a-f0-9]{64}$'
    AND length(btrim(url_normalization_version)) > 0
  ),
  CONSTRAINT backlink_placement_initial_evidence_check CHECK (
    initial_evidence_snapshot_hash ~ '^[a-f0-9]{64}$'
    AND length(btrim(evidence_contract_version)) > 0
    AND initial_evidence_schema_version > 0
  ),
  CONSTRAINT backlink_placement_health_status_check CHECK (
    health_status IN (
      'pending_verification', 'active', 'suspected_changed', 'changed',
      'suspected_lost', 'lost'
    )
  ),
  CONSTRAINT backlink_placement_monitoring_status_check
    CHECK (monitoring_status IN ('enabled', 'paused')),
  CONSTRAINT backlink_placement_version_check CHECK (version > 0),
  CONSTRAINT backlink_placement_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_placement_project_urls_uq UNIQUE (
    website_project_id, normalized_source_url_hash,
    normalized_target_url_hash
  ),
  CONSTRAINT backlink_placement_candidate_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, candidate_id,
    opportunity_id
  ) REFERENCES backlink_placement_candidates (
    organization_id, workspace_id, website_project_id, id, opportunity_id
  ),
  CONSTRAINT backlink_placement_opportunity_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_placement_initial_validation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    initial_validation_id, candidate_id, opportunity_id,
    initial_validation_status, normalized_source_url_hash,
    normalized_target_url_hash, url_normalization_version,
    initial_evidence_snapshot_hash, evidence_contract_version,
    initial_evidence_schema_version
  ) REFERENCES backlink_placement_validation_runs (
    organization_id, workspace_id, website_project_id, id, candidate_id,
    opportunity_id, status, normalized_source_url_hash,
    normalized_target_url_hash, url_normalization_version,
    evidence_snapshot_hash, evidence_contract_version,
    evidence_schema_version
  )
);

CREATE FUNCTION backlink_reject_placement_validation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Placement validation evidence is immutable'
    USING ERRCODE = '55000';
END;
$function$;

CREATE FUNCTION backlink_guard_placement_initial_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF ROW(
    NEW.candidate_id,
    NEW.opportunity_id,
    NEW.initial_validation_id,
    NEW.initial_validation_status,
    NEW.source_page_url,
    NEW.normalized_source_url,
    NEW.normalized_source_url_hash,
    NEW.target_url,
    NEW.normalized_target_url,
    NEW.normalized_target_url_hash,
    NEW.url_normalization_version,
    NEW.initial_evidence_snapshot_hash,
    NEW.evidence_contract_version,
    NEW.initial_evidence_schema_version
  ) IS DISTINCT FROM ROW(
    OLD.candidate_id,
    OLD.opportunity_id,
    OLD.initial_validation_id,
    OLD.initial_validation_status,
    OLD.source_page_url,
    OLD.normalized_source_url,
    OLD.normalized_source_url_hash,
    OLD.target_url,
    OLD.normalized_target_url,
    OLD.normalized_target_url_hash,
    OLD.url_normalization_version,
    OLD.initial_evidence_snapshot_hash,
    OLD.evidence_contract_version,
    OLD.initial_evidence_schema_version
  ) THEN
    RAISE EXCEPTION 'Placement initial validation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_placement_validation_immutable
BEFORE UPDATE OR DELETE ON backlink_placement_validation_runs
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_placement_validation_mutation();

CREATE TRIGGER backlink_placement_initial_evidence_immutable
BEFORE UPDATE ON backlink_placements
FOR EACH ROW
EXECUTE FUNCTION backlink_guard_placement_initial_evidence();

ALTER TABLE backlink_placement_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_placement_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_placement_validation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_placement_validation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_placements FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_placement_candidate_tenant_policy
  ON backlink_placement_candidates
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
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
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_placement_validation_tenant_policy
  ON backlink_placement_validation_runs
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
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
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

CREATE POLICY backlink_placement_tenant_policy
  ON backlink_placements
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
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
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    AND website_project_id =
      NULLIF(
        current_setting('app.current_website_project_id', true),
        ''
      )::uuid
  );

REVOKE ALL ON backlink_placement_candidates FROM PUBLIC;
REVOKE ALL ON backlink_placement_validation_runs FROM PUBLIC;
REVOKE ALL ON backlink_placements FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_reject_placement_validation_mutation()
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_guard_placement_initial_evidence()
  FROM PUBLIC;
REVOKE UPDATE, DELETE
  ON backlink_placement_validation_runs
  FROM growthos_backlinks_writer;
REVOKE DELETE
  ON backlink_placement_candidates, backlink_placements
  FROM growthos_backlinks_writer;

GRANT SELECT, INSERT, UPDATE
  ON backlink_placement_candidates, backlink_placements
  TO growthos_backlinks_writer;
GRANT SELECT, INSERT
  ON backlink_placement_validation_runs
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_placement_candidates, backlink_placement_validation_runs,
    backlink_placements
  TO growthos_reporting_reader;

COMMIT;
