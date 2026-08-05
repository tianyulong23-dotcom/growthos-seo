import { describe, expect, it } from "vitest";

import {
  reserveRecommendationRefillJob,
  type RecommendationRefillReservationClient,
} from "../../src/modules/backlinks/application/services/recommendation-refill-reservation.service.js";

const input = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  websiteProjectId: "33333333-3333-4333-8333-333333333333",
  jobId: "44444444-4444-4444-8444-444444444444",
  lowWatermark: 20,
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
      [{ count: 0 }],
      [{ status: "queued", retry_count: 0 }],
      [{ id: input.jobId }],
    ]);

    await expect(
      reserveRecommendationRefillJob(fixture.client, input),
    ).resolves.toEqual({
      status: "started",
      readyCount: 0,
      jobId: input.jobId,
    });
    expect(fixture.queries[2]).toContain(
      "retry_count=retry_count+$5::integer",
    );
  });

  it.each([0, 1])(
    "retries the same failed job at retry count %i when no provider side effect exists",
    async (retryCount) => {
    const fixture = clientWithRows([
      [{ count: 0 }],
      [{ status: "failed", retry_count: retryCount }],
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
    expect(fixture.queries[2]).toContain("provider_batch_requests");
    expect(fixture.queries[2]).toContain(
      "backlink_provider_usage_ledger",
    );
    expect(fixture.queries[2]).toContain(
      "actual_cost_micros IS NOT NULL",
    );
    },
  );

  it.each([
    ["a provider side effect exists", 0, true],
    ["the failed job exhausted pre-provider recovery", 2, false],
  ])("does not retry when %s", async (_label, retryCount, blocked) => {
    const rows = [
      [{ count: 0 }],
      [{ status: "failed", retry_count: retryCount }],
      ...(retryCount < 2 ? [[{ blocked }]] : []),
    ];
    const fixture = clientWithRows(rows);

    await expect(
      reserveRecommendationRefillJob(fixture.client, input),
    ).resolves.toEqual({
      status: "already_started",
      readyCount: 0,
      jobId: input.jobId,
    });
    expect(fixture.queries).toHaveLength(retryCount < 2 ? 3 : 2);
  });
});
