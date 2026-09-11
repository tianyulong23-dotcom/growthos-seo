import { describe, expect, it } from "vitest";

import { finalizeRecommendationGeneration } from "../../src/modules/backlinks/application/services/recommendation-pool-generation-finalizer.service.js";
import { evaluateRecommendationBatchPreparation } from "../../src/modules/backlinks/application/services/recommendation-release-batch.service.js";
import {
  prepareRecommendationSeeds,
  validateRecommendationSeeds,
} from "../../src/modules/backlinks/application/services/recommendation-seed-preparation.service.js";
import { evaluateRecommendationUserRelease } from "../../src/modules/backlinks/application/services/recommendation-user-release.service.js";

describe("recommendation pool V2 application services", () => {
  it("preserves user seeds and fills missing discovery inputs from project facts", () => {
    const result = prepareRecommendationSeeds({
      userSeeds: [
        {
          kind: "KEYWORD",
          value: "  partner ecosystem ",
          source: "USER",
        },
      ],
      project: {
        canonicalDomain: "https://www.example.test/path",
        keywords: ["SaaS integrations", "partner ecosystem"],
        products: ["Workflow automation"],
        targetAudiences: ["Operations teams"],
      },
    });

    expect(result).toEqual({
      state: "READY",
      reasonCodes: [],
      seeds: [
        expect.objectContaining({
          kind: "KEYWORD",
          value: "partner ecosystem",
          source: "USER",
          evidence: "USER_INPUT",
        }),
        expect.objectContaining({
          kind: "KEYWORD",
          value: "SaaS integrations",
          source: "PROJECT_FACT",
        }),
        expect.objectContaining({
          kind: "KEYWORD",
          value: "Workflow automation",
        }),
        expect.objectContaining({
          kind: "CATEGORY",
          value: "Operations teams",
        }),
      ],
    });
  });

  it("requires input instead of treating the project domain as a competitor", () => {
    const result = prepareRecommendationSeeds({
      userSeeds: [],
      project: {
        canonicalDomain: "example.test",
        keywords: [],
        products: [],
        targetAudiences: [],
      },
    });

    expect(result).toEqual({
      state: "INPUT_REQUIRED",
      seeds: [],
      reasonCodes: ["DISCOVERY_SEEDS_REQUIRED"],
    });
  });

  it("rejects invalid competitor seeds without manufacturing a domain", () => {
    const result = validateRecommendationSeeds([
      {
        kind: "COMPETITOR_DOMAIN",
        value: "not-a-domain",
        source: "USER",
      },
    ]);

    expect(result[0]).toEqual(
      expect.objectContaining({
        valid: false,
        reason: "INVALID_SEED_VALUE",
      }),
    );
  });

  it("freezes a deterministic canonical batch sequence with full lineage", () => {
    const result = finalizeRecommendationGeneration({
      candidates: Array.from({ length: 25 }, (_, index) => ({
        id: `candidate-${index}`,
        canonicalDomain: `${String(index).padStart(2, "0")}.example`,
        recommended: index % 2 === 0,
        recommendationReasonStrengthBand: index % 3,
        evidenceCompleteness: index % 5,
        recommendationId: `recommendation-${index}`,
        prospectId: `prospect-${index}`,
        inventoryId: `inventory-${index}`,
        generationContractId: "generation-contract",
        inputPinId: "input-pin",
        recommendationContextVersionId: "context-version",
      })),
      terminalReason: "SAFE_SUPPLY_REACHED",
      completedAt: new Date("2026-08-28T00:00:00.000Z"),
    });

    expect(result.effectiveUniqueCandidateCount).toBe(25);
    expect(result.canonicalBatchSize).toBe(5);
    expect(result.canonicalBatchCount).toBe(5);
    expect(result.canonicalOrderFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.batches.flatMap((batch) => batch.items)).toHaveLength(25);
  });

  it("refuses to finalize a native item with incomplete canonical lineage", () => {
    expect(() =>
      finalizeRecommendationGeneration({
        candidates: [
          {
            id: "candidate",
            canonicalDomain: "example.test",
            recommended: true,
            recommendationReasonStrengthBand: 1,
            evidenceCompleteness: 1,
            recommendationId: "",
            prospectId: "prospect",
            inventoryId: "inventory",
            generationContractId: "generation",
            inputPinId: "pin",
            recommendationContextVersionId: "context",
          },
        ],
        terminalReason: "PATHS_EXHAUSTED",
        completedAt: new Date("2026-08-28T00:00:00.000Z"),
      }),
    ).toThrow("canonical lineage is incomplete");
  });

  it("converges unfinished contact work to completed partial at the deadline", () => {
    const result = evaluateRecommendationBatchPreparation({
      items: [
        {
          itemId: "item-1",
          status: "retry_scheduled",
          terminalReasonCode: null,
        },
      ],
      preparationDeadline: new Date("2026-08-28T00:00:00.000Z"),
      databaseNow: new Date("2026-08-28T00:00:00.000Z"),
    });

    expect(result).toEqual({
      available: true,
      itemOutcomes: [
        {
          itemId: "item-1",
          terminal: true,
          terminalReasonCode: "COMPLETED_PARTIAL",
        },
      ],
    });
  });

  it("unlocks get-more without automatically advancing the user cursor", () => {
    const result = evaluateRecommendationUserRelease({
      originalBatchSize: 20,
      successfulOpportunityCount: 5,
      firstVisibleAt: new Date("2026-08-28T00:00:00.000Z"),
      databaseNow: new Date("2026-08-28T01:00:00.000Z"),
      previouslyUnlockedAt: null,
      previouslyUnlockReason: null,
      nextBatchState: "AVAILABLE",
    });

    expect(result).toEqual(
      expect.objectContaining({
        requiredOpportunityCount: 5,
        unlockReason: "OPPORTUNITY_RATIO",
        canGetMore: true,
        getMoreState: "RELEASE_NEXT",
      }),
    );
  });

  it("reports preparation without releasing an unavailable next batch", () => {
    const result = evaluateRecommendationUserRelease({
      originalBatchSize: 20,
      successfulOpportunityCount: 0,
      firstVisibleAt: new Date("2026-08-27T00:00:00.000Z"),
      databaseNow: new Date("2026-08-28T00:00:00.000Z"),
      previouslyUnlockedAt: null,
      previouslyUnlockReason: null,
      nextBatchState: "PREPARING",
    });

    expect(result).toEqual(
      expect.objectContaining({
        unlockReason: "ELAPSED_18H",
        canGetMore: false,
        getMoreState: "NEXT_BATCH_PREPARING",
      }),
    );
  });

  it("reports pool exhaustion after the released candidates are consumed", () => {
    const result = evaluateRecommendationUserRelease({
      originalBatchSize: 20,
      successfulOpportunityCount: 5,
      firstVisibleAt: new Date("2026-08-27T00:00:00.000Z"),
      databaseNow: new Date("2026-08-28T00:00:00.000Z"),
      previouslyUnlockedAt: null,
      previouslyUnlockReason: null,
      nextBatchState: "NONE",
    });

    expect(result).toEqual(
      expect.objectContaining({
        unlockReason: "OPPORTUNITY_RATIO",
        canGetMore: false,
        getMoreState: "POOL_EXHAUSTED",
      }),
    );
  });
});
