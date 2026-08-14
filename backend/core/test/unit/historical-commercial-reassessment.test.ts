import { describe, expect, it } from "vitest";

import {
  reassessHistoricalCommercialCandidate,
} from "../../src/modules/backlinks/domain/recommendations/historical-commercial-reassessment.js";

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
  it("reuses immutable v2 evidence in a traceable generic v3 decision", () => {
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
      scoreModelVersion: "recommendation-commercial-fit.v3",
      ruleVersion: "recommendation-commercial-fit-rules.v3",
      total: 80,
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
        "historical-v2-reuse|commercial-fit-normalization.v2",
    });
    expect({ staticAssessment, gateDecision, commercialScore }).toEqual(before);
  });

  it("preserves a historical hard-gate outcome under v3", () => {
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

  it("fails closed when critical historical evidence is unavailable", () => {
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
      decision: "insufficient_data",
      total: null,
      missingEvidence: expect.arrayContaining([
        "score.safefetch_technical_access",
      ]),
    });
  });
});
