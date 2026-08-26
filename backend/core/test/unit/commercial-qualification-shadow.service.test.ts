import { describe, expect, it, vi } from "vitest";

import {
  persistCommercialQualificationFacts,
  type CommercialQualificationCandidate,
} from "../../src/modules/backlinks/application/services/commercial-qualification.service.js";
import type {
  CommercialQualificationBulkResult,
} from "../../src/modules/backlinks/application/services/commercial-qualification-bulk.service.js";
import {
  commercialFitBaselineAdmissionThreshold,
  commercialFitComponentIds,
  commercialFitProgressiveAdmissionPolicyVersion,
  commercialFitWeights,
  commercialRecommendationFitModelVersion,
  commercialRecommendationFitRuleVersion,
  type CommercialFitHardGateId,
} from "../../src/modules/backlinks/domain/recommendations/commercial-score-v4.js";
import type { CommercialCandidateFitDecision } from "../../src/modules/backlinks/domain/recommendations/commercial-candidate-evaluation.js";

const id = (value: number) =>
  `018f0064-0000-7000-8000-${String(value).padStart(12, "0")}`;

const scope = {
  organizationId: id(1),
  workspaceId: id(2),
  websiteProjectId: id(3),
  recommendationContextVersionId: id(4),
};

function commercialScore(
  input: Readonly<{
    marketTier?:
      | "target_market"
      | "same_language_expansion"
      | "market_language_mismatch";
    decision?: CommercialCandidateFitDecision["decision"];
    total?: number | null;
    appliedThreshold?: number;
    hitGates?: readonly CommercialFitHardGateId[];
  }> = {},
): CommercialCandidateFitDecision {
  const total = input.total ?? 80;
  const appliedThreshold =
    input.appliedThreshold ?? commercialFitBaselineAdmissionThreshold;
  return Object.freeze({
    decision: input.decision ?? "eligible",
    scoreModelVersion: commercialRecommendationFitModelVersion,
    ruleVersion: commercialRecommendationFitRuleVersion,
    total,
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
    hitGates: Object.freeze([...(input.hitGates ?? [])]),
    missingEvidence: Object.freeze([]),
    admission: Object.freeze({
      policyVersion: commercialFitProgressiveAdmissionPolicyVersion,
      baselineThreshold: commercialFitBaselineAdmissionThreshold,
      appliedThreshold,
      fallbackApplied: false,
    }),
    details: Object.freeze({
      matchTier: "high_fit" as const,
      reasonCodes: Object.freeze(["PRODUCT_MATCH", "TOPIC_MATCH"]),
      matchedProducts: Object.freeze(["streaming"]),
      matchedTopics: Object.freeze(["film reviews"]),
      matchedKeywords: Object.freeze(["streaming service"]),
      matchedTargetPages: Object.freeze(["https://owner.test/"]),
      matchedAudiences: Object.freeze(["viewers"]),
      market: Object.freeze({
        targetCountry: "ZA",
        candidateCountry: "ZA",
        targetLanguage: "en",
        candidateLanguage: "en",
        tier: input.marketTier ?? "target_market",
        reasonCode: "TARGET_MARKET_MATCH",
      }),
      cooperationAngles: Object.freeze(["editorial review"]),
      authority: Object.freeze({
        projectAuthority: 20,
        candidateAuthority: 70,
        confidence: "observed" as const,
        tier: "elevated_authority_gap" as const,
      }),
      dataForSeo: Object.freeze({
        rank: 70,
        traffic: 40_000,
        backlinks: 1_000,
        referringDomains: 300,
        spamScore: 4,
        backlinkPageEvidence: Object.freeze([]),
        evidenceRefs: Object.freeze(["fixture:provider"]),
        collectedAt: "2026-08-17T03:00:00.000Z",
      }),
      safeFetch: Object.freeze({
        relatedContentPages: Object.freeze(["https://publisher.com/reviews"]),
        evidenceUrls: Object.freeze(["https://publisher.com/"]),
        evidenceRefs: Object.freeze(["fixture:safefetch"]),
        failedUrls: Object.freeze([]),
        technicalAccessibility: 1,
      }),
    }),
  });
}

function candidate(
  input: Partial<CommercialQualificationCandidate> = {},
): CommercialQualificationCandidate {
  return {
    candidateId: id(10),
    canonicalDomain: "publisher.com",
    attempt: 1,
    commercialScore: commercialScore(),
    accessibility: {
      decision: "accessible",
      attempt: 1,
      evidence: { finalUrl: "https://publisher.com/" },
    },
    semantic: {
      productRelevance: 100,
      topicRelevance: 100,
      keywordRelevance: 100,
      unrelated: false,
      attempt: 1,
      state: "observed",
      modelVersion: "semantic-model-v1",
      promptVersion: "semantic-prompt-v1",
      evidence: { artifactRef: "artifact://semantic/1" },
    },
    evidenceRefs: ["artifact://provider/bulk-1"],
    ...input,
  };
}

function metrics(
  input: Partial<CommercialQualificationBulkResult> = {},
): CommercialQualificationBulkResult {
  return {
    state: "completed",
    metricScope: "TARGET_MARKET",
    records: [{
      canonicalDomain: "publisher.com",
      trafficOrganicEtv: 30_000,
      spamScore: 10,
      authorityRank: 70,
      trafficState: "completed",
      spamState: "completed",
      rankState: "completed",
      requestFingerprints: {
        traffic: "traffic-fingerprint",
        spam: "spam-fingerprint",
        rank: "rank-fingerprint",
      },
    }],
    callCount: 3,
    costMicros: 3_000,
    ...input,
  };
}

describe("commercial qualification service", () => {
  it("persists the authoritative V4 fact from one supplied metric artifact", async () => {
    const writeQualificationFact = vi.fn(async () => undefined);
    const result = await persistCommercialQualificationFacts({
      scope,
      generationContractId: id(5),
      sourceKind: "WEBSITE_PROJECT",
      candidates: [candidate()],
      metrics: metrics(),
      repository: { writeQualificationFact },
      observedAt: new Date("2026-08-16T03:00:00.000Z"),
      createdBy: "phase-4-test",
      newId: () => id(20),
    });

    expect(result).toMatchObject({
      mode: "authoritative",
      metricCollectionState: "completed",
      persistedCount: 1,
      ranked: [{
        canonicalDomain: "publisher.com",
        decision: "eligible",
        decisionReasonCode: "COMMERCIAL_FIT_V4_ELIGIBLE",
      }],
    });
    expect(writeQualificationFact).toHaveBeenCalledOnce();
    expect(writeQualificationFact).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: id(10),
        canonicalDomain: "publisher.com",
        qualification: expect.objectContaining({
          factId: id(20),
          trafficOrganicEtv: 30_000,
          spamScore: 10,
          authorityRank: 70,
          decision: "eligible",
          requestFingerprints: {
            traffic: "traffic-fingerprint",
            spam: "spam-fingerprint",
            rank: "rank-fingerprint",
          },
          evidence: expect.objectContaining({
            mode: "authoritative",
            sourceKind: "WEBSITE_PROJECT",
            freshMetricsRole: "qualification_authority",
            qualificationPolicy: expect.objectContaining({
              trafficIsRankingOnly: true,
              spamReviewMinimum: 30,
              spamHardRejectMinimum: 70,
              finalAdmissionThreshold: 50,
              partialEvidenceAllowed: true,
              decision: "eligible",
            }),
            screeningPolicy: expect.objectContaining({
              ruleVersion: commercialRecommendationFitRuleVersion,
              sourceDecision: "eligible",
              total: 80,
            }),
          }),
        }),
      }),
    );
  });

  it.each(["WEBSITE_PROJECT", "RESOURCE_LIBRARY"] as const)(
    "applies identical qualification rules to %s",
    async (sourceKind) => {
      const writes: unknown[] = [];
      const result = await persistCommercialQualificationFacts({
        scope,
        generationContractId: id(5),
        sourceKind,
        candidates: [candidate()],
        metrics: metrics(),
        repository: {
          writeQualificationFact: async (write) => {
            writes.push(write.qualification.decision);
          },
        },
        createdBy: "phase-4-test",
        newId: () => id(21),
      });
      expect(result.ranked[0]?.decision).toBe("eligible");
      expect(writes).toEqual(["eligible"]);
    },
  );

  it("persists a market mismatch as eligible but deprioritized", async () => {
    const writeQualificationFact = vi.fn(async () => undefined);
    const result = await persistCommercialQualificationFacts({
      scope,
      generationContractId: id(5),
      sourceKind: "RESOURCE_LIBRARY",
      candidates: [candidate({
        commercialScore: commercialScore({
          marketTier: "same_language_expansion",
        }),
      })],
      metrics: metrics(),
      repository: { writeQualificationFact },
      createdBy: "phase-4-test",
      newId: () => id(23),
    });

    expect(result.ranked[0]).toMatchObject({
      decision: "eligible",
      decisionReasonCode: "COMMERCIAL_FIT_V4_ELIGIBLE",
      marketDecision: "mismatch",
    });
    expect(writeQualificationFact.mock.calls[0]?.[0].qualification)
      .toMatchObject({
        decision: "eligible",
        evidence: expect.objectContaining({
          screeningPolicy: expect.objectContaining({
            marketTier: "same_language_expansion",
          }),
        }),
      });
  });

  it("keeps weak authoritative traffic as a ranking signal", async () => {
    const writeQualificationFact = vi.fn(async () => undefined);
    const [availableRecord] = metrics().records;
    if (availableRecord === undefined) {
      throw new Error("Expected qualification metric fixture");
    }
    const result = await persistCommercialQualificationFacts({
      scope,
      generationContractId: id(5),
      sourceKind: "WEBSITE_PROJECT",
      candidates: [candidate()],
      metrics: metrics({
        records: [{
          ...availableRecord,
          trafficOrganicEtv: 250,
          spamScore: 10,
          authorityRank: 5,
        }],
      }),
      repository: { writeQualificationFact },
      createdBy: "phase-4-test",
      newId: () => id(24),
    });

    expect(result.ranked[0]).toMatchObject({
      decision: "eligible",
      decisionReasonCode: "COMMERCIAL_FIT_V4_ELIGIBLE",
      trafficOrganicEtv: 250,
      spamScore: 10,
    });
    expect(writeQualificationFact.mock.calls[0]?.[0].qualification)
      .toMatchObject({
        decision: "eligible",
        trafficOrganicEtv: 250,
        spamScore: 10,
        evidence: expect.objectContaining({
          freshMetricsRole: "qualification_authority",
          freshMetrics: expect.objectContaining({
            trafficOrganicEtv: 250,
            spamScore: 10,
          }),
        }),
      });
  });

  it("persists ambiguous provider evidence as insufficient data", async () => {
    const writeQualificationFact = vi.fn(async () => undefined);
    const [availableRecord] = metrics().records;
    if (availableRecord === undefined) {
      throw new Error("Expected qualification metric fixture");
    }
    const unavailableMetrics = metrics({
      state: "unknown_charge",
      records: [{
        ...availableRecord,
        trafficOrganicEtv: null,
        trafficState: "unknown_charge",
      }],
    });

    const result = await persistCommercialQualificationFacts({
      scope,
      generationContractId: id(5),
      sourceKind: "WEBSITE_PROJECT",
      candidates: [candidate()],
      metrics: unavailableMetrics,
      repository: { writeQualificationFact },
      createdBy: "phase-4-test",
      newId: () => id(22),
    });

    expect(result.ranked[0]).toMatchObject({
      decision: "insufficient_data",
      decisionReasonCode: "DATAFORSEO_QUALIFICATION_UNKNOWN_CHARGE",
    });
    expect(writeQualificationFact.mock.calls[0]?.[0].qualification)
      .toMatchObject({
        decision: "insufficient_data",
        evidence: expect.objectContaining({
          metricCollectionState: "unknown_charge",
          freshMetrics: expect.objectContaining({
            states: expect.objectContaining({
              traffic: "unknown_charge",
            }),
          }),
        }),
      });
  });

  it("fails closed when the shared metric artifact lacks a candidate", async () => {
    const writeQualificationFact = vi.fn();
    await expect(persistCommercialQualificationFacts({
      scope,
      generationContractId: id(5),
      sourceKind: "WEBSITE_PROJECT",
      candidates: [candidate({ canonicalDomain: "missing.com" })],
      metrics: metrics(),
      repository: { writeQualificationFact },
      createdBy: "phase-4-test",
    })).rejects.toThrow("metrics are missing");
    expect(writeQualificationFact).not.toHaveBeenCalled();
  });
});
