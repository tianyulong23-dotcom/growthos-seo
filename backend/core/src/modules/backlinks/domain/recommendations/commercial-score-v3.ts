export const commercialRecommendationFitModelVersion =
  "recommendation-commercial-fit.v3";
export const commercialRecommendationFitRuleVersion =
  "recommendation-commercial-fit-rules.v3.1";

export const commercialFitComponentIds = [
  "semantic_relevance",
  "audience_partnership",
  "market_language_tier",
  "site_editorial_commercial",
  "dataforseo_authority_risk",
  "dataforseo_traffic_visibility",
  "safefetch_technical_access",
] as const;

export type CommercialFitComponentId =
  (typeof commercialFitComponentIds)[number];

export const commercialFitWeights = Object.freeze({
  semantic_relevance: 30,
  audience_partnership: 15,
  market_language_tier: 15,
  site_editorial_commercial: 15,
  dataforseo_authority_risk: 15,
  dataforseo_traffic_visibility: 5,
  safefetch_technical_access: 5,
}) satisfies Readonly<Record<CommercialFitComponentId, number>>;

export const commercialFitHardGateIds = [
  "self_or_related_domain",
  "existing_backlink_or_opportunity",
  "permanently_rejected_or_suppressed",
  "zero_topic_relevance",
  "unrelated_industry",
  "unsafe_or_disallowed",
  "pbn_or_link_farm",
  "forbidden_market_mismatch",
] as const;

export type CommercialFitHardGateId = (typeof commercialFitHardGateIds)[number];
export type CommercialFitEvidenceState =
  | "observed"
  | "derived"
  | "unavailable"
  | "insufficient_data"
  | "manual_review";

export type CommercialFitScoreInput = Readonly<{
  id: CommercialFitComponentId;
  state: CommercialFitEvidenceState;
  rawValue: number | string | boolean | null;
  normalizedValue: number | null;
  evidenceRefs: readonly string[];
  collectedAt: string;
  normalizationRuleVersion: string;
}>;

export type CommercialFitGateInput = Readonly<{
  id: CommercialFitHardGateId;
  state: CommercialFitEvidenceState;
  matched: boolean | null;
  evidenceRefs: readonly string[];
}>;

export type CommercialFitDecision = Readonly<{
  decision: "eligible" | "ineligible" | "insufficient_data" | "manual_review";
  scoreModelVersion: typeof commercialRecommendationFitModelVersion;
  ruleVersion: typeof commercialRecommendationFitRuleVersion;
  total: number | null;
  components: readonly Readonly<{
    id: CommercialFitComponentId;
    state: CommercialFitEvidenceState;
    rawValue: number | string | boolean | null;
    normalizedValue: number | null;
    weight: number;
    points: number | null;
    evidenceRefs: readonly string[];
    normalizationRuleVersion: string;
    collectedAt: string;
  }>[];
  hitGates: readonly CommercialFitHardGateId[];
  missingEvidence: readonly string[];
}>;

const criticalComponents = new Set<CommercialFitComponentId>([
  "semantic_relevance",
  "market_language_tier",
  "safefetch_technical_access",
]);

function roundFour(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export function scoreCommercialRecommendationFit(
  input: Readonly<{
    gates: readonly CommercialFitGateInput[];
    components: readonly CommercialFitScoreInput[];
  }>,
): CommercialFitDecision {
  const gates = new Map(input.gates.map((gate) => [gate.id, gate]));
  const components = new Map(
    input.components.map((component) => [component.id, component]),
  );
  if (
    gates.size !== commercialFitHardGateIds.length ||
    components.size !== commercialFitComponentIds.length
  ) {
    throw new TypeError(
      "Commercial fit requires every unique gate and component",
    );
  }

  const hitGates = commercialFitHardGateIds.filter(
    (id) => gates.get(id)?.matched === true,
  );
  const uncertainGates = commercialFitHardGateIds.filter((id) => {
    const gate = gates.get(id);
    return (
      gate?.matched === null ||
      gate?.state === "unavailable" ||
      gate?.state === "insufficient_data" ||
      gate?.state === "manual_review"
    );
  });
  const ordered = commercialFitComponentIds.map((id) => {
    const component = components.get(id);
    if (component === undefined) throw new TypeError(`Missing component ${id}`);
    if (
      component.normalizedValue !== null &&
      (!Number.isFinite(component.normalizedValue) ||
        component.normalizedValue < 0 ||
        component.normalizedValue > 1)
    ) {
      throw new TypeError(`${id}.normalizedValue must be between 0 and 1`);
    }
    const points =
      ["observed", "derived"].includes(component.state) &&
      component.normalizedValue !== null
        ? roundFour(component.normalizedValue * commercialFitWeights[id])
        : null;
    return Object.freeze({
      ...component,
      evidenceRefs: Object.freeze([...component.evidenceRefs]),
      weight: commercialFitWeights[id],
      points,
    });
  });
  const missingEvidence = ordered
    .filter((component) => component.points === null)
    .map((component) => `score.${component.id}`);
  const criticalMissing = ordered.some(
    (component) =>
      criticalComponents.has(component.id) && component.points === null,
  );
  const requiresManualReview = [...gates.values(), ...ordered].some(
    (item) => item.state === "manual_review",
  );
  const total = roundFour(
    ordered.reduce((sum, component) => sum + (component.points ?? 0), 0),
  );
  const decision =
    hitGates.length > 0
      ? "ineligible"
      : uncertainGates.length > 0 || criticalMissing
        ? requiresManualReview
          ? "manual_review"
          : "insufficient_data"
        : total >= 55
          ? "eligible"
          : "ineligible";

  return Object.freeze({
    decision,
    scoreModelVersion: commercialRecommendationFitModelVersion,
    ruleVersion: commercialRecommendationFitRuleVersion,
    total:
      decision === "insufficient_data" || decision === "manual_review"
        ? null
        : total,
    components: Object.freeze(ordered),
    hitGates: Object.freeze(hitGates),
    missingEvidence: Object.freeze([
      ...uncertainGates.map((id) => `gate.${id}`),
      ...missingEvidence,
    ]),
  });
}

export function rankCommercialRecommendationFits<
  T extends Readonly<{
    hostnameAscii: string;
    commercialScore: CommercialFitDecision;
  }>,
>(items: readonly T[]): readonly T[] {
  return Object.freeze(
    [...items].sort(
      (left, right) =>
        (right.commercialScore.total ?? -1) -
          (left.commercialScore.total ?? -1) ||
        left.hostnameAscii.localeCompare(right.hostnameAscii, "en"),
    ),
  );
}
