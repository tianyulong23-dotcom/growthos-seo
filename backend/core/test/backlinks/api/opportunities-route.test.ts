import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import { createOpportunitiesQuery } from "../../../src/modules/backlinks/application/queries/opportunities.query.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import { registerBacklinksOpportunitiesRoutes } from "../../../src/modules/backlinks/api/opportunities.route.js";
import { createActorContext, createProjectContext,
  createTenantContext } from "../../../src/modules/backlinks/domain/context/index.js";
import { BacklinkError, backlinkErrorCodes } from "../../../src/modules/backlinks/domain/errors/backlink-error.js";

const actor = createActorContext({
  userId: "user-80", sessionId: "session-80", roles: ["member"],
});
const context = { actor,
  tenant: createTenantContext({ organizationId: "org-80", workspaceId: "workspace-80" }),
  project: createProjectContext({ websiteProjectId: "project-80",
    canonicalDomain: "owner.example", locale: "en-US", countryCode: "US",
    profileVersionId: "profile-80", promotionTargetVersionId: "target-80" }) };
const rows = ["alpha", "beta"].map((name, index) => ({
  id: `018f0000-0000-7000-8000-00000000008${index}`,
  recommendationId: `018f0000-0000-7000-8000-00000000009${index}`,
  prospectId: `018f0000-0000-7000-8000-00000000010${index}`,
  recommendationContextVersionId: "018f0000-0000-7000-8000-000000000110",
  targetSiteKey: `${name}.example`, targetHostAscii: `www.${name}.example`,
  targetIdentityKind: "registrable_domain",
  targetIdentityRuleVersion: "tldts-v1",
  targetIdentityOverrideReason: null,
  joinSequence: 11 - index,
  businessStage: "JOINED", managementStatus: "ACTIVE",
  outcomeStatus: "OPEN", fulfillmentStatus: "NOT_EXPECTED",
  contactEmail: index === 1 ? "editorial@beta.example" : null,
  hasDownstreamFacts: index === 0,
  version: index + 1,
  createdAt: new Date(`2026-07-24T00:00:0${index}.000Z`),
  updatedAt: new Date(`2026-07-24T01:00:0${index}.000Z`),
  assessmentScoreId: `score-8${index}`,
  assessmentScore: "82.0000",
  assessmentScoreModelVersion: "score-v1",
  assessmentRuleVersion: "rules-v1",
  assessmentComponents: [],
  assessmentEvidence: { sourceEvidenceIds: [`snapshot-${index}`] },
  assessmentGeneratedAt: new Date("2026-07-25T01:00:00.000Z"),
}));

describe("BL-AI-080 Opportunity query API", () => {
  it("enforces project scope, four-axis filters, stable cursor order, and detail lookup", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const query = createOpportunitiesQuery({ query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes("WHERE (o.organization_id,o.workspace_id,o.website_project_id,o.id)")) {
        return { rows: values?.[3] === rows[0]?.id ? [rows[0] as Record<string, unknown>] : [] };
      }
      return { rows: calls.length === 1 ? rows : rows.slice(1) };
    } });
    const app = Fastify({ logger: false, genReqId: () => "request-80" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => { request.actor = actor; });
    registerBacklinksOpportunitiesRoutes(app, { module: createBacklinksModule({
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
      url: "/api/v1/projects/project-key/backlinks/opportunities"
        + "?businessStage=JOINED&managementStatus=ACTIVE"
        + "&outcomeStatus=OPEN&fulfillmentStatus=NOT_EXPECTED"
        + "&search=alpha&limit=1" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      items: [{ id: rows[0]?.id, joinSequence: 11, targetSiteKey: "alpha.example",
        contactEmail: null, hasDownstreamFacts: true,
        createdAt: "2026-07-24T00:00:00.000Z" }],
      hasMore: true, meta: { organizationId: "org-80", workspaceId: "workspace-80",
        websiteProjectId: "project-80", requestId: "request-80" },
    });
    expect(calls[0]?.values?.slice(0, 8)).toEqual([
      "org-80", "workspace-80", "project-80",
      "JOINED", "ACTIVE", "OPEN", "NOT_EXPECTED", "alpha",
    ]);
    expect(calls[0]?.text).toContain("ORDER BY o.join_sequence DESC,o.id DESC");

    const cursor = first.json<{ nextCursor: string }>().nextCursor;
    const second = await app.inject({ method: "GET",
      url: `/api/v1/projects/project-key/backlinks/opportunities?limit=1&cursor=${cursor}` });
    expect(second.json()).toMatchObject({
      items: [{ id: rows[1]?.id, joinSequence: 10,
        contactEmail: "editorial@beta.example" }],
      hasMore: false, nextCursor: null,
    });
    expect(calls[1]?.values?.slice(8, 10)).toEqual([11, rows[0]?.id]);

    const detail = await app.inject({ method: "GET",
      url: `/api/v1/projects/project-key/backlinks/opportunities/${rows[0]?.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      item: { id: rows[0]?.id, recommendationId: rows[0]?.recommendationId,
        targetIdentityKind: "registrable_domain",
        assessment: {
          outcome: "insufficient_data",
          readOnly: true,
          score: 82,
        },
        placementCandidate: null },
      meta: { websiteProjectId: "project-80" },
    });
    expect(calls[2]?.values).toEqual([
      "org-80", "workspace-80", "project-80", rows[0]?.id,
    ]);

    const missing = await app.inject({ method: "GET",
      url: "/api/v1/projects/project-key/backlinks/opportunities"
        + "/018f0000-0000-7000-8000-000000000999" });
    expect(missing.statusCode).toBe(404);
    const invalid = await app.inject({ method: "GET",
      url: "/api/v1/projects/project-key/backlinks/opportunities?cursor=bad" });
    expect(invalid.statusCode).toBe(400);
    const denied = await app.inject({ method: "GET",
      url: "/api/v1/projects/foreign/backlinks/opportunities" });
    expect(denied.statusCode).toBe(403);
    expect(calls).toHaveLength(4);
  });
});
