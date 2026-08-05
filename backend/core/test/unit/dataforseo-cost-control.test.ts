import { describe, expect, it, vi } from "vitest";

import {
  classifyProviderArtifactFreshness,
  createProviderArtifactFreshnessWindow,
} from "../../src/modules/backlinks/application/policies/provider-freshness.policy.js";
import {
  assertDataForSeoRequestIntent,
} from "../../src/modules/backlinks/application/policies/provider-request-intent.policy.js";
import {
  DataForSeoRequestService,
  type DataForSeoRequestCoordinator,
} from "../../src/modules/backlinks/application/services/dataforseo-request.service.js";
import {
  createProviderArtifactFingerprint,
} from "../../src/modules/backlinks/application/services/provider-artifact.service.js";
import {
  ProviderBulkRequestService,
  type DataForSeoBulkBatchStore,
  type DataForSeoBulkPort,
} from "../../src/modules/backlinks/application/services/provider-bulk-request.service.js";
import {
  decideRecommendationInventory,
  decideRecommendationSwap,
} from "../../src/modules/backlinks/application/services/recommendation-inventory.service.js";
import type {
  BacklinkProviderSnapshot,
} from "../../src/modules/backlinks/ports/dataforseo.port.js";

const now = new Date("2026-07-30T08:00:00.000Z");
const snapshot: BacklinkProviderSnapshot = {
  provider: "dataforseo",
  schemaVersion: "dataforseo.backlinks-referring-domains.v1",
  requestedAt: "2026-07-30T08:00:00.000Z",
  completedAt: "2026-07-30T08:00:01.000Z",
  costMicros: 10,
  payloadHash: "a".repeat(64),
  referringDomains: [],
};
const serviceInput = {
  context: {
    organizationId: "organization-1",
    workspaceId: "workspace-1",
    websiteProjectId: "project-1",
    requestId: "request-1",
    idempotencyKey: "request-1",
    budgetReservationId: "request-1",
  },
  request: {
    target: "Example.COM.",
    targetType: "domain" as const,
    limit: 100,
  },
  intent: "DISCOVERY" as const,
  refreshMode: "CACHE_PREFERRED" as const,
  execution: "BACKGROUND" as const,
  locationCode: "us",
  languageCode: "EN-us",
  responseSchemaVersion: "dataforseo.backlinks-referring-domains.v1",
  usagePurpose: "recommendation-discovery",
  projectContextVersion: 1,
  cacheSchemaVersion: 1,
  estimatedCostMicros: 10,
};
const bulkInput = {
  context: serviceInput.context,
  intent: "CARD_ENRICHMENT" as const,
  refreshMode: "BACKGROUND_REFRESH" as const,
  endpoint: "/v3/backlinks/referring_domains/live",
  locationCode: "US",
  languageCode: "en-US",
  requestSchemaVersion: 1,
  responseSchemaVersion: "response.v1",
  usagePurpose: "recommendation-card-enrichment",
  projectContextVersion: 1,
  estimatedCostMicros: 10,
};
const createBulkStore = (): DataForSeoBulkBatchStore => ({
  start: vi.fn(async () => "018f0000-0000-7000-8000-000000000900"),
  complete: vi.fn(async () => undefined),
  fail: vi.fn(async () => undefined),
});
const createBulkService = (
  fetchBatch: DataForSeoBulkPort["fetchBatch"],
  store = createBulkStore(),
  maxBatchSize?: number,
) => ({
  service: new ProviderBulkRequestService({
    provider: { fetchBatch },
    gate: { authorize: async () => undefined },
    store,
    now: () => now,
  }, maxBatchSize === undefined ? {} : { maxBatchSize }),
  store,
});

describe("DFS-COST-001 Request Intent and public fingerprint", () => {
  it("uses only normalized public Provider parameters", () => {
    const base = {
      provider: "dataforseo" as const,
      endpoint: "/v3/backlinks/referring_domains/live",
      requestSchemaVersion: 1,
      responseSchemaVersion: "response.v1",
      locationCode: "us",
      languageCode: "EN-us",
      request: serviceInput.request,
    };
    expect(createProviderArtifactFingerprint(base)).toBe(
      createProviderArtifactFingerprint({
        ...base,
        locationCode: "US",
        languageCode: "en-US",
        request: { ...base.request, target: "example.com" },
      }),
    );
    expect(createProviderArtifactFingerprint(base)).not.toBe(
      createProviderArtifactFingerprint({
        ...base,
        request: { ...base.request, limit: 200 },
      }),
    );
  });

  it("blocks deep, monitoring, interactive discovery, and force-live bypasses", () => {
    expect(() => assertDataForSeoRequestIntent({
      intent: "DEEP_ASSESSMENT",
      refreshMode: "BACKGROUND_REFRESH",
      execution: "INTERACTIVE",
    })).toThrow("DEEP_ASSESSMENT_REQUIRES_OPPORTUNITY");
    expect(() => assertDataForSeoRequestIntent({
      intent: "MONITORING",
      refreshMode: "BACKGROUND_REFRESH",
      execution: "BACKGROUND",
      linkValidatorPrimary: false,
    })).toThrow("LINK_VALIDATOR_PRIMARY");
    expect(() => assertDataForSeoRequestIntent({
      intent: "DISCOVERY",
      refreshMode: "CACHE_PREFERRED",
      execution: "INTERACTIVE",
    })).toThrow("MUST_RUN_AS_BACKGROUND");
    expect(() => assertDataForSeoRequestIntent({
      intent: "CARD_ENRICHMENT",
      refreshMode: "FORCE_LIVE",
      execution: "BACKGROUND",
    })).toThrow("FORCE_LIVE_REQUIRES_EXPLICIT");
  });
});

describe("DFS-COST-002/006 progressive SWR and inventory", () => {
  it("uses scene-specific and shorter negative-cache freshness", () => {
    const discovery = createProviderArtifactFreshnessWindow({
      intent: "DISCOVERY",
      observedAt: now,
      negative: false,
    });
    const negative = createProviderArtifactFreshnessWindow({
      intent: "DISCOVERY",
      observedAt: now,
      negative: true,
    });
    expect(discovery.freshUntil.toISOString()).toBe(
      "2026-08-06T08:00:00.000Z",
    );
    expect(discovery.staleUntil.toISOString()).toBe(
      "2026-08-29T08:00:00.000Z",
    );
    expect(negative.freshUntil.toISOString()).toBe(
      "2026-07-30T14:00:00.000Z",
    );
    expect(classifyProviderArtifactFreshness({
      now: new Date("2026-07-30T16:00:00.000Z"),
      ...negative,
    })).toBe("stale");
  });

  it("serves stale evidence, exposes its age, and schedules refresh", async () => {
    const scheduleBackgroundRefresh = vi.fn(async () => undefined);
    const fetchBacklinkSnapshot = vi.fn(async () => snapshot);
    const coordinator: DataForSeoRequestCoordinator = {
      begin: async () => ({
        kind: "cache",
        freshness: "stale",
        snapshot,
      }),
    };
    const service = new DataForSeoRequestService({
      coordinator,
      provider: { fetchBacklinkSnapshot },
      gate: { authorize: async () => undefined },
      scheduleBackgroundRefresh,
      now: () => now,
    });

    await expect(service.execute(serviceInput)).resolves.toMatchObject({
      source: "stale-cache",
      freshness: "stale",
      snapshot: { completedAt: snapshot.completedAt },
    });
    expect(scheduleBackgroundRefresh).toHaveBeenCalledOnce();
    expect(scheduleBackgroundRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ refreshMode: "BACKGROUND_REFRESH" }),
    );
    expect(fetchBacklinkSnapshot).not.toHaveBeenCalled();
  });

  it("adapts low/high watermarks and keeps swaps local", () => {
    expect(decideRecommendationInventory({
      readyCount: 30,
      lowWatermark: 10,
      highWatermark: 30,
      averageDailyConsumption: 5,
      inactiveDays: 0,
      refillInFlight: false,
      recommendationContextMatches: true,
    })).toEqual({ action: "stop", reason: "high_watermark_reached" });
    expect(decideRecommendationInventory({
      readyCount: 5,
      lowWatermark: 10,
      highWatermark: 40,
      averageDailyConsumption: 2,
      inactiveDays: 30,
      refillInFlight: false,
      recommendationContextMatches: true,
    })).toEqual({ action: "refill", requested: 9, target: 14 });
    expect(decideRecommendationInventory({
      readyCount: 5,
      lowWatermark: 10,
      highWatermark: 40,
      averageDailyConsumption: 2,
      inactiveDays: 0,
      refillInFlight: true,
      recommendationContextMatches: true,
    })).toEqual({ action: "hold", reason: "refill_in_flight" });
    expect(decideRecommendationSwap(3)).toBe("consume_ready");
  });
});

describe("DFS-COST-005 Workspace-local Bulk", () => {
  it("preserves partial success and allocates the true batch cost exactly", async () => {
    const fetchBatch = vi.fn(async () => ({
      actualCostMicros: 10,
      results: [
        { itemKey: "c", status: "permanent_error" as const, code: "INVALID" },
        { itemKey: "a", status: "success" as const, snapshot },
        { itemKey: "b", status: "empty" as const, snapshot },
      ],
      rawPayloadHash: "b".repeat(64),
    }));
    const { service, store } = createBulkService(fetchBatch);
    const result = await service.execute({
      ...bulkInput,
      items: [
        {
          itemKey: "a",
          request: { target: "a.example", targetType: "domain", limit: 100 },
        },
        {
          itemKey: "b",
          request: { target: "b.example", targetType: "domain", limit: 100 },
        },
        {
          itemKey: "c",
          request: { target: "c.example", targetType: "domain", limit: 100 },
        },
      ],
    });

    expect(fetchBatch).toHaveBeenCalledWith(expect.objectContaining({
      context: serviceInput.context,
      intent: "CARD_ENRICHMENT",
    }));
    expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: expect.objectContaining({ actualCostMicros: 10 }),
    }));
    expect(result.results.map(({ allocatedCostMicros }) =>
      allocatedCostMicros).reduce((sum, cost) => sum + cost, 0)).toBe(10);
    expect(result.negativeCacheItemKeys).toEqual(["b"]);
    expect(result.retryItemKeys).toEqual([]);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemKey: "a", status: "success" }),
      expect.objectContaining({ itemKey: "c", status: "permanent_error" }),
    ]));
  });

  it("retries only temporary item failures", async () => {
    const { service } = createBulkService(async () => ({
        actualCostMicros: 2,
        rawPayloadHash: "c".repeat(64),
        results: [
          { itemKey: "a", status: "retryable_error", code: "TEMPORARY" },
          { itemKey: "b", status: "permanent_error", code: "INVALID" },
        ],
      }));
    const result = await service.execute({
      ...bulkInput,
      items: [
        {
          itemKey: "a",
          request: { target: "a.example", targetType: "domain", limit: 10 },
        },
        {
          itemKey: "b",
          request: { target: "b.example", targetType: "domain", limit: 10 },
        },
      ],
    });
    expect(result.retryItemKeys).toEqual(["a"]);
  });

  it("enforces the configured batch size before calling the Provider", async () => {
    const fetchBatch = vi.fn(async () => ({
      actualCostMicros: 0,
      rawPayloadHash: "d".repeat(64),
      results: [],
    }));
    const { service, store } = createBulkService(fetchBatch, undefined, 1);

    await expect(service.execute({
      ...bulkInput,
      items: [
        {
          itemKey: "a",
          request: { target: "a.example", targetType: "domain", limit: 10 },
        },
        {
          itemKey: "b",
          request: { target: "b.example", targetType: "domain", limit: 10 },
        },
      ],
    })).rejects.toThrow("DATAFORSEO_BULK_BATCH_SIZE_EXCEEDED");
    expect(fetchBatch).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled();
  });
});
