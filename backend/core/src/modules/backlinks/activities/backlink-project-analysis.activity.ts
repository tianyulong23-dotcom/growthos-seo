import type { DataForSeoRequestService } from
  "../application/services/dataforseo-request.service.js";

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
export type BacklinkProjectAnalysisContext =
  BacklinkProjectAnalysisInput & ProjectContextSnapshot;
export type ProjectContextSnapshotReader = Readonly<{
  findLatest(scope: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
  }>): Promise<ProjectContextSnapshot | null>;
}>;
export type BacklinkProjectAnalysisActivities = Readonly<{
  loadBacklinkProjectAnalysisContext(
    input: BacklinkProjectAnalysisInput,
  ): Promise<BacklinkProjectAnalysisContext>;
}>;
type ProviderAnalysisOptions = Readonly<{
  dataForSeo: Pick<DataForSeoRequestService, "execute">;
  cacheSchemaVersion: number;
  estimatedCostMicros: number; limit: number;
}>;

export function createBacklinkProjectAnalysisActivities(
  snapshots: ProjectContextSnapshotReader,
  providerAnalysis?: ProviderAnalysisOptions,
): BacklinkProjectAnalysisActivities {
  return Object.freeze({
    async loadBacklinkProjectAnalysisContext(input) {
      const snapshot = await snapshots.findLatest(input);
      if (snapshot === null) {
        throw new Error("BACKLINK_PROJECT_CONTEXT_SNAPSHOT_NOT_FOUND");
      }
      if (snapshot.snapshotVersion !== input.snapshotVersion) {
        throw new Error("BACKLINK_PROJECT_CONTEXT_SNAPSHOT_VERSION_MISMATCH");
      }
      const context = Object.freeze({ ...input, ...snapshot });
      if (providerAnalysis !== undefined) {
        await providerAnalysis.dataForSeo.execute({
          context: {
            organizationId: input.organizationId, workspaceId: input.workspaceId,
            websiteProjectId: input.websiteProjectId, requestId: input.jobId,
            idempotencyKey: input.workflowId,
            budgetReservationId: input.jobId,
          },
          request: {
            target: snapshot.canonicalDomain, targetType: "domain",
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
      return context;
    },
  });
}
