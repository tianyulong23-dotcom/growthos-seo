BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_commercial_inventory_policies
  DROP CONSTRAINT backlink_commercial_refill_tier_check,
  ADD CONSTRAINT backlink_commercial_refill_tier_check CHECK (
    current_refill_tier IN (
      'exact_product_target_market',
      'same_topic_target_market',
      'adjacent_industry_same_audience',
      'resource_media_review_partner_ecosystem',
      'same_language_expansion',
      'curated_resource_library'
    )
  );

ALTER TABLE backlink_commercial_discovery_batches
  DROP CONSTRAINT backlink_commercial_batch_refill_tier_check,
  ADD CONSTRAINT backlink_commercial_batch_refill_tier_check CHECK (
    refill_tier IN (
      'exact_product_target_market',
      'same_topic_target_market',
      'adjacent_industry_same_audience',
      'resource_media_review_partner_ecosystem',
      'same_language_expansion',
      'curated_resource_library'
    )
  );

CREATE TABLE backlink_resource_library_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  resource_key text NOT NULL,
  canonical_domain text NOT NULL,
  canonical_url text NOT NULL,
  website_name text NOT NULL,
  resource_type text NOT NULL,
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  country_language text,
  domain_authority numeric(12,3),
  monthly_organic_traffic bigint,
  dataforseo_rank numeric(12,3),
  spam_score numeric(7,3),
  profile_health_score integer,
  authority_score integer NOT NULL,
  quality_bucket text NOT NULL,
  quality_reviewed boolean NOT NULL DEFAULT false,
  risk_level text,
  recommendation text,
  referring_domains bigint,
  backlinks bigint,
  active boolean NOT NULL DEFAULT true,
  source_bundle_sha256 text NOT NULL,
  source_generated_at timestamptz NOT NULL,
  raw_resource jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_resource_library_values_check CHECK (
    length(btrim(resource_key)) > 0
    AND canonical_domain = lower(canonical_domain)
    AND length(btrim(canonical_domain)) > 0
    AND length(btrim(canonical_url)) > 0
    AND length(btrim(website_name)) > 0
    AND resource_type IN ('free', 'paid')
    AND jsonb_typeof(categories) = 'array'
    AND jsonb_typeof(tags) = 'array'
    AND authority_score BETWEEN 0 AND 100
    AND quality_bucket IN ('recommend', 'review', 'avoid', 'unclassified')
    AND (spam_score IS NULL OR spam_score BETWEEN 0 AND 100)
    AND (
      profile_health_score IS NULL
      OR profile_health_score BETWEEN 0 AND 100
    )
    AND (referring_domains IS NULL OR referring_domains >= 0)
    AND (backlinks IS NULL OR backlinks >= 0)
    AND length(source_bundle_sha256) = 64
    AND jsonb_typeof(raw_resource) = 'object'
    AND version > 0
  ),
  CONSTRAINT backlink_resource_library_key_uq UNIQUE (
    organization_id, workspace_id, resource_key
  ),
  CONSTRAINT backlink_resource_library_domain_uq UNIQUE (
    organization_id, workspace_id, canonical_domain
  )
);

CREATE INDEX backlink_resource_library_matching_idx
  ON backlink_resource_library_items (
    organization_id, workspace_id, active, quality_bucket,
    quality_reviewed, risk_level, authority_score DESC
  );

ALTER TABLE backlink_resource_library_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_resource_library_items FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_resource_library_tenant_policy
  ON backlink_resource_library_items
  USING (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id =
      NULLIF(
        current_setting('app.current_organization_id', true),
        ''
      )::uuid
    AND workspace_id =
      NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE
  ON backlink_resource_library_items
  TO growthos_backlinks_writer;

DO $$
BEGIN
  IF to_regrole('growthos_backlinks_reporting') IS NOT NULL THEN
    GRANT SELECT
      ON backlink_resource_library_items
      TO growthos_backlinks_reporting;
  END IF;
END
$$;

UPDATE backlink_commercial_inventory_policies
   SET current_refill_tier = 'curated_resource_library',
       refill_state = 'idle',
       termination_reason = NULL,
       pause_reason = NULL,
       next_refill_at = now(),
       attempted_refill_tiers = (
         SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
           FROM jsonb_array_elements(attempted_refill_tiers) AS value
          WHERE value->>'tier' <> 'curated_resource_library'
       ),
       updated_at = now(),
       updated_by = 'migration:backlinks-0057',
       version = version + 1
 WHERE current_refill_tier = 'same_language_expansion'
   AND refill_state = 'exhausted'
   AND termination_reason = 'TIERS_EXHAUSTED';

COMMIT;
