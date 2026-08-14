BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_project_context_snapshots
  ADD COLUMN products jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN target_urls jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE backlink_project_context_snapshots
SET products = jsonb_build_array(
      format('Website project %s', canonical_domain)
    ),
    keywords = jsonb_build_array(canonical_domain),
    target_urls = jsonb_build_array(
      format('https://%s/', canonical_domain)
    );

ALTER TABLE backlink_project_context_snapshots
  ADD CONSTRAINT backlink_project_context_snapshot_products_array_check
    CHECK (jsonb_typeof(products) = 'array'),
  ADD CONSTRAINT backlink_project_context_snapshot_keywords_array_check
    CHECK (jsonb_typeof(keywords) = 'array'),
  ADD CONSTRAINT backlink_project_context_snapshot_target_urls_array_check
    CHECK (jsonb_typeof(target_urls) = 'array');

COMMIT;
