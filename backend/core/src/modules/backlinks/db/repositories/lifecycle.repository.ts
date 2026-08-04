export type LifecycleQueryClient = Readonly<{
  query(text: string, values?: readonly unknown[]): Promise<
    Readonly<{ rows: readonly Record<string, unknown>[] }>
  >;
}>;
type LifecycleScope = Readonly<{
  organizationId: string; workspaceId: string;
  websiteProjectId: string; actorId: string;
}>;
export type AppendLifecycleInput = LifecycleScope & Readonly<{
  lifecycleEventId: string; auditEventId: string; jobId: string | null;
  aggregateType: string; aggregateId: string; sequence: number;
  aggregateVersion: number; eventType: string; actorType: string;
  beforeState: unknown | null; afterState: unknown | null; reason: string | null;
  correlationId: string; causationId: string | null; idempotencyKey: string;
  requestId: string; outcome: string; previousIntegrityHash: string | null;
  integrityHash: string; eventSchemaVersion: number;
}>;
export type AppendLifecycleResult = Readonly<{
  lifecycleEventId: string; auditEventId: string;
}>;
export function createLifecycleRepository(client: LifecycleQueryClient) {
  return {
    async append(input: AppendLifecycleInput): Promise<AppendLifecycleResult> {
      const result = await client.query(
        `WITH lifecycle AS (
           INSERT INTO backlink_lifecycle_events (
             id,organization_id,workspace_id,website_project_id,job_id,
             aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
             actor_type,actor_id,before_state,after_state,reason,correlation_id,
             causation_id,idempotency_key,event_schema_version
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,
             $15,$16,$17,$18,$19
           ) RETURNING id
         ), audit AS (
           INSERT INTO backlink_audit_events (
             id,organization_id,workspace_id,website_project_id,job_id,
             lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,
             outcome,reason,before_redacted,after_redacted,request_id,
             correlation_id,previous_integrity_hash,integrity_hash,event_schema_version
           ) SELECT
             $20,$2,$3,$4,$5,lifecycle.id,$12,$11,$10,$6,$7,$21,$15,
             $13::jsonb,$14::jsonb,$22,$16,$23,$24,$19
           FROM lifecycle RETURNING id
         )
         SELECT lifecycle.id AS "lifecycleEventId", audit.id AS "auditEventId"
           FROM lifecycle CROSS JOIN audit`,
        [input.lifecycleEventId, input.organizationId, input.workspaceId,
          input.websiteProjectId, input.jobId, input.aggregateType,
          input.aggregateId, input.sequence, input.aggregateVersion,
          input.eventType, input.actorType, input.actorId,
          JSON.stringify(input.beforeState), JSON.stringify(input.afterState),
          input.reason, input.correlationId, input.causationId,
          input.idempotencyKey, input.eventSchemaVersion, input.auditEventId,
          input.outcome, input.requestId, input.previousIntegrityHash,
          input.integrityHash],
      );
      return result.rows[0] as AppendLifecycleResult;
    },
  };
}
