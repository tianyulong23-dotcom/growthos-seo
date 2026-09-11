BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE backlink_recommendation_pool_v2_timing_events (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  website_project_id uuid NOT NULL,
  generation_contract_id uuid NOT NULL,
  recommendation_context_version_id uuid NOT NULL,
  visible_pool_generation integer NOT NULL,
  input_pin_id uuid NOT NULL,
  job_id uuid NOT NULL,
  workflow_id text NOT NULL,
  command_id text NOT NULL,
  event_type text NOT NULL,
  round_number integer,
  request_intent_id uuid,
  generation_candidate_id uuid,
  batch_id uuid,
  observed_state text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by text NOT NULL,
  CONSTRAINT backlink_pool_v2_timing_scope_id_uq UNIQUE (
    organization_id, workspace_id, website_project_id, id
  ),
  CONSTRAINT backlink_pool_v2_timing_idempotency_uq UNIQUE (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, idempotency_key
  ),
  CONSTRAINT backlink_pool_v2_timing_values_ck CHECK (
    visible_pool_generation > 0
    AND event_type IN (
      'COMMAND_ACCEPTED',
      'WORKFLOW_SCHEDULED',
      'WORKFLOW_STARTED',
      'SEED_SNAPSHOT_LOADED',
      'REQUEST_PLAN_CREATED',
      'PROVIDER_REQUEST_QUEUED',
      'PROVIDER_REQUEST_STARTED',
      'PROVIDER_REQUEST_COMPLETED',
      'PROVIDER_OUTCOME_PERSISTED',
      'CANDIDATE_NORMALIZATION_STARTED',
      'CANDIDATE_NORMALIZATION_COMPLETED',
      'CANDIDATE_ADMISSION_STARTED',
      'CANDIDATE_ADMISSION_COMPLETED',
      'METRIC_ENRICHMENT_STARTED',
      'METRIC_ENRICHMENT_COMPLETED',
      'CONTACT_ENRICHMENT_STARTED',
      'CONTACT_ENRICHMENT_COMPLETED',
      'BATCH_PREPARED',
      'PUBLICATION_COMMITTED',
      'FRONTEND_STATE_FIRST_OBSERVED'
    )
    AND (round_number IS NULL OR round_number IN (1, 2))
    AND length(btrim(workflow_id)) > 0
    AND length(btrim(command_id)) > 0
    AND length(btrim(idempotency_key)) > 0
    AND length(btrim(created_by)) > 0
    AND jsonb_typeof(details) = 'object'
  ),
  CONSTRAINT backlink_pool_v2_timing_generation_fk
    FOREIGN KEY (generation_contract_id)
    REFERENCES backlink_recommendation_generation_contracts (id)
    ON DELETE RESTRICT,
  CONSTRAINT backlink_pool_v2_timing_job_fk FOREIGN KEY (
    organization_id, workspace_id, website_project_id, job_id
  ) REFERENCES backlink_jobs (
    organization_id, workspace_id, website_project_id, id
  ) ON DELETE RESTRICT,
  CONSTRAINT backlink_pool_v2_timing_request_fk
    FOREIGN KEY (request_intent_id)
    REFERENCES backlink_recommendation_discovery_request_intents (id)
    ON DELETE RESTRICT,
  CONSTRAINT backlink_pool_v2_timing_candidate_fk
    FOREIGN KEY (generation_candidate_id)
    REFERENCES backlink_recommendation_generation_candidates (id)
    ON DELETE RESTRICT,
  CONSTRAINT backlink_pool_v2_timing_batch_fk
    FOREIGN KEY (batch_id)
    REFERENCES backlink_recommendation_release_batches (id)
    ON DELETE RESTRICT
);

CREATE INDEX backlink_pool_v2_timing_generation_time_idx
  ON backlink_recommendation_pool_v2_timing_events (
    organization_id, workspace_id, website_project_id,
    generation_contract_id, occurred_at, id
  );

CREATE INDEX backlink_pool_v2_timing_request_time_idx
  ON backlink_recommendation_pool_v2_timing_events (
    organization_id, workspace_id, website_project_id,
    request_intent_id, occurred_at
  )
  WHERE request_intent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION backlink_reject_pool_v2_timing_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'Recommendation pool V2 timing events are immutable.';
END;
$function$;

CREATE TRIGGER backlink_pool_v2_timing_immutable
BEFORE UPDATE OR DELETE ON backlink_recommendation_pool_v2_timing_events
FOR EACH ROW EXECUTE FUNCTION backlink_reject_pool_v2_timing_mutation();

ALTER TABLE backlink_recommendation_pool_v2_timing_events
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_pool_v2_timing_events
  FORCE ROW LEVEL SECURITY;

CREATE POLICY backlink_pool_v2_timing_tenant_policy
ON backlink_recommendation_pool_v2_timing_events
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
  ON backlink_recommendation_pool_v2_timing_events
  FROM PUBLIC;

GRANT SELECT, INSERT
  ON backlink_recommendation_pool_v2_timing_events
  TO growthos_backlinks_writer;

GRANT SELECT
  ON backlink_recommendation_pool_v2_timing_events
  TO growthos_reporting_reader;

COMMENT ON TABLE backlink_recommendation_pool_v2_timing_events IS
  'Append-only Gate 7 timing facts for exact native V2 generation lineage.';

COMMIT;
