import { describe, expect, it } from "vitest";

import { recommendationGateRuleVersion } from "../../src/modules/backlinks/domain/recommendations/gates.js";
import {
  rankRecommendations,
  type RankableRecommendation,
} from "../../src/modules/backlinks/domain/recommendations/ranking.js";
import {
  recommendationScoreModelVersion,
  recommendationWeightPolicyVersion,
} from "../../src/modules/backlinks/domain/recommendations/scoring.js";

type Candidate = RankableRecommendation & Readonly<{ id: string }>;

function candidate(
  hostnameAscii: string,
  total: number,
  id = hostnameAscii,
): Candidate {
  const sourceReleaseId = "dataforseo-2026-07-25";
  const evidencePolicyVersion = "recommendation-evidence-policy.v1";
  return {
    id,
    hostnameAscii,
    sourceReleaseId,
    evidencePolicyVersion,
    score: {
      scoreModelVersion: recommendationScoreModelVersion,
      weightPolicyVersion: recommendationWeightPolicyVersion,
      ruleVersion: recommendationGateRuleVersion,
      sourceReleaseId,
      evidencePolicyVersion,
      total,
    },
  };
}

describe("rankRecommendations", () => {
  it("orders by score descending and hostnameAscii ascending", () => {
    const ranked = rankRecommendations([
      candidate("zeta.com", 90),
      candidate("alpha.com", 70),
      candidate("beta.com", 90),
    ]);

    expect(ranked.map(({ hostnameAscii }) => hostnameAscii)).toEqual([
      "beta.com",
      "zeta.com",
      "alpha.com",
    ]);
  });

  it("is deterministic without mutating the input", () => {
    const input = [
      candidate("charlie.com", 80),
      candidate("alpha.com", 80),
      candidate("bravo.com", 80),
    ];
    const inputSnapshot = [...input];

    const first = rankRecommendations(input);
    const second = rankRecommendations([...input].reverse());

    expect(first.map(({ id }) => id)).toEqual(second.map(({ id }) => id));
    expect(input).toEqual(inputSnapshot);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("rejects duplicate normalized domains", () => {
    expect(() =>
      rankRecommendations([
        candidate("duplicate.com", 90, "first"),
        candidate("duplicate.com", 80, "second"),
      ]),
    ).toThrow(TypeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 100.1])(
    "rejects an invalid total score of %s",
    (total) => {
      expect(() =>
        rankRecommendations([candidate("invalid-score.com", total)]),
      ).toThrow(TypeError);
    },
  );

  it("rejects blank identities and mixed release or policy contracts", () => {
    expect(() => rankRecommendations([candidate(" ", 50)])).toThrow(TypeError);
    expect(() =>
      rankRecommendations([
        candidate("first.com", 50),
        {
          ...candidate("second.com", 40),
          sourceReleaseId: "dataforseo-2026-07-26",
          score: {
            ...candidate("second.com", 40).score,
            sourceReleaseId: "dataforseo-2026-07-26",
          },
        },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      rankRecommendations([
        candidate("first.com", 50),
        {
          ...candidate("second.com", 40),
          evidencePolicyVersion: "recommendation-evidence-policy.v2",
          score: {
            ...candidate("second.com", 40).score,
            evidencePolicyVersion: "recommendation-evidence-policy.v2",
          },
        },
      ]),
    ).toThrow(TypeError);
  });
});
