BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE OR REPLACE FUNCTION backlink_validate_pool_project_contract()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  generation_completed_at timestamptz;
  allowed_transition boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Backlinks recommendation pool project contracts cannot be deleted.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    allowed_transition := (
      (OLD.migration_state = 'V1_ACTIVE'
        AND NEW.migration_state IN (
          'V2_READY', 'V2_ACTIVE', 'MIGRATION_BLOCKED'
        ))
      OR (OLD.migration_state = 'V2_READY'
        AND NEW.migration_state IN ('V2_ACTIVE', 'MIGRATION_BLOCKED'))
      OR (OLD.migration_state = 'MIGRATION_BLOCKED'
        AND NEW.migration_state IN ('V2_READY', 'V2_ACTIVE'))
      OR (OLD.migration_state = 'V2_ACTIVE'
        AND NEW.migration_state = 'V2_ACTIVE'
        AND NEW.visible_pool_generation > OLD.visible_pool_generation
        AND NEW.generation_contract_id <> OLD.generation_contract_id)
      OR (OLD.migration_state = 'V2_ACTIVE'
        AND NEW.migration_state = 'V2_MAINTENANCE_READ_ONLY')
      OR (OLD.migration_state = 'V2_MAINTENANCE_READ_ONLY'
        AND NEW.migration_state = 'V2_ACTIVE')
    );

    IF NOT allowed_transition
       OR OLD.id <> NEW.id
       OR OLD.organization_id <> NEW.organization_id
       OR OLD.workspace_id <> NEW.workspace_id
       OR OLD.website_project_id <> NEW.website_project_id
       OR OLD.created_at <> NEW.created_at
       OR OLD.created_by <> NEW.created_by
       OR NEW.version <> OLD.version + 1
       OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION
        'Invalid recommendation pool project contract transition.';
    END IF;
  END IF;

  IF NEW.migration_state IN ('V2_ACTIVE', 'V2_MAINTENANCE_READ_ONLY') THEN
    SELECT discovery_completed_at
      INTO generation_completed_at
      FROM backlink_recommendation_generation_contracts
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND id = NEW.generation_contract_id
       AND recommendation_context_version_id =
         NEW.recommendation_context_version_id
       AND visible_pool_generation = NEW.visible_pool_generation
       AND input_pin_id = NEW.input_pin_id
       AND pool_contract_version = 'recommendation-pool.v2';

    IF NOT FOUND OR generation_completed_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'An active V2 project requires a completed V2 generation.';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION
  backlink_recommendation_pool_v2_generation_rotation_verify()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT jsonb_build_object(
    'activeGenerationRotationAllowed',
      strpos(
        pg_get_functiondef(
          'backlinks.backlink_validate_pool_project_contract()'::regprocedure
        ),
        $verify$OR (OLD.migration_state = 'V2_ACTIVE'
        AND NEW.migration_state = 'V2_ACTIVE'
        AND NEW.visible_pool_generation > OLD.visible_pool_generation
        AND NEW.generation_contract_id <> OLD.generation_contract_id)$verify$
      ) > 0,
    'v1WritesFrozen',
      backlink_phase9_v1_writes_are_frozen()
  );
$function$;

REVOKE ALL
  ON FUNCTION
    backlink_recommendation_pool_v2_generation_rotation_verify()
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION
    backlink_recommendation_pool_v2_generation_rotation_verify()
  TO growthos_backlinks_writer, growthos_reporting_reader;

COMMIT;
