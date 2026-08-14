import { createHash, randomUUID } from "node:crypto";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import { commercialDiscoveryBlueprintVersion } from "../../domain/recommendations/commercial-discovery-blueprint.js";
import { commercialSupplyPublishedTarget } from "../../domain/recommendations/commercial-refill-cycle.js";
import { buildBacklinksWorkflowId } from "../../workflows/namespaces.js";

export type RecommendationCommandClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
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
}>;
export type ArchiveRecommendationPoolCommand = Readonly<{
  context: ResolvedProjectContext;
  requestId: string;
  idempotencyKey: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
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
  state: "awaiting_refresh";
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
        input.lowWatermark !== commercialSupplyPublishedTarget - 1 ||
        input.highWatermark !== commercialSupplyPublishedTarget
      ) {
        throw conflict("Recommendation refill target must be exactly 10.");
      }
      const { tenant, project, actor } = input.context;
      let triggerReason = input.triggerReason ?? "manual";
      let refillWindowKey = input.refillWindowKey;
      if (input.operationId !== undefined) {
        const recovery = (
          await client.query(
            `SELECT substring(
                      idempotency.idempotency_key
                      FROM length('recommendation-refill:')+1
                    ) "refillWindowKey",
                    refill.trigger_reason "triggerReason",
                    refill.low_watermark "lowWatermark",
                    refill.high_watermark "highWatermark",
                    refill.visible_pool_generation "visiblePoolGeneration"
               FROM backlink_recommendation_refills AS refill
               JOIN backlink_idempotency_records AS idempotency
                 ON idempotency.organization_id=refill.organization_id
                AND idempotency.workspace_id=refill.workspace_id
                AND idempotency.website_project_id=refill.website_project_id
                AND idempotency.command_type='recommendation.refill'
                AND idempotency.response_body->>'operationId'=refill.id::text
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
          Number(recovery.lowWatermark) !== input.lowWatermark ||
          Number(recovery.highWatermark) !== input.highWatermark ||
          (input.refillWindowKey !== undefined &&
            input.refillWindowKey !== recovery.refillWindowKey) ||
          (input.triggerReason !== undefined &&
            input.triggerReason !== recovery.triggerReason)
        ) {
          throw conflict(
            "The recovery operation does not match the current context.",
          );
        }
        refillWindowKey = String(recovery.refillWindowKey);
        triggerReason = recovery.triggerReason as
          | "inventory_low"
          | "manual";
      }
      refillWindowKey ??=
        `manual:${input.recommendationContextVersionId}:g${input.visiblePoolGeneration}:blueprint-v${commercialDiscoveryBlueprintVersion}`;
      const idempotencyKey = `recommendation-refill:${refillWindowKey}`;
      const requestHash = digest({
        recommendationContextVersionId: input.recommendationContextVersionId,
        visiblePoolGeneration: input.visiblePoolGeneration,
        expectedVersion: input.expectedVersion,
        lowWatermark: input.lowWatermark,
        highWatermark: input.highWatermark,
        refillWindowKey,
        triggerReason,
      });
      const ids = Array.from({ length: 6 }, () => randomUUID());
      const workflowId = buildBacklinksWorkflowId({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        websiteProjectId: project.websiteProjectId,
        workflow: "recommendation-refill",
        instanceId: ids[1] ?? "",
      });
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
recoverable AS (SELECT event.id FROM prior JOIN backlink_jobs failed_job ON failed_job.organization_id=$1 AND failed_job.workspace_id=$2 AND failed_job.website_project_id=$3 AND failed_job.id=(prior."responseBody"->>'jobId')::uuid JOIN backlink_recommendation_refills failed_refill ON failed_refill.organization_id=failed_job.organization_id AND failed_refill.workspace_id=failed_job.workspace_id AND failed_refill.website_project_id=failed_job.website_project_id AND failed_refill.job_id=failed_job.id JOIN backlink_outbox_events event ON event.organization_id=$1 AND event.workspace_id=$2 AND event.website_project_id=$3 AND event.aggregate_id=failed_job.id AND event.event_type='backlinks.recommendation-refill.requested.v1' WHERE ($21::uuid IS NULL OR (prior."responseBody"->>'operationId')::uuid=$21::uuid) AND failed_job.status='failed' AND failed_job.retry_count<6 AND event.status='published' AND NOT EXISTS (SELECT 1 FROM backlink_provider_usage_ledger usage WHERE usage.organization_id=$1 AND usage.workspace_id=$2 AND usage.website_project_id=$3 AND usage.provider='dataforseo' AND usage.reservation_key LIKE failed_refill.refill_window_key||':%' AND usage.status='reserved') AND NOT EXISTS (SELECT 1 FROM provider_batch_requests request WHERE request.organization_id=$1 AND request.workspace_id=$2 AND request.website_project_id=$3 AND request.request_id LIKE failed_refill.refill_window_key||':%' AND request.status IN ('running','unknown_charge')) AND NOT EXISTS (SELECT 1 FROM provider_fetch_leases lease WHERE lease.owner_request_id LIKE failed_refill.refill_window_key||':%' AND (lease.status='unknown_charge' OR (lease.status='acquired' AND lease.lease_expires_at>now())))),
rearmed AS (UPDATE backlink_outbox_events event SET status='pending',available_at=now(),claimed_at=NULL,claimed_by=NULL,published_at=NULL,updated_at=now(),updated_by=$4 FROM recoverable WHERE event.id=recoverable.id RETURNING event.id),
recovery AS (SELECT count(*)::integer "rearmedCount" FROM rearmed),
pool AS (SELECT policy.visible_pool_generation FROM guard CROSS JOIN LATERAL (SELECT visible_pool_generation,visible_pool_state FROM backlink_commercial_inventory_policies WHERE (organization_id,workspace_id,website_project_id,project_context_version_id)=($1,$2,$3,$5) FOR UPDATE) policy WHERE policy.visible_pool_generation=$22 AND policy.visible_pool_state IN ('idle','building','awaiting_refresh')),
available AS (SELECT 1 FROM pool WHERE $6::integer=0 AND $21::uuid IS NULL AND NOT EXISTS (SELECT 1 FROM prior) AND NOT EXISTS (SELECT 1 FROM backlink_recommendation_refills WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3 AND recommendation_context_version_id=$5 AND visible_pool_generation=$22 AND refill_window_key=$18) AND NOT EXISTS (SELECT 1 FROM backlink_recommendation_refills active_refill JOIN backlink_jobs active_job ON (active_job.organization_id,active_job.workspace_id,active_job.website_project_id,active_job.id)=(active_refill.organization_id,active_refill.workspace_id,active_refill.website_project_id,active_refill.job_id) WHERE (active_refill.organization_id,active_refill.workspace_id,active_refill.website_project_id)=($1,$2,$3) AND active_refill.recommendation_context_version_id=$5 AND active_refill.visible_pool_generation=$22 AND active_job.status IN ('queued','running','waiting_provider')) AND NOT EXISTS (SELECT 1 FROM backlink_commercial_discovery_batches active_discovery WHERE (active_discovery.organization_id,active_discovery.workspace_id,active_discovery.website_project_id)=($1,$2,$3) AND active_discovery.project_context_version_id=$5 AND active_discovery.visible_pool_generation=$22 AND active_discovery.status='running') AND NOT EXISTS (SELECT 1 FROM backlink_contact_enrichment_batches active_contact JOIN backlink_recommendation_inventory active_inventory ON (active_inventory.organization_id,active_inventory.workspace_id,active_inventory.website_project_id,active_inventory.recommendation_context_version_id)=(active_contact.organization_id,active_contact.workspace_id,active_contact.website_project_id,active_contact.recommendation_context_version_id) WHERE (active_contact.organization_id,active_contact.workspace_id,active_contact.website_project_id)=($1,$2,$3) AND active_contact.recommendation_context_version_id=$5 AND active_inventory.visible_pool_generation=$22 AND active_contact.status='running')),
activated AS (UPDATE backlink_commercial_inventory_policies policy SET visible_pool_state='building',refill_state='running',current_refill_tier=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN 'exact_product_target_market' ELSE policy.current_refill_tier END,current_refill_round=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN 1 ELSE policy.current_refill_round END,paid_refill_tier=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN 'exact_product_target_market' ELSE policy.paid_refill_tier END,paid_refill_round=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN 1 ELSE policy.paid_refill_round END,resource_refill_tier=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN 'curated_resource_library' ELSE policy.resource_refill_tier END,resource_refill_round=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN 1 ELSE policy.resource_refill_round END,attempted_refill_tiers=CASE WHEN policy.termination_reason='TIERS_EXHAUSTED' THEN '[]'::jsonb ELSE policy.attempted_refill_tiers END,termination_reason=NULL,pause_reason=NULL,next_refill_at=NULL,updated_at=now(),updated_by=$4,version=version+1 FROM available WHERE (policy.organization_id,policy.workspace_id,policy.website_project_id,policy.project_context_version_id)=($1,$2,$3,$5) AND policy.visible_pool_generation=$22 RETURNING policy.visible_pool_generation),
job AS (INSERT INTO backlink_jobs (id,organization_id,workspace_id,website_project_id,job_type,source_object_type,source_object_id,workflow_id,correlation_id,created_by,updated_by) SELECT $10,$1,$2,$3,'recommendation_refill','recommendation_context',$5,$15,$14,$4,$4 FROM activated RETURNING id),
refill AS (INSERT INTO backlink_recommendation_refills (id,organization_id,workspace_id,website_project_id,job_id,recommendation_context_version_id,visible_pool_generation,trigger_reason,low_watermark,high_watermark,refill_window_key,created_by,updated_by) SELECT $11,$1,$2,$3,job.id,$5,$22,$20,$16,$17,$18,$4,$4 FROM job RETURNING id),
lifecycle AS (INSERT INTO backlink_lifecycle_events (id,organization_id,workspace_id,website_project_id,job_id,aggregate_type,aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,after_state,correlation_id,idempotency_key) SELECT $12,$1,$2,$3,$10,'recommendation_refill',refill.id,1,1,'recommendation_refill.requested','user',$4,jsonb_build_object('status','queued'),$14,'recommendation.refill:'||$7 FROM refill RETURNING id),
audit AS (INSERT INTO backlink_audit_events (id,organization_id,workspace_id,website_project_id,job_id,lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,outcome,after_redacted,request_id,correlation_id,integrity_hash) SELECT $13,$1,$2,$3,$10,lifecycle.id,$4,'user','recommendation_refill.requested','recommendation_refill',$11,'success',jsonb_build_object('status','queued'),$14,$14,$8 FROM lifecycle RETURNING id),
outbox AS (INSERT INTO backlink_outbox_events (id,organization_id,workspace_id,website_project_id,event_type,aggregate_id,aggregate_version,idempotency_key,payload,payload_schema_version,created_by,updated_by) SELECT $19,$1,$2,$3,'backlinks.recommendation-refill.requested.v1',$10,1,$15,jsonb_build_object('contractVersion','backlinks.recommendation-refill.requested.v1','organizationId',$1::text,'workspaceId',$2::text,'websiteProjectId',$3::text,'recommendationContextVersionId',$5::text,'visiblePoolGeneration',$22,'jobId',$10::text,'workflowId',$15,'correlationId',$14,'actorId',$4,'refillWindowKey',$18,'lowWatermark',$16,'highWatermark',$17),1,$4,$4 FROM refill RETURNING id),
completed AS (INSERT INTO backlink_idempotency_records (id,organization_id,workspace_id,website_project_id,idempotency_key,command_type,request_hash,response_status,response_body,response_schema_version,completed_at,expires_at,created_by,updated_by) SELECT $9,$1,$2,$3,$7,'recommendation.refill',$8,202,jsonb_build_object('operationId',$11,'jobId',$10,'workflowId',$15,'status','queued','version',1,'visiblePoolGeneration',$22,'lifecycleEventId',$12,'auditEventId',$13),1,now(),now()+interval '24 hours',$4,$4 FROM audit CROSS JOIN outbox RETURNING request_hash "requestHash",response_body "responseBody")
SELECT 'completed' state,* FROM completed UNION ALL SELECT CASE WHEN recovery."rearmedCount">0 OR prior_job.status IN ('queued','running','waiting_provider','partial_success','success') THEN 'replay' ELSE 'recovery_blocked' END state,"requestHash","responseBody" FROM prior CROSS JOIN recovery CROSS JOIN prior_job UNION ALL SELECT 'version_conflict',$8,NULL WHERE NOT EXISTS (SELECT 1 FROM completed) AND NOT EXISTS (SELECT 1 FROM prior)`;
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
        input.lowWatermark,
        input.highWatermark,
        refillWindowKey,
        ids[5],
        triggerReason,
        input.operationId ?? null,
        input.visiblePoolGeneration,
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
pool AS (SELECT policy.version FROM guard CROSS JOIN LATERAL (SELECT version FROM backlink_commercial_inventory_policies WHERE (organization_id,workspace_id,website_project_id,project_context_version_id)=($1,$2,$3,$5) AND visible_pool_generation=$6 AND visible_pool_state='active' FOR UPDATE) policy WHERE NOT EXISTS (SELECT 1 FROM prior)),
archived AS (UPDATE backlink_recommendation_inventory inventory SET status='archived',updated_at=now(),updated_by=$4,version=inventory.version+1 FROM pool WHERE (inventory.organization_id,inventory.workspace_id,inventory.website_project_id,inventory.recommendation_context_version_id)=($1,$2,$3,$5) AND inventory.visible_pool_generation=$6 AND inventory.status IN ('ready','shown','accepted') RETURNING inventory.id),
archived_count AS (SELECT count(*)::integer count FROM archived),
changed AS (UPDATE backlink_commercial_inventory_policies policy SET visible_pool_generation=$6+1,visible_pool_state='awaiting_refresh',archived_visible_pool_count=policy.archived_visible_pool_count+archived_count.count,visible_pool_archived_at=now(),visible_pool_archived_by=$4,refill_state='idle',current_refill_tier='exact_product_target_market',current_refill_round=1,paid_refill_tier='exact_product_target_market',paid_refill_round=1,resource_refill_tier='curated_resource_library',resource_refill_round=1,attempted_refill_tiers='[]'::jsonb,termination_reason=NULL,pause_reason=NULL,next_refill_at=NULL,updated_at=now(),updated_by=$4,version=policy.version+1 FROM pool,archived_count WHERE (policy.organization_id,policy.workspace_id,policy.website_project_id,policy.project_context_version_id)=($1,$2,$3,$5) AND policy.visible_pool_generation=$6 RETURNING policy.version,archived_count.count),
lifecycle AS (INSERT INTO backlink_lifecycle_events (id,organization_id,workspace_id,website_project_id,aggregate_type,aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,before_state,after_state,correlation_id,idempotency_key) SELECT $10,$1,$2,$3,'recommendation_pool',$5,changed.version,changed.version,'recommendation_pool.archived','user',$4,jsonb_build_object('generation',$6,'state','active'),jsonb_build_object('generation',$6+1,'state','awaiting_refresh','archivedCount',changed.count),$9,'recommendation.pool.archive:'||$7 FROM changed RETURNING id),
audit AS (INSERT INTO backlink_audit_events (id,organization_id,workspace_id,website_project_id,lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,outcome,before_redacted,after_redacted,request_id,correlation_id,integrity_hash) SELECT $11,$1,$2,$3,lifecycle.id,$4,'user','recommendation_pool.archived','recommendation_pool',$5,'success',jsonb_build_object('generation',$6),jsonb_build_object('generation',$6+1,'state','awaiting_refresh'),$9,$9,$8 FROM lifecycle RETURNING id),
completed AS (INSERT INTO backlink_idempotency_records (id,organization_id,workspace_id,website_project_id,idempotency_key,command_type,request_hash,response_status,response_body,response_schema_version,completed_at,expires_at,created_by,updated_by) SELECT $12,$1,$2,$3,$7,'recommendation.pool.archive',$8,200,jsonb_build_object('archivedGeneration',$6,'nextGeneration',$6+1,'archivedCount',changed.count,'state','awaiting_refresh','version',changed.version,'lifecycleEventId',$10,'auditEventId',$11),1,now(),now()+interval '24 hours',$4,$4 FROM changed,audit RETURNING request_hash "requestHash",response_body "responseBody")
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
  };
}
