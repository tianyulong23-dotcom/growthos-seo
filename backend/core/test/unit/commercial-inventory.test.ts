import { describe, expect, it } from "vitest";

import {
  decideCommercialInventoryRefill,
} from "../../src/modules/backlinks/domain/recommendations/commercial-inventory.js";

const policy = {
  candidateLowWatermark: 20,
  candidateHighWatermark: 40,
  publishedLowWatermark: 5,
  publishedHighWatermark: 10,
  minimumEmailHitRate: 0.1,
  maximumEmailHitRate: 0.8,
} as const;

describe("commercial candidate inventory", () => {
  it("back-calculates candidate over-fetch from capped verified-email history", () => {
    const result = decideCommercialInventoryRefill({
      policy,
      candidateReadyCount: 25,
      publishedContactReadyCount: 2,
      historicalVerifiedEmailCount: 1,
      historicalCandidateCount: 20,
      inflight: false,
      cooldownActive: false,
      budgetAvailable: true,
    });

    expect(result).toEqual({
      shouldRefill: true,
      requestedCandidateCount: 80,
      effectiveEmailHitRate: 0.1,
      pauseReason: null,
    });
  });

  it("pauses without losing the computed inventory need", () => {
    expect(decideCommercialInventoryRefill({
      policy,
      candidateReadyCount: 0,
      publishedContactReadyCount: 0,
      historicalVerifiedEmailCount: 8,
      historicalCandidateCount: 10,
      inflight: false,
      cooldownActive: false,
      budgetAvailable: false,
    })).toMatchObject({
      shouldRefill: false,
      requestedCandidateCount: 40,
      effectiveEmailHitRate: 0.8,
      pauseReason: "budget",
    });
  });
});
