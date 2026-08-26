import { describe, expect, it } from "vitest";

import {
  applyCommercialFitAdmissionThreshold,
  commercialFitComponentIds,
  commercialFitHardGateIds,
  commercialFitWeights,
  resolveProgressiveCommercialFitAdmissionThreshold,
  scoreCommercialRecommendationFit,
} from "../../src/modules/backlinks/domain/recommendations/commercial-score-v3.js";

const gates = () => commercialFitHardGateIds.map((id) => ({
  id,
  state: "observed" as const,
  matched: false,
  evidenceRefs: [`gate:${id}`],
}));

const components = () => commercialFitComponentIds.map((id) => ({
  id,
  state: "observed" as const,
  rawValue: 0.8,
  normalizedValue: 0.8,
  evidenceRefs: [`score:${id}`],
  collectedAt: "2026-08-10T00:00:00.000Z",
  normalizationRuleVersion: "commercial-fit-normalization.v3",
}));

describe("commercial recommendation fit score v3", () => {
  it("uses the new fixed seven-component 100 point policy", () => {
    const result = scoreCommercialRecommendationFit({
      gates: gates(),
      components: components(),
    });

    expect(result).toMatchObject({
      decision: "eligible",
      scoreModelVersion: "recommendation-commercial-fit.v3",
      ruleVersion: "recommendation-commercial-fit-rules.v3.2",
      total: 80,
      admission: {
        baselineThreshold: 50,
        appliedThreshold: 50,
        fallbackApplied: false,
      },
    });
    expect(commercialFitWeights).toEqual({
      semantic_relevance: 30,
      audience_partnership: 15,
      market_language_tier: 15,
      site_editorial_commercial: 15,
      dataforseo_authority_risk: 15,
      dataforseo_traffic_visibility: 5,
      safefetch_technical_access: 5,
    });
    expect(commercialFitHardGateIds).not.toContain(
      "forbidden_market_mismatch",
    );
  });

  it("rejects zero topic relevance before other scores can compensate", () => {
    const hardGates = gates();
    const gateIndex = hardGates.findIndex(
      ({ id }) => id === "zero_topic_relevance",
    );
    const relevanceIndex = commercialFitComponentIds.indexOf(
      "semantic_relevance",
    );
    if (gateIndex < 0 || relevanceIndex < 0) {
      throw new Error("commercial fit score contract is missing required entries");
    }
    const highComponents = components();
    const zeroRelevanceGate = hardGates[gateIndex];
    const semanticRelevance = highComponents[relevanceIndex];
    if (!zeroRelevanceGate || !semanticRelevance) {
      throw new Error("commercial fit score contract indexes are invalid");
    }
    hardGates[gateIndex] = {
      ...zeroRelevanceGate,
      matched: true,
    };
    highComponents[relevanceIndex] = {
      ...semanticRelevance,
      rawValue: 0,
      normalizedValue: 0,
    };

    expect(scoreCommercialRecommendationFit({
      gates: hardGates,
      components: highComponents,
    })).toMatchObject({
      decision: "ineligible",
      hitGates: ["zero_topic_relevance"],
    });
  });

  it("keeps the admission threshold fixed at 50", () => {
    const score54 = scoreCommercialRecommendationFit({
      gates: gates(),
      components: components().map((component) => ({
        ...component,
        rawValue: 0.54,
        normalizedValue: 0.54,
      })),
    });
    const score49 = scoreCommercialRecommendationFit({
      gates: gates(),
      components: components().map((component) => ({
        ...component,
        rawValue: 0.49,
        normalizedValue: 0.49,
      })),
    });

    const threshold = resolveProgressiveCommercialFitAdmissionThreshold([
      score54,
      score49,
    ]);
    expect(threshold).toBe(50);
    expect(
      [score54, score49].map(
        (score) =>
          applyCommercialFitAdmissionThreshold(score, threshold).decision,
      ),
    ).toEqual(["eligible", "ineligible"]);
  });

  it("never relaxes hard gates or uncertain critical safety evidence", () => {
    const hardGates = gates();
    const hardGate = hardGates[0];
    if (hardGate === undefined) throw new Error("missing hard gate fixture");
    hardGates[0] = { ...hardGate, matched: true };
    const hardGatedScore = scoreCommercialRecommendationFit({
      gates: hardGates,
      components: components(),
    });
    const uncertainSafetyGates = gates();
    const safetyGateIndex = uncertainSafetyGates.findIndex(
      ({ id }) => id === "pbn_or_link_farm",
    );
    const safetyGate = uncertainSafetyGates[safetyGateIndex];
    if (safetyGate === undefined) throw new Error("missing safety gate fixture");
    uncertainSafetyGates[safetyGateIndex] = {
      ...safetyGate,
      state: "insufficient_data",
      matched: null,
    };
    const uncertainScore = scoreCommercialRecommendationFit({
      gates: uncertainSafetyGates,
      components: components(),
    });

    const threshold = resolveProgressiveCommercialFitAdmissionThreshold([
      hardGatedScore,
      uncertainScore,
    ]);
    expect(threshold).toBe(50);
    expect(
      applyCommercialFitAdmissionThreshold(hardGatedScore, threshold).decision,
    ).toBe("ineligible");
    expect(
      applyCommercialFitAdmissionThreshold(uncertainScore, threshold).decision,
    ).toBe("insufficient_data");
  });

  it("scores partial non-safety evidence without blocking admission", () => {
    const reviewComponents = components();
    const audience = reviewComponents.find(
      ({ id }) => id === "audience_partnership",
    );
    if (audience === undefined) {
      throw new Error("missing audience partnership fixture");
    }
    reviewComponents[reviewComponents.indexOf(audience)] = {
      ...audience,
      state: "manual_review",
      normalizedValue: null,
    };
    const reviewScore = scoreCommercialRecommendationFit({
      gates: gates(),
      components: reviewComponents,
    });

    expect(reviewScore).toMatchObject({
      decision: "eligible",
      total: 68,
      missingEvidence: expect.arrayContaining([
        "score.audience_partnership",
      ]),
    });
    const threshold = resolveProgressiveCommercialFitAdmissionThreshold([
      reviewScore,
    ]);
    expect(threshold).toBe(50);
    expect(
      applyCommercialFitAdmissionThreshold(reviewScore, threshold).decision,
    ).toBe("eligible");
  });
});
