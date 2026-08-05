import type { EvidenceValue } from "../evidence/evidence.js";
import {
  copyRecommendationEvidenceValue,
  recommendationEvidenceIsUsable,
} from "./evidence-value.js";

export const recommendationScoreModelVersion =
  "recommendation-open-evidence-score.v1";
export const recommendationWeightPolicyVersion =
  "recommendation-open-evidence-weights.v1";

export const recommendationScoreComponentIds = [
  "graph_authority_diversity",
  "topic_content_editorial_quality",
  "outbound_commercialization",
  "network_risk",
  "technical_health",
] as const;

export type RecommendationScoreComponentId =
  (typeof recommendationScoreComponentIds)[number];

export const recommendationScoreWeights = Object.freeze({
  graph_authority_diversity: 35,
  topic_content_editorial_quality: 30,
  outbound_commercialization: 15,
  network_risk: 15,
  technical_health: 5,
}) satisfies Readonly<Record<RecommendationScoreComponentId, number>>;

export type RecommendationScoreComponentInput = Readonly<{
  id: RecommendationScoreComponentId;
  evidence: EvidenceValue<number>;
  normalizedValue: number | null;
  normalizationRuleVersion: string;
  reasonCode: string;
}>;

export type RecommendationScore = Readonly<{
  scoreModelVersion: typeof recommendationScoreModelVersion;
  weightPolicyVersion: typeof recommendationWeightPolicyVersion;
  ruleVersion: string;
  evidencePolicyVersion: string;
  sourceReleaseId: string;
  total: number;
  components: readonly Readonly<{
    id: RecommendationScoreComponentId;
    evidence: EvidenceValue<number>;
    rawValue: number;
    normalizedValue: number;
    normalizationRuleVersion: string;
    weight: number;
    points: number;
    explanation: Readonly<{
      reasonCode: string;
      evidenceRefs: readonly string[];
    }>;
  }>[];
  weights: Readonly<Record<RecommendationScoreComponentId, number>>;
  sourceReleaseIds: readonly string[];
}>;

function roundFour(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function assertRange(name: string, value: number, maximum: number): void {
  if (!Number.isFinite(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be finite and between 0 and ${maximum}`);
  }
}

function orderComponents(
  sourceReleaseId: string,
  components: readonly RecommendationScoreComponentInput[],
): readonly RecommendationScoreComponentInput[] {
  if (components.length !== recommendationScoreComponentIds.length) {
    throw new TypeError("Recommendation score requires every component");
  }

  const byId = new Map<
    RecommendationScoreComponentId,
    RecommendationScoreComponentInput
  >();
  for (const component of components) {
    if (!recommendationScoreComponentIds.includes(component.id)) {
      throw new TypeError(`Unknown recommendation score component ${component.id}`);
    }
    if (byId.has(component.id)) {
      throw new TypeError(`Duplicate recommendation score component ${component.id}`);
    }
    const evidence = copyRecommendationEvidenceValue(
      `Recommendation score component ${component.id}`,
      component.evidence,
      (value): value is number => typeof value === "number" &&
        Number.isFinite(value),
    );
    if (evidence.sourceReleaseId !== sourceReleaseId) {
      throw new TypeError(
        `Recommendation score component ${component.id} has mixed source release`,
      );
    }
    if (component.normalizedValue !== null) {
      assertRange(`${component.id}.normalizedValue`, component.normalizedValue, 1);
    }
    if (
      component.reasonCode.trim().length === 0 ||
      component.normalizationRuleVersion.trim().length === 0
    ) {
      throw new TypeError(`${component.id} requires scoring explanation`);
    }
    byId.set(component.id, Object.freeze({
      ...component,
      evidence,
      normalizationRuleVersion: component.normalizationRuleVersion.trim(),
      reasonCode: component.reasonCode.trim(),
    }));
  }

  return Object.freeze(recommendationScoreComponentIds.map(
    (id) => byId.get(id),
  ) as RecommendationScoreComponentInput[]);
}

export function findRecommendationScoreEvidenceGaps(input: Readonly<{
  sourceReleaseId: string;
  components: readonly RecommendationScoreComponentInput[];
}>): readonly string[] {
  if (input.sourceReleaseId.trim().length === 0) {
    throw new TypeError("Recommendation score requires a source release");
  }
  const ordered = orderComponents(
    input.sourceReleaseId.trim(),
    input.components,
  );
  return Object.freeze(ordered.flatMap((component) =>
    recommendationEvidenceIsUsable(component.evidence) &&
      component.normalizedValue !== null
      ? []
      : [`score.${component.id}`]
  ));
}

export function scoreRecommendation(input: Readonly<{
  ruleVersion: string;
  evidencePolicyVersion: string;
  sourceReleaseId: string;
  components: readonly RecommendationScoreComponentInput[];
}>): RecommendationScore {
  if (
    input.ruleVersion.trim().length === 0 ||
    input.evidencePolicyVersion.trim().length === 0 ||
    input.sourceReleaseId.trim().length === 0
  ) {
    throw new TypeError("Recommendation score requires contract versions");
  }
  const sourceReleaseId = input.sourceReleaseId.trim();
  const ordered = orderComponents(sourceReleaseId, input.components);
  const gaps = findRecommendationScoreEvidenceGaps({
    sourceReleaseId,
    components: ordered,
  });
  if (gaps.length > 0) {
    throw new TypeError(
      `Recommendation score has insufficient evidence: ${gaps.join(", ")}`,
    );
  }

  const components = Object.freeze(ordered.map((component) => {
    if (
      !recommendationEvidenceIsUsable(component.evidence) ||
      component.normalizedValue === null
    ) {
      throw new TypeError(
        `Recommendation score component ${component.id} is unavailable`,
      );
    }
    return Object.freeze({
      id: component.id,
      evidence: component.evidence,
      rawValue: component.evidence.value,
      normalizedValue: component.normalizedValue,
      normalizationRuleVersion: component.normalizationRuleVersion,
      weight: recommendationScoreWeights[component.id],
      points: roundFour(
        component.normalizedValue * recommendationScoreWeights[component.id],
      ),
      explanation: Object.freeze({
        reasonCode: component.reasonCode,
        evidenceRefs: component.evidence.evidenceRefs,
      }),
    });
  }));
  const sourceReleaseIds = Object.freeze([
    ...new Set(components.map(({ evidence }) => evidence.sourceReleaseId)),
  ]);

  return Object.freeze({
    scoreModelVersion: recommendationScoreModelVersion,
    weightPolicyVersion: recommendationWeightPolicyVersion,
    ruleVersion: input.ruleVersion.trim(),
    evidencePolicyVersion: input.evidencePolicyVersion.trim(),
    sourceReleaseId,
    total: roundFour(
      components.reduce((total, component) => total + component.points, 0),
    ),
    components,
    weights: recommendationScoreWeights,
    sourceReleaseIds,
  });
}
