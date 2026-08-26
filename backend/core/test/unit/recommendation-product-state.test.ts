import { describe, expect, it } from "vitest";

import {
  deriveRecommendationProductState,
  type RecommendationProductStateInput,
} from "../../src/modules/backlinks/domain/recommendations/recommendation-product-state.js";

const base: RecommendationProductStateInput = {
  visibleCount: 4,
  targetCount: 10,
  refillInFlight: false,
  nextRetryAt: null,
  terminationReason: null,
  failureRootCause: null,
  canResumeSameOperation: false,
  unknownChargeCount: 0,
};

describe("Phase 5 recommendation product state", () => {
  it.each([
    [
      { refillInFlight: true },
      {
        state: "running",
        reasonCode: "REFILL_IN_PROGRESS",
        recoveryCommand: "CONTINUE_SAME_CRITERIA",
      },
    ],
    [
      { nextRetryAt: "2026-08-18T01:00:00.000Z" },
      {
        state: "waiting_retry",
        reasonCode: "RETRY_SCHEDULED",
        recoveryCommand: "CONTINUE_SAME_CRITERIA",
      },
    ],
    [
      { terminationReason: "PROVIDER_UNAVAILABLE" },
      {
        state: "paused_provider",
        reasonCode: "PROVIDER_UNAVAILABLE",
        recoveryCommand: "WAIT_PROVIDER",
      },
    ],
    [
      { terminationReason: "BUDGET" },
      {
        state: "partial_exhausted",
        reasonCode: "BUDGET",
        recoveryCommand: "CONTINUE_SAME_CRITERIA",
      },
    ],
    [
      { terminationReason: "TIERS_EXHAUSTED" },
      {
        state: "partial_exhausted",
        reasonCode: "TIERS_EXHAUSTED",
        recoveryCommand: "BROADEN_MARKET_OR_KEYWORDS",
      },
    ],
    [
      { failureRootCause: "STALE_BUILD" },
      {
        state: "maintenance",
        reasonCode: "STALE_BUILD",
        recoveryCommand: "RESTART_SERVICE",
      },
    ],
    [
      { failureRootCause: "UNKNOWN_INTERNAL" },
      {
        state: "blocked",
        reasonCode: "UNKNOWN_INTERNAL",
        recoveryCommand: "CONTACT_SUPPORT",
      },
    ],
  ] as const)(
    "derives an independent state for %o",
    (overrides, expected) => {
      expect(deriveRecommendationProductState({
        ...base,
        ...overrides,
      })).toMatchObject(expected);
    },
  );

  it("prioritizes unknown provider charge reconciliation over retries", () => {
    expect(deriveRecommendationProductState({
      ...base,
      nextRetryAt: "2026-08-18T01:00:00.000Z",
      unknownChargeCount: 1,
    })).toEqual({
      state: "blocked",
      reasonCode: "PROVIDER_CHARGE_REQUIRES_RECONCILIATION",
      recoveryCommand: "CONTACT_SUPPORT",
      providerAvailability: "unknown",
    });
  });

  it("allows a bounded pre-provider internal failure to resume the same operation", () => {
    expect(deriveRecommendationProductState({
      ...base,
      failureRootCause: "UNKNOWN_INTERNAL",
      canResumeSameOperation: true,
    })).toEqual({
      state: "maintenance",
      reasonCode: "UNKNOWN_INTERNAL",
      recoveryCommand: "CONTINUE_SAME_CRITERIA",
      providerAvailability: "available",
    });
  });

  it("keeps a target-complete operation in product running state", () => {
    expect(deriveRecommendationProductState({
      ...base,
      visibleCount: 10,
      terminationReason: "HIGH_WATERMARK",
    })).toEqual({
      state: "running",
      reasonCode: "VISIBLE_TARGET_REACHED",
      recoveryCommand: null,
      providerAvailability: "available",
    });
  });
});
