import { describe, expect, it } from "vitest";
import { finalizeRecommendationGeneration } from "../../src/modules/backlinks/application/services/recommendation-pool-generation-finalizer.service.js";

function candidate(index: number, canonicalDomain: string) {
  return {
    id: String(index), canonicalDomain, recommended: true,
    recommendationReasonStrengthBand: 1, evidenceCompleteness: 1,
    recommendationId: `recommendation-${index}`, prospectId: `prospect-${index}`,
    inventoryId: `inventory-${index}`, generationContractId: "generation",
    inputPinId: "pin", recommendationContextVersionId: "context",
  };
}

describe("whole-supply eligibility precedes batch partitioning", () => {
  it("partitions 100 candidates exactly as the remaining 80 eligible candidates", () => {
    const candidates = Array.from({ length: 100 }, (_, index) =>
      candidate(index, index % 5 === 0
        ? (index % 10 === 0 ? `shop${index}.amazon.com` : "developer.android.com")
        : `publisher-${index}.com`),
    );
    const input = { terminalReason: "PATHS_EXHAUSTED" as const, completedAt: new Date("2026-09-08T00:00:00Z") };
    const actual = finalizeRecommendationGeneration({ ...input, candidates });
    const expected = finalizeRecommendationGeneration({
      ...input, candidates: candidates.filter((_, index) => index % 5 !== 0),
    });
    expect(actual).toEqual(expected);
    expect(actual.effectiveUniqueCandidateCount).toBe(80);
    expect(actual.batches.flatMap((batch) => batch.items)).toHaveLength(80);
    expect(actual.batches.every((batch) => batch.originalSize === 16)).toBe(true);
  });

  it("returns no batches if all targets are excluded", () => {
    const actual = finalizeRecommendationGeneration({
      candidates: [candidate(1, "apple.com"), candidate(2, "reddit.com")],
      terminalReason: "PATHS_EXHAUSTED", completedAt: new Date(),
    });
    expect(actual.effectiveUniqueCandidateCount).toBe(0);
    expect(actual.batches).toEqual([]);
  });
});
