BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_project_context_snapshots
  ADD COLUMN target_market text NOT NULL DEFAULT '',
  ADD COLUMN target_audiences jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN partnership_goals jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT backlink_project_context_target_audiences_array_ck CHECK (
    jsonb_typeof(target_audiences) = 'array'
  ),
  ADD CONSTRAINT backlink_project_context_partnership_goals_array_ck CHECK (
    jsonb_typeof(partnership_goals) = 'array'
  );

ALTER TABLE backlink_commercial_inventory_policies
  NO FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_recommendation_refills
  NO FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_outbox_events
  NO FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_commercial_inventory_policies
  DROP CONSTRAINT backlink_commercial_visible_pool_target_check,
  ALTER COLUMN visible_pool_target_count SET DEFAULT 10;

UPDATE backlink_commercial_inventory_policies
   SET visible_pool_target_count=10,
       published_contact_ready_low_watermark=9,
       published_contact_ready_high_watermark=10;

ALTER TABLE backlink_commercial_inventory_policies
  ALTER COLUMN published_contact_ready_low_watermark SET DEFAULT 9,
  ALTER COLUMN published_contact_ready_high_watermark SET DEFAULT 10,
  ADD CONSTRAINT backlink_commercial_visible_pool_target_check CHECK (
    visible_pool_target_count = 10
    AND archived_visible_pool_count >= 0
  );

ALTER TABLE backlink_recommendation_refills
  DROP CONSTRAINT backlink_rec_refill_watermark_check;

UPDATE backlink_recommendation_refills
   SET low_watermark=9,
       high_watermark=10,
       updated_at=now(),
       updated_by='migration:backlinks-0060';

ALTER TABLE backlink_recommendation_refills
  ADD CONSTRAINT backlink_rec_refill_watermark_check CHECK (
    low_watermark = 9 AND high_watermark = 10
  );

UPDATE backlink_outbox_events
   SET payload=jsonb_set(
         jsonb_set(payload,'{lowWatermark}','9'::jsonb,true),
         '{highWatermark}','10'::jsonb,true
       ),
       updated_at=now(),
       updated_by='migration:backlinks-0060'
 WHERE event_type='backlinks.recommendation-refill.requested.v1'
   AND status IN ('pending','processing','failed');

WITH published AS (
  SELECT policy.organization_id,
         policy.workspace_id,
         policy.website_project_id,
         policy.project_context_version_id,
         count(inventory.id) FILTER (
           WHERE inventory.publication_status='PUBLISHED'
             AND inventory.fit_decision='eligible'
             AND inventory.fit_score_model_version=
               'recommendation-commercial-fit.v3'
             AND inventory.contact_decision='eligible'
             AND inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'
             AND inventory.verified_public_email_count>=1
             AND inventory.status IN ('ready','shown','accepted')
             AND inventory.visible_pool_generation=
               policy.visible_pool_generation
         )::integer published_count
    FROM backlink_commercial_inventory_policies policy
    LEFT JOIN backlink_recommendation_inventory inventory
      ON (
        inventory.organization_id,
        inventory.workspace_id,
        inventory.website_project_id,
        inventory.recommendation_context_version_id
      )=(
        policy.organization_id,
        policy.workspace_id,
        policy.website_project_id,
        policy.project_context_version_id
      )
   GROUP BY policy.organization_id,
            policy.workspace_id,
            policy.website_project_id,
            policy.project_context_version_id
)
UPDATE backlink_commercial_inventory_policies policy
   SET visible_pool_state=CASE
         WHEN published.published_count>=10 THEN 'active'
         WHEN policy.refill_state IN ('running','waiting_contact')
           THEN 'building'
         ELSE 'idle'
       END
  FROM published
 WHERE (
   policy.organization_id,
   policy.workspace_id,
   policy.website_project_id,
   policy.project_context_version_id
 )=(
   published.organization_id,
   published.workspace_id,
   published.website_project_id,
   published.project_context_version_id
 );

ALTER TABLE backlink_commercial_inventory_policies
  FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_recommendation_refills
  FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_outbox_events
  FORCE ROW LEVEL SECURITY;

COMMIT;
