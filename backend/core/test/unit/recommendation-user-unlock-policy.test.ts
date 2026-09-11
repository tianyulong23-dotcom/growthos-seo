import { describe, expect, it } from "vitest";

import {
  calculateRecommendationRequiredOpportunityCount,
  evaluateRecommendationBatchUnlock,
} from "../../src/modules/backlinks/domain/recommendations/recommendation-user-unlock-policy.js";

describe("recommendation V2 user unlock policy", () => {
  it.each([
    [5, 0],
    [20, 0],
    [26, 0],
    [100, 0],
  ])("requires no opportunities for batch size %i", (size, required) => {
    expect(calculateRecommendationRequiredOpportunityCount(size)).toBe(
      required,
    );
  });

  it("allows an immediate next release with zero opportunities", () => {
    const firstVisibleAt = new Date("2026-08-28T00:00:00.000Z");
    expect(
      evaluateRecommendationBatchUnlock({
        originalBatchSize: 20,
        successfulOpportunityCount: 0,
        firstVisibleAt,
        databaseNow: firstVisibleAt,
      }),
    ).toMatchObject({
      unlocked: true,
      unlockReason: "NO_GATE",
      requiredOpportunityCount: 0,
      unlockAt: firstVisibleAt,
    });
  });

  it("does not depend on elapsed time and retains historical unlock reasons", () => {
    const firstVisibleAt = new Date("2026-08-28T00:00:00.000Z");
    expect(
      evaluateRecommendationBatchUnlock({
        originalBatchSize: 20,
        successfulOpportunityCount: 0,
        firstVisibleAt,
        databaseNow: new Date("2026-08-28T18:00:00.000Z"),
      }),
    ).toMatchObject({
      unlocked: true,
      unlockReason: "NO_GATE",
    });
    expect(
      evaluateRecommendationBatchUnlock({
        originalBatchSize: 20,
        successfulOpportunityCount: 0,
        firstVisibleAt,
        databaseNow: new Date("2026-08-28T01:00:00.000Z"),
        previouslyUnlockedAt: new Date("2026-08-28T00:30:00.000Z"),
        previouslyUnlockReason: "OPPORTUNITY_RATIO",
      }),
    ).toMatchObject({
      unlocked: true,
      unlockReason: "OPPORTUNITY_RATIO",
    });
  });
});
