BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_reply_match_candidates
  ADD CONSTRAINT backlink_reply_match_candidate_scoped_assignment_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    inbound_message_id, opportunity_id
  );

ALTER TABLE backlink_placement_candidates
  ADD COLUMN reply_id uuid,
  ADD COLUMN planned_placement_id uuid,
  ADD CONSTRAINT backlink_placement_candidate_reply_shape_ck CHECK (
    reply_id IS NULL
    OR (
      source_type = 'manual'
      AND opportunity_id IS NOT NULL
      AND planned_placement_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT backlink_placement_candidate_full_lineage_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    opportunity_id, reply_id, planned_placement_id
  ),
  ADD CONSTRAINT backlink_placement_candidate_reply_assignment_fk
    FOREIGN KEY (
      organization_id, workspace_id, website_project_id,
      reply_id, opportunity_id
    ) REFERENCES backlink_reply_match_candidates (
      organization_id, workspace_id, website_project_id,
      inbound_message_id, opportunity_id
    ) ON DELETE RESTRICT;

UPDATE backlink_placement_candidates
SET planned_placement_id = id
WHERE planned_placement_id IS NULL;

ALTER TABLE backlink_placement_candidates
  ALTER COLUMN planned_placement_id SET NOT NULL;

CREATE UNIQUE INDEX backlink_placement_candidate_planned_placement_uq
  ON backlink_placement_candidates (
    organization_id, workspace_id, website_project_id, planned_placement_id
  )
  WHERE planned_placement_id IS NOT NULL;

CREATE FUNCTION backlink_guard_placement_candidate_reply_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.opportunity_id,
    NEW.reply_id,
    NEW.planned_placement_id,
    NEW.source_type
  ) IS DISTINCT FROM ROW(
    OLD.opportunity_id,
    OLD.reply_id,
    OLD.planned_placement_id,
    OLD.source_type
  ) THEN
    RAISE EXCEPTION 'Placement Candidate lineage is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.reply_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM backlink_inbound_messages inbound
    JOIN backlink_reply_match_candidates assignment
      ON (
        assignment.organization_id,
        assignment.workspace_id,
        assignment.website_project_id,
        assignment.inbound_message_id,
        assignment.opportunity_id
      ) = (
        inbound.organization_id,
        inbound.workspace_id,
        inbound.website_project_id,
        inbound.id,
        NEW.opportunity_id
      )
    WHERE (
      inbound.organization_id,
      inbound.workspace_id,
      inbound.website_project_id,
      inbound.id
    ) = (
      NEW.organization_id,
      NEW.workspace_id,
      NEW.website_project_id,
      NEW.reply_id
    )
      AND inbound.match_status = 'MATCH_CONFIRMED'
      AND assignment.requires_manual_confirmation = false
  ) THEN
    RAISE EXCEPTION 'Placement Candidate Reply lineage is not confirmed'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_placement_candidate_reply_lineage_guard
BEFORE INSERT OR UPDATE OF
  opportunity_id, reply_id, planned_placement_id, source_type
ON backlink_placement_candidates
FOR EACH ROW
EXECUTE FUNCTION backlink_guard_placement_candidate_reply_lineage();

ALTER TABLE backlink_placements
  ADD COLUMN reply_id uuid,
  ADD CONSTRAINT backlink_placement_full_lineage_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, candidate_id,
    opportunity_id, reply_id, id
  ) REFERENCES backlink_placement_candidates (
    organization_id, workspace_id, website_project_id, id,
    opportunity_id, reply_id, planned_placement_id
  ) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION backlink_guard_placement_initial_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF ROW(
    NEW.candidate_id,
    NEW.opportunity_id,
    NEW.reply_id,
    NEW.initial_validation_id,
    NEW.initial_validation_status,
    NEW.source_page_url,
    NEW.normalized_source_url,
    NEW.normalized_source_url_hash,
    NEW.target_url,
    NEW.normalized_target_url,
    NEW.normalized_target_url_hash,
    NEW.url_normalization_version,
    NEW.initial_evidence_snapshot_hash,
    NEW.evidence_contract_version,
    NEW.initial_evidence_schema_version
  ) IS DISTINCT FROM ROW(
    OLD.candidate_id,
    OLD.opportunity_id,
    OLD.reply_id,
    OLD.initial_validation_id,
    OLD.initial_validation_status,
    OLD.source_page_url,
    OLD.normalized_source_url,
    OLD.normalized_source_url_hash,
    OLD.target_url,
    OLD.normalized_target_url,
    OLD.normalized_target_url_hash,
    OLD.url_normalization_version,
    OLD.initial_evidence_snapshot_hash,
    OLD.evidence_contract_version,
    OLD.initial_evidence_schema_version
  ) THEN
    RAISE EXCEPTION 'Placement initial validation evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL
  ON FUNCTION backlink_guard_placement_candidate_reply_lineage()
  FROM PUBLIC;

COMMIT;
