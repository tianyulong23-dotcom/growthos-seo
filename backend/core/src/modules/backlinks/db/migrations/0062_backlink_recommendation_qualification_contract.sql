BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE backlink_generation_input_pins
  ADD CONSTRAINT backlink_generation_input_pin_contract_scope_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    qualification_contract_version, market
  );

ALTER TABLE backlink_commercial_candidates
  DROP CONSTRAINT backlink_commercial_candidate_score_version_check,
  ADD CONSTRAINT backlink_commercial_candidate_score_version_check CHECK (
    score_model_version IN (
      'recommendation-commercial-fit.v2',
      'recommendation-commercial-fit.v3',
      'recommendation-commercial-fit.v4'
    )
  );

CREATE TABLE backlink_recommendation_generation_contracts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  input_pin_id uuid NOT NULL,
  qualification_contract_version text NOT NULL,
  visibility_contract_version text NOT NULL,
  score_model_version text NOT NULL,
  metric_scope text NOT NULL,
  market text NOT NULL,
  location text NOT NULL,
  language text NOT NULL,
  traffic_location_code integer,
  traffic_language_code text,
  request_fingerprints jsonb NOT NULL,
  creator_worker_contract_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_rec_generation_scope_generation_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    recommendation_context_version_id, visible_pool_generation
  ),
  CONSTRAINT backlink_rec_generation_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_rec_generation_scope_context_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id
  ),
  CONSTRAINT backlink_rec_generation_scope_metric_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id, metric_scope
  ),
  CONSTRAINT backlink_rec_generation_values_ck CHECK (
    visible_pool_generation > 0
    AND qualification_contract_version = 'recommendation-qualification.v1'
    AND visibility_contract_version = 'recommendation-visibility.v1'
    AND score_model_version = 'recommendation-commercial-fit.v4'
    AND creator_worker_contract_version = qualification_contract_version
    AND metric_scope IN ('TARGET_MARKET', 'GLOBAL')
    AND length(btrim(market)) > 0
    AND length(btrim(location)) > 0
    AND length(btrim(language)) > 0
    AND jsonb_typeof(request_fingerprints) = 'object'
    AND (
      (
        metric_scope = 'TARGET_MARKET'
        AND traffic_location_code IS NOT NULL
        AND traffic_language_code IS NOT NULL
        AND length(btrim(traffic_language_code)) > 0
      )
      OR (
        metric_scope = 'GLOBAL'
        AND traffic_location_code IS NULL
        AND traffic_language_code IS NULL
      )
    )
  ),
  CONSTRAINT backlink_rec_generation_input_pin_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, input_pin_id,
    qualification_contract_version, market
  ) REFERENCES backlink_generation_input_pins (
    organization_id, workspace_id, website_project_id, id,
    qualification_contract_version, market
  ) ON DELETE RESTRICT
);

CREATE TABLE backlink_generation_operation_facts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  operation_id text NOT NULL,
  operation_state text NOT NULL,
  attempt integer NOT NULL,
  reason_code text NOT NULL,
  fact_contract_version text NOT NULL,
  worker_contract_version text NOT NULL,
  evidence jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CONSTRAINT backlink_generation_operation_attempt_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, operation_id, attempt
  ),
  CONSTRAINT backlink_generation_operation_values_ck CHECK (
    operation_state IN (
      'requested', 'running', 'succeeded', 'failed', 'frozen'
    )
    AND attempt > 0
    AND length(btrim(operation_id)) > 0
    AND length(btrim(reason_code)) > 0
    AND length(btrim(fact_contract_version)) > 0
    AND length(btrim(worker_contract_version)) > 0
    AND jsonb_typeof(evidence) = 'object'
  ),
  CONSTRAINT backlink_generation_operation_generation_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, recommendation_context_version_id
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id, workspace_id, website_project_id, id,
    recommendation_context_version_id
  ) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION backlink_reject_recommendation_contract_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'Backlinks recommendation contract records are immutable.';
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_enforce_generation_fact_contract()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  generation_qualification_contract text;
  generation_visibility_contract text;
  required_fact_contract text;
BEGIN
  SELECT qualification_contract_version, visibility_contract_version
    INTO generation_qualification_contract, generation_visibility_contract
    FROM backlink_recommendation_generation_contracts
   WHERE organization_id = NEW.organization_id
     AND workspace_id = NEW.workspace_id
     AND website_project_id = NEW.website_project_id
     AND id = NEW.generation_contract_id
     AND recommendation_context_version_id =
       NEW.recommendation_context_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Backlinks recommendation generation contract was not found.';
  END IF;

  IF NEW.worker_contract_version <>
       generation_qualification_contract THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Worker contract version does not match generation contract.';
  END IF;

  required_fact_contract := CASE
    WHEN TG_TABLE_NAME = 'backlink_recommendation_visibility_facts'
      THEN generation_visibility_contract
    ELSE generation_qualification_contract
  END;

  IF NEW.fact_contract_version <> required_fact_contract THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Fact contract version does not match generation contract.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER backlink_rec_generation_contract_immutable
BEFORE UPDATE OR DELETE ON backlink_recommendation_generation_contracts
FOR EACH ROW EXECUTE FUNCTION backlink_reject_recommendation_contract_mutation();

CREATE TRIGGER backlink_generation_operation_fact_immutable
BEFORE UPDATE OR DELETE ON backlink_generation_operation_facts
FOR EACH ROW EXECUTE FUNCTION backlink_reject_recommendation_contract_mutation();

CREATE TRIGGER backlink_generation_operation_contract_guard
BEFORE INSERT ON backlink_generation_operation_facts
FOR EACH ROW EXECUTE FUNCTION backlink_enforce_generation_fact_contract();

ALTER TABLE backlink_recommendation_generation_contracts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_generation_contracts
  FORCE ROW LEVEL SECURITY;
CREATE POLICY backlink_rec_generation_contract_tenant_policy
ON backlink_recommendation_generation_contracts
USING (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
)
WITH CHECK (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
);

ALTER TABLE backlink_generation_operation_facts
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_generation_operation_facts
  FORCE ROW LEVEL SECURITY;
CREATE POLICY backlink_generation_operation_fact_tenant_policy
ON backlink_generation_operation_facts
USING (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
)
WITH CHECK (
  organization_id =
    NULLIF(current_setting('app.current_organization_id', true), '')::uuid
  AND workspace_id =
    NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  AND website_project_id =
    NULLIF(current_setting('app.current_website_project_id', true), '')::uuid
);

REVOKE ALL
  ON backlink_recommendation_generation_contracts,
     backlink_generation_operation_facts
  FROM PUBLIC;
REVOKE UPDATE, DELETE
  ON backlink_recommendation_generation_contracts,
     backlink_generation_operation_facts
  FROM growthos_backlinks_writer;

GRANT SELECT, INSERT
  ON backlink_recommendation_generation_contracts,
     backlink_generation_operation_facts
  TO growthos_backlinks_writer;
GRANT SELECT
  ON backlink_recommendation_generation_contracts,
     backlink_generation_operation_facts
  TO growthos_reporting_reader;

COMMIT;
