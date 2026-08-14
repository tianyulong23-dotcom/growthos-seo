BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_commercial_discovery_blueprints (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  project_context_version_id uuid NOT NULL,
  blueprint_version integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  generator text NOT NULL,
  schema_version text NOT NULL,
  prompt_version text NOT NULL,
  model_version text,
  rule_version text NOT NULL,
  blueprint jsonb NOT NULL,
  evidence_refs jsonb NOT NULL,
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_commercial_blueprint_version_check CHECK (
    blueprint_version > 0
    AND length(btrim(schema_version)) > 0
    AND length(btrim(prompt_version)) > 0
    AND length(btrim(rule_version)) > 0
  ),
  CONSTRAINT backlink_commercial_blueprint_status_check CHECK (
    status IN ('active', 'stale_context')
  ),
  CONSTRAINT backlink_commercial_blueprint_generator_check CHECK (
    generator IN ('AI', 'DETERMINISTIC_FALLBACK')
  ),
  CONSTRAINT backlink_commercial_blueprint_json_check CHECK (
    jsonb_typeof(blueprint) = 'object'
    AND jsonb_typeof(evidence_refs) = 'array'
  ),
  CONSTRAINT backlink_commercial_blueprint_context_version_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    project_context_version_id, blueprint_version
  ),
  CONSTRAINT backlink_commercial_blueprint_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_commercial_discovery_batches (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  blueprint_id uuid NOT NULL,
  project_context_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'running',
  idempotency_key text NOT NULL,
  request_intent text NOT NULL,
  source_types jsonb NOT NULL,
  provider_request_fingerprints jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_collected_at timestamptz,
  paid_cost_micros bigint NOT NULL DEFAULT 0,
  pause_reason text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_commercial_batch_status_check CHECK (
    status IN (
      'running', 'completed', 'paused', 'unavailable', 'failed',
      'stale_context'
    )
  ),
  CONSTRAINT backlink_commercial_batch_intent_check CHECK (
    request_intent IN (
      'DISCOVERY', 'CARD_ENRICHMENT', 'DEEP_ASSESSMENT', 'MONITORING'
    )
  ),
  CONSTRAINT backlink_commercial_batch_idempotency_check CHECK (
    length(btrim(idempotency_key)) > 0
  ),
  CONSTRAINT backlink_commercial_batch_json_check CHECK (
    jsonb_typeof(source_types) = 'array'
    AND jsonb_array_length(source_types) >= 1
    AND jsonb_typeof(provider_request_fingerprints) = 'array'
  ),
  CONSTRAINT backlink_commercial_batch_cost_check CHECK (
    paid_cost_micros >= 0
  ),
  CONSTRAINT backlink_commercial_batch_finish_check CHECK (
    (status = 'running' AND finished_at IS NULL)
    OR (status <> 'running' AND finished_at IS NOT NULL)
  ),
  CONSTRAINT backlink_commercial_batch_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_commercial_batch_idempotency_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    project_context_version_id, idempotency_key
  ),
  CONSTRAINT backlink_commercial_batch_blueprint_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, blueprint_id
  ) REFERENCES backlink_commercial_discovery_blueprints (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_commercial_candidates (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  blueprint_id uuid NOT NULL,
  discovery_batch_id uuid NOT NULL,
  recommendation_id uuid,
  prospect_id uuid,
  project_context_version_id uuid NOT NULL,
  canonical_domain text NOT NULL,
  source_types jsonb NOT NULL,
  static_assessment jsonb NOT NULL,
  gate_decision jsonb NOT NULL,
  commercial_score jsonb NOT NULL,
  score_model_version text NOT NULL,
  state text NOT NULL DEFAULT 'candidate_ready',
  provider_collected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_commercial_candidate_domain_check CHECK (
    canonical_domain = lower(canonical_domain)
    AND length(btrim(canonical_domain)) > 0
  ),
  CONSTRAINT backlink_commercial_candidate_json_check CHECK (
    jsonb_typeof(source_types) = 'array'
    AND jsonb_array_length(source_types) >= 1
    AND jsonb_typeof(static_assessment) = 'object'
    AND jsonb_typeof(gate_decision) = 'object'
    AND jsonb_typeof(commercial_score) = 'object'
  ),
  CONSTRAINT backlink_commercial_candidate_score_version_check CHECK (
    score_model_version = 'recommendation-commercial-fit.v2'
  ),
  CONSTRAINT backlink_commercial_candidate_state_check CHECK (
    state IN (
      'candidate_ready', 'contact_enrichment', 'published',
      'excluded', 'insufficient_data', 'manual_review', 'stale_context'
    )
  ),
  CONSTRAINT backlink_commercial_candidate_promotion_check CHECK (
    (recommendation_id IS NULL AND prospect_id IS NULL)
    OR (recommendation_id IS NOT NULL AND prospect_id IS NOT NULL)
  ),
  CONSTRAINT backlink_commercial_candidate_version_check CHECK (version > 0),
  CONSTRAINT backlink_commercial_candidate_context_domain_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    project_context_version_id, canonical_domain
  ),
  CONSTRAINT backlink_commercial_candidate_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_commercial_candidate_blueprint_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, blueprint_id
  ) REFERENCES backlink_commercial_discovery_blueprints (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_commercial_candidate_batch_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, discovery_batch_id
  ) REFERENCES backlink_commercial_discovery_batches (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_commercial_candidate_recommendation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, recommendation_id,
    prospect_id, project_context_version_id
  ) REFERENCES backlink_recommendations (
    organization_id, workspace_id, website_project_id, id,
    prospect_id, recommendation_context_version_id
  )
);

CREATE TABLE backlink_commercial_discovery_artifacts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  project_context_version_id uuid NOT NULL,
  provider text NOT NULL,
  endpoint text NOT NULL,
  request_intent text NOT NULL,
  request_fingerprint text NOT NULL,
  source_type text NOT NULL,
  response_schema_version text NOT NULL,
  normalized_payload jsonb NOT NULL,
  provider_task_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  collected_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  stale_until timestamptz NOT NULL,
  cost_micros bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_commercial_artifact_provider_check CHECK (
    provider = 'dataforseo'
  ),
  CONSTRAINT backlink_commercial_artifact_intent_check CHECK (
    request_intent IN (
      'DISCOVERY', 'CARD_ENRICHMENT', 'DEEP_ASSESSMENT', 'MONITORING'
    )
  ),
  CONSTRAINT backlink_commercial_artifact_source_check CHECK (
    source_type IN (
      'EXISTING_HISTORY',
      'BLUEPRINT_SERP_STANDARD_QUEUE',
      'VERIFIED_COMPETITOR_REFERRING_DOMAINS',
      'VERIFIED_COMPETITOR_BACKLINK_GAP',
      'USER_REFERRING_DOMAINS'
    )
  ),
  CONSTRAINT backlink_commercial_artifact_payload_check CHECK (
    jsonb_typeof(normalized_payload) = 'object'
    AND jsonb_typeof(provider_task_ids) = 'array'
  ),
  CONSTRAINT backlink_commercial_artifact_freshness_check CHECK (
    fresh_until >= collected_at
    AND stale_until >= fresh_until
    AND cost_micros >= 0
  ),
  CONSTRAINT backlink_commercial_artifact_request_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    request_fingerprint, response_schema_version
  )
);

CREATE TABLE backlink_commercial_inventory_policies (
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  project_context_version_id uuid NOT NULL,
  candidate_low_watermark integer NOT NULL DEFAULT 20,
  candidate_high_watermark integer NOT NULL DEFAULT 40,
  published_low_watermark integer NOT NULL DEFAULT 5,
  published_high_watermark integer NOT NULL DEFAULT 10,
  minimum_email_hit_rate numeric(5,4) NOT NULL DEFAULT 0.1000,
  maximum_email_hit_rate numeric(5,4) NOT NULL DEFAULT 0.8000,
  latest_refill_at timestamptz,
  next_refill_at timestamptz,
  latest_provider_collected_at timestamptz,
  pause_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (
    organization_id, workspace_id, website_project_id,
    project_context_version_id
  ),
  CONSTRAINT backlink_commercial_inventory_watermark_check CHECK (
    candidate_low_watermark >= 0
    AND candidate_high_watermark > candidate_low_watermark
    AND published_low_watermark >= 0
    AND published_high_watermark > published_low_watermark
  ),
  CONSTRAINT backlink_commercial_inventory_hit_rate_check CHECK (
    minimum_email_hit_rate > 0
    AND maximum_email_hit_rate <= 1
    AND maximum_email_hit_rate >= minimum_email_hit_rate
  ),
  CONSTRAINT backlink_commercial_inventory_version_check CHECK (version > 0)
);

CREATE TABLE backlink_commercial_gold_sets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  name text NOT NULL,
  dataset_version text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_commercial_gold_set_status_check CHECK (
    status IN ('draft', 'labeled', 'locked')
  ),
  CONSTRAINT backlink_commercial_gold_set_name_check CHECK (
    length(btrim(name)) > 0 AND length(btrim(dataset_version)) > 0
  ),
  CONSTRAINT backlink_commercial_gold_set_version_uq UNIQUE (
    organization_id, workspace_id, website_project_id, dataset_version
  ),
  CONSTRAINT backlink_commercial_gold_set_tenant_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  )
);

CREATE TABLE backlink_commercial_gold_labels (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  gold_set_id uuid NOT NULL,
  canonical_domain text NOT NULL,
  market_code text NOT NULL,
  label text NOT NULL,
  notes text,
  labeled_at timestamptz NOT NULL,
  labeled_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backlink_commercial_gold_label_check CHECK (
    label IN ('suitable', 'unsuitable', 'uncertain')
    AND canonical_domain = lower(canonical_domain)
    AND length(btrim(canonical_domain)) > 0
    AND market_code = upper(market_code)
    AND length(btrim(market_code)) BETWEEN 2 AND 12
  ),
  CONSTRAINT backlink_commercial_gold_label_domain_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    gold_set_id, canonical_domain
  ),
  CONSTRAINT backlink_commercial_gold_label_set_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, gold_set_id
  ) REFERENCES backlink_commercial_gold_sets (
    organization_id, workspace_id, website_project_id, id
  )
);

ALTER TABLE backlink_recommendation_inventory
  ADD COLUMN publication_status text NOT NULL
    DEFAULT 'WITHHELD_CONTACT_REQUIRED',
  ADD COLUMN verified_public_email_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT backlink_rec_inventory_publication_status_check CHECK (
    publication_status IN (
      'WITHHELD_CONTACT_REQUIRED', 'PUBLISHED', 'UNPUBLISHED'
    )
  ),
  ADD CONSTRAINT backlink_rec_inventory_verified_email_check CHECK (
    verified_public_email_count >= 0
    AND (
      publication_status <> 'PUBLISHED'
      OR verified_public_email_count >= 1
    )
  );

WITH eligible AS (
  SELECT inventory.id,
         count(DISTINCT candidate.id)::integer AS email_count
    FROM backlink_recommendation_inventory AS inventory
    JOIN backlink_contact_candidates AS candidate
      ON (
        candidate.organization_id,
        candidate.workspace_id,
        candidate.website_project_id,
        candidate.prospect_id,
        candidate.recommendation_context_version_id
      ) = (
        inventory.organization_id,
        inventory.workspace_id,
        inventory.website_project_id,
        inventory.prospect_id,
        inventory.recommendation_context_version_id
      )
   WHERE candidate.status IN ('candidate', 'promoted')
     AND candidate.invalidated_at IS NULL
     AND lower(candidate.normalized_email) ~
       '^[^[:space:]@]+@[a-z0-9.-]+[.][a-z]{2,}$'
     AND split_part(lower(candidate.normalized_email), '@', 1)
       !~ '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
     AND candidate.email_domain_ascii NOT IN (
       'example.com', 'example.org', 'example.net'
     )
     AND candidate.email_domain_ascii NOT LIKE '%.invalid'
     AND EXISTS (
       SELECT 1
         FROM backlink_contact_evidence AS evidence
        WHERE (
          evidence.organization_id,
          evidence.workspace_id,
          evidence.website_project_id,
          evidence.candidate_id
        ) = (
          candidate.organization_id,
          candidate.workspace_id,
          candidate.website_project_id,
          candidate.id
        )
          AND evidence.invalidated_at IS NULL
          AND evidence.expires_at > now()
          AND evidence.extraction_method IN (
            'mailto', 'visible_text', 'obfuscated_text', 'json_ld', 'manual'
          )
     )
   GROUP BY inventory.id
)
UPDATE backlink_recommendation_inventory AS inventory
   SET publication_status = 'PUBLISHED',
       verified_public_email_count = eligible.email_count,
       updated_at = now()
  FROM eligible
 WHERE inventory.id = eligible.id
   AND eligible.email_count >= 1;

CREATE FUNCTION backlink_reject_commercial_blueprint_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
     AND OLD.generated_at = NEW.generated_at
     AND OLD.created_at = NEW.created_at
     AND OLD.created_by = NEW.created_by THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'commercial discovery blueprints are immutable';
END;
$$;

CREATE TRIGGER backlink_commercial_blueprint_immutable
BEFORE UPDATE OR DELETE ON backlink_commercial_discovery_blueprints
FOR EACH ROW EXECUTE FUNCTION backlink_reject_commercial_blueprint_mutation();

CREATE INDEX backlink_commercial_candidate_inventory_idx
  ON backlink_commercial_candidates (
    organization_id, workspace_id, website_project_id,
    project_context_version_id, state, created_at
  );

CREATE INDEX backlink_commercial_batch_status_idx
  ON backlink_commercial_discovery_batches (
    organization_id, workspace_id, website_project_id,
    project_context_version_id, status, started_at
  );

CREATE INDEX backlink_commercial_artifact_freshness_idx
  ON backlink_commercial_discovery_artifacts (
    organization_id, workspace_id, website_project_id,
    project_context_version_id, source_type, fresh_until
  );

ALTER TABLE backlink_commercial_discovery_blueprints
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_discovery_blueprints
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_discovery_batches
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_discovery_batches
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_discovery_artifacts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_discovery_artifacts
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_inventory_policies
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_inventory_policies
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_gold_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_gold_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_gold_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_gold_labels FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_commercial_blueprint_tenant_policy
  ON backlink_commercial_discovery_blueprints
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

CREATE POLICY backlink_commercial_batch_tenant_policy
  ON backlink_commercial_discovery_batches
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

CREATE POLICY backlink_commercial_candidate_tenant_policy
  ON backlink_commercial_candidates
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

CREATE POLICY backlink_commercial_inventory_policy_tenant_policy
  ON backlink_commercial_inventory_policies
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

CREATE POLICY backlink_commercial_gold_set_tenant_policy
  ON backlink_commercial_gold_sets
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

CREATE POLICY backlink_commercial_gold_label_tenant_policy
  ON backlink_commercial_gold_labels
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

CREATE POLICY backlink_commercial_artifact_tenant_policy
  ON backlink_commercial_discovery_artifacts
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

GRANT SELECT, INSERT
  ON backlink_commercial_discovery_blueprints
  TO growthos_backlinks_writer;
GRANT SELECT, INSERT, UPDATE
  ON backlink_commercial_discovery_batches,
     backlink_commercial_discovery_artifacts,
     backlink_commercial_candidates,
     backlink_commercial_inventory_policies,
     backlink_commercial_gold_sets,
     backlink_commercial_gold_labels
  TO growthos_backlinks_writer;

COMMIT;
