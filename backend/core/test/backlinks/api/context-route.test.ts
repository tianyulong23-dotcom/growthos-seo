import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import { registerBacklinksContextRoute } from "../../../src/modules/backlinks/api/context.route.js";
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
  ProjectContextPort,
  ResolvedProjectContext,
} from "../../../src/modules/backlinks/ports/project-context.port.js";

const actor = createActorContext({
  userId: "user-1",
  sessionId: "session-1",
  roles: ["member"],
});
const resolvedContext: ResolvedProjectContext = {
  actor,
  tenant: createTenantContext({
    organizationId: "org-1",
    workspaceId: "workspace-1",
  }),
  project: createProjectContext({
    websiteProjectId: "project-1",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-version-1",
    promotionTargetVersionId: "target-version-1",
  }),
};
const apps: FastifyInstance[] = [];
const contextUrl = "/api/v1/projects/project-key/backlinks/context";

async function createTestApp(
  resolve: ProjectContextPort["resolve"],
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);

  await registerBacklinksOpenApi(app);
  app.decorateRequest("actor");
  app.addHook("preHandler", async (request) => {
    request.actor = actor;
  });
  registerBacklinksContextRoute(app, {
    module: createBacklinksModule({
      projectContext: { resolve },
      queries: {},
    }),
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("registerBacklinksContextRoute", () => {
  it("resolves and returns a strict read-only project context", async () => {
    const requests: Parameters<ProjectContextPort["resolve"]>[0][] = [];
    const projectBefore = JSON.stringify(resolvedContext.project);
    const app = await createTestApp(async (request) => {
      requests.push(request);
      return resolvedContext;
    });
    const response = await app.inject({
      method: "GET",
      url: contextUrl,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(resolvedContext);
    expect(requests).toEqual([{ actor, websiteProjectKey: "project-key" }]);
    expect(JSON.stringify(resolvedContext.project)).toBe(projectBefore);
    expect(app.swagger()).toMatchObject({
      paths: {
        "/api/v1/projects/{websiteProjectKey}/backlinks/context": {
          get: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      additionalProperties: false,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it("returns 400 without resolving an invalid project key", async () => {
    let calls = 0;
    const app = await createTestApp(async () => {
      calls += 1;
      return resolvedContext;
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/%20/backlinks/context",
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      status: 400,
      code: backlinkErrorCodes.invalidRequest,
    });
    expect(calls).toBe(0);
  });

  it.each([
    [backlinkErrorCodes.accessDenied, 403],
    [backlinkErrorCodes.notFound, 404],
  ] as const)("maps %s from the context port to %i", async (code, status) => {
    const app = await createTestApp(async () => {
      throw new BacklinkError({ code, message: "Context unavailable" });
    });
    const response = await app.inject({
      method: "GET",
      url: contextUrl,
    });
    expect(response.statusCode).toBe(status);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ status, code });
  });
});
