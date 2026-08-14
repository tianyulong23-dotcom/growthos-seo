BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_commercial_inventory_policies
  ADD COLUMN paid_refill_tier text,
  ADD COLUMN paid_refill_round integer,
  ADD COLUMN resource_refill_tier text,
  ADD COLUMN resource_refill_round integer,
  ADD CONSTRAINT backlink_commercial_paid_refill_cursor_check CHECK (
    (
      paid_refill_tier IS NULL
      AND paid_refill_round IS NULL
    )
    OR (
      paid_refill_tier IN (
        'exact_product_target_market',
        'same_topic_target_market',
        'adjacent_industry_same_audience',
        'resource_media_review_partner_ecosystem',
        'same_language_expansion'
      )
      AND paid_refill_round >= 1
    )
  ),
  ADD CONSTRAINT backlink_commercial_resource_refill_cursor_check CHECK (
    (
      resource_refill_tier IS NULL
      AND resource_refill_round IS NULL
    )
    OR (
      resource_refill_tier = 'curated_resource_library'
      AND resource_refill_round >= 1
    )
  );

ALTER TABLE backlink_commercial_inventory_policies
  NO FORCE ROW LEVEL SECURITY;

WITH last_paid_attempt AS (
  SELECT policy.organization_id,
         policy.workspace_id,
         policy.website_project_id,
         policy.project_context_version_id,
         attempt.value->>'tier' AS tier,
         (attempt.value->>'round')::integer AS round
    FROM backlink_commercial_inventory_policies AS policy
    JOIN LATERAL (
      SELECT value
        FROM jsonb_array_elements(policy.attempted_refill_tiers)
             WITH ORDINALITY AS item(value, ordinal)
       WHERE value->>'tier' IN (
         'exact_product_target_market',
         'same_topic_target_market',
         'adjacent_industry_same_audience',
         'resource_media_review_partner_ecosystem',
         'same_language_expansion'
       )
         AND (value->>'round') ~ '^[1-9][0-9]*$'
       ORDER BY ordinal DESC
       LIMIT 1
    ) AS attempt ON true
)
UPDATE backlink_commercial_inventory_policies AS policy
   SET paid_refill_tier = CASE
         WHEN policy.current_refill_tier <> 'curated_resource_library'
           THEN policy.current_refill_tier
         ELSE last_paid.tier
       END,
       paid_refill_round = CASE
         WHEN policy.current_refill_tier <> 'curated_resource_library'
           THEN policy.current_refill_round
         ELSE last_paid.round
       END,
       resource_refill_tier = CASE
         WHEN policy.current_refill_tier = 'curated_resource_library'
           THEN 'curated_resource_library'
         ELSE NULL
       END,
       resource_refill_round = CASE
         WHEN policy.current_refill_tier = 'curated_resource_library'
           THEN policy.current_refill_round
         ELSE NULL
       END
  FROM (
    SELECT organization_id,workspace_id,website_project_id,
           project_context_version_id,tier,round
      FROM last_paid_attempt
  ) AS last_paid
 WHERE (
   policy.organization_id,
   policy.workspace_id,
   policy.website_project_id,
   policy.project_context_version_id
 ) = (
   last_paid.organization_id,
   last_paid.workspace_id,
   last_paid.website_project_id,
   last_paid.project_context_version_id
 );

UPDATE backlink_commercial_inventory_policies
   SET paid_refill_tier = current_refill_tier,
       paid_refill_round = current_refill_round
 WHERE current_refill_tier <> 'curated_resource_library'
   AND paid_refill_tier IS NULL;

UPDATE backlink_commercial_inventory_policies
   SET resource_refill_tier = 'curated_resource_library',
       resource_refill_round = current_refill_round
 WHERE current_refill_tier = 'curated_resource_library'
   AND resource_refill_tier IS NULL;

ALTER TABLE backlink_commercial_inventory_policies
  FORCE ROW LEVEL SECURITY;

COMMIT;
