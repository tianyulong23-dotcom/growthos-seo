import { describe, expect, it } from "vitest";

import { markRecommendation } from "../../src/modules/backlinks/domain/recommendations/recommendation-marker-policy.js";

describe("recommendation V2 marker policy", () => {
  it("requires safety, relevance, and an independent positive category", () => {
    expect(
      markRecommendation({
        passedRequiredExclusions: true,
        relevanceEvidence: ["PRODUCT_TOPIC_OVERLAP"],
        positiveEvidence: ["MARKET_LANGUAGE_MATCH"],
      }),
    ).toMatchObject({
      recommended: true,
      recommendationMarkerVersion: "recommendation-marker.v1",
    });
    expect(
      markRecommendation({
        passedRequiredExclusions: true,
        relevanceEvidence: ["PRODUCT_TOPIC_OVERLAP"],
        positiveEvidence: [],
      }),
    ).toMatchObject({
      recommended: false,
      recommendationReasonCodes: ["INDEPENDENT_POSITIVE_EVIDENCE_MISSING"],
    });
  });

  it("does not accept traffic, rank, spam, or email as hard exclusions", () => {
    expect(
      markRecommendation({
        passedRequiredExclusions: true,
        relevanceEvidence: ["AUDIENCE_OVERLAP"],
        positiveEvidence: ["COOPERATION_PATH"],
      }).recommended,
    ).toBe(true);
  });
});
