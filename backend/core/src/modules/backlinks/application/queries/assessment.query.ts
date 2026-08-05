import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

export const assessmentRunStatuses =
  ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
type AssessmentRunStatus = (typeof assessmentRunStatuses)[number];
type AssessmentAvailability = "available" | "partial" | "unavailable";
type JsonObject = Readonly<Record<string, unknown>>;
export type AssessmentView = Readonly<{
  run: Readonly<{ id: string; opportunityId: string; status: AssessmentRunStatus;
    attemptCount: number; sourceReleaseIds: readonly string[];
    startedAt: string | null; finishedAt: string | null; errorCode: string | null }>;
  result: Readonly<{ snapshotId: string; snapshotVersion: number; isCurrent: boolean;
    availability: AssessmentAvailability; stale: boolean;
    sourceReleaseIds: readonly string[]; generatedAt: string; payload: JsonObject }> | null;
}>;
export type AssessmentQuery = Readonly<{
  getAssessment(context: ResolvedProjectContext, opportunityId: string): Promise<AssessmentView>;
}>;
export type AssessmentQueryClient = Readonly<{ query(text: string,
  values?: readonly unknown[]): Promise<Readonly<{
    rows: readonly Record<string, unknown>[] }>> }>;
const iso = (value: unknown) => value === null || value === undefined
  ? null : (value instanceof Date ? value : new Date(String(value))).toISOString();
const strings = (value: unknown) => Array.isArray(value)
  ? value.map(String) : [];

export function createAssessmentQuery(client: AssessmentQueryClient): AssessmentQuery {
  return Object.freeze({
    async getAssessment(context, opportunityId) {
      const result = await client.query(`
        SELECT r.id "runId",r.opportunity_id "opportunityId",r.status,
          r.attempt_count "attemptCount",r.source_release_ids "sourceReleaseIds",
          r.started_at "startedAt",r.finished_at "finishedAt",r.error_code "errorCode",
          s.id "snapshotId",s.run_id "snapshotRunId",s.snapshot_version "snapshotVersion",
          s.availability "snapshotAvailability",s.stale "snapshotStale",
          s.source_release_ids "snapshotSourceReleaseIds",
          s.generated_at "snapshotGeneratedAt",s.result_payload "resultPayload"
        FROM backlink_assessment_runs r
        LEFT JOIN backlink_assessment_snapshots s ON
          (s.organization_id,s.workspace_id,s.website_project_id,s.id,s.opportunity_id)=
          (r.organization_id,r.workspace_id,r.website_project_id,
           r.last_successful_snapshot_id,r.opportunity_id)
        WHERE (r.organization_id,r.workspace_id,r.website_project_id,
               r.opportunity_id)=($1,$2,$3,$4)
        ORDER BY r.created_at DESC,r.id DESC LIMIT 1
      `, [context.tenant.organizationId, context.tenant.workspaceId,
        context.project.websiteProjectId, opportunityId]);
      const row = result.rows[0];
      if (row === undefined) throw new BacklinkError({
        code: backlinkErrorCodes.notFound,
        message: "Assessment was not found in this project.",
      });
      const snapshotId = row.snapshotId == null ? null : String(row.snapshotId);
      return {
        run: { id: String(row.runId), opportunityId: String(row.opportunityId),
          status: row.status as AssessmentRunStatus, attemptCount: Number(row.attemptCount),
          sourceReleaseIds: strings(row.sourceReleaseIds),
          startedAt: iso(row.startedAt), finishedAt: iso(row.finishedAt),
          errorCode: row.errorCode == null ? null : String(row.errorCode) },
        result: snapshotId === null ? null : {
          snapshotId, snapshotVersion: Number(row.snapshotVersion),
          isCurrent: row.status === "SUCCEEDED"
            && String(row.snapshotRunId) === String(row.runId),
          availability: row.snapshotAvailability as AssessmentAvailability,
          stale: Boolean(row.snapshotStale),
          sourceReleaseIds: strings(row.snapshotSourceReleaseIds),
          generatedAt: iso(row.snapshotGeneratedAt) ?? new Date(0).toISOString(),
          payload: row.resultPayload as JsonObject,
        },
      };
    },
  });
}
