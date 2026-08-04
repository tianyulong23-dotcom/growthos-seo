import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerBacklinksReportExportRoutes,
} from "../../../src/modules/backlinks/api/reports/report-export.route.js";
import {
  registerBacklinksOpenApi,
} from "../../../src/modules/backlinks/api/openapi.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";

const actor = createActorContext({
  userId: "user-169",
  sessionId: "session-169",
  roles: ["member"],
});
const context = {
  actor,
  tenant: createTenantContext({
    organizationId: "organization-169",
    workspaceId: "workspace-169",
  }),
  project: createProjectContext({
    websiteProjectId: "project-169",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-169",
    promotionTargetVersionId: "target-169",
  }),
};
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("BL-AI-169 Report Export API", () => {
  it("returns 202 before rendering and exposes status plus authorized download", async () => {
    const calls: string[] = [];
    const app = Fastify({ logger: false, genReqId: () => "request-169" });
    apps.push(app);
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = actor;
    });
    registerBacklinksReportExportRoutes(app, {
      projectContext: {
        resolve: async () => context,
      },
      workflow: {
        request: async (input) => {
          calls.push(`request:${input.format}`);
          return {
            id: "018f0000-0000-7000-8000-000000000169",
            ...input.scope,
            reportKey: input.reportKey,
            reportRevisionId: input.reportRevisionId,
            format: input.format,
            status: "queued",
            requestedBy: input.requestedBy,
            correlationId: input.correlationId,
            objectReference: null,
            createdAt: new Date("2026-07-29T01:00:00.000Z"),
            completedAt: null,
            expiresAt: null,
            failureCode: null,
          };
        },
        get: async () => ({
          id: "018f0000-0000-7000-8000-000000000169",
          ...context.tenant,
          websiteProjectId: context.project.websiteProjectId,
          reportKey: "weekly-performance",
          reportRevisionId:
            "018f0000-0000-7000-8000-000000000165",
          format: "csv",
          status: "completed",
          requestedBy: actor.userId,
          correlationId: "request-169",
          objectReference: {
            objectKey: "private/export.csv",
            contentType: "text/csv",
            contentLength: 10,
            sha256: "a".repeat(64),
            storagePolicyVersion: "private-export.v1",
          },
          createdAt: new Date("2026-07-29T01:00:00.000Z"),
          completedAt: new Date("2026-07-29T01:01:00.000Z"),
          expiresAt: new Date("2026-07-30T01:01:00.000Z"),
          failureCode: null,
        }),
        run: async () => {
          throw new Error("API must not render");
        },
        authorizeDownload: async () => ({
          url: "https://objects.example/signed/export.csv",
          expiresAt: new Date("2026-07-29T01:10:00.000Z"),
        }),
      },
    });
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url:
        "/api/v1/projects/project-key/backlinks/reports/weekly-performance" +
        "/revisions/018f0000-0000-7000-8000-000000000165/exports",
      payload: { format: "csv" },
    });
    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({
      export: { status: "queued", format: "csv" },
    });
    expect(calls).toEqual(["request:csv"]);

    const status = await app.inject({
      method: "GET",
      url:
        "/api/v1/projects/project-key/backlinks/report-exports/" +
        "018f0000-0000-7000-8000-000000000169",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      export: { status: "completed", expiresAt: "2026-07-30T01:01:00.000Z" },
    });

    const download = await app.inject({
      method: "GET",
      url:
        "/api/v1/projects/project-key/backlinks/report-exports/" +
        "018f0000-0000-7000-8000-000000000169/download",
    });
    expect(download.statusCode).toBe(200);
    expect(download.json()).toMatchObject({
      download: { url: "https://objects.example/signed/export.csv" },
    });
  });
});
