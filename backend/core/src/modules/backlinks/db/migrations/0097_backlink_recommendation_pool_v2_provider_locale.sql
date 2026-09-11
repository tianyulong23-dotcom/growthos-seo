BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE OR REPLACE FUNCTION backlink_validate_discovery_request_intent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  generation_policy_version text;
  generation_country_code text;
  generation_language_code text;
  pinned_country_code text;
  pinned_business_direction_fingerprint text;
  persisted_seed_kind text;
  persisted_seed_source text;
  round_authorized_cost_micros bigint;
  generation_authorized_cost_micros bigint;
BEGIN
  -- Provider language is the base language of the immutable project locale.
  SELECT generation.discovery_budget_policy_version,
         upper(btrim(generation.market)),
         split_part(replace(lower(btrim(generation.language)), '_', '-'), '-', 1),
         upper(btrim(input_pin.market)),
         input_pin.immutable_fingerprint,
         seed.seed_kind,
         seed.source
    INTO generation_policy_version,
         generation_country_code,
         generation_language_code,
         pinned_country_code,
         pinned_business_direction_fingerprint,
         persisted_seed_kind,
         persisted_seed_source
    FROM backlink_recommendation_generation_contracts AS generation
    JOIN backlink_generation_input_pins AS input_pin
      ON (
        input_pin.organization_id,
        input_pin.workspace_id,
        input_pin.website_project_id,
        input_pin.id
      ) = (
        generation.organization_id,
        generation.workspace_id,
        generation.website_project_id,
        generation.input_pin_id
      )
    JOIN backlink_commercial_discovery_seeds AS seed
      ON seed.organization_id = generation.organization_id
     AND seed.workspace_id = generation.workspace_id
     AND seed.website_project_id = generation.website_project_id
     AND seed.generation_contract_id = generation.id
     AND seed.recommendation_context_version_id =
       generation.recommendation_context_version_id
     AND seed.visible_pool_generation = generation.visible_pool_generation
     AND seed.input_pin_id = generation.input_pin_id
     AND seed.id = NEW.seed_id
     AND seed.seed_fingerprint = NEW.seed_fingerprint
   WHERE generation.organization_id = NEW.organization_id
     AND generation.workspace_id = NEW.workspace_id
     AND generation.website_project_id = NEW.website_project_id
     AND generation.id = NEW.generation_contract_id
     AND generation.recommendation_context_version_id =
       NEW.recommendation_context_version_id
     AND generation.visible_pool_generation = NEW.visible_pool_generation
     AND generation.input_pin_id = NEW.input_pin_id
     AND generation.pool_contract_version = NEW.pool_contract_version
   FOR UPDATE OF generation;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'V2 discovery generation or seed lineage was not found.';
  END IF;

  IF NEW.discovery_budget_policy_version <> generation_policy_version
     OR NEW.country_code <> generation_country_code
     OR NEW.country_code <> pinned_country_code
     OR generation_language_code !~ '^[a-z]{2,3}$'
     OR NEW.language_code <> generation_language_code
     OR NEW.business_direction_fingerprint <>
       pinned_business_direction_fingerprint
     OR NEW.seed_kind <> persisted_seed_kind
     OR NEW.seed_source <> persisted_seed_source THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
         'V2 discovery request scope differs from its pinned generation facts.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_recommendation_discovery_request_intents AS intent
     WHERE intent.organization_id = NEW.organization_id
       AND intent.workspace_id = NEW.workspace_id
       AND intent.website_project_id = NEW.website_project_id
       AND intent.generation_contract_id = NEW.generation_contract_id
       AND intent.round_number = NEW.round_number
       AND intent.discovery_window_ordinal = NEW.discovery_window_ordinal
       AND intent.canonical_request_fingerprint =
         NEW.canonical_request_fingerprint
       AND intent.canonical_path_fingerprint = NEW.canonical_path_fingerprint
       AND intent.authorized_cost_micros = NEW.authorized_cost_micros
       AND intent.idempotency_key = NEW.idempotency_key
       AND intent.idempotency_hash = NEW.idempotency_hash
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_recommendation_discovery_generation_terminal_facts
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND generation_contract_id = NEW.generation_contract_id
  ) OR EXISTS (
    SELECT 1
      FROM backlink_recommendation_discovery_round_facts
     WHERE organization_id = NEW.organization_id
       AND workspace_id = NEW.workspace_id
       AND website_project_id = NEW.website_project_id
       AND generation_contract_id = NEW.generation_contract_id
       AND round_number = NEW.round_number
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Discovery request intent cannot extend a completed fact.';
  END IF;

  SELECT
    COALESCE(
      sum(intent.authorized_cost_micros)
        FILTER (WHERE intent.round_number = NEW.round_number),
      0
    )::bigint,
    COALESCE(sum(intent.authorized_cost_micros), 0)::bigint
    INTO round_authorized_cost_micros,
         generation_authorized_cost_micros
    FROM backlink_recommendation_discovery_request_intents AS intent
   WHERE intent.organization_id = NEW.organization_id
     AND intent.workspace_id = NEW.workspace_id
     AND intent.website_project_id = NEW.website_project_id
     AND intent.generation_contract_id = NEW.generation_contract_id;

  IF round_authorized_cost_micros + NEW.authorized_cost_micros > 1000000
     OR generation_authorized_cost_micros + NEW.authorized_cost_micros >
       2000000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Discovery request authorization exceeds the persisted generation budget.';
  END IF;

  IF NEW.round_number = 2
     AND NOT EXISTS (
       SELECT 1
         FROM backlink_recommendation_discovery_round_facts AS round_fact
        WHERE round_fact.organization_id = NEW.organization_id
          AND round_fact.workspace_id = NEW.workspace_id
          AND round_fact.website_project_id = NEW.website_project_id
          AND round_fact.generation_contract_id = NEW.generation_contract_id
          AND round_fact.round_number = 1
          AND round_fact.discovery_budget_policy_version =
            NEW.discovery_budget_policy_version
          AND round_fact.charge_state = 'SETTLED'
          AND round_fact.policy_decision = 'START_ROUND_2'
          AND round_fact.new_unique_count < 100
      ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Round 2 requires a settled Round 1 fact authorizing another path.';
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION backlink_validate_discovery_request_intent()
  OWNER TO growthos_backlinks_owner;
REVOKE ALL ON FUNCTION backlink_validate_discovery_request_intent() FROM PUBLIC;

COMMIT;
