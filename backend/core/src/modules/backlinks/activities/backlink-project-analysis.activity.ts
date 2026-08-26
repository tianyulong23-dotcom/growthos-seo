import type { DataForSeoRequestService } from "../application/services/dataforseo-request.service.js";

export type BacklinkProjectAnalysisInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  jobId: string;
  workflowId: string;
  snapshotVersion: number;
}>;
type ProjectContextSnapshot = Readonly<{
  snapshotId: string;
  snapshotVersion: number;
  projectStatus: string;
  canonicalDomain: string;
  locale: string;
  countryCode: string;
  profileVersionId: string;
  promotionTargetVersionId: string;
}>;
export type BacklinkProjectAnalysisContext = BacklinkProjectAnalysisInput &
  ProjectContextSnapshot;
export type ProjectContextSnapshotReader = Readonly<{
  findLatest(
    scope: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
    }>,
  ): Promise<ProjectContextSnapshot | null>;
}>;
export type ProjectAnalysisJobQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;
export type ProjectAnalysisCompletion = Readonly<{
  completed: boolean;
  actorId: string | null;
}>;
export type ProjectAnalysisJobWriter = Readonly<{
  complete(
    input: BacklinkProjectAnalysisInput,
    context: BacklinkProjectAnalysisContext,
  ): Promise<ProjectAnalysisCompletion>;
  terminate(
    input: BacklinkProjectAnalysisInput,
    outcome: Readonly<{
      status: "failed" | "cancelled";
      step: string;
      resultSummary: Readonly<Record<string, unknown>>;
      error: Readonly<Record<string, unknown>> | null;
    }>,
  ): Promise<void>;
}>;
export type ProjectAnalysisRecommendationRefill = Readonly<{
  ensure(
    input: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
      projectContextVersionId: string;
      actorId: string;
    }>,
  ): Promise<void>;
}>;
export type BacklinkProjectAnalysisActivities = Readonly<{
  loadBacklinkProjectAnalysisContext(
    input: BacklinkProjectAnalysisInput,
  ): Promise<BacklinkProjectAnalysisContext>;
}>;
type ProviderAnalysisOptions = Readonly<{
  dataForSeo: Pick<DataForSeoRequestService, "execute">;
  cacheSchemaVersion: number;
  estimatedCostMicros: number;
  limit: number;
}>;

export function createProjectAnalysisJobWriter(
  client: ProjectAnalysisJobQueryClient,
): ProjectAnalysisJobWriter {
  return Object.freeze({
    async complete(input, context) {
      const scope = [
        input.jobId,
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
      ] as const;
      await client.query(
        `UPDATE backlink_jobs
            SET status='running',step='loading_project_context',progress=50,
                started_at=COALESCE(started_at,now()),version=version+1,
                updated_at=now(),updated_by=created_by
          WHERE (id,organization_id,workspace_id,website_project_id)=
                ($1,$2,$3,$4)
            AND job_type='project-analysis' AND status='queued'`,
        scope,
      );
      const completed = await client.query(
        `UPDATE backlink_jobs
            SET status='success',step='completed',progress=100,
                result_summary=$5::jsonb,error=NULL,finished_at=now(),
                version=version+1,updated_at=now(),updated_by=created_by
          WHERE (id,organization_id,workspace_id,website_project_id)=
                ($1,$2,$3,$4)
            AND job_type='project-analysis' AND status='running'
          RETURNING created_by AS "actorId"`,
        [
          ...scope,
          JSON.stringify({
            snapshotId: context.snapshotId,
            snapshotVersion: context.snapshotVersion,
            canonicalDomain: context.canonicalDomain,
          }),
        ],
      );
      const actorId = completed.rows[0]?.actorId;
      return Object.freeze({
        completed: completed.rows[0] !== undefined,
        actorId: typeof actorId === "string" ? actorId : null,
      });
    },
    async terminate(input, outcome) {
      await client.query(
        `UPDATE backlink_jobs
            SET status=$5,step=$6,progress=100,
                result_summary=$7::jsonb,error=$8::jsonb,finished_at=now(),
                version=version+1,updated_at=now(),updated_by=created_by
          WHERE (id,organization_id,workspace_id,website_project_id)=
                ($1,$2,$3,$4)
            AND job_type='project-analysis'
            AND status IN ('queued','running','waiting_provider')`,
        [
          input.jobId,
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          outcome.status,
          outcome.step,
          JSON.stringify(outcome.resultSummary),
          JSON.stringify(outcome.error),
        ],
      );
    },
  });
}

export function createBacklinkProjectAnalysisActivities(
  snapshots: ProjectContextSnapshotReader,
  providerAnalysis?: ProviderAnalysisOptions,
  jobs?: ProjectAnalysisJobWriter,
  recommendationRefill?: ProjectAnalysisRecommendationRefill,
): BacklinkProjectAnalysisActivities {
  return Object.freeze({
    async loadBacklinkProjectAnalysisContext(input) {
      const snapshot = await snapshots.findLatest(input);
      if (snapshot === null) {
        await jobs?.terminate(input, {
          status: "failed",
          step: "project_context_snapshot_invalid",
          resultSummary: {
            outcome: "input_invalid",
            requestedSnapshotVersion: input.snapshotVersion,
          },
          error: {
            code: "BACKLINK_PROJECT_CONTEXT_SNAPSHOT_NOT_FOUND",
            retryable: false,
          },
        });
        throw new Error("BACKLINK_PROJECT_CONTEXT_SNAPSHOT_NOT_FOUND");
      }
      if (snapshot.snapshotVersion !== input.snapshotVersion) {
        await jobs?.terminate(input, {
          status: "cancelled",
          step: "superseded_project_context",
          resultSummary: {
            outcome: "superseded",
            requestedSnapshotVersion: input.snapshotVersion,
            authoritativeSnapshotId: snapshot.snapshotId,
            authoritativeSnapshotVersion: snapshot.snapshotVersion,
          },
          error: null,
        });
        throw new Error("BACKLINK_PROJECT_CONTEXT_SNAPSHOT_VERSION_MISMATCH");
      }
      const context = Object.freeze({ ...input, ...snapshot });
      if (providerAnalysis !== undefined) {
        await providerAnalysis.dataForSeo.execute({
          context: {
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            websiteProjectId: input.websiteProjectId,
            requestId: input.jobId,
            idempotencyKey: input.workflowId,
            budgetReservationId: input.jobId,
          },
          request: {
            target: snapshot.canonicalDomain,
            targetType: "domain",
            limit: providerAnalysis.limit,
          },
          intent: "DISCOVERY",
          refreshMode: "BACKGROUND_REFRESH",
          execution: "BACKGROUND",
          locationCode: snapshot.countryCode,
          languageCode: snapshot.locale,
          responseSchemaVersion: "dataforseo.backlinks-referring-domains.v1",
          usagePurpose: "project-analysis-discovery",
          projectContextVersion: snapshot.snapshotVersion,
          cacheSchemaVersion: providerAnalysis.cacheSchemaVersion,
          estimatedCostMicros: providerAnalysis.estimatedCostMicros,
        });
      }
      const completion = await jobs?.complete(input, context);
      if (
        completion?.completed === true
        && completion.actorId !== null
      ) {
        await recommendationRefill?.ensure({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          projectContextVersionId: context.snapshotId,
          actorId: completion.actorId,
        });
      }
      return context;
    },
  });
}
