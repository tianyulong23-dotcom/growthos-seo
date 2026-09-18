import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommercialQualificationBulkCall } from "../../src/modules/backlinks/application/services/commercial-qualification-bulk.service.js";
import { commercialQualificationBulkEndpoints } from "../../src/modules/backlinks/application/services/commercial-qualification-bulk.service.js";
import type { LocalProductDataForSeoConfiguration } from "../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), appendMetric: vi.fn(), complete: vi.fn(), fail: vi.fn(),
  acquire: vi.fn(), preflight: vi.fn(), authorize: vi.fn(), gate: vi.fn(),
}));
vi.mock("../../src/modules/backlinks/adapters/security/local-product-secret-store-client.js", () => ({
  LocalProductSecretStoreClient: class {
    async resolve() { return JSON.stringify({ login: "fixture", password: "fixture" }); }
  },
  parseLocalProductSecretReference: vi.fn(),
}));
vi.mock("../../src/modules/backlinks/adapters/dataforseo/commercial-qualification-official-runtime.js", () => ({
  createCommercialQualificationOfficialRuntime: () => ({ execute: mocks.execute }),
}));
vi.mock("../../src/modules/backlinks/db/repositories/commercial-qualification-request.repository.js", () => ({
  createCommercialQualificationRequestRepository: () => ({
    acquire: mocks.acquire, complete: mocks.complete, fail: mocks.fail,
  }),
}));
vi.mock("../../src/modules/backlinks/db/repositories/recommendation-pool-v2-candidate.repository.js", () => ({
  createRecommendationPoolV2CandidateRepository: () => ({ appendMetric: mocks.appendMetric }),
}));
vi.mock("../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.js", () => ({
  createLocalProductDataForSeoGate: mocks.gate,
  resolveLocalProductDataForSeoOperationBudget: ({ configuration }: { configuration: unknown }) => configuration,
}));
import { createRecommendationPoolV2MetricRuntime } from "../../src/modules/backlinks/runtime/recommendation-pool-v2-metric-runtime.js";

const input = {
  organizationId: "org", workspaceId: "workspace", websiteProjectId: "project",
  generationContractId: "generation", recommendationContextVersionId: "context",
  visiblePoolGeneration: 1, inputPinId: "pin", jobId: "job", workflowId: "workflow",
  actorId: "actor", terminalReason: "PATHS_EXHAUSTED" as const,
  totalSettledCostMicros: 1000, hardCandidateLimit: 1000, rounds: [],
};
const configuration = {
  endpointAllowlist: Object.values(commercialQualificationBulkEndpoints).map(path => `https://api.dataforseo.com${path}`),
  credentialSecretRef: "fixture", estimatedCostMicros: 50_000, timeoutMs: 1000,
} as LocalProductDataForSeoConfiguration;
function fixture(options: { finalized?: boolean; empty?: boolean; allowlist?: readonly string[] } = {}) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("SELECT generation.market") ? options.finalized ? [] : [{
      market: "BR", location: "BR", language: "pt", countryCode: "BR", locale: "pt-BR", authorization: null,
    }] : sql.includes("SELECT candidate.id") ? options.empty ? [] : [
      { id: "candidate-1", domain: "showmetech.com.br" }, { id: "candidate-2", domain: "ufba.br" },
    ] : sql.includes("SELECT id,finished_at") ? [{ id: "receipt", finishedAt: "2026-09-16T01:00:00Z" }] : [],
    rowCount: 1,
  }));
  const run = createRecommendationPoolV2MetricRuntime({
    pool: { async connect() { return { query, release() {} }; } },
    configuration: { ...configuration, endpointAllowlist: options.allowlist ?? configuration.endpointAllowlist },
    secretStoreRoot: "fixture",
  });
  return { run, query };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.gate.mockReturnValue(() => ({ preflight: mocks.preflight, authorize: mocks.authorize }));
  mocks.acquire.mockResolvedValue({ state: "started", batchRequestId: "receipt" });
  mocks.execute.mockImplementation(async (call: CommercialQualificationBulkCall) => ({
    status: "completed", providerRequestId: call.kind, costMicros: 10,
    body: { tasks: [{ result: [{ items: call.targets.map(target => call.kind === "traffic"
      ? { target, metrics: { organic: { etv: 0 } } }
      : call.kind === "spam" ? { target, spam_score: 12 } : { target, rank: 40 }) }] }] },
  }));
});
describe("V2 metrics before immutable release", () => {
  it("uses three governed bulk requests and persists real metric provenance including zero", async () => {
    const { run, query } = fixture();
    await run(input);
    expect(mocks.execute).toHaveBeenCalledTimes(3);
    expect(mocks.authorize).toHaveBeenCalledTimes(3);
    expect(mocks.complete).toHaveBeenCalledTimes(3);
    expect(mocks.acquire).toHaveBeenCalledWith(expect.objectContaining({
      recommendationLineage: { generationContractId: "generation", jobId: "job" },
    }));
    expect(mocks.appendMetric).toHaveBeenCalledTimes(6);
    expect(mocks.execute.mock.calls[0][0].body[0]).toMatchObject({ location_code: 2076, language_code: "pt" });
    expect(mocks.appendMetric).toHaveBeenCalledWith(expect.objectContaining({
      generationCandidateId: "candidate-1", metricType: "TRAFFIC_ORGANIC_ETV",
      valueState: "AVAILABLE", metricValue: 0, requestRef: "receipt",
      observedAt: "2026-09-16T01:00:00.000Z", market: "BR",
      endpoint: commercialQualificationBulkEndpoints.traffic,
    }));
    expect(query.mock.calls.some(([sql]) => sql.includes("newer.snapshot_version>context.snapshot_version"))).toBe(true);
    const candidateSql = query.mock.calls.find(([sql]) => sql.includes("SELECT candidate.id"))?.[0];
    expect(candidateSql).toContain("ADMITTED");
    expect(candidateSql).not.toContain("provider='dataforseo'");
    expect(candidateSql).not.toContain("EXISTS");
    expect(mocks.authorize.mock.calls[0][0].context.budgetReservationId)
      .toMatch(/^commercial-refill-operation:job:qualification:/);
  });
  it.each([{ finalized: true }, { empty: true }])("does not spend on completed or empty generations: %j", async options => {
    await fixture(options).run(input);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("reports missing allowlist configuration before making a paid request", async () => {
    await expect(fixture({ allowlist: [] }).run(input)).rejects.toThrow("RECOMMENDATION_METRIC_ENDPOINTS_NOT_ALLOWLISTED");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("stops on unknown charge and does not publish synthetic metric values", async () => {
    mocks.execute.mockResolvedValue({ status: "unknown_charge", body: null, providerRequestId: null, costMicros: 0 });
    await expect(fixture().run(input)).rejects.toThrow("RECOMMENDATION_METRICS_UNKNOWN_CHARGE");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.fail).toHaveBeenCalled();
    expect(mocks.appendMetric).not.toHaveBeenCalled();
  });
  it("distinguishes a successful lookup with no metrics from a failed request", async () => {
    mocks.execute.mockResolvedValue({
      status: "completed", body: { tasks: [{ result: [{ items: [] }] }] }, providerRequestId: "empty", costMicros: 10,
    });
    await fixture().run(input);
    expect(mocks.appendMetric).toHaveBeenCalledTimes(6);
    expect(mocks.appendMetric.mock.calls.every(([metric]) => metric.valueState === "UNAVAILABLE" && metric.metricValue === null)).toBe(true);
  });
  it("reuses stored responses without a new provider call and preserves observation time", async () => {
    mocks.acquire.mockResolvedValue({
      state: "cached", response: {
        status: "completed", costMicros: 0, providerRequestId: "previous",
        body: { tasks: [{ result: [{ items: [{ target: "showmetech.com.br", rank: 40 }] }] }] },
      },
    });
    await fixture().run(input);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.appendMetric).toHaveBeenCalledWith(expect.objectContaining({
      metricType: "AUTHORITY_RANK", metricValue: 40, observedAt: "2026-09-16T01:00:00.000Z",
    }));
  });
});
