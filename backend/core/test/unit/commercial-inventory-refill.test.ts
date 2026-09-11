import { describe, expect, it, vi } from "vitest";

import {
  ensureCommercialRecommendationRefill,
  hasRecoverableAcceptedCommercialRecommendationRefill,
} from "../../src/modules/backlinks/application/services/commercial-inventory-refill.service.js";

const input = {
  organizationId: "018f0000-0000-7000-8000-000000000101",
  workspaceId: "018f0000-0000-7000-8000-000000000102",
  websiteProjectId: "018f0000-0000-7000-8000-000000000103",
  projectContextVersionId: "018f0000-0000-7000-8000-000000000104",
  actorId: "user-commercial-inventory",
  estimatedCostMicros: 1_000,
  absoluteBudgetMicros: 100_000,
  maxPaidCalls: 3,
  providerBudgetGrant: {
    provider: "dataforseo",
    reasonCode: "user_authorized_persistent_discovery",
    maxPaidCalls: 3,
    maxCostMicros: 100_000,
  },
  candidateLimit: 100,
  now: new Date("2026-08-06T09:00:00.000Z"),
} as const;

const inventoryState = {
  canonicalDomain: "elephtv.com",
  locale: "en-US",
  countryCode: "US",
  profileVersionId: "profile-1",
  promotionTargetVersionId: "promotion-1",
  projectContextReady: true,
  candidateLowWatermark: 20,
  candidateHighWatermark: 40,
  publishedLowWatermark: 5,
  publishedHighWatermark: 10,
  minimumEmailHitRate: 0.1,
  maximumEmailHitRate: 0.8,
  candidateReadyCount: 25,
  preparedCandidateCount: 0,
  historicalCandidateCount: 20,
  rawCandidateCount: 68,
  eliminationReasonCounts: {
    NOT_PUBLISHED: 20,
    CONTACT_NOT_ELIGIBLE: 24,
  },
  publishedContactReadyCount: 2,
  historicalVerifiedEmailCount: 1,
  workflowReadyCount: 25,
  inflight: false,
  contactPending: false,
  cooldownActive: false,
  budgetAvailable: true,
  refillState: "idle",
  currentRefillTier: "exact_product_target_market",
  currentRefillRound: 1,
  attemptedRefillTiers: [],
  terminationReason: null,
  currentBatchStatus: null,
  currentBatchPauseReason: null,
  latestJobStatus: null,
  latestRefillStep: null,
  latestRefillTerminalReason: null,
  occupiedRefillWindowKeys: [],
} as const;

describe("commercial inventory automatic refill", () => {
  it("detects only an exact accepted provider task for Worker recovery", async () => {
    const query = vi.fn(async () => ({
      rows: [{ recoverable: true }],
    }));

    await expect(hasRecoverableAcceptedCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toBe(true);

    const [sql, values] = query.mock.calls[0] ?? [];
    expect(values).toEqual([
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.projectContextVersionId,
    ]);
    expect(String(sql)).toContain("request.provider_task_id IS NOT NULL");
    expect(String(sql)).toContain("usage.status='reserved'");
    expect(String(sql)).toContain("lease.status='unknown_charge'");
    expect(String(sql)).toContain("__growthosDiscoveryPlannerLineage");
    expect(String(sql)).toContain("conflicting.refill_job_id<>job.id");
  });

  it("does not schedule accepted-task recovery without exact evidence", async () => {
    const query = vi.fn(async () => ({
      rows: [{ recoverable: false }],
    }));

    await expect(hasRecoverableAcceptedCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toBe(false);
  });

  it("clears a legacy authorization pause and continues the refill", async () => {
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.startsWith('SELECT refill_state "refillState"')) {
        return {
          rows: [{
            refillState: "paused",
            pauseReason: "awaiting_authorization",
            terminationReason: "BUDGET",
            minimumEmailHitRate: 0.1,
            currentRefillTier: "exact_product_target_market",
            currentRefillRound: 1,
          }],
        };
      }
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            contractKind: "candidate_visibility_v1",
            candidateReadyCount: 0,
            budgetAvailable: false,
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "queued",
      requestedCandidateCount: 10,
      effectiveEmailHitRate: 0.1,
      currentTier: "exact_product_target_market",
      currentRound: 1,
      terminationReason: null,
    });
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("pause_reason='awaiting_authorization'")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("WITH guard AS")
    )).toBe(true);
  });

  it("does not mutate contact batches while evaluating recommendation refill", async () => {
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            budgetAvailable: false,
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await ensureCommercialRecommendationRefill({ query }, input);

    expect(query.mock.calls.some(([text]) =>
      String(text).includes(
        "UPDATE backlink_contact_enrichment_batches AS batch",
      )
    )).toBe(false);
  });

  it("queues one inventory-low refill through the existing durable workflow", async () => {
    let commandValues: readonly unknown[] | undefined;
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        return { rows: [inventoryState] };
      }
      if (text.includes("WITH guard AS")) {
        commandValues = values;
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "queued",
      requestedCandidateCount: 10,
      effectiveEmailHitRate: 0.1,
    });
    expect(commandValues?.[15]).toBe(0);
    expect(commandValues?.[16]).toBe(10);
    expect(commandValues?.[17]).toBe(
      "commercial-refill:"
        + `${input.websiteProjectId}:${input.projectContextVersionId}:g1:t1:r1:w1`,
    );
    expect(commandValues?.[19]).toBe("inventory_low");
    expect(commandValues?.[22]).toEqual(JSON.stringify({
      ...input.providerBudgetGrant,
      authorizedBy: input.actorId,
    }));
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("backlinks.recommendation-refill.requested.v1")
    )).toBe(true);
    const stateQuery = String(query.mock.calls.find(([text]) =>
      String(text).includes("WITH candidate_counts AS")
    )?.[0] ?? "");
    for (const clause of [
      "inventory.fit_decision='eligible'",
      "inventory.status IN ('ready','shown','accepted')",
      "recommendation.status IN ('ready','shown','accepted')",
      "AND inventory.visible_pool_generation=(",
    ]) {
      expect(stateQuery).toContain(clause);
    }
    expect(stateQuery).toContain(
      "ELSE 'candidate_visibility_v1'",
    );
    expect(stateQuery).toContain(
      "COALESCE(candidate_counts.candidate_ready_count,0)",
    );
    expect(stateQuery).not.toContain(
      "FROM backlink_opportunities AS opportunity",
    );
    expect(stateQuery).toContain(
      "JOIN backlink_jobs AS job",
    );
    expect(stateQuery).toContain(
      "batch.website_project_id,batch.refill_job_id",
    );
    expect(stateQuery).toContain(
      'current_batch.job_status "latestJobStatus"',
    );
    expect(stateQuery).not.toContain(
      "ORDER BY job.created_at DESC,job.id DESC",
    );
    expect(stateQuery).toContain(
      "usage.budget_id=budget.id",
    );
    expect(stateQuery).toContain(
      "usage.status IN ('reserved','settled')",
    );
    expect(stateQuery).toContain(") < $8");
    expect(query.mock.calls.find(([text]) =>
      String(text).includes("WITH candidate_counts AS")
    )?.[1]?.[7]).toBe(input.maxPaidCalls);
  });

  it("queues archived qualified inventory through a zero-cost durable refill", async () => {
    let commandValues: readonly unknown[] | undefined;
    const queries: string[] = [];
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      queries.push(text);
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            visiblePoolState: "awaiting_refresh",
            visiblePoolGeneration: 2,
            visiblePoolTargetCount: 10,
            candidateReadyCount: 3,
            preparedCandidateCount: 3,
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        commandValues = values;
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      { ...input, providerAvailable: false },
    )).resolves.toMatchObject({
      status: "queued",
      requestedCandidateCount: 3,
      currentTier: "exact_product_target_market",
      currentRound: 1,
      terminationReason: null,
    });
    expect(commandValues?.[17]).toBe(
      "commercial-existing:"
        + `${input.websiteProjectId}:${input.projectContextVersionId}:g2:archive-prepared`,
    );
    expect(commandValues?.[22]).toBeNull();
    expect(commandValues?.[23]).toBe("existing_evidence");
    expect(queries.some((text) =>
      text.includes("WITH accepted_recovery AS MATERIALIZED")
    )).toBe(false);
    expect(queries.some((text) =>
      text.includes("visible_pool_state=COALESCE")
    )).toBe(true);
  });

  it("pauses an empty archived generation when the provider is unavailable", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            visiblePoolState: "awaiting_refresh",
            visiblePoolGeneration: 2,
            visiblePoolTargetCount: 10,
            candidateReadyCount: 0,
            preparedCandidateCount: 0,
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      { ...input, providerAvailable: false },
    )).resolves.toMatchObject({
      status: "paused",
      pauseReason: "provider_unavailable",
      currentTier: "exact_product_target_market",
      currentRound: 1,
      terminationReason: "PROVIDER_UNAVAILABLE",
    });
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("WITH guard AS")
    )).toBe(false);
    expect(query.mock.calls.some(([, values]) =>
      values?.includes("PROVIDER_UNAVAILABLE")
      && values?.includes("provider_unavailable")
    )).toBe(true);
  });

  it("recovers an accepted provider operation after refill tier drift", async () => {
    const operationId = "018f0000-0000-7000-8000-000000000105";
    const jobId = "018f0000-0000-7000-8000-000000000106";
    const refillWindowKey =
      "commercial-refill:"
      + `${input.websiteProjectId}:${input.projectContextVersionId}:g1:t1:r1:w1`;
    const historicalIdempotencyKey =
      `recommendation-refill:project-bootstrap:${input.websiteProjectId}:3:g1`;
    const historicalRequestHash = "historical-request-hash";
    let recoveryLookupValues: readonly unknown[] | undefined;
    let recoveryLookupSql = "";
    let commandValues: readonly unknown[] | undefined;
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            latestJobStatus: "failed",
          }],
        };
      }
      if (text.includes("WITH accepted_recovery AS MATERIALIZED")) {
        recoveryLookupSql = text;
        recoveryLookupValues = values;
        return {
          rows: [{
            operationId,
            acceptedOperationCount: 1,
            hasUnownedProvider: false,
          }],
        };
      }
      if (text.includes("JOIN backlink_idempotency_records AS idempotency")) {
        return {
            rows: [{
              refillWindowKey,
              idempotencyKey: historicalIdempotencyKey,
              requestHash: historicalRequestHash,
              triggerReason: "inventory_low",
              lowWatermark: 9,
              highWatermark: 10,
              visiblePoolGeneration: 1,
              jobId,
              outboxEventId:
                "018f0000-0000-7000-8000-000000000109",
            }],
          };
      }
      if (text.includes("WITH target AS MATERIALIZED")) {
        return {
          rows: [{
            state: "ready",
            providerBudgetAuthorization: {
              ...input.providerBudgetGrant,
              authorizedBy: input.actorId,
            },
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        commandValues = values;
        return {
          rows: [{
            state: "replay",
            requestHash: historicalRequestHash,
            responseBody: {
              operationId,
              jobId,
              workflowId: "workflow-1",
              status: "queued",
              version: 1,
              visiblePoolGeneration: 1,
              lifecycleEventId:
                "018f0000-0000-7000-8000-000000000107",
              auditEventId:
                "018f0000-0000-7000-8000-000000000108",
            },
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "queued",
      jobId,
    });
    expect(recoveryLookupValues).toEqual([
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.projectContextVersionId,
      1,
      refillWindowKey,
    ]);
    expect(recoveryLookupSql).toContain("batch.refill_job_id");
    expect(recoveryLookupSql).toContain("job.id");
    expect(recoveryLookupSql).toContain("request.request_id LIKE");
    expect(recoveryLookupSql).toContain("batch.idempotency_key");
    expect(recoveryLookupSql).toContain("'^commercial-discovery:'");
    expect(recoveryLookupSql).toContain(
      "completed_provider_checkpoint",
    );
    expect(recoveryLookupSql).toContain(
      "job.retry_count=6",
    );
    expect(recoveryLookupSql).toContain(
      "completedProviderCheckpointRecoveryAttempted",
    );
    expect(recoveryLookupSql).toContain(
      "provider_request.status='succeeded'",
    );
    expect(recoveryLookupSql).toContain("usage.status='settled'");
    expect(recoveryLookupSql).toContain("lease.status='completed'");
    expect(commandValues?.[6]).toBe(historicalIdempotencyKey);
    expect(commandValues?.[7]).toBe(historicalRequestHash);
    expect(commandValues?.[17]).toBe(refillWindowKey);
    expect(commandValues?.[20]).toBe(operationId);
  });

  it("fails closed when accepted provider lineage is ambiguous", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (text: string) => {
      queries.push(text);
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            latestJobStatus: "failed",
          }],
        };
      }
      if (text.includes("WITH accepted_recovery AS MATERIALIZED")) {
        return {
          rows: [{
            operationId: null,
            acceptedOperationCount: 2,
            hasUnownedProvider: false,
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).rejects.toThrow("BACKLINK_PROVIDER_RECOVERY_LINEAGE_AMBIGUOUS");
    expect(queries.some((text) => text.includes("WITH guard AS"))).toBe(false);
  });

  it("starts one operation so resources can continue during a paid budget pause", async () => {
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            candidateReadyCount: 0,
            publishedContactReadyCount: 0,
            budgetAvailable: false,
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "queued",
      requestedCandidateCount: 10,
      effectiveEmailHitRate: 0.1,
      currentTier: "exact_product_target_market",
      currentRound: 1,
      terminationReason: null,
    });
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("WITH guard AS")
    )).toBe(true);
  });

  it("pauses an incomplete project context without creating a refill job", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            candidateReadyCount: 0,
            publishedContactReadyCount: 0,
            projectContextReady: false,
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "paused",
      pauseReason: "project_context",
      requestedCandidateCount: 0,
      effectiveEmailHitRate: 0.1,
      currentTier: "exact_product_target_market",
      currentRound: 1,
      terminationReason: "PROJECT_CONTEXT",
    });
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("WITH guard AS")
    )).toBe(false);
  });

  it("continues refill independently of contact discovery", async () => {
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            contractKind: "candidate_visibility_v1",
            candidateReadyCount: 0,
            refillState: "idle",
            attemptedRefillTiers: [{
              tier: "exact_product_target_market",
              round: 1,
            }],
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "queued",
      requestedCandidateCount: 10,
      currentTier: "exact_product_target_market",
      currentRound: 1,
      terminationReason: null,
    });
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("WITH guard AS")
    )).toBe(true);
    const refillCommandSql = String(
      query.mock.calls.find(([text]) =>
        String(text).includes("WITH guard AS")
      )?.[0] ?? "",
    );
    expect(refillCommandSql).not.toContain(
      "backlink_contact_enrichment_batches",
    );
  });

  it("does not use contact-ready count as recommendation pool capacity", async () => {
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            contractKind: "candidate_visibility_v1",
            candidateReadyCount: 0,
            publishedContactReadyCount: 20,
            refillState: "idle",
            attemptedRefillTiers: [{
              tier: "exact_product_target_market",
              round: 1,
            }],
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "queued",
      requestedCandidateCount: 10,
      currentTier: "exact_product_target_market",
      currentRound: 1,
      terminationReason: null,
    });
    expect(query.mock.calls.some(([, values]) =>
      values?.includes("HIGH_WATERMARK")
    )).toBe(false);
  });

  it("declares the high watermark from candidate visibility while contact work continues", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            contractKind: "candidate_visibility_v1",
            candidateReadyCount: 10,
            publishedContactReadyCount: 0,
            inflight: false,
            contactPending: true,
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "idle",
      pauseReason: null,
      requestedCandidateCount: 0,
      terminationReason: "HIGH_WATERMARK",
    });
    expect(query.mock.calls.some(([, values]) =>
      values?.includes("HIGH_WATERMARK")
    )).toBe(true);
  });

  it("activates a corrected pool at ten visible matches without public emails", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            contractKind: "corrected_visibility_v1",
            visibleMatchCount: 10,
            publishedContactReadyCount: 0,
            inflight: false,
            contactPending: false,
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "idle",
      pauseReason: null,
      requestedCandidateCount: 0,
      terminationReason: "HIGH_WATERMARK",
    });
    expect(query.mock.calls.some(([, values]) =>
      values?.includes("HIGH_WATERMARK")
    )).toBe(true);
  });

  it("does not create a second job while the operation is active", async () => {
    const query = vi.fn(async (
      text: string,
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            refillState: "running",
            inflight: true,
            attemptedRefillTiers: [{
              tier: "exact_product_target_market",
              round: 1,
            }],
            currentBatchStatus: "completed",
            latestJobStatus: "success",
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "paused",
      pauseReason: "inflight",
      currentTier: "exact_product_target_market",
      currentRound: 1,
      terminationReason: null,
    });
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("WITH guard AS")
    )).toBe(false);
  });

  it("waits for an active refill before pausing an incompatible generation", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            visiblePoolState: "building",
            contractKind: "incompatible_generation",
            refillState: "running",
            inflight: true,
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "paused",
      pauseReason: "inflight",
      terminationReason: null,
    });
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("UPDATE backlink_commercial_inventory_policies")
    )).toBe(false);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("WITH guard AS")
    )).toBe(false);
  });

  it("pauses an incompatible generation without creating another refill", async () => {
    let stateQuery = "";
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH candidate_counts AS")) {
        stateQuery = text;
        return {
          rows: [{
            ...inventoryState,
            visiblePoolState: "building",
            contractKind: "incompatible_generation",
            refillState: "running",
            inflight: false,
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "paused",
      pauseReason: "incompatible_generation",
      terminationReason: null,
    });
    expect(stateQuery).toContain("occupied_generation_contract AS");
    expect(stateQuery).toContain(
      "WHEN occupied_generation_contract.id IS NOT NULL",
    );
    expect(query.mock.calls.some(([, values]) =>
      values?.includes("incompatible_generation")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("WITH guard AS")
    )).toBe(false);
  });

  it("queues the next persisted window to restore nine sites to ten", async () => {
    let commandValues: readonly unknown[] | undefined;
    let inventoryStateQuery = "";
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        inventoryStateQuery = text;
        return {
          rows: [{
            ...inventoryState,
            publishedContactReadyCount: 9,
            refillState: "completed",
            attemptedRefillTiers: [{
              tier: "exact_product_target_market",
              round: 1,
              window: 1,
              rawCandidateCount: 24,
              eligibleCandidateCount: 3,
            }],
            terminationReason: "HIGH_WATERMARK",
            currentBatchStatus: "completed",
            currentBatchRawCandidateCount: 24,
            currentBatchEligibleCandidateCount: 3,
            latestJobStatus: "success",
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        commandValues = values;
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "queued",
      currentTier: "exact_product_target_market",
      currentRound: 1,
      terminationReason: null,
    });
    expect(commandValues?.[17]).toBe(
      "commercial-refill:"
        + `${input.websiteProjectId}:${input.projectContextVersionId}:g1:t1:r1:w2`,
    );
    expect(commandValues?.[15]).toBe(0);
    expect(commandValues?.[19]).toBe("inventory_low");
    expect(inventoryStateQuery).toContain(
      "batch.raw_candidate_count,batch.eligible_candidate_count",
    );
    expect(inventoryStateQuery).toContain(
      "'^recommendation-refill:'",
    );
  });

  it("does not create another job after the supply floor is persisted", async () => {
    let commandValues: readonly unknown[] | undefined;
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            currentRefillTier: "curated_resource_library",
            refillState: "exhausted",
            attemptedRefillTiers: [{
              tier: "curated_resource_library",
              round: 1,
              window: 1,
            }],
            terminationReason: "TIERS_EXHAUSTED",
            currentBatchStatus: "completed",
            currentBatchRawCandidateCount: 0,
            currentBatchEligibleCandidateCount: 0,
            latestJobStatus: "success",
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        commandValues = values;
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "paused",
      pauseReason: "tiers_exhausted",
      currentTier: "curated_resource_library",
      currentRound: 1,
      terminationReason: "TIERS_EXHAUSTED",
    });
    expect(commandValues).toBeUndefined();
  });

  it("rearms a supply floor incorrectly persisted by evidence recovery", async () => {
    let commandValues: readonly unknown[] | undefined;
    const occupiedWindowKey =
      "commercial-refill:"
      + `${input.websiteProjectId}:${input.projectContextVersionId}:g1:t6:r1:w1`;
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            contractKind: "candidate_visibility_v1",
            candidateReadyCount: 0,
            currentRefillTier: "curated_resource_library",
            refillState: "completed",
            terminationReason: "TIERS_EXHAUSTED",
            latestRefillStep: "existing_evidence_no_progress",
            latestRefillTerminalReason: "EXISTING_EVIDENCE_NO_PROGRESS",
            occupiedRefillWindowKeys: [occupiedWindowKey],
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        commandValues = values;
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "queued",
      currentTier: "curated_resource_library",
      currentRound: 1,
      terminationReason: null,
    });
    expect(commandValues?.[17]).toBe(
      "commercial-refill:"
        + `${input.websiteProjectId}:${input.projectContextVersionId}:g1:t6:r1:w2`,
    );
  });

  it("pauses after an unavailable provider window is fully settled", async () => {
    let commandValues: readonly unknown[] | undefined;
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            currentRefillTier: "same_topic_target_market",
            currentRefillRound: 4,
            attemptedRefillTiers: [{
              tier: "same_topic_target_market",
              round: 4,
              window: 1,
            }],
            currentBatchStatus: "unavailable",
            currentBatchRawCandidateCount: 3,
            currentBatchEligibleCandidateCount: 0,
            currentBatchProviderUnresolved: false,
            latestJobStatus: "failed",
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        commandValues = values;
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "paused",
      pauseReason: "provider_unavailable",
      currentTier: "same_topic_target_market",
      currentRound: 4,
      terminationReason: "PROVIDER_UNAVAILABLE",
    });
    expect(commandValues).toBeUndefined();
    expect(query.mock.calls.some(([, values]) =>
      values?.includes("PROVIDER_UNAVAILABLE")
      && values?.includes("provider_unavailable")
    )).toBe(true);
  });

  it("keeps a persisted provider failure paused without creating a new job", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            refillState: "paused",
            terminationReason: "PROVIDER_UNAVAILABLE",
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "paused",
      pauseReason: "provider_unavailable",
      terminationReason: "PROVIDER_UNAVAILABLE",
    });
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("WITH guard AS")
    )).toBe(false);
  });

  it("advances a settled budget-paused window after a new budget cycle", async () => {
    let commandValues: readonly unknown[] | undefined;
    const query = vi.fn(async (
      text: string,
      values?: readonly unknown[],
    ) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            candidateReadyCount: 0,
            publishedContactReadyCount: 0,
            attemptedRefillTiers: [{
              tier: "exact_product_target_market",
              round: 1,
              window: 1,
            }],
            terminationReason: "BUDGET",
            currentBatchStatus: "paused",
            currentBatchPauseReason: "budget_or_endpoint_allowlist",
            currentBatchRawCandidateCount: 0,
            currentBatchEligibleCandidateCount: 0,
            currentBatchProviderUnresolved: false,
            latestJobStatus: "partial_success",
            budgetAvailable: true,
          }],
        };
      }
      if (text.includes("WITH guard AS")) {
        commandValues = values;
        return {
          rows: [{
            state: "completed",
            requestHash: values?.[7],
            responseBody: {
              jobId: values?.[9],
              workflowId: values?.[14],
              status: "queued",
              version: 1,
              lifecycleEventId: values?.[11],
              auditEventId: values?.[12],
            },
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "queued",
      currentTier: "exact_product_target_market",
      currentRound: 1,
      terminationReason: null,
    });
    expect(commandValues?.[17]).toBe(
      "commercial-refill:"
        + `${input.websiteProjectId}:${input.projectContextVersionId}:g1:t1:r1:w2`,
    );
  });

  it("holds a settled provider pause after the daily call ceiling", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            candidateReadyCount: 0,
            publishedContactReadyCount: 0,
            attemptedRefillTiers: [{
              tier: "exact_product_target_market",
              round: 1,
              window: 2,
            }],
            terminationReason: "BUDGET",
            currentBatchStatus: "paused",
            currentBatchPauseReason: "Data provider quota is exceeded",
            currentBatchRawCandidateCount: 16,
            currentBatchEligibleCandidateCount: 1,
            currentBatchProviderUnresolved: false,
            latestJobStatus: "partial_success",
            budgetAvailable: false,
          }],
        };
      }
      return { rows: [] };
    });

    await expect(ensureCommercialRecommendationRefill(
      { query },
      input,
    )).resolves.toMatchObject({
      status: "paused",
      pauseReason: "budget",
      currentTier: "exact_product_target_market",
      currentRound: 1,
      terminationReason: "BUDGET",
    });
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("WITH guard AS")
    )).toBe(false);
  });
});
