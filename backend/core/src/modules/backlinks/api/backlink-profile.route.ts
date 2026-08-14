import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { BacklinksModule } from "../application/backlinks.module.js";
import {
  backlinkInventoryQuerySchema,
  backlinkInventoryCheckResponseSchema,
  backlinkInventoryDirectObservationResponseSchema,
  backlinkInventoryImportBodySchema,
  backlinkInventoryImportResponseSchema,
  backlinkInventoryItemParamsSchema,
  backlinkInventoryObservationQuerySchema,
  backlinkInventoryPolicyBodySchema,
  backlinkInventoryPolicyResponseSchema,
  backlinkInventoryResponseSchema,
  backlinkProfileParamsSchema,
  backlinkProfileResponseSchema,
  backlinkProfileSyncHeadersSchema,
  backlinkProfileSyncJobParamsSchema,
  backlinkProfileSyncJobResponseSchema,
  backlinkProfileSyncResponseSchema,
} from "../application/schemas/backlink-profile.schema.js";
import type { createBacklinkProfileService } from "../application/services/backlink-profile.service.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";

type Service = ReturnType<typeof createBacklinkProfileService>;
const errors = {
  400: backlinkProblemDetailsSchema,
  403: backlinkProblemDetailsSchema,
  404: backlinkProblemDetailsSchema,
  409: backlinkProblemDetailsSchema,
  500: backlinkProblemDetailsSchema,
};

function sendError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const normalized = error instanceof BacklinkError
    ? error
    : error.validation === undefined
      ? error
      : new BacklinkError({
          code: backlinkErrorCodes.invalidRequest,
          message: "Request validation failed.",
        });
  const problem = toBacklinkProblemDetails(normalized, request.id);
  void reply.code(problem.status).type(backlinkProblemContentType).send(problem);
}

const meta = (
  context: Awaited<ReturnType<BacklinksModule["projectContext"]["resolve"]>>,
  requestId: string,
) => ({
  organizationId: context.tenant.organizationId,
  workspaceId: context.tenant.workspaceId,
  websiteProjectId: context.project.websiteProjectId,
  requestId,
  schemaVersion: "backlinks.v1" as const,
  generatedAt: new Date().toISOString(),
});

export function registerBacklinkProfileRoutes(
  app: FastifyInstance,
  options: Readonly<{ module: BacklinksModule; service: Service }>,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/profile",
    {
      schema: {
        operationId: "backlinksGetProfileV1",
        params: backlinkProfileParamsSchema,
        response: { 200: backlinkProfileResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      return backlinkProfileResponseSchema.parse({
        ...await options.service.getProfile(context),
        meta: meta(context, request.id),
      });
    },
  );
  api.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/inventory",
    {
      schema: {
        operationId: "backlinksListInventoryV1",
        params: backlinkProfileParamsSchema,
        querystring: backlinkInventoryQuerySchema,
        response: { 200: backlinkInventoryResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      return backlinkInventoryResponseSchema.parse({
        ...await options.service.listInventory(context, request.query),
        meta: meta(context, request.id),
      });
    },
  );
  api.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/inventory-items",
    {
      schema: {
        operationId: "backlinksImportInventoryItemV1",
        params: backlinkProfileParamsSchema,
        body: backlinkInventoryImportBodySchema,
        response: { 200: backlinkInventoryImportResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      return backlinkInventoryImportResponseSchema.parse({
        ...await options.service.importInventory(context, request.body),
        meta: meta(context, request.id),
      });
    },
  );
  api.patch(
    "/api/v1/projects/:websiteProjectKey/backlinks/inventory-items/:inventoryItemId/monitoring-policy",
    {
      schema: {
        operationId: "backlinksUpdateInventoryMonitoringPolicyV1",
        params: backlinkInventoryItemParamsSchema,
        body: backlinkInventoryPolicyBodySchema,
        response: { 200: backlinkInventoryPolicyResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      return backlinkInventoryPolicyResponseSchema.parse({
        ...await options.service.updateInventoryPolicy(
          context,
          request.params.inventoryItemId,
          request.body,
        ),
        meta: meta(context, request.id),
      });
    },
  );
  api.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/inventory-items/:inventoryItemId/checks",
    {
      schema: {
        operationId: "backlinksRequestInventoryCheckV1",
        params: backlinkInventoryItemParamsSchema,
        headers: backlinkProfileSyncHeadersSchema,
        response: { 202: backlinkInventoryCheckResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.service.requestInventoryCheck(
        context,
        request.params.inventoryItemId,
        { idempotencyKey: request.headers["idempotency-key"] },
      );
      return reply.code(202).send(backlinkInventoryCheckResponseSchema.parse({
        inventoryItemId: result.inventoryItemId,
        runId: result.runId,
        observationId: result.observationId,
        workflowId: result.workflowId,
        scheduledFor: result.scheduledFor,
        replayed: result.replayed,
        meta: meta(context, request.id),
      }));
    },
  );
  api.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/inventory-items/:inventoryItemId/direct-observations",
    {
      schema: {
        operationId: "backlinksListInventoryDirectObservationsV1",
        params: backlinkInventoryItemParamsSchema,
        querystring: backlinkInventoryObservationQuerySchema,
        response: {
          200: backlinkInventoryDirectObservationResponseSchema,
          ...errors,
        },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      return backlinkInventoryDirectObservationResponseSchema.parse({
        ...await options.service.listDirectObservations(
          context,
          request.params.inventoryItemId,
          request.query.limit,
        ),
        meta: meta(context, request.id),
      });
    },
  );
  api.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/profile-sync-jobs",
    {
      schema: {
        operationId: "backlinksRequestProfileSyncV1",
        params: backlinkProfileParamsSchema,
        headers: backlinkProfileSyncHeadersSchema,
        response: { 202: backlinkProfileSyncResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.service.requestSync(context, {
        idempotencyKey: request.headers["idempotency-key"],
      });
      return reply.code(202).send(backlinkProfileSyncResponseSchema.parse({
        ...result,
        meta: meta(context, request.id),
      }));
    },
  );
  api.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/profile-sync-jobs/:jobId",
    {
      schema: {
        operationId: "backlinksGetProfileSyncJobV1",
        params: backlinkProfileSyncJobParamsSchema,
        response: { 200: backlinkProfileSyncJobResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const job = await options.service.getSyncJob(context, request.params.jobId);
      if (job === null) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Backlink profile sync job was not found.",
        });
      }
      return backlinkProfileSyncJobResponseSchema.parse({
        job,
        meta: meta(context, request.id),
      });
    },
  );
}
