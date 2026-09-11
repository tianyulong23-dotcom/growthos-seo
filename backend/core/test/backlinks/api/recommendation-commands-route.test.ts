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
const operationId = "018f0000-0000-7000-8000-000000000003";
const refillOutboxEventId = "018f0000-0000-7000-8000-000000000004";
describe("BL-AI-063 recommendation command APIs", () => {
  it("enforces idempotency, expected versions, permissions, and audit responses", async () => {
    let rejectCalls = 0;
    let refillCreates = 0;
    const refillRequestHashes = new Set<unknown>();
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const commands = createRecommendationCommands({
      query: async (text, values) => {
        calls.push({ text, values });
        const requestHash = values?.[7];
        if (text.includes("SELECT\n           pg_advisory_xact_lock")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO backlink_commercial_inventory_policies")) {
          return { rows: [] };
        }
        if (text.includes("recommendation.rejected")) {
          if (values?.[5] === 7) {
            return { rows: [{ state: "version_conflict", requestHash }] };
          }
          rejectCalls += 1;
          return { rows: [{ state: rejectCalls === 1 ? "completed" : "replay", requestHash,
            responseBody: { recommendationId, status: "rejected",
              version: 3, lifecycleEventId: "life-reject", auditEventId: "audit-reject" } }] };
        }
        const state = refillRequestHashes.has(requestHash) ? "replay" : "completed";
        if (state === "completed") {
          refillRequestHashes.add(requestHash);
          refillCreates += 1;
        }
        return { rows: [{ state, requestHash, responseBody: {
          operationId, jobId: "job-1", workflowId: "refill:job-1",
          outboxEventId: refillOutboxEventId,
          status: "queued", version: 1, visiblePoolGeneration: 1,
          lifecycleEventId: "life-refill", auditEventId: "audit-refill" } }] };
      },
    }, {
      persistentProviderBudgetGrant: {
        provider: "dataforseo",
        reasonCode: "user_authorized_persistent_discovery",
        maxPaidCalls: 3,
        maxCostMicros: 1_000_000,
      },
    });
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
    const refillPath =
      "/api/v1/projects/project-key/backlinks/recommendation-refill-jobs";
    const refillPayload = { expectedVersion: 0,
      recommendationContextVersionId: contextId,
      visiblePoolGeneration: 1 };
    const refillResponses = await Promise.all(Array.from(
      { length: 5 },
      () => post(refillPath, "refill-logical-63", refillPayload),
    ));
    expect(refillResponses.map(({ statusCode }) => statusCode)).toEqual(
      [202, 202, 202, 202, 202],
    );
    for (const refill of refillResponses) {
      expect(refill.json()).toMatchObject({
        operationId,
        jobId: "job-1",
        workflowId: "refill:job-1",
        outboxEventId: refillOutboxEventId,
        status: "queued",
        version: 1,
        visiblePoolGeneration: 1,
        lifecycleEventId: "life-refill",
        auditEventId: "audit-refill",
      });
    }
    expect(refillCreates).toBe(1);
    expect(refillResponses.filter(
      (response) => response.json().replayed === false,
    )).toHaveLength(1);
    expect(calls.at(-1)?.text).toContain("backlink_recommendation_refills");
    expect(calls.at(-1)?.text).toContain("backlink_outbox_events");
    expect(calls.at(-1)?.text).toContain(
      "backlinks.recommendation-refill.requested.v1",
    );
    expect(calls.at(-1)?.text).toContain(
      "'contractVersion','backlinks.recommendation-refill.requested.v1'",
    );
    expect(calls.at(-1)?.text).toContain(
      "active_job.status IN ('queued','running','waiting_provider')",
    );
    expect(calls.at(-1)?.text).toContain(
      "backlink_commercial_discovery_batches active_discovery",
    );
    expect(calls.at(-1)?.text).not.toContain(
      "backlink_contact_enrichment_batches active_contact",
    );
    expect(calls.at(-1)?.values?.[6]).toBe(
      `recommendation-refill:manual:${contextId}:g1:request:refill-logical-63`,
    );
    expect(calls.at(-1)?.values?.[17]).toBe(
      `manual:${contextId}:g1:request:refill-logical-63`,
    );
    expect(calls.at(-1)?.values?.[20]).toBeNull();
    expect(calls.at(-1)?.values?.[21]).toBe(1);
    expect(calls.at(-1)?.values?.[22]).toEqual(JSON.stringify({
      provider: "dataforseo",
      reasonCode: "user_authorized_persistent_discovery",
      maxPaidCalls: 3,
      maxCostMicros: 1_000_000,
      authorizedBy: "user-1",
    }));
    expect(calls.at(-1)?.text).toContain(
      "'providerOperationId',CASE WHEN $23::jsonb IS NULL THEN NULL ELSE "
        + "'commercial-refill-operation:'||$10::uuid::text END",
    );
    expect(calls.at(-1)?.text).toContain(
      "'providerBudgetAuthorization',$23::jsonb",
    );
    expect(calls.at(-1)?.text).toContain(
      `(prior."responseBody"->>'operationId')::uuid=$21::uuid`,
    );
    expect(calls.at(-1)?.text).toContain(
      "policy.termination_reason='TIERS_EXHAUSTED'",
    );
    expect(calls.at(-1)?.text).toContain(
      "attempted_refill_tiers=CASE",
    );

    const reassessment = await post(
      refillPath,
      "refill-existing-evidence-63",
      {
        ...refillPayload,
        supplyMode: "existing_evidence",
      },
    );
    expect(reassessment.statusCode).toBe(202);
    expect(calls.at(-1)?.values?.[20]).toBeNull();
    expect(calls.at(-1)?.values?.[22]).toBeNull();
    expect(calls.at(-1)?.values?.[23]).toBe("existing_evidence");
    expect(calls.at(-1)?.text).toContain("'supplyMode',$24::text");
    expect(refillCreates).toBe(2);

    const missingIdempotencyKey = await app.inject({
      method: "POST",
      url: refillPath,
      payload: refillPayload,
    });
    expect(missingIdempotencyKey.statusCode).toBe(400);

    const terminalRetry = await post(
      refillPath,
      "refill-logical-64",
      refillPayload,
    );
    expect(terminalRetry.statusCode).toBe(202);
    expect(terminalRetry.json()).toMatchObject({ replayed: false });
    expect(refillCreates).toBe(3);
    expect(calls.at(-1)?.values?.[17]).toBe(
      `manual:${contextId}:g1:request:refill-logical-64`,
    );

    const invalidTarget = await app.inject({
      method: "POST",
      url: refillPath,
      headers: { "idempotency-key": "refill-invalid-target" },
      payload: {
        ...refillPayload,
        lowWatermark: 10,
        highWatermark: 20,
      },
    });
    expect(invalidTarget.statusCode).toBe(400);
  }, 15_000);

  it("archives a complete pool without starting the next generation", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const commands = createRecommendationCommands({
      query: async (text, values) => {
        calls.push({ text, values });
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              archivedGeneration: 1,
              nextGeneration: 2,
              archivedCount: 20,
              preparedCandidateCount: 8,
              state: "awaiting_refresh",
              version: 2,
              lifecycleEventId: "life-archive",
              auditEventId: "audit-archive",
            },
          }],
        };
      },
    });
    const app = Fastify({ logger: false, genReqId: () => "request-archive" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = member;
    });
    registerBacklinksRecommendationCommandsRoutes(app, {
      module: createBacklinksModule({
        projectContext: {
          resolve: async () => baseContext,
        },
        queries: {},
      }),
      commands,
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-key/backlinks/recommendation-pools/1/archive",
      headers: { "idempotency-key": "archive-pool-1" },
      payload: { recommendationContextVersionId: contextId },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      archivedGeneration: 1,
      nextGeneration: 2,
      archivedCount: 20,
      preparedCandidateCount: 8,
      state: "awaiting_refresh",
      replayed: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values?.slice(4, 8)).toEqual([
      contextId,
      1,
      "archive-pool-1",
      expect.any(String),
    ]);
    expect(calls[0]?.text).toContain("visible_pool_state='awaiting_refresh'");
    expect(calls[0]?.text).not.toContain(
      "INSERT INTO backlink_outbox_events",
    );
  });

  it("exposes a strict audited cancellation for an undispatched bootstrap refill", async () => {
    const jobId = "018f0000-0000-7000-8000-000000000011";
    const refillId = "018f0000-0000-7000-8000-000000000012";
    const outboxEventId = "018f0000-0000-7000-8000-000000000013";
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const commands = createRecommendationCommands({
      query: async (text, values) => {
        calls.push({ text, values });
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[8],
            responseBody: {
              jobId,
              refillId,
              outboxEventId,
              recommendationContextVersionId: contextId,
              visiblePoolGeneration: 1,
              status: "cancelled",
              outboxStatus: "published",
              dispatchDisposition: "cancelled_before_dispatch",
              policyState: "idle",
              reasonCode: "read_side_effect_cleanup",
              version: 2,
              lifecycleEventId:
                "018f0000-0000-7000-8000-000000000014",
              auditEventId:
                "018f0000-0000-7000-8000-000000000015",
            },
          }],
        };
      },
    });
    const app = Fastify({ logger: false, genReqId: () => "request-cancel" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = member;
    });
    registerBacklinksRecommendationCommandsRoutes(app, {
      module: createBacklinksModule({
        projectContext: {
          resolve: async () => baseContext,
        },
        queries: {},
      }),
      commands,
    });
    await app.ready();

    const path =
      `/api/v1/projects/project-key/backlinks/` +
      `recommendation-refill-jobs/${jobId}/cancel`;
    const response = await app.inject({
      method: "POST",
      url: path,
      headers: { "idempotency-key": "cancel-read-side-effect-1" },
      payload: {
        expectedVersion: 1,
        reasonCode: "read_side_effect_cleanup",
      },
    });
    const missingIdempotency = await app.inject({
      method: "POST",
      url: path,
      payload: {
        expectedVersion: 1,
        reasonCode: "read_side_effect_cleanup",
      },
    });
    const invalidReason = await app.inject({
      method: "POST",
      url: path,
      headers: { "idempotency-key": "cancel-invalid-reason" },
      payload: {
        expectedVersion: 1,
        reasonCode: "manual",
      },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jobId,
      refillId,
      outboxEventId,
      recommendationContextVersionId: contextId,
      visiblePoolGeneration: 1,
      status: "cancelled",
      outboxStatus: "published",
      dispatchDisposition: "cancelled_before_dispatch",
      policyState: "idle",
      reasonCode: "read_side_effect_cleanup",
      version: 2,
      replayed: false,
    });
    expect(missingIdempotency.statusCode).toBe(400);
    expect(invalidReason.statusCode).toBe(400);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values?.slice(4, 9)).toEqual([
      jobId,
      1,
      "read_side_effect_cleanup",
      "cancel-read-side-effect-1",
      expect.any(String),
    ]);
  });
});
