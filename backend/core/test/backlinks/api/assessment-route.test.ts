import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import { createAssessmentQuery } from "../../../src/modules/backlinks/application/queries/assessment.query.js";
import { registerBacklinksAssessmentRoute } from "../../../src/modules/backlinks/api/assessment.route.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import { createActorContext, createProjectContext,
  createTenantContext } from "../../../src/modules/backlinks/domain/context/index.js";
import { BacklinkError, backlinkErrorCodes } from "../../../src/modules/backlinks/domain/errors/backlink-error.js";

const runningId = "018f0000-0000-7000-8000-000000000084";
const failedId = "018f0000-0000-7000-8000-000000000085";
const actor = createActorContext({
  userId: "user-84", sessionId: "session-84", roles: ["member"],
});
const context = { actor,
  tenant: createTenantContext({ organizationId: "org-84", workspaceId: "workspace-84" }),
  project: createProjectContext({ websiteProjectId: "project-84",
    canonicalDomain: "owner.example", locale: "en-US", countryCode: "US",
    profileVersionId: "profile-84", promotionTargetVersionId: "target-84" }) };

describe("BL-AI-084 Assessment status/result API", () => {
  it("never exposes an incomplete run as a successful result and enforces project scope", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const query = createAssessmentQuery({ query: async (text, values) => {
      calls.push({ text, values });
      if (values?.[3] === runningId) return { rows: [{
        runId: "018f0000-0000-7000-8000-000000000184",
        opportunityId: runningId, status: "RUNNING", attemptCount: 1,
        sourceReleaseIds: ["dataforseo-2026-07-25"], startedAt: new Date("2026-07-27T01:00:00Z"),
        finishedAt: null, errorCode: null, snapshotId: null,
      }] };
      if (values?.[3] === failedId) return { rows: [{
        runId: "018f0000-0000-7000-8000-000000000185",
        opportunityId: failedId, status: "FAILED", attemptCount: 2,
        sourceReleaseIds: ["dataforseo-2026-07-26"], startedAt: new Date("2026-07-27T02:00:00Z"),
        finishedAt: new Date("2026-07-27T02:01:00Z"), errorCode: "CRAWLER_UNAVAILABLE",
        snapshotId: "018f0000-0000-7000-8000-000000000284", snapshotVersion: 3,
        snapshotAvailability: "partial", snapshotStale: true,
        snapshotSourceReleaseIds: ["dataforseo-2026-07-25", "crawler-2026-07-26"],
        snapshotGeneratedAt: new Date("2026-07-26T12:00:00Z"),
        resultPayload: { status: "insufficient_data", totalScore: null },
      }] };
      return { rows: [] };
    } });
    const app = Fastify({ logger: false, genReqId: () => "request-84" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => { request.actor = actor; });
    registerBacklinksAssessmentRoute(app, { module: createBacklinksModule({
      projectContext: { resolve: async ({ websiteProjectKey }) => {
        if (websiteProjectKey === "foreign") throw new BacklinkError({
          code: backlinkErrorCodes.accessDenied, message: "Project denied",
        });
        return context;
      } }, queries: query,
    }) });
    await app.ready();
    afterAll(() => app.close());

    const base = "/api/v1/projects/project-key/backlinks/assessments";
    const running = await app.inject({ method: "GET", url: `${base}/${runningId}` });
    expect(running.statusCode).toBe(200);
    expect(running.json()).toMatchObject({
      assessment: { run: { status: "RUNNING" }, result: null },
      meta: { websiteProjectId: "project-84" },
    });
    const failed = await app.inject({ method: "GET", url: `${base}/${failedId}` });
    expect(failed.json()).toMatchObject({ assessment: {
      run: { status: "FAILED", errorCode: "CRAWLER_UNAVAILABLE" },
      result: { isCurrent: false, availability: "partial", stale: true,
        sourceReleaseIds: ["dataforseo-2026-07-25", "crawler-2026-07-26"],
        payload: { status: "insufficient_data", totalScore: null } },
    } });
    expect(calls[0]?.values).toEqual(["org-84", "workspace-84", "project-84", runningId]);
    expect(calls[0]?.text).toContain("r.last_successful_snapshot_id");
    const denied = await app.inject({ method: "GET",
      url: `/api/v1/projects/foreign/backlinks/assessments/${runningId}` });
    expect(denied.statusCode).toBe(403);
    expect(calls).toHaveLength(2);
  });
});
