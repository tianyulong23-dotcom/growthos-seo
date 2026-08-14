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
    `SELECT visible_pool_generation "visiblePoolGeneration",
            visible_pool_state "visiblePoolState"
       FROM backlink_commercial_inventory_policies
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
    || policy.rows[0]?.visiblePoolState !== "building"
  ) {
    throw new Error("COMMERCIAL_VISIBLE_POOL_GENERATION_STALE");
  }
  const ready = await client.query(
    `SELECT count(*)::integer AS count
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
        AND inventory.publication_status='PUBLISHED'
        AND inventory.fit_decision='eligible'
        AND inventory.fit_score_model_version=
          'recommendation-commercial-fit.v3'
        AND inventory.contact_decision='eligible'
        AND inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'
        AND inventory.verified_public_email_count>=1`,
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
    `SELECT job.status,job.retry_count,refill.refill_window_key
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
  const refillWindowKey = job.rows[0]?.refill_window_key;
  if (typeof status !== "string") {
    throw new Error("BACKLINK_RECOMMENDATION_REFILL_JOB_NOT_FOUND");
  }
  if (typeof refillWindowKey !== "string" || refillWindowKey.length === 0) {
    throw new Error("BACKLINK_RECOMMENDATION_REFILL_WINDOW_NOT_FOUND");
  }

  let retryFailedJob = false;
  if (
    status === "failed"
    && retryCount < maxRecoveryRetries
  ) {
    const sideEffects = await client.query(
      `SELECT (
         EXISTS (
           SELECT 1
             FROM backlink_provider_usage_ledger AS usage
            WHERE (usage.organization_id,usage.workspace_id,
                   usage.website_project_id)=($1,$2,$3)
              AND usage.provider='dataforseo'
               AND usage.reservation_key LIKE $4||':%'
              AND usage.status='reserved'
          )
          OR EXISTS (
            SELECT 1
              FROM provider_batch_requests AS request
             WHERE (request.organization_id,request.workspace_id,
                    request.website_project_id)=($1,$2,$3)
               AND request.request_id LIKE $4||':%'
               AND request.status IN ('running','unknown_charge')
          )
          OR EXISTS (
            SELECT 1
              FROM provider_fetch_leases AS lease
             WHERE lease.owner_request_id LIKE $4||':%'
               AND (
                 lease.status='unknown_charge'
                 OR (
                   lease.status='acquired'
                   AND lease.lease_expires_at>now()
                 )
               )
          )
       ) AS blocked`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        refillWindowKey,
      ],
    );
    retryFailedJob = sideEffects.rows[0]?.blocked === false;
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
            progress=5,error=NULL,result_summary=NULL,
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
