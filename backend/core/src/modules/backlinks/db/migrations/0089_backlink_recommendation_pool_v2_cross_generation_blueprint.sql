BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_commercial_blueprint_seeds
  DROP CONSTRAINT backlink_blueprint_seed_ordinal_uq,
  ADD CONSTRAINT backlink_blueprint_seed_ordinal_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    blueprint_id, generation_contract_id, seed_ordinal
  );

CREATE OR REPLACE FUNCTION
  backlink_recommendation_pool_v2_cross_generation_blueprint_verify()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT jsonb_build_object(
    'blueprintSeedOrdinalScopedByGeneration',
      EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid =
               'backlinks.backlink_commercial_blueprint_seeds'::regclass
           AND conname = 'backlink_blueprint_seed_ordinal_uq'
           AND pg_get_constraintdef(oid) =
             'UNIQUE (organization_id, workspace_id, website_project_id, ' ||
             'blueprint_id, generation_contract_id, seed_ordinal)'
      ),
    'v1WritesFrozen',
      backlink_phase9_v1_writes_are_frozen()
  );
$function$;

REVOKE ALL
  ON FUNCTION
    backlink_recommendation_pool_v2_cross_generation_blueprint_verify()
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION
    backlink_recommendation_pool_v2_cross_generation_blueprint_verify()
  TO growthos_backlinks_writer, growthos_reporting_reader;

COMMIT;
