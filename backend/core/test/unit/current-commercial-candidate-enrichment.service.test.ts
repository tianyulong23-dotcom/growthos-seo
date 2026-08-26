import { describe, expect, it } from "vitest";

import { prepareCurrentCommercialCandidateEnrichment } from "../../src/modules/backlinks/application/services/current-commercial-candidate-enrichment.service.js";
import { evaluateCommercialCandidate } from "../../src/modules/backlinks/domain/recommendations/commercial-candidate-evaluation.js";

const staticAssessment = {
  canonicalDomain: "publisher.example",
  decision: "ready",
  language: "en",
  topics: ["film reviews"],
  matchedProducts: ["streaming entertainment"],
  matchedTopics: ["film reviews"],
  matchedKeywords: ["film reviews"],
  matchedTargetPages: [],
  matchedAudiences: [],
  matchedPartnershipGoals: [],
  relatedContentPages: ["https://publisher.example/reviews"],
  productRelevance: 0.4,
  editorialQuality: 0.2,
  siteType: "specialist_blog",
  monetizationMethods: [],
  cooperationPages: [],
  outboundLinkDensity: 0.8,
  technicalAccessibility: 1,
  unsafeOrMalicious: false,
  highConfidenceLinkFarm: false,
  unrelatedIndustry: false,
  evidenceUrls: ["https://publisher.example/"],
  evidenceRefs: ["safefetch:publisher.example"],
  failedUrls: [],
  collectedAt: "2026-08-19T00:00:00.000Z",
  ruleVersion: "commercial-static-assessment.v3",
} as const;

const business = {
  selfOrRelatedDomain: false,
  existingBacklinkOrOpportunity: false,
  permanentlyRejectedOrSuppressed: false,
  unsafeOrDisallowedIndustry: false,
  targetCountryCode: "ZA",
  candidateCountryCode: "ZA",
  targetLanguages: ["en-ZA", "en"],
  allowSameLanguageExpansion: false,
  targetMarketScopedDiscovery: true,
} as const;

const provider = {
  rank: 0,
  traffic: 0,
  backlinkCount: null,
  referringDomainCount: null,
  spamScore: 50,
  countryCode: "ZA",
  backlinkPageEvidence: [],
  evidenceRefs: ["dataforseo:discovery:publisher.example"],
  collectedAt: "2026-08-19T00:00:00.000Z",
} as const;

function row(
  id: string,
  canonicalDomain: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const candidate = {
    hostnameAscii: canonicalDomain,
    sourceTypes: ["BLUEPRINT_SERP_STANDARD_QUEUE"] as const,
    business,
    provider,
    staticAssessment: {
      ...staticAssessment,
      canonicalDomain,
    },
    commercialScore: evaluateCommercialCandidate({
      business,
      provider,
      staticAssessment: {
        ...staticAssessment,
        canonicalDomain,
      },
    }),
  };
  return {
    candidateId: id,
    canonicalDomain,
    sourceTypes: candidate.sourceTypes,
    staticAssessment: candidate.staticAssessment,
    gateDecision: {
      decision: candidate.commercialScore.decision,
      hitGates: candidate.commercialScore.hitGates,
      missingEvidence: candidate.commercialScore.missingEvidence,
    },
    commercialScore: candidate.commercialScore,
    refillTier: "exact_product_target_market",
    locale: "en",
    countryCode: "ZA",
    ...overrides,
  };
}

const input = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  projectContextVersionId: "context-1",
  visiblePoolGeneration: 1,
  actorId: "test:stage2d-current-enrichment",
  now: new Date("2026-08-19T16:00:00.000Z"),
  generationInputFingerprint: "generation-fingerprint-v8",
} as const;

describe("current commercial candidate enrichment preparation", () => {
  it("keeps already-publishable candidates out of paid enrichment", async () => {
    const nearThreshold = row(
      "00000000-0000-4000-8000-000000000001",
      "near-threshold.example",
    );
    const publishableBase = row(
      "00000000-0000-4000-8000-000000000002",
      "publishable.example",
    );
    const publishable = {
      ...publishableBase,
      commercialScore: {
        ...publishableBase.commercialScore,
        decision: "eligible",
        total: 52.5,
        hitGates: [],
        missingEvidence: ["dataforseo.traffic"],
        admission: {
          ...publishableBase.commercialScore.admission,
          baselineThreshold: 50,
          appliedThreshold: 50,
        },
      },
      gateDecision: {
        decision: "eligible",
        hitGates: [],
        missingEvidence: ["dataforseo.traffic"],
      },
      state: "candidate_ready",
    };
    const writes: unknown[][] = [];

    const result = await prepareCurrentCommercialCandidateEnrichment(
      {
        query: async (text, values = []) => {
          if (text.includes("SELECT candidate.id")) {
            return { rows: [publishable, nearThreshold] };
          }
          writes.push([...values]);
          return { rows: [{ candidateId: nearThreshold.candidateId }] };
        },
      },
      {
        ...input,
        maximumCandidates: 25,
        apply: true,
      },
    );

    expect(result.publishableCandidates).toEqual([
      expect.objectContaining({
        candidateId: publishable.candidateId,
        hostnameAscii: "publishable.example",
      }),
    ]);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        candidateId: nearThreshold.candidateId,
        hostnameAscii: "near-threshold.example",
      }),
    ]);
    expect(result.preparedCount).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[4]).toBe(nearThreshold.candidateId);
  });

  it("dry-runs a bounded near-threshold selection without reviving hard exclusions", async () => {
    const eligibleRows = Array.from({ length: 30 }, (_, index) =>
      row(
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        `publisher-${String(index).padStart(2, "0")}.example`,
      ));
    const excluded = row(
      "00000000-0000-4000-8000-999999999999",
      "unsafe.example",
      {
        staticAssessment: {
          ...staticAssessment,
          canonicalDomain: "unsafe.example",
          unsafeOrMalicious: true,
        },
        gateDecision: {
          decision: "ineligible",
          hitGates: ["unsafe_or_disallowed"],
          missingEvidence: [],
        },
        commercialScore: evaluateCommercialCandidate({
          business,
          provider,
          staticAssessment: {
            ...staticAssessment,
            canonicalDomain: "unsafe.example",
            unsafeOrMalicious: true,
          },
        }),
        state: "excluded",
      },
    );
    const queries: string[] = [];

    const result = await prepareCurrentCommercialCandidateEnrichment(
      {
        query: async (text) => {
          queries.push(text);
          return { rows: [...eligibleRows, excluded] };
        },
      },
      {
        ...input,
        maximumCandidates: 7,
        apply: false,
      },
    );

    expect(result.candidates).toHaveLength(7);
    expect(result.decisions.filter(({ decision }) =>
      decision === "enrichment_eligible"
    )).toHaveLength(7);
    expect(result.decisions).not.toContainEqual(expect.objectContaining({
      hostnameAscii: "unsafe.example",
      decision: "enrichment_eligible",
    }));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(
      "candidate.state NOT IN ('published','stale_context','excluded')",
    );
    expect(queries[0]).toContain(
      "newer_context.snapshot_version>context.snapshot_version",
    );
    expect(queries[0]).toContain(
      "input_pin.immutable_fingerprint=$8",
    );
  });

  it("marks only selected candidates and replays without extra writes", async () => {
    const candidate = row(
      "00000000-0000-4000-8000-000000000001",
      "publisher.example",
    );
    const queries: Array<Readonly<{
      text: string;
      values: readonly unknown[];
    }>> = [];
    let readCount = 0;

    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes("SELECT candidate.id")) {
          readCount += 1;
          return { rows: [candidate] };
        }
        return {
          rows: readCount === 1
            ? [{ candidateId: candidate.candidateId }]
            : [],
        };
      },
    };

    const first = await prepareCurrentCommercialCandidateEnrichment(client, {
      ...input,
      maximumCandidates: 25,
      apply: true,
    });
    const replay = await prepareCurrentCommercialCandidateEnrichment(client, {
      ...input,
      maximumCandidates: 25,
      apply: true,
    });

    expect(first.preparedCount).toBe(1);
    expect(replay.preparedCount).toBe(0);
    expect(queries.filter(({ text }) =>
      text.includes("state='enrichment_eligible'")
    )).toHaveLength(2);
    expect(queries[1]?.text).toContain("state NOT IN (");
    expect(queries[1]?.text).toContain(
      "'published','stale_context','excluded','enrichment_eligible'",
    );
    expect(queries[1]?.text).toContain(
      "input_pin.immutable_fingerprint=$12",
    );
  });
});
