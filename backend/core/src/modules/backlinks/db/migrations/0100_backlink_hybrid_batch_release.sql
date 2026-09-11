BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_recommendation_release_batch_items
  ADD COLUMN resource_library_snapshot jsonb,
  ADD CONSTRAINT backlink_release_item_library_snapshot_ck CHECK (
    resource_library_snapshot IS NULL
    OR jsonb_typeof(resource_library_snapshot) = 'object'
  );

-- Historical unlock facts remain valid and immutable.
ALTER TABLE backlink_recommendation_user_unlocks
  DROP CONSTRAINT backlink_user_unlock_values_ck,
  ADD CONSTRAINT backlink_user_unlock_values_ck CHECK (
    visible_pool_generation > 0
    AND length(btrim(user_id)) > 0
    AND original_batch_size > 0
    AND successful_opportunity_count BETWEEN 0 AND original_batch_size
    AND (
      (reason = 'NO_GATE' AND required_opportunity_count = 0)
      OR (reason IN ('OPPORTUNITY_RATIO', 'ELAPSED_18H')
          AND required_opportunity_count = (original_batch_size + 3) / 4)
    )
    AND evaluated_at = unlocked_at
  );

CREATE OR REPLACE FUNCTION backlink_recommendation_batch_unlock_status(
  p_organization_id text,
  p_workspace_id text,
  p_website_project_id text,
  p_user_id text,
  p_batch_id text
)
RETURNS TABLE (
  original_batch_size integer,
  required_opportunity_count integer,
  successful_opportunity_count integer,
  unlock_by_ratio boolean,
  unlock_by_elapsed boolean,
  eligible boolean,
  reason text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT batch.original_batch_size, 0,
         count(DISTINCT action.batch_item_id) FILTER (
           WHERE action.action_type = 'OPPORTUNITY_CREATED'
         )::integer,
         false, false, true, 'NO_GATE'::text
    FROM backlink_recommendation_user_publications publication
    JOIN backlink_recommendation_release_batches batch
      ON (batch.organization_id,batch.workspace_id,batch.website_project_id,batch.id)
       = (publication.organization_id,publication.workspace_id,
          publication.website_project_id,publication.batch_id)
    LEFT JOIN backlink_recommendation_user_item_actions action
      ON (action.organization_id,action.workspace_id,action.website_project_id,
          action.user_id,action.batch_id)
       = (publication.organization_id,publication.workspace_id,
          publication.website_project_id,publication.user_id,publication.batch_id)
   WHERE publication.organization_id = p_organization_id::uuid
     AND publication.workspace_id = p_workspace_id::uuid
     AND publication.website_project_id = p_website_project_id::uuid
     AND publication.user_id = p_user_id
     AND publication.batch_id = p_batch_id::uuid
     AND publication.publication_state = 'ACTIVE'
   GROUP BY batch.original_batch_size;
$function$;

COMMIT;
