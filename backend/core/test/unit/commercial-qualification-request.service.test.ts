import { describe, expect, it, vi } from "vitest";

import {
  createGovernedCommercialQualificationRuntime,
  type CommercialQualificationRequestStore,
} from "../../src/modules/backlinks/application/services/commercial-qualification-request.service.js";
import { DataForSeoCallBlockedError } from "../../src/modules/backlinks/application/policies/dataforseo-call.policy.js";
import type {
  CommercialQualificationBulkCall,
  CommercialQualificationBulkResponse,
} from "../../src/modules/backlinks/application/services/commercial-qualification-bulk.service.js";

const call: CommercialQualificationBulkCall = {
  kind: "traffic",
  endpoint: "/v3/dataforseo_labs/google/bulk_traffic_estimation/live",
  targets: ["publisher.com"],
  body: [{ targets: ["publisher.com"] }],
  requestFingerprint: "a".repeat(64),
};

const completed: CommercialQualificationBulkResponse = {
  status: "completed",
  body: { tasks: [{ result: [{ items: [] }] }] },
  providerRequestId: "provider-request-1",
  costMicros: 25_000,
};

const operationId = "00000000-0000-4000-8000-000000000004";
const budgetReservationPrefix =
  `commercial-refill-operation:${operationId}`;

function dependencies(
  acquire: CommercialQualificationRequestStore["acquire"],
) {
  const gate = {
    preflight: vi.fn(async () => undefined),
    authorize: vi.fn(async () => undefined),
  };
  const provider = { execute: vi.fn(async () => completed) };
  const store: CommercialQualificationRequestStore = {
    acquire,
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
  const runtime = createGovernedCommercialQualificationRuntime({
    context: {
      organizationId: "00000000-0000-4000-8000-000000000001",
      workspaceId: "00000000-0000-4000-8000-000000000002",
      websiteProjectId: "00000000-0000-4000-8000-000000000003",
    },
    operationId,
    budgetReservationPrefix,
    estimatedCostMicros: 50_000,
    provider,
    gate,
    store,
    now: () => new Date("2026-08-17T05:00:00.000Z"),
  });
  return { gate, provider, runtime, store };
}

describe("commercial qualification governed request service", () => {
  it.each(["dispatch", "settlement"])("quarantines %s exceptions after dispatch instead of allowing a paid retry", async stage => {
    const items = dependencies(async () => ({
      state: "started",
      batchRequestId: "00000000-0000-4000-8000-000000000014",
    }));
    if (stage === "dispatch") items.provider.execute.mockRejectedValueOnce(new Error("network interrupted"));
    else vi.mocked(items.store.complete).mockRejectedValueOnce(new Error("receipt write interrupted"));
    await expect(items.runtime.execute(call)).rejects.toThrow("interrupted");
    expect(items.store.fail).toHaveBeenCalledWith(expect.objectContaining({ status: "unknown_charge" }));
  });
  it("authorizes, dispatches and settles one new paid request", async () => {
    const items = dependencies(async () => ({
      state: "started",
      batchRequestId: "00000000-0000-4000-8000-000000000010",
    }));

    await expect(items.runtime.execute(call)).resolves.toEqual(completed);
    expect(items.gate.preflight).toHaveBeenCalledOnce();
    expect(items.gate.authorize).toHaveBeenCalledOnce();
    expect(items.provider.execute).toHaveBeenCalledOnce();
    expect(items.store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        response: completed,
        context: expect.objectContaining({
          requestId: [
            "commercial-qualification-v4",
            operationId,
            call.kind,
            call.requestFingerprint,
          ].join(":"),
          idempotencyKey: [
            "commercial-qualification-v4",
            operationId,
            call.kind,
            call.requestFingerprint,
          ].join(":"),
          budgetReservationId: [
            budgetReservationPrefix,
            "qualification",
            call.kind,
            call.requestFingerprint,
          ].join(":"),
        }),
      }),
    );
    expect(items.store.fail).not.toHaveBeenCalled();
  });

  it("reuses a completed exact fingerprint without a gate or provider call", async () => {
    const cached = { ...completed, costMicros: 0 };
    const items = dependencies(async () => ({
      state: "cached",
      response: cached,
    }));

    await expect(items.runtime.execute(call)).resolves.toEqual(cached);
    expect(items.gate.preflight).toHaveBeenCalledOnce();
    expect(items.gate.authorize).not.toHaveBeenCalled();
    expect(items.provider.execute).not.toHaveBeenCalled();
    expect(items.store.complete).not.toHaveBeenCalled();
  });

  it("does not resend an exact fingerprint quarantined as unknown charge", async () => {
    const items = dependencies(async () => ({
      state: "blocked",
      reason: "unknown_charge",
    }));

    await expect(items.runtime.execute(call)).resolves.toMatchObject({
      status: "unknown_charge",
      costMicros: 0,
    });
    expect(items.gate.preflight).toHaveBeenCalledOnce();
    expect(items.gate.authorize).not.toHaveBeenCalled();
    expect(items.provider.execute).not.toHaveBeenCalled();
  });

  it("persists an ambiguous dispatched request as unknown charge", async () => {
    const items = dependencies(async () => ({
      state: "started",
      batchRequestId: "00000000-0000-4000-8000-000000000011",
    }));
    items.provider.execute.mockResolvedValueOnce({
      status: "unknown_charge",
      body: null,
      providerRequestId: null,
      costMicros: 0,
    });

    await expect(items.runtime.execute(call)).resolves.toMatchObject({
      status: "unknown_charge",
    });
    expect(items.store.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "unknown_charge",
        failureCode: "DATAFORSEO_QUALIFICATION_UNKNOWN_CHARGE",
      }),
    );
    expect(items.store.complete).not.toHaveBeenCalled();
  });

  it("blocks before creating a batch when preflight denies the operation", async () => {
    const acquire = vi.fn(async () => ({
      state: "started" as const,
      batchRequestId: "00000000-0000-4000-8000-000000000013",
    }));
    const items = dependencies(acquire);
    items.gate.preflight.mockRejectedValueOnce(
      new DataForSeoCallBlockedError("QUOTA_EXCEEDED", "quota"),
    );

    await expect(items.runtime.execute(call)).resolves.toEqual({
      status: "unavailable",
      body: null,
      providerRequestId: null,
      costMicros: 0,
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(items.gate.authorize).not.toHaveBeenCalled();
    expect(items.provider.execute).not.toHaveBeenCalled();
    expect(items.store.fail).not.toHaveBeenCalled();
  });

  it("records a blocked gate as unavailable without dispatching the provider", async () => {
    const items = dependencies(async () => ({
      state: "started",
      batchRequestId: "00000000-0000-4000-8000-000000000012",
    }));
    items.gate.authorize.mockRejectedValueOnce(
      new DataForSeoCallBlockedError("BUDGET_EXCEEDED", "budget"),
    );

    await expect(items.runtime.execute(call)).resolves.toEqual({
      status: "unavailable",
      body: null,
      providerRequestId: null,
      costMicros: 0,
    });
    expect(items.provider.execute).not.toHaveBeenCalled();
    expect(items.store.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        failureCode: "Data provider budget is exceeded",
      }),
    );
  });
});
