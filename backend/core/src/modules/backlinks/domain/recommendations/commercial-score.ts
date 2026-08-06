export const commercialRecommendationScoreModelVersion =
  "recommendation-commercial-fit.v2";
export const commercialRecommendationScoreRuleVersion =
  "recommendation-commercial-fit-rules.v2";

export const commercialScoreComponentIds = [
  "relevance",
  "market_language",
  "target_cooperation_angle",
  "editorial_commercial_feasibility",
  "dataforseo_authority_risk",
  "traffic_visibility",
  "technical",
] as const;

export type CommercialScoreComponentId =
  (typeof commercialScoreComponentIds)[number];

export const commercialScoreWeights = Object.freeze({
  relevance: 25,
  market_language: 15,
  target_cooperation_angle: 15,
  editorial_commercial_feasibility: 15,
  dataforseo_authority_risk: 15,
  traffic_visibility: 10,
  technical: 5,
}) satisfies Readonly<Record<CommercialScoreComponentId, number>>;

export const commercialHardGateIds = [
  "self_or_related_domain",
  "existing_backlink_or_opportunity",
  "permanently_rejected_or_suppressed",
  "unsafe_or_malicious",
  "pbn_or_link_farm",
  "strict_market_mismatch",
] as const;

export type CommercialHardGateId = (typeof commercialHardGateIds)[number];
export type CommercialEvidenceState =
  | "observed"
  | "derived"
  | "unavailable"
  | "insufficient_data"
  | "manual_review";

export type CommercialScoreInput = Readonly<{
  id: CommercialScoreComponentId;
  state: CommercialEvidenceState;
  rawValue: number | string | boolean | null;
  normalizedValue: number | null;
  evidenceRefs: readonly string[];
  collectedAt: string;
  normalizationRuleVersion: string;
}>;

export type CommercialGateInput = Readonly<{
  id: CommercialHardGateId;
  state: CommercialEvidenceState;
  matched: boolean | null;
  evidenceRefs: readonly string[];
}>;

export type CommercialScoreDecision = Readonly<{
  decision: "ready" | "excluded" | "insufficient_data" | "manual_review";
  scoreModelVersion: typeof commercialRecommendationScoreModelVersion;
  ruleVersion: typeof commercialRecommendationScoreRuleVersion;
  total: number | null;
  components: readonly Readonly<{
    id: CommercialScoreComponentId;
    state: CommercialEvidenceState;
    rawValue: number | string | boolean | null;
    normalizedValue: number | null;
    weight: number;
    points: number | null;
    evidenceRefs: readonly string[];
    normalizationRuleVersion: string;
    collectedAt: string;
  }>[];
  hitGates: readonly CommercialHardGateId[];
  missingEvidence: readonly string[];
}>;

function roundFour(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export function scoreCommercialRecommendation(input: Readonly<{
  gates: readonly CommercialGateInput[];
  components: readonly CommercialScoreInput[];
}>): CommercialScoreDecision {
  const gates = new Map(input.gates.map((gate) => [gate.id, gate]));
  const components = new Map(input.components.map(
    (component) => [component.id, component],
  ));
  if (
    gates.size !== commercialHardGateIds.length
    || components.size !== commercialScoreComponentIds.length
  ) {
    throw new TypeError("Commercial score requires every unique gate and component");
  }

  const hitGates = commercialHardGateIds.filter(
    (id) => gates.get(id)?.matched === true,
  );
  const uncertainGates = commercialHardGateIds.filter((id) => {
    const gate = gates.get(id);
    return gate?.matched === null
      || gate?.state === "unavailable"
      || gate?.state === "insufficient_data"
      || gate?.state === "manual_review";
  });
  const ordered = commercialScoreComponentIds.map((id) => {
    const component = components.get(id);
    if (component === undefined) throw new TypeError(`Missing component ${id}`);
    if (
      component.normalizedValue !== null
      && (
        !Number.isFinite(component.normalizedValue)
        || component.normalizedValue < 0
        || component.normalizedValue > 1
      )
    ) {
      throw new TypeError(`${id}.normalizedValue must be between 0 and 1`);
    }
    const usable = ["observed", "derived"].includes(component.state)
      && component.normalizedValue !== null;
    return Object.freeze({
      ...component,
      evidenceRefs: Object.freeze([...component.evidenceRefs]),
      weight: commercialScoreWeights[id],
      points: usable
        ? roundFour(component.normalizedValue! * commercialScoreWeights[id])
        : null,
    });
  });
  const missingEvidence = ordered
    .filter((component) => component.points === null)
    .map((component) => `score.${component.id}`);
  const requiresManualReview = [
    ...gates.values(),
    ...ordered,
  ].some((item) => item.state === "manual_review");
  const decision = hitGates.length > 0
    ? "excluded"
    : uncertainGates.length > 0 || missingEvidence.length > 0
      ? requiresManualReview ? "manual_review" : "insufficient_data"
      : "ready";

  return Object.freeze({
    decision,
    scoreModelVersion: commercialRecommendationScoreModelVersion,
    ruleVersion: commercialRecommendationScoreRuleVersion,
    total: decision === "ready"
      ? roundFour(ordered.reduce((sum, component) => sum + component.points!, 0))
      : null,
    components: Object.freeze(ordered),
    hitGates: Object.freeze(hitGates),
    missingEvidence: Object.freeze([
      ...uncertainGates.map((id) => `gate.${id}`),
      ...missingEvidence,
    ]),
  });
}

export function rankCommercialRecommendations<T extends Readonly<{
  hostnameAscii: string;
  commercialScore: CommercialScoreDecision;
}>>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items].sort((left, right) =>
    (right.commercialScore.total ?? -1) - (left.commercialScore.total ?? -1)
    || left.hostnameAscii.localeCompare(right.hostnameAscii, "en")
  ));
}
