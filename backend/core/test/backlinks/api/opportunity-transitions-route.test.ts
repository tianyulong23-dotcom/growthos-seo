import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import { createOpportunityCommands } from "../../../src/modules/backlinks/application/commands/opportunities.command.js";
import { registerBacklinksOpportunityCommandsRoutes } from "../../../src/modules/backlinks/api/opportunity-commands.route.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import { createActorContext, createProjectContext,
  createTenantContext } from "../../../src/modules/backlinks/domain/context/index.js";
import { BacklinkError, backlinkErrorCodes
} from "../../../src/modules/backlinks/domain/errors/backlink-error.js";
const opportunityId = "018f0000-0000-7000-8000-000000000078";
const recommendationId = "018f0000-0000-7000-8000-000000000079";
const cycleId = "018f0000-0000-7000-8000-000000000080";
const contactCandidateId = "018f0000-0000-7000-8000-000000000081";
const member = createActorContext({ userId: "user-78", sessionId: "session-78",
  roles: ["member"] });
const context = { actor: member,
  tenant: createTenantContext({ organizationId: "org-78", workspaceId: "workspace-78" }),
  project: createProjectContext({ websiteProjectId: "project-78",
    canonicalDomain: "example.com", locale: "en-US", countryCode: "US",
    profileVersionId: "profile-78", promotionTargetVersionId: "target-78" }),
};

describe("BL-AI-078/079 Opportunity command API", () => {
  it("enforces transition and management-patch guards", async () => {
    const commands = createOpportunityCommands({
      createFromRecommendation: async (input) => input.expectedVersion === 7
        ? { state: "version_conflict", requestHash: input.requestHash }
        : { state: "completed", requestHash: input.requestHash,
          responseBody: { opportunityId, recommendationId, cycleId, joinSequence: 1,
            websiteProjectId: "project-78", targetSiteKey: "example.com",
            targetHostAscii: "www.example.com",
            contactCandidateId, contactReviewRequired: false,
            businessStage: "JOINED", managementStatus: "ACTIVE",
            outcomeStatus: "OPEN", fulfillmentStatus: "NOT_EXPECTED", version: 1,
            lifecycleEventId: "life-create", auditEventId: "audit-create" } },
      transitionBusinessStage: async (input) => {
        if (input.expectedVersion === 7) return { state: "version_conflict",
          requestHash: input.requestHash, currentStage: "JOINED" };
        if (input.toBusinessStage === "AGREED") return { state: "invalid_transition",
          requestHash: input.requestHash, currentStage: "JOINED" };
        return { state: "completed", requestHash: input.requestHash,
          responseBody: { opportunityId, businessStage: input.toBusinessStage,
            managementStatus: "ACTIVE", outcomeStatus: "OPEN",
            fulfillmentStatus: "NOT_EXPECTED", version: 2,
            lifecycleEventId: "life-78", auditEventId: "audit-78" } };
      },
      patchManagement: async (input) => input.expectedVersion === 7
        ? { state: "version_conflict", requestHash: input.requestHash }
        : { state: "completed", requestHash: input.requestHash,
          responseBody: { opportunityId, businessStage: "JOINED",
            managementStatus: input.managementStatus, outcomeStatus: "OPEN",
            fulfillmentStatus: "NOT_EXPECTED", version: 2,
            lifecycleEventId: "life-79", auditEventId: "audit-79" } },
    });
    const app = Fastify({ logger: false, genReqId: () => "request-78" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = request.headers["x-role"] === "viewer"
        ? createActorContext({ userId: "viewer-78", sessionId: "viewer-session",
          roles: ["viewer"] }) : member;
    });
    registerBacklinksOpportunityCommandsRoutes(app, {
      module: createBacklinksModule({ projectContext: {
        resolve: async ({ actor, websiteProjectKey }) => {
          if (websiteProjectKey === "foreign") throw new BacklinkError({
            code: backlinkErrorCodes.accessDenied, message: "Project denied." });
          return { ...context, actor };
        },
      }, queries: {} }), commands,
    });
    await app.ready();
    afterAll(() => app.close());
    const create = (project: string, expectedVersion: number, role?: string) => app.inject({
      method: "POST",
      url: `/api/v1/projects/${project}/backlinks/opportunities`,
      headers: { "idempotency-key": `create-${expectedVersion}`,
        ...(role === undefined ? {} : { "x-role": role }) },
      payload: { recommendationId, contactCandidateId, expectedVersion },
    });
    expect((await create("project-key", 1)).json()).toMatchObject({
      opportunityId, recommendationId, cycleId, joinSequence: 1,
      websiteProjectId: "project-78", targetSiteKey: "example.com",
      targetHostAscii: "www.example.com",
      contactCandidateId, contactReviewRequired: false,
      businessStage: "JOINED", managementStatus: "ACTIVE",
      outcomeStatus: "OPEN", fulfillmentStatus: "NOT_EXPECTED", version: 1,
      replayed: false, meta: { websiteProjectId: "project-78", requestId: "request-78" },
    });
    expect((await create("project-key", 7)).statusCode).toBe(409);
    expect((await create("project-key", 1, "viewer")).statusCode).toBe(403);
    expect((await create("foreign", 1)).statusCode).toBe(403);
    const post = (project: string, expectedVersion: number,
      toBusinessStage: string, role?: string) => app.inject({
      method: "POST",
      url: `/api/v1/projects/${project}/backlinks/opportunities/${opportunityId}/transition`,
      headers: { "idempotency-key": `transition-${expectedVersion}-${toBusinessStage}`,
        ...(role === undefined ? {} : { "x-role": role }) },
      payload: { expectedVersion, toBusinessStage, reason: "Advance outreach." },
    });
    expect((await post("project-key", 1, "CONTACT_PREPARING")).json())
      .toMatchObject({ opportunityId, businessStage: "CONTACT_PREPARING",
        managementStatus: "ACTIVE", outcomeStatus: "OPEN",
        fulfillmentStatus: "NOT_EXPECTED", version: 2, replayed: false,
        meta: { websiteProjectId: "project-78", requestId: "request-78" } });
    expect((await post("project-key", 7, "CONTACT_PREPARING")).statusCode).toBe(409);
    expect((await post("project-key", 1, "AGREED")).statusCode).toBe(409);
    expect((await post("project-key", 1, "CONTACT_PREPARING", "viewer")).statusCode)
      .toBe(403);
    expect((await post("foreign", 1, "CONTACT_PREPARING")).statusCode).toBe(403);
    const patch = (project: string, expectedVersion: number, role?: string) => app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project}/backlinks/opportunities/${opportunityId}/management`,
      headers: { "idempotency-key": `management-${expectedVersion}`,
        ...(role === undefined ? {} : { "x-role": role }) },
      payload: { expectedVersion, managementStatus: "PAUSED", reason: "Pause outreach." },
    });
    expect((await patch("project-key", 1)).json()).toMatchObject({
      opportunityId, businessStage: "JOINED", managementStatus: "PAUSED",
      outcomeStatus: "OPEN", fulfillmentStatus: "NOT_EXPECTED", version: 2,
      replayed: false, meta: { websiteProjectId: "project-78" },
    });
    expect((await patch("project-key", 7)).statusCode).toBe(409);
    expect((await patch("project-key", 1, "viewer")).statusCode).toBe(403);
    expect((await patch("foreign", 1)).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH",
      url: `/api/v1/projects/project-key/backlinks/opportunities/${opportunityId}/management`,
      headers: { "idempotency-key": "management-forbidden-field" },
      payload: { expectedVersion: 1, managementStatus: "PAUSED",
        businessStage: "CLOSED", reason: "Do not overwrite business stage." },
    })).statusCode).toBe(400);
  });
});
