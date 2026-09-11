BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_contact_enrichment_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_enrichment_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_inventory FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backlink_contact_recovery_job_read_policy
  ON backlink_contact_enrichment_jobs;
CREATE POLICY backlink_contact_recovery_job_read_policy
  ON backlink_contact_enrichment_jobs
  FOR SELECT TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_contact_recovery_inventory_read_policy
  ON backlink_recommendation_inventory;
CREATE POLICY backlink_contact_recovery_inventory_read_policy
  ON backlink_recommendation_inventory
  FOR SELECT TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_contact_recovery_recommendation_read_policy
  ON backlink_recommendations;
CREATE POLICY backlink_contact_recovery_recommendation_read_policy
  ON backlink_recommendations
  FOR SELECT TO growthos_backlinks_owner
  USING (true);

CREATE OR REPLACE FUNCTION backlink_list_contact_enrichment_recovery_scopes(
  p_limit integer
)
RETURNS TABLE (
  organization_id uuid,
  workspace_id uuid,
  website_project_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF p_limit < 1 THEN
    RAISE EXCEPTION 'Invalid contact-enrichment recovery scope limit'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH latest_context AS (
    SELECT DISTINCT ON (
      context.organization_id,
      context.workspace_id,
      context.website_project_id
    )
      context.organization_id,
      context.workspace_id,
      context.website_project_id,
      context.id,
      context.project_status
    FROM backlink_project_context_snapshots AS context
    ORDER BY
      context.organization_id,
      context.workspace_id,
      context.website_project_id,
      context.snapshot_version DESC,
      context.created_at DESC,
      context.id DESC
  ),
  missing_jobs AS (
    SELECT DISTINCT
      inventory.organization_id,
      inventory.workspace_id,
      inventory.website_project_id
    FROM backlink_recommendation_inventory AS inventory
    JOIN backlink_recommendations AS recommendation
      ON (
        recommendation.organization_id,
        recommendation.workspace_id,
        recommendation.website_project_id,
        recommendation.id,
        recommendation.prospect_id,
        recommendation.recommendation_context_version_id
      ) = (
        inventory.organization_id,
        inventory.workspace_id,
        inventory.website_project_id,
        inventory.recommendation_id,
        inventory.prospect_id,
        inventory.recommendation_context_version_id
      )
    JOIN latest_context AS context
      ON (
        context.organization_id,
        context.workspace_id,
        context.website_project_id,
        context.id
      ) = (
        recommendation.organization_id,
        recommendation.workspace_id,
        recommendation.website_project_id,
        recommendation.recommendation_context_version_id
      )
    WHERE context.project_status = 'ACTIVE'
      AND inventory.status IN ('ready', 'shown', 'accepted')
      AND NOT EXISTS (
        SELECT 1
        FROM backlink_contact_enrichment_jobs AS job
        WHERE (
          job.organization_id,
          job.workspace_id,
          job.website_project_id,
          job.recommendation_id,
          job.recommendation_context_version_id
        ) = (
          recommendation.organization_id,
          recommendation.workspace_id,
          recommendation.website_project_id,
          recommendation.id,
          recommendation.recommendation_context_version_id
        )
      )
  ),
  recoverable_jobs AS (
    SELECT DISTINCT
      job.organization_id,
      job.workspace_id,
      job.website_project_id
    FROM backlink_contact_enrichment_jobs AS job
    LEFT JOIN latest_context AS context
      ON (
        context.organization_id,
        context.workspace_id,
        context.website_project_id
      ) = (
        job.organization_id,
        job.workspace_id,
        job.website_project_id
      )
    WHERE job.status IN ('pending', 'running', 'retry_scheduled')
      AND (
        (
          job.status = 'running'
          AND job.updated_at < now() - interval '10 minutes'
        )
        OR (
          job.status = 'retry_scheduled'
          AND (job.retry_after IS NULL OR job.retry_after <= now())
        )
        OR (
          job.recommendation_context_version_id
            IS DISTINCT FROM context.id
        )
        OR (
          job.status IN ('pending', 'retry_scheduled')
          AND job.updated_at < now() - interval '10 minutes'
          AND EXISTS (
            SELECT 1
            FROM backlink_outbox_events AS event
            WHERE (
              event.organization_id,
              event.workspace_id,
              event.website_project_id,
              event.aggregate_id,
              event.aggregate_version
            ) = (
              job.organization_id,
              job.workspace_id,
              job.website_project_id,
              job.id,
              job.version
            )
              AND event.event_type =
                'backlinks.contact-enrichment.requested.v1'
              AND event.status = 'published'
          )
        )
      )
  ),
  freeze_state AS (
    SELECT COALESCE(
      (
        backlink_recommendation_pool_v2_native_generation_verify()
          ->>'v1WritesFrozen'
      )::boolean,
      false
    ) AS v1_writes_frozen
  ),
  v2_canonical_work AS (
    SELECT DISTINCT
      contract.organization_id,
      contract.workspace_id,
      contract.website_project_id
    FROM backlink_recommendation_pool_project_contracts AS contract
    CROSS JOIN freeze_state
    JOIN latest_context AS context
      ON context.organization_id = contract.organization_id
     AND context.workspace_id = contract.workspace_id
     AND context.website_project_id = contract.website_project_id
    WHERE contract.pool_contract_version = 'recommendation-pool.v2'
      AND (
        contract.migration_state IN ('V2_READY', 'V2_ACTIVE')
        OR (
          contract.migration_state = 'MIGRATION_BLOCKED'
          AND contract.state_reason_codes =
            '["V2_CANDIDATE_LINEAGE_INCOMPLETE"]'::jsonb
          AND freeze_state.v1_writes_frozen
        )
      )
      AND EXISTS (
        SELECT 1
        FROM backlink_recommendation_release_batches AS batch
        JOIN backlink_recommendation_generation_contracts AS generation
          ON generation.organization_id = batch.organization_id
         AND generation.workspace_id = batch.workspace_id
         AND generation.website_project_id = batch.website_project_id
         AND generation.id = batch.generation_contract_id
         AND generation.recommendation_context_version_id =
           batch.recommendation_context_version_id
         AND generation.visible_pool_generation =
           batch.visible_pool_generation
         AND generation.input_pin_id = batch.input_pin_id
        WHERE batch.organization_id = contract.organization_id
          AND batch.workspace_id = contract.workspace_id
          AND batch.website_project_id = contract.website_project_id
          AND (
            batch.state = 'PREPARING'
            OR (
              batch.state = 'AVAILABLE'
              AND (
                generation.visible_pool_generation >
                  contract.visible_pool_generation
                OR (
                  generation.id = contract.generation_contract_id
                  AND EXISTS (
                    SELECT 1
                    FROM backlink_jobs AS job
                    WHERE job.organization_id = generation.organization_id
                      AND job.workspace_id = generation.workspace_id
                      AND job.website_project_id =
                        generation.website_project_id
                      AND job.job_type =
                        'recommendation_pool_v2_generation'
                      AND job.source_object_type =
                        'project-context-snapshot'
                      AND job.source_object_id =
                        generation.recommendation_context_version_id
                      AND job.result_summary->>'generationContractId' =
                        generation.id::text
                      AND job.status = 'success'
                      AND job.step = 'published'
                      AND (
                        job.error IS NOT NULL
                        OR job.result_summary ? 'failureCode'
                        OR job.result_summary->>'outcome' = 'FAILED'
                        OR job.result_summary->>'final' = 'false'
                      )
                  )
                )
              )
            )
          )
          AND batch.batch_ordinal <= 2
          AND generation.pool_contract_version = 'recommendation-pool.v2'
          AND generation.recommendation_context_version_id = context.id
      )
  )
  SELECT scope.organization_id,
         scope.workspace_id,
         scope.website_project_id
  FROM (
    SELECT * FROM missing_jobs
    UNION
    SELECT * FROM recoverable_jobs
    UNION
    SELECT * FROM v2_canonical_work
  ) AS scope
  ORDER BY
    scope.organization_id,
    scope.workspace_id,
    scope.website_project_id
  LIMIT LEAST(p_limit, 100);
END;
$function$;

ALTER FUNCTION backlink_list_contact_enrichment_recovery_scopes(integer)
  OWNER TO growthos_backlinks_owner;

REVOKE ALL
  ON FUNCTION backlink_list_contact_enrichment_recovery_scopes(integer)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION backlink_list_contact_enrichment_recovery_scopes(integer)
  TO growthos_backlinks_writer;

COMMIT;
