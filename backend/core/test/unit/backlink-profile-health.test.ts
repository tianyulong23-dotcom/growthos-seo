import { describe, expect, it } from "vitest";

import {
  calculateBacklinkProfileHealth,
} from "../../src/modules/backlinks/domain/profile/backlink-profile-health.js";

describe("backlink profile health", () => {
  it("returns insufficient data instead of inventing a score for partial coverage", () => {
    expect(calculateBacklinkProfileHealth({
      inventoryCoverage: 0.18,
      totalBacklinks: 500,
      referringDomains: 70,
      dofollow: 20,
      nofollow: 30,
      sponsored: 0,
      ugc: 0,
      spamHighRisk: 1,
      commercialAnchorCount: 5,
      largestAnchorCount: 10,
      newBacklinks: 8,
      lostBacklinks: 3,
      relevantCountryCount: 20,
      knownCountryCount: 30,
      targetPageCount: 12,
      brokenTargetCount: 0,
      qualityDomainCount: 42,
      knownPlacementCount: 4,
      validatedPlacementCount: 4,
    })).toMatchObject({
      score: null,
      grade: "INSUFFICIENT_DATA",
      modelVersion: "backlink-profile-health.v1",
      risks: ["INVENTORY_COVERAGE_LOW"],
    });
  });

  it("calculates a deterministic component score when coverage is sufficient", () => {
    const result = calculateBacklinkProfileHealth({
      inventoryCoverage: 0.92,
      totalBacklinks: 100,
      referringDomains: 60,
      dofollow: 68,
      nofollow: 24,
      sponsored: 4,
      ugc: 4,
      spamHighRisk: 3,
      commercialAnchorCount: 12,
      largestAnchorCount: 16,
      newBacklinks: 9,
      lostBacklinks: 4,
      relevantCountryCount: 70,
      knownCountryCount: 80,
      targetPageCount: 20,
      brokenTargetCount: 2,
      qualityDomainCount: 48,
      knownPlacementCount: 5,
      validatedPlacementCount: 4,
    });

    expect(result.score).toBe(84);
    expect(result.grade).toBe("B");
    expect(result.components).toHaveLength(9);
    expect(result.positives).toContain("REFERRING_DOMAIN_DIVERSITY_HEALTHY");
  });
});
