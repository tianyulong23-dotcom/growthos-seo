import { describe, expect, it, vi } from "vitest";

import {
  ensureCommercialRecommendationRefill,
} from "../../src/modules/backlinks/application/services/commercial-inventory-refill.service.js";

const input = {
  organizationId: "018f0000-0000-7000-8000-000000000101",
  workspaceId: "018f0000-0000-7000-8000-000000000102",
  websiteProjectId: "018f0000-0000-7000-8000-000000000103",
  projectContextVersionId: "018f0000-0000-7000-8000-000000000104",
  actorId: "user-commercial-inventory",
  estimatedCostMicros: 1_000,
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
} as const;

describe("commercial inventory automatic refill", () => {
  it("closes a stale running contact batch only after every existing job is terminal", async () => {
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

    const reconciliation = query.mock.calls.find(([text]) =>
      String(text).includes(
        "UPDATE backlink_contact_enrichment_batches AS batch",
      )
    );
    expect(reconciliation?.[1]).toEqual([
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.projectContextVersionId,
      input.now,
      input.actorId,
    ]);
    const sql = String(reconciliation?.[0] ?? "");
    expect(sql).toContain("batch.status='running'");
    expect(sql).toContain("AND EXISTS (");
    expect(sql).toContain("AND NOT EXISTS (");
    expect(sql).toContain(
      "'pending','running','retry_scheduled'",
    );
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
      requestedCandidateCount: 80,
      effectiveEmailHitRate: 0.1,
    });
    expect(commandValues?.[15]).toBe(9);
    expect(commandValues?.[16]).toBe(10);
    expect(commandValues?.[17]).toBe(
      "commercial-refill:"
        + `${input.websiteProjectId}:${input.projectContextVersionId}:g1:t1:r1:w1`,
    );
    expect(commandValues?.[19]).toBe("inventory_low");
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("backlinks.recommendation-refill.requested.v1")
    )).toBe(true);
    const stateQuery = String(query.mock.calls.find(([text]) =>
      String(text).includes("WITH candidate_counts AS")
    )?.[0] ?? "");
    for (const clause of [
      "inventory.publication_status='PUBLISHED'",
      "inventory.fit_decision='eligible'",
      "inventory.contact_decision='eligible'",
      "inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'",
      "inventory.status IN ('ready','shown','accepted')",
      "recommendation.status IN ('ready','shown','accepted')",
      "AND inventory.visible_pool_generation=(",
      "inventory.contact_decision='pending'",
      "AND NOT EXISTS (",
    ]) {
      expect(stateQuery).toContain(clause);
    }
    expect(stateQuery).not.toContain(
      "FROM backlink_opportunities AS opportunity",
    );
    expect(stateQuery).toContain(
      "WHERE (job.organization_id,job.workspace_id,",
    );
    expect(stateQuery).toContain(
      "AND job.source_object_type='recommendation_context'",
    );
    expect(stateQuery).toContain(
      "ORDER BY job.created_at DESC,job.id DESC",
    );
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
      requestedCandidateCount: 100,
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

  it("waits for the existing contact batch before advancing tiers", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            contactPending: true,
            refillState: "waiting_contact",
            attemptedRefillTiers: [{
              tier: "exact_product_target_market",
              round: 1,
            }],
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

  it("does not declare the high watermark before contact work is terminal", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            publishedContactReadyCount: 20,
            contactPending: true,
            refillState: "waiting_contact",
            attemptedRefillTiers: [{
              tier: "exact_product_target_market",
              round: 1,
            }],
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
    expect(query.mock.calls.some(([, values]) =>
      values?.includes("HIGH_WATERMARK")
    )).toBe(false);
  });

  it("declares the high watermark after discovery and contact work are terminal", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("WITH candidate_counts AS")) {
        return {
          rows: [{
            ...inventoryState,
            publishedContactReadyCount: 20,
            inflight: false,
            contactPending: false,
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
    expect(commandValues?.[15]).toBe(9);
    expect(commandValues?.[19]).toBe("inventory_low");
    expect(inventoryStateQuery).toContain(
      "batch.raw_candidate_count,batch.eligible_candidate_count",
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

  it("advances after an unavailable provider window is fully settled", async () => {
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
      status: "queued",
      currentTier: "same_topic_target_market",
      currentRound: 4,
    });
    expect(commandValues?.[17]).toBe(
      "commercial-refill:"
        + `${input.websiteProjectId}:${input.projectContextVersionId}:g1:t2:r4:w2`,
    );
  });
});
