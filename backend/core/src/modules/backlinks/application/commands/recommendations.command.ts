import { createHash, randomUUID } from "node:crypto";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";
import {
  buildBacklinksWorkflowId,
} from "../../workflows/namespaces.js";

export type RecommendationCommandClient = Readonly<{ query(text: string,
  values?: readonly unknown[]): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>> }>;
type Common = Readonly<{ context: ResolvedProjectContext; idempotencyKey: string; requestId: string;
  expectedVersion: number }>;
export type RejectRecommendationCommand = Common & Readonly<{ recommendationId: string; rejectionType:
  "skipped" | "permanently_rejected"; reasonCode: string; cooldownUntil: string | null }>;
export type RequestRecommendationRefillCommand = Common & Readonly<{ recommendationContextVersionId:
  string; lowWatermark: number; highWatermark: number; refillWindowKey: string;
  triggerReason?: "inventory_low" | "manual" }>;
export type RejectRecommendationResult = Readonly<{ recommendationId: string; status: "rejected";
  version: number; lifecycleEventId: string; auditEventId: string; replayed: boolean }>;
export type RecommendationRefillResult = Readonly<{ jobId: string; workflowId: string; status: "queued";
  version: number; lifecycleEventId: string; auditEventId: string; replayed: boolean }>;
type ResultRow = { state: string; requestHash: string; responseBody?: unknown };
const conflict = (message: string) =>
  new BacklinkError({ code: backlinkErrorCodes.conflict, message });
function authorize(context: ResolvedProjectContext): void {
  if (!context.actor.roles.some((role) => ["owner", "admin", "member"].includes(role))) {
    throw new BacklinkError({ code: backlinkErrorCodes.accessDenied,
      message: "Recommendation write permission is required." });
  }
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function result<T>(row: ResultRow | undefined, requestHash: string): T & { replayed: boolean } {
  if (row === undefined || row.state === "in_progress")
    throw conflict("The idempotent command is already in progress.");
  if (row.requestHash !== requestHash)
    throw conflict("Idempotency key is already bound to a different request.");
  if (!["completed", "replay"].includes(row.state) || row.responseBody === undefined)
    throw conflict("ExpectedVersion does not match the current resource version.");
  return { ...(row.responseBody as T), replayed: row.state === "replay" };
}
export function createRecommendationCommands(client: RecommendationCommandClient) {
  return {
    async reject(input: RejectRecommendationCommand): Promise<RejectRecommendationResult> {
      authorize(input.context);
      const { tenant, project, actor } = input.context;
      const requestHash = digest({ recommendationId: input.recommendationId, expectedVersion:
        input.expectedVersion, rejectionType: input.rejectionType, reasonCode: input.reasonCode,
        cooldownUntil: input.cooldownUntil });
      const ids = Array.from({ length: 4 }, () => randomUUID());
      const sql = `WITH guard AS (SELECT pg_advisory_xact_lock(hashtextextended($2::uuid::text||':'||$7||':recommendation.reject',0))),
prior AS (SELECT i.request_hash "requestHash",i.response_body "responseBody" FROM guard CROSS JOIN LATERAL (SELECT * FROM backlink_idempotency_records WHERE workspace_id=$2 AND idempotency_key=$7 AND command_type='recommendation.reject') i),
changed AS (UPDATE backlink_recommendation_inventory SET status='rejected',version=version+1,updated_at=now(),updated_by=$4 WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3 AND recommendation_id=$5 AND version=$6 AND status IN ('ready','shown') AND NOT EXISTS (SELECT 1 FROM prior) RETURNING id,recommendation_id,prospect_id,recommendation_context_version_id,version),
rejected AS (INSERT INTO backlink_recommendation_rejections (id,organization_id,workspace_id,website_project_id,inventory_id,recommendation_id,prospect_id,recommendation_context_version_id,rejection_type,reason_code,rejected_at,cooldown_until,rejected_by,created_by) SELECT $10,$1,$2,$3,id,recommendation_id,prospect_id,recommendation_context_version_id,$14,$15,now(),$16::timestamptz,$4,$4 FROM changed RETURNING recommendation_id),
lifecycle AS (INSERT INTO backlink_lifecycle_events (id,organization_id,workspace_id,website_project_id,aggregate_type,aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,before_state,after_state,reason,correlation_id,idempotency_key) SELECT $11,$1,$2,$3,'recommendation',c.recommendation_id,c.version,c.version,'recommendation.rejected','user',$4,jsonb_build_object('version',c.version-1),jsonb_build_object('version',c.version,'status','rejected'),$15,$13,'recommendation.reject:'||$7 FROM changed c,rejected RETURNING id),
audit AS (INSERT INTO backlink_audit_events (id,organization_id,workspace_id,website_project_id,lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,outcome,reason,before_redacted,after_redacted,request_id,correlation_id,integrity_hash) SELECT $12,$1,$2,$3,lifecycle.id,$4,'user','recommendation.rejected','recommendation',$5,'success',$15,jsonb_build_object('expectedVersion',$6),jsonb_build_object('status','rejected'),$13,$13,$17 FROM lifecycle RETURNING id),
completed AS (INSERT INTO backlink_idempotency_records (id,organization_id,workspace_id,website_project_id,idempotency_key,command_type,request_hash,response_status,response_body,response_schema_version,completed_at,expires_at,created_by,updated_by) SELECT $9,$1,$2,$3,$7,'recommendation.reject',$8,200,jsonb_build_object('recommendationId',c.recommendation_id,'status','rejected','version',c.version,'lifecycleEventId',$11,'auditEventId',$12),1,now(),now()+interval '24 hours',$4,$4 FROM changed c,audit RETURNING request_hash "requestHash",response_body "responseBody")
SELECT 'completed' state,* FROM completed UNION ALL SELECT 'replay',"requestHash","responseBody" FROM prior UNION ALL SELECT 'version_conflict',$8,NULL WHERE NOT EXISTS (SELECT 1 FROM completed) AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [tenant.organizationId, tenant.workspaceId, project.websiteProjectId,
        actor.userId, input.recommendationId, input.expectedVersion, input.idempotencyKey,
        requestHash, ...ids, input.requestId, input.rejectionType, input.reasonCode,
        input.cooldownUntil, requestHash];
      return result<RejectRecommendationResult>(
        (await client.query(sql, values)).rows[0] as ResultRow | undefined, requestHash);
    },
    async requestRefill(input: RequestRecommendationRefillCommand): Promise<RecommendationRefillResult> {
      authorize(input.context);
      if (input.expectedVersion !== 0) throw conflict("New refill jobs require ExpectedVersion 0.");
      const { tenant, project, actor } = input.context;
      const triggerReason = input.triggerReason ?? "manual";
      const requestHash = digest({ recommendationContextVersionId: input.recommendationContextVersionId,
        expectedVersion: input.expectedVersion, lowWatermark: input.lowWatermark,
        highWatermark: input.highWatermark, refillWindowKey: input.refillWindowKey,
        triggerReason });
      const ids = Array.from({ length: 6 }, () => randomUUID());
      const workflowId = buildBacklinksWorkflowId({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        websiteProjectId: project.websiteProjectId,
        workflow: "recommendation-refill",
        instanceId: ids[1] ?? "",
      });
      const sql = `WITH guard AS (SELECT pg_advisory_xact_lock(hashtextextended($2::uuid::text||':'||$7||':recommendation.refill',0)),pg_advisory_xact_lock(hashtextextended($2::uuid::text||':'||$5::uuid::text||':'||$18,0))),
prior AS (SELECT i.request_hash "requestHash",i.response_body "responseBody" FROM guard CROSS JOIN LATERAL (SELECT * FROM backlink_idempotency_records WHERE workspace_id=$2 AND idempotency_key=$7 AND command_type='recommendation.refill') i),
available AS (SELECT 1 FROM guard WHERE $6::integer=0 AND NOT EXISTS (SELECT 1 FROM prior) AND NOT EXISTS (SELECT 1 FROM backlink_recommendation_refills WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3 AND recommendation_context_version_id=$5 AND refill_window_key=$18)),
job AS (INSERT INTO backlink_jobs (id,organization_id,workspace_id,website_project_id,job_type,source_object_type,source_object_id,workflow_id,correlation_id,created_by,updated_by) SELECT $10,$1,$2,$3,'recommendation_refill','recommendation_context',$5,$15,$14,$4,$4 FROM available RETURNING id),
refill AS (INSERT INTO backlink_recommendation_refills (id,organization_id,workspace_id,website_project_id,job_id,recommendation_context_version_id,trigger_reason,low_watermark,high_watermark,refill_window_key,created_by,updated_by) SELECT $11,$1,$2,$3,job.id,$5,$20,$16,$17,$18,$4,$4 FROM job RETURNING id),
lifecycle AS (INSERT INTO backlink_lifecycle_events (id,organization_id,workspace_id,website_project_id,job_id,aggregate_type,aggregate_id,sequence,aggregate_version,event_type,actor_type,actor_id,after_state,correlation_id,idempotency_key) SELECT $12,$1,$2,$3,$10,'recommendation_refill',refill.id,1,1,'recommendation_refill.requested','user',$4,jsonb_build_object('status','queued'),$14,'recommendation.refill:'||$7 FROM refill RETURNING id),
audit AS (INSERT INTO backlink_audit_events (id,organization_id,workspace_id,website_project_id,job_id,lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,outcome,after_redacted,request_id,correlation_id,integrity_hash) SELECT $13,$1,$2,$3,$10,lifecycle.id,$4,'user','recommendation_refill.requested','recommendation_refill',$11,'success',jsonb_build_object('status','queued'),$14,$14,$8 FROM lifecycle RETURNING id),
outbox AS (INSERT INTO backlink_outbox_events (id,organization_id,workspace_id,website_project_id,event_type,aggregate_id,aggregate_version,idempotency_key,payload,payload_schema_version,created_by,updated_by) SELECT $19,$1,$2,$3,'backlinks.recommendation-refill.requested.v1',$10,1,$15,jsonb_build_object('contractVersion','backlinks.recommendation-refill.requested.v1','organizationId',$1::text,'workspaceId',$2::text,'websiteProjectId',$3::text,'recommendationContextVersionId',$5::text,'jobId',$10::text,'workflowId',$15,'correlationId',$14,'actorId',$4,'refillWindowKey',$18,'lowWatermark',$16,'highWatermark',$17),1,$4,$4 FROM refill RETURNING id),
completed AS (INSERT INTO backlink_idempotency_records (id,organization_id,workspace_id,website_project_id,idempotency_key,command_type,request_hash,response_status,response_body,response_schema_version,completed_at,expires_at,created_by,updated_by) SELECT $9,$1,$2,$3,$7,'recommendation.refill',$8,202,jsonb_build_object('jobId',$10,'workflowId',$15,'status','queued','version',1,'lifecycleEventId',$12,'auditEventId',$13),1,now(),now()+interval '24 hours',$4,$4 FROM audit CROSS JOIN outbox RETURNING request_hash "requestHash",response_body "responseBody")
SELECT 'completed' state,* FROM completed UNION ALL SELECT 'replay',"requestHash","responseBody" FROM prior UNION ALL SELECT 'version_conflict',$8,NULL WHERE NOT EXISTS (SELECT 1 FROM completed) AND NOT EXISTS (SELECT 1 FROM prior)`;
      const values = [tenant.organizationId, tenant.workspaceId, project.websiteProjectId,
        actor.userId, input.recommendationContextVersionId,
        input.expectedVersion, input.idempotencyKey, requestHash,
        ...ids.slice(0, 5), input.requestId, workflowId, input.lowWatermark,
        input.highWatermark, input.refillWindowKey, ids[5], triggerReason];
      return result<RecommendationRefillResult>(
        (await client.query(sql, values)).rows[0] as ResultRow | undefined, requestHash);
    },
  };
}
