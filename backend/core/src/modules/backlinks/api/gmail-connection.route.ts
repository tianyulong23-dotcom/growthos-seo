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
import type {
  GmailPollingSyncCommands,
} from "../application/workflows/gmail-polling-sync-workflow.js";
import {
  BacklinkError,
  backlinkErrorCodes,
  isBacklinkError,
} from "../domain/errors/backlink-error.js";
import { GoogleAuthError } from "../ports/google-auth.port.js";
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
  gmailConnectionSelectionBodySchema,
  gmailConnectResponseSchema,
  gmailDisconnectBodySchema,
  gmailDisconnectResponseSchema,
  gmailPollingSyncResponseSchema,
  gmailPollingSyncStatusResponseSchema,
  gmailSelectionResponseSchema,
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
  503: backlinkProblemDetailsSchema,
};

function sendGmailConnectionError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const invalidTransportRequest =
    error.validation !== undefined
    || error.code?.startsWith("FST_ERR_CTP_") === true;
  const googleAuthError =
    error instanceof GoogleAuthError
      ? error
      : error instanceof BacklinkError && error.cause instanceof GoogleAuthError
        ? error.cause
        : null;
  request.log.warn({
    event: "backlinks.gmail-connection.request.failed",
    errorName: error.name,
    errorCode: error.code,
    backlinkError: isBacklinkError(error),
    validationError: invalidTransportRequest,
    googleAuthOperation: googleAuthError?.operation ?? null,
    googleAuthCode: googleAuthError?.code ?? null,
    googleAuthHttpStatus: googleAuthError?.httpStatus ?? null,
    googleAuthProviderRequestId: googleAuthError?.providerRequestId ?? null,
    googleAuthTransportCode: googleAuthError?.transportCode ?? null,
  });
  const normalized =
    error instanceof BacklinkError
      ? error
      : invalidTransportRequest
        ? new BacklinkError({
            code: backlinkErrorCodes.invalidRequest,
            message: "Request validation failed.",
          })
        : error;
  const problem = toBacklinkProblemDetails(normalized, request.id);
  void reply.code(problem.status).type(backlinkProblemContentType).send(problem);
}

const meta = (
  request: FastifyRequest,
  scope: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
  }>,
) => ({
  ...scope,
  requestId: request.id,
  schemaVersion: "backlinks.v1" as const,
  generatedAt: new Date().toISOString(),
});

const projectScope = (
  context: Awaited<
    ReturnType<BacklinksModule["projectContext"]["resolve"]>
  >,
) => ({
  organizationId: context.tenant.organizationId,
  workspaceId: context.tenant.workspaceId,
  websiteProjectId: context.project.websiteProjectId,
});

const serializeConnection = (
  connection: GmailConnectionView,
) => ({
  ...connection,
  affectedProjectCount: connection.affectedProjectCount ?? 0,
  grantedScopes: [...connection.grantedScopes],
  recentErrorCategory: connection.recentErrorCategory ?? null,
});

const serializeOptionalConnection = (
  connection: GmailConnectionView | null,
) => connection === null ? null : serializeConnection(connection);

const serializeReadiness = (
  readiness: Awaited<
    ReturnType<GmailConnectionQuery["getStatus"]>
  >["readiness"],
) => ({
  evaluatedAt: readiness.evaluatedAt,
  connection: { ...readiness.connection },
  send: { ...readiness.send },
  sync: { ...readiness.sync },
  blockers: readiness.blockers.map((item) => ({ ...item })),
  primaryBlocker:
    readiness.primaryBlocker === null
      ? null
      : { ...readiness.primaryBlocker },
});

export function registerBacklinksGmailConnectionRoutes(
  app: FastifyInstance,
  options: Readonly<{
    module: BacklinksModule;
    commands: GmailConnectionCommands;
    query: GmailConnectionQuery;
    syncCommands: GmailPollingSyncCommands;
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
        ? {
            context,
            websiteProjectKey: request.params.websiteProjectKey,
          }
        : {
            context,
            websiteProjectKey: request.params.websiteProjectKey,
            returnPath: request.body.returnPath,
          },
    );
    return { ...result, meta: meta(request, projectScope(context)) };
  });

  const complete = async (
    request: FastifyRequest,
  ) => {
    const query = request.query as { code: string; state: string };
    const result = await options.commands.complete({
      actor: request.actor,
      tenant: {
        organizationId: request.platformContext.tenant.organizationId,
        workspaceId: request.platformContext.tenant.workspaceId,
      },
      authorizationCode: query.code,
      state: query.state,
    });
    return {
      connection: serializeConnection(result.connection),
      returnPath: result.returnPath,
      meta: meta(request, {
        organizationId: request.platformContext.tenant.organizationId,
        workspaceId: request.platformContext.tenant.workspaceId,
        websiteProjectId: result.websiteProjectId,
      }),
    };
  };

  api.get("/api/v1/backlinks/gmail-connections/callback", {
    schema: {
      operationId: "backlinksCompleteGmailConnectionV1",
      querystring: gmailCallbackQuerySchema,
      response: { 200: gmailCallbackResponseSchema, ...errorResponses },
    },
    errorHandler: sendGmailConnectionError,
  }, complete);

  api.get(`${basePath}/callback`, {
    schema: {
      operationId: "backlinksCompleteLegacyGmailConnectionV1",
      deprecated: true,
      params: gmailConnectionParamsSchema,
      querystring: gmailCallbackQuerySchema,
      response: { 200: gmailCallbackResponseSchema, ...errorResponses },
    },
    errorHandler: sendGmailConnectionError,
  }, complete);

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
    const state = await options.query.getStatus(context);
    return {
      connection: serializeOptionalConnection(state.selectedConnection),
      accounts: state.accounts.map(serializeConnection),
      readiness: serializeReadiness(state.readiness),
      meta: meta(request, projectScope(context)),
    };
  });

  api.post(`${basePath}/select`, {
    schema: {
      operationId: "backlinksSelectGmailConnectionV1",
      params: gmailConnectionParamsSchema,
      body: gmailConnectionSelectionBodySchema,
      response: { 200: gmailSelectionResponseSchema, ...errorResponses },
    },
    errorHandler: sendGmailConnectionError,
  }, async (request) => {
    const context = await options.module.projectContext.resolve({
      actor: request.actor,
      websiteProjectKey: request.params.websiteProjectKey,
    });
    await options.commands.select({
      context,
      connectionId: request.body.connectionId,
    });
    const state = await options.query.getStatus(context);
    return {
      connection: serializeOptionalConnection(state.selectedConnection),
      accounts: state.accounts.map(serializeConnection),
      readiness: serializeReadiness(state.readiness),
      meta: meta(request, projectScope(context)),
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
      meta: meta(request, projectScope(context)),
    };
  });

  api.post(`${basePath}/:connectionId/sync`, {
    schema: {
      operationId: "backlinksStartGmailPollingSyncV1",
      params: gmailConnectionResourceParamsSchema,
      response: { 202: gmailPollingSyncResponseSchema, ...errorResponses },
    },
    errorHandler: sendGmailConnectionError,
  }, async (request, reply) => {
    const context = await options.module.projectContext.resolve({
      actor: request.actor,
      websiteProjectKey: request.params.websiteProjectKey,
    });
    const result = await options.syncCommands.start({
      context,
      connectionId: request.params.connectionId,
    });
    return reply.code(202).send({
      ...result,
      meta: meta(request, projectScope(context)),
    });
  });

  api.get(`${basePath}/:connectionId/sync-status`, {
    schema: {
      operationId: "backlinksGetGmailPollingSyncStatusV1",
      params: gmailConnectionResourceParamsSchema,
      response: {
        200: gmailPollingSyncStatusResponseSchema,
        ...errorResponses,
      },
    },
    errorHandler: sendGmailConnectionError,
  }, async (request) => {
    const context = await options.module.projectContext.resolve({
      actor: request.actor,
      websiteProjectKey: request.params.websiteProjectKey,
    });
    const status = await options.syncCommands.status({
      context,
      connectionId: request.params.connectionId,
    });
    return {
      ...status,
      lastErrorCategory: status.lastErrorCategory ?? null,
      consecutiveFailures: status.consecutiveFailures ?? 0,
      meta: meta(request, projectScope(context)),
    };
  });
}
