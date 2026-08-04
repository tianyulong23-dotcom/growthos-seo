import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type {
  MetricDashboardQuery,
} from "../../../src/modules/backlinks/application/queries/metric-dashboard.query.js";
import {
  registerBacklinksMetricDashboardRoute,
} from "../../../src/modules/backlinks/api/metrics/metric-dashboard.route.js";
import {
  registerBacklinksOpenApi,
} from "../../../src/modules/backlinks/api/openapi.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../../src/modules/backlinks/domain/errors/backlink-error.js";

const actor = createActorContext({
  userId: "user-1",
  sessionId: "session-1",
  roles: ["member"],
});
const context = {
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
    profileVersionId: "profile-1",
    promotionTargetVersionId: "target-1",
  }),
};
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp(query: MetricDashboardQuery) {
  const app = Fastify({ logger: false, genReqId: () => "request-1" });
  apps.push(app);
  await registerBacklinksOpenApi(app);
  app.decorateRequest("actor");
  app.addHook("preHandler", async (request) => {
    request.actor = actor;
  });
  registerBacklinksMetricDashboardRoute(app, {
    projectContext: {
      resolve: async ({ websiteProjectKey }) => {
        if (websiteProjectKey === "foreign") {
          throw new BacklinkError({
            code: backlinkErrorCodes.accessDenied,
            message: "Project denied.",
          });
        }
        return context;
      },
    },
    query,
  });
  await app.ready();
  return app;
}

describe("BL-AI-164 Dashboard Summary/Trend API", () => {
  it("passes the project scope, time window, as-of, and IANA timezone", async () => {
    const calls: Parameters<MetricDashboardQuery["getDashboard"]>[0][] = [];
    const app = await createApp({
      getDashboard: async (input) => {
        calls.push(input);
        return {
          timezone: input.timezone,
          from: input.from,
          to: input.to,
          asOf: input.asOf,
          summary: [{
            snapshotId: "snapshot-1",
            snapshotVersion: 2,
            metricKey: "send_count",
            metricDefinitionVersion: "send_count.v1",
            windowStart: input.from,
            windowEnd: input.to,
            asOf: input.asOf,
            dimensions: {},
            numerator: 3,
            denominator: null,
            value: 3,
          }],
          trends: [{
            metricKey: "send_count",
            metricDefinitionVersion: "send_count.v1",
            points: [{
              snapshotId: "snapshot-1",
              snapshotVersion: 2,
              windowStart: input.from,
              windowEnd: input.to,
              asOf: input.asOf,
              dimensions: {},
              numerator: 3,
              denominator: null,
              value: 3,
            }],
          }],
        };
      },
    });
    const response = await app.inject({
      method: "GET",
      url:
        "/api/v1/projects/project-key/backlinks/metrics/dashboard" +
        "?from=2026-07-28T00%3A00%3A00.000Z" +
        "&to=2026-07-29T00%3A00%3A00.000Z" +
        "&asOf=2026-07-29T01%3A00%3A00.000Z" +
        "&timezone=Asia%2FShanghai",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dashboard: {
        timezone: "Asia/Shanghai",
        summary: [{
          metricKey: "send_count",
          metricDefinitionVersion: "send_count.v1",
          value: 3,
        }],
        trends: [{
          metricKey: "send_count",
          points: [{ value: 3 }],
        }],
      },
      meta: {
        organizationId: "org-1",
        workspaceId: "workspace-1",
        websiteProjectId: "project-1",
        requestId: "request-1",
        schemaVersion: "backlink-metric-dashboard.v1",
      },
    });
    expect(calls).toEqual([{
      scope: {
        organizationId: "org-1",
        workspaceId: "workspace-1",
        websiteProjectId: "project-1",
      },
      from: new Date("2026-07-28T00:00:00.000Z"),
      to: new Date("2026-07-29T00:00:00.000Z"),
      asOf: new Date("2026-07-29T01:00:00.000Z"),
      timezone: "Asia/Shanghai",
    }]);
  });

  it("returns a stable empty dashboard and rejects foreign projects", async () => {
    const query: MetricDashboardQuery = {
      getDashboard: async (input) => ({
        timezone: input.timezone,
        from: input.from,
        to: input.to,
        asOf: input.asOf,
        summary: [],
        trends: [],
      }),
    };
    const app = await createApp(query);
    const suffix =
      "?from=2026-07-28T00%3A00%3A00.000Z" +
      "&to=2026-07-29T00%3A00%3A00.000Z" +
      "&asOf=2026-07-29T01%3A00%3A00.000Z" +
      "&timezone=UTC";
    const empty = await app.inject({
      method: "GET",
      url:
        "/api/v1/projects/project-key/backlinks/metrics/dashboard" + suffix,
    });
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/projects/foreign/backlinks/metrics/dashboard" + suffix,
    });

    expect(empty.statusCode).toBe(200);
    expect(empty.json().dashboard).toMatchObject({
      timezone: "UTC",
      summary: [],
      trends: [],
    });
    expect(denied.statusCode).toBe(403);
  });

  it("rejects invalid time windows and browser-style timezone guesses", async () => {
    const app = await createApp({
      getDashboard: async () => {
        throw new Error("query must not run");
      },
    });
    const invalid = await app.inject({
      method: "GET",
      url:
        "/api/v1/projects/project-key/backlinks/metrics/dashboard" +
        "?from=2026-07-29T00%3A00%3A00.000Z" +
        "&to=2026-07-28T00%3A00%3A00.000Z" +
        "&asOf=2026-07-29T01%3A00%3A00.000Z" +
        "&timezone=GMT%2B8",
    });

    expect(invalid.statusCode).toBe(400);
  });
});
