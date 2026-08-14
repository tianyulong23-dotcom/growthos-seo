import { describe, expect, it, vi } from "vitest";

import {
  reconcileRecommendationRefillOrphans,
  type RecommendationRefillWorkflowState,
} from "../../src/modules/backlinks/application/services/recommendation-refill-reconciliation.service.js";
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
const jobId = "50000000-0000-4000-8000-000000000034";
const workflowId =
  "backlinks:recommendation-refill:60000000-0000-4000-8000-000000000034";

function queryResult(
  rows: Record<string, unknown>[] = [],
): BacklinkTransactionQueryResult {
  return { rows, rowCount: rows.length };
}

function createPool(input: Readonly<{
  workflowIds?: readonly string[];
  hasLiveJob?: boolean;
  hasPendingOutbox?: boolean;
  hasLiveLease?: boolean;
  hasProviderSideEffect?: boolean;
}> = {}): Readonly<{
  pool: BacklinkTenantPool;
  queries: string[];
  state: { running: boolean };
}> {
  const queries: string[] = [];
  const state = { running: true };
  const client = {
    async query(text: string): Promise<BacklinkTransactionQueryResult> {
      queries.push(text);
      if (text.includes("WITH candidate_contexts AS")) {
        return state.running
          ? queryResult([{
              websiteProjectId: scope.websiteProjectId,
              projectContextVersionId: contextId,
              workflowExecutions: (input.workflowIds ?? []).map(
                (candidateWorkflowId) => ({
                  jobId,
                  workflowId: candidateWorkflowId,
                  status: input.hasLiveJob === true ? "running" : "failed",
                }),
              ),
              hasPendingOutbox: input.hasPendingOutbox ?? false,
              hasLiveLease: input.hasLiveLease ?? false,
              hasProviderSideEffect: input.hasProviderSideEffect ?? false,
            }])
          : queryResult();
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

function probe(state: RecommendationRefillWorkflowState) {
  return { inspect: vi.fn(async () => state) };
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
    expect(applySql[0]).toContain("backlink_recommendation_refills");
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
    expect(appliedSql).toContain("refill.refill_window_key||':%'");
    expect(appliedSql).toContain("usage.status='reserved'");
    expect(appliedSql).toContain(
      "request.status IN ('running','unknown_charge')",
    );
    expect(appliedSql).not.toContain("'^commercial-discovery:'");
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
