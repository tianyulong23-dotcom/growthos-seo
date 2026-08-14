import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BacklinksModule } from "../application/backlinks.module.js";
import type { createRecommendationCommands } from "../application/commands/recommendations.command.js";
import { BacklinkError, backlinkErrorCodes } from "../domain/errors/backlink-error.js";
import { backlinkProblemContentType, backlinkProblemDetailsSchema, toBacklinkProblemDetails } from "./problem-details.js";
type Commands = ReturnType<typeof createRecommendationCommands>;
const nonBlank = z.string().trim().min(1);
const headers = z.object({ "idempotency-key": nonBlank.max(200) });
const projectParams = z.object({ websiteProjectKey: nonBlank }).strict();
const rejectParams = projectParams.extend({ recommendationId: z.uuid() }).strict();
const poolParams = projectParams.extend({
  visiblePoolGeneration: z.coerce.number().int().positive(),
}).strict();
export const rejectRecommendationBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  rejectionType: z.enum(["skipped", "permanently_rejected"]),
  reasonCode: nonBlank.max(100), cooldownUntil: z.string().datetime().nullable().default(null),
}).strict().superRefine((body, context) => {
  if ((body.rejectionType === "skipped") !== (body.cooldownUntil !== null))
    context.addIssue({ code: "custom", path: ["cooldownUntil"],
      message: "Skipped rejections require cooldownUntil; permanent rejections require null." });
});
export const requestRefillBodySchema = z.object({
  expectedVersion: z.literal(0), recommendationContextVersionId: z.uuid(),
  visiblePoolGeneration: z.number().int().positive(),
  lowWatermark: z.literal(9), highWatermark: z.literal(10),
  operationId: z.uuid().optional(),
}).strict();
export const archiveRecommendationPoolBodySchema = z.object({
  recommendationContextVersionId: z.uuid(),
}).strict();
const commandMetaSchema = z.object({
  organizationId: nonBlank, workspaceId: nonBlank, websiteProjectId: nonBlank,
  requestId: nonBlank, schemaVersion: z.literal("backlinks.v1"), generatedAt: z.string().datetime(),
}).strict();
const auditFields = { version: z.number().int().positive(), lifecycleEventId: nonBlank,
  auditEventId: nonBlank, replayed: z.boolean(), meta: commandMetaSchema };
const rejectResponse = z.object({ recommendationId: z.uuid(),
  status: z.literal("rejected"), ...auditFields }).strict();
const refillResponse = z.object({ operationId: z.uuid(), jobId: nonBlank, workflowId: nonBlank,
  status: z.literal("queued"), visiblePoolGeneration: z.number().int().positive(),
  ...auditFields }).strict();
const archivePoolResponse = z.object({
  archivedGeneration: z.number().int().positive(),
  nextGeneration: z.number().int().positive(),
  archivedCount: z.number().int().nonnegative(),
  state: z.literal("awaiting_refresh"),
  ...auditFields,
}).strict();
const errors = { 400: backlinkProblemDetailsSchema, 403: backlinkProblemDetailsSchema,
  404: backlinkProblemDetailsSchema, 409: backlinkProblemDetailsSchema, 500: backlinkProblemDetailsSchema };
function sendError(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const normalized = error instanceof BacklinkError ? error : error.validation === undefined ? error
    : new BacklinkError({ code: backlinkErrorCodes.invalidRequest,
      message: "Request validation failed." });
  const problem = toBacklinkProblemDetails(normalized, request.id);
  void reply.code(problem.status).type(backlinkProblemContentType).send(problem);
}
const meta = (request: FastifyRequest, context:
  Awaited<ReturnType<BacklinksModule["projectContext"]["resolve"]>>) => ({
    organizationId: context.tenant.organizationId, workspaceId: context.tenant.workspaceId,
    websiteProjectId: context.project.websiteProjectId, requestId: request.id,
    schemaVersion: "backlinks.v1" as const, generatedAt: new Date().toISOString() });
export function registerBacklinksRecommendationCommandsRoutes(app: FastifyInstance, options:
  Readonly<{ module: BacklinksModule; commands: Commands }>): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.post("/api/v1/projects/:websiteProjectKey/backlinks/recommendations/:recommendationId/reject", {
      schema: { operationId: "backlinksRejectRecommendationV1",
      headers, params: rejectParams, body: rejectRecommendationBodySchema,
      response: { 200: rejectResponse, ...errors } }, errorHandler: sendError },
    async (request) => {
      const context = await options.module.projectContext.resolve({ actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey });
      const result = await options.commands.reject({ context, requestId: request.id,
        idempotencyKey: request.headers["idempotency-key"],
        recommendationId: request.params.recommendationId, ...request.body });
      return { ...result, meta: meta(request, context) };
    });
  api.post("/api/v1/projects/:websiteProjectKey/backlinks/recommendation-refill-jobs", {
      schema: { operationId: "backlinksRequestRecommendationRefillV1",
      params: projectParams, body: requestRefillBodySchema,
      response: { 202: refillResponse, ...errors } }, errorHandler: sendError },
    async (request, reply) => {
      const context = await options.module.projectContext.resolve({ actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey });
      const result = await options.commands.requestRefill({ context, requestId: request.id,
        expectedVersion: request.body.expectedVersion,
        recommendationContextVersionId:
          request.body.recommendationContextVersionId,
        visiblePoolGeneration: request.body.visiblePoolGeneration,
        lowWatermark: request.body.lowWatermark,
        highWatermark: request.body.highWatermark,
        ...(request.body.operationId === undefined
          ? {}
          : { operationId: request.body.operationId }) });
      return reply.code(202).send({ ...result, meta: meta(request, context) });
    });
  api.post("/api/v1/projects/:websiteProjectKey/backlinks/recommendation-pools/:visiblePoolGeneration/archive", {
      schema: { operationId: "backlinksArchiveRecommendationPoolV1",
      headers, params: poolParams, body: archiveRecommendationPoolBodySchema,
      response: { 200: archivePoolResponse, ...errors } }, errorHandler: sendError },
    async (request) => {
      const context = await options.module.projectContext.resolve({ actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey });
      const result = await options.commands.archivePool({
        context,
        requestId: request.id,
        idempotencyKey: request.headers["idempotency-key"],
        recommendationContextVersionId:
          request.body.recommendationContextVersionId,
        visiblePoolGeneration: request.params.visiblePoolGeneration,
      });
      return { ...result, meta: meta(request, context) };
    });
}
