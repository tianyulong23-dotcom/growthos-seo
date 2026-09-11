import { describe, expect, it } from "vitest";

import {
  assertCommercialDiscoveryCallAllowed,
  commercialDiscoveryArtifactSchema,
  createCommercialCompetitorSeedPlan,
  createCommercialDiscoveryPlan,
  extractCommercialCompetitorSeeds,
  mergeCommercialDiscoveryArtifacts,
  normalizeCommercialDiscoveryResponse,
  parseCommercialDiscoveryRequestPayload,
  serializeCommercialDiscoveryRequestPayload,
} from "../../src/modules/backlinks/domain/recommendations/commercial-discovery-source.js";

const allowed = [
  "https://api.dataforseo.com/v3/serp/google/organic/task_post",
  "https://api.dataforseo.com/v3/serp/google/organic/tasks_ready",
  "https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced",
  "https://api.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live",
  "https://api.dataforseo.com/v3/backlinks/competitors/live",
  "https://api.dataforseo.com/v3/backlinks/backlinks/live",
  "https://api.dataforseo.com/v3/backlinks/referring_domains/live",
] as const;

describe("commercial DataForSEO discovery sources", () => {
  it("retains provider metrics and the raw response across normalization and serialization", () => {
    const response = {
      tasks: [{
        id: "offline-metrics",
        result: [{ items: [
          { domain: "example.com", rank: 40, backlinks_spam_score: 0, etv: 120 },
          { domain: "example.com", rank: 60 },
          { domain: "example.com", backlinks_spam_score: 17, etv: 200 },
        ] }],
      }],
    };
    const artifact = normalizeCommercialDiscoveryResponse({
      call: {
        endpoint: "/v3/backlinks/referring_domains/live",
        intent: "DISCOVERY",
        sourceType: "USER_REFERRING_DOMAINS",
        request: { target: "owner.com" },
        responseSchemaVersion: "test.v1",
        estimatedCostMicros: 1000,
      },
      collectedAt: "2026-09-08T00:00:00.000Z",
      response,
    });
    expect(artifact.candidates[0]).toMatchObject({
      rank: 60, traffic: 200, spamScore: 17,
    });
    const restored = commercialDiscoveryArtifactSchema.parse(
      JSON.parse(JSON.stringify(artifact)),
    );
    expect(restored.rawResponse).toEqual(response);
    expect(restored.candidates).toEqual(artifact.candidates);
    const { rawResponse: _raw, ...legacy } = artifact;
    expect(_raw).toEqual(response);
    expect(commercialDiscoveryArtifactSchema.parse(legacy).candidates)
      .toEqual(artifact.candidates);
  });

  it.each(["backlinks_spam_score", "backlink_spam_score", "spam_score"])(
    "retains zero from %s without treating a SERP position as authority rank",
    (field) => {
      const artifact = normalizeCommercialDiscoveryResponse({
        call: {
          endpoint: "/v3/serp/google/organic/task_post",
          intent: "DISCOVERY",
          sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
          request: { keyword: "example" },
          responseSchemaVersion: "test.v1",
          estimatedCostMicros: 1000,
        },
        collectedAt: "2026-09-08T00:00:00.000Z",
        response: { tasks: [{ result: [{ items: [{
          domain: "example.com", rank_absolute: 1, [field]: 0, etv: 0,
        }] }] }] },
      });
      expect(artifact.candidates[0]).toMatchObject({
        rank: null, traffic: 0, spamScore: 0,
      });
    },
  );

  it("uses discovered competitors only as seeds for page-level backlink discovery", () => {
    const seedPlan = createCommercialCompetitorSeedPlan({
      userDomain: "owner.com",
      locationCode: "2840",
      languageCode: "en",
      endpointAllowlist: allowed,
      estimatedCostMicros: 1_000,
      remainingBudgetMicros: 4_000,
    });
    expect(seedPlan).toHaveLength(1);
    const seedCall = seedPlan[0];
    if (seedCall === undefined) {
      throw new Error("expected one competitor seed call");
    }
    const seedArtifact = normalizeCommercialDiscoveryResponse({
      call: seedCall,
      collectedAt: "2026-08-18T02:00:00.000Z",
      response: {
        tasks: [{
          id: "task-competitor-seed",
          cost: 0.01,
          result: [{
            items: [{
              domain: "competitor.com",
              full_domain_metrics: { organic: { etv: 50_000 } },
            }],
          }],
        }],
      },
    });
    const competitorSeeds = extractCommercialCompetitorSeeds({
      artifacts: [seedArtifact],
      userDomain: "owner.com",
      excludedDomains: [],
    });
    const plan = createCommercialDiscoveryPlan({
      searchQueries: ["video streaming resources"],
      verifiedCompetitorDomains: competitorSeeds,
      userDomain: "owner.com",
      locationCode: "2840",
      languageCode: "en",
      endpointAllowlist: allowed,
      estimatedCostMicros: 1_000,
      remainingBudgetMicros: 4_000,
    });

    expect(seedPlan.map(({ sourceType }) => sourceType)).toEqual([
      "VERIFIED_COMPETITOR_BACKLINK_GAP",
    ]);
    expect(competitorSeeds).toEqual(["competitor.com"]);
    expect(plan.map(({ sourceType }) => sourceType)).toEqual([
      "BLUEPRINT_SERP_STANDARD_QUEUE",
      "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
      "USER_REFERRING_DOMAINS",
    ]);
    expect(plan.every(({ intent }) => intent === "DISCOVERY")).toBe(true);
    expect(plan[1]?.request).toMatchObject({
      backlinks_status_type: "live",
    });
    expect(plan[1]?.request).not.toHaveProperty("order_by");
  });

  it("keeps competitor discovery as a separate first hop", () => {
    const seedPlan = createCommercialCompetitorSeedPlan({
      userDomain: "owner.com",
      locationCode: "2840",
      languageCode: "en",
      endpointAllowlist: allowed,
      estimatedCostMicros: 1_000,
      remainingBudgetMicros: 3_000,
    });
    const plan = createCommercialDiscoveryPlan({
      searchQueries: ["video streaming resources"],
      verifiedCompetitorDomains: [],
      userDomain: "owner.com",
      locationCode: "2840",
      languageCode: "en",
      endpointAllowlist: allowed,
      estimatedCostMicros: 1_000,
      remainingBudgetMicros: 3_000,
    });

    expect(seedPlan).toHaveLength(1);
    expect(plan.map(({ sourceType }) => sourceType)).toEqual([
      "BLUEPRINT_SERP_STANDARD_QUEUE",
      "USER_REFERRING_DOMAINS",
    ]);
  });

  it("reserves semantic discovery before supplemental source types", () => {
    const plan = createCommercialDiscoveryPlan({
      searchQueries: [
        "video streaming resources",
        "streaming service reviews",
        "film publication contributors",
      ],
      verifiedCompetitorDomains: ["competitor.com", "competitor-two.com"],
      userDomain: "owner.com",
      locationCode: "2840",
      languageCode: "en",
      endpointAllowlist: allowed,
      estimatedCostMicros: 1_000,
      remainingBudgetMicros: 4_000,
    });

    expect(plan.map(({ sourceType }) => sourceType)).toEqual([
      "BLUEPRINT_SERP_STANDARD_QUEUE",
      "BLUEPRINT_SERP_STANDARD_QUEUE",
      "BLUEPRINT_SERP_STANDARD_QUEUE",
      "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
    ]);
  });

  it("keeps the full bounded semantic candidate space for native V2 filtering", () => {
    const searchQueries = Array.from(
      { length: 25 },
      (_, index) => `streaming publication query ${index + 1}`,
    );
    const plan = createCommercialDiscoveryPlan({
      searchQueries,
      verifiedCompetitorDomains: [],
      userDomain: "owner.com",
      locationCode: "2840",
      languageCode: "en",
      endpointAllowlist: allowed,
      estimatedCostMicros: 1_000,
      remainingBudgetMicros: 25_000,
    });

    expect(plan).toHaveLength(25);
    expect(plan.every(({ sourceType }) =>
      sourceType === "BLUEPRINT_SERP_STANDARD_QUEUE"
    )).toBe(true);
    expect(plan.at(-1)?.request).toMatchObject({
      keyword: "streaming publication query 25",
    });
  });

  it("keeps semantic SERP in the first paid candidate slot", () => {
    const plan = createCommercialDiscoveryPlan({
      searchQueries: ["video streaming publication contribute"],
      verifiedCompetitorDomains: ["competitor.com"],
      userDomain: "owner.com",
      locationCode: "2840",
      languageCode: "en",
      endpointAllowlist: allowed,
      estimatedCostMicros: 1_000,
      remainingBudgetMicros: 2_000,
    });

    expect(plan.map(({ sourceType }) => sourceType)).toEqual([
      "BLUEPRINT_SERP_STANDARD_QUEUE",
      "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
    ]);
  });

  it("binds semantic SERP requests and artifacts to one Blueprint query", () => {
    const blueprintId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const plan = createCommercialDiscoveryPlan({
      blueprintId,
      searchQueries: [
        "South Africa streaming publications",
        "streaming contributor sites South Africa",
      ],
      verifiedCompetitorDomains: [],
      userDomain: "owner.com",
      locationCode: "2710",
      languageCode: "en",
      endpointAllowlist: allowed,
      estimatedCostMicros: 1_000,
      remainingBudgetMicros: 3_000,
    });
    const semanticCalls = plan.filter(
      ({ sourceType }) => sourceType === "BLUEPRINT_SERP_STANDARD_QUEUE",
    );

    expect(semanticCalls).toHaveLength(2);
    expect(semanticCalls.map(({ plannerLineage }) => plannerLineage)).toEqual([
      {
        blueprintId,
        queryId: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      {
        blueprintId,
        queryId: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    ]);
    expect(semanticCalls[0]?.plannerLineage?.queryId).not.toBe(
      semanticCalls[1]?.plannerLineage?.queryId,
    );

    const call = semanticCalls[0];
    if (call === undefined) {
      throw new Error("expected at least one semantic discovery call");
    }
    const persistedPayload = serializeCommercialDiscoveryRequestPayload(call);
    expect(persistedPayload).toMatchObject({
      keyword: "South Africa streaming publications",
      __growthosDiscoveryPlannerLineage: call.plannerLineage,
    });
    expect(parseCommercialDiscoveryRequestPayload(persistedPayload)).toEqual({
      request: call.request,
      plannerLineage: call.plannerLineage,
    });

    const artifact = normalizeCommercialDiscoveryResponse({
      call,
      collectedAt: "2026-08-21T06:00:00.000Z",
      response: { tasks: [] },
    });
    expect(artifact.plannerLineage).toEqual(call.plannerLineage);
  });

  it("preserves provider relevance order when choosing competitor seeds", () => {
    const seedPlan = createCommercialCompetitorSeedPlan({
      userDomain: "owner.com",
      locationCode: "2840",
      languageCode: "en",
      endpointAllowlist: allowed,
      estimatedCostMicros: 1_000,
      remainingBudgetMicros: 1_000,
    });
    expect(seedPlan).toHaveLength(1);
    const seedCall = seedPlan[0];
    if (seedCall === undefined) {
      throw new Error("expected one competitor seed call");
    }
    const artifact = normalizeCommercialDiscoveryResponse({
      call: seedCall,
      collectedAt: "2026-08-18T02:00:00.000Z",
      response: {
        tasks: [{
          id: "seed-order",
          cost: 0.01,
          result: [{
            items: [
              {
                domain: "topic-relevant.com",
                full_domain_metrics: { organic: { etv: 100 } },
              },
              {
                domain: "high-traffic-platform.com",
                full_domain_metrics: { organic: { etv: 10_000_000 } },
              },
            ],
          }],
        }],
      },
    });

    expect(extractCommercialCompetitorSeeds({
      artifacts: [artifact],
      userDomain: "owner.com",
      excludedDomains: [],
      maximumSeeds: 1,
    })).toEqual(["topic-relevant.com"]);
  });

  it("rejects endpoint/source mismatch and missing allowlist entries", () => {
    expect(() =>
      assertCommercialDiscoveryCallAllowed({
        call: {
          endpoint: "/v3/backlinks/referring_domains/live",
          intent: "DISCOVERY",
          sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
          request: { target: "example.com" },
          responseSchemaVersion: "test.v1",
          estimatedCostMicros: 1_000,
        },
        endpointAllowlist: allowed.filter(
          (endpoint) => !endpoint.includes("dataforseo_labs"),
        ),
      }),
    ).toThrow("DATAFORSEO_COMMERCIAL_SOURCE_ENDPOINT_MISMATCH");

    expect(() =>
      assertCommercialDiscoveryCallAllowed({
        call: {
          endpoint: "/v3/dataforseo_labs/google/competitors_domain/live",
          intent: "DISCOVERY",
          sourceType: "VERIFIED_COMPETITOR_BACKLINK_GAP",
          request: { target: "example.com" },
          responseSchemaVersion: "test.v1",
          estimatedCostMicros: 1_000,
        },
        endpointAllowlist: allowed.filter(
          (endpoint) => !endpoint.includes("dataforseo_labs"),
        ),
      }),
    ).toThrow("DATAFORSEO_COMMERCIAL_ENDPOINT_NOT_ALLOWED");
  });

  it("requires live observed links to the requested competitor and retains supplied metrics", () => {
    const artifact = normalizeCommercialDiscoveryResponse({
      call: {
        endpoint: "/v3/backlinks/backlinks/live", intent: "DISCOVERY",
        sourceType: "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
        request: { target: "competitor.com", backlinks_status_type: "live" },
        responseSchemaVersion: "test.v1", estimatedCostMicros: 1_000,
      },
      collectedAt: "2026-09-09T00:00:00.000Z",
      response: { tasks: [{ result: [{ items: [
        { url_from: "https://publisher.com/review", url_to: "https://competitor.com/product",
          domain_from_rank: 72, backlink_spam_score: 0, organic_etv: 1234 },
        { url_from: "https://wrong.com/review", url_to: "https://other.com/product" },
        { url_from: "https://lost.com/review", url_to: "https://competitor.com/", is_lost: true },
        { domain_from: "missing.com" },
      ] }] }] },
    });
    expect(artifact.candidates).toHaveLength(1);
    expect(artifact.candidates[0]).toMatchObject({
      canonicalDomain: "publisher.com", rank: 72, spamScore: 0, traffic: 1234,
    });
  });

  it("normalizes page-level backlink evidence from the second hop", () => {
    const artifact = normalizeCommercialDiscoveryResponse({
      call: {
        endpoint: "/v3/backlinks/backlinks/live",
        intent: "DISCOVERY",
        sourceType: "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
        request: { target: "competitor.com" },
        responseSchemaVersion: "test.v1",
        estimatedCostMicros: 1_000,
      },
      collectedAt: "2026-08-18T02:15:00.000Z",
      response: {
        tasks: [{
          id: "task-page-evidence",
          cost: 0.02,
          result: [{
            items: [{
              domain_from: "publisher.com",
              url_from: "https://publisher.com/guides/streaming-services",
              domain_to: "competitor.com",
              url_to: "https://competitor.com/plans",
              anchor: "compare streaming plans",
              is_lost: false,
              first_seen: "2025-03-01 10:00:00 +00:00",
              last_seen: "2026-08-17 09:00:00 +00:00",
              page_from_status_code: 200,
              url_to_status_code: 200,
              domain_from_rank: 76,
              backlink_spam_score: 3,
              domain_from_country: "ZA",
            }],
          }],
        }],
      },
    });

    expect(artifact.candidates[0]).toMatchObject({
      canonicalDomain: "publisher.com",
      rank: 76,
      spamScore: 3,
      countryCode: "ZA",
      backlinkPageEvidence: [{
        sourceUrl: "https://publisher.com/guides/streaming-services",
        targetUrl: "https://competitor.com/plans",
        anchorText: "compare streaming plans",
        linkStatus: "active",
        firstSeenAt: "2025-03-01T10:00:00.000Z",
        lastSeenAt: "2026-08-17T09:00:00.000Z",
        sourceHttpStatus: 200,
        targetHttpStatus: 200,
      }],
    });
    expect(
      mergeCommercialDiscoveryArtifacts({
        artifacts: [artifact],
        userDomain: "owner.com",
        excludedDomains: [],
      })[0]?.backlinkPageEvidence,
    ).toHaveLength(1);
  });

  it("keeps lost backlink lineage without admitting a lost-only domain", () => {
    const artifact = normalizeCommercialDiscoveryResponse({
      call: {
        endpoint: "/v3/backlinks/backlinks/live",
        intent: "DISCOVERY",
        sourceType: "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
        request: { target: "competitor.com" },
        responseSchemaVersion: "test.v1",
        estimatedCostMicros: 1_000,
      },
      collectedAt: "2026-08-18T02:15:00.000Z",
      response: {
        tasks: [{
          id: "task-lost-page-evidence",
          cost: 0.02,
          result: [{
            items: [{
              domain_from: "historical-only.com",
              url_from: "https://historical-only.com/removed",
              domain_to: "competitor.com",
              url_to: "https://competitor.com/old",
              is_lost: true,
              domain_from_rank: 82,
            }],
          }],
        }],
      },
    });

    expect(artifact.candidates[0]?.backlinkPageEvidence[0]?.linkStatus)
      .toBe("lost");
    expect(mergeCommercialDiscoveryArtifacts({
      artifacts: [artifact],
      userDomain: "owner.com",
      excludedDomains: [],
    })).toEqual([]);
  });

  it("normalizes official task results and withholds user-RD-only domains", () => {
    const call = {
      endpoint: "/v3/backlinks/referring_domains/live",
      intent: "DISCOVERY",
      sourceType: "USER_REFERRING_DOMAINS",
      request: { target: "owner.com" },
      responseSchemaVersion: "test.v1",
      estimatedCostMicros: 1_000,
    } as const;
    const userArtifact = normalizeCommercialDiscoveryResponse({
      call,
      collectedAt: "2026-08-06T08:00:00.000Z",
      response: {
        tasks: [
          {
            id: "task-user",
            cost: 0.001,
            result: [
              {
                items: [
                  {
                    domain: "user-only.com",
                    rank: 40,
                    backlinks: 10,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const serpArtifact = normalizeCommercialDiscoveryResponse({
      call: {
        ...call,
        endpoint: "/v3/serp/google/organic/task_get/advanced",
        sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
      },
      collectedAt: "2026-08-06T08:00:00.000Z",
      response: {
        tasks: [
          {
            id: "task-serp",
            cost: 0,
            result: [
              {
                items: [
                  {
                    domain: "publisher.com",
                    rank: 80,
                    url: "https://publisher.com/reviews/home-cinema-projectors",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(
      mergeCommercialDiscoveryArtifacts({
        artifacts: [userArtifact],
        userDomain: "owner.com",
        excludedDomains: [],
      }),
    ).toEqual([]);
    expect(
      mergeCommercialDiscoveryArtifacts({
        artifacts: [userArtifact, serpArtifact],
        userDomain: "owner.com",
        excludedDomains: [],
      }).map(({ canonicalDomain, discoveryUrls }) => ({
        canonicalDomain,
        discoveryUrls,
      })),
    ).toEqual([
      {
        canonicalDomain: "publisher.com",
        discoveryUrls: [
          "https://publisher.com/reviews/home-cinema-projectors",
        ],
      },
    ]);
  });

  it("reads Labs traffic from full_domain_metrics without treating count as backlinks", () => {
    const artifact = normalizeCommercialDiscoveryResponse({
      call: {
        endpoint: "/v3/dataforseo_labs/google/competitors_domain/live",
        intent: "DISCOVERY",
        sourceType: "VERIFIED_COMPETITOR_BACKLINK_GAP",
        request: { target: "owner.com" },
        responseSchemaVersion: "test.v1",
        estimatedCostMicros: 1_000,
      },
      collectedAt: "2026-08-12T03:40:00.000Z",
      response: {
        tasks: [
          {
            id: "task-labs",
            cost: 0.024,
            result: [
              {
                items: [
                  {
                    domain: "publisher.com",
                    count: 42,
                    full_domain_metrics: {
                      organic: { etv: 12_345 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(artifact.candidates[0]).toMatchObject({
      canonicalDomain: "publisher.com",
      traffic: 12_345,
      backlinkCount: null,
    });
    expect(extractCommercialCompetitorSeeds({
      artifacts: [artifact],
      userDomain: "owner.com",
      excludedDomains: [],
    })).toEqual(["publisher.com"]);
    expect(mergeCommercialDiscoveryArtifacts({
      artifacts: [artifact],
      userDomain: "owner.com",
      excludedDomains: [],
    })).toEqual([]);
  });

  it("round-robins source candidates before authority can exhaust scoring capacity", () => {
    const competitorArtifact = normalizeCommercialDiscoveryResponse({
      call: {
        endpoint: "/v3/backlinks/backlinks/live",
        intent: "DISCOVERY",
        sourceType: "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
        request: { target: "competitor.com" },
        responseSchemaVersion: "test.v1",
        estimatedCostMicros: 1_000,
      },
      collectedAt: "2026-08-18T03:00:00.000Z",
      response: {
        tasks: [{
          id: "competitor-pages",
          cost: 0.01,
          result: [{
            items: [
              {
                domain_from: "huge-one.com",
                url_from: "https://huge-one.com/old-link",
                domain_to: "competitor.com",
                url_to: "https://competitor.com/",
                is_lost: false,
                domain_from_rank: 99,
              },
              {
                domain_from: "huge-two.com",
                url_from: "https://huge-two.com/old-link",
                domain_to: "competitor.com",
                url_to: "https://competitor.com/",
                is_lost: false,
                domain_from_rank: 98,
              },
            ],
          }],
        }],
      },
    });
    const serpArtifact = normalizeCommercialDiscoveryResponse({
      call: {
        endpoint: "/v3/serp/google/organic/task_get/advanced",
        intent: "DISCOVERY",
        sourceType: "BLUEPRINT_SERP_STANDARD_QUEUE",
        request: { keyword: "streaming publication contribute" },
        responseSchemaVersion: "test.v1",
        estimatedCostMicros: 1_000,
      },
      collectedAt: "2026-08-18T03:00:00.000Z",
      response: {
        tasks: [{
          id: "serp-pages",
          cost: 0.01,
          result: [{
            items: [{
              domain: "relevant-small-publisher.com",
              rank: 30,
              url: "https://relevant-small-publisher.com/contribute",
            }],
          }],
        }],
      },
    });

    expect(mergeCommercialDiscoveryArtifacts({
      artifacts: [competitorArtifact, serpArtifact],
      userDomain: "owner.com",
      excludedDomains: [],
    }).slice(0, 2).map(({ canonicalDomain }) => canonicalDomain)).toEqual([
      "huge-one.com",
      "relevant-small-publisher.com",
    ]);
  });
});
