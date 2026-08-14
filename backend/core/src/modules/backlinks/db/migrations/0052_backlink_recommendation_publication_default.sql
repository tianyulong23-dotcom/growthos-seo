BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_recommendation_inventory
  ALTER COLUMN publication_status SET DEFAULT 'CONTACT_PENDING';

COMMIT;
