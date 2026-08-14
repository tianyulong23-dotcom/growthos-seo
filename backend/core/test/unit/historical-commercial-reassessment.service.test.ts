import { describe, expect, it } from "vitest";

import {
  decideRefillPolicyRecovery,
} from "../../src/modules/backlinks/application/services/historical-commercial-reassessment.service.js";

const now = new Date("2026-08-11T04:00:00.000Z");

function policy(
  overrides: Record<string, unknown> = {},
) {
  return {
    organizationId: "018f0000-0000-7000-8000-000000000001",
    workspaceId: "018f0000-0000-7000-8000-000000000002",
    projectContextVersionId: "018f0000-0000-7000-8000-000000000003",
    refillState: "paused",
    currentRefillTier: "curated_resource_library",
    currentRefillRound: 2,
    paidRefillTier: "same_topic_target_market",
    paidRefillRound: 1,
    resourceRefillTier: "curated_resource_library",
    resourceRefillRound: 2,
    terminationReason: "BUDGET",
    nextRefillAt: null,
    updatedAt: "2026-08-01T00:00:00.000Z",
    version: 3,
    budgetPeriodStart: "2026-08-10T00:00:00.000Z",
    budgetRemainingMicros: 49_024,
    activeJob: false,
    activeBatch: false,
    pendingRefillOutbox: false,
    ...overrides,
  };
}

describe("historical refill policy recovery", () => {
  it("resumes BUDGET only in a newer funded period", () => {
    expect(decideRefillPolicyRecovery(policy(), now)).toEqual({
      recover: true,
      reason: "NEW_BUDGET_PERIOD",
    });
    expect(decideRefillPolicyRecovery(policy({
      budgetPeriodStart: "2026-07-01T00:00:00.000Z",
    }), now)).toEqual({
      recover: false,
      reason: "SAME_BUDGET_PERIOD",
    });
  });

  it("resumes PROVIDER_UNAVAILABLE only after recovery time", () => {
    expect(decideRefillPolicyRecovery(policy({
      terminationReason: "PROVIDER_UNAVAILABLE",
      nextRefillAt: "2026-08-11T03:59:59.000Z",
    }), now)).toEqual({
      recover: true,
      reason: "PROVIDER_RECOVERY_DUE",
    });
    expect(decideRefillPolicyRecovery(policy({
      terminationReason: "PROVIDER_UNAVAILABLE",
      nextRefillAt: "2026-08-11T04:00:01.000Z",
    }), now)).toEqual({
      recover: false,
      reason: "RECOVERY_NOT_DUE",
    });
  });

  it("preserves active work, missing paid cursors, and TIERS_EXHAUSTED", () => {
    expect(decideRefillPolicyRecovery(policy({
      activeBatch: true,
    }), now).reason).toBe("ACTIVE_WORK");
    expect(decideRefillPolicyRecovery(policy({
      paidRefillTier: null,
      paidRefillRound: null,
    }), now).reason).toBe("NO_PAID_CURSOR");
    expect(decideRefillPolicyRecovery(policy({
      terminationReason: "TIERS_EXHAUSTED",
    }), now)).toEqual({
      recover: false,
      reason: "TIERS_EXHAUSTED_PRESERVED",
    });
  });
});
