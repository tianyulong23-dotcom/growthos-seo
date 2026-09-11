import { describe, expect, it, vi } from "vitest";

import {
  createRecommendationPoolV2GenerationService,
  type RecommendationPoolV2DiscoveryRoundExecutor,
} from "../../src/modules/backlinks/application/services/recommendation-pool-v2-generation.service.js";

const baseInput = Object.freeze({
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  generationContractId: "generation-1",
  recommendationContextVersionId: "context-1",
  visiblePoolGeneration: 2,
  inputPinId: "pin-1",
  jobId: "job-1",
  workflowId: "workflow-1",
  actorId: "actor-1",
  round: 1 as const,
  requestFingerprint: "fingerprint-round-1",
  idempotencyKey: "generation-1:round:1",
  maxCostMicros: 1_000_000,
});

function executorResult(
  overrides: Partial<Awaited<
    ReturnType<RecommendationPoolV2DiscoveryRoundExecutor["execute"]>
  >> = {},
) {
  return Object.freeze({
    round: 1 as const,
    requestFingerprint: baseInput.requestFingerprint,
    chargeState: "settled" as const,
    costMicros: 1_000_000,
    totalUniqueCandidateCount: 40,
    pathsExhausted: false,
    completedWindows: Object.freeze([
      Object.freeze({ rawCandidateCount: 100, newUniqueCount: 40 }),
    ]),
    ...overrides,
  });
}

describe("recommendation pool V2 generation service", () => {
  it("accepts a fake executor result settled within the 1 USD round ceiling", async () => {
    const execute = vi.fn(async () => executorResult());
    const service = createRecommendationPoolV2GenerationService({ execute });

    await expect(service.executeDiscoveryRound(baseInput)).resolves.toEqual(
      executorResult(),
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects a round authorization above 1 USD before the executor edge", async () => {
    const execute = vi.fn(async () => executorResult());
    const service = createRecommendationPoolV2GenerationService({ execute });

    await expect(service.executeDiscoveryRound({
      ...baseInput,
      maxCostMicros: 1_000_001,
    })).rejects.toThrow("round budget exceeds 1 USD");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a fake executor result settled above its authorization", async () => {
    const execute = vi.fn(async () => executorResult({
      costMicros: 1_000_001,
    }));
    const service = createRecommendationPoolV2GenerationService({ execute });

    await expect(service.executeDiscoveryRound(baseInput)).rejects.toThrow(
      "executor exceeded round budget",
    );
  });

  it("blocks unknown charge results that also claim a settled cost", async () => {
    const execute = vi.fn(async () => executorResult({
      chargeState: "unknown_charge",
      costMicros: 1,
    }));
    const service = createRecommendationPoolV2GenerationService({ execute });

    await expect(service.executeDiscoveryRound(baseInput)).rejects.toThrow(
      "unknown charge cannot report settled cost",
    );
  });
});
