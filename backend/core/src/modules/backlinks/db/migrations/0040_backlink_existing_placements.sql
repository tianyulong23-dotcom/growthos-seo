BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_placement_candidates
  DROP CONSTRAINT backlink_placement_candidate_state_check;

ALTER TABLE backlink_placement_candidates
  ADD CONSTRAINT backlink_placement_candidate_state_check CHECK (
    (match_status <> 'AUTO_MATCHED' OR opportunity_id IS NOT NULL)
    AND (
      status NOT IN ('PENDING_VALIDATION', 'PROMOTED')
      OR (
        source_page_url IS NOT NULL
        AND normalized_source_url IS NOT NULL
        AND normalized_source_url_hash IS NOT NULL
        AND (
          (
            opportunity_id IS NOT NULL
            AND match_status = 'AUTO_MATCHED'
          )
          OR (
            opportunity_id IS NULL
            AND source_type IN ('manual', 'import')
            AND match_status = 'UNMATCHED'
          )
        )
      )
    )
    AND (
      status <> 'PROMOTED'
      OR initial_validation_status IN ('VALID', 'MANUALLY_CONFIRMED')
    )
  );

ALTER TABLE backlink_placement_validation_runs
  ALTER COLUMN opportunity_id DROP NOT NULL;

ALTER TABLE backlink_placements
  ALTER COLUMN opportunity_id DROP NOT NULL;

ALTER TABLE backlink_placement_validation_runs
  ADD CONSTRAINT backlink_placement_validation_candidate_identity_fk
  FOREIGN KEY (
    organization_id, workspace_id, website_project_id, candidate_id
  ) REFERENCES backlink_placement_candidates (
    organization_id, workspace_id, website_project_id, id
  );

ALTER TABLE backlink_placement_validation_runs
  ADD CONSTRAINT backlink_placement_validation_initial_identity_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id, candidate_id,
    status, normalized_source_url_hash, normalized_target_url_hash,
    url_normalization_version, evidence_snapshot_hash,
    evidence_contract_version, evidence_schema_version
  );

ALTER TABLE backlink_placements
  ADD CONSTRAINT backlink_placement_candidate_identity_fk
  FOREIGN KEY (
    organization_id, workspace_id, website_project_id, candidate_id
  ) REFERENCES backlink_placement_candidates (
    organization_id, workspace_id, website_project_id, id
  );

ALTER TABLE backlink_placements
  ADD CONSTRAINT backlink_placement_initial_validation_identity_fk
  FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    initial_validation_id, candidate_id, initial_validation_status,
    normalized_source_url_hash, normalized_target_url_hash,
    url_normalization_version, initial_evidence_snapshot_hash,
    evidence_contract_version, initial_evidence_schema_version
  ) REFERENCES backlink_placement_validation_runs (
    organization_id, workspace_id, website_project_id, id, candidate_id,
    status, normalized_source_url_hash, normalized_target_url_hash,
    url_normalization_version, evidence_snapshot_hash,
    evidence_contract_version, evidence_schema_version
  );

COMMIT;
