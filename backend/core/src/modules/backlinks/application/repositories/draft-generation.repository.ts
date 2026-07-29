import { createHash, randomUUID } from "node:crypto";

import type { AiDraftResult } from "../../ports/ai-draft.port.js";

type Scope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

export type DraftGenerationQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export type DraftGenerationJobStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "REFUSED";

export type DraftGenerationJob = Readonly<{
  runId: string;
  draftId: string;
  status: DraftGenerationJobStatus;
  started: boolean;
  opportunityId: string;
  evidenceSnapshotId: string;
  promptVersion: string;
  outputSchemaVersion: string;
  baseDraftVersion: number;
  versionId: string | null;
  lastSuccessfulVersionId: string | null;
}>;

export type DraftSnapshot = Readonly<{
  draftId: string;
  opportunityId: string;
  status: "generating" | "draft" | "approved" | "rejected" | "sent";
  draftVersion: number;
  approvedVersionId: string | null;
  currentVersion: Readonly<{
    id: string;
    versionNo: number;
    subjectText: string;
    bodyText: string;
    bodyDocument: unknown | null;
    source: "MODEL" | "MANUAL" | "RESTORED";
    createdAt: string;
  }> | null;
}>;

export type CreateDraftGenerationJobInput = Scope & Readonly<{
  opportunityId: string;
  evidenceSnapshotId: string;
  draftId: string;
  runId: string;
  logicalDraftKey: string;
  idempotencyKey: string;
  requestHash: string;
  promptVersion: string;
  outputSchemaVersion: string;
  actorId: string;
  recordedAt: Date;
}>;

type JobMutation = Scope & Readonly<{
  runId: string;
  actorId: string;
  recordedAt: Date;
}>;

export type DraftGenerationRepository = Readonly<{
  createJob(
    input: CreateDraftGenerationJobInput,
  ): Promise<DraftGenerationJob>;
  claimJob(input: JobMutation): Promise<DraftGenerationJob>;
  completeJob(input: JobMutation & Readonly<{
    versionId: string;
    result: AiDraftResult;
  }>): Promise<Readonly<{
    versionId: string;
    draftVersion: number;
    adoptedAsCurrent: boolean;
  }>>;
  failJob(input: JobMutation & Readonly<{
    errorClass: string;
    errorCode: string;
    refused: boolean;
  }>): Promise<void>;
  getJob(input: Scope & Readonly<{ runId: string }>): Promise<DraftGenerationJob>;
  getDraft(input: Scope & Readonly<{ draftId: string }>): Promise<DraftSnapshot>;
}>;

type DraftEditingMutation = Scope & Readonly<{
  draftId: string;
  expectedVersion: number;
  actorId: string;
  recordedAt: Date;
}>;

type DraftEditingCompleted = Readonly<{
  state: "completed";
  draftId: string;
  versionId: string;
  draftVersion: number;
  status: "draft" | "approved";
}>;

type DraftEditingFailure =
  | Readonly<{ state: "not_found" }>
  | Readonly<{ state: "version_conflict"; currentVersion: number }>;

export type DraftEditingRepository = Readonly<{
  saveManualVersion(
    input: DraftEditingMutation & Readonly<{
      versionId: string;
      subjectText: string;
      bodyText: string;
      bodyDocument: unknown;
    }>,
  ): Promise<DraftEditingCompleted | DraftEditingFailure>;
  approve(
    input: DraftEditingMutation,
  ): Promise<DraftEditingCompleted | DraftEditingFailure>;
}>;

export const draftApprovalFactContractVersion =
  "draft-approval-fact.v1" as const;

type DraftEditingRepositoryDependencies = Readonly<{
  newId?: () => string;
}>;

const scopeValues = (input: Scope) =>
  [input.organizationId, input.workspaceId, input.websiteProjectId] as const;

const asJob = (
  row: Record<string, unknown> | undefined,
  message: string,
): DraftGenerationJob => {
  if (row === undefined) throw new Error(message);
  return row as DraftGenerationJob;
};

const asDraft = (
  row: Record<string, unknown> | undefined,
): DraftSnapshot => {
  if (row === undefined) throw new Error("Draft was not found.");
  const currentVersionId = row.currentVersionId;
  return {
    draftId: String(row.draftId),
    opportunityId: String(row.opportunityId),
    status: row.status as DraftSnapshot["status"],
    draftVersion: Number(row.draftVersion),
    approvedVersionId: row.approvedVersionId === null
      ? null
      : String(row.approvedVersionId),
    currentVersion: currentVersionId === null
      ? null
      : {
          id: String(currentVersionId),
          versionNo: Number(row.currentVersionNo),
          subjectText: String(row.subjectText),
          bodyText: String(row.bodyText),
          bodyDocument: row.bodyDocument ?? null,
          source: row.source as "MODEL" | "MANUAL" | "RESTORED",
          createdAt: row.currentVersionCreatedAt instanceof Date
            ? row.currentVersionCreatedAt.toISOString()
            : String(row.currentVersionCreatedAt),
        },
  };
};

export function createDraftGenerationRepository(
  client: DraftGenerationQueryClient,
): DraftGenerationRepository {
  const getJob = async (
    input: Scope & Readonly<{ runId: string }>,
  ): Promise<DraftGenerationJob> => {
    const result = await client.query(`
      SELECT r.id AS "runId", r.draft_id AS "draftId", r.status, false started,
        r.opportunity_id AS "opportunityId",
        r.evidence_snapshot_id AS "evidenceSnapshotId",
        r.prompt_version AS "promptVersion",
        r.output_schema_version AS "outputSchemaVersion",
        r.base_draft_version AS "baseDraftVersion",
        v.id AS "versionId",
        d.last_successful_version_id AS "lastSuccessfulVersionId"
      FROM backlink_model_runs r
      JOIN backlink_email_drafts d ON
        (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
        (r.organization_id,r.workspace_id,r.website_project_id,r.draft_id)
      LEFT JOIN backlink_draft_versions v ON
        (v.organization_id,v.workspace_id,v.website_project_id,v.model_run_id)=
        (r.organization_id,r.workspace_id,r.website_project_id,r.id)
      WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
        ($1,$2,$3,$4)
    `, [...scopeValues(input), input.runId]);
    return asJob(result.rows[0], "Draft generation Job was not found.");
  };

  return {
    async createJob(input) {
      await client.query(`
        WITH inserted_draft AS (
          INSERT INTO backlink_email_drafts (
            id,organization_id,workspace_id,website_project_id,opportunity_id,
            logical_draft_key,status,created_at,updated_at,created_by,updated_by
          ) VALUES ($5,$1,$2,$3,$4,$6,'generating',$13,$13,$12,$12)
          ON CONFLICT (workspace_id,logical_draft_key) DO NOTHING
          RETURNING *
        ), target_draft AS (
          SELECT * FROM inserted_draft
          UNION ALL
          SELECT d.* FROM backlink_email_drafts d
          WHERE (d.organization_id,d.workspace_id,d.website_project_id,
                 d.opportunity_id,d.logical_draft_key)=($1,$2,$3,$4,$6)
            AND NOT EXISTS (SELECT 1 FROM inserted_draft)
        ), inserted_run AS (
          INSERT INTO backlink_model_runs (
            id,organization_id,workspace_id,website_project_id,draft_id,
            opportunity_id,evidence_snapshot_id,idempotency_key,request_hash,
            status,prompt_version,output_schema_version,base_draft_version,
            quality_result,created_at,updated_at,created_by,updated_by
          )
          SELECT $7,$1,$2,$3,d.id,$4,$8,$9,$10,'QUEUED',$11,$14,d.version,
            '{}'::jsonb,$13,$13,$12,$12
          FROM target_draft d
          ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
          RETURNING id
        )
        SELECT id FROM inserted_run
      `, [
        ...scopeValues(input),
        input.opportunityId,
        input.draftId,
        input.logicalDraftKey,
        input.runId,
        input.evidenceSnapshotId,
        input.idempotencyKey,
        input.requestHash,
        input.promptVersion,
        input.actorId,
        input.recordedAt,
        input.outputSchemaVersion,
      ]);
      const result = await client.query(`
        SELECT r.id AS "runId",r.draft_id AS "draftId",r.status,false started,
          r.opportunity_id AS "opportunityId",
          r.evidence_snapshot_id AS "evidenceSnapshotId",
          r.prompt_version AS "promptVersion",
          r.output_schema_version AS "outputSchemaVersion",
          r.base_draft_version AS "baseDraftVersion",
          v.id AS "versionId",
          d.last_successful_version_id AS "lastSuccessfulVersionId",
          r.request_hash AS "requestHash"
        FROM backlink_model_runs r
        JOIN backlink_email_drafts d ON
          (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
          (r.organization_id,r.workspace_id,r.website_project_id,r.draft_id)
        LEFT JOIN backlink_draft_versions v ON
          (v.organization_id,v.workspace_id,v.website_project_id,
           v.model_run_id)=
          (r.organization_id,r.workspace_id,r.website_project_id,r.id)
        WHERE (r.organization_id,r.workspace_id,r.website_project_id,
               r.idempotency_key)=($1,$2,$3,$4)
      `, [
        ...scopeValues(input),
        input.idempotencyKey,
      ]);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("Draft generation Job is outside the requested scope.");
      }
      if (row.requestHash !== input.requestHash) {
        throw new Error("Idempotency key payload mismatch.");
      }
      return row as DraftGenerationJob;
    },

    async claimJob(input) {
      const result = await client.query(`
        WITH started AS (
          UPDATE backlink_model_runs
          SET status='RUNNING',attempt_count=attempt_count+1,
            started_at=$6,finished_at=NULL,error_class=NULL,error_code=NULL,
            updated_at=$6,updated_by=$5
          WHERE (organization_id,workspace_id,website_project_id,id)=
            ($1,$2,$3,$4) AND status='QUEUED'
          RETURNING id
        )
        SELECT r.id AS "runId",r.draft_id AS "draftId",r.status,
          (s.id IS NOT NULL) started,
          r.opportunity_id AS "opportunityId",
          r.evidence_snapshot_id AS "evidenceSnapshotId",
          r.prompt_version AS "promptVersion",
          r.output_schema_version AS "outputSchemaVersion",
          r.base_draft_version AS "baseDraftVersion",
          v.id AS "versionId",
          d.last_successful_version_id AS "lastSuccessfulVersionId"
        FROM backlink_model_runs r
        JOIN backlink_email_drafts d ON
          (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
          (r.organization_id,r.workspace_id,r.website_project_id,r.draft_id)
        LEFT JOIN started s ON s.id=r.id
        LEFT JOIN backlink_draft_versions v ON
          (v.organization_id,v.workspace_id,v.website_project_id,
           v.model_run_id)=
          (r.organization_id,r.workspace_id,r.website_project_id,r.id)
        WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
          ($1,$2,$3,$4)
      `, [
        ...scopeValues(input),
        input.runId,
        input.actorId,
        input.recordedAt,
      ]);
      return asJob(result.rows[0], "Draft generation Job was not found.");
    },

    async completeJob(input) {
      const evidenceIds = [...new Set(
        input.result.output.personalizationClaims.flatMap(
          (claim) => claim.evidenceIds,
        ),
      )].sort();
      const result = await client.query(`
        WITH target AS (
          SELECT r.*,d.version AS current_draft_version,
            d.current_version_id
          FROM backlink_model_runs r
          JOIN backlink_email_drafts d ON
            (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
            (r.organization_id,r.workspace_id,r.website_project_id,r.draft_id)
          WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
            ($1,$2,$3,$4) AND r.status='RUNNING'
          FOR UPDATE OF r,d
        ), next_version AS (
          SELECT COALESCE(max(v.version_no),0)+1 AS value
          FROM target t
          LEFT JOIN backlink_draft_versions v ON
            (v.organization_id,v.workspace_id,v.website_project_id,v.draft_id)=
            (t.organization_id,t.workspace_id,t.website_project_id,t.draft_id)
        ), inserted AS (
          INSERT INTO backlink_draft_versions (
            id,organization_id,workspace_id,website_project_id,draft_id,
            opportunity_id,version_no,parent_version_id,source,model_run_id,
            evidence_snapshot_id,subject_text,body_text,structured_output,
            evidence_ids,prompt_version,output_schema_version,model_id,
            model_version,requires_user_confirmation,can_auto_send,
            created_at,created_by
          )
          SELECT $5,t.organization_id,t.workspace_id,t.website_project_id,
            t.draft_id,t.opportunity_id,n.value,t.current_version_id,'MODEL',
            t.id,t.evidence_snapshot_id,$6,$7,$8::jsonb,$9::jsonb,
            t.prompt_version,t.output_schema_version,$10,$11,true,false,$17,$16
          FROM target t JOIN next_version n ON true
          RETURNING id,draft_id,version_no
        ), updated_run AS (
          UPDATE backlink_model_runs r
          SET status='SUCCEEDED',provider_ref=$12,model_id=$10,
            model_version=$11,input_tokens=$13,output_tokens=$14,
            latency_ms=$15,repair_count=$18,quality_result='{"passed":true}',
            finished_at=$17,updated_at=$17,updated_by=$16
          FROM inserted i
          WHERE r.id=$4
          RETURNING r.id
        ), updated_draft AS (
          UPDATE backlink_email_drafts d
          SET current_version_id=CASE
                WHEN d.version=t.base_draft_version THEN i.id
                ELSE d.current_version_id
              END,
            last_successful_version_id=i.id,
            status=CASE
                WHEN d.version=t.base_draft_version THEN 'draft'
                ELSE d.status
              END,
            version=d.version+1,updated_at=$17,updated_by=$16
          FROM target t,inserted i,updated_run r
          WHERE d.id=t.draft_id
          RETURNING d.version,
            d.current_version_id=i.id AS adopted
        )
        SELECT i.id AS "versionId",d.version AS "draftVersion",
          d.adopted AS "adoptedAsCurrent"
        FROM inserted i JOIN updated_draft d ON true
      `, [
        ...scopeValues(input),
        input.runId,
        input.versionId,
        input.result.output.subject,
        input.result.output.bodyText,
        JSON.stringify(input.result.output),
        JSON.stringify(evidenceIds),
        input.result.model.modelId,
        input.result.model.modelVersion,
        input.result.model.providerRef,
        input.result.usage.inputTokens,
        input.result.usage.outputTokens,
        input.result.latencyMs,
        input.actorId,
        input.recordedAt,
        input.result.repairCount,
      ]);
      const row = result.rows[0] as
        | {
            versionId: string;
            draftVersion: number;
            adoptedAsCurrent: boolean;
          }
        | undefined;
      if (row === undefined) {
        throw new Error("Draft generation Job was not running.");
      }
      return row;
    },

    async failJob(input) {
      await client.query(`
        UPDATE backlink_model_runs
        SET status=$7,error_class=$8,error_code=$9,finished_at=$6,
          updated_at=$6,updated_by=$5
        WHERE (organization_id,workspace_id,website_project_id,id)=
          ($1,$2,$3,$4) AND status='RUNNING'
      `, [
        ...scopeValues(input),
        input.runId,
        input.actorId,
        input.recordedAt,
        input.refused ? "REFUSED" : "FAILED",
        input.errorClass,
        input.errorCode,
      ]);
    },

    getJob,
    async getDraft(input) {
      const result = await client.query(`
        SELECT d.id AS "draftId",d.opportunity_id AS "opportunityId",
          d.status,d.version AS "draftVersion",
          d.approved_version_id AS "approvedVersionId",
          v.id AS "currentVersionId",v.version_no AS "currentVersionNo",
          v.subject_text AS "subjectText",v.body_text AS "bodyText",
          v.body_document AS "bodyDocument",v.source,
          v.created_at AS "currentVersionCreatedAt"
        FROM backlink_email_drafts d
        LEFT JOIN backlink_draft_versions v ON
          (v.organization_id,v.workspace_id,v.website_project_id,
           v.id,v.draft_id,v.opportunity_id)=
          (d.organization_id,d.workspace_id,d.website_project_id,
           d.current_version_id,d.id,d.opportunity_id)
        WHERE (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
          ($1,$2,$3,$4)
      `, [...scopeValues(input), input.draftId]);
      return asDraft(result.rows[0]);
    },
  };
}

export function createDraftEditingRepository(
  client: DraftGenerationQueryClient,
  dependencies: DraftEditingRepositoryDependencies = {},
): DraftEditingRepository {
  const newId = dependencies.newId ?? randomUUID;
  const failure = async (
    input: DraftEditingMutation,
  ): Promise<DraftEditingFailure> => {
    const result = await client.query(`
      SELECT version
      FROM backlink_email_drafts
      WHERE (organization_id,workspace_id,website_project_id,id)=
        ($1,$2,$3,$4)
    `, [...scopeValues(input), input.draftId]);
    const row = result.rows[0];
    return row === undefined
      ? { state: "not_found" }
      : {
          state: "version_conflict",
          currentVersion: Number(row.version),
        };
  };

  return {
    async saveManualVersion(input) {
      const result = await client.query(`
        WITH target AS (
          SELECT d.*,v.evidence_snapshot_id,v.structured_output,
            v.evidence_ids,v.output_schema_version
          FROM backlink_email_drafts d
          JOIN backlink_draft_versions v ON
            (v.organization_id,v.workspace_id,v.website_project_id,
             v.id,v.draft_id,v.opportunity_id)=
            (d.organization_id,d.workspace_id,d.website_project_id,
             d.current_version_id,d.id,d.opportunity_id)
          WHERE (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
            ($1,$2,$3,$4) AND d.version=$5 AND d.status<>'sent'
          FOR UPDATE OF d
        ), next_version AS (
          SELECT COALESCE(max(v.version_no),0)+1 AS value
          FROM target t
          LEFT JOIN backlink_draft_versions v ON
            (v.organization_id,v.workspace_id,v.website_project_id,v.draft_id)=
            (t.organization_id,t.workspace_id,t.website_project_id,t.id)
        ), inserted AS (
          INSERT INTO backlink_draft_versions (
            id,organization_id,workspace_id,website_project_id,draft_id,
            opportunity_id,version_no,parent_version_id,source,
            evidence_snapshot_id,subject_text,body_text,body_document,
            structured_output,
            evidence_ids,prompt_version,output_schema_version,
            requires_user_confirmation,can_auto_send,created_at,created_by
          )
          SELECT $6,t.organization_id,t.workspace_id,t.website_project_id,t.id,
            t.opportunity_id,n.value,t.current_version_id,'MANUAL',
            t.evidence_snapshot_id,$7,$8,$11::jsonb,
            jsonb_set(
              jsonb_set(t.structured_output,'{subject}',to_jsonb($7::text),true),
              '{bodyText}',to_jsonb($8::text),true
            ),
            t.evidence_ids,'manual-edit.v1',t.output_schema_version,
            true,false,$10,$9
          FROM target t JOIN next_version n ON true
          RETURNING id,draft_id
        ), updated AS (
          UPDATE backlink_email_drafts d
          SET current_version_id=i.id,approved_version_id=NULL,status='draft',
            version=d.version+1,updated_at=$10,updated_by=$9
          FROM inserted i
          WHERE d.id=i.draft_id
          RETURNING d.id,d.current_version_id,d.version,d.status
        )
        SELECT id AS "draftId",current_version_id AS "versionId",
          version AS "draftVersion",status
        FROM updated
      `, [
        ...scopeValues(input),
        input.draftId,
        input.expectedVersion,
        input.versionId,
        input.subjectText,
        input.bodyText,
        input.actorId,
        input.recordedAt,
        JSON.stringify(input.bodyDocument),
      ]);
      const row = result.rows[0] as Omit<
        DraftEditingCompleted,
        "state"
      > | undefined;
      return row === undefined
        ? failure(input)
        : { state: "completed", ...row };
    },

    async approve(input) {
      const lifecycleEventId = newId();
      const auditEventId = newId();
      const integrityHash = createHash("sha256").update(JSON.stringify({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        draftId: input.draftId,
        expectedVersion: input.expectedVersion,
        actorId: input.actorId,
        recordedAt: input.recordedAt.toISOString(),
        contractVersion: draftApprovalFactContractVersion,
      })).digest("hex");
      const result = await client.query(`
        WITH target AS (
          SELECT d.id,d.status AS previous_status,
            d.version AS previous_aggregate_version,d.current_version_id
          FROM backlink_email_drafts d
          WHERE (d.organization_id,d.workspace_id,d.website_project_id,d.id)=
            ($1,$2,$3,$4)
            AND d.version=$5
            AND d.current_version_id IS NOT NULL
            AND NOT (
              d.status='approved'
              AND d.approved_version_id=d.current_version_id
            )
          FOR UPDATE OF d
        ), changed AS (
          UPDATE backlink_email_drafts d
          SET approved_version_id=t.current_version_id,status='approved',
            version=d.version+1,updated_at=$7,updated_by=$6
          FROM target t
          WHERE d.id=t.id
          RETURNING d.id,d.current_version_id,d.version,d.status,
            t.previous_status,t.previous_aggregate_version
        ), lifecycle AS (
          INSERT INTO backlink_lifecycle_events (
            id,organization_id,workspace_id,website_project_id,
            aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
            actor_type,actor_id,before_state,after_state,reason,correlation_id,
            idempotency_key,event_schema_version
          )
          SELECT $8,$1,$2,$3,'email_draft',c.id,c.version,c.version,
            'draft.approval.recorded','user',$6,
            jsonb_build_object(
              'status',c.previous_status,
              'aggregateVersion',c.previous_aggregate_version
            ),
            jsonb_build_object(
              'draftId',c.id,
              'approvedVersionId',c.current_version_id,
              'previousStatus',c.previous_status,
              'nextStatus',c.status,
              'previousAggregateVersion',c.previous_aggregate_version,
              'nextAggregateVersion',c.version,
              'actorId',$6,
              'occurredAt',$7::timestamptz,
              'contractVersion',$10::text
            ),
            'approved_current_version',
            'draft.approval:'||c.id::text||':'||
              c.previous_aggregate_version::text,
            'draft.approval:'||c.id::text||':'||
              c.previous_aggregate_version::text,
            1
          FROM changed c
          RETURNING id
        ), audit AS (
          INSERT INTO backlink_audit_events (
            id,organization_id,workspace_id,website_project_id,
            lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,
            outcome,reason,before_redacted,after_redacted,request_id,
            correlation_id,integrity_hash,event_schema_version
          )
          SELECT $9,$1,$2,$3,lifecycle.id,$6,'user','draft.approved',
            'email_draft',c.id,'success','approved_current_version',
            jsonb_build_object(
              'status',c.previous_status,
              'aggregateVersion',c.previous_aggregate_version
            ),
            jsonb_build_object(
              'status',c.status,
              'approvedVersionId',c.current_version_id,
              'aggregateVersion',c.version,
              'contractVersion',$10::text
            ),
            'draft.approval:'||c.id::text||':'||
              c.previous_aggregate_version::text,
            'draft.approval:'||c.id::text||':'||
              c.previous_aggregate_version::text,
            $11,1
          FROM lifecycle CROSS JOIN changed c
          RETURNING id
        )
        SELECT c.id AS "draftId",c.current_version_id AS "versionId",
          c.version AS "draftVersion",c.status
        FROM changed c CROSS JOIN lifecycle CROSS JOIN audit
      `, [
        ...scopeValues(input),
        input.draftId,
        input.expectedVersion,
        input.actorId,
        input.recordedAt,
        lifecycleEventId,
        auditEventId,
        draftApprovalFactContractVersion,
        integrityHash,
      ]);
      const row = result.rows[0] as Omit<
        DraftEditingCompleted,
        "state"
      > | undefined;
      return row === undefined
        ? failure(input)
        : { state: "completed", ...row };
    },
  };
}
