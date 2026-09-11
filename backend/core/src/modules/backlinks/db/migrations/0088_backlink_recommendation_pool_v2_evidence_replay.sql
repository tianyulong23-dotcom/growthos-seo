BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_recommendation_discovery_request_outcomes
  ADD COLUMN acquisition_mode text NOT NULL DEFAULT 'LIVE_PROVIDER',
  ADD COLUMN source_request_outcome_id uuid,
  ALTER COLUMN provider_request_id DROP NOT NULL,
  ALTER COLUMN provider_batch_request_id DROP NOT NULL,
  ALTER COLUMN provider_usage_ledger_id DROP NOT NULL;

ALTER TABLE backlink_recommendation_discovery_request_outcomes
  DROP CONSTRAINT backlink_discovery_outcome_values_ck,
  DROP CONSTRAINT backlink_discovery_outcome_charge_ck;

ALTER TABLE backlink_recommendation_discovery_request_outcomes
  ADD CONSTRAINT backlink_discovery_outcome_values_ck CHECK (
    pool_contract_version = 'recommendation-pool.v2'
    AND visible_pool_generation > 0
    AND raw_candidate_count >= effective_candidate_count
    AND effective_candidate_count >= 0
    AND new_unique_count >= 0
    AND duplicate_count >= 0
    AND effective_candidate_count = new_unique_count + duplicate_count
    AND status IN ('SUCCEEDED', 'PARTIAL', 'FAILED', 'UNKNOWN_CHARGE')
    AND charge_state IN ('SETTLED', 'RELEASED', 'UNKNOWN_CHARGE')
    AND acquisition_mode IN ('LIVE_PROVIDER', 'EVIDENCE_REPLAY')
    AND (
      provider_task_id IS NULL
      OR length(btrim(provider_task_id)) > 0
    )
    AND (
      (
        acquisition_mode = 'LIVE_PROVIDER'
        AND source_request_outcome_id IS NULL
        AND provider_request_id IS NOT NULL
        AND provider_batch_request_id IS NOT NULL
        AND provider_usage_ledger_id IS NOT NULL
      )
      OR (
        acquisition_mode = 'EVIDENCE_REPLAY'
        AND source_request_outcome_id IS NOT NULL
        AND provider_request_id IS NULL
        AND provider_batch_request_id IS NULL
        AND provider_usage_ledger_id IS NULL
        AND provider_task_id IS NULL
      )
    )
  ),
  ADD CONSTRAINT backlink_discovery_outcome_charge_ck CHECK (
    (
      acquisition_mode = 'LIVE_PROVIDER'
      AND (
        (
          charge_state = 'SETTLED'
          AND status IN ('SUCCEEDED', 'PARTIAL')
          AND actual_cost_micros BETWEEN 0 AND 1000000
          AND cumulative_cost_micros
                BETWEEN actual_cost_micros AND 2000000
          AND failure_code IS NULL
        )
        OR (
          charge_state = 'RELEASED'
          AND status = 'FAILED'
          AND actual_cost_micros = 0
          AND cumulative_cost_micros BETWEEN 0 AND 2000000
          AND length(btrim(failure_code)) > 0
        )
        OR (
          charge_state = 'UNKNOWN_CHARGE'
          AND status = 'UNKNOWN_CHARGE'
          AND actual_cost_micros IS NULL
          AND cumulative_cost_micros IS NULL
          AND length(btrim(failure_code)) > 0
        )
      )
    )
    OR (
      acquisition_mode = 'EVIDENCE_REPLAY'
      AND charge_state = 'SETTLED'
      AND status IN ('SUCCEEDED', 'PARTIAL')
      AND actual_cost_micros = 0
      AND cumulative_cost_micros = 0
      AND failure_code IS NULL
    )
  ),
  ADD CONSTRAINT backlink_discovery_outcome_source_fk
    FOREIGN KEY (source_request_outcome_id)
    REFERENCES backlink_recommendation_discovery_request_outcomes (id)
    ON DELETE RESTRICT;

CREATE INDEX backlink_discovery_outcome_source_idx
  ON backlink_recommendation_discovery_request_outcomes (
    organization_id, workspace_id, website_project_id,
    source_request_outcome_id, finished_at
  )
  WHERE acquisition_mode = 'EVIDENCE_REPLAY';

CREATE OR REPLACE FUNCTION backlink_validate_discovery_request_outcome()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  request_authorized_cost_micros bigint;
  request_started_at timestamptz;
  request_fingerprint text;
  request_discovery_source text;
  request_type text;
  request_page_type text;
  request_country_code text;
  request_language_code text;
  request_business_direction_fingerprint text;
  source_finished_at timestamptz;
  source_raw_candidate_count integer;
  source_fingerprint text;
  source_discovery_source text;
  source_request_type text;
  source_page_type text;
  source_country_code text;
  source_language_code text;
  source_business_direction_fingerprint text;
  provider_request_status text;
  provider_request_provider text;
  provider_usage_request_id uuid;
  provider_usage_provider text;
  provider_usage_reservation_key text;
  provider_usage_estimated_cost_micros bigint;
  provider_usage_actual_cost_micros bigint;
  provider_usage_status text;
  provider_batch_provider text;
  provider_batch_reservation_key text;
  provider_batch_estimated_cost_micros bigint;
  provider_batch_actual_cost_micros bigint;
  provider_batch_task_id text;
  provider_batch_status text;
BEGIN
  SELECT intent.authorized_cost_micros,
         intent.started_at,
         intent.canonical_request_fingerprint,
         intent.discovery_source,
         intent.request_type,
         intent.page_type,
         intent.country_code,
         intent.language_code,
         intent.business_direction_fingerprint
    INTO request_authorized_cost_micros,
         request_started_at,
         request_fingerprint,
         request_discovery_source,
         request_type,
         request_page_type,
         request_country_code,
         request_language_code,
         request_business_direction_fingerprint
    FROM backlink_recommendation_discovery_request_intents AS intent
   WHERE intent.organization_id = NEW.organization_id
     AND intent.workspace_id = NEW.workspace_id
     AND intent.website_project_id = NEW.website_project_id
     AND intent.id = NEW.request_intent_id
     AND intent.generation_contract_id = NEW.generation_contract_id
     AND intent.recommendation_context_version_id =
       NEW.recommendation_context_version_id
     AND intent.visible_pool_generation = NEW.visible_pool_generation
     AND intent.input_pin_id = NEW.input_pin_id
     AND intent.pool_contract_version = NEW.pool_contract_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'V2 discovery request intent lineage was not found.';
  END IF;

  IF NEW.finished_at < request_started_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Discovery request outcome cannot finish before its intent.';
  END IF;

  IF NEW.acquisition_mode = 'EVIDENCE_REPLAY' THEN
    SELECT source.finished_at,
           source.raw_candidate_count,
           source_intent.canonical_request_fingerprint,
           source_intent.discovery_source,
           source_intent.request_type,
           source_intent.page_type,
           source_intent.country_code,
           source_intent.language_code,
           source_intent.business_direction_fingerprint
      INTO source_finished_at,
           source_raw_candidate_count,
           source_fingerprint,
           source_discovery_source,
           source_request_type,
           source_page_type,
           source_country_code,
           source_language_code,
           source_business_direction_fingerprint
      FROM backlink_recommendation_discovery_request_outcomes AS source
      JOIN backlink_recommendation_discovery_request_intents AS source_intent
        ON (
          source_intent.organization_id,
          source_intent.workspace_id,
          source_intent.website_project_id,
          source_intent.id
        ) = (
          source.organization_id,
          source.workspace_id,
          source.website_project_id,
          source.request_intent_id
        )
     WHERE source.organization_id = NEW.organization_id
       AND source.workspace_id = NEW.workspace_id
       AND source.website_project_id = NEW.website_project_id
       AND source.id = NEW.source_request_outcome_id
       AND source.acquisition_mode = 'LIVE_PROVIDER'
       AND source.charge_state = 'SETTLED'
       AND source.status IN ('SUCCEEDED', 'PARTIAL')
       AND source_intent.recommendation_context_version_id =
         NEW.recommendation_context_version_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE =
          'Reusable discovery Provider evidence was not found in scope.';
    END IF;

    IF request_authorized_cost_micros <> 0
       OR NEW.actual_cost_micros <> 0
       OR NEW.cumulative_cost_micros <> 0
       OR NEW.finished_at < source_finished_at
       OR NEW.raw_candidate_count <> source_raw_candidate_count
       OR request_fingerprint <> source_fingerprint
       OR request_discovery_source <> source_discovery_source
       OR request_type <> source_request_type
       OR request_page_type <> source_page_type
       OR request_country_code <> source_country_code
       OR request_language_code <> source_language_code
       OR request_business_direction_fingerprint <>
         source_business_direction_fingerprint THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Evidence replay does not match its settled Provider source facts.';
    END IF;

    RETURN NEW;
  END IF;

  SELECT provider, status
    INTO provider_request_provider, provider_request_status
    FROM backlink_provider_requests
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = NEW.provider_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Provider request lineage was not found.';
  END IF;

  SELECT provider_request_id,
         provider,
         reservation_key,
         estimated_cost_micros,
         actual_cost_micros,
         status
    INTO provider_usage_request_id,
         provider_usage_provider,
         provider_usage_reservation_key,
         provider_usage_estimated_cost_micros,
         provider_usage_actual_cost_micros,
         provider_usage_status
    FROM backlink_provider_usage_ledger
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = NEW.provider_usage_ledger_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Provider usage lineage was not found.';
  END IF;

  SELECT provider,
         budget_reservation_id,
         estimated_cost_micros,
         actual_cost_micros,
         provider_task_id,
         status
    INTO provider_batch_provider,
         provider_batch_reservation_key,
         provider_batch_estimated_cost_micros,
         provider_batch_actual_cost_micros,
         provider_batch_task_id,
         provider_batch_status
    FROM provider_batch_requests
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = NEW.provider_batch_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Provider batch lineage was not found.';
  END IF;

  IF provider_usage_request_id <> NEW.provider_request_id
     OR provider_usage_reservation_key <> provider_batch_reservation_key
     OR provider_request_provider <> provider_usage_provider
     OR provider_request_provider <> provider_batch_provider
     OR NEW.provider_task_id IS DISTINCT FROM provider_batch_task_id
     OR provider_usage_estimated_cost_micros >
       request_authorized_cost_micros
     OR provider_batch_estimated_cost_micros >
       request_authorized_cost_micros THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Provider request, batch, and usage lineage do not describe one request.';
  END IF;

  IF NEW.charge_state = 'SETTLED'
     AND (
       provider_request_status <> 'succeeded'
       OR provider_usage_status <> 'settled'
       OR provider_batch_status NOT IN ('succeeded', 'partial')
       OR provider_usage_actual_cost_micros IS DISTINCT FROM
         NEW.actual_cost_micros
       OR provider_batch_actual_cost_micros IS DISTINCT FROM
         NEW.actual_cost_micros
       OR NEW.actual_cost_micros > request_authorized_cost_micros
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Settled discovery outcome does not match Provider facts.';
  END IF;

  IF NEW.charge_state = 'UNKNOWN_CHARGE'
     AND (
       provider_request_status <> 'unknown_charge'
       OR provider_usage_status <> 'reserved'
       OR provider_batch_status <> 'unknown_charge'
       OR provider_usage_actual_cost_micros IS NOT NULL
       OR provider_batch_actual_cost_micros IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Unknown-charge discovery outcome must retain unknown cost.';
  END IF;

  IF NEW.charge_state = 'RELEASED'
     AND (
       provider_request_status <> 'failed'
       OR provider_usage_status <> 'released'
       OR provider_batch_status <> 'failed'
       OR provider_usage_actual_cost_micros IS NOT NULL
       OR provider_batch_actual_cost_micros IS NOT NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Released discovery outcome does not match Provider facts.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION
  backlink_recommendation_pool_v2_evidence_replay_verify()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT jsonb_build_object(
    'evidenceReplayColumnsPresent',
      EXISTS (
        SELECT 1
          FROM pg_attribute
         WHERE attrelid =
           'backlinks.backlink_recommendation_discovery_request_outcomes'
             ::regclass
           AND attname = 'acquisition_mode'
           AND NOT attisdropped
      )
      AND EXISTS (
        SELECT 1
          FROM pg_attribute
         WHERE attrelid =
           'backlinks.backlink_recommendation_discovery_request_outcomes'
             ::regclass
           AND attname = 'source_request_outcome_id'
           AND NOT attisdropped
      ),
    'outcomeTriggerSupportsEvidenceReplay',
      position(
        'EVIDENCE_REPLAY'
        IN pg_get_functiondef(
          'backlinks.backlink_validate_discovery_request_outcome()'
            ::regprocedure
        )
      ) > 0,
    'v1WritesFrozen',
      backlink_phase9_v1_writes_are_frozen()
  );
$function$;

REVOKE ALL
  ON FUNCTION backlink_recommendation_pool_v2_evidence_replay_verify()
  FROM PUBLIC;
GRANT EXECUTE
  ON FUNCTION backlink_recommendation_pool_v2_evidence_replay_verify()
  TO growthos_backlinks_writer, growthos_reporting_reader;

COMMIT;
