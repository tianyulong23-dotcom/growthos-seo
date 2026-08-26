import { describe, expect, it } from "vitest";

import {
  calculateProjectAuthority,
  calculateResourceAuthorityScore,
  resourceAuthorityMatch,
} from "../../src/modules/backlinks/domain/recommendations/resource-library-authority.js";

describe("resource library authority matching", () => {
  it("uses neutral low-confidence authority when the project profile is unavailable", () => {
    expect(calculateProjectAuthority(null)).toEqual({
      score: 50,
      band: "unknown",
      confidence: "neutral_default",
      referringDomains: null,
      minimumResourceAuthorityScore: 35,
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

  it("accepts the normal relative authority range instead of an absolute floor", () => {
    const projectAuthority = {
      score: 20,
      band: "emerging",
      confidence: "backlink_profile",
      referringDomains: 15,
      minimumResourceAuthorityScore: 5,
    } as const;

    expect(resourceAuthorityMatch(60, projectAuthority)).toBe("stronger");
    expect(resourceAuthorityMatch(5, projectAuthority)).toBe("matched");
    expect(resourceAuthorityMatch(4, projectAuthority)).toBe("below");
  });
});
