import { describe, expect, it, vi } from "vitest";

import {
  createRecommendationPoolV2ContactPreparationService,
  type RecommendationPoolV2CanonicalContactSource,
} from "../../src/modules/backlinks/application/services/recommendation-pool-v2-contact-preparation.service.js";

const input = Object.freeze({
  organizationId: "organization",
  workspaceId: "workspace",
  websiteProjectId: "project",
  generationContractId: "generation",
  recommendationContextVersionId: "context",
  visiblePoolGeneration: 2,
  inputPinId: "input-pin",
  jobId: "job",
  workflowId: "workflow",
  actorId: "worker",
  batchIds: Object.freeze(["batch-1", "batch-2"]),
  preparationDeadlineAt: "2026-08-29T00:00:00.000Z",
});

function source(
  batchId: string,
  suffix: string,
): RecommendationPoolV2CanonicalContactSource {
  return Object.freeze({
    batchId,
    candidateId: `candidate-${suffix}`,
    recommendationId: `recommendation-${suffix}`,
    prospectId: `prospect-${suffix}`,
    inventoryId: `inventory-${suffix}`,
    generationContractId: input.generationContractId,
    recommendationContextVersionId: input.recommendationContextVersionId,
    inputPinId: input.inputPinId,
    visiblePoolGeneration: input.visiblePoolGeneration,
  });
}

describe("recommendation pool V2 contact preparation", () => {
  it("queues only canonical current and next batch recommendations through the existing command", async () => {
    const provider = vi.fn();
    const queueContactEnrichmentJobs = vi.fn(async () =>
      Object.freeze({
        eligibleRecommendationCount: 3,
        jobsCreated: 3,
        jobsRetried: 0,
        activeJobsPreserved: 0,
        staleContextsSkipped: 0,
        attemptLimitsSkipped: 0,
        outboxEventsCreated: 3,
      }),
    );
    const service = createRecommendationPoolV2ContactPreparationService({
      client: {
        query: vi.fn(async () => {
          throw new Error("The command client is owned by the injected queue");
        }),
      },
      options: {
        maxPages: 5,
        maxDepth: 2,
        maxAttempts: 3,
        browserAllowed: false,
      },
      loadCanonicalContactSources: vi.fn(async () =>
        Object.freeze([
          source("batch-1", "1"),
          source("batch-1", "2"),
          source("batch-2", "3"),
        ]),
      ),
      queueContactEnrichmentJobs,
    });

    await service.prepareCanonicalBatches(input);

    expect(queueContactEnrichmentJobs).toHaveBeenCalledWith(
      expect.any(Object),
      {
        scope: {
          organizationId: "organization",
          workspaceId: "workspace",
          websiteProjectId: "project",
        },
        actorId: "worker",
        recommendationIds: [
          "recommendation-1",
          "recommendation-2",
          "recommendation-3",
        ],
        options: {
          maxPages: 5,
          maxDepth: 2,
          maxAttempts: 3,
          browserAllowed: false,
        },
        sourceSelection: "canonical_v2",
      },
    );
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects incomplete canonical batch coverage before creating contact jobs", async () => {
    const queueContactEnrichmentJobs = vi.fn();
    const service = createRecommendationPoolV2ContactPreparationService({
      client: { query: vi.fn() },
      options: {
        maxPages: 5,
        maxDepth: 2,
        maxAttempts: 3,
        browserAllowed: false,
      },
      loadCanonicalContactSources: vi.fn(async () =>
        Object.freeze([source("batch-1", "1")]),
      ),
      queueContactEnrichmentJobs,
    });

    await expect(service.prepareCanonicalBatches(input)).rejects.toThrow(
      "batch coverage is incomplete",
    );
    expect(queueContactEnrichmentJobs).not.toHaveBeenCalled();
  });

  it("fails closed when the existing contact command detects a stale context", async () => {
    const service = createRecommendationPoolV2ContactPreparationService({
      client: { query: vi.fn() },
      options: {
        maxPages: 5,
        maxDepth: 2,
        maxAttempts: 3,
        browserAllowed: false,
      },
      loadCanonicalContactSources: vi.fn(async () =>
        Object.freeze([source("batch-1", "1"), source("batch-2", "2")]),
      ),
      queueContactEnrichmentJobs: vi.fn(async () =>
        Object.freeze({
          eligibleRecommendationCount: 2,
          jobsCreated: 0,
          jobsRetried: 0,
          activeJobsPreserved: 0,
          staleContextsSkipped: 1,
          attemptLimitsSkipped: 0,
          outboxEventsCreated: 0,
        }),
      ),
    });

    await expect(service.prepareCanonicalBatches(input)).rejects.toThrow(
      "RECOMMENDATION_POOL_V2_CONTACT_PREPARATION_CONTEXT_SUPERSEDED",
    );
  });
});
