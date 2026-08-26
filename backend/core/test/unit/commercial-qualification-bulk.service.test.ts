import { describe, expect, it, vi } from "vitest";

import {
  collectCommercialQualificationBulkMetrics,
  commercialQualificationBulkEndpoints,
  type CommercialQualificationBulkCall,
  type CommercialQualificationBulkResponse,
  type CommercialQualificationBulkRuntime,
} from "../../src/modules/backlinks/application/services/commercial-qualification-bulk.service.js";

const allowlist = Object.values(commercialQualificationBulkEndpoints);

function body(
  call: CommercialQualificationBulkCall,
  missing: ReadonlySet<string> = new Set(),
): unknown {
  const items = call.targets
    .filter((target) => !missing.has(target))
    .map((target) => call.kind === "traffic"
      ? { target, metrics: { organic: { etv: 30_000 } } }
      : call.kind === "spam"
        ? { target, spam_score: 10 }
        : { target, rank: 70 });
  return { tasks: [{ result: [{ items }] }] };
}

function completed(
  call: CommercialQualificationBulkCall,
): CommercialQualificationBulkResponse {
  return {
    status: "completed",
    body: body(call),
    providerRequestId: `${call.kind}-request`,
    costMicros: 10,
  };
}

describe("commercial qualification bulk service", () => {
  it("deduplicates domains and parses the three typed metric responses", async () => {
    const execute = vi.fn(async (call: CommercialQualificationBulkCall) =>
      completed(call));
    const result = await collectCommercialQualificationBulkMetrics({
      domains: ["https://www.Example.com/a", "example.com", "openai.com"],
      metricScope: "TARGET_MARKET",
      locationCode: 2840,
      languageCode: "en",
      endpointAllowlist: allowlist.map(
        (endpoint) => `https://api.dataforseo.com${endpoint}`,
      ),
      runtime: { execute },
    });
    expect(result).toMatchObject({
      state: "completed",
      callCount: 3,
      costMicros: 30,
    });
    expect(result.records).toEqual([
      expect.objectContaining({
        canonicalDomain: "example.com",
        trafficOrganicEtv: 30_000,
        spamScore: 10,
        authorityRank: 70,
      }),
      expect.objectContaining({
        canonicalDomain: "openai.com",
        trafficOrganicEtv: 30_000,
        spamScore: 10,
        authorityRank: 70,
      }),
    ]);
    expect(execute.mock.calls[0]?.[0].body[0]).toMatchObject({
      location_code: 2840,
      language_code: "en",
      item_types: ["organic"],
    });
    expect(execute.mock.calls.find(([call]) => call.kind === "rank")
      ?.[0].body[0]).toMatchObject({ rank_scale: "one_hundred" });
  });

  it("chunks at no more than 1000 targets and bounds concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    const execute = vi.fn(async (call: CommercialQualificationBulkCall) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return completed(call);
    });
    const domains = Array.from(
      { length: 1_001 },
      (_, index) => `site-${index}.com`,
    );
    const result = await collectCommercialQualificationBulkMetrics({
      domains,
      metricScope: "GLOBAL",
      locationCode: null,
      languageCode: null,
      endpointAllowlist: allowlist,
      chunkSize: 1_000,
      concurrency: 2,
      runtime: { execute },
    });
    expect(result.callCount).toBe(6);
    expect(maximumActive).toBe(2);
    expect(execute.mock.calls.every(
      ([call]) => call.targets.length <= 1_000,
    )).toBe(true);
    expect(execute.mock.calls[0]?.[0].body[0]).not.toHaveProperty(
      "location_code",
    );
  });

  it("retains per-item missing metrics as a partial result", async () => {
    const runtime: CommercialQualificationBulkRuntime = {
      execute: async (call) => ({
        ...completed(call),
        body: body(
          call,
          call.kind === "traffic" ? new Set(["missing.com"]) : new Set(),
        ),
      }),
    };
    const result = await collectCommercialQualificationBulkMetrics({
      domains: ["ready.com", "missing.com"],
      metricScope: "GLOBAL",
      locationCode: null,
      languageCode: null,
      endpointAllowlist: allowlist,
      runtime,
    });
    expect(result.state).toBe("partial");
    expect(result.records.find(
      ({ canonicalDomain }) => canonicalDomain === "missing.com",
    )).toMatchObject({
      trafficOrganicEtv: null,
      trafficState: "missing",
      spamState: "completed",
      rankState: "completed",
    });
  });

  it("stops dispatching after an ambiguous live request", async () => {
    const execute = vi.fn(async (
      call: CommercialQualificationBulkCall,
    ): Promise<CommercialQualificationBulkResponse> => call.kind === "traffic"
      ? {
          status: "unknown_charge",
          body: null,
          providerRequestId: null,
          costMicros: 0,
        }
      : completed(call));
    const result = await collectCommercialQualificationBulkMetrics({
      domains: ["example.com"],
      metricScope: "GLOBAL",
      locationCode: null,
      languageCode: null,
      endpointAllowlist: allowlist,
      concurrency: 1,
      runtime: { execute },
    });
    expect(result.state).toBe("unknown_charge");
    expect(result.callCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      trafficState: "unknown_charge",
      trafficOrganicEtv: null,
      spamState: "unavailable",
      rankState: "unavailable",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("stops dispatching after the provider becomes unavailable", async () => {
    const execute = vi.fn(async (): Promise<
      CommercialQualificationBulkResponse
    > => ({
      status: "unavailable",
      body: null,
      providerRequestId: null,
      costMicros: 0,
    }));
    const result = await collectCommercialQualificationBulkMetrics({
      domains: ["example.com"],
      metricScope: "GLOBAL",
      locationCode: null,
      languageCode: null,
      endpointAllowlist: allowlist,
      concurrency: 1,
      runtime: { execute },
    });
    expect(result.state).toBe("unavailable");
    expect(result.callCount).toBe(1);
    expect(result.records[0]).toMatchObject({
      trafficState: "unavailable",
      spamState: "unavailable",
      rankState: "unavailable",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails before dispatch when one endpoint is not allowlisted", async () => {
    const execute = vi.fn();
    await expect(collectCommercialQualificationBulkMetrics({
      domains: ["example.com"],
      metricScope: "GLOBAL",
      locationCode: null,
      languageCode: null,
      endpointAllowlist: [commercialQualificationBulkEndpoints.traffic],
      runtime: { execute },
    })).rejects.toThrow("is not allowlisted");
    expect(execute).not.toHaveBeenCalled();
  });
});
