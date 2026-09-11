import { describe, expect, it } from "vitest";

import {
  buildRecommendationBatchFingerprint,
  buildRecommendationOrderFingerprint,
  calculateRecommendationBatchCount,
  calculateRecommendationBatchSize,
  orderRecommendationBatchCandidates,
  partitionRecommendationBatches,
} from "../../src/modules/backlinks/domain/recommendations/recommendation-batch-policy.js";

describe("recommendation V2 batch policy", () => {
  it.each([
    [0, 0],
    [18, 18],
    [24, 24],
    [25, 5],
    [100, 20],
    [130, 26],
    [500, 100],
    [1_000, 100],
  ])("calculates T=%i as batch size %i", (total, expected) => {
    expect(calculateRecommendationBatchSize(total)).toBe(expected);
  });

  it("calculates canonical batch counts", () => {
    expect(calculateRecommendationBatchCount(0)).toBe(0);
    expect(calculateRecommendationBatchCount(18)).toBe(1);
    expect(calculateRecommendationBatchCount(25)).toBe(5);
    expect(calculateRecommendationBatchCount(130)).toBe(5);
    expect(calculateRecommendationBatchCount(1_000)).toBe(10);
  });

  it("orders deterministically without using a user-visible score", () => {
    const ordered = orderRecommendationBatchCandidates([
      {
        id: "3",
        canonicalDomain: "z.example",
        recommended: false,
        recommendationReasonStrengthBand: 10,
        evidenceCompleteness: 10,
      },
      {
        id: "2",
        canonicalDomain: "b.example",
        recommended: true,
        recommendationReasonStrengthBand: 1,
        evidenceCompleteness: 2,
      },
      {
        id: "1",
        canonicalDomain: "a.example",
        recommended: true,
        recommendationReasonStrengthBand: 1,
        evidenceCompleteness: 2,
      },
    ]);
    expect(ordered.map((candidate) => candidate.id)).toEqual(["1", "2", "3"]);
  });

  it("freezes a stable complete-order fingerprint", () => {
    const candidates = [
      {
        id: "1",
        canonicalDomain: "a.example",
        recommended: true,
        recommendationReasonStrengthBand: 2,
        evidenceCompleteness: 3,
      },
      {
        id: "2",
        canonicalDomain: "b.example",
        recommended: false,
        recommendationReasonStrengthBand: 1,
        evidenceCompleteness: 1,
      },
    ] as const;
    expect(buildRecommendationOrderFingerprint(candidates)).toBe(
      buildRecommendationOrderFingerprint([...candidates].reverse()),
    );
    expect(partitionRecommendationBatches(candidates)).toHaveLength(1);
  });

  it("freezes each canonical batch membership and order independently", () => {
    const first = [
      {
        id: "1",
        canonicalDomain: "a.example",
        recommended: true,
        recommendationReasonStrengthBand: 2,
        evidenceCompleteness: 3,
      },
      {
        id: "2",
        canonicalDomain: "b.example",
        recommended: false,
        recommendationReasonStrengthBand: 1,
        evidenceCompleteness: 1,
      },
    ] as const;
    const fingerprint = buildRecommendationBatchFingerprint({
      ordinal: 1,
      candidates: first,
    });

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      buildRecommendationBatchFingerprint({
        ordinal: 1,
        candidates: [...first].reverse(),
      }),
    ).not.toBe(fingerprint);
    expect(
      buildRecommendationBatchFingerprint({
        ordinal: 2,
        candidates: first,
      }),
    ).not.toBe(fingerprint);
  });
});
