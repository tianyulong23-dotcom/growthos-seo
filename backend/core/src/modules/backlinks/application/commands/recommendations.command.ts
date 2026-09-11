import { createHash, randomUUID } from "node:crypto";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import { commercialDiscoveryBlueprintVersion } from "../../domain/recommendations/commercial-discovery-blueprint.js";
import {
  bindProviderOperationBudgetAuthorization,
  parseProviderOperationBudgetAuthorization,
  type ProviderOperationBudgetAuthorization,
  type ProviderOperationBudgetGrant,
} from "../../domain/recommendations/provider-operation-budget.js";
import { buildBacklinksWorkflowId } from "../../workflows/namespaces.js";

export type RecommendationCommandClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;
export type RecommendationCommandOptions = Readonly<{
  persistentProviderBudgetGrant?: ProviderOperationBudgetGrant | null;
}>;
type Common = Readonly<{
  context: ResolvedProjectContext;
  idempotencyKey: string;
  requestId: string;
  expectedVersion: number;
}>;
export type RejectRecommendationCommand = Common &
  Readonly<{
    recommendationId: string;
    rejectionType: "skipped" | "permanently_rejected";
    reasonCode: string;
    cooldownUntil: string | null;
  }>;
export type RequestRecommendationRefillCommand = Readonly<{
  context: ResolvedProjectContext;
  requestId: string;
  expectedVersion: number;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  lowWatermark: number;
  highWatermark: number;
  operationId?: string;
  refillWindowKey?: string;
  triggerReason?: "inventory_low" | "manual";
  providerBudgetAuthorization?: ProviderOperationBudgetGrant;
  supplyMode?: "existing_evidence";
}>;
export type ArchiveRecommendationPoolCommand = Readonly<{
  context: ResolvedProjectContext;
  requestId: string;
  idempotencyKey: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
}>;
export type CancelQueuedRecommendationRefillCommand = Common &
  Readonly<{
    jobId: string;
    reasonCode: "read_side_effect_cleanup";
  }>;
export type CloseDuplicateRecommendationRefillCommand = Common &
  Readonly<{
    duplicateJobId: string;
    canonicalJobId: string;
    reasonCode: "duplicate_recovery_owner";
  }>;
export type RejectRecommendationResult = Readonly<{
  recommendationId: string;
  status: "rejected";
  version: number;
  lifecycleEventId: string;
  auditEventId: string;
  replayed: boolean;
}>;
export type RecommendationRefillResult = Readonly<{
  operationId: string;
  jobId: string;
  workflowId: string;
  outboxEventId?: string;
  status: "queued";
  version: number;
  visiblePoolGeneration: number;
  lifecycleEventId: string;
  auditEventId: string;
  replayed: boolean;
}>;
export type ArchiveRecommendationPoolResult = Readonly<{
  archivedGeneration: number;
  nextGeneration: number;
  archivedCount: number;
  preparedCandidateCount: number;
  state: "awaiting_refresh";
  version: number;
  lifecycleEventId: string;
  auditEventId: string;
  replayed: boolean;
}>;
export type CancelQueuedRecommendationRefillResult = Readonly<{
  jobId: string;
  refillId: string;
  outboxEventId: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  status: "cancelled";
  outboxStatus: "published";
  dispatchDisposition: "cancelled_before_dispatch";
  policyState: "idle";
  reasonCode: "read_side_effect_cleanup";
  version: number;
  lifecycleEventId: string;
  auditEventId: string;
  replayed: boolean;
}>;
export type CloseDuplicateRecommendationRefillResult = Readonly<{
  duplicateJobId: string;
  canonicalJobId: string;
  status: "cancelled";
  reasonCode: "duplicate_recovery_owner";
  version: number;
  lifecycleEventId: string;
  auditEventId: string;
  replayed: boolean;
}>;
type ResultRow = { state: string; requestHash: string; responseBody?: unknown };
const conflict = (message: string) =>
  new BacklinkError({ code: backlinkErrorCodes.conflict, message });
function authorize(context: ResolvedProjectContext): void {
  if (
    !context.actor.roles.some((role) =>
      ["owner", "admin", "member"].includes(role),
    )
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Recommendation write permission is required.",
    });
  }
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function ensureRecoverySupplyAuthorization(
  client: RecommendationCommandClient,
  input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    recommendationContextVersionId: string;
    visiblePoolGeneration: number;
    refillId: string;
    jobId: string;
    outboxEventId: string;
    idempotencyKey: string;
    authorization: ProviderOperationBudgetAuthorization | null;
    actorId: string;
    now: Date;
  }>,
): Promise<void> {
  const providerOperationId =
    `commercial-refill-operation:${input.jobId}`;
  const authorizationJson = input.authorization === null
    ? null
    : JSON.stringify(input.authorization);
  const authorizationHash = authorizationJson === null
    ? null
    : createHash("sha256").update(authorizationJson).digest("hex");
  const recovery = (
    await client.query(
      `WITH target AS MATERIALIZED (
         SELECT refill.id "refillId",refill.job_id "jobId",
                refill.refill_window_key "refillWindowKey",
                job.status "jobStatus",job.retry_count "retryCount",
                job.result_summary "jobResultSummary",job.error "jobError",
                event.id "outboxEventId",event.status "outboxStatus",
                event.claimed_at "outboxClaimedAt",
                event.claimed_by "outboxClaimedBy",
                event.payload "outboxPayload"
           FROM backlink_recommendation_refills AS refill
           JOIN backlink_jobs AS job
             ON (
               job.organization_id,job.workspace_id,
               job.website_project_id,job.id
             )=(
               refill.organization_id,refill.workspace_id,
               refill.website_project_id,refill.job_id
             )
           JOIN backlink_outbox_events AS event
             ON (
               event.organization_id,event.workspace_id,
               event.website_project_id,event.aggregate_id
             )=(
               job.organization_id,job.workspace_id,
               job.website_project_id,job.id
             )
            AND event.id=$8::uuid
            AND event.event_type=
                'backlinks.recommendation-refill.requested.v1'
          WHERE (
            refill.organization_id,refill.workspace_id,
            refill.website_project_id,
            refill.recommendation_context_version_id
          )=($1,$2,$3,$4)
            AND refill.visible_pool_generation=$5
            AND refill.id=$6::uuid
            AND refill.job_id=$7::uuid
            AND job.job_type='recommendation_refill'
            AND job.source_object_type='recommendation_context'
            AND job.source_object_id=$4
          FOR UPDATE OF refill,job,event
       ),
       existing_contract AS MATERIALIZED (
         SELECT target."jobId",
                operation.authorization_snapshot
                  "providerBudgetAuthorization"
           FROM target
           JOIN backlink_commercial_supply_operations AS operation
             ON (
               operation.organization_id,operation.workspace_id,
               operation.website_project_id,operation.job_id
             )=($1,$2,$3,target."jobId")
            AND operation.id=$10
            AND operation.project_context_version_id=$4
            AND operation.visible_pool_generation=$5
            AND operation.provider='dataforseo'
            AND operation.status='authorized'
            AND operation.idempotency_key=$9
          WHERE target."jobResultSummary"->>'providerOperationId'=$10
            AND target."jobResultSummary"
                  ->'providerBudgetAuthorization'=
                operation.authorization_snapshot
            AND target."outboxPayload"->>'providerOperationId'=$10
            AND target."outboxPayload"
                  ->'providerBudgetAuthorization'=
                operation.authorization_snapshot
       ),
       provider_side_effect AS MATERIALIZED (
         SELECT target."jobId"
           FROM target
          WHERE EXISTS (
                  SELECT 1
                    FROM backlink_commercial_discovery_batches AS batch
                   WHERE (
                     batch.organization_id,batch.workspace_id,
                     batch.website_project_id,batch.refill_job_id
                   )=($1,$2,$3,target."jobId")
                )
             OR EXISTS (
                  SELECT 1
                    FROM provider_batch_requests AS request
                   WHERE (
                     request.organization_id,request.workspace_id,
                     request.website_project_id
                   )=($1,$2,$3)
                     AND request.request_id LIKE
                         target."refillWindowKey"||':%'
                )
             OR EXISTS (
                  SELECT 1
                    FROM backlink_provider_usage_ledger AS usage
                   WHERE (
                     usage.organization_id,usage.workspace_id,
                     usage.website_project_id
                   )=($1,$2,$3)
                     AND usage.provider='dataforseo'
                     AND usage.reservation_key LIKE
                         target."refillWindowKey"||':%'
                )
             OR EXISTS (
                  SELECT 1
                    FROM provider_fetch_leases AS lease
                   WHERE lease.owner_request_id LIKE
                         target."refillWindowKey"||':%'
                )
       ),
       repairable AS MATERIALIZED (
         SELECT target.*
           FROM target
          WHERE $11::jsonb IS NOT NULL
            AND target."jobStatus"='failed'
            AND target."retryCount"<6
            AND (
              target."outboxStatus"='published'
              OR (
                target."outboxStatus"='pending'
                AND target."outboxClaimedAt" IS NULL
                AND target."outboxClaimedBy" IS NULL
              )
            )
            AND target."jobError"
                  ->>'providerCallOccurred' IS DISTINCT FROM 'true'
            AND NOT (
              COALESCE(target."jobResultSummary",'{}'::jsonb)
                ? 'providerOperationId'
            )
            AND NOT (
              COALESCE(target."jobResultSummary",'{}'::jsonb)
                ? 'providerBudgetAuthorization'
            )
            AND NOT (
              target."outboxPayload" ? 'providerOperationId'
            )
            AND NOT (
              target."outboxPayload" ? 'providerBudgetAuthorization'
            )
            AND NOT EXISTS (
              SELECT 1
                FROM backlink_commercial_supply_operations AS operation
               WHERE (
                 operation.organization_id,operation.workspace_id,
                 operation.website_project_id,operation.job_id
               )=($1,$2,$3,target."jobId")
            )
            AND NOT EXISTS (
              SELECT 1
                FROM provider_side_effect AS effect
               WHERE effect."jobId"=target."jobId"
            )
       ),
       repaired_operation AS (
         INSERT INTO backlink_commercial_supply_operations (
           id,organization_id,workspace_id,website_project_id,
           project_context_version_id,visible_pool_generation,job_id,
           provider,authorization_snapshot,authorization_hash,status,
           idempotency_key,created_by,updated_by
         )
         SELECT $10,$1,$2,$3,$4,$5,repairable."jobId",
                'dataforseo',$11::jsonb,$12,'authorized',$9,$13,$13
           FROM repairable
         ON CONFLICT DO NOTHING
         RETURNING job_id
       ),
       repaired_job AS (
         UPDATE backlink_jobs AS job
            SET result_summary=
                  COALESCE(job.result_summary,'{}'::jsonb)
                  ||jsonb_build_object(
                    'providerOperationId',$10,
                    'providerBudgetAuthorization',$11::jsonb,
                    'providerAuthorizationRecovery',
                    jsonb_build_object(
                      'status','repaired',
                      'reason','pre_provider_contract_missing',
                      'repairedAt',$14::timestamptz,
                      'repairedBy',$13
                    )
                  ),
                updated_at=$14,updated_by=$13,version=version+1
           FROM repairable
           JOIN repaired_operation AS operation
             ON operation.job_id=repairable."jobId"
          WHERE (
            job.organization_id,job.workspace_id,
            job.website_project_id,job.id
          )=($1,$2,$3,repairable."jobId")
         RETURNING job.id
       ),
       repaired_event AS (
         UPDATE backlink_outbox_events AS event
            SET payload=event.payload||jsonb_build_object(
                  'providerOperationId',$10,
                  'providerBudgetAuthorization',$11::jsonb
                ),
                updated_at=$14,updated_by=$13
           FROM repairable
           JOIN repaired_job AS job
             ON job.id=repairable."jobId"
          WHERE (
            event.organization_id,event.workspace_id,
            event.website_project_id,event.id
          )=($1,$2,$3,repairable."outboxEventId")
         RETURNING event.id
       )
       SELECT CASE
                WHEN EXISTS (SELECT 1 FROM existing_contract)
                  THEN 'ready'
                WHEN EXISTS (SELECT 1 FROM repaired_event)
                  THEN 'repaired'
                ELSE 'blocked'
              END "state",
              COALESCE(
                (
                  SELECT existing."providerBudgetAuthorization"
                    FROM existing_contract AS existing
                   LIMIT 1
                ),
                CASE
                  WHEN EXISTS (SELECT 1 FROM repaired_event)
                    THEN $11::jsonb
                  ELSE NULL
                END
              ) "providerBudgetAuthorization"`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.recommendationContextVersionId,
        input.visiblePoolGeneration,
        input.refillId,
        input.jobId,
        input.outboxEventId,
        input.idempotencyKey,
        providerOperationId,
        authorizationJson,
        authorizationHash,
        input.actorId,
        input.now,
      ],
    )
  ).rows[0];
  if (
    recovery === undefined
    || !["ready", "repaired"].includes(String(recovery.state))
  ) {
    throw conflict(
      "The recovery operation cannot resume without its original provider authorization contract.",
    );
  }
  try {
    parseProviderOperationBudgetAuthorization(
      recovery.providerBudgetAuthorization,
    );
  } catch {
    throw conflict(
      "The recovery operation has an invalid provider authorization contract.",
    );
  }
}
function result<T>(
  row: ResultRow | undefined,
  requestHash: string,
): T & { replayed: boolean } {
  if (row === undefined || row.state === "in_progress")
    throw conflict("The idempotent command is already in progress.");
  if (row.requestHash !== requestHash)
    throw conflict("Idempotency key is already bound to a different request.");
  if (
    !["completed", "replay"].includes(row.state) ||
    row.responseBody === undefined
  )
    throw conflict(
      "ExpectedVersion does not match the current resource version.",
    );
  return { ...(row.responseBody as T), replayed: row.state === "replay" };
}
export function createRecommendationCommands(
  client: RecommendationCommandClient,
  options: RecommendationCommandOptions = {},
) {
  return {
    async reject(
      input: RejectRecommendationCommand,
    ): Promise<RejectRecommendationResult> {
      authorize(input.context);
      const { tenant, project, actor } = input.context;
      const requestHash = digest({
        recommendationId: input.recommendationId,
        expectedVersion: input.expectedVersion,
        rejectionType: input.rejectionType,
        reasonCode: input.reasonCode,
        cooldownUntil: input.cooldownUntil,
      });
      const ids = Array.from({ length: 4 }, () => randomUUID());
      const sql = `WITH guard AS (SELECT pg_advisory_xact_lock(hashtextextended($2::uuid::text||':'||$7||':recommendation.reject',0))),
prior AS (SELECT i.request_hash "requestHash",i.response_body "responseBody" FROM guard CROSS JOIN LATERAL (SELECT * FROM backlink_idempotency_records WHERE workspace_id=$2 AND idempotency_key=$7 AND command_type='recommendation.reject') i),
changed AS (UPDATE backlink_recommendation_inventory SET status='rejected',version=version+1,updated_at=now(),updated_by=$4 WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3 AND recommendation_id=$5 AND version=$6 AND status IN ('ready','shown') AND NOT EXISTS (SELECT 1 FROM prior) RETURNING id,recommendation_id,prospect_id,recommendation_context_version_id,version),
rejected AS (INSERT INTO backlink_recommendation_rejections (id,organization_id,workspace_id,website_project_id,inventory_id,recommendation_id,prospect_id,recommendation_context_version_id,rejection_type,reason_code,rejected_at,cooldown_until,rejected_by,created_by) SELECT $10,$1,$2,$3,id,recommendation_id,prospect_id,recommendation_context_version_id,$14,$15,now(),$16::timestamptz,$4,$4 FROM changed RETURNING recommendation_id),
lifecycle AS (INSERT INTO backlink_lifecycle_events (id,organization_id,workspace_id,website_project_id,aggregate_type,aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,before_state,after_state,reason,correlation_id,idempotency_key) SELECT $11,$1,$2,$3,'recommendation',c.recommendation_id,c.version,c.version,'recommendation.rejected','user',$4,jsonb_build_object('version',c.version-1),jsonb_build_object('version',c.version,'status','rejected'),$15,$13,'recommendation.reject:'||$7 FROM changed c,rejected RETURNING id),
audit AS (INSERT INTO backlink_audit_events (id,organization_id,workspace_id,website_project_id,lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,outcome,reason,before_redacted,after_redacted,request_id,correlation_id,integrity_hash) SELECT $12,$1,$2,$3,lifecycle.id,$4,'user','recommendation.rejected','recommendation',$5,'success',$15,jsonb_build_object('expectedVersion',$6),jsonb_build_object('status','rejected'),$13,$13,$17 FROM lifecycle RETURNING id),
completed AS (INSERT INTO backlink_idempotency_records (id,organization_id,workspace_id,website_project_id,idempotency_key,command_type,request_hash,response_status,response_body,response_schema_version,completed_at,expires_at,created_by,updated_by) SELECT $9,$1,$2,$3,$7,'recommendation.reject',$8,200,jsonb_build_object('recommendationId',c.recommendation_id,'status','rejected','version',c.version,'lifecycleEventId',$11,'auditEventId',$12),1,now(),now()+interval '24 hours',$4,$4 FROM changed c,audit RETURNING request_hash "requestHash",response_body "responseBody")
SELECT 'completed' state,* FROM completed UNION ALL SELECT 'replay',"requestHash","responseBody" FROM prior UNION ALL SELECT 'version_conflict',$8,NULL WHERE NOT EXISTS (SELECT 1 FROM completed) AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [
        tenant.organizationId,
        tenant.workspaceId,
        project.websiteProjectId,
        actor.userId,
        input.recommendationId,
        input.expectedVersion,
        input.idempotencyKey,
        requestHash,
        ...ids,
        input.requestId,
        input.rejectionType,
        input.reasonCode,
        input.cooldownUntil,
        requestHash,
      ];
      return result<RejectRecommendationResult>(
        (await client.query(sql, values)).rows[0] as ResultRow | undefined,
        requestHash,
      );
    },
    async requestRefill(
      input: RequestRecommendationRefillCommand,
    ): Promise<RecommendationRefillResult> {
      authorize(input.context);
      if (input.expectedVersion !== 0)
        throw conflict("New refill jobs require ExpectedVersion 0.");
      if (
        !Number.isSafeInteger(input.lowWatermark) ||
        input.lowWatermark < 0 ||
        !Number.isSafeInteger(input.highWatermark) ||
        input.highWatermark <= input.lowWatermark ||
        input.highWatermark > 100
      ) {
        throw conflict("Recommendation refill watermarks are invalid.");
      }
      if (
        input.operationId !== undefined &&
        input.providerBudgetAuthorization !== undefined
      ) {
        throw conflict(
          "A recovery operation cannot replace its provider budget authorization.",
        );
      }
      if (
        input.supplyMode === "existing_evidence"
        && input.providerBudgetAuthorization !== undefined
      ) {
        throw conflict(
          "Existing-evidence reassessment cannot bind a provider budget.",
        );
      }
      const { tenant, project, actor } = input.context;
      let supplyMode = input.supplyMode;
      let lowWatermark = input.lowWatermark;
      let highWatermark = input.highWatermark;
      let triggerReason = input.triggerReason ?? "manual";
      let refillWindowKey = input.refillWindowKey;
      let persistedIdempotencyKey: string | undefined;
      let persistedRequestHash: string | undefined;
      let persistedJobId: string | undefined;
      let persistedOutboxEventId: string | undefined;
      if (input.operationId !== undefined) {
        const recovery = (
          await client.query(
            `SELECT refill.refill_window_key "refillWindowKey",
                    idempotency.idempotency_key "idempotencyKey",
                    idempotency.request_hash "requestHash",
                    refill.trigger_reason "triggerReason",
                    refill.low_watermark "lowWatermark",
                      refill.high_watermark "highWatermark",
                      refill.visible_pool_generation "visiblePoolGeneration",
                      refill.job_id::text "jobId",
                      COALESCE(
                        job.result_summary->>'supplyMode',
                        event.payload->>'supplyMode'
                      ) "supplyMode",
                      idempotency.response_body->>'outboxEventId'
                        "outboxEventId"
                 FROM backlink_recommendation_refills AS refill
                 JOIN backlink_jobs AS job
                   ON (
                     job.organization_id,job.workspace_id,
                     job.website_project_id,job.id
                   )=(
                     refill.organization_id,refill.workspace_id,
                     refill.website_project_id,refill.job_id
                   )
                 JOIN backlink_idempotency_records AS idempotency
                   ON idempotency.organization_id=refill.organization_id
                  AND idempotency.workspace_id=refill.workspace_id
                AND idempotency.website_project_id=refill.website_project_id
                  AND idempotency.command_type='recommendation.refill'
                  AND idempotency.response_body->>'operationId'=refill.id::text
                 JOIN backlink_outbox_events AS event
                   ON (
                     event.organization_id,event.workspace_id,
                     event.website_project_id,event.aggregate_id
                   )=(
                     job.organization_id,job.workspace_id,
                     job.website_project_id,job.id
                   )
                  AND event.id=(
                    idempotency.response_body->>'outboxEventId'
                  )::uuid
                  AND event.event_type=
                      'backlinks.recommendation-refill.requested.v1'
                WHERE (refill.organization_id,refill.workspace_id,
                       refill.website_project_id,
                       refill.recommendation_context_version_id)=
                    ($1,$2,$3,$4)
                AND refill.id=$5`,
            [
              tenant.organizationId,
              tenant.workspaceId,
              project.websiteProjectId,
              input.recommendationContextVersionId,
              input.operationId,
            ],
          )
        ).rows[0];
        if (
          recovery === undefined ||
          Number(recovery.visiblePoolGeneration) !==
            input.visiblePoolGeneration ||
          (input.refillWindowKey !== undefined &&
            input.refillWindowKey !== recovery.refillWindowKey) ||
          (input.triggerReason !== undefined &&
            input.triggerReason !== recovery.triggerReason) ||
          (
            input.supplyMode !== undefined
            && input.supplyMode !== recovery.supplyMode
          )
        ) {
          throw conflict(
            "The recovery operation does not match the current context.",
          );
        }
        refillWindowKey = String(recovery.refillWindowKey);
        persistedIdempotencyKey = String(recovery.idempotencyKey);
        persistedRequestHash = String(recovery.requestHash);
        persistedJobId = String(recovery.jobId);
        persistedOutboxEventId = String(recovery.outboxEventId);
        if (
          persistedJobId.length < 1
          || persistedOutboxEventId.length < 1
          || persistedOutboxEventId === "undefined"
        ) {
          throw conflict(
            "The recovery operation is missing its durable dispatch identity.",
          );
        }
        lowWatermark = Number(recovery.lowWatermark);
        highWatermark = Number(recovery.highWatermark);
        triggerReason = recovery.triggerReason as
          | "inventory_low"
          | "manual";
        supplyMode = recovery.supplyMode === "existing_evidence"
          ? "existing_evidence"
          : undefined;
      }
      const providerBudgetGrant =
        input.providerBudgetAuthorization
        ?? (
          supplyMode !== "existing_evidence"
            ? options.persistentProviderBudgetGrant ?? undefined
            : undefined
        );
      const providerBudgetAuthorization =
        providerBudgetGrant === undefined
          ? null
          : bindProviderOperationBudgetAuthorization(
            providerBudgetGrant,
            {
              authorizedBy: actor.userId,
            },
          );
      refillWindowKey ??=
        `manual:${input.recommendationContextVersionId}:g${input.visiblePoolGeneration}:blueprint-v${commercialDiscoveryBlueprintVersion}`;
      const idempotencyKey = persistedIdempotencyKey
        ?? `recommendation-refill:${refillWindowKey}`;
      const requestHash = persistedRequestHash
        ?? digest({
          recommendationContextVersionId: input.recommendationContextVersionId,
          visiblePoolGeneration: input.visiblePoolGeneration,
          expectedVersion: input.expectedVersion,
          lowWatermark,
          highWatermark,
          refillWindowKey,
          triggerReason,
          providerBudgetAuthorization,
          supplyMode,
        });
      const ids = Array.from({ length: 6 }, () => randomUUID());
      const providerBudgetAuthorizationJson =
        providerBudgetAuthorization === null
          ? null
          : JSON.stringify(providerBudgetAuthorization);
      const providerBudgetAuthorizationHash =
        providerBudgetAuthorizationJson === null
          ? null
          : createHash("sha256")
            .update(providerBudgetAuthorizationJson)
            .digest("hex");
      const workflowId = buildBacklinksWorkflowId({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        websiteProjectId: project.websiteProjectId,
        workflow: "recommendation-refill",
        instanceId: ids[1] ?? "",
      });
      await client.query(
        `SELECT
           pg_advisory_xact_lock(
             hashtextextended($1::uuid::text||':'||$2||':recommendation.refill',0)
           ),
           pg_advisory_xact_lock(
             hashtextextended(
               $1::uuid::text||':'||$3::uuid::text||
               ':recommendation.refill.active',
               0
             )
           )`,
        [
          tenant.workspaceId,
          idempotencyKey,
          input.recommendationContextVersionId,
        ],
      );
      if (
        input.operationId !== undefined
        && persistedJobId !== undefined
        && persistedOutboxEventId !== undefined
        && supplyMode !== "existing_evidence"
      ) {
        await ensureRecoverySupplyAuthorization(client, {
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          websiteProjectId: project.websiteProjectId,
          recommendationContextVersionId:
            input.recommendationContextVersionId,
          visiblePoolGeneration: input.visiblePoolGeneration,
          refillId: input.operationId,
          jobId: persistedJobId,
          outboxEventId: persistedOutboxEventId,
          idempotencyKey,
          authorization: providerBudgetAuthorization,
          actorId: actor.userId,
          now: new Date(),
        });
      }
      await client.query(
        `INSERT INTO backlink_commercial_inventory_policies (
           organization_id,workspace_id,website_project_id,
           project_context_version_id,updated_by
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (
           organization_id,workspace_id,website_project_id,
           project_context_version_id
         ) DO NOTHING`,
        [
          tenant.organizationId,
          tenant.workspaceId,
          project.websiteProjectId,
          input.recommendationContextVersionId,
          actor.userId,
        ],
      );
      const sql = `WITH guard AS (SELECT pg_advisory_xact_lock(hashtextextended($2::uuid::text||':'||$7||':recommendation.refill',0)),pg_advisory_xact_lock(hashtextextended($2::uuid::text||':'||$5::uuid::text||':recommendation.refill.active',0))),
prior AS (SELECT i.request_hash "requestHash",i.response_body "responseBody" FROM guard CROSS JOIN LATERAL (SELECT * FROM backlink_idempotency_records WHERE workspace_id=$2 AND idempotency_key=$7 AND command_type='recommendation.refill') i),
prior_job AS (SELECT job.status FROM prior LEFT JOIN backlink_jobs job ON job.organization_id=$1 AND job.workspace_id=$2 AND job.website_project_id=$3 AND job.id=(prior."responseBody"->>'jobId')::uuid),
accepted_provider_recovery AS MATERIALIZED (
  SELECT failed_job.id "jobId",
         request.id "providerRequestId",
         request.request_id "ownerRequestId",
         request.normalized_request_hash "artifactFingerprint"
    FROM prior
    JOIN backlink_jobs failed_job
      ON failed_job.organization_id=$1
     AND failed_job.workspace_id=$2
     AND failed_job.website_project_id=$3
     AND failed_job.id=(prior."responseBody"->>'jobId')::uuid
     AND failed_job.job_type='recommendation_refill'
     AND failed_job.source_object_type='recommendation_context'
     AND failed_job.source_object_id=$5
    JOIN backlink_recommendation_refills failed_refill
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
     AND failed_refill.visible_pool_generation=$22
    JOIN provider_batch_requests request
      ON request.organization_id=failed_job.organization_id
     AND request.workspace_id=failed_job.workspace_id
     AND request.website_project_id=failed_job.website_project_id
     AND request.request_id LIKE failed_refill.refill_window_key||':%'
     AND request.budget_reservation_id LIKE
         'commercial-refill-operation:'||failed_job.id::text||
         ':discovery:'||failed_refill.refill_window_key||':%'
     AND request.created_at>=failed_job.created_at
    JOIN backlink_provider_requests provider_request
      ON (
        provider_request.organization_id,
        provider_request.workspace_id,
        provider_request.website_project_id,
        provider_request.id
      )=(
        request.organization_id,
        request.workspace_id,
        request.website_project_id,
        request.id
      )
    JOIN backlink_commercial_discovery_blueprints blueprint
      ON (
        blueprint.organization_id,
        blueprint.workspace_id,
        blueprint.website_project_id,
        blueprint.project_context_version_id
      )=(
        failed_job.organization_id,
        failed_job.workspace_id,
        failed_job.website_project_id,
        $5
      )
     AND blueprint.id::text=
         provider_request.request_payload
           #>>'{__growthosDiscoveryPlannerLineage,blueprintId}'
    JOIN backlink_provider_usage_ledger usage
      ON (
        usage.organization_id,
        usage.workspace_id,
        usage.website_project_id,
        usage.provider_request_id
      )=(
        request.organization_id,
        request.workspace_id,
        request.website_project_id,
        request.id
      )
     AND usage.provider='dataforseo'
     AND usage.reservation_key=request.budget_reservation_id
     AND usage.status='reserved'
    JOIN provider_fetch_leases lease
      ON lease.artifact_fingerprint=request.normalized_request_hash
     AND lease.owner_request_id=request.request_id
   WHERE provider_request.request_payload
           #>>'{__growthosDiscoveryPlannerLineage,queryId}'
         ~'^[0-9a-f]{64}$'
     AND NOT EXISTS (
       SELECT 1
         FROM backlink_commercial_discovery_batches conflicting
        WHERE (
          conflicting.organization_id,
          conflicting.workspace_id,
          conflicting.website_project_id
        )=(
          failed_job.organization_id,
          failed_job.workspace_id,
          failed_job.website_project_id
        )
          AND conflicting.project_context_version_id=$5
          AND conflicting.visible_pool_generation=$22
          AND conflicting.idempotency_key=
              'commercial-discovery:'||failed_refill.refill_window_key
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
completed_provider_checkpoint AS MATERIALIZED (SELECT DISTINCT failed_job.id "jobId" FROM prior JOIN backlink_jobs failed_job ON failed_job.organization_id=$1 AND failed_job.workspace_id=$2 AND failed_job.website_project_id=$3 AND failed_job.id=(prior."responseBody"->>'jobId')::uuid JOIN backlink_commercial_discovery_batches batch ON batch.organization_id=failed_job.organization_id AND batch.workspace_id=failed_job.workspace_id AND batch.website_project_id=failed_job.website_project_id AND batch.refill_job_id=failed_job.id AND batch.project_context_version_id=$5 AND batch.visible_pool_generation=$22 JOIN provider_batch_requests request ON request.organization_id=batch.organization_id AND request.workspace_id=batch.workspace_id AND request.website_project_id=batch.website_project_id AND request.request_id LIKE regexp_replace(batch.idempotency_key,'^commercial-discovery:','')||':%' JOIN backlink_provider_requests provider_request ON (provider_request.organization_id,provider_request.workspace_id,provider_request.website_project_id,provider_request.id)=(request.organization_id,request.workspace_id,request.website_project_id,request.id) JOIN backlink_provider_usage_ledger usage ON (usage.organization_id,usage.workspace_id,usage.website_project_id,usage.provider_request_id)=(request.organization_id,request.workspace_id,request.website_project_id,request.id) AND usage.provider='dataforseo' AND usage.reservation_key=request.budget_reservation_id JOIN provider_fetch_leases lease ON lease.artifact_fingerprint=request.normalized_request_hash AND lease.owner_request_id=request.request_id WHERE request.status='succeeded' AND provider_request.status='succeeded' AND request.provider_task_id IS NOT NULL AND request.actual_cost_micros IS NOT NULL AND usage.status='settled' AND lease.status='completed'),
publication_contract_recovery AS MATERIALIZED (SELECT DISTINCT failed_job.id "jobId",'existing-evidence-publication-recovery:'||failed_job.id::text||':'||(failed_job.result_summary->>'refillWindowKey') "recoveryKey" FROM prior JOIN backlink_jobs failed_job ON failed_job.organization_id=$1 AND failed_job.workspace_id=$2 AND failed_job.website_project_id=$3 AND failed_job.id=(prior."responseBody"->>'jobId')::uuid AND failed_job.job_type='recommendation_refill' AND failed_job.source_object_type='recommendation_context' AND failed_job.source_object_id=$5 JOIN backlink_recommendation_refills failed_refill ON (failed_refill.organization_id,failed_refill.workspace_id,failed_refill.website_project_id,failed_refill.job_id)=(failed_job.organization_id,failed_job.workspace_id,failed_job.website_project_id,failed_job.id) AND failed_refill.recommendation_context_version_id=$5 AND failed_refill.visible_pool_generation=$22 JOIN backlink_recommendation_generation_contracts generation ON (generation.organization_id,generation.workspace_id,generation.website_project_id,generation.recommendation_context_version_id,generation.visible_pool_generation)=(failed_job.organization_id,failed_job.workspace_id,failed_job.website_project_id,$5,$22) AND generation.qualification_contract_version='recommendation-qualification.v1' AND generation.visibility_contract_version='recommendation-visibility.v1' AND generation.score_model_version='recommendation-commercial-fit.v4' JOIN backlink_commercial_candidates candidate ON (candidate.organization_id,candidate.workspace_id,candidate.website_project_id,candidate.project_context_version_id,candidate.visible_pool_generation)=(failed_job.organization_id,failed_job.workspace_id,failed_job.website_project_id,$5,$22) AND candidate.state='candidate_ready' AND candidate.recommendation_id IS NULL AND candidate.prospect_id IS NULL AND candidate.score_model_version='recommendation-commercial-fit.v4' AND candidate.gate_decision->>'decision'='eligible' AND jsonb_typeof(candidate.gate_decision->'hitGates')='array' AND jsonb_array_length(candidate.gate_decision->'hitGates')=0 AND candidate.commercial_score->>'decision'='eligible' AND CASE WHEN jsonb_typeof(candidate.commercial_score->'total')='number' AND jsonb_typeof(candidate.commercial_score#>'{admission,appliedThreshold}')='number' THEN (candidate.commercial_score->>'total')::numeric>=(candidate.commercial_score#>>'{admission,appliedThreshold}')::numeric ELSE false END WHERE failed_job.status='partial_success' AND failed_job.step='existing_evidence_no_progress' AND failed_job.result_summary->>'terminalReason'='EXISTING_EVIDENCE_NO_PROGRESS' AND COALESCE((failed_job.result_summary->>'existingCandidatesCompleted')::boolean,false)=true AND failed_job.result_summary->>'refillWindowKey' LIKE 'commercial-existing:'||$3::text||':'||$5::text||':g'||$22::text||':%' AND prior."responseBody"->>'existingEvidencePublicationRecoveryKey' IS DISTINCT FROM 'existing-evidence-publication-recovery:'||failed_job.id::text||':'||(failed_job.result_summary->>'refillWindowKey') AND NOT EXISTS (SELECT 1 FROM backlink_recommendation_qualification_facts qualification WHERE (qualification.organization_id,qualification.workspace_id,qualification.website_project_id,qualification.recommendation_context_version_id,qualification.generation_contract_id,qualification.candidate_id)=(candidate.organization_id,candidate.workspace_id,candidate.website_project_id,$5,generation.id,candidate.id) AND qualification.recommendation_id IS NULL AND qualification.prospect_id IS NULL AND qualification.decision='eligible' AND qualification.fact_contract_version=generation.qualification_contract_version AND qualification.score_model_version=generation.score_model_version) AND NOT EXISTS (SELECT 1 FROM backlink_recommendation_refills active_refill JOIN backlink_jobs active_job ON (active_job.organization_id,active_job.workspace_id,active_job.website_project_id,active_job.id)=(active_refill.organization_id,active_refill.workspace_id,active_refill.website_project_id,active_refill.job_id) WHERE (active_refill.organization_id,active_refill.workspace_id,active_refill.website_project_id,active_refill.recommendation_context_version_id,active_refill.visible_pool_generation)=($1,$2,$3,$5,$22) AND active_job.id<>failed_job.id AND active_job.status IN ('queued','running','waiting_provider')) AND NOT EXISTS (SELECT 1 FROM backlink_outbox_events active_event WHERE (active_event.organization_id,active_event.workspace_id,active_event.website_project_id,active_event.aggregate_id)=($1,$2,$3,failed_job.id) AND active_event.event_type='backlinks.recommendation-refill.requested.v1' AND active_event.status IN ('pending','processing','failed')) AND NOT EXISTS (SELECT 1 FROM provider_batch_requests request WHERE request.organization_id=$1 AND request.workspace_id=$2 AND request.website_project_id=$3 AND request.request_id LIKE 'commercial-refill:'||$3::text||':'||$5::text||':g'||$22::text||':%' AND request.status IN ('running','unknown_charge')) AND NOT EXISTS (SELECT 1 FROM backlink_provider_usage_ledger usage WHERE usage.organization_id=$1 AND usage.workspace_id=$2 AND usage.website_project_id=$3 AND usage.provider='dataforseo' AND usage.reservation_key LIKE 'commercial-refill:'||$3::text||':'||$5::text||':g'||$22::text||':%' AND usage.status='reserved') AND NOT EXISTS (SELECT 1 FROM provider_fetch_leases lease WHERE lease.owner_request_id LIKE 'commercial-refill:'||$3::text||':'||$5::text||':g'||$22::text||':%' AND lease.status IN ('acquired','unknown_charge'))),
recoverable AS (SELECT event.id,failed_job.id "jobId",(failed_job.status='failed') "resumeFailed",(failed_job.status='partial_success') "resumePartialSuccess",(failed_job.status='partial_success' AND failed_job.step='paused_budget') "resumeBudgetPause",(publication."jobId" IS NOT NULL) "resumePublicationContract",publication."recoveryKey" FROM prior JOIN backlink_jobs failed_job ON failed_job.organization_id=$1 AND failed_job.workspace_id=$2 AND failed_job.website_project_id=$3 AND failed_job.id=(prior."responseBody"->>'jobId')::uuid JOIN backlink_outbox_events event ON event.organization_id=$1 AND event.workspace_id=$2 AND event.website_project_id=$3 AND event.aggregate_id=failed_job.id AND event.event_type='backlinks.recommendation-refill.requested.v1' LEFT JOIN publication_contract_recovery publication ON publication."jobId"=failed_job.id WHERE ($21::uuid IS NULL OR (prior."responseBody"->>'operationId')::uuid=$21::uuid) AND ((failed_job.status='failed' AND (failed_job.retry_count<6 OR (failed_job.retry_count=6 AND COALESCE((failed_job.result_summary->>'completedProviderCheckpointRecoveryAttempted')::boolean,false)=false AND EXISTS (SELECT 1 FROM completed_provider_checkpoint completed WHERE completed."jobId"=failed_job.id)))) OR (failed_job.status='partial_success' AND failed_job.step='paused_budget' AND failed_job.result_summary->>'outcome'='PAUSED_BUDGET' AND failed_job.result_summary->>'stageReason'='semantic_discovery_budget_insufficient' AND EXISTS (SELECT 1 FROM accepted_provider_recovery accepted WHERE accepted."jobId"=failed_job.id)) OR publication."jobId" IS NOT NULL) AND (event.status='published' OR (failed_job.status='failed' AND event.status='pending' AND event.claimed_at IS NULL AND event.claimed_by IS NULL)) AND NOT EXISTS (SELECT 1 FROM provider_batch_requests request WHERE request.organization_id=$1 AND request.workspace_id=$2 AND request.website_project_id=$3 AND request.request_id LIKE 'commercial-refill:'||$3::text||':'||$5::text||':g'||$22::text||':%' AND request.status IN ('running','unknown_charge') AND NOT EXISTS (SELECT 1 FROM accepted_provider_recovery accepted WHERE accepted."jobId"=failed_job.id AND accepted."providerRequestId"=request.id)) AND NOT EXISTS (SELECT 1 FROM backlink_provider_usage_ledger usage WHERE usage.organization_id=$1 AND usage.workspace_id=$2 AND usage.website_project_id=$3 AND usage.provider='dataforseo' AND usage.reservation_key LIKE 'commercial-refill:'||$3::text||':'||$5::text||':g'||$22::text||':%' AND usage.status='reserved' AND NOT EXISTS (SELECT 1 FROM accepted_provider_recovery accepted WHERE accepted."jobId"=failed_job.id AND accepted."providerRequestId"=usage.provider_request_id)) AND NOT EXISTS (SELECT 1 FROM provider_fetch_leases lease WHERE lease.owner_request_id LIKE 'commercial-refill:'||$3::text||':'||$5::text||':g'||$22::text||':%' AND lease.status IN ('acquired','unknown_charge') AND NOT EXISTS (SELECT 1 FROM accepted_provider_recovery accepted WHERE accepted."jobId"=failed_job.id AND accepted."ownerRequestId"=lease.owner_request_id AND accepted."artifactFingerprint"=lease.artifact_fingerprint))),
resumed_job AS (UPDATE backlink_jobs job SET status='queued',step='recovery_queued',progress=0,error=NULL,finished_at=NULL,result_summary=CASE WHEN recoverable."resumePublicationContract" THEN (COALESCE(job.result_summary,'{}'::jsonb)-'existingCandidatesCompleted')||jsonb_build_object('existingEvidencePublicationRecoveryKey',recoverable."recoveryKey") ELSE job.result_summary END,updated_at=now(),updated_by=$4,version=version+1 FROM recoverable WHERE (job.organization_id,job.workspace_id,job.website_project_id,job.id)=($1,$2,$3,recoverable."jobId") AND ((recoverable."resumeFailed" AND job.status='failed') OR (recoverable."resumePartialSuccess" AND job.status='partial_success' AND ((recoverable."resumeBudgetPause" AND job.step='paused_budget') OR (recoverable."resumePublicationContract" AND job.step='existing_evidence_no_progress' AND job.result_summary->>'terminalReason'='EXISTING_EVIDENCE_NO_PROGRESS')))) RETURNING job.id),
marked_publication_recovery AS (UPDATE backlink_idempotency_records record SET response_body=record.response_body||jsonb_build_object('existingEvidencePublicationRecoveryKey',recoverable."recoveryKey"),updated_at=now(),updated_by=$4 FROM recoverable JOIN resumed_job resumed ON resumed.id=recoverable."jobId" WHERE recoverable."resumePublicationContract" AND record.workspace_id=$2 AND record.idempotency_key=$7 AND record.command_type='recommendation.refill' RETURNING recoverable."jobId"),
rearmed AS (UPDATE backlink_outbox_events event SET status='pending',available_at=now(),claimed_at=NULL,claimed_by=NULL,published_at=NULL,updated_at=now(),updated_by=$4 FROM recoverable JOIN resumed_job resumed ON resumed.id=recoverable."jobId" LEFT JOIN marked_publication_recovery marked ON marked."jobId"=recoverable."jobId" WHERE event.id=recoverable.id AND event.status IN ('published','pending') AND (NOT recoverable."resumePublicationContract" OR marked."jobId" IS NOT NULL) RETURNING event.id),
recovery AS (SELECT count(*)::integer "rearmedCount" FROM rearmed),
pool AS (SELECT policy.visible_pool_generation,policy.visible_pool_state FROM guard CROSS JOIN LATERAL (SELECT visible_pool_generation,visible_pool_state FROM backlink_commercial_inventory_policies WHERE (organization_id,workspace_id,website_project_id,project_context_version_id)=($1,$2,$3,$5) FOR UPDATE) policy WHERE policy.visible_pool_generation=$22 AND policy.visible_pool_state IN ('idle','building','active','awaiting_refresh')),
available AS (SELECT 1 FROM pool WHERE $6::integer=0 AND $21::uuid IS NULL AND NOT EXISTS (SELECT 1 FROM prior) AND NOT EXISTS (SELECT 1 FROM backlink_recommendation_refills WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3 AND recommendation_context_version_id=$5 AND visible_pool_generation=$22 AND refill_window_key=$18) AND NOT EXISTS (SELECT 1 FROM backlink_recommendation_refills active_refill JOIN backlink_jobs active_job ON (active_job.organization_id,active_job.workspace_id,active_job.website_project_id,active_job.id)=(active_refill.organization_id,active_refill.workspace_id,active_refill.website_project_id,active_refill.job_id) WHERE (active_refill.organization_id,active_refill.workspace_id,active_refill.website_project_id)=($1,$2,$3) AND active_refill.recommendation_context_version_id=$5 AND active_refill.visible_pool_generation=$22 AND active_job.status IN ('queued','running','waiting_provider')) AND NOT EXISTS (SELECT 1 FROM backlink_commercial_discovery_batches active_discovery WHERE (active_discovery.organization_id,active_discovery.workspace_id,active_discovery.website_project_id)=($1,$2,$3) AND active_discovery.project_context_version_id=$5 AND active_discovery.visible_pool_generation=$22 AND active_discovery.status='running')),
activated AS (UPDATE backlink_commercial_inventory_policies policy SET visible_pool_state=CASE WHEN policy.visible_pool_state='active' THEN 'active' ELSE 'building' END,visible_pool_target_count=$17,published_contact_ready_low_watermark=0,published_contact_ready_high_watermark=$17,refill_state='running',current_refill_tier=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN 'curated_resource_library' ELSE policy.current_refill_tier END,current_refill_round=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN 1 ELSE policy.current_refill_round END,paid_refill_tier=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN 'exact_product_target_market' ELSE policy.paid_refill_tier END,paid_refill_round=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN 1 ELSE policy.paid_refill_round END,resource_refill_tier=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN 'curated_resource_library' ELSE policy.resource_refill_tier END,resource_refill_round=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN 1 ELSE policy.resource_refill_round END,attempted_refill_tiers=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN '[]'::jsonb ELSE policy.attempted_refill_tiers END,termination_reason=NULL,pause_reason=NULL,next_refill_at=NULL,updated_at=now(),updated_by=$4,version=version+1 FROM available WHERE (policy.organization_id,policy.workspace_id,policy.website_project_id,policy.project_context_version_id)=($1,$2,$3,$5) AND policy.visible_pool_generation=$22 RETURNING policy.visible_pool_generation),
job AS (INSERT INTO backlink_jobs (id,organization_id,workspace_id,website_project_id,job_type,source_object_type,source_object_id,workflow_id,correlation_id,result_summary,created_by,updated_by) SELECT $10,$1,$2,$3,'recommendation_refill','recommendation_context',$5,$15,$14,NULLIF(jsonb_strip_nulls(jsonb_build_object('providerOperationId',CASE WHEN $23::jsonb IS NULL THEN NULL ELSE 'commercial-refill-operation:'||$10::uuid::text END,'providerBudgetAuthorization',$23::jsonb,'supplyMode',$24::text)),'{}'::jsonb),$4,$4 FROM activated RETURNING id),
supply_operation AS (INSERT INTO backlink_commercial_supply_operations (id,organization_id,workspace_id,website_project_id,project_context_version_id,visible_pool_generation,job_id,provider,authorization_snapshot,authorization_hash,status,idempotency_key,created_by,updated_by) SELECT 'commercial-refill-operation:'||job.id::text,$1,$2,$3,$5,$22,job.id,'dataforseo',$23::jsonb,$25,'authorized',$7,$4,$4 FROM job WHERE $23::jsonb IS NOT NULL RETURNING job_id),
operation_gate AS (SELECT job.id FROM job WHERE $23::jsonb IS NULL UNION ALL SELECT job.id FROM job JOIN supply_operation ON supply_operation.job_id=job.id),
refill AS (INSERT INTO backlink_recommendation_refills (id,organization_id,workspace_id,website_project_id,job_id,recommendation_context_version_id,visible_pool_generation,trigger_reason,low_watermark,high_watermark,refill_window_key,created_by,updated_by) SELECT $11,$1,$2,$3,operation_gate.id,$5,$22,$20,$16,$17,$18,$4,$4 FROM operation_gate RETURNING id),
lifecycle AS (INSERT INTO backlink_lifecycle_events (id,organization_id,workspace_id,website_project_id,job_id,aggregate_type,aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,after_state,correlation_id,idempotency_key) SELECT $12,$1,$2,$3,$10,'recommendation_refill',refill.id,1,1,'recommendation_refill.requested','user',$4,jsonb_strip_nulls(jsonb_build_object('status','queued','providerOperationId',CASE WHEN $23::jsonb IS NULL THEN NULL ELSE 'commercial-refill-operation:'||$10::uuid::text END,'providerBudgetAuthorization',$23::jsonb,'supplyMode',$24::text)),$14,'recommendation.refill:'||$7 FROM refill RETURNING id),
audit AS (INSERT INTO backlink_audit_events (id,organization_id,workspace_id,website_project_id,job_id,lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,outcome,after_redacted,request_id,correlation_id,integrity_hash) SELECT $13,$1,$2,$3,$10,lifecycle.id,$4,'user','recommendation_refill.requested','recommendation_refill',$11,'success',jsonb_strip_nulls(jsonb_build_object('status','queued','providerOperationId',CASE WHEN $23::jsonb IS NULL THEN NULL ELSE 'commercial-refill-operation:'||$10::uuid::text END,'providerBudgetAuthorization',$23::jsonb,'supplyMode',$24::text)),$14,$14,$8 FROM lifecycle RETURNING id),
outbox AS (INSERT INTO backlink_outbox_events (id,organization_id,workspace_id,website_project_id,event_type,aggregate_id,aggregate_version,idempotency_key,payload,payload_schema_version,created_by,updated_by) SELECT $19,$1,$2,$3,'backlinks.recommendation-refill.requested.v1',$10,1,$15,jsonb_strip_nulls(jsonb_build_object('contractVersion','backlinks.recommendation-refill.requested.v1','organizationId',$1::text,'workspaceId',$2::text,'websiteProjectId',$3::text,'recommendationContextVersionId',$5::text,'visiblePoolGeneration',$22,'jobId',$10::uuid::text,'workflowId',$15,'correlationId',$14,'actorId',$4,'refillWindowKey',$18,'lowWatermark',$16,'highWatermark',$17,'providerOperationId',CASE WHEN $23::jsonb IS NULL THEN NULL ELSE 'commercial-refill-operation:'||$10::uuid::text END,'providerBudgetAuthorization',$23::jsonb,'supplyMode',$24::text)),1,$4,$4 FROM refill RETURNING id),
completed AS (INSERT INTO backlink_idempotency_records (id,organization_id,workspace_id,website_project_id,idempotency_key,command_type,request_hash,response_status,response_body,response_schema_version,completed_at,expires_at,created_by,updated_by) SELECT $9,$1,$2,$3,$7,'recommendation.refill',$8,202,jsonb_build_object('operationId',$11,'jobId',$10,'workflowId',$15,'outboxEventId',$19,'status','queued','version',1,'visiblePoolGeneration',$22,'lifecycleEventId',$12,'auditEventId',$13),1,now(),now()+interval '24 hours',$4,$4 FROM audit CROSS JOIN outbox RETURNING request_hash "requestHash",response_body "responseBody")
SELECT 'completed' state,* FROM completed UNION ALL SELECT CASE WHEN recovery."rearmedCount">0 OR prior_job.status IN ('queued','running','waiting_provider','success') THEN 'replay' ELSE 'recovery_blocked' END state,"requestHash","responseBody" FROM prior CROSS JOIN recovery CROSS JOIN prior_job UNION ALL SELECT 'version_conflict',$8,NULL WHERE NOT EXISTS (SELECT 1 FROM completed) AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [
        tenant.organizationId,
        tenant.workspaceId,
        project.websiteProjectId,
        actor.userId,
        input.recommendationContextVersionId,
        input.expectedVersion,
        idempotencyKey,
        requestHash,
        ...ids.slice(0, 5),
        input.requestId,
        workflowId,
        lowWatermark,
        highWatermark,
        refillWindowKey,
        ids[5],
        triggerReason,
        input.operationId ?? null,
        input.visiblePoolGeneration,
        providerBudgetAuthorizationJson,
        supplyMode ?? null,
        providerBudgetAuthorizationHash,
      ];
      const refillResult = result<RecommendationRefillResult>(
        (await client.query(sql, values)).rows[0] as ResultRow | undefined,
        requestHash,
      );
      if (
        input.operationId !== undefined &&
        refillResult.operationId !== input.operationId
      ) {
        throw conflict(
          "The recovery operation does not match the current context.",
        );
      }
      return refillResult;
    },
    async archivePool(
      input: ArchiveRecommendationPoolCommand,
    ): Promise<ArchiveRecommendationPoolResult> {
      authorize(input.context);
      const { tenant, project, actor } = input.context;
      const requestHash = digest({
        recommendationContextVersionId: input.recommendationContextVersionId,
        visiblePoolGeneration: input.visiblePoolGeneration,
      });
      const ids = Array.from({ length: 3 }, () => randomUUID());
      const sql = `WITH guard AS (SELECT pg_advisory_xact_lock(hashtextextended($2::uuid::text||':'||$5::uuid::text||':recommendation.pool.archive',0))),
prior AS (SELECT i.request_hash "requestHash",i.response_body "responseBody" FROM guard CROSS JOIN LATERAL (SELECT * FROM backlink_idempotency_records WHERE workspace_id=$2 AND idempotency_key=$7 AND command_type='recommendation.pool.archive') i),
 pool AS (SELECT policy.version,policy.visible_pool_state,policy.visible_pool_target_count FROM guard CROSS JOIN LATERAL (SELECT version,visible_pool_state,visible_pool_target_count FROM backlink_commercial_inventory_policies WHERE (organization_id,workspace_id,website_project_id,project_context_version_id)=($1,$2,$3,$5) AND visible_pool_generation=$6 AND (visible_pool_state='active' OR (visible_pool_state='building' AND refill_state='paused' AND pause_reason='incompatible_generation' AND NOT EXISTS (SELECT 1 FROM backlink_recommendation_refills refill JOIN backlink_jobs job ON (job.organization_id,job.workspace_id,job.website_project_id,job.id)=(refill.organization_id,refill.workspace_id,refill.website_project_id,refill.job_id) WHERE (refill.organization_id,refill.workspace_id,refill.website_project_id,refill.recommendation_context_version_id)=($1,$2,$3,$5) AND refill.visible_pool_generation=$6 AND job.status IN ('queued','running','waiting_provider')) AND NOT EXISTS (SELECT 1 FROM backlink_recommendation_refills refill JOIN backlink_outbox_events event ON (event.organization_id,event.workspace_id,event.website_project_id,event.aggregate_id)=(refill.organization_id,refill.workspace_id,refill.website_project_id,refill.job_id) WHERE (refill.organization_id,refill.workspace_id,refill.website_project_id,refill.recommendation_context_version_id)=($1,$2,$3,$5) AND refill.visible_pool_generation=$6 AND event.event_type='backlinks.recommendation-refill.requested.v1' AND event.status IN ('pending','processing')) AND NOT EXISTS (SELECT 1 FROM backlink_commercial_discovery_batches batch WHERE (batch.organization_id,batch.workspace_id,batch.website_project_id,batch.project_context_version_id)=($1,$2,$3,$5) AND batch.visible_pool_generation=$6 AND batch.status='running') AND NOT EXISTS (SELECT 1 FROM backlink_commercial_discovery_batches batch JOIN provider_batch_requests request ON (request.organization_id,request.workspace_id,request.website_project_id)=(batch.organization_id,batch.workspace_id,batch.website_project_id) AND request.request_id LIKE regexp_replace(batch.idempotency_key,'^commercial-discovery:','')||':%' WHERE (batch.organization_id,batch.workspace_id,batch.website_project_id,batch.project_context_version_id)=($1,$2,$3,$5) AND batch.visible_pool_generation=$6 AND request.status IN ('running','unknown_charge')) AND NOT EXISTS (SELECT 1 FROM backlink_commercial_discovery_batches batch JOIN backlink_provider_usage_ledger usage ON (usage.organization_id,usage.workspace_id,usage.website_project_id)=(batch.organization_id,batch.workspace_id,batch.website_project_id) AND usage.provider='dataforseo' AND usage.reservation_key LIKE regexp_replace(batch.idempotency_key,'^commercial-discovery:','')||':%' WHERE (batch.organization_id,batch.workspace_id,batch.website_project_id,batch.project_context_version_id)=($1,$2,$3,$5) AND batch.visible_pool_generation=$6 AND usage.status='reserved') AND NOT EXISTS (SELECT 1 FROM backlink_commercial_discovery_batches batch JOIN provider_fetch_leases lease ON lease.owner_request_id LIKE regexp_replace(batch.idempotency_key,'^commercial-discovery:','')||':%' WHERE (batch.organization_id,batch.workspace_id,batch.website_project_id,batch.project_context_version_id)=($1,$2,$3,$5) AND batch.visible_pool_generation=$6 AND lease.status IN ('acquired','unknown_charge')))) FOR UPDATE) policy WHERE NOT EXISTS (SELECT 1 FROM prior)),
 archived AS (UPDATE backlink_recommendation_inventory inventory SET status='archived',updated_at=now(),updated_by=$4,version=inventory.version+1 FROM pool WHERE (inventory.organization_id,inventory.workspace_id,inventory.website_project_id,inventory.recommendation_context_version_id)=($1,$2,$3,$5) AND inventory.visible_pool_generation=$6 AND inventory.status IN ('ready','shown','accepted') RETURNING inventory.id),
 archived_count AS (SELECT count(*)::integer count FROM archived),
 prepared_candidates AS (INSERT INTO backlink_commercial_candidates (id,organization_id,workspace_id,website_project_id,blueprint_id,discovery_batch_id,recommendation_id,prospect_id,project_context_version_id,visible_pool_generation,canonical_domain,source_types,static_assessment,gate_decision,commercial_score,score_model_version,state,provider_collected_at,created_by,updated_by) SELECT gen_random_uuid(),candidate.organization_id,candidate.workspace_id,candidate.website_project_id,candidate.blueprint_id,candidate.discovery_batch_id,NULL,NULL,candidate.project_context_version_id,$6+1,candidate.canonical_domain,candidate.source_types,candidate.static_assessment,candidate.gate_decision,candidate.commercial_score,candidate.score_model_version,'candidate_ready',candidate.provider_collected_at,$4,$4 FROM backlink_commercial_candidates candidate JOIN LATERAL (SELECT qualification.decision FROM backlink_recommendation_qualification_facts qualification JOIN backlink_recommendation_generation_contracts generation ON generation.id=qualification.generation_contract_id AND (generation.organization_id,generation.workspace_id,generation.website_project_id,generation.recommendation_context_version_id,generation.visible_pool_generation)=(candidate.organization_id,candidate.workspace_id,candidate.website_project_id,candidate.project_context_version_id,$6) WHERE (qualification.organization_id,qualification.workspace_id,qualification.website_project_id,qualification.recommendation_context_version_id,qualification.candidate_id)=(candidate.organization_id,candidate.workspace_id,candidate.website_project_id,candidate.project_context_version_id,candidate.id) AND qualification.recommendation_id IS NULL AND qualification.prospect_id IS NULL AND qualification.fact_contract_version='recommendation-qualification.v1' AND qualification.score_model_version='recommendation-commercial-fit.v4' ORDER BY qualification.attempt DESC,qualification.observed_at DESC,qualification.id DESC LIMIT 1) qualification ON true WHERE (candidate.organization_id,candidate.workspace_id,candidate.website_project_id,candidate.project_context_version_id)=($1,$2,$3,$5) AND candidate.visible_pool_generation=$6 AND candidate.recommendation_id IS NULL AND candidate.prospect_id IS NULL AND candidate.state='candidate_ready' AND candidate.score_model_version='recommendation-commercial-fit.v4' AND candidate.gate_decision->>'decision'='eligible' AND jsonb_typeof(candidate.gate_decision->'hitGates')='array' AND jsonb_array_length(candidate.gate_decision->'hitGates')=0 AND candidate.commercial_score->>'decision'='eligible' AND CASE WHEN jsonb_typeof(candidate.commercial_score->'total')='number' AND jsonb_typeof(candidate.commercial_score#>'{admission,appliedThreshold}')='number' THEN (candidate.commercial_score->>'total')::numeric>=(candidate.commercial_score#>>'{admission,appliedThreshold}')::numeric ELSE false END AND qualification.decision='eligible' ORDER BY (candidate.commercial_score->>'total')::numeric DESC,candidate.canonical_domain LIMIT (SELECT visible_pool_target_count FROM pool) ON CONFLICT (organization_id,workspace_id,website_project_id,project_context_version_id,visible_pool_generation,canonical_domain,score_model_version) DO NOTHING RETURNING id),
 prepared_count AS (SELECT count(*)::integer count FROM prepared_candidates),
 changed AS (UPDATE backlink_commercial_inventory_policies policy SET visible_pool_generation=$6+1,visible_pool_state='awaiting_refresh',archived_visible_pool_count=policy.archived_visible_pool_count+archived_count.count,visible_pool_archived_at=now(),visible_pool_archived_by=$4,refill_state='idle',current_refill_tier='curated_resource_library',current_refill_round=1,paid_refill_tier='exact_product_target_market',paid_refill_round=1,resource_refill_tier='curated_resource_library',resource_refill_round=1,attempted_refill_tiers='[]'::jsonb,termination_reason=NULL,pause_reason=NULL,next_refill_at=NULL,updated_at=now(),updated_by=$4,version=policy.version+1 FROM pool,archived_count,prepared_count WHERE (policy.organization_id,policy.workspace_id,policy.website_project_id,policy.project_context_version_id)=($1,$2,$3,$5) AND policy.visible_pool_generation=$6 RETURNING policy.version,archived_count.count AS "archivedCount",prepared_count.count AS "preparedCount",pool.visible_pool_state "previousState"),
 lifecycle AS (INSERT INTO backlink_lifecycle_events (id,organization_id,workspace_id,website_project_id,aggregate_type,aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,before_state,after_state,correlation_id,idempotency_key) SELECT $10,$1,$2,$3,'recommendation_pool',$5,changed.version,changed.version,'recommendation_pool.archived','user',$4,jsonb_build_object('generation',$6,'state',changed."previousState"),jsonb_build_object('generation',$6+1,'state','awaiting_refresh','archivedCount',changed."archivedCount",'preparedCandidateCount',changed."preparedCount"),$9,'recommendation.pool.archive:'||$7 FROM changed RETURNING id),
 audit AS (INSERT INTO backlink_audit_events (id,organization_id,workspace_id,website_project_id,lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,outcome,before_redacted,after_redacted,request_id,correlation_id,integrity_hash) SELECT $11,$1,$2,$3,lifecycle.id,$4,'user','recommendation_pool.archived','recommendation_pool',$5,'success',jsonb_build_object('generation',$6,'state',changed."previousState"),jsonb_build_object('generation',$6+1,'state','awaiting_refresh','preparedCandidateCount',changed."preparedCount"),$9,$9,$8 FROM lifecycle,changed RETURNING id),
 completed AS (INSERT INTO backlink_idempotency_records (id,organization_id,workspace_id,website_project_id,idempotency_key,command_type,request_hash,response_status,response_body,response_schema_version,completed_at,expires_at,created_by,updated_by) SELECT $12,$1,$2,$3,$7,'recommendation.pool.archive',$8,200,jsonb_build_object('archivedGeneration',$6,'nextGeneration',$6+1,'archivedCount',changed."archivedCount",'preparedCandidateCount',changed."preparedCount",'state','awaiting_refresh','version',changed.version,'lifecycleEventId',$10,'auditEventId',$11),1,now(),now()+interval '24 hours',$4,$4 FROM changed,audit RETURNING request_hash "requestHash",response_body "responseBody")
SELECT 'completed' state,* FROM completed UNION ALL SELECT 'replay',"requestHash","responseBody" FROM prior UNION ALL SELECT 'version_conflict',$8,NULL WHERE NOT EXISTS (SELECT 1 FROM completed) AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [
        tenant.organizationId,
        tenant.workspaceId,
        project.websiteProjectId,
        actor.userId,
        input.recommendationContextVersionId,
        input.visiblePoolGeneration,
        input.idempotencyKey,
        requestHash,
        input.requestId,
        ...ids,
      ];
      return result<ArchiveRecommendationPoolResult>(
        (await client.query(sql, values)).rows[0] as ResultRow | undefined,
        requestHash,
      );
    },
    async cancelQueuedRefill(
      input: CancelQueuedRecommendationRefillCommand,
    ): Promise<CancelQueuedRecommendationRefillResult> {
      authorize(input.context);
      const { tenant, project, actor } = input.context;
      const requestHash = digest({
        jobId: input.jobId,
        expectedVersion: input.expectedVersion,
        reasonCode: input.reasonCode,
      });
      const ids = Array.from({ length: 3 }, () => randomUUID());
      const sql = `WITH guard AS (
  SELECT pg_advisory_xact_lock(
    hashtextextended(
      $2::uuid::text||':'||$5::uuid::text||':recommendation.refill.queued.cancel',
      0
    )
  )
),
prior AS (
  SELECT record.request_hash "requestHash",
         record.response_body "responseBody"
  FROM guard
  CROSS JOIN LATERAL (
    SELECT *
    FROM backlink_idempotency_records
    WHERE workspace_id=$2
      AND idempotency_key=$8
      AND command_type='recommendation.refill.queued.cancel'
  ) record
),
eligible AS MATERIALIZED (
  SELECT job.id "jobId",job.status "previousJobStatus",
         job.version "previousJobVersion",refill.id "refillId",
         refill.recommendation_context_version_id
           "recommendationContextVersionId",
         refill.visible_pool_generation "visiblePoolGeneration",
         refill.refill_window_key "refillWindowKey",
         event.id "outboxEventId",event.status "previousOutboxStatus",
         policy.visible_pool_state "previousPolicyState",
         policy.refill_state "previousRefillState"
  FROM guard
  JOIN backlink_jobs job
    ON (job.organization_id,job.workspace_id,
        job.website_project_id,job.id)=($1,$2,$3,$5)
  JOIN backlink_recommendation_refills refill
    ON (refill.organization_id,refill.workspace_id,
        refill.website_project_id,refill.job_id)=
       (job.organization_id,job.workspace_id,
        job.website_project_id,job.id)
  JOIN backlink_outbox_events event
    ON (event.organization_id,event.workspace_id,
        event.website_project_id,event.aggregate_id)=
       (job.organization_id,job.workspace_id,
        job.website_project_id,job.id)
   AND event.event_type='backlinks.recommendation-refill.requested.v1'
  JOIN backlink_commercial_inventory_policies policy
    ON (policy.organization_id,policy.workspace_id,
        policy.website_project_id,policy.project_context_version_id)=
       (refill.organization_id,refill.workspace_id,
        refill.website_project_id,
        refill.recommendation_context_version_id)
   AND policy.visible_pool_generation=refill.visible_pool_generation
  WHERE job.job_type='recommendation_refill'
    AND job.source_object_type='recommendation_context'
    AND job.status='queued'
    AND job.version=$6
    AND refill.trigger_reason='inventory_low'
    AND refill.refill_window_key LIKE
        'project-bootstrap:'||$3::text||':%'
    AND event.status='pending'
    AND event.attempt_count=0
    AND event.claimed_at IS NULL
    AND event.claimed_by IS NULL
    AND policy.visible_pool_state='building'
    AND policy.refill_state='running'
    AND NOT EXISTS (SELECT 1 FROM prior)
    AND NOT EXISTS (
      SELECT 1
      FROM backlink_commercial_discovery_batches batch
      WHERE (batch.organization_id,batch.workspace_id,
             batch.website_project_id,batch.refill_job_id)=
            ($1,$2,$3,job.id)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM backlink_recommendation_refills other_refill
      JOIN backlink_jobs other_job
        ON (other_job.organization_id,other_job.workspace_id,
            other_job.website_project_id,other_job.id)=
           (other_refill.organization_id,other_refill.workspace_id,
            other_refill.website_project_id,other_refill.job_id)
      WHERE (other_refill.organization_id,other_refill.workspace_id,
             other_refill.website_project_id,
             other_refill.recommendation_context_version_id)=
            (refill.organization_id,refill.workspace_id,
             refill.website_project_id,
             refill.recommendation_context_version_id)
        AND other_refill.visible_pool_generation=
            refill.visible_pool_generation
        AND other_refill.job_id<>job.id
        AND other_job.status IN ('queued','running','waiting_provider')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM backlink_recommendation_refills other_refill
      JOIN backlink_outbox_events other_event
        ON (other_event.organization_id,other_event.workspace_id,
            other_event.website_project_id,other_event.aggregate_id)=
           (other_refill.organization_id,other_refill.workspace_id,
            other_refill.website_project_id,other_refill.job_id)
      WHERE (other_refill.organization_id,other_refill.workspace_id,
             other_refill.website_project_id,
             other_refill.recommendation_context_version_id)=
            (refill.organization_id,refill.workspace_id,
             refill.website_project_id,
             refill.recommendation_context_version_id)
        AND other_refill.visible_pool_generation=
            refill.visible_pool_generation
        AND other_refill.job_id<>job.id
        AND other_event.event_type=
            'backlinks.recommendation-refill.requested.v1'
        AND other_event.status IN ('pending','processing')
    )
  FOR UPDATE OF job,event,policy
),
consumed_outbox AS (
  UPDATE backlink_outbox_events event
  SET status='published',published_at=now(),claimed_at=NULL,claimed_by=NULL,
      payload=COALESCE(event.payload,'{}'::jsonb)||jsonb_build_object(
        'dispatchDisposition','cancelled_before_dispatch',
        'cancellationReasonCode',$7::text,
        'cancelledBy',$4::text,
        'cancelledAt',now()
      ),
      updated_at=now(),updated_by=$4
  FROM eligible
  WHERE event.id=eligible."outboxEventId"
  RETURNING event.id "outboxEventId",event.status "outboxStatus"
),
changed_job AS (
  UPDATE backlink_jobs job
  SET status='cancelled',step='cancelled_before_dispatch',progress=100,
      result_summary=COALESCE(job.result_summary,'{}'::jsonb)
        ||jsonb_build_object(
          'final',true,
          'outcome','READ_SIDE_EFFECT_CANCELLED',
          'reasonCode',$7::text,
          'outboxEventId',consumed_outbox."outboxEventId",
          'dispatchDisposition','cancelled_before_dispatch'
        ),
      error=NULL,finished_at=now(),updated_at=now(),updated_by=$4,
      version=job.version+1
  FROM eligible,consumed_outbox
  WHERE job.id=eligible."jobId"
  RETURNING job.id "jobId",job.version,eligible."previousJobStatus",
            eligible."previousJobVersion",eligible."refillId",
            eligible."recommendationContextVersionId",
            eligible."visiblePoolGeneration",eligible."outboxEventId",
            eligible."previousOutboxStatus",
            eligible."previousPolicyState",eligible."previousRefillState"
),
changed_policy AS (
  UPDATE backlink_commercial_inventory_policies policy
  SET visible_pool_state='idle',refill_state='idle',
      termination_reason=NULL,
      pause_reason=NULL,next_refill_at=NULL,
      updated_at=now(),updated_by=$4,version=policy.version+1
  FROM changed_job
  WHERE (policy.organization_id,policy.workspace_id,
         policy.website_project_id,policy.project_context_version_id)=
        ($1,$2,$3,changed_job."recommendationContextVersionId")
    AND policy.visible_pool_generation=changed_job."visiblePoolGeneration"
  RETURNING policy.visible_pool_state "policyState",
            policy.refill_state "refillState",
            policy.termination_reason "terminationReason",
            policy.pause_reason "pauseReason",
            policy.next_refill_at "nextRefillAt"
),
lifecycle AS (
  INSERT INTO backlink_lifecycle_events (
    id,organization_id,workspace_id,website_project_id,job_id,
    aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
    actor_type,actor_id,before_state,after_state,reason,correlation_id,
    idempotency_key
  )
  SELECT $12,$1,$2,$3,changed_job."jobId",'recommendation_refill',
         changed_job."refillId",changed_job.version,changed_job.version,
         'recommendation_refill.cancelled_before_dispatch','user',$4,
         jsonb_build_object(
           'jobStatus',changed_job."previousJobStatus",
           'jobVersion',changed_job."previousJobVersion",
           'outboxStatus',changed_job."previousOutboxStatus",
           'policyState',changed_job."previousPolicyState",
           'refillState',changed_job."previousRefillState"
         ),
         jsonb_build_object(
           'jobStatus','cancelled',
           'jobVersion',changed_job.version,
           'outboxStatus',consumed_outbox."outboxStatus",
           'dispatchDisposition','cancelled_before_dispatch',
           'policyState',changed_policy."policyState",
           'refillState',changed_policy."refillState",
           'terminationReason',changed_policy."terminationReason",
           'pauseReason',changed_policy."pauseReason",
           'nextRefillAt',changed_policy."nextRefillAt"
         ),
         $7::text,$10,'recommendation.refill.queued.cancel:'||$8
  FROM changed_job,consumed_outbox,changed_policy
  RETURNING id
),
audit AS (
  INSERT INTO backlink_audit_events (
    id,organization_id,workspace_id,website_project_id,job_id,
    lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,
    outcome,reason,before_redacted,after_redacted,request_id,
    correlation_id,integrity_hash
  )
  SELECT $13,$1,$2,$3,changed_job."jobId",lifecycle.id,$4,'user',
         'recommendation_refill.cancelled_before_dispatch',
         'recommendation_refill',changed_job."refillId",'success',$7::text,
         jsonb_build_object(
           'jobStatus',changed_job."previousJobStatus",
           'jobVersion',changed_job."previousJobVersion",
           'outboxStatus',changed_job."previousOutboxStatus"
         ),
         jsonb_build_object(
           'jobStatus','cancelled',
           'jobVersion',changed_job.version,
           'outboxStatus',consumed_outbox."outboxStatus",
           'dispatchDisposition','cancelled_before_dispatch',
           'policyState',changed_policy."policyState",
           'refillState',changed_policy."refillState",
           'terminationReason',changed_policy."terminationReason",
           'pauseReason',changed_policy."pauseReason",
           'nextRefillAt',changed_policy."nextRefillAt"
         ),
         $10,$10,$9
  FROM changed_job,consumed_outbox,changed_policy,lifecycle
  RETURNING id
),
completed AS (
  INSERT INTO backlink_idempotency_records (
    id,organization_id,workspace_id,website_project_id,idempotency_key,
    command_type,request_hash,response_status,response_body,
    response_schema_version,completed_at,expires_at,created_by,updated_by
  )
  SELECT $11,$1,$2,$3,$8,'recommendation.refill.queued.cancel',$9,200,
         jsonb_build_object(
           'jobId',changed_job."jobId",
           'refillId',changed_job."refillId",
           'outboxEventId',changed_job."outboxEventId",
           'recommendationContextVersionId',
             changed_job."recommendationContextVersionId",
           'visiblePoolGeneration',changed_job."visiblePoolGeneration",
           'status','cancelled',
           'outboxStatus',consumed_outbox."outboxStatus",
           'dispatchDisposition','cancelled_before_dispatch',
           'policyState',changed_policy."policyState",
           'reasonCode',$7::text,
           'version',changed_job.version,
           'lifecycleEventId',$12,
           'auditEventId',$13
         ),
         1,now(),now()+interval '24 hours',$4,$4
  FROM changed_job,consumed_outbox,changed_policy,audit
  RETURNING request_hash "requestHash",response_body "responseBody"
)
SELECT 'completed' state,* FROM completed
UNION ALL SELECT 'replay',"requestHash","responseBody" FROM prior
UNION ALL SELECT 'version_conflict',$9,NULL
WHERE NOT EXISTS (SELECT 1 FROM completed)
  AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [
        tenant.organizationId,
        tenant.workspaceId,
        project.websiteProjectId,
        actor.userId,
        input.jobId,
        input.expectedVersion,
        input.reasonCode,
        input.idempotencyKey,
        requestHash,
        input.requestId,
        ...ids,
      ];
      return result<CancelQueuedRecommendationRefillResult>(
        (await client.query(sql, values)).rows[0] as ResultRow | undefined,
        requestHash,
      );
    },
    async closeDuplicateRefill(
      input: CloseDuplicateRecommendationRefillCommand,
    ): Promise<CloseDuplicateRecommendationRefillResult> {
      authorize(input.context);
      if (input.duplicateJobId === input.canonicalJobId) {
        throw conflict("A refill job cannot be its own canonical owner.");
      }
      const { tenant, project, actor } = input.context;
      const requestHash = digest({
        duplicateJobId: input.duplicateJobId,
        canonicalJobId: input.canonicalJobId,
        expectedVersion: input.expectedVersion,
        reasonCode: input.reasonCode,
      });
      const ids = Array.from({ length: 3 }, () => randomUUID());
      const sql = `WITH guard AS (SELECT pg_advisory_xact_lock(hashtextextended($2::uuid::text||':'||$5::uuid::text||':recommendation.refill.duplicate.close',0))),
prior AS (SELECT i.request_hash "requestHash",i.response_body "responseBody" FROM guard CROSS JOIN LATERAL (SELECT * FROM backlink_idempotency_records WHERE workspace_id=$2 AND idempotency_key=$9 AND command_type='recommendation.refill.duplicate.close') i),
eligible AS MATERIALIZED (
  SELECT duplicate_job.id "duplicateJobId",duplicate_job.status "previousStatus",
         duplicate_job.version "previousVersion",duplicate_job.error "previousError",
         duplicate_refill.id "refillId",canonical_job.id "canonicalJobId"
  FROM guard
  JOIN backlink_jobs duplicate_job ON (duplicate_job.organization_id,duplicate_job.workspace_id,duplicate_job.website_project_id,duplicate_job.id)=($1,$2,$3,$5)
  JOIN backlink_recommendation_refills duplicate_refill ON (duplicate_refill.organization_id,duplicate_refill.workspace_id,duplicate_refill.website_project_id,duplicate_refill.job_id)=(duplicate_job.organization_id,duplicate_job.workspace_id,duplicate_job.website_project_id,duplicate_job.id)
  JOIN backlink_jobs canonical_job ON (canonical_job.organization_id,canonical_job.workspace_id,canonical_job.website_project_id,canonical_job.id)=($1,$2,$3,$7)
    AND canonical_job.job_type=duplicate_job.job_type
    AND canonical_job.source_object_type=duplicate_job.source_object_type
    AND canonical_job.source_object_id=duplicate_job.source_object_id
  JOIN backlink_recommendation_refills canonical_refill ON (canonical_refill.organization_id,canonical_refill.workspace_id,canonical_refill.website_project_id,canonical_refill.job_id)=(canonical_job.organization_id,canonical_job.workspace_id,canonical_job.website_project_id,canonical_job.id)
    AND canonical_refill.recommendation_context_version_id=duplicate_refill.recommendation_context_version_id
    AND canonical_refill.visible_pool_generation=duplicate_refill.visible_pool_generation
  WHERE duplicate_job.job_type='recommendation_refill'
    AND duplicate_job.source_object_type='recommendation_context'
    AND duplicate_job.status='failed'
    AND duplicate_job.version=$6
    AND COALESCE(duplicate_job.error->>'providerCallOccurred','false')='false'
    AND canonical_job.status IN ('waiting_provider','partial_success','success')
    AND canonical_job.result_summary->>'existingCandidatesCompleted'='true'
    AND jsonb_typeof(canonical_job.result_summary->'addedCount')='number'
    AND (canonical_job.result_summary->>'addedCount')::integer>0
    AND NOT EXISTS (SELECT 1 FROM prior)
    AND NOT EXISTS (
      SELECT 1 FROM backlink_commercial_discovery_batches batch
      WHERE (batch.organization_id,batch.workspace_id,batch.website_project_id,batch.refill_job_id)=($1,$2,$3,duplicate_job.id)
        AND (batch.status='running' OR batch.paid_cost_micros>0 OR jsonb_array_length(batch.provider_request_fingerprints)>0)
    )
    AND NOT EXISTS (
      SELECT 1 FROM provider_batch_requests request
      WHERE (request.organization_id,request.workspace_id,request.website_project_id)=($1,$2,$3)
        AND request.request_id LIKE duplicate_refill.refill_window_key||':%'
        AND (request.provider_task_id IS NOT NULL OR COALESCE(request.actual_cost_micros,0)>0 OR request.status IN ('running','unknown_charge','succeeded'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM backlink_provider_usage_ledger usage
      WHERE (usage.organization_id,usage.workspace_id,usage.website_project_id)=($1,$2,$3)
        AND usage.reservation_key LIKE duplicate_refill.refill_window_key||':%'
        AND (usage.status IN ('reserved','settled') OR COALESCE(usage.actual_cost_micros,0)>0)
    )
    AND NOT EXISTS (
      SELECT 1 FROM provider_fetch_leases lease
      WHERE lease.owner_request_id LIKE duplicate_refill.refill_window_key||':%'
    )
  FOR UPDATE OF duplicate_job
),
changed AS (
  UPDATE backlink_jobs job
  SET status='cancelled',step='duplicate_closed',progress=100,
      result_summary=COALESCE(job.result_summary,'{}'::jsonb)||jsonb_build_object(
        'final',true,'outcome','DUPLICATE_CLOSED','duplicateOf',$7::text,
        'reasonCode',$8::text
      ),
      error=NULL,finished_at=now(),updated_at=now(),updated_by=$4,
      version=job.version+1
  FROM eligible
  WHERE job.id=eligible."duplicateJobId"
  RETURNING job.id "duplicateJobId",job.version,eligible."previousStatus",
            eligible."previousVersion",eligible."previousError",
            eligible."refillId",eligible."canonicalJobId"
),
lifecycle AS (
  INSERT INTO backlink_lifecycle_events (
    id,organization_id,workspace_id,website_project_id,job_id,
    aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
    actor_type,actor_id,before_state,after_state,reason,correlation_id,
    idempotency_key
  )
  SELECT $13,$1,$2,$3,changed."duplicateJobId",'recommendation_refill',
         changed."refillId",changed.version,changed.version,
         'recommendation_refill.duplicate_closed','user',$4,
         jsonb_build_object('status',changed."previousStatus",'version',changed."previousVersion",'errorCode',changed."previousError"->>'code'),
         jsonb_build_object('status','cancelled','version',changed.version,'duplicateOf',changed."canonicalJobId"),
         $8::text,$11,'recommendation.refill.duplicate.close:'||$9
  FROM changed
  RETURNING id
),
audit AS (
  INSERT INTO backlink_audit_events (
    id,organization_id,workspace_id,website_project_id,job_id,
    lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,
    outcome,reason,before_redacted,after_redacted,request_id,
    correlation_id,integrity_hash
  )
  SELECT $14,$1,$2,$3,changed."duplicateJobId",lifecycle.id,$4,'user',
         'recommendation_refill.duplicate_closed','recommendation_refill',
         changed."refillId",'success',$8::text,
         jsonb_build_object('status',changed."previousStatus",'version',changed."previousVersion",'errorCode',changed."previousError"->>'code'),
         jsonb_build_object('status','cancelled','version',changed.version,'duplicateOf',changed."canonicalJobId"),
         $11,$11,$10
  FROM changed,lifecycle
  RETURNING id
),
completed AS (
  INSERT INTO backlink_idempotency_records (
    id,organization_id,workspace_id,website_project_id,idempotency_key,
    command_type,request_hash,response_status,response_body,
    response_schema_version,completed_at,expires_at,created_by,updated_by
  )
  SELECT $12,$1,$2,$3,$9,'recommendation.refill.duplicate.close',$10,200,
         jsonb_build_object(
           'duplicateJobId',changed."duplicateJobId",
           'canonicalJobId',changed."canonicalJobId",
           'status','cancelled','reasonCode',$8::text,'version',changed.version,
           'lifecycleEventId',$13,'auditEventId',$14
         ),
         1,now(),now()+interval '24 hours',$4,$4
  FROM changed,audit
  RETURNING request_hash "requestHash",response_body "responseBody"
)
SELECT 'completed' state,* FROM completed
UNION ALL SELECT 'replay',"requestHash","responseBody" FROM prior
UNION ALL SELECT 'version_conflict',$10,NULL
WHERE NOT EXISTS (SELECT 1 FROM completed) AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [
        tenant.organizationId,
        tenant.workspaceId,
        project.websiteProjectId,
        actor.userId,
        input.duplicateJobId,
        input.expectedVersion,
        input.canonicalJobId,
        input.reasonCode,
        input.idempotencyKey,
        requestHash,
        input.requestId,
        ...ids,
      ];
      return result<CloseDuplicateRecommendationRefillResult>(
        (await client.query(sql, values)).rows[0] as ResultRow | undefined,
        requestHash,
      );
    },
  };
}
