BEGIN;

SET LOCAL ROLE growthos_backlinks_owner;
SET LOCAL search_path = backlinks, pg_catalog;

-- Hidden future batches can be PREPARING. Published batches cannot.
CREATE OR REPLACE FUNCTION backlink_recommendation_pool_v2_verify_cutover()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = backlinks, pg_catalog
AS $function$
  WITH latest AS (
    SELECT DISTINCT ON (
      snapshot.organization_id, snapshot.workspace_id, snapshot.website_project_id
    ) snapshot.organization_id, snapshot.workspace_id,
      snapshot.website_project_id, snapshot.project_status
    FROM backlink_project_context_snapshots AS snapshot
    ORDER BY snapshot.organization_id, snapshot.workspace_id,
      snapshot.website_project_id, snapshot.snapshot_version DESC,
      snapshot.created_at DESC, snapshot.id DESC
  ),
  project_state AS (
    SELECT latest.organization_id, latest.workspace_id, latest.website_project_id,
      contract.migration_state,
      COALESCE((
        contract.migration_state = 'V2_ACTIVE'
        AND contract.pool_contract_version = 'recommendation-pool.v2'
        AND generation.pool_contract_version = 'recommendation-pool.v2'
        AND generation.qualification_contract_version = 'recommendation-pool-admission.v2'
        AND generation.visibility_contract_version = 'recommendation-pool-release-visibility.v2'
        AND generation.score_model_version = 'recommendation-pool-materialization.v2'
        AND generation.creator_worker_contract_version = 'recommendation-pool-worker.v2'
        AND pin.qualification_contract_version = 'recommendation-pool-admission.v2'
        AND generation.discovery_completed_at IS NOT NULL
        AND generation.effective_unique_candidate_count > 0
        AND generation.canonical_batch_count > 0
        AND contract.visible_pool_generation = generation.visible_pool_generation
        AND (
          SELECT count(*)::integer FROM backlink_recommendation_release_batches batch
          WHERE (batch.organization_id,batch.workspace_id,batch.website_project_id,
                 batch.generation_contract_id)
              = (generation.organization_id,generation.workspace_id,
                 generation.website_project_id,generation.id)
        ) = generation.canonical_batch_count
        AND EXISTS (
          SELECT 1 FROM backlink_recommendation_release_batches batch
          WHERE (batch.organization_id,batch.workspace_id,batch.website_project_id,
                 batch.generation_contract_id)
              = (generation.organization_id,generation.workspace_id,
                 generation.website_project_id,generation.id)
            AND batch.batch_ordinal = 1 AND batch.state = 'AVAILABLE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM backlink_recommendation_release_batches batch
          WHERE (batch.organization_id,batch.workspace_id,batch.website_project_id,
                 batch.generation_contract_id)
              = (generation.organization_id,generation.workspace_id,
                 generation.website_project_id,generation.id)
            AND (
              batch.state NOT IN ('PREPARING','AVAILABLE')
              OR (batch.state = 'AVAILABLE'
                  AND batch.contact_terminal_count <> batch.contact_total_count)
              OR (batch.state <> 'AVAILABLE' AND EXISTS (
                SELECT 1 FROM backlink_recommendation_user_publications publication
                WHERE (publication.organization_id,publication.workspace_id,
                       publication.website_project_id,publication.batch_id)
                    = (batch.organization_id,batch.workspace_id,
                       batch.website_project_id,batch.id)
              ))
            )
        )
        AND (
          SELECT count(*)::integer FROM backlink_recommendation_release_batch_items item
          WHERE (item.organization_id,item.workspace_id,item.website_project_id,
                 item.generation_contract_id)
              = (generation.organization_id,generation.workspace_id,
                 generation.website_project_id,generation.id)
        ) = generation.effective_unique_candidate_count
        AND NOT EXISTS (
          SELECT 1
          FROM backlink_recommendation_release_batch_items item
          JOIN backlink_recommendation_release_batches batch
            ON (batch.organization_id,batch.workspace_id,batch.website_project_id,batch.id)
             = (item.organization_id,item.workspace_id,item.website_project_id,item.batch_id)
          WHERE (item.organization_id,item.workspace_id,item.website_project_id,
                 item.generation_contract_id)
              = (generation.organization_id,generation.workspace_id,
                 generation.website_project_id,generation.id)
            AND (
              NOT backlink_recommendation_release_item_has_valid_lineage(item)
              OR item.input_pin_id IS NULL
              OR item.legacy_imported
              OR item.generation_candidate_id IS NULL
              OR (batch.state = 'AVAILABLE' AND (
                item.contact_terminal_reason_at_release IS NULL
                OR item.contact_terminal_reason_at_release = 'CONTACT_PENDING'
                OR item.contact_completed_at_release IS NULL
              ))
            )
        )
      ), false) AS valid_v2_active
    FROM latest
    LEFT JOIN backlink_recommendation_pool_project_contracts contract
      ON (contract.organization_id,contract.workspace_id,contract.website_project_id)
       = (latest.organization_id,latest.workspace_id,latest.website_project_id)
    LEFT JOIN backlink_recommendation_generation_contracts generation
      ON (generation.organization_id,generation.workspace_id,
          generation.website_project_id,generation.id)
       = (contract.organization_id,contract.workspace_id,
          contract.website_project_id,contract.generation_contract_id)
    LEFT JOIN backlink_generation_input_pins pin
      ON (pin.organization_id,pin.workspace_id,pin.website_project_id,pin.id)
       = (generation.organization_id,generation.workspace_id,
          generation.website_project_id,generation.input_pin_id)
    WHERE latest.project_status = 'ACTIVE'
  ),
  project_counts AS (
    SELECT count(*)::integer AS eligible_project_count,
      count(*) FILTER (WHERE migration_state='V2_ACTIVE')::integer AS v2_active_project_count,
      count(*) FILTER (WHERE valid_v2_active)::integer AS valid_v2_active_project_count,
      count(*) FILTER (WHERE migration_state IS NULL OR migration_state='V1_ACTIVE')::integer AS active_v1_project_count,
      count(*) FILTER (WHERE migration_state='MIGRATION_BLOCKED')::integer AS migration_blocked_project_count,
      count(*) FILTER (WHERE migration_state='V2_ACTIVE' AND NOT valid_v2_active)::integer AS invalid_v2_active_project_count
    FROM project_state
  ),
  v1_counts AS (
    SELECT
      (SELECT count(*)::integer FROM backlink_recommendation_generation_contracts generation
       JOIN project_state ON (project_state.organization_id,project_state.workspace_id,project_state.website_project_id)
                           = (generation.organization_id,generation.workspace_id,generation.website_project_id)
       WHERE generation.pool_contract_version='recommendation-pool.v1'
         AND (project_state.migration_state IS NULL OR project_state.migration_state='V1_ACTIVE')) AS generations,
      (SELECT count(*)::integer FROM backlink_jobs job
       WHERE job.job_type='recommendation_refill'
         AND job.status IN ('queued','running','waiting_provider')) AS jobs,
      (SELECT count(*)::integer FROM backlink_recommendation_refills refill
       JOIN backlink_jobs job ON (job.organization_id,job.workspace_id,job.website_project_id,job.id)
                              = (refill.organization_id,refill.workspace_id,refill.website_project_id,refill.job_id)
       WHERE job.status IN ('queued','running','waiting_provider')) AS refills,
      (SELECT count(*)::integer FROM backlink_outbox_events event
       WHERE event.event_type='backlinks.recommendation-refill.requested.v1'
         AND event.status IN ('pending','processing')) AS outbox,
      (SELECT count(*)::integer FROM backlink_recommendation_claims claim WHERE claim.status='active') AS claims,
      (SELECT count(DISTINCT request.id)::integer FROM provider_batch_requests request
       JOIN backlink_recommendation_refills refill ON request.request_id LIKE refill.refill_window_key || ':%'
       WHERE request.status IN ('running','unknown_charge')) AS requests,
      (SELECT count(DISTINCT usage.id)::integer FROM backlink_provider_usage_ledger usage
       JOIN backlink_recommendation_refills refill ON usage.reservation_key LIKE refill.refill_window_key || ':%'
       WHERE usage.status='reserved') AS reservations,
      (SELECT count(DISTINCT lease.artifact_fingerprint)::integer FROM provider_fetch_leases lease
       JOIN backlink_recommendation_refills refill ON lease.owner_request_id LIKE refill.refill_window_key || ':%'
       WHERE lease.status IN ('acquired','unknown_charge')) AS leases
  )
  SELECT jsonb_build_object(
    'eligibleProjectCount', project_counts.eligible_project_count,
    'v2ActiveProjectCount', project_counts.v2_active_project_count,
    'validV2ActiveProjectCount', project_counts.valid_v2_active_project_count,
    'activeV1ProjectCount', project_counts.active_v1_project_count,
    'migrationBlockedProjectCount', project_counts.migration_blocked_project_count,
    'invalidV2ActiveProjectCount', project_counts.invalid_v2_active_project_count,
    'activeV1GenerationCount', v1_counts.generations,
    'activeV1RefillCount', v1_counts.refills,
    'activeV1RefillJobCount', v1_counts.jobs,
    'activeV1OutboxCount', v1_counts.outbox,
    'activeV1ClaimCount', v1_counts.claims,
    'activeV1ProviderRequestCount', v1_counts.requests,
    'activeV1ProviderReservationCount', v1_counts.reservations,
    'activeV1ProviderLeaseCount', v1_counts.leases,
    'completed',
      project_counts.eligible_project_count = project_counts.valid_v2_active_project_count
      AND project_counts.active_v1_project_count = 0
      AND project_counts.migration_blocked_project_count = 0
      AND project_counts.invalid_v2_active_project_count = 0
      AND v1_counts.generations = 0 AND v1_counts.refills = 0
      AND v1_counts.jobs = 0 AND v1_counts.outbox = 0 AND v1_counts.claims = 0
      AND v1_counts.requests = 0 AND v1_counts.reservations = 0 AND v1_counts.leases = 0
  ) FROM project_counts, v1_counts;
$function$;

ALTER FUNCTION backlink_recommendation_pool_v2_verify_cutover()
  OWNER TO growthos_backlinks_owner;
REVOKE ALL ON FUNCTION backlink_recommendation_pool_v2_verify_cutover() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backlink_recommendation_pool_v2_verify_cutover()
  TO growthos_backlinks_writer;

COMMIT;
