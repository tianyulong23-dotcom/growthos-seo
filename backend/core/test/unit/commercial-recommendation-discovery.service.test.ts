import { describe, expect, it, vi } from "vitest";

import {
  buildCommercialTierSearchQueries,
  claimPausedCommercialDiscoveryBatch,
  executeCommercialRecommendationDiscovery,
  scoreCuratedResourceForProject,
  selectCommercialNativeV2RequestPlan,
  orderCommercialNativeV2DiscoveryCalls,
} from "../../src/modules/backlinks/application/services/commercial-recommendation-discovery.service.js";
import {
  buildCommercialDiscoveryBlueprint,
} from "../../src/modules/backlinks/domain/recommendations/commercial-discovery-blueprint.js";
import {
  CommercialDiscoveryRequestService,
  type CommercialDiscoveryQueryClient,
} from "../../src/modules/backlinks/application/services/commercial-discovery-request.service.js";
import {
  createCommercialDiscoveryPlan,
  fingerprintCommercialDiscoveryCall,
  fingerprintCommercialDiscoverySemanticRequest,
  normalizeCommercialDiscoveryResponse,
  serializeCommercialDiscoveryRequestPayload,
  type CommercialDiscoveryCall,
} from "../../src/modules/backlinks/domain/recommendations/commercial-discovery-source.js";
import type { GenerationInputBinding } from "../../src/modules/backlinks/ports/shared-seo-evidence.port.js";

const profileVersionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const promotionTargetVersionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const inputBinding: GenerationInputBinding = Object.freeze({
  inputPinId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  outreachProfileRecordId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  immutableFingerprint: "discovery-fixture-binding",
  pins: Object.freeze({
    organizationId: "11111111-1111-4111-8111-111111111111",
    websiteProjectId: "33333333-3333-4333-8333-333333333333",
    projectContextVersion: 2,
    siteProfileVersionId: profileVersionId,
    outreachProfileVersionId: profileVersionId,
    promotionTargetVersionId,
    keywordEvidenceSnapshotIds: Object.freeze([]),
    sharedEvidenceSnapshotIds: Object.freeze([]),
    market: "US",
    qualificationContractVersion: "backlinks.recommendation-qualification.v4",
  }),
  outreachProfile: Object.freeze({
    organizationId: "11111111-1111-4111-8111-111111111111",
    websiteProjectId: "33333333-3333-4333-8333-333333333333",
    profileVersionId,
    promotionTargetVersionId,
    keywordsAndTopics: Object.freeze([]),
    productsAndServices: Object.freeze([]),
    targetUrls: Object.freeze([]),
    targetAudiences: Object.freeze([]),
    partnershipGoals: Object.freeze([]),
    market: "US",
    location: "US",
    language: "en-US",
    authorizedDiscoverySources: Object.freeze([
      "WEBSITE_PROJECT",
      "CURATED_RESOURCE_LIBRARY",
    ]),
    immutableFingerprint: "discovery-fixture-profile",
  }),
  sharedEvidence: Object.freeze([]),
});

class MemoryDiscoveryClient implements CommercialDiscoveryQueryClient {
  readonly calls: Array<Readonly<{
    text: string;
    values: readonly unknown[];
  }>> = [];
  private blueprint: Readonly<{
    id: string;
    value: Record<string, unknown>;
  }> | null = null;
  private readonly artifacts = new Map<string, Readonly<{
    normalizedPayload: Record<string, unknown>;
    freshUntil: Date;
    staleUntil: Date;
  }>>();
  private succeededRequestReplay: Readonly<Record<string, unknown>> | null =
    null;
  private completedDiscoveryBatchId: string | null = null;
  private candidateHistory:
    readonly Readonly<Record<string, unknown>>[] = [];

  constructor(
    private readonly reconciledFingerprint: string | null = null,
    private readonly interrupted: Readonly<{
      fingerprint: string;
      batchRequestId: string;
      providerTaskId: string | null;
      leaseOwnerRequestId: string;
      budgetReserved: boolean;
      startedAt: Date;
    }> | null = null,
    private readonly acceptedRecovery: Readonly<{
      endpoint: CommercialDiscoveryCall["endpoint"];
      blueprintId: string;
      responseSchemaVersion: string;
      requestFingerprint: string;
      estimatedCostMicros: number;
      requestId: string;
      budgetReservationId: string;
      requestPayload: Readonly<Record<string, unknown>>;
    }> | null = null,
    private readonly remainingBudget = 10_000,
  ) {}

  seedBlueprint(
    id: string,
    value: Readonly<Record<string, unknown>>,
  ): void {
    this.blueprint = { id, value };
  }

  seedSucceededRequestReplay(
    value: Readonly<Record<string, unknown>>,
  ): void {
    this.succeededRequestReplay = value;
  }

  seedCompletedDiscoveryBatch(id: string): void {
    this.completedDiscoveryBatchId = id;
  }

  seedCandidateHistory(
    rows: readonly Readonly<Record<string, unknown>>[],
  ): void {
    this.candidateHistory = rows;
  }

  async query(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>> {
    this.calls.push({ text, values });
    const sql = text.replace(/\s+/gu, " ").trim();
    if (
      sql.includes("FROM backlink_prospects AS p")
      || sql.includes("FROM backlink_placements")
      || sql.includes("FROM backlink_opportunities")
    ) {
      return { rows: [] };
    }
    if (
      sql.includes("FROM backlink_commercial_candidates")
      && sql.includes('recommendation_id AS "recommendationId"')
    ) {
      return { rows: this.candidateHistory };
    }
    if (
      sql.includes("FROM backlink_commercial_inventory_policies")
      && sql.includes("visible_pool_state='building'")
    ) {
      return { rows: [{ visiblePoolGeneration: values[4] ?? 1 }] };
    }
    if (
      sql.includes("UPDATE backlink_commercial_inventory_policies")
      && sql.includes("RETURNING visible_pool_generation")
    ) {
      return { rows: [{ visiblePoolGeneration: values[4] ?? 1 }] };
    }
    if (sql.includes("SELECT GREATEST(")) {
      return { rows: [{ remaining: this.remainingBudget }] };
    }
    if (sql.includes("DATAFORSEO_ACCEPTED_TASK_RECOVERY_PLAN")) {
      return {
        rows: this.acceptedRecovery === null
          ? []
          : [this.acceptedRecovery],
      };
    }
    if (
      sql.includes("SELECT id,blueprint")
      && sql.includes("backlink_commercial_discovery_blueprints")
    ) {
      return {
        rows: this.blueprint === null
          ? []
          : [{ id: this.blueprint.id, blueprint: this.blueprint.value }],
      };
    }
    if (sql.includes("INSERT INTO backlink_commercial_discovery_blueprints")) {
      this.blueprint = {
        id: String(values[0]),
        value: JSON.parse(String(values[10])) as Record<string, unknown>,
      };
      return { rows: [] };
    }
    if (
      sql.includes("SELECT id")
      && sql.includes("FROM backlink_commercial_discovery_blueprints")
    ) {
      return {
        rows: this.blueprint === null ? [] : [{ id: this.blueprint.id }],
      };
    }
    if (
      sql.includes('SELECT normalized_payload AS "normalizedPayload"')
      && sql.includes("backlink_commercial_discovery_artifacts")
    ) {
      const artifact = this.artifacts.get(String(values[4]));
      return {
        rows: artifact === undefined ? [] : [artifact],
      };
    }
    if (sql.includes("RECOMMENDATION_POOL_V2_SUCCEEDED_REQUEST_REPLAY")) {
      return {
        rows: this.succeededRequestReplay === null
          ? []
          : [this.succeededRequestReplay],
      };
    }
    if (
      sql.includes("DATAFORSEO_RECONCILED_ASSUMED_CHARGE_NO_RESULT")
      && this.reconciledFingerprint !== null
      && values[3] === this.reconciledFingerprint
    ) {
      return { rows: [{ id: "reconciled-request" }] };
    }
    if (
      sql.includes("DATAFORSEO_WORKER_INTERRUPTED_AFTER_TASK_ACCEPTED")
      && this.interrupted !== null
      && values[3] === this.interrupted.fingerprint
    ) {
      return {
        rows: [{
          batchRequestId: this.interrupted.batchRequestId,
          providerTaskId: this.interrupted.providerTaskId,
          leaseOwnerRequestId: this.interrupted.leaseOwnerRequestId,
          budgetReserved: this.interrupted.budgetReserved,
          startedAt: this.interrupted.startedAt,
        }],
      };
    }
    if (sql.includes("DATAFORSEO_RECONCILED_NOT_DISPATCHED")) {
      return { rows: [{ id: "reconciled-not-dispatched" }] };
    }
    if (
      sql.includes("WITH attempted AS")
      && sql.includes("provider_fetch_leases")
    ) {
      return {
        rows: [{
          acquired: true,
          status: "acquired",
          ownerRequestId: String(values[1]),
          leaseExpiresAt: values[3],
        }],
      };
    }
    if (sql.includes("INSERT INTO backlink_commercial_discovery_artifacts")) {
      this.artifacts.set(String(values[6]), {
        normalizedPayload: JSON.parse(
          String(values[9]),
        ) as Record<string, unknown>,
        freshUntil: values[12] as Date,
        staleUntil: values[13] as Date,
      });
      return { rows: [] };
    }
    if (
      sql.includes("WITH ledger AS")
      && sql.includes("SET status='settled'")
    ) {
      return { rows: [{ id: String(values[0]) }] };
    }
    if (
      sql.includes('AS "providerUsageLedgerId"')
      && sql.includes("usage.status='settled'")
    ) {
      return {
        rows: [{
          providerRequestId: String(values[0]),
          providerBatchRequestId: String(values[0]),
          providerUsageLedgerId:
            "99999999-9999-4999-8999-999999999999",
          providerTaskId: null,
          actualCostMicros: 0,
        }],
      };
    }
    if (
      sql.includes("UPDATE provider_batch_requests")
      && sql.includes("SET provider_task_id=$2")
    ) {
      return { rows: [{ id: String(values[0]) }] };
    }
    if (
      sql.includes("UPDATE provider_batch_requests")
      && sql.includes("SET status='succeeded'")
      && sql.includes("RETURNING id")
    ) {
      return { rows: [{ id: String(values[0]) }] };
    }
    if (
      sql.includes("UPDATE provider_fetch_leases")
      && sql.includes("SET status='completed'")
      && sql.includes("RETURNING artifact_fingerprint")
    ) {
      return { rows: [{ artifactFingerprint: String(values[0]) }] };
    }
    if (
      sql.includes("INSERT INTO backlink_commercial_discovery_batches")
      && sql.includes("RETURNING id")
    ) {
      if (this.completedDiscoveryBatchId !== null) {
        return sql.includes("completed_replay") && values[13] === true
          ? { rows: [{ id: this.completedDiscoveryBatchId }] }
          : { rows: [] };
      }
      return { rows: [{ id: String(values[0]) }] };
    }
    return { rows: [] };
  }
}

describe("commercial recommendation discovery service", () => {
  it("keeps semantic request history stable across cost estimate changes", () => {
    const [call] = createCommercialDiscoveryPlan({
      blueprintId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      searchQueries: ["South Africa streaming service review sites"],
      verifiedCompetitorDomains: [],
      userDomain: "elephtv.com",
      locationCode: "2710",
      languageCode: "en",
      endpointAllowlist: ["/v3/serp/google/organic/task_post"],
      estimatedCostMicros: 27_600,
      remainingBudgetMicros: 27_600,
    });
    if (call === undefined) throw new Error("Missing semantic request");
    const repricedCall = Object.freeze({
      ...call,
      estimatedCostMicros: 25_000,
    });

    expect(fingerprintCommercialDiscoveryCall(call)).not.toBe(
      fingerprintCommercialDiscoveryCall(repricedCall),
    );
    expect(fingerprintCommercialDiscoverySemanticRequest(call)).toBe(
      fingerprintCommercialDiscoverySemanticRequest(repricedCall),
    );
  });

  it("settles a deterministic zero-plan window without reporting provider downtime", async () => {
    const client = new MemoryDiscoveryClient();
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const authorize = vi.fn(async () => {});

    const result = await executeCommercialRecommendationDiscovery({
      client,
      provider: { execute: providerExecute },
      gate: { preflight: async () => {}, authorize },
      safeFetch: {
        fetch: async () => ({
          requestedUrl: "https://aiper.com/",
          finalUrl: "https://aiper.com/",
          status: 200,
          contentType: "text/html",
          body: new Uint8Array(),
          redirectChain: [],
          resolvedIps: ["203.0.113.10"],
          fetchedAt: "2026-08-25T15:30:00.000Z",
        }),
      },
      scope: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
      },
      contextVersionId: "44444444-4444-4444-8444-444444444444",
      inputBinding,
      context: {
        snapshotVersion: 2,
        profileVersionId,
        promotionTargetVersionId,
        projectSettingsVersionId:
          "55555555-5555-4555-8555-555555555555",
        projectSettingsVersion: 1,
        canonicalDomain: "aiper.com",
        locale: "en-US",
        countryCode: "US",
        products: ["robotic pool cleaner"],
        keywords: ["pool cleaning"],
        targetUrls: ["https://aiper.com/"],
        targetAudiences: ["pool owners"],
        partnershipGoals: ["editorial review"],
        explicitCompetitorDomains: [],
      },
      configuration: {
        endpointAllowlist: [],
        estimatedCostMicros: 1_000,
        absoluteBudgetMicros: 10_000,
        candidateLimit: 25,
        locationCode: "2840",
        languageCode: "en",
      },
      requestedCount: 10,
      visiblePoolGeneration: 1,
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 1,
      jobId: "job-zero-plan",
      actorId: "zero-plan-test",
      now: () => new Date("2026-08-25T15:30:00.000Z"),
    });

    expect(result.discovery).toEqual({
      semanticStatus: "not_required",
      semanticRequiredCallCount: 0,
      semanticCompletedCallCount: 0,
      reason: "semantic_discovery_not_planned_endpoint_allowlist",
    });
    expect(providerExecute).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    const batchUpdate = client.calls.find(({ text }) =>
      text.includes("UPDATE backlink_commercial_discovery_batches")
      && text.includes("SET status=$5")
    );
    expect(batchUpdate?.values[4]).toBe("completed");
    expect(batchUpdate?.values[9]).toBe(
      "semantic_discovery_not_planned_endpoint_allowlist",
    );
  });

  it("does not reopen a completed legacy discovery batch for native V2", async () => {
    const client = new MemoryDiscoveryClient();
    client.seedCompletedDiscoveryBatch(
      "77777777-7777-4777-8777-777777777777",
    );
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const authorize = vi.fn(async () => {});
    const prepareRequest = vi.fn();
    const recordRequestSuccess = vi.fn();
    const recordRequestFailure = vi.fn();

    await expect(executeCommercialRecommendationDiscovery({
      client,
      provider: { execute: providerExecute },
      gate: { preflight: async () => {}, authorize },
      safeFetch: {
        fetch: async () => ({
          requestedUrl: "https://aiper.com/",
          finalUrl: "https://aiper.com/",
          status: 200,
          contentType: "text/html",
          body: new Uint8Array(),
          redirectChain: [],
          resolvedIps: ["203.0.113.10"],
          fetchedAt: "2026-09-02T11:00:00.000Z",
        }),
      },
      scope: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
      },
      contextVersionId: "44444444-4444-4444-8444-444444444444",
      inputBinding,
      context: {
        snapshotVersion: 2,
        profileVersionId,
        promotionTargetVersionId,
        projectSettingsVersionId:
          "55555555-5555-4555-8555-555555555555",
        projectSettingsVersion: 1,
        canonicalDomain: "aiper.com",
        locale: "en-US",
        countryCode: "US",
        products: ["robotic pool cleaner"],
        keywords: ["pool cleaning"],
        targetUrls: ["https://aiper.com/"],
        targetAudiences: ["pool owners"],
        partnershipGoals: ["editorial review"],
        explicitCompetitorDomains: [],
      },
      configuration: {
        endpointAllowlist: [],
        estimatedCostMicros: 1_000,
        absoluteBudgetMicros: 10_000,
        candidateLimit: 25,
        locationCode: "2840",
        languageCode: "en",
      },
      nativeV2: {
        authoritativeBlueprintId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        maxRequests: 1,
        maxAuthorizedCostMicros: 10_000,
        prepareRequest,
        recordRequestSuccess,
        recordRequestFailure,
      },
      requestedCount: 5,
      visiblePoolGeneration: 3,
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 1,
      jobId: "66666666-6666-4666-8666-666666666666",
      actorId: "recommendation-pool-v2-test",
      now: () => new Date("2026-09-02T11:00:00.000Z"),
    })).resolves.toMatchObject({
      discovery: {
        semanticStatus: "not_required",
      },
    });

    expect(providerExecute).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(prepareRequest).not.toHaveBeenCalled();
    expect(recordRequestSuccess).not.toHaveBeenCalled();
    expect(recordRequestFailure).not.toHaveBeenCalled();
    expect(client.calls.some(({ text }) =>
      text.includes("INSERT INTO backlink_commercial_discovery_batches")
      || (
        text.includes("backlink_commercial_discovery_batches")
        && text.includes("status='running'")
      )
    )).toBe(false);
  });

  it("injects reusable native V2 evidence without invoking the provider", async () => {
    const client = new MemoryDiscoveryClient();
    client.seedCandidateHistory([{
      hostname: "publisher.co.za",
      state: "insufficient_data",
      recommendationId: null,
      prospectId: null,
    }]);
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const authorize = vi.fn(async () => {});
    const safeFetch = vi.fn(async (
      request: Readonly<{ url: string }>,
    ) => ({
      requestedUrl: request.url,
      finalUrl: request.url,
      status: 200,
      contentType: "text/html",
      body: new TextEncoder().encode(
        "<html><body><h1>Streaming reviews</h1></body></html>",
      ),
      redirectChain: [] as string[],
      resolvedIps: ["203.0.113.10"],
      fetchedAt: "2026-09-02T11:00:00.000Z",
    }));
    const sourceRequestFingerprint = "e".repeat(64);
    const authoritativeBlueprintId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const prepareRequest = vi.fn(async (
      request: Readonly<{
        call: CommercialDiscoveryCall;
        index: number;
        requestFingerprint: string;
      }>,
    ) => ({
      context: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
        requestId: "88888888-8888-4888-8888-888888888888",
        idempotencyKey: "recommendation-pool-v2-evidence-replay",
        budgetReservationId: "88888888-8888-4888-8888-888888888888",
      },
      actorId: "recommendation-pool-v2-evidence-replay",
      refreshMode: "CACHE_PREFERRED" as const,
      replayResult: {
        source: "cache" as const,
        artifact: {
          sourceType: request.call.sourceType,
          endpoint: request.call.endpoint,
          requestFingerprint: sourceRequestFingerprint,
          responseSchemaVersion: request.call.responseSchemaVersion,
          collectedAt: "2026-09-02T10:47:20.000Z",
          costMicros: 600,
          providerTaskIds: [
            "09021047-1594-0066-0000-946311258027",
          ],
          plannerLineage: request.call.plannerLineage,
          candidates: [{
            canonicalDomain: "publisher.co.za",
            discoveryUrls: ["https://publisher.co.za/reviews"],
            backlinkPageEvidence: [],
            rank: 1,
            traffic: null,
            backlinkCount: null,
            referringDomainCount: null,
            spamScore: null,
            countryCode: "ZA",
            evidenceRefs: [
              `dataforseo:${request.call.endpoint}:`
              + `${sourceRequestFingerprint}:publisher.co.za`,
            ],
          }],
        },
      },
    }));
    const recordRequestSuccess = vi.fn(async () => {});
    const recordRequestFailure = vi.fn(async () => {});
    const recordRequestPlan = vi.fn(async () => {});

    await executeCommercialRecommendationDiscovery({
      client,
      provider: { execute: providerExecute },
      gate: { preflight: async () => {}, authorize },
      safeFetch: { fetch: safeFetch },
      scope: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
      },
      contextVersionId: "44444444-4444-4444-8444-444444444444",
      inputBinding,
      context: {
        snapshotVersion: 2,
        profileVersionId,
        promotionTargetVersionId,
        projectSettingsVersionId:
          "55555555-5555-4555-8555-555555555555",
        projectSettingsVersion: 1,
        canonicalDomain: "elephtv.com",
        locale: "en-ZA",
        countryCode: "ZA",
        products: ["streaming", "film"],
        keywords: ["streaming service in SA"],
        targetUrls: ["https://elephtv.com/"],
        targetAudiences: ["South African viewers"],
        partnershipGoals: ["authoritative film review websites"],
        explicitCompetitorDomains: [],
      },
      configuration: {
        endpointAllowlist: [
          "/v3/serp/google/organic/task_post",
        ],
        estimatedCostMicros: 25_000,
        absoluteBudgetMicros: 25_000,
        candidateLimit: 25,
        locationCode: "2710",
        languageCode: "en",
      },
      nativeV2: {
        authoritativeBlueprintId,
        maxRequests: 1,
        maxAuthorizedCostMicros: 25_000,
        requestOffset: 1,
        recordRequestPlan,
        prepareRequest,
        recordRequestSuccess,
        recordRequestFailure,
      },
      requestedCount: 5,
      visiblePoolGeneration: 5,
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 1,
      jobId: "99999999-9999-4999-8999-999999999999",
      actorId: "recommendation-pool-v2-test",
      now: () => new Date("2026-09-02T11:00:00.000Z"),
    });

    expect(prepareRequest).toHaveBeenCalledOnce();
    expect(recordRequestPlan).toHaveBeenCalledOnce();
    const plannedCalls = recordRequestPlan.mock.calls[0]?.[0].calls;
    const selectedCalls = recordRequestPlan.mock.calls[0]?.[0].selectedCalls;
    expect(plannedCalls?.length).toBeGreaterThan(1);
    expect(
      plannedCalls?.every(
        ({ plannerLineage }) =>
          plannerLineage?.blueprintId === authoritativeBlueprintId,
      ),
    ).toBe(true);
    expect(selectedCalls).toEqual([plannedCalls?.[1]]);
    expect(prepareRequest.mock.calls[0]?.[0].call).toEqual(plannedCalls?.[1]);
    expect(providerExecute).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(recordRequestFailure).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
    expect(recordRequestSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          source: "cache",
          artifact: expect.objectContaining({
            requestFingerprint: sourceRequestFingerprint,
          }),
        }),
      }),
    );
    expect(client.calls.some(({ text }) =>
      text.includes("INSERT INTO provider_batch_requests")
      || text.includes("INSERT INTO backlink_provider_requests")
      || text.includes("WITH attempted AS")
    )).toBe(false);
  });

  it("only transfers a paused batch from a terminal job without provider risk", async () => {
    const calls: Array<Readonly<{
      text: string;
      values: readonly unknown[];
    }>> = [];
    const client: CommercialDiscoveryQueryClient = {
      async query(text, values = []) {
        calls.push({ text, values });
        if (text.includes("COMMERCIAL_DISCOVERY_BATCH_TAKEOVER")) {
          return {
            rows: [{
              id: "77777777-7777-4777-8777-777777777777",
              disposition: "resumed",
            }],
          };
        }
        return { rows: [] };
      },
    };

    const result = await claimPausedCommercialDiscoveryBatch({
      client,
      scope: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
      },
      contextVersionId: "55555555-5555-4555-8555-555555555555",
      visiblePoolGeneration: 1,
      jobId: "66666666-6666-4666-8666-666666666666",
      refillKey: "commercial-refill:project:context:g1:t1:r1:w1",
      inputBinding,
      actorId: "stage2d-test",
      claimedAt: new Date("2026-08-20T01:00:00.000Z"),
    });

    expect(result).toEqual({
      batchId: "77777777-7777-4777-8777-777777777777",
      disposition: "resumed",
    });
    const takeover = calls.find(({ text }) =>
      text.includes("COMMERCIAL_DISCOVERY_BATCH_TAKEOVER")
    );
    expect(takeover?.text).toContain("FOR UPDATE OF batch");
    expect(takeover?.text).toContain(
      "old_owner.status IN ('partial_success','cancelled')",
    );
    expect(takeover?.text).toContain("batch.status='paused'");
    expect(takeover?.text).toContain(
      "batch.status='running'",
    );
    expect(takeover?.text).toContain("$20::boolean");
    expect(takeover?.text).toContain(
      "SELECT 1 FROM locked_requests",
    );
    expect(takeover?.text).toContain(
      "WHERE status IN ('running','unknown_charge')",
    );
    expect(takeover?.text).toContain(
      "SELECT 1 FROM locked_provider_requests",
    );
    expect(takeover?.text).toContain("status='reserved'");
    expect(takeover?.text).toContain(
      "SELECT 1 FROM locked_leases",
    );
    expect(takeover?.text).toContain(
      "SET refill_job_id=$7::uuid",
    );
    expect(takeover?.text).not.toContain(
      "UPDATE backlink_provider_requests",
    );
    expect(takeover?.text).not.toContain(
      "UPDATE backlink_provider_usage_ledger",
    );
    expect(takeover?.text).not.toContain(
      "UPDATE backlink_commercial_candidates",
    );
  });

  it("recovers an accepted task after its budget period expires", async () => {
    const blueprintId = "88888888-8888-4888-8888-888888888888";
    const runtimeContext = {
      snapshotVersion: 2 as const,
      profileVersionId,
      promotionTargetVersionId,
      projectSettingsVersionId:
        "55555555-5555-4555-8555-555555555555",
      projectSettingsVersion: 1,
      canonicalDomain: "elephtv.com",
      locale: "en",
      countryCode: "ZA",
      products: ["streaming", "film"],
      keywords: ["streaming service in SA"],
      targetUrls: ["https://elephtv.com/"],
      targetAudiences: ["South African viewers"],
      partnershipGoals: ["authoritative film review websites"],
      explicitCompetitorDomains: ["smiletv.net"],
    };
    const blueprint = buildCommercialDiscoveryBlueprint({
      context: {
        projectContextVersionId:
          "44444444-4444-4444-8444-444444444444",
        projectSettingsVersionId:
          runtimeContext.projectSettingsVersionId,
        projectSettingsVersion: runtimeContext.projectSettingsVersion,
        canonicalDomain: runtimeContext.canonicalDomain,
        countries: [runtimeContext.countryCode],
        languages: [runtimeContext.locale],
        products: runtimeContext.products,
        keywords: runtimeContext.keywords,
        promotionTargetUrls: runtimeContext.targetUrls,
        declaredTargetAudiences: runtimeContext.targetAudiences,
        partnershipGoals: runtimeContext.partnershipGoals,
        explicitCompetitorDomains:
          runtimeContext.explicitCompetitorDomains,
        historicalFeedbackDomains: [],
        evidenceRefs: ["project-context:elephtv"],
      },
    });
    const [call] = createCommercialDiscoveryPlan({
      blueprintId,
      searchQueries: buildCommercialTierSearchQueries({
        tier: "exact_product_target_market",
        blueprint,
        context: runtimeContext,
        refillRound: 1,
        refillWindow: 1,
        languageCode: "en",
      }).slice(0, 1),
      verifiedCompetitorDomains: [],
      userDomain: runtimeContext.canonicalDomain,
      locationCode: "2710",
      languageCode: "en",
      endpointAllowlist: [
        "/v3/serp/google/organic/task_post",
      ],
      estimatedCostMicros: 25_000,
      remainingBudgetMicros: 25_000,
    });
    if (call === undefined) throw new Error("Missing semantic recovery call");
    const fingerprint = fingerprintCommercialDiscoveryCall(call);
    const refillKey =
      "commercial-refill:33333333-3333-4333-8333-333333333333:"
      + "44444444-4444-4444-8444-444444444444:g1:t1:r1:w1";
    const requestId = `${refillKey}:1`;
    const jobId = "77777777-7777-4777-8777-777777777777";
    const budgetReservationId =
      `commercial-refill-operation:${jobId}:discovery:`
      + `${refillKey}:${fingerprint}`;
    const client = new MemoryDiscoveryClient(
      null,
      {
        fingerprint,
        batchRequestId: "66666666-6666-4666-8666-666666666666",
        providerTaskId: "provider-task-accepted",
        leaseOwnerRequestId: requestId,
        budgetReserved: true,
        startedAt: new Date("2026-08-17T09:55:00.000Z"),
      },
      {
        endpoint: call.endpoint,
        blueprintId,
        responseSchemaVersion: call.responseSchemaVersion,
        requestFingerprint: fingerprint,
        estimatedCostMicros: call.estimatedCostMicros,
        requestId,
        budgetReservationId,
        requestPayload: serializeCommercialDiscoveryRequestPayload(call),
      },
      0,
    );
    client.seedBlueprint(
      blueprintId,
      JSON.parse(JSON.stringify(blueprint)) as Record<string, unknown>,
    );
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const recoverAcceptedTask = vi.fn(async () => ({
      tasks: [{
        id: "provider-task-accepted",
        status_code: 20000,
        cost: 0.07,
        result: [],
      }],
    }));
    const authorize = vi.fn(async () => {});

    const result = await executeCommercialRecommendationDiscovery({
      client,
      provider: {
        execute: providerExecute,
        recoverAcceptedTask,
      },
      gate: { preflight: async () => {}, authorize },
      safeFetch: {
        fetch: async () => ({
          requestedUrl: "https://elephtv.com/",
          finalUrl: "https://elephtv.com/",
          status: 200,
          contentType: "text/html",
          body: new Uint8Array(),
          redirectChain: [],
          resolvedIps: ["203.0.113.10"],
          fetchedAt: "2026-08-17T10:00:00.000Z",
        }),
      },
      scope: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
      },
      contextVersionId: "44444444-4444-4444-8444-444444444444",
      inputBinding,
      context: runtimeContext,
      configuration: {
        endpointAllowlist: [
          "/v3/serp/google/organic/task_post",
          "/v3/serp/google/organic/task_get/advanced",
        ],
        estimatedCostMicros: 25_000,
        absoluteBudgetMicros: 1_000_000,
        candidateLimit: 25,
        locationCode: "2710",
        languageCode: "en",
      },
      requestedCount: 10,
      visiblePoolGeneration: 1,
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 1,
      jobId,
      actorId: "phase-4-test",
      now: () => new Date("2026-08-17T10:00:00.000Z"),
    });

    expect(result.provider).toMatchObject({
      source: "provider",
      costMicros: 70_000,
    });
    expect(recoverAcceptedTask).toHaveBeenCalledWith(
      call,
      "provider-task-accepted",
    );
    expect(call.plannerLineage).toBeDefined();
    expect(recoverAcceptedTask.mock.calls[0]?.[0].plannerLineage).toEqual(
      call.plannerLineage,
    );
    expect(providerExecute.mock.calls.map(([executedCall]) =>
      fingerprintCommercialDiscoveryCall(executedCall)
    )).not.toContain(fingerprint);
    expect(providerExecute).toHaveBeenCalledTimes(3);
    expect(authorize).toHaveBeenCalledTimes(3);
    const recoveryLookup = client.calls.find(({ text }) =>
      text.includes("DATAFORSEO_ACCEPTED_TASK_RECOVERY_PLAN")
    );
    expect(recoveryLookup?.text).toContain(
      "JOIN backlink_recommendation_refills AS refill",
    );
    expect(recoveryLookup?.text).toContain(
      "refill.refill_window_key=$7",
    );
    expect(recoveryLookup?.values[6]).toBe(refillKey);
    expect(recoveryLookup?.values[6]).not.toBe(
      `commercial-discovery:${refillKey}`,
    );
    expect(recoveryLookup?.text).toContain(
      "batch.budget_reservation_id LIKE $10",
    );
    expect(recoveryLookup?.text).toContain(
      "__growthosDiscoveryPlannerLineage,blueprintId",
    );
    expect(recoveryLookup?.text).not.toContain(
      "FROM backlink_commercial_discovery_batches AS discovery",
    );
    expect(recoveryLookup?.values[9]).toBe(
      `commercial-refill-operation:${jobId}:discovery:${refillKey}:%`,
    );
    const batchOpenIndex = client.calls.findIndex(({ text }) =>
      text.includes("INSERT INTO backlink_commercial_discovery_batches")
    );
    const acceptedRecoveryIndex = client.calls.findIndex(({ text }) =>
      text.includes("DATAFORSEO_WORKER_INTERRUPTED_AFTER_TASK_ACCEPTED")
    );
    expect(batchOpenIndex).toBeGreaterThan(-1);
    expect(acceptedRecoveryIndex).toBeGreaterThan(batchOpenIndex);
    expect(client.calls.filter(({ text }) =>
      text.includes("INSERT INTO provider_batch_requests")
    )).toHaveLength(3);
  });

  it("recovers an accepted task after an expired Worker lease", async () => {
    const call: CommercialDiscoveryCall = {
      endpoint: "/v3/backlinks/referring_domains/live",
      intent: "DISCOVERY",
      sourceType: "USER_REFERRING_DOMAINS",
      request: {
        target: "example.com",
        limit: 25,
      },
      responseSchemaVersion:
        "dataforseo.backlinks-referring-domains-commercial.v1",
      estimatedCostMicros: 25_000,
    };
    const fingerprint = fingerprintCommercialDiscoveryCall(call);
    const leaseOwnerRequestId =
      "commercial-refill:33333333-3333-4333-8333-333333333333:"
      + "44444444-4444-4444-8444-444444444444:g1:t1:r1:w1:1";
    const client = new MemoryDiscoveryClient(null, {
      fingerprint,
      batchRequestId: "66666666-6666-4666-8666-666666666666",
      providerTaskId: "provider-task-accepted",
      leaseOwnerRequestId,
      budgetReserved: true,
      startedAt: new Date("2026-08-17T08:00:00.000Z"),
    });
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const recoverAcceptedTask = vi.fn(async () => ({ tasks: [] }));
    const authorize = vi.fn(async () => {});
    const request = new CommercialDiscoveryRequestService({
      client,
      provider: {
        execute: providerExecute,
        recoverAcceptedTask,
      },
      gate: { preflight: async () => {}, authorize },
      now: () => new Date("2026-08-17T08:05:20.000Z"),
    });

    await expect(request.execute({
      context: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
        requestId: leaseOwnerRequestId,
        idempotencyKey: "commercial-discovery:recovery",
        budgetReservationId: "commercial-refill:recovery",
      },
      projectContextVersionId: "44444444-4444-4444-8444-444444444444",
      call,
      locationCode: "2710",
      languageCode: "en",
      refreshMode: "CACHE_PREFERRED",
      actorId: "phase-4-test",
    })).resolves.toMatchObject({
      source: "provider",
      artifact: {
        providerTaskIds: [],
        candidates: [],
      },
    });

    expect(recoverAcceptedTask).toHaveBeenCalledWith(
      call,
      "provider-task-accepted",
    );
    expect(providerExecute).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    const transitionSql = client.calls.find(({ text }) =>
      text.includes("DATAFORSEO_WORKER_INTERRUPTED_AFTER_TASK_ACCEPTED")
    )?.text ?? "";
    expect(transitionSql).toContain("lease.lease_expires_at<=$8");
    expect(transitionSql).toContain(
      "usage.reservation_key=batch.budget_reservation_id",
    );
    expect(transitionSql).toContain(
      "$1::uuid,$2::uuid,$3::uuid",
    );
    expect(transitionSql).toContain("status='unknown_charge'");
    expect(client.calls.some(({ text }) =>
      text.includes("INSERT INTO provider_batch_requests")
    )).toBe(false);
  });

  it("replays an exact settled native V2 request without provider work", async () => {
    const call: CommercialDiscoveryCall = {
      endpoint: "/v3/serp/google/organic/task_post",
      intent: "DISCOVERY",
      sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
      request: {
        keyword: "South Africa streaming service review sites",
        location_code: 2710,
        language_code: "en",
        depth: 10,
        device: "desktop",
        os: "windows",
      },
      responseSchemaVersion: "dataforseo.serp-google-organic-task-post.v2",
      estimatedCostMicros: 27_600,
      plannerLineage: {
        blueprintId: "88888888-8888-4888-8888-888888888888",
        queryId: "99999999-9999-4999-8999-999999999999",
      },
    };
    const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const reservationId = requestId;
    const artifact = normalizeCommercialDiscoveryResponse({
      call,
      response: {
        tasks: [{
          id: "09021047-1594-0066-0000-946311258027",
          status_code: 20_000,
          cost: 0.0006,
          result: [],
        }],
      },
      collectedAt: "2026-09-02T10:47:20.000Z",
    });
    const client = new MemoryDiscoveryClient();
    client.seedSucceededRequestReplay({
      normalizedPayload: artifact,
      providerRequestId: requestId,
      providerBatchRequestId: requestId,
      providerUsageLedgerId:
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      providerTaskId: "09021047-1594-0066-0000-946311258027",
      actualCostMicros: 600,
    });
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const preflight = vi.fn(async () => {});
    const authorize = vi.fn(async () => {});
    const request = new CommercialDiscoveryRequestService({
      client,
      provider: { execute: providerExecute },
      gate: { preflight, authorize },
      now: () => new Date("2026-09-02T11:00:00.000Z"),
    });

    await expect(request.execute({
      context: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
        requestId,
        idempotencyKey: "recommendation-pool-v2-replay",
        budgetReservationId: reservationId,
      },
      projectContextVersionId: "44444444-4444-4444-8444-444444444444",
      call,
      locationCode: "2710",
      languageCode: "en",
      refreshMode: "FORCE_LIVE",
      actorId: "recommendation-pool-v2-test",
      preserveBudgetReservationId: true,
      allowSucceededRequestReplay: true,
    })).resolves.toMatchObject({
      source: "provider",
      artifact: {
        costMicros: 600,
        providerTaskIds: ["09021047-1594-0066-0000-946311258027"],
      },
      providerTrace: {
        providerRequestId: requestId,
        providerBatchRequestId: requestId,
        providerUsageLedgerId:
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        providerTaskId: "09021047-1594-0066-0000-946311258027",
        actualCostMicros: 600,
      },
    });

    expect(preflight).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(providerExecute).not.toHaveBeenCalled();
    expect(client.calls.some(({ text }) =>
      text.includes("INSERT INTO provider_batch_requests")
      || text.includes("WITH attempted AS")
    )).toBe(false);
    const replay = client.calls.find(({ text }) =>
      text.includes("RECOMMENDATION_POOL_V2_SUCCEEDED_REQUEST_REPLAY")
    );
    expect(replay?.text).toContain("usage.status='settled'");
    expect(replay?.text).toContain("lease.status='completed'");
    expect(replay?.values[7]).toBe(requestId);
    expect(replay?.values[8]).toBe(reservationId);
  });

  it("fails closed when an interrupted request has no accepted task id", async () => {
    const call: CommercialDiscoveryCall = {
      endpoint: "/v3/backlinks/referring_domains/live",
      intent: "DISCOVERY",
      sourceType: "USER_REFERRING_DOMAINS",
      request: {
        target: "example.com",
        limit: 25,
      },
      responseSchemaVersion:
        "dataforseo.backlinks-referring-domains-commercial.v1",
      estimatedCostMicros: 25_000,
    };
    const fingerprint = fingerprintCommercialDiscoveryCall(call);
    const leaseOwnerRequestId =
      "commercial-refill:33333333-3333-4333-8333-333333333333:"
      + "44444444-4444-4444-8444-444444444444:g1:t1:r1:w1:1";
    const client = new MemoryDiscoveryClient(null, {
      fingerprint,
      batchRequestId: "66666666-6666-4666-8666-666666666666",
      providerTaskId: null,
      leaseOwnerRequestId,
      budgetReserved: true,
      startedAt: new Date("2026-08-17T08:00:00.000Z"),
    });
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const recoverAcceptedTask = vi.fn(async () => ({ tasks: [] }));
    const authorize = vi.fn(async () => {});
    const request = new CommercialDiscoveryRequestService({
      client,
      provider: {
        execute: providerExecute,
        recoverAcceptedTask,
      },
      gate: { preflight: async () => {}, authorize },
      now: () => new Date("2026-08-17T08:05:20.000Z"),
    });

    await expect(request.execute({
      context: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
        requestId: leaseOwnerRequestId,
        idempotencyKey: "commercial-discovery:recovery",
        budgetReservationId: "commercial-refill:recovery",
      },
      projectContextVersionId: "44444444-4444-4444-8444-444444444444",
      call,
      locationCode: "2710",
      languageCode: "en",
      refreshMode: "CACHE_PREFERRED",
      actorId: "phase-4-test",
    })).rejects.toThrow(
      "BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED",
    );

    expect(recoverAcceptedTask).not.toHaveBeenCalled();
    expect(providerExecute).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(client.calls.some(({ text }) =>
      text.includes("WITH attempted AS")
      && text.includes("provider_fetch_leases")
    )).toBe(false);
  });

  it("recovers a task found by official dispatch reconciliation without reposting", async () => {
    const call: CommercialDiscoveryCall = {
      endpoint: "/v3/serp/google/organic/task_post",
      intent: "DISCOVERY",
      sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
      request: {
        keyword: "regional streaming industry publications",
        location_code: 2710,
        language_code: "en",
        depth: 10,
        device: "desktop",
        os: "windows",
      },
      responseSchemaVersion: "dataforseo.serp-google-organic-task-post.v2",
      estimatedCostMicros: 25_000,
    };
    const fingerprint = fingerprintCommercialDiscoveryCall(call);
    const leaseOwnerRequestId = "commercial-refill:recovery:accepted:1";
    const client = new MemoryDiscoveryClient(null, {
      fingerprint,
      batchRequestId: "66666666-6666-4666-8666-666666666666",
      providerTaskId: null,
      leaseOwnerRequestId,
      budgetReserved: true,
      startedAt: new Date("2026-08-17T08:00:00.000Z"),
    });
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const recoverAcceptedTask = vi.fn(async () => ({ tasks: [] }));
    const reconcileDispatchedTask = vi.fn(async () => ({
      status: "accepted" as const,
      providerTaskId: "provider-task-reconciled",
    }));
    const authorize = vi.fn(async () => {});
    const request = new CommercialDiscoveryRequestService({
      client,
      provider: {
        execute: providerExecute,
        recoverAcceptedTask,
        reconcileDispatchedTask,
      },
      gate: { preflight: async () => {}, authorize },
      now: () => new Date("2026-08-17T08:05:20.000Z"),
    });

    await expect(request.execute({
      context: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
        requestId: leaseOwnerRequestId,
        idempotencyKey: "commercial-discovery:recovery",
        budgetReservationId: "commercial-refill:recovery",
      },
      projectContextVersionId: "44444444-4444-4444-8444-444444444444",
      call,
      locationCode: "2710",
      languageCode: "en",
      refreshMode: "CACHE_PREFERRED",
      actorId: "phase-4-test",
    })).resolves.toMatchObject({
      source: "provider",
      artifact: { candidates: [] },
    });

    expect(reconcileDispatchedTask).toHaveBeenCalledOnce();
    expect(recoverAcceptedTask).toHaveBeenCalledWith(
      call,
      "provider-task-reconciled",
    );
    expect(providerExecute).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("releases an officially absent dispatch before safely reposting", async () => {
    const call: CommercialDiscoveryCall = {
      endpoint: "/v3/serp/google/organic/task_post",
      intent: "DISCOVERY",
      sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
      request: {
        keyword: "regional streaming industry publications",
        location_code: 2710,
        language_code: "en",
        depth: 10,
        device: "desktop",
        os: "windows",
      },
      responseSchemaVersion: "dataforseo.serp-google-organic-task-post.v2",
      estimatedCostMicros: 25_000,
    };
    const fingerprint = fingerprintCommercialDiscoveryCall(call);
    const leaseOwnerRequestId = "commercial-refill:recovery:not-found:1";
    const client = new MemoryDiscoveryClient(null, {
      fingerprint,
      batchRequestId: "66666666-6666-4666-8666-666666666666",
      providerTaskId: null,
      leaseOwnerRequestId,
      budgetReserved: true,
      startedAt: new Date("2026-08-17T08:00:00.000Z"),
    });
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const recoverAcceptedTask = vi.fn(async () => ({ tasks: [] }));
    const reconcileDispatchedTask = vi.fn(async () => ({
      status: "not_found" as const,
    }));
    const authorize = vi.fn(async () => {});
    const request = new CommercialDiscoveryRequestService({
      client,
      provider: {
        execute: providerExecute,
        recoverAcceptedTask,
        reconcileDispatchedTask,
      },
      gate: { preflight: async () => {}, authorize },
      now: () => new Date("2026-08-17T08:05:20.000Z"),
    });

    await expect(request.execute({
      context: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
        requestId: leaseOwnerRequestId,
        idempotencyKey: "commercial-discovery:recovery",
        budgetReservationId: "commercial-refill:recovery",
      },
      projectContextVersionId: "44444444-4444-4444-8444-444444444444",
      call,
      locationCode: "2710",
      languageCode: "en",
      refreshMode: "CACHE_PREFERRED",
      actorId: "phase-4-test",
    })).resolves.toMatchObject({
      source: "provider",
      artifact: { candidates: [] },
    });

    expect(reconcileDispatchedTask).toHaveBeenCalledOnce();
    expect(client.calls.some(({ text }) =>
      text.includes("DATAFORSEO_RECONCILED_NOT_DISPATCHED")
    )).toBe(true);
    expect(providerExecute).toHaveBeenCalledOnce();
    expect(recoverAcceptedTask).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledOnce();
  });

  it("does not create a new provider request when recovery state changes", async () => {
    const call: CommercialDiscoveryCall = {
      endpoint: "/v3/serp/google/organic/task_post",
      intent: "DISCOVERY",
      sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
      request: {
        keyword: "streaming review",
        location_code: 2710,
        language_code: "en",
        depth: 10,
        device: "desktop",
        os: "windows",
      },
      responseSchemaVersion: "dataforseo.serp-google-organic-task-post.v2",
      estimatedCostMicros: 25_000,
    };
    const client = new MemoryDiscoveryClient();
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const recoverAcceptedTask = vi.fn(async () => ({ tasks: [] }));
    const authorize = vi.fn(async () => {});
    const request = new CommercialDiscoveryRequestService({
      client,
      provider: {
        execute: providerExecute,
        recoverAcceptedTask,
      },
      gate: { preflight: async () => {}, authorize },
      now: () => new Date("2026-08-17T10:00:00.000Z"),
    });

    await expect(request.execute({
      context: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
        requestId: "commercial-refill:recovery:1",
        idempotencyKey: "commercial-discovery:recovery",
        budgetReservationId: "commercial-refill:recovery",
      },
      projectContextVersionId: "44444444-4444-4444-8444-444444444444",
      call,
      locationCode: "2710",
      languageCode: "en",
      refreshMode: "CACHE_PREFERRED",
      actorId: "phase-4-test",
      recoveryOnly: true,
    })).rejects.toThrow(
      "DATAFORSEO_ACCEPTED_TASK_RECOVERY_STATE_CHANGED",
    );

    expect(providerExecute).not.toHaveBeenCalled();
    expect(recoverAcceptedTask).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(client.calls.some(({ text }) =>
      text.includes("INSERT INTO provider_batch_requests")
    )).toBe(false);
  });

  it("does not redispatch a reconciled charged request without a result", async () => {
    const call: CommercialDiscoveryCall = {
      endpoint: "/v3/backlinks/referring_domains/live",
      intent: "DISCOVERY",
      sourceType: "USER_REFERRING_DOMAINS",
      request: {
        target: "silksleepwear.com",
        limit: 100,
      },
      responseSchemaVersion:
        "dataforseo.backlinks-referring-domains-commercial.v1",
      estimatedCostMicros: 27_600,
    };
    const client = new MemoryDiscoveryClient(
      fingerprintCommercialDiscoveryCall(call),
    );
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const authorize = vi.fn(async () => {});
    const request = new CommercialDiscoveryRequestService({
      client,
      provider: { execute: providerExecute },
      gate: { preflight: async () => {}, authorize },
      now: () => new Date("2026-08-13T10:58:00.000Z"),
    });

    await expect(request.execute({
      context: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
        requestId:
          "commercial-refill:33333333-3333-4333-8333-333333333333:"
          + "44444444-4444-4444-8444-444444444444:g1:t1:r1:w1:22",
        idempotencyKey: "commercial-discovery:reconciled",
        budgetReservationId: "commercial-refill:reconciled",
      },
      projectContextVersionId: "44444444-4444-4444-8444-444444444444",
      call,
      locationCode: "2840",
      languageCode: "en",
      refreshMode: "CACHE_PREFERRED",
      actorId: "local-product-038-test",
    })).rejects.toMatchObject({
      message: "DATAFORSEO_RECONCILED_NO_RESULT",
      providerRequestStatus: "failed",
    });
    expect(providerExecute).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(client.calls.some(({ text }) =>
      text.includes("INSERT INTO provider_batch_requests")
    )).toBe(false);
    expect(client.calls.some(({ text }) =>
      text.includes("provider_fetch_leases")
      && text.includes("WITH attempted AS")
    )).toBe(false);
  });

  it("blocks before lease, batch, budget reservation, or provider execution", async () => {
    const call: CommercialDiscoveryCall = {
      endpoint: "/v3/serp/google/organic/task_post",
      intent: "DISCOVERY",
      sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
      request: {
        keyword: "streaming review publication",
        location_code: 2710,
        language_code: "en",
        depth: 10,
        device: "desktop",
        os: "windows",
      },
      responseSchemaVersion: "dataforseo.serp-google-organic-task-post.v2",
      estimatedCostMicros: 25_000,
    };
    const client = new MemoryDiscoveryClient();
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const authorize = vi.fn(async () => {});
    const preflight = vi.fn(async () => {
      throw new Error("DATAFORSEO_OPERATION_NOT_AUTHORIZED");
    });
    const request = new CommercialDiscoveryRequestService({
      client,
      provider: { execute: providerExecute },
      gate: { preflight, authorize },
      now: () => new Date("2026-08-19T10:00:00.000Z"),
    });

    await expect(request.execute({
      context: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
        requestId: "commercial-refill:preflight-denied",
        idempotencyKey: "commercial-refill:preflight-denied",
        budgetReservationId: "commercial-refill:preflight-denied",
      },
      projectContextVersionId: "44444444-4444-4444-8444-444444444444",
      call,
      locationCode: "2710",
      languageCode: "en",
      refreshMode: "FORCE_LIVE",
      actorId: "stage2d-test",
    })).rejects.toThrow("DATAFORSEO_OPERATION_NOT_AUTHORIZED");

    expect(preflight).toHaveBeenCalledOnce();
    expect(authorize).not.toHaveBeenCalled();
    expect(providerExecute).not.toHaveBeenCalled();
    expect(client.calls.some(({ text }) =>
      text.includes("WITH attempted AS")
      && text.includes("provider_fetch_leases")
    )).toBe(false);
    expect(client.calls.some(({ text }) =>
      text.includes("INSERT INTO provider_batch_requests")
      || text.includes("INSERT INTO backlink_provider_requests")
      || text === "BEGIN"
    )).toBe(false);
  });

  it("reuses one Blueprint and one provider artifact for the same Context", async () => {
    const client = new MemoryDiscoveryClient();
    const generate = vi.fn(async () => ({
      output: {
        targetAudience: ["pool owners"],
        productValuePropositions: ["robotic pool cleaning"],
        topicClusters: ["pool maintenance"],
        searchQueryClusters: [
          "United States robotic pool cleaner blogs",
          "United States robotic pool cleaner publications",
          "\"robotic pool cleaner\" \"write for us\" United States",
          "United States robotic pool cleaner resource directory",
        ],
        targetSiteArchetypes: ["pool care publication"],
        cooperationAngles: ["editorial review"],
        negativeKeywords: [],
        excludedSiteTypes: ["link marketplace"],
        discoveredCompetitorSeeds: ["untrusted-competitor.example"],
      },
      model: {
        providerRef: "openai",
        modelId: "model-1",
        modelVersion: "2026-08-10",
      },
      generation: {
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUsd: 0.0002,
        latencyMs: 25,
      },
    }));
    const providerExecute = vi.fn(async (
      _call: unknown,
      hooks?: Readonly<{
        onProviderTaskAccepted?(taskId: string): Promise<void> | void;
      }>,
    ) => {
      await hooks?.onProviderTaskAccepted?.("provider-task-persisted");
      return { tasks: [] };
    });
    const authorize = vi.fn(async () => {});
    const fetch = vi.fn(async () => ({
      requestedUrl: "https://aiper.com/",
      finalUrl: "https://aiper.com/",
      status: 200,
      contentType: "text/html",
      body: new Uint8Array(),
      redirectChain: [],
      resolvedIps: ["203.0.113.10"],
      fetchedAt: "2026-08-10T02:00:00.000Z",
    }));
    let tick = 0;
    const run = (jobId: string) =>
      executeCommercialRecommendationDiscovery({
        client,
        provider: { execute: providerExecute },
        gate: { preflight: async () => {}, authorize },
        safeFetch: { fetch },
        scope: {
          organizationId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          websiteProjectId: "33333333-3333-4333-8333-333333333333",
        },
        contextVersionId: "44444444-4444-4444-8444-444444444444",
        inputBinding,
        context: {
          snapshotVersion: 2,
          profileVersionId,
          promotionTargetVersionId,
          projectSettingsVersionId:
            "55555555-5555-4555-8555-555555555555",
          projectSettingsVersion: 1,
          canonicalDomain: "aiper.com",
          locale: "en-US",
          countryCode: "US",
          products: ["robotic pool cleaner"],
          keywords: ["pool cleaning"],
          targetUrls: ["https://aiper.com/"],
          targetAudiences: ["pool owners"],
          partnershipGoals: ["editorial review"],
          explicitCompetitorDomains: [],
        },
        configuration: {
          endpointAllowlist: [
            "/v3/serp/google/organic/task_post",
          ],
          estimatedCostMicros: 1_000,
          absoluteBudgetMicros: 10_000,
          candidateLimit: 25,
          locationCode: "2840",
          languageCode: "en",
        },
        blueprintGenerator: { generate },
        requestedCount: 10,
        visiblePoolGeneration: 1,
        refillTier: "exact_product_target_market",
        refillRound: 1,
        jobId,
        providerBudgetOperationPrefix:
          `commercial-refill-operation:${jobId}`,
        actorId: "local-product-029-test",
        now: () => new Date(
          Date.parse("2026-08-10T02:00:00.000Z") + tick++ * 1_000,
        ),
      });

    const first = await run("job-1");
    const second = await run("job-2");

    expect(first.provider.source).toBe("provider");
    expect(second.provider.source).toBe("cache");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(providerExecute).toHaveBeenCalledTimes(4);
    expect(authorize).toHaveBeenCalledTimes(4);
    const persistedArtifact = client.calls.find(({ text }) =>
      text.includes("INSERT INTO backlink_commercial_discovery_artifacts")
    );
    expect(JSON.parse(String(persistedArtifact?.values[9])).rawResponse)
      .toEqual({ tasks: [] });
    expect(client.calls.some(({ text, values }) =>
      text.includes("SET provider_task_id=$2")
      && values[1] === "provider-task-persisted"
    )).toBe(true);
    const authorizedGateInput = authorize.mock.calls[0]?.[0];
    const authorizedContext = authorizedGateInput.context;
    const insertedBatch = client.calls.find(({ text }) =>
      text.includes("INSERT INTO provider_batch_requests")
    );
    expect(authorizedContext.budgetReservationId).toMatch(
      /^commercial-refill-operation:job-1:discovery:commercial-refill:.*:[0-9a-f-]{36}$/u,
    );
    expect(insertedBatch?.values[13]).toBe(
      authorizedContext.budgetReservationId,
    );
    expect(authorizedGateInput.requiredRemainingPaidCalls).toBe(0);
    expect(authorizedGateInput.requiredRemainingCostMicros).toBe(0);
    const discoveryBatch = client.calls.find(({ text }) =>
      text.includes("INSERT INTO backlink_commercial_discovery_batches")
    );
    expect(discoveryBatch?.text).toContain("refill_job_id");
    expect(discoveryBatch?.values[7]).toBe("job-1");
    const completedBatchUpdate = client.calls.find(({ text }) =>
      text.includes("provider_request_fingerprints=$7::jsonb")
    );
    expect(completedBatchUpdate?.text).toContain(
      "backlink_commercial_discovery_batches.status",
    );
    expect(completedBatchUpdate?.text).toContain(
      "AND $5 IN ('paused','unavailable')",
    );
    expect(completedBatchUpdate?.text).toContain(
      "backlink_commercial_discovery_batches.finished_at",
    );
    expect(completedBatchUpdate?.text).toContain(
      "raw_candidate_count=$12",
    );
    expect(completedBatchUpdate?.values[11]).toBe(0);
    const inventoryPolicyUpdate = client.calls.find(({ text }) =>
      text.includes("last_raw_candidate_count=$9")
    );
    expect(inventoryPolicyUpdate?.values[8]).toBe(0);
  });

  it("skips a planned provider call when exact shared evidence is reusable", async () => {
    const client = new MemoryDiscoveryClient();
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const authorize = vi.fn(async () => {});
    const readReusable = vi.fn(async (call: CommercialDiscoveryCall) => ({
      sourceType: call.sourceType,
      endpoint: call.endpoint,
      requestFingerprint: fingerprintCommercialDiscoveryCall(call),
      responseSchemaVersion: call.responseSchemaVersion,
      collectedAt: "2026-08-15T02:00:00.000Z",
      costMicros: 1_000,
      providerTaskIds: ["shared-task-1"],
      candidates: [],
      ...(call.plannerLineage === undefined
        ? {}
        : { plannerLineage: call.plannerLineage }),
    }));

    const result = await executeCommercialRecommendationDiscovery({
      client,
      provider: { execute: providerExecute },
      gate: { preflight: async () => {}, authorize },
      safeFetch: {
        fetch: async () => ({
          requestedUrl: "https://aiper.com/",
          finalUrl: "https://aiper.com/",
          status: 200,
          contentType: "text/html",
          body: new Uint8Array(),
          redirectChain: [],
          resolvedIps: ["203.0.113.10"],
          fetchedAt: "2026-08-15T02:00:00.000Z",
        }),
      },
      scope: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
      },
      contextVersionId: "44444444-4444-4444-8444-444444444444",
      inputBinding,
      context: {
        snapshotVersion: 2,
        profileVersionId,
        promotionTargetVersionId,
        projectSettingsVersionId:
          "55555555-5555-4555-8555-555555555555",
        projectSettingsVersion: 1,
        canonicalDomain: "aiper.com",
        locale: "en-US",
        countryCode: "US",
        products: ["robotic pool cleaner"],
        keywords: ["pool cleaning"],
        targetUrls: ["https://aiper.com/"],
        targetAudiences: ["pool owners"],
        partnershipGoals: ["editorial review"],
        explicitCompetitorDomains: [],
      },
      configuration: {
          endpointAllowlist: [
            "/v3/serp/google/organic/task_post",
          ],
        estimatedCostMicros: 1_000,
        absoluteBudgetMicros: 10_000,
        candidateLimit: 25,
        locationCode: "2840",
        languageCode: "en",
      },
      sharedEvidence: { readReusable },
      requestedCount: 10,
      visiblePoolGeneration: 1,
      refillTier: "exact_product_target_market",
      refillRound: 1,
      jobId: "job-shared-evidence",
      actorId: "phase-4-test",
      now: () => new Date("2026-08-15T02:00:00.000Z"),
    });

    expect(result.provider).toMatchObject({
      source: "cache",
      costMicros: 0,
    });
    expect(readReusable.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(providerExecute).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("runs the curated resource tier without paid provider or AI transport", async () => {
    const client = new MemoryDiscoveryClient();
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const authorize = vi.fn(async () => {});
    const fetch = vi.fn();

    const result = await executeCommercialRecommendationDiscovery({
      client,
      provider: { execute: providerExecute },
      gate: { preflight: async () => {}, authorize },
      safeFetch: { fetch },
      scope: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
      },
      contextVersionId: "44444444-4444-4444-8444-444444444444",
      inputBinding,
      context: {
        snapshotVersion: 2,
        profileVersionId,
        promotionTargetVersionId,
        projectSettingsVersionId:
          "55555555-5555-4555-8555-555555555555",
        projectSettingsVersion: 1,
        canonicalDomain: "sunleadcrm.com",
        locale: "en-US",
        countryCode: "US",
        products: ["solar installer CRM"],
        keywords: ["solar lead management"],
        targetUrls: ["https://sunleadcrm.com/"],
        targetAudiences: ["residential solar installers"],
        partnershipGoals: ["renewable energy sales workflow guide"],
        explicitCompetitorDomains: [],
      },
      configuration: {
        endpointAllowlist: [
          "/v3/dataforseo_labs/google/competitors_domain/live",
        ],
        estimatedCostMicros: 1_000,
        absoluteBudgetMicros: 10_000,
        candidateLimit: 25,
        locationCode: "2840",
        languageCode: "en",
      },
      requestedCount: 10,
      visiblePoolGeneration: 1,
      refillTier: "curated_resource_library",
      refillRound: 1,
      refillWindow: 1,
      jobId: "job-resource",
      actorId: "local-product-036-test",
      now: () => new Date("2026-08-11T02:00:00.000Z"),
    });

    expect(result.provider).toMatchObject({
      source: "cache",
      costMicros: 0,
    });
    expect(result.candidates).toEqual([]);
    expect(providerExecute).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const resourceQuery = client.calls.find(({ text }) =>
      text.includes("FROM backlink_resource_library_items")
    );
    expect(resourceQuery?.text).not.toContain(
      "ORDER BY authority_score DESC",
    );
    expect(resourceQuery?.text).not.toContain("LIMIT $3");
    expect(resourceQuery?.values).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("uses disjoint persisted query windows before widening the round", () => {
    const blueprint = buildCommercialDiscoveryBlueprint({
      context: {
        projectContextVersionId: "context-silk",
        projectSettingsVersionId: "settings-silk",
        projectSettingsVersion: 1,
        canonicalDomain: "silksleepwear.com",
        countries: ["US"],
        languages: ["en"],
        products: ["silk pajamas"],
        keywords: ["silk sleepwear"],
        promotionTargetUrls: ["https://silksleepwear.com/"],
        declaredTargetAudiences: ["women"],
        partnershipGoals: ["editorial review"],
        explicitCompetitorDomains: [],
        historicalFeedbackDomains: [],
        evidenceRefs: ["project-context:silk"],
      },
    });
    const context = {
      snapshotVersion: 2 as const,
      projectSettingsVersionId: "settings-silk",
      projectSettingsVersion: 1,
      canonicalDomain: "silksleepwear.com",
      locale: "en-US",
      countryCode: "US",
      products: ["silk pajamas"],
      keywords: ["silk sleepwear"],
      targetUrls: ["https://silksleepwear.com/"],
      targetAudiences: ["women"],
      partnershipGoals: ["editorial review"],
      explicitCompetitorDomains: [],
    };
    const queries = (refillRound: number, refillWindow: number) =>
      buildCommercialTierSearchQueries({
        tier: "exact_product_target_market",
        blueprint,
        context,
        refillRound,
        refillWindow,
        languageCode: "en",
      });
    const first = queries(1, 1);
    const second = queries(1, 2);
    const broader = queries(2, 1);
    const thirdWindow = queries(1, 3);

    expect(first).toHaveLength(6);
    expect(second).toHaveLength(6);
    expect(broader).toHaveLength(6);
    expect(thirdWindow).toHaveLength(6);
    expect(first.filter((query) => second.includes(query))).toEqual([]);
    expect(first.filter((query) => broader.includes(query))).toEqual([]);
    expect(second.filter((query) => broader.includes(query))).toEqual([]);
    expect(thirdWindow.filter((query) => broader.includes(query))).toEqual([]);
    expect([...first, ...second, ...broader, ...thirdWindow].every((query) =>
      query.includes("United States")
    )).toBe(true);
  });

  it("filters language before subject limits without exposing raw goals", () => {
    const context = {
      snapshotVersion: 2 as const,
      profileVersionId,
      promotionTargetVersionId,
      projectSettingsVersionId: "settings-elephtv",
      projectSettingsVersion: 1,
      canonicalDomain: "elephtv.com",
      locale: "en-ZA",
      countryCode: "ZA",
      products: ["直播", "影视"],
      keywords: [
        "South African live streaming guide",
        "independent film reviews",
      ],
      targetUrls: ["https://elephtv.com/watch/live"],
      targetAudiences: ["南非流媒体观众"],
      partnershipGoals: [
        "获取权威影视评测 / authoritative film review backlinks",
      ],
      explicitCompetitorDomains: [],
    };
    const blueprint = buildCommercialDiscoveryBlueprint({
      context: {
        projectContextVersionId: "context-elephtv",
        projectSettingsVersionId: "settings-elephtv",
        projectSettingsVersion: 1,
        canonicalDomain: "elephtv.com",
        countries: ["ZA"],
        languages: ["en"],
        products: context.products,
        keywords: context.keywords,
        promotionTargetUrls: context.targetUrls,
        declaredTargetAudiences: context.targetAudiences,
        partnershipGoals: context.partnershipGoals,
        explicitCompetitorDomains: [],
        historicalFeedbackDomains: [],
        evidenceRefs: ["project-context:elephtv"],
      },
    });

    const queries = buildCommercialTierSearchQueries({
      tier: "exact_product_target_market",
      blueprint,
      context,
      refillRound: 1,
      refillWindow: 1,
      languageCode: "en",
    });

    expect(queries).toHaveLength(6);
    expect(queries.some((query) =>
      query.includes("South African live streaming guide")
    )).toBe(true);
    expect(queries.every((query) => !/\p{Script=Han}/u.test(query))).toBe(true);
    expect(queries.every((query) =>
      !query.toLowerCase().includes("authoritative film review backlinks")
    )).toBe(true);
    expect(queries.every((query) => !query.includes("elephtv.com"))).toBe(true);
  });

  it("blocks a raw partnership goal embedded in a Blueprint query cluster", () => {
    const rawGoal = "authoritative film review backlinks";
    const context = {
      snapshotVersion: 2 as const,
      profileVersionId,
      promotionTargetVersionId,
      projectSettingsVersionId: "settings-goal-boundary",
      projectSettingsVersion: 1,
      canonicalDomain: "elephtv.com",
      locale: "en-ZA",
      countryCode: "ZA",
      products: ["影视"],
      keywords: [rawGoal],
      targetUrls: ["https://elephtv.com/watch/live"],
      targetAudiences: ["南非流媒体观众"],
      partnershipGoals: [`获取权威影视评测 / ${rawGoal}`],
      explicitCompetitorDomains: [],
    };
    const generated = buildCommercialDiscoveryBlueprint({
      context: {
        projectContextVersionId: "context-goal-boundary",
        projectSettingsVersionId: "settings-goal-boundary",
        projectSettingsVersion: 1,
        canonicalDomain: "elephtv.com",
        countries: ["ZA"],
        languages: ["en"],
        products: context.products,
        keywords: context.keywords,
        promotionTargetUrls: context.targetUrls,
        declaredTargetAudiences: context.targetAudiences,
        partnershipGoals: context.partnershipGoals,
        explicitCompetitorDomains: [],
        historicalFeedbackDomains: [],
        evidenceRefs: ["project-context:goal-boundary"],
      },
    });
    const blueprint = Object.freeze({
      ...generated,
      topicClusters: Object.freeze(["streaming media"]),
      searchQueryClusters: Object.freeze([
        `${rawGoal} publication`,
        "streaming media publication",
      ]),
    });

    const queries = buildCommercialTierSearchQueries({
      tier: "exact_product_target_market",
      blueprint,
      context,
      refillRound: 1,
      refillWindow: 1,
      languageCode: "en",
    });

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((query) => query.includes("streaming media"))).toBe(true);
    expect(queries.every((query) =>
      !query.toLowerCase().includes(rawGoal)
    )).toBe(true);
  });

  it("keeps AI queries exclusive by default and expands native V2 planning", () => {
    const aiQueries = [
      "South Africa streaming television blogs",
      "South Africa independent film publications",
      "streaming television contributor sites South Africa",
      "South Africa entertainment resource submissions",
    ];
    const context = {
      snapshotVersion: 2 as const,
      profileVersionId,
      promotionTargetVersionId,
      projectSettingsVersionId: "settings-ai-query-plan",
      projectSettingsVersion: 1,
      canonicalDomain: "elephtv.com",
      locale: "en-ZA",
      countryCode: "ZA",
      products: ["直播", "影视"],
      keywords: ["South African streaming guide"],
      targetUrls: ["https://elephtv.com/watch/live"],
      targetAudiences: ["South African streaming viewers"],
      partnershipGoals: ["editorial review backlinks"],
      explicitCompetitorDomains: [],
    };
    const blueprint = buildCommercialDiscoveryBlueprint({
      context: {
        projectContextVersionId: "context-ai-query-plan",
        projectSettingsVersionId: "settings-ai-query-plan",
        projectSettingsVersion: 1,
        canonicalDomain: context.canonicalDomain,
        countries: ["ZA"],
        languages: ["en"],
        products: context.products,
        keywords: context.keywords,
        promotionTargetUrls: context.targetUrls,
        declaredTargetAudiences: context.targetAudiences,
        partnershipGoals: context.partnershipGoals,
        explicitCompetitorDomains: [],
        historicalFeedbackDomains: [],
        evidenceRefs: ["project-context:ai-query-plan"],
      },
      aiOutput: {
        targetAudience: context.targetAudiences,
        productValuePropositions: ["live television streaming"],
        topicClusters: ["streaming television", "independent film"],
        searchQueryClusters: aiQueries,
        targetSiteArchetypes: ["regional entertainment publication"],
        cooperationAngles: ["editorial contribution"],
        negativeKeywords: [],
        excludedSiteTypes: ["general platform"],
        discoveredCompetitorSeeds: [],
      },
      aiModel: {
        providerRef: "openai",
        modelId: "gpt-5.6-terra",
        modelVersion: "2026-08-21",
      },
      aiGeneration: {
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUsd: 0.0002,
        latencyMs: 25,
      },
    });

    const firstWindow = buildCommercialTierSearchQueries({
      tier: "exact_product_target_market",
      blueprint,
      context,
      refillRound: 1,
      refillWindow: 1,
      languageCode: "en",
    });
    const secondWindow = buildCommercialTierSearchQueries({
      tier: "exact_product_target_market",
      blueprint,
      context,
      refillRound: 1,
      refillWindow: 2,
      languageCode: "en",
    });
    const nativeV2Plan = buildCommercialTierSearchQueries({
      tier: "exact_product_target_market",
      blueprint,
      context,
      refillRound: 1,
      refillWindow: 1,
      languageCode: "en",
      queryOffset: 0,
      queryLimit: 64,
      includeDeterministicExpansion: true,
    });

    expect(blueprint.generator).toBe("AI");
    expect(firstWindow).toEqual(aiQueries);
    expect(secondWindow).toEqual([]);
    expect(firstWindow.every((query) =>
      !query.includes("local or regional publication")
      && !query.includes("adjacent industry publication")
    )).toBe(true);
    expect(nativeV2Plan.slice(0, aiQueries.length)).toEqual(aiQueries);
    expect(nativeV2Plan.length).toBeGreaterThan(aiQueries.length);
    expect(nativeV2Plan.some((query) =>
      !aiQueries.includes(query) && query.includes("blogs")
    )).toBe(true);
    expect(nativeV2Plan.every((query) =>
      !query.includes("elephtv.com")
      && !query.toLowerCase().includes("editorial review backlinks")
    )).toBe(true);

    const candidatePlan = createCommercialDiscoveryPlan({
      blueprintId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      searchQueries: nativeV2Plan,
      verifiedCompetitorDomains: [],
      userDomain: context.canonicalDomain,
      locationCode: "2710",
      languageCode: "en",
      endpointAllowlist: ["/v3/serp/google/organic/task_post"],
      estimatedCostMicros: 1_000,
      remainingBudgetMicros: Number.MAX_SAFE_INTEGER,
    });
    const exhaustedAiFingerprints = new Set(
      candidatePlan
        .filter(({ request }) =>
          aiQueries.includes(String(request.keyword))
        )
        .map(fingerprintCommercialDiscoverySemanticRequest),
    );
    const freshCalls = candidatePlan.filter((call) =>
      !exhaustedAiFingerprints.has(
        fingerprintCommercialDiscoverySemanticRequest(call),
      )
    );

    expect(exhaustedAiFingerprints.size).toBe(aiQueries.length);
    expect(freshCalls.length).toBeGreaterThan(0);
    expect(aiQueries).not.toContain(freshCalls[0]?.request.keyword);
  });

  it("interleaves project, category, competitor, and audience seeds deterministically", () => {
    const context = {
      snapshotVersion: 2 as const,
      profileVersionId,
      promotionTargetVersionId,
      projectSettingsVersionId: "settings-balanced-plan",
      projectSettingsVersion: 1,
      canonicalDomain: "project.com",
      locale: "en-US",
      countryCode: "US",
      products: ["product alpha"],
      keywords: ["keyword alpha"],
      targetUrls: ["https://project.com/"],
      targetAudiences: ["audience alpha"],
      partnershipGoals: ["editorial review"],
      explicitCompetitorDomains: ["competitor.com"],
    };
    const generated = buildCommercialDiscoveryBlueprint({
      context: {
        projectContextVersionId: "context-balanced-plan",
        projectSettingsVersionId: context.projectSettingsVersionId,
        projectSettingsVersion: context.projectSettingsVersion,
        canonicalDomain: context.canonicalDomain,
        countries: ["US"],
        languages: ["en"],
        products: context.products,
        keywords: context.keywords,
        promotionTargetUrls: context.targetUrls,
        declaredTargetAudiences: context.targetAudiences,
        partnershipGoals: context.partnershipGoals,
        explicitCompetitorDomains: context.explicitCompetitorDomains,
        historicalFeedbackDomains: [],
        evidenceRefs: ["project-context:balanced-plan"],
      },
    });
    const blueprint = Object.freeze({
      ...generated,
      searchQueryClusters: Object.freeze([]),
      topicClusters: Object.freeze(["category alpha"]),
      discoveredCompetitorSeeds: Object.freeze(["competitor.com"]),
    });
    const build = () =>
      buildCommercialTierSearchQueries({
        tier: "exact_product_target_market",
        blueprint,
        context,
        refillRound: 1,
        refillWindow: 1,
        languageCode: "en",
        queryOffset: 0,
        queryLimit: 10,
        includeDeterministicExpansion: true,
      });

    const first = build();
    expect(build()).toEqual(first);
    expect(first.slice(0, 5).every((query) => query.endsWith("blogs"))).toBe(
      true,
    );
    expect(first.slice(0, 5)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("keyword alpha"),
        expect.stringContaining("product alpha"),
        expect.stringContaining("category alpha"),
        expect.stringContaining("competitor.com"),
        expect.stringContaining("audience alpha"),
      ]),
    );
  });

  it("interleaves confirmed competitor backlinks and search within the existing budget", () => {
    const calls = createCommercialDiscoveryPlan({
      blueprintId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      searchQueries: ["pool cleaner reviews", "robotic pool maintenance"],
      verifiedCompetitorDomains: ["competitor.com", "second.com"],
      userDomain: "project.com", locationCode: "2840", languageCode: "en",
      endpointAllowlist: ["/v3/serp/google/organic/task_post", "/v3/backlinks/backlinks/live",
        "/v3/backlinks/referring_domains/live"],
      estimatedCostMicros: 250_000, remainingBudgetMicros: Number.MAX_SAFE_INTEGER,
    });
    const ordered = orderCommercialNativeV2DiscoveryCalls(calls);
    expect(ordered.map((call) => call.sourceType)).toEqual([
      "VERIFIED_COMPETITOR_REFERRING_DOMAINS", "BLUEPRINT_SERP_STANDARD_QUEUE",
      "VERIFIED_COMPETITOR_REFERRING_DOMAINS", "BLUEPRINT_SERP_STANDARD_QUEUE",
    ]);
    expect(ordered[0]?.request).toMatchObject({
      target: "competitor.com", limit: 100, mode: "one_per_domain",
      backlinks_status_type: "live",
    });
    expect(ordered[0]?.plannerLineage?.blueprintId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(ordered[0]?.plannerLineage?.queryId).not.toBe(ordered[2]?.plannerLineage?.queryId);
    expect(selectCommercialNativeV2RequestPlan({
      calls: ordered, maxRequests: 4, maxAuthorizedCostMicros: 500_000,
    })).toEqual(ordered.slice(0, 2));
  });

  it("selects multiple native V2 requests without exceeding the round authorization", () => {
    const calls = createCommercialDiscoveryPlan({
      blueprintId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      searchQueries: [
        "query one",
        "query two",
        "query three",
        "query four",
        "query five",
      ],
      verifiedCompetitorDomains: [],
      userDomain: "project.com",
      locationCode: "2840",
      languageCode: "en",
      endpointAllowlist: ["/v3/serp/google/organic/task_post"],
      estimatedCostMicros: 400_000,
      remainingBudgetMicros: Number.MAX_SAFE_INTEGER,
    });

    const selected = selectCommercialNativeV2RequestPlan({
      calls,
      requestOffset: 1,
      maxRequests: 4,
      maxAuthorizedCostMicros: 1_000_000,
    });

    expect(selected).toEqual(calls.slice(1, 3));
    expect(
      selected.reduce(
        (total, call) => total + call.estimatedCostMicros,
        0,
      ),
    ).toBe(800_000);
  });

  it("lets Terra normalize stored project facts into target-language queries", async () => {
    const client = new MemoryDiscoveryClient();
    const providerExecute = vi.fn(async (call: CommercialDiscoveryCall) => {
      if (call.sourceType === "BLUEPRINT_SERP_STANDARD_QUEUE") {
        expect(client.calls.some(({ text }) =>
          text.includes("INSERT INTO backlink_commercial_discovery_blueprints")
        )).toBe(true);
        expect(call.plannerLineage).toMatchObject({
          blueprintId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f-]{27}$/u,
          ),
          queryId: expect.stringMatching(/^[0-9a-f]{64}$/u),
        });
        expect(call.request).not.toHaveProperty(
          "__growthosDiscoveryPlannerLineage",
        );
      }
      return { tasks: [] };
    });
    const authorize = vi.fn(async () => {});
    const aiQueries = [
      "South Africa streaming service blogs",
      "South Africa online television publications",
      "streaming contributor sites South Africa",
      "South Africa entertainment media kit",
    ];
    const generate = vi.fn(async () => ({
      output: {
        targetAudience: ["South African streaming viewers"],
        productValuePropositions: ["live television streaming"],
        topicClusters: ["streaming service", "online television"],
        searchQueryClusters: aiQueries,
        targetSiteArchetypes: ["regional entertainment publication"],
        cooperationAngles: ["editorial contribution"],
        negativeKeywords: [],
        excludedSiteTypes: ["general platform"],
        discoveredCompetitorSeeds: [],
      },
      model: {
        providerRef: "openai",
        modelId: "gpt-5.6-terra",
        modelVersion: "2026-08-21",
      },
      generation: {
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUsd: 0.0002,
        latencyMs: 25,
      },
    }));

    await executeCommercialRecommendationDiscovery({
      client,
      provider: { execute: providerExecute },
      gate: { preflight: async () => {}, authorize },
      blueprintGenerator: { generate },
      safeFetch: {
        fetch: async () => {
          throw new Error("SAFE_FETCH_MUST_NOT_RUN");
        },
      },
      scope: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
      },
      contextVersionId: "44444444-4444-4444-8444-444444444444",
      inputBinding,
      context: {
        snapshotVersion: 2,
        profileVersionId,
        promotionTargetVersionId,
        projectSettingsVersionId:
          "55555555-5555-4555-8555-555555555555",
        projectSettingsVersion: 1,
        canonicalDomain: "elephtv.com",
        locale: "en-ZA",
        countryCode: "ZA",
        products: ["直播", "影视"],
        keywords: [],
        targetUrls: ["https://elephtv.com/watch/live"],
        targetAudiences: ["南非流媒体观众"],
        partnershipGoals: [
          "获取权威影视评测 / authoritative film review backlinks",
        ],
        explicitCompetitorDomains: [],
      },
      configuration: {
        endpointAllowlist: [
          "/v3/dataforseo_labs/google/competitors_domain/live",
          "/v3/serp/google/organic/task_post",
        ],
        estimatedCostMicros: 1_000,
        absoluteBudgetMicros: 10_000,
        candidateLimit: 25,
        locationCode: "2710",
        languageCode: "en",
      },
      requestedCount: 10,
      visiblePoolGeneration: 1,
      refillTier: "exact_product_target_market",
      refillRound: 1,
      jobId: "job-language-input-required",
      actorId: "stage2b-test",
      now: () => new Date("2026-08-19T08:00:00.000Z"),
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(providerExecute).toHaveBeenCalled();
    expect(authorize).toHaveBeenCalled();
    const semanticCalls = providerExecute.mock.calls
      .map(([call]) => call as CommercialDiscoveryCall)
      .filter(({ sourceType }) =>
        sourceType === "BLUEPRINT_SERP_STANDARD_QUEUE"
      );
    expect(semanticCalls.length).toBeGreaterThan(0);
    expect(semanticCalls.every(({ request }) =>
      aiQueries.includes(String(request.keyword))
    )).toBe(true);
    expect(semanticCalls.every(({ request }) =>
      !String(request.keyword).includes("local or regional publication")
      && !String(request.keyword).includes("adjacent industry publication")
    )).toBe(true);
    const persistedSemanticRequests = client.calls
      .filter(({ text }) =>
        text.includes("INSERT INTO backlink_provider_requests")
      )
      .map(({ values }) =>
        JSON.parse(String(values[7])) as Record<string, unknown>
      )
      .filter((payload) =>
        "__growthosDiscoveryPlannerLineage" in payload
      );
    expect(persistedSemanticRequests.length).toBeGreaterThan(0);
    expect(persistedSemanticRequests.every((payload) =>
      aiQueries.includes(String(payload.keyword))
    )).toBe(true);
    const persistedSemanticArtifacts = client.calls
      .filter(({ text }) =>
        text.includes(
          "INSERT INTO backlink_commercial_discovery_artifacts",
        )
      )
      .map(({ values }) =>
        JSON.parse(String(values[9])) as Record<string, unknown>
      )
      .filter((artifact) => artifact.plannerLineage !== undefined);
    expect(persistedSemanticArtifacts.length).toBeGreaterThan(0);
  });

  it("uses bounded concurrency with independent provider request clients", async () => {
    const client = new MemoryDiscoveryClient();
    let inFlight = 0;
    let maximumInFlight = 0;
    let released = 0;
    let requestGateCalls = 0;
    const providerExecute = vi.fn(async () => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { tasks: [] };
    });

    await executeCommercialRecommendationDiscovery({
      client,
      provider: { execute: providerExecute },
      gate: {
        preflight: async () => {
          throw new Error("SHARED_GATE_MUST_NOT_BE_USED");
        },
        authorize: async () => {
          throw new Error("SHARED_GATE_MUST_NOT_BE_USED");
        },
      },
      safeFetch: {
        fetch: async () => ({
          requestedUrl: "https://silksleepwear.com/",
          finalUrl: "https://silksleepwear.com/",
          status: 200,
          contentType: "text/html",
          body: new Uint8Array(),
          redirectChain: [],
          resolvedIps: ["203.0.113.10"],
          fetchedAt: "2026-08-12T15:00:00.000Z",
        }),
      },
      scope: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
      },
      contextVersionId: "44444444-4444-4444-8444-444444444444",
      inputBinding,
      context: {
        snapshotVersion: 2,
        profileVersionId,
        promotionTargetVersionId,
        projectSettingsVersionId:
          "55555555-5555-4555-8555-555555555555",
        projectSettingsVersion: 1,
        canonicalDomain: "silksleepwear.com",
        locale: "en-US",
        countryCode: "US",
        products: ["silk pajamas"],
        keywords: ["silk sleepwear"],
        targetUrls: ["https://silksleepwear.com/"],
        targetAudiences: ["women"],
        partnershipGoals: ["editorial review"],
        explicitCompetitorDomains: [],
      },
      configuration: {
        endpointAllowlist: ["/v3/serp/google/organic/task_post"],
        estimatedCostMicros: 1_000,
        absoluteBudgetMicros: 10_000,
        candidateLimit: 25,
        locationCode: "2840",
        languageCode: "en",
        providerRequestConcurrency: 2,
      },
      requestClientFactory: async () => ({
        client: new MemoryDiscoveryClient(),
        gate: {
          preflight: async () => {},
          authorize: async () => {
            requestGateCalls += 1;
          },
        },
        release: () => {
          released += 1;
        },
      }),
      requestedCount: 10,
      visiblePoolGeneration: 1,
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 1,
      jobId: "job-concurrent",
      actorId: "local-product-038-test",
      now: () => new Date("2026-08-12T15:00:00.000Z"),
    });

    expect(providerExecute).toHaveBeenCalledTimes(4);
    expect(maximumInFlight).toBe(2);
    expect(requestGateCalls).toBe(4);
    expect(released).toBe(4);
  });

  it("rethrows internal request failures instead of recording provider unavailability", async () => {
    const client = new MemoryDiscoveryClient();
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const internalFailure = new Error("operator does not exist: uuid = text");
    let released = 0;

    await expect(executeCommercialRecommendationDiscovery({
      client,
      provider: { execute: providerExecute },
      gate: {
        preflight: async () => {},
        authorize: async () => {},
      },
      safeFetch: {
        fetch: async () => ({
          requestedUrl: "https://silksleepwear.com/",
          finalUrl: "https://silksleepwear.com/",
          status: 200,
          contentType: "text/html",
          body: new Uint8Array(),
          redirectChain: [],
          resolvedIps: ["203.0.113.10"],
          fetchedAt: "2026-08-17T09:00:00.000Z",
        }),
      },
      scope: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
      },
      contextVersionId: "44444444-4444-4444-8444-444444444444",
      inputBinding,
      context: {
        snapshotVersion: 2,
        profileVersionId,
        promotionTargetVersionId,
        projectSettingsVersionId:
          "55555555-5555-4555-8555-555555555555",
        projectSettingsVersion: 1,
        canonicalDomain: "silksleepwear.com",
        locale: "en-US",
        countryCode: "US",
        products: ["silk pajamas"],
        keywords: ["silk sleepwear"],
        targetUrls: ["https://silksleepwear.com/"],
        targetAudiences: ["women"],
        partnershipGoals: ["editorial review"],
        explicitCompetitorDomains: [],
      },
      configuration: {
        endpointAllowlist: ["/v3/serp/google/organic/task_post"],
        estimatedCostMicros: 1_000,
        absoluteBudgetMicros: 10_000,
        candidateLimit: 25,
        locationCode: "2840",
        languageCode: "en",
      },
      requestClientFactory: async () => ({
        client: {
          query: async (text: string) => {
            if (text.includes("DATAFORSEO_WORKER_INTERRUPTED_AFTER_TASK_ACCEPTED")) {
              throw internalFailure;
            }
            return { rows: [] };
          },
        },
        gate: {
          preflight: async () => {},
          authorize: async () => {},
        },
        release: () => {
          released += 1;
        },
      }),
      requestedCount: 10,
      visiblePoolGeneration: 1,
      refillTier: "exact_product_target_market",
      refillRound: 1,
      refillWindow: 1,
      jobId: "job-internal-failure",
      actorId: "phase-4-test",
      now: () => new Date("2026-08-17T09:00:00.000Z"),
    })).rejects.toBe(internalFailure);

    expect(providerExecute).not.toHaveBeenCalled();
    expect(released).toBeGreaterThan(0);
    expect(client.calls.some(({ text }) =>
      text.includes("provider_request_fingerprints=$7::jsonb")
    )).toBe(false);
  });

  it("scores existing resources against each project without treating authority as fit", () => {
    const blueprint = (input: Readonly<{
      canonicalDomain: string;
      country: string;
      products: readonly string[];
      keywords: readonly string[];
      audience: readonly string[];
    }>) => buildCommercialDiscoveryBlueprint({
      context: {
        projectContextVersionId: `context-${input.canonicalDomain}`,
        projectSettingsVersionId: `settings-${input.canonicalDomain}`,
        projectSettingsVersion: 1,
        canonicalDomain: input.canonicalDomain,
        countries: [input.country],
        languages: ["en"],
        products: input.products,
        keywords: input.keywords,
        promotionTargetUrls: [`https://${input.canonicalDomain}/`],
        declaredTargetAudiences: input.audience,
        partnershipGoals: ["editorial education"],
        explicitCompetitorDomains: [],
        historicalFeedbackDomains: [],
        evidenceRefs: [`project-context:${input.canonicalDomain}`],
      },
    });
    const solar = blueprint({
      canonicalDomain: "sunleadcrm.com",
      country: "US",
      products: ["solar installer CRM"],
      keywords: ["solar lead management"],
      audience: ["residential solar installers"],
    });
    const petNutrition = blueprint({
      canonicalDomain: "freshbowlnutrition.com",
      country: "GB",
      products: ["fresh dog nutrition subscription"],
      keywords: ["personalized dog meal plan"],
      audience: ["dog owners"],
    });
    const accounting = blueprint({
      canonicalDomain: "ledgerwiseapp.com",
      country: "CA",
      products: ["accounts payable automation"],
      keywords: ["invoice approval software"],
      audience: ["finance operations teams"],
    });
    const resource = {
      categories: ["renewable energy", "solar installers"],
      tags: ["solar lead management", "CRM"],
      countryLanguage: "US English",
      resourceType: "paid" as const,
      authorityScore: 88,
      riskLevel: "low",
    };

    expect(scoreCuratedResourceForProject({
      resource,
      blueprint: solar,
      minimumAuthorityScore: 40,
    })).toMatchObject({
      eligible: true,
      resourceType: "paid",
      marketMatched: true,
      authorityMatched: true,
    });
    for (const unrelated of [petNutrition, accounting]) {
      expect(scoreCuratedResourceForProject({
        resource,
        blueprint: unrelated,
        minimumAuthorityScore: 40,
      })).toMatchObject({
        eligible: false,
        resourceType: "paid",
        authorityMatched: true,
        reasonCodes: expect.arrayContaining([
          "RESOURCE_PROJECT_TOPIC_MISMATCH",
        ]),
      });
    }
    expect(scoreCuratedResourceForProject({
      resource: {
        ...resource,
        categories: ["general business"],
        tags: ["software platform publications"],
        authorityScore: 100,
      },
      blueprint: solar,
      minimumAuthorityScore: 40,
    })).toMatchObject({
      eligible: false,
      authorityMatched: true,
      reasonCodes: expect.arrayContaining([
        "RESOURCE_PROJECT_TOPIC_MISMATCH",
      ]),
    });
    expect(scoreCuratedResourceForProject({
      resource: { ...resource, riskLevel: "review" },
      blueprint: solar,
      minimumAuthorityScore: 40,
    })).toMatchObject({
      eligible: false,
      reasonCodes: expect.arrayContaining(["RESOURCE_RISK_NOT_LOW"]),
    });
    expect(scoreCuratedResourceForProject({
      resource: {
        ...resource,
        categories: ["Profile"],
        tags: ["Profile Backlink", "Other / Needs Review"],
      },
      blueprint: blueprint({
        canonicalDomain: "screenwise.co.za",
        country: "ZA",
        products: ["streaming entertainment"],
        keywords: ["film review website"],
        audience: ["South African viewers"],
      }),
      minimumAuthorityScore: 40,
    })).toMatchObject({
      eligible: false,
      matchedTerms: [],
      reasonCodes: expect.arrayContaining([
        "RESOURCE_PROJECT_TOPIC_MISMATCH",
      ]),
    });
  });
});
