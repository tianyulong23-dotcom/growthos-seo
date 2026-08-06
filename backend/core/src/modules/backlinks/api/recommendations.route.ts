import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BacklinksModule } from "../application/backlinks.module.js";
import {
  recommendationInventoryStatuses,
  type RecommendationsQuery,
} from "../application/queries/recommendations.query.js";
import { BacklinkError, backlinkErrorCodes } from "../domain/errors/backlink-error.js";
import { publicAssessmentSchema } from "./evidence-contracts.js";
import { backlinkProblemContentType, backlinkProblemDetailsSchema,
  toBacklinkProblemDetails } from "./problem-details.js";

const nonBlank = z.string().trim().min(1);
const status = z.enum(recommendationInventoryStatuses);
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
export const recommendationsParamsSchema =
  z.object({ websiteProjectKey: nonBlank }).strict();
export const recommendationsQuerySchema = z.object({
  status: status.optional(), minScore: z.coerce.number().min(0).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: nonBlank.max(2048).optional(),
}).strict();
const itemSchema = z.object({
  id: nonBlank, hostname: nonBlank, score: z.number().min(0).max(100), status,
  publicationStatus: z.literal("PUBLISHED"),
  verifiedPublicEmailCount: z.number().int().min(1),
  recommendationContextVersionId: nonBlank, version: z.number().int().positive(),
  scoreModelVersion: nonBlank, ruleVersion: nonBlank,
  assessment: publicAssessmentSchema,
  rootUrl: z.url(),
  faviconUrl: z.url(),
  acquiredAt: z.string().datetime(),
  matchReasons: z.array(nonBlank),
  dataSources: z.array(nonBlank),
  seoMetrics: z.object({
    authority: z.number().nullable(),
    editorialQuality: z.number().nullable(),
    technicalHealth: z.number().nullable(),
  }).strict(),
  contactStatus: z.enum(["contactable", "running", "review", "not_found"]),
  contactJob: contactJobSchema.nullable(),
  contacts: z.array(contactCandidateSchema),
  recommendedContactCandidateId: z.uuid().nullable(),
  existingOpportunityId: z.uuid().nullable(),
  canCreateOpportunity: z.boolean(),
  createBlockReason: z.enum([
    "existing_opportunity",
    "no_eligible_contact",
  ]).nullable(),
}).strict();
const inventoryStatusSchema = z.object({
  candidateReadyCount: z.number().int().min(0),
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
  contactBatch: z.object({
    id: z.uuid(),
    status: z.enum(["running", "completed", "stale_context"]),
    totalJobCount: z.number().int().min(0),
    terminalJobCount: z.number().int().min(0),
    publishedCount: z.number().int().min(0),
    unpublishedCount: z.number().int().min(0),
    retryableUnpublishedCount: z.number().int().min(0),
    reasonCounts: z.array(z.object({
      reasonCode: nonBlank,
      count: z.number().int().min(0),
    }).strict()),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  }).strict().nullable(),
}).strict();
export const recommendationsResponseSchema = z.object({
  items: z.array(itemSchema), nextCursor: z.string().nullable(), hasMore: z.boolean(),
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
  options: Readonly<{ module: BacklinksModule<RecommendationsQuery> }>): void {
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
        await options.module.queries.getRecommendationInventoryStatus(context);
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
