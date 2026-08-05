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
const componentIds = [
  "graph_authority_diversity",
  "topic_content_editorial_quality",
  "outbound_commercialization",
  "network_risk",
  "technical_health",
] as const;
const componentWeights = [35, 30, 15, 15, 5] as const;
const rows = ["alpha", "beta"].map((name, index) => ({
  id: `018f0000-0000-7000-8000-00000000000${index + 1}`,
  hostname: `${name}.example`, score: "90.0000", status: "ready",
  recommendationContextVersionId: "context-1", version: index + 1,
  scoreModelVersion: "recommendation-open-evidence-score.v1",
  ruleVersion: "rules-v1",
  scoreId: `score-${index + 1}`,
  scoreComponents: componentIds.map((id, componentIndex) => ({
    id,
    evidence: {
      availability: "observed", value: 0.9,
      sourceType: id === "technical_health"
        ? "shared_crawler_site_audit"
        : "dataforseo",
      sourceReleaseId: "dataforseo-2026-07-25", confidence: 0.95,
      observedAt: "2026-07-25T00:00:00.000Z", stale: false,
      evidenceRefs: [`score:${name}:${id}`],
    },
    normalizedValue: 0.9,
    weight: componentWeights[componentIndex],
    points: componentWeights[componentIndex] * 0.9,
  })),
  scoreEvidence: { sourceReleaseId: "dataforseo-2026-07-25" },
  scoreGeneratedAt: new Date("2026-07-25T01:00:00.000Z"),
}));

describe("BL-AI-062 recommendations list API", () => {
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
    registerBacklinksRecommendationsRoute(app, { module: createBacklinksModule({
      projectContext: { resolve: async ({ websiteProjectKey }) => {
        if (websiteProjectKey === "foreign") throw new BacklinkError({
          code: backlinkErrorCodes.accessDenied, message: "Project denied",
        });
        return context;
      } }, queries: query,
    }) });
    await app.ready();
    afterAll(() => app.close());

    const first = await app.inject({ method: "GET",
      url: "/api/v1/projects/project-key/backlinks/recommendations"
        + "?status=ready&minScore=70&limit=1" });
    expect(first.json()).toMatchObject({
      items: [{
        id: rows[0]?.id, hostname: "alpha.example", score: 90,
        assessment: {
          outcome: "review_recommended",
          sourceReleaseIds: ["dataforseo-2026-07-25"],
          unavailableFields: [],
        },
      }],
      hasMore: true, meta: { organizationId: "org-1", workspaceId: "workspace-1",
        websiteProjectId: "project-1", requestId: "request-1" },
    });
    const assessment = first.json<{
      items: { assessment: { components: unknown[] } }[];
    }>().items[0]?.assessment;
    expect(assessment?.components).toHaveLength(5);
    expect(assessment?.components[0]).toMatchObject({
      id: "graph_authority_diversity",
      availability: "observed",
      sourceType: "dataforseo",
    });
    expect(calls[0]?.values?.slice(0, 5))
      .toEqual(["org-1", "workspace-1", "project-1", "ready", 70]);
    expect(calls[0]?.text).toContain(
      "ORDER BY s.total_score DESC,p.hostname_ascii,r.id",
    );
    const cursor = first.json<{ nextCursor: string }>().nextCursor;
    const second = await app.inject({ method: "GET",
      url: `/api/v1/projects/project-key/backlinks/recommendations?limit=1&cursor=${cursor}` });
    expect(second.json()).toMatchObject({
      items: [{ id: rows[1]?.id }], hasMore: false, nextCursor: null,
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
