import { describe, expect, it } from "vitest";

import {
  evaluateStoredCurrentCommercialCandidate,
  reassessCurrentCommercialCandidates,
} from "../../src/modules/backlinks/application/services/current-commercial-candidate-reassessment.service.js";
import {
  commercialFitBaselineAdmissionThreshold,
  commercialRecommendationFitModelVersion,
  commercialRecommendationFitRuleVersion,
} from "../../src/modules/backlinks/domain/recommendations/commercial-score-v4.js";

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
            sourceScoreModelVersion: commercialRecommendationFitModelVersion,
            recommendationId: null,
            prospectId: null,
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
        visiblePoolGeneration: 1,
        actorId: "test:local-product-038",
        now: new Date("2026-08-12T04:00:00.000Z"),
      },
    );

    expect(result).toEqual({ reassessedCount: 1 });
    expect(queries).toHaveLength(2);
    expect(queries[0]?.text).toContain("candidate.recommendation_id IS NULL");
    expect(queries[0]?.values[5]).toBe(
      commercialRecommendationFitRuleVersion,
    );
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

  it("rescored a linked manual-review candidate without a provider call", async () => {
    const queries: Readonly<{
      text: string;
      values: readonly unknown[];
    }>[] = [];
    const responses = [
      {
        rows: [
          {
            id: "candidate-2",
            sourceScoreModelVersion: commercialRecommendationFitModelVersion,
            recommendationId: "recommendation-2",
            prospectId: "prospect-2",
            staticAssessment: {
              ...staticAssessment,
              decision: "manual_review",
              matchedAudiences: [],
              matchedPartnershipGoals: [],
            },
            gateDecision: {
              decision: "eligible",
              hitGates: [],
              missingEvidence: [],
            },
            commercialScore: {
              decision: "eligible",
              ruleVersion: commercialRecommendationFitRuleVersion,
              components: [
                {
                  id: "audience_partnership",
                  state: "manual_review",
                },
              ],
              details: {
                market: { candidateCountry: null },
                dataForSeo: {
                  rank: null,
                  traffic: null,
                  backlinks: null,
                  referringDomains: null,
                  spamScore: null,
                  evidenceRefs: [],
                  collectedAt: "2026-08-12T03:40:00.000Z",
                },
              },
            },
            refillTier: "curated_resource_library",
            locale: "en",
            countryCode: "ZA",
          },
        ],
      },
      { rows: [{ id: "candidate-2" }] },
      { rows: [{ id: "score-2" }] },
      { rows: [{ emailCount: 0 }] },
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
        visiblePoolGeneration: 1,
        actorId: "test:phase-4-v3-2-repair",
        now: new Date("2026-08-17T03:00:00.000Z"),
      },
    );

    expect(result).toEqual({ reassessedCount: 1 });
    expect(queries).toHaveLength(5);
    expect(queries[0]?.text).toContain(
      "candidate.static_assessment->>'decision'='manual_review'",
    );
    expect(queries[0]?.text).not.toContain(
      "inventory.publication_status='NOT_PUBLISHED'",
    );
    expect(queries[0]?.text).not.toContain(
      "'pending','running','retry_scheduled'",
    );
    expect(queries[1]?.text).toContain(
      "UPDATE backlink_commercial_candidates AS candidate",
    );
    expect(queries[1]?.values[7]).toBe("candidate_ready");
    const updatedScore = JSON.parse(String(queries[1]?.values[6]));
    expect(updatedScore).toMatchObject({
      decision: "eligible",
      ruleVersion: commercialRecommendationFitRuleVersion,
    });
    expect(updatedScore.total).toBeGreaterThanOrEqual(
      commercialFitBaselineAdmissionThreshold,
    );
    expect(queries[2]?.text).toContain(
      "INSERT INTO backlink_recommendation_scores",
    );
    expect(queries[3]?.text).toContain("recommendation-commercial-fit.v4");
    expect(queries[3]?.text).toContain(
      "WHEN fit_candidate.fit_decision='eligible' THEN 'PUBLISHED'",
    );
    expect(queries[4]?.text).toContain(
      "opportunity.engagement_channel='EMAIL'",
    );
    expect(queries[4]?.text).toContain(
      "opportunity.source_contact_candidate_id IS NULL",
    );
    expect(queries[4]?.text).toContain(
      "opportunity.contact_review_required=true",
    );
  });

  it("reassesses a stale-rule candidate without forcing every generation back to the baseline threshold", async () => {
    const queries: Readonly<{
      text: string;
      values: readonly unknown[];
    }>[] = [];
    const responses = [
      {
        rows: [
          {
            id: "candidate-3",
            sourceScoreModelVersion: commercialRecommendationFitModelVersion,
            recommendationId: null,
            prospectId: null,
            staticAssessment,
            gateDecision: {
              decision: "ineligible",
              hitGates: [],
              missingEvidence: [],
            },
            commercialScore: {
              decision: "ineligible",
              ruleVersion: "recommendation-commercial-fit-rules.v4.2",
              admission: {
                baselineThreshold: 55,
                appliedThreshold: 55,
              },
              details: {
                market: { candidateCountry: null },
                dataForSeo: {
                  rank: null,
                  traffic: null,
                  backlinks: null,
                  referringDomains: null,
                  spamScore: null,
                  evidenceRefs: [],
                  collectedAt: "2026-08-12T03:40:00.000Z",
                },
              },
            },
            refillTier: "curated_resource_library",
            locale: "en",
            countryCode: "ZA",
          },
        ],
      },
      { rows: [{ id: "candidate-3" }] },
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
        visiblePoolGeneration: 1,
        actorId: "test:stage2r-threshold-reassessment",
        now: new Date("2026-08-20T04:00:00.000Z"),
      },
    );

    expect(result).toEqual({ reassessedCount: 1 });
    expect(queries).toHaveLength(2);
    expect(queries[0]?.text).not.toContain(
      "candidate.commercial_score#>>'{admission,appliedThreshold}'",
    );
    expect(queries[0]?.text).toContain(
      "candidate.state IS DISTINCT FROM",
    );
    expect(queries[0]?.text).toContain("jsonb_array_elements_text");
    expect(queries[0]?.text).toContain("evidence.value LIKE 'gate.%'");
    expect(queries[0]?.values).toHaveLength(7);
    expect(queries[1]?.text).not.toContain(
      "candidate.commercial_score#>>'{admission,appliedThreshold}'",
    );
    expect(queries[1]?.values).toHaveLength(13);
    const updatedScore = JSON.parse(String(queries[1]?.values[6]));
    expect(updatedScore).toMatchObject({
      decision: "eligible",
      admission: {
        baselineThreshold: commercialFitBaselineAdmissionThreshold,
        appliedThreshold: commercialFitBaselineAdmissionThreshold,
      },
      ruleVersion: commercialRecommendationFitRuleVersion,
    });
  });

  it("preserves a strongly relevant second-generation candidate below 50 during reassessment", () => {
    const evaluated = evaluateStoredCurrentCommercialCandidate({
      staticAssessment: {
        ...staticAssessment,
        productRelevance: 0.45,
        editorialQuality: 0.2,
        matchedAudiences: [],
        matchedPartnershipGoals: [],
        monetizationMethods: [],
        cooperationPages: [],
        outboundLinkDensity: 0.8,
        technicalAccessibility: 0.8,
      },
      gateDecision: {
        decision: "ineligible",
        hitGates: [],
        missingEvidence: [],
      },
      commercialScore: {
        decision: "ineligible",
        ruleVersion: "recommendation-commercial-fit-rules.v4.2",
        details: {
          authority: { projectAuthority: 20 },
          market: { candidateCountry: null },
          dataForSeo: {
            rank: 0,
            traffic: 0,
            backlinks: 0,
            referringDomains: 0,
            spamScore: 50,
            evidenceRefs: [],
            collectedAt: "2026-08-12T03:40:00.000Z",
          },
        },
      },
      refillTier: "exact_product_target_market",
      locale: "en",
      countryCode: "ZA",
      visiblePoolGeneration: 2,
    });

    expect(evaluated.score.total).toBeGreaterThanOrEqual(40);
    expect(evaluated.score.total).toBeLessThan(50);
    expect(evaluated.score).toMatchObject({
      decision: "eligible",
      admission: {
        baselineThreshold: 50,
        appliedThreshold: 40,
        fallbackApplied: true,
      },
      details: {
        market: {
          tier: "target_market",
        },
      },
    });
  });

  it("creates one immutable V4 fact from a legacy V3 candidate", async () => {
    const queries: Readonly<{
      text: string;
      values: readonly unknown[];
    }>[] = [];
    const responses = [
      {
        rows: [
          {
            id: "candidate-v3",
            sourceScoreModelVersion: "recommendation-commercial-fit.v3",
            blueprintId: "blueprint-1",
            discoveryBatchId: "batch-1",
            recommendationId: null,
            prospectId: null,
            canonicalDomain: "publisher.com",
            sourceTypes: ["EXISTING_HISTORY"],
            staticAssessment,
            gateDecision: {
              decision: "eligible",
              hitGates: [],
              missingEvidence: [],
            },
            commercialScore: {
              details: {
                authority: { projectAuthority: 20 },
                market: { candidateCountry: "ZA" },
                dataForSeo: {
                  rank: 60,
                  traffic: 20_000,
                  backlinks: 1_000,
                  referringDomains: 200,
                  spamScore: 10,
                  evidenceRefs: ["dataforseo:publisher.com"],
                  collectedAt: "2026-08-12T03:40:00.000Z",
                },
              },
            },
            providerCollectedAt: "2026-08-12T03:40:00.000Z",
            refillTier: "exact_product_target_market",
            locale: "en",
            countryCode: "ZA",
          },
        ],
      },
      { rows: [{ id: "candidate-v4" }] },
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
        visiblePoolGeneration: 1,
        actorId: "test:stage2q-v4-reassessment",
        now: new Date("2026-08-20T04:00:00.000Z"),
      },
    );

    expect(result).toEqual({ reassessedCount: 1 });
    expect(queries).toHaveLength(2);
    expect(queries[0]?.text).toContain(
      "candidate.score_model_version='recommendation-commercial-fit.v3'",
    );
    expect(queries[1]?.text).toContain(
      "INSERT INTO backlink_commercial_candidates",
    );
    expect(queries[1]?.text).not.toContain(
      "UPDATE backlink_commercial_candidates",
    );
    expect(queries[1]?.values[15]).toBe(
      commercialRecommendationFitModelVersion,
    );
    const score = JSON.parse(String(queries[1]?.values[14]));
    expect(score).toMatchObject({
      scoreModelVersion: commercialRecommendationFitModelVersion,
      ruleVersion: commercialRecommendationFitRuleVersion,
      details: {
        authority: {
          projectAuthority: 20,
          candidateAuthority: 60,
          tier: "normal_relative_range",
        },
      },
    });
  });
});
