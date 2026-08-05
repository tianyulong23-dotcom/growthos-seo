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
  createReplyMatchCommands,
} from "../application/commands/reply-match.command.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";

type Commands = ReturnType<typeof createReplyMatchCommands>;
const nonBlank = z.string().trim().min(1);
const projectParams = z.object({
  websiteProjectKey: nonBlank,
  inboundMessageId: z.uuid(),
}).strict();
const candidateParams = projectParams.extend({
  candidateId: z.uuid(),
}).strict();
const confirmBody = z.object({
  expectedMatchStatus: z.literal("CANDIDATES_READY"),
  reason: nonBlank.max(500),
}).strict();
const unbindBody = z.object({
  expectedMatchStatus: z.literal("MATCH_CONFIRMED"),
  reason: nonBlank.max(500),
}).strict();
const reasonCode = z.record(z.string(), z.unknown());
const candidate = z.object({
  id: z.uuid(),
  inboundMessageId: z.uuid(),
  opportunityId: z.uuid(),
  candidateRank: z.number().int().positive(),
  confidenceScore: z.number().min(0).max(1),
  reasonCodes: z.array(reasonCode),
  requiresManualConfirmation: z.boolean(),
  createdAt: z.string().datetime(),
}).strict();
const metaSchema = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  requestId: nonBlank,
  schemaVersion: z.literal("backlinks.v1"),
  generatedAt: z.string().datetime(),
}).strict();
const listResponse = z.object({
  inboundMessageId: z.uuid(),
  matchStatus: z.enum([
    "UNMATCHED",
    "CANDIDATES_READY",
    "MATCH_CONFIRMED",
  ]),
  items: z.array(candidate),
  meta: metaSchema,
}).strict();
const confirmResponse = z.object({
  candidateId: z.uuid(),
  inboundMessageId: z.uuid(),
  opportunityId: z.uuid(),
  matchStatus: z.literal("MATCH_CONFIRMED"),
  auditEventId: z.uuid(),
  meta: metaSchema,
}).strict();
const unbindResponse = z.object({
  candidateId: z.uuid(),
  inboundMessageId: z.uuid(),
  opportunityId: z.uuid(),
  matchStatus: z.enum(["CANDIDATES_READY", "UNMATCHED"]),
  auditEventId: z.uuid(),
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
  void reply.code(problem.status).type(backlinkProblemContentType).send(problem);
}

const meta = (
  request: FastifyRequest,
  context: Awaited<
    ReturnType<BacklinksModule["projectContext"]["resolve"]>
  >,
) => ({
  organizationId: context.tenant.organizationId,
  workspaceId: context.tenant.workspaceId,
  websiteProjectId: context.project.websiteProjectId,
  requestId: request.id,
  schemaVersion: "backlinks.v1" as const,
  generatedAt: new Date().toISOString(),
});

export function registerBacklinksReplyMatchRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule;
    commands: Commands;
  }>,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/replies/:inboundMessageId/match-candidates",
    {
      schema: {
        operationId: "backlinksListReplyMatchCandidatesV1",
        params: projectParams,
        response: { 200: listResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.commands.listCandidates(
        context,
        request.params.inboundMessageId,
      );
      return {
        inboundMessageId: result.inboundMessageId,
        matchStatus: result.matchStatus,
        items: result.candidates.map((item) => ({
          ...item,
          reasonCodes: item.reasonCodes.map((reason) => ({ ...reason })),
        })),
        meta: meta(request, context),
      };
    },
  );

  api.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/replies/:inboundMessageId/match-candidates/:candidateId/confirm",
    {
      schema: {
        operationId: "backlinksConfirmReplyMatchCandidateV1",
        params: candidateParams,
        body: confirmBody,
        response: { 200: confirmResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.commands.confirm({
        context,
        inboundMessageId: request.params.inboundMessageId,
        candidateId: request.params.candidateId,
        expectedMatchStatus: request.body.expectedMatchStatus,
        requestId: request.id,
        reason: request.body.reason,
      });
      return {
        candidateId: result.candidateId,
        inboundMessageId: result.inboundMessageId,
        opportunityId: result.opportunityId,
        matchStatus: result.matchStatus,
        auditEventId: result.auditEventId,
        meta: meta(request, context),
      };
    },
  );

  api.post(
    "/api/v1/projects/:websiteProjectKey/backlinks/replies/:inboundMessageId/match/unbind",
    {
      schema: {
        operationId: "backlinksUnbindReplyMatchV1",
        params: projectParams,
        body: unbindBody,
        response: { 200: unbindResponse, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const result = await options.commands.unbind({
        context,
        inboundMessageId: request.params.inboundMessageId,
        expectedMatchStatus: request.body.expectedMatchStatus,
        requestId: request.id,
        reason: request.body.reason,
      });
      return {
        candidateId: result.candidateId,
        inboundMessageId: result.inboundMessageId,
        opportunityId: result.opportunityId,
        matchStatus: result.matchStatus,
        auditEventId: result.auditEventId,
        meta: meta(request, context),
      };
    },
  );
}
