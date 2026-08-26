BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_commercial_candidates
  DROP CONSTRAINT backlink_commercial_candidate_state_check;

ALTER TABLE backlink_commercial_candidates
  ADD CONSTRAINT backlink_commercial_candidate_state_check CHECK (
    state IN (
      'enrichment_eligible',
      'candidate_ready', 'contact_enrichment', 'published',
      'excluded', 'insufficient_data', 'manual_review', 'stale_context'
    )
  );

COMMIT;
