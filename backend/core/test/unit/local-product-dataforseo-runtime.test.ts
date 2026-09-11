import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertLocalProductDataForSeoCredentialReady,
  isLocalProductDataForSeoPaidCallAllowed,
  buildLocalProductRecommendationEvidenceCandidate,
  buildStoredCommercialRecommendationEvidenceCandidate,
  createLocalProductDataForSeoRuntime,
  localProductDataForSeoAvailabilityDecision,
  parseLocalProductRecommendationContext,
  parseLocalProductRecommendationContextDatabaseRow,
  readLocalProductDataForSeoConfiguration,
  resolveExistingCandidateQualificationPlan,
  resolveLocalProductDataForSeoOperationBudget,
  resolveLocalProductCommercialRefillCycle,
  resolveLocalProductProjectDiscoveryInput,
} from "../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.js";
import { parseProviderOperationBudgetAuthorization } from "../../src/modules/backlinks/domain/recommendations/provider-operation-budget.js";
import {
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../../src/modules/backlinks/adapters/security/local-product-secret-store-client.js";
import { CORRECTED_QUALIFICATION_CONTRACT_VERSION } from "../../src/modules/backlinks/ports/recommendation-contract.port.js";
import type {
  GenerationInputBinding,
  SharedSeoEvidenceSourceModule,
} from "../../src/modules/backlinks/ports/shared-seo-evidence.port.js";

import { evaluateRecommendationCandidate } from "../../src/modules/backlinks/domain/recommendations/evaluation.js";
import {
  applyProgressiveCommercialCandidateAdmission,
  evaluateCommercialCandidate,
} from "../../src/modules/backlinks/domain/recommendations/commercial-candidate-evaluation.js";
import { secretKinds } from "../../src/modules/backlinks/ports/secret-store.port.js";
import { readFile } from "node:fs/promises";

const environment = Object.freeze({
  DATAFORSEO_CREDENTIAL_SECRET_REF:
    "secret://growthos/local-product/dataforseo/provider-credential/v7",
  DATAFORSEO_ENDPOINT_ALLOWLIST: JSON.stringify([
    "https://api.dataforseo.com/v3/serp/google/organic/task_post",
    "https://api.dataforseo.com/v3/serp/google/organic/tasks_ready",
    "https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced",
    "https://api.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live",
    "https://api.dataforseo.com/v3/backlinks/competitors/live",
    "https://api.dataforseo.com/v3/backlinks/referring_domains/live",
    "https://api.dataforseo.com/v3/backlinks/summary/live",
    "https://api.dataforseo.com/v3/backlinks/backlinks/live",
    "https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_traffic_estimation/live",
    "https://api.dataforseo.com/v3/backlinks/bulk_spam_score/live",
    "https://api.dataforseo.com/v3/backlinks/bulk_ranks/live",
  ]),
  DATAFORSEO_REQUEST_TIMEOUT_MS: "60000",
  DATAFORSEO_ESTIMATED_COST_MICROS: "50000",
  DATAFORSEO_ABSOLUTE_BUDGET_MICROS: "100000",
  DATAFORSEO_MAX_PAID_CALLS: "25",
  DATAFORSEO_CANDIDATE_LIMIT: "20",
  DATAFORSEO_DISCOVERY_TARGETS_JSON: JSON.stringify([
    "showmax.com",
    "dstv.com",
  ]),
});
const organizationId = "11111111-1111-4111-8111-111111111111";
const websiteProjectId = "33333333-3333-4333-8333-333333333333";
const recommendationContextVersionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("DataForSEO execution ceiling configuration", () => {
  it("requires both ceiling fields and validates the fixed timestamp", () => {
    expect(() => readLocalProductDataForSeoConfiguration({
      ...environment, DATAFORSEO_EXECUTION_LIMIT_MICROS: "16800",
    })).toThrow();
    expect(() => readLocalProductDataForSeoConfiguration({
      ...environment, DATAFORSEO_EXECUTION_STARTED_AT: "not-a-date",
      DATAFORSEO_EXECUTION_LIMIT_MICROS: "16800",
    })).toThrow();
    expect(readLocalProductDataForSeoConfiguration({
      ...environment, DATAFORSEO_EXECUTION_STARTED_AT: "2026-09-08T02:00:00Z",
      DATAFORSEO_EXECUTION_LIMIT_MICROS: "16800",
    }).executionCeiling).toEqual({
      startedAt: "2026-09-08T02:00:00Z", limitMicros: 16800,
    });
  });
});
const profileVersionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const promotionTargetVersionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function projectContext(overrides: Readonly<Record<string, unknown>> = {}) {
  return parseLocalProductRecommendationContext({
    snapshotVersion: 4,
    profileVersionId,
    promotionTargetVersionId,
    projectSettingsVersionId: "00000000-0000-4000-8000-000000000011",
    projectSettingsVersion: 2,
    projectStatus: "ACTIVE",
    canonicalDomain: "elephtv.com",
    locale: "en-ZA",
    countryCode: "ZA",
    products: ["streaming entertainment"],
    keywords: ["streaming service in South Africa"],
    targetUrls: [],
    targetAudiences: ["South African viewers"],
    partnershipGoals: ["editorial review"],
    explicitCompetitorDomains: ["untrusted-settings.com"],
    ...overrides,
  });
}

function evidence(
  sourceModule: SharedSeoEvidenceSourceModule,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const recordId =
    sourceModule === "site-profile"
      ? "10000000-0000-4000-8000-000000000001"
      : sourceModule === "content"
        ? "10000000-0000-4000-8000-000000000002"
        : sourceModule === "keywords"
          ? "10000000-0000-4000-8000-000000000003"
          : sourceModule === "competitor-serp"
            ? "10000000-0000-4000-8000-000000000004"
            : "10000000-0000-4000-8000-000000000005";
  return Object.freeze({
    recordId,
    snapshot: Object.freeze({
      organizationId,
      websiteProjectId,
      evidenceType: `website-project.${sourceModule}`,
      sourceModule,
      sourceRecordId: recordId,
      sourceVersion: `${sourceModule}.v1`,
      provider: "growthos-platform",
      endpoint: `website-project/${sourceModule}`,
      normalizedParameters: Object.freeze(
        sourceModule === "site-profile"
          ? { canonicalDomain: "elephtv.com" }
          : sourceModule === "competitor-serp"
            ? { domains: ["showmax.com", "dstv.com"] }
            : {},
      ),
      requestFingerprint: `fixture-${sourceModule}`,
      market: "ZA",
      location: "ZA",
      language: "en-ZA",
      fetchedAt: "2026-08-17T00:00:00.000Z",
      expiresAt: "2026-09-17T00:00:00.000Z",
      providerRequestId: `platform-${sourceModule}`,
      providerTaskId: null,
      costMicros: 0,
      artifactRef: `platform://website-project/${sourceModule}`,
      status: "ready" as const,
      ...overrides,
    }),
  });
}

function inputBinding(
  input: Readonly<{
    keywords?: readonly string[];
    targetUrls?: readonly string[];
    authorizedSources?: readonly string[];
    sharedEvidence?: readonly ReturnType<typeof evidence>[];
  }> = {},
): GenerationInputBinding {
  const sharedEvidence = input.sharedEvidence ?? [evidence("site-profile")];
  return Object.freeze({
    inputPinId: "99999999-9999-4999-8999-999999999999",
    outreachProfileRecordId: "88888888-8888-4888-8888-888888888888",
    immutableFingerprint: "fixture-binding",
    pins: Object.freeze({
      organizationId,
      websiteProjectId,
      projectContextVersion: 4,
      siteProfileVersionId: profileVersionId,
      outreachProfileVersionId: profileVersionId,
      promotionTargetVersionId,
      keywordEvidenceSnapshotIds: Object.freeze(
        sharedEvidence
          .filter(({ snapshot }) => snapshot.sourceModule === "keywords")
          .map(({ recordId }) => recordId),
      ),
      sharedEvidenceSnapshotIds: Object.freeze(
        sharedEvidence.map(({ recordId }) => recordId),
      ),
      market: "ZA",
      qualificationContractVersion: CORRECTED_QUALIFICATION_CONTRACT_VERSION,
    }),
    outreachProfile: Object.freeze({
      organizationId,
      websiteProjectId,
      profileVersionId,
      promotionTargetVersionId,
      keywordsAndTopics: Object.freeze([
        ...(input.keywords ?? ["streaming service in South Africa"]),
      ]),
      productsAndServices: Object.freeze(["streaming entertainment"]),
      targetUrls: Object.freeze([...(input.targetUrls ?? [])]),
      targetAudiences: Object.freeze(["South African viewers"]),
      partnershipGoals: Object.freeze(["editorial review"]),
      market: "ZA",
      location: "ZA",
      language: "en-ZA",
      authorizedDiscoverySources: Object.freeze([
        ...(input.authorizedSources ?? [
          "WEBSITE_PROJECT",
          "CURATED_RESOURCE_LIBRARY",
          "KEYWORDS",
          "CONTENT",
          "COMPETITOR_SERP",
          "GSC",
        ]),
      ]),
      immutableFingerprint: "fixture-profile",
    }),
    sharedEvidence: Object.freeze([...sharedEvidence]),
  });
}

function currentCommercialCandidate(
  overrides: Readonly<{
    candidateId?: string;
    hostnameAscii?: string;
    unsafeOrMalicious?: boolean | null;
    highConfidenceLinkFarm?: boolean | null;
    spamScore?: number | null;
  }> = {},
) {
  const hostnameAscii = overrides.hostnameAscii ?? "publisher.co.za";
  const staticAssessment = Object.freeze({
    canonicalDomain: hostnameAscii,
    decision: "ready" as const,
    language: "en",
    topics: Object.freeze(["film reviews"]),
    matchedProducts: Object.freeze(["streaming entertainment"]),
    matchedTopics: Object.freeze(["film reviews"]),
    matchedKeywords: Object.freeze(["streaming reviews"]),
    matchedTargetPages: Object.freeze([]),
    matchedAudiences: Object.freeze(["South African viewers"]),
    matchedPartnershipGoals: Object.freeze([]),
    relatedContentPages: Object.freeze([`https://${hostnameAscii}/reviews`]),
    productRelevance: 0.9,
    editorialQuality: 0.9,
    siteType: "specialist_blog",
    monetizationMethods: Object.freeze(["advertising"]),
    cooperationPages: Object.freeze(["https://publisher.co.za/contribute"]),
    outboundLinkDensity: 0.1,
    technicalAccessibility: 1,
    unsafeOrMalicious: overrides.unsafeOrMalicious ?? false,
    highConfidenceLinkFarm: overrides.highConfidenceLinkFarm ?? false,
    unrelatedIndustry: false,
    evidenceUrls: Object.freeze([`https://${hostnameAscii}/`]),
    evidenceRefs: Object.freeze([`safefetch:${hostnameAscii}`]),
    failedUrls: Object.freeze([]),
    collectedAt: "2026-08-20T00:00:00.000Z",
    ruleVersion: "commercial-static-assessment.v3" as const,
  });
  const business = Object.freeze({
    selfOrRelatedDomain: false,
    existingBacklinkOrOpportunity: false,
    permanentlyRejectedOrSuppressed: false,
    unsafeOrDisallowedIndustry: false,
    targetCountryCode: "ZA",
    candidateCountryCode: "ZA",
    targetLanguages: Object.freeze(["en-ZA"]),
    allowSameLanguageExpansion: false,
    targetMarketScopedDiscovery: true,
  });
  const provider = Object.freeze({
    rank: 98,
    traffic: null,
    backlinkCount: 5_000,
    referringDomainCount: 500,
    spamScore: overrides.spamScore ?? 0,
    countryCode: "ZA",
    backlinkPageEvidence: Object.freeze([]),
    evidenceRefs: Object.freeze([`dataforseo:${hostnameAscii}`]),
    collectedAt: "2026-08-20T00:00:00.000Z",
  });
  const commercialScore = evaluateCommercialCandidate({
    business,
    provider,
    staticAssessment,
  });
  return Object.freeze({
    candidateId:
      overrides.candidateId ?? "00000000-0000-4000-8000-000000000001",
    hostnameAscii,
    sourceTypes: Object.freeze(["BLUEPRINT_SERP_STANDARD_QUEUE"] as const),
    business,
    provider,
    staticAssessment,
    commercialScore,
  });
}

describe("LOCAL-REAL-002 DataForSEO runtime", () => {
  it("does not expose the V1 store or execute a legacy provider request", async () => {
    let queries = 0;
    const runtime = createLocalProductDataForSeoRuntime({
      pool: {
        async connect() {
          queries += 1;
          throw new Error("Retired requests must not reach the database");
        },
      },
      secretStoreRoot: join(tmpdir(), "unused-retirement-test"),
      configuration: readLocalProductDataForSeoConfiguration(environment),
    });
    expect(runtime).not.toHaveProperty("store");
    for (const source of ["paid", "existing"] as const) {
      await expect(runtime.execute({
        source,
      } as Parameters<typeof runtime.execute>[0])).rejects.toThrow(
        "BACKLINKS_V1_RECOMMENDATION_PROVIDER_RETIRED",
      );
    }
    expect(queries).toBe(0);
    const source = await readFile(
      new URL("../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("FROM backlink_recommendation_refills");
    expect(source).not.toContain("writeCorrectedRecommendationFactsInTransaction");
    expect(source).not.toContain("commercial-score-v4");
    expect(source).not.toContain("INSERT INTO backlink_recommendations");
  });

  it("allows only calls below the configured paid-call ceiling", () => {
    expect(isLocalProductDataForSeoPaidCallAllowed(0, 25, 0)).toBe(true);
    expect(isLocalProductDataForSeoPaidCallAllowed(24, 25, 0)).toBe(true);
    expect(isLocalProductDataForSeoPaidCallAllowed(25, 25, 0)).toBe(false);
    expect(isLocalProductDataForSeoPaidCallAllowed(0, 3, 3)).toBe(false);
    expect(isLocalProductDataForSeoPaidCallAllowed(0, 4, 3)).toBe(true);
    expect(isLocalProductDataForSeoPaidCallAllowed(1, 4, 3)).toBe(false);
  });

  it("keeps an audited operation authorization as an exact ceiling", () => {
    const configuration = readLocalProductDataForSeoConfiguration({
      ...environment,
      DATAFORSEO_ABSOLUTE_BUDGET_MICROS: "1000000",
      DATAFORSEO_MAX_PAID_CALLS: "3",
    });
    const authorization = parseProviderOperationBudgetAuthorization({
      provider: "dataforseo",
      reasonCode: "user_authorized_bounded_real_refill",
      maxPaidCalls: 4,
      maxCostMicros: 1_000_000,
      recommendationContextVersionId,
      visiblePoolGeneration: 1,
      authorizedBy: "local-product-operator",
    });
    expect(authorization).not.toHaveProperty("recommendationContextVersionId");
    expect(authorization).not.toHaveProperty("visiblePoolGeneration");

    expect(
      resolveLocalProductDataForSeoOperationBudget({
        configuration,
        authorization,
      }),
    ).toEqual({
      maxPaidCalls: 4,
      operationBudgetLimitMicros: 1_000_000,
      dailyBudgetLimitMicros: 1_000_000,
      authorization,
    });
    expect(parseProviderOperationBudgetAuthorization(authorization)).toEqual(
      authorization,
    );
    expect(
      resolveLocalProductDataForSeoOperationBudget({
        configuration,
        authorization: null,
      }),
    ).toEqual({
      maxPaidCalls: 3,
      operationBudgetLimitMicros: 1_000_000,
      dailyBudgetLimitMicros: 1_000_000,
      authorization: null,
    });
  });

  it("enforces the paid-call ceiling across the current workspace budget cycle", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("WITH current_budget AS");
    expect(source).toContain("FROM backlink_provider_usage_ledger AS usage");
    expect(source).toContain(
      "JOIN current_budget AS budget ON budget.id=usage.budget_id",
    );
    expect(source).toContain("usage.status IN ('reserved','settled')");
    expect(source).toContain("request_id=$5 AND status='running'");
    expect(source).toContain("usage.provider_request_id<>COALESCE(");
    expect(source).toContain("gateInput.context.requestId");
    expect(source).toContain("reserveBudgetWithinPaidCallCeiling(");
    expect(source).toContain("configuration.maxPaidCalls");
    expect(source).toContain("configuration.absoluteBudgetMicros");
    expect(source).toContain(
      "return (await resolveProviderRuntime()).execute(call, hooks);",
    );
  });

  it("keeps the native discovery request ceiling without V1 qualification calls", async () => {
    const source = await readFile(
      new URL(
        "../../src/modules/backlinks/runtime/local-product-dataforseo-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toContain("`commercial-refill-operation:${input.jobId}`");
    expect(source).not.toContain("createCommercialQualificationOfficialRuntime");
    expect(source).toContain("providerBudgetOperationPrefix,");
    expect(source).toContain("requestClientFactory: async () => {");
    expect(source).toContain(
      "gate: createGate(client, providerBudgetOperationPrefix)",
    );
  });

  it("never falls back to Provider qualification for explicit existing-evidence replay", () => {
    const publishable = [{ candidateId: "publishable-1" }];
    const enrichment = [{ candidateId: "enrichment-1" }];

    expect(
      resolveExistingCandidateQualificationPlan({
        supplyMode: "existing_evidence",
        publishableCandidates: publishable,
        enrichmentCandidates: enrichment,
      }),
    ).toEqual({
      candidates: publishable,
      metricCollectionMode: "existing_evidence",
    });
    expect(
      resolveExistingCandidateQualificationPlan({
        supplyMode: "existing_evidence",
        publishableCandidates: [],
        enrichmentCandidates: enrichment,
      }),
    ).toEqual({
      candidates: [],
      metricCollectionMode: "existing_evidence",
    });
    expect(
      resolveExistingCandidateQualificationPlan({
        publishableCandidates: [],
        enrichmentCandidates: enrichment,
      }),
    ).toEqual({
      candidates: enrichment,
      metricCollectionMode: "provider",
    });
  });

  it("resolves provider failures through the zero-paid curated fallback", () => {
    expect(
      resolveLocalProductCommercialRefillCycle({
        refillWindowKey: "manual:1786359107748:request-1",
        triggerReason: "manual",
        websiteProjectId: "project-1",
        projectContextVersionId: "context-1",
        currentTier: "resource_media_review_partner_ecosystem",
        currentRound: 1,
        terminationReason: "PROVIDER_UNAVAILABLE",
      }),
    ).toEqual({
      tier: "curated_resource_library",
      round: 1,
      window: 1,
    });

    expect(
      resolveLocalProductCommercialRefillCycle({
        refillWindowKey: "manual:1786359107748:request-2",
        triggerReason: "manual",
        websiteProjectId: "project-1",
        projectContextVersionId: "context-1",
        currentTier: "same_language_expansion",
        currentRound: 1,
        terminationReason: "PROVIDER_UNAVAILABLE",
      }),
    ).toEqual({
      tier: "curated_resource_library",
      round: 1,
      window: 1,
    });

    expect(() =>
      resolveLocalProductCommercialRefillCycle({
        refillWindowKey: "manual:1786359107748:request-3",
        triggerReason: "manual",
        websiteProjectId: "project-1",
        projectContextVersionId: "context-1",
        currentTier: "curated_resource_library",
        currentRound: 1,
        terminationReason: "PROVIDER_UNAVAILABLE",
      }),
    ).toThrow("COMMERCIAL_REFILL_TIERS_EXHAUSTED");
  });

  it("rejects cross-project cycles and sends budget blocks to the curated fallback", () => {
    expect(() =>
      resolveLocalProductCommercialRefillCycle({
        refillWindowKey: "commercial-refill:project-2:context-1:g1:t1:r1:w1",
        triggerReason: "inventory_low",
        websiteProjectId: "project-1",
        projectContextVersionId: "context-1",
        visiblePoolGeneration: 1,
        currentTier: "exact_product_target_market",
        currentRound: 1,
        terminationReason: null,
      }),
    ).toThrow("COMMERCIAL_REFILL_CYCLE_KEY_INVALID");

    expect(
      resolveLocalProductCommercialRefillCycle({
        refillWindowKey: "manual:1786359107748:request-4",
        triggerReason: "manual",
        websiteProjectId: "project-1",
        projectContextVersionId: "context-1",
        visiblePoolGeneration: 1,
        currentTier: "exact_product_target_market",
        currentRound: 1,
        terminationReason: "BUDGET",
      }),
    ).toEqual({
      tier: "curated_resource_library",
      round: 1,
      window: 1,
    });
  });

  it("keeps a planned paid window authoritative during budget recovery", () => {
    expect(
      resolveLocalProductCommercialRefillCycle({
        refillWindowKey: "commercial-refill:project-1:context-1:g1:t1:r1:w1",
        triggerReason: "inventory_low",
        websiteProjectId: "project-1",
        projectContextVersionId: "context-1",
        visiblePoolGeneration: 1,
        currentTier: "exact_product_target_market",
        currentRound: 1,
        terminationReason: "BUDGET",
      }),
    ).toEqual({
      tier: "exact_product_target_market",
      round: 1,
      window: 1,
    });
  });

  it("accepts bounded local real-product configuration", () => {
    const configuration = readLocalProductDataForSeoConfiguration(environment);
    const configurationWithoutGlobalTargets =
      readLocalProductDataForSeoConfiguration({
        ...environment,
        DATAFORSEO_DISCOVERY_TARGETS_JSON: undefined,
      });
    expect(configuration).toMatchObject({
      estimatedCostMicros: 50_000,
      absoluteBudgetMicros: 100_000,
      maxPaidCalls: 25,
      candidateLimit: 20,
      discoveryConcurrency: 2,
      qualificationConcurrency: 2,
      externalAvailability: "not_checked",
      externalReasonCode: "provider_not_checked",
      externalRecoveryAction: "run_provider_diagnostic",
    });
    expect(configurationWithoutGlobalTargets).toEqual(configuration);
    expect(configuration).not.toHaveProperty("discoveryTargets");
    expect(configuration).not.toHaveProperty("locationCode");
    expect(configuration).not.toHaveProperty("languageCode");
    expect(
      readLocalProductDataForSeoConfiguration({
        ...environment,
        DATAFORSEO_REQUEST_TIMEOUT_MS: "300000",
      }),
    ).toMatchObject({ timeoutMs: 300_000 });

    expect(() =>
      readLocalProductDataForSeoConfiguration({
        ...environment,
        DATAFORSEO_ENDPOINT_ALLOWLIST: JSON.stringify([
          "https://provider.invalid/live",
        ]),
      }),
    ).toThrow();
    expect(() =>
      readLocalProductDataForSeoConfiguration({
        ...environment,
        DATAFORSEO_REQUEST_TIMEOUT_MS: "300001",
      }),
    ).toThrow();
    expect(() =>
      readLocalProductDataForSeoConfiguration({
        ...environment,
        DATAFORSEO_DISCOVERY_CONCURRENCY: "5",
      }),
    ).toThrow();
    expect(() =>
      readLocalProductDataForSeoConfiguration({
        ...environment,
        DATAFORSEO_QUALIFICATION_CONCURRENCY: "0",
      }),
    ).toThrow();
  });

  it("turns explicit external unavailability into an execution decision", () => {
    const configuration = readLocalProductDataForSeoConfiguration({
      ...environment,
      DATAFORSEO_EXTERNAL_AVAILABILITY: "unavailable",
      DATAFORSEO_EXTERNAL_UNAVAILABLE_REASON: "explicit_block",
    });

    expect(localProductDataForSeoAvailabilityDecision(configuration)).toEqual({
      decision: "deny",
      reasonCode: "explicit_block",
      recoveryAction: "remove_explicit_block",
    });
  });

  it("fails worker credential readiness before provider work can start", async () => {
    const secretStoreRoot = await mkdtemp(
      join(tmpdir(), "growthos-dataforseo-readiness-"),
    );
    const configuration = readLocalProductDataForSeoConfiguration(environment);

    await expect(
      assertLocalProductDataForSeoCredentialReady({
        secretStoreRoot,
        configuration,
      }),
    ).rejects.toThrow(
      `BACKLINKS_DATAFORSEO_CREDENTIAL_UNAVAILABLE root=${secretStoreRoot}`,
    );

    await new LocalProductSecretStoreClient({
      rootDirectory: secretStoreRoot,
    }).importFixed({
      reference: parseLocalProductSecretReference(
        configuration.credentialSecretRef,
        secretKinds.dataForSeoCredential,
      ),
      plaintext: JSON.stringify({
        login: "dataforseo-login",
        password: "dataforseo-password",
      }),
      context: {
        organizationId: "local-product",
        subjectProvider: "dataforseo",
      },
    });

    await expect(
      assertLocalProductDataForSeoCredentialReady({
        secretStoreRoot,
        configuration,
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps startup and runtime configuration project-generic", async () => {
    const [startup, environmentExample, coreEntry] = await Promise.all([
      readFile(
        new URL("../../../../scripts/dev-up.ps1", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../../deploy/compose/.env.example", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../../src/index.ts", import.meta.url), "utf8"),
    ]);
    for (const source of [startup, environmentExample, coreEntry]) {
      expect(source).not.toContain("LOCAL_PRODUCT_WEBSITE_PROJECT_ID");
    }
    for (const name of [
      "DATAFORSEO_LOCATION_CODE",
      "DATAFORSEO_LANGUAGE_CODE",
      "DATAFORSEO_PROJECT_KEYWORDS_JSON",
      "DATAFORSEO_PROJECT_PRODUCTS_JSON",
      "DATAFORSEO_TARGET_URLS_JSON",
    ]) {
      expect(startup).not.toContain(name);
      expect(environmentExample).not.toContain(name);
    }
    expect(environmentExample).toContain(
      "DATAFORSEO_EXTERNAL_AVAILABILITY=available",
    );
    expect(environmentExample).toContain(
      "DATAFORSEO_ABSOLUTE_BUDGET_MICROS=5000000",
    );
    expect(environmentExample).toContain("DATAFORSEO_MAX_PAID_CALLS=25");
  });

  it("binds discovery and scoring facts to one immutable Website Project context", () => {
    expect(
      parseLocalProductRecommendationContext({
        snapshotVersion: 4,
        profileVersionId,
        promotionTargetVersionId,
        projectSettingsVersionId: "00000000-0000-4000-8000-000000000011",
        projectSettingsVersion: 2,
        projectStatus: "ACTIVE",
        canonicalDomain: "awolvision.com",
        locale: "en-US",
        countryCode: "US",
        products: ["Home cinema projector"],
        keywords: ["home cinema"],
        targetUrls: ["https://awolvision.com/"],
        targetAudiences: ["home cinema buyers"],
        partnershipGoals: ["editorial review"],
        explicitCompetitorDomains: [],
      }),
    ).toMatchObject({
      snapshotVersion: 4,
      canonicalDomain: "awolvision.com",
      countryCode: "US",
      keywords: ["home cinema"],
    });

    expect(() =>
      parseLocalProductRecommendationContext({
        snapshotVersion: 4,
        profileVersionId,
        promotionTargetVersionId,
        projectSettingsVersionId: "00000000-0000-4000-8000-000000000011",
        projectSettingsVersion: 2,
        projectStatus: "PAUSED",
        canonicalDomain: "awolvision.com",
        locale: "en",
        countryCode: "US",
        products: ["Home cinema projector"],
        keywords: ["home cinema"],
        targetUrls: ["https://awolvision.com/"],
        targetAudiences: [],
        partnershipGoals: [],
        explicitCompetitorDomains: [],
      }),
    ).toThrow();
  });

  it("separates validated V2 pool metadata from the strict project context", () => {
    const parsed = parseLocalProductRecommendationContextDatabaseRow({
      snapshotVersion: 4,
      profileVersionId,
      promotionTargetVersionId,
      projectSettingsVersionId: "00000000-0000-4000-8000-000000000011",
      projectSettingsVersion: 2,
      projectStatus: "ACTIVE",
      canonicalDomain: "elephtv.com",
      locale: "en-ZA",
      countryCode: "ZA",
      products: ["streaming entertainment"],
      keywords: ["streaming service in South Africa"],
      targetUrls: [],
      targetAudiences: ["South African viewers"],
      partnershipGoals: ["editorial review"],
      explicitCompetitorDomains: [],
      poolContractVersion: "recommendation-pool.v2",
      poolMigrationState: "V2_ACTIVE",
      poolRecommendationContextVersionId: recommendationContextVersionId,
    });

    expect(parsed).toMatchObject({
      poolContractVersion: "recommendation-pool.v2",
      migrationState: "V2_ACTIVE",
      contractRecommendationContextVersionId: recommendationContextVersionId,
      context: {
        canonicalDomain: "elephtv.com",
        countryCode: "ZA",
      },
    });
    expect(parsed.context).not.toHaveProperty("poolContractVersion");

    expect(() =>
      parseLocalProductRecommendationContextDatabaseRow({
        ...parsed.context,
        poolContractVersion: "recommendation-pool.v2",
        poolMigrationState: "V2_ACTIVE",
        poolRecommendationContextVersionId: "not-a-uuid",
      }),
    ).toThrow();
  });

  it("accepts the minimum sufficient project evidence without optional modules", () => {
    const context = projectContext();
    const resolved = resolveLocalProductProjectDiscoveryInput({
      organizationId,
      websiteProjectId,
      context,
      binding: inputBinding(),
      now: new Date("2026-08-18T00:00:00.000Z"),
    });

    expect(resolved.context).toMatchObject({
      canonicalDomain: "elephtv.com",
      keywords: ["streaming service in South Africa"],
      explicitCompetitorDomains: [],
    });
    expect(resolved.binding.outreachProfile.authorizedDiscoverySources).toEqual(
      ["WEBSITE_PROJECT", "CURATED_RESOURCE_LIBRARY"],
    );
  });

  it("uses a published target as the promotion proof and ignores expired optional evidence", () => {
    const publishedTarget =
      "https://elephtv.com/reviews/south-african-streaming-guide";
    const binding = inputBinding({
      keywords: [],
      targetUrls: [publishedTarget],
      sharedEvidence: [
        evidence("site-profile"),
        evidence("content"),
        evidence("gsc", {
          expiresAt: "2026-08-17T00:00:00.000Z",
          status: "expired",
        }),
        evidence("competitor-serp", {
          expiresAt: "2026-08-17T00:00:00.000Z",
          status: "expired",
        }),
      ],
    });
    const resolved = resolveLocalProductProjectDiscoveryInput({
      organizationId,
      websiteProjectId,
      context: projectContext({
        keywords: [],
        targetUrls: [publishedTarget],
      }),
      binding,
      now: new Date("2026-08-18T00:00:00.000Z"),
    });

    expect(resolved.context.targetUrls).toEqual([publishedTarget]);
    expect(resolved.context.explicitCompetitorDomains).toEqual([]);
    expect(resolved.binding.outreachProfile.authorizedDiscoverySources).toEqual(
      ["WEBSITE_PROJECT", "CURATED_RESOURCE_LIBRARY", "CONTENT"],
    );
  });

  it("uses stale required evidence but rejects version mismatches", () => {
    expect(() =>
      resolveLocalProductProjectDiscoveryInput({
        organizationId,
        websiteProjectId,
        context: projectContext(),
        binding: inputBinding({
          sharedEvidence: [
            evidence("site-profile", {
              expiresAt: "2026-08-17T00:00:00.000Z",
              status: "expired",
            }),
          ],
        }),
        now: new Date("2026-08-18T00:00:00.000Z"),
      }),
    ).not.toThrow();

    expect(() =>
      resolveLocalProductProjectDiscoveryInput({
        organizationId,
        websiteProjectId,
        context: projectContext({ snapshotVersion: 5 }),
        binding: inputBinding(),
        now: new Date("2026-08-18T00:00:00.000Z"),
      }),
    ).toThrow(
      "owner=WEBSITE_PROJECT recovery=reproject_current_website_project reason=project_or_version_binding_mismatch",
    );
  });

  it("builds an evaluable non-demo candidate from provider and SafeFetch evidence", async () => {
    const candidate = await buildLocalProductRecommendationEvidenceCandidate({
      context: {
        workspaceId: "workspace-1",
        websiteProjectId: "project-1",
      },
      evidence: {
        domain: "sportsnews.co.za",
        backlinkCount: 1_200,
        rank: 72,
        spamScore: 4,
        countryCode: "ZA",
      },
      sourceReleaseId: "dataforseo:release-1",
      acquiredAt: "2026-08-04T08:00:00.000Z",
      locationCode: "ZA",
      languageCode: "en",
      projectTerms: [
        "live sports",
        "streaming movies",
        "ElephTV Android streaming app",
      ],
      existingHostname: false,
      existingBacklink: false,
      previouslyExcluded: false,
      duplicateDomain: false,
      safeFetch: {
        fetch: async () => ({
          requestedUrl: "https://sportsnews.co.za/",
          finalUrl: "https://sportsnews.co.za/",
          status: 200,
          contentType: "text/html",
          body: Uint8Array.from(
            Buffer.from(
              "<html lang='en'><head><title>Live sports and streaming news</title>" +
                "<meta name='description' content='Movies, TV and sports'></head>" +
                "<body><a href='/football'>Football</a>" +
                "<p>Independent editorial coverage of African live sports.</p>" +
                "</body></html>",
              "utf8",
            ),
          ),
          redirectChain: [],
          resolvedIps: ["203.0.113.10"],
          fetchedAt: "2026-08-04T08:00:01.000Z",
        }),
      },
    });

    const evaluated = evaluateRecommendationCandidate(candidate);
    expect(evaluated.decision).toBe("ready");
    expect(evaluated.hostnameAscii).toBe("sportsnews.co.za");
    expect(evaluated.score?.total).toBeGreaterThan(0);
  });

  it("fails closed when static website evidence cannot be collected", async () => {
    const candidate = await buildLocalProductRecommendationEvidenceCandidate({
      context: {
        workspaceId: "workspace-1",
        websiteProjectId: "project-1",
      },
      evidence: {
        domain: "unreachable.co.za",
        backlinkCount: 100,
        rank: 20,
        spamScore: null,
        countryCode: "ZA",
      },
      sourceReleaseId: "dataforseo:release-1",
      acquiredAt: "2026-08-04T08:00:00.000Z",
      locationCode: "ZA",
      languageCode: "en",
      projectTerms: ["live sports"],
      existingHostname: false,
      existingBacklink: false,
      previouslyExcluded: false,
      duplicateDomain: false,
      safeFetch: {
        fetch: async () => {
          throw new Error("network unavailable");
        },
      },
    });

    expect(evaluateRecommendationCandidate(candidate)).toMatchObject({
      decision: "insufficient_data",
    });
  });

  it("bridges eligible V4 evidence without re-fetching ordinary missing metrics", () => {
    const current = currentCommercialCandidate();
    expect(current.commercialScore).toMatchObject({
      decision: "eligible",
      missingEvidence: [],
      admission: { appliedThreshold: 50 },
    });

    const candidate = buildStoredCommercialRecommendationEvidenceCandidate({
      candidate: current,
      sourceReleaseId: "commercial-existing:release-1",
    });
    const evaluated = evaluateRecommendationCandidate(candidate);

    expect(evaluated).toMatchObject({
      decision: "ready",
      hostnameAscii: "publisher.co.za",
      missingEvidenceKeys: [],
    });
    expect(evaluated.score?.total).toBeCloseTo(
      current.commercialScore.total ?? 0,
      3,
    );
    expect(candidate.components).toHaveLength(5);
    expect(
      candidate.components.every(({ evidence }) =>
        evidence.evidenceRefs.includes("commercial-fit-v4:publisher.co.za"),
      ),
    ).toBe(true);
  });

  it("bridges a strongly relevant second-generation candidate admitted below 50", () => {
    const current = currentCommercialCandidate();
    const provider = Object.freeze({
      ...current.provider,
      rank: 0,
      traffic: 0,
      backlinkCount: 0,
      referringDomainCount: 0,
      spamScore: 29,
    });
    const staticAssessment = Object.freeze({
      ...current.staticAssessment,
      productRelevance: 0.35,
      editorialQuality: 0.2,
      matchedAudiences: Object.freeze([]),
      matchedPartnershipGoals: Object.freeze([]),
      monetizationMethods: Object.freeze([]),
      cooperationPages: Object.freeze([]),
      outboundLinkDensity: 0.8,
      technicalAccessibility: 0.8,
    });
    const baseline = evaluateCommercialCandidate({
      business: {
        ...current.business,
        projectAuthorityScore: 20,
      },
      provider,
      staticAssessment,
    });
    const commercialScore = applyProgressiveCommercialCandidateAdmission(
      [baseline],
      { visiblePoolGeneration: 2 },
    ).scores[0];
    if (commercialScore === undefined) {
      throw new Error("Missing progressively admitted commercial score");
    }

    const candidate = buildStoredCommercialRecommendationEvidenceCandidate({
      candidate: {
        ...current,
        provider,
        staticAssessment,
        commercialScore,
      },
      sourceReleaseId: "commercial-existing:release-2",
    });

    expect(commercialScore).toMatchObject({
      decision: "eligible",
      admission: {
        appliedThreshold: 40,
        fallbackApplied: true,
      },
    });
    expect(commercialScore?.total).toBeGreaterThanOrEqual(40);
    expect(commercialScore?.total).toBeLessThan(50);
    expect(evaluateRecommendationCandidate(candidate)).toMatchObject({
      decision: "ready",
      hostnameAscii: "publisher.co.za",
      missingEvidenceKeys: [],
    });
  });

  it("keeps persisted safety uncertainty and hard risk fail closed", () => {
    const safe = currentCommercialCandidate();
    const uncertain = buildStoredCommercialRecommendationEvidenceCandidate({
      candidate: {
        ...safe,
        staticAssessment: {
          ...safe.staticAssessment,
          unsafeOrMalicious: null,
        },
      },
      sourceReleaseId: "commercial-existing:release-1",
    });
    const unsafe = buildStoredCommercialRecommendationEvidenceCandidate({
      candidate: {
        ...safe,
        staticAssessment: {
          ...safe.staticAssessment,
          unsafeOrMalicious: true,
        },
      },
      sourceReleaseId: "commercial-existing:release-1",
    });

    expect(evaluateRecommendationCandidate(uncertain).decision).toBe(
      "insufficient_data",
    );
    expect(evaluateRecommendationCandidate(unsafe)).toMatchObject({
      decision: "excluded",
      gateDecision: {
        hitRules: [expect.objectContaining({ ruleId: "unsafe_or_malicious" })],
      },
    });
  });
});
