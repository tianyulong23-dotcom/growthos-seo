import type {
  EvidenceAvailability,
  EvidenceUnavailableReason,
  EvidenceValue,
} from "../evidence/evidence.js";
import {
  copyRecommendationEvidenceValue,
} from "../recommendations/evidence-value.js";
import {
  recommendationScoreComponentIds,
  recommendationScoreModelVersion,
  recommendationScoreWeights,
  type RecommendationScoreComponentId,
} from "../recommendations/scoring.js";

export const publicAssessmentOutcomes = [
  "low_risk",
  "review_recommended",
  "high_risk",
  "insufficient_data",
] as const;
export type PublicAssessmentOutcome =
  (typeof publicAssessmentOutcomes)[number];

export type PublicAssessmentComponent = Readonly<{
  id: RecommendationScoreComponentId;
  normalizedValue: number | null;
  weight: number;
  points: number | null;
  availability: EvidenceAvailability;
  sourceType: string;
  sourceReleaseId: string;
  confidence: number;
  observedAt: string;
  stale: boolean;
  evidenceRefs: readonly string[];
  unavailableReason: EvidenceUnavailableReason | null;
  derivationRuleVersion: string | null;
}>;

export type PublicAssessment = Readonly<{
  outcome: PublicAssessmentOutcome;
  score: number | null;
  availability: "available" | "partial" | "unavailable";
  freshness: "fresh" | "stale";
  scoreModelVersion: string;
  ruleVersion: string;
  generatedAt: string;
  readOnly: boolean;
  sourceReleaseIds: readonly string[];
  unavailableFields: readonly RecommendationScoreComponentId[];
  staleFields: readonly RecommendationScoreComponentId[];
  components: readonly PublicAssessmentComponent[];
}>;

export type PublicAssessmentSource = Readonly<{
  scoreId: unknown;
  totalScore: unknown;
  scoreModelVersion: unknown;
  ruleVersion: unknown;
  components: unknown;
  evidence: unknown;
  generatedAt: unknown;
}>;

type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toIsoString(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : new Date(0).toISOString();
}

function legacyEvidenceRefs(
  evidence: unknown,
  scoreId: string,
): readonly string[] {
  if (isObject(evidence) && Array.isArray(evidence.sourceEvidenceIds)) {
    const references = evidence.sourceEvidenceIds
      .filter(nonBlank)
      .map((reference) => reference.trim());
    if (references.length > 0) return Object.freeze(references);
  }
  return Object.freeze([`backlink-recommendation-score:${scoreId}`]);
}

function evidenceReleaseId(evidence: unknown): string | null {
  return isObject(evidence) && nonBlank(evidence.sourceReleaseId)
    ? evidence.sourceReleaseId.trim()
    : null;
}

function fallbackComponent(input: Readonly<{
  id: RecommendationScoreComponentId;
  sourceType: string;
  sourceReleaseId: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  readOnly: boolean;
}>): PublicAssessmentComponent {
  return Object.freeze({
    id: input.id,
    normalizedValue: null,
    weight: recommendationScoreWeights[input.id],
    points: null,
    availability: "unavailable",
    sourceType: input.sourceType,
    sourceReleaseId: input.sourceReleaseId,
    confidence: 0,
    observedAt: input.observedAt,
    stale: true,
    evidenceRefs: input.evidenceRefs,
    unavailableReason: input.readOnly ? "not_supported" : "not_observed",
    derivationRuleVersion: null,
  });
}

function parseComponent(
  id: RecommendationScoreComponentId,
  value: unknown,
): PublicAssessmentComponent | null {
  if (!isObject(value) || value.id !== id || !isObject(value.evidence)) {
    return null;
  }

  let evidence: EvidenceValue<number>;
  try {
    evidence = copyRecommendationEvidenceValue(
      `Public assessment component ${id}`,
      value.evidence as EvidenceValue<number>,
      finiteNumber,
    );
  } catch {
    return null;
  }

  const normalizedValue = value.normalizedValue;
  const points = value.points;
  if (
    evidence.availability === "unavailable" ||
    !finiteNumber(normalizedValue) ||
    normalizedValue < 0 ||
    normalizedValue > 1 ||
    !finiteNumber(points) ||
    points < 0 ||
    points > recommendationScoreWeights[id]
  ) {
    return null;
  }

  return Object.freeze({
    id,
    normalizedValue,
    weight: recommendationScoreWeights[id],
    points,
    availability: evidence.availability,
    sourceType: evidence.sourceType,
    sourceReleaseId: evidence.sourceReleaseId,
    confidence: evidence.confidence,
    observedAt: evidence.observedAt,
    stale: evidence.stale,
    evidenceRefs: evidence.evidenceRefs,
    unavailableReason: null,
    derivationRuleVersion: evidence.availability === "derived"
      ? evidence.derivationRuleVersion
      : null,
  });
}

export function toPublicAssessment(
  input: PublicAssessmentSource,
): PublicAssessment {
  const scoreId = nonBlank(input.scoreId)
    ? input.scoreId.trim()
    : "unavailable";
  const scoreModelVersion = nonBlank(input.scoreModelVersion)
    ? input.scoreModelVersion.trim()
    : "assessment-unavailable.v1";
  const ruleVersion = nonBlank(input.ruleVersion)
    ? input.ruleVersion.trim()
    : "assessment-unavailable.v1";
  const generatedAt = toIsoString(input.generatedAt);
  const readOnly = scoreModelVersion !== recommendationScoreModelVersion;
  const persisted = Array.isArray(input.components)
    ? new Map(input.components.flatMap((component) =>
      isObject(component) &&
        recommendationScoreComponentIds.some((id) => component.id === id)
        ? [[component.id as RecommendationScoreComponentId, component] as const]
        : []
    ))
    : new Map<RecommendationScoreComponentId, unknown>();
  const fallbackReleaseId = evidenceReleaseId(input.evidence)
    ?? `${readOnly ? "legacy" : "assessment"}-score:${scoreId}`;
  const fallbackRefs = legacyEvidenceRefs(input.evidence, scoreId);

  const components = Object.freeze(recommendationScoreComponentIds.map((id) =>
    parseComponent(id, persisted.get(id)) ??
      fallbackComponent({
        id,
        sourceType: readOnly ? "legacy_snapshot" : "assessment_snapshot",
        sourceReleaseId: fallbackReleaseId,
        observedAt: generatedAt,
        evidenceRefs: fallbackRefs,
        readOnly,
      })
  ));
  const unavailableFields = Object.freeze(components.flatMap((component) =>
    component.availability === "unavailable"
      ? [component.id]
      : []
  ));
  const staleFields = Object.freeze(components.flatMap((component) =>
    component.stale ? [component.id] : []
  ));
  const sourceReleaseIds = Object.freeze([
    ...new Set(components.map(({ sourceReleaseId }) => sourceReleaseId)),
  ]);
  const totalScore = typeof input.totalScore === "string"
    ? Number(input.totalScore)
    : input.totalScore;

  return Object.freeze({
    outcome: unavailableFields.length > 0 || staleFields.length > 0
      ? "insufficient_data"
      : "review_recommended",
    score: finiteNumber(totalScore) ? totalScore : null,
    availability: unavailableFields.length === components.length
      ? "unavailable"
      : unavailableFields.length > 0
      ? "partial"
      : "available",
    freshness: staleFields.length > 0 ? "stale" : "fresh",
    scoreModelVersion,
    ruleVersion,
    generatedAt,
    readOnly,
    sourceReleaseIds,
    unavailableFields,
    staleFields,
    components,
  });
}
