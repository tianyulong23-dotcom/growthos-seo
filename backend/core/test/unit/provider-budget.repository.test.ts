import { describe, expect, it } from "vitest";

import {
  resolveProviderBudgetOperationReservationScope,
  createProviderBudgetRepository,
  type ProviderBudgetReservationInput,
} from "../../src/modules/backlinks/db/repositories/provider-budget.repository.js";

const reservation: ProviderBudgetReservationInput = Object.freeze({
  context: Object.freeze({
    organizationId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    websiteProjectId: "33333333-3333-4333-8333-333333333333",
    requestId: "44444444-4444-4444-8444-444444444444",
    idempotencyKey: "fixture-idempotency-key",
    budgetReservationId: "44444444-4444-4444-8444-444444444444",
  }),
  provider: "dataforseo",
  requestFingerprint: "a".repeat(64),
  reservationKey: "44444444-4444-4444-8444-444444444444",
  estimatedCostMicros: 27_600,
});

describe("provider cumulative execution ceiling", () => {
  const startedAt = "2026-09-08T02:00:00Z";
  const now = () => new Date("2026-09-08T03:00:00Z");
  const input = { ...reservation, estimatedCostMicros: 600 };

  function fixture(exposureMicros: number, alreadyReserved = false) {
    const statements: string[] = [];
    const parameters: unknown[][] = [];
    const client = {
      async query(sql: string, values?: readonly unknown[]) {
        statements.push(sql);
        parameters.push([...(values ?? [])]);
        return { rows: sql.includes('AS "exposureMicros"')
          ? [{ exposureMicros, alreadyReserved }] : [{}] };
      },
    };
    return {
      statements, parameters,
      repository: createProviderBudgetRepository(client, now, {
        startedAt, limitMicros: 16_800,
      }),
    };
  }

  it("locks and counts all projects before reserving exactly the remaining cap", async () => {
    const test = fixture(16_200);
    expect(await test.repository.reserveBudget(input)).toBe("allow");
    expect(test.statements[0]).toContain("pg_advisory_xact_lock");
    expect(test.statements[1]).toContain("OR status='reserved'");
    expect(test.statements[1]).not.toContain("WHERE website_project_id");
    expect(test.parameters[1]?.[5]).toEqual(new Date(startedAt));
    expect(test.statements[2]).toContain("backlink_reserve_provider_cost");
  });

  it.each([16_201, 16_800, Number.NaN, -1])(
    "denies excess or invalid exposure %s without reserving",
    async (exposure) => {
      const test = fixture(exposure);
      expect(await test.repository.reserveBudget(input)).toBe("deny");
      expect(test.statements).toHaveLength(2);
    },
  );

  it("does not count an existing reservation twice", async () => {
    const test = fixture(16_800, true);
    expect(await test.repository.reserveBudget(input)).toBe("allow");
  });

  it("fails closed for a future authorization window", async () => {
    const repository = createProviderBudgetRepository({
      async query() { throw new Error("must not reserve"); },
    }, now, { startedAt: "2026-09-09T00:00:00Z", limitMicros: 16_800 });
    expect(await repository.reserveBudget(input)).toBe("deny");
  });
});

describe("provider budget operation reservation scope", () => {
  it("accepts a bounded V2 request intent as an exact operation key", () => {
    expect(resolveProviderBudgetOperationReservationScope({
      reservation,
      operationPrefix: "commercial-refill-operation:job-id",
      authorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 1,
        maxCostMicros: 1_000_000,
        authorizedBy: "fixture-user",
      },
    })).toEqual({
      mode: "v2_intent",
      ledgerPrefix: reservation.reservationKey,
    });
  });

  it("keeps ordinary operation budgets restricted to their prefix", () => {
    expect(resolveProviderBudgetOperationReservationScope({
      reservation: {
        ...reservation,
        context: {
          ...reservation.context,
          requestId: "fixture-request",
          budgetReservationId:
            "commercial-refill-operation:job-id:discovery:1",
        },
        reservationKey: "commercial-refill-operation:job-id:discovery:1",
      },
      operationPrefix: "commercial-refill-operation:job-id",
    })).toEqual({
      mode: "prefix",
      ledgerPrefix: "commercial-refill-operation:job-id:",
    });
  });

  it("rejects an unbound exact key", () => {
    expect(resolveProviderBudgetOperationReservationScope({
      reservation: {
        ...reservation,
        context: {
          ...reservation.context,
          budgetReservationId: "different-reservation",
        },
      },
      operationPrefix: "commercial-refill-operation:job-id",
      authorization: {
        provider: "dataforseo",
        reasonCode: "user_authorized_bounded_real_refill",
        maxPaidCalls: 1,
        maxCostMicros: 1_000_000,
        authorizedBy: "fixture-user",
      },
    })).toBeNull();
  });
});
