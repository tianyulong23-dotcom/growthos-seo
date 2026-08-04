import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { BacklinksModule } from "../application/backlinks.module.js";
import type {
  ReplyMailQuery,
} from "../application/queries/reply-mail.query.js";
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
  replyMailDetailResponseSchema,
  replyMailListParamsSchema,
  replyMailListQuerySchema,
  replyMailListResponseSchema,
  replyMailMessageParamsSchema,
  replyMailThreadParamsSchema,
  replyMailThreadResponseSchema,
} from "./reply-mail.schema.js";

const errors = {
  400: backlinkProblemDetailsSchema,
  403: backlinkProblemDetailsSchema,
  404: backlinkProblemDetailsSchema,
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

function meta(
  context: Awaited<
    ReturnType<BacklinksModule["projectContext"]["resolve"]>
  >,
  requestId: string,
) {
  return {
    organizationId: context.tenant.organizationId,
    workspaceId: context.tenant.workspaceId,
    websiteProjectId: context.project.websiteProjectId,
    requestId,
    schemaVersion: "backlinks.v1" as const,
    generatedAt: new Date().toISOString(),
  };
}

export function registerBacklinksReplyMailRoutes(
  app: FastifyInstance,
  options: Readonly<{ module: BacklinksModule<ReplyMailQuery> }>,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/mail/messages",
    {
      schema: {
        operationId: "backlinksListReplyMailMessagesV1",
        params: replyMailListParamsSchema,
        querystring: replyMailListQuerySchema,
        response: { 200: replyMailListResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const page = await options.module.queries.listMailMessages(
        context,
        request.query,
      );
      return { ...page, meta: meta(context, request.id) };
    },
  );

  api.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/mail/messages/:messageId",
    {
      schema: {
        operationId: "backlinksGetReplyMailMessageV1",
        params: replyMailMessageParamsSchema,
        response: { 200: replyMailDetailResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const item = await options.module.queries.getMailMessage(
        context,
        request.params.messageId,
      );
      return { item, meta: meta(context, request.id) };
    },
  );

  api.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/mail/threads/:threadId",
    {
      schema: {
        operationId: "backlinksGetReplyMailThreadV1",
        params: replyMailThreadParamsSchema,
        response: { 200: replyMailThreadResponseSchema, ...errors },
      },
      errorHandler: sendError,
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const item = await options.module.queries.getMailThread(
        context,
        request.params.threadId,
      );
      return { item, meta: meta(context, request.id) };
    },
  );
}
