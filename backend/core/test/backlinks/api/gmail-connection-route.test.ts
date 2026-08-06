import { createHash } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import { createGmailConnectionCommands } from "../../../src/modules/backlinks/application/commands/gmail-connection.command.js";
import { createGmailConnectionQuery } from "../../../src/modules/backlinks/application/queries/gmail-connection.query.js";
import type {
  GmailConnectionCompletionInput,
  GmailConnectionView,
} from "../../../src/modules/backlinks/application/gmail-connection.gateway.js";
import { registerBacklinksGmailConnectionRoutes } from "../../../src/modules/backlinks/api/gmail-connection.route.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../../src/modules/backlinks/domain/errors/backlink-error.js";
import type {
  ConsumedOAuthAttempt,
  NewOAuthAttempt,
  OAuthAttemptConsumeInput,
  OAuthAttemptRepository,
} from "../../../src/modules/backlinks/domain/sending/oauth-attempt-repository.js";
import {
  OAuthAttemptService,
  gmailOAuthScopes,
} from "../../../src/modules/backlinks/domain/sending/oauth-attempt.js";
import type {
  GoogleAuthCallbackInput,
  GoogleAuthPort,
  GoogleAuthRequestInput,
} from "../../../src/modules/backlinks/ports/google-auth.port.js";

type StoredAttempt = {
  readonly creation: NewOAuthAttempt;
  consumedAt: Date | null;
};

class FakeOAuthAttemptRepository implements OAuthAttemptRepository {
  readonly attempts = new Map<string, StoredAttempt>();

  async cleanupExpired(): Promise<number> {
    return 0;
  }

  async create(input: NewOAuthAttempt): Promise<void> {
    this.attempts.set(input.stateHash, {
      creation: { ...input, requestedScopes: [...input.requestedScopes] },
      consumedAt: null,
    });
  }

  async consume(
    input: OAuthAttemptConsumeInput,
  ): Promise<ConsumedOAuthAttempt | null> {
    const stored = this.attempts.get(input.stateHash);
    if (
      stored === undefined
      || stored.creation.organizationId !== input.organizationId
      || stored.creation.workspaceId !== input.workspaceId
      || stored.creation.initiatedByUserId !== input.initiatedByUserId
      || stored.creation.sessionBindingHash !== input.sessionBindingHash
      || stored.consumedAt !== null
      || stored.creation.expiresAt.getTime() <= input.consumedAt.getTime()
    ) {
      return null;
    }

    stored.consumedAt = new Date(input.consumedAt);
    return {
      attemptId: stored.creation.id,
      organizationId: stored.creation.organizationId,
      workspaceId: stored.creation.workspaceId,
      websiteProjectId: stored.creation.websiteProjectId,
      pkceVerifier: stored.creation.pkceVerifier,
      requestedScopes: stored.creation.requestedScopes,
      redirectUri: stored.creation.redirectUri,
      returnPath: stored.creation.returnPath,
    };
  }
}

const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const redirectUri =
  "http://localhost:7200/api/v1/backlinks/gmail-connections/callback";
const returnPath = "/projects/project-key/backlinks/email";
const routeBase =
  "/api/v1/projects/project-key/backlinks/gmail-connections";
const member = createActorContext({
  userId: "user-103",
  sessionId: "session-103",
  roles: ["member"],
});
const tenant = createTenantContext({
  organizationId: id(1),
  workspaceId: id(2),
});
const project = createProjectContext({
  websiteProjectId: id(3),
  canonicalDomain: "example.com",
  locale: "en-US",
  countryCode: "US",
  profileVersionId: id(4),
  promotionTargetVersionId: id(5),
});
const connection: GmailConnectionView = {
  connectionId: id(20),
  version: 7,
  primaryEmail: "owner@example.com",
  displayName: "Example Owner",
  hostedDomain: "example.com",
  grantedScopes: gmailOAuthScopes,
  connectionStatus: "CONNECTED",
  sendAvailability: "AVAILABLE",
  mailSyncCapability: true,
  tokenExpiresAt: "2026-07-27T06:00:00.000Z",
  connectedAt: "2026-07-27T05:00:00.000Z",
};
const disconnectedConnection: GmailConnectionView = {
  ...connection,
  connectionStatus: "DISCONNECTED",
  sendAvailability: "PAUSED",
};
const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(options?: Readonly<{
  grantedScopes?: readonly string[];
  syncError?: Error;
}>) {
  const repository = new FakeOAuthAttemptRepository();
  let randomValue = 1;
  const oauthAttempts = new OAuthAttemptService({
    repository,
    now: () => new Date("2026-07-27T05:00:00.000Z"),
    newId: () => id(10 + repository.attempts.size),
    randomBytes: (size) => new Uint8Array(size).fill(randomValue++),
  });
  const authorizeCalls: GoogleAuthRequestInput[] = [];
  const callbackCalls: GoogleAuthCallbackInput[] = [];
  const googleAuth: GoogleAuthPort = {
    async authorize(input) {
      authorizeCalls.push(input);
      return {
        authorizationUrl:
          `https://accounts.example.test/authorize?state=${input.state}`,
      };
    },
    async callback(input) {
      callbackCalls.push(input);
      return {
        identity: {
          subject: "google-subject-103",
          email: "owner@example.com",
          emailVerified: true,
          displayName: "Example Owner",
          hostedDomain: "example.com",
        },
        tokens: {
          accessToken: "access-token-103",
          refreshToken: "refresh-token-103",
          tokenType: "Bearer",
          expiresAt: connection.tokenExpiresAt,
          grantedScopes: options?.grantedScopes ?? gmailOAuthScopes,
        },
      };
    },
    async refresh() {
      throw new Error("Unexpected refresh");
    },
    async revoke() {
      throw new Error("Unexpected revoke");
    },
  };
  const completionFacts: {
    contextIds: readonly string[];
    sawAccessToken: boolean;
    sawRefreshToken: boolean;
  }[] = [];
  const disconnectInputs: {
    readonly connectionId: string;
    readonly expectedVersion: number;
    readonly contextIds: readonly string[];
  }[] = [];
  const commands = createGmailConnectionCommands({
    oauthAttempts,
    googleAuth,
    redirectUri,
    completion: {
      async complete(input: GmailConnectionCompletionInput) {
        completionFacts.push({
          contextIds: [
            input.context.organizationId,
            input.context.workspaceId,
            input.context.websiteProjectId,
            input.context.actorId,
          ],
          sawAccessToken: input.tokens.accessToken === "access-token-103",
          sawRefreshToken: input.tokens.refreshToken === "refresh-token-103",
        });
        return connection;
      },
    },
    selector: {
      async selectForProject(_context, connectionId) {
        return connectionId === connection.connectionId
          ? { accounts: [connection], selectedConnection: connection }
          : null;
      },
    },
    disconnectWorkflow: {
      async disconnect(input) {
        disconnectInputs.push({
          connectionId: input.connectionId,
          expectedVersion: input.expectedVersion,
          contextIds: [
            input.context.tenant.organizationId,
            input.context.tenant.workspaceId,
            input.context.project.websiteProjectId,
            input.context.actor.userId,
          ],
        });
        return {
          connection: disconnectedConnection,
          revocationStatus: "PENDING" as const,
        };
      },
    },
  });
  const statusContexts: string[][] = [];
  const syncInputs: {
    readonly connectionId: string;
    readonly contextIds: readonly string[];
  }[] = [];
  const query = createGmailConnectionQuery({
    reader: {
      async findProjectMailboxState(context) {
        statusContexts.push([
          context.tenant.organizationId,
          context.tenant.workspaceId,
          context.project.websiteProjectId,
        ]);
        return {
          accounts: [connection],
          selectedConnection: connection,
        };
      },
    },
  });
  const app = Fastify({ logger: false, genReqId: () => "request-103" });
  apps.push(app);

  return {
    app,
    repository,
    authorizeCalls,
    callbackCalls,
    completionFacts,
    disconnectInputs,
    statusContexts,
    syncInputs,
    async ready() {
      await registerBacklinksOpenApi(app);
      app.decorateRequest("actor");
      app.decorateRequest("platformContext");
      app.addHook("preHandler", async (request) => {
        const role = request.headers["x-role"];
        const session = request.headers["x-session"];
        request.actor = createActorContext({
          userId: role === "viewer" ? "viewer-103" : member.userId,
          sessionId:
            typeof session === "string" ? session : member.sessionId,
          roles: [role === "viewer" ? "viewer" : "member"],
        });
        request.platformContext = {
          version: "PlatformRequestContext.v1",
          issuer: "growthos-platform-gateway",
          audience: "growthos-backlinks-core",
          issuedAt: "2026-07-27T04:59:30.000Z",
          expiresAt: "2026-07-27T05:00:30.000Z",
          correlationId: "request-103",
          actor: {
            userId: request.actor.userId,
            sessionId: request.actor.sessionId,
            roles: request.actor.roles,
          },
          tenant,
          project: null,
          permissions: ["backlinks.gmail:manage"],
        };
      });
      registerBacklinksGmailConnectionRoutes(app, {
        module: createBacklinksModule({
          projectContext: {
            async resolve({ actor, websiteProjectKey }) {
              if (websiteProjectKey === "foreign") {
                throw new BacklinkError({
                  code: backlinkErrorCodes.accessDenied,
                  message: "Project access denied.",
                });
              }
              return {
                actor,
                tenant,
                project:
                  websiteProjectKey === "other-project"
                    ? { ...project, websiteProjectId: id(30) }
                    : project,
              };
            },
          },
          queries: {},
        }),
        commands,
        query,
        syncCommands: {
          async start(input) {
            syncInputs.push({
              connectionId: input.connectionId,
              contextIds: [
                input.context.tenant.organizationId,
                input.context.tenant.workspaceId,
                input.context.project.websiteProjectId,
                input.context.actor.userId,
              ],
            });
            if (options?.syncError !== undefined) {
              throw options.syncError;
            }
            return {
              status: "ACCEPTED",
              workflowId: id(40),
            };
          },
          async status() {
            return {
              state: "POLLING",
              workflowId: id(40),
              pollingIntervalSeconds: 60,
              killSwitchOpen: true,
              acceptedSendCount: 2,
              cursor: {
                historyId: "166995",
                initialSyncCompletedAt: "2026-08-04T00:00:00.000Z",
                lastSyncedAt: "2026-08-04T00:01:00.000Z",
                version: 3,
              },
            };
          },
        },
      });
      await app.ready();
    },
  };
}

describe("BL-AI-103 Gmail connection APIs", () => {
  it("binds connect and callback to state, PKCE, session, and project context", async () => {
    const test = setup();
    await test.ready();

    const connect = await test.app.inject({
      method: "POST",
      url: `${routeBase}/connect`,
      payload: { returnPath },
    });
    expect(connect.statusCode).toBe(200);
    expect(connect.json()).toMatchObject({
      authorizationUrl: expect.stringContaining(
        "https://accounts.example.test/authorize?state=",
      ),
      expiresAt: "2026-07-27T05:10:00.000Z",
      meta: {
        organizationId: id(1),
        workspaceId: id(2),
        websiteProjectId: id(3),
        requestId: "request-103",
      },
    });
    expect(test.authorizeCalls).toHaveLength(1);
    expect(test.authorizeCalls[0]).toMatchObject({
      redirectUri,
      codeChallengeMethod: "S256",
      requestedScopes: gmailOAuthScopes,
    });
    const state = test.authorizeCalls[0]?.state ?? "";
    const stored = test.repository.attempts.get(sha256Hex(state));
    expect(stored?.creation).toMatchObject({
      organizationId: id(1),
      workspaceId: id(2),
      websiteProjectId: id(3),
      initiatedByUserId: "user-103",
      redirectUri,
      returnPath,
    });

    const callback = await test.app.inject({
      method: "GET",
      url: `/api/v1/backlinks/gmail-connections/callback`
        + `?code=authorization-code-103&state=${state}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(test.callbackCalls).toEqual([{
      authorizationCode: "authorization-code-103",
      codeVerifier: stored?.creation.pkceVerifier,
      redirectUri,
    }]);
    expect(test.completionFacts).toEqual([{
      contextIds: [id(1), id(2), id(3), "user-103"],
      sawAccessToken: true,
      sawRefreshToken: true,
    }]);
    expect(callback.json()).toMatchObject({
      connection,
      returnPath,
      meta: { websiteProjectId: id(3), requestId: "request-103" },
    });

    const status = await test.app.inject({
      method: "GET",
      url: `${routeBase}/status`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      connection,
      accounts: [connection],
      meta: { websiteProjectId: id(3), requestId: "request-103" },
    });
    expect(test.statusContexts).toEqual([[id(1), id(2), id(3)]]);

    const callbackText = callback.body;
    const statusText = status.body;
    for (const secret of [
      "authorization-code-103",
      stored?.creation.pkceVerifier ?? "",
      "access-token-103",
      "refresh-token-103",
      "accessToken",
      "refreshToken",
      "codeVerifier",
      "tokenSecretReferenceId",
      "credentialReference",
    ]) {
      expect(callbackText).not.toContain(secret);
      expect(statusText).not.toContain(secret);
    }
    expect(apps[0]?.swagger().paths).toMatchObject({
      "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/connect":
        { post: { operationId: "backlinksConnectGmailV1" } },
      "/api/v1/backlinks/gmail-connections/callback":
        { get: { operationId: "backlinksCompleteGmailConnectionV1" } },
      "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/callback":
        { get: { operationId: "backlinksCompleteLegacyGmailConnectionV1" } },
      "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/status":
        { get: { operationId: "backlinksGetGmailConnectionStatusV1" } },
      "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/select":
        { post: { operationId: "backlinksSelectGmailConnectionV1" } },
      "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/{connectionId}/disconnect":
        { post: { operationId: "backlinksDisconnectGmailV1" } },
      "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/{connectionId}/sync-status":
        { get: { operationId: "backlinksGetGmailPollingSyncStatusV1" } },
    });
  });

  it("returns polling, cursor, and recovery status without credentials", async () => {
    const test = setup();
    await test.ready();

    const response = await test.app.inject({
      method: "GET",
      url: `${routeBase}/${connection.connectionId}/sync-status`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "POLLING",
      workflowId: id(40),
      pollingIntervalSeconds: 60,
      killSwitchOpen: true,
      acceptedSendCount: 2,
      cursor: {
        historyId: "166995",
        initialSyncCompletedAt: "2026-08-04T00:00:00.000Z",
        lastSyncedAt: "2026-08-04T00:01:00.000Z",
        version: 3,
      },
      meta: {
        websiteProjectId: id(3),
        requestId: "request-103",
      },
    });
    expect(response.body).not.toMatch(
      /accessToken|refreshToken|tokenSecretReference|credentialReference/,
    );
  });

  it("disconnects by resolved project scope without returning credentials", async () => {
    const test = setup();
    await test.ready();

    const response = await test.app.inject({
      method: "POST",
      url: `${routeBase}/${connection.connectionId}/disconnect`,
      payload: { expectedVersion: 7 },
    });

    expect(response.statusCode).toBe(200);
    expect(test.disconnectInputs).toEqual([{
      connectionId: connection.connectionId,
      expectedVersion: 7,
      contextIds: [id(1), id(2), id(3), "user-103"],
    }]);
    expect(response.json()).toMatchObject({
      connection: disconnectedConnection,
      revocationStatus: "PENDING",
      meta: {
        organizationId: id(1),
        workspaceId: id(2),
        websiteProjectId: id(3),
        requestId: "request-103",
      },
    });
    expect(response.body).not.toMatch(
      /access-token|refresh-token|externalSecretId|tokenSecretReference|credentialReference/,
    );

    const forbidden = await test.app.inject({
      method: "POST",
      url: `${routeBase}/${connection.connectionId}/disconnect`,
      headers: { "x-role": "viewer" },
      payload: { expectedVersion: 7 },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(test.disconnectInputs).toHaveLength(1);
  });

  it("maps a blocked Gmail polling sync to a conflict response", async () => {
    const isolatedRuntimeError = new Error(
      "Gmail polling is blocked by the project Kill Switch.",
    ) as Error & {
      code: typeof backlinkErrorCodes.conflict;
      retryable: boolean;
    };
    isolatedRuntimeError.name = "BacklinkError";
    isolatedRuntimeError.code = backlinkErrorCodes.conflict;
    isolatedRuntimeError.retryable = false;
    const test = setup({
      syncError: isolatedRuntimeError,
    });
    await test.ready();

    const response = await test.app.inject({
      method: "POST",
      url: `${routeBase}/${connection.connectionId}/sync`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: backlinkErrorCodes.conflict,
      retryable: false,
    });
    expect(test.syncInputs).toEqual([{
      connectionId: connection.connectionId,
      contextIds: [id(1), id(2), id(3), "user-103"],
    }]);
  });

  it("maps an unsupported sync request media type to an invalid request", async () => {
    const test = setup();
    await test.ready();

    const response = await test.app.inject({
      method: "POST",
      url: `${routeBase}/${connection.connectionId}/sync`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "invalid=transport",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: backlinkErrorCodes.invalidRequest,
      retryable: false,
    });
    expect(test.syncInputs).toHaveLength(0);
  });

  it("rejects missing permission, session mismatch, and replay while ignoring the legacy path project", async () => {
    const test = setup();
    await test.ready();

    expect((await test.app.inject({
      method: "POST",
      url: `${routeBase}/connect`,
      headers: { "x-role": "viewer" },
      payload: {},
    })).statusCode).toBe(403);
    expect(test.authorizeCalls).toHaveLength(0);

    await test.app.inject({
      method: "POST",
      url: `${routeBase}/connect`,
      payload: {},
    });
    const state = test.authorizeCalls[0]?.state ?? "";
    const legacyCallbackUrl = (projectKey: string) =>
      `/api/v1/projects/${projectKey}/backlinks/gmail-connections/callback`
      + `?code=authorization-code-103&state=${state}`;
    const stableCallbackUrl =
      `/api/v1/backlinks/gmail-connections/callback`
      + `?code=authorization-code-103&state=${state}`;

    expect((await test.app.inject({
      method: "GET",
      url: stableCallbackUrl,
      headers: { "x-role": "viewer" },
    })).statusCode).toBe(403);
    expect((await test.app.inject({
      method: "GET",
      url: legacyCallbackUrl("other-project"),
      headers: { "x-session": "other-session" },
    })).statusCode).toBe(400);
    expect(test.callbackCalls).toHaveLength(0);

    expect((await test.app.inject({
      method: "GET",
      url: legacyCallbackUrl("other-project"),
    })).statusCode).toBe(200);
    expect(test.completionFacts[0]?.contextIds[2]).toBe(id(3));
    const replay = await test.app.inject({
      method: "GET",
      url: stableCallbackUrl,
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.body).not.toContain(state);
    expect(replay.body).not.toContain("authorization-code-103");
    expect(test.callbackCalls).toHaveLength(1);

    expect((await test.app.inject({
      method: "GET",
      url: `${routeBase}/status`,
      headers: { "x-role": "viewer" },
    })).statusCode).toBe(403);
    expect((await test.app.inject({
      method: "GET",
      url: "/api/v1/projects/foreign/backlinks/gmail-connections/status",
    })).statusCode).toBe(403);
  });

  it("does not complete a connection without the required Gmail scope", async () => {
    const test = setup({ grantedScopes: ["openid", "email", "profile"] });
    await test.ready();
    await test.app.inject({
      method: "POST",
      url: `${routeBase}/connect`,
      payload: {},
    });
    const state = test.authorizeCalls[0]?.state ?? "";

    const response = await test.app.inject({
      method: "GET",
      url: `/api/v1/backlinks/gmail-connections/callback`
        + `?code=authorization-code-103&state=${state}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: backlinkErrorCodes.invalidRequest,
    });
    expect(test.completionFacts).toHaveLength(0);
    expect(response.body).not.toContain("access-token-103");
    expect(response.body).not.toContain("refresh-token-103");
  });

  it("does not persist a grant containing an unapproved extra scope", async () => {
    const test = setup({
      grantedScopes: [...gmailOAuthScopes, "https://www.googleapis.com/auth/drive.readonly"],
    });
    await test.ready();
    await test.app.inject({
      method: "POST",
      url: `${routeBase}/connect`,
      payload: {},
    });
    const state = test.authorizeCalls[0]?.state ?? "";

    const response = await test.app.inject({
      method: "GET",
      url: `/api/v1/backlinks/gmail-connections/callback`
        + `?code=authorization-code-103&state=${state}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: backlinkErrorCodes.invalidRequest,
    });
    expect(test.completionFacts).toHaveLength(0);
  });
});
