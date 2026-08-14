import { describe, expect, it } from "vitest";

import {
  buildCommercialRefillWindowKey,
  planCommercialSupplyOperation,
  recordCommercialRefillAttemptOutcome,
  type CommercialRefillAttempt,
  type CommercialSupplyProviderState,
} from "../../src/modules/backlinks/domain/recommendations/commercial-refill-cycle.js";
import {
  planCommercialSupplyOperationStep,
  resolveCommercialSupplyProviderState,
} from "../../src/modules/backlinks/application/services/commercial-supply-operation.service.js";

describe("commercial supply operation fixtures", () => {
  it("keeps three unrelated project funnels and call identities isolated", () => {
    const fixtures = [
      {
        websiteProjectId: "project-solar-crm",
        projectContextVersionId: "context-solar-crm",
        initial: { raw: 3, fit: 1, contact: 1, published: 1 },
        windows: [
          { raw: 12, fit: 7, contact: 5, published: 4 },
          { raw: 10, fit: 6, contact: 5, published: 5 },
        ],
        expected: { raw: 25, fit: 14, contact: 11, published: 10 },
      },
      {
        websiteProjectId: "project-pet-nutrition",
        projectContextVersionId: "context-pet-nutrition",
        initial: { raw: 5, fit: 2, contact: 2, published: 2 },
        windows: [
          { raw: 15, fit: 8, contact: 5, published: 3 },
          { raw: 14, fit: 8, contact: 6, published: 5 },
        ],
        expected: { raw: 34, fit: 18, contact: 13, published: 10 },
      },
      {
        websiteProjectId: "project-accounting-saas",
        projectContextVersionId: "context-accounting-saas",
        initial: { raw: 0, fit: 0, contact: 0, published: 0 },
        windows: [
          { raw: 20, fit: 8, contact: 5, published: 4 },
          { raw: 18, fit: 9, contact: 7, published: 6 },
        ],
        expected: { raw: 38, fit: 17, contact: 12, published: 10 },
      },
    ] as const;
    const allCallKeys = new Set<string>();

    for (const fixture of fixtures) {
      let attempts: readonly CommercialRefillAttempt[] = [];
      let rawCandidateCount = fixture.initial.raw;
      let fitCandidateCount = fixture.initial.fit;
      let contactReadyCount = fixture.initial.contact;
      let publishedCount = fixture.initial.published;
      const projectCallKeys: string[] = [];
      const plan = () =>
        planCommercialSupplyOperation({
          projectContextReady: true,
          targetPublishedCount: 10,
          publishedCount,
          rawCandidateCount,
          fitCandidateCount,
          readyFitCandidateCount: 0,
          contactReadyCount,
          contactWorkPending: false,
          providerState: "available",
          paidCursor: {
            tier: "exact_product_target_market",
            round: 1,
          },
          resourceCursor: {
            tier: "curated_resource_library",
            round: 1,
          },
          attempts,
          candidateLimit: 200,
        });

      for (const outcome of fixture.windows) {
        const step = plan();
        expect(step.kind).toBe("execute");
        if (step.kind !== "execute") throw new Error("expected execute step");
        const callKey = buildCommercialRefillWindowKey({
          websiteProjectId: fixture.websiteProjectId,
          projectContextVersionId: fixture.projectContextVersionId,
          visiblePoolGeneration: 1,
          tier: step.cursor.tier,
          round: step.cursor.round,
          window: step.cursor.window,
        });
        expect(callKey).toContain(fixture.websiteProjectId);
        expect(allCallKeys.has(callKey)).toBe(false);
        allCallKeys.add(callKey);
        projectCallKeys.push(callKey);
        attempts = recordCommercialRefillAttemptOutcome(attempts, {
          tier: step.cursor.tier,
          round: step.cursor.round,
          window: step.cursor.window,
          rawCandidateCount: outcome.raw,
          eligibleCandidateCount: outcome.fit,
          contactReadyCount: outcome.contact,
          publishedCount: outcome.published,
        });
        rawCandidateCount += outcome.raw;
        fitCandidateCount += outcome.fit;
        contactReadyCount += outcome.contact;
        publishedCount += outcome.published;
      }

      expect(plan()).toEqual({
        kind: "complete",
        outcome: "TARGET_REACHED",
      });
      expect({
        raw: rawCandidateCount,
        fit: fitCandidateCount,
        contact: contactReadyCount,
        published: publishedCount,
      }).toEqual(fixture.expected);
      expect(new Set(projectCallKeys).size).toBe(fixture.windows.length);
    }

    expect(allCallKeys.size).toBe(6);
  });

  it("continues one operation from one published site to ten", () => {
    let attempts: readonly CommercialRefillAttempt[] = [];
    let rawCandidateCount = 4;
    let fitCandidateCount = 1;
    let contactReadyCount = 1;
    let publishedCount = 1;
    const calls: string[] = [];
    const requestedCounts: number[] = [];
    const plan = () =>
      planCommercialSupplyOperation({
        projectContextReady: true,
        targetPublishedCount: 10,
        publishedCount,
        rawCandidateCount,
        fitCandidateCount,
        readyFitCandidateCount: 0,
        contactReadyCount,
        contactWorkPending: false,
        providerState: "available",
        paidCursor: {
          tier: "exact_product_target_market",
          round: 3,
        },
        resourceCursor: {
          tier: "curated_resource_library",
          round: 7,
        },
        attempts,
        candidateLimit: 200,
      });
    const execute = (
      outcome: Readonly<{
        raw: number;
        fit: number;
        contact: number;
        published: number;
      }>,
    ) => {
      const step = plan();
      expect(step.kind).toBe("execute");
      if (step.kind !== "execute") throw new Error("expected execute step");
      calls.push(
        buildCommercialRefillWindowKey({
          websiteProjectId: "sunlead-project",
          projectContextVersionId: "sunlead-context",
          visiblePoolGeneration: 1,
          tier: step.cursor.tier,
          round: step.cursor.round,
          window: step.cursor.window,
        }),
      );
      requestedCounts.push(step.requestedCandidateCount);
      attempts = recordCommercialRefillAttemptOutcome(attempts, {
        tier: step.cursor.tier,
        round: step.cursor.round,
        window: step.cursor.window,
        rawCandidateCount: outcome.raw,
        eligibleCandidateCount: outcome.fit,
        contactReadyCount: outcome.contact,
        publishedCount: outcome.published,
      });
      rawCandidateCount += outcome.raw;
      fitCandidateCount += outcome.fit;
      contactReadyCount += outcome.contact;
      publishedCount += outcome.published;
      return step;
    };

    expect(plan()).toEqual(plan());
    execute({ raw: 10, fit: 0, contact: 0, published: 0 });
    execute({ raw: 10, fit: 0, contact: 0, published: 0 });
    expect(plan()).toMatchObject({
      kind: "execute",
      source: "paid",
      cursor: {
        tier: "same_topic_target_market",
        round: 3,
        window: 1,
      },
    });
    execute({ raw: 30, fit: 12, contact: 7, published: 4 });
    const retryPlan = plan();
    expect(retryPlan).toEqual(plan());
    execute({ raw: 24, fit: 10, contact: 6, published: 3 });
    execute({ raw: 20, fit: 8, contact: 5, published: 2 });

    expect(plan()).toEqual({
      kind: "complete",
      outcome: "TARGET_REACHED",
    });
    expect(publishedCount).toBe(10);
    expect(calls).toHaveLength(5);
    expect(new Set(calls).size).toBe(5);
    expect(requestedCounts.at(-1) ?? 0).toBeLessThan(requestedCounts[0] ?? 0);
    expect(calls.every((key) => key.includes(":r3:"))).toBe(true);
  });

  it("uses the independent resource cursor during a paid pause and resumes paid", () => {
    let attempts: readonly CommercialRefillAttempt[] = [];
    let providerState: CommercialSupplyProviderState = "budget_paused";
    const plan = () =>
      planCommercialSupplyOperation({
        projectContextReady: true,
        targetPublishedCount: 10,
        publishedCount: 4,
        rawCandidateCount: 20,
        fitCandidateCount: 8,
        readyFitCandidateCount: 0,
        contactReadyCount: 5,
        contactWorkPending: false,
        providerState,
        paidCursor: {
          tier: "resource_media_review_partner_ecosystem",
          round: 5,
        },
        resourceCursor: {
          tier: "curated_resource_library",
          round: 9,
        },
        attempts,
        candidateLimit: 100,
      });

    const resource = plan();
    expect(resource).toMatchObject({
      kind: "execute",
      source: "resource",
      cursor: {
        tier: "curated_resource_library",
        round: 9,
        window: 1,
      },
    });
    expect(resource).toEqual(plan());
    if (resource.kind !== "execute") throw new Error("expected resource step");
    attempts = recordCommercialRefillAttemptOutcome(attempts, {
      tier: resource.cursor.tier,
      round: resource.cursor.round,
      window: resource.cursor.window,
      rawCandidateCount: 12,
      eligibleCandidateCount: 4,
      contactReadyCount: 3,
      publishedCount: 2,
    });

    providerState = "available";
    expect(plan()).toMatchObject({
      kind: "execute",
      source: "paid",
      cursor: {
        tier: "resource_media_review_partner_ecosystem",
        round: 5,
        window: 1,
      },
    });
  });

  it.each([
    {
      name: "retries a temporarily unavailable paid window after cooldown",
      pauseReason: "DATAFORSEO_DISCOVERY_UNAVAILABLE",
      expectedWindow: 2,
    },
    {
      name: "advances after a reconciled paid window has no result",
      pauseReason: "DATAFORSEO_RECONCILED_NO_RESULT",
      expectedWindow: 3,
    },
  ])("$name", async ({ pauseReason, expectedWindow }) => {
    const refillWindowKey = buildCommercialRefillWindowKey({
      websiteProjectId: "project-solar",
      projectContextVersionId: "context-solar",
      visiblePoolGeneration: 1,
      tier: "same_topic_target_market",
      round: 4,
      window: 2,
    });
    const responses = [
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            projectContextReady: true,
            currentRefillTier: "same_topic_target_market",
            currentRefillRound: 4,
            paidRefillTier: "same_topic_target_market",
            paidRefillRound: 4,
            resourceRefillTier: "curated_resource_library",
            resourceRefillRound: 8,
            attemptedRefillTiers: [
              {
                tier: "same_topic_target_market",
                round: 4,
                window: 2,
              },
            ],
            terminationReason: "PROVIDER_UNAVAILABLE",
            rawCandidateCount: 10,
            fitCandidateCount: 3,
            readyFitCandidateCount: 0,
            existingCandidatesAttempted: false,
            contactReadyCount: 2,
            publishedCount: 1,
            contactWorkPending: false,
            budgetAvailable: true,
          },
        ],
      },
      {
        rows: [
          {
            idempotencyKey: `commercial-discovery:${refillWindowKey}`,
            status: "unavailable",
            pauseReason,
            finishedAt: "2026-08-11T10:00:00.000Z",
            rawCandidateCount: 0,
            eligibleCandidateCount: 0,
          },
        ],
      },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ];
    let queryIndex = 0;
    const queries: string[] = [];
    const step = await planCommercialSupplyOperationStep(
      {
        query: async (text: string) => {
          queries.push(text);
          return responses[queryIndex++] ?? { rows: [] };
        },
      },
      {
        organizationId: "organization-solar",
        workspaceId: "workspace-solar",
        websiteProjectId: "project-solar",
        projectContextVersionId: "context-solar",
        visiblePoolGeneration: 1,
        jobId: "job-solar",
        actorId: "fixture:local-product-036",
        targetPublishedCount: 10,
        candidateLimit: 100,
        estimatedCostMicros: 1_000,
        now: new Date("2026-08-11T10:02:00.000Z"),
      },
    );
    const expectedRefillWindowKey = buildCommercialRefillWindowKey({
      websiteProjectId: "project-solar",
      projectContextVersionId: "context-solar",
      visiblePoolGeneration: 1,
      tier: "same_topic_target_market",
      round: 4,
      window: expectedWindow,
    });

    expect(step).toMatchObject({
      status: "execute",
      source: "paid",
      refillWindowKey: expectedRefillWindowKey,
      refillTier: "same_topic_target_market",
      refillRound: 4,
      refillWindow: expectedWindow,
    });
    expect(queries[0]).toContain(
      "INSERT INTO backlink_commercial_inventory_policies",
    );
    expect(queries[3]).toContain(
      'SELECT batch.idempotency_key "idempotencyKey"',
    );
    expect(queries[3]).toContain(
      'batch.status,batch.pause_reason "pauseReason"',
    );
    expect(queries[5]).toContain(
      "UPDATE backlink_recommendation_refills",
    );
    expect(queries[5]).toContain("refill_window_key=$6");
    expect(queries[3]).toContain(
      "blueprint.blueprint_version=3",
    );
    expect(queryIndex).toBe(7);
  });

  it("keeps a recent provider pause separate from current budget state", () => {
    const batch = {
      idempotencyKey: `commercial-discovery:${buildCommercialRefillWindowKey({
        websiteProjectId: "project-pet",
        projectContextVersionId: "context-pet",
        visiblePoolGeneration: 1,
        tier: "adjacent_industry_same_audience",
        round: 2,
        window: 1,
      })}`,
      status: "unavailable",
      pauseReason: "DATAFORSEO_TEMPORARILY_UNAVAILABLE",
      finishedAt: "2026-08-11T10:00:30.000Z",
    };

    expect(
      resolveCommercialSupplyProviderState({
        budgetAvailable: true,
        batches: [batch],
        now: new Date("2026-08-11T10:01:00.000Z"),
      }),
    ).toBe("provider_paused");
    expect(
      resolveCommercialSupplyProviderState({
        budgetAvailable: false,
        batches: [batch],
        now: new Date("2026-08-11T10:01:00.000Z"),
      }),
    ).toBe("budget_paused");
    expect(
      resolveCommercialSupplyProviderState({
        budgetAvailable: true,
        batches: [batch],
        now: new Date("2026-08-11T10:01:31.000Z"),
      }),
    ).toBe("available");
  });
});
