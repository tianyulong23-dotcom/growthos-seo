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
  status: z.enum([
    "pending",
    "running",
    "completed",
    "partially_completed",
    "no_contact_found",
    "retry_scheduled",
  ]),
  candidateCount: z.number().int().min(0),
  evidenceCount: z.number().int().min(0),
  pagesVisited: z.number().int().min(0),
  lastErrorCode: z.string().nullable(),
  retryAfter: z.string().datetime().nullable(),
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
