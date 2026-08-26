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
import type {
  SendIntentListQuery,
  SendIntentQuery,
} from "../application/queries/send-intent.query.js";
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
  getSendIntentParamsSchema,
  getSendIntentResponseSchema,
  listSendIntentsParamsSchema,
  listSendIntentsQuerySchema,
  listSendIntentsResponseSchema,
  preflightSendIntentBodySchema,
  preflightSendIntentResponseSchema,
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
    module: BacklinksModule<SendIntentQuery>;
    commands: Commands;
  }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/send-intents/:sendIntentId",
    {
      schema: {
        operationId: "backlinksGetSendIntentV1",
        params: getSendIntentParamsSchema,
        response: {
          200: getSendIntentResponseSchema,
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
      const sendIntent = await options.module.queries.getSendIntent(
        context,
        request.params.sendIntentId,
      );
      return {
        sendIntent,
        meta: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          requestId: request.id,
          schemaVersion: "backlinks.v1" as const,
          generatedAt: new Date().toISOString(),
        },
      };
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/v1/projects/:websiteProjectKey/backlinks/drafts/:draftId/send-preflight",
    {
      schema: {
        operationId: "backlinksPreflightSendIntentV1",
        params: sendIntentParamsSchema,
        body: preflightSendIntentBodySchema,
        response: {
          200: preflightSendIntentResponseSchema,
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
      const result = await options.commands.preflight({
        context,
        draftId: request.params.draftId,
        approvedDraftVersionId: request.body.approvedDraftVersionId,
        contactId: request.body.contactId,
        contactVersion: request.body.contactVersion,
        gmailConnectionId: request.body.gmailConnectionId,
        messagePurpose: request.body.messagePurpose,
        followUpIndex: request.body.followUpIndex,
      });
      return {
        ...result,
        meta: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          requestId: request.id,
          schemaVersion: "backlinks.v1" as const,
          generatedAt: new Date().toISOString(),
        },
      };
    },
  );

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
        contactId: request.body.contactId,
        contactVersion: request.body.contactVersion,
        gmailConnectionId: request.body.gmailConnectionId,
        messagePurpose: request.body.messagePurpose,
        followUpIndex: request.body.followUpIndex,
        readinessSnapshot: request.body.readinessSnapshot,
        humanConfirmation: request.body.humanConfirmation,
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

export function registerBacklinksSendIntentListRoute(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule<SendIntentListQuery>;
  }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/send-intents",
    {
      schema: {
        operationId: "backlinksListSendIntentsV1",
        params: listSendIntentsParamsSchema,
        querystring: listSendIntentsQuerySchema,
        response: {
          200: listSendIntentsResponseSchema,
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
      const page = await options.module.queries.listSendIntents(
        context,
        request.query,
      );
      return {
        ...page,
        meta: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          requestId: request.id,
          schemaVersion: "backlinks.v1" as const,
          generatedAt: new Date().toISOString(),
        },
      };
    },
  );
}
