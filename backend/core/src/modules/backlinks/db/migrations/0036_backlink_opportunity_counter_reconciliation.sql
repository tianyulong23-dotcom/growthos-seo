BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE OR REPLACE FUNCTION backlink_allocate_opportunity_join_sequence(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_website_project_id uuid,
  p_actor_id text
) RETURNS integer
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  allocated_sequence integer;
BEGIN
  IF length(btrim(p_actor_id)) = 0 THEN
    RAISE EXCEPTION 'Opportunity sequence actor is required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO backlink_opportunity_project_counters (
    organization_id,
    workspace_id,
    website_project_id,
    last_join_sequence,
    created_by,
    updated_by
  )
  SELECT
    p_organization_id,
    p_workspace_id,
    p_website_project_id,
    COALESCE(max(opportunity.join_sequence), 0),
    p_actor_id,
    p_actor_id
  FROM backlink_opportunities AS opportunity
  WHERE opportunity.organization_id = p_organization_id
    AND opportunity.workspace_id = p_workspace_id
    AND opportunity.website_project_id = p_website_project_id
  ON CONFLICT (
    organization_id, workspace_id, website_project_id
  ) DO UPDATE
    SET last_join_sequence = GREATEST(
          backlink_opportunity_project_counters.last_join_sequence,
          EXCLUDED.last_join_sequence
        ),
        version = backlink_opportunity_project_counters.version
          + CASE
              WHEN EXCLUDED.last_join_sequence
                > backlink_opportunity_project_counters.last_join_sequence
              THEN 1
              ELSE 0
            END,
        updated_at = CASE
          WHEN EXCLUDED.last_join_sequence
            > backlink_opportunity_project_counters.last_join_sequence
          THEN now()
          ELSE backlink_opportunity_project_counters.updated_at
        END,
        updated_by = CASE
          WHEN EXCLUDED.last_join_sequence
            > backlink_opportunity_project_counters.last_join_sequence
          THEN p_actor_id
          ELSE backlink_opportunity_project_counters.updated_by
        END;

  SELECT last_join_sequence
    INTO allocated_sequence
    FROM backlink_opportunity_project_counters
    WHERE (
      organization_id, workspace_id, website_project_id
    ) = (
      p_organization_id, p_workspace_id, p_website_project_id
    )
    FOR UPDATE;

  allocated_sequence := allocated_sequence + 1;

  UPDATE backlink_opportunity_project_counters
    SET last_join_sequence = allocated_sequence,
        version = version + 1,
        updated_at = now(),
        updated_by = p_actor_id
    WHERE (
      organization_id, workspace_id, website_project_id
    ) = (
      p_organization_id, p_workspace_id, p_website_project_id
    );

  RETURN allocated_sequence;
END;
$function$;

REVOKE ALL ON FUNCTION backlink_allocate_opportunity_join_sequence(
  uuid, uuid, uuid, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backlink_allocate_opportunity_join_sequence(
  uuid, uuid, uuid, text
) TO growthos_backlinks_writer;

COMMIT;
