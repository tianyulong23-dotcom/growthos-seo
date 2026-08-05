BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_opportunities
  ADD COLUMN source_contact_candidate_id uuid,
  ADD COLUMN contact_review_required boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT backlink_opportunity_contact_gate_check CHECK (
    source_contact_candidate_id IS NOT NULL OR contact_review_required
  ),
  ADD CONSTRAINT backlink_opportunity_source_contact_candidate_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id,
      source_contact_candidate_id
    ) REFERENCES backlink_contact_candidates (
      organization_id, workspace_id, website_project_id, id
    );

CREATE INDEX backlink_opportunity_source_contact_candidate_idx
  ON backlink_opportunities (
    organization_id, workspace_id, website_project_id,
    source_contact_candidate_id
  )
  WHERE source_contact_candidate_id IS NOT NULL;

COMMIT;
