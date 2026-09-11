BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE POLICY backlink_contact_recovery_cursor_read_policy
  ON backlink_recommendation_user_cursors
  FOR SELECT TO growthos_backlinks_owner
  USING (true);

CREATE POLICY backlink_contact_recovery_input_pin_read_policy
  ON backlink_generation_input_pins
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
      context.organization_id, context.workspace_id, context.website_project_id
    )
      context.organization_id, context.workspace_id, context.website_project_id,
      context.id, context.project_status
    FROM backlink_project_context_snapshots AS context
    ORDER BY context.organization_id, context.workspace_id,
      context.website_project_id, context.snapshot_version DESC,
      context.created_at DESC, context.id DESC
  ),
  missing_jobs AS (
    SELECT DISTINCT inventory.organization_id, inventory.workspace_id,
      inventory.website_project_id
    FROM backlink_recommendation_inventory AS inventory
    JOIN backlink_recommendations AS recommendation
      ON (recommendation.organization_id, recommendation.workspace_id,
          recommendation.website_project_id, recommendation.id,
          recommendation.prospect_id, recommendation.recommendation_context_version_id)
       = (inventory.organization_id, inventory.workspace_id,
          inventory.website_project_id, inventory.recommendation_id,
          inventory.prospect_id, inventory.recommendation_context_version_id)
    JOIN latest_context AS context
      ON (context.organization_id, context.workspace_id,
          context.website_project_id, context.id)
       = (recommendation.organization_id, recommendation.workspace_id,
          recommendation.website_project_id,
          recommendation.recommendation_context_version_id)
    WHERE context.project_status = 'ACTIVE'
      AND inventory.status IN ('ready', 'shown', 'accepted')
      AND NOT EXISTS (
        SELECT 1 FROM backlink_recommendation_pool_project_contracts AS contract
        WHERE contract.organization_id = inventory.organization_id
          AND contract.workspace_id = inventory.workspace_id
          AND contract.website_project_id = inventory.website_project_id
          AND contract.pool_contract_version = 'recommendation-pool.v2'
      )
      AND NOT EXISTS (
        SELECT 1 FROM backlink_contact_enrichment_jobs AS job
        WHERE (job.organization_id, job.workspace_id, job.website_project_id,
               job.recommendation_id, job.recommendation_context_version_id)
            = (recommendation.organization_id, recommendation.workspace_id,
               recommendation.website_project_id, recommendation.id,
               recommendation.recommendation_context_version_id)
      )
  ),
  recoverable_jobs AS (
    SELECT DISTINCT job.organization_id, job.workspace_id, job.website_project_id
    FROM backlink_contact_enrichment_jobs AS job
    LEFT JOIN latest_context AS context
      ON (context.organization_id, context.workspace_id, context.website_project_id)
       = (job.organization_id, job.workspace_id, job.website_project_id)
    WHERE job.status IN ('pending', 'running', 'retry_scheduled')
      AND (
        (job.status = 'running' AND job.updated_at < now() - interval '10 minutes')
        OR (job.status = 'retry_scheduled'
            AND (job.retry_after IS NULL OR job.retry_after <= now()))
        OR job.recommendation_context_version_id IS DISTINCT FROM context.id
        OR (
          job.status IN ('pending', 'retry_scheduled')
          AND job.updated_at < now() - interval '10 minutes'
          AND EXISTS (
            SELECT 1 FROM backlink_outbox_events AS event
            WHERE (event.organization_id, event.workspace_id, event.website_project_id,
                   event.aggregate_id, event.aggregate_version)
                = (job.organization_id, job.workspace_id, job.website_project_id,
                   job.id, job.version)
              AND event.event_type = 'backlinks.contact-enrichment.requested.v1'
              AND event.status = 'published'
          )
        )
      )
  ),
  freeze_state AS (
    SELECT COALESCE((
      backlink_recommendation_pool_v2_native_generation_verify()->>'v1WritesFrozen'
    )::boolean, false) AS v1_writes_frozen
  ),
  v2_canonical_work AS (
    SELECT DISTINCT contract.organization_id, contract.workspace_id,
      contract.website_project_id
    FROM backlink_recommendation_pool_project_contracts AS contract
    CROSS JOIN freeze_state
    JOIN latest_context AS context
      ON context.organization_id = contract.organization_id
     AND context.workspace_id = contract.workspace_id
     AND context.website_project_id = contract.website_project_id
    WHERE context.project_status = 'ACTIVE'
      AND contract.pool_contract_version = 'recommendation-pool.v2'
      AND (
        contract.migration_state IN ('V2_READY', 'V2_ACTIVE')
        OR (
          contract.migration_state = 'MIGRATION_BLOCKED'
          AND contract.state_reason_codes = '["V2_CANDIDATE_LINEAGE_INCOMPLETE"]'::jsonb
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
         AND generation.visible_pool_generation = batch.visible_pool_generation
         AND generation.input_pin_id = batch.input_pin_id
        JOIN backlink_generation_input_pins AS pin
          ON pin.organization_id = generation.organization_id
         AND pin.workspace_id = generation.workspace_id
         AND pin.website_project_id = generation.website_project_id
         AND pin.id = generation.input_pin_id
        CROSS JOIN LATERAL (
          SELECT GREATEST(1, COALESCE(max(cursor.highest_published_batch_ordinal), 1))
            AS current_ordinal
          FROM backlink_recommendation_user_cursors AS cursor
          WHERE cursor.organization_id = generation.organization_id
            AND cursor.workspace_id = generation.workspace_id
            AND cursor.website_project_id = generation.website_project_id
            AND cursor.recommendation_context_version_id =
                generation.recommendation_context_version_id
            AND cursor.visible_pool_generation = generation.visible_pool_generation
        ) AS preparation
        WHERE batch.organization_id = contract.organization_id
          AND batch.workspace_id = contract.workspace_id
          AND batch.website_project_id = contract.website_project_id
          AND batch.batch_ordinal BETWEEN preparation.current_ordinal
              AND preparation.current_ordinal + 1
          AND generation.pool_contract_version = 'recommendation-pool.v2'
          AND generation.qualification_contract_version = 'recommendation-pool-admission.v2'
          AND generation.visibility_contract_version = 'recommendation-pool-release-visibility.v2'
          AND generation.score_model_version = 'recommendation-pool-materialization.v2'
          AND generation.creator_worker_contract_version = 'recommendation-pool-worker.v2'
          AND pin.qualification_contract_version = 'recommendation-pool-admission.v2'
          AND generation.recommendation_context_version_id = context.id
          AND NOT EXISTS (
            SELECT 1 FROM backlink_recommendation_release_batch_items AS item
            WHERE item.organization_id = generation.organization_id
              AND item.workspace_id = generation.workspace_id
              AND item.website_project_id = generation.website_project_id
              AND item.generation_contract_id = generation.id
              AND (item.legacy_imported OR item.generation_candidate_id IS NULL)
          )
          AND (
            batch.state = 'PREPARING'
            OR (
              batch.state = 'AVAILABLE'
              AND (
                generation.visible_pool_generation > contract.visible_pool_generation
                OR (
                  generation.id = contract.generation_contract_id
                  AND EXISTS (
                    SELECT 1 FROM backlink_jobs AS job
                    WHERE job.organization_id = generation.organization_id
                      AND job.workspace_id = generation.workspace_id
                      AND job.website_project_id = generation.website_project_id
                      AND job.job_type = 'recommendation_pool_v2_generation'
                      AND job.source_object_type = 'project-context-snapshot'
                      AND job.source_object_id = generation.recommendation_context_version_id
                      AND job.result_summary->>'generationContractId' = generation.id::text
                      AND job.status = 'success' AND job.step = 'published'
                      AND (job.error IS NOT NULL OR job.result_summary ? 'failureCode'
                           OR job.result_summary->>'outcome' = 'FAILED'
                           OR job.result_summary->>'final' = 'false')
                  )
                )
                OR EXISTS (
                  SELECT 1 FROM backlink_recommendation_release_batch_items AS item
                  JOIN backlink_contact_enrichment_jobs AS contact_job
                    ON contact_job.organization_id = item.organization_id
                   AND contact_job.workspace_id = item.workspace_id
                   AND contact_job.website_project_id = item.website_project_id
                   AND contact_job.recommendation_id = item.recommendation_id
                   AND contact_job.prospect_id = item.prospect_id
                   AND contact_job.recommendation_context_version_id =
                       item.recommendation_context_version_id
                  JOIN backlink_contact_candidates AS candidate
                    ON candidate.organization_id = item.organization_id
                   AND candidate.workspace_id = item.workspace_id
                   AND candidate.website_project_id = item.website_project_id
                   AND candidate.prospect_id = item.prospect_id
                   AND candidate.recommendation_context_version_id =
                       item.recommendation_context_version_id
                  JOIN backlink_contact_evidence AS evidence
                    ON evidence.organization_id = candidate.organization_id
                   AND evidence.workspace_id = candidate.workspace_id
                   AND evidence.website_project_id = candidate.website_project_id
                   AND evidence.candidate_id = candidate.id
                  WHERE item.organization_id = batch.organization_id
                    AND item.workspace_id = batch.workspace_id
                    AND item.website_project_id = batch.website_project_id
                    AND item.batch_id = batch.id
                    AND item.generation_contract_id = generation.id
                    AND item.recommendation_context_version_id = generation.recommendation_context_version_id
                    AND item.visible_pool_generation = generation.visible_pool_generation
                    AND item.input_pin_id = generation.input_pin_id
                    AND item.legacy_imported = false
                    AND item.contact_terminal_reason_at_release = 'PUBLIC_EMAIL_FOUND'
                    AND item.contact_email_at_release IS NULL
                    AND item.contact_completed_at_release IS NOT NULL
                    AND contact_job.terminal_reason_code = 'PUBLIC_EMAIL_FOUND'
                    AND contact_job.completed_at IS NOT NULL
                    AND candidate.status IN ('candidate', 'promoted')
                    AND candidate.invalidated_at IS NULL AND candidate.guessed = false
                    AND candidate.confidence >= 80 AND candidate.purpose_confidence >= 70
                    AND candidate.inferred_purpose IN (
                      'press', 'editorial', 'partnerships', 'advertising',
                      'business', 'marketing', 'site_owner', 'general'
                    )
                    AND lower(candidate.normalized_email) ~
                      '^[^[:space:]@]+@[a-z0-9.-]+[.][a-z]{2,}$'
                    AND split_part(lower(candidate.normalized_email), '@', 1) !~
                      '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
                    AND candidate.email_domain_ascii NOT IN ('example.com', 'example.org', 'example.net')
                    AND candidate.email_domain_ascii NOT LIKE '%.invalid'
                    AND evidence.invalidated_at IS NULL AND evidence.expires_at > now()
                    AND evidence.extraction_method IN ('mailto', 'visible_text', 'obfuscated_text', 'json_ld')
                    AND evidence.confidence >= 80
                )
              )
            )
          )
      )
  )
  SELECT scope.organization_id, scope.workspace_id, scope.website_project_id
  FROM (
    SELECT * FROM missing_jobs
    UNION SELECT * FROM recoverable_jobs
    UNION SELECT * FROM v2_canonical_work
  ) AS scope
  ORDER BY scope.organization_id, scope.workspace_id, scope.website_project_id
  LIMIT LEAST(p_limit, 100);
END;
$function$;

ALTER FUNCTION backlink_list_contact_enrichment_recovery_scopes(integer)
  OWNER TO growthos_backlinks_owner;
REVOKE ALL ON FUNCTION backlink_list_contact_enrichment_recovery_scopes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backlink_list_contact_enrichment_recovery_scopes(integer)
  TO growthos_backlinks_writer;

COMMIT;
