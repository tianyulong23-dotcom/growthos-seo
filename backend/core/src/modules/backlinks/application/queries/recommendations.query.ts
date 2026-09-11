import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { RecommendationRefillFailure } from "../../domain/recommendations/refill-failure.js";
import {
  cooperationContentTypeFor,
  isCooperationPathType,
  normalizeCooperationPathUrl,
  type CooperationContentType,
  type CooperationPathType,
} from "../../domain/opportunities/cooperation-path.js";
import {
  deriveRecommendationProductState,
  type RecommendationProductState,
  type RecommendationProviderAvailability,
  type RecommendationRecoveryCommand,
} from "../../domain/recommendations/recommendation-product-state.js";
import { assertV1RecommendationPoolReadContract } from "../../domain/recommendations/recommendation-pool-read-contract.js";
import {
  resolveCommercialSupplyPublishedTarget,
} from "../../domain/recommendations/commercial-refill-cycle.js";
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
    "mailto" | "visible_text" | "obfuscated_text" | "json_ld" | "manual";
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
  attemptCount: number;
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
  scoreModelVersion:
    | "recommendation-commercial-fit.v4"
    | "recommendation-commercial-fit.v3";
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
    tier:
      | "target_market"
      | "same_language_expansion"
      | "market_language_mismatch";
    reasonCode: string;
  };
  cooperationAngles: string[];
  dataForSeo: {
    rank: number | null;
    traffic: number | null;
    backlinks: number | null;
    referringDomains: number | null;
    spamScore: number | null;
    backlinkPageEvidence: {
      sourceUrl: string;
      targetUrl: string;
      anchorText: string | null;
      linkStatus: "active" | "lost";
      firstSeenAt: string | null;
      lastSeenAt: string | null;
      sourceHttpStatus: number | null;
      targetHttpStatus: number | null;
    }[];
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
export type RecommendationPresentationState = "current" | "legacy_stale";
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
export type RecommendationCooperationPath = Readonly<{
  factId: string;
  decision: "pending" | "verified" | "unavailable" | "manual_review";
  reasonCode: string;
  pathType: CooperationPathType | null;
  url: string | null;
  action:
    | "SEND_EMAIL"
    | "OPEN_CONTACT_FORM"
    | "OPEN_GUEST_POST_SUBMISSION"
    | "OPEN_RESOURCE_SUBMISSION"
    | "OPEN_EDITOR_AUTHOR_PAGE"
    | null;
  contentType: CooperationContentType | null;
  evidence: Readonly<Record<string, unknown>>;
  observedAt: string;
}>;
export type RecommendationListItem = {
  id: string;
  hostname: string;
  score: number;
  presentationState: RecommendationPresentationState;
  contractKind: "corrected_visibility_v1";
  outreachReadiness:
    "ready" | "manual_action" | "contact_pending" | "manual_review"
    | "unavailable";
  priority: "high" | "standard";
  candidateSource:
    "paid_discovery" | "resource_library" | "mixed" | "existing_history";
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
  }> | null;
  status: RecommendationInventoryStatus;
  publicationStatus:
    "PUBLISHED" | "NOT_PUBLISHED" | "CONTACT_PENDING" | "CONTACT_REVIEW";
  verifiedPublicEmailCount: number;
  recommendationContextVersionId: string;
  version: number;
  scoreModelVersion: string;
  ruleVersion: string;
  fitDecision: RecommendationFitDecision;
  contactDecision: RecommendationContactDecision | null;
  cooperationPath: RecommendationCooperationPath | null;
  contactPageUrl: string | null;
  rootUrl: string;
  faviconUrl: string;
  acquiredAt: string;
  contactStatus:
    | "contactable"
    | "running"
    | "review"
    | "not_found"
    | "not_started";
  contactJob: RecommendationContactJob | null;
  contacts: RecommendationContactCandidate[];
  recommendedContactCandidateId: string | null;
  existingOpportunityId: string | null;
  canCreateOpportunity: boolean;
  createBlockReason: "existing_opportunity" | null;
};
export type RecommendationsListInput = Readonly<{
  status?: RecommendationListItem["status"] | undefined;
  minScore?: number | undefined;
  limit: number;
  cursor?: string | undefined;
}>;
export type RecommendationPage = Readonly<{
  items: RecommendationListItem[];
  presentationState: RecommendationPresentationState;
  nextCursor: string | null;
  hasMore: boolean;
}>;
export type RecommendationInventorySummary = Readonly<{
  contractVersion: "backlinks.recommendation-operation.v1";
  contractKind: "corrected_visibility_v1";
  productState: RecommendationProductState;
  productStateReason: string;
  recoveryCommand: RecommendationRecoveryCommand | null;
  providerAvailability: RecommendationProviderAvailability;
  visibleMatchCount: number;
  activeProcessingSeconds: number;
  providerBalanceMicros: number | null;
  aiCapacity: Readonly<{
    status: "available" | "exhausted" | "unconfigured";
    remainingCalls: number | null;
    remainingBudgetMicros: number | null;
  }>;
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

const invalidCursor = () =>
  new BacklinkError({
    code: backlinkErrorCodes.invalidRequest,
    message: "Recommendation cursor is invalid.",
    fieldErrors: [
      { field: "cursor", message: "Use a cursor returned by this API." },
    ],
  });

function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      typeof parsed[0] !== "number" ||
      !Number.isFinite(parsed[0]) ||
      typeof parsed[1] !== "string" ||
      parsed[1].length === 0 ||
      typeof parsed[2] !== "string" ||
      parsed[2].length === 0
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
  Buffer.from(JSON.stringify([item.score, item.hostname, item.id])).toString(
    "base64url",
  );

const toIsoString = (value: unknown) => {
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : new Date(0).toISOString();
};
const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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
const cooperationPathAction = (
  pathType: CooperationPathType,
): NonNullable<RecommendationCooperationPath["action"]> => {
  const actions: Readonly<Record<
    CooperationPathType,
    NonNullable<RecommendationCooperationPath["action"]>
  >> = {
    public_email: "SEND_EMAIL",
    contact_form: "OPEN_CONTACT_FORM",
    guest_post_submission: "OPEN_GUEST_POST_SUBMISSION",
    resource_submission: "OPEN_RESOURCE_SUBMISSION",
    editor_author_page: "OPEN_EDITOR_AUTHOR_PAGE",
  };
  return actions[pathType];
};
const toCooperationPath = (
  value: unknown,
): RecommendationCooperationPath | null => {
  const record = objectValue(value);
  const factId = nullableString(record.factId);
  const decision = record.decision;
  if (
    factId === null
    || (
      decision !== "pending"
      && decision !== "verified"
      && decision !== "unavailable"
      && decision !== "manual_review"
    )
  ) {
    return null;
  }
  const pathType = isCooperationPathType(record.pathType)
    ? record.pathType
    : null;
  const url = normalizeCooperationPathUrl(record.url);
  return {
    factId,
    decision,
    reasonCode: String(record.reasonCode),
    pathType,
    url,
    action: pathType === null ? null : cooperationPathAction(pathType),
    contentType:
      pathType === null ? null : cooperationContentTypeFor(pathType),
    evidence: objectValue(record.evidence),
    observedAt: toIsoString(record.observedAt),
  };
};
const correctedVisibilityRelations = [
  "backlink_recommendation_generation_contracts",
  "backlink_recommendation_qualification_facts",
  "backlink_recommendation_visibility_facts",
  "backlink_recommendation_cooperation_path_facts",
] as const;
async function readRecommendationSchemaCapabilities(
  client: RecommendationsQueryClient,
): Promise<
  Readonly<{
    correctedVisibility: boolean;
    aiCapacityAvailable: boolean;
    poolContractAvailable: boolean;
  }>
> {
  const result = await client.query(`
    SELECT
      (
        to_regclass('${correctedVisibilityRelations[0]}') IS NOT NULL
        AND to_regclass('${correctedVisibilityRelations[1]}') IS NOT NULL
        AND to_regclass('${correctedVisibilityRelations[2]}') IS NOT NULL
        AND to_regclass('${correctedVisibilityRelations[3]}') IS NOT NULL
      ) "correctedVisibility",
      (
        to_regclass('backlink_ai_capability_windows') IS NOT NULL
      ) "aiCapacityAvailable",
      (
        to_regclass('backlink_recommendation_pool_project_contracts') IS NOT NULL
      ) "poolContractAvailable"
  `);
  const row = result.rows[0] ?? {};
  return Object.freeze({
    correctedVisibility: row.correctedVisibility === true,
    aiCapacityAvailable: row.aiCapacityAvailable === true,
    poolContractAvailable: row.poolContractAvailable === true,
  });
}
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
  const resourceEvidence = evidenceRefs.find((reference) =>
    reference.startsWith("resource-type:"),
  );
  const resourceType = resourceEvidence?.slice("resource-type:".length);
  const normalizedResourceType =
    resourceType === "free" || resourceType === "paid" ? resourceType : null;
  const hasResource =
    sourceTypes.includes("CURATED_RESOURCE_LIBRARY") ||
    normalizedResourceType !== null;
  const hasPaidDiscovery =
    sourceTypes.some((sourceType) =>
      paidCandidateSourceTypes.has(sourceType),
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
    level:
      spamScore === null
        ? "unknown"
        : spamScore >= 70
          ? "high"
          : spamScore >= 30
            ? "medium"
            : "low",
  });
}

function cursorWindow(
  attempts: RecommendationInventorySummary["attemptedRefillTiers"],
  tier: RecommendationInventorySummary["currentRefillTier"] | null,
  round: number | null,
): number {
  if (tier === null || round === null) return 1;
  return (
    attempts.findLast(
      (attempt) => attempt.tier === tier && attempt.round === round,
    )?.window ?? 1
  );
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

function recommendationTerminationReason(
  persisted: RecommendationInventorySummary["terminationReason"],
  refillJob: Record<string, unknown> | null,
): RecommendationInventorySummary["terminationReason"] {
  if (persisted !== null) return persisted;
  switch (nullableString(refillJob?.step)) {
    case "paused_budget":
      return "BUDGET";
    case "paused_provider":
      return "PROVIDER_UNAVAILABLE";
    case "paused_project_context":
      return "PROJECT_CONTEXT";
    default:
      return null;
  }
}

function recommendationStage(
  input: Readonly<{
    terminalState: RecommendationInventorySummary["terminalState"];
    refillState: RecommendationInventorySummary["refillState"];
    refillJob: Record<string, unknown> | null;
    blueprintVersion: number | null;
  }>,
): RecommendationInventorySummary["stage"] {
  if (
    input.terminalState === "PAUSED_BUDGET" ||
    input.terminalState === "PAUSED_PROVIDER"
  ) {
    return "pause";
  }
  if (input.terminalState !== null) return "complete";
  if (input.blueprintVersion === null) return "blueprint";
  const step = nullableString(input.refillJob?.step);
  if (step?.includes("score") === true || step?.includes("match") === true) {
    return "match";
  }
  if (step?.includes("publish") === true) {
    return "publish";
  }
  if (
    input.refillState === "running" ||
    input.refillJob?.status === "queued" ||
    input.refillJob?.status === "running" ||
    input.refillJob?.status === "waiting_provider"
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
    attemptCount: Number(item.attemptCount),
    lastErrorCode: nullableString(item.lastErrorCode),
    terminalReasonCode: nullableString(
      item.terminalReasonCode,
    ) as RecommendationContactJob["terminalReasonCode"],
    method: item.method as RecommendationContactJob["method"],
    lastErrorCategory: nullableString(item.lastErrorCategory),
    retryAfter:
      item.retryAfter === null || item.retryAfter === undefined
        ? null
        : toIsoString(item.retryAfter),
    completedAt:
      item.completedAt === null || item.completedAt === undefined
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
  scoreGeneratedAt: unknown,
): RecommendationFitDecision {
  const fit = objectValue(value);
  const fitTotal = nullableNumber(fit.total);
  const fitRuleVersion = String(fit.ruleVersion ?? "");
  const fitScoreModelVersion = String(fit.scoreModelVersion ?? "");
  const persistedScoreModelVersion = String(scoreModelVersion ?? "");
  const supportedScoreModel =
    persistedScoreModelVersion === "recommendation-commercial-fit.v4" ||
    persistedScoreModelVersion === "recommendation-commercial-fit.v3";
  if (
    fit.decision !== "eligible" ||
    !supportedScoreModel ||
    fitScoreModelVersion !== persistedScoreModelVersion ||
    fitTotal === null ||
    Math.abs(fitTotal - score) > 0.0001 ||
    fitRuleVersion === "" ||
    fitRuleVersion !== String(ruleVersion)
  ) {
    throw new Error("PUBLISHED_RECOMMENDATION_FIT_SCORE_MISMATCH");
  }
  const details = objectValue(fit.details);
  const components: RecommendationFitDecision["components"] = arrayValue(
    fit.components,
  ).map((value) => {
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
      normalizationRuleVersion: String(component.normalizationRuleVersion),
      collectedAt: toIsoString(component.collectedAt),
    };
  });
  if (details.reassessmentReason === "HISTORICAL_V2_REASSESSED") {
    const projectContext = objectValue(details.projectContext);
    const targetCountry = String(projectContext.countryCode ?? "")
      .trim()
      .toUpperCase();
    const targetLanguage =
      String(projectContext.locale ?? "")
        .trim()
        .split(/[-_]/u)[0]
        ?.toLowerCase() ?? "";
    if (targetCountry === "" || targetLanguage === "") {
      throw new Error("PUBLISHED_RECOMMENDATION_HISTORICAL_CONTEXT_MISSING");
    }
    const evidenceRefs = (componentIds: readonly string[]) => [
      ...new Set(
        components
          .filter(({ id }) => componentIds.includes(id))
          .flatMap(({ evidenceRefs }) => evidenceRefs),
      ),
    ];
    const technicalComponent = components.find(
      ({ id }) => id === "safefetch_technical_access",
    );
    return {
      decision: "eligible",
      matchTier: fitTotal >= 75 ? "high_fit" : "qualified_fit",
      overallFit: fitTotal,
      scoreModelVersion: persistedScoreModelVersion,
      ruleVersion: fitRuleVersion,
      reasonCodes: ["HISTORICAL_V2_REASSESSED", "SAME_LANGUAGE_EXPANSION"],
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
        backlinkPageEvidence: [],
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
        technicalAccessibility: technicalComponent?.normalizedValue ?? null,
      },
      components,
    };
  }
  const market = objectValue(details.market);
  const dataForSeo = objectValue(details.dataForSeo);
  const safeFetch = objectValue(details.safeFetch);
  const collectedAt =
    dataForSeo.collectedAt === null || dataForSeo.collectedAt === undefined
      ? toIsoString(scoreGeneratedAt)
      : toIsoString(dataForSeo.collectedAt);
  const targetCountry = String(market.targetCountry ?? "unknown");
  const targetLanguage = String(market.targetLanguage ?? "und");
  const marketTier =
    market.tier === "target_market" ||
    market.tier === "same_language_expansion" ||
    market.tier === "market_language_mismatch"
      ? market.tier
      : "same_language_expansion";
  return {
    decision: "eligible",
    matchTier:
      details.matchTier === "high_fit" || details.matchTier === "qualified_fit"
        ? details.matchTier
        : fitTotal >= 75
          ? "high_fit"
          : "qualified_fit",
    overallFit: fitTotal,
    scoreModelVersion: persistedScoreModelVersion,
    ruleVersion: fitRuleVersion,
    reasonCodes:
      stringArray(details.reasonCodes).length > 0
        ? stringArray(details.reasonCodes)
        : ["LEGACY_STALE_RECALCULATING"],
    matchedProducts: stringArray(details.matchedProducts),
    matchedTopics: stringArray(details.matchedTopics),
    matchedKeywords: stringArray(details.matchedKeywords),
    matchedTargetPages: stringArray(details.matchedTargetPages),
    matchedAudiences: stringArray(details.matchedAudiences),
    market: {
      targetCountry,
      candidateCountry: nullableString(market.candidateCountry),
      targetLanguage,
      candidateLanguage: nullableString(market.candidateLanguage),
      tier: marketTier,
      reasonCode: String(
        market.reasonCode ?? "LEGACY_STALE_RECALCULATING",
      ),
    },
    cooperationAngles: stringArray(details.cooperationAngles),
    dataForSeo: {
      rank: nullableNumber(dataForSeo.rank),
      traffic: nullableNumber(dataForSeo.traffic),
      backlinks: nullableNumber(dataForSeo.backlinks),
      referringDomains: nullableNumber(dataForSeo.referringDomains),
      spamScore: nullableNumber(dataForSeo.spamScore),
      backlinkPageEvidence: arrayValue(
        dataForSeo.backlinkPageEvidence,
      ).flatMap((value) => {
        const evidence = objectValue(value);
        const sourceUrl = nullableString(evidence.sourceUrl);
        const targetUrl = nullableString(evidence.targetUrl);
        if (
          sourceUrl === null ||
          targetUrl === null ||
          (evidence.linkStatus !== "active" &&
            evidence.linkStatus !== "lost")
        ) {
          return [];
        }
        return [{
          sourceUrl,
          targetUrl,
          anchorText: nullableString(evidence.anchorText),
          linkStatus: evidence.linkStatus,
          firstSeenAt:
            evidence.firstSeenAt === null ||
            evidence.firstSeenAt === undefined
              ? null
              : toIsoString(evidence.firstSeenAt),
          lastSeenAt:
            evidence.lastSeenAt === null ||
            evidence.lastSeenAt === undefined
              ? null
              : toIsoString(evidence.lastSeenAt),
          sourceHttpStatus: nullableNumber(evidence.sourceHttpStatus),
          targetHttpStatus: nullableNumber(evidence.targetHttpStatus),
        }];
      }),
      evidenceRefs: stringArray(dataForSeo.evidenceRefs),
      collectedAt,
    },
    safeFetch: {
      relatedContentPages: stringArray(safeFetch.relatedContentPages),
      evidenceUrls: stringArray(safeFetch.evidenceUrls),
      evidenceRefs: stringArray(safeFetch.evidenceRefs),
      failedUrls: stringArray(safeFetch.failedUrls),
      technicalAccessibility: nullableNumber(safeFetch.technicalAccessibility),
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
      const capabilities = await readRecommendationSchemaCapabilities(client);
      if (capabilities.poolContractAvailable) {
        await assertV1RecommendationPoolReadContract(client, {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
        });
      }
      const executeListQuery = (correctedVisibility: boolean) =>
        client.query(
          `
        WITH visible_generation_candidates AS MATERIALIZED (
          SELECT inventory.recommendation_context_version_id,
                 inventory.visible_pool_generation,
                 inventory.fit_score_model_version score_model_version,
                 CASE
                   WHEN inventory.fit_score_model_version=
                     'recommendation-commercial-fit.v4'
                     THEN 'current'
                   ELSE 'legacy_stale'
                 END presentation_state,
                 CASE
                   WHEN inventory.fit_score_model_version=
                     'recommendation-commercial-fit.v4'
                     THEN 2
                   ELSE 1
                 END model_priority,
                 bool_or(visible_policy.visible_pool_state='active')
                   active_pool,
                 max(visible_policy.updated_at) policy_updated_at,
                 max(inventory.updated_at) inventory_updated_at
            FROM backlink_recommendation_inventory AS inventory
            JOIN backlink_commercial_inventory_policies AS visible_policy ON
              (
                visible_policy.organization_id,
                visible_policy.workspace_id,
                visible_policy.website_project_id,
                visible_policy.project_context_version_id,
                visible_policy.visible_pool_generation
              )=(
                inventory.organization_id,
                inventory.workspace_id,
                inventory.website_project_id,
                inventory.recommendation_context_version_id,
                inventory.visible_pool_generation
              )
           WHERE (
             inventory.organization_id,inventory.workspace_id,
             inventory.website_project_id
           )=($1,$2,$3)
             AND inventory.publication_status IN (
               'PUBLISHED','CONTACT_PENDING'
             )
             AND inventory.fit_decision='eligible'
             AND inventory.fit_score_model_version IN (
               'recommendation-commercial-fit.v4',
               'recommendation-commercial-fit.v3'
             )
             AND inventory.status IN ('ready','shown','accepted')
             AND visible_policy.visible_pool_state IN (
               'building','active','awaiting_refresh'
             )
             AND EXISTS (
               SELECT 1
                 FROM backlink_commercial_candidates AS candidate
                WHERE (
                  candidate.organization_id,candidate.workspace_id,
                  candidate.website_project_id,candidate.recommendation_id,
                  candidate.project_context_version_id
                )=(
                  inventory.organization_id,inventory.workspace_id,
                  inventory.website_project_id,inventory.recommendation_id,
                  inventory.recommendation_context_version_id
                )
                  AND candidate.visible_pool_generation=
                    inventory.visible_pool_generation
                  AND candidate.score_model_version=
                    inventory.fit_score_model_version
                  AND candidate.commercial_score->>'decision'='eligible'
             )
             AND ${
               correctedVisibility
                 ? `(
                   (
                     inventory.fit_score_model_version=
                       'recommendation-commercial-fit.v3'
                     AND visible_policy.visible_pool_state IN (
                       'building','active','awaiting_refresh'
                     )
                   )
                   OR (
                     inventory.fit_score_model_version=
                       'recommendation-commercial-fit.v4'
                     AND visible_policy.visible_pool_state IN (
                       'building','active'
                     )
                     AND EXISTS (
                         SELECT 1
                           FROM backlink_recommendation_generation_contracts
                             AS generation
                           JOIN LATERAL (
                             SELECT qualification.id,
                                    qualification.decision
                               FROM backlink_recommendation_qualification_facts
                                 AS qualification
                              WHERE (
                                qualification.organization_id,
                                qualification.workspace_id,
                                qualification.website_project_id,
                                qualification.generation_contract_id,
                                qualification.recommendation_context_version_id,
                                qualification.recommendation_id,
                                qualification.prospect_id
                              )=(
                                inventory.organization_id,
                                inventory.workspace_id,
                                inventory.website_project_id,
                                generation.id,
                                inventory.recommendation_context_version_id,
                                inventory.recommendation_id,
                                inventory.prospect_id
                              )
                              ORDER BY qualification.attempt DESC,
                                       qualification.observed_at DESC,
                                       qualification.id DESC
                              LIMIT 1
                           ) qualification ON true
                           JOIN LATERAL (
                             SELECT visibility.decision
                               FROM backlink_recommendation_visibility_facts
                                 AS visibility
                              WHERE (
                                visibility.organization_id,
                                visibility.workspace_id,
                                visibility.website_project_id,
                                visibility.generation_contract_id,
                                visibility.recommendation_context_version_id,
                                visibility.qualification_fact_id,
                                visibility.recommendation_id,
                                visibility.prospect_id
                              )=(
                                inventory.organization_id,
                                inventory.workspace_id,
                                inventory.website_project_id,
                                generation.id,
                                inventory.recommendation_context_version_id,
                                qualification.id,
                                inventory.recommendation_id,
                                inventory.prospect_id
                              )
                              ORDER BY visibility.attempt DESC,
                                       visibility.observed_at DESC,
                                       visibility.id DESC
                              LIMIT 1
                           ) visibility ON true
                          WHERE (
                            generation.organization_id,
                            generation.workspace_id,
                            generation.website_project_id,
                            generation.recommendation_context_version_id,
                            generation.visible_pool_generation
                          )=(
                            inventory.organization_id,
                            inventory.workspace_id,
                            inventory.website_project_id,
                            inventory.recommendation_context_version_id,
                            inventory.visible_pool_generation
                          )
                            AND generation.qualification_contract_version=
                              'recommendation-qualification.v1'
                            AND generation.visibility_contract_version=
                              'recommendation-visibility.v1'
                            AND generation.score_model_version=
                              'recommendation-commercial-fit.v4'
                            AND qualification.decision='eligible'
                            AND visibility.decision='visible'
                       )
                   )
                 )`
                 : `(
                   inventory.fit_score_model_version=
                     'recommendation-commercial-fit.v3'
                   OR (
                     inventory.fit_score_model_version=
                       'recommendation-commercial-fit.v4'
                     AND visible_policy.visible_pool_state IN (
                       'building','active'
                     )
                     AND inventory.status IN ('ready','shown')
                   )
                 )`
             }
            GROUP BY inventory.recommendation_context_version_id,
                     inventory.visible_pool_generation,
                     inventory.fit_score_model_version
        ),
        last_visible_generation AS MATERIALIZED (
          SELECT recommendation_context_version_id,
                 visible_pool_generation,
                 score_model_version,
                 presentation_state,
                 model_priority
            FROM visible_generation_candidates
           ORDER BY model_priority DESC,
                    active_pool DESC,
                    policy_updated_at DESC,
                    visible_pool_generation DESC,
                    inventory_updated_at DESC
           LIMIT 1
        )
        SELECT r.id,p.hostname_ascii "hostname",
               (fit.commercial_score->>'total')::double precision "score",
               visible_generation.presentation_state "presentationState",
               'corrected_visibility_v1' "contractKind",
               i.status,
               i.publication_status "publicationStatus",
               i.verified_public_email_count "verifiedPublicEmailCount",
               i.recommendation_context_version_id
                 "recommendationContextVersionId",
               i.version,i.created_at "acquiredAt",
               fit.commercial_score->>'scoreModelVersion' "scoreModelVersion",
               fit.commercial_score->>'ruleVersion' "ruleVersion",
               fit.updated_at "scoreGeneratedAt",
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
               ${
                 correctedVisibility
                   ? `CASE WHEN cooperation.id IS NULL THEN NULL
                      ELSE jsonb_build_object(
                        'factId',cooperation.id,
                        'decision',cooperation.decision,
                        'reasonCode',cooperation.decision_reason_code,
                        'pathType',cooperation.path_type,
                        'url',cooperation.path_url,
                        'evidence',cooperation.evidence,
                        'observedAt',cooperation.observed_at
                      )
                    END`
                   : "NULL::jsonb"
                } "cooperationPath",
               contact_page.page_url "contactPageUrl",
               CASE
                 WHEN o.id IS NOT NULL THEN 'existing_opportunity'
                 ELSE NULL
               END "createBlockReason",
               (
                 o.id IS NULL
                 AND visible_generation.presentation_state='current'
               ) "canCreateOpportunity",
               c.contacts,
               i.default_contact_candidate_id
                 "recommendedContactCandidateId",
                CASE
                  WHEN COALESCE(c.eligible_count,0)>=1 THEN 'contactable'
                  WHEN j.status IN (
                    'pending','running','retry_scheduled',
                    'partially_completed'
                  ) THEN 'running'
                  WHEN contact_page.page_url IS NOT NULL THEN 'review'
                  WHEN i.publication_status='CONTACT_REVIEW' THEN 'review'
                  WHEN j.id IS NULL THEN 'not_started'
                  ELSE 'not_found'
                END "contactStatus",
               CASE
                 WHEN COALESCE(c.eligible_count,0)>=1 THEN 'ready'
                 ${
                   correctedVisibility
                     ? `WHEN cooperation.decision='verified'
                          AND cooperation.path_type IN (
                            'contact_form','guest_post_submission',
                            'resource_submission','editor_author_page'
                          )
                          AND cooperation.path_url ~
                            '^https?://[^[:space:]]+$'
                          AND cooperation.path_url !~ '^https?://[^/]*@'
                        THEN 'manual_action'
                        WHEN cooperation.decision='manual_review'
                          THEN 'manual_review'`
                     : ""
                  }
                  WHEN contact_page.page_url IS NOT NULL
                    THEN 'manual_review'
                  WHEN i.publication_status='CONTACT_REVIEW'
                    THEN 'manual_review'
                 WHEN j.status IN (
                   'pending','running','retry_scheduled',
                   'partially_completed'
                 ) THEN 'contact_pending'
                 ${
                   correctedVisibility
                      ? `WHEN cooperation.decision='pending'
                        THEN 'contact_pending'`
                      : ""
                 }
                 ELSE 'unavailable'
               END "outreachReadiness",
               CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object(
                 'id',j.id,
                 'batchId',j.batch_id,
                 'status',j.status,
                  'candidateCount',j.candidate_count,
                  'evidenceCount',j.evidence_count,
                  'pagesVisited',j.pages_visited,
                  'attemptCount',j.attempt_count,
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
           AND policy.visible_pool_generation=i.visible_pool_generation
          JOIN last_visible_generation AS visible_generation ON
            (
              visible_generation.recommendation_context_version_id,
              visible_generation.visible_pool_generation
            )=(
              i.recommendation_context_version_id,
              i.visible_pool_generation
            )
          ${
            correctedVisibility
              ? `
           LEFT JOIN LATERAL (
             SELECT contract.id
               FROM backlink_recommendation_generation_contracts AS contract
             WHERE (
               contract.organization_id,contract.workspace_id,
               contract.website_project_id,
               contract.recommendation_context_version_id,
               contract.visible_pool_generation
             )=(
               i.organization_id,i.workspace_id,i.website_project_id,
               i.recommendation_context_version_id,
               i.visible_pool_generation
             )
               AND contract.qualification_contract_version=
                 'recommendation-qualification.v1'
               AND contract.visibility_contract_version=
                 'recommendation-visibility.v1'
               AND contract.score_model_version=
                 'recommendation-commercial-fit.v4'
             LIMIT 1
          ) generation ON true
           LEFT JOIN LATERAL (
            SELECT qualification.id,qualification.decision
              FROM backlink_recommendation_qualification_facts
                AS qualification
             WHERE generation.id IS NOT NULL
               AND (
                 qualification.organization_id,
                 qualification.workspace_id,
                 qualification.website_project_id,
                 qualification.generation_contract_id,
                 qualification.recommendation_context_version_id,
                 qualification.recommendation_id,
                 qualification.prospect_id
               )=(
                 i.organization_id,i.workspace_id,
                 i.website_project_id,generation.id,
                 i.recommendation_context_version_id,
                 i.recommendation_id,i.prospect_id
               )
             ORDER BY qualification.attempt DESC,
                      qualification.observed_at DESC,
                      qualification.id DESC
             LIMIT 1
          ) qualification ON true
          LEFT JOIN LATERAL (
            SELECT visibility.decision
              FROM backlink_recommendation_visibility_facts AS visibility
             WHERE qualification.id IS NOT NULL
               AND (
                 visibility.organization_id,
                 visibility.workspace_id,
                 visibility.website_project_id,
                 visibility.generation_contract_id,
                 visibility.recommendation_context_version_id,
                 visibility.qualification_fact_id,
                 visibility.recommendation_id,
                 visibility.prospect_id
               )=(
                 i.organization_id,i.workspace_id,
                 i.website_project_id,generation.id,
                 i.recommendation_context_version_id,
                 qualification.id,i.recommendation_id,i.prospect_id
               )
             ORDER BY visibility.attempt DESC,
                      visibility.observed_at DESC,
                      visibility.id DESC
              LIMIT 1
           ) visibility ON true
          LEFT JOIN LATERAL (
            SELECT cooperation.id,cooperation.decision,
                   cooperation.decision_reason_code,cooperation.path_type,
                   cooperation.evidence,cooperation.observed_at,
                   COALESCE(
                     NULLIF(btrim(cooperation.evidence->>'url'),''),
                     NULLIF(btrim(cooperation.evidence->>'pathUrl'),''),
                     NULLIF(btrim(cooperation.evidence->>'sourceUrl'),'')
                   ) path_url
              FROM backlink_recommendation_cooperation_path_facts
                AS cooperation
             WHERE generation.id IS NOT NULL
               AND (
                 cooperation.organization_id,
                 cooperation.workspace_id,
                 cooperation.website_project_id,
                 cooperation.generation_contract_id,
                 cooperation.recommendation_context_version_id,
                 cooperation.recommendation_id,
                 cooperation.prospect_id
               )=(
                 i.organization_id,i.workspace_id,
                 i.website_project_id,generation.id,
                 i.recommendation_context_version_id,
                 i.recommendation_id,i.prospect_id
               )
             ORDER BY cooperation.attempt DESC,
                      cooperation.observed_at DESC,
                      cooperation.id DESC
             LIMIT 1
          ) cooperation ON true
          `
              : ""
          }
           JOIN backlink_recommendations r ON
             (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
             (i.organization_id,i.workspace_id,i.website_project_id,
              i.recommendation_id)
           JOIN backlink_prospects p ON
             (p.organization_id,p.workspace_id,p.website_project_id,p.id)=
             (i.organization_id,i.workspace_id,i.website_project_id,
              i.prospect_id)
          JOIN LATERAL (
            SELECT commercial_score,source_types,updated_at
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
                 visible_generation.score_model_version
               AND candidate.commercial_score->>'decision'='eligible'
             ORDER BY candidate.updated_at DESC,candidate.id DESC
             LIMIT 1
          ) fit ON true
          LEFT JOIN backlink_contact_evidence_snapshots AS snapshot ON
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
            SELECT page.page_url
              FROM backlink_contact_enrichment_pages AS page
             WHERE j.id IS NOT NULL
               AND j.terminal_reason_code='CONTACT_FORM_ONLY'
               AND (
                 page.organization_id,page.workspace_id,
                 page.website_project_id,page.job_id
               )=(
                 j.organization_id,j.workspace_id,
                 j.website_project_id,j.id
               )
               AND page.status IN ('fetched','browser_fetched')
             ORDER BY
               CASE
                 WHEN page.page_url ~*
                   '/(contact(-us)?|advertis(e|ing)|partnerships?|write-for-us|editorial)([/?#]|$)'
                 THEN 0
                 ELSE 1
               END,
               page.observed_at DESC,page.id DESC
             LIMIT 1
          ) contact_page ON true
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
           AND i.fit_decision='eligible'
           AND visible_generation.score_model_version=i.fit_score_model_version
           AND ${
             correctedVisibility
               ? `(
                (
                  visible_generation.presentation_state='current'
                  AND
                  generation.id IS NOT NULL
                  AND policy.visible_pool_state IN ('building','active')
                  AND qualification.decision='eligible'
                  AND visibility.decision='visible'
                )
                OR (
                  visible_generation.presentation_state='legacy_stale'
                  AND policy.visible_pool_state IN (
                    'building','active','awaiting_refresh'
                  )
                  AND i.publication_status='PUBLISHED'
                  AND i.status IN ('ready','shown','accepted')
                )
              )`
               : `(
                  (
                    visible_generation.presentation_state='current'
                    AND policy.visible_pool_state IN ('building','active')
                    AND i.status IN ('ready','shown')
                  )
                  OR (
                    visible_generation.presentation_state='legacy_stale'
                    AND policy.visible_pool_state IN (
                      'building','active','awaiting_refresh'
                    )
                    AND i.publication_status='PUBLISHED'
                    AND i.status IN ('ready','shown','accepted')
                  )
                )`
           }
           AND (
             $5::numeric IS NULL
             OR (fit.commercial_score->>'total')::numeric >= $5
           )
           AND (
             $6::numeric IS NULL
             OR (fit.commercial_score->>'total')::numeric < $6
             OR (
               (fit.commercial_score->>'total')::numeric=$6
               AND p.hostname_ascii > $7
             )
             OR (
               (fit.commercial_score->>'total')::numeric=$6
               AND p.hostname_ascii=$7
               AND r.id > $8::uuid
             ))
         ORDER BY (fit.commercial_score->>'total')::numeric DESC,
                  p.hostname_ascii,r.id
         LIMIT $9
      `,
          [
            context.tenant.organizationId,
            context.tenant.workspaceId,
            context.project.websiteProjectId,
            input.status ?? null,
            input.minScore ?? null,
            after?.[0] ?? null,
            after?.[1] ?? null,
            after?.[2] ?? null,
            input.limit + 1,
          ],
        );
      const result = await executeListQuery(capabilities.correctedVisibility);
      const items = result.rows.slice(0, input.limit).map((row) => {
        const hostname = String(row.hostname);
        const rootUrl = toWebsiteUrl(hostname, row.rootUrl);
        const contacts = arrayValue(row.contacts).map(toContactCandidate);
        const selectedContact = contacts.find(
          (contact) =>
            contact.id === nullableString(row.recommendedContactCandidateId),
        );
        const selectedEvidence = selectedContact?.evidence[0];
        const contractKind = "corrected_visibility_v1" as const;
        const fitDecision = toFitDecision(
          row.fitScore,
          Number(row.score),
          row.scoreModelVersion,
          row.ruleVersion,
          row.scoreGeneratedAt,
        );
        const presentationState: RecommendationPresentationState =
          row.presentationState === "legacy_stale"
            ? "legacy_stale"
            : "current";
        const source = recommendationSource(
          stringArray(row.sourceTypes),
          fitDecision.dataForSeo.evidenceRefs,
        );
        const cooperationPath = toCooperationPath(row.cooperationPath);
        const outreachReadiness: RecommendationListItem["outreachReadiness"] =
          row.outreachReadiness === "ready" ||
          row.outreachReadiness === "manual_action" ||
          row.outreachReadiness === "contact_pending" ||
          row.outreachReadiness === "manual_review" ||
          row.outreachReadiness === "unavailable"
            ? row.outreachReadiness
            : selectedEvidence === undefined
              ? "unavailable"
              : "ready";
        return {
          id: String(row.id),
          hostname,
          score: Number(row.score),
          presentationState,
          contractKind,
          outreachReadiness,
          priority:
            Number(row.score) >= 80 ? ("high" as const) : ("standard" as const),
          ...source,
          risk: recommendationRisk(fitDecision.dataForSeo.spamScore),
          relevantPages: fitDecision.safeFetch.relatedContentPages,
          emailSource:
            selectedEvidence === undefined
              ? null
              : {
                  url: selectedEvidence.sourceUrl,
                  extractionMethod: selectedEvidence.extractionMethod,
                  observedAt: selectedEvidence.observedAt,
                },
          status: row.status as RecommendationListItem["status"],
          publicationStatus: String(
            row.publicationStatus,
          ) as RecommendationListItem["publicationStatus"],
          verifiedPublicEmailCount: Number(row.verifiedPublicEmailCount),
          recommendationContextVersionId: String(
            row.recommendationContextVersionId,
          ),
          version: Number(row.version),
          scoreModelVersion: String(row.scoreModelVersion),
          ruleVersion: String(row.ruleVersion),
          fitDecision,
          contactDecision:
            selectedEvidence === undefined
              ? null
              : {
                  decision: "eligible" as const,
                  reasonCode: "PUBLIC_EMAIL_FOUND" as const,
                  sourceUrl: String(row.contactDecisionSourceUrl),
                  inferredPurpose: String(row.contactDecisionPurpose),
                  contactConfidence: Number(row.contactDecisionConfidence),
                  purposeConfidence: Number(
                    row.contactDecisionPurposeConfidence,
                  ),
                  evidenceConfidence: Number(
                    row.contactDecisionEvidenceConfidence,
                  ),
                  collectedAt: toIsoString(row.contactDecisionCollectedAt),
                  rulesVersion: String(row.contactDecisionRulesVersion),
                },
          cooperationPath,
          contactPageUrl: nullableString(row.contactPageUrl),
          rootUrl,
          faviconUrl: new URL("/favicon.ico", rootUrl).toString(),
          acquiredAt: toIsoString(row.acquiredAt ?? row.scoreGeneratedAt),
          contactStatus: (row.contactStatus ??
            "not_started") as RecommendationListItem["contactStatus"],
          contactJob: toContactJob(row.contactJob),
          contacts,
          recommendedContactCandidateId: nullableString(
            row.recommendedContactCandidateId,
          ),
          existingOpportunityId: nullableString(row.existingOpportunityId),
          canCreateOpportunity:
            presentationState === "current" &&
            row.canCreateOpportunity === true,
          createBlockReason: nullableString(
            row.createBlockReason,
          ) as RecommendationListItem["createBlockReason"],
        };
      });
      const hasMore = result.rows.length > input.limit;
      const last = items.at(-1);
      return {
        items,
        presentationState:
          items[0]?.presentationState === "legacy_stale"
            ? "legacy_stale"
            : "current",
        hasMore,
        nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      };
    },
    async getRecommendationInventoryStatus(
      context,
      runningBuildId = "unknown",
    ) {
      const capabilities = await readRecommendationSchemaCapabilities(client);
      if (capabilities.poolContractAvailable) {
        await assertV1RecommendationPoolReadContract(client, {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
        });
      }
      const executeInventoryQuery = (
        correctedVisibility: boolean,
        aiCapacityAvailable: boolean,
      ) =>
        client.query(
          `
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
        ${
          correctedVisibility
            ? `
        generation_contract AS (
          SELECT contract.id
            FROM backlink_recommendation_generation_contracts AS contract
           WHERE (
             contract.organization_id,contract.workspace_id,
             contract.website_project_id,
             contract.recommendation_context_version_id,
             contract.visible_pool_generation
           )=(
             $1,$2,$3,(SELECT id FROM current_context),
             (SELECT visible_pool_generation FROM pool_policy)
           )
             AND contract.qualification_contract_version=
               'recommendation-qualification.v1'
             AND contract.visibility_contract_version=
               'recommendation-visibility.v1'
           LIMIT 1
        ),
        latest_qualification AS (
          SELECT DISTINCT ON (qualification.canonical_domain)
                 qualification.id,qualification.recommendation_id,
                 qualification.canonical_domain,
                 qualification.decision
            FROM backlink_recommendation_qualification_facts
              AS qualification
           WHERE (
             qualification.organization_id,
             qualification.workspace_id,
             qualification.website_project_id
           )=($1,$2,$3)
             AND qualification.generation_contract_id=(
               SELECT id FROM generation_contract
             )
             AND qualification.recommendation_context_version_id=(
               SELECT id FROM current_context
             )
             AND qualification.recommendation_id IS NOT NULL
           ORDER BY qualification.canonical_domain,
                    qualification.attempt DESC,
                    qualification.observed_at DESC,
                    qualification.id DESC
        ),
        latest_visibility AS (
          SELECT DISTINCT ON (visibility.canonical_domain)
                 visibility.canonical_domain,visibility.qualification_fact_id,
                 visibility.decision
            FROM backlink_recommendation_visibility_facts AS visibility
           WHERE (
             visibility.organization_id,visibility.workspace_id,
             visibility.website_project_id
           )=($1,$2,$3)
             AND visibility.generation_contract_id=(
               SELECT id FROM generation_contract
             )
             AND visibility.recommendation_context_version_id=(
               SELECT id FROM current_context
             )
             AND visibility.recommendation_id IS NOT NULL
           ORDER BY visibility.canonical_domain,
                    visibility.attempt DESC,
                    visibility.observed_at DESC,
                    visibility.id DESC
        ),
        corrected_visibility_counts AS (
          SELECT count(*) FILTER (
                   WHERE qualification.decision='eligible'
                 )::integer fit_count,
                 count(*) FILTER (
                   WHERE qualification.decision='eligible'
                     AND visibility.decision='visible'
                     AND visibility.qualification_fact_id=qualification.id
                 )::integer visible_count
            FROM latest_qualification AS qualification
             LEFT JOIN latest_visibility AS visibility
               ON visibility.canonical_domain=
                  qualification.canonical_domain
        ),
        `
            : `
        generation_contract AS (
          SELECT NULL::uuid id
           WHERE false
        ),
        corrected_visibility_counts AS (
          SELECT 0::integer fit_count,0::integer visible_count
        ),
        `
        }
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
                  'recommendation-commercial-fit.v4'
                AND commercial_score->>'decision'='eligible'
            )::integer candidate_ready_count,
            count(*) FILTER (
              WHERE score_model_version=
                'recommendation-commercial-fit.v4'
            )::integer historical_candidate_count,
            count(*) FILTER (
              WHERE score_model_version=
                'recommendation-commercial-fit.v4'
                AND commercial_score->>'decision'='eligible'
            )::integer fit_count,
            max(provider_collected_at) FILTER (
              WHERE score_model_version=
                'recommendation-commercial-fit.v4'
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
        latest_discovery_batch AS (
          SELECT
            raw_candidate_count,
            COALESCE(finished_at,started_at) observed_at
            FROM backlink_commercial_discovery_batches
           WHERE (organization_id,workspace_id,website_project_id)=
                 ($1,$2,$3)
             AND project_context_version_id=(SELECT id FROM current_context)
             AND visible_pool_generation=(
               SELECT visible_pool_generation FROM pool_policy
             )
           ORDER BY started_at DESC,id DESC
           LIMIT 1
        ),
        publication_counts AS (
          SELECT
            count(*) FILTER (
              WHERE inventory.publication_status IN ('PUBLISHED','CONTACT_PENDING')
                AND inventory.fit_decision='eligible'
                AND inventory.fit_score_model_version=
                  'recommendation-commercial-fit.v4'
                AND inventory.status IN ('ready','shown','accepted')
                AND recommendation.status IN ('ready','shown','accepted')
                AND EXISTS (
                  SELECT 1
                    FROM backlink_commercial_candidates AS candidate
                   WHERE (
                     candidate.organization_id,candidate.workspace_id,
                     candidate.website_project_id,candidate.recommendation_id,
                     candidate.project_context_version_id,
                     candidate.visible_pool_generation
                   )=(
                     inventory.organization_id,inventory.workspace_id,
                     inventory.website_project_id,inventory.recommendation_id,
                     inventory.recommendation_context_version_id,
                     inventory.visible_pool_generation
                   )
                     AND candidate.score_model_version=
                       'recommendation-commercial-fit.v4'
                     AND candidate.commercial_score->>'decision'='eligible'
                )
            )::integer published_count,
            count(*) FILTER (
              WHERE inventory.fit_decision='eligible'
                AND inventory.fit_score_model_version=
                  'recommendation-commercial-fit.v4'
                AND inventory.contact_decision='eligible'
                AND inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'
                AND inventory.verified_public_email_count>=1
            )::integer contact_count,
            count(*) FILTER (
              WHERE inventory.fit_decision='eligible'
                AND inventory.fit_score_model_version=
                  'recommendation-commercial-fit.v4'
                AND inventory.publication_status<>'PUBLISHED'
            )::integer unpublished_count,
            count(*) FILTER (
              WHERE inventory.verified_public_email_count>=1
                AND inventory.fit_decision='eligible'
                AND inventory.fit_score_model_version=
                  'recommendation-commercial-fit.v4'
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
          SELECT DISTINCT regexp_replace(
                   idempotency_key,
                   '^commercial-discovery:',
                   ''
                 ) AS refill_window_key
            FROM backlink_commercial_discovery_batches
           WHERE (
             organization_id,workspace_id,website_project_id
           )=($1,$2,$3)
             AND project_context_version_id=
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
                JOIN provider_batch_requests AS request
                  ON (
                    usage.organization_id,usage.workspace_id,
                    usage.website_project_id,usage.provider_request_id
                  )=(
                    request.organization_id,request.workspace_id,
                    request.website_project_id,request.id
                  )
                 AND usage.reservation_key=request.budget_reservation_id
                JOIN generation_refills AS refill
                  ON request.request_id LIKE refill.refill_window_key||':%'
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
              JOIN provider_batch_requests AS request
                ON (
                  usage.organization_id,usage.workspace_id,
                  usage.website_project_id,usage.provider_request_id
                )=(
                  request.organization_id,request.workspace_id,
                  request.website_project_id,request.id
                )
               AND usage.reservation_key=request.budget_reservation_id
              JOIN generation_refills AS refill
                ON request.request_id LIKE refill.refill_window_key||':%'
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
              JOIN provider_batch_requests AS request
                ON (
                  usage.organization_id,usage.workspace_id,
                  usage.website_project_id,usage.provider_request_id
                )=(
                  request.organization_id,request.workspace_id,
                  request.website_project_id,request.id
                )
               AND usage.reservation_key=request.budget_reservation_id
              JOIN generation_refills AS refill
                ON request.request_id LIKE refill.refill_window_key||':%'
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
              JOIN provider_batch_requests AS request
                ON (
                  usage.organization_id,usage.workspace_id,
                  usage.website_project_id,usage.provider_request_id
                )=(
                  request.organization_id,request.workspace_id,
                  request.website_project_id,request.id
                )
               AND usage.reservation_key=request.budget_reservation_id
              JOIN generation_refills AS refill
                ON request.request_id LIKE refill.refill_window_key||':%'
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
        ai_capacity AS (
          ${
            aiCapacityAvailable
              ? `
          SELECT
            GREATEST(
              capability_window.call_limit
                -capability_window.reserved_calls
                -capability_window.settled_calls,
              0
            )::integer remaining_calls,
            GREATEST(
              capability_window.budget_limit_usd
                -capability_window.reserved_cost_usd
                -capability_window.spent_cost_usd,
              0
            ) remaining_budget_usd
            FROM backlink_ai_capability_windows AS capability_window
           WHERE (
              capability_window.organization_id,
              capability_window.workspace_id,
              capability_window.website_project_id
            )=($1,$2,$3)
              AND capability_window.capability='AI_DISCOVERY'
              AND capability_window.window_expires_at>now()
            ORDER BY capability_window.window_started_at DESC,
                     capability_window.id DESC
           LIMIT 1
          `
              : `
          SELECT NULL::integer remaining_calls,
                 NULL::numeric remaining_budget_usd
           WHERE false
          `
          }
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
	                   SELECT max(job.completed_at)
	                     FROM backlink_contact_enrichment_jobs AS job
	                    WHERE (
	                      job.organization_id,job.workspace_id,
	                      job.website_project_id,job.batch_id
	                    )=(
	                      b.organization_id,b.workspace_id,
	                      b.website_project_id,b.id
	                    )
	                      AND job.terminal_reason_code IS NOT NULL
	                 ) terminal_completed_at,
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
                        'recommendation-commercial-fit.v4'
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
                    ${
                      correctedVisibility
                        ? `AND (
                      (SELECT id FROM generation_contract) IS NULL
                      OR EXISTS (
                        SELECT 1
                          FROM latest_qualification AS qualification
                          JOIN latest_visibility AS visibility
                            ON visibility.canonical_domain=
                               qualification.canonical_domain
                           AND visibility.qualification_fact_id=
                               qualification.id
                         WHERE qualification.recommendation_id=
                               scoped_inventory.recommendation_id
                           AND qualification.decision='eligible'
                           AND visibility.decision='visible'
                      )
                    )`
                        : ""
                    }
               )
           ORDER BY b.started_at DESC,b.id DESC
           LIMIT 1
        )
        SELECT
          (SELECT id FROM current_context)
            "recommendationContextVersionId",
          'corrected_visibility_v1' "contractKind",
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
            latest_discovery_batch.observed_at,
            policy.updated_at,
            latest_refill_job.updated_at
          ) "serverUpdatedAt",
          COALESCE(candidate_counts.candidate_ready_count,0)
            "candidateReadyCount",
          COALESCE(latest_discovery_batch.raw_candidate_count,0)
            "rawCandidateCount",
          CASE WHEN generation_contract.id IS NULL
            THEN COALESCE(candidate_counts.fit_count,0)
            ELSE COALESCE(corrected_visibility_counts.fit_count,0)
          END "fitCount",
          COALESCE(publication_counts.contact_count,0)
            "contactCount",
          COALESCE(publication_counts.published_count,0)
            "publishedContactReadyCount",
          COALESCE(publication_counts.published_count,0)
            "visibleMatchCount",
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
          0 "publishedLowWatermark",
          COALESCE(policy.visible_pool_target_count,10)
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
          CASE
            WHEN policy.refill_state='waiting_contact' THEN 'idle'
            ELSE COALESCE(policy.refill_state,'idle')
          END "refillState",
          COALESCE(
            policy.current_refill_tier,
            'curated_resource_library'
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
          NULL::bigint "providerBalanceMicros",
          ai_capacity.remaining_calls "aiRemainingCalls",
          CASE WHEN ai_capacity.remaining_budget_usd IS NULL THEN NULL
            ELSE round(ai_capacity.remaining_budget_usd*1000000)
          END::bigint "aiRemainingBudgetMicros",
          CASE WHEN latest_refill_job.started_at IS NULL THEN 0
            ELSE GREATEST(
              EXTRACT(EPOCH FROM (
                COALESCE(
                  latest_refill_job.finished_at,
                  CASE WHEN latest_refill_job.status IN (
                    'queued','running','waiting_provider'
                  ) THEN now() ELSE latest_refill_job.updated_at END
                )-latest_refill_job.started_at
              )),
              0
            )
          END::bigint "activeProcessingSeconds",
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
	              'completedAt',contact_batch.completed_at,
	              'terminalCompletedAt',contact_batch.terminal_completed_at
	            )
          END "contactBatch"
        FROM candidate_counts
        CROSS JOIN publication_counts
        CROSS JOIN corrected_visibility_counts
        CROSS JOIN running_batch
        CROSS JOIN provider_call_state
        LEFT JOIN generation_contract ON true
        LEFT JOIN ai_capacity ON true
        LEFT JOIN latest_discovery_batch ON true
        LEFT JOIN latest_blueprint ON true
        LEFT JOIN latest_refill_job ON true
        LEFT JOIN contact_batch ON true
        LEFT JOIN pool_policy AS policy ON true
      `,
          [
            context.tenant.organizationId,
            context.tenant.workspaceId,
            context.project.websiteProjectId,
          ],
        );
      const result = await executeInventoryQuery(
        capabilities.correctedVisibility,
        capabilities.aiCapacityAvailable,
      );
      const row = result.rows[0] ?? {};
      const contractKind = "corrected_visibility_v1" as const;
      const rawContactBatch =
        row.contactBatch === null || row.contactBatch === undefined
          ? null
          : objectValue(row.contactBatch);
      const persistedRefillJob =
        row.refillJob === null || row.refillJob === undefined
          ? null
          : objectValue(row.refillJob);
      const attemptedRefillTiers = arrayValue(row.attemptedRefillTiers).map(
        (value) => {
          const attempt = objectValue(value);
          return Object.freeze({
            tier: String(
              attempt.tier,
            ) as RecommendationInventorySummary["currentRefillTier"],
            round: Number(attempt.round),
            window: Number(attempt.window ?? 1),
          });
        },
      );
      const currentRefillTier = String(
        row.currentRefillTier ?? "curated_resource_library",
      ) as RecommendationInventorySummary["currentRefillTier"];
      const currentRefillRound = Number(row.currentRefillRound ?? 1);
      const publishedContactReadyCount = Number(
        row.publishedContactReadyCount ?? 0,
      );
      const visibleMatchCount = Number(
        row.visibleMatchCount ?? publishedContactReadyCount,
      );
	      const contactBatch =
	        contractKind === "corrected_visibility_v1" && visibleMatchCount === 0
	          ? null
	          : rawContactBatch;
	      const contactBatchTotalJobCount = Number(
	        contactBatch?.totalJobCount ?? 0,
	      );
	      const contactBatchTerminalJobCount = Number(
	        contactBatch?.terminalJobCount ?? 0,
	      );
	      const contactBatchStatus =
	        contactBatch?.status === "stale_context"
	          ? "stale_context"
	          : contactBatchTotalJobCount > 0 &&
	              contactBatchTerminalJobCount >= contactBatchTotalJobCount
	            ? "completed"
	            : contactBatch?.status;
      const publishedCount = visibleMatchCount;
      const targetCount = resolveCommercialSupplyPublishedTarget(
        process.env.BACKLINK_RECOMMENDATION_POOL_TARGET_COUNT
          ?? row.visiblePoolTargetCount,
      );
      const persistedTerminationReason = nullableString(
        row.terminationReason,
      ) as RecommendationInventorySummary["terminationReason"];
      const terminationReason =
        publishedCount >= targetCount
          ? persistedTerminationReason
          : recommendationTerminationReason(
              persistedTerminationReason,
              persistedRefillJob,
            );
      const terminalState = recommendationTerminalState(
        terminationReason,
        publishedCount,
        targetCount,
      );
      const refillJob =
        terminalState === "TARGET_REACHED" ? null : persistedRefillJob;
      const refillFailure =
        refillJob?.failure === null || refillJob?.failure === undefined
          ? null
          : objectValue(refillJob.failure);
      const blueprintVersion =
        row.blueprintVersion === null || row.blueprintVersion === undefined
          ? null
          : Number(row.blueprintVersion);
      const persistedRefillState = String(
        row.refillState ?? "idle",
      ) as RecommendationInventorySummary["refillState"];
      const refillInFlight = row.refillInFlight === true;
      const refillState =
        persistedRefillState === "running" && !refillInFlight
          ? "idle"
          : persistedRefillState;
      const paidRefillTier = nullableString(row.paidRefillTier) as
        | NonNullable<RecommendationInventorySummary["paidCursor"]>["tier"]
        | null;
      const paidRefillRound = nullableNumber(row.paidRefillRound);
      const resourceRefillTier = nullableString(row.resourceRefillTier);
      const resourceRefillRound = nullableNumber(row.resourceRefillRound);
      const nextRetryAt =
        row.nextRefillAt === null || row.nextRefillAt === undefined
          ? null
          : toIsoString(row.nextRefillAt);
      const persistedFailureRootCause = nullableString(
        refillFailure?.rootCause,
      ) as Parameters<
        typeof deriveRecommendationProductState
      >[0]["failureRootCause"];
      const failureRootCause =
        nullableString(refillJob?.errorCode)
          === "COMMERCIAL_SUPPLY_OPERATION_NOT_FOUND"
          ? "RECOVERY_CONFLICT"
          : persistedFailureRootCause;
      const providerCallOccurred =
        row.providerCallOccurred === true ||
        refillFailure?.providerCallOccurred === true;
      const unknownChargeCount = Number(
        row.providerUnknownChargeCount ?? 0,
      );
      const canResumeSameOperation =
        failureRootCause === "UNKNOWN_INTERNAL" &&
        nullableString(refillJob?.operationId) !== null &&
        nullableString(refillJob?.status) === "failed" &&
        Number(refillJob?.retryCount ?? 0) < 6 &&
        !providerCallOccurred &&
        unknownChargeCount === 0;
      const productState = deriveRecommendationProductState({
        visibleCount: visibleMatchCount,
        targetCount,
        refillInFlight,
        nextRetryAt,
        terminationReason,
        failureRootCause,
        canResumeSameOperation,
        unknownChargeCount,
      });
      const aiRemainingCalls = nullableNumber(row.aiRemainingCalls);
      const aiRemainingBudgetMicros = nullableNumber(
        row.aiRemainingBudgetMicros,
      );
      const defaultRecovery =
        terminalState === "PAUSED_PROVIDER"
          ? ("WAIT_PROVIDER" as const)
          : terminalState === "PAUSED_BUDGET"
            ? ("RESUME_OPERATION" as const)
            : terminalState === "PROJECT_CONTEXT_REQUIRED"
              ? ("COMPLETE_PROJECT_CONTEXT" as const)
              : terminalState === "SUPPLY_FLOOR_REACHED"
                ? ("ACCEPT_SUPPLY_FLOOR" as const)
                : null;
      return Object.freeze({
        contractVersion: "backlinks.recommendation-operation.v1" as const,
        contractKind,
        productState: productState.state,
        productStateReason: productState.reasonCode,
        recoveryCommand: productState.recoveryCommand,
        providerAvailability: productState.providerAvailability,
        visibleMatchCount,
        activeProcessingSeconds: Number(row.activeProcessingSeconds ?? 0),
        providerBalanceMicros: nullableNumber(row.providerBalanceMicros),
        aiCapacity: Object.freeze({
          status:
            aiRemainingCalls === null || aiRemainingBudgetMicros === null
              ? ("unconfigured" as const)
              : aiRemainingCalls > 0 && aiRemainingBudgetMicros > 0
                ? ("available" as const)
                : ("exhausted" as const),
          remainingCalls: aiRemainingCalls,
          remainingBudgetMicros: aiRemainingBudgetMicros,
        }),
        runningBuildId,
        visiblePoolGeneration: Number(row.visiblePoolGeneration ?? 1),
        visiblePoolState: String(
          row.visiblePoolState ?? "idle",
        ) as RecommendationInventorySummary["visiblePoolState"],
        visiblePoolTargetCount: targetCount,
        archivedVisiblePoolCount: Number(row.archivedVisiblePoolCount ?? 0),
        visiblePoolArchivedAt:
          row.visiblePoolArchivedAt === null ||
          row.visiblePoolArchivedAt === undefined
            ? null
            : toIsoString(row.visiblePoolArchivedAt),
        operationId: nullableString(refillJob?.operationId),
        jobId: nullableString(refillJob?.id),
        stage: recommendationStage({
          terminalState,
          refillState,
          refillJob,
          blueprintVersion,
        }),
        terminal:
          terminalState === "TARGET_REACHED" ||
          terminalState === "PROJECT_CONTEXT_REQUIRED" ||
          terminalState === "SUPPLY_FLOOR_REACHED",
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
        paidCursor:
          paidRefillTier === null || paidRefillRound === null
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
          resourceRefillTier !== "curated_resource_library" ||
          resourceRefillRound === null
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
        nextRetryAt,
        errorCode:
          terminalState === "TARGET_REACHED"
            ? null
            : (nullableString(refillJob?.errorCode) ??
              nullableString(refillFailure?.rootCause) ??
              nullableString(row.pauseReason)),
        recoveryAction:
          terminalState === "TARGET_REACHED"
            ? null
            : ((nullableString(refillFailure?.recovery) ??
                defaultRecovery) as RecommendationInventorySummary["recoveryAction"]),
        providerCallOccurred,
        providerActualCostMicros: Number(row.providerActualCostMicros ?? 0),
        providerReservedCostMicros: Number(row.providerReservedCostMicros ?? 0),
        providerPaidCallCount: Number(row.providerPaidCallCount ?? 0),
        providerUnknownChargeCount: unknownChargeCount,
        providerUniqueCallCount: Number(row.providerUniqueCallCount ?? 0),
        recommendationContextVersionId: nullableString(
          row.recommendationContextVersionId,
        ),
        serverUpdatedAt:
          row.serverUpdatedAt === null || row.serverUpdatedAt === undefined
            ? null
            : toIsoString(row.serverUpdatedAt),
        candidateReadyCount: Number(row.candidateReadyCount ?? 0),
        rawCandidateCount: Number(row.rawCandidateCount ?? 0),
        publishedContactReadyCount,
        historicalEmailHitRate: Number(row.historicalEmailHitRate ?? 0.1),
        candidateLowWatermark: Number(row.candidateLowWatermark ?? 20),
        candidateHighWatermark: Number(row.candidateHighWatermark ?? 40),
        publishedLowWatermark: 0,
        publishedHighWatermark: targetCount,
        blueprintVersion,
        blueprintGenerator: nullableString(
          row.blueprintGenerator,
        ) as RecommendationInventorySummary["blueprintGenerator"],
        latestRefillAt:
          row.latestRefillAt === null || row.latestRefillAt === undefined
            ? null
            : toIsoString(row.latestRefillAt),
        nextRefillAt:
          row.nextRefillAt === null || row.nextRefillAt === undefined
            ? null
            : toIsoString(row.nextRefillAt),
        providerCollectedAt:
          row.providerCollectedAt === null ||
          row.providerCollectedAt === undefined
            ? null
            : toIsoString(row.providerCollectedAt),
        pauseReason: nullableString(row.pauseReason),
        refillInFlight,
        refillState,
        currentRefillTier,
        currentRefillRound,
        attemptedRefillTiers,
        terminationReason,
        eliminationReasonCounts: Object.entries(
          objectValue(row.eliminationReasonCounts),
        ).map(([reasonCode, count]) =>
          Object.freeze({
            reasonCode,
            count: Number(count),
          }),
        ),
        refillJob:
          refillJob === null
            ? null
            : Object.freeze({
                operationId: String(refillJob.operationId),
                id: String(refillJob.id),
                workflowId: String(refillJob.workflowId),
                status: String(refillJob.status) as NonNullable<
                  RecommendationInventorySummary["refillJob"]
                >["status"],
                step: nullableString(refillJob.step),
                progress: Number(refillJob.progress ?? 0),
                errorCode: nullableString(refillJob.errorCode),
                errorMessage: nullableString(refillJob.errorMessage),
                failure:
                  refillJob.failure === null || refillJob.failure === undefined
                    ? null
                    : (Object.freeze({
                        rootCause: String(
                          objectValue(refillJob.failure).rootCause,
                        ),
                        recovery: String(
                          objectValue(refillJob.failure).recovery,
                        ),
                        providerCallOccurred:
                          objectValue(refillJob.failure)
                            .providerCallOccurred === true,
                        diagnosticId: String(
                          objectValue(refillJob.failure).diagnosticId,
                        ),
                        message: String(objectValue(refillJob.failure).message),
                      }) as RecommendationRefillFailure),
                retryCount: Number(refillJob.retryCount ?? 0),
                lowWatermark: Number(refillJob.lowWatermark),
                highWatermark: Number(refillJob.highWatermark),
                refillWindowKey: String(refillJob.refillWindowKey),
                startedAt:
                  refillJob.startedAt === null ||
                  refillJob.startedAt === undefined
                    ? null
                    : toIsoString(refillJob.startedAt),
                finishedAt:
                  refillJob.finishedAt === null ||
                  refillJob.finishedAt === undefined
                    ? null
                    : toIsoString(refillJob.finishedAt),
                createdAt: toIsoString(refillJob.createdAt),
                updatedAt: toIsoString(refillJob.updatedAt),
                version: Number(refillJob.version),
              }),
        contactBatch:
          contactBatch === null
	            ? null
	            : Object.freeze({
	                id: String(contactBatch.id),
	                status: contactBatchStatus as NonNullable<
	                  RecommendationInventorySummary["contactBatch"]
	                >["status"],
	                totalJobCount: contactBatchTotalJobCount,
	                terminalJobCount: contactBatchTerminalJobCount,
                publishedCount: Number(contactBatch.publishedCount),
                unpublishedCount: Number(contactBatch.unpublishedCount),
                retryableUnpublishedCount: Number(
                  contactBatch.retryableUnpublishedCount,
                ),
                nextRetryAt:
                  contactBatch.nextRetryAt === null ||
                  contactBatch.nextRetryAt === undefined
                    ? null
                    : toIsoString(contactBatch.nextRetryAt),
                reasonCounts: arrayValue(contactBatch.reasonCounts).map(
                  (value) => {
                    const reason = objectValue(value);
                    return Object.freeze({
                      reasonCode: String(reason.reasonCode),
                      count: Number(reason.count),
                    });
                  },
                ),
                startedAt: toIsoString(contactBatch.startedAt),
	                completedAt: (() => {
	                  const completedAt =
	                    contactBatch.completedAt ??
	                    (contactBatchStatus === "completed"
	                      ? contactBatch.terminalCompletedAt
	                      : null);
	                  return completedAt === null || completedAt === undefined
	                    ? null
	                    : toIsoString(completedAt);
	                })(),
	              }),
      });
    },
  });
}
