import { createHash } from "node:crypto";

import type { BacklinkTransactionClient } from "../../db/tenant-transaction.js";
import type { RecommendationRefillSupersessionSignal } from "../../workflows/definitions/backlink-recommendation-refill.orchestration.js";

export type RecommendationRefillSupersessionResult = Readonly<{
  status:
    | "cancelled"
    | "awaiting_provider_reconciliation"
    | "no_change";
  replayed: boolean;
}>;

export type RecommendationRefillSupersessionRequestResult = Readonly<{
  status: "requested" | "no_change";
  replayed: boolean;
}>;

export type RecommendationRefillFailureArbitrationResult =
  | Readonly<{ status: "failed" }>
  | Readonly<{
      status: "superseded";
      supersession: RecommendationRefillSupersessionSignal;
    }>
  | Readonly<{
      status: "awaiting_provider_reconciliation";
      supersession: RecommendationRefillSupersessionSignal;
    }>;

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function contextIdentity(
  value: unknown,
): RecommendationRefillSupersessionSignal["oldContext"] | null {
  const record = object(value);
  if (record === null) return null;
  const snapshotVersion = Number(record.snapshotVersion);
  if (
    typeof record.contextVersionId !== "string"
    || !Number.isSafeInteger(snapshotVersion)
    || snapshotVersion < 1
    || typeof record.profileVersionId !== "string"
    || typeof record.promotionTargetVersionId !== "string"
    || typeof record.generationInputFingerprint !== "string"
  ) {
    return null;
  }
  return Object.freeze({
    contextVersionId: record.contextVersionId,
    snapshotVersion,
    profileVersionId: record.profileVersionId,
    promotionTargetVersionId: record.promotionTargetVersionId,
    generationInputFingerprint: record.generationInputFingerprint,
  });
}

function supersessionSignal(
  value: unknown,
): RecommendationRefillSupersessionSignal | null {
  if (typeof value === "string") {
    try {
      return supersessionSignal(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  const record = object(value);
  if (record === null || record.contractVersion !== 1) return null;
  const oldContext = contextIdentity(record.oldContext);
  const authoritativeContext = contextIdentity(record.authoritativeContext);
  if (
    oldContext === null
    || authoritativeContext === null
    || authoritativeContext.snapshotVersion <= oldContext.snapshotVersion
  ) {
    return null;
  }
  const strings = [
    "organizationId",
    "workspaceId",
    "websiteProjectId",
    "jobId",
    "workflowId",
    "actorId",
    "correlationId",
    "requestId",
    "idempotencyKey",
    "lifecycleEventId",
    "auditEventId",
  ] as const;
  if (strings.some((key) => typeof record[key] !== "string")) return null;
  return Object.freeze({
    contractVersion: 1,
    organizationId: String(record.organizationId),
    workspaceId: String(record.workspaceId),
    websiteProjectId: String(record.websiteProjectId),
    jobId: String(record.jobId),
    workflowId: String(record.workflowId),
    oldContext,
    authoritativeContext,
    actorId: String(record.actorId),
    correlationId: String(record.correlationId),
    requestId: String(record.requestId),
    idempotencyKey: String(record.idempotencyKey),
    lifecycleEventId: String(record.lifecycleEventId),
    auditEventId: String(record.auditEventId),
  });
}

const requestSupersessionSql =
  `WITH locked_job AS (
     SELECT job.*,
            refill.id "refillId",
            old_context.snapshot_version "oldSnapshotVersion",
            old_context.profile_version_id "oldProfileVersionId",
            old_context.promotion_target_version_id
              "oldPromotionTargetVersionId",
            old_pin.immutable_fingerprint "oldGenerationInputFingerprint",
            latest_context.id "newContextVersionId",
            latest_context.snapshot_version "newSnapshotVersion",
            latest_context.profile_version_id "newProfileVersionId",
            latest_context.promotion_target_version_id
              "newPromotionTargetVersionId",
            latest_pin.immutable_fingerprint
              "newGenerationInputFingerprint"
       FROM backlink_jobs AS job
       JOIN backlink_recommendation_refills AS refill
         ON (refill.organization_id,refill.workspace_id,
             refill.website_project_id,refill.job_id,
             refill.recommendation_context_version_id)=
            (job.organization_id,job.workspace_id,
             job.website_project_id,job.id,job.source_object_id)
       JOIN backlink_project_context_snapshots AS old_context
         ON (old_context.organization_id,old_context.workspace_id,
             old_context.website_project_id,old_context.id)=
            (job.organization_id,job.workspace_id,
             job.website_project_id,job.source_object_id)
       JOIN backlink_generation_input_pins AS old_pin
         ON (old_pin.organization_id,old_pin.workspace_id,
             old_pin.website_project_id,old_pin.project_context_version)=
            (old_context.organization_id,old_context.workspace_id,
             old_context.website_project_id,old_context.snapshot_version)
       JOIN LATERAL (
         SELECT snapshot.*
           FROM backlink_project_context_snapshots AS snapshot
          WHERE (snapshot.organization_id,snapshot.workspace_id,
                 snapshot.website_project_id)=
                (job.organization_id,job.workspace_id,
                 job.website_project_id)
          ORDER BY snapshot.snapshot_version DESC
          LIMIT 1
       ) AS latest_context ON true
       JOIN backlink_generation_input_pins AS latest_pin
         ON (latest_pin.organization_id,latest_pin.workspace_id,
             latest_pin.website_project_id,
             latest_pin.project_context_version)=
            (latest_context.organization_id,latest_context.workspace_id,
             latest_context.website_project_id,
             latest_context.snapshot_version)
      WHERE (job.organization_id,job.workspace_id,
             job.website_project_id,job.id)=($1,$2,$3,$4)
        AND job.job_type='recommendation_refill'
        AND job.source_object_type='recommendation_context'
      FOR UPDATE OF job
   ),
   authority AS (
     SELECT *,
            (
              workflow_id=$5
              AND source_object_id=$6::uuid
              AND "oldSnapshotVersion"=$7
              AND "oldProfileVersionId"=$8
              AND "oldPromotionTargetVersionId"=$9
              AND "oldGenerationInputFingerprint"=$10
              AND "newContextVersionId"=$11::uuid
              AND "newSnapshotVersion"=$12
              AND "newProfileVersionId"=$13
              AND "newPromotionTargetVersionId"=$14
              AND "newGenerationInputFingerprint"=$15
              AND "newSnapshotVersion">"oldSnapshotVersion"
            ) authorized,
            COALESCE(
              result_summary->'supersessionRequest'->'signal'=$16::jsonb,
              false
            ) replayed,
            COALESCE(
              result_summary ? 'supersessionRequest',
              false
            ) has_request
       FROM locked_job
   ),
   requested_job AS (
     UPDATE backlink_jobs AS job
        SET result_summary=jsonb_set(
              COALESCE(job.result_summary,'{}'::jsonb),
              '{supersessionRequest}',
              jsonb_build_object(
                'state','requested',
                'signal',$16::jsonb,
                'requestedAt',$17::timestamptz
              ),
              true
            ),
            updated_at=$17,
            updated_by=$18,
            version=job.version+1
       FROM authority
      WHERE job.id=authority.id
        AND authority.authorized
        AND NOT authority.replayed
        AND NOT authority.has_request
        AND job.status IN ('queued','running','waiting_provider','failed')
     RETURNING job.id,job.version,job.correlation_id
   ),
   lifecycle AS (
     INSERT INTO backlink_lifecycle_events (
       id,organization_id,workspace_id,website_project_id,job_id,
       aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
       actor_type,actor_id,before_state,after_state,reason,correlation_id,
       idempotency_key,created_at
     )
     SELECT $19,$1,$2,$3,requested_job.id,
            'recommendation_refill',authority."refillId",
            requested_job.version,requested_job.version,
            'recommendation_refill.supersession_requested','system',$18,
            jsonb_build_object(
              'status',authority.status,
              'contextVersionId',$6,
              'snapshotVersion',$7
            ),
            jsonb_build_object(
              'status',authority.status,
              'authoritativeContextVersionId',$11,
              'authoritativeSnapshotVersion',$12
            ),
            'superseded_project_context',$20,$21,$17
       FROM requested_job
       JOIN authority ON authority.id=requested_job.id
     ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
     RETURNING id
   ),
   audit AS (
     INSERT INTO backlink_audit_events (
       id,organization_id,workspace_id,website_project_id,job_id,
       lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,
       outcome,reason,before_redacted,after_redacted,request_id,
       correlation_id,integrity_hash,created_at
     )
     SELECT $22,$1,$2,$3,$4,lifecycle.id,$18,'system',
            'recommendation_refill.supersession_requested',
            'recommendation_refill',authority."refillId",
            'success','superseded_project_context',
            jsonb_build_object('contextVersionId',$6,'snapshotVersion',$7),
            jsonb_build_object('contextVersionId',$11,'snapshotVersion',$12),
            $23,$20,$24,$17
       FROM lifecycle
       JOIN authority ON true
     RETURNING id
   )
   SELECT CASE
            WHEN NOT COALESCE(authority.authorized,false) THEN 'no_change'
            WHEN authority.replayed
              OR EXISTS (SELECT 1 FROM requested_job) THEN 'requested'
            ELSE 'no_change'
          END status,
          COALESCE(authority.replayed,false) replayed
     FROM authority
   UNION ALL
   SELECT 'no_change',false
   WHERE NOT EXISTS (SELECT 1 FROM authority)
   LIMIT 1`;

export async function requestRecommendationRefillSupersession(
  client: BacklinkTransactionClient,
  input: Readonly<{
    signal: RecommendationRefillSupersessionSignal;
    now: Date;
    integrityHash: string;
  }>,
): Promise<RecommendationRefillSupersessionRequestResult> {
  const { signal } = input;
  const requestIdempotencyKey = `${signal.idempotencyKey}:requested`;
  const result = await client.query(requestSupersessionSql, [
    signal.organizationId,
    signal.workspaceId,
    signal.websiteProjectId,
    signal.jobId,
    signal.workflowId,
    signal.oldContext.contextVersionId,
    signal.oldContext.snapshotVersion,
    signal.oldContext.profileVersionId,
    signal.oldContext.promotionTargetVersionId,
    signal.oldContext.generationInputFingerprint,
    signal.authoritativeContext.contextVersionId,
    signal.authoritativeContext.snapshotVersion,
    signal.authoritativeContext.profileVersionId,
    signal.authoritativeContext.promotionTargetVersionId,
    signal.authoritativeContext.generationInputFingerprint,
    JSON.stringify(signal),
    input.now,
    signal.actorId,
    deterministicUuid(`lifecycle:${requestIdempotencyKey}`),
    signal.correlationId,
    requestIdempotencyKey,
    deterministicUuid(`audit:${requestIdempotencyKey}`),
    signal.requestId,
    input.integrityHash,
  ]);
  const row = result.rows[0];
  return Object.freeze({
    status: row?.status === "requested" ? "requested" : "no_change",
    replayed: row?.replayed === true || row?.replayed === "true",
  });
}

const completeSupersessionSql =
  `WITH locked_job AS (
     SELECT job.*,
             refill.id "refillId",
             refill.visible_pool_generation "visiblePoolGeneration",
            old_context.snapshot_version "oldSnapshotVersion",
            old_context.profile_version_id "oldProfileVersionId",
            old_context.promotion_target_version_id
              "oldPromotionTargetVersionId",
            old_pin.immutable_fingerprint "oldGenerationInputFingerprint",
            latest_context.id "newContextVersionId",
            latest_context.snapshot_version "newSnapshotVersion",
            latest_context.profile_version_id "newProfileVersionId",
            latest_context.promotion_target_version_id
              "newPromotionTargetVersionId",
            latest_pin.immutable_fingerprint
              "newGenerationInputFingerprint"
       FROM backlink_jobs AS job
       JOIN backlink_recommendation_refills AS refill
         ON (refill.organization_id,refill.workspace_id,
             refill.website_project_id,refill.job_id,
             refill.recommendation_context_version_id)=
             (job.organization_id,job.workspace_id,
             job.website_project_id,job.id,job.source_object_id)
       JOIN backlink_project_context_snapshots AS old_context
         ON (old_context.organization_id,old_context.workspace_id,
             old_context.website_project_id,old_context.id)=
            (job.organization_id,job.workspace_id,
             job.website_project_id,job.source_object_id)
       JOIN backlink_generation_input_pins AS old_pin
         ON (old_pin.organization_id,old_pin.workspace_id,
             old_pin.website_project_id,old_pin.project_context_version)=
            (old_context.organization_id,old_context.workspace_id,
             old_context.website_project_id,old_context.snapshot_version)
       JOIN LATERAL (
         SELECT snapshot.*
           FROM backlink_project_context_snapshots AS snapshot
          WHERE (snapshot.organization_id,snapshot.workspace_id,
                 snapshot.website_project_id)=
                (job.organization_id,job.workspace_id,
                 job.website_project_id)
          ORDER BY snapshot.snapshot_version DESC
          LIMIT 1
       ) AS latest_context ON true
       JOIN backlink_generation_input_pins AS latest_pin
         ON (latest_pin.organization_id,latest_pin.workspace_id,
             latest_pin.website_project_id,
             latest_pin.project_context_version)=
            (latest_context.organization_id,latest_context.workspace_id,
             latest_context.website_project_id,
             latest_context.snapshot_version)
      WHERE (job.organization_id,job.workspace_id,
             job.website_project_id,job.id)=($1,$2,$3,$4)
        AND job.job_type='recommendation_refill'
        AND job.source_object_type='recommendation_context'
      FOR UPDATE OF job
   ),
   authority AS (
     SELECT *,
            (
              workflow_id=$5
              AND source_object_id=$6::uuid
              AND "oldSnapshotVersion"=$7
              AND "oldProfileVersionId"=$8
              AND "oldPromotionTargetVersionId"=$9
              AND "oldGenerationInputFingerprint"=$10
              AND "newContextVersionId"=$11::uuid
              AND "newSnapshotVersion"=$12
              AND "newProfileVersionId"=$13
              AND "newPromotionTargetVersionId"=$14
              AND "newGenerationInputFingerprint"=$15
              AND "newSnapshotVersion">"oldSnapshotVersion"
            ) authorized,
            (
               status='cancelled'
               AND step='superseded_project_context'
               AND result_summary->'supersession'
                     ->>'authoritativeContextVersionId'=$11::text
            ) replayed,
            (
              result_summary->'supersessionRequest'->'signal'=$24::jsonb
            ) request_matches
       FROM locked_job
   ),
   blockers AS (
     SELECT (
       EXISTS (
         SELECT 1
           FROM backlink_commercial_discovery_batches AS batch
           JOIN provider_batch_requests AS request
             ON (request.organization_id,request.workspace_id,
                 request.website_project_id)=
                (batch.organization_id,batch.workspace_id,
                 batch.website_project_id)
            AND request.request_id LIKE
                regexp_replace(
                  batch.idempotency_key,
                  '^commercial-discovery:',
                  ''
                )||':%'
           JOIN provider_fetch_leases AS lease
             ON lease.artifact_fingerprint=request.normalized_request_hash
            AND lease.owner_request_id=request.request_id
          WHERE (batch.organization_id,batch.workspace_id,
                 batch.website_project_id,batch.refill_job_id)=
                ($1,$2,$3,$4)
            AND lease.status IN ('acquired','unknown_charge')
       )
       OR EXISTS (
         SELECT 1
           FROM backlink_commercial_discovery_batches AS batch
           JOIN provider_batch_requests AS request
             ON (request.organization_id,request.workspace_id,
                 request.website_project_id)=
                (batch.organization_id,batch.workspace_id,
                 batch.website_project_id)
            AND request.request_id LIKE
                regexp_replace(
                  batch.idempotency_key,
                  '^commercial-discovery:',
                  ''
                )||':%'
           JOIN backlink_provider_usage_ledger AS usage
             ON (usage.organization_id,usage.workspace_id,
                 usage.website_project_id,usage.provider_request_id)=
                (request.organization_id,request.workspace_id,
                 request.website_project_id,request.id)
            AND usage.provider='dataforseo'
            AND usage.reservation_key=request.budget_reservation_id
          WHERE (batch.organization_id,batch.workspace_id,
                 batch.website_project_id,batch.refill_job_id)=
                ($1,$2,$3,$4)
            AND usage.status='reserved'
       )
       OR EXISTS (
         SELECT 1
           FROM backlink_commercial_discovery_batches AS batch
           JOIN provider_batch_requests AS request
             ON (request.organization_id,request.workspace_id,
                 request.website_project_id)=
                (batch.organization_id,batch.workspace_id,
                 batch.website_project_id)
            AND request.request_id LIKE
                regexp_replace(
                  batch.idempotency_key,
                  '^commercial-discovery:',
                  ''
                )||':%'
          WHERE (batch.organization_id,batch.workspace_id,
                 batch.website_project_id,batch.refill_job_id)=
                ($1,$2,$3,$4)
            AND request.status IN ('running','unknown_charge')
       )
     ) blocked
   ),
   cancelled_job AS (
     UPDATE backlink_jobs AS job
        SET status='cancelled',
            step='superseded_project_context',
            progress=100,
            result_summary=jsonb_build_object(
              'final',true,
              'outcome','CANCELLED',
              'reason','superseded_project_context',
              'supersessionRequest',
                authority.result_summary->'supersessionRequest',
              'supersession',jsonb_build_object(
                'oldContextVersionId',$6,
                'oldSnapshotVersion',$7,
                'authoritativeContextVersionId',$11,
                'authoritativeSnapshotVersion',$12,
                'authoritativeGenerationInputFingerprint',$15
              )
            ),
            error=NULL,
            finished_at=CASE
              WHEN job.status='failed' THEN $16
              ELSE COALESCE(job.finished_at,$16)
            END,
            updated_at=$16,
            updated_by=$17,
            version=job.version+1
       FROM authority,blockers
      WHERE job.id=authority.id
        AND authority.authorized
        AND NOT authority.replayed
        AND NOT blockers.blocked
        AND (
          job.status IN ('queued','running','waiting_provider')
          OR (job.status='failed' AND authority.request_matches)
        )
       RETURNING job.id,job.version,job.correlation_id
   ),
   closed_batches AS (
     UPDATE backlink_commercial_discovery_batches AS batch
        SET status='stale_context',
            pause_reason='superseded_project_context',
            finished_at=COALESCE(batch.finished_at,$16)
      WHERE (batch.organization_id,batch.workspace_id,
             batch.website_project_id,batch.refill_job_id)=
            ($1,$2,$3,$4)
        AND batch.status IN ('running','failed')
        AND EXISTS (SELECT 1 FROM cancelled_job)
     RETURNING batch.id
   ),
   released_policy AS (
     UPDATE backlink_commercial_inventory_policies AS policy
        SET visible_pool_state='idle',
            refill_state='paused',
            termination_reason='PROJECT_CONTEXT',
            pause_reason='superseded_project_context',
            next_refill_at=NULL,
             updated_at=$16,
             updated_by=$17,
             version=policy.version+1
       FROM authority
       WHERE (policy.organization_id,policy.workspace_id,
              policy.website_project_id,
              policy.project_context_version_id)=($1,$2,$3,$6)
         AND policy.visible_pool_generation=authority."visiblePoolGeneration"
         AND EXISTS (SELECT 1 FROM cancelled_job)
     RETURNING policy.project_context_version_id
   ),
   lifecycle AS (
     INSERT INTO backlink_lifecycle_events (
       id,organization_id,workspace_id,website_project_id,job_id,
       aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
       actor_type,actor_id,before_state,after_state,reason,correlation_id,
       idempotency_key,created_at
     )
     SELECT $18,$1,$2,$3,cancelled_job.id,
            'recommendation_refill',authority."refillId",
            cancelled_job.version,cancelled_job.version,
            'recommendation_refill.superseded','system',$17,
            jsonb_build_object(
              'status',authority.status,
              'contextVersionId',$6,
              'snapshotVersion',$7
            ),
            jsonb_build_object(
              'status','cancelled',
              'contextVersionId',$11,
              'snapshotVersion',$12
            ),
            'superseded_project_context',$19,$20,$16
       FROM cancelled_job
       JOIN authority ON authority.id=cancelled_job.id
     ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
     RETURNING id
   ),
   audit AS (
     INSERT INTO backlink_audit_events (
       id,organization_id,workspace_id,website_project_id,job_id,
       lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,
       outcome,reason,before_redacted,after_redacted,request_id,
       correlation_id,integrity_hash,created_at
     )
     SELECT $21,$1,$2,$3,$4,lifecycle.id,$17,'system',
            'recommendation_refill.superseded','recommendation_refill',
            authority."refillId",
            'success','superseded_project_context',
            jsonb_build_object('contextVersionId',$6,'snapshotVersion',$7),
            jsonb_build_object('contextVersionId',$11,'snapshotVersion',$12),
            $22,$19,$23,$16
       FROM lifecycle
       JOIN authority ON true
     RETURNING id
   )
   SELECT CASE
            WHEN NOT COALESCE(authority.authorized,false) THEN 'no_change'
            WHEN authority.replayed
              OR EXISTS (SELECT 1 FROM cancelled_job) THEN 'cancelled'
            WHEN blockers.blocked THEN 'awaiting_provider_reconciliation'
            ELSE 'no_change'
          END status,
          COALESCE(authority.replayed,false) replayed
     FROM blockers
     LEFT JOIN authority ON true`;

export async function completeRecommendationRefillSupersession(
  client: BacklinkTransactionClient,
  input: Readonly<{
    signal: RecommendationRefillSupersessionSignal;
    now: Date;
    integrityHash: string;
  }>,
): Promise<RecommendationRefillSupersessionResult> {
  const { signal } = input;
  const result = await client.query(completeSupersessionSql, [
    signal.organizationId,
    signal.workspaceId,
    signal.websiteProjectId,
    signal.jobId,
    signal.workflowId,
    signal.oldContext.contextVersionId,
    signal.oldContext.snapshotVersion,
    signal.oldContext.profileVersionId,
    signal.oldContext.promotionTargetVersionId,
    signal.oldContext.generationInputFingerprint,
    signal.authoritativeContext.contextVersionId,
    signal.authoritativeContext.snapshotVersion,
    signal.authoritativeContext.profileVersionId,
    signal.authoritativeContext.promotionTargetVersionId,
    signal.authoritativeContext.generationInputFingerprint,
    input.now,
    signal.actorId,
    signal.lifecycleEventId,
    signal.correlationId,
    signal.idempotencyKey,
    signal.auditEventId,
    signal.requestId,
    input.integrityHash,
    JSON.stringify(signal),
  ]);
  const row = result.rows[0];
  const status = row?.status;
  if (
    status !== "cancelled"
    && status !== "awaiting_provider_reconciliation"
    && status !== "no_change"
  ) {
    return Object.freeze({ status: "no_change", replayed: false });
  }
  return Object.freeze({
    status,
    replayed: row?.replayed === true || row?.replayed === "true",
  });
}

const providerExecutionPreflightSql =
  `SELECT job.source_object_id "jobContextVersionId",
          current_context.snapshot_version "jobSnapshotVersion",
          latest_context.id "latestContextVersionId",
          latest_context.snapshot_version "latestSnapshotVersion",
          job.result_summary->'supersessionRequest'->'signal'
            "supersessionSignal"
     FROM backlink_jobs AS job
     JOIN backlink_project_context_snapshots AS current_context
       ON (current_context.organization_id,current_context.workspace_id,
           current_context.website_project_id,current_context.id)=
          (job.organization_id,job.workspace_id,
           job.website_project_id,job.source_object_id)
     JOIN backlink_generation_input_pins AS current_pin
       ON (current_pin.organization_id,current_pin.workspace_id,
           current_pin.website_project_id,
           current_pin.project_context_version)=
          (current_context.organization_id,current_context.workspace_id,
           current_context.website_project_id,
           current_context.snapshot_version)
     JOIN LATERAL (
       SELECT snapshot.*
         FROM backlink_project_context_snapshots AS snapshot
        WHERE (snapshot.organization_id,snapshot.workspace_id,
               snapshot.website_project_id)=
              (job.organization_id,job.workspace_id,
               job.website_project_id)
        ORDER BY snapshot.snapshot_version DESC
        LIMIT 1
     ) AS latest_context ON true
     JOIN backlink_generation_input_pins AS latest_pin
       ON (latest_pin.organization_id,latest_pin.workspace_id,
           latest_pin.website_project_id,
           latest_pin.project_context_version)=
          (latest_context.organization_id,latest_context.workspace_id,
           latest_context.website_project_id,
           latest_context.snapshot_version)
    WHERE (job.organization_id,job.workspace_id,
           job.website_project_id,job.id)=($1,$2,$3,$4)
      AND job.job_type='recommendation_refill'
      AND job.source_object_type='recommendation_context'
      AND job.source_object_id=$5::uuid`;

export async function assertRecommendationRefillProviderExecutionCurrent(
  client: BacklinkTransactionClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    jobId: string;
    recommendationContextVersionId: string;
  }>,
): Promise<void> {
  const result = await client.query(providerExecutionPreflightSql, [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.jobId,
    input.recommendationContextVersionId,
  ]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      "BACKLINK_RECOMMENDATION_REFILL_CONTEXT_IDENTITY_MISMATCH",
    );
  }
  if (
    row.supersessionSignal !== null
    && row.supersessionSignal !== undefined
  ) {
    throw new Error(
      "BACKLINK_RECOMMENDATION_REFILL_SUPERSEDED_PROJECT_CONTEXT",
    );
  }
  const jobSnapshotVersion = Number(row.jobSnapshotVersion);
  const latestSnapshotVersion = Number(row.latestSnapshotVersion);
  if (
    !Number.isSafeInteger(jobSnapshotVersion)
    || !Number.isSafeInteger(latestSnapshotVersion)
    || latestSnapshotVersion > jobSnapshotVersion
  ) {
    throw new Error(
      "BACKLINK_RECOMMENDATION_REFILL_SUPERSEDED_PROJECT_CONTEXT",
    );
  }
}

const readSupersessionRequestSql =
  `SELECT result_summary->'supersessionRequest'->'signal'
            "supersessionSignal"
     FROM backlink_jobs
    WHERE (organization_id,workspace_id,website_project_id,id)=
          ($1,$2,$3,$4)
      AND job_type='recommendation_refill'
      AND source_object_type='recommendation_context'
      AND source_object_id=$5::uuid
    FOR UPDATE`;

const recordFailureSql =
  `WITH failed_refill AS (
      SELECT refill.refill_window_key "refillWindowKey",
             refill.recommendation_context_version_id
               "recommendationContextVersionId",
             refill.visible_pool_generation "visiblePoolGeneration"
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
         AND job.website_project_id=$3 AND job.id=$4::uuid
         AND job.source_object_id=$5::uuid
    ),
    provider_call AS (
      SELECT (
        EXISTS (
          SELECT 1
            FROM failed_refill
            JOIN backlink_provider_usage_ledger AS usage
              ON usage.organization_id=$1
             AND usage.workspace_id=$2
             AND usage.website_project_id=$3
             AND usage.provider='dataforseo'
             AND usage.reservation_key LIKE
                 failed_refill."refillWindowKey"||':%'
             AND usage.status IN ('reserved','settled')
        )
        OR EXISTS (
          SELECT 1
            FROM failed_refill
            JOIN provider_batch_requests AS request
              ON request.organization_id=$1
             AND request.workspace_id=$2
             AND request.website_project_id=$3
             AND request.request_id LIKE
                 failed_refill."refillWindowKey"||':%'
             AND (
               request.status<>'failed'
               OR request.actual_cost_micros IS NOT NULL
               OR request.provider_task_id IS NOT NULL
             )
        )
      ) occurred
    ),
    failed_job AS (
      UPDATE backlink_jobs AS job
         SET status='failed',
             step='provider_request_failed',
             progress=100,
             error=jsonb_build_object(
               'code',$6::text,
               'rootCause',$7::text,
               'recovery',$8::text,
               'providerCallOccurred',provider_call.occurred,
               'diagnosticId',$9::text,
               'message',$10::text
             ),
             finished_at=$11,
             updated_at=$11,
             updated_by=$12,
             version=job.version+1
        FROM provider_call
       WHERE (job.organization_id,job.workspace_id,
              job.website_project_id,job.id)=($1,$2,$3,$4)
         AND job.source_object_id=$5::uuid
         AND job.status IN ('queued','running','waiting_provider')
      RETURNING job.id
    ),
    failed_policy AS (
      UPDATE backlink_commercial_inventory_policies AS policy
         SET refill_state='paused',
             termination_reason=CASE $7::text
               WHEN 'BUDGET_PAUSED' THEN 'BUDGET'
               WHEN 'PROVIDER_UNAVAILABLE' THEN 'PROVIDER_UNAVAILABLE'
               WHEN 'PROJECT_CONTEXT_REQUIRED' THEN 'PROJECT_CONTEXT'
               ELSE NULL
             END,
             pause_reason=lower($7::text)||':'||$9::text,
             next_refill_at=CASE
               WHEN $7::text IN (
                 'BUDGET_PAUSED','PROVIDER_UNAVAILABLE'
               ) THEN $11::timestamptz+interval '5 minutes'
               ELSE NULL
             END,
             updated_at=$11,
             updated_by=$12,
             version=policy.version+1
        FROM failed_refill,failed_job
       WHERE (
         policy.organization_id,policy.workspace_id,
         policy.website_project_id,
         policy.project_context_version_id
       )=(
         $1,$2,$3,failed_refill."recommendationContextVersionId"
       )
         AND policy.visible_pool_generation=
             failed_refill."visiblePoolGeneration"
      RETURNING policy.project_context_version_id
    )
    SELECT
      (SELECT count(*) FROM failed_job) "failedJobCount",
      (SELECT count(*) FROM failed_policy) "failedPolicyCount"`;

export async function arbitrateRecommendationRefillFailure(
  client: BacklinkTransactionClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    recommendationContextVersionId: string;
    jobId: string;
    errorCode: string;
    rootCause: string;
    recovery: string;
    diagnosticId: string;
    message: string;
    actorId: string;
    now: Date;
    integrityHash: string;
  }>,
): Promise<RecommendationRefillFailureArbitrationResult> {
  const request = await client.query(readSupersessionRequestSql, [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.jobId,
    input.recommendationContextVersionId,
  ]);
  const rawSignal = request.rows[0]?.supersessionSignal;
  if (rawSignal !== null && rawSignal !== undefined) {
    const signal = supersessionSignal(rawSignal);
    if (signal === null) {
      throw new Error(
        "BACKLINK_RECOMMENDATION_REFILL_SUPERSESSION_REQUEST_INVALID",
      );
    }
    const completion = await completeRecommendationRefillSupersession(
      client,
      { signal, now: input.now, integrityHash: input.integrityHash },
    );
    if (completion.status === "cancelled") {
      return Object.freeze({ status: "superseded", supersession: signal });
    }
    if (completion.status === "awaiting_provider_reconciliation") {
      return Object.freeze({
        status: "awaiting_provider_reconciliation",
        supersession: signal,
      });
    }
    throw new Error(
      "BACKLINK_RECOMMENDATION_REFILL_SUPERSESSION_AUTHORITY_CONFLICT",
    );
  }

  await client.query(recordFailureSql, [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.jobId,
    input.recommendationContextVersionId,
    input.errorCode,
    input.rootCause,
    input.recovery,
    input.diagnosticId,
    input.message,
    input.now,
    input.actorId,
  ]);
  return Object.freeze({ status: "failed" });
}
