import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import { createRecommendationsQuery } from "../../../src/modules/backlinks/application/queries/recommendations.query.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import { registerBacklinksRecommendationsRoute } from "../../../src/modules/backlinks/api/recommendations.route.js";
import { createActorContext, createProjectContext,
  createTenantContext } from "../../../src/modules/backlinks/domain/context/index.js";
import { BacklinkError, backlinkErrorCodes } from "../../../src/modules/backlinks/domain/errors/backlink-error.js";

const actor = createActorContext({
  userId: "user-1", sessionId: "session-1", roles: ["member"],
});
const context = { actor,
  tenant: createTenantContext({ organizationId: "org-1", workspaceId: "workspace-1" }),
  project: createProjectContext({ websiteProjectId: "project-1",
    canonicalDomain: "example.com", locale: "en-US", countryCode: "US",
    profileVersionId: "profile-1", promotionTargetVersionId: "target-1" }) };
const fitComponentIds = [
  "semantic_relevance",
  "audience_partnership",
  "market_language_tier",
  "site_editorial_commercial",
  "dataforseo_authority_risk",
  "dataforseo_traffic_visibility",
  "safefetch_technical_access",
] as const;
const fitComponentWeights = [30, 15, 15, 15, 15, 5, 5] as const;
const rows = ["alpha", "beta"].map((name, index) => ({
  id: `018f0000-0000-7000-8000-00000000000${index + 1}`,
  hostname: `${name}.example`, score: "90.0000", status: "ready",
  publicationStatus: "PUBLISHED",
  verifiedPublicEmailCount: 1,
  recommendationContextVersionId: "context-1", version: index + 1,
  scoreModelVersion: "recommendation-commercial-fit.v3",
  ruleVersion: "recommendation-commercial-fit-rules.v3",
  sourceTypes: index === 0
    ? ["BLUEPRINT_SERP_STANDARD_QUEUE"]
    : ["CURATED_RESOURCE_LIBRARY"],
  fitScore: {
    decision: "eligible",
    scoreModelVersion: "recommendation-commercial-fit.v3",
    ruleVersion: "recommendation-commercial-fit-rules.v3",
    total: 90,
    components: fitComponentIds.map((id, componentIndex) => ({
      id,
      state: "observed",
      rawValue: 0.9,
      normalizedValue: 0.9,
      weight: fitComponentWeights[componentIndex],
      points: fitComponentWeights[componentIndex] * 0.9,
      evidenceRefs: [`fit:${name}:${id}`],
      normalizationRuleVersion: "recommendation-commercial-fit-rules.v3",
      collectedAt: "2026-08-10T01:00:00.000Z",
    })),
    hitGates: [],
    missingEvidence: [],
    details: {
      matchTier: "high_fit",
      reasonCodes: ["PRODUCT_MATCH", "TARGET_MARKET_MATCH"],
      matchedProducts: ["robotic pool cleaner"],
      matchedTopics: ["pool care"],
      matchedKeywords: ["pool maintenance"],
      matchedTargetPages: ["https://example.com/pool-cleaner"],
      matchedAudiences: ["pool owners"],
      market: {
        targetCountry: "US",
        candidateCountry: "US",
        targetLanguage: "en",
        candidateLanguage: "en",
        tier: "target_market",
        reasonCode: "TARGET_MARKET_MATCH",
      },
      cooperationAngles: ["editorial"],
      dataForSeo: {
        rank: 320,
        traffic: 12500,
        backlinks: 4200,
        referringDomains: 780,
        spamScore: 4,
        evidenceRefs: index === 0
          ? [`dataforseo:${name}`]
          : [
            "resource-type:free",
            `resource-library:${name}:fixture-sha`,
          ],
        collectedAt: "2026-08-10T00:30:00.000Z",
      },
      safeFetch: {
        relatedContentPages: [`https://${name}.example/pool-care`],
        evidenceUrls: [`https://${name}.example/pool-care`],
        evidenceRefs: [`safefetch:${name}`],
        failedUrls: [],
        technicalAccessibility: 0.95,
      },
    },
  },
  contacts: [{
    id: `018f0000-0000-7000-8000-00000000020${index + 1}`,
    normalizedEmail: `editorial@${name}.com`,
    domainRelation: "same_registrable_domain",
    confidence: 95,
    inferredPurpose: "editorial",
    purposeConfidence: 90,
    guessed: false,
    version: 1,
    eligible: true,
    contactReviewRequired: false,
    evidence: [{
      id: `018f0000-0000-7000-8000-00000000030${index + 1}`,
      sourceUrl: `https://${name}.example/contact`,
      observedAt: "2026-08-10T01:05:00.000Z",
      extractionMethod: "mailto",
      evidenceSnippet: `editorial@${name}.com`,
      confidence: 95,
    }],
  }],
  recommendedContactCandidateId:
    `018f0000-0000-7000-8000-00000000020${index + 1}`,
  contactDecisionSourceUrl: `https://${name}.example/contact`,
  contactDecisionPurpose: "editorial",
  contactDecisionConfidence: 95,
  contactDecisionPurposeConfidence: 90,
  contactDecisionEvidenceConfidence: 95,
  contactDecisionCollectedAt: new Date("2026-08-10T01:05:00.000Z"),
  contactDecisionRulesVersion: "contact-publication-rules.v2",
  rootUrl: `https://${name}.example/`,
  contactStatus: "contactable",
  contactJob: null,
  existingOpportunityId: null,
  canCreateOpportunity: true,
  createBlockReason: null,
  scoreGeneratedAt: new Date("2026-07-25T01:00:00.000Z"),
}));
const firstRecommendationRow = rows[0];
if (firstRecommendationRow === undefined) {
  throw new Error("Recommendation fixture is missing its first row");
}
const historicalReassessmentRow = {
  ...firstRecommendationRow,
  hostname: "historical.example",
  score: "71.2858",
  sourceTypes: [],
  fitScore: {
    ...firstRecommendationRow.fitScore,
    total: 71.2858,
    components: firstRecommendationRow.fitScore.components.map((component) => ({
      ...component,
      evidenceRefs: component.id.startsWith("dataforseo_")
        ? [`dataforseo:historical:${component.id}`]
        : component.id === "safefetch_technical_access"
          ? ["safefetch:historical"]
          : [`historical:${component.id}`],
    })),
    details: {
      reassessmentReason: "HISTORICAL_V2_REASSESSED",
      sourceCandidateId: "historical-candidate-1",
      sourceScoreModelVersion: "recommendation-commercial-fit.v2",
      sourceRuleVersion: "recommendation-commercial-fit-rules.v2",
      sourceEvidenceCollectedAt: "2026-08-09T01:00:00.000Z",
      projectContext: {
        locale: "en-US",
        countryCode: "US",
      },
    },
  },
};

describe("BL-AI-062 recommendations list API", () => {
  it("resolves commercial inventory through the active context snapshot", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const query = createRecommendationsQuery({
      query: async (text, values) => {
        calls.push({ text, values });
        return { rows: [{
          recommendationContextVersionId:
            "018f0000-0000-7000-8000-000000000099",
          serverUpdatedAt: new Date("2026-08-10T02:00:00.000Z"),
          blueprintVersion: 3,
          blueprintGenerator: "DETERMINISTIC_FALLBACK",
          fitCount: 8,
          contactCount: 6,
          unpublishedCount: 2,
          currentRefillTier: "same_topic_target_market",
          currentRefillRound: 2,
          paidRefillTier: "same_topic_target_market",
          paidRefillRound: 2,
          resourceRefillTier: "curated_resource_library",
          resourceRefillRound: 1,
          attemptedRefillTiers: [
            { tier: "same_topic_target_market", round: 2, window: 3 },
            { tier: "curated_resource_library", round: 1, window: 2 },
          ],
          providerCallOccurred: false,
          refillInFlight: true,
          refillJob: {
            operationId: "018f0000-0000-7000-8000-000000000097",
            id: "018f0000-0000-7000-8000-000000000098",
            workflowId: "backlinks:recommendation-refill:e2e",
            status: "running",
            step: "provider_request_reserved",
            progress: 5,
            errorCode: null,
            errorMessage: null,
            failure: null,
            retryCount: 0,
            lowWatermark: 20,
            highWatermark: 40,
            refillWindowKey: "manual-e2e",
            startedAt: "2026-08-10T01:59:00.000Z",
            finishedAt: null,
            createdAt: "2026-08-10T01:58:59.000Z",
            updatedAt: "2026-08-10T02:00:00.000Z",
            version: 2,
          },
        }] };
      },
    });

    const result = await query.getRecommendationInventoryStatus(
      {
        ...context,
        project: createProjectContext({
          ...context.project,
          profileVersionId: "project-1:legacy-profile",
        }),
      },
      "test-build",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual(["org-1", "workspace-1", "project-1"]);
    expect(calls[0]?.text).toContain("WITH current_context AS");
    expect(calls[0]?.text).toContain(
      "project_context_version_id=(SELECT id FROM current_context)",
    );
    expect(calls[0]?.text).toContain("latest_refill_job AS");
    expect(calls[0]?.text).toContain(
      "ORDER BY b.started_at DESC,b.id DESC",
    );
    expect(calls[0]?.text).not.toContain("refill_windows AS");
    expect(calls[0]?.text).toContain(
      "usage.reservation_key LIKE",
    );
    expect(calls[0]?.text).toContain(
      "request.request_id LIKE",
    );
    expect(calls[0]?.text).toContain(
      "refill.refill_window_key||':%'",
    );
    expect(calls[0]?.text).not.toContain(
      "request.request_id=(SELECT id::text FROM latest_refill_job)",
    );
    expect(result).toMatchObject({
      recommendationContextVersionId:
        "018f0000-0000-7000-8000-000000000099",
      serverUpdatedAt: "2026-08-10T02:00:00.000Z",
      contractVersion: "backlinks.recommendation-operation.v1",
      runningBuildId: "test-build",
      operationId: "018f0000-0000-7000-8000-000000000097",
      jobId: "018f0000-0000-7000-8000-000000000098",
      stage: "discovery",
      terminal: false,
      targetCount: 10,
      fitCount: 8,
      contactCount: 6,
      unpublishedCount: 2,
      tier: "same_topic_target_market",
      round: 2,
      window: 3,
      paidCursor: {
        tier: "same_topic_target_market",
        round: 2,
        window: 3,
      },
      resourceCursor: {
        tier: "curated_resource_library",
        round: 1,
        window: 2,
      },
      providerCallOccurred: false,
      candidateReadyCount: 0,
      publishedContactReadyCount: 0,
      historicalEmailHitRate: 0.1,
      refillInFlight: true,
      refillJob: {
        operationId: "018f0000-0000-7000-8000-000000000097",
        id: "018f0000-0000-7000-8000-000000000098",
        status: "running",
        step: "provider_request_reserved",
        progress: 5,
      },
    });
  });

  it.each(["shown", "stale_context", "accepted"] as const)(
    "returns historical inventory status %s without a validation failure",
    async (historicalStatus) => {
      const historicalRow = {
        ...rows[0],
        status: historicalStatus,
      };
      const app = Fastify({ logger: false, genReqId: () => "request-history" });
      await registerBacklinksOpenApi(app);
      app.decorateRequest("actor");
      app.addHook("preHandler", async (request) => { request.actor = actor; });
      registerBacklinksRecommendationsRoute(app, {
        module: createBacklinksModule({
          projectContext: { resolve: async () => context },
          queries: createRecommendationsQuery({
            query: async () => ({ rows: [historicalRow] }),
          }),
        }),
        runningBuildId: "test-build",
      });
      await app.ready();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/project-key/backlinks/recommendations?status=${historicalStatus}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        items: [{ id: historicalRow.id, status: historicalStatus }],
      });
      await app.close();
    },
  );

  it("does not project a persisted running policy without live work", async () => {
    const query = createRecommendationsQuery({
      query: async () => ({
        rows: [{
          recommendationContextVersionId: "context-stale-running",
          serverUpdatedAt: new Date("2026-08-12T02:00:00.000Z"),
          blueprintVersion: 1,
          refillState: "running",
          refillInFlight: false,
          refillJob: {
            operationId: "operation-stale-running",
            id: "job-stale-running",
            workflowId: "workflow-stale-running",
            status: "success",
            step: "completed",
            progress: 100,
            errorCode: null,
            errorMessage: null,
            failure: null,
            retryCount: 0,
            lowWatermark: 20,
            highWatermark: 40,
            refillWindowKey: "tier-1:round-1:window-1",
            startedAt: "2026-08-12T01:59:00.000Z",
            finishedAt: "2026-08-12T02:00:00.000Z",
            createdAt: "2026-08-12T01:59:00.000Z",
            updatedAt: "2026-08-12T02:00:00.000Z",
            version: 2,
          },
        }],
      }),
    });

    const result = await query.getRecommendationInventoryStatus(
      context,
      "test-build",
    );

    expect(result).toMatchObject({
      stage: "complete",
      terminal: false,
      refillInFlight: false,
      refillState: "idle",
      refillJob: {
        id: "job-stale-running",
        status: "success",
      },
    });
  });

  it("does not project a historical failed refill after the target is reached", async () => {
    const query = createRecommendationsQuery({
      query: async () => ({
        rows: [{
          recommendationContextVersionId: "context-target-reached",
          serverUpdatedAt: new Date("2026-08-13T14:30:00.000Z"),
          blueprintVersion: 3,
          visiblePoolState: "active",
          visiblePoolTargetCount: 10,
          publishedContactReadyCount: 10,
          refillState: "completed",
          terminationReason: "HIGH_WATERMARK",
          pauseReason: "PROVIDER_REQUEST_FAILED",
          refillInFlight: false,
          refillJob: {
            operationId: "operation-historical-failure",
            id: "job-historical-failure",
            workflowId: "workflow-historical-failure",
            status: "failed",
            step: "provider_request_failed",
            progress: 40,
            errorCode: "UNKNOWN_INTERNAL",
            errorMessage: "Historical refill failure",
            failure: {
              rootCause: "UNKNOWN_INTERNAL",
              recovery: "RETRY_REFILL",
              providerCallOccurred: false,
              diagnosticId: "diagnostic-historical-failure",
              message: "Historical refill failure",
            },
            retryCount: 1,
            lowWatermark: 9,
            highWatermark: 10,
            refillWindowKey: "tier-1:round-1:window-1",
            startedAt: "2026-08-13T14:20:00.000Z",
            finishedAt: "2026-08-13T14:21:00.000Z",
            createdAt: "2026-08-13T14:19:00.000Z",
            updatedAt: "2026-08-13T14:21:00.000Z",
            version: 2,
          },
        }],
      }),
    });

    const result = await query.getRecommendationInventoryStatus(
      context,
      "test-build",
    );

    expect(result).toMatchObject({
      operationId: null,
      jobId: null,
      stage: "complete",
      terminal: true,
      terminalState: "TARGET_REACHED",
      targetCount: 10,
      publishedCount: 10,
      refillState: "completed",
      errorCode: null,
      recoveryAction: null,
      refillJob: null,
    });
  });

  it("projects historical v2 reassessments through the current v3 response", async () => {
    const app = Fastify({ logger: false, genReqId: () => "request-history-v2" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => { request.actor = actor; });
    registerBacklinksRecommendationsRoute(app, {
      module: createBacklinksModule({
        projectContext: { resolve: async () => context },
        queries: createRecommendationsQuery({
          query: async () => ({ rows: [historicalReassessmentRow] }),
        }),
      }),
      runningBuildId: "test-build",
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-key/backlinks/recommendations?status=ready",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{
        hostname: "historical.example",
        candidateSource: "paid_discovery",
        metricsSource: "dataforseo",
        risk: { level: "unknown", spamScore: null },
        relevantPages: [],
        fitDecision: {
          matchTier: "qualified_fit",
          reasonCodes: [
            "HISTORICAL_V2_REASSESSED",
            "SAME_LANGUAGE_EXPANSION",
          ],
          matchedProducts: [],
          market: {
            targetCountry: "US",
            candidateCountry: null,
            targetLanguage: "en",
            candidateLanguage: null,
            tier: "same_language_expansion",
            reasonCode: "SAME_LANGUAGE_EXPANSION",
          },
          dataForSeo: {
            rank: null,
            traffic: null,
            backlinks: null,
            referringDomains: null,
            spamScore: null,
            evidenceRefs: [
              "dataforseo:historical:dataforseo_authority_risk",
              "dataforseo:historical:dataforseo_traffic_visibility",
            ],
            collectedAt: "2026-08-09T01:00:00.000Z",
          },
          safeFetch: {
            relatedContentPages: [],
            evidenceUrls: [],
            evidenceRefs: ["safefetch:historical"],
            failedUrls: [],
            technicalAccessibility: 0.9,
          },
        },
      }],
    });
    await app.close();
  });

  it("enforces project scope, filters, and a stable seek cursor", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const rejectedRow = {
      ...rows[0],
      id: "018f0000-0000-7000-8000-000000000003",
      hostname: "rejected.example",
      status: "rejected",
      version: 3,
    };
    const query = createRecommendationsQuery({ query: async (text, values) => {
      calls.push({ text, values });
      return {
        rows: calls.length === 1
          ? rows
          : calls.length === 2 ? rows.slice(1) : [rejectedRow],
      };
    } });
    const app = Fastify({ logger: false, genReqId: () => "request-1" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => { request.actor = actor; });
    registerBacklinksRecommendationsRoute(app, {
      module: createBacklinksModule({
        projectContext: { resolve: async ({ websiteProjectKey }) => {
          if (websiteProjectKey === "foreign") throw new BacklinkError({
            code: backlinkErrorCodes.accessDenied, message: "Project denied",
          });
          return context;
        } }, queries: query,
      }),
      runningBuildId: "test-build",
    });
    await app.ready();
    afterAll(() => app.close());

    const first = await app.inject({ method: "GET",
      url: "/api/v1/projects/project-key/backlinks/recommendations"
        + "?status=ready&minScore=70&limit=1" });
    expect(first.json()).toMatchObject({
      items: [{
        id: rows[0]?.id, hostname: "alpha.example", score: 90,
        fitDecision: {
          decision: "eligible",
          matchTier: "high_fit",
          matchedProducts: ["robotic pool cleaner"],
          market: {
            tier: "target_market",
            reasonCode: "TARGET_MARKET_MATCH",
          },
        },
        contactDecision: {
          decision: "eligible",
          reasonCode: "PUBLIC_EMAIL_FOUND",
          inferredPurpose: "editorial",
        },
        priority: "high",
        candidateSource: "paid_discovery",
        metricsSource: "dataforseo",
        risk: { level: "low", spamScore: 4 },
        relevantPages: ["https://alpha.example/pool-care"],
        emailSource: {
          url: "https://alpha.example/contact",
          extractionMethod: "mailto",
        },
      }],
      hasMore: true, meta: { organizationId: "org-1", workspaceId: "workspace-1",
        websiteProjectId: "project-1", requestId: "request-1" },
    });
    const fitDecision = first.json<{
      items: { fitDecision: { components: unknown[] } }[];
    }>().items[0]?.fitDecision;
    expect(fitDecision?.components).toHaveLength(7);
    expect(fitDecision?.components[0]).toMatchObject({
      id: "semantic_relevance",
      state: "observed",
      evidenceRefs: ["fit:alpha:semantic_relevance"],
    });
    expect(first.json()).not.toHaveProperty("items.0.assessment");
    expect(calls[0]?.values?.slice(0, 5))
      .toEqual(["org-1", "workspace-1", "project-1", "ready", 70]);
    expect(calls[0]?.text).toContain(
      "ORDER BY s.total_score DESC,p.hostname_ascii,r.id",
    );
    const cursor = first.json<{ nextCursor: string }>().nextCursor;
    const second = await app.inject({ method: "GET",
      url: `/api/v1/projects/project-key/backlinks/recommendations?limit=1&cursor=${cursor}` });
    expect(second.json()).toMatchObject({
      items: [{
        id: rows[1]?.id,
        candidateSource: "resource_library",
        resourceType: "free",
        metricsSource: "resource_library_snapshot",
      }],
      hasMore: false,
      nextCursor: null,
    });
    expect(calls[1]?.values?.slice(5, 8))
      .toEqual([90, "alpha.example", rows[0]?.id]);

    const rejected = await app.inject({ method: "GET",
      url: "/api/v1/projects/project-key/backlinks/recommendations"
        + "?status=rejected&limit=1" });
    expect(rejected.json()).toMatchObject({
      items: [{ id: rejectedRow.id, status: "rejected" }],
    });
    expect(calls[2]?.values?.[3]).toBe("rejected");

    const invalid = await app.inject({ method: "GET",
      url: "/api/v1/projects/project-key/backlinks/recommendations?cursor=bad" });
    expect(invalid.statusCode).toBe(400);
    expect(calls).toHaveLength(3);
    const denied = await app.inject({ method: "GET",
      url: "/api/v1/projects/foreign/backlinks/recommendations" });
    expect(denied.statusCode).toBe(403);
    expect(calls).toHaveLength(3);
  });
});
