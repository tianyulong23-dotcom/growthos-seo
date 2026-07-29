import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createBacklinksModule } from "../../src/modules/backlinks/application/backlinks.module.js";
import { createContactCommands } from "../../src/modules/backlinks/application/commands/contacts.command.js";
import { registerBacklinksContactsRoutes } from "../../src/modules/backlinks/api/contacts.route.js";
import { registerBacklinksOpenApi } from "../../src/modules/backlinks/api/openapi.js";
import {
  platformRequestContextSchema,
  registerBacklinksPlatformContextConsumer,
  type PlatformRequestContextV1,
} from "../../src/modules/backlinks/api/platform-request-context.js";
import {
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";
import { backlinkErrorCodes } from "../../src/modules/backlinks/domain/errors/backlink-error.js";

const signingKey = "test-only-platform-context-key-32-bytes";
const now = new Date("2026-07-23T09:30:00.000Z");
const baseContext: PlatformRequestContextV1 = {
  version: "PlatformRequestContext.v1",
  issuer: "growthos-platform-gateway",
  audience: "growthos-backlinks-core",
  issuedAt: "2026-07-23T09:30:00.000Z",
  expiresAt: "2026-07-23T09:30:30.000Z",
  correlationId: "correlation-arch-004",
  actor: {
    userId: "user-arch-004",
    sessionId: "session-arch-004",
    roles: ["member"],
  },
  tenant: {
    organizationId: "org-authoritative",
    workspaceId: "workspace-authoritative",
  },
  project: {
    websiteProjectId: "project-authoritative",
    websiteProjectKey: "project-key",
  },
  permissions: ["backlinks:read", "backlinks:write"],
};
const pythonProducerHeaders = {
  "x-growthos-platform-context":
    "eyJhY3RvciI6eyJyb2xlcyI6WyJtZW1iZXIiXSwic2Vzc2lvbklkIjoic2Vzc2lvbi1hcmNoLTAwNCIsInVzZXJJZCI6InVzZXItYXJjaC0wMDQifSwiYXVkaWVuY2UiOiJncm93dGhvcy1iYWNrbGlua3MtY29yZSIsImNvcnJlbGF0aW9uSWQiOiJjb3JyZWxhdGlvbi1hcmNoLTAwNCIsImV4cGlyZXNBdCI6IjIwMjYtMDctMjNUMDk6MzA6MzAuMDAwWiIsImlzc3VlZEF0IjoiMjAyNi0wNy0yM1QwOTozMDowMC4wMDBaIiwiaXNzdWVyIjoiZ3Jvd3Rob3MtcGxhdGZvcm0tZ2F0ZXdheSIsInBlcm1pc3Npb25zIjpbImJhY2tsaW5rczpyZWFkIiwiYmFja2xpbmtzOndyaXRlIl0sInByb2plY3QiOnsid2Vic2l0ZVByb2plY3RJZCI6InByb2plY3QtYXV0aG9yaXRhdGl2ZSIsIndlYnNpdGVQcm9qZWN0S2V5IjoicHJvamVjdC1rZXkifSwidGVuYW50Ijp7Im9yZ2FuaXphdGlvbklkIjoib3JnLWF1dGhvcml0YXRpdmUiLCJ3b3Jrc3BhY2VJZCI6IndvcmtzcGFjZS1hdXRob3JpdGF0aXZlIn0sInZlcnNpb24iOiJQbGF0Zm9ybVJlcXVlc3RDb250ZXh0LnYxIn0",
  "x-growthos-platform-context-signature":
    "v1=tsH-qBF5DN0Elg-JlUom4wlxn8_XOSvTS4zt8zaHnQI",
} as const;
const apps: FastifyInstance[] = [];

function signedHeaders(
  context: PlatformRequestContextV1 = baseContext,
  key = signingKey,
): Record<string, string> {
  const payload = Buffer.from(JSON.stringify(context)).toString("base64url");
  const signature = createHmac("sha256", key)
    .update(`PlatformRequestContext.v1.${payload}`)
    .digest("base64url");
  return {
    "x-growthos-platform-context": payload,
    "x-growthos-platform-context-signature": `v1=${signature}`,
  };
}

async function createConsumerApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, genReqId: () => "request-arch-004" });
  apps.push(app);
  registerBacklinksPlatformContextConsumer(app, {
    signingKey,
    now: () => now,
  });
  app.get(
    "/api/v1/projects/:websiteProjectKey/backlinks/test",
    async (request) => ({
      actor: request.actor,
      platformContext: request.platformContext,
    }),
  );
  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("PlatformRequestContext.v1 Backlinks consumer", () => {
  it("matches the shared schema and accepts a valid Python-compatible envelope", async () => {
    const schemaUrl = new URL(
      "../../../contracts/json-schema/platform-request-context.v1.schema.json",
      import.meta.url,
    );
    const schema = JSON.parse(await readFile(schemaUrl, "utf8")) as {
      properties: { version: { const: string } };
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema).toMatchObject({
      properties: {
        version: { const: "PlatformRequestContext.v1" },
      },
      additionalProperties: false,
    });
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "actor",
        "tenant",
        "project",
        "permissions",
        "correlationId",
      ]),
    );
    expect(platformRequestContextSchema.parse(baseContext)).toEqual(baseContext);

    const app = await createConsumerApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-key/backlinks/test",
      headers: pythonProducerHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      actor: baseContext.actor,
      platformContext: baseContext,
    });
  });

  it.each([
    [
      "missing",
      {},
      backlinkErrorCodes.authenticationRequired,
      401,
    ],
    [
      "tampered",
      {
        ...signedHeaders(),
        "x-growthos-platform-context": Buffer.from(
          JSON.stringify({
            ...baseContext,
            tenant: { ...baseContext.tenant, workspaceId: "workspace-forged" },
          }),
        ).toString("base64url"),
      },
      backlinkErrorCodes.authenticationRequired,
      401,
    ],
    [
      "expired",
      signedHeaders({
        ...baseContext,
        issuedAt: "2026-07-23T09:28:00.000Z",
        expiresAt: "2026-07-23T09:29:00.000Z",
      }),
      backlinkErrorCodes.authenticationRequired,
      401,
    ],
    [
      "wrong audience",
      signedHeaders({ ...baseContext, audience: "another-service" as never }),
      backlinkErrorCodes.authenticationRequired,
      401,
    ],
  ])("fails closed for a %s context", async (_case, headers, code, status) => {
    const app = await createConsumerApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-key/backlinks/test",
      headers,
    });

    expect(response.statusCode).toBe(status);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ code, status });
  });

  it("rejects a signed context bound to another project", async () => {
    const app = await createConsumerApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/another-project/backlinks/test",
      headers: signedHeaders(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: backlinkErrorCodes.accessDenied,
      status: 403,
    });
  });

  it("preserves Backlinks role and ExpectedVersion authorization", async () => {
    let queryCalls = 0;
    const commands = createContactCommands({
      query: async () => {
        queryCalls += 1;
        return { rows: [{ state: "version_conflict" }] };
      },
    });
    const app = Fastify({ logger: false, genReqId: () => "request-arch-004" });
    apps.push(app);
    await registerBacklinksOpenApi(app);
    registerBacklinksPlatformContextConsumer(app, {
      signingKey,
      now: () => now,
    });
    registerBacklinksContactsRoutes(app, {
      module: createBacklinksModule({
        projectContext: {
          resolve: async ({ actor }) => ({
            actor,
            tenant: createTenantContext(baseContext.tenant),
            project: createProjectContext({
              websiteProjectId: baseContext.project.websiteProjectId,
              canonicalDomain: "example.com",
              locale: "en-US",
              countryCode: "US",
              profileVersionId: "profile-1",
              promotionTargetVersionId: "target-1",
            }),
          }),
        },
        queries: {},
      }),
      commands,
    });
    await app.ready();
    const path =
      "/api/v1/projects/project-key/backlinks/contacts/candidates/"
      + "018f0000-0000-7000-8000-000000000004/confirm";
    const payload = {
      expectedVersion: 7,
      contactRole: "editorial",
      reason: "Verified manually.",
    };
    const viewerResponse = await app.inject({
      method: "POST",
      url: path,
      headers: signedHeaders({
        ...baseContext,
        actor: { ...baseContext.actor, roles: ["viewer"] },
      }),
      payload,
    });
    expect(viewerResponse.statusCode).toBe(403);
    expect(queryCalls).toBe(0);

    const staleResponse = await app.inject({
      method: "POST",
      url: path,
      headers: signedHeaders(),
      payload,
    });
    expect(staleResponse.statusCode).toBe(409);
    expect(queryCalls).toBe(1);
  });
});
