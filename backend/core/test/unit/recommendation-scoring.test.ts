import { describe, expect, it } from "vitest";

import type { EvidenceValue } from "../../src/modules/backlinks/domain/evidence/evidence.js";
import { recommendationGateRuleVersion } from "../../src/modules/backlinks/domain/recommendations/gates.js";
import {
  recommendationScoreComponentIds,
  recommendationScoreModelVersion,
  recommendationScoreWeights,
  recommendationWeightPolicyVersion,
  scoreRecommendation,
  type RecommendationScoreComponentId,
  type RecommendationScoreComponentInput,
} from "../../src/modules/backlinks/domain/recommendations/scoring.js";

const sourceReleaseId = "dataforseo-2026-07-25";
const evidencePolicyVersion = "recommendation-evidence-policy.v1";
const values: Readonly<Record<RecommendationScoreComponentId, number>> = {
  graph_authority_diversity: 0.8,
  topic_content_editorial_quality: 0.7,
  outbound_commercialization: 0.9,
  network_risk: 0.6,
  technical_health: 1,
};

function observed(
  value: number,
  evidenceRef: string,
): EvidenceValue<number> {
  return {
    availability: "observed",
    value,
    sourceType: "dataforseo",
    sourceReleaseId,
    confidence: 0.9,
    observedAt: "2026-07-25T00:00:00.000Z",
    stale: false,
    evidenceRefs: [evidenceRef],
  };
}

function components(): RecommendationScoreComponentInput[] {
  return recommendationScoreComponentIds.map((id) => ({
    id,
    evidence: observed(values[id], `score:${id}`),
    normalizedValue: values[id],
    normalizationRuleVersion: "recommendation-normalization.v1",
    reasonCode: `SUPPORTED_${id.toUpperCase()}`,
  }));
}

function score(input = components()) {
  return scoreRecommendation({
    ruleVersion: recommendationGateRuleVersion,
    evidencePolicyVersion,
    sourceReleaseId,
    components: input,
  });
}

describe("recommendation scoring", () => {
  it("uses the fixed, versioned five-dimensional policy", () => {
    const result = score();

    expect(result).toMatchObject({
      scoreModelVersion: recommendationScoreModelVersion,
      weightPolicyVersion: recommendationWeightPolicyVersion,
      ruleVersion: recommendationGateRuleVersion,
      evidencePolicyVersion,
      sourceReleaseId,
      total: 76.5,
      weights: {
        graph_authority_diversity: 35,
        topic_content_editorial_quality: 30,
        outbound_commercialization: 15,
        network_risk: 15,
        technical_health: 5,
      },
    });
    expect(result.weights).toEqual(recommendationScoreWeights);
    expect(result.components.map(({ id }) => id)).toEqual(
      recommendationScoreComponentIds,
    );
    expect(result.components[0]).toMatchObject({
      id: "graph_authority_diversity",
      rawValue: 0.8,
      normalizedValue: 0.8,
      normalizationRuleVersion: "recommendation-normalization.v1",
      weight: 35,
      points: 28,
      explanation: {
        reasonCode: "SUPPORTED_GRAPH_AUTHORITY_DIVERSITY",
        evidenceRefs: ["score:graph_authority_diversity"],
      },
    });
  });

  it("is deterministic and canonicalizes component input order", () => {
    expect(score([...components()].reverse())).toEqual(score());
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1])(
    "rejects unsafe normalized value %s",
    (normalizedValue) => {
      const input = components().map((component, index) =>
        index === 0 ? { ...component, normalizedValue } : component);
      expect(() => score(input)).toThrow(TypeError);
    },
  );

  it("rejects incomplete, duplicate, unavailable, or unexplained input", () => {
    const complete = components();
    const missing = complete.slice(0, 4);
    const duplicate = complete.map((component, index) =>
      index === 4
        ? { ...component, id: "graph_authority_diversity" as const }
        : component);
    const unavailable = complete.map((component, index) =>
      index === 0
        ? {
          ...component,
          evidence: {
            availability: "unavailable" as const,
            reason: "partial_scan" as const,
            sourceType: "dataforseo",
            sourceReleaseId,
            confidence: 0 as const,
            observedAt: "2026-07-25T00:00:00.000Z",
            stale: false,
            evidenceRefs: ["score:missing"],
          },
          normalizedValue: null,
        }
        : component);
    const unexplained = complete.map((component, index) =>
      index === 0 ? { ...component, reasonCode: " " } : component);

    for (const invalid of [missing, duplicate, unavailable, unexplained]) {
      expect(() => score(invalid)).toThrow(TypeError);
    }
  });

  it("does not expose custom dimensions as DA or DR", () => {
    expect(recommendationScoreComponentIds.join(" ")).not.toMatch(
      /\b(?:da|dr)\b/iu,
    );
  });
});
