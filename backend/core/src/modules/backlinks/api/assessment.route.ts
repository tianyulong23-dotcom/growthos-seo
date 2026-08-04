import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BacklinksModule } from "../application/backlinks.module.js";
import { assessmentRunStatuses, type AssessmentQuery } from
  "../application/queries/assessment.query.js";
import { BacklinkError, backlinkErrorCodes } from "../domain/errors/backlink-error.js";
import { backlinkProblemContentType, backlinkProblemDetailsSchema,
  toBacklinkProblemDetails } from "./problem-details.js";

const text = z.string().trim().min(1);
export const assessmentParamsSchema = z.object({
  websiteProjectKey: text, opportunityId: z.uuid(),
}).strict();
const resultSchema = z.object({
  snapshotId: z.uuid(), snapshotVersion: z.number().int().positive(),
  isCurrent: z.boolean(), availability: z.enum(["available", "partial", "unavailable"]),
  stale: z.boolean(), sourceReleaseIds: z.array(text).min(1).readonly(),
  generatedAt: z.string().datetime(), payload: z.record(z.string(), z.unknown()),
}).strict();
export const assessmentResponseSchema = z.object({
  assessment: z.object({
    run: z.object({
      id: z.uuid(), opportunityId: z.uuid(), status: z.enum(assessmentRunStatuses),
      attemptCount: z.number().int().nonnegative(),
      sourceReleaseIds: z.array(text).min(1).readonly(),
      startedAt: z.string().datetime().nullable(), finishedAt: z.string().datetime().nullable(),
      errorCode: z.string().nullable(),
    }).strict(),
    result: resultSchema.nullable(),
  }).strict(),
  meta: z.object({
    organizationId: text, workspaceId: text, websiteProjectId: text,
    requestId: text, schemaVersion: z.literal("backlinks.v1"),
    generatedAt: z.string().datetime(),
  }).strict(),
}).strict();
function sendError(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const normalized = error instanceof BacklinkError ? error
    : error.validation === undefined ? error : new BacklinkError({
      code: backlinkErrorCodes.invalidRequest, message: "Request validation failed.",
    });
  const problem = toBacklinkProblemDetails(normalized, request.id);
  void reply.code(problem.status).type(backlinkProblemContentType).send(problem);
}

export function registerBacklinksAssessmentRoute(app: FastifyInstance,
  options: Readonly<{ module: BacklinksModule<AssessmentQuery> }>): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/assessments/:opportunityId",
    { schema: {
      operationId: "backlinksGetAssessmentV1", params: assessmentParamsSchema,
      response: { 200: assessmentResponseSchema, 400: backlinkProblemDetailsSchema,
        403: backlinkProblemDetailsSchema, 404: backlinkProblemDetailsSchema,
        500: backlinkProblemDetailsSchema },
    }, errorHandler: sendError },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor, websiteProjectKey: request.params.websiteProjectKey,
      });
      return {
        assessment: await options.module.queries.getAssessment(
          context, request.params.opportunityId,
        ),
        meta: { organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId, requestId: request.id,
          schemaVersion: "backlinks.v1" as const, generatedAt: new Date().toISOString() },
      };
    },
  );
}
