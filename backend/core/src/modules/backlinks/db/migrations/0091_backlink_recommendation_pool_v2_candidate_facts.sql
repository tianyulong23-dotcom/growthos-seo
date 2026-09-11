BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_commercial_discovery_blueprints
  ADD COLUMN seed_snapshot_fingerprint text,
  ADD CONSTRAINT backlink_commercial_blueprint_seed_snapshot_ck CHECK (
    seed_snapshot_fingerprint IS NULL
    OR seed_snapshot_fingerprint ~ '^[a-f0-9]{64}$'
  );

CREATE UNIQUE INDEX backlink_commercial_blueprint_seed_snapshot_uq
  ON backlink_commercial_discovery_blueprints (
    organization_id, workspace_id, website_project_id,
    project_context_version_id, seed_snapshot_fingerprint
  )
  WHERE status = 'active' AND seed_snapshot_fingerprint IS NOT NULL;

CREATE OR REPLACE FUNCTION backlink_reject_commercial_blueprint_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'active'
     AND NEW.status = 'stale_context'
     AND OLD.id = NEW.id
     AND OLD.organization_id = NEW.organization_id
     AND OLD.workspace_id = NEW.workspace_id
     AND OLD.website_project_id = NEW.website_project_id
     AND OLD.project_context_version_id = NEW.project_context_version_id
     AND OLD.blueprint_version = NEW.blueprint_version
     AND OLD.generator = NEW.generator
     AND OLD.schema_version = NEW.schema_version
     AND OLD.prompt_version = NEW.prompt_version
     AND OLD.model_version IS NOT DISTINCT FROM NEW.model_version
     AND OLD.rule_version = NEW.rule_version
     AND OLD.blueprint = NEW.blueprint
     AND OLD.evidence_refs = NEW.evidence_refs
     AND OLD.seed_snapshot_fingerprint IS NOT DISTINCT FROM
           NEW.seed_snapshot_fingerprint
     AND OLD.generated_at = NEW.generated_at
     AND OLD.created_at = NEW.created_at
     AND OLD.created_by = NEW.created_by THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'commercial discovery blueprints are immutable';
END;
$function$;

ALTER TABLE backlink_recommendation_generation_contracts
  DROP CONSTRAINT backlink_rec_generation_values_v3_2_ck,
  ADD CONSTRAINT backlink_rec_generation_values_ck CHECK (
    visible_pool_generation > 0
    AND metric_scope IN ('TARGET_MARKET', 'GLOBAL')
    AND length(btrim(market)) > 0
    AND length(btrim(location)) > 0
    AND length(btrim(language)) > 0
    AND jsonb_typeof(request_fingerprints) = 'object'
    AND (
      (
        metric_scope = 'TARGET_MARKET'
        AND traffic_location_code IS NOT NULL
        AND traffic_language_code IS NOT NULL
        AND length(btrim(traffic_language_code)) > 0
      )
      OR (
        metric_scope = 'GLOBAL'
        AND traffic_location_code IS NULL
        AND traffic_language_code IS NULL
      )
    )
    AND (
      (
        pool_contract_version = 'recommendation-pool.v1'
        AND qualification_contract_version =
              'recommendation-qualification.v1'
        AND visibility_contract_version =
              'recommendation-visibility.v1'
        AND score_model_version = 'recommendation-commercial-fit.v4'
        AND creator_worker_contract_version =
              'recommendation-qualification.v1'
      )
      OR (
        pool_contract_version = 'recommendation-pool.v2'
        AND qualification_contract_version =
              'recommendation-pool-admission.v2'
        AND visibility_contract_version =
              'recommendation-pool-release-visibility.v2'
        AND score_model_version =
              'recommendation-pool-materialization.v2'
        AND creator_worker_contract_version =
              'recommendation-pool-worker.v2'
      )
    )
  ) NOT VALID;

ALTER TABLE backlink_commercial_discovery_batches
  ADD COLUMN generation_contract_id uuid,
  ADD COLUMN input_pin_id uuid,
  ADD COLUMN pool_contract_version text,
  ADD COLUMN materialization_contract_version text,
  DROP CONSTRAINT backlink_commercial_batch_intent_check,
  ADD CONSTRAINT backlink_commercial_batch_intent_check CHECK (
    request_intent IN (
      'DISCOVERY', 'CARD_ENRICHMENT', 'DEEP_ASSESSMENT', 'MONITORING',
      'V2_MATERIALIZATION'
    )
  ),
  ADD CONSTRAINT backlink_commercial_batch_v2_materialization_ck CHECK (
    (
      generation_contract_id IS NULL
      AND input_pin_id IS NULL
      AND pool_contract_version IS NULL
      AND materialization_contract_version IS NULL
    )
    OR (
      generation_contract_id IS NOT NULL
      AND input_pin_id IS NOT NULL
      AND pool_contract_version = 'recommendation-pool.v2'
      AND materialization_contract_version =
            'recommendation-pool-materialization.v2'
      AND request_intent = 'V2_MATERIALIZATION'
      AND status = 'completed'
      AND source_types = '["V2_CANONICAL_MATERIALIZATION"]'::jsonb
      AND provider_request_fingerprints = '[]'::jsonb
      AND provider_collected_at IS NULL
      AND paid_cost_micros = 0
      AND pause_reason IS NULL
      AND finished_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT backlink_commercial_batch_v2_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, project_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT;

CREATE UNIQUE INDEX backlink_commercial_batch_v2_materialization_uq
  ON backlink_commercial_discovery_batches (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, materialization_contract_version
  )
  WHERE generation_contract_id IS NOT NULL;

ALTER TABLE backlink_commercial_candidates
  DROP CONSTRAINT backlink_commercial_candidate_score_version_check,
  DROP CONSTRAINT backlink_commercial_candidate_state_check,
  ADD CONSTRAINT backlink_commercial_candidate_score_version_check CHECK (
    score_model_version IN (
      'recommendation-commercial-fit.v2',
      'recommendation-commercial-fit.v3',
      'recommendation-commercial-fit.v4',
      'recommendation-pool-materialization.v2'
    )
  ),
  ADD CONSTRAINT backlink_commercial_candidate_state_check CHECK (
    state IN (
      'candidate_ready', 'enrichment_eligible', 'contact_enrichment', 'published',
      'excluded', 'insufficient_data', 'manual_review', 'stale_context',
      'v2_materialized'
    )
  ),
  ADD CONSTRAINT backlink_commercial_candidate_v2_materialization_ck CHECK (
    score_model_version <> 'recommendation-pool-materialization.v2'
    OR (
      state = 'v2_materialized'
      AND source_types = '["V2_CANONICAL_MATERIALIZATION"]'::jsonb
      AND static_assessment = jsonb_build_object(
        'contractVersion', 'recommendation-pool-materialization.v2',
        'assessment', 'NOT_SCORED'
      )
      AND gate_decision = jsonb_build_object(
        'contractVersion', 'recommendation-pool-materialization.v2',
        'decision', 'NOT_APPLICABLE'
      )
      AND commercial_score = jsonb_build_object(
        'contractVersion', 'recommendation-pool-materialization.v2',
        'score', NULL
      )
      AND provider_collected_at IS NULL
    )
  );

CREATE OR REPLACE FUNCTION backlink_validate_v2_materialized_candidate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.score_model_version = 'recommendation-pool-materialization.v2' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'V2 canonical materialization is immutable.';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.score_model_version = 'recommendation-pool-materialization.v2' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'V2 canonical materialization is immutable.';
  END IF;

  IF NEW.score_model_version = 'recommendation-pool-materialization.v2'
     AND NOT EXISTS (
       SELECT 1
         FROM backlink_commercial_discovery_batches AS batch
        WHERE batch.organization_id = NEW.organization_id
          AND batch.workspace_id = NEW.workspace_id
          AND batch.website_project_id = NEW.website_project_id
          AND batch.id = NEW.discovery_batch_id
          AND batch.project_context_version_id =
                NEW.project_context_version_id
          AND batch.visible_pool_generation = NEW.visible_pool_generation
          AND batch.request_intent = 'V2_MATERIALIZATION'
          AND batch.materialization_contract_version =
                'recommendation-pool-materialization.v2'
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'V2 canonical candidates require the exact zero-cost materialization carrier.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_commercial_candidate_v2_materialization_guard
BEFORE INSERT OR UPDATE OR DELETE ON backlink_commercial_candidates
FOR EACH ROW EXECUTE FUNCTION backlink_validate_v2_materialized_candidate();

ALTER TABLE backlink_recommendations
  ADD COLUMN generation_contract_id uuid,
  ADD COLUMN visible_pool_generation integer,
  ADD COLUMN input_pin_id uuid,
  ADD COLUMN pool_contract_version text,
  ADD COLUMN materialization_contract_version text,
  ADD CONSTRAINT backlink_recommendation_v2_lineage_ck CHECK (
    (
      generation_contract_id IS NULL
      AND visible_pool_generation IS NULL
      AND input_pin_id IS NULL
      AND pool_contract_version IS NULL
      AND materialization_contract_version IS NULL
    )
    OR (
      generation_contract_id IS NOT NULL
      AND visible_pool_generation > 0
      AND input_pin_id IS NOT NULL
      AND pool_contract_version = 'recommendation-pool.v2'
      AND materialization_contract_version =
            'recommendation-pool-materialization.v2'
    )
  ),
  ADD CONSTRAINT backlink_recommendation_v2_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT;

CREATE TABLE backlink_recommendation_generation_candidates (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  input_pin_id uuid NOT NULL,
  pool_contract_version text NOT NULL
    DEFAULT 'recommendation-pool.v2',
  canonical_domain text NOT NULL,
  admission_state text NOT NULL,
  admission_contract_version text NOT NULL,
  exclusion_reason_code text,
  exclusion_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_evidence jsonb NOT NULL,
  first_seen_request_intent text NOT NULL,
  recommended boolean NOT NULL,
  recommendation_reason_codes jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL,
  admitted_at timestamptz,
  excluded_at timestamptz,
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_generation_candidate_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_generation_candidate_domain_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, canonical_domain
  ),
  CONSTRAINT backlink_generation_candidate_lineage_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version,
    canonical_domain
  ),
  CONSTRAINT backlink_generation_candidate_values_ck CHECK (
    pool_contract_version = 'recommendation-pool.v2'
    AND admission_contract_version = 'recommendation-pool-admission.v2'
    AND visible_pool_generation > 0
    AND canonical_domain = lower(canonical_domain)
    AND length(btrim(canonical_domain)) > 0
    AND canonical_domain !~ '[.]$'
    AND admission_state IN ('ADMITTED', 'EXCLUDED')
    AND jsonb_typeof(exclusion_evidence) = 'object'
    AND jsonb_typeof(decision_evidence) = 'object'
    AND decision_evidence <> '{}'::jsonb
    AND length(btrim(first_seen_request_intent)) > 0
    AND jsonb_typeof(recommendation_reason_codes) = 'array'
    AND jsonb_array_length(recommendation_reason_codes) > 0
    AND first_seen_at <= decided_at
    AND (
      (
        admission_state = 'ADMITTED'
        AND exclusion_reason_code IS NULL
        AND exclusion_evidence = '{}'::jsonb
        AND admitted_at = decided_at
        AND excluded_at IS NULL
      )
      OR (
        admission_state = 'EXCLUDED'
        AND recommended = false
        AND exclusion_reason_code IN (
          'SELF_DOMAIN',
          'INVALID_DOMAIN',
          'UNREACHABLE_DOMAIN',
          'MALICIOUS_OR_BLOCKED',
          'ALREADY_RELEASED_TO_PROJECT',
          'EXISTING_PROJECT_OPPORTUNITY',
          'OBVIOUSLY_UNRELATED',
          'PERMANENTLY_EXCLUDED'
        )
        AND exclusion_evidence <> '{}'::jsonb
        AND admitted_at IS NULL
        AND excluded_at = decided_at
      )
    )
  ),
  CONSTRAINT backlink_generation_candidate_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_generation_candidate_sources (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_candidate_id uuid NOT NULL,
  request_intent text NOT NULL,
  provider_outcome text NOT NULL,
  source_type text NOT NULL,
  discovered_url text NOT NULL,
  source_ref text NOT NULL,
  evidence_payload jsonb NOT NULL,
  evidence_fingerprint text NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_generation_candidate_source_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_generation_candidate_source_evidence_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_candidate_id, evidence_fingerprint
  ),
  CONSTRAINT backlink_generation_candidate_source_values_ck CHECK (
    length(btrim(request_intent)) > 0
    AND provider_outcome IN (
      'SUCCEEDED', 'PARTIAL', 'EMPTY', 'FAILED', 'UNAVAILABLE', 'UNSUPPORTED'
    )
    AND length(btrim(source_type)) > 0
    AND length(btrim(discovered_url)) > 0
    AND length(btrim(source_ref)) > 0
    AND jsonb_typeof(evidence_payload) = 'object'
    AND evidence_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT backlink_generation_candidate_source_candidate_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_candidate_id
  ) REFERENCES backlink_recommendation_generation_candidates (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_candidate_metric_snapshots (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_candidate_id uuid NOT NULL,
  metric_type text NOT NULL,
  value_state text NOT NULL,
  provider text NOT NULL,
  endpoint text NOT NULL,
  market text NOT NULL,
  location text NOT NULL,
  language text NOT NULL,
  request_intent text NOT NULL,
  metric_value jsonb,
  request_ref text,
  artifact_ref text,
  evidence_fingerprint text NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_candidate_metric_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_candidate_metric_evidence_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_candidate_id, metric_type, evidence_fingerprint
  ),
  CONSTRAINT backlink_candidate_metric_values_ck CHECK (
    length(btrim(metric_type)) > 0
    AND length(btrim(provider)) > 0
    AND length(btrim(endpoint)) > 0
    AND length(btrim(market)) > 0
    AND length(btrim(location)) > 0
    AND length(btrim(language)) > 0
    AND length(btrim(request_intent)) > 0
    AND value_state IN (
      'AVAILABLE', 'UNAVAILABLE', 'FAILED', 'UNSUPPORTED'
    )
    AND (
      (
        value_state = 'AVAILABLE'
        AND metric_value IS NOT NULL
        AND jsonb_typeof(metric_value) <> 'null'
      )
      OR (
        value_state IN ('UNAVAILABLE', 'FAILED', 'UNSUPPORTED')
        AND metric_value IS NULL
      )
    )
    AND (
      COALESCE(length(btrim(request_ref)) > 0, false)
      OR COALESCE(length(btrim(artifact_ref)) > 0, false)
    )
    AND evidence_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT backlink_candidate_metric_candidate_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_candidate_id
  ) REFERENCES backlink_recommendation_generation_candidates (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_generation_candidate_links (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_candidate_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  inventory_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  materialization_contract_version text NOT NULL,
  idempotency_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_generation_candidate_link_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_generation_candidate_link_source_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_candidate_id
  ),
  CONSTRAINT backlink_generation_candidate_link_idempotency_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    idempotency_fingerprint
  ),
  CONSTRAINT backlink_generation_candidate_link_canonical_uq UNIQUE (
    organization_id, workspace_id, website_project_id, candidate_id
  ),
  CONSTRAINT backlink_generation_candidate_link_values_ck CHECK (
    visible_pool_generation > 0
    AND materialization_contract_version =
          'recommendation-pool-materialization.v2'
    AND idempotency_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT backlink_generation_candidate_link_source_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_candidate_id
  ) REFERENCES backlink_recommendation_generation_candidates (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_generation_candidate_link_candidate_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, candidate_id,
    recommendation_context_version_id, visible_pool_generation,
    recommendation_id, prospect_id
  ) REFERENCES backlink_commercial_candidates (
    organization_id, workspace_id, website_project_id, id,
    project_context_version_id, visible_pool_generation,
    recommendation_id, prospect_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_generation_candidate_link_recommendation_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id,
      recommendation_id, prospect_id, recommendation_context_version_id
    ) REFERENCES backlink_recommendations (
      organization_id, workspace_id, website_project_id, id,
      prospect_id, recommendation_context_version_id
    ) ON DELETE RESTRICT,
  CONSTRAINT backlink_generation_candidate_link_prospect_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    prospect_id, recommendation_context_version_id
  ) REFERENCES backlink_prospects (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_generation_candidate_link_inventory_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, inventory_id,
    recommendation_id, prospect_id, recommendation_context_version_id,
    visible_pool_generation
  ) REFERENCES backlink_recommendation_inventory (
    organization_id, workspace_id, website_project_id, id,
    recommendation_id, prospect_id, recommendation_context_version_id,
    visible_pool_generation
  ) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION backlink_guard_generation_candidate_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF NEW.admission_state = 'ADMITTED' AND (
    EXISTS (
      SELECT 1
        FROM backlink_project_context_snapshots AS context
       WHERE context.organization_id = NEW.organization_id
         AND context.workspace_id = NEW.workspace_id
         AND context.website_project_id = NEW.website_project_id
         AND context.id = NEW.recommendation_context_version_id
         AND context.canonical_domain = NEW.canonical_domain
    )
    OR EXISTS (
      SELECT 1
        FROM backlink_recommendation_release_batch_items AS item
       WHERE item.organization_id = NEW.organization_id
         AND item.workspace_id = NEW.workspace_id
         AND item.website_project_id = NEW.website_project_id
         AND item.canonical_domain = NEW.canonical_domain
    )
    OR EXISTS (
      SELECT 1
        FROM backlink_opportunities AS opportunity
       WHERE opportunity.organization_id = NEW.organization_id
         AND opportunity.workspace_id = NEW.workspace_id
         AND opportunity.website_project_id = NEW.website_project_id
         AND opportunity.target_site_key = NEW.canonical_domain
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE =
        'V2 candidate admission lost a historical-domain uniqueness race.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_generation_candidate_history_guard
BEFORE INSERT ON backlink_recommendation_generation_candidates
FOR EACH ROW EXECUTE FUNCTION backlink_guard_generation_candidate_history();

CREATE TRIGGER backlink_generation_candidate_immutable
BEFORE UPDATE OR DELETE ON backlink_recommendation_generation_candidates
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE TRIGGER backlink_generation_candidate_source_immutable
BEFORE UPDATE OR DELETE
ON backlink_recommendation_generation_candidate_sources
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE TRIGGER backlink_candidate_metric_snapshot_immutable
BEFORE UPDATE OR DELETE
ON backlink_recommendation_candidate_metric_snapshots
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE TRIGGER backlink_generation_candidate_link_immutable
BEFORE UPDATE OR DELETE
ON backlink_recommendation_generation_candidate_links
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

ALTER TABLE backlink_recommendation_release_batch_items
  ADD COLUMN generation_candidate_id uuid,
  ADD CONSTRAINT backlink_release_item_native_generation_candidate_ck CHECK (
    legacy_imported OR generation_candidate_id IS NOT NULL
  ) NOT VALID,
  ADD CONSTRAINT backlink_release_item_generation_candidate_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_candidate_id, generation_contract_id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version, canonical_domain
  ) REFERENCES backlink_recommendation_generation_candidates (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version,
    canonical_domain
  ) ON DELETE RESTRICT;

CREATE INDEX backlink_generation_candidate_admission_idx
  ON backlink_recommendation_generation_candidates (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, admission_state, canonical_domain
  );

CREATE INDEX backlink_generation_candidate_source_idx
  ON backlink_recommendation_generation_candidate_sources (
    organization_id, workspace_id, website_project_id,
    generation_candidate_id, observed_at
  );

CREATE INDEX backlink_candidate_metric_snapshot_idx
  ON backlink_recommendation_candidate_metric_snapshots (
    organization_id, workspace_id, website_project_id,
    generation_candidate_id, metric_type, observed_at
  );

ALTER TABLE backlink_recommendation_generation_candidates
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_generation_candidates
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_generation_candidate_sources
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_generation_candidate_sources
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_candidate_metric_snapshots
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_candidate_metric_snapshots
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_generation_candidate_links
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_generation_candidate_links
  FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_generation_candidate_tenant_policy
ON backlink_recommendation_generation_candidates
USING (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
)
WITH CHECK (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
);

CREATE POLICY backlink_generation_candidate_source_tenant_policy
ON backlink_recommendation_generation_candidate_sources
USING (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
)
WITH CHECK (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
);

CREATE POLICY backlink_candidate_metric_snapshot_tenant_policy
ON backlink_recommendation_candidate_metric_snapshots
USING (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
)
WITH CHECK (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
);

CREATE POLICY backlink_generation_candidate_link_tenant_policy
ON backlink_recommendation_generation_candidate_links
USING (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
)
WITH CHECK (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
);

CREATE OR REPLACE FUNCTION backlink_phase9_can_insert_v2_recommendation(
  p_recommendation jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF p_recommendation IS NULL
     OR p_recommendation->>'pool_contract_version' <>
          'recommendation-pool.v2'
     OR p_recommendation->>'materialization_contract_version' <>
          'recommendation-pool-materialization.v2'
     OR p_recommendation->>'generation_contract_id' IS NULL
     OR p_recommendation->>'recommendation_context_version_id' IS NULL
     OR p_recommendation->>'visible_pool_generation' IS NULL
     OR p_recommendation->>'input_pin_id' IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM backlink_recommendation_generation_contracts AS generation
     WHERE generation.organization_id =
             (p_recommendation->>'organization_id')::uuid
       AND generation.workspace_id =
             (p_recommendation->>'workspace_id')::uuid
       AND generation.website_project_id =
             (p_recommendation->>'website_project_id')::uuid
       AND generation.id =
             (p_recommendation->>'generation_contract_id')::uuid
       AND generation.recommendation_context_version_id =
             (p_recommendation->>'recommendation_context_version_id')::uuid
       AND generation.visible_pool_generation =
             (p_recommendation->>'visible_pool_generation')::integer
       AND generation.input_pin_id =
             (p_recommendation->>'input_pin_id')::uuid
       AND generation.pool_contract_version = 'recommendation-pool.v2'
       AND generation.qualification_contract_version =
             'recommendation-pool-admission.v2'
       AND generation.visibility_contract_version =
             'recommendation-pool-release-visibility.v2'
       AND generation.score_model_version =
             'recommendation-pool-materialization.v2'
       AND generation.creator_worker_contract_version =
             'recommendation-pool-worker.v2'
  );
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_pool_project_contract()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  generation_completed_at timestamptz;
  allowed_transition boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Backlinks recommendation pool project contracts cannot be deleted.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    allowed_transition := (
      (OLD.migration_state = 'V1_ACTIVE'
        AND NEW.migration_state IN (
          'V2_READY', 'V2_ACTIVE', 'MIGRATION_BLOCKED'
        ))
      OR (OLD.migration_state = 'V2_READY'
        AND NEW.migration_state IN ('V2_ACTIVE', 'MIGRATION_BLOCKED'))
      OR (OLD.migration_state = 'MIGRATION_BLOCKED'
        AND NEW.migration_state IN ('V2_READY', 'V2_ACTIVE'))
      OR (OLD.migration_state = 'V2_ACTIVE'
        AND NEW.migration_state = 'V2_ACTIVE'
        AND NEW.visible_pool_generation > OLD.visible_pool_generation
        AND NEW.generation_contract_id <> OLD.generation_contract_id)
      OR (OLD.migration_state = 'V2_ACTIVE'
        AND NEW.migration_state IN (
          'MIGRATION_BLOCKED', 'V2_MAINTENANCE_READ_ONLY'
        ))
      OR (OLD.migration_state = 'V2_MAINTENANCE_READ_ONLY'
        AND NEW.migration_state = 'V2_ACTIVE')
    );

    IF NOT allowed_transition
       OR OLD.id <> NEW.id
       OR OLD.organization_id <> NEW.organization_id
       OR OLD.workspace_id <> NEW.workspace_id
       OR OLD.website_project_id <> NEW.website_project_id
       OR OLD.created_at <> NEW.created_at
       OR OLD.created_by <> NEW.created_by
       OR NEW.version <> OLD.version + 1
       OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION
        'Invalid recommendation pool project contract transition.';
    END IF;
  END IF;

  IF NEW.migration_state IN ('V2_ACTIVE', 'V2_MAINTENANCE_READ_ONLY') THEN
    SELECT generation.discovery_completed_at
      INTO generation_completed_at
      FROM backlink_recommendation_generation_contracts AS generation
      JOIN backlink_generation_input_pins AS pin
        ON pin.organization_id = generation.organization_id
       AND pin.workspace_id = generation.workspace_id
       AND pin.website_project_id = generation.website_project_id
       AND pin.id = generation.input_pin_id
     WHERE generation.organization_id = NEW.organization_id
       AND generation.workspace_id = NEW.workspace_id
       AND generation.website_project_id = NEW.website_project_id
       AND generation.id = NEW.generation_contract_id
       AND generation.recommendation_context_version_id =
             NEW.recommendation_context_version_id
       AND generation.visible_pool_generation = NEW.visible_pool_generation
       AND generation.input_pin_id = NEW.input_pin_id
       AND generation.pool_contract_version = 'recommendation-pool.v2'
       AND generation.qualification_contract_version =
             'recommendation-pool-admission.v2'
       AND generation.visibility_contract_version =
             'recommendation-pool-release-visibility.v2'
       AND generation.score_model_version =
             'recommendation-pool-materialization.v2'
       AND generation.creator_worker_contract_version =
             'recommendation-pool-worker.v2'
       AND pin.qualification_contract_version =
             'recommendation-pool-admission.v2';

    IF NOT FOUND OR generation_completed_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'An active V2 project requires exact completed V2 lineage.';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

UPDATE backlink_recommendation_pool_project_contracts AS contract
   SET migration_state = 'MIGRATION_BLOCKED',
       state_reason_codes =
         CASE
           WHEN contract.state_reason_codes ? 'V2_CANDIDATE_LINEAGE_INCOMPLETE'
             THEN contract.state_reason_codes
           ELSE contract.state_reason_codes ||
             '["V2_CANDIDATE_LINEAGE_INCOMPLETE"]'::jsonb
         END,
       activated_at = NULL,
       updated_at = statement_timestamp(),
       updated_by = 'backlinks-0091',
       version = contract.version + 1
  FROM backlink_recommendation_generation_contracts AS generation
  JOIN backlink_generation_input_pins AS pin
    ON pin.organization_id = generation.organization_id
   AND pin.workspace_id = generation.workspace_id
   AND pin.website_project_id = generation.website_project_id
   AND pin.id = generation.input_pin_id
 WHERE contract.organization_id = generation.organization_id
   AND contract.workspace_id = generation.workspace_id
   AND contract.website_project_id = generation.website_project_id
   AND contract.generation_contract_id = generation.id
   AND contract.migration_state IN ('V2_READY', 'V2_ACTIVE')
   AND (
     generation.qualification_contract_version <>
       'recommendation-pool-admission.v2'
     OR generation.visibility_contract_version <>
       'recommendation-pool-release-visibility.v2'
     OR generation.score_model_version <>
       'recommendation-pool-materialization.v2'
     OR generation.creator_worker_contract_version <>
       'recommendation-pool-worker.v2'
     OR pin.qualification_contract_version <>
       'recommendation-pool-admission.v2'
   );

CREATE OR REPLACE FUNCTION backlink_recommendation_generation_admitted_count(
  p_organization_id text,
  p_workspace_id text,
  p_website_project_id text,
  p_generation_contract_id text
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT count(*)::integer
    FROM backlink_recommendation_generation_candidates AS candidate
   WHERE candidate.organization_id::text = p_organization_id
     AND candidate.workspace_id::text = p_workspace_id
     AND candidate.website_project_id::text = p_website_project_id
     AND candidate.generation_contract_id::text = p_generation_contract_id
     AND candidate.admission_state = 'ADMITTED';
$function$;

REVOKE ALL
  ON backlink_recommendation_generation_candidates,
     backlink_recommendation_generation_candidate_sources,
     backlink_recommendation_candidate_metric_snapshots,
     backlink_recommendation_generation_candidate_links
  FROM PUBLIC;

GRANT SELECT, INSERT
  ON backlink_recommendation_generation_candidates,
     backlink_recommendation_generation_candidate_sources,
     backlink_recommendation_candidate_metric_snapshots,
     backlink_recommendation_generation_candidate_links
  TO growthos_backlinks_writer;

GRANT SELECT
  ON backlink_recommendation_generation_candidates,
     backlink_recommendation_generation_candidate_sources,
     backlink_recommendation_candidate_metric_snapshots,
     backlink_recommendation_generation_candidate_links
  TO growthos_reporting_reader;

REVOKE ALL
  ON FUNCTION backlink_recommendation_generation_admitted_count(
    text, text, text, text
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION backlink_recommendation_generation_admitted_count(
    text, text, text, text
  )
  TO growthos_backlinks_writer, growthos_reporting_reader;

COMMENT ON TABLE backlink_recommendation_generation_candidates IS
  'Immutable V2 candidate admission authority; V1 score and state are not inputs.';
COMMENT ON TABLE backlink_recommendation_generation_candidate_sources IS
  'Append-only repeated discovery evidence for one immutable V2 candidate.';
COMMENT ON TABLE backlink_recommendation_candidate_metric_snapshots IS
  'Append-only metrics independent from V2 admission.';
COMMENT ON TABLE backlink_recommendation_generation_candidate_links IS
  'Idempotent bridge from native V2 candidate identity to canonical records.';

COMMIT;
