import { backlinkJobStatuses } from "../schema/jobs.js";
export type JobStatus = (typeof backlinkJobStatuses)[number];
export type JobQueryClient = Readonly<{
  query(text: string, values?: readonly unknown[]): Promise<
    Readonly<{ rows: readonly Record<string, unknown>[] }>
  >;
}>;
type JobScope = Readonly<{ organizationId: string; workspaceId: string;
  websiteProjectId: string; actorId: string;
}>;
export type CreateJobInput = JobScope & Readonly<{
  jobId: string; jobType: string; sourceObjectType: string;
  sourceObjectId: string; workflowId: string; correlationId: string;
}>;
export type TransitionJobInput = JobScope & Readonly<{
  jobId: string; expectedVersion: number; from: JobStatus; to: JobStatus;
  step: string | null; progress: number;
  resultSummary: unknown | null; error: unknown | null;
}>;
const transitions: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["waiting_provider", "partial_success", "success", "failed", "cancelled"],
  waiting_provider: ["running", "partial_success", "success", "failed", "cancelled"],
  partial_success: [], success: [], failed: [], cancelled: [],
};

export function createJobRepository(client: JobQueryClient) {
  return {
    async create(input: CreateJobInput): Promise<boolean> {
      const result = await client.query(
        `INSERT INTO backlink_jobs (
           id, organization_id, workspace_id, website_project_id, job_type,
           source_object_type, source_object_id, workflow_id, correlation_id,
           created_by, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
         ON CONFLICT (workspace_id, workflow_id) DO NOTHING RETURNING id`,
        [input.jobId, input.organizationId, input.workspaceId,
          input.websiteProjectId, input.jobType, input.sourceObjectType,
          input.sourceObjectId, input.workflowId, input.correlationId,
          input.actorId],
      );
      return result.rows[0] !== undefined;
    },

    async transition(input: TransitionJobInput): Promise<boolean> {
      if (!transitions[input.from].includes(input.to)) return false;
      const result = await client.query(
        `UPDATE backlink_jobs SET
           status=$7, step=$8, progress=$9, result_summary=$10::jsonb,
           error=$11::jsonb, version=version+1, updated_at=now(), updated_by=$5,
           started_at=CASE WHEN $7='running' THEN COALESCE(started_at,now())
                           ELSE started_at END,
           finished_at=CASE WHEN $7 IN ('partial_success','success','failed','cancelled')
                            THEN now() ELSE NULL END
         WHERE id=$1 AND organization_id=$2 AND workspace_id=$3
           AND website_project_id=$4 AND version=$6 AND status=$12 RETURNING id`,
        [input.jobId, input.organizationId, input.workspaceId,
          input.websiteProjectId, input.actorId, input.expectedVersion,
          input.to, input.step, input.progress, JSON.stringify(input.resultSummary),
          JSON.stringify(input.error), input.from],
      );
      return result.rows[0] !== undefined;
    },
  };
}
