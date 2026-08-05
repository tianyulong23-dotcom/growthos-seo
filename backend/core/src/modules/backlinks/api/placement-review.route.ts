import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { BacklinksModule } from "../application/backlinks.module.js";
import type {
  createPlacementReviewCommand,
} from "../application/commands/placement-review.command.js";
import {
  confirmPlacementCandidateBodySchema,
  rejectPlacementCandidateBodySchema,
} from "../application/schemas/placement-review.schema.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";

type Command = ReturnType<typeof createPlacementReviewCommand>;
const nonBlank = z.string().trim().min(1);
const paramsSchema = z.object({
  websiteProjectKey: nonBlank,
  candidateId: z.uuid(),
}).strict();
const metaSchema = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"),
  generatedAt: z.string().datetime(),
}).strict();
const confirmationResponseSchema = z.object({
  action: z.literal("manual_confirm"),
  candidateId: z.uuid(),
  candidateStatus: z.literal("PROMOTED"),
  initialValidationStatus: z.literal("MANUALLY_CONFIRMED"),
  candidateVersion: z.number().int().positive(),
  validationRunId: z.uuid(),
  placementId: z.uuid(),
  placementVersion: z.number().int().positive(),
  monitoringOutboxEventId: z.uuid(),
  lifecycleEventId: z.uuid(),
  auditEventId: z.uuid(),
  countsTowardKpi: z.literal(true),
  meta: metaSchema,
}).strict();
const rejectionResponseSchema = z.object({
  action: z.literal("reject"),
  candidateId: z.uuid(),
  candidateStatus: z.literal("REJECTED"),
  initialValidationStatus: z.enum(["INVALID", "INCONCLUSIVE"]),
  candidateVersion: z.number().int().positive(),
  lifecycleEventId: z.uuid(),
  auditEventId: z.uuid(),
  countsTowardKpi: z.literal(false),
  meta: metaSchema,
}).strict();
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
  void reply
    .code(problem.status)
    .type(backlinkProblemContentType)
    .send(problem);
}

function meta(
  request: FastifyRequest,
  context: Awaited<
    ReturnType<BacklinksModule["projectContext"]["resolve"]>
  >,
) {
  return {
    organizationId: context.tenant.organizationId,
    workspaceId: context.tenant.workspaceId,
    websiteProjectId: context.project.websiteProjectId,
    requestId: request.id,
    schemaVersion: "backlinks.v1" as const,
    generatedAt: new Date().toISOString(),
  };
}

export function registerBacklinksPlacementReviewRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule;
    command: Command;
  }>,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/placement-candidates/:candidateId/confirm",
    {
      schema: {
        operationId: "backlinksConfirmPlacementCandidateV1",
        params: paramsSchema,
        body: confirmPlacementCandidateBodySchema,
        response: {
          200: confirmationResponseSchema,
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
      return {
        ...(await options.command.confirm({
          context,
          requestId: request.id,
          candidateId: request.params.candidateId,
          ...request.body,
        })),
        meta: meta(request, context),
      };
    },
  );
  api.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/placement-candidates/:candidateId/reject",
    {
      schema: {
        operationId: "backlinksRejectPlacementCandidateV1",
        params: paramsSchema,
        body: rejectPlacementCandidateBodySchema,
        response: {
          200: rejectionResponseSchema,
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
      return {
        ...(await options.command.reject({
          context,
          requestId: request.id,
          candidateId: request.params.candidateId,
          ...request.body,
        })),
        meta: meta(request, context),
      };
    },
  );
}
