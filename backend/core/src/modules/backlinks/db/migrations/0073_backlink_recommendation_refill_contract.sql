BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_commercial_inventory_policies
  NO FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_recommendation_refills
  NO FORCE ROW LEVEL SECURITY;

UPDATE backlink_commercial_inventory_policies
   SET refill_state=CASE
         WHEN refill_state='waiting_contact' THEN 'idle'
         ELSE refill_state
       END,
       pause_reason=CASE
         WHEN refill_state='waiting_contact' THEN NULL
         ELSE pause_reason
       END,
       current_refill_tier=CASE
         WHEN refill_state='running' THEN current_refill_tier
         ELSE 'curated_resource_library'
       END,
       published_contact_ready_low_watermark=0,
       published_contact_ready_high_watermark=visible_pool_target_count,
       updated_at=now(),
       updated_by='migration:backlinks-0073',
       version=version+1
 WHERE refill_state='waiting_contact'
    OR published_contact_ready_low_watermark<>0
    OR published_contact_ready_high_watermark<>visible_pool_target_count
    OR (
      refill_state<>'running'
      AND current_refill_tier<>'curated_resource_library'
    );

ALTER TABLE backlink_commercial_inventory_policies
  DROP CONSTRAINT backlink_commercial_visible_pool_target_check,
  DROP CONSTRAINT backlink_commercial_refill_state_check,
  ALTER COLUMN current_refill_tier
    SET DEFAULT 'curated_resource_library',
  ALTER COLUMN published_contact_ready_low_watermark SET DEFAULT 0,
  ALTER COLUMN published_contact_ready_high_watermark SET DEFAULT 10,
  ADD CONSTRAINT backlink_commercial_visible_pool_target_check CHECK (
    visible_pool_target_count BETWEEN 1 AND 100
    AND archived_visible_pool_count >= 0
  ),
  ADD CONSTRAINT backlink_commercial_refill_state_check CHECK (
    refill_state IN (
      'idle', 'running', 'completed', 'paused', 'exhausted'
    )
  );

ALTER TABLE backlink_recommendation_refills
  DROP CONSTRAINT backlink_rec_refill_watermark_check,
  ADD CONSTRAINT backlink_rec_refill_watermark_check CHECK (
    low_watermark >= 0
    AND high_watermark > low_watermark
    AND high_watermark <= 100
  );

ALTER TABLE backlink_commercial_inventory_policies
  FORCE ROW LEVEL SECURITY;

ALTER TABLE backlink_recommendation_refills
  FORCE ROW LEVEL SECURITY;

COMMIT;
