export type RecommendationRefillReservationClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export type RecommendationRefillReservationInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  jobId: string;
  targetPublishedCount: number;
}>;

export type RecommendationRefillReservationResult =
  | Readonly<{ status: "inventory_sufficient"; readyCount: number }>
  | Readonly<{
    status: "already_started";
    readyCount: number;
    jobId: string;
  }>
  | Readonly<{ status: "started"; readyCount: number; jobId: string }>;

const integerFrom = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : 0;
};

const maxRecoveryRetries = 6;

export async function reserveRecommendationRefillJob(
  client: RecommendationRefillReservationClient,
  input: RecommendationRefillReservationInput,
): Promise<RecommendationRefillReservationResult> {
  const values = [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.jobId,
  ] as const;
  const policy = await client.query(
    `SELECT policy.visible_pool_generation "visiblePoolGeneration",
            policy.visible_pool_state "visiblePoolState",
            EXISTS (
              SELECT 1
                FROM backlink_recommendation_generation_contracts AS contract
               WHERE (
                 contract.organization_id,contract.workspace_id,
                 contract.website_project_id,
                 contract.recommendation_context_version_id,
                 contract.visible_pool_generation
               )=(
                 policy.organization_id,policy.workspace_id,
                 policy.website_project_id,
                 policy.project_context_version_id,
                 policy.visible_pool_generation
               )
                 AND contract.qualification_contract_version=
                   'recommendation-qualification.v1'
                 AND contract.visibility_contract_version=
                   'recommendation-visibility.v1'
                 AND contract.score_model_version=
                   'recommendation-commercial-fit.v4'
            ) "correctedVisibilityContract"
       FROM backlink_commercial_inventory_policies AS policy
      WHERE (organization_id,workspace_id,website_project_id,
             project_context_version_id)=($1,$2,$3,$4)
      FOR UPDATE`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.recommendationContextVersionId,
    ],
  );
  if (
    Number(policy.rows[0]?.visiblePoolGeneration) !==
      input.visiblePoolGeneration
    || (
      policy.rows[0]?.visiblePoolState !== "building"
      && !(
        policy.rows[0]?.correctedVisibilityContract === true
        && policy.rows[0]?.visiblePoolState === "active"
      )
    )
  ) {
    throw new Error("COMMERCIAL_VISIBLE_POOL_GENERATION_STALE");
  }
  const ready = await client.query(
    `WITH generation_contract AS (
       SELECT contract.id
         FROM backlink_recommendation_generation_contracts AS contract
        WHERE (
          contract.organization_id,contract.workspace_id,
          contract.website_project_id,
          contract.recommendation_context_version_id,
          contract.visible_pool_generation
        )=($1,$2,$3,$4,$5)
          AND contract.qualification_contract_version=
            'recommendation-qualification.v1'
          AND contract.visibility_contract_version=
            'recommendation-visibility.v1'
          AND contract.score_model_version=
            'recommendation-commercial-fit.v4'
        LIMIT 1
     ),
     legacy_count AS (
       SELECT count(*)::integer AS count
       FROM backlink_recommendation_inventory AS inventory
       JOIN backlink_recommendations AS recommendation
         ON (
           recommendation.organization_id,
           recommendation.workspace_id,
           recommendation.website_project_id,
           recommendation.id
         )=(
           inventory.organization_id,
           inventory.workspace_id,
           inventory.website_project_id,
           inventory.recommendation_id
         )
       JOIN backlink_prospects AS prospect
         ON (
           prospect.organization_id,
           prospect.workspace_id,
           prospect.website_project_id,
           prospect.id
         )=(
           inventory.organization_id,
           inventory.workspace_id,
           inventory.website_project_id,
           inventory.prospect_id
         )
      WHERE inventory.organization_id=$1
        AND inventory.workspace_id=$2
        AND inventory.website_project_id=$3
        AND inventory.recommendation_context_version_id=$4
        AND inventory.visible_pool_generation=$5
        AND inventory.status IN ('ready','shown','accepted')
        AND recommendation.status IN ('ready','shown','accepted')
        AND inventory.fit_decision='eligible'
        AND inventory.fit_score_model_version=
          'recommendation-commercial-fit.v4'
     ),
     latest_qualification AS (
       SELECT DISTINCT ON (qualification.canonical_domain)
              qualification.id,qualification.canonical_domain,
              qualification.decision
         FROM backlink_recommendation_qualification_facts AS qualification
        WHERE qualification.generation_contract_id=(
                SELECT id FROM generation_contract
              )
          AND (
            qualification.organization_id,qualification.workspace_id,
            qualification.website_project_id,
            qualification.recommendation_context_version_id
          )=($1,$2,$3,$4)
          AND qualification.recommendation_id IS NOT NULL
        ORDER BY qualification.canonical_domain,
                 qualification.attempt DESC,
                 qualification.observed_at DESC,
                 qualification.id DESC
     ),
     corrected_count AS (
       SELECT count(*)::integer AS count
         FROM latest_qualification AS qualification
         JOIN LATERAL (
           SELECT visibility.decision
             FROM backlink_recommendation_visibility_facts AS visibility
            WHERE visibility.generation_contract_id=(
                    SELECT id FROM generation_contract
                  )
              AND (
                visibility.organization_id,visibility.workspace_id,
                visibility.website_project_id,
                visibility.recommendation_context_version_id,
                visibility.qualification_fact_id
              )=($1,$2,$3,$4,qualification.id)
            ORDER BY visibility.attempt DESC,
                     visibility.observed_at DESC,
                     visibility.id DESC
            LIMIT 1
         ) AS visibility ON true
        WHERE qualification.decision='eligible'
          AND visibility.decision='visible'
     )
     SELECT CASE WHEN generation_contract.id IS NULL
              THEN legacy_count.count
              ELSE corrected_count.count
            END AS count
       FROM legacy_count
       CROSS JOIN corrected_count
       LEFT JOIN generation_contract ON true`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.recommendationContextVersionId,
      input.visiblePoolGeneration,
    ],
  );
  const readyCount = integerFrom(ready.rows[0]?.count);
  const job = await client.query(
    `SELECT job.status,job.retry_count,job.result_summary
       FROM backlink_jobs AS job
       JOIN backlink_recommendation_refills AS refill
         ON (
           refill.organization_id,refill.workspace_id,
           refill.website_project_id,refill.job_id
         )=(
           job.organization_id,job.workspace_id,
           job.website_project_id,job.id
         )
      WHERE job.organization_id=$1 AND job.workspace_id=$2
        AND job.website_project_id=$3 AND job.id=$4
        AND refill.visible_pool_generation=$5
      FOR UPDATE`,
    [...values, input.visiblePoolGeneration],
  );
  const status = job.rows[0]?.status;
  const retryCount = integerFrom(job.rows[0]?.retry_count);
  const resultSummary = job.rows[0]?.result_summary;
  const completedProviderCheckpointRecoveryAttempted =
    typeof resultSummary === "object"
    && resultSummary !== null
    && "completedProviderCheckpointRecoveryAttempted" in resultSummary
    && (resultSummary as Record<string, unknown>)
      .completedProviderCheckpointRecoveryAttempted === true;
  if (typeof status !== "string") {
    throw new Error("BACKLINK_RECOMMENDATION_REFILL_JOB_NOT_FOUND");
  }

  let retryFailedJob = false;
  let completedProviderCheckpointRecovery = false;
  if (
    status === "failed"
    && (
      retryCount < maxRecoveryRetries
      || (
        retryCount === maxRecoveryRetries
        && !completedProviderCheckpointRecoveryAttempted
      )
    )
  ) {
    const sideEffects = await client.query(
       `WITH accepted_recovery AS MATERIALIZED (
         SELECT request.id AS "providerRequestId",
                request.request_id AS "ownerRequestId",
                request.normalized_request_hash AS "artifactFingerprint"
           FROM backlink_jobs AS failed_job
           JOIN backlink_recommendation_refills AS failed_refill
             ON (
               failed_refill.organization_id,
               failed_refill.workspace_id,
               failed_refill.website_project_id,
               failed_refill.job_id
             )=(
               failed_job.organization_id,
               failed_job.workspace_id,
               failed_job.website_project_id,
               failed_job.id
             )
            AND failed_refill.recommendation_context_version_id=$5
            AND failed_refill.visible_pool_generation=$6
           JOIN provider_batch_requests AS request
             ON (
               request.organization_id,request.workspace_id,
               request.website_project_id
             )=(
               failed_job.organization_id,failed_job.workspace_id,
               failed_job.website_project_id
             )
            AND request.request_id LIKE failed_refill.refill_window_key||':%'
            AND request.budget_reservation_id LIKE
                'commercial-refill-operation:'||failed_job.id::text||
                ':discovery:'||failed_refill.refill_window_key||':%'
            AND request.created_at>=failed_job.created_at
           JOIN backlink_provider_requests AS provider_request
             ON (
               provider_request.organization_id,
               provider_request.workspace_id,
               provider_request.website_project_id,
               provider_request.id
             )=(
               request.organization_id,request.workspace_id,
               request.website_project_id,request.id
             )
           JOIN backlink_commercial_discovery_blueprints AS blueprint
             ON (
               blueprint.organization_id,blueprint.workspace_id,
               blueprint.website_project_id,
               blueprint.project_context_version_id
             )=(
               failed_job.organization_id,failed_job.workspace_id,
               failed_job.website_project_id,$5
             )
            AND blueprint.id::text=
                provider_request.request_payload#>>
                  '{__growthosDiscoveryPlannerLineage,blueprintId}'
           JOIN backlink_provider_usage_ledger AS usage
             ON (
               usage.organization_id,usage.workspace_id,
               usage.website_project_id,usage.provider_request_id
             )=(
               request.organization_id,request.workspace_id,
               request.website_project_id,request.id
             )
            AND usage.provider='dataforseo'
            AND usage.reservation_key=request.budget_reservation_id
            AND usage.status='reserved'
           JOIN provider_fetch_leases AS lease
             ON lease.artifact_fingerprint=request.normalized_request_hash
            AND lease.owner_request_id=request.request_id
          WHERE (
                  failed_job.organization_id,failed_job.workspace_id,
                  failed_job.website_project_id,failed_job.id
                )=($1,$2,$3,$4)
            AND failed_job.job_type='recommendation_refill'
            AND failed_job.source_object_type='recommendation_context'
            AND failed_job.source_object_id=$5
            AND request.provider_task_id IS NOT NULL
            AND provider_request.request_payload#>>
                  '{__growthosDiscoveryPlannerLineage,queryId}'
                ~'^[0-9a-f]{64}$'
            AND NOT EXISTS (
              SELECT 1
                FROM backlink_commercial_discovery_batches AS conflicting
               WHERE (
                 conflicting.organization_id,conflicting.workspace_id,
                 conflicting.website_project_id
               )=(
                 failed_job.organization_id,failed_job.workspace_id,
                 failed_job.website_project_id
               )
                 AND conflicting.project_context_version_id=$5
                 AND conflicting.visible_pool_generation=$6
                 AND conflicting.idempotency_key=
                   'commercial-discovery:'||
                   failed_refill.refill_window_key
                 AND conflicting.refill_job_id<>failed_job.id
            )
            AND (
              (
                request.status='running'
                AND provider_request.status='running'
                AND lease.status='acquired'
                AND lease.lease_expires_at<=now()
              )
              OR (
                request.status='unknown_charge'
                AND provider_request.status='unknown_charge'
                AND lease.status='unknown_charge'
              )
            )
       ),
       completed_provider_checkpoint AS MATERIALIZED (
         SELECT EXISTS (
           SELECT 1
             FROM backlink_commercial_discovery_batches AS batch
             JOIN provider_batch_requests AS request
               ON (
                 request.organization_id,request.workspace_id,
                 request.website_project_id
               )=(
                 batch.organization_id,batch.workspace_id,
                 batch.website_project_id
               )
              AND request.request_id LIKE
                  regexp_replace(
                  batch.idempotency_key,
                  '^commercial-discovery:',
                  ''
                )||':%'
             JOIN backlink_provider_requests AS provider_request
               ON (
                 provider_request.organization_id,
                 provider_request.workspace_id,
                 provider_request.website_project_id,
                 provider_request.id
               )=(
                 request.organization_id,request.workspace_id,
                 request.website_project_id,request.id
               )
             JOIN backlink_provider_usage_ledger AS usage
               ON (
                 usage.organization_id,usage.workspace_id,
                 usage.website_project_id,usage.provider_request_id
               )=(
                 request.organization_id,request.workspace_id,
                 request.website_project_id,request.id
               )
              AND usage.provider='dataforseo'
              AND usage.reservation_key=request.budget_reservation_id
             JOIN provider_fetch_leases AS lease
               ON lease.artifact_fingerprint=request.normalized_request_hash
              AND lease.owner_request_id=request.request_id
            WHERE (batch.organization_id,batch.workspace_id,
                   batch.website_project_id)=($1,$2,$3)
              AND batch.refill_job_id=$4
              AND batch.project_context_version_id=$5
              AND batch.visible_pool_generation=$6
              AND request.status='succeeded'
              AND provider_request.status='succeeded'
              AND request.provider_task_id IS NOT NULL
              AND request.actual_cost_micros IS NOT NULL
              AND usage.status='settled'
              AND lease.status='completed'
         ) AS value
       )
       SELECT (
         NOT EXISTS (
           SELECT 1
             FROM provider_batch_requests AS request
            WHERE (request.organization_id,request.workspace_id,
                   request.website_project_id)=($1,$2,$3)
              AND request.request_id LIKE
                  'commercial-refill:'||$3::text||':'||$5::text||
                  ':g'||$6::text||':%'
              AND request.status IN ('running','unknown_charge')
              AND NOT EXISTS (
                SELECT 1
                  FROM accepted_recovery AS accepted
                 WHERE accepted."providerRequestId"=request.id
              )
         )
         AND NOT EXISTS (
           SELECT 1
             FROM backlink_provider_usage_ledger AS usage
            WHERE (usage.organization_id,usage.workspace_id,
                   usage.website_project_id)=($1,$2,$3)
              AND usage.provider='dataforseo'
              AND usage.reservation_key LIKE
                  'commercial-refill:'||$3::text||':'||$5::text||
                  ':g'||$6::text||':%'
              AND usage.status='reserved'
              AND NOT EXISTS (
                SELECT 1
                  FROM accepted_recovery AS accepted
                 WHERE accepted."providerRequestId"=usage.provider_request_id
              )
         )
         AND NOT EXISTS (
           SELECT 1
             FROM provider_fetch_leases AS lease
            WHERE lease.owner_request_id LIKE
                  'commercial-refill:'||$3::text||':'||$5::text||
                  ':g'||$6::text||':%'
              AND lease.status IN ('acquired','unknown_charge')
              AND NOT EXISTS (
                SELECT 1
                  FROM accepted_recovery AS accepted
                 WHERE accepted."ownerRequestId"=lease.owner_request_id
                   AND accepted."artifactFingerprint"=
                     lease.artifact_fingerprint
             )
         )
       ) AS recoverable,
       (SELECT value FROM completed_provider_checkpoint)
         AS "completedProviderCheckpoint"`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.jobId,
        input.recommendationContextVersionId,
        input.visiblePoolGeneration,
      ],
    );
    retryFailedJob = sideEffects.rows[0]?.recoverable === true;
    completedProviderCheckpointRecovery =
      retryFailedJob
      && retryCount === maxRecoveryRetries
      && sideEffects.rows[0]?.completedProviderCheckpoint === true;
    if (
      retryCount === maxRecoveryRetries
      && !completedProviderCheckpointRecovery
    ) {
      retryFailedJob = false;
    }
  }
  if (status !== "queued" && !retryFailedJob) {
    return {
      status: "already_started",
      readyCount,
      jobId: input.jobId,
    };
  }

  if (readyCount >= input.targetPublishedCount) {
    const completed = await client.query(
      `UPDATE backlink_jobs
          SET status='success',step='inventory_sufficient',
              progress=100,
              result_summary=jsonb_build_object(
                'readyCount',$5::integer,
                'reason','inventory_sufficient'
              ),
              error=NULL,retry_count=retry_count+$6::integer,
              finished_at=now(),updated_at=now(),version=version+1
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND id=$4
          AND status=$7
        RETURNING id`,
      [
        ...values,
        readyCount,
        retryFailedJob ? 1 : 0,
        status,
      ],
    );
    if (completed.rows[0] === undefined) {
      throw new Error("BACKLINK_RECOMMENDATION_REFILL_JOB_STATE_CONFLICT");
    }
    return { status: "inventory_sufficient", readyCount };
  }

  const started = await client.query(
    `UPDATE backlink_jobs
        SET status='running',step='provider_request_reserved',
            progress=5,error=NULL,
            result_summary=NULLIF(
              jsonb_strip_nulls(
                jsonb_build_object(
                  'providerOperationId',
                    result_summary->'providerOperationId',
                  'providerBudgetAuthorization',
                    result_summary->'providerBudgetAuthorization',
                  'supplyMode',result_summary->'supplyMode',
                  'completedProviderCheckpointRecoveryAttempted',
                    CASE
                      WHEN $7::boolean THEN 'true'::jsonb
                      ELSE result_summary
                        ->'completedProviderCheckpointRecoveryAttempted'
                    END
                )
              ),
              '{}'::jsonb
            ),
            retry_count=retry_count+$5::integer,
            started_at=COALESCE(started_at,now()),
            finished_at=NULL,updated_at=now(),version=version+1
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND id=$4
        AND status=$6
      RETURNING id`,
    [
      ...values,
      retryFailedJob ? 1 : 0,
      status,
      completedProviderCheckpointRecovery,
    ],
  );
  if (started.rows[0] === undefined) {
    throw new Error("BACKLINK_RECOMMENDATION_REFILL_JOB_STATE_CONFLICT");
  }
  return {
    status: "started",
    readyCount,
    jobId: input.jobId,
  };
}
