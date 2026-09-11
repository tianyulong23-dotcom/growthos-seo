BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

CREATE TABLE IF NOT EXISTS backlink_recommendation_pool_v2_phase9_runs (
  id uuid PRIMARY KEY,
  command_id text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL,
  verification jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_by text NOT NULL,
  CONSTRAINT backlink_pool_v2_phase9_run_command_uq UNIQUE (command_id),
  CONSTRAINT backlink_pool_v2_phase9_run_values_ck CHECK (
    length(btrim(command_id)) > 0
    AND mode IN ('PLAN', 'EXECUTE', 'VERIFY')
    AND status IN ('PLANNED', 'BLOCKED', 'COMPLETED')
    AND jsonb_typeof(verification) = 'object'
    AND completed_at >= started_at
    AND length(btrim(created_by)) > 0
  )
);

ALTER TABLE backlink_recommendation_pool_v2_phase9_runs
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backlink_recommendation_pool_v2_phase9_runs
  FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backlink_pool_v2_phase9_run_internal_policy
  ON backlink_recommendation_pool_v2_phase9_runs;
CREATE POLICY backlink_pool_v2_phase9_run_internal_policy
  ON backlink_recommendation_pool_v2_phase9_runs
  TO growthos_backlinks_owner
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS backlink_pool_v2_phase9_run_writer_policy
  ON backlink_recommendation_pool_v2_phase9_runs;
CREATE POLICY backlink_pool_v2_phase9_run_writer_policy
  ON backlink_recommendation_pool_v2_phase9_runs
  FOR SELECT
  TO growthos_backlinks_writer, growthos_reporting_reader
  USING (true);

REVOKE ALL
  ON TABLE backlink_recommendation_pool_v2_phase9_runs
  FROM PUBLIC;
GRANT SELECT
  ON TABLE backlink_recommendation_pool_v2_phase9_runs
  TO growthos_backlinks_writer, growthos_reporting_reader;

CREATE OR REPLACE FUNCTION backlink_phase9_v1_writes_are_frozen()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM backlink_recommendation_pool_v2_cutover_control AS control
     WHERE control.control_key = 'GLOBAL'
       AND control.state = 'V1_WRITES_FROZEN'
  );
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_provider_batch_is_allowed(
  p_record jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_workspace_id uuid;
  v_website_project_id uuid;
  v_request_id text;
  v_budget_reservation_id text;
BEGIN
  IF p_record IS NULL
     OR p_record->>'organization_id' IS NULL
     OR p_record->>'workspace_id' IS NULL
     OR p_record->>'website_project_id' IS NULL
     OR p_record->>'provider' <> 'dataforseo'
     OR p_record->>'request_intent' IS NULL
     OR p_record->>'normalized_request_hash' !~ '^[a-f0-9]{64}$'
     OR p_record->>'estimated_cost_micros' IS NULL
     OR p_record->>'request_id' IS NULL
     OR p_record->>'budget_reservation_id' IS NULL
     OR p_record->>'created_by' IS NULL THEN
    RETURN false;
  END IF;

  v_organization_id := (p_record->>'organization_id')::uuid;
  v_workspace_id := (p_record->>'workspace_id')::uuid;
  v_website_project_id := (p_record->>'website_project_id')::uuid;
  v_request_id := p_record->>'request_id';
  v_budget_reservation_id := p_record->>'budget_reservation_id';

  IF v_request_id ~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND v_budget_reservation_id = v_request_id
     AND p_record->>'created_by' = v_request_id
     AND p_record->>'request_intent' = 'DISCOVERY'
     AND EXISTS (
      SELECT 1
        FROM backlink_jobs AS job
       WHERE job.organization_id = v_organization_id
         AND job.workspace_id = v_workspace_id
         AND job.website_project_id = v_website_project_id
         AND job.id = v_request_id::uuid
         AND job.job_type = 'project-analysis'
         AND job.source_object_type = 'project-context-snapshot'
     ) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM backlink_recommendation_discovery_request_intents AS intent
     WHERE intent.organization_id = v_organization_id
       AND intent.workspace_id = v_workspace_id
       AND intent.website_project_id = v_website_project_id
       AND intent.pool_contract_version = 'recommendation-pool.v2'
       AND intent.canonical_request_fingerprint =
             p_record->>'normalized_request_hash'
       AND intent.language_code = p_record->>'language_code'
       AND (p_record->>'estimated_cost_micros')::bigint
             <= intent.authorized_cost_micros
       AND p_record->>'request_intent' = 'DISCOVERY'
       AND v_request_id IN (intent.id::text, intent.idempotency_key)
       AND v_budget_reservation_id IN (
         intent.id::text,
         intent.idempotency_key
       )
       AND p_record->>'created_by' = v_request_id
  );
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_provider_request_is_allowed(
  p_record jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_workspace_id uuid;
  v_website_project_id uuid;
  v_request_id uuid;
BEGIN
  IF p_record IS NULL
     OR p_record->>'id' IS NULL
     OR p_record->>'organization_id' IS NULL
     OR p_record->>'workspace_id' IS NULL
     OR p_record->>'website_project_id' IS NULL
     OR p_record->>'provider' <> 'dataforseo'
     OR p_record->>'endpoint' IS NULL
     OR p_record->>'request_fingerprint' !~ '^[a-f0-9]{64}$'
     OR p_record->>'active_request_bucket' IS NULL
     OR p_record->>'created_by' IS NULL
     OR jsonb_typeof(p_record->'request_payload') <> 'object' THEN
    RETURN false;
  END IF;

  v_organization_id := (p_record->>'organization_id')::uuid;
  v_workspace_id := (p_record->>'workspace_id')::uuid;
  v_website_project_id := (p_record->>'website_project_id')::uuid;
  v_request_id := (p_record->>'id')::uuid;

  IF EXISTS (
    SELECT 1
      FROM backlink_profile_sync_jobs AS profile_job
     WHERE profile_job.organization_id = v_organization_id
       AND profile_job.workspace_id = v_workspace_id
       AND profile_job.website_project_id = v_website_project_id
       AND profile_job.provider = 'dataforseo'
       AND profile_job.created_by = p_record->>'created_by'
       AND p_record->>'endpoint' IN (
         '/v3/backlinks/summary/live',
         '/v3/backlinks/backlinks/live'
       )
       AND p_record->'request_payload'->>'requestIntent' = 'MONITORING'
       AND lower(btrim(p_record->'request_payload'->>'target')) =
             profile_job.canonical_domain
       AND p_record->>'active_request_bucket' =
             'backlink-profile:' || profile_job.id::text || ':'
             || (p_record->>'endpoint')
  ) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM provider_batch_requests AS batch
     WHERE batch.organization_id = v_organization_id
       AND batch.workspace_id = v_workspace_id
       AND batch.website_project_id = v_website_project_id
       AND batch.id = v_request_id
       AND p_record->>'active_request_bucket' = batch.id::text
       AND p_record->>'provider' = batch.provider
       AND p_record->>'endpoint' = batch.endpoint
       AND p_record->>'request_fingerprint' =
             batch.normalized_request_hash
       AND p_record->>'created_by' = batch.created_by
       AND backlink_phase9_provider_batch_is_allowed(to_jsonb(batch))
  );
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_provider_usage_is_allowed(
  p_record jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_workspace_id uuid;
  v_website_project_id uuid;
  v_provider_request_id uuid;
BEGIN
  IF p_record IS NULL
     OR p_record->>'organization_id' IS NULL
     OR p_record->>'workspace_id' IS NULL
     OR p_record->>'website_project_id' IS NULL
     OR p_record->>'provider_request_id' IS NULL
     OR p_record->>'provider' <> 'dataforseo'
     OR p_record->>'reservation_key' IS NULL THEN
    RETURN false;
  END IF;

  v_organization_id := (p_record->>'organization_id')::uuid;
  v_workspace_id := (p_record->>'workspace_id')::uuid;
  v_website_project_id := (p_record->>'website_project_id')::uuid;
  v_provider_request_id := (p_record->>'provider_request_id')::uuid;

  RETURN EXISTS (
    SELECT 1
      FROM backlink_provider_requests AS request
      LEFT JOIN provider_batch_requests AS batch
        ON batch.organization_id = request.organization_id
       AND batch.workspace_id = request.workspace_id
       AND batch.website_project_id = request.website_project_id
       AND batch.id = request.id
     WHERE request.organization_id = v_organization_id
       AND request.workspace_id = v_workspace_id
       AND request.website_project_id = v_website_project_id
       AND request.id = v_provider_request_id
       AND request.provider = p_record->>'provider'
       AND backlink_phase9_provider_request_is_allowed(to_jsonb(request))
       AND (
         (
           batch.id IS NULL
           AND p_record->>'reservation_key' =
                 request.active_request_bucket
         )
         OR (
           batch.id IS NOT NULL
           AND backlink_phase9_provider_batch_is_allowed(to_jsonb(batch))
           AND p_record->>'reservation_key' =
                 batch.budget_reservation_id
         )
       )
  );
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_fetch_lease_is_allowed(
  p_record jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  v_owner_request_id text;
BEGIN
  IF p_record IS NULL
     OR p_record->>'artifact_fingerprint' !~ '^[a-f0-9]{64}$'
     OR p_record->>'owner_request_id' IS NULL THEN
    RETURN false;
  END IF;

  v_owner_request_id := p_record->>'owner_request_id';

  IF v_owner_request_id ~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (
       SELECT 1
         FROM backlink_jobs AS job
        WHERE job.id = v_owner_request_id::uuid
          AND job.job_type = 'project-analysis'
          AND job.source_object_type = 'project-context-snapshot'
     ) THEN
    RETURN true;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM backlink_recommendation_discovery_request_intents AS intent
     WHERE intent.pool_contract_version = 'recommendation-pool.v2'
       AND intent.canonical_request_fingerprint =
             p_record->>'artifact_fingerprint'
       AND v_owner_request_id IN (intent.id::text, intent.idempotency_key)
  );
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_job_is_v1(
  p_record jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_workspace_id uuid;
  v_website_project_id uuid;
  v_source_object_id uuid;
BEGIN
  IF p_record IS NULL
     OR NULLIF(btrim(p_record->>'job_type'), '') IS NULL
     OR NULLIF(btrim(p_record->>'source_object_type'), '') IS NULL
     OR p_record->>'organization_id' IS NULL
     OR p_record->>'workspace_id' IS NULL
     OR p_record->>'website_project_id' IS NULL
     OR p_record->>'source_object_id' IS NULL THEN
    RETURN true;
  END IF;

  v_organization_id := (p_record->>'organization_id')::uuid;
  v_workspace_id := (p_record->>'workspace_id')::uuid;
  v_website_project_id := (p_record->>'website_project_id')::uuid;
  v_source_object_id := (p_record->>'source_object_id')::uuid;

  IF p_record->>'job_type' = 'recommendation_refill'
     OR p_record->>'source_object_type' IN (
       'recommendation_context',
       'recommendation',
       'recommendation_inventory',
       'recommendation_refill'
     ) THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_recommendation_generation_contracts AS generation
     WHERE generation.organization_id = v_organization_id
       AND generation.workspace_id = v_workspace_id
       AND generation.website_project_id = v_website_project_id
       AND generation.pool_contract_version = 'recommendation-pool.v1'
       AND generation.recommendation_context_version_id = v_source_object_id
    UNION ALL
    SELECT 1
      FROM backlink_recommendations AS recommendation
     WHERE recommendation.organization_id = v_organization_id
       AND recommendation.workspace_id = v_workspace_id
       AND recommendation.website_project_id = v_website_project_id
       AND recommendation.id = v_source_object_id
       AND backlink_phase9_recommendation_is_v1(
             to_jsonb(recommendation)
           )
    UNION ALL
    SELECT 1
      FROM backlink_recommendation_inventory AS inventory
     WHERE inventory.organization_id = v_organization_id
       AND inventory.workspace_id = v_workspace_id
       AND inventory.website_project_id = v_website_project_id
       AND inventory.id = v_source_object_id
       AND backlink_phase9_inventory_is_v1(to_jsonb(inventory))
    UNION ALL
    SELECT 1
      FROM backlink_recommendation_refills AS refill
     WHERE refill.organization_id = v_organization_id
       AND refill.workspace_id = v_workspace_id
       AND refill.website_project_id = v_website_project_id
       AND refill.id = v_source_object_id
  ) THEN
    RETURN true;
  END IF;

  RETURN NOT (
    (
      p_record->>'job_type' = 'project-analysis'
      AND p_record->>'source_object_type' = 'project-context-snapshot'
      AND EXISTS (
        SELECT 1
          FROM backlink_project_context_snapshots AS snapshot
         WHERE snapshot.organization_id = v_organization_id
           AND snapshot.workspace_id = v_workspace_id
           AND snapshot.website_project_id = v_website_project_id
           AND snapshot.id = v_source_object_id
      )
    )
    OR (
      p_record->>'job_type' = 'backlink_profile_sync'
      AND p_record->>'source_object_type' = 'website_project'
      AND v_source_object_id = v_website_project_id
    )
    OR (
      p_record->>'job_type' = 'backlink_inventory_monitor'
      AND p_record->>'source_object_type' = 'backlink_inventory_item'
      AND EXISTS (
        SELECT 1
          FROM backlink_inventory_items AS inventory_item
         WHERE inventory_item.organization_id = v_organization_id
           AND inventory_item.workspace_id = v_workspace_id
           AND inventory_item.website_project_id = v_website_project_id
           AND inventory_item.id = v_source_object_id
      )
    )
  );
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_outbox_is_v1(
  p_record jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_workspace_id uuid;
  v_website_project_id uuid;
  v_aggregate_id uuid;
  payload jsonb;
BEGIN
  IF p_record IS NULL
     OR NULLIF(btrim(p_record->>'event_type'), '') IS NULL
     OR p_record->>'organization_id' IS NULL
     OR p_record->>'workspace_id' IS NULL
     OR p_record->>'website_project_id' IS NULL
     OR p_record->>'aggregate_id' IS NULL
     OR jsonb_typeof(p_record->'payload') <> 'object' THEN
    RETURN true;
  END IF;

  v_organization_id := (p_record->>'organization_id')::uuid;
  v_workspace_id := (p_record->>'workspace_id')::uuid;
  v_website_project_id := (p_record->>'website_project_id')::uuid;
  v_aggregate_id := (p_record->>'aggregate_id')::uuid;
  payload := p_record->'payload';

  IF p_record->>'event_type' =
       'backlinks.recommendation-refill.requested.v1'
     OR p_record->>'event_type' LIKE
       'backlinks.recommendation-refill.%'
     OR payload->>'contractVersion' =
       'backlinks.recommendation-refill.requested.v1' THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_jobs AS job
     WHERE job.organization_id = v_organization_id
       AND job.workspace_id = v_workspace_id
       AND job.website_project_id = v_website_project_id
       AND job.id = v_aggregate_id
       AND backlink_phase9_job_is_v1(to_jsonb(job))
    UNION ALL
    SELECT 1
      FROM backlink_recommendation_refills AS refill
     WHERE refill.organization_id = v_organization_id
       AND refill.workspace_id = v_workspace_id
       AND refill.website_project_id = v_website_project_id
       AND refill.id = v_aggregate_id
    UNION ALL
    SELECT 1
      FROM backlink_recommendations AS recommendation
     WHERE recommendation.organization_id = v_organization_id
       AND recommendation.workspace_id = v_workspace_id
       AND recommendation.website_project_id = v_website_project_id
       AND recommendation.id = v_aggregate_id
       AND backlink_phase9_recommendation_is_v1(
             to_jsonb(recommendation)
           )
  ) OR (
    payload ? 'recommendationContextVersionId'
    AND EXISTS (
      SELECT 1
        FROM backlink_recommendation_generation_contracts AS generation
       WHERE generation.organization_id = v_organization_id
         AND generation.workspace_id = v_workspace_id
         AND generation.website_project_id = v_website_project_id
         AND generation.pool_contract_version = 'recommendation-pool.v1'
          AND generation.recommendation_context_version_id::text =
                payload->>'recommendationContextVersionId'
    )
  ) THEN
    RETURN true;
  END IF;

  IF p_record->>'payload_schema_version' <> '1' THEN
    RETURN true;
  END IF;

  RETURN NOT (
    (
      p_record->>'event_type' =
        'backlinks.project-analysis.requested.v1'
      AND payload->>'organizationId' = v_organization_id::text
      AND payload->>'workspaceId' = v_workspace_id::text
      AND payload->>'websiteProjectId' = v_website_project_id::text
      AND payload->>'jobId' = v_aggregate_id::text
      AND NULLIF(btrim(payload->>'workflowId'), '') IS NOT NULL
      AND (payload->>'snapshotVersion')::integer > 0
    )
    OR (
      p_record->>'event_type' =
        'backlinks.placement-monitoring.requested.v1'
      AND payload->>'contractVersion' =
        'backlinks.placement-monitoring.requested.v1'
      AND payload->>'placementId' = v_aggregate_id::text
      AND payload->>'websiteProjectId' = v_website_project_id::text
      AND NULLIF(btrim(payload->>'candidateId'), '') IS NOT NULL
      AND NULLIF(btrim(payload->>'opportunityId'), '') IS NOT NULL
      AND NULLIF(btrim(payload->>'initialValidationId'), '') IS NOT NULL
    )
    OR (
      p_record->>'event_type' =
        'backlinks.placement-monitoring.lifecycle.v1'
      AND payload->>'contractVersion' =
        'backlinks.placement-monitoring.lifecycle.v1'
      AND payload->>'placementId' = v_aggregate_id::text
      AND NULLIF(btrim(payload->>'lifecycleEventId'), '') IS NOT NULL
      AND NULLIF(btrim(payload->>'lifecycleEventType'), '') IS NOT NULL
      AND NULLIF(btrim(payload->>'monitorRunId'), '') IS NOT NULL
      AND NULLIF(btrim(payload->>'monitorPolicyId'), '') IS NOT NULL
      AND NULLIF(btrim(payload->>'observationId'), '') IS NOT NULL
    )
    OR (
      p_record->>'event_type' =
        'backlinks.contact-enrichment.requested.v1'
      AND payload->>'contractVersion' =
        'backlinks.contact-enrichment.requested.v1'
      AND payload->>'organizationId' = v_organization_id::text
      AND payload->>'workspaceId' = v_workspace_id::text
      AND payload->>'websiteProjectId' = v_website_project_id::text
      AND payload->>'jobId' = v_aggregate_id::text
      AND (payload->>'requestVersion')::integer > 0
    )
    OR (
      p_record->>'event_type' = 'backlinks.send-intent.created.v1'
      AND payload->>'sendIntentId' = v_aggregate_id::text
      AND NULLIF(btrim(payload->>'draftId'), '') IS NOT NULL
      AND NULLIF(btrim(payload->>'approvedDraftVersionId'), '') IS NOT NULL
      AND NULLIF(btrim(payload->>'gmailConnectionId'), '') IS NOT NULL
    )
    OR (
      p_record->>'event_type' =
        'backlinks.gmail-incremental-sync.requested.v1'
      AND payload->>'contractVersion' =
        'backlinks.gmail-incremental-sync.requested.v1'
      AND payload->>'organizationId' = v_organization_id::text
      AND payload->>'workspaceId' = v_workspace_id::text
      AND payload->>'websiteProjectId' = v_website_project_id::text
      AND NULLIF(btrim(payload->>'gmailConnectionId'), '') IS NOT NULL
    )
  );
EXCEPTION
  WHEN invalid_text_representation
    OR numeric_value_out_of_range THEN
    RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_idempotency_is_v1(
  p_record jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_workspace_id uuid;
  v_website_project_id uuid;
  response_body jsonb;
BEGIN
  IF p_record IS NULL
     OR NULLIF(btrim(p_record->>'command_type'), '') IS NULL
     OR p_record->>'organization_id' IS NULL
     OR p_record->>'workspace_id' IS NULL
     OR p_record->>'website_project_id' IS NULL THEN
    RETURN true;
  END IF;

  v_organization_id := (p_record->>'organization_id')::uuid;
  v_workspace_id := (p_record->>'workspace_id')::uuid;
  v_website_project_id := (p_record->>'website_project_id')::uuid;
  response_body := CASE
    WHEN jsonb_typeof(p_record->'response_body') = 'object'
      THEN p_record->'response_body'
    ELSE '{}'::jsonb
  END;

  IF p_record->>'command_type' LIKE 'recommendation.%' THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_jobs AS job
     WHERE job.organization_id = v_organization_id
       AND job.workspace_id = v_workspace_id
       AND job.website_project_id = v_website_project_id
       AND job.id::text = response_body->>'jobId'
       AND backlink_phase9_job_is_v1(to_jsonb(job))
    UNION ALL
    SELECT 1
      FROM backlink_recommendation_refills AS refill
     WHERE refill.organization_id = v_organization_id
       AND refill.workspace_id = v_workspace_id
       AND refill.website_project_id = v_website_project_id
       AND refill.id::text = response_body->>'refillId'
    UNION ALL
    SELECT 1
      FROM backlink_recommendations AS recommendation
     WHERE recommendation.organization_id = v_organization_id
       AND recommendation.workspace_id = v_workspace_id
       AND recommendation.website_project_id = v_website_project_id
       AND recommendation.id::text = response_body->>'recommendationId'
       AND backlink_phase9_recommendation_is_v1(
             to_jsonb(recommendation)
           )
  ) THEN
    RETURN true;
  END IF;

  RETURN p_record->>'command_type' NOT IN (
    'recommendation-user-release.get-more',
    'recommendation-user-release.archive',
    'recommendation-seeds.prepare.v2',
    'opportunity.create',
    'opportunity.create.feed-item',
    'opportunity.transition',
    'opportunity.management.patch',
    'opportunity.cooperation_path.create',
    'opportunity.manual_content.patch',
    'opportunity.manual_action.transition',
    'contact.candidate.create',
    'placement.candidate.create',
    'placement.reverify'
  );
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_lifecycle_is_v1(
  p_record jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_workspace_id uuid;
  v_website_project_id uuid;
  v_aggregate_id uuid;
BEGIN
  IF p_record IS NULL
     OR NULLIF(btrim(p_record->>'aggregate_type'), '') IS NULL
     OR NULLIF(btrim(p_record->>'event_type'), '') IS NULL
     OR p_record->>'organization_id' IS NULL
     OR p_record->>'workspace_id' IS NULL
     OR p_record->>'website_project_id' IS NULL
     OR p_record->>'aggregate_id' IS NULL THEN
    RETURN true;
  END IF;

  v_organization_id := (p_record->>'organization_id')::uuid;
  v_workspace_id := (p_record->>'workspace_id')::uuid;
  v_website_project_id := (p_record->>'website_project_id')::uuid;
  v_aggregate_id := (p_record->>'aggregate_id')::uuid;

  IF p_record->>'aggregate_type' IN (
       'recommendation',
       'recommendation_inventory',
       'recommendation_refill'
     )
     OR p_record->>'event_type' LIKE 'recommendation.%'
     OR p_record->>'event_type' LIKE 'recommendation_refill.%' THEN
    RETURN true;
  END IF;

  IF p_record->>'job_id' IS NOT NULL THEN
    RETURN NOT EXISTS (
      SELECT 1
        FROM backlink_jobs AS job
       WHERE job.organization_id = v_organization_id
          AND job.workspace_id = v_workspace_id
          AND job.website_project_id = v_website_project_id
          AND job.id::text = p_record->>'job_id'
          AND NOT backlink_phase9_job_is_v1(to_jsonb(job))
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_recommendations AS recommendation
     WHERE recommendation.organization_id = v_organization_id
       AND recommendation.workspace_id = v_workspace_id
       AND recommendation.website_project_id = v_website_project_id
       AND recommendation.id = v_aggregate_id
       AND backlink_phase9_recommendation_is_v1(
             to_jsonb(recommendation)
           )
    UNION ALL
    SELECT 1
      FROM backlink_recommendation_inventory AS inventory
     WHERE inventory.organization_id = v_organization_id
       AND inventory.workspace_id = v_workspace_id
       AND inventory.website_project_id = v_website_project_id
       AND inventory.id = v_aggregate_id
       AND backlink_phase9_inventory_is_v1(to_jsonb(inventory))
    UNION ALL
    SELECT 1
      FROM backlink_recommendation_refills AS refill
     WHERE refill.organization_id = v_organization_id
       AND refill.workspace_id = v_workspace_id
       AND refill.website_project_id = v_website_project_id
       AND refill.id = v_aggregate_id
  ) THEN
    RETURN true;
  END IF;

  RETURN NOT (
    (
      p_record->>'aggregate_type' = 'opportunity'
      AND p_record->>'event_type' LIKE 'opportunity.%'
    )
    OR (
      p_record->>'aggregate_type' = 'opportunity_manual_action'
      AND p_record->>'event_type' LIKE 'opportunity.manual_action.%'
    )
    OR (
      p_record->>'aggregate_type' = 'contact_candidate'
      AND p_record->>'event_type' LIKE 'contact_candidate.%'
    )
    OR (
      p_record->>'aggregate_type' = 'email_draft'
      AND p_record->>'event_type' = 'draft.approval.recorded'
    )
    OR (
      p_record->>'aggregate_type' = 'reply_assignment'
      AND p_record->>'event_type' IN (
        'reply.assignment.recorded',
        'reply.assignment.revoked'
      )
    )
    OR (
      p_record->>'aggregate_type' = 'negotiation_fact'
      AND p_record->>'event_type' = 'negotiation.fact.reviewed'
    )
    OR (
      p_record->>'aggregate_type' = 'placement_candidate'
      AND p_record->>'event_type' LIKE 'placement_candidate.%'
    )
    OR (
      p_record->>'aggregate_type' = 'placement'
      AND p_record->>'event_type' LIKE 'placement.%'
    )
    OR (
      p_record->>'aggregate_type' = 'placement_monitor_run'
      AND p_record->>'event_type' LIKE 'placement.monitoring.%'
    )
    OR (
      p_record->>'aggregate_type' = 'backlink_inventory_item'
      AND p_record->>'event_type' LIKE 'inventory.direct.%'
    )
  );
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_audit_is_v1(
  p_record jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  v_organization_id uuid;
  v_workspace_id uuid;
  v_website_project_id uuid;
  v_target_id uuid;
BEGIN
  IF p_record IS NULL
     OR NULLIF(btrim(p_record->>'action'), '') IS NULL
     OR NULLIF(btrim(p_record->>'target_type'), '') IS NULL
     OR p_record->>'organization_id' IS NULL
     OR p_record->>'workspace_id' IS NULL
     OR p_record->>'website_project_id' IS NULL
     OR p_record->>'target_id' IS NULL THEN
    RETURN true;
  END IF;

  v_organization_id := (p_record->>'organization_id')::uuid;
  v_workspace_id := (p_record->>'workspace_id')::uuid;
  v_website_project_id := (p_record->>'website_project_id')::uuid;
  v_target_id := (p_record->>'target_id')::uuid;

  IF p_record->>'target_type' IN (
       'recommendation',
       'recommendation_inventory',
       'recommendation_refill'
     )
     OR p_record->>'action' LIKE 'recommendation.%'
     OR p_record->>'action' LIKE 'recommendation_refill.%' THEN
    RETURN true;
  END IF;

  IF p_record->>'job_id' IS NOT NULL THEN
    RETURN NOT EXISTS (
      SELECT 1
        FROM backlink_jobs AS job
       WHERE job.organization_id = v_organization_id
          AND job.workspace_id = v_workspace_id
          AND job.website_project_id = v_website_project_id
          AND job.id::text = p_record->>'job_id'
          AND NOT backlink_phase9_job_is_v1(to_jsonb(job))
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_recommendations AS recommendation
     WHERE recommendation.organization_id = v_organization_id
       AND recommendation.workspace_id = v_workspace_id
       AND recommendation.website_project_id = v_website_project_id
       AND recommendation.id = v_target_id
       AND backlink_phase9_recommendation_is_v1(
             to_jsonb(recommendation)
           )
    UNION ALL
    SELECT 1
      FROM backlink_recommendation_inventory AS inventory
     WHERE inventory.organization_id = v_organization_id
       AND inventory.workspace_id = v_workspace_id
       AND inventory.website_project_id = v_website_project_id
       AND inventory.id = v_target_id
       AND backlink_phase9_inventory_is_v1(to_jsonb(inventory))
    UNION ALL
    SELECT 1
      FROM backlink_recommendation_refills AS refill
     WHERE refill.organization_id = v_organization_id
       AND refill.workspace_id = v_workspace_id
       AND refill.website_project_id = v_website_project_id
       AND refill.id = v_target_id
  ) THEN
    RETURN true;
  END IF;

  IF p_record->>'lifecycle_event_id' IS NULL THEN
    RETURN NOT (
      p_record->>'target_type' = 'gmail_connection'
      AND p_record->>'action' LIKE 'gmail.%'
    );
  END IF;

  RETURN NOT (
    (
      p_record->>'target_type' = 'opportunity'
      AND p_record->>'action' LIKE 'opportunity.%'
    )
    OR (
      p_record->>'target_type' = 'opportunity_manual_action'
      AND p_record->>'action' LIKE 'opportunity.manual_action.%'
    )
    OR (
      p_record->>'target_type' = 'contact_candidate'
      AND p_record->>'action' LIKE 'contact_candidate.%'
    )
    OR (
      p_record->>'target_type' = 'email_draft'
      AND p_record->>'action' = 'draft.approved'
    )
    OR (
      p_record->>'target_type' = 'reply_assignment'
      AND p_record->>'action' IN (
        'reply.assignment.recorded',
        'reply.assignment.revoked'
      )
    )
    OR (
      p_record->>'target_type' = 'inbound_message'
      AND p_record->>'action' = 'reply.assignment.recorded'
    )
    OR (
      p_record->>'target_type' = 'reply_match_candidate'
      AND p_record->>'action' IN (
        'reply_match_candidate.confirmed',
        'reply_match_candidate.unbound'
      )
    )
    OR (
      p_record->>'target_type' = 'negotiation_fact'
      AND p_record->>'action' = 'negotiation.fact.reviewed'
    )
    OR (
      p_record->>'target_type' = 'placement_candidate'
      AND p_record->>'action' LIKE 'placement_candidate.%'
    )
    OR (
      p_record->>'target_type' = 'placement'
      AND p_record->>'action' LIKE 'placement.%'
    )
    OR (
      p_record->>'target_type' = 'placement_monitor_run'
      AND p_record->>'action' LIKE 'placement.monitoring.%'
    )
    OR (
      p_record->>'target_type' = 'backlink_inventory_item'
      AND p_record->>'action' LIKE 'inventory.direct.%'
    )
  );
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_inventory_is_v1(
  p_inventory jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  generation_count integer;
  v1_generation_count integer;
  v2_generation_count integer;
BEGIN
  IF p_inventory IS NULL
     OR p_inventory->>'id' IS NULL
     OR p_inventory->>'organization_id' IS NULL
     OR p_inventory->>'workspace_id' IS NULL
     OR p_inventory->>'website_project_id' IS NULL
     OR p_inventory->>'recommendation_context_version_id' IS NULL
     OR p_inventory->>'visible_pool_generation' IS NULL THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_recommendation_legacy_source_lineage_facts AS lineage
     WHERE lineage.organization_id =
             (p_inventory->>'organization_id')::uuid
       AND lineage.workspace_id = (p_inventory->>'workspace_id')::uuid
       AND lineage.website_project_id =
             (p_inventory->>'website_project_id')::uuid
       AND lineage.source_inventory_id = (p_inventory->>'id')::uuid
  ) THEN
    RETURN true;
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE generation.pool_contract_version =
             'recommendation-pool.v1'
         )::integer,
         count(*) FILTER (
           WHERE generation.pool_contract_version =
             'recommendation-pool.v2'
         )::integer
    INTO generation_count, v1_generation_count, v2_generation_count
    FROM backlink_recommendation_generation_contracts AS generation
   WHERE generation.organization_id =
           (p_inventory->>'organization_id')::uuid
     AND generation.workspace_id = (p_inventory->>'workspace_id')::uuid
     AND generation.website_project_id =
           (p_inventory->>'website_project_id')::uuid
     AND generation.recommendation_context_version_id =
           (p_inventory->>'recommendation_context_version_id')::uuid
     AND generation.visible_pool_generation =
           (p_inventory->>'visible_pool_generation')::integer;

  RETURN generation_count <> 1
    OR v1_generation_count <> 0
    OR v2_generation_count <> 1;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_recommendation_is_v1(
  p_recommendation jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  inventory_count integer;
  v1_inventory_count integer;
BEGIN
  IF p_recommendation IS NULL
     OR p_recommendation->>'id' IS NULL
     OR p_recommendation->>'organization_id' IS NULL
     OR p_recommendation->>'workspace_id' IS NULL
     OR p_recommendation->>'website_project_id' IS NULL
     OR p_recommendation->>'recommendation_context_version_id' IS NULL THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM backlink_recommendation_legacy_source_lineage_facts AS lineage
     WHERE lineage.organization_id =
             (p_recommendation->>'organization_id')::uuid
       AND lineage.workspace_id =
             (p_recommendation->>'workspace_id')::uuid
       AND lineage.website_project_id =
             (p_recommendation->>'website_project_id')::uuid
       AND lineage.source_recommendation_id =
             (p_recommendation->>'id')::uuid
  ) THEN
    RETURN true;
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (
           WHERE backlink_phase9_inventory_is_v1(to_jsonb(inventory))
         )::integer
    INTO inventory_count, v1_inventory_count
    FROM backlink_recommendation_inventory AS inventory
   WHERE inventory.organization_id =
           (p_recommendation->>'organization_id')::uuid
     AND inventory.workspace_id =
           (p_recommendation->>'workspace_id')::uuid
     AND inventory.website_project_id =
           (p_recommendation->>'website_project_id')::uuid
     AND inventory.recommendation_id =
           (p_recommendation->>'id')::uuid;

  IF inventory_count > 0 THEN
    RETURN v1_inventory_count > 0;
  END IF;

  RETURN true;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_can_insert_v2_recommendation(
  p_recommendation jsonb
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  SELECT p_recommendation IS NOT NULL
    AND EXISTS (
    SELECT 1
      FROM backlink_recommendation_pool_project_contracts AS contract
      JOIN backlink_recommendation_generation_contracts AS generation
        ON generation.organization_id = contract.organization_id
       AND generation.workspace_id = contract.workspace_id
       AND generation.website_project_id = contract.website_project_id
       AND generation.id = contract.generation_contract_id
     WHERE contract.organization_id =
             (p_recommendation->>'organization_id')::uuid
       AND contract.workspace_id =
             (p_recommendation->>'workspace_id')::uuid
       AND contract.website_project_id =
             (p_recommendation->>'website_project_id')::uuid
       AND contract.pool_contract_version = 'recommendation-pool.v2'
       AND contract.migration_state = 'V2_ACTIVE'
       AND generation.pool_contract_version = 'recommendation-pool.v2'
       AND generation.recommendation_context_version_id =
             (p_recommendation->>'recommendation_context_version_id')::uuid
  );
$function$;

CREATE OR REPLACE FUNCTION backlink_reject_v1_write_after_phase9()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  old_data jsonb;
  new_data jsonb;
BEGIN
  IF NOT backlink_phase9_v1_writes_are_frozen() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  old_data := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  new_data := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;

  IF TG_TABLE_NAME = 'backlink_recommendation_pool_project_contracts' THEN
    IF (
      old_data IS NOT NULL
      AND (
        old_data->>'pool_contract_version' IS DISTINCT FROM
          'recommendation-pool.v2'
        OR old_data->>'migration_state' = 'V1_ACTIVE'
      )
    ) OR (
      new_data IS NOT NULL
      AND (
        new_data->>'pool_contract_version' IS DISTINCT FROM
          'recommendation-pool.v2'
        OR new_data->>'migration_state' = 'V1_ACTIVE'
      )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'V1 recommendation project contracts are read-only.';
    END IF;
  ELSIF TG_TABLE_NAME =
          'backlink_recommendation_generation_contracts' THEN
    IF (
      old_data IS NOT NULL
      AND old_data->>'pool_contract_version' IS DISTINCT FROM
        'recommendation-pool.v2'
    ) OR (
      new_data IS NOT NULL
      AND new_data->>'pool_contract_version' IS DISTINCT FROM
        'recommendation-pool.v2'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'V1 recommendation generation history is read-only.';
    END IF;
  ELSIF TG_TABLE_NAME = 'backlink_recommendations' THEN
    IF (
      old_data IS NOT NULL
      AND backlink_phase9_recommendation_is_v1(old_data)
    ) OR (
      new_data IS NOT NULL
      AND backlink_phase9_recommendation_is_v1(new_data)
      AND (
        TG_OP <> 'INSERT'
        OR NOT backlink_phase9_can_insert_v2_recommendation(new_data)
      )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'V1 recommendation history is read-only.';
    END IF;
  ELSIF TG_TABLE_NAME = 'backlink_recommendation_inventory' THEN
    IF (
      old_data IS NOT NULL
      AND backlink_phase9_inventory_is_v1(old_data)
    ) OR (
      new_data IS NOT NULL
      AND backlink_phase9_inventory_is_v1(new_data)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'V1 recommendation inventory history is read-only.';
    END IF;
  ELSIF TG_TABLE_NAME IN (
    'backlink_recommendation_rejections',
    'backlink_recommendation_refills',
    'backlink_recommendation_claims',
    'backlink_commercial_supply_operations',
    'backlink_commercial_inventory_policies'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'V1 recommendation runtime history is read-only.';
  ELSIF TG_TABLE_NAME = 'backlink_jobs' THEN
    IF (
      old_data IS NOT NULL
      AND backlink_phase9_job_is_v1(old_data)
    ) OR (
      new_data IS NOT NULL
      AND backlink_phase9_job_is_v1(new_data)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'V1 recommendation jobs are frozen.';
    END IF;
  ELSIF TG_TABLE_NAME = 'backlink_outbox_events' THEN
    IF (
      old_data IS NOT NULL
      AND backlink_phase9_outbox_is_v1(old_data)
    ) OR (
      new_data IS NOT NULL
      AND backlink_phase9_outbox_is_v1(new_data)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'V1 recommendation outbox is frozen.';
    END IF;
  ELSIF TG_TABLE_NAME = 'backlink_idempotency_records' THEN
    IF (
      old_data IS NOT NULL
      AND backlink_phase9_idempotency_is_v1(old_data)
    ) OR (
      new_data IS NOT NULL
      AND backlink_phase9_idempotency_is_v1(new_data)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'V1 recommendation commands are frozen.';
    END IF;
  ELSIF TG_TABLE_NAME = 'backlink_lifecycle_events' THEN
    IF (
      old_data IS NOT NULL
      AND backlink_phase9_lifecycle_is_v1(old_data)
    ) OR (
      new_data IS NOT NULL
      AND backlink_phase9_lifecycle_is_v1(new_data)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'V1 recommendation lifecycle history is read-only.';
    END IF;
  ELSIF TG_TABLE_NAME = 'backlink_audit_events' THEN
    IF (
      old_data IS NOT NULL
      AND backlink_phase9_audit_is_v1(old_data)
    ) OR (
      new_data IS NOT NULL
      AND backlink_phase9_audit_is_v1(new_data)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'V1 recommendation audit history is read-only.';
    END IF;
  ELSIF TG_TABLE_NAME = 'provider_batch_requests' THEN
    IF (
      old_data IS NOT NULL
      AND NOT backlink_phase9_provider_batch_is_allowed(old_data)
    ) OR (
      new_data IS NOT NULL
      AND NOT backlink_phase9_provider_batch_is_allowed(new_data)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE =
          'Untyped or V1 recommendation provider batches are frozen.';
    END IF;
  ELSIF TG_TABLE_NAME = 'backlink_provider_requests' THEN
    IF (
      old_data IS NOT NULL
      AND NOT backlink_phase9_provider_request_is_allowed(old_data)
    ) OR (
      new_data IS NOT NULL
      AND NOT backlink_phase9_provider_request_is_allowed(new_data)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE =
          'Untyped or V1 recommendation provider requests are frozen.';
    END IF;
  ELSIF TG_TABLE_NAME = 'backlink_provider_usage_ledger' THEN
    IF (
      old_data IS NOT NULL
      AND NOT backlink_phase9_provider_usage_is_allowed(old_data)
    ) OR (
      new_data IS NOT NULL
      AND NOT backlink_phase9_provider_usage_is_allowed(new_data)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE =
          'Untyped or V1 recommendation provider reservations are frozen.';
    END IF;
  ELSIF TG_TABLE_NAME = 'provider_fetch_leases' THEN
    IF (
      old_data IS NOT NULL
      AND NOT backlink_phase9_fetch_lease_is_allowed(old_data)
    ) OR (
      new_data IS NOT NULL
      AND NOT backlink_phase9_fetch_lease_is_allowed(new_data)
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE =
          'Untyped or V1 recommendation provider leases are frozen.';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_phase9_reject_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'Phase 9 freeze records are immutable.';
END;
$function$;

CREATE OR REPLACE FUNCTION
  backlink_recommendation_pool_v2_phase9_verify()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  base jsonb;
  frozen boolean;
  trigger_count integer;
  expected_trigger_count constant integer := 18;
  history_count integer;
BEGIN
  base := backlink_recommendation_pool_v2_verify_cutover();
  frozen := backlink_phase9_v1_writes_are_frozen();

  WITH expected(trigger_name, table_name) AS (
    VALUES
      (
        'backlink_pool_project_contract_v1_freeze_guard',
        'backlink_recommendation_pool_project_contracts'
      ),
      (
        'backlink_generation_v1_freeze_guard',
        'backlink_recommendation_generation_contracts'
      ),
      (
        'backlink_recommendation_v1_freeze_guard',
        'backlink_recommendations'
      ),
      (
        'backlink_inventory_v1_freeze_guard',
        'backlink_recommendation_inventory'
      ),
      (
        'backlink_rejection_v1_freeze_guard',
        'backlink_recommendation_rejections'
      ),
      (
        'backlink_refill_v1_freeze_guard',
        'backlink_recommendation_refills'
      ),
      ('backlink_job_v1_freeze_guard', 'backlink_jobs'),
      ('backlink_outbox_v1_freeze_guard', 'backlink_outbox_events'),
      (
        'backlink_claim_v1_freeze_guard',
        'backlink_recommendation_claims'
      ),
      (
        'backlink_provider_request_v1_freeze_guard',
        'backlink_provider_requests'
      ),
      (
        'provider_batch_request_v1_freeze_guard',
        'provider_batch_requests'
      ),
      (
        'provider_usage_v1_freeze_guard',
        'backlink_provider_usage_ledger'
      ),
      (
        'provider_fetch_lease_v1_freeze_guard',
        'provider_fetch_leases'
      ),
      (
        'backlink_supply_operation_v1_freeze_guard',
        'backlink_commercial_supply_operations'
      ),
      (
        'backlink_inventory_policy_v1_freeze_guard',
        'backlink_commercial_inventory_policies'
      ),
      (
        'backlink_lifecycle_v1_freeze_guard',
        'backlink_lifecycle_events'
      ),
      ('backlink_audit_v1_freeze_guard', 'backlink_audit_events'),
      (
        'backlink_idempotency_v1_freeze_guard',
        'backlink_idempotency_records'
      )
  )
  SELECT count(*)::integer
    INTO trigger_count
    FROM expected
    JOIN pg_namespace AS namespace
      ON namespace.nspname = 'backlinks'
    JOIN pg_class AS relation
      ON relation.relnamespace = namespace.oid
     AND relation.relname = expected.table_name
    JOIN pg_trigger AS trigger
      ON trigger.tgrelid = relation.oid
     AND trigger.tgname = expected.trigger_name
     AND NOT trigger.tgisinternal
     AND trigger.tgfoid =
       'backlinks.backlink_reject_v1_write_after_phase9()'::regprocedure;

  SELECT count(*)::integer
    INTO history_count
    FROM backlink_recommendation_generation_contracts AS generation
   WHERE generation.pool_contract_version = 'recommendation-pool.v1';

  RETURN base || jsonb_build_object(
    'v1WritesFrozen',
      frozen,
    'v1GenerationHistoryCount',
      history_count,
    'phase9FreezeTriggerCount',
      trigger_count,
    'phase9FreezeTriggerExpectedCount',
      expected_trigger_count,
    'phase9FreezeTriggersInstalled',
      trigger_count = expected_trigger_count,
    'completed',
      COALESCE((base->>'completed')::boolean, false)
      AND frozen
      AND trigger_count = expected_trigger_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION backlink_recommendation_pool_v2_phase9_run(
  p_run_id uuid,
  p_command_id text,
  p_mode text,
  p_actor text,
  p_observed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  existing backlink_recommendation_pool_v2_phase9_runs%ROWTYPE;
  base jsonb;
  verification jsonb;
  ready boolean;
  run_status text;
  cutover_run_id uuid;
BEGIN
  IF p_run_id IS NULL
     OR length(btrim(p_command_id)) = 0
     OR p_mode NOT IN ('PLAN', 'EXECUTE', 'VERIFY')
     OR length(btrim(p_actor)) = 0
     OR p_observed_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Invalid recommendation pool V2 Phase 9 command.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'recommendation-pool-v2-phase9:' || p_command_id,
      0
    )
  );

  SELECT *
    INTO existing
    FROM backlink_recommendation_pool_v2_phase9_runs AS run
   WHERE run.command_id = p_command_id;

  IF FOUND THEN
    IF existing.id <> p_run_id
       OR existing.mode <> p_mode
       OR existing.created_by <> p_actor THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'Phase 9 command does not match the existing run.';
    END IF;

    RETURN to_jsonb(existing);
  END IF;

  base := backlink_recommendation_pool_v2_verify_cutover();
  SELECT run.id
    INTO cutover_run_id
    FROM backlink_recommendation_pool_v2_cutover_runs AS run
   WHERE run.status = 'COMPLETED'
     AND COALESCE((run.verification->>'completed')::boolean, false)
   ORDER BY run.completed_at DESC, run.id DESC
   LIMIT 1;

  ready := COALESCE((base->>'completed')::boolean, false)
    AND cutover_run_id IS NOT NULL;

  IF p_mode = 'EXECUTE' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('recommendation-pool-v2-phase9:execute', 0)
    );

    IF ready THEN
      INSERT INTO backlink_recommendation_pool_v2_cutover_control (
        control_key,
        state,
        frozen_by_run_id,
        frozen_at,
        frozen_by
      ) VALUES (
        'GLOBAL',
        'V1_WRITES_FROZEN',
        cutover_run_id,
        p_observed_at,
        p_actor
      )
      ON CONFLICT (control_key) DO NOTHING;
    END IF;
  END IF;

  verification := backlink_recommendation_pool_v2_phase9_verify()
    || jsonb_build_object(
      'mode', p_mode,
      'readyForExecute', ready
    );

  run_status := CASE
    WHEN p_mode = 'PLAN' AND ready THEN 'PLANNED'
    WHEN p_mode <> 'PLAN'
      AND COALESCE((verification->>'completed')::boolean, false)
      THEN 'COMPLETED'
    ELSE 'BLOCKED'
  END;

  INSERT INTO backlink_recommendation_pool_v2_phase9_runs (
    id,
    command_id,
    mode,
    status,
    verification,
    started_at,
    completed_at,
    created_by
  ) VALUES (
    p_run_id,
    p_command_id,
    p_mode,
    run_status,
    verification,
    p_observed_at,
    clock_timestamp(),
    p_actor
  );

  SELECT *
    INTO existing
    FROM backlink_recommendation_pool_v2_phase9_runs AS run
   WHERE run.id = p_run_id;

  RETURN to_jsonb(existing);
END;
$function$;

DROP TRIGGER IF EXISTS backlink_pool_project_contract_v1_freeze_guard
  ON backlink_recommendation_pool_project_contracts;
CREATE TRIGGER backlink_pool_project_contract_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendation_pool_project_contracts
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_generation_v1_freeze_guard
  ON backlink_recommendation_generation_contracts;
CREATE TRIGGER backlink_generation_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendation_generation_contracts
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_recommendation_v1_freeze_guard
  ON backlink_recommendations;
CREATE TRIGGER backlink_recommendation_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendations
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_inventory_v1_freeze_guard
  ON backlink_recommendation_inventory;
CREATE TRIGGER backlink_inventory_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendation_inventory
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_rejection_v1_freeze_guard
  ON backlink_recommendation_rejections;
CREATE TRIGGER backlink_rejection_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendation_rejections
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_refill_v1_freeze_guard
  ON backlink_recommendation_refills;
CREATE TRIGGER backlink_refill_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendation_refills
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_job_v1_freeze_guard
  ON backlink_jobs;
CREATE TRIGGER backlink_job_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_jobs
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_outbox_v1_freeze_guard
  ON backlink_outbox_events;
CREATE TRIGGER backlink_outbox_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_outbox_events
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_claim_v1_freeze_guard
  ON backlink_recommendation_claims;
CREATE TRIGGER backlink_claim_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_recommendation_claims
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_provider_request_v1_freeze_guard
  ON backlink_provider_requests;
CREATE TRIGGER backlink_provider_request_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_provider_requests
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS provider_batch_request_v1_freeze_guard
  ON provider_batch_requests;
CREATE TRIGGER provider_batch_request_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON provider_batch_requests
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS provider_usage_v1_freeze_guard
  ON backlink_provider_usage_ledger;
CREATE TRIGGER provider_usage_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_provider_usage_ledger
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS provider_fetch_lease_v1_freeze_guard
  ON provider_fetch_leases;
CREATE TRIGGER provider_fetch_lease_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON provider_fetch_leases
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_supply_operation_v1_freeze_guard
  ON backlink_commercial_supply_operations;
CREATE TRIGGER backlink_supply_operation_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_commercial_supply_operations
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_inventory_policy_v1_freeze_guard
  ON backlink_commercial_inventory_policies;
CREATE TRIGGER backlink_inventory_policy_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_commercial_inventory_policies
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_lifecycle_v1_freeze_guard
  ON backlink_lifecycle_events;
CREATE TRIGGER backlink_lifecycle_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_audit_v1_freeze_guard
  ON backlink_audit_events;
CREATE TRIGGER backlink_audit_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_audit_events
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_idempotency_v1_freeze_guard
  ON backlink_idempotency_records;
CREATE TRIGGER backlink_idempotency_v1_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE
ON backlink_idempotency_records
FOR EACH ROW EXECUTE FUNCTION backlink_reject_v1_write_after_phase9();

DROP TRIGGER IF EXISTS backlink_pool_v2_cutover_control_immutable
  ON backlink_recommendation_pool_v2_cutover_control;
CREATE TRIGGER backlink_pool_v2_cutover_control_immutable
BEFORE UPDATE OR DELETE
ON backlink_recommendation_pool_v2_cutover_control
FOR EACH ROW EXECUTE FUNCTION backlink_phase9_reject_immutable();

DROP TRIGGER IF EXISTS backlink_pool_v2_phase9_run_immutable
  ON backlink_recommendation_pool_v2_phase9_runs;
CREATE TRIGGER backlink_pool_v2_phase9_run_immutable
BEFORE UPDATE OR DELETE
ON backlink_recommendation_pool_v2_phase9_runs
FOR EACH ROW EXECUTE FUNCTION backlink_phase9_reject_immutable();

REVOKE ALL
  ON FUNCTION backlink_phase9_v1_writes_are_frozen()
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_provider_batch_is_allowed(jsonb)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_provider_request_is_allowed(jsonb)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_provider_usage_is_allowed(jsonb)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_fetch_lease_is_allowed(jsonb)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_job_is_v1(jsonb)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_outbox_is_v1(jsonb)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_idempotency_is_v1(jsonb)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_lifecycle_is_v1(jsonb)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_audit_is_v1(jsonb)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_inventory_is_v1(jsonb)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_recommendation_is_v1(jsonb)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_can_insert_v2_recommendation(jsonb)
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_reject_v1_write_after_phase9()
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_phase9_reject_immutable()
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_recommendation_pool_v2_phase9_verify()
  FROM PUBLIC;
REVOKE ALL
  ON FUNCTION backlink_recommendation_pool_v2_phase9_run(
    uuid,
    text,
    text,
    text,
    timestamptz
  )
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION backlink_recommendation_pool_v2_phase9_verify()
  TO growthos_backlinks_writer, growthos_reporting_reader;
GRANT EXECUTE
  ON FUNCTION backlink_recommendation_pool_v2_phase9_run(
    uuid,
    text,
    text,
    text,
    timestamptz
  )
  TO growthos_backlinks_writer;

COMMIT;
