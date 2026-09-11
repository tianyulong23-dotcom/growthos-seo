BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_generation_input_pins
  ADD CONSTRAINT backlink_input_pin_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  );

ALTER TABLE backlink_recommendation_generation_contracts
  ADD COLUMN pool_contract_version text NOT NULL
    DEFAULT 'recommendation-pool.v1',
  ADD COLUMN seed_contract_version text NOT NULL
    DEFAULT 'recommendation-seed.v1',
  ADD COLUMN release_contract_version text NOT NULL
    DEFAULT 'recommendation-release.v1',
  ADD COLUMN recommendation_marker_version text NOT NULL
    DEFAULT 'recommendation-marker.v1',
  ADD COLUMN discovery_budget_policy_version text NOT NULL
    DEFAULT 'recommendation-discovery-budget.v1',
  ADD COLUMN effective_unique_candidate_count integer,
  ADD COLUMN canonical_batch_size integer,
  ADD COLUMN canonical_batch_count integer,
  ADD COLUMN canonical_order_fingerprint text,
  ADD COLUMN discovery_terminal_reason text,
  ADD COLUMN discovery_completed_at timestamptz,
  ADD CONSTRAINT backlink_rec_generation_pool_versions_ck CHECK (
    pool_contract_version IN (
      'recommendation-pool.v1',
      'recommendation-pool.v2'
    )
    AND length(btrim(seed_contract_version)) > 0
    AND length(btrim(release_contract_version)) > 0
    AND length(btrim(recommendation_marker_version)) > 0
    AND length(btrim(discovery_budget_policy_version)) > 0
  ),
  ADD CONSTRAINT backlink_rec_generation_completion_ck CHECK (
    pool_contract_version <> 'recommendation-pool.v2'
    OR (
      (
        effective_unique_candidate_count IS NULL
        AND canonical_batch_size IS NULL
        AND canonical_batch_count IS NULL
        AND canonical_order_fingerprint IS NULL
        AND discovery_terminal_reason IS NULL
        AND discovery_completed_at IS NULL
      )
      OR (
        effective_unique_candidate_count >= 0
        AND (
          (
            effective_unique_candidate_count = 0
            AND canonical_batch_size = 0
            AND canonical_batch_count = 0
          )
          OR (
            effective_unique_candidate_count > 0
            AND canonical_batch_size > 0
            AND canonical_batch_count > 0
          )
        )
        AND canonical_batch_count >= 0
        AND length(btrim(canonical_order_fingerprint)) > 0
        AND length(btrim(discovery_terminal_reason)) > 0
        AND discovery_completed_at IS NOT NULL
      )
    )
  ),
  ADD CONSTRAINT backlink_rec_generation_v2_lineage_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  );

ALTER TABLE backlink_commercial_discovery_blueprints
  ADD CONSTRAINT backlink_v2_blueprint_context_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    project_context_version_id
  );

ALTER TABLE backlink_commercial_candidates
  ADD CONSTRAINT backlink_v2_candidate_lineage_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    project_context_version_id, visible_pool_generation,
    recommendation_id, prospect_id
  );

ALTER TABLE backlink_recommendation_inventory
  ADD CONSTRAINT backlink_v2_inventory_lineage_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    recommendation_id, prospect_id, recommendation_context_version_id,
    visible_pool_generation
  );

CREATE OR REPLACE FUNCTION backlink_reject_recommendation_contract_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'backlink_recommendation_generation_contracts'
     AND TG_OP = 'UPDATE' THEN
    IF OLD.pool_contract_version = 'recommendation-pool.v2'
       AND NEW.pool_contract_version = 'recommendation-pool.v2'
       AND OLD.effective_unique_candidate_count IS NULL
       AND OLD.canonical_batch_size IS NULL
       AND OLD.canonical_batch_count IS NULL
       AND OLD.canonical_order_fingerprint IS NULL
       AND OLD.discovery_terminal_reason IS NULL
       AND OLD.discovery_completed_at IS NULL
       AND NEW.effective_unique_candidate_count IS NOT NULL
       AND NEW.canonical_batch_size IS NOT NULL
       AND NEW.canonical_batch_count IS NOT NULL
       AND NEW.canonical_order_fingerprint IS NOT NULL
       AND NEW.discovery_terminal_reason IS NOT NULL
       AND NEW.discovery_completed_at IS NOT NULL
       AND (
         to_jsonb(NEW) - ARRAY[
           'effective_unique_candidate_count',
           'canonical_batch_size',
           'canonical_batch_count',
           'canonical_order_fingerprint',
           'discovery_terminal_reason',
           'discovery_completed_at'
         ]::text[]
       ) = (
         to_jsonb(OLD) - ARRAY[
           'effective_unique_candidate_count',
           'canonical_batch_size',
           'canonical_batch_count',
           'canonical_order_fingerprint',
           'discovery_terminal_reason',
           'discovery_completed_at'
         ]::text[]
       ) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'Backlinks recommendation contract records are immutable.';
END;
$function$;

CREATE TABLE backlink_recommendation_pool_project_contracts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  pool_contract_version text NOT NULL,
  migration_state text NOT NULL,
  generation_contract_id uuid,
  recommendation_context_version_id uuid,
  visible_pool_generation integer,
  input_pin_id uuid,
  state_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_pool_project_contract_scope_uq UNIQUE (
    organization_id, workspace_id, website_project_id
  ),
  CONSTRAINT backlink_pool_project_contract_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_pool_project_contract_values_ck CHECK (
    pool_contract_version IN (
      'recommendation-pool.v1',
      'recommendation-pool.v2'
    )
    AND migration_state IN (
      'V1_ACTIVE',
      'V2_READY',
      'V2_ACTIVE',
      'MIGRATION_BLOCKED',
      'V2_MAINTENANCE_READ_ONLY'
    )
    AND jsonb_typeof(state_reason_codes) = 'array'
    AND version > 0
    AND (
      (
        migration_state = 'V1_ACTIVE'
        AND pool_contract_version = 'recommendation-pool.v1'
        AND generation_contract_id IS NULL
        AND recommendation_context_version_id IS NULL
        AND visible_pool_generation IS NULL
        AND input_pin_id IS NULL
        AND activated_at IS NULL
      )
      OR (
        migration_state IN ('V2_READY', 'MIGRATION_BLOCKED')
        AND (
          (
            generation_contract_id IS NULL
            AND recommendation_context_version_id IS NULL
            AND visible_pool_generation IS NULL
            AND input_pin_id IS NULL
          )
          OR (
            pool_contract_version = 'recommendation-pool.v2'
            AND generation_contract_id IS NOT NULL
            AND recommendation_context_version_id IS NOT NULL
            AND visible_pool_generation > 0
            AND input_pin_id IS NOT NULL
          )
        )
        AND activated_at IS NULL
      )
      OR (
        migration_state IN ('V2_ACTIVE', 'V2_MAINTENANCE_READ_ONLY')
        AND pool_contract_version = 'recommendation-pool.v2'
        AND generation_contract_id IS NOT NULL
        AND recommendation_context_version_id IS NOT NULL
        AND visible_pool_generation > 0
        AND input_pin_id IS NOT NULL
        AND activated_at IS NOT NULL
      )
    )
  ),
  CONSTRAINT backlink_pool_project_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_commercial_discovery_seeds (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  input_pin_id uuid NOT NULL,
  pool_contract_version text NOT NULL DEFAULT 'recommendation-pool.v2',
  seed_kind text NOT NULL,
  raw_value text NOT NULL,
  normalized_value text NOT NULL,
  source text NOT NULL,
  validation_status text NOT NULL,
  validation_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence_band text NOT NULL,
  seed_fingerprint text NOT NULL,
  supersedes_seed_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_commercial_seed_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id
  ),
  CONSTRAINT backlink_commercial_seed_generation_value_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, seed_kind, normalized_value
  ),
  CONSTRAINT backlink_commercial_seed_fingerprint_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, seed_fingerprint
  ),
  CONSTRAINT backlink_commercial_seed_lineage_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, seed_fingerprint
  ),
  CONSTRAINT backlink_commercial_seed_values_ck CHECK (
    pool_contract_version = 'recommendation-pool.v2'
    AND visible_pool_generation > 0
    AND seed_kind IN ('KEYWORD', 'CATEGORY', 'SEO_COMPETITOR')
    AND source IN (
      'USER_INPUT',
      'USER_TRIGGERED_GENERATION',
      'SYSTEM_FALLBACK',
      'SYSTEM_SUPPLEMENT'
    )
    AND validation_status IN (
      'PENDING',
      'VERIFIED',
      'RETAINED_LOW_CONFIDENCE',
      'REJECTED'
    )
    AND confidence_band IN ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN')
    AND length(btrim(raw_value)) > 0
    AND length(btrim(normalized_value)) > 0
    AND normalized_value = lower(normalized_value)
    AND length(btrim(seed_fingerprint)) > 0
    AND jsonb_typeof(validation_reason_codes) = 'array'
    AND jsonb_typeof(evidence_refs) = 'array'
    AND supersedes_seed_id IS DISTINCT FROM id
  ),
  CONSTRAINT backlink_commercial_seed_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_commercial_seed_input_pin_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, input_pin_id
  ) REFERENCES backlink_generation_input_pins (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_commercial_seed_supersedes_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    supersedes_seed_id, generation_contract_id
  ) REFERENCES backlink_commercial_discovery_seeds (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_commercial_discovery_seed_provenance_assertions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  seed_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  seed_fingerprint text NOT NULL,
  asserted_raw_value text NOT NULL,
  asserted_source text NOT NULL,
  asserted_validation_status text NOT NULL,
  asserted_validation_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  asserted_evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  asserted_confidence_band text NOT NULL,
  assertion_fingerprint text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_commercial_seed_provenance_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_commercial_seed_provenance_assertion_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, assertion_fingerprint
  ),
  CONSTRAINT backlink_commercial_seed_provenance_values_ck CHECK (
    visible_pool_generation > 0
    AND length(btrim(seed_fingerprint)) > 0
    AND length(btrim(asserted_raw_value)) > 0
    AND asserted_source IN (
      'USER_INPUT',
      'USER_TRIGGERED_GENERATION',
      'SYSTEM_FALLBACK',
      'SYSTEM_SUPPLEMENT'
    )
    AND asserted_validation_status IN (
      'PENDING',
      'VERIFIED',
      'RETAINED_LOW_CONFIDENCE',
      'REJECTED'
    )
    AND asserted_confidence_band IN ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN')
    AND jsonb_typeof(asserted_validation_reason_codes) = 'array'
    AND jsonb_typeof(asserted_evidence_refs) = 'array'
    AND length(btrim(assertion_fingerprint)) > 0
    AND length(btrim(request_id)) > 0
  ),
  CONSTRAINT backlink_commercial_seed_provenance_seed_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, seed_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, seed_fingerprint
  ) REFERENCES backlink_commercial_discovery_seeds (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, seed_fingerprint
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_commercial_blueprint_seeds (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  blueprint_id uuid NOT NULL,
  seed_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  seed_ordinal integer NOT NULL,
  seed_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_blueprint_seed_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_blueprint_seed_assignment_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    blueprint_id, seed_id
  ),
  CONSTRAINT backlink_blueprint_seed_ordinal_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    blueprint_id, seed_ordinal
  ),
  CONSTRAINT backlink_blueprint_seed_values_ck CHECK (
    visible_pool_generation > 0
    AND seed_ordinal > 0
    AND length(btrim(seed_fingerprint)) > 0
  ),
  CONSTRAINT backlink_blueprint_seed_blueprint_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, blueprint_id,
    recommendation_context_version_id
  ) REFERENCES backlink_commercial_discovery_blueprints (
    organization_id, workspace_id, website_project_id, id,
    project_context_version_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_blueprint_seed_seed_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    seed_id, generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, seed_fingerprint
  ) REFERENCES backlink_commercial_discovery_seeds (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, seed_fingerprint
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_release_batches (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  input_pin_id uuid NOT NULL,
  pool_contract_version text NOT NULL DEFAULT 'recommendation-pool.v2',
  batch_ordinal integer NOT NULL,
  state text NOT NULL DEFAULT 'PREPARING',
  original_batch_size integer NOT NULL,
  selection_policy_version text NOT NULL,
  order_fingerprint text NOT NULL,
  contact_terminal_count integer NOT NULL DEFAULT 0,
  contact_total_count integer NOT NULL,
  preparation_started_at timestamptz NOT NULL,
  available_at timestamptz,
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_release_batch_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation
  ),
  CONSTRAINT backlink_release_batch_ordinal_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    recommendation_context_version_id, visible_pool_generation,
    batch_ordinal
  ),
  CONSTRAINT backlink_release_batch_order_fingerprint_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, order_fingerprint
  ),
  CONSTRAINT backlink_release_batch_values_ck CHECK (
    pool_contract_version = 'recommendation-pool.v2'
    AND visible_pool_generation > 0
    AND batch_ordinal > 0
    AND original_batch_size > 0
    AND contact_total_count = original_batch_size
    AND contact_terminal_count BETWEEN 0 AND contact_total_count
    AND length(btrim(selection_policy_version)) > 0
    AND length(btrim(order_fingerprint)) > 0
    AND deadline_at > preparation_started_at
    AND version > 0
    AND state IN ('PREPARING', 'AVAILABLE', 'RETIRED', 'SUPERSEDED')
    AND (
      (state = 'PREPARING' AND available_at IS NULL)
      OR (
        state = 'AVAILABLE'
        AND available_at IS NOT NULL
        AND contact_terminal_count = contact_total_count
      )
      OR state IN ('RETIRED', 'SUPERSEDED')
    )
  ),
  CONSTRAINT backlink_release_batch_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_release_batch_input_pin_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, input_pin_id
  ) REFERENCES backlink_generation_input_pins (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_release_batch_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  candidate_id uuid,
  recommendation_id uuid,
  prospect_id uuid,
  inventory_id uuid,
  generation_contract_id uuid,
  input_pin_id uuid,
  pool_contract_version text NOT NULL DEFAULT 'recommendation-pool.v2',
  canonical_domain text NOT NULL,
  position integer NOT NULL,
  recommended boolean NOT NULL,
  recommendation_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommendation_marker_version text NOT NULL,
  traffic_snapshot_ref text,
  rank_snapshot_ref text,
  spam_snapshot_ref text,
  traffic_snapshot jsonb NOT NULL,
  rank_snapshot jsonb NOT NULL,
  spam_snapshot jsonb NOT NULL,
  traffic_organic_etv numeric,
  authority_rank numeric,
  spam_score numeric,
  primary_category text,
  category_snapshot jsonb,
  contact_terminal_reason_at_release text,
  contact_email_at_release text,
  contact_page_url_at_release text,
  contact_completed_at_release timestamptz,
  legacy_imported boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_release_item_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_release_item_position_uq UNIQUE (
    batch_id, position
  ),
  CONSTRAINT backlink_release_item_batch_domain_uq UNIQUE (
    batch_id, canonical_domain
  ),
  CONSTRAINT backlink_release_item_project_domain_uq UNIQUE (
    organization_id, workspace_id, website_project_id, canonical_domain
  ),
  CONSTRAINT backlink_release_item_values_ck CHECK (
    pool_contract_version = 'recommendation-pool.v2'
    AND visible_pool_generation > 0
    AND canonical_domain = lower(canonical_domain)
    AND length(btrim(canonical_domain)) > 0
    AND position > 0
    AND length(btrim(recommendation_marker_version)) > 0
    AND jsonb_typeof(recommendation_reason_codes) = 'array'
    AND (traffic_organic_etv IS NULL OR traffic_organic_etv >= 0)
    AND (authority_rank IS NULL OR authority_rank >= 0)
    AND (spam_score IS NULL OR spam_score BETWEEN 0 AND 100)
    AND (
      jsonb_typeof(traffic_snapshot) = 'object'
      AND traffic_snapshot ? 'value'
      AND traffic_snapshot ?& ARRAY[
        'provider','endpoint','market','location','language','observedAt'
      ]
      AND (
        traffic_snapshot->'value' = 'null'::jsonb
        OR jsonb_typeof(traffic_snapshot->'value') = 'number'
      )
      AND COALESCE(length(btrim(traffic_snapshot->>'provider')) > 0, false)
      AND COALESCE(length(btrim(traffic_snapshot->>'endpoint')) > 0, false)
      AND COALESCE(length(btrim(traffic_snapshot->>'market')) > 0, false)
      AND COALESCE(length(btrim(traffic_snapshot->>'location')) > 0, false)
      AND COALESCE(length(btrim(traffic_snapshot->>'language')) > 0, false)
      AND COALESCE(length(btrim(traffic_snapshot->>'observedAt')) > 0, false)
      AND (traffic_snapshot->>'observedAt')::timestamptz IS NOT NULL
      AND (
        COALESCE(length(btrim(traffic_snapshot->>'requestRef')) > 0, false)
        OR COALESCE(
          length(btrim(traffic_snapshot->>'artifactRef')) > 0,
          false
        )
      )
      AND CASE
        WHEN traffic_snapshot->'value' = 'null'::jsonb THEN
          traffic_snapshot->'value' = 'null'::jsonb
          AND traffic_organic_etv IS NULL
        ELSE traffic_organic_etv =
          (traffic_snapshot->>'value')::numeric
      END
    )
    AND (
      jsonb_typeof(rank_snapshot) = 'object'
      AND rank_snapshot ? 'value'
      AND rank_snapshot ?& ARRAY[
        'provider','endpoint','market','location','language','observedAt'
      ]
      AND (
        rank_snapshot->'value' = 'null'::jsonb
        OR jsonb_typeof(rank_snapshot->'value') = 'number'
      )
      AND COALESCE(length(btrim(rank_snapshot->>'provider')) > 0, false)
      AND COALESCE(length(btrim(rank_snapshot->>'endpoint')) > 0, false)
      AND COALESCE(length(btrim(rank_snapshot->>'market')) > 0, false)
      AND COALESCE(length(btrim(rank_snapshot->>'location')) > 0, false)
      AND COALESCE(length(btrim(rank_snapshot->>'language')) > 0, false)
      AND COALESCE(length(btrim(rank_snapshot->>'observedAt')) > 0, false)
      AND (rank_snapshot->>'observedAt')::timestamptz IS NOT NULL
      AND (
        COALESCE(length(btrim(rank_snapshot->>'requestRef')) > 0, false)
        OR COALESCE(
          length(btrim(rank_snapshot->>'artifactRef')) > 0,
          false
        )
      )
      AND CASE
        WHEN rank_snapshot->'value' = 'null'::jsonb THEN
          authority_rank IS NULL
        ELSE authority_rank = (rank_snapshot->>'value')::numeric
      END
    )
    AND (
      jsonb_typeof(spam_snapshot) = 'object'
      AND spam_snapshot ? 'value'
      AND spam_snapshot ?& ARRAY[
        'provider','endpoint','market','location','language','observedAt'
      ]
      AND (
        spam_snapshot->'value' = 'null'::jsonb
        OR jsonb_typeof(spam_snapshot->'value') = 'number'
      )
      AND COALESCE(length(btrim(spam_snapshot->>'provider')) > 0, false)
      AND COALESCE(length(btrim(spam_snapshot->>'endpoint')) > 0, false)
      AND COALESCE(length(btrim(spam_snapshot->>'market')) > 0, false)
      AND COALESCE(length(btrim(spam_snapshot->>'location')) > 0, false)
      AND COALESCE(length(btrim(spam_snapshot->>'language')) > 0, false)
      AND COALESCE(length(btrim(spam_snapshot->>'observedAt')) > 0, false)
      AND (spam_snapshot->>'observedAt')::timestamptz IS NOT NULL
      AND (
        COALESCE(length(btrim(spam_snapshot->>'requestRef')) > 0, false)
        OR COALESCE(
          length(btrim(spam_snapshot->>'artifactRef')) > 0,
          false
        )
      )
      AND CASE
        WHEN spam_snapshot->'value' = 'null'::jsonb THEN
          spam_score IS NULL
        ELSE spam_score = (spam_snapshot->>'value')::numeric
      END
    )
    AND (category_snapshot IS NULL OR jsonb_typeof(category_snapshot) = 'object')
    AND (
      (
        contact_terminal_reason_at_release IS NULL
        AND contact_email_at_release IS NULL
        AND contact_page_url_at_release IS NULL
        AND contact_completed_at_release IS NULL
      )
      OR (
        length(btrim(contact_terminal_reason_at_release)) > 0
        AND contact_completed_at_release IS NOT NULL
        AND (
          contact_email_at_release IS NULL
          OR (
            contact_email_at_release = lower(contact_email_at_release)
            AND contact_email_at_release ~
              '^[^[:space:]@]+@[a-z0-9.-]+[.][a-z]{2,}$'
          )
        )
      )
    )
    AND (
      (
        legacy_imported = false
        AND candidate_id IS NOT NULL
        AND recommendation_id IS NOT NULL
        AND prospect_id IS NOT NULL
        AND inventory_id IS NOT NULL
        AND generation_contract_id IS NOT NULL
        AND input_pin_id IS NOT NULL
      )
      OR (
        legacy_imported = true
        AND generation_contract_id IS NOT NULL
        AND input_pin_id IS NOT NULL
        AND (
          (
            candidate_id IS NULL
            AND recommendation_id IS NULL
            AND prospect_id IS NULL
            AND inventory_id IS NULL
          )
          OR (
            candidate_id IS NOT NULL
            AND recommendation_id IS NOT NULL
            AND prospect_id IS NOT NULL
            AND inventory_id IS NOT NULL
          )
        )
      )
    )
  ),
  CONSTRAINT backlink_release_item_batch_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, batch_id,
    recommendation_context_version_id, visible_pool_generation
  ) REFERENCES backlink_recommendation_release_batches (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_release_item_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_release_item_input_pin_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, input_pin_id
  ) REFERENCES backlink_generation_input_pins (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_release_item_candidate_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, candidate_id,
    recommendation_context_version_id, visible_pool_generation,
    recommendation_id, prospect_id
  ) REFERENCES backlink_commercial_candidates (
    organization_id, workspace_id, website_project_id, id,
    project_context_version_id, visible_pool_generation,
    recommendation_id, prospect_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_release_item_recommendation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    recommendation_id, prospect_id, recommendation_context_version_id
  ) REFERENCES backlink_recommendations (
    organization_id, workspace_id, website_project_id, id,
    prospect_id, recommendation_context_version_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_release_item_prospect_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    prospect_id, recommendation_context_version_id
  ) REFERENCES backlink_prospects (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_release_item_inventory_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, inventory_id,
    recommendation_id, prospect_id, recommendation_context_version_id,
    visible_pool_generation
  ) REFERENCES backlink_recommendation_inventory (
    organization_id, workspace_id, website_project_id, id,
    recommendation_id, prospect_id, recommendation_context_version_id,
    visible_pool_generation
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_user_publications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  user_id text NOT NULL,
  batch_id uuid NOT NULL,
  first_visible_at timestamptz NOT NULL DEFAULT now(),
  publication_state text NOT NULL DEFAULT 'ACTIVE',
  published_by_command_id text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_user_publication_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_user_publication_batch_uq UNIQUE (
    organization_id, workspace_id, website_project_id, user_id, batch_id
  ),
  CONSTRAINT backlink_user_publication_command_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    user_id, published_by_command_id
  ),
  CONSTRAINT backlink_user_publication_values_ck CHECK (
    visible_pool_generation > 0
    AND length(btrim(user_id)) > 0
    AND length(btrim(published_by_command_id)) > 0
    AND publication_state IN ('ACTIVE', 'ARCHIVED')
    AND version > 0
    AND (
      (publication_state = 'ACTIVE' AND archived_at IS NULL)
      OR (publication_state = 'ARCHIVED' AND archived_at IS NOT NULL)
    )
  ),
  CONSTRAINT backlink_user_publication_batch_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, batch_id,
    recommendation_context_version_id, visible_pool_generation
  ) REFERENCES backlink_recommendation_release_batches (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_user_cursors (
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  user_id text NOT NULL,
  highest_published_batch_ordinal integer NOT NULL DEFAULT 0,
  current_batch_id uuid,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY (
    organization_id, workspace_id, website_project_id,
    recommendation_context_version_id, visible_pool_generation, user_id
  ),
  CONSTRAINT backlink_user_cursor_values_ck CHECK (
    visible_pool_generation > 0
    AND length(btrim(user_id)) > 0
    AND highest_published_batch_ordinal >= 0
    AND version > 0
    AND (
      current_batch_id IS NOT NULL
      OR highest_published_batch_ordinal = 0
    )
  ),
  CONSTRAINT backlink_user_cursor_batch_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, current_batch_id,
    recommendation_context_version_id, visible_pool_generation
  ) REFERENCES backlink_recommendation_release_batches (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_user_unlocks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  user_id text NOT NULL,
  batch_id uuid NOT NULL,
  original_batch_size integer NOT NULL,
  required_opportunity_count integer NOT NULL,
  successful_opportunity_count integer NOT NULL,
  unlocked_at timestamptz NOT NULL,
  reason text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  created_by text NOT NULL,
  CONSTRAINT backlink_user_unlock_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_user_unlock_batch_uq UNIQUE (
    organization_id, workspace_id, website_project_id, user_id, batch_id
  ),
  CONSTRAINT backlink_user_unlock_values_ck CHECK (
    visible_pool_generation > 0
    AND length(btrim(user_id)) > 0
    AND original_batch_size > 0
    AND required_opportunity_count = (original_batch_size + 3) / 4
    AND successful_opportunity_count BETWEEN 0 AND original_batch_size
    AND reason IN ('OPPORTUNITY_RATIO', 'ELAPSED_18H')
    AND evaluated_at = unlocked_at
  ),
  CONSTRAINT backlink_user_unlock_publication_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, user_id, batch_id
  ) REFERENCES backlink_recommendation_user_publications (
    organization_id, workspace_id, website_project_id, user_id, batch_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_user_unlock_batch_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, batch_id,
    recommendation_context_version_id, visible_pool_generation
  ) REFERENCES backlink_recommendation_release_batches (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_user_item_actions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  user_id text NOT NULL,
  batch_id uuid NOT NULL,
  batch_item_id uuid,
  action_type text NOT NULL,
  opportunity_id uuid,
  target_batch_id uuid,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_user_item_action_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_user_item_action_idempotency_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    user_id, idempotency_key
  ),
  CONSTRAINT backlink_user_item_action_values_ck CHECK (
    visible_pool_generation > 0
    AND length(btrim(user_id)) > 0
    AND length(btrim(idempotency_key)) > 0
    AND length(btrim(request_hash)) > 0
    AND action_type IN (
      'OPPORTUNITY_CREATED', 'ARCHIVED', 'UNARCHIVED', 'GET_MORE'
    )
    AND (
      (
        action_type = 'OPPORTUNITY_CREATED'
        AND batch_item_id IS NOT NULL
        AND opportunity_id IS NOT NULL
        AND target_batch_id IS NULL
      )
      OR (
        action_type IN ('ARCHIVED', 'UNARCHIVED')
        AND batch_item_id IS NOT NULL
        AND opportunity_id IS NULL
        AND target_batch_id IS NULL
      )
      OR (
        action_type = 'GET_MORE'
        AND batch_item_id IS NULL
        AND opportunity_id IS NULL
        AND target_batch_id IS NOT NULL
      )
    )
  ),
  CONSTRAINT backlink_user_item_action_publication_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, user_id, batch_id
  ) REFERENCES backlink_recommendation_user_publications (
    organization_id, workspace_id, website_project_id, user_id, batch_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_user_item_action_source_batch_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, batch_id,
    recommendation_context_version_id, visible_pool_generation
  ) REFERENCES backlink_recommendation_release_batches (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_user_item_action_item_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, batch_item_id
  ) REFERENCES backlink_recommendation_release_batch_items (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_user_item_action_opportunity_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, opportunity_id
  ) REFERENCES backlink_opportunities (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_user_item_action_target_batch_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, target_batch_id,
    recommendation_context_version_id, visible_pool_generation
  ) REFERENCES backlink_recommendation_release_batches (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation
  ) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX backlink_user_item_opportunity_count_uq
  ON backlink_recommendation_user_item_actions (
    organization_id, workspace_id, website_project_id,
    user_id, batch_id, batch_item_id
  )
  WHERE action_type = 'OPPORTUNITY_CREATED';

/*
 * Phase 8/9 cutover facts and V1 write freezing are intentionally deferred.
 * Migration 0080 is Phase 1 additive schema only.
 *
CREATE TABLE backlink_recommendation_pool_v2_cutover_runs (
  id uuid PRIMARY KEY,
  command_id text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'RUNNING',
  eligible_project_count integer NOT NULL DEFAULT 0,
  v2_active_project_count integer NOT NULL DEFAULT 0,
  input_required_project_count integer NOT NULL DEFAULT 0,
  migration_blocked_project_count integer NOT NULL DEFAULT 0,
  verification jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_pool_v2_cutover_run_command_uq UNIQUE (command_id),
  CONSTRAINT backlink_pool_v2_cutover_run_values_ck CHECK (
    length(btrim(command_id)) > 0
    AND mode IN ('PLAN', 'EXECUTE')
    AND status IN (
      'RUNNING', 'PLANNED', 'INPUT_REQUIRED',
      'MIGRATION_BLOCKED', 'COMPLETED'
    )
    AND eligible_project_count >= 0
    AND v2_active_project_count >= 0
    AND input_required_project_count >= 0
    AND migration_blocked_project_count >= 0
    AND jsonb_typeof(verification) = 'object'
    AND version > 0
    AND (
      (status = 'RUNNING' AND completed_at IS NULL)
      OR (status <> 'RUNNING' AND completed_at IS NOT NULL)
    )
  )
);

CREATE TABLE backlink_recommendation_pool_v2_cutover_project_facts (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  project_context_snapshot_id uuid NOT NULL,
  project_context_snapshot_version integer NOT NULL,
  phase text NOT NULL,
  result text NOT NULL,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  generation_contract_id uuid,
  pool_contract_version text,
  recommendation_context_version_id uuid,
  visible_pool_generation integer,
  input_pin_id uuid,
  canonical_batch_count integer,
  available_batch_count integer,
  canonical_item_count integer,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_pool_v2_cutover_fact_run_scope_phase_uq UNIQUE (
    run_id, organization_id, workspace_id, website_project_id, phase
  ),
  CONSTRAINT backlink_pool_v2_cutover_fact_values_ck CHECK (
    project_context_snapshot_version > 0
    AND phase IN ('PLAN', 'APPLY')
    AND result IN (
      'READY', 'V2_ACTIVE', 'ALREADY_V2_ACTIVE',
      'INPUT_REQUIRED', 'MIGRATION_BLOCKED'
    )
    AND jsonb_typeof(reason_codes) = 'array'
    AND (
      (
        generation_contract_id IS NULL
        AND pool_contract_version IS NULL
        AND recommendation_context_version_id IS NULL
        AND visible_pool_generation IS NULL
        AND input_pin_id IS NULL
      )
      OR (
        generation_contract_id IS NOT NULL
        AND pool_contract_version = 'recommendation-pool.v2'
        AND recommendation_context_version_id IS NOT NULL
        AND visible_pool_generation > 0
        AND input_pin_id IS NOT NULL
      )
    )
    AND (canonical_batch_count IS NULL OR canonical_batch_count >= 0)
    AND (available_batch_count IS NULL OR available_batch_count >= 0)
    AND (canonical_item_count IS NULL OR canonical_item_count >= 0)
  ),
  CONSTRAINT backlink_pool_v2_cutover_fact_run_fk FOREIGN KEY (run_id)
    REFERENCES backlink_recommendation_pool_v2_cutover_runs (id)
    ON DELETE RESTRICT,
  CONSTRAINT backlink_pool_v2_cutover_fact_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_pool_v2_cutover_control (
  control_key text PRIMARY KEY,
  state text NOT NULL,
  frozen_by_run_id uuid NOT NULL,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  frozen_by text NOT NULL,
  CONSTRAINT backlink_pool_v2_cutover_control_values_ck CHECK (
    control_key = 'GLOBAL'
    AND state = 'V1_WRITES_FROZEN'
    AND length(btrim(frozen_by)) > 0
  ),
  CONSTRAINT backlink_pool_v2_cutover_control_run_fk
    FOREIGN KEY (frozen_by_run_id)
    REFERENCES backlink_recommendation_pool_v2_cutover_runs (id)
    ON DELETE RESTRICT
);
*/

CREATE OR REPLACE FUNCTION backlink_reject_pool_v2_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Backlinks recommendation pool V2 record is immutable.';
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_commercial_seed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  superseded_source text;
BEGIN
  IF NEW.supersedes_seed_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT source
    INTO superseded_source
    FROM backlink_commercial_discovery_seeds
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND generation_contract_id = NEW.generation_contract_id
     AND id = NEW.supersedes_seed_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Superseded commercial discovery seed was not found.';
  END IF;

  IF superseded_source = 'USER_INPUT'
     AND NEW.source IN ('SYSTEM_FALLBACK', 'SYSTEM_SUPPLEMENT') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'System seeds cannot supersede user input seeds.';
  END IF;

  RETURN NEW;
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
        AND NEW.migration_state = 'V2_MAINTENANCE_READ_ONLY')
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
    SELECT discovery_completed_at
      INTO generation_completed_at
      FROM backlink_recommendation_generation_contracts
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND id = NEW.generation_contract_id
       AND recommendation_context_version_id =
         NEW.recommendation_context_version_id
       AND visible_pool_generation = NEW.visible_pool_generation
       AND input_pin_id = NEW.input_pin_id
       AND pool_contract_version = 'recommendation-pool.v2';

    IF NOT FOUND OR generation_completed_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'An active V2 project requires a completed V2 generation.';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_release_batch_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Canonical recommendation release batches are retained.';
  END IF;

  IF (
    to_jsonb(NEW) - ARRAY[
      'state',
      'contact_terminal_count',
      'available_at',
      'updated_at',
      'updated_by',
      'version'
    ]::text[]
  ) <> (
    to_jsonb(OLD) - ARRAY[
      'state',
      'contact_terminal_count',
      'available_at',
      'updated_at',
      'updated_by',
      'version'
    ]::text[]
  )
     OR NEW.version <> OLD.version + 1
     OR NEW.updated_at < OLD.updated_at
     OR NOT (
       (OLD.state = 'PREPARING'
         AND NEW.state IN ('PREPARING', 'AVAILABLE', 'RETIRED', 'SUPERSEDED'))
       OR (OLD.state = 'AVAILABLE'
         AND NEW.state IN ('AVAILABLE', 'RETIRED', 'SUPERSEDED'))
       OR (OLD.state = NEW.state
         AND OLD.state IN ('RETIRED', 'SUPERSEDED'))
     ) THEN
    RAISE EXCEPTION 'Invalid canonical release batch mutation.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_release_item_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  batch_state text;
  batch_generation_contract_id uuid;
  batch_input_pin_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Canonical recommendation release items are retained.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.contact_terminal_reason_at_release IS NOT NULL
       OR OLD.contact_completed_at_release IS NOT NULL
       OR NEW.contact_terminal_reason_at_release IS NULL
       OR NEW.contact_completed_at_release IS NULL
       OR (
         to_jsonb(NEW) - ARRAY[
           'contact_terminal_reason_at_release',
           'contact_email_at_release',
           'contact_page_url_at_release',
           'contact_completed_at_release'
         ]::text[]
       ) <> (
         to_jsonb(OLD) - ARRAY[
           'contact_terminal_reason_at_release',
           'contact_email_at_release',
           'contact_page_url_at_release',
           'contact_completed_at_release'
         ]::text[]
       ) THEN
      RAISE EXCEPTION
        'Release item membership is immutable after insertion.';
    END IF;
  END IF;

  SELECT state, generation_contract_id, input_pin_id
    INTO batch_state, batch_generation_contract_id, batch_input_pin_id
    FROM backlink_recommendation_release_batches
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = NEW.batch_id
     AND recommendation_context_version_id =
       NEW.recommendation_context_version_id
     AND visible_pool_generation = NEW.visible_pool_generation;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Canonical recommendation release batch was not found.';
  END IF;

  IF batch_state <> 'PREPARING'
     OR NEW.generation_contract_id <> batch_generation_contract_id
     OR NEW.input_pin_id <> batch_input_pin_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Release items can be prepared only against matching PREPARING batches.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_release_batch_available()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  checked_batch_id uuid;
  current_state text;
  expected_size integer;
  declared_terminal_count integer;
  item_count integer;
  incomplete_native_count integer;
  incomplete_contact_count integer;
BEGIN
  checked_batch_id := CASE
    WHEN TG_TABLE_NAME = 'backlink_recommendation_release_batch_items'
      THEN (to_jsonb(NEW) ->> 'batch_id')::uuid
    ELSE (to_jsonb(NEW) ->> 'id')::uuid
  END;

  SELECT state, original_batch_size, contact_terminal_count
    INTO current_state, expected_size, declared_terminal_count
    FROM backlink_recommendation_release_batches
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = checked_batch_id;

  IF current_state <> 'AVAILABLE' THEN
    RETURN NULL;
  END IF;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE legacy_imported = false
        AND (
          candidate_id IS NULL
          OR recommendation_id IS NULL
          OR prospect_id IS NULL
          OR inventory_id IS NULL
          OR generation_contract_id IS NULL
          OR input_pin_id IS NULL
        )
    )::integer,
    count(*) FILTER (
      WHERE contact_terminal_reason_at_release IS NULL
        OR contact_completed_at_release IS NULL
    )::integer
    INTO item_count, incomplete_native_count, incomplete_contact_count
    FROM backlink_recommendation_release_batch_items
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND batch_id = checked_batch_id;

  IF item_count <> expected_size
     OR incomplete_native_count <> 0
     OR incomplete_contact_count <> 0
     OR declared_terminal_count <> item_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'AVAILABLE batch requires complete canonical items and terminal contacts.';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_user_publication_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  batch_state text;
  database_time timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Recommendation publication facts are retained.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT state
      INTO batch_state
      FROM backlink_recommendation_release_batches
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND id = NEW.batch_id
       AND recommendation_context_version_id =
         NEW.recommendation_context_version_id
       AND visible_pool_generation = NEW.visible_pool_generation;

    IF batch_state IS DISTINCT FROM 'AVAILABLE' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Only AVAILABLE canonical batches can be published.';
    END IF;

    database_time := statement_timestamp();
    NEW.first_visible_at := database_time;
    NEW.created_at := database_time;
    NEW.updated_at := database_time;
    RETURN NEW;
  END IF;

  IF OLD.publication_state <> 'ACTIVE'
     OR NEW.publication_state <> 'ARCHIVED'
     OR NEW.archived_at IS NULL
     OR NEW.version <> OLD.version + 1
     OR NEW.updated_at < OLD.updated_at
     OR (
       to_jsonb(NEW) - ARRAY[
         'publication_state',
         'archived_at',
         'updated_at',
         'updated_by',
         'version'
       ]::text[]
     ) <> (
       to_jsonb(OLD) - ARRAY[
         'publication_state',
         'archived_at',
         'updated_at',
         'updated_by',
         'version'
       ]::text[]
     ) THEN
    RAISE EXCEPTION 'Invalid recommendation publication mutation.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_user_cursor_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  published_batch_ordinal integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Recommendation user cursors cannot be deleted.';
  END IF;

  IF NEW.current_batch_id IS NOT NULL THEN
    SELECT batch.batch_ordinal
      INTO published_batch_ordinal
      FROM backlink_recommendation_release_batches AS batch
      JOIN backlink_recommendation_user_publications AS publication
        ON (
          publication.organization_id,
          publication.workspace_id,
          publication.website_project_id,
          publication.batch_id,
          publication.recommendation_context_version_id,
          publication.visible_pool_generation
        ) = (
          batch.organization_id,
          batch.workspace_id,
          batch.website_project_id,
          batch.id,
          batch.recommendation_context_version_id,
          batch.visible_pool_generation
        )
     WHERE batch.organization_id = NEW.organization_id
       AND batch.workspace_id = NEW.workspace_id
       AND batch.website_project_id = NEW.website_project_id
       AND batch.id = NEW.current_batch_id
       AND batch.recommendation_context_version_id =
         NEW.recommendation_context_version_id
       AND batch.visible_pool_generation = NEW.visible_pool_generation
       AND publication.user_id = NEW.user_id
       AND publication.publication_state = 'ACTIVE';

    IF published_batch_ordinal IS DISTINCT FROM
       NEW.highest_published_batch_ordinal THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Recommendation cursor must reference the user active publication.';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.organization_id <> NEW.organization_id
       OR OLD.workspace_id <> NEW.workspace_id
       OR OLD.website_project_id <> NEW.website_project_id
       OR OLD.recommendation_context_version_id <>
         NEW.recommendation_context_version_id
       OR OLD.visible_pool_generation <> NEW.visible_pool_generation
       OR OLD.user_id <> NEW.user_id
       OR NEW.highest_published_batch_ordinal <
         OLD.highest_published_batch_ordinal
       OR NEW.version <> OLD.version + 1
       OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'Invalid recommendation user cursor mutation.';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_recommendation_batch_unlock_status(
  p_organization_id text,
  p_workspace_id text,
  p_website_project_id text,
  p_user_id text,
  p_batch_id text
)
RETURNS TABLE (
  original_batch_size integer,
  required_opportunity_count integer,
  successful_opportunity_count integer,
  unlock_by_ratio boolean,
  unlock_by_elapsed boolean,
  eligible boolean,
  reason text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT batch.original_batch_size,
         (batch.original_batch_size + 3) / 4,
         count(DISTINCT action.batch_item_id) FILTER (
           WHERE action.action_type = 'OPPORTUNITY_CREATED'
         )::integer,
         count(DISTINCT action.batch_item_id) FILTER (
           WHERE action.action_type = 'OPPORTUNITY_CREATED'
         ) >= ((batch.original_batch_size + 3) / 4),
         statement_timestamp() >=
           publication.first_visible_at + interval '18 hours',
         (
           count(DISTINCT action.batch_item_id) FILTER (
             WHERE action.action_type = 'OPPORTUNITY_CREATED'
           ) >= ((batch.original_batch_size + 3) / 4)
           OR statement_timestamp() >=
             publication.first_visible_at + interval '18 hours'
         ),
         CASE
           WHEN count(DISTINCT action.batch_item_id) FILTER (
             WHERE action.action_type = 'OPPORTUNITY_CREATED'
           ) >= ((batch.original_batch_size + 3) / 4)
             THEN 'OPPORTUNITY_RATIO'
           WHEN statement_timestamp() >=
             publication.first_visible_at + interval '18 hours'
             THEN 'ELAPSED_18H'
           ELSE NULL
         END
    FROM backlink_recommendation_user_publications AS publication
    JOIN backlink_recommendation_release_batches AS batch
      ON (
        batch.organization_id,
        batch.workspace_id,
        batch.website_project_id,
        batch.id
      ) = (
        publication.organization_id,
        publication.workspace_id,
        publication.website_project_id,
        publication.batch_id
      )
    LEFT JOIN backlink_recommendation_user_item_actions AS action
      ON (
        action.organization_id,
        action.workspace_id,
        action.website_project_id,
        action.user_id,
        action.batch_id
      ) = (
        publication.organization_id,
        publication.workspace_id,
        publication.website_project_id,
        publication.user_id,
        publication.batch_id
      )
   WHERE publication.organization_id = p_organization_id::uuid
     AND publication.workspace_id = p_workspace_id::uuid
     AND publication.website_project_id = p_website_project_id::uuid
     AND publication.user_id = p_user_id
     AND publication.batch_id = p_batch_id::uuid
     AND publication.publication_state = 'ACTIVE'
   GROUP BY batch.original_batch_size, publication.first_visible_at;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_user_unlock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  status_row record;
  database_time timestamptz;
BEGIN
  SELECT *
    INTO status_row
    FROM backlink_recommendation_batch_unlock_status(
      NEW.organization_id::text,
      NEW.workspace_id::text,
      NEW.website_project_id::text,
      NEW.user_id,
      NEW.batch_id::text
    );

  IF NOT FOUND OR status_row.eligible IS NOT TRUE THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Recommendation batch unlock requirements are not met.';
  END IF;

  database_time := statement_timestamp();
  NEW.original_batch_size := status_row.original_batch_size;
  NEW.required_opportunity_count := status_row.required_opportunity_count;
  NEW.successful_opportunity_count :=
    status_row.successful_opportunity_count;
  NEW.reason := status_row.reason;
  NEW.unlocked_at := database_time;
  NEW.evaluated_at := database_time;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_user_item_action()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  item_recommendation_id uuid;
  item_prospect_id uuid;
  item_context_id uuid;
  opportunity_recommendation_id uuid;
  opportunity_prospect_id uuid;
  opportunity_context_id uuid;
  source_ordinal integer;
  target_ordinal integer;
  target_state text;
BEGIN
  IF NEW.action_type IN (
    'OPPORTUNITY_CREATED', 'ARCHIVED', 'UNARCHIVED'
  ) THEN
    SELECT recommendation_id, prospect_id,
           recommendation_context_version_id
      INTO item_recommendation_id, item_prospect_id, item_context_id
      FROM backlink_recommendation_release_batch_items
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND id = NEW.batch_item_id
       AND batch_id = NEW.batch_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'Recommendation release item was not found in the batch.';
    END IF;
  END IF;

  IF NEW.action_type = 'OPPORTUNITY_CREATED' THEN
    SELECT recommendation_id, prospect_id,
           recommendation_context_version_id
      INTO opportunity_recommendation_id, opportunity_prospect_id,
           opportunity_context_id
      FROM backlink_opportunities
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND id = NEW.opportunity_id;

    IF NOT FOUND
       OR item_recommendation_id IS NULL
       OR (
         item_recommendation_id,
         item_prospect_id,
         item_context_id
       ) IS DISTINCT FROM (
         opportunity_recommendation_id,
         opportunity_prospect_id,
         opportunity_context_id
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Opportunity action must preserve recommendation item lineage.';
    END IF;
  END IF;

  IF NEW.action_type = 'GET_MORE' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM backlink_recommendation_user_unlocks AS unlock
       WHERE unlock.organization_id = NEW.organization_id
         AND unlock.workspace_id = NEW.workspace_id
         AND unlock.website_project_id = NEW.website_project_id
         AND unlock.user_id = NEW.user_id
         AND unlock.batch_id = NEW.batch_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'GET_MORE requires an authoritative unlock fact.';
    END IF;

    SELECT batch_ordinal
      INTO source_ordinal
      FROM backlink_recommendation_release_batches
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND id = NEW.batch_id;

    SELECT batch_ordinal, state
      INTO target_ordinal, target_state
      FROM backlink_recommendation_release_batches
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND id = NEW.target_batch_id
       AND recommendation_context_version_id =
         NEW.recommendation_context_version_id
       AND visible_pool_generation = NEW.visible_pool_generation;

    IF source_ordinal IS NULL
       OR target_ordinal <> source_ordinal + 1
       OR target_state <> 'AVAILABLE' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'GET_MORE must bind the next AVAILABLE canonical batch.';
    END IF;
  END IF;

  NEW.created_at := statement_timestamp();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_recommendation_pool_contract_status(
  p_organization_id text,
  p_workspace_id text,
  p_website_project_id text
)
RETURNS TABLE (
  pool_contract_version text,
  migration_state text,
  generation_contract_id uuid,
  recommendation_context_version_id uuid,
  visible_pool_generation integer,
  generation_enabled boolean,
  read_enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH authorized AS (
    SELECT
      NULLIF(
        current_setting('app.current_organization_id', true), ''
      )::uuid = p_organization_id::uuid
      AND NULLIF(
        current_setting('app.current_workspace_id', true), ''
      )::uuid = p_workspace_id::uuid
      AND NULLIF(
        current_setting('app.current_website_project_id', true), ''
      )::uuid = p_website_project_id::uuid AS allowed
  )
  SELECT contract.pool_contract_version,
         contract.migration_state,
         contract.generation_contract_id,
         contract.recommendation_context_version_id,
         contract.visible_pool_generation,
         contract.migration_state IN ('V1_ACTIVE', 'V2_ACTIVE'),
         contract.migration_state IN (
           'V1_ACTIVE', 'V2_ACTIVE', 'V2_MAINTENANCE_READ_ONLY'
         )
    FROM backlink_recommendation_pool_project_contracts AS contract
    CROSS JOIN authorized
   WHERE authorized.allowed
     AND contract.organization_id = p_organization_id::uuid
     AND contract.workspace_id = p_workspace_id::uuid
     AND contract.website_project_id = p_website_project_id::uuid
  UNION ALL
  SELECT 'recommendation-pool.v1',
         'V1_ACTIVE',
         NULL::uuid,
         NULL::uuid,
         NULL::integer,
         true,
         true
    FROM authorized
   WHERE authorized.allowed
     AND NOT EXISTS (
       SELECT 1
         FROM backlink_recommendation_pool_project_contracts AS contract
        WHERE contract.organization_id = p_organization_id::uuid
          AND contract.workspace_id = p_workspace_id::uuid
          AND contract.website_project_id = p_website_project_id::uuid
     );
$function$;

CREATE OR REPLACE FUNCTION backlink_recommendation_pool_contract_guard(
  p_organization_id text,
  p_workspace_id text,
  p_website_project_id text,
  p_worker_pool_contract_version text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT COALESCE((
    SELECT CASE
      WHEN status.pool_contract_version = p_worker_pool_contract_version
        AND status.generation_enabled
        THEN 'applicable'
      ELSE 'contract_not_applicable'
    END
      FROM backlink_recommendation_pool_contract_status(
        p_organization_id,
        p_workspace_id,
        p_website_project_id
      ) AS status
  ), 'contract_not_applicable');
$function$;

/*
 * Phase 8/9 cutover functions and the global V1 freeze guard are deferred.
 *
CREATE OR REPLACE FUNCTION backlink_recommendation_pool_v2_start_cutover_run(
  p_run_id uuid,
  p_command_id text,
  p_mode text,
  p_actor text
)
RETURNS TABLE (
  id uuid,
  command_id text,
  mode text,
  status text,
  eligible_project_count integer,
  v2_active_project_count integer,
  input_required_project_count integer,
  migration_blocked_project_count integer,
  verification jsonb,
  started_at timestamptz,
  completed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  existing_mode text;
BEGIN
  IF length(btrim(p_command_id)) = 0
     OR p_mode NOT IN ('PLAN', 'EXECUTE')
     OR length(btrim(p_actor)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid recommendation pool V2 cutover command.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('recommendation-pool-v2-cutover:' || p_command_id, 0)
  );

  SELECT run.mode
    INTO existing_mode
    FROM backlink_recommendation_pool_v2_cutover_runs AS run
   WHERE run.command_id = p_command_id;

  IF FOUND AND existing_mode <> p_mode THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Cutover command mode does not match the existing run.';
  END IF;

  INSERT INTO backlink_recommendation_pool_v2_cutover_runs (
    id, command_id, mode, created_by, updated_by
  ) VALUES (
    p_run_id, p_command_id, p_mode, p_actor, p_actor
  )
  ON CONFLICT (command_id) DO NOTHING;

  RETURN QUERY
  SELECT run.id,
         run.command_id,
         run.mode,
         run.status,
         run.eligible_project_count,
         run.v2_active_project_count,
         run.input_required_project_count,
         run.migration_blocked_project_count,
         run.verification,
         run.started_at,
         run.completed_at
    FROM backlink_recommendation_pool_v2_cutover_runs AS run
   WHERE run.command_id = p_command_id;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_recommendation_pool_v2_list_cutover_projects()
RETURNS TABLE (
  organization_id uuid,
  workspace_id uuid,
  website_project_id uuid,
  project_context_snapshot_id uuid,
  project_context_snapshot_version integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH latest AS (
    SELECT DISTINCT ON (
             snapshot.organization_id,
             snapshot.workspace_id,
             snapshot.website_project_id
           )
           snapshot.organization_id,
           snapshot.workspace_id,
           snapshot.website_project_id,
           snapshot.id,
           snapshot.snapshot_version,
           snapshot.project_status
      FROM backlink_project_context_snapshots AS snapshot
     ORDER BY snapshot.organization_id,
              snapshot.workspace_id,
              snapshot.website_project_id,
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
   WHERE latest.project_status = 'ACTIVE'
   ORDER BY latest.organization_id,
            latest.workspace_id,
            latest.website_project_id;
$function$;

CREATE OR REPLACE FUNCTION backlink_recommendation_pool_v2_record_cutover_fact(
  p_id uuid,
  p_run_id uuid,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_website_project_id uuid,
  p_project_context_snapshot_id uuid,
  p_project_context_snapshot_version integer,
  p_phase text,
  p_result text,
  p_reason_codes jsonb,
  p_generation_contract_id uuid,
  p_pool_contract_version text,
  p_recommendation_context_version_id uuid,
  p_visible_pool_generation integer,
  p_input_pin_id uuid,
  p_canonical_batch_count integer,
  p_available_batch_count integer,
  p_canonical_item_count integer,
  p_actor text,
  p_observed_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  run_status text;
BEGIN
  SELECT run.status
    INTO run_status
    FROM backlink_recommendation_pool_v2_cutover_runs AS run
   WHERE run.id = p_run_id
   FOR UPDATE;

  IF NOT FOUND OR run_status <> 'RUNNING' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Cutover facts can only be recorded for a running command.';
  END IF;

  IF length(btrim(p_actor)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Cutover fact actor is required.';
  END IF;

  INSERT INTO backlink_recommendation_pool_v2_cutover_project_facts (
    id, run_id, organization_id, workspace_id, website_project_id,
    project_context_snapshot_id, project_context_snapshot_version,
    phase, result, reason_codes, generation_contract_id,
    pool_contract_version, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, canonical_batch_count,
    available_batch_count, canonical_item_count, observed_at, created_by
  ) VALUES (
    p_id, p_run_id, p_organization_id, p_workspace_id,
    p_website_project_id, p_project_context_snapshot_id,
    p_project_context_snapshot_version, p_phase, p_result,
    COALESCE(p_reason_codes, '[]'::jsonb), p_generation_contract_id,
    p_pool_contract_version, p_recommendation_context_version_id,
    p_visible_pool_generation, p_input_pin_id, p_canonical_batch_count,
    p_available_batch_count, p_canonical_item_count,
    p_observed_at, p_actor
  )
  ON CONFLICT (
    run_id, organization_id, workspace_id, website_project_id, phase
  ) DO UPDATE
     SET result = EXCLUDED.result,
         reason_codes = EXCLUDED.reason_codes,
         generation_contract_id = EXCLUDED.generation_contract_id,
         pool_contract_version = EXCLUDED.pool_contract_version,
         recommendation_context_version_id =
           EXCLUDED.recommendation_context_version_id,
         visible_pool_generation = EXCLUDED.visible_pool_generation,
         input_pin_id = EXCLUDED.input_pin_id,
         canonical_batch_count = EXCLUDED.canonical_batch_count,
         available_batch_count = EXCLUDED.available_batch_count,
         canonical_item_count = EXCLUDED.canonical_item_count,
         observed_at = EXCLUDED.observed_at
   WHERE backlink_recommendation_pool_v2_cutover_project_facts
           .project_context_snapshot_id =
         EXCLUDED.project_context_snapshot_id
     AND backlink_recommendation_pool_v2_cutover_project_facts
           .project_context_snapshot_version =
         EXCLUDED.project_context_snapshot_version;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_recommendation_pool_v2_list_cutover_facts(
  p_run_id uuid
)
RETURNS TABLE (
  id uuid,
  run_id uuid,
  organization_id uuid,
  workspace_id uuid,
  website_project_id uuid,
  project_context_snapshot_id uuid,
  project_context_snapshot_version integer,
  phase text,
  result text,
  reason_codes jsonb,
  generation_contract_id uuid,
  pool_contract_version text,
  recommendation_context_version_id uuid,
  visible_pool_generation integer,
  input_pin_id uuid,
  canonical_batch_count integer,
  available_batch_count integer,
  canonical_item_count integer,
  observed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT fact.id,
         fact.run_id,
         fact.organization_id,
         fact.workspace_id,
         fact.website_project_id,
         fact.project_context_snapshot_id,
         fact.project_context_snapshot_version,
         fact.phase,
         fact.result,
         fact.reason_codes,
         fact.generation_contract_id,
         fact.pool_contract_version,
         fact.recommendation_context_version_id,
         fact.visible_pool_generation,
         fact.input_pin_id,
         fact.canonical_batch_count,
         fact.available_batch_count,
         fact.canonical_item_count,
         fact.observed_at
    FROM backlink_recommendation_pool_v2_cutover_project_facts AS fact
   WHERE fact.run_id = p_run_id
   ORDER BY fact.organization_id,
            fact.workspace_id,
            fact.website_project_id,
            fact.phase;
$function$;

CREATE OR REPLACE FUNCTION backlink_recommendation_pool_v2_verify_cutover()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH latest AS (
    SELECT DISTINCT ON (
             snapshot.organization_id,
             snapshot.workspace_id,
             snapshot.website_project_id
           )
           snapshot.organization_id,
           snapshot.workspace_id,
           snapshot.website_project_id,
           snapshot.id,
           snapshot.project_status
      FROM backlink_project_context_snapshots AS snapshot
     ORDER BY snapshot.organization_id,
              snapshot.workspace_id,
              snapshot.website_project_id,
              snapshot.snapshot_version DESC,
              snapshot.created_at DESC,
              snapshot.id DESC
  ),
  eligible AS (
    SELECT *
      FROM latest
     WHERE project_status = 'ACTIVE'
  ),
  project_state AS (
    SELECT eligible.organization_id,
           eligible.workspace_id,
           eligible.website_project_id,
           contract.migration_state,
           contract.pool_contract_version,
           generation.id AS generation_contract_id,
           (
             contract.migration_state = 'V2_ACTIVE'
             AND contract.pool_contract_version = 'recommendation-pool.v2'
             AND generation.pool_contract_version =
               'recommendation-pool.v2'
             AND generation.discovery_completed_at IS NOT NULL
             AND generation.effective_unique_candidate_count > 0
             AND generation.canonical_batch_count > 0
             AND (
               SELECT count(*)::integer
                 FROM backlink_recommendation_release_batches AS batch
                WHERE batch.organization_id = eligible.organization_id
                  AND batch.workspace_id = eligible.workspace_id
                  AND batch.website_project_id =
                    eligible.website_project_id
                  AND batch.generation_contract_id = generation.id
             ) = generation.canonical_batch_count
             AND NOT EXISTS (
               SELECT 1
                 FROM backlink_recommendation_release_batches AS batch
                WHERE batch.organization_id = eligible.organization_id
                  AND batch.workspace_id = eligible.workspace_id
                  AND batch.website_project_id =
                    eligible.website_project_id
                  AND batch.generation_contract_id = generation.id
                  AND (
                    batch.state <> 'AVAILABLE'
                    OR batch.contact_terminal_count <>
                      batch.contact_total_count
                  )
             )
             AND (
               SELECT count(*)::integer
                 FROM backlink_recommendation_release_batch_items AS item
                WHERE item.organization_id = eligible.organization_id
                  AND item.workspace_id = eligible.workspace_id
                  AND item.website_project_id =
                    eligible.website_project_id
                  AND item.generation_contract_id = generation.id
             ) = generation.effective_unique_candidate_count
             AND NOT EXISTS (
               SELECT 1
                 FROM backlink_recommendation_release_batch_items AS item
                WHERE item.organization_id = eligible.organization_id
                  AND item.workspace_id = eligible.workspace_id
                  AND item.website_project_id =
                    eligible.website_project_id
                  AND item.generation_contract_id = generation.id
                  AND (
                    item.candidate_id IS NULL
                    OR item.recommendation_id IS NULL
                    OR item.prospect_id IS NULL
                    OR item.inventory_id IS NULL
                    OR item.input_pin_id IS NULL
                    OR item.contact_terminal_reason_at_release IS NULL
                    OR item.contact_terminal_reason_at_release =
                      'CONTACT_PENDING'
                    OR item.contact_completed_at_release IS NULL
                  )
             )
           ) AS valid_v2_active
      FROM eligible
      LEFT JOIN backlink_recommendation_pool_project_contracts AS contract
        ON contract.organization_id = eligible.organization_id
       AND contract.workspace_id = eligible.workspace_id
       AND contract.website_project_id = eligible.website_project_id
      LEFT JOIN backlink_recommendation_generation_contracts AS generation
        ON generation.organization_id = contract.organization_id
       AND generation.workspace_id = contract.workspace_id
       AND generation.website_project_id = contract.website_project_id
       AND generation.id = contract.generation_contract_id
  ),
  project_counts AS (
    SELECT count(*)::integer AS eligible_project_count,
           count(*) FILTER (
             WHERE migration_state = 'V2_ACTIVE'
           )::integer AS v2_active_project_count,
           count(*) FILTER (
             WHERE valid_v2_active
           )::integer AS valid_v2_active_project_count,
           count(*) FILTER (
             WHERE migration_state IS NULL
                OR migration_state = 'V1_ACTIVE'
           )::integer AS active_v1_project_count,
           count(*) FILTER (
             WHERE migration_state = 'MIGRATION_BLOCKED'
           )::integer AS migration_blocked_project_count,
           count(*) FILTER (
             WHERE migration_state = 'V2_ACTIVE'
               AND NOT valid_v2_active
           )::integer AS invalid_v2_active_project_count
      FROM project_state
  ),
  active_v1_generation AS (
    SELECT count(*)::integer AS count
      FROM backlink_recommendation_generation_contracts AS generation
      JOIN project_state
        ON project_state.organization_id = generation.organization_id
       AND project_state.workspace_id = generation.workspace_id
       AND project_state.website_project_id =
         generation.website_project_id
     WHERE generation.pool_contract_version = 'recommendation-pool.v1'
       AND (
         project_state.migration_state IS NULL
         OR project_state.migration_state = 'V1_ACTIVE'
       )
  ),
  active_refill_job AS (
    SELECT count(*)::integer AS count
      FROM backlink_jobs AS job
     WHERE job.job_type = 'recommendation_refill'
       AND job.status IN ('queued', 'running', 'waiting_provider')
  ),
  active_refill AS (
    SELECT count(*)::integer AS count
      FROM backlink_recommendation_refills AS refill
      JOIN backlink_jobs AS job
        ON job.organization_id = refill.organization_id
       AND job.workspace_id = refill.workspace_id
       AND job.website_project_id = refill.website_project_id
       AND job.id = refill.job_id
     WHERE job.status IN ('queued', 'running', 'waiting_provider')
  ),
  active_outbox AS (
    SELECT count(*)::integer AS count
      FROM backlink_outbox_events AS event
     WHERE event.event_type =
             'backlinks.recommendation-refill.requested.v1'
       AND event.status IN ('pending', 'processing')
  ),
  active_claim AS (
    SELECT count(*)::integer AS count
      FROM backlink_recommendation_claims AS claim
     WHERE claim.status = 'active'
  ),
  active_provider_request AS (
    SELECT count(DISTINCT request.id)::integer AS count
      FROM provider_batch_requests AS request
      JOIN backlink_recommendation_refills AS refill
        ON request.request_id LIKE refill.refill_window_key || ':%'
     WHERE request.status IN ('running', 'unknown_charge')
  ),
  active_provider_reservation AS (
    SELECT count(DISTINCT usage.id)::integer AS count
      FROM backlink_provider_usage_ledger AS usage
      JOIN backlink_recommendation_refills AS refill
        ON usage.reservation_key LIKE refill.refill_window_key || ':%'
     WHERE usage.status = 'reserved'
  ),
  active_provider_lease AS (
    SELECT count(DISTINCT lease.artifact_fingerprint)::integer AS count
      FROM provider_fetch_leases AS lease
      JOIN backlink_recommendation_refills AS refill
        ON lease.owner_request_id LIKE refill.refill_window_key || ':%'
     WHERE lease.status IN ('acquired', 'unknown_charge')
  )
  SELECT jsonb_build_object(
    'eligibleProjectCount', project_counts.eligible_project_count,
    'v2ActiveProjectCount', project_counts.v2_active_project_count,
    'validV2ActiveProjectCount',
      project_counts.valid_v2_active_project_count,
    'activeV1ProjectCount', project_counts.active_v1_project_count,
    'migrationBlockedProjectCount',
      project_counts.migration_blocked_project_count,
    'invalidV2ActiveProjectCount',
      project_counts.invalid_v2_active_project_count,
    'activeV1GenerationCount', active_v1_generation.count,
    'activeV1RefillCount', active_refill.count,
    'activeV1RefillJobCount', active_refill_job.count,
    'activeV1OutboxCount', active_outbox.count,
    'activeV1ClaimCount', active_claim.count,
    'activeV1ProviderRequestCount', active_provider_request.count,
    'activeV1ProviderReservationCount',
      active_provider_reservation.count,
    'activeV1ProviderLeaseCount', active_provider_lease.count,
    'completed',
      project_counts.eligible_project_count =
        project_counts.valid_v2_active_project_count
      AND project_counts.active_v1_project_count = 0
      AND project_counts.migration_blocked_project_count = 0
      AND project_counts.invalid_v2_active_project_count = 0
      AND active_v1_generation.count = 0
      AND active_refill.count = 0
      AND active_refill_job.count = 0
      AND active_outbox.count = 0
      AND active_claim.count = 0
      AND active_provider_request.count = 0
      AND active_provider_reservation.count = 0
      AND active_provider_lease.count = 0
  )
    FROM project_counts,
         active_v1_generation,
         active_refill,
         active_refill_job,
         active_outbox,
         active_claim,
         active_provider_request,
         active_provider_reservation,
         active_provider_lease;
$function$;

CREATE OR REPLACE FUNCTION backlink_recommendation_pool_v2_freeze_v1_writes(
  p_run_id uuid,
  p_actor text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  run_mode text;
  run_status text;
  verification_result jsonb;
BEGIN
  SELECT run.mode, run.status
    INTO run_mode, run_status
    FROM backlink_recommendation_pool_v2_cutover_runs AS run
   WHERE run.id = p_run_id
   FOR UPDATE;

  IF NOT FOUND OR run_mode <> 'EXECUTE' OR run_status <> 'RUNNING' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'V1 writes can only be frozen by a running EXECUTE command.';
  END IF;

  IF length(btrim(p_actor)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Cutover freeze actor is required.';
  END IF;

  verification_result :=
    backlink_recommendation_pool_v2_verify_cutover();
  IF COALESCE((verification_result->>'completed')::boolean, false) = false THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'V1 writes cannot be frozen before global cutover verifies.';
  END IF;

  INSERT INTO backlink_recommendation_pool_v2_cutover_control (
    control_key, state, frozen_by_run_id, frozen_by
  ) VALUES (
    'GLOBAL', 'V1_WRITES_FROZEN', p_run_id, p_actor
  )
  ON CONFLICT (control_key) DO NOTHING;

  RETURN verification_result;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_recommendation_pool_v2_finish_cutover_run(
  p_run_id uuid,
  p_status text,
  p_eligible_project_count integer,
  p_v2_active_project_count integer,
  p_input_required_project_count integer,
  p_migration_blocked_project_count integer,
  p_verification jsonb,
  p_actor text,
  p_completed_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  existing_status text;
BEGIN
  IF p_status NOT IN (
       'PLANNED', 'INPUT_REQUIRED', 'MIGRATION_BLOCKED', 'COMPLETED'
     )
     OR p_eligible_project_count < 0
     OR p_v2_active_project_count < 0
     OR p_input_required_project_count < 0
     OR p_migration_blocked_project_count < 0
     OR jsonb_typeof(p_verification) <> 'object'
     OR length(btrim(p_actor)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid cutover completion payload.';
  END IF;

  IF p_status = 'COMPLETED' AND (
    COALESCE((p_verification->>'completed')::boolean, false) = false
    OR NOT EXISTS (
      SELECT 1
        FROM backlink_recommendation_pool_v2_cutover_control AS control
       WHERE control.control_key = 'GLOBAL'
         AND control.state = 'V1_WRITES_FROZEN'
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'A completed cutover requires verified frozen V1 writes.';
  END IF;

  SELECT run.status
    INTO existing_status
    FROM backlink_recommendation_pool_v2_cutover_runs AS run
   WHERE run.id = p_run_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Cutover run was not found.';
  END IF;

  IF existing_status <> 'RUNNING' THEN
    RETURN;
  END IF;

  UPDATE backlink_recommendation_pool_v2_cutover_runs
     SET status = p_status,
         eligible_project_count = p_eligible_project_count,
         v2_active_project_count = p_v2_active_project_count,
         input_required_project_count = p_input_required_project_count,
         migration_blocked_project_count =
           p_migration_blocked_project_count,
         verification = p_verification,
         completed_at = p_completed_at,
         updated_by = p_actor,
         version = version + 1
   WHERE id = p_run_id;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_reject_v1_write_after_cutover()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  frozen boolean;
  record_data jsonb;
  trace_value text;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM backlink_recommendation_pool_v2_cutover_control AS control
     WHERE control.control_key = 'GLOBAL'
       AND control.state = 'V1_WRITES_FROZEN'
  ) INTO frozen;

  IF NOT frozen THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  record_data := CASE
    WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
    ELSE to_jsonb(NEW)
  END;

  IF TG_TABLE_NAME =
       'backlink_recommendation_pool_project_contracts'
     AND (
       record_data->>'migration_state' = 'V1_ACTIVE'
       OR record_data->>'pool_contract_version' =
         'recommendation-pool.v1'
     ) THEN
    RAISE EXCEPTION 'V1 recommendation pool writes are frozen.';
  ELSIF TG_TABLE_NAME =
          'backlink_recommendation_generation_contracts'
        AND record_data->>'pool_contract_version' =
          'recommendation-pool.v1' THEN
    RAISE EXCEPTION 'V1 recommendation generation history is read-only.';
  ELSIF TG_TABLE_NAME = 'backlink_recommendation_refills' THEN
    RAISE EXCEPTION 'V1 recommendation refill history is read-only.';
  ELSIF TG_TABLE_NAME = 'backlink_jobs'
        AND record_data->>'job_type' = 'recommendation_refill' THEN
    RAISE EXCEPTION 'V1 recommendation refill jobs are frozen.';
  ELSIF TG_TABLE_NAME = 'backlink_outbox_events'
        AND record_data->>'event_type' =
          'backlinks.recommendation-refill.requested.v1' THEN
    RAISE EXCEPTION 'V1 recommendation refill outbox is frozen.';
  ELSIF TG_TABLE_NAME = 'backlink_recommendation_claims' THEN
    RAISE EXCEPTION 'V1 recommendation reservations are frozen.';
  ELSIF TG_TABLE_NAME = 'provider_batch_requests' THEN
    trace_value := record_data->>'request_id';
    IF EXISTS (
      SELECT 1
        FROM backlink_recommendation_refills AS refill
       WHERE trace_value LIKE refill.refill_window_key || ':%'
    ) THEN
      RAISE EXCEPTION 'V1 recommendation provider requests are frozen.';
    END IF;
  ELSIF TG_TABLE_NAME = 'backlink_provider_usage_ledger' THEN
    trace_value := record_data->>'reservation_key';
    IF EXISTS (
      SELECT 1
        FROM backlink_recommendation_refills AS refill
       WHERE trace_value LIKE refill.refill_window_key || ':%'
    ) THEN
      RAISE EXCEPTION 'V1 recommendation provider reservations are frozen.';
    END IF;
  ELSIF TG_TABLE_NAME = 'provider_fetch_leases' THEN
    trace_value := record_data->>'owner_request_id';
    IF EXISTS (
      SELECT 1
        FROM backlink_recommendation_refills AS refill
       WHERE trace_value LIKE refill.refill_window_key || ':%'
    ) THEN
      RAISE EXCEPTION 'V1 recommendation provider fetches are frozen.';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
*/

CREATE TRIGGER backlink_pool_project_contract_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendation_pool_project_contracts
FOR EACH ROW EXECUTE FUNCTION backlink_validate_pool_project_contract();

/*
 * Phase 9 V1 freeze triggers are deferred.
 *
CREATE TRIGGER backlink_pool_project_contract_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendation_pool_project_contracts
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_cutover();

CREATE TRIGGER backlink_generation_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendation_generation_contracts
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_cutover();

CREATE TRIGGER backlink_refill_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendation_refills
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_cutover();

CREATE TRIGGER backlink_job_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_jobs
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_cutover();

CREATE TRIGGER backlink_outbox_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_outbox_events
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_cutover();

CREATE TRIGGER backlink_claim_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendation_claims
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_cutover();

CREATE TRIGGER provider_batch_request_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON provider_batch_requests
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_cutover();

CREATE TRIGGER provider_usage_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_provider_usage_ledger
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_cutover();

CREATE TRIGGER provider_fetch_lease_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON provider_fetch_leases
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_cutover();
*/

CREATE TRIGGER backlink_commercial_seed_guard
BEFORE INSERT ON backlink_commercial_discovery_seeds
FOR EACH ROW EXECUTE FUNCTION backlink_validate_commercial_seed();

CREATE TRIGGER backlink_commercial_seed_immutable
BEFORE UPDATE OR DELETE ON backlink_commercial_discovery_seeds
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE TRIGGER backlink_commercial_seed_provenance_immutable
BEFORE UPDATE OR DELETE
ON backlink_commercial_discovery_seed_provenance_assertions
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE TRIGGER backlink_blueprint_seed_immutable
BEFORE UPDATE OR DELETE ON backlink_commercial_blueprint_seeds
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE TRIGGER backlink_release_batch_mutation_guard
BEFORE UPDATE OR DELETE ON backlink_recommendation_release_batches
FOR EACH ROW EXECUTE FUNCTION backlink_validate_release_batch_mutation();

CREATE TRIGGER backlink_release_item_write_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendation_release_batch_items
FOR EACH ROW EXECUTE FUNCTION backlink_validate_release_item_write();

CREATE CONSTRAINT TRIGGER backlink_release_batch_available_ck
AFTER INSERT OR UPDATE ON backlink_recommendation_release_batches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION backlink_validate_release_batch_available();

CREATE CONSTRAINT TRIGGER backlink_release_item_available_ck
AFTER INSERT OR UPDATE ON backlink_recommendation_release_batch_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION backlink_validate_release_batch_available();

CREATE TRIGGER backlink_user_publication_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON backlink_recommendation_user_publications
FOR EACH ROW EXECUTE FUNCTION backlink_validate_user_publication_mutation();

CREATE TRIGGER backlink_user_cursor_mutation_guard
BEFORE INSERT OR UPDATE OR DELETE ON backlink_recommendation_user_cursors
FOR EACH ROW EXECUTE FUNCTION backlink_validate_user_cursor_mutation();

CREATE TRIGGER backlink_user_unlock_guard
BEFORE INSERT ON backlink_recommendation_user_unlocks
FOR EACH ROW EXECUTE FUNCTION backlink_validate_user_unlock();

CREATE TRIGGER backlink_user_unlock_immutable
BEFORE UPDATE OR DELETE ON backlink_recommendation_user_unlocks
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE TRIGGER backlink_user_item_action_guard
BEFORE INSERT ON backlink_recommendation_user_item_actions
FOR EACH ROW EXECUTE FUNCTION backlink_validate_user_item_action();

CREATE TRIGGER backlink_user_item_action_immutable
BEFORE UPDATE OR DELETE ON backlink_recommendation_user_item_actions
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE INDEX backlink_pool_project_contract_state_idx
  ON backlink_recommendation_pool_project_contracts (
    organization_id, workspace_id, migration_state, pool_contract_version
  );

CREATE INDEX backlink_commercial_seed_generation_idx
  ON backlink_commercial_discovery_seeds (
    organization_id, workspace_id, website_project_id,
    recommendation_context_version_id, visible_pool_generation,
    validation_status, seed_kind
  );

CREATE INDEX backlink_commercial_seed_provenance_effective_idx
  ON backlink_commercial_discovery_seed_provenance_assertions (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, seed_id, asserted_source, created_at
  );

CREATE INDEX backlink_blueprint_seed_generation_idx
  ON backlink_commercial_blueprint_seeds (
    organization_id, workspace_id, website_project_id,
    recommendation_context_version_id, visible_pool_generation,
    generation_contract_id
  );

CREATE INDEX backlink_release_batch_state_idx
  ON backlink_recommendation_release_batches (
    organization_id, workspace_id, website_project_id,
    recommendation_context_version_id, visible_pool_generation,
    state, batch_ordinal
  );

CREATE INDEX backlink_release_item_filter_idx
  ON backlink_recommendation_release_batch_items (
    organization_id, workspace_id, website_project_id,
    recommendation_context_version_id, visible_pool_generation,
    recommended, primary_category, traffic_organic_etv,
    authority_rank, spam_score, position
  );

CREATE INDEX backlink_release_item_candidate_idx
  ON backlink_recommendation_release_batch_items (
    organization_id, workspace_id, website_project_id, candidate_id
  );

CREATE INDEX backlink_user_publication_scope_idx
  ON backlink_recommendation_user_publications (
    organization_id, workspace_id, website_project_id,
    user_id, recommendation_context_version_id, visible_pool_generation,
    publication_state, first_visible_at
  );

CREATE INDEX backlink_user_cursor_scope_idx
  ON backlink_recommendation_user_cursors (
    organization_id, workspace_id, website_project_id,
    user_id, recommendation_context_version_id, visible_pool_generation
  );

CREATE INDEX backlink_user_unlock_scope_idx
  ON backlink_recommendation_user_unlocks (
    organization_id, workspace_id, website_project_id,
    user_id, recommendation_context_version_id, visible_pool_generation,
    unlocked_at
  );

CREATE INDEX backlink_user_item_action_scope_idx
  ON backlink_recommendation_user_item_actions (
    organization_id, workspace_id, website_project_id,
    user_id, recommendation_context_version_id, visible_pool_generation,
    batch_id, action_type, created_at
  );

CREATE INDEX backlink_user_item_action_opportunity_idx
  ON backlink_recommendation_user_item_actions (
    organization_id, workspace_id, website_project_id, opportunity_id
  )
  WHERE opportunity_id IS NOT NULL;

ALTER TABLE backlink_recommendation_pool_project_contracts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_pool_project_contracts
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_discovery_seeds
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_discovery_seeds
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_discovery_seed_provenance_assertions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_discovery_seed_provenance_assertions
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_blueprint_seeds
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_commercial_blueprint_seeds
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_release_batches
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_release_batches
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_release_batch_items
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_release_batch_items
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_user_publications
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_user_publications
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_user_cursors
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_user_cursors
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_user_unlocks
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_user_unlocks
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_user_item_actions
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_user_item_actions
  FORCE ROW LEVEL SECURITY;
/*
 * Phase 8/9 cutover RLS and owner policies are deferred.
 *
ALTER TABLE backlink_recommendation_pool_v2_cutover_runs
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_pool_v2_cutover_runs
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_pool_v2_cutover_project_facts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_pool_v2_cutover_project_facts
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_pool_v2_cutover_control
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_pool_v2_cutover_control
  FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_project_context_snapshot_cutover_policy
  ON backlink_project_context_snapshots TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_outreach_profile_cutover_policy
  ON backlink_outreach_profile_versions TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_generation_input_pin_cutover_policy
  ON backlink_generation_input_pins TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_generation_contract_cutover_policy
  ON backlink_recommendation_generation_contracts
  TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_commercial_candidate_cutover_policy
  ON backlink_commercial_candidates TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_qualification_fact_cutover_policy
  ON backlink_recommendation_qualification_facts
  TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_visibility_fact_cutover_policy
  ON backlink_recommendation_visibility_facts
  TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_contact_fact_cutover_policy
  ON backlink_recommendation_contact_facts
  TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_inventory_cutover_policy
  ON backlink_recommendation_inventory TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_claim_cutover_policy
  ON backlink_recommendation_claims TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_refill_cutover_policy
  ON backlink_recommendation_refills TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_pool_project_contract_cutover_policy
  ON backlink_recommendation_pool_project_contracts
  TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_release_batch_cutover_policy
  ON backlink_recommendation_release_batches TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_release_item_cutover_policy
  ON backlink_recommendation_release_batch_items
  TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_pool_v2_cutover_run_internal_policy
  ON backlink_recommendation_pool_v2_cutover_runs
  TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_pool_v2_cutover_fact_internal_policy
  ON backlink_recommendation_pool_v2_cutover_project_facts
  TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
CREATE POLICY backlink_pool_v2_cutover_control_internal_policy
  ON backlink_recommendation_pool_v2_cutover_control
  TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);
*/

CREATE POLICY backlink_pool_project_contract_tenant_policy
ON backlink_recommendation_pool_project_contracts
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

CREATE POLICY backlink_commercial_seed_tenant_policy
ON backlink_commercial_discovery_seeds
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

CREATE POLICY backlink_commercial_seed_provenance_tenant_policy
ON backlink_commercial_discovery_seed_provenance_assertions
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

CREATE POLICY backlink_blueprint_seed_tenant_policy
ON backlink_commercial_blueprint_seeds
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

CREATE POLICY backlink_release_batch_tenant_policy
ON backlink_recommendation_release_batches
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

CREATE POLICY backlink_release_item_tenant_policy
ON backlink_recommendation_release_batch_items
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

CREATE POLICY backlink_user_publication_tenant_policy
ON backlink_recommendation_user_publications
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

CREATE POLICY backlink_user_cursor_tenant_policy
ON backlink_recommendation_user_cursors
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

CREATE POLICY backlink_user_unlock_tenant_policy
ON backlink_recommendation_user_unlocks
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

CREATE POLICY backlink_user_item_action_tenant_policy
ON backlink_recommendation_user_item_actions
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

COMMENT ON TABLE backlink_recommendation_release_batches IS
  'Canonical V2 release authority; independent from V1 inventory publication.';
COMMENT ON TABLE backlink_recommendation_release_batch_items IS
  'Canonical V2 batch membership and lineage; never a V1 PUBLISHED projection.';

CREATE OR REPLACE FUNCTION backlink_list_project_retained_dependencies(
  p_organization_id text,
  p_workspace_id text,
  p_website_project_id text
)
RETURNS TABLE (
  owner_module text,
  record_type text,
  record_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  PERFORM set_config('app.current_organization_id', p_organization_id, true);
  PERFORM set_config('app.current_workspace_id', p_workspace_id, true);
  PERFORM set_config(
    'app.current_website_project_id',
    p_website_project_id,
    true
  );
  PERFORM set_config('app.current_project_id', p_website_project_id, true);

  RETURN QUERY
  SELECT 'BACKLINKS', 'opportunity', item.id::text
    FROM (
      SELECT id FROM backlink_opportunities
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'GMAIL', 'project_mailbox_binding', item.id::text
    FROM (
      SELECT id FROM backlink_website_project_mailbox_bindings
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'REPLY', 'inbound_message', item.id::text
    FROM (
      SELECT id FROM backlink_inbound_messages
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'PLACEMENT', 'placement', item.id::text
    FROM (
      SELECT id FROM backlink_placements
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'LINKS', 'inventory_item', item.id::text
    FROM (
      SELECT id FROM backlink_inventory_items
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'MONITORING', 'inventory_monitor_observation', item.id::text
    FROM (
      SELECT id FROM backlink_inventory_monitor_observations
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'REPORT', 'report_revision', item.id::text
    FROM (
      SELECT id FROM backlink_report_revisions
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
       LIMIT 1
    ) AS item
  UNION ALL
  SELECT 'BACKLINKS', 'recommendation_pool_v2', item.id::text
    FROM (
      SELECT id
        FROM backlink_recommendation_pool_project_contracts
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
      UNION ALL
      SELECT id
        FROM backlink_commercial_discovery_seeds
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
      UNION ALL
      SELECT id
        FROM backlink_commercial_discovery_seed_provenance_assertions
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
      UNION ALL
      SELECT id
        FROM backlink_recommendation_release_batches
       WHERE organization_id::text = p_organization_id
         AND workspace_id::text = p_workspace_id
         AND website_project_id::text = p_website_project_id
      LIMIT 1
    ) AS item;
END;
$function$;

REVOKE ALL
  ON backlink_recommendation_pool_project_contracts,
     backlink_commercial_discovery_seeds,
     backlink_commercial_discovery_seed_provenance_assertions,
     backlink_commercial_blueprint_seeds,
     backlink_recommendation_release_batches,
     backlink_recommendation_release_batch_items,
     backlink_recommendation_user_publications,
     backlink_recommendation_user_cursors,
     backlink_recommendation_user_unlocks,
     backlink_recommendation_user_item_actions
  FROM PUBLIC;

REVOKE UPDATE, DELETE
  ON backlink_recommendation_generation_contracts
  FROM growthos_backlinks_writer;

GRANT UPDATE (
  effective_unique_candidate_count,
  canonical_batch_size,
  canonical_batch_count,
  canonical_order_fingerprint,
  discovery_terminal_reason,
  discovery_completed_at
)
  ON backlink_recommendation_generation_contracts
  TO growthos_backlinks_writer;

GRANT SELECT, INSERT
  ON backlink_recommendation_pool_project_contracts,
     backlink_recommendation_release_batches,
     backlink_recommendation_release_batch_items,
     backlink_recommendation_user_publications,
     backlink_recommendation_user_cursors
  TO growthos_backlinks_writer;

GRANT UPDATE (
  pool_contract_version,
  migration_state,
  generation_contract_id,
  recommendation_context_version_id,
  visible_pool_generation,
  input_pin_id,
  state_reason_codes,
  activated_at,
  updated_at,
  updated_by,
  version
)
  ON backlink_recommendation_pool_project_contracts
  TO growthos_backlinks_writer;

GRANT UPDATE (
  state,
  contact_terminal_count,
  available_at,
  updated_at,
  updated_by,
  version
)
  ON backlink_recommendation_release_batches
  TO growthos_backlinks_writer;

GRANT UPDATE (
  contact_terminal_reason_at_release,
  contact_email_at_release,
  contact_page_url_at_release,
  contact_completed_at_release
)
  ON backlink_recommendation_release_batch_items
  TO growthos_backlinks_writer;

GRANT UPDATE (
  publication_state,
  archived_at,
  updated_at,
  updated_by,
  version
)
  ON backlink_recommendation_user_publications
  TO growthos_backlinks_writer;

GRANT UPDATE (
  highest_published_batch_ordinal,
  current_batch_id,
  version,
  updated_at,
  updated_by
)
  ON backlink_recommendation_user_cursors
  TO growthos_backlinks_writer;

GRANT SELECT, INSERT
  ON backlink_commercial_discovery_seeds,
     backlink_commercial_discovery_seed_provenance_assertions,
     backlink_commercial_blueprint_seeds,
     backlink_recommendation_user_unlocks,
     backlink_recommendation_user_item_actions
  TO growthos_backlinks_writer;

GRANT SELECT
  ON backlink_recommendation_pool_project_contracts,
     backlink_commercial_discovery_seeds,
     backlink_commercial_discovery_seed_provenance_assertions,
     backlink_commercial_blueprint_seeds,
     backlink_recommendation_release_batches,
     backlink_recommendation_release_batch_items,
     backlink_recommendation_user_publications,
     backlink_recommendation_user_cursors,
     backlink_recommendation_user_unlocks,
     backlink_recommendation_user_item_actions
  TO growthos_reporting_reader;

REVOKE ALL
  ON FUNCTION backlink_recommendation_pool_contract_status(
    text, text, text
  ),
  backlink_recommendation_pool_contract_guard(
    text, text, text, text
  ),
  backlink_recommendation_batch_unlock_status(
    text, text, text, text, text
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION backlink_recommendation_pool_contract_status(
    text, text, text
  ),
  backlink_recommendation_pool_contract_guard(
    text, text, text, text
  ),
  backlink_recommendation_batch_unlock_status(
    text, text, text, text, text
  )
  TO growthos_backlinks_writer, growthos_reporting_reader;

GRANT EXECUTE
  ON FUNCTION backlink_list_project_retained_dependencies(text, text, text)
  TO growthos_platform_writer;

CREATE TABLE backlink_recommendation_discovery_request_intents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  input_pin_id uuid NOT NULL,
  pool_contract_version text NOT NULL DEFAULT 'recommendation-pool.v2',
  seed_id uuid NOT NULL,
  seed_fingerprint text NOT NULL,
  seed_kind text NOT NULL,
  seed_source text NOT NULL,
  discovery_budget_policy_version text NOT NULL,
  round_number integer NOT NULL,
  discovery_window_ordinal integer NOT NULL,
  discovery_source text NOT NULL,
  request_type text NOT NULL,
  page_type text NOT NULL,
  page_ordinal integer NOT NULL,
  canonical_request_fingerprint text NOT NULL,
  canonical_path_fingerprint text NOT NULL,
  country_code text NOT NULL,
  language_code text NOT NULL,
  business_direction_fingerprint text NOT NULL,
  authorized_cost_micros bigint NOT NULL,
  idempotency_key text NOT NULL,
  idempotency_hash text NOT NULL,
  started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_discovery_intent_lineage_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ),
  CONSTRAINT backlink_discovery_intent_request_fingerprint_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, canonical_request_fingerprint
  ),
  CONSTRAINT backlink_discovery_intent_path_fingerprint_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, canonical_path_fingerprint
  ),
  CONSTRAINT backlink_discovery_intent_idempotency_key_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, idempotency_key
  ),
  CONSTRAINT backlink_discovery_intent_idempotency_hash_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, idempotency_hash
  ),
  CONSTRAINT backlink_discovery_intent_values_ck CHECK (
    pool_contract_version = 'recommendation-pool.v2'
    AND visible_pool_generation > 0
    AND round_number IN (1, 2)
    AND discovery_window_ordinal > 0
    AND seed_kind IN ('KEYWORD', 'CATEGORY', 'SEO_COMPETITOR')
    AND seed_source IN (
      'USER_INPUT',
      'USER_TRIGGERED_GENERATION',
      'SYSTEM_FALLBACK',
      'SYSTEM_SUPPLEMENT'
    )
    AND length(btrim(seed_fingerprint)) > 0
    AND length(btrim(discovery_budget_policy_version)) > 0
    AND length(btrim(discovery_source)) > 0
    AND length(btrim(request_type)) > 0
    AND length(btrim(page_type)) > 0
    AND page_ordinal >= 0
    AND canonical_request_fingerprint ~ '^[a-f0-9]{64}$'
    AND canonical_path_fingerprint ~ '^[a-f0-9]{64}$'
    AND length(btrim(country_code)) > 0
    AND length(btrim(language_code)) > 0
    AND length(btrim(business_direction_fingerprint)) > 0
    AND authorized_cost_micros BETWEEN 0 AND 1000000
    AND length(btrim(idempotency_key)) > 0
    AND idempotency_hash ~ '^[a-f0-9]{64}$'
    AND length(btrim(created_by)) > 0
  ),
  CONSTRAINT backlink_discovery_intent_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_discovery_intent_seed_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    seed_id, generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, seed_fingerprint
  ) REFERENCES backlink_commercial_discovery_seeds (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, seed_fingerprint
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_discovery_request_outcomes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  input_pin_id uuid NOT NULL,
  pool_contract_version text NOT NULL DEFAULT 'recommendation-pool.v2',
  request_intent_id uuid NOT NULL,
  provider_request_id uuid NOT NULL,
  provider_batch_request_id uuid NOT NULL,
  provider_usage_ledger_id uuid NOT NULL,
  provider_task_id text,
  raw_candidate_count integer NOT NULL,
  effective_candidate_count integer NOT NULL,
  new_unique_count integer NOT NULL,
  duplicate_count integer NOT NULL,
  actual_cost_micros bigint,
  cumulative_cost_micros bigint,
  status text NOT NULL,
  charge_state text NOT NULL,
  failure_code text,
  finished_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_discovery_outcome_lineage_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ),
  CONSTRAINT backlink_discovery_outcome_request_uq UNIQUE (
    organization_id, workspace_id, website_project_id, request_intent_id
  ),
  CONSTRAINT backlink_discovery_outcome_values_ck CHECK (
    pool_contract_version = 'recommendation-pool.v2'
    AND visible_pool_generation > 0
    AND raw_candidate_count >= effective_candidate_count
    AND effective_candidate_count >= 0
    AND new_unique_count >= 0
    AND duplicate_count >= 0
    AND effective_candidate_count = new_unique_count + duplicate_count
    AND status IN (
      'SUCCEEDED',
      'PARTIAL',
      'FAILED',
      'UNKNOWN_CHARGE'
    )
    AND charge_state IN ('SETTLED', 'RELEASED', 'UNKNOWN_CHARGE')
    AND (
      provider_task_id IS NULL
      OR length(btrim(provider_task_id)) > 0
    )
  ),
  CONSTRAINT backlink_discovery_outcome_charge_ck CHECK (
    (
      charge_state = 'SETTLED'
      AND status IN ('SUCCEEDED', 'PARTIAL')
      AND actual_cost_micros BETWEEN 0 AND 1000000
      AND cumulative_cost_micros BETWEEN actual_cost_micros AND 2000000
      AND failure_code IS NULL
    )
    OR (
      charge_state = 'RELEASED'
      AND status = 'FAILED'
      AND actual_cost_micros = 0
      AND cumulative_cost_micros BETWEEN 0 AND 2000000
      AND length(btrim(failure_code)) > 0
    )
    OR (
      charge_state = 'UNKNOWN_CHARGE'
      AND status = 'UNKNOWN_CHARGE'
      AND actual_cost_micros IS NULL
      AND cumulative_cost_micros IS NULL
      AND length(btrim(failure_code)) > 0
    )
  ),
  CONSTRAINT backlink_discovery_outcome_created_by_ck CHECK (
    length(btrim(created_by)) > 0
  ),
  CONSTRAINT backlink_discovery_outcome_intent_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, request_intent_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_discovery_request_intents (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_discovery_outcome_provider_request_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, provider_request_id
  ) REFERENCES backlink_provider_requests (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_discovery_outcome_provider_batch_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    provider_batch_request_id
  ) REFERENCES provider_batch_requests (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_discovery_outcome_provider_usage_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    provider_usage_ledger_id
  ) REFERENCES backlink_provider_usage_ledger (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_discovery_window_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  input_pin_id uuid NOT NULL,
  pool_contract_version text NOT NULL DEFAULT 'recommendation-pool.v2',
  discovery_budget_policy_version text NOT NULL,
  round_number integer NOT NULL,
  window_ordinal integer NOT NULL,
  completed_request_count integer NOT NULL,
  raw_candidate_count integer NOT NULL,
  effective_candidate_count integer NOT NULL,
  new_unique_count integer NOT NULL,
  duplicate_count integer NOT NULL,
  new_unique_rate_numerator integer NOT NULL,
  new_unique_rate_denominator integer NOT NULL,
  window_authorized_cost_micros bigint NOT NULL,
  window_settled_cost_micros bigint,
  charge_state text NOT NULL,
  canonical_request_set_fingerprint text NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_discovery_window_lineage_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ),
  CONSTRAINT backlink_discovery_window_generation_ordinal_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, window_ordinal
  ),
  CONSTRAINT backlink_discovery_window_values_ck CHECK (
    pool_contract_version = 'recommendation-pool.v2'
    AND visible_pool_generation > 0
    AND length(btrim(discovery_budget_policy_version)) > 0
    AND round_number IN (1, 2)
    AND window_ordinal > 0
    AND completed_request_count > 0
    AND raw_candidate_count >= effective_candidate_count
    AND effective_candidate_count >= 0
    AND new_unique_count >= 0
    AND duplicate_count >= 0
    AND effective_candidate_count = new_unique_count + duplicate_count
    AND new_unique_rate_numerator = new_unique_count
    AND new_unique_rate_denominator = effective_candidate_count
    AND window_authorized_cost_micros BETWEEN 0 AND 1000000
    AND charge_state IN ('SETTLED', 'UNKNOWN_CHARGE')
    AND canonical_request_set_fingerprint ~ '^[a-f0-9]{64}$'
    AND length(btrim(created_by)) > 0
  ),
  CONSTRAINT backlink_discovery_window_charge_ck CHECK (
    (
      charge_state = 'SETTLED'
      AND window_settled_cost_micros
        BETWEEN 0 AND window_authorized_cost_micros
    )
    OR (
      charge_state = 'UNKNOWN_CHARGE'
      AND window_settled_cost_micros IS NULL
    )
  ),
  CONSTRAINT backlink_discovery_window_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_discovery_round_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  input_pin_id uuid NOT NULL,
  pool_contract_version text NOT NULL DEFAULT 'recommendation-pool.v2',
  discovery_budget_policy_version text NOT NULL,
  round_number integer NOT NULL,
  completed_window_count integer NOT NULL,
  completed_request_count integer NOT NULL,
  raw_candidate_count integer NOT NULL,
  effective_candidate_count integer NOT NULL,
  new_unique_count integer NOT NULL,
  duplicate_count integer NOT NULL,
  new_unique_rate_numerator integer NOT NULL,
  new_unique_rate_denominator integer NOT NULL,
  round_authorized_cost_micros bigint NOT NULL,
  round_settled_cost_micros bigint,
  cumulative_settled_cost_micros bigint,
  charge_state text NOT NULL,
  paths_exhausted boolean NOT NULL,
  changed_dimensions text[] NOT NULL DEFAULT ARRAY[]::text[],
  canonical_request_set_fingerprint text NOT NULL,
  policy_decision text NOT NULL,
  terminal_reason text,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_discovery_round_lineage_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ),
  CONSTRAINT backlink_discovery_round_generation_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, round_number
  ),
  CONSTRAINT backlink_discovery_round_values_ck CHECK (
    pool_contract_version = 'recommendation-pool.v2'
    AND visible_pool_generation > 0
    AND length(btrim(discovery_budget_policy_version)) > 0
    AND round_number IN (1, 2)
    AND completed_window_count > 0
    AND completed_request_count > 0
    AND raw_candidate_count >= effective_candidate_count
    AND effective_candidate_count >= 0
    AND new_unique_count >= 0
    AND duplicate_count >= 0
    AND effective_candidate_count = new_unique_count + duplicate_count
    AND new_unique_rate_numerator = new_unique_count
    AND new_unique_rate_denominator = effective_candidate_count
    AND round_authorized_cost_micros BETWEEN 0 AND 1000000
    AND charge_state IN ('SETTLED', 'UNKNOWN_CHARGE')
    AND changed_dimensions <@
      ARRAY['KEYWORD', 'COMPETITOR', 'SOURCE', 'PAGE', 'STRATEGY']::text[]
    AND (
      (round_number = 1 AND cardinality(changed_dimensions) = 0)
      OR (round_number = 2 AND cardinality(changed_dimensions) > 0)
    )
    AND canonical_request_set_fingerprint ~ '^[a-f0-9]{64}$'
    AND policy_decision IN ('START_ROUND_2', 'STOP')
    AND (
      (policy_decision = 'START_ROUND_2' AND terminal_reason IS NULL)
      OR (policy_decision = 'STOP' AND terminal_reason IS NOT NULL)
    )
    AND (
      policy_decision <> 'START_ROUND_2'
      OR (
        round_number = 1
        AND charge_state = 'SETTLED'
        AND paths_exhausted = false
        AND new_unique_count < 100
      )
    )
    AND (
      terminal_reason IS NULL
      OR terminal_reason IN (
        'CANDIDATE_LIMIT_REACHED',
        'SAFE_SUPPLY_REACHED',
        'LOW_YIELD',
        'BUDGET_EXHAUSTED',
        'PATHS_EXHAUSTED',
        'CONTEXT_SUPERSEDED',
        'UNKNOWN_CHARGE',
        'REQUEST_SCOPE_CHANGED'
      )
    )
    AND (
      terminal_reason IS DISTINCT FROM 'PATHS_EXHAUSTED'
      OR paths_exhausted
    )
    AND length(btrim(created_by)) > 0
  ),
  CONSTRAINT backlink_discovery_round_charge_ck CHECK (
    (
      charge_state = 'SETTLED'
      AND round_settled_cost_micros BETWEEN 0 AND round_authorized_cost_micros
      AND round_settled_cost_micros <= 1000000
      AND cumulative_settled_cost_micros
        BETWEEN round_settled_cost_micros AND 2000000
    )
    OR (
      charge_state = 'UNKNOWN_CHARGE'
      AND round_settled_cost_micros IS NULL
      AND cumulative_settled_cost_micros IS NULL
      AND policy_decision = 'STOP'
      AND terminal_reason = 'UNKNOWN_CHARGE'
    )
  ),
  CONSTRAINT backlink_discovery_round_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_recommendation_discovery_generation_terminal_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  input_pin_id uuid NOT NULL,
  pool_contract_version text NOT NULL DEFAULT 'recommendation-pool.v2',
  discovery_budget_policy_version text NOT NULL,
  effective_unique_candidate_count integer NOT NULL,
  terminal_reason text NOT NULL,
  total_settled_cost_micros bigint,
  charge_state text NOT NULL,
  completed_round_count integer NOT NULL,
  completed_window_count integer NOT NULL,
  canonical_request_set_fingerprint text NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_discovery_terminal_lineage_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ),
  CONSTRAINT backlink_discovery_terminal_generation_uq UNIQUE (
    organization_id, workspace_id, website_project_id, generation_contract_id
  ),
  CONSTRAINT backlink_discovery_terminal_values_ck CHECK (
    pool_contract_version = 'recommendation-pool.v2'
    AND visible_pool_generation > 0
    AND length(btrim(discovery_budget_policy_version)) > 0
    AND effective_unique_candidate_count BETWEEN 0 AND 1000
    AND terminal_reason IN (
      'CANDIDATE_LIMIT_REACHED',
      'SAFE_SUPPLY_REACHED',
      'LOW_YIELD',
      'BUDGET_EXHAUSTED',
      'PATHS_EXHAUSTED',
      'CONTEXT_SUPERSEDED',
      'UNKNOWN_CHARGE',
      'REQUEST_SCOPE_CHANGED'
    )
    AND charge_state IN ('SETTLED', 'UNKNOWN_CHARGE')
    AND completed_round_count IN (1, 2)
    AND completed_window_count >= completed_round_count
    AND canonical_request_set_fingerprint ~ '^[a-f0-9]{64}$'
    AND (
      terminal_reason <> 'CANDIDATE_LIMIT_REACHED'
      OR effective_unique_candidate_count = 1000
    )
    AND (
      terminal_reason <> 'SAFE_SUPPLY_REACHED'
      OR effective_unique_candidate_count >= 100
    )
    AND (
      (
        charge_state = 'SETTLED'
        AND total_settled_cost_micros BETWEEN 0 AND 2000000
        AND terminal_reason <> 'UNKNOWN_CHARGE'
      )
      OR (
        charge_state = 'UNKNOWN_CHARGE'
        AND total_settled_cost_micros IS NULL
        AND terminal_reason = 'UNKNOWN_CHARGE'
      )
    )
    AND length(btrim(created_by)) > 0
  ),
  CONSTRAINT backlink_discovery_terminal_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id,
    visible_pool_generation, input_pin_id, pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION backlink_validate_discovery_request_intent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  generation_policy_version text;
  generation_country_code text;
  generation_language_code text;
  pinned_country_code text;
  pinned_business_direction_fingerprint text;
  persisted_seed_kind text;
  persisted_seed_source text;
  round_authorized_cost_micros bigint;
  generation_authorized_cost_micros bigint;
BEGIN
  SELECT generation.discovery_budget_policy_version,
         generation.market,
         generation.language,
         input_pin.market,
         input_pin.immutable_fingerprint,
         seed.seed_kind,
         seed.source
    INTO generation_policy_version,
         generation_country_code,
         generation_language_code,
         pinned_country_code,
         pinned_business_direction_fingerprint,
         persisted_seed_kind,
         persisted_seed_source
    FROM backlink_recommendation_generation_contracts AS generation
    JOIN backlink_generation_input_pins AS input_pin
      ON (
        input_pin.organization_id,
        input_pin.workspace_id,
        input_pin.website_project_id,
        input_pin.id
      ) = (
        generation.organization_id,
        generation.workspace_id,
        generation.website_project_id,
        generation.input_pin_id
      )
    JOIN backlink_commercial_discovery_seeds AS seed
      ON seed.organization_id = generation.organization_id
     AND seed.workspace_id = generation.workspace_id
     AND seed.website_project_id = generation.website_project_id
     AND seed.generation_contract_id = generation.id
     AND seed.recommendation_context_version_id =
       generation.recommendation_context_version_id
     AND seed.visible_pool_generation = generation.visible_pool_generation
     AND seed.input_pin_id = generation.input_pin_id
     AND seed.id = NEW.seed_id
     AND seed.seed_fingerprint = NEW.seed_fingerprint
   WHERE generation.organization_id = NEW.organization_id
     AND generation.workspace_id = NEW.workspace_id
     AND generation.website_project_id = NEW.website_project_id
     AND generation.id = NEW.generation_contract_id
     AND generation.recommendation_context_version_id =
       NEW.recommendation_context_version_id
     AND generation.visible_pool_generation = NEW.visible_pool_generation
     AND generation.input_pin_id = NEW.input_pin_id
     AND generation.pool_contract_version = NEW.pool_contract_version
   FOR UPDATE OF generation;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'V2 discovery generation or seed lineage was not found.';
  END IF;

  IF NEW.discovery_budget_policy_version <> generation_policy_version
     OR NEW.country_code <> generation_country_code
     OR NEW.country_code <> pinned_country_code
     OR NEW.language_code <> generation_language_code
     OR NEW.business_direction_fingerprint <>
       pinned_business_direction_fingerprint
     OR NEW.seed_kind <> persisted_seed_kind
     OR NEW.seed_source <> persisted_seed_source THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
         'V2 discovery request scope differs from its pinned generation facts.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_recommendation_discovery_request_intents AS intent
     WHERE intent.organization_id = NEW.organization_id
       AND intent.workspace_id = NEW.workspace_id
       AND intent.website_project_id = NEW.website_project_id
       AND intent.generation_contract_id = NEW.generation_contract_id
       AND intent.round_number = NEW.round_number
       AND intent.discovery_window_ordinal = NEW.discovery_window_ordinal
       AND intent.canonical_request_fingerprint =
         NEW.canonical_request_fingerprint
       AND intent.canonical_path_fingerprint = NEW.canonical_path_fingerprint
       AND intent.authorized_cost_micros = NEW.authorized_cost_micros
       AND intent.idempotency_key = NEW.idempotency_key
       AND intent.idempotency_hash = NEW.idempotency_hash
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_recommendation_discovery_generation_terminal_facts
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND generation_contract_id = NEW.generation_contract_id
  ) OR EXISTS (
    SELECT 1
      FROM backlink_recommendation_discovery_round_facts
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND generation_contract_id = NEW.generation_contract_id
       AND round_number = NEW.round_number
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Discovery request intent cannot extend a completed fact.';
  END IF;

  SELECT
    COALESCE(
      sum(intent.authorized_cost_micros)
        FILTER (WHERE intent.round_number = NEW.round_number),
      0
    )::bigint,
    COALESCE(sum(intent.authorized_cost_micros), 0)::bigint
    INTO round_authorized_cost_micros,
         generation_authorized_cost_micros
    FROM backlink_recommendation_discovery_request_intents AS intent
   WHERE intent.organization_id = NEW.organization_id
     AND intent.workspace_id = NEW.workspace_id
     AND intent.website_project_id = NEW.website_project_id
     AND intent.generation_contract_id = NEW.generation_contract_id;

  IF round_authorized_cost_micros + NEW.authorized_cost_micros > 1000000
     OR generation_authorized_cost_micros + NEW.authorized_cost_micros >
       2000000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Discovery request authorization exceeds the persisted generation budget.';
  END IF;

  IF NEW.round_number = 2
     AND NOT EXISTS (
       SELECT 1
         FROM backlink_recommendation_discovery_round_facts AS round_fact
        WHERE round_fact.organization_id = NEW.organization_id
          AND round_fact.workspace_id = NEW.workspace_id
          AND round_fact.website_project_id = NEW.website_project_id
          AND round_fact.generation_contract_id = NEW.generation_contract_id
          AND round_fact.round_number = 1
           AND round_fact.discovery_budget_policy_version =
             NEW.discovery_budget_policy_version
           AND round_fact.charge_state = 'SETTLED'
           AND round_fact.policy_decision = 'START_ROUND_2'
           AND round_fact.new_unique_count < 100
      ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Round 2 requires a settled Round 1 fact authorizing another path.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_discovery_request_outcome()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  request_authorized_cost_micros bigint;
  request_started_at timestamptz;
  provider_request_status text;
  provider_request_provider text;
  provider_usage_request_id uuid;
  provider_usage_provider text;
  provider_usage_reservation_key text;
  provider_usage_estimated_cost_micros bigint;
  provider_usage_actual_cost_micros bigint;
  provider_usage_status text;
  provider_batch_provider text;
  provider_batch_reservation_key text;
  provider_batch_estimated_cost_micros bigint;
  provider_batch_actual_cost_micros bigint;
  provider_batch_task_id text;
  provider_batch_status text;
BEGIN
  SELECT intent.authorized_cost_micros, intent.started_at
    INTO request_authorized_cost_micros, request_started_at
    FROM backlink_recommendation_discovery_request_intents AS intent
   WHERE intent.organization_id = NEW.organization_id
     AND intent.workspace_id = NEW.workspace_id
     AND intent.website_project_id = NEW.website_project_id
     AND intent.id = NEW.request_intent_id
     AND intent.generation_contract_id = NEW.generation_contract_id
     AND intent.recommendation_context_version_id =
       NEW.recommendation_context_version_id
     AND intent.visible_pool_generation = NEW.visible_pool_generation
     AND intent.input_pin_id = NEW.input_pin_id
     AND intent.pool_contract_version = NEW.pool_contract_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'V2 discovery request intent lineage was not found.';
  END IF;

  SELECT provider, status
    INTO provider_request_provider, provider_request_status
    FROM backlink_provider_requests
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = NEW.provider_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Provider request lineage was not found.';
  END IF;

  SELECT provider_request_id,
         provider,
         reservation_key,
         estimated_cost_micros,
         actual_cost_micros,
         status
    INTO provider_usage_request_id,
         provider_usage_provider,
         provider_usage_reservation_key,
         provider_usage_estimated_cost_micros,
         provider_usage_actual_cost_micros,
         provider_usage_status
    FROM backlink_provider_usage_ledger
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = NEW.provider_usage_ledger_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Provider usage lineage was not found.';
  END IF;

  SELECT provider,
         budget_reservation_id,
         estimated_cost_micros,
         actual_cost_micros,
         provider_task_id,
         status
    INTO provider_batch_provider,
         provider_batch_reservation_key,
         provider_batch_estimated_cost_micros,
         provider_batch_actual_cost_micros,
         provider_batch_task_id,
         provider_batch_status
    FROM provider_batch_requests
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = NEW.provider_batch_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Provider batch lineage was not found.';
  END IF;

  IF provider_usage_request_id <> NEW.provider_request_id
     OR provider_usage_reservation_key <> provider_batch_reservation_key
     OR provider_request_provider <> provider_usage_provider
     OR provider_request_provider <> provider_batch_provider
     OR NEW.provider_task_id IS DISTINCT FROM provider_batch_task_id
     OR provider_usage_estimated_cost_micros >
       request_authorized_cost_micros
     OR provider_batch_estimated_cost_micros >
       request_authorized_cost_micros THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Provider request, batch, and usage lineage do not describe one request.';
  END IF;

  IF NEW.finished_at < request_started_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Discovery request outcome cannot finish before its intent.';
  END IF;

  IF NEW.charge_state = 'SETTLED'
     AND (
       provider_request_status <> 'succeeded'
       OR provider_usage_status <> 'settled'
       OR provider_batch_status NOT IN ('succeeded', 'partial')
       OR provider_usage_actual_cost_micros IS DISTINCT FROM
         NEW.actual_cost_micros
       OR provider_batch_actual_cost_micros IS DISTINCT FROM
         NEW.actual_cost_micros
       OR NEW.actual_cost_micros > request_authorized_cost_micros
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Settled discovery outcome does not match Provider facts.';
  END IF;

  IF NEW.charge_state = 'UNKNOWN_CHARGE'
     AND (
       provider_request_status <> 'unknown_charge'
       OR provider_usage_status <> 'reserved'
       OR provider_batch_status <> 'unknown_charge'
       OR provider_usage_actual_cost_micros IS NOT NULL
       OR provider_batch_actual_cost_micros IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Unknown-charge discovery outcome must retain unknown cost.';
  END IF;

  IF NEW.charge_state = 'RELEASED'
     AND (
       provider_request_status <> 'failed'
       OR provider_usage_status <> 'released'
       OR provider_batch_status <> 'failed'
       OR provider_usage_actual_cost_micros IS NOT NULL
       OR provider_batch_actual_cost_micros IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Released discovery outcome does not match Provider facts.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_discovery_window_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  generation_policy_version text;
  expected_window_ordinal integer;
  intent_count integer;
  outcome_count integer;
  aggregate_raw_count integer;
  aggregate_effective_count integer;
  aggregate_new_count integer;
  aggregate_duplicate_count integer;
  aggregate_authorized_cost_micros bigint;
  aggregate_settled_cost_micros bigint;
  has_unknown_charge boolean;
  latest_outcome_finished_at timestamptz;
BEGIN
  SELECT discovery_budget_policy_version
    INTO generation_policy_version
    FROM backlink_recommendation_generation_contracts
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = NEW.generation_contract_id
     AND recommendation_context_version_id =
       NEW.recommendation_context_version_id
     AND visible_pool_generation = NEW.visible_pool_generation
     AND input_pin_id = NEW.input_pin_id
     AND pool_contract_version = NEW.pool_contract_version
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'V2 discovery window generation lineage was not found.';
  END IF;

  IF NEW.discovery_budget_policy_version <> generation_policy_version THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Discovery window policy differs from its generation pin.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_recommendation_discovery_generation_terminal_facts
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND generation_contract_id = NEW.generation_contract_id
  ) OR EXISTS (
    SELECT 1
      FROM backlink_recommendation_discovery_round_facts
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND generation_contract_id = NEW.generation_contract_id
       AND round_number = NEW.round_number
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Discovery window cannot extend a completed fact.';
  END IF;

  SELECT COALESCE(max(window_ordinal), 0)::integer + 1
    INTO expected_window_ordinal
    FROM backlink_recommendation_discovery_window_facts
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND generation_contract_id = NEW.generation_contract_id;

  IF NEW.window_ordinal <> expected_window_ordinal THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Discovery window ordinals must be consecutive per generation.';
  END IF;

  SELECT
    count(intent.id)::integer,
    count(outcome.id)::integer,
    COALESCE(sum(outcome.raw_candidate_count), 0)::integer,
    COALESCE(sum(outcome.effective_candidate_count), 0)::integer,
    COALESCE(sum(outcome.new_unique_count), 0)::integer,
    COALESCE(sum(outcome.duplicate_count), 0)::integer,
    COALESCE(sum(intent.authorized_cost_micros), 0)::bigint,
    COALESCE(sum(outcome.actual_cost_micros), 0)::bigint,
    COALESCE(bool_or(outcome.charge_state = 'UNKNOWN_CHARGE'), false),
    max(outcome.finished_at)
    INTO intent_count,
         outcome_count,
         aggregate_raw_count,
         aggregate_effective_count,
         aggregate_new_count,
         aggregate_duplicate_count,
         aggregate_authorized_cost_micros,
         aggregate_settled_cost_micros,
         has_unknown_charge,
         latest_outcome_finished_at
    FROM backlink_recommendation_discovery_request_intents AS intent
    LEFT JOIN backlink_recommendation_discovery_request_outcomes AS outcome
      ON outcome.organization_id = intent.organization_id
     AND outcome.workspace_id = intent.workspace_id
     AND outcome.website_project_id = intent.website_project_id
     AND outcome.request_intent_id = intent.id
   WHERE intent.organization_id = NEW.organization_id
     AND intent.workspace_id = NEW.workspace_id
     AND intent.website_project_id = NEW.website_project_id
     AND intent.generation_contract_id = NEW.generation_contract_id
     AND intent.round_number = NEW.round_number
     AND intent.discovery_window_ordinal = NEW.window_ordinal;

  IF intent_count = 0
     OR outcome_count <> intent_count
     OR NEW.completed_request_count <> intent_count
     OR NEW.raw_candidate_count <> aggregate_raw_count
     OR NEW.effective_candidate_count <> aggregate_effective_count
     OR NEW.new_unique_count <> aggregate_new_count
     OR NEW.duplicate_count <> aggregate_duplicate_count
     OR NEW.new_unique_rate_numerator <> aggregate_new_count
     OR NEW.new_unique_rate_denominator <> aggregate_effective_count
     OR NEW.window_authorized_cost_micros <>
       aggregate_authorized_cost_micros
     OR NEW.completed_at < latest_outcome_finished_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Discovery window fact does not match its completed request outcomes.';
  END IF;

  IF has_unknown_charge THEN
    IF NEW.charge_state <> 'UNKNOWN_CHARGE'
       OR NEW.window_settled_cost_micros IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Unknown Provider charge must fail the window closed.';
    END IF;
  ELSIF NEW.charge_state <> 'SETTLED'
        OR NEW.window_settled_cost_micros <>
          aggregate_settled_cost_micros THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Settled window costs do not match Provider outcomes.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_discovery_round_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  generation_policy_version text;
  intent_count integer;
  outcome_count integer;
  aggregate_raw_count integer;
  aggregate_effective_count integer;
  aggregate_new_count integer;
  aggregate_duplicate_count integer;
  aggregate_authorized_cost_micros bigint;
  aggregate_settled_cost_micros bigint;
  aggregate_cumulative_cost_micros bigint;
  has_unknown_charge boolean;
  window_count integer;
  window_request_count integer;
  window_raw_count integer;
  window_effective_count integer;
  window_new_count integer;
  window_duplicate_count integer;
  window_authorized_cost_micros bigint;
  window_settled_cost_micros bigint;
  has_unknown_window_charge boolean;
  latest_window_completed_at timestamptz;
  low_yield_window_count integer;
  prior_round record;
BEGIN
  IF NEW.round_authorized_cost_micros > 1000000
     OR NEW.round_settled_cost_micros > 1000000
     OR NEW.cumulative_settled_cost_micros > 2000000 THEN
    RETURN NEW;
  END IF;

  SELECT discovery_budget_policy_version
    INTO generation_policy_version
    FROM backlink_recommendation_generation_contracts
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = NEW.generation_contract_id
     AND recommendation_context_version_id =
       NEW.recommendation_context_version_id
     AND visible_pool_generation = NEW.visible_pool_generation
     AND input_pin_id = NEW.input_pin_id
     AND pool_contract_version = NEW.pool_contract_version
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'V2 discovery round generation lineage was not found.';
  END IF;

  IF NEW.discovery_budget_policy_version <> generation_policy_version THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Discovery round policy differs from its generation pin.';
  END IF;

  IF NEW.policy_decision = 'START_ROUND_2'
     AND NEW.new_unique_count >= 100 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Round 2 cannot start after safe supply reaches 100 unique candidates.';
  END IF;

  SELECT
    count(intent.id)::integer,
    count(outcome.id)::integer,
    COALESCE(sum(outcome.raw_candidate_count), 0)::integer,
    COALESCE(sum(outcome.effective_candidate_count), 0)::integer,
    COALESCE(sum(outcome.new_unique_count), 0)::integer,
    COALESCE(sum(outcome.duplicate_count), 0)::integer,
    COALESCE(sum(intent.authorized_cost_micros), 0)::bigint,
    COALESCE(sum(outcome.actual_cost_micros), 0)::bigint,
    max(outcome.cumulative_cost_micros),
    COALESCE(bool_or(outcome.charge_state = 'UNKNOWN_CHARGE'), false)
    INTO intent_count,
         outcome_count,
         aggregate_raw_count,
         aggregate_effective_count,
         aggregate_new_count,
         aggregate_duplicate_count,
         aggregate_authorized_cost_micros,
         aggregate_settled_cost_micros,
         aggregate_cumulative_cost_micros,
         has_unknown_charge
    FROM backlink_recommendation_discovery_request_intents AS intent
    LEFT JOIN backlink_recommendation_discovery_request_outcomes AS outcome
      ON outcome.organization_id = intent.organization_id
     AND outcome.workspace_id = intent.workspace_id
     AND outcome.website_project_id = intent.website_project_id
     AND outcome.request_intent_id = intent.id
   WHERE intent.organization_id = NEW.organization_id
     AND intent.workspace_id = NEW.workspace_id
     AND intent.website_project_id = NEW.website_project_id
     AND intent.generation_contract_id = NEW.generation_contract_id
     AND intent.round_number = NEW.round_number;

  IF intent_count = 0
     OR outcome_count <> intent_count
     OR NEW.completed_request_count <> intent_count
     OR NEW.raw_candidate_count <> aggregate_raw_count
     OR NEW.effective_candidate_count <> aggregate_effective_count
     OR NEW.new_unique_count <> aggregate_new_count
     OR NEW.duplicate_count <> aggregate_duplicate_count
     OR NEW.new_unique_rate_numerator <> aggregate_new_count
     OR NEW.new_unique_rate_denominator <> aggregate_effective_count
     OR NEW.round_authorized_cost_micros <>
       aggregate_authorized_cost_micros THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Discovery round fact does not match its completed request outcomes.';
  END IF;

  SELECT
    count(*)::integer,
    COALESCE(sum(window_fact.completed_request_count), 0)::integer,
    COALESCE(sum(window_fact.raw_candidate_count), 0)::integer,
    COALESCE(sum(window_fact.effective_candidate_count), 0)::integer,
    COALESCE(sum(window_fact.new_unique_count), 0)::integer,
    COALESCE(sum(window_fact.duplicate_count), 0)::integer,
    COALESCE(sum(window_fact.window_authorized_cost_micros), 0)::bigint,
    COALESCE(sum(window_fact.window_settled_cost_micros), 0)::bigint,
    COALESCE(
      bool_or(window_fact.charge_state = 'UNKNOWN_CHARGE'),
      false
    ),
    max(window_fact.completed_at)
    INTO window_count,
         window_request_count,
         window_raw_count,
         window_effective_count,
         window_new_count,
         window_duplicate_count,
         window_authorized_cost_micros,
         window_settled_cost_micros,
         has_unknown_window_charge,
         latest_window_completed_at
    FROM backlink_recommendation_discovery_window_facts AS window_fact
   WHERE window_fact.organization_id = NEW.organization_id
     AND window_fact.workspace_id = NEW.workspace_id
     AND window_fact.website_project_id = NEW.website_project_id
     AND window_fact.generation_contract_id = NEW.generation_contract_id
     AND window_fact.round_number = NEW.round_number;

  IF NEW.completed_window_count <> window_count
     OR NEW.completed_request_count <> window_request_count
     OR NEW.raw_candidate_count <> window_raw_count
     OR NEW.effective_candidate_count <> window_effective_count
     OR NEW.new_unique_count <> window_new_count
     OR NEW.duplicate_count <> window_duplicate_count
     OR NEW.round_authorized_cost_micros <> window_authorized_cost_micros
     OR has_unknown_charge <> has_unknown_window_charge
     OR NEW.completed_at < latest_window_completed_at
     OR (
       NOT has_unknown_charge
       AND NEW.round_settled_cost_micros <> window_settled_cost_micros
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Discovery round fact does not match its append-only window facts.';
  END IF;

  IF NEW.terminal_reason = 'LOW_YIELD' THEN
    SELECT count(*)::integer
      INTO low_yield_window_count
      FROM (
        SELECT new_unique_count, new_unique_rate_denominator
          FROM backlink_recommendation_discovery_window_facts
         WHERE organization_id = NEW.organization_id
           AND workspace_id = NEW.workspace_id
           AND website_project_id = NEW.website_project_id
           AND generation_contract_id = NEW.generation_contract_id
         ORDER BY window_ordinal DESC
         LIMIT 2
      ) AS recent_window
     WHERE recent_window.new_unique_count < 5
       AND (
         recent_window.new_unique_rate_denominator = 0
         OR recent_window.new_unique_count::bigint * 100 <
           recent_window.new_unique_rate_denominator::bigint * 5
       );

    IF low_yield_window_count <> 2 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'LOW_YIELD requires two consecutive qualifying discovery windows.';
    END IF;
  END IF;

  IF has_unknown_charge THEN
    IF NEW.charge_state <> 'UNKNOWN_CHARGE'
       OR NEW.round_settled_cost_micros IS NOT NULL
       OR NEW.cumulative_settled_cost_micros IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Unknown Provider charge must fail the round closed.';
    END IF;
  ELSE
    IF NEW.charge_state <> 'SETTLED'
       OR NEW.round_settled_cost_micros <>
         aggregate_settled_cost_micros
       OR NEW.cumulative_settled_cost_micros <>
         aggregate_cumulative_cost_micros THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Settled round costs do not match Provider outcomes.';
    END IF;
  END IF;

  IF NEW.round_number = 1
     AND NEW.charge_state = 'SETTLED'
     AND NEW.cumulative_settled_cost_micros <>
       NEW.round_settled_cost_micros THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Round 1 cumulative cost must equal its settled cost.';
  END IF;

  IF NEW.round_number = 2 THEN
    SELECT charge_state,
           cumulative_settled_cost_micros,
           discovery_budget_policy_version,
           policy_decision
      INTO prior_round
      FROM backlink_recommendation_discovery_round_facts
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND generation_contract_id = NEW.generation_contract_id
       AND round_number = 1;

    IF NOT FOUND
       OR prior_round.charge_state <> 'SETTLED'
       OR prior_round.discovery_budget_policy_version <>
         NEW.discovery_budget_policy_version
       OR prior_round.policy_decision <> 'START_ROUND_2'
       OR (
         NEW.charge_state = 'SETTLED'
         AND NEW.cumulative_settled_cost_micros <>
           prior_round.cumulative_settled_cost_micros +
             NEW.round_settled_cost_micros
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Round 2 fact requires the matching settled Round 1 decision and cost.';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_discovery_terminal_fact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  generation_policy_version text;
  persisted_round_count integer;
  persisted_window_count integer;
  persisted_unique_count integer;
  final_round record;
BEGIN
  IF NEW.effective_unique_candidate_count > 1000
     OR NEW.total_settled_cost_micros > 2000000 THEN
    RETURN NEW;
  END IF;

  SELECT discovery_budget_policy_version
    INTO generation_policy_version
    FROM backlink_recommendation_generation_contracts
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = NEW.generation_contract_id
     AND recommendation_context_version_id =
       NEW.recommendation_context_version_id
     AND visible_pool_generation = NEW.visible_pool_generation
     AND input_pin_id = NEW.input_pin_id
     AND pool_contract_version = NEW.pool_contract_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'V2 discovery terminal generation lineage was not found.';
  END IF;

  SELECT count(*)::integer,
         COALESCE(sum(completed_window_count), 0)::integer,
         COALESCE(sum(new_unique_count), 0)::integer
    INTO persisted_round_count,
         persisted_window_count,
         persisted_unique_count
    FROM backlink_recommendation_discovery_round_facts
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND generation_contract_id = NEW.generation_contract_id;

  SELECT discovery_budget_policy_version,
         policy_decision,
         terminal_reason,
         cumulative_settled_cost_micros,
         charge_state
    INTO final_round
    FROM backlink_recommendation_discovery_round_facts
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND generation_contract_id = NEW.generation_contract_id
     AND round_number = NEW.completed_round_count;

  IF NOT FOUND
     OR generation_policy_version <> NEW.discovery_budget_policy_version
     OR final_round.discovery_budget_policy_version <>
       NEW.discovery_budget_policy_version
     OR final_round.policy_decision <> 'STOP'
     OR final_round.terminal_reason <> NEW.terminal_reason
     OR final_round.charge_state <> NEW.charge_state
     OR final_round.cumulative_settled_cost_micros IS DISTINCT FROM
       NEW.total_settled_cost_micros
     OR persisted_round_count <> NEW.completed_round_count
     OR persisted_window_count <> NEW.completed_window_count
     OR persisted_unique_count <> NEW.effective_unique_candidate_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Generation terminal fact does not match its immutable round facts.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_discovery_intent_validate
BEFORE INSERT ON backlink_recommendation_discovery_request_intents
FOR EACH ROW EXECUTE FUNCTION backlink_validate_discovery_request_intent();

CREATE TRIGGER backlink_discovery_intent_immutable
BEFORE UPDATE OR DELETE ON backlink_recommendation_discovery_request_intents
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE TRIGGER backlink_discovery_outcome_validate
BEFORE INSERT ON backlink_recommendation_discovery_request_outcomes
FOR EACH ROW EXECUTE FUNCTION backlink_validate_discovery_request_outcome();

CREATE TRIGGER backlink_discovery_outcome_immutable
BEFORE UPDATE OR DELETE ON backlink_recommendation_discovery_request_outcomes
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE TRIGGER backlink_discovery_window_validate
BEFORE INSERT ON backlink_recommendation_discovery_window_facts
FOR EACH ROW EXECUTE FUNCTION backlink_validate_discovery_window_fact();

CREATE TRIGGER backlink_discovery_window_immutable
BEFORE UPDATE OR DELETE ON backlink_recommendation_discovery_window_facts
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE TRIGGER backlink_discovery_round_validate
BEFORE INSERT ON backlink_recommendation_discovery_round_facts
FOR EACH ROW EXECUTE FUNCTION backlink_validate_discovery_round_fact();

CREATE TRIGGER backlink_discovery_round_immutable
BEFORE UPDATE OR DELETE ON backlink_recommendation_discovery_round_facts
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE TRIGGER backlink_discovery_terminal_validate
BEFORE INSERT ON backlink_recommendation_discovery_generation_terminal_facts
FOR EACH ROW EXECUTE FUNCTION backlink_validate_discovery_terminal_fact();

CREATE TRIGGER backlink_discovery_terminal_immutable
BEFORE UPDATE OR DELETE
ON backlink_recommendation_discovery_generation_terminal_facts
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE INDEX backlink_discovery_intent_trace_idx
  ON backlink_recommendation_discovery_request_intents (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, round_number, started_at
  );

CREATE INDEX backlink_discovery_outcome_provider_trace_idx
  ON backlink_recommendation_discovery_request_outcomes (
    organization_id, workspace_id, website_project_id,
    provider_request_id, provider_batch_request_id, provider_usage_ledger_id
  );

CREATE INDEX backlink_discovery_window_completed_idx
  ON backlink_recommendation_discovery_window_facts (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, round_number, completed_at
  );

CREATE INDEX backlink_discovery_round_completed_idx
  ON backlink_recommendation_discovery_round_facts (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, completed_at
  );

CREATE INDEX backlink_discovery_terminal_completed_idx
  ON backlink_recommendation_discovery_generation_terminal_facts (
    organization_id, workspace_id, website_project_id, completed_at
  );

ALTER TABLE backlink_recommendation_discovery_request_intents
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_discovery_request_intents
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_discovery_request_outcomes
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_discovery_request_outcomes
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_discovery_window_facts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_discovery_window_facts
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_discovery_round_facts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_discovery_round_facts
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_discovery_generation_terminal_facts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_discovery_generation_terminal_facts
  FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_discovery_intent_tenant_policy
ON backlink_recommendation_discovery_request_intents
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

CREATE POLICY backlink_discovery_outcome_tenant_policy
ON backlink_recommendation_discovery_request_outcomes
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

CREATE POLICY backlink_discovery_window_tenant_policy
ON backlink_recommendation_discovery_window_facts
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

CREATE POLICY backlink_discovery_round_tenant_policy
ON backlink_recommendation_discovery_round_facts
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

CREATE POLICY backlink_discovery_terminal_tenant_policy
ON backlink_recommendation_discovery_generation_terminal_facts
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

REVOKE ALL
  ON backlink_recommendation_discovery_request_intents,
     backlink_recommendation_discovery_request_outcomes,
     backlink_recommendation_discovery_window_facts,
     backlink_recommendation_discovery_round_facts,
     backlink_recommendation_discovery_generation_terminal_facts
  FROM PUBLIC, growthos_backlinks_writer, growthos_reporting_reader;

GRANT SELECT, INSERT
  ON backlink_recommendation_discovery_request_intents,
     backlink_recommendation_discovery_request_outcomes,
     backlink_recommendation_discovery_window_facts,
     backlink_recommendation_discovery_round_facts,
     backlink_recommendation_discovery_generation_terminal_facts
  TO growthos_backlinks_writer;

GRANT SELECT
  ON backlink_recommendation_discovery_request_intents,
     backlink_recommendation_discovery_request_outcomes,
     backlink_recommendation_discovery_window_facts,
     backlink_recommendation_discovery_round_facts,
     backlink_recommendation_discovery_generation_terminal_facts
  TO growthos_reporting_reader;

COMMENT ON TABLE backlink_recommendation_discovery_request_intents IS
  'Append-only V2 discovery request authority, independent from release batches.';
COMMENT ON TABLE backlink_recommendation_discovery_request_outcomes IS
  'Append-only V2 discovery outcome facts linked to existing Provider ledgers.';
COMMENT ON TABLE backlink_recommendation_discovery_window_facts IS
  'Append-only V2 completed discovery windows used by budget policy facts.';
COMMENT ON TABLE backlink_recommendation_discovery_round_facts IS
  'Append-only V2 discovery round aggregates and budget policy decisions.';
COMMENT ON TABLE
  backlink_recommendation_discovery_generation_terminal_facts IS
  'Append-only V2 discovery terminal facts; not canonical batch completion.';

COMMIT;
