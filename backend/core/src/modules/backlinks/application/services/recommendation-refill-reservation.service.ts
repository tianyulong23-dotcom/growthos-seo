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
  jobId: string;
  lowWatermark: number;
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

const maxPreProviderRecoveryRetries = 2;

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
  const ready = await client.query(
    `SELECT count(*)::integer AS count
       FROM backlink_recommendation_inventory
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND status IN ('ready','shown')`,
    values.slice(0, 3),
  );
  const readyCount = integerFrom(ready.rows[0]?.count);
  const job = await client.query(
    `SELECT status,retry_count
       FROM backlink_jobs
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND id=$4
      FOR UPDATE`,
    values,
  );
  const status = job.rows[0]?.status;
  const retryCount = integerFrom(job.rows[0]?.retry_count);
  if (typeof status !== "string") {
    throw new Error("BACKLINK_RECOMMENDATION_REFILL_JOB_NOT_FOUND");
  }

  let retryFailedJob = false;
  if (
    status === "failed"
    && retryCount < maxPreProviderRecoveryRetries
  ) {
    const sideEffects = await client.query(
      `SELECT (
         EXISTS (
           SELECT 1
             FROM backlink_provider_usage_ledger
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3
              AND provider='dataforseo'
              AND reservation_key=$4
         )
         OR EXISTS (
           SELECT 1
             FROM provider_batch_requests
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3
              AND request_id=$4
              AND (
                status<>'failed'
                OR actual_cost_micros IS NOT NULL
                OR provider_task_id IS NOT NULL
              )
         )
       ) AS blocked`,
      values,
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

  if (readyCount >= input.lowWatermark) {
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
            started_at=CASE WHEN $5::integer=1 THEN now()
                            ELSE COALESCE(started_at,now()) END,
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
