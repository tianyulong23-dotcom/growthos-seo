BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'backlink_rec_visibility_scope_id_uq'
       AND conrelid =
         'backlink_recommendation_visibility_facts'::regclass
  ) THEN
    ALTER TABLE backlink_recommendation_visibility_facts
      ADD CONSTRAINT backlink_rec_visibility_scope_id_uq UNIQUE (
        organization_id, workspace_id, website_project_id, id
      );
  END IF;
END;
$migration$;

CREATE TABLE IF NOT EXISTS
  backlink_recommendation_legacy_source_lineage_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  target_generation_contract_id uuid NOT NULL,
  target_recommendation_context_version_id uuid NOT NULL,
  target_visible_pool_generation integer NOT NULL,
  target_input_pin_id uuid NOT NULL,
  target_batch_id uuid NOT NULL,
  target_item_id uuid NOT NULL,
  target_pool_contract_version text NOT NULL,
  source_generation_contract_id uuid NOT NULL,
  source_recommendation_context_version_id uuid NOT NULL,
  source_visible_pool_generation integer NOT NULL,
  source_input_pin_id uuid NOT NULL,
  source_pool_contract_version text NOT NULL,
  source_candidate_id uuid NOT NULL,
  source_recommendation_id uuid NOT NULL,
  source_prospect_id uuid NOT NULL,
  source_inventory_id uuid NOT NULL,
  source_qualification_fact_id uuid NOT NULL,
  source_visibility_fact_id uuid NOT NULL,
  source_contact_enrichment_job_id uuid NOT NULL,
  canonical_domain text NOT NULL,
  contact_terminal_reason text NOT NULL,
  contact_completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_legacy_lineage_target_item_uq UNIQUE (
    organization_id, workspace_id, website_project_id, target_item_id
  ),
  CONSTRAINT backlink_legacy_lineage_target_domain_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    target_generation_contract_id, canonical_domain
  ),
  CONSTRAINT backlink_legacy_lineage_source_domain_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    source_generation_contract_id, canonical_domain
  ),
  CONSTRAINT backlink_legacy_lineage_values_ck CHECK (
    target_pool_contract_version = 'recommendation-pool.v2'
    AND source_pool_contract_version = 'recommendation-pool.v1'
    AND target_visible_pool_generation > 0
    AND source_visible_pool_generation > 0
    AND canonical_domain = lower(canonical_domain)
    AND length(btrim(canonical_domain)) > 0
    AND contact_terminal_reason IN (
      'PUBLIC_EMAIL_FOUND',
      'CONTACT_FORM_ONLY',
      'LOGIN_REQUIRED',
      'CAPTCHA_OR_BOT_CHALLENGE',
      'ROBOTS_DISALLOWED',
      'ACCESS_DENIED',
      'NO_PUBLIC_EMAIL',
      'SITE_UNREACHABLE',
      'UNSUPPORTED_CONTENT',
      'MANUAL_REVIEW_REQUIRED',
      'COMPLETED_PARTIAL'
    )
    AND length(btrim(created_by)) > 0
  ),
  CONSTRAINT backlink_legacy_lineage_target_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    target_generation_contract_id,
    target_recommendation_context_version_id,
    target_visible_pool_generation,
    target_input_pin_id,
    target_pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_legacy_lineage_target_batch_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    target_batch_id,
    target_recommendation_context_version_id,
    target_visible_pool_generation
  ) REFERENCES backlink_recommendation_release_batches (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_legacy_lineage_target_item_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, target_item_id
  ) REFERENCES backlink_recommendation_release_batch_items (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_legacy_lineage_source_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    source_generation_contract_id,
    source_recommendation_context_version_id,
    source_visible_pool_generation,
    source_input_pin_id,
    source_pool_contract_version
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, visible_pool_generation,
    input_pin_id, pool_contract_version
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_legacy_lineage_source_candidate_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    source_candidate_id,
    source_recommendation_context_version_id,
    source_visible_pool_generation,
    source_recommendation_id,
    source_prospect_id
  ) REFERENCES backlink_commercial_candidates (
    organization_id, workspace_id, website_project_id, id,
    project_context_version_id, visible_pool_generation,
    recommendation_id, prospect_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_legacy_lineage_source_recommendation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    source_recommendation_id,
    source_prospect_id,
    source_recommendation_context_version_id
  ) REFERENCES backlink_recommendations (
    organization_id, workspace_id, website_project_id, id,
    prospect_id, recommendation_context_version_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_legacy_lineage_source_prospect_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    source_prospect_id,
    source_recommendation_context_version_id
  ) REFERENCES backlink_prospects (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_legacy_lineage_source_inventory_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    source_inventory_id,
    source_recommendation_id,
    source_prospect_id,
    source_recommendation_context_version_id,
    source_visible_pool_generation
  ) REFERENCES backlink_recommendation_inventory (
    organization_id, workspace_id, website_project_id, id,
    recommendation_id, prospect_id, recommendation_context_version_id,
    visible_pool_generation
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_legacy_lineage_source_qualification_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    source_qualification_fact_id
  ) REFERENCES backlink_recommendation_qualification_facts (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_legacy_lineage_source_visibility_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    source_visibility_fact_id
  ) REFERENCES backlink_recommendation_visibility_facts (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_legacy_lineage_source_contact_job_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    source_contact_enrichment_job_id
  ) REFERENCES backlink_contact_enrichment_jobs (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION
  backlink_validate_recommendation_legacy_source_lineage()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  target_matches integer;
  source_matches integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Legacy recommendation source lineage facts are immutable.';
  END IF;

  SELECT count(*)::integer
    INTO target_matches
    FROM backlink_recommendation_release_batch_items AS item
    JOIN backlink_recommendation_release_batches AS batch
      ON batch.organization_id = item.organization_id
     AND batch.workspace_id = item.workspace_id
     AND batch.website_project_id = item.website_project_id
     AND batch.id = item.batch_id
    JOIN backlink_recommendation_generation_contracts AS generation
      ON generation.organization_id = item.organization_id
     AND generation.workspace_id = item.workspace_id
     AND generation.website_project_id = item.website_project_id
     AND generation.id = item.generation_contract_id
    JOIN LATERAL (
      SELECT snapshot.id, snapshot.project_status
        FROM backlink_project_context_snapshots AS snapshot
       WHERE snapshot.organization_id = item.organization_id
         AND snapshot.workspace_id = item.workspace_id
         AND snapshot.website_project_id = item.website_project_id
       ORDER BY snapshot.snapshot_version DESC,
                snapshot.created_at DESC,
                snapshot.id DESC
       LIMIT 1
    ) AS current_context ON true
   WHERE item.organization_id = NEW.organization_id
     AND item.workspace_id = NEW.workspace_id
     AND item.website_project_id = NEW.website_project_id
     AND item.id = NEW.target_item_id
     AND item.batch_id = NEW.target_batch_id
     AND item.generation_contract_id =
       NEW.target_generation_contract_id
     AND item.recommendation_context_version_id =
       NEW.target_recommendation_context_version_id
     AND item.visible_pool_generation =
       NEW.target_visible_pool_generation
     AND item.input_pin_id = NEW.target_input_pin_id
     AND item.pool_contract_version =
       NEW.target_pool_contract_version
     AND item.pool_contract_version = 'recommendation-pool.v2'
     AND item.legacy_imported = true
     AND item.candidate_id IS NULL
     AND item.recommendation_id IS NULL
     AND item.prospect_id IS NULL
     AND item.inventory_id IS NULL
     AND item.canonical_domain = NEW.canonical_domain
     AND item.contact_terminal_reason_at_release =
       NEW.contact_terminal_reason
     AND item.contact_completed_at_release = NEW.contact_completed_at
     AND batch.state = 'PREPARING'
     AND generation.pool_contract_version = 'recommendation-pool.v2'
     AND generation.recommendation_context_version_id =
       NEW.target_recommendation_context_version_id
     AND generation.visible_pool_generation =
       NEW.target_visible_pool_generation
     AND generation.input_pin_id = NEW.target_input_pin_id
     AND current_context.id =
       NEW.target_recommendation_context_version_id
     AND current_context.project_status = 'ACTIVE';

  IF target_matches <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Legacy recommendation target lineage is incomplete or stale.';
  END IF;

  SELECT count(*)::integer
    INTO source_matches
    FROM backlink_recommendation_generation_contracts AS generation
    JOIN backlink_recommendation_qualification_facts AS qualification
      ON qualification.organization_id = generation.organization_id
     AND qualification.workspace_id = generation.workspace_id
     AND qualification.website_project_id =
       generation.website_project_id
     AND qualification.generation_contract_id = generation.id
    JOIN backlink_recommendation_visibility_facts AS visibility
      ON visibility.organization_id = qualification.organization_id
     AND visibility.workspace_id = qualification.workspace_id
     AND visibility.website_project_id =
       qualification.website_project_id
     AND visibility.generation_contract_id = generation.id
     AND visibility.qualification_fact_id = qualification.id
    JOIN backlink_commercial_candidates AS candidate
      ON candidate.organization_id = qualification.organization_id
     AND candidate.workspace_id = qualification.workspace_id
     AND candidate.website_project_id =
       qualification.website_project_id
     AND candidate.id = qualification.candidate_id
    JOIN backlink_recommendations AS recommendation
      ON recommendation.organization_id = candidate.organization_id
     AND recommendation.workspace_id = candidate.workspace_id
     AND recommendation.website_project_id =
       candidate.website_project_id
     AND recommendation.id = candidate.recommendation_id
     AND recommendation.prospect_id = candidate.prospect_id
     AND recommendation.recommendation_context_version_id =
       candidate.project_context_version_id
    JOIN backlink_prospects AS prospect
      ON prospect.organization_id = recommendation.organization_id
     AND prospect.workspace_id = recommendation.workspace_id
     AND prospect.website_project_id =
       recommendation.website_project_id
     AND prospect.id = recommendation.prospect_id
     AND prospect.recommendation_context_version_id =
       recommendation.recommendation_context_version_id
    JOIN backlink_recommendation_inventory AS inventory
      ON inventory.organization_id = recommendation.organization_id
     AND inventory.workspace_id = recommendation.workspace_id
     AND inventory.website_project_id =
       recommendation.website_project_id
     AND inventory.recommendation_id = recommendation.id
     AND inventory.prospect_id = recommendation.prospect_id
     AND inventory.recommendation_context_version_id =
       recommendation.recommendation_context_version_id
    JOIN backlink_contact_enrichment_jobs AS contact_job
      ON contact_job.organization_id = recommendation.organization_id
     AND contact_job.workspace_id = recommendation.workspace_id
     AND contact_job.website_project_id =
       recommendation.website_project_id
     AND contact_job.recommendation_id = recommendation.id
     AND contact_job.prospect_id = recommendation.prospect_id
     AND contact_job.recommendation_context_version_id =
       recommendation.recommendation_context_version_id
   WHERE generation.organization_id = NEW.organization_id
     AND generation.workspace_id = NEW.workspace_id
     AND generation.website_project_id = NEW.website_project_id
     AND generation.id = NEW.source_generation_contract_id
     AND generation.recommendation_context_version_id =
       NEW.source_recommendation_context_version_id
     AND generation.visible_pool_generation =
       NEW.source_visible_pool_generation
     AND generation.input_pin_id = NEW.source_input_pin_id
     AND generation.pool_contract_version =
       NEW.source_pool_contract_version
     AND generation.pool_contract_version = 'recommendation-pool.v1'
     AND qualification.id = NEW.source_qualification_fact_id
     AND qualification.candidate_id = NEW.source_candidate_id
     AND qualification.recommendation_id =
       NEW.source_recommendation_id
     AND qualification.prospect_id = NEW.source_prospect_id
     AND qualification.recommendation_context_version_id =
       NEW.source_recommendation_context_version_id
     AND qualification.canonical_domain = NEW.canonical_domain
     AND qualification.decision = 'eligible'
     AND visibility.id = NEW.source_visibility_fact_id
     AND visibility.recommendation_id =
       NEW.source_recommendation_id
     AND visibility.prospect_id = NEW.source_prospect_id
     AND visibility.recommendation_context_version_id =
       NEW.source_recommendation_context_version_id
     AND visibility.canonical_domain = NEW.canonical_domain
     AND visibility.decision = 'visible'
     AND candidate.id = NEW.source_candidate_id
     AND candidate.project_context_version_id =
       NEW.source_recommendation_context_version_id
     AND candidate.visible_pool_generation =
       NEW.source_visible_pool_generation
     AND candidate.canonical_domain = NEW.canonical_domain
     AND candidate.recommendation_id =
       NEW.source_recommendation_id
     AND candidate.prospect_id = NEW.source_prospect_id
     AND recommendation.id = NEW.source_recommendation_id
     AND prospect.id = NEW.source_prospect_id
     AND prospect.registrable_domain = NEW.canonical_domain
     AND inventory.id = NEW.source_inventory_id
     AND inventory.visible_pool_generation =
       NEW.source_visible_pool_generation
     AND contact_job.id = NEW.source_contact_enrichment_job_id
     AND contact_job.status IN (
       'completed', 'partially_completed', 'no_contact_found'
     )
     AND contact_job.terminal_reason_code =
       NEW.contact_terminal_reason
     AND contact_job.completed_at = NEW.contact_completed_at;

  IF source_matches <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Legacy recommendation source lineage is incomplete or non-terminal.';
  END IF;

  RETURN NEW;
END;
$function$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'backlink_legacy_source_lineage_validate_trg'
       AND tgrelid =
         'backlink_recommendation_legacy_source_lineage_facts'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER backlink_legacy_source_lineage_validate_trg
    BEFORE INSERT OR UPDATE OR DELETE
    ON backlink_recommendation_legacy_source_lineage_facts
    FOR EACH ROW
    EXECUTE FUNCTION
      backlink_validate_recommendation_legacy_source_lineage();
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION
  backlink_recommendation_release_item_has_valid_lineage(
    p_item backlink_recommendation_release_batch_items
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT CASE
    WHEN p_item.legacy_imported = false THEN
      p_item.candidate_id IS NOT NULL
      AND p_item.recommendation_id IS NOT NULL
      AND p_item.prospect_id IS NOT NULL
      AND p_item.inventory_id IS NOT NULL
      AND p_item.generation_contract_id IS NOT NULL
      AND p_item.input_pin_id IS NOT NULL
    WHEN p_item.legacy_imported = true THEN
      p_item.candidate_id IS NULL
      AND p_item.recommendation_id IS NULL
      AND p_item.prospect_id IS NULL
      AND p_item.inventory_id IS NULL
      AND p_item.generation_contract_id IS NOT NULL
      AND p_item.input_pin_id IS NOT NULL
      AND p_item.contact_terminal_reason_at_release IS NOT NULL
      AND p_item.contact_terminal_reason_at_release <> 'CONTACT_PENDING'
      AND p_item.contact_completed_at_release IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM backlink_recommendation_legacy_source_lineage_facts AS lineage
         WHERE lineage.organization_id = p_item.organization_id
           AND lineage.workspace_id = p_item.workspace_id
           AND lineage.website_project_id = p_item.website_project_id
           AND lineage.target_item_id = p_item.id
           AND lineage.target_batch_id = p_item.batch_id
           AND lineage.target_generation_contract_id =
             p_item.generation_contract_id
           AND lineage.target_recommendation_context_version_id =
             p_item.recommendation_context_version_id
           AND lineage.target_visible_pool_generation =
             p_item.visible_pool_generation
           AND lineage.target_input_pin_id = p_item.input_pin_id
           AND lineage.target_pool_contract_version =
             p_item.pool_contract_version
           AND lineage.canonical_domain = p_item.canonical_domain
           AND lineage.contact_terminal_reason =
             p_item.contact_terminal_reason_at_release
           AND lineage.contact_completed_at =
             p_item.contact_completed_at_release
      )
    ELSE false
  END;
$function$;

CREATE OR REPLACE FUNCTION backlink_validate_release_batch_available()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  checked_batch_id uuid;
  current_state text;
  expected_size integer;
  declared_terminal_count integer;
  item_count integer;
  invalid_lineage_count integer;
  incomplete_contact_count integer;
BEGIN
  checked_batch_id := CASE
    WHEN TG_TABLE_NAME = 'backlink_recommendation_release_batch_items'
      THEN (to_jsonb(NEW) ->> 'batch_id')::uuid
    ELSE (to_jsonb(NEW) ->> 'id')::uuid
  END;

  SELECT state, original_batch_size, contact_terminal_count
    INTO current_state, expected_size, declared_terminal_count
    FROM backlink_recommendation_release_batches
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = checked_batch_id;

  IF current_state <> 'AVAILABLE' THEN
    RETURN NULL;
  END IF;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE NOT backlink_recommendation_release_item_has_valid_lineage(item)
    )::integer,
    count(*) FILTER (
      WHERE contact_terminal_reason_at_release IS NULL
        OR contact_terminal_reason_at_release = 'CONTACT_PENDING'
        OR contact_completed_at_release IS NULL
    )::integer
    INTO item_count, invalid_lineage_count, incomplete_contact_count
    FROM backlink_recommendation_release_batch_items AS item
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND batch_id = checked_batch_id;

  IF item_count <> expected_size
     OR invalid_lineage_count <> 0
     OR incomplete_contact_count <> 0
     OR declared_terminal_count <> item_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'AVAILABLE batch requires complete canonical items and terminal contacts.';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION
  backlink_recommendation_pool_v2_verify_cutover()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH latest AS (
    SELECT DISTINCT ON (
             snapshot.organization_id,
             snapshot.workspace_id,
             snapshot.website_project_id
           )
           snapshot.organization_id,
           snapshot.workspace_id,
           snapshot.website_project_id,
           snapshot.project_status
      FROM backlink_project_context_snapshots AS snapshot
     ORDER BY snapshot.organization_id,
              snapshot.workspace_id,
              snapshot.website_project_id,
              snapshot.snapshot_version DESC,
              snapshot.created_at DESC,
              snapshot.id DESC
  ),
  eligible AS (
    SELECT *
      FROM latest
     WHERE project_status = 'ACTIVE'
  ),
  project_state AS (
    SELECT eligible.organization_id,
           eligible.workspace_id,
           eligible.website_project_id,
           contract.migration_state,
           contract.pool_contract_version,
           generation.id AS generation_contract_id,
           (
             contract.migration_state = 'V2_ACTIVE'
             AND contract.pool_contract_version = 'recommendation-pool.v2'
             AND generation.pool_contract_version =
               'recommendation-pool.v2'
             AND generation.discovery_completed_at IS NOT NULL
             AND generation.effective_unique_candidate_count > 0
             AND generation.canonical_batch_count > 0
             AND (
               SELECT count(*)::integer
                 FROM backlink_recommendation_release_batches AS batch
                WHERE batch.organization_id = eligible.organization_id
                  AND batch.workspace_id = eligible.workspace_id
                  AND batch.website_project_id =
                    eligible.website_project_id
                  AND batch.generation_contract_id = generation.id
             ) = generation.canonical_batch_count
             AND NOT EXISTS (
               SELECT 1
                 FROM backlink_recommendation_release_batches AS batch
                WHERE batch.organization_id = eligible.organization_id
                  AND batch.workspace_id = eligible.workspace_id
                  AND batch.website_project_id =
                    eligible.website_project_id
                  AND batch.generation_contract_id = generation.id
                  AND (
                    batch.state <> 'AVAILABLE'
                    OR batch.contact_terminal_count <>
                      batch.contact_total_count
                  )
             )
             AND (
               SELECT count(*)::integer
                 FROM backlink_recommendation_release_batch_items AS item
                WHERE item.organization_id = eligible.organization_id
                  AND item.workspace_id = eligible.workspace_id
                  AND item.website_project_id =
                    eligible.website_project_id
                  AND item.generation_contract_id = generation.id
             ) = generation.effective_unique_candidate_count
             AND NOT EXISTS (
               SELECT 1
                 FROM backlink_recommendation_release_batch_items AS item
                WHERE item.organization_id = eligible.organization_id
                  AND item.workspace_id = eligible.workspace_id
                  AND item.website_project_id =
                    eligible.website_project_id
                  AND item.generation_contract_id = generation.id
                  AND (
                    NOT backlink_recommendation_release_item_has_valid_lineage(
                      item
                    )
                    OR item.input_pin_id IS NULL
                    OR item.contact_terminal_reason_at_release IS NULL
                    OR item.contact_terminal_reason_at_release =
                      'CONTACT_PENDING'
                    OR item.contact_completed_at_release IS NULL
                  )
             )
           ) AS valid_v2_active
      FROM eligible
      LEFT JOIN backlink_recommendation_pool_project_contracts AS contract
        ON contract.organization_id = eligible.organization_id
       AND contract.workspace_id = eligible.workspace_id
       AND contract.website_project_id = eligible.website_project_id
      LEFT JOIN backlink_recommendation_generation_contracts AS generation
        ON generation.organization_id = contract.organization_id
       AND generation.workspace_id = contract.workspace_id
       AND generation.website_project_id = contract.website_project_id
       AND generation.id = contract.generation_contract_id
  ),
  project_counts AS (
    SELECT count(*)::integer AS eligible_project_count,
           count(*) FILTER (
             WHERE migration_state = 'V2_ACTIVE'
           )::integer AS v2_active_project_count,
           count(*) FILTER (
             WHERE valid_v2_active
           )::integer AS valid_v2_active_project_count,
           count(*) FILTER (
             WHERE migration_state IS NULL
                OR migration_state = 'V1_ACTIVE'
           )::integer AS active_v1_project_count,
           count(*) FILTER (
             WHERE migration_state = 'MIGRATION_BLOCKED'
           )::integer AS migration_blocked_project_count,
           count(*) FILTER (
             WHERE migration_state = 'V2_ACTIVE'
               AND NOT valid_v2_active
           )::integer AS invalid_v2_active_project_count
      FROM project_state
  ),
  active_v1_generation AS (
    SELECT count(*)::integer AS count
      FROM backlink_recommendation_generation_contracts AS generation
      JOIN project_state
        ON project_state.organization_id = generation.organization_id
       AND project_state.workspace_id = generation.workspace_id
       AND project_state.website_project_id =
         generation.website_project_id
     WHERE generation.pool_contract_version = 'recommendation-pool.v1'
       AND (
         project_state.migration_state IS NULL
         OR project_state.migration_state = 'V1_ACTIVE'
       )
  ),
  active_refill_job AS (
    SELECT count(*)::integer AS count
      FROM backlink_jobs AS job
     WHERE job.job_type = 'recommendation_refill'
       AND job.status IN ('queued', 'running', 'waiting_provider')
  ),
  active_refill AS (
    SELECT count(*)::integer AS count
      FROM backlink_recommendation_refills AS refill
      JOIN backlink_jobs AS job
        ON job.organization_id = refill.organization_id
       AND job.workspace_id = refill.workspace_id
       AND job.website_project_id = refill.website_project_id
       AND job.id = refill.job_id
     WHERE job.status IN ('queued', 'running', 'waiting_provider')
  ),
  active_outbox AS (
    SELECT count(*)::integer AS count
      FROM backlink_outbox_events AS event
     WHERE event.event_type =
             'backlinks.recommendation-refill.requested.v1'
       AND event.status IN ('pending', 'processing')
  ),
  active_claim AS (
    SELECT count(*)::integer AS count
      FROM backlink_recommendation_claims AS claim
     WHERE claim.status = 'active'
  ),
  active_provider_request AS (
    SELECT count(DISTINCT request.id)::integer AS count
      FROM provider_batch_requests AS request
      JOIN backlink_recommendation_refills AS refill
        ON request.request_id LIKE refill.refill_window_key || ':%'
     WHERE request.status IN ('running', 'unknown_charge')
  ),
  active_provider_reservation AS (
    SELECT count(DISTINCT usage.id)::integer AS count
      FROM backlink_provider_usage_ledger AS usage
      JOIN backlink_recommendation_refills AS refill
        ON usage.reservation_key LIKE refill.refill_window_key || ':%'
     WHERE usage.status = 'reserved'
  ),
  active_provider_lease AS (
    SELECT count(DISTINCT lease.artifact_fingerprint)::integer AS count
      FROM provider_fetch_leases AS lease
      JOIN backlink_recommendation_refills AS refill
        ON lease.owner_request_id LIKE refill.refill_window_key || ':%'
     WHERE lease.status IN ('acquired', 'unknown_charge')
  )
  SELECT jsonb_build_object(
    'eligibleProjectCount',
      project_counts.eligible_project_count,
    'v2ActiveProjectCount',
      project_counts.v2_active_project_count,
    'validV2ActiveProjectCount',
      project_counts.valid_v2_active_project_count,
    'activeV1ProjectCount',
      project_counts.active_v1_project_count,
    'migrationBlockedProjectCount',
      project_counts.migration_blocked_project_count,
    'invalidV2ActiveProjectCount',
      project_counts.invalid_v2_active_project_count,
    'activeV1GenerationCount',
      active_v1_generation.count,
    'activeV1RefillCount',
      active_refill.count,
    'activeV1RefillJobCount',
      active_refill_job.count,
    'activeV1OutboxCount',
      active_outbox.count,
    'activeV1ClaimCount',
      active_claim.count,
    'activeV1ProviderRequestCount',
      active_provider_request.count,
    'activeV1ProviderReservationCount',
      active_provider_reservation.count,
    'activeV1ProviderLeaseCount',
      active_provider_lease.count,
    'completed',
      project_counts.eligible_project_count =
        project_counts.valid_v2_active_project_count
      AND project_counts.active_v1_project_count = 0
      AND project_counts.migration_blocked_project_count = 0
      AND project_counts.invalid_v2_active_project_count = 0
      AND active_v1_generation.count = 0
      AND active_refill.count = 0
      AND active_refill_job.count = 0
      AND active_outbox.count = 0
      AND active_claim.count = 0
      AND active_provider_request.count = 0
      AND active_provider_reservation.count = 0
      AND active_provider_lease.count = 0
  )
    FROM project_counts,
         active_v1_generation,
         active_refill,
         active_refill_job,
         active_outbox,
         active_claim,
         active_provider_request,
         active_provider_reservation,
         active_provider_lease;
$function$;

ALTER TABLE backlink_recommendation_legacy_source_lineage_facts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_legacy_source_lineage_facts
  FORCE ROW LEVEL SECURITY;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'backlinks'
       AND tablename =
         'backlink_recommendation_legacy_source_lineage_facts'
       AND policyname = 'backlink_legacy_source_lineage_tenant_policy'
  ) THEN
    CREATE POLICY backlink_legacy_source_lineage_tenant_policy
      ON backlink_recommendation_legacy_source_lineage_facts
      TO growthos_backlinks_writer, growthos_reporting_reader
      USING (
        organization_id::text =
          current_setting('app.current_organization_id', true)
        AND workspace_id::text =
          current_setting('app.current_workspace_id', true)
        AND website_project_id::text =
          current_setting('app.current_website_project_id', true)
      )
      WITH CHECK (
        organization_id::text =
          current_setting('app.current_organization_id', true)
        AND workspace_id::text =
          current_setting('app.current_workspace_id', true)
        AND website_project_id::text =
          current_setting('app.current_website_project_id', true)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'backlinks'
       AND tablename =
         'backlink_recommendation_legacy_source_lineage_facts'
       AND policyname = 'backlink_legacy_source_lineage_internal_policy'
  ) THEN
    CREATE POLICY backlink_legacy_source_lineage_internal_policy
      ON backlink_recommendation_legacy_source_lineage_facts
      TO growthos_backlinks_owner
      USING (true)
      WITH CHECK (true);
  END IF;
END;
$migration$;

REVOKE ALL
  ON backlink_recommendation_legacy_source_lineage_facts
  FROM PUBLIC;
GRANT SELECT, INSERT
  ON backlink_recommendation_legacy_source_lineage_facts
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_recommendation_legacy_source_lineage_facts
  TO growthos_reporting_reader;

REVOKE ALL
  ON FUNCTION backlink_recommendation_release_item_has_valid_lineage(
    backlink_recommendation_release_batch_items
  )
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION backlink_recommendation_release_item_has_valid_lineage(
    backlink_recommendation_release_batch_items
  )
  TO growthos_backlinks_writer, growthos_reporting_reader;

COMMIT;
