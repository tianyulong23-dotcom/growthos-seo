import { describe, expect, it } from "vitest";
import {
  buildRecommendationBatchFingerprint,
  buildRecommendationOrderFingerprint,
  calculateRecommendationBatchSize,
  planRecommendationHybridBatchAllocation,
  recommendationBatchSelectionPolicyVersion,
} from "../../src/modules/backlinks/domain/recommendations/recommendation-batch-policy.js";

describe("hybrid batch allocation for a finalized generation", () => {
  it.each([
    { dfs: 200, library: 0, expected: [[100, 0], [100, 0]] },
    { dfs: 120, library: 80, expected: [[60, 40], [60, 40]] },
    { dfs: 50, library: 150, expected: [[25, 75], [25, 75]] },
    { dfs: 0, library: 200, expected: [[0, 100], [0, 100]] },
    { dfs: 51, library: 149, expected: [[26, 74], [25, 75]] },
    { dfs: 1, library: 199, expected: [[1, 99], [0, 100]] },
    { dfs: 199, library: 1, expected: [[100, 0], [99, 1]] },
    { dfs: 201, library: 99, expected: [[100, 0], [100, 0], [1, 99]] },
    {
      dfs: 450,
      library: 50,
      expected: [[100, 0], [100, 0], [100, 0], [100, 0], [50, 50]],
    },
    { dfs: 120, library: 10, expected: [[60, 10], [60, 0]] },
    { dfs: 50, library: 20, expected: [[25, 20], [25, 0]] },
    { dfs: 0, library: 150, expected: [[0, 100], [0, 50]] },
    { dfs: 1, library: 0, expected: [[1, 0]] },
    { dfs: 0, library: 0, expected: [] },
  ])("allocates $dfs DataForSEO + $library library candidates", ({
    dfs,
    library,
    expected,
  }) => {
    expect(planRecommendationHybridBatchAllocation({
      dataForSeoCount: dfs,
      resourceLibraryCount: library,
    })).toEqual(expected.map(([dataForSeoCount, resourceLibraryCount], index) => ({
      ordinal: index + 1,
      dataForSeoCount,
      resourceLibraryCount,
    })));
  });

  it("conserves both sources and caps each batch at 100 across generation capacity", () => {
    for (let dfs = 0; dfs <= 1_000; dfs += 1) {
      for (const library of new Set([0, Math.floor((1_000 - dfs) / 2), 1_000 - dfs])) {
        const batches = planRecommendationHybridBatchAllocation({
          dataForSeoCount: dfs,
          resourceLibraryCount: library,
        });
        expect(batches.reduce((sum, batch) => sum + batch.dataForSeoCount, 0)).toBe(dfs);
        expect(batches.reduce((sum, batch) => sum + batch.resourceLibraryCount, 0)).toBe(library);
        batches.forEach((batch, index) => {
          expect(batch.ordinal).toBe(index + 1);
          expect(batch.dataForSeoCount + batch.resourceLibraryCount).toBeGreaterThan(0);
          expect(batch.dataForSeoCount + batch.resourceLibraryCount).toBeLessThanOrEqual(100);
        });
      }
    }
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1_001])(
    "rejects invalid source counts: %s",
    (count) => {
      expect(() => planRecommendationHybridBatchAllocation({
        dataForSeoCount: count,
        resourceLibraryCount: 0,
      })).toThrow(TypeError);
      expect(() => planRecommendationHybridBatchAllocation({
        dataForSeoCount: 0,
        resourceLibraryCount: count,
      })).toThrow(TypeError);
    },
  );

  it("rejects combined supply above generation capacity", () => {
    expect(() => planRecommendationHybridBatchAllocation({
      dataForSeoCount: 600,
      resourceLibraryCount: 401,
    })).toThrow(TypeError);
  });

  it("is deterministic for the same frozen supply snapshot", () => {
    const input = Object.freeze({ dataForSeoCount: 51, resourceLibraryCount: 149 });
    expect(planRecommendationHybridBatchAllocation(input))
      .toEqual(planRecommendationHybridBatchAllocation(input));
    expect(input).toEqual({ dataForSeoCount: 51, resourceLibraryCount: 149 });
  });
});

describe("legacy batch policy remains unchanged before hybrid wiring", () => {
  it("retains five-way sizing and existing policy version", () => {
    expect(recommendationBatchSelectionPolicyVersion).toBe("recommendation-batch-selection.v1");
    expect(calculateRecommendationBatchSize(100)).toBe(20);
    expect(calculateRecommendationBatchSize(130)).toBe(26);
  });

  it("retains the pre-edit order and batch fingerprints", () => {
    const candidates = [
      { id: "1", canonicalDomain: "a.example", recommended: true,
        recommendationReasonStrengthBand: 2, evidenceCompleteness: 3 },
      { id: "2", canonicalDomain: "b.example", recommended: false,
        recommendationReasonStrengthBand: 1, evidenceCompleteness: 1 },
    ];
    expect(buildRecommendationOrderFingerprint(candidates))
      .toBe("7fc7aee922905416511fb6a6f3600e35458966535c1a977b7ff9ea44e0595f82");
    expect(buildRecommendationBatchFingerprint({ ordinal: 1, candidates }))
      .toBe("43d0e8e7a6922c806b93a12d93de1c2f2f5da015d85702fdb19f3c3331028b5d");
  });
});
