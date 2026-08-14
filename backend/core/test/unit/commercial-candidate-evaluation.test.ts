import { describe, expect, it } from "vitest";

import { evaluateCommercialCandidate } from "../../src/modules/backlinks/domain/recommendations/commercial-candidate-evaluation.js";
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
  it("produces the deterministic 100-point commercial v3 fit score", () => {
    const result = evaluateCommercialCandidate(base);

    expect(result.decision).toBe("eligible");
    expect(result.total).toBeGreaterThan(0);
    expect(result.components.map(({ weight }) => weight)).toEqual([
      30, 15, 15, 15, 15, 5, 5,
    ]);
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
    expect(result.hitGates).not.toContain("forbidden_market_mismatch");
    expect(result.details.market).toMatchObject({
      candidateCountry: null,
      tier: "target_market",
      reasonCode: "TARGET_MARKET_SCOPED_CANDIDATE",
    });
  });

  it("still rejects an explicit conflicting market without expansion", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      business: {
        ...base.business,
        candidateCountryCode: "GB",
        allowSameLanguageExpansion: false,
      },
    });

    expect(result.decision).toBe("ineligible");
    expect(result.hitGates).toContain("forbidden_market_mismatch");
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
});
