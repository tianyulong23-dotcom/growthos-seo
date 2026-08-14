BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_commercial_inventory_policies
  ADD COLUMN refill_state text NOT NULL DEFAULT 'idle',
  ADD COLUMN current_refill_tier text NOT NULL
    DEFAULT 'exact_product_target_market',
  ADD COLUMN current_refill_round integer NOT NULL DEFAULT 1,
  ADD COLUMN attempted_refill_tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN termination_reason text,
  ADD COLUMN last_publishable_count integer NOT NULL DEFAULT 0,
  ADD COLUMN last_raw_candidate_count integer NOT NULL DEFAULT 0,
  ADD COLUMN elimination_reason_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT backlink_commercial_refill_state_check CHECK (
    refill_state IN (
      'idle', 'running', 'waiting_contact', 'completed', 'paused',
      'exhausted'
    )
  ),
  ADD CONSTRAINT backlink_commercial_refill_tier_check CHECK (
    current_refill_tier IN (
      'exact_product_target_market',
      'same_topic_target_market',
      'adjacent_industry_same_audience',
      'resource_media_review_partner_ecosystem',
      'same_language_expansion'
    )
  ),
  ADD CONSTRAINT backlink_commercial_refill_round_check CHECK (
    current_refill_round >= 1
  ),
  ADD CONSTRAINT backlink_commercial_refill_attempts_check CHECK (
    jsonb_typeof(attempted_refill_tiers) = 'array'
  ),
  ADD CONSTRAINT backlink_commercial_refill_termination_check CHECK (
    termination_reason IS NULL OR termination_reason IN (
      'HIGH_WATERMARK', 'BUDGET', 'PROVIDER_UNAVAILABLE',
      'TIERS_EXHAUSTED', 'PROJECT_CONTEXT'
    )
  ),
  ADD CONSTRAINT backlink_commercial_refill_counts_check CHECK (
    last_publishable_count >= 0
    AND last_raw_candidate_count >= 0
    AND jsonb_typeof(elimination_reason_counts) = 'object'
  );

ALTER TABLE backlink_commercial_discovery_batches
  ADD COLUMN refill_tier text NOT NULL
    DEFAULT 'exact_product_target_market',
  ADD COLUMN refill_round integer NOT NULL DEFAULT 1,
  ADD COLUMN raw_candidate_count integer NOT NULL DEFAULT 0,
  ADD COLUMN eligible_candidate_count integer NOT NULL DEFAULT 0,
  ADD COLUMN elimination_reason_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT backlink_commercial_batch_refill_tier_check CHECK (
    refill_tier IN (
      'exact_product_target_market',
      'same_topic_target_market',
      'adjacent_industry_same_audience',
      'resource_media_review_partner_ecosystem',
      'same_language_expansion'
    )
  ),
  ADD CONSTRAINT backlink_commercial_batch_refill_round_check CHECK (
    refill_round >= 1
  ),
  ADD CONSTRAINT backlink_commercial_batch_refill_counts_check CHECK (
    raw_candidate_count >= 0
    AND eligible_candidate_count >= 0
    AND eligible_candidate_count <= raw_candidate_count
    AND jsonb_typeof(elimination_reason_counts) = 'object'
  );

CREATE INDEX backlink_commercial_refill_cycle_idx
  ON backlink_commercial_discovery_batches (
    organization_id, workspace_id, website_project_id,
    project_context_version_id, refill_round, refill_tier, status
  );

COMMIT;
