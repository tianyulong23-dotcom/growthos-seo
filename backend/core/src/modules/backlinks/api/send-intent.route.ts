import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { BacklinksModule } from "../application/backlinks.module.js";
import type {
  createSendIntentCommands,
} from "../application/commands/send-intent.command.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  backlinkProblemDetailsSchema,
  toBacklinkProblemDetails,
} from "./problem-details.js";
import {
  createSendIntentBodySchema,
  createSendIntentResponseSchema,
  sendIntentHeadersSchema,
  sendIntentParamsSchema,
} from "./send-intent.schema.js";

type Commands = ReturnType<typeof createSendIntentCommands>;

const errors = {
  400: backlinkProblemDetailsSchema,
  403: backlinkProblemDetailsSchema,
  404: backlinkProblemDetailsSchema,
  409: backlinkProblemDetailsSchema,
  429: backlinkProblemDetailsSchema,
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

export function registerBacklinksSendIntentRoute(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule;
    commands: Commands;
  }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/v1/projects/:websiteProjectKey/backlinks/drafts/:draftId/send-intents",
    {
      schema: {
        operationId: "backlinksCreateSendIntentV1",
        headers: sendIntentHeadersSchema,
        params: sendIntentParamsSchema,
        body: createSendIntentBodySchema,
        response: {
          201: createSendIntentResponseSchema,
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
      const result = await options.commands.create({
        context,
        draftId: request.params.draftId,
        approvedDraftVersionId: request.body.approvedDraftVersionId,
        gmailConnectionId: request.body.gmailConnectionId,
        messagePurpose: request.body.messagePurpose,
        followUpIndex: request.body.followUpIndex,
        idempotencyKey: request.headers["idempotency-key"],
      });
      return reply.code(201).send({
        ...result,
        meta: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          requestId: request.id,
          schemaVersion: "backlinks.v1",
          generatedAt: new Date().toISOString(),
        },
      });
    },
  );
}
