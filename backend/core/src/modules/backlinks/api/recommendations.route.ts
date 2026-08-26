import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BacklinksModule } from "../application/backlinks.module.js";
import {
  recommendationInventoryStatuses,
  type RecommendationsQuery,
} from "../application/queries/recommendations.query.js";
import { BacklinkError, backlinkErrorCodes } from "../domain/errors/backlink-error.js";
import { backlinkProblemContentType, backlinkProblemDetailsSchema,
  toBacklinkProblemDetails } from "./problem-details.js";

const nonBlank = z.string().trim().min(1);
const status = z.enum(recommendationInventoryStatuses);
const paidRefillTierSchema = z.enum([
  "exact_product_target_market",
  "same_topic_target_market",
  "adjacent_industry_same_audience",
  "resource_media_review_partner_ecosystem",
  "same_language_expansion",
]);
const refillTierSchema = z.union([
  z.literal("curated_resource_library"),
  paidRefillTierSchema,
]);
const contactEvidenceSchema = z.object({
  id: z.uuid(),
  sourceUrl: z.url(),
  observedAt: z.string().datetime(),
  extractionMethod: z.enum([
    "mailto",
    "visible_text",
    "obfuscated_text",
    "json_ld",
    "manual",
  ]),
  evidenceSnippet: nonBlank,
  confidence: z.number().int().min(0).max(100),
}).strict();
const contactCandidateSchema = z.object({
  id: z.uuid(),
  normalizedEmail: z.email(),
  domainRelation: nonBlank,
  confidence: z.number().int().min(0).max(100),
  inferredPurpose: nonBlank,
  purposeConfidence: z.number().int().min(0).max(100),
  guessed: z.boolean(),
  version: z.number().int().positive(),
  eligible: z.boolean(),
  contactReviewRequired: z.boolean(),
  evidence: z.array(contactEvidenceSchema),
}).strict();
const contactJobSchema = z.object({
  id: z.uuid(),
  batchId: z.uuid(),
  status: z.enum([
    "pending",
    "running",
    "completed",
    "partially_completed",
    "no_contact_found",
    "retry_scheduled",
    "stale_context",
  ]),
  candidateCount: z.number().int().min(0),
  evidenceCount: z.number().int().min(0),
  pagesVisited: z.number().int().min(0),
  attemptCount: z.number().int().min(0),
  lastErrorCode: z.string().nullable(),
  terminalReasonCode: z.enum([
    "PUBLIC_EMAIL_FOUND",
    "CONTACT_FORM_ONLY",
    "LOGIN_REQUIRED",
    "CAPTCHA_OR_BOT_CHALLENGE",
    "ROBOTS_DISALLOWED",
    "ACCESS_DENIED",
    "NO_PUBLIC_EMAIL",
    "SITE_UNREACHABLE",
    "UNSUPPORTED_CONTENT",
    "MANUAL_REVIEW_REQUIRED",
    "COMPLETED_PARTIAL",
  ]).nullable(),
  method: z.enum(["none", "static", "browser", "static_and_browser"]),
  lastErrorCategory: z.string().nullable(),
  retryAfter: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
}).strict();
const fitComponentSchema = z.object({
  id: nonBlank,
  state: nonBlank,
  rawValue: z.union([z.number(), z.string(), z.boolean()]).nullable(),
  normalizedValue: z.number().min(0).max(1).nullable(),
  weight: z.number().min(0).max(100),
  points: z.number().min(0).max(100).nullable(),
  evidenceRefs: z.array(nonBlank),
  normalizationRuleVersion: nonBlank,
  collectedAt: z.string().datetime(),
}).strict();
const fitDecisionSchema = z.object({
  decision: z.literal("eligible"),
  matchTier: z.enum(["high_fit", "qualified_fit"]),
  overallFit: z.number().min(0).max(100),
  scoreModelVersion: z.enum([
    "recommendation-commercial-fit.v4",
    "recommendation-commercial-fit.v3",
  ]),
  ruleVersion: nonBlank,
  reasonCodes: z.array(nonBlank),
  matchedProducts: z.array(nonBlank),
  matchedTopics: z.array(nonBlank),
  matchedKeywords: z.array(nonBlank),
  matchedTargetPages: z.array(nonBlank),
  matchedAudiences: z.array(nonBlank),
  market: z.object({
    targetCountry: nonBlank,
    candidateCountry: nonBlank.nullable(),
    targetLanguage: nonBlank,
    candidateLanguage: nonBlank.nullable(),
    tier: z.enum([
      "target_market",
      "same_language_expansion",
      "market_language_mismatch",
    ]),
    reasonCode: nonBlank,
  }).strict(),
  cooperationAngles: z.array(nonBlank),
  dataForSeo: z.object({
    rank: z.number().nullable(),
    traffic: z.number().nullable(),
    backlinks: z.number().nullable(),
    referringDomains: z.number().nullable(),
    spamScore: z.number().min(0).max(100).nullable(),
    backlinkPageEvidence: z.array(z.object({
      sourceUrl: z.url(),
      targetUrl: z.url(),
      anchorText: z.string().nullable(),
      linkStatus: z.enum(["active", "lost"]),
      firstSeenAt: z.string().datetime().nullable(),
      lastSeenAt: z.string().datetime().nullable(),
      sourceHttpStatus: z.number().int().nullable(),
      targetHttpStatus: z.number().int().nullable(),
    }).strict()),
    evidenceRefs: z.array(nonBlank),
    collectedAt: z.string().datetime(),
  }).strict(),
  safeFetch: z.object({
    relatedContentPages: z.array(z.url()),
    evidenceUrls: z.array(z.url()),
    evidenceRefs: z.array(nonBlank),
    failedUrls: z.array(z.url()),
    technicalAccessibility: z.number().min(0).max(1).nullable(),
  }).strict(),
  components: z.array(fitComponentSchema),
}).strict();
const contactDecisionSchema = z.object({
  decision: z.literal("eligible"),
  reasonCode: z.literal("PUBLIC_EMAIL_FOUND"),
  sourceUrl: z.url(),
  inferredPurpose: nonBlank,
  contactConfidence: z.number().int().min(0).max(100),
  purposeConfidence: z.number().int().min(0).max(100),
  evidenceConfidence: z.number().int().min(0).max(100),
  collectedAt: z.string().datetime(),
  rulesVersion: nonBlank,
}).strict();
const cooperationPathSchema = z.object({
  factId: z.uuid(),
  decision: z.enum(["pending", "verified", "unavailable", "manual_review"]),
  reasonCode: nonBlank,
  pathType: z.enum([
    "public_email",
    "contact_form",
    "guest_post_submission",
    "resource_submission",
    "editor_author_page",
  ]).nullable(),
  url: z.url().nullable(),
  action: z.enum([
    "SEND_EMAIL",
    "OPEN_CONTACT_FORM",
    "OPEN_GUEST_POST_SUBMISSION",
    "OPEN_RESOURCE_SUBMISSION",
    "OPEN_EDITOR_AUTHOR_PAGE",
  ]).nullable(),
  contentType: z.enum([
    "EMAIL",
    "FORM_MESSAGE",
    "SUBMISSION_PITCH",
  ]).nullable(),
  evidence: z.record(z.string(), z.unknown()),
  observedAt: z.string().datetime(),
}).strict();
export const recommendationsParamsSchema =
  z.object({ websiteProjectKey: nonBlank }).strict();
export const recommendationsQuerySchema = z.object({
  status: status.optional(), minScore: z.coerce.number().min(0).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: nonBlank.max(2048).optional(),
}).strict();
const itemSchema = z.object({
  id: nonBlank, hostname: nonBlank, score: z.number().min(0).max(100), status,
  presentationState: z.enum(["current", "legacy_stale"]),
  contractKind: z.literal("corrected_visibility_v1"),
  outreachReadiness: z.enum([
    "ready",
    "manual_action",
    "contact_pending",
    "manual_review",
    "unavailable",
  ]),
  priority: z.enum(["high", "standard"]),
  candidateSource: z.enum([
    "paid_discovery",
    "resource_library",
    "mixed",
    "existing_history",
  ]),
  resourceType: z.enum(["free", "paid"]).nullable(),
  metricsSource: z.enum([
    "dataforseo",
    "resource_library_snapshot",
    "mixed_snapshot",
    "historical_snapshot",
  ]),
  risk: z.object({
    level: z.enum(["low", "medium", "high", "unknown"]),
    spamScore: z.number().min(0).max(100).nullable(),
  }).strict(),
  relevantPages: z.array(z.url()),
  emailSource: z.object({
    url: z.url(),
    extractionMethod: z.enum([
      "mailto",
      "visible_text",
      "obfuscated_text",
      "json_ld",
      "manual",
    ]),
    observedAt: z.string().datetime(),
  }).strict().nullable(),
  publicationStatus: z.enum([
    "PUBLISHED",
    "NOT_PUBLISHED",
    "CONTACT_PENDING",
    "CONTACT_REVIEW",
  ]),
  verifiedPublicEmailCount: z.number().int().min(0),
  recommendationContextVersionId: nonBlank, version: z.number().int().positive(),
  scoreModelVersion: nonBlank, ruleVersion: nonBlank,
  fitDecision: fitDecisionSchema,
  contactDecision: contactDecisionSchema.nullable(),
  cooperationPath: cooperationPathSchema.nullable(),
  contactPageUrl: z.url().nullable(),
  rootUrl: z.url(),
  faviconUrl: z.url(),
  acquiredAt: z.string().datetime(),
  contactStatus: z.enum([
    "contactable",
    "running",
    "review",
    "not_found",
    "not_started",
  ]),
  contactJob: contactJobSchema.nullable(),
  contacts: z.array(contactCandidateSchema),
  recommendedContactCandidateId: z.uuid().nullable(),
  existingOpportunityId: z.uuid().nullable(),
  canCreateOpportunity: z.boolean(),
  createBlockReason: z.literal("existing_opportunity").nullable(),
}).strict();
const inventoryStatusSchema = z.object({
  contractVersion: z.literal("backlinks.recommendation-operation.v1"),
  contractKind: z.literal("corrected_visibility_v1"),
  productState: z.enum([
    "running",
    "waiting_retry",
    "paused_provider",
    "partial_exhausted",
    "maintenance",
    "blocked",
  ]),
  productStateReason: nonBlank,
  recoveryCommand: z.enum([
    "CONTINUE_SAME_CRITERIA",
    "EDIT_PROJECT_MATCH_INPUTS",
    "BROADEN_MARKET_OR_KEYWORDS",
    "CHANGE_DISCOVERY_SOURCE",
    "WAIT_PROVIDER",
    "RESTART_SERVICE",
    "CONTACT_SUPPORT",
  ]).nullable(),
  providerAvailability: z.enum(["available", "paused", "unknown"]),
  visibleMatchCount: z.number().int().min(0),
  activeProcessingSeconds: z.number().int().min(0),
  providerBalanceMicros: z.number().int().min(0).nullable(),
  aiCapacity: z.object({
    status: z.enum(["available", "exhausted", "unconfigured"]),
    remainingCalls: z.number().int().min(0).nullable(),
    remainingBudgetMicros: z.number().int().min(0).nullable(),
  }).strict(),
  runningBuildId: nonBlank,
  visiblePoolGeneration: z.number().int().positive(),
  visiblePoolState: z.enum([
    "idle",
    "building",
    "active",
    "awaiting_refresh",
  ]),
  visiblePoolTargetCount: z.number().int().positive(),
  archivedVisiblePoolCount: z.number().int().min(0),
  visiblePoolArchivedAt: z.string().datetime().nullable(),
  operationId: z.uuid().nullable(),
  jobId: z.uuid().nullable(),
  stage: z.enum([
    "blueprint",
    "discovery",
    "match",
    "contact",
    "publish",
    "complete",
    "pause",
  ]),
  terminal: z.boolean(),
  terminalState: z.enum([
    "TARGET_REACHED",
    "PAUSED_BUDGET",
    "PAUSED_PROVIDER",
    "PROJECT_CONTEXT_REQUIRED",
    "SUPPLY_FLOOR_REACHED",
  ]).nullable(),
  targetCount: z.number().int().positive(),
  rawCount: z.number().int().min(0),
  fitCount: z.number().int().min(0),
  contactCount: z.number().int().min(0),
  publishedCount: z.number().int().min(0),
  unpublishedCount: z.number().int().min(0),
  tier: refillTierSchema,
  round: z.number().int().positive(),
  window: z.number().int().positive(),
  paidCursor: z.object({
    tier: paidRefillTierSchema,
    round: z.number().int().positive(),
    window: z.number().int().positive(),
  }).strict().nullable(),
  resourceCursor: z.object({
    tier: z.literal("curated_resource_library"),
    round: z.number().int().positive(),
    window: z.number().int().positive(),
  }).strict().nullable(),
  nextRetryAt: z.string().datetime().nullable(),
  errorCode: z.string().nullable(),
  recoveryAction: z.enum([
    "RESUME_OPERATION",
    "WAIT_PROVIDER",
    "COMPLETE_PROJECT_CONTEXT",
    "RESTART_SERVICE",
    "ACCEPT_SUPPLY_FLOOR",
    "CONTACT_SUPPORT",
  ]).nullable(),
  providerCallOccurred: z.boolean(),
  providerActualCostMicros: z.number().int().min(0),
  providerReservedCostMicros: z.number().int().min(0),
  providerPaidCallCount: z.number().int().min(0),
  providerUnknownChargeCount: z.number().int().min(0),
  providerUniqueCallCount: z.number().int().min(0),
  recommendationContextVersionId: z.uuid().nullable(),
  serverUpdatedAt: z.string().datetime().nullable(),
  candidateReadyCount: z.number().int().min(0),
  rawCandidateCount: z.number().int().min(0),
  publishedContactReadyCount: z.number().int().min(0),
  historicalEmailHitRate: z.number().min(0).max(1),
  candidateLowWatermark: z.number().int().min(0),
  candidateHighWatermark: z.number().int().positive(),
  publishedLowWatermark: z.number().int().min(0),
  publishedHighWatermark: z.number().int().positive(),
  blueprintVersion: z.number().int().positive().nullable(),
  blueprintGenerator: z.enum(["AI", "DETERMINISTIC_FALLBACK"]).nullable(),
  latestRefillAt: z.string().datetime().nullable(),
  nextRefillAt: z.string().datetime().nullable(),
  providerCollectedAt: z.string().datetime().nullable(),
  pauseReason: z.string().nullable(),
  refillInFlight: z.boolean(),
  refillState: z.enum([
    "idle",
    "running",
    "completed",
    "paused",
    "exhausted",
  ]),
  currentRefillTier: refillTierSchema,
  currentRefillRound: z.number().int().positive(),
  attemptedRefillTiers: z.array(z.object({
    tier: refillTierSchema,
    round: z.number().int().positive(),
    window: z.number().int().positive(),
  }).strict()),
  terminationReason: z.enum([
    "HIGH_WATERMARK",
    "BUDGET",
    "PROVIDER_UNAVAILABLE",
    "TIERS_EXHAUSTED",
    "PROJECT_CONTEXT",
  ]).nullable(),
  eliminationReasonCounts: z.array(z.object({
    reasonCode: nonBlank,
    count: z.number().int().min(0),
  }).strict()),
  refillJob: z.object({
    operationId: z.uuid(),
    id: z.uuid(),
    workflowId: nonBlank,
    status: z.enum([
      "queued",
      "running",
      "waiting_provider",
      "partial_success",
      "success",
      "failed",
      "cancelled",
    ]),
    step: z.string().nullable(),
    progress: z.number().int().min(0).max(100),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    failure: z.object({
      rootCause: z.enum([
        "BUDGET_PAUSED",
        "PROVIDER_UNAVAILABLE",
        "PROJECT_CONTEXT_REQUIRED",
        "RECOVERY_CONFLICT",
        "STALE_BUILD",
        "ORPHAN_OPERATION",
        "SUPPLY_FLOOR_REACHED",
        "UNKNOWN_INTERNAL",
      ]),
      recovery: z.enum([
        "RESUME_OPERATION",
        "WAIT_PROVIDER",
        "COMPLETE_PROJECT_CONTEXT",
        "RESTART_SERVICE",
        "ACCEPT_SUPPLY_FLOOR",
        "CONTACT_SUPPORT",
      ]),
      providerCallOccurred: z.boolean(),
      diagnosticId: nonBlank,
      message: nonBlank,
    }).strict().nullable(),
    retryCount: z.number().int().min(0),
    lowWatermark: z.number().int().min(0),
    highWatermark: z.number().int().positive(),
    refillWindowKey: nonBlank,
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    version: z.number().int().positive(),
  }).strict().nullable(),
  contactBatch: z.object({
    id: z.uuid(),
    status: z.enum(["running", "completed", "stale_context"]),
    totalJobCount: z.number().int().min(0),
    terminalJobCount: z.number().int().min(0),
    publishedCount: z.number().int().min(0),
    unpublishedCount: z.number().int().min(0),
    retryableUnpublishedCount: z.number().int().min(0),
    nextRetryAt: z.string().datetime().nullable(),
    reasonCounts: z.array(z.object({
      reasonCode: nonBlank,
      count: z.number().int().min(0),
    }).strict()),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  }).strict().nullable(),
}).strict();
export const recommendationsResponseSchema = z.object({
  items: z.array(itemSchema),
  presentationState: z.enum(["current", "legacy_stale"]),
  nextCursor: z.string().nullable(), hasMore: z.boolean(),
  meta: z.object({
    organizationId: nonBlank, workspaceId: nonBlank, websiteProjectId: nonBlank,
    requestId: nonBlank, schemaVersion: z.literal("backlinks.v1"),
    generatedAt: z.string().datetime(),
  }).strict(),
}).strict();

function sendError(error: FastifyError, request: FastifyRequest,
  reply: FastifyReply): void {
  const normalized = error instanceof BacklinkError ? error
    : error.validation === undefined ? error : new BacklinkError({
      code: backlinkErrorCodes.invalidRequest, message: "Request validation failed.",
    });
  const problem = toBacklinkProblemDetails(normalized, request.id);
  void reply.code(problem.status).type(backlinkProblemContentType).send(problem);
}

export function registerBacklinksRecommendationsRoute(app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule<RecommendationsQuery>;
    runningBuildId: string;
  }>): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendation-inventory",
    { schema: {
      operationId: "backlinksGetRecommendationInventoryV1",
      params: recommendationsParamsSchema,
      response: {
        200: inventoryStatusSchema.extend({
          meta: z.object({
            organizationId: nonBlank,
            workspaceId: nonBlank,
            websiteProjectId: nonBlank,
            requestId: nonBlank,
            schemaVersion: z.literal("backlinks.v1"),
            generatedAt: z.string().datetime(),
          }).strict(),
        }).strict(),
        400: backlinkProblemDetailsSchema, 403: backlinkProblemDetailsSchema,
        404: backlinkProblemDetailsSchema, 500: backlinkProblemDetailsSchema,
      },
    }, errorHandler: sendError },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const statusResult =
        await options.module.queries.getRecommendationInventoryStatus(
          context,
          options.runningBuildId,
        );
      return { ...statusResult, meta: {
        organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId,
        requestId: request.id,
        schemaVersion: "backlinks.v1" as const,
        generatedAt: new Date().toISOString(),
      } };
    },
  );
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/recommendations",
    { schema: {
      operationId: "backlinksListRecommendationsV1",
      params: recommendationsParamsSchema, querystring: recommendationsQuerySchema,
      response: { 200: recommendationsResponseSchema,
        400: backlinkProblemDetailsSchema, 403: backlinkProblemDetailsSchema,
        404: backlinkProblemDetailsSchema, 500: backlinkProblemDetailsSchema },
    }, errorHandler: sendError },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor, websiteProjectKey: request.params.websiteProjectKey,
      });
      const page = await options.module.queries.listRecommendations(context, request.query);
      return { ...page, meta: {
        organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId,
        requestId: request.id, schemaVersion: "backlinks.v1" as const,
        generatedAt: new Date().toISOString(),
      } };
    },
  );
}
