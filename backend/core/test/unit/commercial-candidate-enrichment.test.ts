import { describe, expect, it } from "vitest";

import {
  finalizeCommercialCandidateEnrichment,
  selectCommercialCandidateEnrichment,
} from "../../src/modules/backlinks/domain/recommendations/commercial-candidate-enrichment.js";
import {
  evaluateCommercialCandidate,
  type CommercialCandidateBusinessFacts,
  type CommercialCandidateProviderFacts,
} from "../../src/modules/backlinks/domain/recommendations/commercial-candidate-evaluation.js";
import type { CommercialStaticAssessment } from "../../src/modules/backlinks/domain/recommendations/commercial-static-assessment.js";

const business: CommercialCandidateBusinessFacts = Object.freeze({
  selfOrRelatedDomain: false,
  existingBacklinkOrOpportunity: false,
  permanentlyRejectedOrSuppressed: false,
  unsafeOrDisallowedIndustry: false,
  targetCountryCode: "ZA",
  candidateCountryCode: "ZA",
  targetLanguages: ["en-ZA", "en"],
  allowSameLanguageExpansion: false,
  targetMarketScopedDiscovery: true,
});

const provider: CommercialCandidateProviderFacts = Object.freeze({
  rank: 0,
  traffic: 0,
  backlinkCount: null,
  referringDomainCount: null,
  spamScore: 50,
  evidenceRefs: Object.freeze(["dataforseo:discovery:publisher.example"]),
  collectedAt: "2026-08-19T00:00:00.000Z",
});

const assessment: CommercialStaticAssessment = Object.freeze({
  canonicalDomain: "publisher.example",
  decision: "ready",
  language: "en",
  topics: Object.freeze(["film reviews"]),
  matchedProducts: Object.freeze(["streaming entertainment"]),
  matchedTopics: Object.freeze(["film reviews"]),
  matchedKeywords: Object.freeze(["film reviews"]),
  matchedTargetPages: Object.freeze([]),
  matchedAudiences: Object.freeze([]),
  matchedPartnershipGoals: Object.freeze([]),
  relatedContentPages: Object.freeze(["https://publisher.example/reviews"]),
  productRelevance: 0.4,
  editorialQuality: 0.2,
  siteType: "specialist_blog",
  monetizationMethods: Object.freeze([]),
  cooperationPages: Object.freeze([]),
  outboundLinkDensity: 0.8,
  technicalAccessibility: 1,
  unsafeOrMalicious: false,
  highConfidenceLinkFarm: false,
  unrelatedIndustry: false,
  evidenceUrls: Object.freeze(["https://publisher.example/"]),
  evidenceRefs: Object.freeze(["safefetch:publisher.example"]),
  failedUrls: Object.freeze([]),
  collectedAt: "2026-08-19T00:00:00.000Z",
  ruleVersion: "commercial-static-assessment.v3",
});

function candidate(
  hostnameAscii: string,
  overrides: Readonly<{
    business?: CommercialCandidateBusinessFacts;
    provider?: CommercialCandidateProviderFacts;
    assessment?: CommercialStaticAssessment;
  }> = {},
) {
  const facts = Object.freeze({
    business: overrides.business ?? business,
    provider: overrides.provider ?? provider,
    staticAssessment: overrides.assessment ?? assessment,
  });
  return Object.freeze({
    hostnameAscii,
    ...facts,
    commercialScore: evaluateCommercialCandidate(facts),
  });
}

const completeMetrics = Object.freeze({
  trafficOrganicEtv: 100_000,
  spamScore: 2,
  authorityRank: 90,
  trafficState: "completed" as const,
  spamState: "completed" as const,
  rankState: "completed" as const,
  requestFingerprints: Object.freeze({
    traffic: "traffic-fingerprint",
    spam: "spam-fingerprint",
    rank: "rank-fingerprint",
  }),
});

describe("commercial candidate evidence enrichment", () => {
  it("never sends hard-filtered candidates to enrichment", () => {
    const unsafe = candidate("unsafe.example", {
      assessment: Object.freeze({
        ...assessment,
        canonicalDomain: "unsafe.example",
        unsafeOrMalicious: true,
      }),
    });

    const selected = selectCommercialCandidateEnrichment([unsafe], {
      maximumCandidates: 25,
    });

    expect(unsafe.commercialScore.hitGates).toContain("unsafe_or_disallowed");
    expect(selected.candidates).toEqual([]);
    expect(selected.decisions[0]).toMatchObject({
      hostnameAscii: "unsafe.example",
      decision: "excluded",
      hitGates: ["unsafe_or_disallowed"],
      market: expect.objectContaining({
        tier: "target_market",
      }),
    });
  });

  it("selects only bounded near-threshold candidates that can still reach 50", () => {
    const candidates = Array.from({ length: 30 }, (_, index) =>
      candidate(`publisher-${String(index).padStart(2, "0")}.example`));

    const selected = selectCommercialCandidateEnrichment(candidates, {
      maximumCandidates: 7,
    });

    expect(candidates[0]?.commercialScore.total).toBeLessThan(50);
    expect(selected.candidates).toHaveLength(7);
    expect(selected.decisions.filter(({ decision }) =>
      decision === "enrichment_eligible"
    )).toHaveLength(7);
    expect(selected.candidates.every(({ commercialScore }) =>
      commercialScore.decision === "ineligible"
    )).toBe(true);
  });

  it("uses the final V4 decision instead of a stale pre-enrichment exclusion", () => {
    const original = candidate("publisher.example");

    const finalized = finalizeCommercialCandidateEnrichment({
      candidate: original,
      metrics: completeMetrics,
      qualificationDecision: "ineligible",
    });
    const expected = evaluateCommercialCandidate({
      business,
      provider: {
        ...provider,
        rank: completeMetrics.authorityRank,
        traffic: completeMetrics.trafficOrganicEtv,
        spamScore: completeMetrics.spamScore,
        evidenceRefs: [
          ...provider.evidenceRefs,
          ...Object.values(completeMetrics.requestFingerprints),
        ],
      },
      staticAssessment: assessment,
    });

    expect(finalized.commercialScore).toEqual(expected);
    expect(finalized.commercialScore.total).toBeGreaterThanOrEqual(50);
    expect(finalized.state).toBe("candidate_ready");

    const unsafe = finalizeCommercialCandidateEnrichment({
      candidate: candidate("unsafe.example", {
        assessment: Object.freeze({
          ...assessment,
          canonicalDomain: "unsafe.example",
          unsafeOrMalicious: true,
        }),
      }),
      metrics: completeMetrics,
      qualificationDecision: "eligible",
    });

    expect(unsafe.commercialScore.hitGates).toContain(
      "unsafe_or_disallowed",
    );
    expect(unsafe.state).toBe("excluded");

    const unresolvedHardGate = finalizeCommercialCandidateEnrichment({
      candidate: candidate("unresolved.example", {
        assessment: Object.freeze({
          ...assessment,
          canonicalDomain: "unresolved.example",
          siteType: null,
        }),
      }),
      metrics: completeMetrics,
      qualificationDecision: "ineligible",
    });

    expect(unresolvedHardGate.commercialScore.total).toBeGreaterThanOrEqual(50);
    expect(unresolvedHardGate.commercialScore.missingEvidence).toContain(
      "gate.mega_platform_without_placement_evidence",
    );
    expect(unresolvedHardGate.state).toBe("insufficient_data");
  });

  it("keeps complete candidates below 50 and incomplete candidates unpublished", () => {
    const original = candidate("publisher.example");
    const belowThreshold = finalizeCommercialCandidateEnrichment({
      candidate: original,
      metrics: {
        ...completeMetrics,
        trafficOrganicEtv: 0,
        spamScore: 30,
        authorityRank: 10,
      },
      qualificationDecision: "eligible",
    });
    const incomplete = finalizeCommercialCandidateEnrichment({
      candidate: original,
      metrics: {
        ...completeMetrics,
        spamScore: null,
        spamState: "missing",
      },
      qualificationDecision: "insufficient_data",
    });

    expect(belowThreshold.commercialScore.total).toBeLessThan(50);
    expect(belowThreshold.state).not.toBe("candidate_ready");
    expect(incomplete.state).toBe("insufficient_data");
    expect(incomplete.commercialScore.decision).toBe("eligible");
  });

  it("isolates a failed metric record without blocking a complete candidate", () => {
    const complete = finalizeCommercialCandidateEnrichment({
      candidate: candidate("complete.example"),
      metrics: completeMetrics,
      qualificationDecision: "eligible",
    });
    const failed = finalizeCommercialCandidateEnrichment({
      candidate: candidate("failed.example"),
      metrics: {
        ...completeMetrics,
        trafficOrganicEtv: null,
        trafficState: "unavailable",
      },
      qualificationDecision: "insufficient_data",
    });

    expect(complete.state).toBe("candidate_ready");
    expect(failed.state).toBe("insufficient_data");
  });
});
