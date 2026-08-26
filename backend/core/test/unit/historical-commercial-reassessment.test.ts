import { describe, expect, it } from "vitest";

import {
  reassessHistoricalCommercialCandidate,
} from "../../src/modules/backlinks/domain/recommendations/historical-commercial-reassessment.js";
import {
  commercialRecommendationFitRuleVersion,
} from "../../src/modules/backlinks/domain/recommendations/commercial-score-v4.js";

const componentIds = [
  "relevance",
  "target_cooperation_angle",
  "market_language",
  "editorial_commercial_feasibility",
  "dataforseo_authority_risk",
  "traffic_visibility",
  "technical",
] as const;

function historicalScore(
  normalizedValue = 0.8,
): Record<string, unknown> {
  return {
    ruleVersion: "recommendation-commercial-fit-rules.v2",
    components: componentIds.map((id) => ({
      id,
      state: "observed",
      rawValue: normalizedValue,
      normalizedValue,
      evidenceRefs: [`v2:${id}`],
      collectedAt: "2026-07-01T00:00:00.000Z",
      normalizationRuleVersion: "commercial-fit-normalization.v2",
    })),
    hitGates: [],
  };
}

describe("historical commercial reassessment", () => {
  it("reuses immutable v2 evidence in a traceable generic v4 decision", () => {
    const staticAssessment = {
      evidenceRefs: ["static:v2"],
      unsafeOrMalicious: false,
      highConfidenceLinkFarm: false,
    };
    const gateDecision = { hitGates: [] };
    const commercialScore = historicalScore();
    const before = structuredClone({
      staticAssessment,
      gateDecision,
      commercialScore,
    });

    const result = reassessHistoricalCommercialCandidate({
      candidateId: "candidate-v2",
      staticAssessment,
      gateDecision,
      commercialScore,
      fallbackCollectedAt: "2026-07-02T00:00:00.000Z",
      locale: "fr-FR",
      countryCode: "FR",
    });

    expect(result).toMatchObject({
      decision: "eligible",
      scoreModelVersion: "recommendation-commercial-fit.v4",
      ruleVersion: commercialRecommendationFitRuleVersion,
      total: 81,
      details: {
        reassessmentReason: "HISTORICAL_V2_REASSESSED",
        sourceCandidateId: "candidate-v2",
        sourceScoreModelVersion: "recommendation-commercial-fit.v2",
        sourceRuleVersion: "recommendation-commercial-fit-rules.v2",
        sourceEvidenceCollectedAt: "2026-07-02T00:00:00.000Z",
        projectContext: {
          locale: "fr-FR",
          countryCode: "FR",
        },
      },
    });
    expect(result.components[0]).toMatchObject({
      id: "semantic_relevance",
      evidenceRefs: ["v2:relevance"],
      collectedAt: "2026-07-01T00:00:00.000Z",
      normalizationRuleVersion:
        "historical-v2-to-v4.semantic_relevance.v1",
    });
    expect({ staticAssessment, gateDecision, commercialScore }).toEqual(before);
  });

  it("preserves a historical hard-gate outcome under v4", () => {
    const commercialScore = historicalScore();
    const relevance = (
      commercialScore.components as Record<string, unknown>[]
    )[0];
    if (relevance === undefined) {
      throw new Error("Missing historical relevance component");
    }
    relevance.rawValue = 0;
    relevance.normalizedValue = 0;

    expect(reassessHistoricalCommercialCandidate({
      candidateId: "zero-relevance",
      staticAssessment: {},
      gateDecision: { hitGates: ["zero_topic_relevance"] },
      commercialScore,
      fallbackCollectedAt: "2026-07-02T00:00:00.000Z",
      locale: "en-US",
      countryCode: "US",
    })).toMatchObject({
      decision: "ineligible",
      hitGates: ["zero_topic_relevance"],
    });
  });

  it("converts a historical market mismatch gate into a score penalty", () => {
    const result = reassessHistoricalCommercialCandidate({
      candidateId: "market-mismatch",
      staticAssessment: {},
      gateDecision: { hitGates: ["strict_market_mismatch"] },
      commercialScore: historicalScore(),
      fallbackCollectedAt: "2026-07-02T00:00:00.000Z",
      locale: "en-ZA",
      countryCode: "ZA",
    });

    expect(result).toMatchObject({
      decision: "eligible",
      hitGates: [],
      total: 69,
    });
    expect(
      result.components.find(({ id }) => id === "market_language_tier"),
    ).toMatchObject({
      normalizedValue: 0,
      points: 0,
      normalizationRuleVersion:
        "historical-v2-to-v4.market_language_tier.v1",
    });
  });

  it("scores partial historical evidence when safety evidence is available", () => {
    const commercialScore = historicalScore();
    const technical = (
      commercialScore.components as Record<string, unknown>[]
    ).at(-1);
    if (technical === undefined) {
      throw new Error("Missing historical technical component");
    }
    technical.state = "unavailable";
    technical.normalizedValue = null;

    expect(reassessHistoricalCommercialCandidate({
      candidateId: "missing-technical",
      staticAssessment: {},
      gateDecision: { hitGates: [] },
      commercialScore,
      fallbackCollectedAt: "2026-07-02T00:00:00.000Z",
      locale: "de-DE",
      countryCode: "DE",
    })).toMatchObject({
      decision: "eligible",
      total: 80.2857,
      missingEvidence: [],
    });
  });

  it("applies the generic mega-platform gate only with explicit relative authority evidence", () => {
    const commercialScore = historicalScore(0.9);
    commercialScore.details = {
      authority: { projectAuthority: 20 },
    };

    expect(reassessHistoricalCommercialCandidate({
      candidateId: "large-platform",
      staticAssessment: {
        siteType: "code_hosting",
        cooperationPages: [],
      },
      gateDecision: { hitGates: [] },
      commercialScore,
      fallbackCollectedAt: "2026-07-02T00:00:00.000Z",
      locale: "en-US",
      countryCode: "US",
    })).toMatchObject({
      decision: "ineligible",
      hitGates: expect.arrayContaining([
        "mega_platform_without_placement_evidence",
      ]),
    });
  });
});
