export const commercialRecommendationFitModelVersion =
  "recommendation-commercial-fit.v4";
export const commercialRecommendationFitRuleVersion =
  "recommendation-commercial-fit-rules.v4.2";
export const commercialFitBaselineAdmissionThreshold = 50;
export const commercialFitSpamReviewMinimum = 30;
export const commercialFitSpamHardRejectMinimum = 70;
export const commercialFitProgressiveAdmissionPolicyVersion =
  "commercial-fit-admission.v4";

export const commercialFitComponentIds = [
  "semantic_relevance",
  "placement_attainability",
  "relative_authority",
  "market_language_tier",
  "traffic_basic_quality",
  "evidence_completeness",
] as const;

export type CommercialFitComponentId =
  (typeof commercialFitComponentIds)[number];

export const commercialFitWeights = Object.freeze({
  semantic_relevance: 30,
  placement_attainability: 25,
  relative_authority: 20,
  market_language_tier: 15,
  traffic_basic_quality: 5,
  evidence_completeness: 5,
}) satisfies Readonly<Record<CommercialFitComponentId, number>>;

export const commercialFitHardGateIds = [
  "self_or_related_domain",
  "existing_backlink_or_opportunity",
  "permanently_rejected_or_suppressed",
  "zero_topic_relevance",
  "unrelated_industry",
  "unsafe_or_disallowed",
  "pbn_or_link_farm",
  "confirmed_inaccessible",
  "mega_platform_without_placement_evidence",
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

export type CommercialFitAdmission = Readonly<{
  policyVersion: typeof commercialFitProgressiveAdmissionPolicyVersion;
  baselineThreshold: typeof commercialFitBaselineAdmissionThreshold;
  appliedThreshold: number;
  fallbackApplied: false;
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
  admission: CommercialFitAdmission;
}>;

const commercialFitHardGateEvidenceIds = new Set<string>(
  commercialFitHardGateIds.map((id) => `gate.${id}`),
);

export function hasUnresolvedCommercialFitHardGate(
  score: Pick<CommercialFitDecision, "missingEvidence">,
): boolean {
  return score.missingEvidence.some((evidence) =>
    commercialFitHardGateEvidenceIds.has(evidence)
  );
}

const criticalSafetyGateIds = new Set<CommercialFitHardGateId>([
  "unsafe_or_disallowed",
  "pbn_or_link_farm",
  "confirmed_inaccessible",
]);

function roundFour(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function admission(): CommercialFitAdmission {
  return Object.freeze({
    policyVersion: commercialFitProgressiveAdmissionPolicyVersion,
    baselineThreshold: commercialFitBaselineAdmissionThreshold,
    appliedThreshold: commercialFitBaselineAdmissionThreshold,
    fallbackApplied: false,
  });
}

export function resolveProgressiveCommercialFitAdmissionThreshold(
  scores: readonly CommercialFitDecision[],
): number {
  void scores;
  return commercialFitBaselineAdmissionThreshold;
}

export function applyCommercialFitAdmissionThreshold(
  score: CommercialFitDecision,
  threshold: number,
): CommercialFitDecision {
  if (threshold !== commercialFitBaselineAdmissionThreshold) {
    throw new TypeError("Commercial fit admission threshold must be 50");
  }
  return Object.freeze({ ...score, admission: admission() });
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
      gate?.state === "insufficient_data"
    );
  });
  const uncertainSafetyGates = uncertainGates.filter((id) =>
    criticalSafetyGateIds.has(id)
  );
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
  const total = roundFour(
    ordered.reduce((sum, component) => sum + (component.points ?? 0), 0),
  );
  const decision =
    hitGates.length > 0
      ? "ineligible"
      : uncertainSafetyGates.length > 0
        ? "insufficient_data"
        : total >= commercialFitBaselineAdmissionThreshold
          ? "eligible"
          : "ineligible";

  return Object.freeze({
    decision,
    scoreModelVersion: commercialRecommendationFitModelVersion,
    ruleVersion: commercialRecommendationFitRuleVersion,
    total: decision === "insufficient_data" ? null : total,
    components: Object.freeze(ordered),
    hitGates: Object.freeze(hitGates),
    missingEvidence: Object.freeze([
      ...uncertainGates.map((id) => `gate.${id}`),
      ...missingEvidence,
    ]),
    admission: admission(),
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
