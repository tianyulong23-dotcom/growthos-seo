import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createRecommendationPoolV2DataForSeoDiscoveryRoundExecutor,
  createRecommendationPoolV2ProviderIdentity,
  reconcileRecommendationPoolV2RequestIngestion,
  recommendationPoolV2CompletedSemanticRequestFingerprint,
  recommendationPoolV2DiscoveryWindowOrdinal,
} from "../../src/modules/backlinks/runtime/recommendation-pool-v2-dataforseo-executor.js";
import {
  createCommercialDiscoveryPlan,
  fingerprintCommercialDiscoverySemanticRequest,
  serializeCommercialDiscoveryRequestPayload,
} from "../../src/modules/backlinks/domain/recommendations/commercial-discovery-source.js";
import type { BacklinkTenantPool } from "../../src/modules/backlinks/db/tenant-transaction.js";
import type { LocalProductDataForSeoRuntime } from "../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.js";

const lineage = Object.freeze({
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  websiteProjectId: "33333333-3333-4333-8333-333333333333",
  generationContractId: "44444444-4444-4444-8444-444444444444",
  recommendationContextVersionId: "55555555-5555-4555-8555-555555555555",
  visiblePoolGeneration: 3,
  inputPinId: "66666666-6666-4666-8666-666666666666",
  discoveryBudgetPolicyVersion: "recommendation-discovery-budget.v1",
});

describe("recommendation pool V2 DataForSEO provider identity", () => {
  it.each([
    ["VERIFIED", "competitor.com"],
    ["VERIFIED", "us.competitor.com"],
    ["RETAINED_LOW_CONFIDENCE", "competitor.com"],
  ])(
    "binds competitor requests to their exact confirmed seed (%s, %s)",
    async (validationStatus, competitorDomain) => {
      let intentValues: readonly unknown[] | undefined;
      const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
        if (text.includes("INSERT INTO") && text.includes("backlink_recommendation_discovery_request_intents")) {
          intentValues = values;
          throw new Error("INTENT_CAPTURED");
        }
        const rows = text.includes('context.canonical_domain "canonicalDomain"')
          ? [{ canonicalDomain: "example.com", countryCode: "US", languageCode: "en",
              businessDirectionFingerprint: "a".repeat(64), authoritativeBlueprintId: lineage.generationContractId,
              startedAt: "2026-09-07T00:00:00Z" }]
          : text.includes('AS "nextWindowOrdinal"')
            ? [{ completedRequestCount: 0, nextWindowOrdinal: 1, roundSettledAuthorizedCostMicros: 0, rawObservationCount: 0, candidateCount: 0 }]
            : text.includes('seed.seed_fingerprint "fingerprint"')
              ? [
                  { id: lineage.inputPinId, fingerprint: "b".repeat(64), kind: "KEYWORD", source: "USER_INPUT" },
                  { id: "77777777-7777-4777-8777-777777777777", fingerprint: "e".repeat(64),
                    kind: "SEO_COMPETITOR", source: "USER_INPUT", normalizedValue: competitorDomain, validationStatus },
                ]
              : text.includes("FOR UPDATE") && text.includes("backlink_recommendation_generation_contracts")
                ? [{ id: lineage.generationContractId }] : [];
        return { rows, rowCount: rows.length };
      });
      const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as BacklinkTenantPool;
      const [call] = createCommercialDiscoveryPlan({
        blueprintId: lineage.generationContractId, searchQueries: [], verifiedCompetitorDomains: ["competitor.com"],
        userDomain: "example.com", locationCode: "2840", languageCode: "en",
        endpointAllowlist: ["/v3/backlinks/backlinks/live"], estimatedCostMicros: 25_000,
        remainingBudgetMicros: 25_000,
      });
      if (!call) throw new Error("Missing competitor request");
      const runtime = { execute: async (input: Parameters<LocalProductDataForSeoRuntime["execute"]>[0]) => {
        expect(input.nativeV2?.requestPort.verifiedCompetitorDomains)
          .toEqual(validationStatus === "VERIFIED" ? [competitorDomain] : []);
        await input.nativeV2?.requestPort.prepareRequest({ index: 0, call, requestFingerprint: "c".repeat(64) });
      } } as unknown as LocalProductDataForSeoRuntime;
      const executor = createRecommendationPoolV2DataForSeoDiscoveryRoundExecutor({ pool, runtime });
      await expect(executor.execute({
        ...lineage, actorId: lineage.inputPinId, jobId: lineage.inputPinId,
        round: 1, maxCostMicros: 1_000_000, requestFingerprint: "d".repeat(64),
        idempotencyKey: "competitor-seed-regression",
      })).rejects.toThrow(validationStatus === "VERIFIED" ? "INTENT_CAPTURED" : "RECOMMENDATION_POOL_V2_LINEAGE_NOT_FOUND");
      if (validationStatus === "VERIFIED") {
        expect(intentValues).toContain("77777777-7777-4777-8777-777777777777");
        expect(intentValues).toContain("e".repeat(64));
        expect(intentValues).toContain("backlinks");
      } else expect(intentValues).toBeUndefined();
    },
  );

  it.each([
    ["pt-BR", "BR", "pt"],
    ["en-US", "US", "en"],
    ["en", "US", "en"],
  ])("persists provider language for project locale %s", async (locale, countryCode, languageCode) => {
    let intentValues: readonly unknown[] | undefined;
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      if (text.includes("INSERT INTO") && text.includes("backlink_recommendation_discovery_request_intents")) {
        intentValues = values;
        throw new Error("INTENT_CAPTURED");
      }
      const rows: Record<string, unknown>[] = text.includes('context.canonical_domain "canonicalDomain"')
        ? [{
            canonicalDomain: "example.com", countryCode, languageCode: locale,
            businessDirectionFingerprint: "a".repeat(64),
            authoritativeBlueprintId: lineage.generationContractId,
            startedAt: "2026-09-07T00:00:00Z",
          }]
        : text.includes('AS "nextWindowOrdinal"')
          ? [{ completedRequestCount: 0, nextWindowOrdinal: 1, roundSettledAuthorizedCostMicros: 0, rawObservationCount: 0, candidateCount: 0 }]
          : text.includes('seed.seed_fingerprint "fingerprint"')
            ? [{ id: lineage.inputPinId, fingerprint: "b".repeat(64), kind: "KEYWORD", source: "USER_INPUT" }]
            : text.includes("FOR UPDATE") && text.includes("backlink_recommendation_generation_contracts")
              ? [{ id: lineage.generationContractId }]
              : [];
      return { rows, rowCount: rows.length };
    });
    const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as BacklinkTenantPool;
    const [call] = createCommercialDiscoveryPlan({
      blueprintId: lineage.generationContractId, searchQueries: ["product reviews"],
      verifiedCompetitorDomains: [], userDomain: "example.com",
      locationCode: countryCode === "BR" ? "2076" : "2840", languageCode,
      endpointAllowlist: ["/v3/serp/google/organic/task_post"],
      estimatedCostMicros: 25_000, remainingBudgetMicros: 25_000,
    });
    if (!call) throw new Error("Missing request");
    const runtime = {
      execute: async (input: Parameters<LocalProductDataForSeoRuntime["execute"]>[0]) => {
        await input.nativeV2?.requestPort.prepareRequest({
          index: 0, call, requestFingerprint: "c".repeat(64),
        });
        throw new Error("Missing intent");
      },
    } as unknown as LocalProductDataForSeoRuntime;
    const executor = createRecommendationPoolV2DataForSeoDiscoveryRoundExecutor({ pool, runtime });
    await expect(executor.execute({
      ...lineage, actorId: lineage.inputPinId, jobId: lineage.inputPinId,
      round: 1, maxCostMicros: 1_000_000, requestFingerprint: "d".repeat(64),
      idempotencyKey: "locale-regression",
    })).rejects.toThrow("INTENT_CAPTURED");
    expect(intentValues?.[21]).toBe(countryCode);
    expect(intentValues?.[22]).toBe(languageCode);
  });

  it("uses the immutable V2 request intent for request, budget, actor, and lease ownership", () => {
    const identity = createRecommendationPoolV2ProviderIdentity({
      lineage,
      requestFingerprint: "a".repeat(64),
    });

    expect(identity.intentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(identity).toEqual({
      intentId: identity.intentId,
      requestId: identity.intentId,
      budgetReservationId: identity.intentId,
      actorId: identity.intentId,
    });
  });

  it("is deterministic for the same generation lineage and request fingerprint", () => {
    expect(
      createRecommendationPoolV2ProviderIdentity({
        lineage,
        requestFingerprint: "b".repeat(64),
      }),
    ).toEqual(
      createRecommendationPoolV2ProviderIdentity({
        lineage,
        requestFingerprint: "b".repeat(64),
      }),
    );
  });

  it("assigns each paid request in one round a distinct durable window", () => {
    const windowOrdinal =
      recommendationPoolV2DiscoveryWindowOrdinal as unknown as (
        round: 1 | 2,
        requestOrdinal: number,
      ) => number;

    expect(windowOrdinal(1, 1)).not.toBe(windowOrdinal(1, 2));
    expect(windowOrdinal(1, 2)).toBeLessThan(windowOrdinal(2, 1));
  });

  it("does not cap a discovery round to one request path", () => {
    const source = readFileSync(
      new URL(
        "../../src/modules/backlinks/runtime/recommendation-pool-v2-dataforseo-executor.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toContain("maxRequests: 1");
    expect(source).not.toContain("completedRequestCount: 1");
  });

  it("does not use the PostgreSQL WINDOW keyword as a SQL table alias", () => {
    const source = readFileSync(
      new URL(
        "../../src/modules/backlinks/runtime/recommendation-pool-v2-dataforseo-executor.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).not.toMatch(
      /\bFROM\s+backlinks\.backlink_recommendation_discovery_window_facts\s+window\b/,
    );
  });

  it("binds native request lineage to one exact generation V2 blueprint", () => {
    const source = readFileSync(
      new URL(
        "../../src/modules/backlinks/runtime/recommendation-pool-v2-dataforseo-executor.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain(
      "blueprint.schema_version='recommendation-blueprint.v2'",
    );
    expect(source).toContain(
      "blueprint.prompt_version='recommendation-seed.v2'",
    );
    expect(source).toContain(
      "blueprint.rule_version='recommendation-discovery.v2'",
    );
    expect(source).toContain(
      "HAVING count(DISTINCT assignment.blueprint_id)=1",
    );
    expect(source).toContain(
      "authoritativeBlueprintId: generation.authoritativeBlueprintId",
    );
  });

  it("replays an immutable completed round without calling the Provider or writing facts", async () => {
    const providerExecute = vi.fn(async () => {
      throw new Error("Provider must not run for a completed discovery round.");
    });
    const queries: string[] = [];
    const query = vi.fn(
      async (
        text: string,
      ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
        queries.push(text);
        if (
          text === "BEGIN" ||
          text === "COMMIT" ||
          text === "ROLLBACK" ||
          text.includes("set_config(")
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("backlink_recommendation_discovery_round_facts")) {
          return {
            rows: [
              {
                completedWindowCount: 4,
                completedRequestCount: 4,
                rawCandidateCount: 34,
                effectiveCandidateCount: 34,
                newUniqueCount: 26,
                duplicateCount: 8,
                roundSettledCostMicros: "2400",
                chargeState: "SETTLED",
                pathsExhausted: false,
              },
            ],
            rowCount: 1,
          };
        }
        if (text.includes('"candidateCount"')) {
          return {
            rows: [{ candidateCount: 23 }],
            rowCount: 1,
          };
        }
        if (text.includes("backlink_recommendation_discovery_window_facts")) {
          return {
            rows: [
              {
                rawCandidateCount: 8,
                canonicalCandidateCount: 8,
                newUniqueCount: 8,
                admittedCount: 6,
                hardExcludedCount: 2,
              },
              {
                rawCandidateCount: 9,
                canonicalCandidateCount: 9,
                newUniqueCount: 5,
                admittedCount: 4,
                hardExcludedCount: 1,
              },
              {
                rawCandidateCount: 8,
                canonicalCandidateCount: 8,
                newUniqueCount: 4,
                admittedCount: 4,
                hardExcludedCount: 0,
              },
              {
                rawCandidateCount: 9,
                canonicalCandidateCount: 9,
                newUniqueCount: 9,
                admittedCount: 9,
                hardExcludedCount: 0,
              },
            ],
            rowCount: 4,
          };
        }
        throw new Error(`Unexpected SQL in completed-round replay: ${text}`);
      },
    );
    const release = vi.fn();
    const pool: BacklinkTenantPool = {
      connect: vi.fn(async () => ({ query, release })),
    };
    const executor = createRecommendationPoolV2DataForSeoDiscoveryRoundExecutor(
      {
        pool,
        runtime: {
          execute: providerExecute,
        } as unknown as LocalProductDataForSeoRuntime,
      },
    );

    const result = await executor.execute({
      organizationId: lineage.organizationId,
      workspaceId: lineage.workspaceId,
      websiteProjectId: lineage.websiteProjectId,
      generationContractId: lineage.generationContractId,
      recommendationContextVersionId: lineage.recommendationContextVersionId,
      visiblePoolGeneration: lineage.visiblePoolGeneration,
      inputPinId: lineage.inputPinId,
      jobId: "77777777-7777-4777-8777-777777777777",
      workflowId: "recommendation-pool-v2-workflow-1",
      actorId: "88888888-8888-4888-8888-888888888888",
      round: 1,
      requestFingerprint: "round-1-workflow-fingerprint",
      idempotencyKey: "generation-1:round:1",
      maxCostMicros: 1_000_000,
    });

    expect(result).toMatchObject({
      round: 1,
      requestFingerprint: "round-1-workflow-fingerprint",
      chargeState: "settled",
      costMicros: 2400,
      totalUniqueCandidateCount: 23,
      pathsExhausted: false,
      completedWindows: [
        {
          completed: true,
          rawCandidateCount: 8,
          canonicalCandidateCount: 8,
          newUniqueCount: 8,
        },
        {
          completed: true,
          rawCandidateCount: 9,
          canonicalCandidateCount: 9,
          newUniqueCount: 5,
        },
        {
          completed: true,
          rawCandidateCount: 8,
          canonicalCandidateCount: 8,
          newUniqueCount: 4,
        },
        {
          completed: true,
          rawCandidateCount: 9,
          canonicalCandidateCount: 9,
          newUniqueCount: 9,
        },
      ],
    });
    expect(providerExecute).not.toHaveBeenCalled();
    expect(
      queries.filter((text) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(text)),
    ).toEqual([]);
  });

  it("rebuilds persisted request history with the cost-independent semantic fingerprint", () => {
    const [historicalCall] = createCommercialDiscoveryPlan({
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
    if (historicalCall === undefined) {
      throw new Error("Missing historical semantic request");
    }
    const currentCall = Object.freeze({
      ...historicalCall,
      estimatedCostMicros: 25_000,
    });

    expect(
      recommendationPoolV2CompletedSemanticRequestFingerprint({
        discoverySource: historicalCall.sourceType,
        requestType: historicalCall.endpoint,
        requestPayload:
          serializeCommercialDiscoveryRequestPayload(historicalCall),
        responseSchemaVersion: historicalCall.responseSchemaVersion,
      }),
    ).toBe(fingerprintCommercialDiscoverySemanticRequest(currentCall));
  });

  it("reconciles exact admission counts with durable candidate facts", () => {
    const counts = {
      rawCandidateCount: 12,
      canonicalCandidateCount: 10,
      newUniqueCount: 8,
      duplicateCount: 2,
      admittedCount: 7,
      hardExcludedCount: 3,
    };

    expect(
      reconcileRecommendationPoolV2RequestIngestion({
        admissionResult: {
          ...counts,
          materializedCount: 7,
        },
        persistedFacts: counts,
        persistedCompletion: null,
      }),
    ).toEqual(counts);
  });

  it("rejects candidate-fact drift before persisting a request outcome", () => {
    expect(() =>
      reconcileRecommendationPoolV2RequestIngestion({
        admissionResult: {
          rawCandidateCount: 12,
          canonicalCandidateCount: 10,
          newUniqueCount: 8,
          duplicateCount: 2,
          admittedCount: 7,
          hardExcludedCount: 3,
          materializedCount: 7,
        },
        persistedFacts: {
          rawCandidateCount: 12,
          canonicalCandidateCount: 10,
          newUniqueCount: 8,
          duplicateCount: 2,
          admittedCount: 6,
          hardExcludedCount: 4,
        },
        persistedCompletion: null,
      }),
    ).toThrow("RECOMMENDATION_POOL_V2_REQUEST_INGESTION_PERSISTENCE_CONFLICT");
  });

  it("reconciles replay with the immutable request outcome", () => {
    const persistedFacts = {
      rawCandidateCount: 12,
      canonicalCandidateCount: 10,
      newUniqueCount: 8,
      duplicateCount: 2,
      admittedCount: 7,
      hardExcludedCount: 3,
    };

    expect(
      reconcileRecommendationPoolV2RequestIngestion({
        admissionResult: null,
        persistedFacts,
        persistedCompletion: {
          rawCandidateCount: 12,
          effectiveCandidateCount: 10,
          newUniqueCount: 8,
          duplicateCount: 2,
        },
      }),
    ).toEqual(persistedFacts);
    expect(() =>
      reconcileRecommendationPoolV2RequestIngestion({
        admissionResult: null,
        persistedFacts,
        persistedCompletion: {
          rawCandidateCount: 12,
          effectiveCandidateCount: 10,
          newUniqueCount: 7,
          duplicateCount: 3,
        },
      }),
    ).toThrow("RECOMMENDATION_POOL_V2_REQUEST_INGESTION_REPLAY_CONFLICT");
  });
});
