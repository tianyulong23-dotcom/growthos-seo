BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE OR REPLACE FUNCTION backlink_phase9_job_is_v1(
  p_record jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_workspace_id uuid;
  v_website_project_id uuid;
  v_source_object_id uuid;
BEGIN
  IF p_record IS NULL
     OR NULLIF(btrim(p_record->>'job_type'), '') IS NULL
     OR NULLIF(btrim(p_record->>'source_object_type'), '') IS NULL
     OR p_record->>'organization_id' IS NULL
     OR p_record->>'workspace_id' IS NULL
     OR p_record->>'website_project_id' IS NULL
     OR p_record->>'source_object_id' IS NULL THEN
    RETURN true;
  END IF;

  v_organization_id := (p_record->>'organization_id')::uuid;
  v_workspace_id := (p_record->>'workspace_id')::uuid;
  v_website_project_id := (p_record->>'website_project_id')::uuid;
  v_source_object_id := (p_record->>'source_object_id')::uuid;

  IF p_record->>'job_type' = 'recommendation_pool_v2_generation'
     AND p_record->>'source_object_type' = 'project-context-snapshot'
     AND jsonb_typeof(p_record->'result_summary') = 'object'
     AND p_record->'result_summary'->>'poolContractVersion' =
           'recommendation-pool.v2'
     AND p_record->'result_summary'->>'generationContractId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (
       SELECT 1
         FROM backlink_recommendation_generation_contracts AS generation
        WHERE generation.organization_id = v_organization_id
          AND generation.workspace_id = v_workspace_id
          AND generation.website_project_id = v_website_project_id
          AND generation.id = (
                p_record->'result_summary'->>'generationContractId'
              )::uuid
          AND generation.recommendation_context_version_id =
                v_source_object_id
          AND generation.pool_contract_version =
                'recommendation-pool.v2'
     ) THEN
    RETURN false;
  END IF;

  IF p_record->>'job_type' = 'recommendation_refill'
     OR p_record->>'source_object_type' IN (
       'recommendation_context',
       'recommendation',
       'recommendation_inventory',
       'recommendation_refill'
     ) THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_recommendation_generation_contracts AS generation
     WHERE generation.organization_id = v_organization_id
       AND generation.workspace_id = v_workspace_id
       AND generation.website_project_id = v_website_project_id
       AND generation.pool_contract_version = 'recommendation-pool.v1'
       AND generation.recommendation_context_version_id = v_source_object_id
    UNION ALL
    SELECT 1
      FROM backlink_recommendations AS recommendation
     WHERE recommendation.organization_id = v_organization_id
       AND recommendation.workspace_id = v_workspace_id
       AND recommendation.website_project_id = v_website_project_id
       AND recommendation.id = v_source_object_id
       AND backlink_phase9_recommendation_is_v1(
             to_jsonb(recommendation)
           )
    UNION ALL
    SELECT 1
      FROM backlink_recommendation_inventory AS inventory
     WHERE inventory.organization_id = v_organization_id
       AND inventory.workspace_id = v_workspace_id
       AND inventory.website_project_id = v_website_project_id
       AND inventory.id = v_source_object_id
       AND backlink_phase9_inventory_is_v1(to_jsonb(inventory))
    UNION ALL
    SELECT 1
      FROM backlink_recommendation_refills AS refill
     WHERE refill.organization_id = v_organization_id
       AND refill.workspace_id = v_workspace_id
       AND refill.website_project_id = v_website_project_id
       AND refill.id = v_source_object_id
  ) THEN
    RETURN true;
  END IF;

  RETURN NOT (
    (
      p_record->>'job_type' = 'project-analysis'
      AND p_record->>'source_object_type' = 'project-context-snapshot'
      AND EXISTS (
        SELECT 1
          FROM backlink_project_context_snapshots AS snapshot
         WHERE snapshot.organization_id = v_organization_id
           AND snapshot.workspace_id = v_workspace_id
           AND snapshot.website_project_id = v_website_project_id
           AND snapshot.id = v_source_object_id
      )
    )
    OR (
      p_record->>'job_type' = 'backlink_profile_sync'
      AND p_record->>'source_object_type' = 'website_project'
      AND v_source_object_id = v_website_project_id
    )
    OR (
      p_record->>'job_type' = 'backlink_inventory_monitor'
      AND p_record->>'source_object_type' = 'backlink_inventory_item'
      AND EXISTS (
        SELECT 1
          FROM backlink_inventory_items AS inventory_item
         WHERE inventory_item.organization_id = v_organization_id
           AND inventory_item.workspace_id = v_workspace_id
           AND inventory_item.website_project_id = v_website_project_id
           AND inventory_item.id = v_source_object_id
      )
    )
  );
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION
  backlink_recommendation_pool_v2_generation_compatibility_verify()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH source AS (
    SELECT pg_get_functiondef(
      'backlinks.backlink_phase9_job_is_v1(jsonb)'::regprocedure
    ) AS definition
  )
  SELECT jsonb_build_object(
    'v2GenerationPrecedesLegacyClassification',
      position(
        'recommendation_pool_v2_generation'
        IN definition
      ) > 0
      AND position(
        'recommendation_pool_v2_generation'
        IN definition
      ) < position(
        'recommendation-pool.v1'
        IN definition
      ),
    'v1WritesFrozen',
      backlink_phase9_v1_writes_are_frozen()
  )
  FROM source;
$function$;

REVOKE ALL
  ON FUNCTION
    backlink_recommendation_pool_v2_generation_compatibility_verify()
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION
    backlink_recommendation_pool_v2_generation_compatibility_verify()
  TO growthos_backlinks_writer, growthos_reporting_reader;

COMMIT;
