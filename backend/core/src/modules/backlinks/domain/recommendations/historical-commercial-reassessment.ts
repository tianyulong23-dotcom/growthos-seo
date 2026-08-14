import {
  commercialFitComponentIds,
  commercialFitHardGateIds,
  scoreCommercialRecommendationFit,
  type CommercialFitDecision,
  type CommercialFitEvidenceState,
  type CommercialFitGateInput,
  type CommercialFitScoreInput,
} from "./commercial-score-v3.js";

type JsonObject = Readonly<Record<string, unknown>>;

const componentMap = Object.freeze({
  semantic_relevance: "relevance",
  audience_partnership: "target_cooperation_angle",
  market_language_tier: "market_language",
  site_editorial_commercial: "editorial_commercial_feasibility",
  dataforseo_authority_risk: "dataforseo_authority_risk",
  dataforseo_traffic_visibility: "traffic_visibility",
  safefetch_technical_access: "technical",
}) satisfies Readonly<Record<
  CommercialFitScoreInput["id"],
  string
>>;

const gateMap = Object.freeze({
  self_or_related_domain: "self_or_related_domain",
  existing_backlink_or_opportunity: "existing_backlink_or_opportunity",
  permanently_rejected_or_suppressed: "permanently_rejected_or_suppressed",
  unsafe_or_disallowed: "unsafe_or_malicious",
  pbn_or_link_farm: "pbn_or_link_farm",
  forbidden_market_mismatch: "strict_market_mismatch",
}) satisfies Readonly<Record<
  Exclude<
    CommercialFitGateInput["id"],
    "zero_topic_relevance" | "unrelated_industry"
  >,
  string
>>;

const evidenceStates = new Set<CommercialFitEvidenceState>([
  "observed",
  "derived",
  "unavailable",
  "insufficient_data",
  "manual_review",
]);

function objectValue(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValues(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? Object.freeze(value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      ))
    : Object.freeze([]);
}

function evidenceState(value: unknown): CommercialFitEvidenceState {
  return typeof value === "string"
      && evidenceStates.has(value as CommercialFitEvidenceState)
    ? value as CommercialFitEvidenceState
    : "unavailable";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedValue(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function rawValue(
  value: unknown,
): number | string | boolean | null {
  return typeof value === "number"
      || typeof value === "string"
      || typeof value === "boolean"
    ? value
    : null;
}

function collectedAt(value: unknown, fallback: string): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : fallback;
}

function componentById(
  score: JsonObject,
  id: string,
): JsonObject {
  const components = Array.isArray(score.components) ? score.components : [];
  return objectValue(components.find(
    (component) => objectValue(component).id === id,
  ));
}

function gate(
  id: CommercialFitGateInput["id"],
  state: CommercialFitEvidenceState,
  matched: boolean | null,
  evidenceRefs: readonly string[],
): CommercialFitGateInput {
  return Object.freeze({
    id,
    state,
    matched,
    evidenceRefs: Object.freeze([...evidenceRefs]),
  });
}

export type HistoricalCommercialReassessment =
  CommercialFitDecision & Readonly<{
    details: Readonly<{
      reassessmentReason: "HISTORICAL_V2_REASSESSED";
      sourceCandidateId: string;
      sourceScoreModelVersion: "recommendation-commercial-fit.v2";
      sourceRuleVersion: string | null;
      sourceEvidenceCollectedAt: string;
      projectContext: Readonly<{
        locale: string;
        countryCode: string;
      }>;
    }>;
  }>;

export function reassessHistoricalCommercialCandidate(input: Readonly<{
  candidateId: string;
  staticAssessment: unknown;
  gateDecision: unknown;
  commercialScore: unknown;
  fallbackCollectedAt: string;
  locale: string;
  countryCode: string;
}>): HistoricalCommercialReassessment {
  const staticAssessment = objectValue(input.staticAssessment);
  const oldGateDecision = objectValue(input.gateDecision);
  const oldScore = objectValue(input.commercialScore);
  const oldHitGates = new Set([
    ...stringValues(oldGateDecision.hitGates),
    ...stringValues(oldScore.hitGates),
  ]);
  const staticEvidence = stringValues(staticAssessment.evidenceRefs);
  const components = commercialFitComponentIds.map((id) => {
    const previous = componentById(oldScore, componentMap[id]);
    return Object.freeze({
      id,
      state: evidenceState(previous.state),
      rawValue: rawValue(previous.rawValue),
      normalizedValue: normalizedValue(previous.normalizedValue),
      evidenceRefs: Object.freeze([
        ...stringValues(previous.evidenceRefs),
      ]),
      collectedAt: collectedAt(
        previous.collectedAt,
        input.fallbackCollectedAt,
      ),
      normalizationRuleVersion:
        `historical-v2-reuse|${String(
          previous.normalizationRuleVersion ?? "unknown",
        )}`,
    });
  });
  const relevance = components.find(
    ({ id }) => id === "semantic_relevance",
  );
  if (relevance === undefined) {
    throw new TypeError("Historical v2 score is missing relevance");
  }
  const relevanceUsable = ["observed", "derived"].includes(relevance.state)
    && relevance.normalizedValue !== null;
  const mappedGates = Object.entries(gateMap).map(([newId, oldId]) => {
    const id = newId as keyof typeof gateMap;
    const matched = oldHitGates.has(oldId);
    const staticMatch = id === "unsafe_or_disallowed"
      ? staticAssessment.unsafeOrMalicious === true
      : id === "pbn_or_link_farm"
        ? staticAssessment.highConfidenceLinkFarm === true
        : false;
    return gate(
      id,
      "derived",
      matched || staticMatch,
      Object.freeze([
        ...staticEvidence,
        `historical-v2-gate:${oldId}`,
      ]),
    );
  });
  const gates = Object.freeze([
    ...mappedGates,
    gate(
      "zero_topic_relevance",
      relevanceUsable ? "derived" : relevance.state,
      relevanceUsable ? relevance.normalizedValue === 0 : null,
      relevance.evidenceRefs,
    ),
    gate(
      "unrelated_industry",
      relevanceUsable ? "derived" : relevance.state,
      relevanceUsable && (relevance.normalizedValue ?? 0) > 0 ? false : null,
      relevance.evidenceRefs,
    ),
  ].sort(
    (left, right) =>
      commercialFitHardGateIds.indexOf(left.id)
      - commercialFitHardGateIds.indexOf(right.id),
  ));
  const decision = scoreCommercialRecommendationFit({ gates, components });

  return Object.freeze({
    ...decision,
    details: Object.freeze({
      reassessmentReason: "HISTORICAL_V2_REASSESSED",
      sourceCandidateId: input.candidateId,
      sourceScoreModelVersion: "recommendation-commercial-fit.v2",
      sourceRuleVersion: typeof oldScore.ruleVersion === "string"
        ? oldScore.ruleVersion
        : null,
      sourceEvidenceCollectedAt: input.fallbackCollectedAt,
      projectContext: Object.freeze({
        locale: input.locale,
        countryCode: input.countryCode,
      }),
    }),
  });
}
