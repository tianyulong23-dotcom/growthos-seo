import { describe, expect, it } from "vitest";
import {
  finalizeRecommendationGeneration,
  type RecommendationFinalizationCandidate,
} from "../../src/modules/backlinks/application/services/recommendation-pool-generation-finalizer.service.js";
import { evaluateRecommendationUserRelease } from "../../src/modules/backlinks/application/services/recommendation-user-release.service.js";
import { buildRecommendationBatchFingerprint } from "../../src/modules/backlinks/domain/recommendations/recommendation-batch-policy.js";

function candidates(count: number, library = false, ordinal?: number): RecommendationFinalizationCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${library ? "library" : "dfs"}-${ordinal ?? 0}-${index}`,
    canonicalDomain: `${library ? "library" : "dfs"}-${ordinal ?? 0}-${index}.example`,
    sourceType: library ? "CURATED_RESOURCE_LIBRARY" : "DATAFORSEO",
    ...(ordinal === undefined ? {} : { resourceBatchOrdinal: ordinal }),
    recommended: false, recommendationReasonStrengthBand: 0, evidenceCompleteness: 0,
    recommendationId: "recommendation", prospectId: "prospect", inventoryId: "inventory",
    generationContractId: "generation", inputPinId: "pin", recommendationContextVersionId: "context",
  }));
}
const finalize = (supply: RecommendationFinalizationCandidate[], hybrid = true) =>
  finalizeRecommendationGeneration({
    candidates: supply, completedAt: new Date("2026-09-10T00:00:00Z"),
    terminalReason: "PATHS_EXHAUSTED", ...(hybrid ? { allocationPolicy: "hybrid" as const } : {}),
  });

describe("hybrid canonical finalization", () => {
  it.each([
    [200, 0, [100, 100]], [120, 80, [100, 100]], [50, 150, [100, 100]],
    [0, 200, [100, 100]], [51, 149, [100, 100]],
    [450, 50, [100, 100, 100, 100, 100]],
    [120, 5, [65, 60]], [1, 0, [1]],
  ])("allocates %i discovery and %i library candidates", (dfs, library, sizes) => {
    const result = finalize([...candidates(dfs), ...candidates(library, true)]);
    expect(result.batches.map((batch) => batch.originalSize)).toEqual(sizes);
    expect(new Set(result.batches.flatMap((batch) => batch.items.map((item) => item.candidate.id))).size)
      .toBe(dfs + library);
    expect(result.batches[2]?.items.every((item) => item.candidate.sourceType === "DATAFORSEO") ?? true)
      .toBe(true);
  });

  it("keeps each library match together including its high-DR tail", () => {
    const first = candidates(40, true, 1);
    const second = candidates(40, true, 2).map((item) => ({ ...item, recommended: true }));
    const result = finalize([...candidates(120), ...first, ...second]);
    expect(result.batches.map((batch) => batch.items.filter((item) =>
      item.candidate.sourceType === "CURATED_RESOURCE_LIBRARY"
    ).map((item) => item.candidate.resourceBatchOrdinal))).toEqual([
      Array(40).fill(1), Array(40).fill(2),
    ]);
    expect(finalize([...second, ...first, ...candidates(120)]).canonicalOrderFingerprint)
      .toBe(result.canonicalOrderFingerprint);
  });

  it("does not refill a partial reserved batch from another match", () => {
    const result = finalize([...candidates(120), ...candidates(5, true, 1), ...candidates(40, true, 2)]);
    expect(result.batches.map((batch) => batch.originalSize)).toEqual([65, 100]);
  });

  it("retains legacy allocation and fingerprints for explicit historical callers", () => {
    const supply = candidates(120);
    const historical = finalize(supply, false);
    expect(historical.batches.map((batch) => batch.originalSize)).toEqual([24, 24, 24, 24, 24]);
    const first = historical.batches[0];
    if (first === undefined) throw new Error("Missing historical batch");
    expect(first.orderFingerprint).toBe(buildRecommendationBatchFingerprint({
      ordinal: 1, candidates: first.items.map((item) => item.candidate),
    }));
    expect(finalize(supply).canonicalOrderFingerprint).not.toBe(historical.canonicalOrderFingerprint);
  });

  it.each([
    ["AVAILABLE", "RELEASE_NEXT", true],
    ["PREPARING", "NEXT_BATCH_PREPARING", false],
    ["NONE", "POOL_EXHAUSTED", false],
  ] as const)("retains %s supply guard without a time or action gate", (nextBatchState, state, enabled) => {
    const now = new Date("2026-09-10T00:00:00Z");
    expect(evaluateRecommendationUserRelease({
      originalBatchSize: 100, successfulOpportunityCount: 0,
      firstVisibleAt: now, databaseNow: now, previouslyUnlockedAt: null,
      previouslyUnlockReason: null, nextBatchState,
    })).toMatchObject({ getMoreState: state, canGetMore: enabled, requiredOpportunityCount: 0 });
  });
});
