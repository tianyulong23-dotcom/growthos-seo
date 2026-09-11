import {
  queueHistoricalContactEnrichmentJobs,
  type ContactEnrichmentCommandClient,
  type ContactEnrichmentJobOptions,
  type HistoricalContactEnrichmentQueueSummary,
} from "../commands/contact-enrichment.command.js";

export type PrepareRecommendationPoolV2CanonicalBatchesInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  generationContractId: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  inputPinId: string;
  actorId: string;
  batchIds: readonly string[];
}>;

export type RecommendationPoolV2CanonicalContactSource = Readonly<{
  batchId: string;
  candidateId: string;
  recommendationId: string;
  prospectId: string;
  inventoryId: string;
  generationContractId: string;
  recommendationContextVersionId: string;
  inputPinId: string;
  visiblePoolGeneration: number;
}>;

type QueueContactEnrichmentJobs = typeof queueHistoricalContactEnrichmentJobs;

export type RecommendationPoolV2ContactPreparationDependencies = Readonly<{
  client: ContactEnrichmentCommandClient;
  options: ContactEnrichmentJobOptions;
  loadCanonicalContactSources(
    input: PrepareRecommendationPoolV2CanonicalBatchesInput,
  ): Promise<readonly RecommendationPoolV2CanonicalContactSource[]>;
  queueContactEnrichmentJobs?: QueueContactEnrichmentJobs;
}>;

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`Recommendation V2 ${label} is required`);
  }
}

function validateSource(
  input: PrepareRecommendationPoolV2CanonicalBatchesInput,
  source: RecommendationPoolV2CanonicalContactSource,
  requestedBatchIds: ReadonlySet<string>,
): void {
  [
    source.batchId,
    source.candidateId,
    source.recommendationId,
    source.prospectId,
    source.inventoryId,
    source.generationContractId,
    source.recommendationContextVersionId,
    source.inputPinId,
  ].forEach((value, index) => assertNonEmpty(value, `lineage ${index + 1}`));
  if (!requestedBatchIds.has(source.batchId)) {
    throw new TypeError(
      "Recommendation V2 contact source is outside the requested batches",
    );
  }
  if (
    source.generationContractId !== input.generationContractId ||
    source.recommendationContextVersionId !==
      input.recommendationContextVersionId ||
    source.inputPinId !== input.inputPinId ||
    source.visiblePoolGeneration !== input.visiblePoolGeneration
  ) {
    throw new TypeError(
      "Recommendation V2 contact source lineage does not match the generation",
    );
  }
}

export function createRecommendationPoolV2ContactPreparationService(
  dependencies: RecommendationPoolV2ContactPreparationDependencies,
) {
  const queueContactEnrichmentJobs =
    dependencies.queueContactEnrichmentJobs ??
    queueHistoricalContactEnrichmentJobs;

  return Object.freeze({
    async prepareCanonicalBatches(
      input: PrepareRecommendationPoolV2CanonicalBatchesInput,
    ): Promise<void> {
      const requestedBatchIds = new Set(input.batchIds);
      if (
        input.batchIds.length < 1 ||
        input.batchIds.length > 2 ||
        requestedBatchIds.size !== input.batchIds.length
      ) {
        throw new TypeError(
          "Recommendation V2 contact preparation requires one or two unique batches",
        );
      }

      const sources = await dependencies.loadCanonicalContactSources(input);
      const coveredBatchIds = new Set<string>();
      const recommendationIds = new Set<string>();
      for (const source of sources) {
        validateSource(input, source, requestedBatchIds);
        coveredBatchIds.add(source.batchId);
        if (recommendationIds.has(source.recommendationId)) {
          throw new TypeError(
            "Recommendation V2 canonical batches contain duplicate recommendations",
          );
        }
        recommendationIds.add(source.recommendationId);
      }
      if (
        coveredBatchIds.size !== requestedBatchIds.size ||
        [...requestedBatchIds].some((batchId) => !coveredBatchIds.has(batchId))
      ) {
        throw new TypeError(
          "Recommendation V2 contact preparation batch coverage is incomplete",
        );
      }

      const summary: HistoricalContactEnrichmentQueueSummary =
        await queueContactEnrichmentJobs(dependencies.client, {
          scope: {
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            websiteProjectId: input.websiteProjectId,
          },
          actorId: input.actorId,
          recommendationIds: Object.freeze([...recommendationIds]),
          options: dependencies.options,
          sourceSelection: "canonical_v2",
        });
      if (summary.staleContextsSkipped > 0) {
        throw new Error(
          "RECOMMENDATION_POOL_V2_CONTACT_PREPARATION_CONTEXT_SUPERSEDED",
        );
      }
    },
  });
}
