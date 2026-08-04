import { describe, expect, it } from "vitest";

import {
  toPublicAssessment,
} from "../../src/modules/backlinks/domain/assessments/public-assessment.js";
import {
  recommendationScoreComponentIds,
  recommendationScoreWeights,
} from "../../src/modules/backlinks/domain/recommendations/scoring.js";

const releaseId = "dataforseo-2026-07-25";
const generatedAt = "2026-07-25T01:00:00.000Z";

function currentComponents() {
  return recommendationScoreComponentIds.map((id) => ({
    id,
    evidence: {
      availability: "observed",
      value: 0.8,
      sourceType: id === "technical_health"
        ? "shared_crawler_site_audit"
        : "dataforseo",
      sourceReleaseId: releaseId,
      confidence: 0.93,
      observedAt: "2026-07-25T00:00:00.000Z",
      stale: false,
      evidenceRefs: [`score:${id}`],
    },
    rawValue: 0.8,
    normalizedValue: 0.8,
    normalizationRuleVersion: "recommendation-normalization.v1",
    weight: recommendationScoreWeights[id],
    points: recommendationScoreWeights[id] * 0.8,
    explanation: {
      reasonCode: `SUPPORTED_${id.toUpperCase()}`,
      evidenceRefs: [`score:${id}`],
    },
  }));
}

describe("public assessment DTO", () => {
  it("publishes source, release, freshness, and availability per component", () => {
    const assessment = toPublicAssessment({
      scoreId: "score-1",
      totalScore: 80,
      scoreModelVersion: "recommendation-open-evidence-score.v1",
      ruleVersion: "recommendation-gates.v1",
      components: currentComponents(),
      evidence: { sourceReleaseId: releaseId },
      generatedAt,
    });

    expect(assessment).toMatchObject({
      outcome: "review_recommended",
      score: 80,
      availability: "available",
      freshness: "fresh",
      readOnly: false,
      generatedAt,
      sourceReleaseIds: [releaseId],
      unavailableFields: [],
    });
    expect(assessment.components).toHaveLength(5);
    expect(assessment.components[0]).toMatchObject({
      id: "graph_authority_diversity",
      availability: "observed",
      sourceType: "dataforseo",
      sourceReleaseId: releaseId,
      confidence: 0.93,
      observedAt: "2026-07-25T00:00:00.000Z",
      stale: false,
      normalizedValue: 0.8,
    });
  });

  it("keeps legacy scores explainable without inventing unavailable zeroes", () => {
    const assessment = toPublicAssessment({
      scoreId: "legacy-score-1",
      totalScore: 72,
      scoreModelVersion: "legacy-score.v1",
      ruleVersion: "legacy-rules.v1",
      components: [{ id: "seo", points: 72 }],
      evidence: {
        provider: "dataforseo",
        sourceEvidenceIds: ["legacy-snapshot-1"],
      },
      generatedAt,
    });

    expect(assessment).toMatchObject({
      outcome: "insufficient_data",
      score: 72,
      availability: "unavailable",
      freshness: "stale",
      readOnly: true,
      unavailableFields: recommendationScoreComponentIds,
      staleFields: recommendationScoreComponentIds,
    });
    expect(assessment.components.every(
      ({ availability, normalizedValue, points }) =>
        availability === "unavailable" &&
        normalizedValue === null &&
        points === null,
    )).toBe(true);
    const serialized = JSON.stringify(assessment);
    expect(serialized).not.toContain('"value":0');
    expect(serialized.toLowerCase()).not.toContain("dataforseo");
  });

  it("reports stale observed evidence separately from availability", () => {
    const staleComponents = currentComponents().map((component) => ({
      ...component,
      evidence: {
        ...component.evidence,
        stale: true,
      },
    }));
    const assessment = toPublicAssessment({
      scoreId: "score-stale",
      totalScore: 80,
      scoreModelVersion: "recommendation-open-evidence-score.v1",
      ruleVersion: "recommendation-gates.v1",
      components: staleComponents,
      evidence: { sourceReleaseId: releaseId },
      generatedAt,
    });

    expect(assessment).toMatchObject({
      outcome: "insufficient_data",
      availability: "available",
      freshness: "stale",
      unavailableFields: [],
      staleFields: recommendationScoreComponentIds,
    });
  });
});
