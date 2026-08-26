import { describe, expect, it } from "vitest";

import {
  reserveRecommendationRefillJob,
  type RecommendationRefillReservationClient,
} from "../../src/modules/backlinks/application/services/recommendation-refill-reservation.service.js";

const input = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  websiteProjectId: "33333333-3333-4333-8333-333333333333",
  recommendationContextVersionId: "55555555-5555-4555-8555-555555555555",
  visiblePoolGeneration: 1,
  jobId: "44444444-4444-4444-8444-444444444444",
  targetPublishedCount: 10,
} as const;

function clientWithRows(
  rowsByQuery: readonly (readonly Record<string, unknown>[])[],
): Readonly<{
  client: RecommendationRefillReservationClient;
  queries: string[];
}> {
  const queries: string[] = [];
  let index = 0;
  return {
    queries,
    client: {
      async query(text) {
        queries.push(text);
        return { rows: rowsByQuery[index++] ?? [] };
      },
    },
  };
}

describe("recommendation refill reservation", () => {
  it("starts a queued job without incrementing its retry count", async () => {
    const fixture = clientWithRows([
      [{ visiblePoolGeneration: 1, visiblePoolState: "building" }],
      [{ count: 0 }],
      [{
        status: "queued",
        retry_count: 0,
        refill_window_key: "commercial-refill:project:context:t1:r1:w1",
      }],
      [{ id: input.jobId }],
    ]);

    await expect(
      reserveRecommendationRefillJob(fixture.client, input),
    ).resolves.toEqual({
      status: "started",
      readyCount: 0,
      jobId: input.jobId,
    });
    expect(fixture.queries[3]).toContain(
      "retry_count=retry_count+$5::integer",
    );
    expect(fixture.queries[0]).toContain(
      "project_context_version_id)=($1,$2,$3,$4)",
    );
    expect(fixture.queries[0]).toContain(
      "contract.score_model_version=",
    );
    expect(fixture.queries[0]).toContain(
      "'recommendation-commercial-fit.v4'",
    );
    for (const clause of [
      "inventory.fit_decision='eligible'",
      "inventory.status IN ('ready','shown','accepted')",
      "recommendation.status IN ('ready','shown','accepted')",
      "inventory.visible_pool_generation=$5",
    ]) {
      expect(fixture.queries[1]).toContain(clause);
    }
    expect(fixture.queries[1]).not.toContain(
      "FROM backlink_opportunities AS opportunity",
    );
    expect(fixture.queries[1]).toContain(
      "contract.score_model_version=",
    );
    expect(fixture.queries[1]).toContain(
      "'recommendation-commercial-fit.v4'",
    );
    expect(fixture.queries[3]).toContain("'providerOperationId'");
    expect(fixture.queries[3]).toContain(
      "'providerBudgetAuthorization'",
    );
    expect(fixture.queries[3]).toContain("'supplyMode'");
    expect(fixture.queries[3]).not.toContain("ELSE NULL");
  });

  it.each([
    [0, "started"],
    [1, "started"],
    [9, "started"],
    [10, "inventory_sufficient"],
    [11, "inventory_sufficient"],
  ] as const)(
    "treats %i published candidates as %s for the fixed ten target",
    async (readyCount, status) => {
      const fixture = clientWithRows([
        [{ visiblePoolGeneration: 1, visiblePoolState: "building" }],
        [{ count: readyCount }],
        [{
          status: "queued",
          retry_count: 0,
          refill_window_key: "commercial-refill:project:context:g1:t1:r1:w1",
        }],
        [{ id: input.jobId }],
      ]);

      await expect(
        reserveRecommendationRefillJob(fixture.client, input),
      ).resolves.toMatchObject({ status, readyCount });
    },
  );

  it.each([0, 1, 2, 3, 4, 5])(
    "retries the same failed job at retry count %i, including pre-batch accepted tasks",
    async (retryCount) => {
    const fixture = clientWithRows([
      [{ visiblePoolGeneration: 1, visiblePoolState: "building" }],
      [{ count: 0 }],
      [{
        status: "failed",
        retry_count: retryCount,
        refill_window_key: "commercial-refill:project:context:t1:r1:w1",
      }],
      [{ recoverable: true }],
      [{ id: input.jobId }],
    ]);

    await expect(
      reserveRecommendationRefillJob(fixture.client, input),
    ).resolves.toEqual({
      status: "started",
      readyCount: 0,
      jobId: input.jobId,
    });
    expect(fixture.queries[3]).toContain("provider_batch_requests");
    expect(fixture.queries[3]).toContain(
      "backlink_provider_usage_ledger",
    );
    expect(fixture.queries[3]).toContain(
      "usage.status='reserved'",
    );
    expect(fixture.queries[3]).toContain(
      "request.status IN ('running','unknown_charge')",
    );
    expect(fixture.queries[3]).toContain(
      "request.provider_task_id IS NOT NULL",
    );
    expect(fixture.queries[3]).toContain(
      "lease.status='unknown_charge'",
    );
    expect(fixture.queries[3]).toContain(
      "lease.lease_expires_at<=now()",
    );
    expect(fixture.queries[3]).toContain(
      "usage.reservation_key=request.budget_reservation_id",
    );
    expect(fixture.queries[3]).not.toContain("request.status='failed'");
    const acceptedRecoverySql =
      fixture.queries[3]?.split(
        "completed_provider_checkpoint AS MATERIALIZED",
      )[0] ?? "";
    expect(acceptedRecoverySql).toContain(
      "FROM backlink_jobs AS failed_job",
    );
    expect(acceptedRecoverySql).toContain(
      "JOIN backlink_recommendation_refills AS failed_refill",
    );
    expect(acceptedRecoverySql).toContain(
      "failed_refill.recommendation_context_version_id=$5",
    );
    expect(acceptedRecoverySql).toContain(
      "failed_refill.visible_pool_generation=$6",
    );
    expect(acceptedRecoverySql).toContain(
      "request.request_id LIKE failed_refill.refill_window_key||':%'",
    );
    expect(acceptedRecoverySql).toContain(
      "'commercial-refill-operation:'||failed_job.id::text||",
    );
    expect(acceptedRecoverySql).toContain(
      "':discovery:'||failed_refill.refill_window_key||':%'",
    );
    expect(acceptedRecoverySql).toContain(
      "request.created_at>=failed_job.created_at",
    );
    expect(acceptedRecoverySql).toContain(
      "backlink_commercial_discovery_blueprints AS blueprint",
    );
    expect(acceptedRecoverySql).toContain(
      "{__growthosDiscoveryPlannerLineage,blueprintId}",
    );
    expect(acceptedRecoverySql).toContain(
      "{__growthosDiscoveryPlannerLineage,queryId}",
    );
    expect(acceptedRecoverySql).toContain("~'^[0-9a-f]{64}$'");
    expect(acceptedRecoverySql).toContain(
      "conflicting.refill_job_id<>failed_job.id",
    );
    expect(acceptedRecoverySql).not.toContain(
      "FROM backlink_commercial_discovery_batches AS batch",
    );
    expect(acceptedRecoverySql).not.toContain("batch.refill_job_id=$4");
    expect(fixture.queries[3]).toContain(
      "backlink_commercial_discovery_batches",
    );
    expect(fixture.queries[3]).toContain("batch.refill_job_id=$4");
    expect(fixture.queries[3]).toContain(
      "batch.project_context_version_id=$5",
    );
    expect(fixture.queries[3]).toContain(
      "batch.visible_pool_generation=$6",
    );
    expect(fixture.queries[3]).toContain("request.request_id LIKE");
    expect(fixture.queries[3]).toContain("batch.idempotency_key");
    expect(fixture.queries[3]).toContain("'^commercial-discovery:'");
    expect(fixture.queries[3]).toContain(
      "'commercial-refill:'||$3::text||':'||$5::text||",
    );
    expect(fixture.queries[3]).toContain(
      "':g'||$6::text||':%'",
    );
    expect(fixture.queries[4]).toContain("'providerOperationId'");
    expect(fixture.queries[4]).toContain(
      "'providerBudgetAuthorization'",
    );
    expect(fixture.queries[4]).toContain("'supplyMode'");
    expect(fixture.queries[4]).not.toContain("ELSE NULL");
    },
  );

  it.each([
    ["a provider side effect is ambiguous", 0, false],
  ])("does not retry when %s", async (_label, retryCount, recoverable) => {
    const rows = [
      [{ visiblePoolGeneration: 1, visiblePoolState: "building" }],
      [{ count: 0 }],
      [{
        status: "failed",
        retry_count: retryCount,
        refill_window_key: "commercial-refill:project:context:t1:r1:w1",
      }],
      [{ recoverable }],
    ];
    const fixture = clientWithRows(rows);

    await expect(
      reserveRecommendationRefillJob(fixture.client, input),
    ).resolves.toEqual({
      status: "already_started",
      readyCount: 0,
      jobId: input.jobId,
    });
    expect(fixture.queries).toHaveLength(4);
  });

  it("does not retry an exhausted job after checkpoint recovery was attempted", async () => {
    const fixture = clientWithRows([
      [{ visiblePoolGeneration: 1, visiblePoolState: "building" }],
      [{ count: 0 }],
      [{
        status: "failed",
        retry_count: 6,
        result_summary: {
          completedProviderCheckpointRecoveryAttempted: true,
        },
      }],
    ]);

    await expect(
      reserveRecommendationRefillJob(fixture.client, input),
    ).resolves.toEqual({
      status: "already_started",
      readyCount: 0,
      jobId: input.jobId,
    });
    expect(fixture.queries).toHaveLength(3);
  });

  it("does not retry an exhausted job without a completed provider checkpoint", async () => {
    const fixture = clientWithRows([
      [{ visiblePoolGeneration: 1, visiblePoolState: "building" }],
      [{ count: 0 }],
      [{
        status: "failed",
        retry_count: 6,
        result_summary: {},
      }],
      [{
        recoverable: true,
        completedProviderCheckpoint: false,
      }],
    ]);

    await expect(
      reserveRecommendationRefillJob(fixture.client, input),
    ).resolves.toEqual({
      status: "already_started",
      readyCount: 0,
      jobId: input.jobId,
    });
    expect(fixture.queries).toHaveLength(4);
  });

  it("allows one recovery from a completed provider checkpoint at the retry cap", async () => {
    const fixture = clientWithRows([
      [{ visiblePoolGeneration: 1, visiblePoolState: "building" }],
      [{ count: 0 }],
      [{
        status: "failed",
        retry_count: 6,
        result_summary: {},
      }],
      [{
        recoverable: true,
        completedProviderCheckpoint: true,
      }],
      [{ id: input.jobId }],
    ]);

    await expect(
      reserveRecommendationRefillJob(fixture.client, input),
    ).resolves.toEqual({
      status: "started",
      readyCount: 0,
      jobId: input.jobId,
    });
    expect(fixture.queries).toHaveLength(5);
    expect(fixture.queries[3]).toContain(
      "completed_provider_checkpoint",
    );
    expect(fixture.queries[3]).toContain(
      "provider_request.status='succeeded'",
    );
    expect(fixture.queries[3]).toContain("usage.status='settled'");
    expect(fixture.queries[3]).toContain("lease.status='completed'");
    expect(fixture.queries[4]).toContain(
      "completedProviderCheckpointRecoveryAttempted",
    );
  });

  it("allows a bounded recovery after a reconciled provider failure", async () => {
    const fixture = clientWithRows([
      [{ visiblePoolGeneration: 1, visiblePoolState: "building" }],
      [{ count: 0 }],
      [{
        status: "failed",
        retry_count: 3,
        refill_window_key: "commercial-refill:project:context:t1:r1:w1",
      }],
      [{ recoverable: true }],
      [{ id: input.jobId }],
    ]);

    await expect(
      reserveRecommendationRefillJob(fixture.client, input),
    ).resolves.toEqual({
      status: "started",
      readyCount: 0,
      jobId: input.jobId,
    });
    expect(fixture.queries).toHaveLength(5);
  });
});
