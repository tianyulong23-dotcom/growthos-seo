import {
  commercialFitComponentIds,
  commercialFitHardGateIds,
  scoreCommercialRecommendationFit,
  type CommercialFitDecision,
  type CommercialFitComponentId,
  type CommercialFitEvidenceState,
  type CommercialFitGateInput,
  type CommercialFitScoreInput,
} from "./commercial-score-v4.js";

type JsonObject = Readonly<Record<string, unknown>>;

const componentSources = Object.freeze({
  semantic_relevance: ["relevance"],
  placement_attainability: [
    "target_cooperation_angle",
    "editorial_commercial_feasibility",
  ],
  relative_authority: ["dataforseo_authority_risk"],
  market_language_tier: ["market_language"],
  traffic_basic_quality: ["traffic_visibility", "technical"],
  evidence_completeness: [
    "relevance",
    "target_cooperation_angle",
    "market_language",
    "editorial_commercial_feasibility",
    "dataforseo_authority_risk",
    "traffic_visibility",
    "technical",
  ],
}) satisfies Readonly<Record<CommercialFitComponentId, readonly string[]>>;

const gateMap = Object.freeze({
  self_or_related_domain: "self_or_related_domain",
  existing_backlink_or_opportunity: "existing_backlink_or_opportunity",
  permanently_rejected_or_suppressed: "permanently_rejected_or_suppressed",
  unsafe_or_disallowed: "unsafe_or_malicious",
  pbn_or_link_farm: "pbn_or_link_farm",
}) satisfies Readonly<Record<
  Exclude<
    CommercialFitGateInput["id"],
    | "zero_topic_relevance"
    | "unrelated_industry"
    | "confirmed_inaccessible"
    | "mega_platform_without_placement_evidence"
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

function mappedComponent(
  oldScore: JsonObject,
  id: CommercialFitComponentId,
  fallbackCollectedAt: string,
  forceZero = false,
): CommercialFitScoreInput {
  const previous = componentSources[id].map((sourceId) =>
    componentById(oldScore, sourceId)
  );
  const usable = previous.filter((component) =>
    ["observed", "derived"].includes(evidenceState(component.state))
      && normalizedValue(component.normalizedValue) !== null
  );
  const normalized = forceZero
    ? 0
    : id === "evidence_completeness"
      ? usable.length / previous.length
      : usable.length === 0
        ? null
        : usable.reduce(
            (sum, component) =>
              sum + (normalizedValue(component.normalizedValue) ?? 0),
            0,
          ) / usable.length;
  const state: CommercialFitEvidenceState = forceZero || usable.length > 0
    ? "derived"
    : previous.some((component) =>
        evidenceState(component.state) === "manual_review"
      )
      ? "manual_review"
      : previous.some((component) =>
          evidenceState(component.state) === "insufficient_data"
        )
        ? "insufficient_data"
        : "unavailable";
  return Object.freeze({
    id,
    state,
    rawValue: forceZero
      ? "strict_market_mismatch"
      : normalized,
    normalizedValue: normalized,
    evidenceRefs: Object.freeze([
      ...new Set(previous.flatMap((component) =>
        stringValues(component.evidenceRefs)
      )),
      ...(forceZero
        ? ["historical-v2-gate:strict_market_mismatch"]
        : []),
    ]),
    collectedAt: previous
      .map((component) => collectedAt(
        component.collectedAt,
        fallbackCollectedAt,
      ))
      .sort()
      .at(-1) ?? fallbackCollectedAt,
    normalizationRuleVersion:
      `historical-v2-to-v4.${id}.v1`,
  });
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
  const components = commercialFitComponentIds.map((id) =>
    mappedComponent(
      oldScore,
      id,
      input.fallbackCollectedAt,
      id === "market_language_tier"
        && oldHitGates.has("strict_market_mismatch"),
    )
  );
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
  const technical = componentById(oldScore, "technical");
  const projectAuthority = finiteNumber(
    objectValue(objectValue(oldScore.details).authority).projectAuthority,
  );
  const candidateAuthority = normalizedValue(
    componentById(oldScore, "dataforseo_authority_risk").normalizedValue,
  );
  const siteType = typeof staticAssessment.siteType === "string"
    ? staticAssessment.siteType.toLowerCase()
    : null;
  const megaSiteTypes = new Set([
    "global_marketplace",
    "search_engine",
    "social_network",
    "code_hosting",
    "cloud_infrastructure",
    "encyclopedia",
  ]);
  const cooperationPages = stringValues(staticAssessment.cooperationPages);
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
    gate(
      "confirmed_inaccessible",
      "derived",
      staticAssessment.technicalAccessibility === 0
        || normalizedValue(technical.normalizedValue) === 0,
      Object.freeze([
        ...staticEvidence,
        ...stringValues(technical.evidenceRefs),
      ]),
    ),
    gate(
      "mega_platform_without_placement_evidence",
      "derived",
      projectAuthority !== null
        && candidateAuthority !== null
        && candidateAuthority * 100 - projectAuthority > 55
        && siteType !== null
        && megaSiteTypes.has(siteType)
        && cooperationPages.length === 0,
      Object.freeze([
        ...staticEvidence,
        ...stringValues(
          componentById(
            oldScore,
            "dataforseo_authority_risk",
          ).evidenceRefs,
        ),
      ]),
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
