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
      requestedCandidateCount: 13,
      effectiveEmailHitRate: 0.8,
      pauseReason: "budget",
    });
  });

  it("counts only publishable websites when raw inventory is 68 but 24 qualify", () => {
    expect(decideCommercialInventoryRefill({
      policy: {
        ...policy,
        publishedLowWatermark: 25,
        publishedHighWatermark: 30,
      },
      candidateReadyCount: 68,
      publishedContactReadyCount: 24,
      historicalVerifiedEmailCount: 5,
      historicalCandidateCount: 20,
      inflight: false,
      cooldownActive: false,
      budgetAvailable: true,
    })).toMatchObject({
      shouldRefill: true,
      requestedCandidateCount: 24,
      effectiveEmailHitRate: 0.25,
      pauseReason: null,
    });
  });

  it("continues an active cycle until the publishable high watermark", () => {
    expect(decideCommercialInventoryRefill({
      policy,
      candidateReadyCount: 68,
      publishedContactReadyCount: 7,
      historicalVerifiedEmailCount: 5,
      historicalCandidateCount: 20,
      refillCycleActive: true,
      inflight: false,
      cooldownActive: true,
      budgetAvailable: true,
    })).toMatchObject({
      shouldRefill: true,
      requestedCandidateCount: 12,
      pauseReason: null,
    });
  });

  it("restores a twenty-site pool after one recommendation is consumed", () => {
    const stablePoolPolicy = {
      ...policy,
      publishedLowWatermark: 19,
      publishedHighWatermark: 20,
    };

    expect(decideCommercialInventoryRefill({
      policy: stablePoolPolicy,
      candidateReadyCount: 20,
      publishedContactReadyCount: 20,
      historicalVerifiedEmailCount: 20,
      historicalCandidateCount: 20,
      refillCycleActive: false,
      inflight: false,
      cooldownActive: false,
      budgetAvailable: true,
    })).toMatchObject({
      shouldRefill: false,
      requestedCandidateCount: 0,
    });
    expect(decideCommercialInventoryRefill({
      policy: stablePoolPolicy,
      candidateReadyCount: 19,
      publishedContactReadyCount: 19,
      historicalVerifiedEmailCount: 19,
      historicalCandidateCount: 19,
      refillCycleActive: true,
      inflight: false,
      cooldownActive: false,
      budgetAvailable: true,
    })).toMatchObject({
      shouldRefill: true,
      requestedCandidateCount: 2,
      pauseReason: null,
    });
    expect(decideCommercialInventoryRefill({
      policy: stablePoolPolicy,
      candidateReadyCount: 20,
      publishedContactReadyCount: 20,
      historicalVerifiedEmailCount: 20,
      historicalCandidateCount: 20,
      refillCycleActive: true,
      inflight: false,
      cooldownActive: false,
      budgetAvailable: true,
    })).toMatchObject({
      shouldRefill: false,
      requestedCandidateCount: 0,
    });
  });
});
