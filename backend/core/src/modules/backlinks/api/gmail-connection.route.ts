import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { BacklinksModule } from "../application/backlinks.module.js";
import type { createGmailConnectionCommands } from "../application/commands/gmail-connection.command.js";
import type { GmailConnectionView } from "../application/gmail-connection.gateway.js";
import type { createGmailConnectionQuery } from "../application/queries/gmail-connection.query.js";
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
  gmailCallbackQuerySchema,
  gmailCallbackResponseSchema,
  gmailConnectBodySchema,
  gmailConnectionParamsSchema,
  gmailConnectionResourceParamsSchema,
  gmailConnectResponseSchema,
  gmailDisconnectBodySchema,
  gmailDisconnectResponseSchema,
  gmailStatusResponseSchema,
} from "./gmail-connection.schema.js";

type GmailConnectionCommands = ReturnType<
  typeof createGmailConnectionCommands
>;
type GmailConnectionQuery = ReturnType<typeof createGmailConnectionQuery>;

const errorResponses = {
  400: backlinkProblemDetailsSchema,
  403: backlinkProblemDetailsSchema,
  404: backlinkProblemDetailsSchema,
  409: backlinkProblemDetailsSchema,
  500: backlinkProblemDetailsSchema,
};

function sendGmailConnectionError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const normalized =
    error instanceof BacklinkError
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

const serializeConnection = (
  connection: GmailConnectionView,
) => ({ ...connection, grantedScopes: [...connection.grantedScopes] });

const serializeOptionalConnection = (
  connection: GmailConnectionView | null,
) => connection === null ? null : serializeConnection(connection);

export function registerBacklinksGmailConnectionRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule;
    commands: GmailConnectionCommands;
    query: GmailConnectionQuery;
  }>,
): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const basePath =
    "/api/v1/projects/:websiteProjectKey/backlinks/gmail-connections";

  api.post(`${basePath}/connect`, {
    schema: {
      operationId: "backlinksConnectGmailV1",
      params: gmailConnectionParamsSchema,
      body: gmailConnectBodySchema,
      response: { 200: gmailConnectResponseSchema, ...errorResponses },
    },
    errorHandler: sendGmailConnectionError,
  }, async (request) => {
    const context = await options.module.projectContext.resolve({
      actor: request.actor,
      websiteProjectKey: request.params.websiteProjectKey,
    });
    const result = await options.commands.connect(
      request.body.returnPath === undefined
        ? { context }
        : { context, returnPath: request.body.returnPath },
    );
    return { ...result, meta: meta(request, context) };
  });

  api.get(`${basePath}/callback`, {
    schema: {
      operationId: "backlinksCompleteGmailConnectionV1",
      params: gmailConnectionParamsSchema,
      querystring: gmailCallbackQuerySchema,
      response: { 200: gmailCallbackResponseSchema, ...errorResponses },
    },
    errorHandler: sendGmailConnectionError,
  }, async (request) => {
    const context = await options.module.projectContext.resolve({
      actor: request.actor,
      websiteProjectKey: request.params.websiteProjectKey,
    });
    const result = await options.commands.complete({
      context,
      authorizationCode: request.query.code,
      state: request.query.state,
    });
    return {
      ...result,
      connection: serializeConnection(result.connection),
      meta: meta(request, context),
    };
  });

  api.get(`${basePath}/status`, {
    schema: {
      operationId: "backlinksGetGmailConnectionStatusV1",
      params: gmailConnectionParamsSchema,
      response: { 200: gmailStatusResponseSchema, ...errorResponses },
    },
    errorHandler: sendGmailConnectionError,
  }, async (request) => {
    const context = await options.module.projectContext.resolve({
      actor: request.actor,
      websiteProjectKey: request.params.websiteProjectKey,
    });
    return {
      connection: serializeOptionalConnection(
        await options.query.getStatus(context),
      ),
      meta: meta(request, context),
    };
  });

  api.post(`${basePath}/:connectionId/disconnect`, {
    schema: {
      operationId: "backlinksDisconnectGmailV1",
      params: gmailConnectionResourceParamsSchema,
      body: gmailDisconnectBodySchema,
      response: { 200: gmailDisconnectResponseSchema, ...errorResponses },
    },
    errorHandler: sendGmailConnectionError,
  }, async (request) => {
    const context = await options.module.projectContext.resolve({
      actor: request.actor,
      websiteProjectKey: request.params.websiteProjectKey,
    });
    const result = await options.commands.disconnect({
      context,
      connectionId: request.params.connectionId,
      expectedVersion: request.body.expectedVersion,
    });
    return {
      ...result,
      connection: serializeConnection(result.connection),
      meta: meta(request, context),
    };
  });
}
