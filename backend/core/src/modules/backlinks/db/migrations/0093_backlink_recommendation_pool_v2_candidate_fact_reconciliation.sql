BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

LOCK TABLE
  backlink_recommendation_pool_project_contracts,
  backlink_recommendation_generation_contracts,
  backlink_generation_input_pins
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE backlink_recommendation_pool_project_contracts
  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_generation_contracts
  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_generation_input_pins
  NO FORCE ROW LEVEL SECURITY;

UPDATE backlink_recommendation_pool_project_contracts AS contract
   SET migration_state = 'MIGRATION_BLOCKED',
       state_reason_codes =
         CASE
           WHEN contract.state_reason_codes ? 'V2_CANDIDATE_LINEAGE_INCOMPLETE'
             THEN contract.state_reason_codes
           ELSE contract.state_reason_codes ||
             '["V2_CANDIDATE_LINEAGE_INCOMPLETE"]'::jsonb
         END,
       activated_at = NULL,
       updated_at = statement_timestamp(),
       updated_by = 'backlinks-0093',
       version = contract.version + 1
  FROM backlink_recommendation_generation_contracts AS generation
  JOIN backlink_generation_input_pins AS pin
    ON pin.organization_id = generation.organization_id
   AND pin.workspace_id = generation.workspace_id
   AND pin.website_project_id = generation.website_project_id
   AND pin.id = generation.input_pin_id
 WHERE contract.organization_id = generation.organization_id
   AND contract.workspace_id = generation.workspace_id
   AND contract.website_project_id = generation.website_project_id
   AND contract.generation_contract_id = generation.id
   AND contract.migration_state IN ('V2_READY', 'V2_ACTIVE')
   AND (
     generation.qualification_contract_version <>
       'recommendation-pool-admission.v2'
     OR generation.visibility_contract_version <>
       'recommendation-pool-release-visibility.v2'
     OR generation.score_model_version <>
       'recommendation-pool-materialization.v2'
     OR generation.creator_worker_contract_version <>
       'recommendation-pool-worker.v2'
     OR pin.qualification_contract_version <>
       'recommendation-pool-admission.v2'
   );

DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM backlink_recommendation_pool_project_contracts AS contract
      JOIN backlink_recommendation_generation_contracts AS generation
        ON generation.organization_id = contract.organization_id
       AND generation.workspace_id = contract.workspace_id
       AND generation.website_project_id = contract.website_project_id
       AND generation.id = contract.generation_contract_id
      JOIN backlink_generation_input_pins AS pin
        ON pin.organization_id = generation.organization_id
       AND pin.workspace_id = generation.workspace_id
       AND pin.website_project_id = generation.website_project_id
       AND pin.id = generation.input_pin_id
     WHERE contract.migration_state IN ('V2_READY', 'V2_ACTIVE')
       AND (
         generation.qualification_contract_version <>
           'recommendation-pool-admission.v2'
         OR generation.visibility_contract_version <>
           'recommendation-pool-release-visibility.v2'
         OR generation.score_model_version <>
           'recommendation-pool-materialization.v2'
         OR generation.creator_worker_contract_version <>
           'recommendation-pool-worker.v2'
         OR pin.qualification_contract_version <>
           'recommendation-pool-admission.v2'
       )
  ) THEN
    RAISE EXCEPTION
      'Recommendation pool V2 candidate fact reconciliation is incomplete.';
  END IF;
END;
$block$;

ALTER TABLE backlink_recommendation_pool_project_contracts
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_generation_contracts
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_generation_input_pins
  FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION
  backlink_pool_v2_candidate_fact_reconciliation_verify()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT jsonb_build_object(
    'candidateFactReconciliationInstalled', true,
    'projectContractsForceRls',
      EXISTS (
        SELECT 1
          FROM pg_class
         WHERE oid =
               'backlinks.backlink_recommendation_pool_project_contracts'
                 ::regclass
           AND relrowsecurity
           AND relforcerowsecurity
      ),
    'generationContractsForceRls',
      EXISTS (
        SELECT 1
          FROM pg_class
         WHERE oid =
               'backlinks.backlink_recommendation_generation_contracts'
                 ::regclass
           AND relrowsecurity
           AND relforcerowsecurity
      ),
    'inputPinsForceRls',
      EXISTS (
        SELECT 1
          FROM pg_class
         WHERE oid =
               'backlinks.backlink_generation_input_pins'::regclass
           AND relrowsecurity
           AND relforcerowsecurity
      ),
    'v1WritesFrozen',
      backlink_phase9_v1_writes_are_frozen()
  );
$function$;

DO $block$
DECLARE
  verification jsonb;
BEGIN
  verification :=
    backlink_pool_v2_candidate_fact_reconciliation_verify();

  IF verification->>'candidateFactReconciliationInstalled' <> 'true'
     OR verification->>'projectContractsForceRls' <> 'true'
     OR verification->>'generationContractsForceRls' <> 'true'
     OR verification->>'inputPinsForceRls' <> 'true'
     OR verification->>'v1WritesFrozen' <> 'true' THEN
    RAISE EXCEPTION
      'Recommendation pool V2 candidate fact reconciliation failed: %',
      verification;
  END IF;
END;
$block$;

REVOKE ALL
  ON FUNCTION
    backlink_pool_v2_candidate_fact_reconciliation_verify()
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION
    backlink_pool_v2_candidate_fact_reconciliation_verify()
  TO growthos_backlinks_writer, growthos_reporting_reader;

COMMIT;
