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
  createPlacementCandidateCommand,
} from "../application/commands/placement-candidate.command.js";
import {
  createPlacementCandidateBodySchema,
} from "../application/schemas/placement-candidate.schema.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";

type Command = ReturnType<typeof createPlacementCandidateCommand>;
const nonBlank = z.string().trim().min(1);
const headersSchema = z.object({
  "idempotency-key": nonBlank.max(200),
});
const paramsSchema = z.object({
  websiteProjectKey: nonBlank,
}).strict();
const metaSchema = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"),
  generatedAt: z.string().datetime(),
}).strict();
const responseSchema = z.object({
  candidateId: z.uuid(),
  opportunityId: z.uuid().optional(),
  replyId: z.uuid().optional(),
  placementId: z.uuid(),
  lineageStatus: z.enum(["OUTREACH_DERIVED", "UNATTRIBUTED"]),
  status: z.enum(["PENDING_MATCH", "PENDING_VALIDATION"]),
  matchStatus: z.enum(["UNMATCHED", "AUTO_MATCHED"]),
  initialValidationStatus: z.literal("PENDING"),
  version: z.number().int().positive(),
  countsTowardKpi: z.literal(false),
  replayed: z.boolean(),
  meta: metaSchema,
}).strict();
const errors = {
  400: backlinkProblemDetailsSchema,
  403: backlinkProblemDetailsSchema,
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

export function registerBacklinksPlacementCandidateRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule;
    command: Command;
  }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/v1/projects/:websiteProjectKey/backlinks/placement-candidates",
    {
      schema: {
        operationId: "backlinksCreatePlacementCandidateV1",
        headers: headersSchema,
        params: paramsSchema,
        body: createPlacementCandidateBodySchema,
        response: {
          201: responseSchema,
          ...errors,
        },
      },
      errorHandler: sendError,
    },
    async (request, reply) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.command.execute({
        context,
        requestId: request.id,
        idempotencyKey: request.headers["idempotency-key"],
        ...request.body,
      });
      const {
        initialValidationRequest,
        ...response
      } = result;
      void initialValidationRequest;

      return reply.code(201).send({
        ...response,
        meta: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          requestId: request.id,
          schemaVersion: "backlinks.v1" as const,
          generatedAt: new Date().toISOString(),
        },
      });
    },
  );
}
