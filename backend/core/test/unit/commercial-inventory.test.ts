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
  it("refills the visible website deficit without email over-fetch", () => {
    const result = decideCommercialInventoryRefill({
      policy,
      candidateReadyCount: 25,
      publishedVisibleCount: 2,
      historicalVerifiedEmailCount: 1,
      historicalCandidateCount: 20,
      inflight: false,
      cooldownActive: false,
      budgetAvailable: true,
    });

    expect(result).toEqual({
      shouldRefill: true,
      requestedCandidateCount: 8,
      effectiveEmailHitRate: 0.1,
      pauseReason: null,
    });
  });

  it("pauses without losing the computed inventory need", () => {
    expect(decideCommercialInventoryRefill({
      policy,
      candidateReadyCount: 0,
      publishedVisibleCount: 0,
      historicalVerifiedEmailCount: 8,
      historicalCandidateCount: 10,
      inflight: false,
      cooldownActive: false,
      budgetAvailable: false,
    })).toMatchObject({
      shouldRefill: false,
      requestedCandidateCount: 10,
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
      publishedVisibleCount: 24,
      historicalVerifiedEmailCount: 5,
      historicalCandidateCount: 20,
      inflight: false,
      cooldownActive: false,
      budgetAvailable: true,
    })).toMatchObject({
      shouldRefill: true,
      requestedCandidateCount: 6,
      effectiveEmailHitRate: 0.25,
      pauseReason: null,
    });
  });

  it("continues an active cycle until the publishable high watermark", () => {
    expect(decideCommercialInventoryRefill({
      policy,
      candidateReadyCount: 68,
      publishedVisibleCount: 7,
      historicalVerifiedEmailCount: 5,
      historicalCandidateCount: 20,
      refillCycleActive: true,
      inflight: false,
      cooldownActive: true,
      budgetAvailable: true,
    })).toMatchObject({
      shouldRefill: true,
      requestedCandidateCount: 3,
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
      publishedVisibleCount: 20,
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
      publishedVisibleCount: 19,
      historicalVerifiedEmailCount: 19,
      historicalCandidateCount: 19,
      refillCycleActive: true,
      inflight: false,
      cooldownActive: false,
      budgetAvailable: true,
    })).toMatchObject({
      shouldRefill: true,
      requestedCandidateCount: 1,
      pauseReason: null,
    });
    expect(decideCommercialInventoryRefill({
      policy: stablePoolPolicy,
      candidateReadyCount: 20,
      publishedVisibleCount: 20,
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
