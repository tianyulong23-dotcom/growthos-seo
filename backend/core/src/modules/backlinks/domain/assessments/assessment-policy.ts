import { copyRecommendationEvidenceValue } from "../recommendations/evidence-value.js";
import {
  recommendationScoreComponentIds,
  recommendationScoreWeights,
  type RecommendationScoreComponentId,
  type RecommendationScoreComponentInput,
} from "../recommendations/scoring.js";

export const assessmentPolicyVersion = "backlink-assessment-policy.v1";
export const assessmentWeightPolicyVersion = "backlink-assessment-weights.v1";
export const assessmentDimensionIds = recommendationScoreComponentIds;
export const assessmentDimensionWeights = recommendationScoreWeights;
export type AssessmentDimensionId = RecommendationScoreComponentId;
export type AssessmentDimensionInput = RecommendationScoreComponentInput;
function roundFour(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}
function requireText(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
  return normalized;
}
function orderDimensions(dimensions: readonly AssessmentDimensionInput[]):
  readonly AssessmentDimensionInput[] {
  if (dimensions.length !== assessmentDimensionIds.length) {
    throw new TypeError("Assessment policy requires every dimension");
  }
  const byId = new Map<AssessmentDimensionId, AssessmentDimensionInput>();
  for (const dimension of dimensions) {
    if (!assessmentDimensionIds.includes(dimension.id) || byId.has(dimension.id)) {
      throw new TypeError(`Invalid assessment dimension ${dimension.id}`);
    }
    const evidence = copyRecommendationEvidenceValue(
      `Assessment dimension ${dimension.id}`,
      dimension.evidence,
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
    if (
      dimension.normalizedValue !== null &&
      (!Number.isFinite(dimension.normalizedValue) ||
        dimension.normalizedValue < 0 ||
        dimension.normalizedValue > 1)
    ) {
      throw new TypeError(`${dimension.id}.normalizedValue is invalid`);
    }
    if (
      evidence.availability === "unavailable" &&
      dimension.normalizedValue !== null
    ) {
      throw new TypeError(`${dimension.id} cannot score unavailable evidence`);
    }
    byId.set(dimension.id, Object.freeze({
      ...dimension,
      evidence,
      normalizationRuleVersion: requireText(
        `${dimension.id}.normalizationRuleVersion`, dimension.normalizationRuleVersion,
      ),
      reasonCode: requireText(`${dimension.id}.reasonCode`, dimension.reasonCode),
    }));
  }
  return Object.freeze(assessmentDimensionIds.map((id) => {
    const dimension = byId.get(id);
    if (dimension === undefined) {
      throw new TypeError(`Missing assessment dimension ${id}`);
    }
    return dimension;
  }));
}
export function assessBacklinkEvidence(input: Readonly<{
  evidenceContractVersion: string;
  dimensions: readonly AssessmentDimensionInput[];
  }>) {
  const ordered = orderDimensions(input.dimensions);
  const dimensions = Object.freeze(ordered.map((dimension) => {
    const unknown = dimension.evidence.availability === "unavailable" ||
      dimension.evidence.stale ||
      dimension.normalizedValue === null;
    const weight = assessmentDimensionWeights[dimension.id];
    return Object.freeze({
      id: dimension.id,
      status: unknown ? "unknown" as const : "assessed" as const,
      evidence: dimension.evidence,
      rawValue: dimension.evidence.availability === "unavailable"
        ? null
        : dimension.evidence.value,
      normalizedValue: dimension.normalizedValue,
      normalizationRuleVersion: dimension.normalizationRuleVersion,
      reasonCode: dimension.reasonCode,
      weight,
      points: unknown || dimension.normalizedValue === null
        ? null
        : roundFour(dimension.normalizedValue * weight),
    });
  }));
  const assessed = dimensions.filter(({ status }) => status === "assessed");
  const unavailableCount = dimensions.filter(({ evidence }) =>
    evidence.availability === "unavailable"
  ).length;
  const confidenceWeight = assessed.reduce((total, dimension) =>
    total + dimension.weight, 0);
  const totalScore = assessed.length === dimensions.length
    ? roundFour(dimensions.reduce(
      (total, dimension) => total + (dimension.points ?? 0),
      0,
    ))
    : null;

  return Object.freeze({
    policyVersion: assessmentPolicyVersion,
    weightPolicyVersion: assessmentWeightPolicyVersion,
    evidenceContractVersion: requireText(
      "Assessment evidenceContractVersion",
      input.evidenceContractVersion,
    ),
    status: totalScore === null ? "insufficient_data" : "complete",
    availability: unavailableCount === dimensions.length
      ? "unavailable"
      : unavailableCount > 0
      ? "partial"
      : "available",
    freshness: dimensions.some(({ evidence }) => evidence.stale)
      ? "stale"
      : "fresh",
    totalScore,
    confidence: confidenceWeight === 0
      ? 0
      : roundFour(assessed.reduce(
        (total, dimension) =>
          total + dimension.evidence.confidence * dimension.weight,
        0,
      ) / confidenceWeight),
    dimensions,
    sourceReleaseIds: Object.freeze([
      ...new Set(dimensions.map(({ evidence }) => evidence.sourceReleaseId)),
    ].sort()),
    evidenceRefs: Object.freeze([
      ...new Set(dimensions.flatMap(({ evidence }) => evidence.evidenceRefs)),
    ].sort()),
  });
}
export type AssessmentPolicyResult = ReturnType<typeof assessBacklinkEvidence>;
