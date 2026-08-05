import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerBacklinksReportOverviewRoute,
} from "../../../src/modules/backlinks/api/reports/report-overview.route.js";
import {
  registerBacklinksOpenApi,
} from "../../../src/modules/backlinks/api/openapi.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";

const actor = createActorContext({
  userId: "user-177",
  sessionId: "session-177",
  roles: ["member"],
});
const context = {
  actor,
  tenant: createTenantContext({
    organizationId: "organization-177",
    workspaceId: "workspace-177",
  }),
  project: createProjectContext({
    websiteProjectId: "project-177",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-177",
    promotionTargetVersionId: "target-177",
  }),
};
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("BL-AI-177 Report Overview API", () => {
  it("returns immutable published revisions with server-derived freshness", async () => {
    const app = Fastify({ logger: false, genReqId: () => "request-177" });
    apps.push(app);
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = actor;
    });
    registerBacklinksReportOverviewRoute(app, {
      projectContext: { resolve: async () => context },
      query: {
        listPublished: async (input) => [{
          id: "018f0000-0000-7000-8000-000000000177",
          reportKey: "weekly-performance",
          revision: 4,
          inputSnapshotIds: [
            "018f0000-0000-7000-8000-000000000161",
          ],
          metricDefinitionVersions: {
            placement_success_rate: "placement_success_rate.v1",
          },
          querySpec: { grain: "day" },
          payload: { title: "Weekly performance" },
          sourceStartedAt: new Date("2026-07-21T00:00:00.000Z"),
          sourceEndedAt: new Date("2026-07-28T00:00:00.000Z"),
          sourceWatermarkAt: new Date("2026-07-28T00:00:00.000Z"),
          sourceWatermarkId: "event-177",
          resultChecksum: "a".repeat(64),
          generatedAt: new Date("2026-07-28T00:05:00.000Z"),
          freshness:
            input.asOf.getTime() > Date.parse("2026-07-29T00:00:00.000Z")
              ? "stale"
              : "fresh",
        }],
      },
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url:
        "/api/v1/projects/project-key/backlinks/reports" +
        "?asOf=2026-07-29T01%3A00%3A00.000Z",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reports: [{
        reportKey: "weekly-performance",
        revision: 4,
        freshness: "stale",
        inputSnapshotIds: [
          "018f0000-0000-7000-8000-000000000161",
        ],
      }],
      meta: { schemaVersion: "backlink-report-overview.v1" },
    });
  });
});
