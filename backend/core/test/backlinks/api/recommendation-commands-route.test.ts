import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import { createRecommendationCommands } from "../../../src/modules/backlinks/application/commands/recommendations.command.js";
import { registerBacklinksRecommendationCommandsRoutes } from "../../../src/modules/backlinks/api/recommendation-commands.route.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import { createActorContext, createProjectContext, createTenantContext } from "../../../src/modules/backlinks/domain/context/index.js";
const member = createActorContext({ userId: "user-1", sessionId: "session-1", roles: ["member"] });
const baseContext = {
  actor: member, tenant: createTenantContext({ organizationId: "org-1", workspaceId: "workspace-1" }),
  project: createProjectContext({ websiteProjectId: "project-1", canonicalDomain: "example.com",
    locale: "en-US", countryCode: "US",
    profileVersionId: "profile-1", promotionTargetVersionId: "target-1" }),
};
const recommendationId = "018f0000-0000-7000-8000-000000000001";
const contextId = "018f0000-0000-7000-8000-000000000002";
describe("BL-AI-063 recommendation command APIs", () => {
  it("enforces idempotency, expected versions, permissions, and audit responses", async () => {
    let rejectCalls = 0;
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const commands = createRecommendationCommands({ query: async (text, values) => {
      calls.push({ text, values });
      const requestHash = values?.[7];
      if (text.includes("recommendation.rejected")) {
        if (values?.[5] === 7) {
          return { rows: [{ state: "version_conflict", requestHash }] };
        }
        rejectCalls += 1;
        return { rows: [{ state: rejectCalls === 1 ? "completed" : "replay", requestHash,
          responseBody: { recommendationId, status: "rejected",
            version: 3, lifecycleEventId: "life-reject", auditEventId: "audit-reject" } }] };
      }
      return { rows: [{ state: "completed", requestHash, responseBody: {
        jobId: "job-1", workflowId: "refill:job-1", status: "queued", version: 1,
        lifecycleEventId: "life-refill", auditEventId: "audit-refill" } }] };
    } });
    const app = Fastify({ logger: false, genReqId: () => "request-63" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => { request.actor =
      request.headers["x-role"] === "viewer" ? createActorContext({
        userId: "viewer-1", sessionId: "session-2", roles: ["viewer"] }) : member; });
    registerBacklinksRecommendationCommandsRoutes(app, {
      module: createBacklinksModule({ projectContext: {
        resolve: async ({ actor }) => ({ ...baseContext, actor }),
      }, queries: {} }),
      commands,
    });
    await app.ready();
    afterAll(() => app.close());
    const rejectPath = `/api/v1/projects/project-key/backlinks/recommendations/${recommendationId}/reject`;
    const post = (url: string, key: string, payload: object, role?: string) => app.inject({
      method: "POST", url, headers: { "idempotency-key": key,
        ...(role === undefined ? {} : { "x-role": role }) }, payload,
    });
    const rejectPayload = { expectedVersion: 2, rejectionType: "permanently_rejected" as const,
      reasonCode: "not_relevant" };
    const reject = () => post(rejectPath, "reject-63", rejectPayload);
    expect((await reject()).json()).toMatchObject({
      recommendationId, status: "rejected", version: 3, replayed: false,
      lifecycleEventId: "life-reject", auditEventId: "audit-reject",
    });
    expect((await reject()).json()).toMatchObject({ replayed: true, version: 3 });
    expect(calls[0]?.values?.slice(0, 8)).toEqual(["org-1", "workspace-1", "project-1",
      "user-1", recommendationId, 2, "reject-63", expect.any(String)]);
    expect(calls[0]?.text).toContain("backlink_audit_events");

    const stale = await post(rejectPath, "reject-stale", { expectedVersion: 7,
      rejectionType: "permanently_rejected", reasonCode: "not_relevant" });
    expect(stale.statusCode).toBe(409);
    const denied = await post(rejectPath, "reject-denied", rejectPayload, "viewer");
    expect(denied.statusCode).toBe(403);
    const refill = await post("/api/v1/projects/project-key/backlinks/recommendation-refill-jobs",
      "refill-63", { expectedVersion: 0, recommendationContextVersionId: contextId,
        lowWatermark: 5, highWatermark: 20, refillWindowKey: "manual-2026-07-23" });
    expect(refill.statusCode).toBe(202);
    expect(refill.json()).toMatchObject({ jobId: "job-1", workflowId: "refill:job-1", status: "queued",
      version: 1, replayed: false, lifecycleEventId: "life-refill",
      auditEventId: "audit-refill" });
    expect(calls.at(-1)?.text).toContain("backlink_recommendation_refills");
    expect(calls.at(-1)?.text).toContain("backlink_outbox_events");
    expect(calls.at(-1)?.text).toContain(
      "backlinks.recommendation-refill.requested.v1",
    );
    expect(calls.at(-1)?.text).toContain(
      "'contractVersion','backlinks.recommendation-refill.requested.v1'",
    );
  });
});
