BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE IF NOT EXISTS backlink_recommendation_pool_v2_cutover_runs (
  id uuid PRIMARY KEY,
  command_id text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'RUNNING',
  eligible_project_count integer NOT NULL DEFAULT 0,
  v2_active_project_count integer NOT NULL DEFAULT 0,
  input_required_project_count integer NOT NULL DEFAULT 0,
  migration_blocked_project_count integer NOT NULL DEFAULT 0,
  verification jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT backlink_pool_v2_cutover_run_command_uq UNIQUE (command_id),
  CONSTRAINT backlink_pool_v2_cutover_run_values_ck CHECK (
    length(btrim(command_id)) > 0
    AND mode IN ('PLAN', 'EXECUTE')
    AND status IN (
      'RUNNING',
      'PLANNED',
      'INPUT_REQUIRED',
      'MIGRATION_BLOCKED',
      'COMPLETED'
    )
    AND eligible_project_count >= 0
    AND v2_active_project_count >= 0
    AND input_required_project_count >= 0
    AND migration_blocked_project_count >= 0
    AND jsonb_typeof(verification) = 'object'
    AND version > 0
    AND (
      (status = 'RUNNING' AND completed_at IS NULL)
      OR (status <> 'RUNNING' AND completed_at IS NOT NULL)
    )
  )
);

CREATE TABLE IF NOT EXISTS
  backlink_recommendation_pool_v2_cutover_project_facts (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    website_project_id uuid NOT NULL,
    project_context_snapshot_id uuid NOT NULL,
    project_context_snapshot_version integer NOT NULL,
    phase text NOT NULL,
    result text NOT NULL,
    reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
    generation_contract_id uuid,
    pool_contract_version text,
    recommendation_context_version_id uuid,
    visible_pool_generation integer,
    input_pin_id uuid,
    canonical_batch_count integer,
    available_batch_count integer,
    canonical_item_count integer,
    observed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text NOT NULL,
    CONSTRAINT backlink_pool_v2_cutover_fact_run_scope_phase_uq UNIQUE (
      run_id,
      organization_id,
      workspace_id,
      website_project_id,
      phase
    ),
    CONSTRAINT backlink_pool_v2_cutover_fact_values_ck CHECK (
      project_context_snapshot_version > 0
      AND phase IN ('PLAN', 'APPLY')
      AND result IN (
        'READY',
        'V2_ACTIVE',
        'ALREADY_V2_ACTIVE',
        'INPUT_REQUIRED',
        'MIGRATION_BLOCKED'
      )
      AND jsonb_typeof(reason_codes) = 'array'
      AND (
        (
          generation_contract_id IS NULL
          AND pool_contract_version IS NULL
          AND recommendation_context_version_id IS NULL
          AND visible_pool_generation IS NULL
          AND input_pin_id IS NULL
        )
        OR (
          generation_contract_id IS NOT NULL
          AND pool_contract_version = 'recommendation-pool.v2'
          AND recommendation_context_version_id IS NOT NULL
          AND visible_pool_generation > 0
          AND input_pin_id IS NOT NULL
        )
      )
      AND (canonical_batch_count IS NULL OR canonical_batch_count >= 0)
      AND (available_batch_count IS NULL OR available_batch_count >= 0)
      AND (canonical_item_count IS NULL OR canonical_item_count >= 0)
    ),
    CONSTRAINT backlink_pool_v2_cutover_fact_run_fk FOREIGN KEY (run_id)
      REFERENCES backlink_recommendation_pool_v2_cutover_runs (id)
      ON DELETE RESTRICT,
    CONSTRAINT backlink_pool_v2_cutover_fact_context_fk FOREIGN KEY (
      organization_id,
      workspace_id,
      website_project_id,
      project_context_snapshot_id
    ) REFERENCES backlink_project_context_snapshots (
      organization_id,
      workspace_id,
      website_project_id,
      id
    ) ON DELETE RESTRICT,
    CONSTRAINT backlink_pool_v2_cutover_fact_generation_fk FOREIGN KEY (
      organization_id,
      workspace_id,
      website_project_id,
      generation_contract_id,
      recommendation_context_version_id,
      visible_pool_generation,
      input_pin_id,
      pool_contract_version
    ) REFERENCES backlink_recommendation_generation_contracts (
      organization_id,
      workspace_id,
      website_project_id,
      id,
      recommendation_context_version_id,
      visible_pool_generation,
      input_pin_id,
      pool_contract_version
    ) ON DELETE RESTRICT
  );

ALTER TABLE backlink_recommendation_pool_v2_cutover_runs
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_pool_v2_cutover_runs
  FORCE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_pool_v2_cutover_project_facts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_pool_v2_cutover_project_facts
  FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backlink_pool_v2_cutover_run_internal_policy
  ON backlink_recommendation_pool_v2_cutover_runs;
CREATE POLICY backlink_pool_v2_cutover_run_internal_policy
  ON backlink_recommendation_pool_v2_cutover_runs
  TO growthos_backlinks_owner
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_fact_internal_policy
  ON backlink_recommendation_pool_v2_cutover_project_facts;
CREATE POLICY backlink_pool_v2_cutover_fact_internal_policy
  ON backlink_recommendation_pool_v2_cutover_project_facts
  TO growthos_backlinks_owner
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_context_read_policy
  ON backlink_project_context_snapshots;
CREATE POLICY backlink_pool_v2_cutover_context_read_policy
  ON backlink_project_context_snapshots
  FOR SELECT
  TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_contract_read_policy
  ON backlink_recommendation_pool_project_contracts;
CREATE POLICY backlink_pool_v2_cutover_contract_read_policy
  ON backlink_recommendation_pool_project_contracts
  FOR SELECT
  TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_generation_read_policy
  ON backlink_recommendation_generation_contracts;
CREATE POLICY backlink_pool_v2_cutover_generation_read_policy
  ON backlink_recommendation_generation_contracts
  FOR SELECT
  TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_batch_read_policy
  ON backlink_recommendation_release_batches;
CREATE POLICY backlink_pool_v2_cutover_batch_read_policy
  ON backlink_recommendation_release_batches
  FOR SELECT
  TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_item_read_policy
  ON backlink_recommendation_release_batch_items;
CREATE POLICY backlink_pool_v2_cutover_item_read_policy
  ON backlink_recommendation_release_batch_items
  FOR SELECT
  TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_job_read_policy
  ON backlink_jobs;
CREATE POLICY backlink_pool_v2_cutover_job_read_policy
  ON backlink_jobs
  FOR SELECT
  TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_refill_read_policy
  ON backlink_recommendation_refills;
CREATE POLICY backlink_pool_v2_cutover_refill_read_policy
  ON backlink_recommendation_refills
  FOR SELECT
  TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_outbox_read_policy
  ON backlink_outbox_events;
CREATE POLICY backlink_pool_v2_cutover_outbox_read_policy
  ON backlink_outbox_events
  FOR SELECT
  TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_claim_read_policy
  ON backlink_recommendation_claims;
CREATE POLICY backlink_pool_v2_cutover_claim_read_policy
  ON backlink_recommendation_claims
  FOR SELECT
  TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_provider_request_read_policy
  ON provider_batch_requests;
CREATE POLICY backlink_pool_v2_cutover_provider_request_read_policy
  ON provider_batch_requests
  FOR SELECT
  TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_provider_usage_read_policy
  ON backlink_provider_usage_ledger;
CREATE POLICY backlink_pool_v2_cutover_provider_usage_read_policy
  ON backlink_provider_usage_ledger
  FOR SELECT
  TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_provider_lease_read_policy
  ON provider_fetch_leases;
CREATE POLICY backlink_pool_v2_cutover_provider_lease_read_policy
  ON provider_fetch_leases
  FOR SELECT
  TO growthos_backlinks_owner
  USING (true);

DROP TRIGGER IF EXISTS backlink_pool_v2_cutover_fact_immutable_trg
  ON backlink_recommendation_pool_v2_cutover_project_facts;
CREATE TRIGGER backlink_pool_v2_cutover_fact_immutable_trg
BEFORE UPDATE OR DELETE
ON backlink_recommendation_pool_v2_cutover_project_facts
FOR EACH ROW
EXECUTE FUNCTION backlink_reject_pool_v2_immutable();

CREATE OR REPLACE FUNCTION backlink_recommendation_pool_v2_start_cutover_run(
  p_run_id uuid,
  p_command_id text,
  p_mode text,
  p_actor text
)
RETURNS TABLE (
  id uuid,
  command_id text,
  mode text,
  status text,
  eligible_project_count integer,
  v2_active_project_count integer,
  input_required_project_count integer,
  migration_blocked_project_count integer,
  verification jsonb,
  started_at timestamptz,
  completed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  existing_mode text;
BEGIN
  IF p_run_id IS NULL
     OR length(btrim(p_command_id)) = 0
     OR p_mode NOT IN ('PLAN', 'EXECUTE')
     OR length(btrim(p_actor)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid recommendation pool V2 cutover command.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('recommendation-pool-v2-cutover:' || p_command_id, 0)
  );

  SELECT run.mode
    INTO existing_mode
    FROM backlink_recommendation_pool_v2_cutover_runs AS run
   WHERE run.command_id = p_command_id;

  IF FOUND AND existing_mode <> p_mode THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Cutover command mode does not match the existing run.';
  END IF;

  INSERT INTO backlink_recommendation_pool_v2_cutover_runs (
    id,
    command_id,
    mode,
    created_by,
    updated_by
  ) VALUES (
    p_run_id,
    p_command_id,
    p_mode,
    p_actor,
    p_actor
  )
  ON CONFLICT ON CONSTRAINT backlink_pool_v2_cutover_run_command_uq
  DO NOTHING;

  RETURN QUERY
  SELECT run.id,
         run.command_id,
         run.mode,
         run.status,
         run.eligible_project_count,
         run.v2_active_project_count,
         run.input_required_project_count,
         run.migration_blocked_project_count,
         run.verification,
         run.started_at,
         run.completed_at
    FROM backlink_recommendation_pool_v2_cutover_runs AS run
   WHERE run.command_id = p_command_id;
END;
$function$;

CREATE OR REPLACE FUNCTION
  backlink_recommendation_pool_v2_list_cutover_projects()
RETURNS TABLE (
  organization_id uuid,
  workspace_id uuid,
  website_project_id uuid,
  project_context_snapshot_id uuid,
  project_context_snapshot_version integer
)
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
           snapshot.id,
           snapshot.snapshot_version,
           snapshot.project_status
      FROM backlink_project_context_snapshots AS snapshot
     ORDER BY snapshot.organization_id,
              snapshot.workspace_id,
              snapshot.website_project_id,
              snapshot.snapshot_version DESC,
              snapshot.created_at DESC,
              snapshot.id DESC
  )
  SELECT latest.organization_id,
         latest.workspace_id,
         latest.website_project_id,
         latest.id,
         latest.snapshot_version
    FROM latest
   WHERE latest.project_status = 'ACTIVE'
   ORDER BY latest.organization_id,
            latest.workspace_id,
            latest.website_project_id;
$function$;

CREATE OR REPLACE FUNCTION
  backlink_recommendation_pool_v2_record_cutover_fact(
    p_id uuid,
    p_run_id uuid,
    p_organization_id uuid,
    p_workspace_id uuid,
    p_website_project_id uuid,
    p_project_context_snapshot_id uuid,
    p_project_context_snapshot_version integer,
    p_phase text,
    p_result text,
    p_reason_codes jsonb,
    p_generation_contract_id uuid,
    p_pool_contract_version text,
    p_recommendation_context_version_id uuid,
    p_visible_pool_generation integer,
    p_input_pin_id uuid,
    p_canonical_batch_count integer,
    p_available_batch_count integer,
    p_canonical_item_count integer,
    p_actor text,
    p_observed_at timestamptz
  )
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  run_status text;
  existing backlink_recommendation_pool_v2_cutover_project_facts%ROWTYPE;
BEGIN
  SELECT run.status
    INTO run_status
    FROM backlink_recommendation_pool_v2_cutover_runs AS run
   WHERE run.id = p_run_id
   FOR UPDATE;

  IF NOT FOUND OR run_status <> 'RUNNING' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Cutover facts can only be recorded for a running command.';
  END IF;

  IF p_id IS NULL
     OR length(btrim(p_actor)) = 0
     OR p_observed_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid recommendation pool V2 cutover fact.';
  END IF;

  INSERT INTO backlink_recommendation_pool_v2_cutover_project_facts (
    id,
    run_id,
    organization_id,
    workspace_id,
    website_project_id,
    project_context_snapshot_id,
    project_context_snapshot_version,
    phase,
    result,
    reason_codes,
    generation_contract_id,
    pool_contract_version,
    recommendation_context_version_id,
    visible_pool_generation,
    input_pin_id,
    canonical_batch_count,
    available_batch_count,
    canonical_item_count,
    observed_at,
    created_by
  ) VALUES (
    p_id,
    p_run_id,
    p_organization_id,
    p_workspace_id,
    p_website_project_id,
    p_project_context_snapshot_id,
    p_project_context_snapshot_version,
    p_phase,
    p_result,
    COALESCE(p_reason_codes, '[]'::jsonb),
    p_generation_contract_id,
    p_pool_contract_version,
    p_recommendation_context_version_id,
    p_visible_pool_generation,
    p_input_pin_id,
    p_canonical_batch_count,
    p_available_batch_count,
    p_canonical_item_count,
    p_observed_at,
    p_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT fact.*
    INTO existing
    FROM backlink_recommendation_pool_v2_cutover_project_facts AS fact
   WHERE fact.run_id = p_run_id
     AND fact.organization_id = p_organization_id
     AND fact.workspace_id = p_workspace_id
     AND fact.website_project_id = p_website_project_id
     AND fact.phase = p_phase;

  IF NOT FOUND
     OR existing.project_context_snapshot_id IS DISTINCT FROM
          p_project_context_snapshot_id
     OR existing.project_context_snapshot_version IS DISTINCT FROM
          p_project_context_snapshot_version
     OR existing.result IS DISTINCT FROM p_result
     OR existing.reason_codes IS DISTINCT FROM
          COALESCE(p_reason_codes, '[]'::jsonb)
     OR existing.generation_contract_id IS DISTINCT FROM
          p_generation_contract_id
     OR existing.pool_contract_version IS DISTINCT FROM
          p_pool_contract_version
     OR existing.recommendation_context_version_id IS DISTINCT FROM
          p_recommendation_context_version_id
     OR existing.visible_pool_generation IS DISTINCT FROM
          p_visible_pool_generation
     OR existing.input_pin_id IS DISTINCT FROM p_input_pin_id
     OR existing.canonical_batch_count IS DISTINCT FROM
          p_canonical_batch_count
     OR existing.available_batch_count IS DISTINCT FROM
          p_available_batch_count
     OR existing.canonical_item_count IS DISTINCT FROM
          p_canonical_item_count
     OR existing.observed_at IS DISTINCT FROM p_observed_at
     OR existing.created_by IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Cutover fact conflicts with an immutable recorded fact.';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION
  backlink_recommendation_pool_v2_list_cutover_facts(p_run_id uuid)
RETURNS TABLE (
  id uuid,
  run_id uuid,
  organization_id uuid,
  workspace_id uuid,
  website_project_id uuid,
  project_context_snapshot_id uuid,
  project_context_snapshot_version integer,
  phase text,
  result text,
  reason_codes jsonb,
  generation_contract_id uuid,
  pool_contract_version text,
  recommendation_context_version_id uuid,
  visible_pool_generation integer,
  input_pin_id uuid,
  canonical_batch_count integer,
  available_batch_count integer,
  canonical_item_count integer,
  observed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT fact.id,
         fact.run_id,
         fact.organization_id,
         fact.workspace_id,
         fact.website_project_id,
         fact.project_context_snapshot_id,
         fact.project_context_snapshot_version,
         fact.phase,
         fact.result,
         fact.reason_codes,
         fact.generation_contract_id,
         fact.pool_contract_version,
         fact.recommendation_context_version_id,
         fact.visible_pool_generation,
         fact.input_pin_id,
         fact.canonical_batch_count,
         fact.available_batch_count,
         fact.canonical_item_count,
         fact.observed_at
    FROM backlink_recommendation_pool_v2_cutover_project_facts AS fact
   WHERE fact.run_id = p_run_id
   ORDER BY fact.organization_id,
            fact.workspace_id,
            fact.website_project_id,
            fact.phase;
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
                    item.candidate_id IS NULL
                    OR item.recommendation_id IS NULL
                    OR item.prospect_id IS NULL
                    OR item.inventory_id IS NULL
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

CREATE OR REPLACE FUNCTION
  backlink_recommendation_pool_v2_finish_cutover_run(
    p_run_id uuid,
    p_status text,
    p_eligible_project_count integer,
    p_v2_active_project_count integer,
    p_input_required_project_count integer,
    p_migration_blocked_project_count integer,
    p_verification jsonb,
    p_actor text,
    p_completed_at timestamptz
  )
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  existing backlink_recommendation_pool_v2_cutover_runs%ROWTYPE;
BEGIN
  IF p_status NOT IN (
       'PLANNED',
       'INPUT_REQUIRED',
       'MIGRATION_BLOCKED',
       'COMPLETED'
     )
     OR p_eligible_project_count < 0
     OR p_v2_active_project_count < 0
     OR p_input_required_project_count < 0
     OR p_migration_blocked_project_count < 0
     OR jsonb_typeof(p_verification) <> 'object'
     OR length(btrim(p_actor)) = 0
     OR p_completed_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid cutover completion payload.';
  END IF;

  IF p_status = 'COMPLETED'
     AND COALESCE((p_verification->>'completed')::boolean, false) = false THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'A completed cutover requires verified V2 project facts.';
  END IF;

  SELECT run.*
    INTO existing
    FROM backlink_recommendation_pool_v2_cutover_runs AS run
   WHERE run.id = p_run_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Cutover run was not found.';
  END IF;

  IF existing.status <> 'RUNNING' THEN
    IF existing.status IS DISTINCT FROM p_status
       OR existing.eligible_project_count IS DISTINCT FROM
            p_eligible_project_count
       OR existing.v2_active_project_count IS DISTINCT FROM
            p_v2_active_project_count
       OR existing.input_required_project_count IS DISTINCT FROM
            p_input_required_project_count
       OR existing.migration_blocked_project_count IS DISTINCT FROM
            p_migration_blocked_project_count
       OR existing.verification IS DISTINCT FROM p_verification
       OR existing.completed_at IS DISTINCT FROM p_completed_at
       OR existing.updated_by IS DISTINCT FROM p_actor THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Cutover completion conflicts with an immutable result.';
    END IF;
    RETURN;
  END IF;

  UPDATE backlink_recommendation_pool_v2_cutover_runs
     SET status = p_status,
         eligible_project_count = p_eligible_project_count,
         v2_active_project_count = p_v2_active_project_count,
         input_required_project_count = p_input_required_project_count,
         migration_blocked_project_count =
           p_migration_blocked_project_count,
         verification = p_verification,
         completed_at = p_completed_at,
         updated_by = p_actor,
         version = version + 1
   WHERE id = p_run_id;
END;
$function$;

REVOKE ALL
  ON backlink_recommendation_pool_v2_cutover_runs
  FROM PUBLIC;
REVOKE ALL
  ON backlink_recommendation_pool_v2_cutover_project_facts
  FROM PUBLIC;

GRANT SELECT
  ON backlink_recommendation_pool_v2_cutover_runs
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_recommendation_pool_v2_cutover_project_facts
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_recommendation_pool_v2_cutover_runs
  TO growthos_reporting_reader;
GRANT SELECT
  ON backlink_recommendation_pool_v2_cutover_project_facts
  TO growthos_reporting_reader;

REVOKE ALL
  ON FUNCTION backlink_recommendation_pool_v2_start_cutover_run(
    uuid,
    text,
    text,
    text
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_recommendation_pool_v2_list_cutover_projects()
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_recommendation_pool_v2_record_cutover_fact(
    uuid,
    uuid,
    uuid,
    uuid,
    uuid,
    uuid,
    integer,
    text,
    text,
    jsonb,
    uuid,
    text,
    uuid,
    integer,
    uuid,
    integer,
    integer,
    integer,
    text,
    timestamptz
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_recommendation_pool_v2_list_cutover_facts(uuid)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_recommendation_pool_v2_verify_cutover()
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_recommendation_pool_v2_finish_cutover_run(
    uuid,
    text,
    integer,
    integer,
    integer,
    integer,
    jsonb,
    text,
    timestamptz
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION backlink_recommendation_pool_v2_start_cutover_run(
    uuid,
    text,
    text,
    text
  )
  TO growthos_backlinks_writer;
GRANT EXECUTE
  ON FUNCTION backlink_recommendation_pool_v2_list_cutover_projects()
  TO growthos_backlinks_writer;
GRANT EXECUTE
  ON FUNCTION backlink_recommendation_pool_v2_record_cutover_fact(
    uuid,
    uuid,
    uuid,
    uuid,
    uuid,
    uuid,
    integer,
    text,
    text,
    jsonb,
    uuid,
    text,
    uuid,
    integer,
    uuid,
    integer,
    integer,
    integer,
    text,
    timestamptz
  )
  TO growthos_backlinks_writer;
GRANT EXECUTE
  ON FUNCTION backlink_recommendation_pool_v2_list_cutover_facts(uuid)
  TO growthos_backlinks_writer;
GRANT EXECUTE
  ON FUNCTION backlink_recommendation_pool_v2_verify_cutover()
  TO growthos_backlinks_writer;
GRANT EXECUTE
  ON FUNCTION backlink_recommendation_pool_v2_finish_cutover_run(
    uuid,
    text,
    integer,
    integer,
    integer,
    integer,
    jsonb,
    text,
    timestamptz
  )
  TO growthos_backlinks_writer;

COMMIT;
