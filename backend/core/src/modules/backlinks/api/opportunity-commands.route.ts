import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BacklinksModule } from "../application/backlinks.module.js";
import type { createOpportunityCommands } from "../application/commands/opportunities.command.js";
import { BacklinkError, backlinkErrorCodes } from "../domain/errors/backlink-error.js";
import { opportunityBusinessStages, opportunityManagementStatuses
} from "../domain/opportunities/opportunity-state.js";
import { backlinkProblemContentType, backlinkProblemDetailsSchema,
  toBacklinkProblemDetails } from "./problem-details.js";
type Commands = ReturnType<typeof createOpportunityCommands>;
const nonBlank = z.string().trim().min(1);
const headers = z.object({ "idempotency-key": nonBlank.max(200) });
const params = z.object({ websiteProjectKey: nonBlank, opportunityId: z.uuid() }).strict();
export const transitionOpportunityBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  toBusinessStage: z.enum(opportunityBusinessStages),
  reason: nonBlank.max(500),
}).strict();
export const patchOpportunityManagementBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  managementStatus: z.enum(opportunityManagementStatuses),
  reason: nonBlank.max(500),
}).strict();
const metaSchema = z.object({ organizationId: nonBlank, workspaceId: nonBlank,
  websiteProjectId: nonBlank, requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"), generatedAt: z.string().datetime() }).strict();
const response = z.object({ opportunityId: z.uuid(),
  businessStage: z.enum(opportunityBusinessStages),
  managementStatus: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]),
  outcomeStatus: z.enum(["OPEN", "WON", "LOST"]),
  fulfillmentStatus: z.enum(["NOT_EXPECTED", "PENDING", "PARTIAL", "FULFILLED"]),
  version: z.number().int().positive(), lifecycleEventId: nonBlank,
  auditEventId: nonBlank, replayed: z.boolean(), meta: metaSchema }).strict();
const errors = { 400: backlinkProblemDetailsSchema, 403: backlinkProblemDetailsSchema,
  404: backlinkProblemDetailsSchema, 409: backlinkProblemDetailsSchema,
  500: backlinkProblemDetailsSchema };
function sendError(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const normalized = error instanceof BacklinkError ? error : error.validation === undefined
    ? error : new BacklinkError({ code: backlinkErrorCodes.invalidRequest,
      message: "Request validation failed." });
  const problem = toBacklinkProblemDetails(normalized, request.id);
  void reply.code(problem.status).type(backlinkProblemContentType).send(problem);
}
export function registerBacklinksOpportunityCommandsRoutes(app: FastifyInstance, options:
  Readonly<{ module: BacklinksModule; commands: Commands }>): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/v1/projects/:websiteProjectKey/backlinks/opportunities/:opportunityId/transition",
    { schema: { operationId: "backlinksTransitionOpportunityBusinessStageV1",
      headers, params, body: transitionOpportunityBodySchema,
      response: { 200: response, ...errors } }, errorHandler: sendError },
    async (request) => {
      const context = await options.module.projectContext.resolve({ actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey });
      const result = await options.commands.transitionBusinessStage({ context,
        requestId: request.id, idempotencyKey: request.headers["idempotency-key"],
        opportunityId: request.params.opportunityId, ...request.body });
      return { ...result, meta: { organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId, requestId: request.id,
        schemaVersion: "backlinks.v1" as const, generatedAt: new Date().toISOString() } };
    },
  );
  app.withTypeProvider<ZodTypeProvider>().patch(
    "/api/v1/projects/:websiteProjectKey/backlinks/opportunities/:opportunityId/management",
    { schema: { operationId: "backlinksPatchOpportunityManagementV1",
      headers, params, body: patchOpportunityManagementBodySchema,
      response: { 200: response, ...errors } }, errorHandler: sendError },
    async (request) => {
      const context = await options.module.projectContext.resolve({ actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey });
      const result = await options.commands.patchManagement({ context,
        requestId: request.id, idempotencyKey: request.headers["idempotency-key"],
        opportunityId: request.params.opportunityId, ...request.body });
      return { ...result, meta: { organizationId: context.tenant.organizationId,
        workspaceId: context.tenant.workspaceId,
        websiteProjectId: context.project.websiteProjectId, requestId: request.id,
        schemaVersion: "backlinks.v1" as const, generatedAt: new Date().toISOString() } };
    },
  );
}
