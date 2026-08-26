import { describe, expect, it } from "vitest";

import {
  applyProgressiveCommercialCandidateAdmission,
  evaluateCommercialCandidate,
} from "../../src/modules/backlinks/domain/recommendations/commercial-candidate-evaluation.js";
import type { CommercialStaticAssessment } from "../../src/modules/backlinks/domain/recommendations/commercial-static-assessment.js";

const assessment: CommercialStaticAssessment = {
  canonicalDomain: "publisher.com",
  decision: "ready",
  language: "en",
  topics: ["projector", "streaming"],
  matchedProducts: ["portable projector"],
  matchedTopics: ["projector", "streaming"],
  matchedKeywords: ["home theater"],
  matchedTargetPages: ["https://elephtv.com/portable-projector"],
  matchedAudiences: ["home theater enthusiasts"],
  matchedPartnershipGoals: ["sponsored review"],
  relatedContentPages: ["https://publisher.com/projector-review"],
  productRelevance: 0.8,
  editorialQuality: 0.75,
  siteType: "specialist_blog",
  monetizationMethods: ["advertising"],
  cooperationPages: ["https://publisher.com/advertise"],
  outboundLinkDensity: 0.1,
  technicalAccessibility: 1,
  unsafeOrMalicious: false,
  highConfidenceLinkFarm: false,
  unrelatedIndustry: false,
  evidenceUrls: ["https://publisher.com/"],
  evidenceRefs: ["safefetch:publisher.com"],
  failedUrls: [],
  collectedAt: "2026-08-06T08:00:00.000Z",
  ruleVersion: "commercial-static-assessment.v3",
};

const base = {
  business: {
    selfOrRelatedDomain: false,
    existingBacklinkOrOpportunity: false,
    permanentlyRejectedOrSuppressed: false,
    unsafeOrDisallowedIndustry: false,
    projectAuthorityScore: 20,
    targetCountryCode: "US",
    candidateCountryCode: "US",
    targetLanguages: ["en-US"],
    allowSameLanguageExpansion: true,
    targetMarketScopedDiscovery: true,
  },
  provider: {
    rank: 70,
    traffic: 100_000,
    backlinkCount: 10_000,
    referringDomainCount: 500,
    spamScore: 4,
    evidenceRefs: ["dataforseo:publisher.com"],
    collectedAt: "2026-08-06T08:00:00.000Z",
  },
  staticAssessment: assessment,
} as const;

describe("commercial candidate evaluation", () => {
  it("produces the single deterministic 100-point commercial v4 fit score", () => {
    const result = evaluateCommercialCandidate(base);

    expect(result.decision).toBe("eligible");
    expect(result.scoreModelVersion).toBe("recommendation-commercial-fit.v4");
    expect(result.total).toBeGreaterThan(0);
    expect(result.components.map(({ weight }) => weight)).toEqual([
      30, 25, 20, 15, 5, 5,
    ]);
  });

  it("treats a candidate forty authority points above an emerging project as attainable", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      provider: {
        ...base.provider,
        rank: 60,
        traffic: 25_000,
        backlinkCount: 2_000,
        referringDomainCount: 250,
      },
    });

    expect(result.details.authority).toMatchObject({
      projectAuthority: 20,
      candidateAuthority: expect.any(Number),
      tier: "normal_relative_range",
    });
    expect(result.decision).toBe("eligible");
  });

  it("excludes a mega platform with an extreme authority gap and no page-level placement evidence", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      provider: {
        ...base.provider,
        rank: 100,
        traffic: 100_000_000,
        backlinkCount: 100_000_000,
        referringDomainCount: 10_000_000,
        backlinkPageEvidence: [],
      },
      staticAssessment: {
        ...assessment,
        siteType: "global_platform",
        cooperationPages: [],
        monetizationMethods: [],
        matchedPartnershipGoals: [],
      },
    });

    expect(result.decision).toBe("ineligible");
    expect(result.hitGates).toContain(
      "mega_platform_without_placement_evidence",
    );
  });

  it("allows current page-level placement evidence to override the mega-platform default", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      provider: {
        ...base.provider,
        rank: 100,
        traffic: 100_000_000,
        backlinkCount: 100_000_000,
        referringDomainCount: 10_000_000,
        backlinkPageEvidence: [{
          sourceUrl: "https://platform.example/contribute",
          targetUrl: "https://publisher.com/projector-review",
          anchorText: "contribute",
          linkStatus: "active",
          firstSeenAt: "2026-08-01T00:00:00.000Z",
          lastSeenAt: "2026-08-19T00:00:00.000Z",
          sourceHttpStatus: 200,
          targetHttpStatus: 200,
        }],
      },
      staticAssessment: {
        ...assessment,
        siteType: "global_platform",
        cooperationPages: ["https://platform.example/contribute"],
        relatedContentPages: ["https://platform.example/contribute"],
      },
    });

    expect(result.hitGates).not.toContain(
      "mega_platform_without_placement_evidence",
    );
    expect(result.total).not.toBeNull();
    expect(
      result.components.find(({ id }) => id === "placement_attainability"),
    ).toMatchObject({
      normalizedValue: 1,
      points: 25,
    });
  });

  it("does not let a generic cooperation page override the mega-platform default", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      provider: {
        ...base.provider,
        rank: 100,
        traffic: 100_000_000,
        backlinkCount: 100_000_000,
        referringDomainCount: 10_000_000,
      },
      staticAssessment: {
        ...assessment,
        siteType: "global_platform",
        cooperationPages: ["https://platform.example/partners"],
        relatedContentPages: ["https://platform.example/company-news"],
      },
    });

    expect(result.decision).toBe("ineligible");
    expect(result.hitGates).toContain(
      "mega_platform_without_placement_evidence",
    );
    expect(result.details.reasonCodes).not.toContain(
      "COOPERATION_PATH_AVAILABLE",
    );
  });

  it("does not award high attainability for a generic cooperation navigation page", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      staticAssessment: {
        ...assessment,
        productRelevance: 0.1,
        matchedProducts: [],
        matchedTopics: [],
        matchedKeywords: [],
        relatedContentPages: ["https://publisher.com/company-news"],
        cooperationPages: ["https://publisher.com/advertise"],
      },
    });

    expect(
      result.components.find(({ id }) => id === "placement_attainability"),
    ).toMatchObject({
      normalizedValue: expect.any(Number),
      normalizationRuleVersion: "commercial-placement-attainability.v6",
    });
    expect(
      result.components.find(({ id }) => id === "placement_attainability")
        ?.points ?? 25,
    ).toBeLessThanOrEqual(11.25);
    expect(result.details.reasonCodes).not.toContain(
      "COOPERATION_PATH_AVAILABLE",
    );
    expect(result.details.reasonCodes).toContain(
      "COOPERATION_PATH_REQUIRES_TOPIC_EVIDENCE",
    );
    expect(result.ruleVersion).toBe(
      "recommendation-commercial-fit-rules.v4.2",
    );
    expect(result.decision).toBe("ineligible");
  });

  it("does not treat a weakly related generic cooperation page as project placement evidence", () => {
    const genericPage = "https://platform.example/advertising";
    const result = evaluateCommercialCandidate({
      ...base,
      provider: {
        ...base.provider,
        rank: 100,
        traffic: 100_000_000,
        backlinkCount: 100_000_000,
        referringDomainCount: 10_000_000,
      },
      staticAssessment: {
        ...assessment,
        productRelevance: 0.1,
        matchedProducts: [],
        matchedTopics: ["streaming"],
        matchedKeywords: [],
        siteType: "global_platform",
        cooperationPages: [genericPage],
        relatedContentPages: [genericPage],
      },
    });

    expect(result.decision).toBe("ineligible");
    expect(result.hitGates).toContain(
      "mega_platform_without_placement_evidence",
    );
    expect(
      result.components.find(({ id }) => id === "placement_attainability")
        ?.points ?? 25,
    ).toBeLessThanOrEqual(11.25);
    expect(result.details.reasonCodes).not.toContain(
      "COOPERATION_PATH_AVAILABLE",
    );
    expect(result.details.reasonCodes).toContain(
      "COOPERATION_PATH_REQUIRES_TOPIC_EVIDENCE",
    );
  });

  it("does not treat an unrelated active backlink page as project placement evidence", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      provider: {
        ...base.provider,
        backlinkPageEvidence: [{
          sourceUrl: "https://publisher.com/about/partners",
          targetUrl: "https://unrelated.example/partner",
          anchorText: "partners",
          linkStatus: "active",
          firstSeenAt: "2026-08-01T00:00:00.000Z",
          lastSeenAt: "2026-08-19T00:00:00.000Z",
          sourceHttpStatus: 200,
          targetHttpStatus: 200,
        }],
      },
      staticAssessment: {
        ...assessment,
        cooperationPages: [],
        relatedContentPages: ["https://publisher.com/projector-review"],
      },
    });

    expect(
      result.components.find(({ id }) => id === "placement_attainability")
        ?.points ?? 25,
    ).toBeLessThanOrEqual(11.25);
    expect(result.details.reasonCodes).not.toContain(
      "COOPERATION_PATH_AVAILABLE",
    );
  });

  it("accepts an active backlink source page when that same page is project-relevant", () => {
    const sourceUrl = "https://publisher.com/projector-review";
    const result = evaluateCommercialCandidate({
      ...base,
      provider: {
        ...base.provider,
        backlinkPageEvidence: [{
          sourceUrl,
          targetUrl: "https://industry.example/projector",
          anchorText: "projector review",
          linkStatus: "active",
          firstSeenAt: "2026-08-01T00:00:00.000Z",
          lastSeenAt: "2026-08-19T00:00:00.000Z",
          sourceHttpStatus: 200,
          targetHttpStatus: 200,
        }],
      },
      staticAssessment: {
        ...assessment,
        cooperationPages: [],
        relatedContentPages: [sourceUrl],
      },
    });

    expect(
      result.components.find(({ id }) => id === "placement_attainability"),
    ).toMatchObject({
      normalizedValue: 0.85,
      points: 21.25,
    });
    expect(result.details.reasonCodes).toContain(
      "COOPERATION_PATH_AVAILABLE",
    );
  });

  it("applies business hard gates before scoring", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      business: {
        ...base.business,
        existingBacklinkOrOpportunity: true,
      },
    });

    expect(result.decision).toBe("ineligible");
    expect(result.total).toBeGreaterThan(0);
    expect(result.hitGates).toContain("existing_backlink_or_opportunity");
  });

  it("keeps unknown-country candidates from target-market discovery eligible", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      business: {
        ...base.business,
        candidateCountryCode: null,
        allowSameLanguageExpansion: false,
      },
    });

    expect(result.decision).toBe("eligible");
    expect(result.details.market).toMatchObject({
      candidateCountry: null,
      tier: "target_market",
      reasonCode: "TARGET_MARKET_SCOPED_CANDIDATE",
    });
  });

  it("keeps a same-language country expansion at partial market priority", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      business: {
        ...base.business,
        candidateCountryCode: "GB",
      },
    });

    expect(result.decision).toBe("eligible");
    expect(result.details.market).toMatchObject({
      candidateCountry: "GB",
      tier: "same_language_expansion",
      reasonCode: "SAME_LANGUAGE_EXPANSION",
    });
    expect(
      result.components.find(({ id }) => id === "market_language_tier"),
    ).toMatchObject({
      normalizedValue: 0.75,
      points: 11.25,
    });
  });

  it("keeps a known market mismatch usable but lowers its score", () => {
    const targetMarket = evaluateCommercialCandidate(base);
    const result = evaluateCommercialCandidate({
      ...base,
      business: {
        ...base.business,
        candidateCountryCode: "GB",
        allowSameLanguageExpansion: false,
      },
    });

    expect(result.decision).toBe("eligible");
    expect(result.hitGates).toEqual([]);
    expect(result.details.market).toMatchObject({
      candidateCountry: "GB",
      tier: "market_language_mismatch",
      reasonCode: "MARKET_LANGUAGE_MISMATCH_DEPRIORITIZED",
    });
    expect(
      result.components.find(({ id }) => id === "market_language_tier"),
    ).toMatchObject({
      normalizedValue: 0,
      points: 0,
      normalizationRuleVersion: "commercial-market-language-tier.v2",
    });
    expect(result.total).toBeLessThan(targetMarket.total ?? 0);
  });

  it("does not turn a fetch timeout into zero-valued facts", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      staticAssessment: {
        ...assessment,
        decision: "insufficient_data",
        language: null,
        productRelevance: null,
        editorialQuality: null,
        siteType: null,
        outboundLinkDensity: null,
        technicalAccessibility: null,
        unsafeOrMalicious: null,
        highConfidenceLinkFarm: null,
        evidenceUrls: [],
        evidenceRefs: [],
        failedUrls: ["https://publisher.com/"],
      },
    });

    expect(result.decision).toBe("insufficient_data");
    expect(result.total).toBeNull();
    expect(
      result.components.find(({ id }) => id === "semantic_relevance")?.points,
    ).toBeNull();
  });

  it("keeps ordinary SEO metric gaps scoreable and lowers evidence completeness", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      provider: {
        ...base.provider,
        rank: null,
        traffic: null,
        backlinkCount: null,
        referringDomainCount: null,
      },
    });

    expect(result.decision).not.toBe("insufficient_data");
    expect(result.total).not.toBeNull();
    expect(
      result.components.find(({ id }) => id === "evidence_completeness"),
    ).toMatchObject({
      weight: 5,
      normalizedValue: expect.any(Number),
    });
  });

  it("does not lower the admission threshold to manufacture a candidate", () => {
    const lowFit = evaluateCommercialCandidate({
      ...base,
      provider: {
        ...base.provider,
        rank: 0,
        traffic: 0,
        backlinkCount: 0,
        referringDomainCount: 0,
        spamScore: 50,
      },
      staticAssessment: {
        ...assessment,
        productRelevance: 0.45,
        editorialQuality: 0.2,
        matchedAudiences: [],
        matchedPartnershipGoals: [],
        monetizationMethods: [],
        cooperationPages: [],
        outboundLinkDensity: 0.8,
        technicalAccessibility: 0.8,
      },
    });
    expect(lowFit.decision).toBe("ineligible");

    const batch = applyProgressiveCommercialCandidateAdmission([lowFit]);

    expect(batch.admission).toMatchObject({
      baselineThreshold: 50,
      appliedThreshold: 50,
      fallbackApplied: false,
    });
    expect(batch.scores[0]).toMatchObject({
      decision: "ineligible",
      details: {
        matchTier: "not_eligible",
      },
    });
    expect(batch.scores[0]?.details.reasonCodes).not.toContain(
      "PROGRESSIVE_SCORE_THRESHOLD",
    );
  });

  it("admits a non-safety manual-review assessment when the score qualifies", () => {
    const review = evaluateCommercialCandidate({
      ...base,
      staticAssessment: {
        ...assessment,
        decision: "manual_review",
        matchedAudiences: [],
        matchedPartnershipGoals: [],
      },
    });

    expect(review).toMatchObject({
      decision: "eligible",
      details: {
        matchTier: "qualified_fit",
      },
    });

    const batch = applyProgressiveCommercialCandidateAdmission([review]);
    expect(batch.admission.appliedThreshold).toBe(50);
    expect(batch.scores[0]).toMatchObject({
      decision: "eligible",
      details: {
        matchTier: "qualified_fit",
      },
    });
    expect(batch.scores[0]?.details.reasonCodes).not.toContain(
      "PROGRESSIVE_SCORE_THRESHOLD",
    );
  });
});
