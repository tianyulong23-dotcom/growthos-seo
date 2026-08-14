import { describe, expect, it } from "vitest";

import { createRecommendationCommands } from "../../src/modules/backlinks/application/commands/recommendations.command.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

const organizationId = "018f0000-0000-7000-8000-000000000001";
const workspaceId = "018f0000-0000-7000-8000-000000000002";
const websiteProjectId = "018f0000-0000-7000-8000-000000000003";
const contextVersionId = "018f0000-0000-7000-8000-000000000004";

describe("recommendation commands", () => {
  it("rejects refill watermarks outside the fixed ten-item contract", async () => {
    let queryCount = 0;
    const commands = createRecommendationCommands({
      query: async () => {
        queryCount += 1;
        return { rows: [] };
      },
    });

    await expect(
      commands.requestRefill({
        context: {
          actor: createActorContext({
            userId: "local-product-operator",
            sessionId: "session-1",
            roles: ["member"],
          }),
          tenant: createTenantContext({ organizationId, workspaceId }),
          project: createProjectContext({
            websiteProjectId,
            canonicalDomain: "example.com",
            locale: "en-US",
            countryCode: "US",
            profileVersionId: "profile-1",
            promotionTargetVersionId: "target-1",
          }),
        },
        requestId: "invalid-target",
        expectedVersion: 0,
        recommendationContextVersionId: contextVersionId,
        visiblePoolGeneration: 1,
        lowWatermark: 10,
        highWatermark: 20,
      }),
    ).rejects.toThrow("Recommendation refill target must be exactly 10.");
    expect(queryCount).toBe(0);
  });

  it("checks provider side effects by the persisted refill window", async () => {
    let sql = "";
    const commands = createRecommendationCommands({
      query: async (text) => {
        sql = text;
        return { rows: [] };
      },
    });

    await expect(
      commands.requestRefill({
        context: {
          actor: createActorContext({
            userId: "local-product-operator",
            sessionId: "session-1",
            roles: ["member"],
          }),
          tenant: createTenantContext({ organizationId, workspaceId }),
          project: createProjectContext({
            websiteProjectId,
            canonicalDomain: "example.com",
            locale: "en-US",
            countryCode: "US",
            profileVersionId: "profile-1",
            promotionTargetVersionId: "target-1",
          }),
        },
        requestId: "request-1",
        expectedVersion: 0,
        recommendationContextVersionId: contextVersionId,
        visiblePoolGeneration: 1,
        lowWatermark: 9,
        highWatermark: 10,
      }),
    ).rejects.toThrow();

    expect(sql).toContain(
      "usage.reservation_key LIKE failed_refill.refill_window_key||':%'",
    );
    expect(sql).toContain(
      "request.request_id LIKE failed_refill.refill_window_key||':%'",
    );
    expect(sql).toContain(
      "lease.owner_request_id LIKE failed_refill.refill_window_key||':%'",
    );
    expect(sql).toContain(
      "recovery.\"rearmedCount\">0 OR prior_job.status IN ('queued','running','waiting_provider','partial_success','success')",
    );
    expect(sql).toContain(
      "failed_job.status='failed' AND failed_job.retry_count<6",
    );
    expect(sql).toContain(
      "request.status IN ('running','unknown_charge')",
    );
    expect(sql).not.toContain("request.status='failed'");
    expect(sql).not.toContain("providerCallOccurred'='false'");
    expect(sql).toContain(
      "policy.termination_reason='TIERS_EXHAUSTED'",
    );
    expect(sql).toContain(
      "attempted_refill_tiers=CASE",
    );
    expect(sql).toContain("LEFT JOIN backlink_jobs job");
    expect(sql).not.toContain("reservation_key=failed_job.id::text");
    expect(sql).not.toContain("request_id=failed_job.id::text");
  });

  it("resolves an operation recovery to its persisted commercial refill request", async () => {
    const operationId = "018f0000-0000-7000-8000-000000000005";
    const originalRefillWindowKey =
      `commercial-refill:${websiteProjectId}:${contextVersionId}:g1:t1:r1:w1`;
    const currentRefillWindowKey =
      `commercial-refill:${websiteProjectId}:${contextVersionId}:g1:t2:r1:w1`;
    let recoverySql = "";
    let refillValues: readonly unknown[] | undefined;
    const commands = createRecommendationCommands({
      query: async (text, values) => {
        if (text.includes("JOIN backlink_idempotency_records AS idempotency")) {
          recoverySql = text;
          return {
            rows: [{
              refillWindowKey: originalRefillWindowKey,
              triggerReason: "inventory_low",
              lowWatermark: 9,
              highWatermark: 10,
              visiblePoolGeneration: 1,
            }],
          };
        }
        if (text.includes("INSERT INTO backlink_commercial_inventory_policies"))
          return { rows: [] };
        refillValues = values;
        return {
          rows: [{
            state: "replay",
            requestHash: values?.[7],
            responseBody: {
              operationId,
              jobId: "018f0000-0000-7000-8000-000000000006",
              workflowId: "workflow-1",
              status: "queued",
              version: 1,
              lifecycleEventId: "018f0000-0000-7000-8000-000000000007",
              auditEventId: "018f0000-0000-7000-8000-000000000008",
            },
          }],
        };
      },
    });

    const recovered = await commands.requestRefill({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "request-recover-1",
      expectedVersion: 0,
      recommendationContextVersionId: contextVersionId,
      visiblePoolGeneration: 1,
      lowWatermark: 9,
      highWatermark: 10,
      operationId,
    });

    expect(recovered).toMatchObject({ operationId, replayed: true });
    expect(recoverySql).toContain("refill.id=$5");
    expect(recoverySql).toContain(
      "idempotency.response_body->>'operationId'=refill.id::text",
    );
    expect(recoverySql).toContain(
      "substring(",
    );
    expect(refillValues?.[6]).toBe(
      `recommendation-refill:${originalRefillWindowKey}`,
    );
    expect(refillValues?.[17]).toBe(originalRefillWindowKey);
    expect(refillValues?.[19]).toBe("inventory_low");
    expect(refillValues?.[20]).toBe(operationId);
    expect(refillValues).not.toContain(currentRefillWindowKey);
  });

  it("does not report a failed refill as queued when recovery was blocked", async () => {
    const commands = createRecommendationCommands({
      query: async (text, values) =>
        text.includes("INSERT INTO backlink_commercial_inventory_policies")
          ? { rows: [] }
          : {
              rows: [{
                state: "recovery_blocked",
                requestHash: values?.[7],
                responseBody: {
                  operationId: "018f0000-0000-7000-8000-000000000005",
                  jobId: "018f0000-0000-7000-8000-000000000006",
                  workflowId: "workflow-1",
                  status: "queued",
                  version: 1,
                  lifecycleEventId: "018f0000-0000-7000-8000-000000000007",
                  auditEventId: "018f0000-0000-7000-8000-000000000008",
                },
              }],
            },
    });

    await expect(
      commands.requestRefill({
        context: {
          actor: createActorContext({
            userId: "local-product-operator",
            sessionId: "session-1",
            roles: ["member"],
          }),
          tenant: createTenantContext({ organizationId, workspaceId }),
          project: createProjectContext({
            websiteProjectId,
            canonicalDomain: "example.com",
            locale: "en-US",
            countryCode: "US",
            profileVersionId: "profile-1",
            promotionTargetVersionId: "target-1",
          }),
        },
        requestId: "request-1",
        expectedVersion: 0,
        recommendationContextVersionId: contextVersionId,
        visiblePoolGeneration: 1,
        lowWatermark: 9,
        highWatermark: 10,
      }),
    ).rejects.toThrow(
      "ExpectedVersion does not match the current resource version.",
    );
  });

  it("archives only the active generation and leaves the next generation waiting", async () => {
    let sql = "";
    let values: readonly unknown[] | undefined;
    const commands = createRecommendationCommands({
      query: async (text, queryValues) => {
        sql = text;
        values = queryValues;
        return {
          rows: [{
            state: "completed",
            requestHash: queryValues?.[7],
            responseBody: {
              archivedGeneration: 1,
              nextGeneration: 2,
              archivedCount: 20,
              state: "awaiting_refresh",
              version: 4,
              lifecycleEventId: "018f0000-0000-7000-8000-000000000009",
              auditEventId: "018f0000-0000-7000-8000-000000000010",
            },
          }],
        };
      },
    });

    const archived = await commands.archivePool({
      context: {
        actor: createActorContext({
          userId: "local-product-operator",
          sessionId: "session-1",
          roles: ["member"],
        }),
        tenant: createTenantContext({ organizationId, workspaceId }),
        project: createProjectContext({
          websiteProjectId,
          canonicalDomain: "example.com",
          locale: "en-US",
          countryCode: "US",
          profileVersionId: "profile-1",
          promotionTargetVersionId: "target-1",
        }),
      },
      requestId: "request-archive-1",
      idempotencyKey: "archive-generation-1",
      recommendationContextVersionId: contextVersionId,
      visiblePoolGeneration: 1,
    });

    expect(archived).toMatchObject({
      archivedGeneration: 1,
      nextGeneration: 2,
      archivedCount: 20,
      state: "awaiting_refresh",
      replayed: false,
    });
    expect(values?.slice(4, 8)).toEqual([
      contextVersionId,
      1,
      "archive-generation-1",
      expect.any(String),
    ]);
    expect(sql).toContain("visible_pool_state='active'");
    expect(sql).toContain("inventory.visible_pool_generation=$6");
    expect(sql).toContain("status='archived'");
    expect(sql).toContain("visible_pool_state='awaiting_refresh'");
    expect(sql).not.toContain("recommendation_refill.requested");
  });
});
