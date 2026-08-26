import { describe, expect, it, vi } from "vitest";

import {
  executeCommercialQualificationProduction,
  type CommercialQualificationProductionCandidate,
} from "../../src/modules/backlinks/application/services/commercial-qualification-production.service.js";
import type {
  CommercialQualificationBulkCall,
  CommercialQualificationBulkResponse,
} from "../../src/modules/backlinks/application/services/commercial-qualification-bulk.service.js";
import {
  commercialFitBaselineAdmissionThreshold,
  commercialFitComponentIds,
  commercialFitProgressiveAdmissionPolicyVersion,
  commercialFitWeights,
  commercialRecommendationFitModelVersion,
  commercialRecommendationFitRuleVersion,
} from "../../src/modules/backlinks/domain/recommendations/commercial-score-v4.js";
import type { GenerationInputBinding } from "../../src/modules/backlinks/ports/shared-seo-evidence.port.js";
import {
  CORRECTED_QUALIFICATION_CONTRACT_VERSION,
  type RecommendationContractPort,
} from "../../src/modules/backlinks/ports/recommendation-contract.port.js";

const scope = Object.freeze({
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  websiteProjectId: "33333333-3333-4333-8333-333333333333",
  recommendationContextVersionId: "44444444-4444-4444-8444-444444444444",
});
const profileVersionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const promotionTargetVersionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const context = Object.freeze({
  snapshotVersion: 3,
  profileVersionId,
  promotionTargetVersionId,
  projectSettingsVersionId: "55555555-5555-4555-8555-555555555555",
  canonicalDomain: "elephtv.com",
  locale: "en",
  countryCode: "ZA",
  products: Object.freeze(["streaming", "film"]),
  keywords: Object.freeze(["streaming service in sa", "eleph tv"]),
  targetUrls: Object.freeze(["https://elephtv.com/"]),
  targetAudiences: Object.freeze(["South Africans"]),
  partnershipGoals: Object.freeze([
    "Authoritative film and television review backlinks",
  ]),
});
const inputBinding: GenerationInputBinding = Object.freeze({
  inputPinId: "99999999-9999-4999-8999-999999999999",
  outreachProfileRecordId: "88888888-8888-4888-8888-888888888888",
  immutableFingerprint: "fixture-binding",
  pins: Object.freeze({
    organizationId: scope.organizationId,
    websiteProjectId: scope.websiteProjectId,
    projectContextVersion: context.snapshotVersion,
    siteProfileVersionId: profileVersionId,
    outreachProfileVersionId: profileVersionId,
    promotionTargetVersionId,
    keywordEvidenceSnapshotIds: Object.freeze([]),
    sharedEvidenceSnapshotIds: Object.freeze([]),
    market: context.countryCode,
    qualificationContractVersion: CORRECTED_QUALIFICATION_CONTRACT_VERSION,
  }),
  outreachProfile: Object.freeze({
    organizationId: scope.organizationId,
    websiteProjectId: scope.websiteProjectId,
    profileVersionId,
    promotionTargetVersionId,
    keywordsAndTopics: context.keywords,
    productsAndServices: context.products,
    targetUrls: context.targetUrls,
    targetAudiences: context.targetAudiences,
    partnershipGoals: context.partnershipGoals,
    market: context.countryCode,
    location: context.countryCode,
    language: context.locale,
    authorizedDiscoverySources: Object.freeze([
      "WEBSITE_PROJECT",
      "CURATED_RESOURCE_LIBRARY",
    ]),
    immutableFingerprint: "fixture-profile",
  }),
  sharedEvidence: Object.freeze([]),
});

function candidate(
  domain: string,
  sourceTypes: readonly (
    | "CURATED_RESOURCE_LIBRARY"
    | "BLUEPRINT_SERP_STANDARD_QUEUE"
  )[],
  marketTier: CommercialQualificationProductionCandidate[
    "commercialScore"
  ]["details"]["market"]["tier"] = "target_market",
): CommercialQualificationProductionCandidate {
  return Object.freeze({
    candidateId: domain === "reviews-example.com"
      ? "66666666-6666-4666-8666-666666666666"
      : "77777777-7777-4777-8777-777777777777",
    hostnameAscii: domain,
    sourceTypes,
    provider: Object.freeze({
      rank: 70,
      traffic: 40_000,
      backlinkCount: 1_000,
      referringDomainCount: 300,
      spamScore: 4,
      countryCode: "ZA",
      backlinkPageEvidence: Object.freeze([]),
      evidenceRefs: Object.freeze([`provider:${domain}`]),
      collectedAt: "2026-08-17T03:00:00.000Z",
    }),
    staticAssessment: Object.freeze({
      canonicalDomain: domain,
      decision: "ready" as const,
      language: "en",
      topics: Object.freeze(["film"]),
      matchedProducts: Object.freeze(["streaming", "film"]),
      matchedTopics: Object.freeze(["film reviews"]),
      matchedKeywords: Object.freeze([
        "streaming service in sa",
        "eleph tv",
      ]),
      matchedTargetPages: Object.freeze(["https://elephtv.com/"]),
      matchedAudiences: Object.freeze(["South Africans"]),
      matchedPartnershipGoals: Object.freeze([
        "Authoritative film and television review backlinks",
      ]),
      relatedContentPages: Object.freeze([`https://${domain}/reviews`]),
      productRelevance: 1,
      editorialQuality: 1,
      siteType: "review",
      monetizationMethods: Object.freeze([]),
      cooperationPages: Object.freeze([]),
      outboundLinkDensity: 0.1,
      technicalAccessibility: 1,
      unsafeOrMalicious: false,
      highConfidenceLinkFarm: false,
      unrelatedIndustry: false,
      evidenceUrls: Object.freeze([`https://${domain}/`]),
      evidenceRefs: Object.freeze([`static:${domain}`]),
      failedUrls: Object.freeze([]),
      collectedAt: "2026-08-17T03:00:00.000Z",
      ruleVersion: "commercial-static-assessment.v3" as const,
    }),
    commercialScore: Object.freeze({
      decision: "eligible" as const,
      scoreModelVersion: commercialRecommendationFitModelVersion,
      ruleVersion: commercialRecommendationFitRuleVersion,
      total: 80,
      components: Object.freeze(
        commercialFitComponentIds.map((componentId) => Object.freeze({
          id: componentId,
          state: "derived" as const,
          rawValue: 0.8,
          normalizedValue: 0.8,
          weight: commercialFitWeights[componentId],
          points: commercialFitWeights[componentId] * 0.8,
          evidenceRefs: Object.freeze([`fixture:${componentId}`]),
          normalizationRuleVersion: `fixture-${componentId}.v1`,
          collectedAt: "2026-08-17T03:00:00.000Z",
        })),
      ),
      hitGates: Object.freeze([]),
      missingEvidence: Object.freeze([]),
      admission: Object.freeze({
        policyVersion: commercialFitProgressiveAdmissionPolicyVersion,
        baselineThreshold: commercialFitBaselineAdmissionThreshold,
        appliedThreshold: commercialFitBaselineAdmissionThreshold,
        fallbackApplied: false,
      }),
      details: Object.freeze({
        matchTier: "high_fit" as const,
        reasonCodes: Object.freeze([]),
        matchedProducts: Object.freeze(["streaming", "film"]),
        matchedTopics: Object.freeze(["film reviews"]),
        matchedKeywords: Object.freeze([
          "streaming service in sa",
          "eleph tv",
        ]),
        matchedTargetPages: Object.freeze(["https://elephtv.com/"]),
        matchedAudiences: Object.freeze(["South Africans"]),
        market: Object.freeze({
          targetCountry: "ZA",
          candidateCountry: "ZA",
          targetLanguage: "en",
          candidateLanguage: "en",
          tier: marketTier,
          reasonCode: "TARGET_MARKET",
        }),
        cooperationAngles: Object.freeze([]),
        dataForSeo: Object.freeze({
          rank: 70,
          traffic: 40_000,
          backlinks: 1_000,
          referringDomains: 300,
          spamScore: 4,
          backlinkPageEvidence: Object.freeze([]),
          evidenceRefs: Object.freeze([`provider:${domain}`]),
          collectedAt: "2026-08-17T03:00:00.000Z",
        }),
        safeFetch: Object.freeze({
          relatedContentPages: Object.freeze([`https://${domain}/reviews`]),
          evidenceUrls: Object.freeze([`https://${domain}/`]),
          evidenceRefs: Object.freeze([`static:${domain}`]),
          failedUrls: Object.freeze([]),
          technicalAccessibility: 1,
        }),
      }),
    }),
  });
}

function repositories() {
  const recommendationRepository = {
    assertCorrectedGenerationAvailable: vi.fn(async () => undefined),
    createCorrectedGeneration: vi.fn(async () => undefined),
    writeQualificationFact: vi.fn(async () => undefined),
  } satisfies Pick<
    RecommendationContractPort,
    | "assertCorrectedGenerationAvailable"
    | "createCorrectedGeneration"
    | "writeQualificationFact"
  >;
  return { recommendationRepository };
}

function providerBody(
  call: CommercialQualificationBulkCall,
): unknown {
  const items = call.targets.map((target) => call.kind === "traffic"
    ? { target, metrics: { organic: { etv: 40_000 } } }
    : call.kind === "spam"
      ? { target, spam_score: 4 }
      : { target, rank: 70 });
  return { tasks: [{ result: [{ items }] }] };
}

describe("commercial qualification production", () => {
  it("persists already-publishable partial evidence without provider calls", async () => {
    const repos = repositories();
    const execute = vi.fn();
    const base = candidate(
      "reviews-example.com",
      ["BLUEPRINT_SERP_STANDARD_QUEUE"],
    );
    const partialEvidenceCandidate = Object.freeze({
      ...base,
      provider: Object.freeze({
        ...base.provider,
        traffic: null,
      }),
      commercialScore: Object.freeze({
        ...base.commercialScore,
        total: 52.5,
        missingEvidence: Object.freeze(["dataforseo.traffic"]),
      }),
    });

    const result = await executeCommercialQualificationProduction({
      scope,
      context,
      inputBinding,
      topics: ["film reviews"],
      candidates: [partialEvidenceCandidate],
      visiblePoolGeneration: 1,
      locationCode: 2710,
      languageCode: "en",
      endpointAllowlist: [],
      metricCollectionMode: "existing_evidence",
      metricRuntime: { execute },
      ...repos,
      createdBy: "stage2r-test",
      observedAt: new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      state: "partial",
      candidateCount: 1,
      persistedCount: 1,
      callCount: 0,
      costMicros: 0,
      qualifications: [
        expect.objectContaining({
          hostnameAscii: "reviews-example.com",
          decision: "eligible",
          decisionReasonCode:
            "COMMERCIAL_FIT_V4_ELIGIBLE_PARTIAL_EVIDENCE",
          trafficOrganicEtv: null,
          spamScore: 4,
          authorityRank: 70,
          trafficState: "missing",
          spamState: "completed",
          rankState: "completed",
        }),
      ],
    });
    expect(
      repos.recommendationRepository.createCorrectedGeneration,
    ).toHaveBeenCalledWith(expect.objectContaining({
      requestFingerprints: {},
      operation: expect.objectContaining({
        operationId: "commercial-qualification-v4-existing-evidence:1",
        state: "succeeded",
        reasonCode: "QUALIFICATION_PARTIAL",
        evidence: expect.objectContaining({
          metricCollectionMode: "existing_evidence",
          callCount: 0,
          costMicros: 0,
        }),
      }),
    }));
    expect(
      repos.recommendationRepository.writeQualificationFact,
    ).toHaveBeenCalledWith(expect.objectContaining({
      qualification: expect.objectContaining({
        decision: "eligible",
        decisionReasonCode:
          "COMMERCIAL_FIT_V4_ELIGIBLE_PARTIAL_EVIDENCE",
        evidence: expect.objectContaining({
          freshMetricsRole: "evidence_only",
        }),
      }),
    }));
  });

  it("keeps qualification fact ids stable for retries and changes them for new conclusions", async () => {
    const repos = repositories();
    const execute = vi.fn();
    const original = candidate(
      "reviews-example.com",
      ["BLUEPRINT_SERP_STANDARD_QUEUE"],
    );
    const run = (
      qualificationCandidate: CommercialQualificationProductionCandidate,
    ) =>
      executeCommercialQualificationProduction({
        scope,
        context,
        inputBinding,
        topics: ["film reviews"],
        candidates: [qualificationCandidate],
        visiblePoolGeneration: 1,
        locationCode: 2710,
        languageCode: "en",
        endpointAllowlist: [],
        metricCollectionMode: "existing_evidence",
        metricRuntime: { execute },
        ...repos,
        createdBy: "stage2r-test",
        observedAt: new Date("2026-08-20T00:00:00.000Z"),
      });

    await run(original);
    await run(original);
    await run(Object.freeze({
      ...original,
      commercialScore: Object.freeze({
        ...original.commercialScore,
        total: 53.5,
      }),
    }));

    const factIds = repos.recommendationRepository.writeQualificationFact
      .mock.calls.map(([input]) => input.qualification.factId);
    expect(factIds[0]).toBe(factIds[1]);
    expect(factIds[2]).not.toBe(factIds[0]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects non-publishable candidates from the zero-cost evidence path", async () => {
    const repos = repositories();
    const execute = vi.fn();
    const base = candidate(
      "reviews-example.com",
      ["BLUEPRINT_SERP_STANDARD_QUEUE"],
    );
    const belowThreshold = Object.freeze({
      ...base,
      commercialScore: Object.freeze({
        ...base.commercialScore,
        decision: "ineligible" as const,
        total: 49.9,
      }),
    });

    await expect(executeCommercialQualificationProduction({
      scope,
      context,
      inputBinding,
      topics: ["film reviews"],
      candidates: [belowThreshold],
      visiblePoolGeneration: 1,
      locationCode: 2710,
      languageCode: "en",
      endpointAllowlist: [],
      metricCollectionMode: "existing_evidence",
      metricRuntime: { execute },
      ...repos,
      createdBy: "stage2r-test",
    })).rejects.toThrow(
      "Existing-evidence qualification requires an already publishable candidate.",
    );

    expect(execute).not.toHaveBeenCalled();
    expect(
      repos.recommendationRepository.createCorrectedGeneration,
    ).not.toHaveBeenCalled();
    expect(
      repos.recommendationRepository.writeQualificationFact,
    ).not.toHaveBeenCalled();
  });

  it("freezes with zero paid calls when candidate supply is empty", async () => {
    const repos = repositories();
    const execute = vi.fn<
      (call: CommercialQualificationBulkCall) =>
        Promise<CommercialQualificationBulkResponse>
    >();
    const result = await executeCommercialQualificationProduction({
      scope,
      context,
      inputBinding,
      topics: ["film reviews"],
      candidates: [],
      visiblePoolGeneration: 1,
      locationCode: 2710,
      languageCode: "en",
      endpointAllowlist: [
        "/v3/dataforseo_labs/google/bulk_traffic_estimation/live",
        "/v3/backlinks/bulk_spam_score/live",
        "/v3/backlinks/bulk_ranks/live",
      ],
      metricRuntime: { execute },
      ...repos,
      createdBy: "phase-4-test",
      observedAt: new Date("2026-08-17T03:00:00.000Z"),
    });

    expect(result).toMatchObject({
      state: "candidate_supply_required",
      candidateCount: 0,
      persistedCount: 0,
      callCount: 0,
      costMicros: 0,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(
      repos.recommendationRepository.createCorrectedGeneration,
    ).toHaveBeenCalledWith(expect.objectContaining({
      requestFingerprints: {},
      operation: expect.objectContaining({
        state: "frozen",
        reasonCode: "CANDIDATE_SUPPLY_REQUIRED",
      }),
    }));
  });

  it("uses three sequential bulk calls and reuses metrics for both sources", async () => {
    const repos = repositories();
    const observedKinds: string[] = [];
    const execute = vi.fn(async (call: CommercialQualificationBulkCall) => {
      observedKinds.push(call.kind);
      return Object.freeze({
        status: "completed" as const,
        body: providerBody(call),
        providerRequestId: `provider-${call.kind}`,
        costMicros: 20_000,
      });
    });
    const result = await executeCommercialQualificationProduction({
      scope,
      context,
      inputBinding,
      topics: ["film reviews"],
      candidates: [
        candidate("reviews-example.com", ["BLUEPRINT_SERP_STANDARD_QUEUE"]),
        candidate(
          "library-example.com",
          ["CURATED_RESOURCE_LIBRARY"],
          "same_language_expansion",
        ),
      ],
      visiblePoolGeneration: 2,
      locationCode: 2710,
      languageCode: "en",
      endpointAllowlist: [
        "/v3/dataforseo_labs/google/bulk_traffic_estimation/live",
        "/v3/backlinks/bulk_spam_score/live",
        "/v3/backlinks/bulk_ranks/live",
      ],
      metricRuntime: { execute },
      ...repos,
      createdBy: "phase-4-test",
      observedAt: new Date("2026-08-17T03:00:00.000Z"),
    });

    expect(observedKinds).toEqual(["traffic", "spam", "rank"]);
    expect(result).toMatchObject({
      state: "completed",
      candidateCount: 2,
      persistedCount: 2,
      websiteProjectCount: 1,
      resourceLibraryCount: 1,
      callCount: 3,
      costMicros: 60_000,
      qualifications: expect.arrayContaining([
        expect.objectContaining({
          hostnameAscii: "reviews-example.com",
          decision: "eligible",
          trafficOrganicEtv: 40_000,
          spamScore: 4,
          authorityRank: 70,
          trafficState: "completed",
          spamState: "completed",
          rankState: "completed",
          requestFingerprints: expect.objectContaining({
            traffic: expect.any(String),
            spam: expect.any(String),
            rank: expect.any(String),
          }),
        }),
      ]),
    });
    expect(
      repos.recommendationRepository.writeQualificationFact,
    ).toHaveBeenCalledTimes(2);
    const facts = repos.recommendationRepository
      .writeQualificationFact.mock.calls.map(([input]) => input);
    expect(facts[0]?.qualification.requestFingerprints).toEqual(
      facts[1]?.qualification.requestFingerprints,
    );
    expect(
      facts.find(({ candidateId }) =>
        candidateId === "77777777-7777-4777-8777-777777777777"
      )?.qualification,
    ).toMatchObject({
      decision: "eligible",
      decisionReasonCode: "COMMERCIAL_FIT_V4_ELIGIBLE",
      evidence: {
        freshMetricsRole: "qualification_authority",
        screeningPolicy: expect.objectContaining({
          marketTier: "same_language_expansion",
        }),
      },
    });
  });

  it("rejects an incompatible generation before provider execution", async () => {
    const repos = repositories();
    repos.recommendationRepository.assertCorrectedGenerationAvailable
      .mockRejectedValueOnce(
        new Error(
          "Corrected recommendation generation contract is incompatible.",
        ),
      );
    const execute = vi.fn();

    await expect(executeCommercialQualificationProduction({
      scope,
      context,
      inputBinding,
      topics: ["film reviews"],
      candidates: [
        candidate("reviews-example.com", ["BLUEPRINT_SERP_STANDARD_QUEUE"]),
      ],
      visiblePoolGeneration: 1,
      locationCode: 2710,
      languageCode: "en",
      endpointAllowlist: [
        "/v3/dataforseo_labs/google/bulk_traffic_estimation/live",
        "/v3/backlinks/bulk_spam_score/live",
        "/v3/backlinks/bulk_ranks/live",
      ],
      metricRuntime: { execute },
      ...repos,
      createdBy: "phase-10-test",
    })).rejects.toThrow(
      "Corrected recommendation generation contract is incompatible.",
    );

    expect(execute).not.toHaveBeenCalled();
    expect(
      repos.recommendationRepository.createCorrectedGeneration,
    ).not.toHaveBeenCalled();
    expect(
      repos.recommendationRepository.writeQualificationFact,
    ).not.toHaveBeenCalled();
  });

  it("stops after the first unknown charge response", async () => {
    const repos = repositories();
    const execute = vi.fn(async () => Object.freeze({
      status: "unknown_charge" as const,
      body: null,
      providerRequestId: null,
      costMicros: 0,
    }));
    const result = await executeCommercialQualificationProduction({
      scope,
      context,
      inputBinding,
      topics: ["film reviews"],
      candidates: [
        candidate("reviews-example.com", ["BLUEPRINT_SERP_STANDARD_QUEUE"]),
      ],
      visiblePoolGeneration: 3,
      locationCode: 2710,
      languageCode: "en",
      endpointAllowlist: [
        "/v3/dataforseo_labs/google/bulk_traffic_estimation/live",
        "/v3/backlinks/bulk_spam_score/live",
        "/v3/backlinks/bulk_ranks/live",
      ],
      metricRuntime: { execute },
      ...repos,
      createdBy: "phase-4-test",
      observedAt: new Date("2026-08-17T03:00:00.000Z"),
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      state: "unknown_charge",
      callCount: 1,
    });
    expect(
      repos.recommendationRepository.createCorrectedGeneration,
    ).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({
        state: "frozen",
        reasonCode: "DATAFORSEO_QUALIFICATION_UNKNOWN_CHARGE",
      }),
    }));
  });

  it("persists an unavailable shadow result without blocking candidates", async () => {
    const repos = repositories();
    const execute = vi.fn(async () => Object.freeze({
      status: "unavailable" as const,
      body: null,
      providerRequestId: null,
      costMicros: 0,
    }));
    const result = await executeCommercialQualificationProduction({
      scope,
      context,
      inputBinding,
      topics: ["film reviews"],
      candidates: [
        candidate("reviews-example.com", ["BLUEPRINT_SERP_STANDARD_QUEUE"]),
      ],
      visiblePoolGeneration: 4,
      locationCode: 2710,
      languageCode: "en",
      endpointAllowlist: [
        "/v3/dataforseo_labs/google/bulk_traffic_estimation/live",
        "/v3/backlinks/bulk_spam_score/live",
        "/v3/backlinks/bulk_ranks/live",
      ],
      metricRuntime: { execute },
      ...repos,
      createdBy: "phase-4-test",
      observedAt: new Date("2026-08-17T03:00:00.000Z"),
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      state: "unavailable",
      candidateCount: 1,
      persistedCount: 1,
      callCount: 1,
      costMicros: 0,
    });
    expect(
      repos.recommendationRepository.createCorrectedGeneration,
    ).toHaveBeenCalledWith(expect.objectContaining({
      operation: expect.objectContaining({
        state: "failed",
        reasonCode: "DATAFORSEO_QUALIFICATION_UNAVAILABLE",
      }),
    }));
    expect(
      repos.recommendationRepository.writeQualificationFact,
    ).toHaveBeenCalledWith(expect.objectContaining({
      qualification: expect.objectContaining({
        decision: "eligible",
        decisionReasonCode: "COMMERCIAL_FIT_V4_ELIGIBLE",
      }),
    }));
  });

  it("rejects more than 25 domains before persistence or provider work", async () => {
    const repos = repositories();
    const execute = vi.fn();
    await expect(executeCommercialQualificationProduction({
      scope,
      context,
      inputBinding,
      topics: ["film reviews"],
      candidates: Array.from({ length: 26 }, (_, index) =>
        candidate(`review-${index}.com`, ["BLUEPRINT_SERP_STANDARD_QUEUE"])),
      visiblePoolGeneration: 4,
      locationCode: 2710,
      languageCode: "en",
      endpointAllowlist: [],
      metricRuntime: { execute },
      ...repos,
      createdBy: "phase-4-test",
    })).rejects.toThrow("at most 25");

    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps operation facts stable for retries and distinct across collection modes", async () => {
    const repos = repositories();
    const execute = vi.fn<
      (call: CommercialQualificationBulkCall) =>
        Promise<CommercialQualificationBulkResponse>
    >();
    const run = (
      metricCollectionMode: "provider" | "existing_evidence",
    ) =>
      executeCommercialQualificationProduction({
        scope,
        context,
        inputBinding,
        topics: ["film reviews"],
        candidates: [],
        visiblePoolGeneration: 1,
        locationCode: 2710,
        languageCode: "en",
        endpointAllowlist: [],
        metricCollectionMode,
        metricRuntime: { execute },
        ...repos,
        createdBy: "phase-4-test",
        observedAt: new Date("2026-08-17T03:00:00.000Z"),
      });

    await run("provider");
    await run("provider");
    await run("existing_evidence");

    const operations = repos.recommendationRepository
      .createCorrectedGeneration.mock.calls
      .map(([input]) => input.operation);
    expect(operations[0]?.factId).toBe(operations[1]?.factId);
    expect(operations[2]?.factId).not.toBe(operations[0]?.factId);
    expect(operations.map(({ operationId }) => operationId)).toEqual([
      "commercial-qualification-v4:1",
      "commercial-qualification-v4:1",
      "commercial-qualification-v4-existing-evidence:1",
    ]);
    expect(execute).not.toHaveBeenCalled();
  });
});
