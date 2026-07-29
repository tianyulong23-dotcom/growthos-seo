import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import {
  createEmptySummaryQuery,
  type SummaryQuery,
} from "../../../src/modules/backlinks/application/queries/summary.query.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import { registerBacklinksSummaryRoute } from "../../../src/modules/backlinks/api/summary.route.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import { BacklinkError, backlinkErrorCodes } from "../../../src/modules/backlinks/domain/errors/backlink-error.js";
import type {
  ProjectContextPort,
  ResolvedProjectContext,
} from "../../../src/modules/backlinks/ports/project-context.port.js";

const actor = createActorContext({
  userId: "user-1", sessionId: "session-1", roles: ["member"],
});
const context: ResolvedProjectContext = {
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
const summaryUrl = "/api/v1/projects/project-key/backlinks/summary";

async function createTestApp(
  resolve: ProjectContextPort["resolve"],
  getSummary: SummaryQuery["getSummary"],
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, genReqId: () => "request-1" });
  apps.push(app);
  await registerBacklinksOpenApi(app);
  app.decorateRequest("actor");
  app.addHook("preHandler", async (request) => {
    request.actor = actor;
  });
  registerBacklinksSummaryRoute(app, {
    module: createBacklinksModule({
      projectContext: { resolve },
      queries: { getSummary },
    }),
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("registerBacklinksSummaryRoute", () => {
  it("returns an empty summary with strict project response metadata", async () => {
    const resolveRequests: Parameters<ProjectContextPort["resolve"]>[0][] = [];
    const queryContexts: ResolvedProjectContext[] = [];
    const emptyQuery = createEmptySummaryQuery();
    const app = await createTestApp(
      async (request) => {
        resolveRequests.push(request);
        return context;
      },
      async (resolved) => {
        queryContexts.push(resolved);
        return emptyQuery.getSummary(resolved);
      },
    );
    const response = await app.inject({ method: "GET", url: summaryUrl });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      summary: {},
      meta: {
        organizationId: "org-1",
        workspaceId: "workspace-1",
        websiteProjectId: "project-1",
        requestId: "request-1",
        schemaVersion: "backlinks.v1",
      },
    });
    expect(Object.keys(body)).toEqual(["summary", "meta"]);
    expect(Object.keys(body.summary)).toEqual([]);
    expect(Date.parse(body.meta.generatedAt)).not.toBeNaN();
    expect(resolveRequests).toEqual([{ actor, websiteProjectKey: "project-key" }]);
    expect(queryContexts).toEqual([context]);
    const openApi = JSON.stringify(
      app.swagger().paths?.["/api/v1/projects/{websiteProjectKey}/backlinks/summary"],
    );
    expect(openApi).toContain('"summary"');
    expect(openApi).toMatch(/"summary":\{"type":"object","properties":\{\},"additionalProperties":false\}/);
  });

  it.each([
    ["context", backlinkErrorCodes.accessDenied, 403],
    ["query", backlinkErrorCodes.notFound, 404],
  ] as const)("maps %s %s to %i", async (stage, code, status) => {
    const failure = new BacklinkError({ code, message: "Summary unavailable" });
    const app = await createTestApp(
      async () => {
        if (stage === "context") throw failure;
        return context;
      },
      async () => {
        if (stage === "query") throw failure;
        return {};
      },
    );
    const response = await app.inject({ method: "GET", url: summaryUrl });

    expect(response.statusCode).toBe(status);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ status, code });
  });
});
