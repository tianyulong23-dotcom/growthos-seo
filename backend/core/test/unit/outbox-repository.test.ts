import { describe, expect, it, vi } from "vitest";

import {
  createOutboxRelayRepository,
  createOutboxRepository,
} from "../../src/modules/backlinks/db/repositories/outbox.repository.js";
import { recommendationRefillRequestedEventType } from "../../src/modules/backlinks/domain/recommendations/recommendation-pool-contract-guard.js";

describe("outbox recommendation refill claims", () => {
  it("claims only exact V1 generation events in a scoped transaction", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = createOutboxRepository({ query });

    await expect(
      repository.claim({
        workerId: "worker-1",
        limit: 10,
        eventType: recommendationRefillRequestedEventType,
      }),
    ).resolves.toEqual([]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain(
      "JOIN backlink_recommendation_generation_contracts",
    );
    expect(String(sql)).toContain(
      "JOIN backlink_recommendation_pool_project_contracts",
    );
    expect(String(sql)).toContain("recommendation-pool.v1");
    expect(String(sql)).toContain("migration_state='V1_ACTIVE'");
    expect(String(sql)).toContain(
      "backlink_recommendation_pool_v2_cutover_control",
    );
    expect(String(sql)).toContain("state='V1_WRITES_FROZEN'");
    expect(String(sql)).toContain("FOR UPDATE OF event SKIP LOCKED");
    expect(String(sql)).not.toContain("backlink_claim_outbox_events(");
    expect(values).toEqual([
      10,
      "worker-1",
      recommendationRefillRequestedEventType,
      null,
      null,
    ]);
  });

  it("routes global refill claims through the dedicated atomic function", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = createOutboxRelayRepository({ query });

    await expect(
      repository.claim({
        workerId: "worker-1",
        limit: 10,
        eventType: recommendationRefillRequestedEventType,
      }),
    ).resolves.toEqual([]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain(
      "backlink_claim_recommendation_refill_outbox_events(",
    );
    expect(String(sql)).not.toContain("backlink_claim_outbox_events(");
    expect(values).toEqual(["worker-1", 10, null]);
  });

  it("excludes recommendation refill events from an untyped generic claim", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = createOutboxRepository({ query });

    await expect(
      repository.claim({
        workerId: "worker-1",
        limit: 10,
      }),
    ).resolves.toEqual([]);

    const [sql, values] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("event_type<>$6");
    expect(values?.[5]).toBe(recommendationRefillRequestedEventType);
  });

  it("keeps untyped relay claims on the generic non-refill lane", async () => {
    const genericEvent = {
      eventId: "event-1",
      eventType: "backlinks.opportunity.created.v1",
    };
    const query = vi.fn(async () => ({ rows: [genericEvent] }));
    const repository = createOutboxRelayRepository({ query });

    await expect(
      repository.claim({
        workerId: "worker-1",
        limit: 10,
      }),
    ).resolves.toEqual([genericEvent]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("backlink_claim_outbox_events(");
    expect(String(sql)).not.toContain(
      "backlink_claim_recommendation_refill_outbox_events(",
    );
    expect(values).toEqual(["worker-1", 10, null, null]);
  });
});
