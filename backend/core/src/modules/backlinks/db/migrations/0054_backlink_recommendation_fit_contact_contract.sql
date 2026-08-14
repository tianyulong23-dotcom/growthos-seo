BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_commercial_candidates
  DROP CONSTRAINT backlink_commercial_candidate_score_version_check,
  DROP CONSTRAINT backlink_commercial_candidate_context_domain_uq,
  ADD CONSTRAINT backlink_commercial_candidate_score_version_check CHECK (
    score_model_version IN (
      'recommendation-commercial-fit.v2',
      'recommendation-commercial-fit.v3'
    )
  ),
  ADD CONSTRAINT backlink_commercial_candidate_context_domain_model_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    project_context_version_id, canonical_domain, score_model_version
  );

ALTER TABLE backlink_recommendation_inventory
  DROP CONSTRAINT backlink_rec_inventory_publication_gate_check,
  ADD COLUMN fit_decision text NOT NULL DEFAULT 'unassessed',
  ADD COLUMN contact_decision text NOT NULL DEFAULT 'pending',
  ADD COLUMN contact_reason_code text NOT NULL DEFAULT 'CONTACT_PENDING',
  ADD COLUMN fit_score_model_version text;

RESET ROLE;

UPDATE backlink_recommendation_inventory
   SET publication_status = CASE
         WHEN publication_status = 'PUBLISHED' THEN 'CONTACT_REVIEW'
         ELSE publication_status
       END,
       fit_decision = 'unassessed',
       contact_decision = CASE
         WHEN contact_evidence_snapshot_id IS NOT NULL
           THEN 'manual_review'
         ELSE 'pending'
       END,
       contact_reason_code = CASE
         WHEN contact_evidence_snapshot_id IS NOT NULL
           THEN 'FIT_V3_REASSESSMENT_REQUIRED'
         ELSE 'CONTACT_PENDING'
       END,
       fit_score_model_version = NULL,
       updated_at = now();

SET LOCAL ROLE growthos_backlinks_owner;

ALTER TABLE backlink_recommendation_inventory
  ADD CONSTRAINT backlink_rec_inventory_fit_decision_check CHECK (
    fit_decision IN (
      'unassessed', 'eligible', 'ineligible',
      'insufficient_data', 'manual_review'
    )
  ),
  ADD CONSTRAINT backlink_rec_inventory_contact_decision_check CHECK (
    contact_decision IN (
      'pending', 'eligible', 'ineligible', 'manual_review'
    )
  ),
  ADD CONSTRAINT backlink_rec_inventory_contact_reason_check CHECK (
    length(btrim(contact_reason_code)) > 0
  ),
  ADD CONSTRAINT backlink_rec_inventory_fit_version_check CHECK (
    (
      fit_decision = 'unassessed'
      AND fit_score_model_version IS NULL
    )
    OR (
      fit_decision <> 'unassessed'
      AND fit_score_model_version = 'recommendation-commercial-fit.v3'
    )
  ),
  ADD CONSTRAINT backlink_rec_inventory_publication_gate_check CHECK (
    verified_public_email_count >= 0
    AND (
      publication_status <> 'PUBLISHED'
      OR (
        fit_decision = 'eligible'
        AND fit_score_model_version = 'recommendation-commercial-fit.v3'
        AND contact_decision = 'eligible'
        AND contact_reason_code = 'PUBLIC_EMAIL_FOUND'
        AND verified_public_email_count >= 1
        AND contact_evidence_snapshot_id IS NOT NULL
        AND default_contact_candidate_id IS NOT NULL
        AND default_contact_source_url ~ '^https?://'
        AND default_contact_email_sha256 ~ '^[a-f0-9]{64}$'
        AND length(btrim(default_contact_email_reference)) > 0
        AND contact_collected_at IS NOT NULL
        AND length(btrim(contact_rules_version)) > 0
      )
    )
  );

CREATE INDEX backlink_commercial_candidate_model_inventory_idx
  ON backlink_commercial_candidates (
    organization_id, workspace_id, website_project_id,
    project_context_version_id, score_model_version, state, created_at
  );

COMMIT;
