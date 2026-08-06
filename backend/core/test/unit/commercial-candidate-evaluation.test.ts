import { describe, expect, it } from "vitest";

import {
  evaluateCommercialCandidate,
} from "../../src/modules/backlinks/domain/recommendations/commercial-candidate-evaluation.js";
import type {
  CommercialStaticAssessment,
} from "../../src/modules/backlinks/domain/recommendations/commercial-static-assessment.js";

const assessment: CommercialStaticAssessment = {
  canonicalDomain: "publisher.com",
  decision: "ready",
  language: "en",
  topics: ["projector", "streaming"],
  productRelevance: 0.8,
  editorialQuality: 0.75,
  siteType: "specialist_blog",
  monetizationMethods: ["advertising"],
  cooperationPages: ["https://publisher.com/advertise"],
  outboundLinkDensity: 0.1,
  technicalAccessibility: 1,
  unsafeOrMalicious: false,
  highConfidenceLinkFarm: false,
  evidenceUrls: ["https://publisher.com/"],
  evidenceRefs: ["safefetch:publisher.com"],
  failedUrls: [],
  collectedAt: "2026-08-06T08:00:00.000Z",
  ruleVersion: "commercial-static-assessment.v1",
};

const base = {
  business: {
    selfOrRelatedDomain: false,
    existingBacklinkOrOpportunity: false,
    permanentlyRejectedOrSuppressed: false,
    unsafeOrDisallowedIndustry: false,
    strictMarketMode: true,
    expectedLanguages: ["en-US"],
  },
  provider: {
    rank: 70,
    backlinkCount: 10_000,
    referringDomainCount: 500,
    spamScore: 4,
    evidenceRefs: ["dataforseo:publisher.com"],
    collectedAt: "2026-08-06T08:00:00.000Z",
  },
  staticAssessment: assessment,
} as const;

describe("commercial candidate evaluation", () => {
  it("produces the deterministic 100-point commercial v2 score", () => {
    const result = evaluateCommercialCandidate(base);

    expect(result.decision).toBe("ready");
    expect(result.total).toBeGreaterThan(0);
    expect(result.components.map(({ weight }) => weight))
      .toEqual([25, 15, 15, 15, 15, 10, 5]);
  });

  it("applies business hard gates before scoring", () => {
    const result = evaluateCommercialCandidate({
      ...base,
      business: {
        ...base.business,
        existingBacklinkOrOpportunity: true,
      },
    });

    expect(result.decision).toBe("excluded");
    expect(result.total).toBeNull();
    expect(result.hitGates).toContain("existing_backlink_or_opportunity");
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
    expect(result.components.find(({ id }) => id === "relevance")?.points)
      .toBeNull();
  });
});
