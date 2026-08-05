BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_draft_versions
  ADD COLUMN body_document jsonb;

ALTER TABLE backlink_draft_versions
  ADD CONSTRAINT backlink_draft_version_body_document_check CHECK (
    body_document IS NULL
    OR (
      jsonb_typeof(body_document) = 'object'
      AND body_document ->> 'type' = 'doc'
      AND jsonb_typeof(body_document -> 'content') = 'array'
    )
  );

COMMIT;
