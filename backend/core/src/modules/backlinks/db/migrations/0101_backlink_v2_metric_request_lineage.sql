BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

ALTER TABLE provider_batch_requests
  ADD COLUMN recommendation_generation_contract_id uuid,
  ADD COLUMN recommendation_job_id uuid,
  ADD CONSTRAINT provider_batch_v2_metric_lineage_pair_ck CHECK (
    (recommendation_generation_contract_id IS NULL) = (recommendation_job_id IS NULL)
  ),
  ADD CONSTRAINT provider_batch_v2_metric_generation_fk FOREIGN KEY (
    organization_id,workspace_id,website_project_id,recommendation_generation_contract_id
  ) REFERENCES backlink_recommendation_generation_contracts (
    organization_id,workspace_id,website_project_id,id
  ),
  ADD CONSTRAINT provider_batch_v2_metric_job_fk FOREIGN KEY (
    organization_id,workspace_id,website_project_id,recommendation_job_id
  ) REFERENCES backlink_jobs (organization_id,workspace_id,website_project_id,id);

-- Keep the existing discovery/profile admission rules unchanged.
ALTER FUNCTION backlink_phase9_provider_batch_is_allowed(jsonb)
  RENAME TO backlink_phase9_non_metric_provider_batch_is_allowed;

CREATE FUNCTION backlink_phase9_provider_batch_is_allowed(p_record jsonb)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
DECLARE
  v_kind text;
  v_job_id text := p_record->>'recommendation_job_id';
  v_hash text := p_record->>'normalized_request_hash';
BEGIN
  IF v_job_id IS NULL AND p_record->>'recommendation_generation_contract_id' IS NULL THEN
    RETURN backlink_phase9_non_metric_provider_batch_is_allowed(p_record);
  END IF;
  v_kind := CASE p_record->>'endpoint'
    WHEN '/v3/dataforseo_labs/google/bulk_traffic_estimation/live' THEN 'traffic'
    WHEN '/v3/backlinks/bulk_ranks/live' THEN 'rank'
    WHEN '/v3/backlinks/bulk_spam_score/live' THEN 'spam'
  END;
  IF NOT COALESCE(
    v_kind IS NOT NULL
    AND v_hash ~ '^[a-f0-9]{64}$'
    AND p_record->>'provider' = 'dataforseo'
    AND p_record->>'request_intent' = 'DEEP_ASSESSMENT'
    AND p_record->>'response_schema_version' = 'commercial-qualification-bulk.v1'
    AND p_record->>'request_id' = 'commercial-qualification-v4:' || v_job_id || ':' || v_kind || ':' || v_hash
    AND p_record->>'budget_reservation_id' = 'commercial-refill-operation:' || v_job_id || ':qualification:' || v_kind || ':' || v_hash
    AND p_record->>'created_by' = p_record->>'request_id'
    AND (p_record->>'estimated_cost_micros')::bigint > 0,
    false
  ) THEN RETURN false; END IF;

  RETURN EXISTS (
    SELECT 1
      FROM backlink_recommendation_generation_contracts generation
      JOIN backlink_jobs job
        ON (job.organization_id,job.workspace_id,job.website_project_id) =
           (generation.organization_id,generation.workspace_id,generation.website_project_id)
       AND job.id = v_job_id::uuid
       AND job.job_type = 'recommendation_pool_v2_generation'
       AND job.source_object_type = 'project-context-snapshot'
       AND job.source_object_id = generation.recommendation_context_version_id
     WHERE generation.organization_id = (p_record->>'organization_id')::uuid
       AND generation.workspace_id = (p_record->>'workspace_id')::uuid
       AND generation.website_project_id = (p_record->>'website_project_id')::uuid
       AND generation.id = (p_record->>'recommendation_generation_contract_id')::uuid
       AND generation.pool_contract_version = 'recommendation-pool.v2'
       AND job.result_summary->>'generationContractId' = generation.id::text
       AND job.result_summary->>'inputPinId' = generation.input_pin_id::text
       AND job.result_summary->>'visiblePoolGeneration' = generation.visible_pool_generation::text
       AND job.result_summary->'providerBudgetAuthorization'->>'provider' = 'dataforseo'
       AND job.result_summary->'providerBudgetAuthorization'->>'authorizedBy' = job.created_by
       AND job.result_summary->'providerBudgetAuthorization'->>'reasonCode' IN (
         'user_authorized_bounded_real_refill', 'user_authorized_persistent_discovery'
       )
       AND (job.result_summary->'providerBudgetAuthorization'->>'maxPaidCalls')::integer BETWEEN 1 AND 1000
       AND (job.result_summary->'providerBudgetAuthorization'->>'maxCostMicros')::bigint
         BETWEEN (p_record->>'estimated_cost_micros')::bigint AND 100000000
  );
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN false;
END;
$function$;

-- A receipt can settle later, but cannot change its original generation or job.
CREATE FUNCTION backlink_provider_metric_lineage_is_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = backlinks, pg_catalog
AS $function$
BEGIN
  IF (NEW.recommendation_generation_contract_id,NEW.recommendation_job_id)
     IS DISTINCT FROM (OLD.recommendation_generation_contract_id,OLD.recommendation_job_id) THEN
    RAISE EXCEPTION 'Provider metric request lineage is immutable.' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER provider_metric_lineage_immutable
  BEFORE UPDATE ON provider_batch_requests
  FOR EACH ROW EXECUTE FUNCTION backlink_provider_metric_lineage_is_immutable();

COMMIT;
