import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BacklinksModule } from "../application/backlinks.module.js";
import type { RecommendationsQuery } from "../application/queries/recommendations.query.js";
import { BacklinkError, backlinkErrorCodes } from "../domain/errors/backlink-error.js";
import { publicAssessmentSchema } from "./evidence-contracts.js";
import { backlinkProblemContentType, backlinkProblemDetailsSchema,
  toBacklinkProblemDetails } from "./problem-details.js";

const nonBlank = z.string().trim().min(1);
const status = z.enum(["ready", "claimed", "rejected"]);
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
