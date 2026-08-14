import { describe, expect, it } from "vitest";

import {
  commercialFitComponentIds,
  commercialFitHardGateIds,
  commercialFitWeights,
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
      total: 80,
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
});
