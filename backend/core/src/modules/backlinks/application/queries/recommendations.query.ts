import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";
import type {
  RecommendationRefillFailure,
} from "../../domain/recommendations/refill-failure.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

export const recommendationInventoryStatuses = [
  "ready",
  "claimed",
  "shown",
  "rejected",
  "stale_context",
  "accepted",
] as const;
export type RecommendationInventoryStatus =
  (typeof recommendationInventoryStatuses)[number];

export type RecommendationContactEvidence = {
  id: string;
  sourceUrl: string;
  observedAt: string;
  extractionMethod:
    | "mailto"
    | "visible_text"
    | "obfuscated_text"
    | "json_ld"
    | "manual";
  evidenceSnippet: string;
  confidence: number;
};
export type RecommendationContactCandidate = {
  id: string;
  normalizedEmail: string;
  domainRelation: string;
  confidence: number;
  inferredPurpose: string;
  purposeConfidence: number;
  guessed: boolean;
  version: number;
  eligible: boolean;
  contactReviewRequired: boolean;
  evidence: RecommendationContactEvidence[];
};
export type RecommendationContactJob = {
  id: string;
  batchId: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "partially_completed"
    | "no_contact_found"
    | "retry_scheduled"
    | "stale_context";
  candidateCount: number;
  evidenceCount: number;
  pagesVisited: number;
  lastErrorCode: string | null;
  terminalReasonCode:
    | "PUBLIC_EMAIL_FOUND"
    | "CONTACT_FORM_ONLY"
    | "LOGIN_REQUIRED"
    | "CAPTCHA_OR_BOT_CHALLENGE"
    | "ROBOTS_DISALLOWED"
    | "ACCESS_DENIED"
    | "NO_PUBLIC_EMAIL"
    | "SITE_UNREACHABLE"
    | "UNSUPPORTED_CONTENT"
    | "MANUAL_REVIEW_REQUIRED"
    | "COMPLETED_PARTIAL"
    | null;
  method: "none" | "static" | "browser" | "static_and_browser";
  lastErrorCategory: string | null;
  retryAfter: string | null;
  completedAt: string | null;
};
export type RecommendationFitDecision = {
  decision: "eligible";
  matchTier: "high_fit" | "qualified_fit";
  overallFit: number;
  scoreModelVersion: "recommendation-commercial-fit.v3";
  ruleVersion: string;
  reasonCodes: string[];
  matchedProducts: string[];
  matchedTopics: string[];
  matchedKeywords: string[];
  matchedTargetPages: string[];
  matchedAudiences: string[];
  market: {
    targetCountry: string;
    candidateCountry: string | null;
    targetLanguage: string;
    candidateLanguage: string | null;
    tier: "target_market" | "same_language_expansion";
    reasonCode: string;
  };
  cooperationAngles: string[];
  dataForSeo: {
    rank: number | null;
    traffic: number | null;
    backlinks: number | null;
    referringDomains: number | null;
    spamScore: number | null;
    evidenceRefs: string[];
    collectedAt: string;
  };
  safeFetch: {
    relatedContentPages: string[];
    evidenceUrls: string[];
    evidenceRefs: string[];
    failedUrls: string[];
    technicalAccessibility: number | null;
  };
  components: {
    id: string;
    state: string;
    rawValue: number | string | boolean | null;
    normalizedValue: number | null;
    weight: number;
    points: number | null;
    evidenceRefs: string[];
    normalizationRuleVersion: string;
    collectedAt: string;
  }[];
};
export type RecommendationContactDecision = {
  decision: "eligible";
  reasonCode: "PUBLIC_EMAIL_FOUND";
  sourceUrl: string;
  inferredPurpose: string;
  contactConfidence: number;
  purposeConfidence: number;
  evidenceConfidence: number;
  collectedAt: string;
  rulesVersion: string;
};
export type RecommendationListItem = {
  id: string;
  hostname: string;
  score: number;
  priority: "high" | "standard";
  candidateSource:
    | "paid_discovery"
    | "resource_library"
    | "mixed"
    | "existing_history";
  resourceType: "free" | "paid" | null;
  metricsSource:
    | "dataforseo"
    | "resource_library_snapshot"
    | "mixed_snapshot"
    | "historical_snapshot";
  risk: Readonly<{
    level: "low" | "medium" | "high" | "unknown";
    spamScore: number | null;
  }>;
  relevantPages: string[];
  emailSource: Readonly<{
    url: string;
    extractionMethod: RecommendationContactEvidence["extractionMethod"];
    observedAt: string;
  }>;
  status: RecommendationInventoryStatus;
  publicationStatus: "PUBLISHED";
  verifiedPublicEmailCount: number;
  recommendationContextVersionId: string;
  version: number;
  scoreModelVersion: string;
  ruleVersion: string;
  fitDecision: RecommendationFitDecision;
  contactDecision: RecommendationContactDecision;
  rootUrl: string;
  faviconUrl: string;
  acquiredAt: string;
  contactStatus: "contactable" | "running" | "review" | "not_found";
  contactJob: RecommendationContactJob | null;
  contacts: RecommendationContactCandidate[];
  recommendedContactCandidateId: string | null;
  existingOpportunityId: string | null;
  canCreateOpportunity: boolean;
  createBlockReason:
    | "existing_opportunity"
    | "no_eligible_contact"
    | null;
};
export type RecommendationsListInput = Readonly<{
  status?: RecommendationListItem["status"] | undefined;
  minScore?: number | undefined;
  limit: number;
  cursor?: string | undefined;
}>;
export type RecommendationPage = Readonly<{
  items: RecommendationListItem[];
  nextCursor: string | null;
  hasMore: boolean;
}>;
export type RecommendationInventorySummary = Readonly<{
  contractVersion: "backlinks.recommendation-operation.v1";
  runningBuildId: string;
  visiblePoolGeneration: number;
  visiblePoolState: "idle" | "building" | "active" | "awaiting_refresh";
  visiblePoolTargetCount: number;
  archivedVisiblePoolCount: number;
  visiblePoolArchivedAt: string | null;
  operationId: string | null;
  jobId: string | null;
  stage:
    | "blueprint"
    | "discovery"
    | "match"
    | "contact"
    | "publish"
    | "complete"
    | "pause";
  terminal: boolean;
  terminalState:
    | "TARGET_REACHED"
    | "PAUSED_BUDGET"
    | "PAUSED_PROVIDER"
    | "PROJECT_CONTEXT_REQUIRED"
    | "SUPPLY_FLOOR_REACHED"
    | null;
  targetCount: number;
  rawCount: number;
  fitCount: number;
  contactCount: number;
  publishedCount: number;
  unpublishedCount: number;
  tier:
    | "exact_product_target_market"
    | "same_topic_target_market"
    | "adjacent_industry_same_audience"
    | "resource_media_review_partner_ecosystem"
    | "same_language_expansion"
    | "curated_resource_library";
  round: number;
  window: number;
  paidCursor: Readonly<{
    tier:
      | "exact_product_target_market"
      | "same_topic_target_market"
      | "adjacent_industry_same_audience"
      | "resource_media_review_partner_ecosystem"
      | "same_language_expansion";
    round: number;
    window: number;
  }> | null;
  resourceCursor: Readonly<{
    tier: "curated_resource_library";
    round: number;
    window: number;
  }> | null;
  nextRetryAt: string | null;
  errorCode: string | null;
  recoveryAction:
    | "RESUME_OPERATION"
    | "WAIT_PROVIDER"
    | "COMPLETE_PROJECT_CONTEXT"
    | "RESTART_SERVICE"
    | "ACCEPT_SUPPLY_FLOOR"
    | "CONTACT_SUPPORT"
    | null;
  providerCallOccurred: boolean;
  providerActualCostMicros: number;
  providerReservedCostMicros: number;
  providerPaidCallCount: number;
  providerUnknownChargeCount: number;
  providerUniqueCallCount: number;
  recommendationContextVersionId: string | null;
  serverUpdatedAt: string | null;
  candidateReadyCount: number;
  rawCandidateCount: number;
  publishedContactReadyCount: number;
  historicalEmailHitRate: number;
  candidateLowWatermark: number;
  candidateHighWatermark: number;
  publishedLowWatermark: number;
  publishedHighWatermark: number;
  blueprintVersion: number | null;
  blueprintGenerator: "AI" | "DETERMINISTIC_FALLBACK" | null;
  latestRefillAt: string | null;
  nextRefillAt: string | null;
  providerCollectedAt: string | null;
  pauseReason: string | null;
  refillInFlight: boolean;
  refillState:
    | "idle"
    | "running"
    | "waiting_contact"
    | "completed"
    | "paused"
    | "exhausted";
  currentRefillTier:
    | "exact_product_target_market"
    | "same_topic_target_market"
    | "adjacent_industry_same_audience"
    | "resource_media_review_partner_ecosystem"
    | "same_language_expansion"
    | "curated_resource_library";
  currentRefillRound: number;
  attemptedRefillTiers: Readonly<{
    tier: RecommendationInventorySummary["currentRefillTier"];
    round: number;
    window: number;
  }>[];
  terminationReason:
    | "HIGH_WATERMARK"
    | "BUDGET"
    | "PROVIDER_UNAVAILABLE"
    | "TIERS_EXHAUSTED"
    | "PROJECT_CONTEXT"
    | null;
  eliminationReasonCounts: Readonly<{
    reasonCode: string;
    count: number;
  }>[];
  refillJob: Readonly<{
    operationId: string;
    id: string;
    workflowId: string;
    status:
      | "queued"
      | "running"
      | "waiting_provider"
      | "partial_success"
      | "success"
      | "failed"
      | "cancelled";
    step: string | null;
    progress: number;
    errorCode: string | null;
    errorMessage: string | null;
    failure: RecommendationRefillFailure | null;
    retryCount: number;
    lowWatermark: number;
    highWatermark: number;
    refillWindowKey: string;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
    updatedAt: string;
    version: number;
  }> | null;
  contactBatch: Readonly<{
    id: string;
    status: "running" | "completed" | "stale_context";
    totalJobCount: number;
    terminalJobCount: number;
    publishedCount: number;
    unpublishedCount: number;
    retryableUnpublishedCount: number;
    nextRetryAt: string | null;
    reasonCounts: {
      reasonCode: string;
      count: number;
    }[];
    startedAt: string;
    completedAt: string | null;
  }> | null;
}>;
export type RecommendationsQuery = Readonly<{
  listRecommendations(
    context: ResolvedProjectContext,
    input: RecommendationsListInput,
  ): Promise<RecommendationPage>;
  getRecommendationInventoryStatus(
    context: ResolvedProjectContext,
    runningBuildId?: string,
  ): Promise<RecommendationInventorySummary>;
}>;
export type RecommendationsQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;
type Cursor = readonly [number, string, string];

const invalidCursor = () => new BacklinkError({
  code: backlinkErrorCodes.invalidRequest,
  message: "Recommendation cursor is invalid.",
  fieldErrors: [{ field: "cursor", message: "Use a cursor returned by this API." }],
});

function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length !== 3
      || typeof parsed[0] !== "number"
      || !Number.isFinite(parsed[0])
      || typeof parsed[1] !== "string"
      || parsed[1].length === 0
      || typeof parsed[2] !== "string"
      || parsed[2].length === 0
    ) {
      throw invalidCursor();
    }
    return parsed as unknown as Cursor;
  } catch (error) {
    if (error instanceof BacklinkError) throw error;
    throw invalidCursor();
  }
}

const encodeCursor = (item: RecommendationListItem) =>
  Buffer.from(JSON.stringify([item.score, item.hostname, item.id]))
    .toString("base64url");

const toIsoString = (value: unknown) => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : new Date(0).toISOString();
};
const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const arrayValue = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];
const nullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const stringArray = (value: unknown): string[] =>
  arrayValue(value).map(String).filter(Boolean);
const nullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const paidCandidateSourceTypes = new Set([
  "BLUEPRINT_SERP_STANDARD_QUEUE",
  "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
  "VERIFIED_COMPETITOR_BACKLINK_GAP",
  "USER_REFERRING_DOMAINS",
]);

function recommendationSource(
  sourceTypes: readonly string[],
  evidenceRefs: readonly string[],
): Pick<
  RecommendationListItem,
  "candidateSource" | "resourceType" | "metricsSource"
> {
  const resourceEvidence = evidenceRefs.find(
    (reference) => reference.startsWith("resource-type:"),
  );
  const resourceType = resourceEvidence?.slice("resource-type:".length);
  const normalizedResourceType = resourceType === "free" || resourceType === "paid"
    ? resourceType
    : null;
  const hasResource = sourceTypes.includes("CURATED_RESOURCE_LIBRARY")
    || normalizedResourceType !== null;
  const hasPaidDiscovery = sourceTypes.some(
    (sourceType) => paidCandidateSourceTypes.has(sourceType),
  ) || evidenceRefs.some((reference) => reference.startsWith("dataforseo:"));

  if (hasResource && hasPaidDiscovery) {
    return {
      candidateSource: "mixed",
      resourceType: normalizedResourceType,
      metricsSource: "mixed_snapshot",
    };
  }
  if (hasResource) {
    return {
      candidateSource: "resource_library",
      resourceType: normalizedResourceType,
      metricsSource: "resource_library_snapshot",
    };
  }
  if (hasPaidDiscovery) {
    return {
      candidateSource: "paid_discovery",
      resourceType: null,
      metricsSource: "dataforseo",
    };
  }
  return {
    candidateSource: "existing_history",
    resourceType: null,
    metricsSource: "historical_snapshot",
  };
}

function recommendationRisk(
  spamScore: number | null,
): RecommendationListItem["risk"] {
  return Object.freeze({
    spamScore,
    level: spamScore === null
      ? "unknown"
      : spamScore >= 30
        ? "high"
        : spamScore >= 10 ? "medium" : "low",
  });
}

function cursorWindow(
  attempts: RecommendationInventorySummary["attemptedRefillTiers"],
  tier: RecommendationInventorySummary["currentRefillTier"] | null,
  round: number | null,
): number {
  if (tier === null || round === null) return 1;
  return attempts.findLast(
    (attempt) => attempt.tier === tier && attempt.round === round,
  )?.window ?? 1;
}

function recommendationTerminalState(
  terminationReason: RecommendationInventorySummary["terminationReason"],
  publishedCount: number,
  targetCount: number,
): RecommendationInventorySummary["terminalState"] {
  if (publishedCount >= targetCount || terminationReason === "HIGH_WATERMARK") {
    return "TARGET_REACHED";
  }
  switch (terminationReason) {
    case "BUDGET":
      return "PAUSED_BUDGET";
    case "PROVIDER_UNAVAILABLE":
      return "PAUSED_PROVIDER";
    case "PROJECT_CONTEXT":
      return "PROJECT_CONTEXT_REQUIRED";
    case "TIERS_EXHAUSTED":
      return "SUPPLY_FLOOR_REACHED";
    default:
      return null;
  }
}

function recommendationStage(input: Readonly<{
  terminalState: RecommendationInventorySummary["terminalState"];
  refillState: RecommendationInventorySummary["refillState"];
  refillJob: Record<string, unknown> | null;
  contactBatch: Record<string, unknown> | null;
  blueprintVersion: number | null;
}>): RecommendationInventorySummary["stage"] {
  if (
    input.terminalState === "PAUSED_BUDGET"
    || input.terminalState === "PAUSED_PROVIDER"
  ) {
    return "pause";
  }
  if (input.terminalState !== null) return "complete";
  if (input.blueprintVersion === null) return "blueprint";
  if (
    input.refillState === "waiting_contact"
    || input.contactBatch?.status === "running"
  ) {
    return "contact";
  }
  const step = nullableString(input.refillJob?.step);
  if (step?.includes("score") === true || step?.includes("match") === true) {
    return "match";
  }
  if (
    step?.includes("contact") === true
    || step?.includes("publish") === true
  ) {
    return "publish";
  }
  if (
    input.refillState === "running"
    || input.refillJob?.status === "queued"
    || input.refillJob?.status === "running"
    || input.refillJob?.status === "waiting_provider"
  ) {
    return "discovery";
  }
  return "complete";
}

function toContactEvidence(value: unknown): RecommendationContactEvidence {
  const item = objectValue(value);
  return {
    id: String(item.id),
    sourceUrl: String(item.sourceUrl),
    observedAt: toIsoString(item.observedAt),
    extractionMethod:
      item.extractionMethod as RecommendationContactEvidence["extractionMethod"],
    evidenceSnippet: String(item.evidenceSnippet),
    confidence: Number(item.confidence),
  };
}

function toContactCandidate(value: unknown): RecommendationContactCandidate {
  const item = objectValue(value);
  return {
    id: String(item.id),
    normalizedEmail: String(item.normalizedEmail),
    domainRelation: String(item.domainRelation),
    confidence: Number(item.confidence),
    inferredPurpose: String(item.inferredPurpose),
    purposeConfidence: Number(item.purposeConfidence),
    guessed: item.guessed === true,
    version: Number(item.version),
    eligible: item.eligible === true,
    contactReviewRequired: item.contactReviewRequired === true,
    evidence: arrayValue(item.evidence).map(toContactEvidence),
  };
}

function toContactJob(value: unknown): RecommendationContactJob | null {
  if (value === null || value === undefined) return null;
  const item = objectValue(value);
  return {
    id: String(item.id),
    batchId: String(item.batchId),
    status: item.status as RecommendationContactJob["status"],
    candidateCount: Number(item.candidateCount),
    evidenceCount: Number(item.evidenceCount),
    pagesVisited: Number(item.pagesVisited),
    lastErrorCode: nullableString(item.lastErrorCode),
    terminalReasonCode: nullableString(item.terminalReasonCode) as
      RecommendationContactJob["terminalReasonCode"],
    method: item.method as RecommendationContactJob["method"],
    lastErrorCategory: nullableString(item.lastErrorCategory),
    retryAfter: item.retryAfter === null || item.retryAfter === undefined
      ? null
      : toIsoString(item.retryAfter),
    completedAt: item.completedAt === null || item.completedAt === undefined
      ? null
      : toIsoString(item.completedAt),
  };
}

function toWebsiteUrl(hostname: string, value: unknown): string {
  try {
    return new URL(String(value)).toString();
  } catch {
    return `https://${hostname}/`;
  }
}

function toFitDecision(
  value: unknown,
  score: number,
  scoreModelVersion: unknown,
  ruleVersion: unknown,
): RecommendationFitDecision {
  const fit = objectValue(value);
  const fitTotal = nullableNumber(fit.total);
  const fitRuleVersion = String(fit.ruleVersion ?? "");
  if (
    fit.decision !== "eligible"
    || fit.scoreModelVersion !== "recommendation-commercial-fit.v3"
    || scoreModelVersion !== "recommendation-commercial-fit.v3"
    || fitTotal === null
    || Math.abs(fitTotal - score) > 0.0001
    || fitRuleVersion === ""
    || fitRuleVersion !== String(ruleVersion)
  ) {
    throw new Error("PUBLISHED_RECOMMENDATION_FIT_SCORE_MISMATCH");
  }
  const details = objectValue(fit.details);
  const components: RecommendationFitDecision["components"] =
    arrayValue(fit.components).map((value) => {
      const component = objectValue(value);
      return {
        id: String(component.id),
        state: String(component.state),
        rawValue: (component.rawValue ?? null) as
          number | string | boolean | null,
        normalizedValue: nullableNumber(component.normalizedValue),
        weight: Number(component.weight),
        points: nullableNumber(component.points),
        evidenceRefs: stringArray(component.evidenceRefs),
        normalizationRuleVersion: String(
          component.normalizationRuleVersion,
        ),
        collectedAt: toIsoString(component.collectedAt),
      };
    });
  if (details.reassessmentReason === "HISTORICAL_V2_REASSESSED") {
    const projectContext = objectValue(details.projectContext);
    const targetCountry = String(projectContext.countryCode ?? "")
      .trim()
      .toUpperCase();
    const targetLanguage = String(projectContext.locale ?? "")
      .trim()
      .split(/[-_]/u)[0]
      ?.toLowerCase() ?? "";
    if (targetCountry === "" || targetLanguage === "") {
      throw new Error("PUBLISHED_RECOMMENDATION_HISTORICAL_CONTEXT_MISSING");
    }
    const evidenceRefs = (componentIds: readonly string[]) => [
      ...new Set(components
        .filter(({ id }) => componentIds.includes(id))
        .flatMap(({ evidenceRefs }) => evidenceRefs)),
    ];
    const technicalComponent = components.find(
      ({ id }) => id === "safefetch_technical_access",
    );
    return {
      decision: "eligible",
      matchTier: fitTotal >= 75 ? "high_fit" : "qualified_fit",
      overallFit: fitTotal,
      scoreModelVersion: "recommendation-commercial-fit.v3",
      ruleVersion: fitRuleVersion,
      reasonCodes: [
        "HISTORICAL_V2_REASSESSED",
        "SAME_LANGUAGE_EXPANSION",
      ],
      matchedProducts: [],
      matchedTopics: [],
      matchedKeywords: [],
      matchedTargetPages: [],
      matchedAudiences: [],
      market: {
        targetCountry,
        candidateCountry: null,
        targetLanguage,
        candidateLanguage: null,
        tier: "same_language_expansion",
        reasonCode: "SAME_LANGUAGE_EXPANSION",
      },
      cooperationAngles: [],
      dataForSeo: {
        rank: null,
        traffic: null,
        backlinks: null,
        referringDomains: null,
        spamScore: null,
        evidenceRefs: evidenceRefs([
          "dataforseo_authority_risk",
          "dataforseo_traffic_visibility",
        ]),
        collectedAt: toIsoString(details.sourceEvidenceCollectedAt),
      },
      safeFetch: {
        relatedContentPages: [],
        evidenceUrls: [],
        evidenceRefs: evidenceRefs(["safefetch_technical_access"]),
        failedUrls: [],
        technicalAccessibility:
          technicalComponent?.normalizedValue ?? null,
      },
      components,
    };
  }
  const market = objectValue(details.market);
  const dataForSeo = objectValue(details.dataForSeo);
  const safeFetch = objectValue(details.safeFetch);
  return {
    decision: "eligible",
    matchTier: details.matchTier as RecommendationFitDecision["matchTier"],
    overallFit: fitTotal,
    scoreModelVersion: "recommendation-commercial-fit.v3",
    ruleVersion: fitRuleVersion,
    reasonCodes: stringArray(details.reasonCodes),
    matchedProducts: stringArray(details.matchedProducts),
    matchedTopics: stringArray(details.matchedTopics),
    matchedKeywords: stringArray(details.matchedKeywords),
    matchedTargetPages: stringArray(details.matchedTargetPages),
    matchedAudiences: stringArray(details.matchedAudiences),
    market: {
      targetCountry: String(market.targetCountry),
      candidateCountry: nullableString(market.candidateCountry),
      targetLanguage: String(market.targetLanguage),
      candidateLanguage: nullableString(market.candidateLanguage),
      tier: market.tier as RecommendationFitDecision["market"]["tier"],
      reasonCode: String(market.reasonCode),
    },
    cooperationAngles: stringArray(details.cooperationAngles),
    dataForSeo: {
      rank: nullableNumber(dataForSeo.rank),
      traffic: nullableNumber(dataForSeo.traffic),
      backlinks: nullableNumber(dataForSeo.backlinks),
      referringDomains: nullableNumber(dataForSeo.referringDomains),
      spamScore: nullableNumber(dataForSeo.spamScore),
      evidenceRefs: stringArray(dataForSeo.evidenceRefs),
      collectedAt: toIsoString(dataForSeo.collectedAt),
    },
    safeFetch: {
      relatedContentPages: stringArray(safeFetch.relatedContentPages),
      evidenceUrls: stringArray(safeFetch.evidenceUrls),
      evidenceRefs: stringArray(safeFetch.evidenceRefs),
      failedUrls: stringArray(safeFetch.failedUrls),
      technicalAccessibility:
        nullableNumber(safeFetch.technicalAccessibility),
    },
    components,
  };
}

export function createRecommendationsQuery(
  client: RecommendationsQueryClient,
): RecommendationsQuery {
  return Object.freeze({
    async listRecommendations(context, input) {
      const after = decodeCursor(input.cursor);
      const result = await client.query(`
        SELECT r.id,p.hostname_ascii "hostname",
               s.total_score::double precision "score",
               i.status,
               i.publication_status "publicationStatus",
               i.verified_public_email_count "verifiedPublicEmailCount",
               i.recommendation_context_version_id
                 "recommendationContextVersionId",
               i.version,i.created_at "acquiredAt",
               s.score_model_version "scoreModelVersion",
               s.rule_version "ruleVersion",s.generated_at "scoreGeneratedAt",
               fit.commercial_score "fitScore",
               fit.source_types "sourceTypes",
               snapshot.source_url "contactDecisionSourceUrl",
               snapshot.inferred_purpose "contactDecisionPurpose",
               snapshot.contact_confidence "contactDecisionConfidence",
               snapshot.purpose_confidence
                 "contactDecisionPurposeConfidence",
               snapshot.evidence_confidence
                 "contactDecisionEvidenceConfidence",
               snapshot.collected_at "contactDecisionCollectedAt",
               snapshot.rules_version "contactDecisionRulesVersion",
               COALESCE(
                 j.root_url,'https://' || p.hostname_ascii || '/'
               ) "rootUrl",
               CASE
                 WHEN o.id IS NOT NULL THEN 'existing_opportunity'
                 ELSE NULL
               END "createBlockReason",
               o.id IS NULL "canCreateOpportunity",
               c.contacts,
               i.default_contact_candidate_id
                 "recommendedContactCandidateId",
               'contactable' "contactStatus",
               CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object(
                 'id',j.id,
                 'batchId',j.batch_id,
                 'status',j.status,
                 'candidateCount',j.candidate_count,
                 'evidenceCount',j.evidence_count,
                 'pagesVisited',j.pages_visited,
                 'lastErrorCode',j.last_error_code,
                 'terminalReasonCode',j.terminal_reason_code,
                 'method',j.method,
                 'lastErrorCategory',j.last_error_category,
                 'retryAfter',j.retry_after,
                 'completedAt',j.completed_at
               ) END "contactJob",
               o.id "existingOpportunityId"
          FROM backlink_recommendation_inventory i
          JOIN backlink_commercial_inventory_policies AS policy ON
            (
              policy.organization_id,policy.workspace_id,
              policy.website_project_id,policy.project_context_version_id
            )=(
              i.organization_id,i.workspace_id,
              i.website_project_id,i.recommendation_context_version_id
            )
           AND policy.visible_pool_state='active'
           AND policy.visible_pool_generation=i.visible_pool_generation
          JOIN backlink_recommendations r ON
            (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
            (i.organization_id,i.workspace_id,i.website_project_id,
             i.recommendation_id)
          JOIN backlink_prospects p ON
            (p.organization_id,p.workspace_id,p.website_project_id,p.id)=
            (i.organization_id,i.workspace_id,i.website_project_id,
             i.prospect_id)
          JOIN LATERAL (
            SELECT id,total_score,score_model_version,rule_version,
                   components,evidence,generated_at
              FROM backlink_recommendation_scores s
             WHERE (s.organization_id,s.workspace_id,
                    s.website_project_id,s.recommendation_id)=
                   (i.organization_id,i.workspace_id,
                    i.website_project_id,i.recommendation_id)
               AND s.score_model_version=
                 'recommendation-commercial-fit.v3'
             ORDER BY s.generated_at DESC,s.id DESC
             LIMIT 1
           ) s ON true
          JOIN LATERAL (
            SELECT commercial_score,source_types
              FROM backlink_commercial_candidates AS candidate
             WHERE (
               candidate.organization_id,candidate.workspace_id,
               candidate.website_project_id,candidate.recommendation_id,
               candidate.project_context_version_id
             )=(
               i.organization_id,i.workspace_id,i.website_project_id,
               i.recommendation_id,i.recommendation_context_version_id
             )
               AND candidate.visible_pool_generation=
                 i.visible_pool_generation
               AND candidate.score_model_version=
                 'recommendation-commercial-fit.v3'
               AND candidate.commercial_score->>'decision'='eligible'
             ORDER BY candidate.updated_at DESC,candidate.id DESC
             LIMIT 1
          ) fit ON true
          JOIN backlink_contact_evidence_snapshots AS snapshot ON
            (
              snapshot.organization_id,snapshot.workspace_id,
              snapshot.website_project_id,snapshot.id
            )=(
              i.organization_id,i.workspace_id,
              i.website_project_id,i.contact_evidence_snapshot_id
            )
          LEFT JOIN backlink_contact_enrichment_jobs j ON
            (j.organization_id,j.workspace_id,j.website_project_id,
             j.recommendation_id,j.recommendation_context_version_id)=
            (i.organization_id,i.workspace_id,i.website_project_id,
             i.recommendation_id,i.recommendation_context_version_id)
          LEFT JOIN LATERAL (
            SELECT
              COALESCE(bool_or(candidate.eligible),false) has_eligible,
              count(*) FILTER (WHERE candidate.eligible)::integer
                eligible_count,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id',candidate.id,
                'normalizedEmail',candidate.normalized_email,
                'domainRelation',candidate.domain_relation,
                'confidence',candidate.confidence,
                'inferredPurpose',candidate.inferred_purpose,
                'purposeConfidence',candidate.purpose_confidence,
                'guessed',candidate.guessed,
                'version',candidate.version,
                'eligible',candidate.eligible,
                'contactReviewRequired',
                  candidate.contact_review_required,
                'evidence',candidate.evidence
              ) ORDER BY
                candidate.eligible DESC,
                candidate.contact_review_required ASC,
                candidate.confidence DESC,
                candidate.normalized_email
              ),'[]'::jsonb) contacts
            FROM (
              SELECT c.*,
                (
                  lower(c.normalized_email) ~
                    '^[^[:space:]@]+@[a-z0-9.-]+[.][a-z]{2,}$'
                  AND split_part(
                    lower(c.normalized_email),'@',1
                  ) !~ '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
                  AND c.email_domain_ascii NOT IN (
                    'example.com','example.org','example.net'
                  )
                  AND c.email_domain_ascii NOT LIKE '%.invalid'
                  AND c.status IN ('candidate','promoted')
                  AND c.invalidated_at IS NULL
                  AND c.guessed=false
                  AND c.confidence>=80
                  AND c.purpose_confidence>=70
                  AND c.inferred_purpose IN (
                    'press','editorial','partnerships','advertising','business',
                    'marketing','site_owner','general'
                  )
                  AND evidence.has_valid_evidence
                ) eligible,
                false contact_review_required,
                evidence.items evidence
              FROM backlink_contact_candidates c
              CROSS JOIN LATERAL (
                SELECT
                  COALESCE(bool_or(
                    e.invalidated_at IS NULL
                    AND e.expires_at > now()
                    AND e.extraction_method IN (
                      'mailto','visible_text','obfuscated_text',
                      'json_ld'
                    )
                    AND e.confidence>=80
                  ),false) has_valid_evidence,
                  COALESCE(jsonb_agg(jsonb_build_object(
                    'id',e.id,
                    'sourceUrl',e.source_url,
                    'observedAt',e.observed_at,
                    'extractionMethod',e.extraction_method,
                    'evidenceSnippet',e.evidence_snippet,
                    'confidence',e.confidence
                  ) ORDER BY e.observed_at DESC,e.id)
                  FILTER (
                    WHERE e.invalidated_at IS NULL
                      AND e.expires_at>now()
                      AND e.extraction_method IN (
                        'mailto','visible_text','obfuscated_text','json_ld'
                      )
                      AND e.confidence>=80
                  ),'[]'::jsonb) items
                FROM backlink_contact_evidence e
                WHERE (e.organization_id,e.workspace_id,
                       e.website_project_id,e.candidate_id)=
                      (c.organization_id,c.workspace_id,
                       c.website_project_id,c.id)
                  AND e.id=(
                    SELECT snapshot.contact_evidence_id
                      FROM backlink_contact_evidence_snapshots AS snapshot
                     WHERE (
                       snapshot.organization_id,snapshot.workspace_id,
                       snapshot.website_project_id,snapshot.id
                     )=(
                       i.organization_id,i.workspace_id,
                       i.website_project_id,i.contact_evidence_snapshot_id
                     )
                  )
              ) evidence
              WHERE (c.organization_id,c.workspace_id,
                     c.website_project_id,c.prospect_id,
                     c.recommendation_context_version_id)=
                    (i.organization_id,i.workspace_id,
                     i.website_project_id,i.prospect_id,
                     i.recommendation_context_version_id)
                AND c.status IN ('candidate','promoted')
                AND c.invalidated_at IS NULL
                AND c.id=i.default_contact_candidate_id
            ) candidate
          ) c ON true
          LEFT JOIN backlink_opportunities o ON
            (o.organization_id,o.workspace_id,o.website_project_id,
             o.target_site_key)=
            (i.organization_id,i.workspace_id,i.website_project_id,
             p.registrable_domain)
         WHERE (i.organization_id,i.workspace_id,i.website_project_id)=
               ($1,$2,$3)
           AND ($4::text IS NULL OR i.status=$4)
           AND i.publication_status='PUBLISHED'
           AND i.fit_decision='eligible'
           AND i.fit_score_model_version=
             'recommendation-commercial-fit.v3'
           AND i.contact_decision='eligible'
           AND i.contact_reason_code='PUBLIC_EMAIL_FOUND'
           AND i.verified_public_email_count>=1
           AND i.contact_evidence_snapshot_id IS NOT NULL
           AND i.default_contact_candidate_id IS NOT NULL
           AND COALESCE(c.eligible_count,0)>=1
           AND ($5::numeric IS NULL OR s.total_score >= $5)
           AND ($6::numeric IS NULL OR s.total_score < $6
             OR (s.total_score=$6 AND p.hostname_ascii > $7)
             OR (
               s.total_score=$6
               AND p.hostname_ascii=$7
               AND r.id > $8::uuid
             ))
         ORDER BY s.total_score DESC,p.hostname_ascii,r.id
         LIMIT $9
      `, [
        context.tenant.organizationId,
        context.tenant.workspaceId,
        context.project.websiteProjectId,
        input.status ?? null,
        input.minScore ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        after?.[2] ?? null,
        input.limit + 1,
      ]);
      const items = result.rows.slice(0, input.limit).map((row) => {
        const hostname = String(row.hostname);
        const rootUrl = toWebsiteUrl(hostname, row.rootUrl);
        const contacts = arrayValue(row.contacts).map(toContactCandidate);
        const selectedContact = contacts.find(
          (contact) =>
            contact.id === nullableString(row.recommendedContactCandidateId),
        );
        const selectedEvidence = selectedContact?.evidence[0];
        if (selectedContact === undefined || selectedEvidence === undefined) {
          throw new Error("PUBLISHED_RECOMMENDATION_CONTACT_EVIDENCE_MISSING");
        }
        const fitDecision = toFitDecision(
          row.fitScore,
          Number(row.score),
          row.scoreModelVersion,
          row.ruleVersion,
        );
        const source = recommendationSource(
          stringArray(row.sourceTypes),
          fitDecision.dataForSeo.evidenceRefs,
        );
        return {
          id: String(row.id),
          hostname,
          score: Number(row.score),
          priority: Number(row.score) >= 80 ? "high" as const : "standard" as const,
          ...source,
          risk: recommendationRisk(fitDecision.dataForSeo.spamScore),
          relevantPages: fitDecision.safeFetch.relatedContentPages,
          emailSource: {
            url: selectedEvidence.sourceUrl,
            extractionMethod: selectedEvidence.extractionMethod,
            observedAt: selectedEvidence.observedAt,
          },
          status: row.status as RecommendationListItem["status"],
          publicationStatus: "PUBLISHED" as const,
          verifiedPublicEmailCount: Number(row.verifiedPublicEmailCount),
          recommendationContextVersionId:
            String(row.recommendationContextVersionId),
          version: Number(row.version),
          scoreModelVersion: String(row.scoreModelVersion),
          ruleVersion: String(row.ruleVersion),
          fitDecision,
          contactDecision: {
            decision: "eligible" as const,
            reasonCode: "PUBLIC_EMAIL_FOUND" as const,
            sourceUrl: String(row.contactDecisionSourceUrl),
            inferredPurpose: String(row.contactDecisionPurpose),
            contactConfidence: Number(row.contactDecisionConfidence),
            purposeConfidence:
              Number(row.contactDecisionPurposeConfidence),
            evidenceConfidence:
              Number(row.contactDecisionEvidenceConfidence),
            collectedAt: toIsoString(row.contactDecisionCollectedAt),
            rulesVersion: String(row.contactDecisionRulesVersion),
          },
          rootUrl,
          faviconUrl: new URL("/favicon.ico", rootUrl).toString(),
          acquiredAt: toIsoString(row.acquiredAt ?? row.scoreGeneratedAt),
          contactStatus: (row.contactStatus ?? "not_found") as
            RecommendationListItem["contactStatus"],
          contactJob: toContactJob(row.contactJob),
          contacts,
          recommendedContactCandidateId:
            nullableString(row.recommendedContactCandidateId),
          existingOpportunityId: nullableString(row.existingOpportunityId),
          canCreateOpportunity: row.canCreateOpportunity === true,
          createBlockReason: nullableString(row.createBlockReason) as
            RecommendationListItem["createBlockReason"],
        };
      });
      const hasMore = result.rows.length > input.limit;
      const last = items.at(-1);
      return {
        items,
        hasMore,
        nextCursor: hasMore && last !== undefined
          ? encodeCursor(last)
          : null,
      };
    },
    async getRecommendationInventoryStatus(context, runningBuildId = "unknown") {
      const result = await client.query(`
        WITH current_context AS (
          SELECT id,created_at
            FROM backlink_project_context_snapshots
           WHERE (organization_id,workspace_id,website_project_id)=
                 ($1,$2,$3)
             AND project_status='ACTIVE'
           ORDER BY snapshot_version DESC,created_at DESC,id DESC
           LIMIT 1
        ),
        pool_policy AS (
          SELECT *
            FROM backlink_commercial_inventory_policies
           WHERE (organization_id,workspace_id,website_project_id)=
                 ($1,$2,$3)
             AND project_context_version_id=(SELECT id FROM current_context)
           LIMIT 1
        ),
        latest_blueprint AS (
          SELECT blueprint_version,generator
            FROM backlink_commercial_discovery_blueprints
           WHERE (organization_id,workspace_id,website_project_id)=
                 ($1,$2,$3)
             AND project_context_version_id=(SELECT id FROM current_context)
             AND status='active'
           ORDER BY blueprint_version DESC,generated_at DESC,id DESC
           LIMIT 1
        ),
        candidate_counts AS (
          SELECT
            count(*) FILTER (
              WHERE state IN ('candidate_ready','contact_enrichment')
                AND score_model_version=
                  'recommendation-commercial-fit.v3'
                AND commercial_score->>'decision'='eligible'
            )::integer candidate_ready_count,
            count(*) FILTER (
              WHERE score_model_version=
                'recommendation-commercial-fit.v3'
            )::integer historical_candidate_count,
            count(*) FILTER (
              WHERE score_model_version=
                'recommendation-commercial-fit.v3'
            )::integer raw_candidate_count,
            count(*) FILTER (
              WHERE score_model_version=
                'recommendation-commercial-fit.v3'
                AND commercial_score->>'decision'='eligible'
            )::integer fit_count,
            max(provider_collected_at) FILTER (
              WHERE score_model_version=
                'recommendation-commercial-fit.v3'
            ) provider_collected_at,
            max(updated_at) latest_updated_at
            FROM backlink_commercial_candidates
           WHERE (organization_id,workspace_id,website_project_id)=
                 ($1,$2,$3)
             AND project_context_version_id=(SELECT id FROM current_context)
             AND visible_pool_generation=(
               SELECT visible_pool_generation FROM pool_policy
             )
        ),
        publication_counts AS (
          SELECT
            count(*) FILTER (
              WHERE inventory.publication_status='PUBLISHED'
                AND inventory.fit_decision='eligible'
                AND inventory.fit_score_model_version=
                  'recommendation-commercial-fit.v3'
                AND inventory.contact_decision='eligible'
                AND inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'
                AND inventory.verified_public_email_count>=1
                AND inventory.status IN ('ready','shown','accepted')
                AND recommendation.status IN ('ready','shown','accepted')
            )::integer published_count,
            count(*) FILTER (
              WHERE inventory.fit_decision='eligible'
                AND inventory.fit_score_model_version=
                  'recommendation-commercial-fit.v3'
                AND inventory.contact_decision='eligible'
                AND inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'
                AND inventory.verified_public_email_count>=1
            )::integer contact_count,
            count(*) FILTER (
              WHERE inventory.fit_decision='eligible'
                AND inventory.fit_score_model_version=
                  'recommendation-commercial-fit.v3'
                AND inventory.publication_status<>'PUBLISHED'
            )::integer unpublished_count,
            count(*) FILTER (
              WHERE inventory.verified_public_email_count>=1
                AND inventory.fit_decision='eligible'
                AND inventory.fit_score_model_version=
                  'recommendation-commercial-fit.v3'
                AND inventory.contact_decision='eligible'
            )::integer
              historical_verified_email_count
            FROM backlink_recommendation_inventory AS inventory
            JOIN backlink_recommendations AS recommendation
              ON (
                recommendation.organization_id,
                recommendation.workspace_id,
                recommendation.website_project_id,
                recommendation.id
              )=(
                inventory.organization_id,
                inventory.workspace_id,
                inventory.website_project_id,
                inventory.recommendation_id
              )
            JOIN backlink_prospects AS prospect
              ON (
                prospect.organization_id,prospect.workspace_id,
                prospect.website_project_id,prospect.id
              )=(
                inventory.organization_id,inventory.workspace_id,
                inventory.website_project_id,inventory.prospect_id
              )
           WHERE (
             inventory.organization_id,inventory.workspace_id,
             inventory.website_project_id
           )=
                 ($1,$2,$3)
             AND inventory.recommendation_context_version_id=
                 (SELECT id FROM current_context)
             AND inventory.visible_pool_generation=(
               SELECT visible_pool_generation FROM pool_policy
             )
        ),
        running_batch AS (
          SELECT EXISTS (
            SELECT 1
            FROM backlink_commercial_discovery_batches
             WHERE (organization_id,workspace_id,website_project_id)=
                   ($1,$2,$3)
               AND project_context_version_id=(SELECT id FROM current_context)
               AND visible_pool_generation=(
                 SELECT visible_pool_generation FROM pool_policy
               )
               AND status='running'
          ) value
        ),
        generation_refills AS (
          SELECT DISTINCT refill_window_key
            FROM backlink_recommendation_refills
           WHERE (
             organization_id,workspace_id,website_project_id
           )=($1,$2,$3)
             AND recommendation_context_version_id=
                 (SELECT id FROM current_context)
             AND visible_pool_generation=(
               SELECT visible_pool_generation FROM pool_policy
             )
        ),
        latest_refill_job AS (
          SELECT refill.id refill_id,job.id,job.workflow_id,job.status,job.step,job.progress,
                 job.error,job.retry_count,job.started_at,job.finished_at,
                 job.created_at,job.updated_at,job.version,
                 refill.low_watermark,refill.high_watermark,
                 refill.refill_window_key
            FROM backlink_recommendation_refills AS refill
            JOIN backlink_jobs AS job ON
              (
                job.organization_id,job.workspace_id,
                job.website_project_id,job.id
              )=(
                refill.organization_id,refill.workspace_id,
                refill.website_project_id,refill.job_id
              )
           WHERE (
             refill.organization_id,refill.workspace_id,
             refill.website_project_id
           )=($1,$2,$3)
             AND refill.recommendation_context_version_id=
                 (SELECT id FROM current_context)
             AND refill.visible_pool_generation=(
               SELECT visible_pool_generation FROM pool_policy
             )
           ORDER BY job.created_at DESC,job.id DESC
           LIMIT 1
        ),
        provider_call_state AS (
          SELECT
          (
            EXISTS (
              SELECT 1
                FROM backlink_provider_usage_ledger AS usage
                JOIN generation_refills AS refill
                  ON usage.reservation_key LIKE
                     refill.refill_window_key||':%'
               WHERE (
                 usage.organization_id,usage.workspace_id,
                 usage.website_project_id
               )=($1,$2,$3)
                 AND usage.provider='dataforseo'
                 AND usage.status IN ('reserved','settled')
            )
            OR EXISTS (
              SELECT 1
                FROM provider_batch_requests AS request
                JOIN generation_refills AS refill
                  ON request.request_id LIKE
                     refill.refill_window_key||':%'
               WHERE (
                 request.organization_id,request.workspace_id,
                 request.website_project_id
               )=($1,$2,$3)
                 AND (
                   request.status<>'failed'
                   OR request.actual_cost_micros IS NOT NULL
                   OR request.provider_task_id IS NOT NULL
                 )
            )
          ) value,
          COALESCE((
            SELECT sum(usage.actual_cost_micros)
              FROM backlink_provider_usage_ledger AS usage
              JOIN generation_refills AS refill
                ON usage.reservation_key LIKE refill.refill_window_key||':%'
             WHERE (
               usage.organization_id,usage.workspace_id,
               usage.website_project_id
             )=($1,$2,$3)
               AND usage.provider='dataforseo'
               AND usage.status='settled'
          ),0)::bigint actual_cost_micros,
          COALESCE((
            SELECT sum(usage.estimated_cost_micros)
              FROM backlink_provider_usage_ledger AS usage
              JOIN generation_refills AS refill
                ON usage.reservation_key LIKE refill.refill_window_key||':%'
             WHERE (
               usage.organization_id,usage.workspace_id,
               usage.website_project_id
             )=($1,$2,$3)
               AND usage.provider='dataforseo'
               AND usage.status='reserved'
          ),0)::bigint reserved_cost_micros,
          (
            SELECT count(DISTINCT usage.id)::integer
              FROM backlink_provider_usage_ledger AS usage
              JOIN generation_refills AS refill
                ON usage.reservation_key LIKE refill.refill_window_key||':%'
             WHERE (
               usage.organization_id,usage.workspace_id,
               usage.website_project_id
             )=($1,$2,$3)
               AND usage.provider='dataforseo'
               AND usage.status='settled'
          ) paid_call_count,
          (
            SELECT count(DISTINCT request.id)::integer
              FROM provider_batch_requests AS request
              JOIN generation_refills AS refill
                ON request.request_id LIKE refill.refill_window_key||':%'
             WHERE (
               request.organization_id,request.workspace_id,
               request.website_project_id
             )=($1,$2,$3)
               AND request.status='unknown_charge'
          ) unknown_charge_count,
          (
            SELECT count(
              DISTINCT request.normalized_request_hash
            )::integer
              FROM provider_batch_requests AS request
              JOIN generation_refills AS refill
                ON request.request_id LIKE refill.refill_window_key||':%'
             WHERE (
               request.organization_id,request.workspace_id,
               request.website_project_id
             )=($1,$2,$3)
          ) request_fingerprint_count
        ),
        contact_batch AS (
          SELECT b.id,b.status,b.started_at,b.completed_at,b.updated_at,
                 (
                   SELECT min(job.retry_after)
                     FROM backlink_contact_enrichment_jobs AS job
                    WHERE (
                      job.organization_id,job.workspace_id,
                      job.website_project_id,job.batch_id
                    )=(
                      b.organization_id,b.workspace_id,
                      b.website_project_id,b.id
                    )
                      AND job.status='retry_scheduled'
                 ) next_retry_at,
                 (
                   SELECT count(*)::integer
                     FROM backlink_contact_enrichment_jobs AS job
                    WHERE (
                      job.organization_id,job.workspace_id,
                      job.website_project_id,job.batch_id
                    )=(
                      b.organization_id,b.workspace_id,
                      b.website_project_id,b.id
                    )
                 ) total_job_count,
                 (
                   SELECT count(*)::integer
                     FROM backlink_contact_enrichment_jobs AS job
                    WHERE (
                      job.organization_id,job.workspace_id,
                      job.website_project_id,job.batch_id
                    )=(
                      b.organization_id,b.workspace_id,
                      b.website_project_id,b.id
                    )
                      AND job.terminal_reason_code IS NOT NULL
                 ) terminal_job_count,
                 (
                   SELECT count(*)::integer
                     FROM backlink_recommendation_inventory AS inventory
                    WHERE (
                      inventory.organization_id,inventory.workspace_id,
                      inventory.website_project_id,
                      inventory.recommendation_context_version_id
                    )=(
                      b.organization_id,b.workspace_id,
                      b.website_project_id,
                      b.recommendation_context_version_id
                    )
                      AND inventory.publication_status='PUBLISHED'
                      AND inventory.visible_pool_generation=(
                        SELECT visible_pool_generation FROM pool_policy
                      )
                      AND inventory.fit_decision='eligible'
                      AND inventory.fit_score_model_version=
                        'recommendation-commercial-fit.v3'
                      AND inventory.contact_decision='eligible'
                      AND inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'
                      AND inventory.verified_public_email_count>=1
                 ) published_count,
                 (
                   SELECT count(*)::integer
                     FROM backlink_recommendation_inventory AS inventory
                    WHERE (
                      inventory.organization_id,inventory.workspace_id,
                      inventory.website_project_id,
                      inventory.recommendation_context_version_id
                    )=(
                      b.organization_id,b.workspace_id,
                      b.website_project_id,
                      b.recommendation_context_version_id
                    )
                      AND inventory.publication_status<>'PUBLISHED'
                      AND inventory.visible_pool_generation=(
                        SELECT visible_pool_generation FROM pool_policy
                      )
                 ) unpublished_count,
                 (
                   SELECT count(*)::integer
                     FROM backlink_contact_enrichment_jobs AS job
                     JOIN backlink_recommendation_inventory AS inventory ON
                       (
                         inventory.organization_id,inventory.workspace_id,
                         inventory.website_project_id,
                         inventory.recommendation_id,
                         inventory.recommendation_context_version_id
                       )=(
                         job.organization_id,job.workspace_id,
                         job.website_project_id,job.recommendation_id,
                         job.recommendation_context_version_id
                       )
                    WHERE (
                      job.organization_id,job.workspace_id,
                      job.website_project_id,job.batch_id
                    )=(
                      b.organization_id,b.workspace_id,
                      b.website_project_id,b.id
                    )
                      AND inventory.publication_status<>'PUBLISHED'
                      AND inventory.visible_pool_generation=(
                        SELECT visible_pool_generation FROM pool_policy
                      )
                      AND job.status IN (
                        'completed','partially_completed',
                        'no_contact_found','retry_scheduled'
                      )
                      AND job.attempt_count<10
                 ) retryable_unpublished_count,
                 (
                   SELECT COALESCE(jsonb_agg(jsonb_build_object(
                     'reasonCode',reason.reason_code,
                     'count',reason.reason_count
                   ) ORDER BY reason.reason_code),'[]'::jsonb)
                     FROM (
                       SELECT job.terminal_reason_code reason_code,
                              count(*)::integer reason_count
                         FROM backlink_contact_enrichment_jobs AS job
                        WHERE (
                          job.organization_id,job.workspace_id,
                          job.website_project_id,job.batch_id
                        )=(
                          b.organization_id,b.workspace_id,
                          b.website_project_id,b.id
                        )
                          AND job.terminal_reason_code IS NOT NULL
                        GROUP BY job.terminal_reason_code
                     ) reason
                 ) reason_counts
            FROM backlink_contact_enrichment_batches AS b
           WHERE (b.organization_id,b.workspace_id,b.website_project_id)=
                 ($1,$2,$3)
              AND b.recommendation_context_version_id=
                  (SELECT id FROM current_context)
              AND EXISTS (
                SELECT 1
                  FROM backlink_contact_enrichment_jobs AS scoped_job
                  JOIN backlink_recommendation_inventory AS scoped_inventory
                    ON (
                      scoped_inventory.organization_id,
                      scoped_inventory.workspace_id,
                      scoped_inventory.website_project_id,
                      scoped_inventory.recommendation_id,
                      scoped_inventory.recommendation_context_version_id
                    )=(
                      scoped_job.organization_id,
                      scoped_job.workspace_id,
                      scoped_job.website_project_id,
                      scoped_job.recommendation_id,
                      scoped_job.recommendation_context_version_id
                    )
                 WHERE (
                   scoped_job.organization_id,scoped_job.workspace_id,
                   scoped_job.website_project_id,scoped_job.batch_id
                 )=(
                   b.organization_id,b.workspace_id,
                   b.website_project_id,b.id
                 )
                   AND scoped_inventory.visible_pool_generation=(
                     SELECT visible_pool_generation FROM pool_policy
                   )
              )
           ORDER BY b.started_at DESC,b.id DESC
           LIMIT 1
        )
        SELECT
          (SELECT id FROM current_context)
            "recommendationContextVersionId",
          COALESCE(policy.visible_pool_generation,1)
            "visiblePoolGeneration",
          COALESCE(policy.visible_pool_state,'idle')
            "visiblePoolState",
          COALESCE(policy.visible_pool_target_count,10)
            "visiblePoolTargetCount",
          COALESCE(policy.archived_visible_pool_count,0)
            "archivedVisiblePoolCount",
          policy.visible_pool_archived_at "visiblePoolArchivedAt",
          GREATEST(
            (SELECT created_at FROM current_context),
            candidate_counts.latest_updated_at,
            policy.updated_at,
            latest_refill_job.updated_at,
            contact_batch.updated_at
          ) "serverUpdatedAt",
          COALESCE(candidate_counts.candidate_ready_count,0)
            "candidateReadyCount",
          COALESCE(candidate_counts.raw_candidate_count,0)
            "rawCandidateCount",
          COALESCE(candidate_counts.fit_count,0)
            "fitCount",
          COALESCE(publication_counts.contact_count,0)
            "contactCount",
          COALESCE(publication_counts.published_count,0)
            "publishedContactReadyCount",
          COALESCE(publication_counts.unpublished_count,0)
            "unpublishedCount",
          CASE
            WHEN COALESCE(candidate_counts.historical_candidate_count,0)=0
              THEN 0.1
            ELSE LEAST(0.8,GREATEST(
              0.1,
              publication_counts.historical_verified_email_count::numeric
                / candidate_counts.historical_candidate_count
            ))
          END::double precision "historicalEmailHitRate",
          COALESCE(policy.candidate_low_watermark,20)
            "candidateLowWatermark",
          COALESCE(policy.candidate_high_watermark,40)
            "candidateHighWatermark",
          COALESCE(policy.published_contact_ready_low_watermark,5)
            "publishedLowWatermark",
          COALESCE(policy.published_contact_ready_high_watermark,10)
            "publishedHighWatermark",
          latest_blueprint.blueprint_version "blueprintVersion",
          latest_blueprint.generator "blueprintGenerator",
          policy.latest_refill_at "latestRefillAt",
          policy.next_refill_at "nextRefillAt",
          COALESCE(
            policy.latest_provider_collected_at,
            candidate_counts.provider_collected_at
          ) "providerCollectedAt",
          policy.pause_reason "pauseReason",
          (
            running_batch.value
            OR latest_refill_job.status IN (
              'queued','running','waiting_provider'
            )
          ) "refillInFlight",
          COALESCE(policy.refill_state,'idle') "refillState",
          COALESCE(
            policy.current_refill_tier,
            'exact_product_target_market'
          ) "currentRefillTier",
          COALESCE(policy.current_refill_round,1) "currentRefillRound",
          policy.paid_refill_tier "paidRefillTier",
          policy.paid_refill_round "paidRefillRound",
          policy.resource_refill_tier "resourceRefillTier",
          policy.resource_refill_round "resourceRefillRound",
          COALESCE(policy.attempted_refill_tiers,'[]'::jsonb)
            "attemptedRefillTiers",
          policy.termination_reason "terminationReason",
          COALESCE(provider_call_state.value,false) "providerCallOccurred",
          provider_call_state.actual_cost_micros "providerActualCostMicros",
          provider_call_state.reserved_cost_micros "providerReservedCostMicros",
          provider_call_state.paid_call_count "providerPaidCallCount",
          provider_call_state.unknown_charge_count
            "providerUnknownChargeCount",
          provider_call_state.request_fingerprint_count
            "providerUniqueCallCount",
          COALESCE(policy.elimination_reason_counts,'{}'::jsonb)
            "eliminationReasonCounts",
          CASE WHEN latest_refill_job.id IS NULL THEN NULL
            ELSE jsonb_build_object(
              'id',latest_refill_job.id,
              'operationId',latest_refill_job.refill_id,
              'workflowId',latest_refill_job.workflow_id,
              'status',latest_refill_job.status,
              'step',latest_refill_job.step,
              'progress',latest_refill_job.progress,
              'errorCode',COALESCE(
                latest_refill_job.error->>'code',
                latest_refill_job.error->>'errorCode'
              ),
              'errorMessage',COALESCE(
                latest_refill_job.error->>'message',
                latest_refill_job.error->>'detail'
              ),
              'failure',CASE
                WHEN latest_refill_job.error->>'rootCause' IS NULL THEN NULL
                ELSE jsonb_build_object(
                  'rootCause',latest_refill_job.error->>'rootCause',
                  'recovery',latest_refill_job.error->>'recovery',
                  'providerCallOccurred',COALESCE(
                    (latest_refill_job.error->>'providerCallOccurred')::boolean,
                    false
                  ),
                  'diagnosticId',latest_refill_job.error->>'diagnosticId',
                  'message',latest_refill_job.error->>'message'
                )
              END,
              'retryCount',latest_refill_job.retry_count,
              'lowWatermark',latest_refill_job.low_watermark,
              'highWatermark',latest_refill_job.high_watermark,
              'refillWindowKey',latest_refill_job.refill_window_key,
              'startedAt',latest_refill_job.started_at,
              'finishedAt',latest_refill_job.finished_at,
              'createdAt',latest_refill_job.created_at,
              'updatedAt',latest_refill_job.updated_at,
              'version',latest_refill_job.version
            )
          END "refillJob",
          CASE WHEN contact_batch.id IS NULL THEN NULL
            ELSE jsonb_build_object(
              'id',contact_batch.id,
              'status',contact_batch.status,
              'totalJobCount',contact_batch.total_job_count,
              'terminalJobCount',contact_batch.terminal_job_count,
              'publishedCount',contact_batch.published_count,
              'unpublishedCount',contact_batch.unpublished_count,
               'retryableUnpublishedCount',
                 contact_batch.retryable_unpublished_count,
               'nextRetryAt',contact_batch.next_retry_at,
              'reasonCounts',contact_batch.reason_counts,
              'startedAt',contact_batch.started_at,
              'completedAt',contact_batch.completed_at
            )
          END "contactBatch"
        FROM candidate_counts
        CROSS JOIN publication_counts
        CROSS JOIN running_batch
        CROSS JOIN provider_call_state
        LEFT JOIN latest_blueprint ON true
        LEFT JOIN latest_refill_job ON true
        LEFT JOIN contact_batch ON true
        LEFT JOIN pool_policy AS policy ON true
      `, [
        context.tenant.organizationId,
        context.tenant.workspaceId,
        context.project.websiteProjectId,
      ]);
      const row = result.rows[0] ?? {};
      const contactBatch = row.contactBatch === null
        || row.contactBatch === undefined
        ? null
        : objectValue(row.contactBatch);
      const persistedRefillJob = row.refillJob === null
        || row.refillJob === undefined
        ? null
        : objectValue(row.refillJob);
      const attemptedRefillTiers = arrayValue(row.attemptedRefillTiers).map(
        (value) => {
          const attempt = objectValue(value);
          return Object.freeze({
            tier: String(attempt.tier) as
              RecommendationInventorySummary["currentRefillTier"],
            round: Number(attempt.round),
            window: Number(attempt.window ?? 1),
          });
        },
      );
      const currentRefillTier = String(
        row.currentRefillTier ?? "exact_product_target_market",
      ) as RecommendationInventorySummary["currentRefillTier"];
      const currentRefillRound = Number(row.currentRefillRound ?? 1);
      const publishedCount = Number(row.publishedContactReadyCount ?? 0);
      const targetCount = Number(row.visiblePoolTargetCount ?? 10);
      const terminationReason = nullableString(row.terminationReason) as
        RecommendationInventorySummary["terminationReason"];
      const terminalState = recommendationTerminalState(
        terminationReason,
        publishedCount,
        targetCount,
      );
      const refillJob = terminalState === "TARGET_REACHED"
        ? null
        : persistedRefillJob;
      const refillFailure = refillJob?.failure === null
        || refillJob?.failure === undefined
        ? null
        : objectValue(refillJob.failure);
      const blueprintVersion = row.blueprintVersion === null
        || row.blueprintVersion === undefined
        ? null : Number(row.blueprintVersion);
      const persistedRefillState = String(row.refillState ?? "idle") as
        RecommendationInventorySummary["refillState"];
      const refillInFlight = row.refillInFlight === true;
      const refillState = persistedRefillState === "running" && !refillInFlight
        ? "idle"
        : persistedRefillState;
      const paidRefillTier = nullableString(row.paidRefillTier) as
        NonNullable<RecommendationInventorySummary["paidCursor"]>["tier"] | null;
      const paidRefillRound = nullableNumber(row.paidRefillRound);
      const resourceRefillTier = nullableString(row.resourceRefillTier);
      const resourceRefillRound = nullableNumber(row.resourceRefillRound);
      const defaultRecovery = terminalState === "PAUSED_PROVIDER"
        ? "WAIT_PROVIDER" as const
        : terminalState === "PAUSED_BUDGET"
          ? "RESUME_OPERATION" as const
          : terminalState === "PROJECT_CONTEXT_REQUIRED"
            ? "COMPLETE_PROJECT_CONTEXT" as const
            : terminalState === "SUPPLY_FLOOR_REACHED"
              ? "ACCEPT_SUPPLY_FLOOR" as const
              : null;
      return Object.freeze({
        contractVersion: "backlinks.recommendation-operation.v1" as const,
        runningBuildId,
        visiblePoolGeneration: Number(row.visiblePoolGeneration ?? 1),
        visiblePoolState: String(
          row.visiblePoolState ?? "idle",
        ) as RecommendationInventorySummary["visiblePoolState"],
        visiblePoolTargetCount: targetCount,
        archivedVisiblePoolCount: Number(row.archivedVisiblePoolCount ?? 0),
        visiblePoolArchivedAt: row.visiblePoolArchivedAt === null
          || row.visiblePoolArchivedAt === undefined
          ? null
          : toIsoString(row.visiblePoolArchivedAt),
        operationId: nullableString(refillJob?.operationId),
        jobId: nullableString(refillJob?.id),
        stage: recommendationStage({
          terminalState,
          refillState,
          refillJob,
          contactBatch,
          blueprintVersion,
        }),
        terminal: terminalState === "TARGET_REACHED"
          || terminalState === "PROJECT_CONTEXT_REQUIRED"
          || terminalState === "SUPPLY_FLOOR_REACHED",
        terminalState,
        targetCount,
        rawCount: Number(row.rawCandidateCount ?? 0),
        fitCount: Number(row.fitCount ?? 0),
        contactCount: Number(row.contactCount ?? 0),
        publishedCount,
        unpublishedCount: Number(row.unpublishedCount ?? 0),
        tier: currentRefillTier,
        round: currentRefillRound,
        window: cursorWindow(
          attemptedRefillTiers,
          currentRefillTier,
          currentRefillRound,
        ),
        paidCursor: paidRefillTier === null || paidRefillRound === null
          ? null
          : Object.freeze({
            tier: paidRefillTier,
            round: paidRefillRound,
            window: cursorWindow(
              attemptedRefillTiers,
              paidRefillTier,
              paidRefillRound,
            ),
          }),
        resourceCursor:
          resourceRefillTier !== "curated_resource_library"
            || resourceRefillRound === null
            ? null
            : Object.freeze({
              tier: "curated_resource_library" as const,
              round: resourceRefillRound,
              window: cursorWindow(
                attemptedRefillTiers,
                "curated_resource_library",
                resourceRefillRound,
              ),
            }),
        nextRetryAt: contactBatch?.nextRetryAt === null
          || contactBatch?.nextRetryAt === undefined
          ? row.nextRefillAt === null || row.nextRefillAt === undefined
            ? null
            : toIsoString(row.nextRefillAt)
          : toIsoString(contactBatch.nextRetryAt),
        errorCode: terminalState === "TARGET_REACHED"
          ? null
          : nullableString(refillJob?.errorCode)
            ?? nullableString(refillFailure?.rootCause)
            ?? nullableString(row.pauseReason),
        recoveryAction: terminalState === "TARGET_REACHED"
          ? null
          : (
            nullableString(refillFailure?.recovery) ?? defaultRecovery
          ) as RecommendationInventorySummary["recoveryAction"],
        providerCallOccurred: row.providerCallOccurred === true
          || refillFailure?.providerCallOccurred === true,
        providerActualCostMicros: Number(row.providerActualCostMicros ?? 0),
        providerReservedCostMicros: Number(row.providerReservedCostMicros ?? 0),
        providerPaidCallCount: Number(row.providerPaidCallCount ?? 0),
        providerUnknownChargeCount:
          Number(row.providerUnknownChargeCount ?? 0),
        providerUniqueCallCount:
          Number(row.providerUniqueCallCount ?? 0),
        recommendationContextVersionId:
          nullableString(row.recommendationContextVersionId),
        serverUpdatedAt: row.serverUpdatedAt === null
          || row.serverUpdatedAt === undefined
          ? null
          : toIsoString(row.serverUpdatedAt),
        candidateReadyCount: Number(row.candidateReadyCount ?? 0),
        rawCandidateCount: Number(row.rawCandidateCount ?? 0),
        publishedContactReadyCount:
          Number(row.publishedContactReadyCount ?? 0),
        historicalEmailHitRate: Number(row.historicalEmailHitRate ?? 0.1),
        candidateLowWatermark: Number(row.candidateLowWatermark ?? 20),
        candidateHighWatermark: Number(row.candidateHighWatermark ?? 40),
        publishedLowWatermark: Number(row.publishedLowWatermark ?? 5),
        publishedHighWatermark: Number(row.publishedHighWatermark ?? 10),
        blueprintVersion,
        blueprintGenerator: nullableString(row.blueprintGenerator) as
          RecommendationInventorySummary["blueprintGenerator"],
        latestRefillAt: row.latestRefillAt === null
          || row.latestRefillAt === undefined
          ? null : toIsoString(row.latestRefillAt),
        nextRefillAt: row.nextRefillAt === null
          || row.nextRefillAt === undefined
          ? null : toIsoString(row.nextRefillAt),
        providerCollectedAt: row.providerCollectedAt === null
          || row.providerCollectedAt === undefined
          ? null : toIsoString(row.providerCollectedAt),
        pauseReason: nullableString(row.pauseReason),
        refillInFlight,
        refillState,
        currentRefillTier,
        currentRefillRound,
        attemptedRefillTiers,
        terminationReason,
        eliminationReasonCounts: Object.entries(
          objectValue(row.eliminationReasonCounts),
        ).map(([reasonCode, count]) => Object.freeze({
          reasonCode,
          count: Number(count),
        })),
        refillJob: refillJob === null ? null : Object.freeze({
          operationId: String(refillJob.operationId),
          id: String(refillJob.id),
          workflowId: String(refillJob.workflowId),
          status: String(refillJob.status) as
            NonNullable<RecommendationInventorySummary["refillJob"]>["status"],
          step: nullableString(refillJob.step),
          progress: Number(refillJob.progress ?? 0),
          errorCode: nullableString(refillJob.errorCode),
          errorMessage: nullableString(refillJob.errorMessage),
          failure: refillJob.failure === null
            || refillJob.failure === undefined
            ? null
            : Object.freeze({
              rootCause: String(objectValue(refillJob.failure).rootCause),
              recovery: String(objectValue(refillJob.failure).recovery),
              providerCallOccurred:
                objectValue(refillJob.failure).providerCallOccurred === true,
              diagnosticId:
                String(objectValue(refillJob.failure).diagnosticId),
              message: String(objectValue(refillJob.failure).message),
            }) as RecommendationRefillFailure,
          retryCount: Number(refillJob.retryCount ?? 0),
          lowWatermark: Number(refillJob.lowWatermark),
          highWatermark: Number(refillJob.highWatermark),
          refillWindowKey: String(refillJob.refillWindowKey),
          startedAt: refillJob.startedAt === null
            || refillJob.startedAt === undefined
            ? null
            : toIsoString(refillJob.startedAt),
          finishedAt: refillJob.finishedAt === null
            || refillJob.finishedAt === undefined
            ? null
            : toIsoString(refillJob.finishedAt),
          createdAt: toIsoString(refillJob.createdAt),
          updatedAt: toIsoString(refillJob.updatedAt),
          version: Number(refillJob.version),
        }),
        contactBatch: contactBatch === null ? null : Object.freeze({
          id: String(contactBatch.id),
          status: contactBatch.status as
            NonNullable<RecommendationInventorySummary["contactBatch"]>["status"],
          totalJobCount: Number(contactBatch.totalJobCount),
          terminalJobCount: Number(contactBatch.terminalJobCount),
          publishedCount: Number(contactBatch.publishedCount),
          unpublishedCount: Number(contactBatch.unpublishedCount),
          retryableUnpublishedCount:
            Number(contactBatch.retryableUnpublishedCount),
          nextRetryAt: contactBatch.nextRetryAt === null
            || contactBatch.nextRetryAt === undefined
            ? null
            : toIsoString(contactBatch.nextRetryAt),
          reasonCounts: arrayValue(contactBatch.reasonCounts).map((value) => {
            const reason = objectValue(value);
            return Object.freeze({
              reasonCode: String(reason.reasonCode),
              count: Number(reason.count),
            });
          }),
          startedAt: toIsoString(contactBatch.startedAt),
          completedAt: contactBatch.completedAt === null
            || contactBatch.completedAt === undefined
            ? null
            : toIsoString(contactBatch.completedAt),
        }),
      });
    },
  });
}
