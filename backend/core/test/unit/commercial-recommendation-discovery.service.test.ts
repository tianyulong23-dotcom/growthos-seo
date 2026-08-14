import { describe, expect, it, vi } from "vitest";

import {
  buildCommercialTierSearchQueries,
  executeCommercialRecommendationDiscovery,
  scoreCuratedResourceForProject,
} from "../../src/modules/backlinks/application/services/commercial-recommendation-discovery.service.js";
import {
  buildCommercialDiscoveryBlueprint,
} from "../../src/modules/backlinks/domain/recommendations/commercial-discovery-blueprint.js";
import {
  CommercialDiscoveryRequestService,
  type CommercialDiscoveryQueryClient,
} from "../../src/modules/backlinks/application/services/commercial-discovery-request.service.js";
import {
  fingerprintCommercialDiscoveryCall,
  type CommercialDiscoveryCall,
} from "../../src/modules/backlinks/domain/recommendations/commercial-discovery-source.js";

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

  constructor(private readonly reconciledFingerprint: string | null = null) {}

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
      return { rows: [{ remaining: 10_000 }] };
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
    if (
      sql.includes("DATAFORSEO_RECONCILED_ASSUMED_CHARGE_NO_RESULT")
      && this.reconciledFingerprint !== null
      && values[3] === this.reconciledFingerprint
    ) {
      return { rows: [{ id: "reconciled-request" }] };
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
      return { rows: [{ id: String(values[0]) }] };
    }
    return { rows: [] };
  }
}

describe("commercial recommendation discovery service", () => {
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
      gate: { authorize },
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

  it("reuses one Blueprint and one provider artifact for the same Context", async () => {
    const client = new MemoryDiscoveryClient();
    const generate = vi.fn(async () => ({
      output: {
        targetAudience: ["pool owners"],
        productValuePropositions: ["robotic pool cleaning"],
        topicClusters: ["pool maintenance"],
        searchQueryClusters: ["robotic pool cleaner reviews"],
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
        gate: { authorize },
        safeFetch: { fetch },
        scope: {
          organizationId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          websiteProjectId: "33333333-3333-4333-8333-333333333333",
        },
        contextVersionId: "44444444-4444-4444-8444-444444444444",
        context: {
          snapshotVersion: 2,
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
            "/v3/dataforseo_labs/google/competitors_domain/live",
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
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(providerExecute).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(client.calls.some(({ text, values }) =>
      text.includes("SET provider_task_id=$2")
      && values[1] === "provider-task-persisted"
    )).toBe(true);
    const authorizedContext = authorize.mock.calls[0]?.[0].context;
    const insertedBatch = client.calls.find(({ text }) =>
      text.includes("INSERT INTO provider_batch_requests")
    );
    expect(authorizedContext.budgetReservationId).toMatch(
      /^commercial-refill:.*:[0-9a-f-]{36}$/u,
    );
    expect(insertedBatch?.values[13]).toBe(
      authorizedContext.budgetReservationId,
    );
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
  });

  it("runs the curated resource tier without paid provider or AI transport", async () => {
    const client = new MemoryDiscoveryClient();
    const providerExecute = vi.fn(async () => ({ tasks: [] }));
    const authorize = vi.fn(async () => {});
    const fetch = vi.fn();

    const result = await executeCommercialRecommendationDiscovery({
      client,
      provider: { execute: providerExecute },
      gate: { authorize },
      safeFetch: { fetch },
      scope: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        websiteProjectId: "33333333-3333-4333-8333-333333333333",
      },
      contextVersionId: "44444444-4444-4444-8444-444444444444",
      context: {
        snapshotVersion: 2,
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
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      client.calls.find(({ text }) =>
        text.includes("FROM backlink_resource_library_items")
      )?.values[2],
    ).toBe(455);
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
      });
    const first = queries(1, 1);
    const second = queries(1, 2);
    const broader = queries(2, 1);
    const thirdWindow = queries(1, 3);

    expect(first).toHaveLength(20);
    expect(second).toHaveLength(20);
    expect(broader).toHaveLength(20);
    expect(thirdWindow).toHaveLength(20);
    expect(first.filter((query) => second.includes(query))).toEqual([]);
    expect(first.filter((query) => broader.includes(query))).toEqual([]);
    expect(second.filter((query) => broader.includes(query))).toEqual([]);
    expect(thirdWindow.filter((query) => broader.includes(query))).toEqual([]);
    expect([...first, ...second, ...broader, ...thirdWindow].every((query) =>
      query.includes("US")
    )).toBe(true);
  });

  it("serializes independent provider request clients", async () => {
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
      context: {
        snapshotVersion: 2,
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
        client: new MemoryDiscoveryClient(),
        gate: {
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

    expect(providerExecute).toHaveBeenCalledTimes(10);
    expect(maximumInFlight).toBe(1);
    expect(requestGateCalls).toBe(10);
    expect(released).toBe(10);
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
  });
});
