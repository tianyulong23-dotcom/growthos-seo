import { describe, expect, it } from "vitest";

import { reassessCurrentCommercialCandidates } from "../../src/modules/backlinks/application/services/current-commercial-candidate-reassessment.service.js";
import { commercialRecommendationFitRuleVersion } from "../../src/modules/backlinks/domain/recommendations/commercial-score-v3.js";

const staticAssessment = {
  canonicalDomain: "publisher.com",
  decision: "ready",
  language: "en",
  topics: ["streaming"],
  matchedProducts: ["streaming app"],
  matchedTopics: ["streaming"],
  matchedKeywords: ["streaming"],
  matchedTargetPages: ["https://project.example/"],
  matchedAudiences: ["streaming viewers"],
  matchedPartnershipGoals: ["editorial review"],
  relatedContentPages: ["https://publisher.com/review"],
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
  collectedAt: "2026-08-12T03:40:00.000Z",
  ruleVersion: "commercial-static-assessment.v3",
};

describe("current commercial candidate reassessment", () => {
  it("reuses target-market scoped evidence without a provider call", async () => {
    const queries: Readonly<{
      text: string;
      values: readonly unknown[];
    }>[] = [];
    const responses = [
      {
        rows: [
          {
            id: "candidate-1",
            staticAssessment,
            gateDecision: {
              decision: "ineligible",
              hitGates: ["forbidden_market_mismatch"],
              missingEvidence: [],
            },
            commercialScore: {
              ruleVersion: "recommendation-commercial-fit-rules.v3",
              details: {
                market: { candidateCountry: null },
                dataForSeo: {
                  rank: null,
                  traffic: null,
                  backlinks: null,
                  referringDomains: null,
                  spamScore: null,
                  evidenceRefs: ["dataforseo:publisher.com"],
                  collectedAt: "2026-08-12T03:40:00.000Z",
                },
              },
            },
            refillTier: "exact_product_target_market",
            locale: "en",
            countryCode: "ZA",
          },
        ],
      },
      { rows: [{ id: "candidate-1" }] },
    ];
    let index = 0;

    const result = await reassessCurrentCommercialCandidates(
      {
        query: async (text, values = []) => {
          queries.push({ text, values });
          return responses[index++] ?? { rows: [] };
        },
      },
      {
        organizationId: "organization-1",
        workspaceId: "workspace-1",
        websiteProjectId: "project-1",
        projectContextVersionId: "context-1",
        actorId: "test:local-product-038",
        now: new Date("2026-08-12T04:00:00.000Z"),
      },
    );

    expect(result).toEqual({ reassessedCount: 1 });
    expect(queries).toHaveLength(2);
    expect(queries[0]?.text).toContain("candidate.recommendation_id IS NULL");
    const updatedScore = JSON.parse(String(queries[1]?.values[6]));
    expect(updatedScore).toMatchObject({
      decision: "eligible",
      ruleVersion: commercialRecommendationFitRuleVersion,
      details: {
        market: {
          candidateCountry: null,
          tier: "target_market",
          reasonCode: "TARGET_MARKET_SCOPED_CANDIDATE",
        },
      },
    });
    expect(queries[1]?.values[7]).toBe("candidate_ready");
  });
});
