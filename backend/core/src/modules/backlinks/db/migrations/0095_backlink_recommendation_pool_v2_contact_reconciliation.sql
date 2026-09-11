BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_contact_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_contact_evidence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backlink_contact_recovery_candidate_read_policy
  ON backlink_contact_candidates;
CREATE POLICY backlink_contact_recovery_candidate_read_policy
  ON backlink_contact_candidates
  FOR SELECT TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_contact_recovery_evidence_read_policy
  ON backlink_contact_evidence;
CREATE POLICY backlink_contact_recovery_evidence_read_policy
  ON backlink_contact_evidence
  FOR SELECT TO growthos_backlinks_owner
  USING (true);

CREATE OR REPLACE FUNCTION backlink_validate_release_item_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  batch_state text;
  batch_generation_contract_id uuid;
  batch_input_pin_id uuid;
  canonical_email text;
  is_contact_email_reconciliation boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Canonical recommendation release items are retained.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    is_contact_email_reconciliation :=
      OLD.contact_terminal_reason_at_release = 'PUBLIC_EMAIL_FOUND'
      AND OLD.contact_email_at_release IS NULL
      AND OLD.contact_completed_at_release IS NOT NULL
      AND NEW.contact_terminal_reason_at_release =
        OLD.contact_terminal_reason_at_release
      AND NEW.contact_email_at_release IS NOT NULL
      AND NEW.contact_email_at_release =
        lower(btrim(NEW.contact_email_at_release))
      AND NEW.contact_email_at_release ~
        '^[^[:space:]@]+@[a-z0-9.-]+[.][a-z]{2,}$'
      AND NEW.contact_page_url_at_release IS NOT DISTINCT FROM
        OLD.contact_page_url_at_release
      AND NEW.contact_completed_at_release IS NOT DISTINCT FROM
        OLD.contact_completed_at_release
      AND (
        to_jsonb(NEW) - ARRAY[
          'contact_terminal_reason_at_release',
          'contact_email_at_release',
          'contact_page_url_at_release',
          'contact_completed_at_release'
        ]::text[]
      ) = (
        to_jsonb(OLD) - ARRAY[
          'contact_terminal_reason_at_release',
          'contact_email_at_release',
          'contact_page_url_at_release',
          'contact_completed_at_release'
        ]::text[]
      );

    IF NOT is_contact_email_reconciliation
       AND (
         OLD.contact_terminal_reason_at_release IS NOT NULL
         OR OLD.contact_completed_at_release IS NOT NULL
         OR NEW.contact_terminal_reason_at_release IS NULL
         OR NEW.contact_completed_at_release IS NULL
         OR (
           to_jsonb(NEW) - ARRAY[
             'contact_terminal_reason_at_release',
             'contact_email_at_release',
             'contact_page_url_at_release',
             'contact_completed_at_release'
           ]::text[]
         ) <> (
           to_jsonb(OLD) - ARRAY[
             'contact_terminal_reason_at_release',
             'contact_email_at_release',
             'contact_page_url_at_release',
             'contact_completed_at_release'
           ]::text[]
         )
       ) THEN
      RAISE EXCEPTION
        'Release item membership is immutable after insertion.';
    END IF;
  END IF;

  SELECT state, generation_contract_id, input_pin_id
    INTO batch_state, batch_generation_contract_id, batch_input_pin_id
    FROM backlink_recommendation_release_batches
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = NEW.batch_id
     AND recommendation_context_version_id =
       NEW.recommendation_context_version_id
     AND visible_pool_generation = NEW.visible_pool_generation;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Canonical recommendation release batch was not found.';
  END IF;

  IF (
       batch_state <> 'PREPARING'
       AND NOT (
         is_contact_email_reconciliation
         AND batch_state = 'AVAILABLE'
       )
     )
     OR NEW.generation_contract_id <> batch_generation_contract_id
     OR NEW.input_pin_id <> batch_input_pin_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Release items can be prepared only against matching PREPARING batches.';
  END IF;

  IF is_contact_email_reconciliation THEN
    SELECT lower(candidate.normalized_email)
      INTO canonical_email
      FROM backlink_recommendation_inventory AS inventory
      JOIN backlink_contact_evidence_snapshots AS snapshot
        ON snapshot.organization_id = inventory.organization_id
       AND snapshot.workspace_id = inventory.workspace_id
       AND snapshot.website_project_id = inventory.website_project_id
       AND snapshot.id = inventory.contact_evidence_snapshot_id
       AND snapshot.recommendation_id = inventory.recommendation_id
       AND snapshot.prospect_id = inventory.prospect_id
       AND snapshot.recommendation_context_version_id =
         inventory.recommendation_context_version_id
      JOIN backlink_contact_candidates AS candidate
        ON candidate.organization_id = snapshot.organization_id
       AND candidate.workspace_id = snapshot.workspace_id
       AND candidate.website_project_id = snapshot.website_project_id
       AND candidate.id = snapshot.contact_candidate_id
       AND candidate.prospect_id = snapshot.prospect_id
       AND candidate.recommendation_context_version_id =
         snapshot.recommendation_context_version_id
      JOIN backlink_contact_evidence AS evidence
        ON evidence.organization_id = snapshot.organization_id
       AND evidence.workspace_id = snapshot.workspace_id
       AND evidence.website_project_id = snapshot.website_project_id
       AND evidence.id = snapshot.contact_evidence_id
       AND evidence.candidate_id = candidate.id
     WHERE inventory.organization_id = NEW.organization_id
       AND inventory.workspace_id = NEW.workspace_id
       AND inventory.website_project_id = NEW.website_project_id
       AND inventory.id = NEW.inventory_id
       AND inventory.recommendation_id = NEW.recommendation_id
       AND inventory.prospect_id = NEW.prospect_id
       AND inventory.recommendation_context_version_id =
         NEW.recommendation_context_version_id
       AND inventory.contact_decision = 'eligible'
       AND inventory.contact_reason_code = 'PUBLIC_EMAIL_FOUND'
       AND inventory.default_contact_candidate_id = candidate.id
       AND candidate.status IN ('candidate', 'promoted')
       AND candidate.invalidated_at IS NULL
       AND candidate.guessed = false
       AND candidate.confidence >= 80
       AND candidate.purpose_confidence >= 70
       AND candidate.inferred_purpose IN (
         'press', 'editorial', 'partnerships', 'advertising',
         'business', 'marketing', 'site_owner', 'general'
       )
       AND split_part(lower(candidate.normalized_email), '@', 1)
         !~ '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
       AND candidate.email_domain_ascii NOT IN (
         'example.com', 'example.org', 'example.net'
       )
       AND candidate.email_domain_ascii NOT LIKE '%.invalid'
       AND evidence.invalidated_at IS NULL
       AND evidence.expires_at > statement_timestamp()
       AND evidence.extraction_method IN (
         'mailto', 'visible_text', 'obfuscated_text', 'json_ld'
       )
       AND evidence.confidence >= 80
       AND lower(candidate.normalized_email) =
         NEW.contact_email_at_release;

    IF canonical_email IS NULL
       OR canonical_email <> NEW.contact_email_at_release THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Release email reconciliation requires current canonical evidence.';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

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
                OR EXISTS (
                  SELECT 1
                  FROM backlink_recommendation_release_batch_items AS item
                  JOIN backlink_contact_enrichment_jobs AS contact_job
                    ON contact_job.organization_id = item.organization_id
                   AND contact_job.workspace_id = item.workspace_id
                   AND contact_job.website_project_id =
                     item.website_project_id
                   AND contact_job.recommendation_id =
                     item.recommendation_id
                   AND contact_job.prospect_id = item.prospect_id
                   AND contact_job.recommendation_context_version_id =
                     item.recommendation_context_version_id
                  JOIN backlink_contact_candidates AS candidate
                    ON candidate.organization_id = item.organization_id
                   AND candidate.workspace_id = item.workspace_id
                   AND candidate.website_project_id =
                     item.website_project_id
                   AND candidate.prospect_id = item.prospect_id
                   AND candidate.recommendation_context_version_id =
                     item.recommendation_context_version_id
                  JOIN backlink_contact_evidence AS evidence
                    ON evidence.organization_id = candidate.organization_id
                   AND evidence.workspace_id = candidate.workspace_id
                   AND evidence.website_project_id =
                     candidate.website_project_id
                   AND evidence.candidate_id = candidate.id
                  WHERE item.organization_id = batch.organization_id
                    AND item.workspace_id = batch.workspace_id
                    AND item.website_project_id =
                      batch.website_project_id
                    AND item.batch_id = batch.id
                    AND item.generation_contract_id = generation.id
                    AND item.recommendation_context_version_id =
                      generation.recommendation_context_version_id
                    AND item.visible_pool_generation =
                      generation.visible_pool_generation
                    AND item.input_pin_id = generation.input_pin_id
                    AND item.legacy_imported = false
                    AND item.contact_terminal_reason_at_release =
                      'PUBLIC_EMAIL_FOUND'
                    AND item.contact_email_at_release IS NULL
                    AND item.contact_completed_at_release IS NOT NULL
                    AND contact_job.terminal_reason_code =
                      'PUBLIC_EMAIL_FOUND'
                    AND contact_job.completed_at IS NOT NULL
                    AND candidate.status IN ('candidate', 'promoted')
                    AND candidate.invalidated_at IS NULL
                    AND candidate.guessed = false
                    AND candidate.confidence >= 80
                    AND candidate.purpose_confidence >= 70
                    AND candidate.inferred_purpose IN (
                      'press', 'editorial', 'partnerships',
                      'advertising', 'business', 'marketing',
                      'site_owner', 'general'
                    )
                    AND lower(candidate.normalized_email) ~
                      '^[^[:space:]@]+@[a-z0-9.-]+[.][a-z]{2,}$'
                    AND split_part(
                      lower(candidate.normalized_email), '@', 1
                    ) !~
                      '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
                    AND candidate.email_domain_ascii NOT IN (
                      'example.com', 'example.org', 'example.net'
                    )
                    AND candidate.email_domain_ascii NOT LIKE '%.invalid'
                    AND evidence.invalidated_at IS NULL
                    AND evidence.expires_at > now()
                    AND evidence.extraction_method IN (
                      'mailto', 'visible_text', 'obfuscated_text',
                      'json_ld'
                    )
                    AND evidence.confidence >= 80
                )
              )
            )
          )
          AND batch.batch_ordinal <= 2
          AND generation.pool_contract_version =
            'recommendation-pool.v2'
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
