import { describe, expect, it, vi } from "vitest";

import {
  reconcileRecommendationRefillOrphans,
  type RecommendationRefillWorkflowState,
} from "../../src/modules/backlinks/application/services/recommendation-refill-reconciliation.service.js";
import type {
  RecommendationRefillSupersessionSignal,
} from "../../src/modules/backlinks/workflows/definitions/backlink-recommendation-refill.orchestration.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionQueryResult,
} from "../../src/modules/backlinks/db/tenant-transaction.js";

const scope = {
  organizationId: "10000000-0000-4000-8000-000000000034",
  workspaceId: "20000000-0000-4000-8000-000000000034",
  websiteProjectId: "30000000-0000-4000-8000-000000000034",
} as const;
const contextId = "40000000-0000-4000-8000-000000000034";
const latestContextId = "40000000-0000-4000-8000-000000000035";
const jobId = "50000000-0000-4000-8000-000000000034";
const secondJobId = "50000000-0000-4000-8000-000000000035";
const workflowId =
  "backlinks:recommendation-refill:60000000-0000-4000-8000-000000000034";
const secondWorkflowId =
  "backlinks:recommendation-refill:60000000-0000-4000-8000-000000000035";
const operation = { jobId, workflowId } as const;

function queryResult(
  rows: Record<string, unknown>[] = [],
): BacklinkTransactionQueryResult {
  return { rows, rowCount: rows.length };
}

function createPool(input: Readonly<{
  workflowIds?: readonly string[];
  workflowExecutions?: readonly Readonly<{
    jobId: string;
    workflowId: string;
    status: string;
  }>[];
  hasLiveJob?: boolean;
  jobState?: "running" | "failed";
  hasPendingOutbox?: boolean;
  hasLiveLease?: boolean;
  hasProviderSideEffect?: boolean;
  hasNewerAuthority?: boolean;
}> = {}): Readonly<{
  pool: BacklinkTenantPool;
  queries: string[];
  state: {
    running: boolean;
    supersessionRequested: boolean;
    compensated: boolean;
  };
}> {
  const queries: string[] = [];
  const state = {
    running: true,
    supersessionRequested: false,
    compensated: false,
  };
  const client = {
    async query(text: string): Promise<BacklinkTransactionQueryResult> {
      queries.push(text);
      if (text.includes("WITH candidate_contexts AS")) {
        return state.running
          ? queryResult([{
              websiteProjectId: scope.websiteProjectId,
              projectContextVersionId: contextId,
              state: input.jobState ?? "running",
              workflowExecutions: input.workflowExecutions
                ?? (input.workflowIds ?? []).map(
                  (candidateWorkflowId) => ({
                    jobId,
                    workflowId: candidateWorkflowId,
                    status: input.jobState === "failed"
                      ? "failed"
                      : input.hasLiveJob === true
                      ? "running"
                      : "failed",
                  }),
                ),
              hasPendingOutbox: input.hasPendingOutbox ?? false,
              hasLiveLease: input.hasLiveLease ?? false,
              hasProviderSideEffect: input.hasProviderSideEffect ?? false,
              currentContextVersionId: contextId,
              currentSnapshotVersion: 7,
              currentProfileVersionId: "profile-v3",
              currentPromotionTargetVersionId: "promotion-v2",
              currentGenerationInputFingerprint: "generation-v7",
              latestContextVersionId: input.hasNewerAuthority === true
                ? latestContextId
                : contextId,
              latestSnapshotVersion: input.hasNewerAuthority === true ? 8 : 7,
              latestProfileVersionId: input.hasNewerAuthority === true
                ? "profile-v4"
                : "profile-v3",
              latestPromotionTargetVersionId: "promotion-v2",
              latestGenerationInputFingerprint:
                input.hasNewerAuthority === true
                  ? "generation-v8"
                  : "generation-v7",
            }])
          : queryResult();
      }
      if (
        text.includes(
          "'recommendation_refill.supersession_requested'",
        )
      ) {
        const replayed = state.supersessionRequested;
        state.supersessionRequested = true;
        return queryResult([{ status: "requested", replayed }]);
      }
      if (text.includes("'recommendation_refill.superseded'")) {
        state.compensated = true;
        state.running = false;
        return queryResult([{ status: "cancelled", replayed: false }]);
      }
      if (text.includes("WITH orphan_jobs AS")) {
        state.running = false;
        return queryResult([{ applied: true, closedBatchCount: 1 }]);
      }
      return queryResult();
    },
    release() {},
  };
  return {
    pool: { connect: async () => client },
    queries,
    state,
  };
}

function probe(
  state: RecommendationRefillWorkflowState,
  initialSupersession: RecommendationRefillSupersessionSignal | null = null,
) {
  let supersession = initialSupersession;
  return {
    inspect: vi.fn(async () => state),
    readSupersession: vi.fn(async () => supersession),
    signalSuperseded: vi.fn(async (
      _workflowId: string,
      signal: RecommendationRefillSupersessionSignal,
    ) => {
      supersession = signal;
    }),
  };
}

describe("recommendation refill orphan reconciliation", () => {
  it("reports a locked dry-run without changing state", async () => {
    const fake = createPool({ workflowIds: [workflowId] });
    const workflowProbe = probe("closed");

    const result = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "dry-run",
      workflowProbe,
      now: () => new Date("2026-08-11T03:30:00.000Z"),
    });

    expect(result).toMatchObject({
      mode: "dry-run",
      scannedRunningCount: 1,
      projectCount: 1,
      plannedChangeCount: 1,
      appliedChangeCount: 0,
      entries: [{
        reason: "NO_LIVE_JOB_WORKFLOW_OR_LEASE",
        plannedAction: "RESET_RUNNING_TO_IDLE",
        applied: false,
      }],
    });
    expect(fake.state.running).toBe(true);
    expect(fake.queries.some((sql) =>
      sql.includes("pg_advisory_xact_lock")
    )).toBe(true);
    expect(fake.queries.some((sql) =>
      sql.includes("WITH orphan_jobs AS")
    )).toBe(false);
  });

  it("applies once and returns zero changes on a repeated apply", async () => {
    const fake = createPool();
    const workflowProbe = probe("missing");

    const first = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "apply",
      workflowProbe,
      now: () => new Date("2026-08-11T03:31:00.000Z"),
    });
    const second = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "apply",
      workflowProbe,
      now: () => new Date("2026-08-11T03:32:00.000Z"),
    });

    expect(first).toMatchObject({
      plannedChangeCount: 1,
      appliedChangeCount: 1,
    });
    expect(second).toMatchObject({
      scannedRunningCount: 0,
      projectCount: 0,
      plannedChangeCount: 0,
      appliedChangeCount: 0,
    });
    const applySql = fake.queries.filter((sql) =>
      sql.includes("WITH orphan_jobs AS")
    );
    expect(applySql).toHaveLength(1);
    expect(applySql[0]).toContain("provider_fetch_leases");
    expect(applySql[0]).toContain("backlink_outbox_events");
    expect(applySql[0]).toContain(
      "backlink_commercial_discovery_batches",
    );
    expect(applySql[0]).toContain("ORPHAN_REFILL_OPERATION");
    expect(applySql[0]).toContain("providerCallOccurred");
  });

  it("fails closed when Temporal reports an active workflow", async () => {
    const fake = createPool({ workflowIds: [workflowId] });
    const workflowProbe = probe("running");

    const result = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "apply",
      workflowProbe,
    });

    expect(result).toMatchObject({
      projectCount: 0,
      plannedChangeCount: 0,
      appliedChangeCount: 0,
      entries: [{
        reason: "LIVE_WORKFLOW",
        plannedAction: "NO_CHANGE",
      }],
    });
    expect(fake.state.running).toBe(true);
    expect(fake.queries.some((sql) =>
      sql.includes("WITH reconciled_policy AS")
    )).toBe(false);
    expect(workflowProbe.signalSuperseded).not.toHaveBeenCalled();
  });

  it("reports each superseded operation instead of collapsing a context", async () => {
    const fake = createPool({
      jobState: "failed",
      hasNewerAuthority: true,
      workflowExecutions: [
        { jobId, workflowId, status: "failed" },
        {
          jobId: secondJobId,
          workflowId: secondWorkflowId,
          status: "failed",
        },
      ],
    });

    const result = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "dry-run",
      workflowProbe: probe("closed"),
    });

    expect(result).toMatchObject({
      scannedRunningCount: 2,
      projectCount: 1,
      plannedChangeCount: 2,
      appliedChangeCount: 0,
      entries: [
        {
          jobId,
          workflowId,
          plannedAction: "COMPENSATE_SUPERSEDED_TERMINAL",
        },
        {
          jobId: secondJobId,
          workflowId: secondWorkflowId,
          plannedAction: "COMPENSATE_SUPERSEDED_TERMINAL",
        },
      ],
    });
  });

  it("requires an exact operation before supersession apply", async () => {
    const fake = createPool({
      workflowIds: [workflowId],
      jobState: "failed",
      hasNewerAuthority: true,
    });

    await expect(reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "apply",
      workflowProbe: probe("closed"),
    })).rejects.toThrow(
      "RECOMMENDATION_REFILL_RECONCILIATION_OPERATION_IDENTITY_REQUIRED",
    );
    expect(fake.state.supersessionRequested).toBe(false);
    expect(fake.state.compensated).toBe(false);
  });

  it("signals a live workflow owned by an older authoritative context", async () => {
    const fake = createPool({
      workflowIds: [workflowId],
      hasLiveJob: true,
      hasNewerAuthority: true,
    });
    const workflowProbe = probe("running");

    const result = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "apply",
      operation,
      workflowProbe,
      now: () => new Date("2026-08-19T03:30:00.000Z"),
    });

    expect(result).toMatchObject({
      projectCount: 1,
      plannedChangeCount: 1,
      appliedChangeCount: 1,
      entries: [{
        reason: "SUPERSEDED_LIVE_WORKFLOW",
        plannedAction: "SIGNAL_SUPERSEDE",
        applied: true,
      }],
    });
    expect(workflowProbe.signalSuperseded).toHaveBeenCalledOnce();
    expect(fake.state.supersessionRequested).toBe(true);
    const requestIndex = fake.queries.findIndex((sql) =>
      sql.includes("'recommendation_refill.supersession_requested'")
    );
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(workflowProbe.signalSuperseded).toHaveBeenCalledWith(
      workflowId,
      expect.objectContaining({
        contractVersion: 1,
        ...scope,
        jobId,
        workflowId,
        oldContext: expect.objectContaining({
          contextVersionId: contextId,
          snapshotVersion: 7,
          generationInputFingerprint: "generation-v7",
        }),
        authoritativeContext: expect.objectContaining({
          contextVersionId: latestContextId,
          snapshotVersion: 8,
          generationInputFingerprint: "generation-v8",
        }),
      }),
    );
  });

  it("does not emit a duplicate signal after matching supersession is recorded", async () => {
    const fake = createPool({
      workflowIds: [workflowId],
      hasLiveJob: true,
      hasNewerAuthority: true,
    });
    const workflowProbe = probe("running");

    const first = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "apply",
      operation,
      workflowProbe,
    });
    const second = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "apply",
      operation,
      workflowProbe,
    });

    expect(first.entries[0]).toMatchObject({
      plannedAction: "SIGNAL_SUPERSEDE",
      applied: true,
    });
    expect(second).toMatchObject({
      projectCount: 0,
      plannedChangeCount: 0,
      appliedChangeCount: 0,
      entries: [{
        reason: "SUPERSEDED_LIVE_WORKFLOW_SIGNALLED",
        plannedAction: "AWAIT_SUPERSEDED_TERMINAL",
        applied: false,
      }],
    });
    expect(workflowProbe.signalSuperseded).toHaveBeenCalledOnce();
  });

  it("replaces a mismatched pin signal with the authoritative identity", async () => {
    const fake = createPool({
      workflowIds: [workflowId],
      hasLiveJob: true,
      hasNewerAuthority: true,
    });
    const mismatched: RecommendationRefillSupersessionSignal = {
      contractVersion: 1,
      ...scope,
      jobId,
      workflowId,
      oldContext: {
        contextVersionId: contextId,
        snapshotVersion: 7,
        profileVersionId: "profile-v3",
        promotionTargetVersionId: "promotion-v2",
        generationInputFingerprint: "wrong-generation-v7",
      },
      authoritativeContext: {
        contextVersionId: latestContextId,
        snapshotVersion: 8,
        profileVersionId: "profile-v4",
        promotionTargetVersionId: "promotion-v2",
        generationInputFingerprint: "wrong-generation-v8",
      },
      actorId: "local-product-034",
      correlationId: "wrong",
      requestId: "wrong",
      idempotencyKey:
        `recommendation-refill.supersede:${jobId}:${latestContextId}`,
      lifecycleEventId: "70000000-0000-4000-8000-000000000034",
      auditEventId: "80000000-0000-4000-8000-000000000034",
    };
    const workflowProbe = probe("running", mismatched);

    const result = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "apply",
      operation,
      workflowProbe,
    });

    expect(result.entries[0]).toMatchObject({
      reason: "SUPERSEDED_LIVE_WORKFLOW",
      plannedAction: "SIGNAL_SUPERSEDE",
      applied: true,
    });
    expect(workflowProbe.signalSuperseded).toHaveBeenCalledWith(
      workflowId,
      expect.objectContaining({
        oldContext: expect.objectContaining({
          generationInputFingerprint: "generation-v7",
        }),
        authoritativeContext: expect.objectContaining({
          generationInputFingerprint: "generation-v8",
        }),
      }),
    );
  });

  it("fails a database-live job after Temporal reports it closed", async () => {
    const fake = createPool({
      workflowIds: [workflowId],
      hasLiveJob: true,
    });

    const result = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-038",
      mode: "apply",
      workflowProbe: probe("closed"),
    });

    expect(result).toMatchObject({
      plannedChangeCount: 1,
      appliedChangeCount: 1,
      entries: [{
        reason: "NO_LIVE_JOB_WORKFLOW_OR_LEASE",
        plannedAction: "RESET_RUNNING_TO_IDLE",
        applied: true,
      }],
    });
    expect(fake.state.running).toBe(false);
    const appliedSql = fake.queries.find((sql) =>
      sql.includes("WITH orphan_jobs AS")
    );
    expect(appliedSql).not.toContain("'commercial-refill:'");
    expect(appliedSql).toContain("batch.refill_job_id");
    expect(appliedSql).toContain("regexp_replace(");
    expect(appliedSql).toContain("batch.idempotency_key");
    expect(appliedSql).not.toContain("refill.refill_window_key");
    expect(appliedSql).toContain("usage.status='reserved'");
    expect(appliedSql).toContain(
      "request.status IN ('running','unknown_charge')",
    );
    expect(appliedSql).toContain("'^commercial-discovery:'");
  });

  it("compensates a closed failed job owned by an older context once", async () => {
    const fake = createPool({
      workflowIds: [workflowId],
      jobState: "failed",
      hasNewerAuthority: true,
    });
    const workflowProbe = probe("closed");

    const first = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "apply",
      operation,
      workflowProbe,
    });
    const second = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "apply",
      operation,
      workflowProbe,
    });

    expect(first.entries[0]).toMatchObject({
      reason: "SUPERSEDED_FAILED_WORKFLOW",
      plannedAction: "COMPENSATE_SUPERSEDED_TERMINAL",
      applied: true,
    });
    expect(fake.state.supersessionRequested).toBe(true);
    expect(fake.state.compensated).toBe(true);
    expect(second).toMatchObject({
      scannedRunningCount: 0,
      plannedChangeCount: 0,
      appliedChangeCount: 0,
    });
    expect(workflowProbe.signalSuperseded).not.toHaveBeenCalled();
  });

  it.each([
    ["PENDING_WORKFLOW_START", { hasPendingOutbox: true }],
    ["LIVE_PROVIDER_LEASE", { hasLiveLease: true }],
    ["PROVIDER_SIDE_EFFECT", { hasProviderSideEffect: true }],
  ] as const)("does not compensate a failed state blocked by %s", async (
    reason,
    blockers,
  ) => {
    const fake = createPool({
      workflowIds: [workflowId],
      jobState: "failed",
      hasNewerAuthority: true,
      ...blockers,
    });

    const result = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "apply",
      operation,
      workflowProbe: probe("closed"),
    });

    expect(result.entries[0]).toMatchObject({
      reason,
      plannedAction: "NO_CHANGE",
      applied: false,
    });
    expect(fake.state.supersessionRequested).toBe(false);
    expect(fake.state.compensated).toBe(false);
  });

  it.each([
    ["PENDING_WORKFLOW_START", { hasPendingOutbox: true }],
    ["LIVE_PROVIDER_LEASE", { hasLiveLease: true }],
    ["PROVIDER_SIDE_EFFECT", { hasProviderSideEffect: true }],
  ] as const)("does not change a state blocked by %s", async (
    reason,
    blockers,
  ) => {
    const fake = createPool(blockers);

    const result = await reconcileRecommendationRefillOrphans({
      pool: fake.pool,
      scope,
      actorId: "local-product-034",
      mode: "apply",
      workflowProbe: probe("missing"),
    });

    expect(result.entries[0]).toMatchObject({
      reason,
      plannedAction: "NO_CHANGE",
      applied: false,
    });
    expect(fake.state.running).toBe(true);
    expect(fake.queries.some((sql) =>
      sql.includes("WITH orphan_jobs AS")
    )).toBe(false);
  });
});
