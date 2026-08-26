import { describe, expect, it } from "vitest";

import {
  buildCommercialRefillWindowKey,
  planCommercialSupplyOperation,
  recordCommercialRefillAttemptOutcome,
  type CommercialRefillAttempt,
  type CommercialSupplyProviderState,
} from "../../src/modules/backlinks/domain/recommendations/commercial-refill-cycle.js";
import {
  completeCommercialSupplyOperation,
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
        tier: "exact_product_target_market",
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
    expect(calls.slice(0, 2).every((key) => key.includes(":t6:r7:"))).toBe(
      true,
    );
    expect(calls.slice(2).every((key) => key.includes(":t1:r3:"))).toBe(true);
  });

  it("exhausts the independent resource cursor before resuming paid", () => {
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
    for (const expectedWindow of [2, 3]) {
      const resourceContinuation = plan();
      expect(resourceContinuation).toMatchObject({
        kind: "execute",
        source: "resource",
        cursor: {
          tier: "curated_resource_library",
          round: 9,
          window: expectedWindow,
        },
      });
      if (resourceContinuation.kind !== "execute") {
        throw new Error("expected resource continuation");
      }
      attempts = recordCommercialRefillAttemptOutcome(attempts, {
        tier: resourceContinuation.cursor.tier,
        round: resourceContinuation.cursor.round,
        window: resourceContinuation.cursor.window,
        rawCandidateCount: 0,
        eligibleCandidateCount: 0,
        contactReadyCount: 0,
        publishedCount: 0,
      });
    }
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
      batchStatus: "unavailable",
      pauseReason: "DATAFORSEO_DISCOVERY_UNAVAILABLE",
      sourceTypes: ["BLUEPRINT_SERP_STANDARD_QUEUE"],
      expected: {
        source: "paid" as const,
        tier: "same_topic_target_market" as const,
        round: 4,
        window: 2,
      },
    },
    {
      name: "returns to curated supply after a reconciled paid no-result",
      batchStatus: "unavailable",
      pauseReason: "DATAFORSEO_RECONCILED_NO_RESULT",
      sourceTypes: ["BLUEPRINT_SERP_STANDARD_QUEUE"],
      expected: {
        source: "resource" as const,
        tier: "curated_resource_library" as const,
        round: 8,
        window: 1,
      },
    },
    {
      name: "counts a deterministic zero-plan paid window as exhausted",
      batchStatus: "paused",
      pauseReason: "semantic_discovery_not_planned_endpoint_allowlist",
      sourceTypes: ["EXISTING_HISTORY"],
      expected: {
        source: "resource" as const,
        tier: "curated_resource_library" as const,
        round: 8,
        window: 1,
      },
    },
  ])("$name", async ({
    batchStatus,
    pauseReason,
    sourceTypes,
    expected,
  }) => {
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
            existingCandidatesCompleted: false,
            contactReadyCount: 2,
            publishedCount: 1,
            budgetAvailable: true,
          },
        ],
      },
      {
        rows: [
          {
            idempotencyKey: `commercial-discovery:${refillWindowKey}`,
            status: batchStatus,
            pauseReason,
            finishedAt: "2026-08-11T10:00:00.000Z",
            rawCandidateCount: 0,
            eligibleCandidateCount: 0,
            acceptedProviderRecoveryPending: false,
            sourceTypes,
          },
        ],
      },
      {
        rows: [
          {
            jobId: "job-solar",
            refillWindowKey: "manual:project-solar:fixture",
          },
        ],
      },
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
        providerOperationId: "commercial-refill-operation:job-solar",
        providerBudgetAuthorization: {
          provider: "dataforseo",
          reasonCode: "user_authorized_persistent_discovery",
          maxPaidCalls: 6,
          maxCostMicros: 1_000_000,
          authorizedBy: "fixture:local-product-036",
        },
        now: new Date("2026-08-11T10:02:00.000Z"),
      },
    );
    const expectedRefillWindowKey = buildCommercialRefillWindowKey({
      websiteProjectId: "project-solar",
      projectContextVersionId: "context-solar",
      visiblePoolGeneration: 1,
      tier: expected.tier,
      round: expected.round,
      window: expected.window,
    });

    expect(step).toMatchObject({
      status: "execute",
      source: expected.source,
      refillWindowKey: expectedRefillWindowKey,
      refillTier: expected.tier,
      refillRound: expected.round,
      refillWindow: expected.window,
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
    expect(queries[3]).toContain("batch.refill_job_id=$6");
    expect(queries[3]).toContain(
      ') "acceptedProviderRecoveryPending"',
    );
    expect(queries[4]).toContain(
      "FROM backlink_recommendation_refills",
    );
    expect(queries[4]).toContain("FOR UPDATE");
    expect(queries[6]).toContain(
      "UPDATE backlink_recommendation_refills",
    );
    expect(queries[6]).toContain("refill_window_key=$6");
    expect(queries[3]).toContain(
      "blueprint.blueprint_version=5",
    );
    expect(queries[2]).toContain(
      "FROM backlink_commercial_supply_operations AS operation",
    );
    expect(queries[2]).toContain("operation.id=$12");
    expect(queries[2]).toContain(
      "operation.authorization_snapshot=$13::jsonb",
    );
    expect(queryIndex).toBe(8);
  });

  it("does not reuse immutable completed discovery windows", async () => {
    const windowKey = (window: number) =>
      buildCommercialRefillWindowKey({
        websiteProjectId: "project-streaming",
        projectContextVersionId: "context-streaming",
        visiblePoolGeneration: 1,
        tier: "exact_product_target_market",
        round: 1,
        window,
      });
    const responses = [
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            projectContextReady: true,
            currentRefillTier: "exact_product_target_market",
            currentRefillRound: 1,
            paidRefillTier: "exact_product_target_market",
            paidRefillRound: 1,
            resourceRefillTier: "curated_resource_library",
            resourceRefillRound: 1,
            attemptedRefillTiers: [
              {
                tier: "curated_resource_library",
                round: 1,
                window: 1,
                rawCandidateCount: 0,
                eligibleCandidateCount: 0,
              },
              {
                tier: "curated_resource_library",
                round: 1,
                window: 2,
                rawCandidateCount: 0,
                eligibleCandidateCount: 0,
              },
              {
                tier: "curated_resource_library",
                round: 1,
                window: 3,
                rawCandidateCount: 0,
                eligibleCandidateCount: 0,
              },
              {
                tier: "exact_product_target_market",
                round: 1,
                window: 3,
              },
            ],
            terminationReason: null,
            rawCandidateCount: 10,
            fitCandidateCount: 2,
            readyFitCandidateCount: 0,
            existingCandidatesCompleted: true,
            contactReadyCount: 0,
            publishedCount: 0,
            budgetAvailable: true,
            operationPaidCallCount: 0,
            operationExposureMicros: 0,
            operationUnknownChargeCount: 0,
          },
        ],
      },
      {
        rows: [5, 6].map((window) => ({
          idempotencyKey: `commercial-discovery:${windowKey(window)}`,
          status: "completed",
          pauseReason: null,
          finishedAt: "2026-08-20T12:00:00.000Z",
          rawCandidateCount: 25,
          eligibleCandidateCount: 4,
          acceptedProviderRecoveryPending: false,
          sourceTypes: ["BLUEPRINT_SERP_STANDARD_QUEUE"],
        })),
      },
      {
        rows: [
          {
            jobId: "job-streaming",
            refillWindowKey: windowKey(6),
          },
          {
            jobId: "historical-job-3",
            refillWindowKey: windowKey(3),
          },
          {
            jobId: "historical-job-4",
            refillWindowKey: windowKey(4),
          },
        ],
      },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ];
    let queryIndex = 0;

    const step = await planCommercialSupplyOperationStep(
      {
        query: async () => responses[queryIndex++] ?? { rows: [] },
      },
      {
        organizationId: "organization-streaming",
        workspaceId: "workspace-streaming",
        websiteProjectId: "project-streaming",
        projectContextVersionId: "context-streaming",
        visiblePoolGeneration: 1,
        jobId: "job-streaming",
        actorId: "fixture:immutable-discovery-window",
        targetPublishedCount: 10,
        candidateLimit: 25,
        estimatedCostMicros: 1_000,
        providerOperationId: "commercial-refill-operation:job-streaming",
        providerBudgetAuthorization: {
          provider: "dataforseo",
          reasonCode: "user_authorized_persistent_discovery",
          maxPaidCalls: 3,
          maxCostMicros: 1_000_000,
          authorizedBy: "fixture:immutable-discovery-window",
        },
        now: new Date("2026-08-20T12:05:00.000Z"),
      },
    );

    expect(step).toMatchObject({
      status: "execute",
      source: "paid",
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 7,
      refillWindowKey: windowKey(7),
    });
    expect(queryIndex).toBe(8);
  });

  it("publishes candidates made ready after an earlier existing-candidate pass", async () => {
    const responses = [
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            projectContextReady: true,
            currentRefillTier: "exact_product_target_market",
            currentRefillRound: 1,
            paidRefillTier: "exact_product_target_market",
            paidRefillRound: 1,
            resourceRefillTier: "curated_resource_library",
            resourceRefillRound: 1,
            attemptedRefillTiers: [],
            terminationReason: "BUDGET",
            rawCandidateCount: 6,
            fitCandidateCount: 1,
            readyFitCandidateCount: 1,
            existingCandidatesAttempted: true,
            existingCandidatesCompleted: true,
            contactReadyCount: 0,
            publishedCount: 0,
            budgetAvailable: false,
          },
        ],
      },
      {
        rows: [{
          idempotencyKey: `commercial-discovery:${
            buildCommercialRefillWindowKey({
              websiteProjectId: "project-streaming",
              projectContextVersionId: "context-streaming",
              visiblePoolGeneration: 1,
              tier: "exact_product_target_market",
              round: 1,
              window: 1,
            })
          }`,
          status: "completed",
          pauseReason: null,
          finishedAt: "2026-08-17T09:59:00.000Z",
          rawCandidateCount: 6,
          eligibleCandidateCount: 1,
          acceptedProviderRecoveryPending: false,
          sourceTypes: ["BLUEPRINT_SERP_STANDARD_QUEUE"],
        }],
      },
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
        organizationId: "organization-streaming",
        workspaceId: "workspace-streaming",
        websiteProjectId: "project-streaming",
        projectContextVersionId: "context-streaming",
        visiblePoolGeneration: 1,
        jobId: "job-streaming",
        actorId: "fixture:commercial-existing-recovery",
        targetPublishedCount: 10,
        candidateLimit: 25,
        estimatedCostMicros: 1_000,
        providerOperationId: "commercial-refill-operation:job-streaming",
        providerBudgetAuthorization: {
          provider: "dataforseo",
          reasonCode: "user_authorized_persistent_discovery",
          maxPaidCalls: 6,
          maxCostMicros: 1_000_000,
          authorizedBy: "fixture:commercial-existing-recovery",
        },
        now: new Date("2026-08-17T10:00:00.000Z"),
      },
    );

    expect(step).toMatchObject({
      status: "execute",
      source: "existing",
      requestedCandidateCount: 1,
    });
    expect(step.refillWindowKey).toContain("commercial-existing:");
    expect(queries[2]).toContain("existingCandidatesCompleted");
    expect(queries[2]).toContain("operation.job_id=$7");
    expect(queries[2]).toContain("operation.status='authorized'");
    expect(queries[2]).not.toContain("existingCandidatesAttempted");
    expect(queries[5]).not.toContain("existingCandidatesAttempted");
    expect(queryIndex).toBe(7);
  });

  it.each([
    {
      name: "reserves semantic discovery before existing qualification",
      operationPaidCallCount: 2,
      authorizationMaxPaidCalls: 6,
      expectedStatus: "execute",
      expectedQueryCount: 8,
    },
    {
      name: "pauses semantic discovery at the persistent authorization ceiling",
      operationPaidCallCount: 3,
      authorizationMaxPaidCalls: 3,
      expectedStatus: "wait",
      expectedQueryCount: 6,
    },
  ])("$name", async ({
    operationPaidCallCount,
    authorizationMaxPaidCalls,
    expectedStatus,
    expectedQueryCount,
  }) => {
    const responses = [
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            projectContextReady: true,
            generationInputFingerprint: "generation-input-1",
            currentRefillTier: "exact_product_target_market",
            currentRefillRound: 1,
            paidRefillTier: "exact_product_target_market",
            paidRefillRound: 1,
            resourceRefillTier: "curated_resource_library",
            resourceRefillRound: 1,
            attemptedRefillTiers: [1, 2, 3].map((window) => ({
              tier: "curated_resource_library",
              round: 1,
              window,
              rawCandidateCount: 0,
              eligibleCandidateCount: 0,
            })),
            terminationReason: null,
            rawCandidateCount: 6,
            fitCandidateCount: 0,
            readyFitCandidateCount: 1,
            existingCandidatesCompleted: false,
            contactReadyCount: 0,
            publishedCount: 0,
            budgetAvailable: true,
            operationPaidCallCount,
            operationExposureMicros: operationPaidCallCount * 1_000,
            operationUnknownChargeCount: 0,
          },
        ],
      },
      { rows: [] },
      {
        rows: [
          {
            jobId: "job-streaming",
            refillWindowKey: "manual:project-streaming:budget-headroom",
          },
        ],
      },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ];
    let queryIndex = 0;
    const queries: Array<Readonly<{
      text: string;
      values: readonly unknown[];
    }>> = [];

    const step = await planCommercialSupplyOperationStep(
      {
        query: async (text: string, values: readonly unknown[] = []) => {
          queries.push({ text, values });
          return responses[queryIndex++] ?? { rows: [] };
        },
      },
      {
        organizationId: "organization-streaming",
        workspaceId: "workspace-streaming",
        websiteProjectId: "project-streaming",
        projectContextVersionId: "context-streaming",
        visiblePoolGeneration: 1,
        jobId: "job-streaming",
        actorId: "fixture:commercial-discovery-headroom",
        targetPublishedCount: 10,
        candidateLimit: 25,
        estimatedCostMicros: 1_000,
        providerOperationId: "commercial-refill-operation:job-streaming",
        providerBudgetAuthorization: {
          provider: "dataforseo",
          reasonCode: "user_authorized_persistent_discovery",
          maxPaidCalls: authorizationMaxPaidCalls,
          maxCostMicros: 1_000_000,
          authorizedBy: "fixture:commercial-discovery-headroom",
        },
        now: new Date("2026-08-20T15:00:00.000Z"),
      },
    );

    expect(step).toMatchObject(expectedStatus === "execute"
      ? {
          status: "execute",
          source: "paid",
        }
      : {
          status: "wait",
          outcome: "PAUSED_BUDGET",
          reason: "budget",
        });
    expect(queryIndex).toBe(expectedQueryCount);
    const jobUpdate = queries.find(({ text }) =>
      text.includes("UPDATE backlink_jobs")
    );
    expect(jobUpdate).toBeDefined();
    expect(jobUpdate?.values[9]).toBeNull();
    expect(jobUpdate?.values[8]).toBe(
      expectedStatus === "wait"
        ? "semantic_discovery_budget_insufficient"
        : null,
    );
  });

  it("continues the same accepted semantic task when its authorization window is exhausted", async () => {
    const refillWindowKey = buildCommercialRefillWindowKey({
      websiteProjectId: "project-streaming",
      projectContextVersionId: "context-streaming",
      visiblePoolGeneration: 1,
      tier: "exact_product_target_market",
      round: 1,
      window: 2,
    });
    const responses = [
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            projectContextReady: true,
            generationInputFingerprint: "generation-input-1",
            currentRefillTier: "exact_product_target_market",
            currentRefillRound: 1,
            paidRefillTier: "exact_product_target_market",
            paidRefillRound: 1,
            resourceRefillTier: "curated_resource_library",
            resourceRefillRound: 1,
            attemptedRefillTiers: [1, 2, 3].map((window) => ({
              tier: "curated_resource_library",
              round: 1,
              window,
              rawCandidateCount: 0,
              eligibleCandidateCount: 0,
            })),
            terminationReason: "BUDGET",
            rawCandidateCount: 0,
            fitCandidateCount: 0,
            readyFitCandidateCount: 0,
            existingCandidatesCompleted: true,
            contactReadyCount: 0,
            publishedCount: 0,
            budgetAvailable: false,
            operationPaidCallCount: 3,
            operationExposureMicros: 3_000,
            operationUnknownChargeCount: 1,
            operationAcceptedProviderRecoveryPending: true,
          },
        ],
      },
      { rows: [] },
      {
        rows: [
          {
            jobId: "job-streaming",
            refillWindowKey,
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
        organizationId: "organization-streaming",
        workspaceId: "workspace-streaming",
        websiteProjectId: "project-streaming",
        projectContextVersionId: "context-streaming",
        visiblePoolGeneration: 1,
        jobId: "job-streaming",
        actorId: "fixture:accepted-semantic-budget-recovery",
        targetPublishedCount: 10,
        candidateLimit: 25,
        estimatedCostMicros: 1_000,
        providerOperationId: "commercial-refill-operation:job-streaming",
        providerBudgetAuthorization: {
          provider: "dataforseo",
          reasonCode: "user_authorized_persistent_discovery",
          maxPaidCalls: 3,
          maxCostMicros: 3_000,
          authorizedBy: "fixture:accepted-semantic-budget-recovery",
        },
        now: new Date("2026-08-21T08:20:00.000Z"),
      },
    );

    expect(step).toMatchObject({
      status: "execute",
      source: "paid",
      refillWindowKey,
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 2,
    });
    expect(queries[2]).toContain(
      '"operationAcceptedProviderRecoveryPending"',
    );
    expect(queries[2]).toContain(
      "usage.reservation_key LIKE $12 || ':%'",
    );
    expect(queries[2]).not.toContain(
      "batch_request.provider_task_id IS NOT NULL",
    );
    expect(queries[2]).toContain(
      "batch_request.endpoint=",
    );
    expect(queries[3]).not.toContain(
      "request.provider_task_id IS NOT NULL",
    );
    expect(queries[2]).toContain(
      "lease.owner_request_id=batch_request.request_id",
    );
    expect(queryIndex).toBe(8);
  });

  it("reassesses existing evidence without requiring a commercial supply operation", async () => {
    const responses = [
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            projectContextReady: true,
            visiblePoolGeneration: 1,
            visiblePoolState: "active",
            generationInputFingerprint: "generation-input-1",
            rawCandidateCount: 0,
            fitCandidateCount: 0,
            readyFitCandidateCount: 0,
            existingCandidatesCompleted: false,
            publishedCount: 0,
          },
        ],
      },
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
        organizationId: "organization-streaming",
        workspaceId: "workspace-streaming",
        websiteProjectId: "project-streaming",
        projectContextVersionId: "context-streaming",
        visiblePoolGeneration: 1,
        jobId: "job-streaming",
        actorId: "fixture:existing-evidence-reassessment",
        targetPublishedCount: 10,
        candidateLimit: 25,
        estimatedCostMicros: 1_000,
        supplyMode: "existing_evidence",
        now: new Date("2026-08-20T08:00:00.000Z"),
      },
    );

    expect(step).toMatchObject({
      status: "complete",
      outcome: "SUPPLY_FLOOR_REACHED",
      publishedCount: 0,
    });
    expect(queries[2]).toMatch(
      /policy\.visible_pool_state IN \(\s*'idle','building','active','awaiting_refresh'\s*\)/,
    );
    expect(queries.join("\n")).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE)\s+backlink_commercial_discovery_batches\b/i,
    );
    expect(queries.join("\n")).not.toContain("provider_batch_requests");
    expect(queries.join("\n")).not.toContain(
      "backlink_provider_usage_ledger",
    );
    expect(queries.join("\n")).not.toContain("provider_fetch_leases");
    expect(queryIndex).toBe(4);
  });

  it("executes existing-evidence recovery when static assessments are retryable", async () => {
    const responses = [
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            projectContextReady: true,
            visiblePoolGeneration: 1,
            visiblePoolState: "building",
            generationInputFingerprint: "generation-input-1",
            rawCandidateCount: 0,
            fitCandidateCount: 0,
            readyFitCandidateCount: 0,
            recoverableStaticAssessmentCount: 7,
            existingCandidatesCompleted: false,
            publishedCount: 0,
          },
        ],
      },
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
        organizationId: "organization-streaming",
        workspaceId: "workspace-streaming",
        websiteProjectId: "project-streaming",
        projectContextVersionId: "context-streaming",
        visiblePoolGeneration: 1,
        jobId: "job-streaming",
        actorId: "fixture:existing-evidence-static-recovery",
        targetPublishedCount: 10,
        candidateLimit: 25,
        estimatedCostMicros: 1_000,
        supplyMode: "existing_evidence",
        now: new Date("2026-08-20T08:00:00.000Z"),
      },
    );

    expect(step).toMatchObject({
      status: "execute",
      source: "existing",
      refillTier: "existing_evidence",
      requestedCandidateCount: 7,
    });
    expect(queries[2]).toContain('"recoverableStaticAssessmentCount"');
    expect(queries[2]).toContain(
      "#>>'{recovery,contractVersion}' IS DISTINCT FROM $15",
    );
    expect(queries[2]).toContain("#>>'{recovery,nextRetryAt}'");
    expect(queryIndex).toBe(4);
  });

  it("keeps ordinary refill fail-closed when no supply operation is active", async () => {
    const responses = [{ rows: [] }, { rows: [] }, { rows: [] }];
    let queryIndex = 0;

    await expect(planCommercialSupplyOperationStep(
      {
        query: async () => responses[queryIndex++] ?? { rows: [] },
      },
      {
        organizationId: "organization-streaming",
        workspaceId: "workspace-streaming",
        websiteProjectId: "project-streaming",
        projectContextVersionId: "context-streaming",
        visiblePoolGeneration: 1,
        jobId: "job-streaming",
        actorId: "fixture:ordinary-refill",
        targetPublishedCount: 10,
        candidateLimit: 25,
        estimatedCostMicros: 1_000,
        now: new Date("2026-08-20T08:00:00.000Z"),
      },
    )).rejects.toThrow("COMMERCIAL_SUPPLY_OPERATION_NOT_FOUND");
    expect(queryIndex).toBe(3);
  });

  it("keeps an ordinary refill fail-closed when its operation binding mismatches", async () => {
    const responses = [{ rows: [] }, { rows: [] }, { rows: [] }];
    let queryIndex = 0;
    const queries: string[] = [];

    await expect(planCommercialSupplyOperationStep(
      {
        query: async (text: string) => {
          queries.push(text);
          return responses[queryIndex++] ?? { rows: [] };
        },
      },
      {
        organizationId: "organization-streaming",
        workspaceId: "workspace-streaming",
        websiteProjectId: "project-streaming",
        projectContextVersionId: "context-streaming",
        visiblePoolGeneration: 1,
        jobId: "job-streaming",
        actorId: "fixture:mismatched-operation",
        targetPublishedCount: 10,
        candidateLimit: 25,
        estimatedCostMicros: 1_000,
        providerOperationId: "commercial-refill-operation:other-job",
        providerBudgetAuthorization: {
          provider: "dataforseo",
          reasonCode: "user_authorized_persistent_discovery",
          maxPaidCalls: 6,
          maxCostMicros: 1_000_000,
          authorizedBy: "fixture:mismatched-operation",
        },
        now: new Date("2026-08-20T08:00:00.000Z"),
      },
    )).rejects.toThrow("COMMERCIAL_SUPPLY_OPERATION_NOT_FOUND");
    expect(queries[2]).toContain("operation.id=$12");
    expect(queries[2]).toContain("operation.project_context_version_id=$4");
    expect(queries[2]).toContain("operation.visible_pool_generation=$9");
    expect(queries[2]).toContain("operation.job_id=$7");
    expect(queries[2]).toContain(
      "operation.authorization_snapshot=$13::jsonb",
    );
    expect(queryIndex).toBe(3);
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
        acceptedProviderRecoveryPending: false,
        batches: [batch],
        now: new Date("2026-08-11T10:01:00.000Z"),
      }),
    ).toBe("provider_paused");
    expect(
      resolveCommercialSupplyProviderState({
        budgetAvailable: false,
        operationAuthorized: false,
        acceptedProviderRecoveryPending: false,
        batches: [batch],
        now: new Date("2026-08-11T10:01:00.000Z"),
      }),
    ).toBe("budget_paused");
    expect(
      resolveCommercialSupplyProviderState({
        budgetAvailable: false,
        operationAuthorized: false,
        acceptedProviderRecoveryPending: true,
        batches: [batch],
        now: new Date("2026-08-11T10:01:00.000Z"),
      }),
    ).toBe("available");
    expect(
      resolveCommercialSupplyProviderState({
        budgetAvailable: false,
        operationAuthorized: true,
        operationBudgetAvailable: true,
        acceptedProviderRecoveryPending: false,
        batches: [],
        now: new Date("2026-08-11T10:01:00.000Z"),
      }),
    ).toBe("available");
    expect(
      resolveCommercialSupplyProviderState({
        budgetAvailable: true,
        operationAuthorized: true,
        operationBudgetAvailable: false,
        acceptedProviderRecoveryPending: false,
        batches: [],
        now: new Date("2026-08-11T10:01:00.000Z"),
      }),
    ).toBe("budget_paused");
    expect(
      resolveCommercialSupplyProviderState({
        budgetAvailable: true,
        acceptedProviderRecoveryPending: false,
        batches: [batch],
        now: new Date("2026-08-11T10:01:31.000Z"),
      }),
    ).toBe("available");
  });

  it("does not classify a deterministic zero-plan batch as provider downtime", () => {
    const batch = {
      idempotencyKey: `commercial-discovery:${buildCommercialRefillWindowKey({
        websiteProjectId: "project-pet",
        projectContextVersionId: "context-pet",
        visiblePoolGeneration: 1,
        tier: "exact_product_target_market",
        round: 2,
        window: 1,
      })}`,
      status: "paused",
      pauseReason: "semantic_discovery_not_planned_endpoint_allowlist",
      finishedAt: "2026-08-11T10:00:30.000Z",
    };

    expect(
      resolveCommercialSupplyProviderState({
        budgetAvailable: true,
        acceptedProviderRecoveryPending: false,
        batches: [batch],
        now: new Date("2026-08-11T10:00:31.000Z"),
      }),
    ).toBe("available");
  });

  it("publishes partial existing evidence without claiming the target", async () => {
    const calls: Array<{
      text: string;
      values: readonly unknown[] | undefined;
    }> = [];
    const now = new Date("2026-08-21T10:00:00.000Z");

    await completeCommercialSupplyOperation(
      {
        query: async (text, values) => {
          calls.push({ text, values });
          return text.includes("UPDATE backlink_jobs")
            ? { rows: [{ id: "job-streaming" }] }
            : { rows: [] };
        },
      },
      {
        organizationId: "organization-streaming",
        workspaceId: "workspace-streaming",
        websiteProjectId: "project-streaming",
        projectContextVersionId: "context-streaming",
        visiblePoolGeneration: 1,
        jobId: "job-streaming",
        actorId: "fixture:existing-evidence",
        outcome: "SUPPLY_FLOOR_REACHED",
        terminalReason: "EXISTING_EVIDENCE_WINDOW_COMPLETED",
        targetPublishedCount: 10,
        publishedCount: 7,
        addedCount: 7,
        evaluatedCount: 7,
        excludedCount: 0,
        insufficientDataCount: 0,
        now,
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.values?.[4]).toBe("partial_success");
    expect(calls[0]?.values?.[5]).toBe("existing_evidence_completed");
    expect(JSON.parse(String(calls[0]?.values?.[7]))).toMatchObject({
      outcome: "SUPPLY_FLOOR_REACHED",
      terminalReason: "EXISTING_EVIDENCE_WINDOW_COMPLETED",
      publishedCount: 7,
    });
    expect(calls[1]?.values?.slice(5, 8)).toEqual([
      true,
      false,
      true,
    ]);
    expect(calls[1]?.text).toContain(
      "WHEN $7::boolean THEN 'HIGH_WATERMARK'",
    );
    expect(calls[1]?.text).toContain(
      "WHEN $8::boolean THEN 'idle'",
    );
    expect(calls[1]?.text).toContain(
      "WHEN $8::boolean THEN NULL",
    );
  });
});
