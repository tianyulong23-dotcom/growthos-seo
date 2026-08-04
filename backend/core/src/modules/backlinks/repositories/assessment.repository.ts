import { createHash } from "node:crypto";
import type { AssessmentPolicyResult } from "../domain/assessments/assessment-policy.js";
type Scope = Readonly<{ organizationId: string; workspaceId: string;
  websiteProjectId: string }>;
export type AssessmentQueryClient = Readonly<{
  query(text: string, values?: readonly unknown[]):
    Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;
export type AssessmentRunInput = Scope & Readonly<{
  runId: string; opportunityId: string; policyVersion: string;
  evidenceContractVersion: string; sourceReleaseIds: readonly string[];
  inputEvidenceRefs: readonly string[]; inputEvidenceHash: string;
  actorId: string; recordedAt: Date }>;
type Mutation = Scope & Readonly<{ runId: string; actorId: string;
  recordedAt: Date }>;
type StartedRun = Readonly<{
  runId: string; status: "RUNNING" | "SUCCEEDED" | "CANCELLED";
  started: boolean; lastSuccessfulSnapshotId: string | null;
  snapshotVersion: number | null }>;
export type AssessmentWorkflowRepository = Readonly<{
  begin(input: AssessmentRunInput): Promise<StartedRun>;
  complete(input: Mutation & Readonly<{
    snapshotId: string; result: AssessmentPolicyResult;
  }>): Promise<Readonly<{ snapshotId: string; snapshotVersion: number }>>;
  fail(input: Mutation & Readonly<{ errorCode: string }>): Promise<void> }>;
const scope = (input: Scope) =>
  [input.organizationId, input.workspaceId, input.websiteProjectId];
export function createAssessmentRepository(
  client: AssessmentQueryClient,
): AssessmentWorkflowRepository {
  return {
    async begin(input) {
      await client.query(`
        WITH prior AS (
          SELECT s.id FROM backlink_assessment_snapshots s JOIN
            backlink_assessment_runs r ON r.id=s.run_id
           WHERE (s.organization_id,s.workspace_id,s.website_project_id,
                  s.opportunity_id)=($1,$2,$3,$4) AND r.status='SUCCEEDED'
           ORDER BY s.snapshot_version DESC LIMIT 1)
        INSERT INTO backlink_assessment_runs (
          id,organization_id,workspace_id,website_project_id,opportunity_id,
          policy_version,evidence_contract_version,source_release_ids,
          input_evidence_refs,input_evidence_hash,status,
          last_successful_snapshot_id,schema_version,created_at,updated_at,
          created_by,updated_by
        ) VALUES ($5,$1,$2,$3,$4,$6,$7,$8::jsonb,$9::jsonb,$10,'QUEUED',
          (SELECT id FROM prior),1,$12,$12,$11,$11)
        ON CONFLICT (organization_id,workspace_id,website_project_id,
          opportunity_id,policy_version,input_evidence_hash) DO NOTHING
      `, [...scope(input), input.opportunityId, input.runId,
        input.policyVersion, input.evidenceContractVersion,
        JSON.stringify(input.sourceReleaseIds),
        JSON.stringify(input.inputEvidenceRefs), input.inputEvidenceHash,
        input.actorId, input.recordedAt]);
      const result = await client.query(`
        WITH started AS (UPDATE backlink_assessment_runs SET status='RUNNING',
            attempt_count=attempt_count+1,started_at=$8,finished_at=NULL,
            error_code=NULL,updated_at=$8,updated_by=$7
           WHERE (organization_id,workspace_id,website_project_id,
                  opportunity_id,policy_version,input_evidence_hash)
                  =($1,$2,$3,$4,$5,$6) AND status IN ('QUEUED','FAILED')
          RETURNING id)
        SELECT r.id AS "runId",r.status,(x.id IS NOT NULL) AS started,
          r.last_successful_snapshot_id AS "lastSuccessfulSnapshotId",
          s.snapshot_version AS "snapshotVersion"
        FROM backlink_assessment_runs r LEFT JOIN started x ON x.id=r.id
        LEFT JOIN backlink_assessment_snapshots s
          ON s.id=r.last_successful_snapshot_id
        WHERE (r.organization_id,r.workspace_id,r.website_project_id,
               r.opportunity_id,r.policy_version,r.input_evidence_hash)
              =($1,$2,$3,$4,$5,$6)
      `, [...scope(input), input.opportunityId, input.policyVersion,
        input.inputEvidenceHash, input.actorId, input.recordedAt]);
      const run = result.rows[0] as StartedRun | undefined;
      if (run === undefined) throw new Error("Assessment run was not found");
      return run;
    },
    async complete(input) {
      const payload = JSON.stringify(input.result);
      const resultHash = createHash("sha256").update(payload).digest("hex");
      const result = await client.query(`
        WITH target AS (
          SELECT r.* FROM backlink_assessment_runs r
           WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.id)
                 =($1,$2,$3,$4) AND r.status='RUNNING' FOR UPDATE
        ), locked AS (SELECT o.id FROM backlink_opportunities o JOIN target t ON
            (o.organization_id,o.workspace_id,o.website_project_id,o.id)=
            (t.organization_id,t.workspace_id,t.website_project_id,
             t.opportunity_id) FOR UPDATE OF o
        ), version AS (SELECT COALESCE(max(s.snapshot_version),0)+1 value
          FROM target t JOIN locked l ON true
          LEFT JOIN backlink_assessment_snapshots s ON
            (s.organization_id,s.workspace_id,s.website_project_id,
             s.opportunity_id)=(t.organization_id,t.workspace_id,
             t.website_project_id,t.opportunity_id)
        ), inserted AS (INSERT INTO backlink_assessment_snapshots (
            id,organization_id,workspace_id,website_project_id,run_id,
            opportunity_id,policy_version,input_evidence_hash,snapshot_version,
            source_release_ids,availability,confidence,evidence_refs,
            unavailable_reason,stale,result_payload,result_hash,generated_at,
            schema_version,created_by
          ) SELECT $5,t.organization_id,t.workspace_id,t.website_project_id,t.id,
            t.opportunity_id,t.policy_version,t.input_evidence_hash,v.value,
            t.source_release_ids,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14,$7,1,$6
          FROM target t JOIN version v ON true RETURNING id,snapshot_version
        ), updated AS (UPDATE backlink_assessment_runs r SET status='SUCCEEDED',
            finished_at=$7,last_successful_snapshot_id=i.id,
            updated_at=$7,updated_by=$6 FROM inserted i
          WHERE r.id=$4 RETURNING r.id
        )
        SELECT i.id "snapshotId",i.snapshot_version "snapshotVersion"
        FROM inserted i JOIN updated u ON true
      `, [...scope(input), input.runId, input.snapshotId, input.actorId,
        input.recordedAt, input.result.availability, input.result.confidence,
        JSON.stringify(input.result.evidenceRefs),
        input.result.availability === "unavailable"
          ? "all_dimensions_unavailable" : null,
        input.result.freshness === "stale", payload, resultHash]);
      const snapshot = result.rows[0] as
        | { snapshotId: string; snapshotVersion: number } | undefined;
      if (snapshot === undefined) throw new Error("Assessment run was not running");
      return snapshot;
    },
    async fail(input) {
      await client.query(`
        UPDATE backlink_assessment_runs SET status='FAILED',finished_at=$6,
          error_code=$7,updated_at=$6,updated_by=$5
        WHERE (organization_id,workspace_id,website_project_id,id)
              =($1,$2,$3,$4) AND status='RUNNING'
      `, [...scope(input), input.runId, input.actorId, input.recordedAt,
        input.errorCode]);
    },
  };
}
