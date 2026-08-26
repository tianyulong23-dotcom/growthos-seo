import { describe, expect, it, vi } from "vitest";

import {
  DataForSeoRequestService,
  type DataForSeoRequestCoordinator,
  type DataForSeoRequestStart,
} from "../../src/modules/backlinks/application/services/dataforseo-request.service.js";
import {
  DataForSeoCallPolicy,
  type DataForSeoGateDecision,
} from "../../src/modules/backlinks/application/policies/dataforseo-call.policy.js";
import type { BacklinkProviderSnapshot } from
  "../../src/modules/backlinks/ports/dataforseo.port.js";
const snapshot: BacklinkProviderSnapshot = {
  provider: "dataforseo",
  schemaVersion: "dataforseo.backlinks-referring-domains.v1",
  requestedAt: "2026-07-22T08:00:00.000Z", costMicros: 20_000,
  completedAt: "2026-07-22T08:00:01.000Z",
  payloadHash: "a".repeat(64),
  referringDomains: [],
};
const input = {
  context: {
    organizationId: "organization-1",
    workspaceId: "workspace-1",
    websiteProjectId: "project-1",
    requestId: "request-1",
    idempotencyKey: "analysis:project-1:profile-1",
    budgetReservationId: "reservation-1",
  },
  request: { target: "example.com", targetType: "domain" as const, limit: 100 },
  intent: "DISCOVERY" as const,
  refreshMode: "BACKGROUND_REFRESH" as const,
  execution: "BACKGROUND" as const,
  locationCode: "US",
  languageCode: "en-US",
  responseSchemaVersion: "dataforseo.backlinks-referring-domains.v1",
  usagePurpose: "project-analysis-discovery",
  projectContextVersion: 7,
  cacheSchemaVersion: 1,
  estimatedCostMicros: 20_000,
};
type Flight = { promise: Promise<BacklinkProviderSnapshot>;
  resolve(value: BacklinkProviderSnapshot): void; reject(error: unknown): void };
class MemoryCoordinator implements DataForSeoRequestCoordinator {
  readonly begin = vi.fn(async (start: DataForSeoRequestStart) => {
    const key = JSON.stringify(start.key);
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > start.now) {
      return { kind: "cache" as const, snapshot: cached.snapshot };
    }
    const active = this.flights.get(key);
    if (active !== undefined) {
      return { kind: "follower" as const, snapshot: active.promise };
    }
    let resolve!: Flight["resolve"];
    let reject!: Flight["reject"];
    const flight: Flight = {
      promise: new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      }),
      resolve: (value) => resolve(value),
      reject: (error) => reject(error),
    };
    void flight.promise.catch(() => undefined);
    this.flights.set(key, flight);
    return {
      kind: "leader" as const,
      complete: async (value: BacklinkProviderSnapshot) => {
        this.cache.set(key, { snapshot: value, expiresAt: start.freshUntil });
        this.flights.delete(key);
        flight.resolve(value);
      },
      fail: async (error: unknown) => {
        this.flights.delete(key);
        flight.reject(error);
      },
    };
  });
  private readonly cache = new Map<string, {
    snapshot: BacklinkProviderSnapshot; expiresAt: Date }>();
  private readonly flights = new Map<string, Flight>();
}
type GatePlan = Partial<Record<
  "availability" | "killSwitch" | "quota" | "budget",
  DataForSeoGateDecision | "error"
>>;
function createGate(plan: GatePlan = {}) {
  const decide = (outcome: DataForSeoGateDecision | "error" = "allow") =>
    async () => {
      if (outcome === "error") {
        throw new Error("gate unavailable");
      }
      return outcome;
    };
  return new DataForSeoCallPolicy({
    checkAvailability: async () => {
      if (plan.availability === "error") {
        throw new Error("availability unavailable");
      }
      return plan.availability === "deny"
        ? {
            decision: "deny" as const,
            reasonCode: "explicit_block",
            recoveryAction: "remove_explicit_block",
          }
        : { decision: "allow" as const };
    },
    checkKillSwitch: decide(plan.killSwitch),
    checkQuota: decide(plan.quota),
    reserveBudget: decide(plan.budget),
  });
}
function createService(
  fetchBacklinkSnapshot: () => Promise<BacklinkProviderSnapshot>,
  gatePlan: GatePlan = {},
  coordinator = new MemoryCoordinator(),
) {
  return {
    coordinator,
    service: new DataForSeoRequestService({
      coordinator,
      provider: { fetchBacklinkSnapshot },
      gate: createGate(gatePlan),
      now: () => new Date("2026-07-22T09:00:00.000Z"),
    }),
  };
}
describe("DataForSeoRequestService", () => {
  it("scopes the Provider Kill Switch to Backlinks and DataForSEO", async () => {
    const checkKillSwitch = vi.fn(async () => "allow" as const);
    const checkQuota = vi.fn(async () => "allow" as const);
    const reserveBudget = vi.fn(async () => "allow" as const);
    const policy = new DataForSeoCallPolicy({
      checkKillSwitch,
      checkQuota,
      reserveBudget,
    });

    await policy.authorize({
      context: input.context,
      requestFingerprint: "fingerprint-1",
      estimatedCostMicros: 20_000,
      requiredRemainingPaidCalls: 3,
      requiredRemainingCostMicros: 60_000,
    });

    expect(checkKillSwitch).toHaveBeenCalledWith({
      context: input.context,
      moduleId: "backlinks",
      providerId: "dataforseo",
      killSwitchKey: "backlinks.dataforseo.v1",
    });
    expect(checkQuota).toHaveBeenCalledWith({
      context: input.context,
      provider: "dataforseo",
      estimatedCostMicros: 20_000,
      requiredRemainingPaidCalls: 3,
      requiredRemainingCostMicros: 60_000,
    });
    expect(reserveBudget).toHaveBeenCalledWith({
      context: input.context,
      provider: "dataforseo",
      estimatedCostMicros: 20_000,
      requiredRemainingPaidCalls: 3,
      requiredRemainingCostMicros: 60_000,
      requestFingerprint: "fingerprint-1",
      reservationKey: "reservation-1",
    });
  });

  it("shares an active request and then serves the fresh cache", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async () => {
      await gate;
      return snapshot;
    });
    const { coordinator, service } = createService(fetch);

    const first = service.execute(input);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const second = service.execute(input);
    await vi.waitFor(() => expect(coordinator.begin).toHaveBeenCalledTimes(2));
    release();

    const [leader, follower] = await Promise.all([first, second]);
    const cached = await service.execute(input);
    expect([leader.source, follower.source]).toEqual(["provider", "single-flight"]);
    expect(cached.source).toBe("cache");
    const fingerprints = [leader, follower, cached]
      .map((item) => item.requestFingerprint);
    expect(new Set(fingerprints).size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("excludes private project versions but includes Provider parameters", async () => {
    const fetch = vi.fn(async () => snapshot);
    const { service } = createService(fetch);

    const results = await Promise.all([
      service.execute(input),
      service.execute({ ...input, projectContextVersion: 8 }),
      service.execute({ ...input, request: { ...input.request, limit: 200 } }),
    ]);

    const fingerprints = results.map((result) => result.requestFingerprint);
    expect(new Set(fingerprints).size).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("serves a historical cache entry while the Provider Kill Switch is closed", async () => {
    const coordinator = new MemoryCoordinator();
    const warmFetch = vi.fn(async () => snapshot);
    const warm = createService(warmFetch, {}, coordinator);
    await expect(warm.service.execute(input)).resolves.toMatchObject({
      source: "provider",
      snapshot,
    });

    const closedFetch = vi.fn(async () => snapshot);
    const closed = createService(
      closedFetch,
      { killSwitch: "deny" },
      coordinator,
    );
    await expect(closed.service.execute(input)).resolves.toMatchObject({
      source: "cache",
      snapshot,
    });
    expect(warmFetch).toHaveBeenCalledOnce();
    expect(closedFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["external availability", { availability: "deny" }, "PROVIDER_UNAVAILABLE"],
    ["Kill Switch", { killSwitch: "deny" }, "KILL_SWITCH_ACTIVE"],
    ["quota", { quota: "deny" }, "QUOTA_EXCEEDED"],
    ["budget", { budget: "deny" }, "BUDGET_EXCEEDED"],
    ["unavailable authority", { killSwitch: "error" }, "GATE_UNAVAILABLE"],
  ] as const)("blocks %s before the Provider call", async (_, plan, code) => {
    const fetch = vi.fn(async () => snapshot);
    const { service } = createService(fetch, plan);

    await expect(service.execute(input)).rejects.toMatchObject({ code });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks external unavailability before tenant gates and budget", async () => {
    const checkKillSwitch = vi.fn(async () => "allow" as const);
    const checkQuota = vi.fn(async () => "allow" as const);
    const reserveBudget = vi.fn(async () => "allow" as const);
    const policy = new DataForSeoCallPolicy({
      checkAvailability: async () => ({
        decision: "deny",
        reasonCode: "explicit_block",
        recoveryAction: "remove_explicit_block",
      }),
      checkKillSwitch,
      checkQuota,
      reserveBudget,
    });

    await expect(policy.authorize({
      context: input.context,
      requestFingerprint: "fingerprint-blocked",
      estimatedCostMicros: 20_000,
    })).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      stage: "availability",
      reasonCode: "explicit_block",
      recoveryAction: "remove_explicit_block",
      message:
        "Data provider is unavailable: explicit_block;"
        + " recovery=remove_explicit_block",
    });
    expect(checkKillSwitch).not.toHaveBeenCalled();
    expect(checkQuota).not.toHaveBeenCalled();
    expect(reserveBudget).not.toHaveBeenCalled();
  });
});
