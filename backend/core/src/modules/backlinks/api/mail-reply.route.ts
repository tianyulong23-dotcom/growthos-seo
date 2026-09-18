import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { BacklinksModule } from "../application/backlinks.module.js";
import { replySendSchema, type MailReplyService } from "../application/services/mail-reply.service.js";
import { backlinkProblemContentType, toBacklinkProblemDetails } from "./problem-details.js";
import { BacklinkError, backlinkErrorCodes } from "../domain/errors/backlink-error.js";

export function registerMailReplyRoutes(app: FastifyInstance, options: {
  module: BacklinksModule;
  service: MailReplyService;
}) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ websiteProjectKey: z.string().min(1), messageId: z.uuid() });
  const errorHandler = (error: import("fastify").FastifyError, request: { id: string }, reply: import("fastify").FastifyReply) => {
    const normalized = error.validation === undefined ? error : new BacklinkError({
      code: backlinkErrorCodes.invalidRequest, message: "Request validation failed.",
    });
    const problem = toBacklinkProblemDetails(normalized, request.id);
    return reply.code(problem.status).type(backlinkProblemContentType).send(problem);
  };
  api.get("/api/v1/projects/:websiteProjectKey/backlinks/mail/messages/:messageId/reply-context", {
    schema: { params }, errorHandler,
  }, async (request) => {
    const context = await options.module.projectContext.resolve({
      actor: request.actor, websiteProjectKey: request.params.websiteProjectKey,
    });
    return options.service.context(context, request.params.messageId);
  });
  api.post("/api/v1/projects/:websiteProjectKey/backlinks/mail/messages/:messageId/reply-send", {
    schema: { params, body: replySendSchema }, errorHandler,
  }, async (request, reply) => {
    const context = await options.module.projectContext.resolve({
      actor: request.actor, websiteProjectKey: request.params.websiteProjectKey,
    });
    const result = await options.service.send(context, request.params.messageId, request.body);
    return reply.code(202).send(result);
  });
}
