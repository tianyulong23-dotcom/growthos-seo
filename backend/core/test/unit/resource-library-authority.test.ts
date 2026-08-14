import { describe, expect, it } from "vitest";

import {
  calculateProjectAuthority,
  calculateResourceAuthorityScore,
  resourceAuthorityMatch,
} from "../../src/modules/backlinks/domain/recommendations/resource-library-authority.js";

describe("resource library authority matching", () => {
  it("uses a conservative threshold when the project profile is unavailable", () => {
    expect(calculateProjectAuthority(null)).toEqual({
      score: 75,
      band: "unknown",
      confidence: "conservative_default",
      referringDomains: null,
      minimumResourceAuthorityScore: 72,
    });
  });

  it("raises the minimum resource score with known project authority", () => {
    expect(calculateProjectAuthority(1_000_000)).toEqual({
      score: 100,
      band: "high",
      confidence: "backlink_profile",
      referringDomains: 1_000_000,
      minimumResourceAuthorityScore: 95,
    });
  });

  it("combines profile health, referring domains, and provider rank", () => {
    expect(calculateResourceAuthorityScore({
      profileHealthScore: 90,
      dataForSeoRank: 375,
      referringDomains: 100_000,
    })).toBe(80);
  });

  it("does not classify below-threshold resources as matched", () => {
    const projectAuthority = calculateProjectAuthority(null);
    expect(resourceAuthorityMatch(84, projectAuthority)).toBe("stronger");
    expect(resourceAuthorityMatch(72, projectAuthority)).toBe("matched");
    expect(resourceAuthorityMatch(71, projectAuthority)).toBe("below");
  });
});
