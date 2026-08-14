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
    for (const clause of [
      "inventory.publication_status='PUBLISHED'",
      "inventory.fit_decision='eligible'",
      "inventory.contact_decision='eligible'",
      "inventory.contact_reason_code='PUBLIC_EMAIL_FOUND'",
      "inventory.verified_public_email_count>=1",
      "inventory.status IN ('ready','shown','accepted')",
      "recommendation.status IN ('ready','shown','accepted')",
      "inventory.visible_pool_generation=$5",
    ]) {
      expect(fixture.queries[1]).toContain(clause);
    }
    expect(fixture.queries[1]).not.toContain(
      "FROM backlink_opportunities AS opportunity",
    );
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
    "retries the same failed job at retry count %i when provider state is settled",
    async (retryCount) => {
    const fixture = clientWithRows([
      [{ visiblePoolGeneration: 1, visiblePoolState: "building" }],
      [{ count: 0 }],
      [{
        status: "failed",
        retry_count: retryCount,
        refill_window_key: "commercial-refill:project:context:t1:r1:w1",
      }],
      [{ blocked: false }],
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
      "lease.status='unknown_charge'",
    );
    expect(fixture.queries[3]).toContain(
      "lease.lease_expires_at>now()",
    );
    expect(fixture.queries[3]).not.toContain("request.status='failed'");
    expect(fixture.queries[3]).not.toContain(
      "backlink_commercial_discovery_batches",
    );
    expect(fixture.queries[3]).toContain(
      "usage.reservation_key LIKE $4||':%'",
    );
    },
  );

  it.each([
    ["a provider side effect exists", 0, true],
    ["the failed job exhausted recovery", 6, false],
  ])("does not retry when %s", async (_label, retryCount, blocked) => {
    const rows = [
      [{ visiblePoolGeneration: 1, visiblePoolState: "building" }],
      [{ count: 0 }],
      [{
        status: "failed",
        retry_count: retryCount,
        refill_window_key: "commercial-refill:project:context:t1:r1:w1",
      }],
      ...(retryCount < 6 ? [[{ blocked }]] : []),
    ];
    const fixture = clientWithRows(rows);

    await expect(
      reserveRecommendationRefillJob(fixture.client, input),
    ).resolves.toEqual({
      status: "already_started",
      readyCount: 0,
      jobId: input.jobId,
    });
    expect(fixture.queries).toHaveLength(retryCount < 6 ? 4 : 3);
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
      [{ blocked: false }],
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
