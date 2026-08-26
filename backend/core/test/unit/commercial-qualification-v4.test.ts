import { describe, expect, it } from "vitest";

import {
  evaluateCommercialQualificationV4,
  rankCommercialQualificationsV4,
  scoreCommercialSemanticFit,
  type CommercialQualificationV4Input,
} from "../../src/modules/backlinks/domain/recommendations/commercial-qualification-v4.js";

function candidate(
  overrides: Partial<CommercialQualificationV4Input> = {},
): CommercialQualificationV4Input {
  return {
    canonicalDomain: "Example.com",
    metricScope: "TARGET_MARKET",
    trafficOrganicEtv: 30_000,
    spamScore: 10,
    authorityRank: 50,
    metricAttempt: 1,
    accessibilityDecision: "accessible",
    accessibilityAttempt: 1,
    marketDecision: "allowed",
    hardGateReasonCodes: [],
    semantic: {
      productRelevance: 60,
      topicRelevance: 60,
      keywordRelevance: 60,
      unrelated: false,
      attempt: 1,
      state: "observed",
    },
    ...overrides,
  };
}

describe("commercial qualification V4", () => {
  it("uses the frozen 50/30/20 semantic weighting", () => {
    expect(scoreCommercialSemanticFit({
      productRelevance: 100,
      topicRelevance: 50,
      keywordRelevance: 25,
    })).toBe(70);
  });

  it.each([
    [250, 10, 60, "eligible", "QUALIFICATION_PASSED"],
    [29_999, 29, 39, "eligible", "QUALIFICATION_PASSED"],
    [30_000, 10, 60, "eligible", "QUALIFICATION_PASSED"],
    [30_000, 30, 60, "manual_review", "SPAM_SCORE_REVIEW_REQUIRED"],
    [30_000, 69, 60, "manual_review", "SPAM_SCORE_REVIEW_REQUIRED"],
    [30_000, 70, 60, "ineligible", "SPAM_SCORE_HIGH_RISK"],
    [30_000, 100, 60, "ineligible", "SPAM_SCORE_HIGH_RISK"],
  ])(
    "uses traffic %s for ranking and applies the spam %s risk band",
    (traffic, spam, semantic, decision, reason) => {
      expect(evaluateCommercialQualificationV4(candidate({
        trafficOrganicEtv: traffic,
        spamScore: spam,
        semantic: {
          productRelevance: semantic,
          topicRelevance: semantic,
          keywordRelevance: semantic,
          unrelated: false,
          attempt: 1,
          state: "observed",
        },
      }))).toMatchObject({
        decision,
        decisionReasonCode: reason,
      });
    },
  );

  it("does not add a second semantic threshold outside the final fit score", () => {
    expect(evaluateCommercialQualificationV4(candidate({
      semantic: {
        productRelevance: 59,
        topicRelevance: 59,
        keywordRelevance: 59,
        unrelated: false,
        attempt: 2,
        state: "observed",
      },
    }))).toMatchObject({
      decision: "eligible",
      decisionReasonCode: "QUALIFICATION_PASSED",
    });
  });

  it("allows partial non-safety evidence and records reduced completeness", () => {
    expect(evaluateCommercialQualificationV4(candidate({
      trafficOrganicEtv: null,
      metricAttempt: 2,
    }))).toMatchObject({
      decision: "eligible",
      decisionReasonCode: "QUALIFICATION_PASSED_WITH_PARTIAL_EVIDENCE",
    });
    expect(evaluateCommercialQualificationV4(candidate({
      trafficOrganicEtv: null,
      metricAttempt: 3,
    }))).toMatchObject({
      decision: "eligible",
      decisionReasonCode: "QUALIFICATION_PASSED_WITH_PARTIAL_EVIDENCE",
    });
    expect(evaluateCommercialQualificationV4(candidate({
      semantic: {
        productRelevance: null,
        topicRelevance: null,
        keywordRelevance: null,
        unrelated: null,
        attempt: 2,
        state: "malformed",
      },
    }))).toMatchObject({
      decision: "eligible",
      decisionReasonCode: "QUALIFICATION_PASSED_WITH_PARTIAL_EVIDENCE",
    });
  });

  it("keeps explicit semantic unrelated evidence as a hard exclusion", () => {
    expect(evaluateCommercialQualificationV4(candidate({
      semantic: {
        productRelevance: 100,
        topicRelevance: 100,
        keywordRelevance: 100,
        unrelated: true,
        attempt: 1,
        state: "observed",
      },
    }))).toMatchObject({
      decision: "ineligible",
      decisionReasonCode: "SEMANTIC_UNRELATED",
    });
  });

  it("does not use authority as an eligibility gate", () => {
    expect(evaluateCommercialQualificationV4(candidate({
      authorityRank: 0,
    }))).toMatchObject({
      decision: "eligible",
      decisionReasonCode: "QUALIFICATION_PASSED",
    });
  });

  it.each(["mismatch", "forbidden"] as const)(
    "treats %s market evidence as a soft priority penalty",
    (marketDecision) => {
      expect(evaluateCommercialQualificationV4(candidate({
        marketDecision,
      }))).toMatchObject({
        decision: "eligible",
        decisionReasonCode: "QUALIFICATION_PASSED_MARKET_MISMATCH",
        marketDecision: "mismatch",
      });
    },
  );

  it("orders by semantic, market, authority, traffic, and canonical domain", () => {
    const result = rankCommercialQualificationsV4([
      evaluateCommercialQualificationV4(candidate({
        canonicalDomain: "zeta.com",
        authorityRank: 70,
      })),
      evaluateCommercialQualificationV4(candidate({
        canonicalDomain: "beta.com",
        authorityRank: 80,
        trafficOrganicEtv: 40_000,
      })),
      evaluateCommercialQualificationV4(candidate({
        canonicalDomain: "alpha.com",
        authorityRank: 80,
        trafficOrganicEtv: 40_000,
      })),
      evaluateCommercialQualificationV4(candidate({
        canonicalDomain: "mismatch.com",
        authorityRank: 90,
        marketDecision: "mismatch",
      })),
      evaluateCommercialQualificationV4(candidate({
        canonicalDomain: "top.com",
        authorityRank: 10,
        semantic: {
          productRelevance: 70,
          topicRelevance: 70,
          keywordRelevance: 70,
          unrelated: false,
          attempt: 1,
          state: "observed",
        },
      })),
    ]);
    expect(result.map(({ canonicalDomain }) => canonicalDomain)).toEqual([
      "top.com",
      "alpha.com",
      "beta.com",
      "zeta.com",
      "mismatch.com",
    ]);
  });
});
