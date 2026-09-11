BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE IF NOT EXISTS backlink_recommendation_pool_v2_cutover_control (
  control_key text PRIMARY KEY,
  state text NOT NULL,
  frozen_by_run_id uuid,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  frozen_by text NOT NULL,
  CONSTRAINT backlink_pool_v2_cutover_control_values_ck CHECK (
    control_key = 'GLOBAL'
    AND state = 'V1_WRITES_FROZEN'
    AND length(btrim(frozen_by)) > 0
  )
);

ALTER TABLE backlink_recommendation_pool_v2_cutover_control
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_pool_v2_cutover_control
  FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backlink_pool_v2_cutover_control_internal_policy
  ON backlink_recommendation_pool_v2_cutover_control;
CREATE POLICY backlink_pool_v2_cutover_control_internal_policy
  ON backlink_recommendation_pool_v2_cutover_control
  TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS backlink_pool_v2_cutover_control_writer_policy
  ON backlink_recommendation_pool_v2_cutover_control;
CREATE POLICY backlink_pool_v2_cutover_control_writer_policy
  ON backlink_recommendation_pool_v2_cutover_control
  FOR SELECT TO growthos_backlinks_writer
  USING (true);

REVOKE ALL
  ON TABLE backlink_recommendation_pool_v2_cutover_control
  FROM PUBLIC;
GRANT SELECT
  ON TABLE backlink_recommendation_pool_v2_cutover_control
  TO growthos_backlinks_writer;

DROP POLICY IF EXISTS backlink_rec_refill_preclaim_internal_policy
  ON backlink_recommendation_refills;
CREATE POLICY backlink_rec_refill_preclaim_internal_policy
  ON backlink_recommendation_refills
  FOR SELECT TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_rec_generation_preclaim_internal_policy
  ON backlink_recommendation_generation_contracts;
CREATE POLICY backlink_rec_generation_preclaim_internal_policy
  ON backlink_recommendation_generation_contracts
  FOR SELECT TO growthos_backlinks_owner
  USING (true);

DROP POLICY IF EXISTS backlink_pool_project_preclaim_internal_policy
  ON backlink_recommendation_pool_project_contracts;
CREATE POLICY backlink_pool_project_preclaim_internal_policy
  ON backlink_recommendation_pool_project_contracts
  FOR SELECT TO growthos_backlinks_owner
  USING (true);

CREATE OR REPLACE FUNCTION backlink_claim_outbox_events(
  p_worker_id text,
  p_limit integer,
  p_event_type text,
  p_stale_claim_before timestamptz
)
RETURNS TABLE (
  event_id uuid,
  organization_id uuid,
  workspace_id uuid,
  website_project_id uuid,
  event_type text,
  aggregate_id uuid,
  aggregate_version integer,
  idempotency_key text,
  payload jsonb,
  payload_schema_version integer,
  status text,
  available_at timestamptz,
  attempt_count integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH claimable AS (
    SELECT event.id
      FROM backlink_outbox_events AS event
     WHERE (
             (
               event.status IN ('pending', 'failed')
               AND event.available_at <= now()
             )
             OR (
               p_stale_claim_before IS NOT NULL
               AND event.status = 'processing'
               AND event.claimed_at <= p_stale_claim_before
             )
           )
       AND event.event_type <>
         'backlinks.recommendation-refill.requested.v1'
       AND (p_event_type IS NULL OR event.event_type = p_event_type)
     ORDER BY event.available_at, event.created_at, event.id
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(p_limit, 0)
  )
  UPDATE backlink_outbox_events AS event
     SET status = 'processing',
         claimed_at = now(),
         claimed_by = p_worker_id,
         attempt_count = event.attempt_count + 1,
         updated_at = now(),
         updated_by = p_worker_id
    FROM claimable
   WHERE event.id = claimable.id
  RETURNING
    event.id,
    event.organization_id,
    event.workspace_id,
    event.website_project_id,
    event.event_type,
    event.aggregate_id,
    event.aggregate_version,
    event.idempotency_key,
    event.payload,
    event.payload_schema_version,
    event.status,
    event.available_at,
    event.attempt_count;
$function$;

CREATE OR REPLACE FUNCTION
  backlink_claim_recommendation_refill_outbox_events(
    p_worker_id text,
    p_limit integer,
    p_stale_claim_before timestamptz,
    p_organization_id uuid,
    p_workspace_id uuid,
    p_website_project_id uuid,
    p_event_id uuid
  )
RETURNS TABLE (
  event_id uuid,
  organization_id uuid,
  workspace_id uuid,
  website_project_id uuid,
  event_type text,
  aggregate_id uuid,
  aggregate_version integer,
  idempotency_key text,
  payload jsonb,
  payload_schema_version integer,
  status text,
  available_at timestamptz,
  attempt_count integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH claimable AS (
    SELECT event.id
      FROM backlink_outbox_events AS event
      JOIN backlink_jobs AS job
        ON (
          job.organization_id,
          job.workspace_id,
          job.website_project_id,
          job.id
        ) = (
          event.organization_id,
          event.workspace_id,
          event.website_project_id,
          event.aggregate_id
        )
       AND job.job_type = 'recommendation_refill'
       AND job.source_object_type = 'recommendation_context'
       AND job.source_object_id::text =
         event.payload->>'recommendationContextVersionId'
       AND job.workflow_id = event.idempotency_key
       AND job.workflow_id = event.payload->>'workflowId'
      JOIN backlink_recommendation_refills AS refill
        ON (
          refill.organization_id,
          refill.workspace_id,
          refill.website_project_id,
          refill.job_id
        ) = (
          job.organization_id,
          job.workspace_id,
          job.website_project_id,
          job.id
        )
       AND refill.recommendation_context_version_id::text =
         event.payload->>'recommendationContextVersionId'
       AND refill.visible_pool_generation::text =
         event.payload->>'visiblePoolGeneration'
       AND refill.refill_window_key =
         event.payload->>'refillWindowKey'
       AND refill.low_watermark::text =
         event.payload->>'lowWatermark'
       AND refill.high_watermark::text =
         event.payload->>'highWatermark'
      JOIN backlink_recommendation_generation_contracts AS generation
        ON (
          generation.organization_id,
          generation.workspace_id,
          generation.website_project_id,
          generation.recommendation_context_version_id,
          generation.visible_pool_generation
        ) = (
          refill.organization_id,
          refill.workspace_id,
          refill.website_project_id,
          refill.recommendation_context_version_id,
          refill.visible_pool_generation
        )
       AND generation.pool_contract_version = 'recommendation-pool.v1'
      JOIN backlink_recommendation_pool_project_contracts AS project_contract
        ON (
          project_contract.organization_id,
          project_contract.workspace_id,
          project_contract.website_project_id
        ) = (
          event.organization_id,
          event.workspace_id,
          event.website_project_id
        )
       AND project_contract.pool_contract_version = 'recommendation-pool.v1'
       AND project_contract.migration_state = 'V1_ACTIVE'
     WHERE event.event_type =
             'backlinks.recommendation-refill.requested.v1'
       AND event.payload_schema_version = 1
       AND jsonb_typeof(event.payload) = 'object'
       AND event.payload->>'contractVersion' =
             'backlinks.recommendation-refill.requested.v1'
       AND event.payload->>'organizationId' =
             event.organization_id::text
       AND event.payload->>'workspaceId' =
             event.workspace_id::text
       AND event.payload->>'websiteProjectId' =
             event.website_project_id::text
       AND event.payload->>'jobId' = event.aggregate_id::text
       AND jsonb_typeof(event.payload->'visiblePoolGeneration') = 'number'
       AND event.payload->>'visiblePoolGeneration' ~ '^[1-9][0-9]*$'
       AND jsonb_typeof(event.payload->'lowWatermark') = 'number'
       AND event.payload->>'lowWatermark' ~ '^(0|[1-9][0-9]*)$'
       AND jsonb_typeof(event.payload->'highWatermark') = 'number'
       AND event.payload->>'highWatermark' ~ '^[1-9][0-9]*$'
       AND length(btrim(event.payload->>'recommendationContextVersionId')) > 0
       AND length(btrim(event.payload->>'workflowId')) > 0
       AND length(btrim(event.payload->>'correlationId')) > 0
       AND length(btrim(event.payload->>'actorId')) > 0
       AND length(btrim(event.payload->>'refillWindowKey')) > 0
       AND (
             (
               event.status IN ('pending', 'failed')
               AND event.available_at <= now()
             )
             OR (
               p_stale_claim_before IS NOT NULL
               AND event.status = 'processing'
               AND event.claimed_at <= p_stale_claim_before
             )
           )
       AND (
         p_organization_id IS NULL
         OR event.organization_id = p_organization_id
       )
       AND (
         p_workspace_id IS NULL
         OR event.workspace_id = p_workspace_id
       )
       AND (
         p_website_project_id IS NULL
         OR event.website_project_id = p_website_project_id
       )
       AND (p_event_id IS NULL OR event.id = p_event_id)
       AND NOT EXISTS (
         SELECT 1
           FROM backlink_recommendation_pool_v2_cutover_control AS control
          WHERE control.control_key = 'GLOBAL'
            AND control.state = 'V1_WRITES_FROZEN'
       )
     ORDER BY event.available_at, event.created_at, event.id
     FOR UPDATE OF event SKIP LOCKED
     LIMIT GREATEST(p_limit, 0)
  )
  UPDATE backlink_outbox_events AS event
     SET status = 'processing',
         claimed_at = now(),
         claimed_by = p_worker_id,
         attempt_count = event.attempt_count + 1,
         updated_at = now(),
         updated_by = p_worker_id
    FROM claimable
   WHERE event.id = claimable.id
  RETURNING
    event.id,
    event.organization_id,
    event.workspace_id,
    event.website_project_id,
    event.event_type,
    event.aggregate_id,
    event.aggregate_version,
    event.idempotency_key,
    event.payload,
    event.payload_schema_version,
    event.status,
    event.available_at,
    event.attempt_count;
$function$;

REVOKE ALL
  ON FUNCTION backlink_claim_outbox_events(
    text, integer, text, timestamptz
  )
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_claim_recommendation_refill_outbox_events(
    text, integer, timestamptz, uuid, uuid, uuid, uuid
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION backlink_claim_outbox_events(
    text, integer, text, timestamptz
  )
  TO growthos_backlinks_writer;
GRANT EXECUTE
  ON FUNCTION backlink_claim_recommendation_refill_outbox_events(
    text, integer, timestamptz, uuid, uuid, uuid, uuid
  )
  TO growthos_backlinks_writer;

COMMIT;
