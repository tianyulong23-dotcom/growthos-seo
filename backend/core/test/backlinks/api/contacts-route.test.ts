import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import { createContactCommands } from "../../../src/modules/backlinks/application/commands/contacts.command.js";
import { registerBacklinksContactsRoutes } from "../../../src/modules/backlinks/api/contacts.route.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import { createActorContext, createProjectContext, createTenantContext
} from "../../../src/modules/backlinks/domain/context/index.js";
import { BacklinkError, backlinkErrorCodes } from "../../../src/modules/backlinks/domain/errors/backlink-error.js";
const candidateId = "018f0000-0000-7000-8000-000000000073",
  foreignCandidateId = "018f0000-0000-7000-8000-000000000074", prospectId = "018f0000-0000-7000-8000-000000000075";
const member = createActorContext({ userId: "user-1", sessionId: "session-1", roles: ["member"] });
const baseContext = { actor: member,
  tenant: createTenantContext({ organizationId: "org-1", workspaceId: "workspace-1" }),
  project: createProjectContext({ websiteProjectId: "project-1",
    canonicalDomain: "example.com", locale: "en-US", countryCode: "US",
    profileVersionId: "profile-1", promotionTargetVersionId: "target-1" }),
};
describe("BL-AI-073 contact candidate APIs", () => {
  it("lists only eligible Opportunity contacts and exposes deterministic selection state", async () => {
    const emptyOpportunityId = "018f0000-0000-7000-8000-000000000078";
    const singleOpportunityId = "018f0000-0000-7000-8000-000000000079";
    const multipleOpportunityId = "018f0000-0000-7000-8000-000000000080";
    const missingOpportunityId = "018f0000-0000-7000-8000-000000000081";
    const firstContactId = "018f0000-0000-7000-8000-000000000082";
    const secondContactId = "018f0000-0000-7000-8000-000000000083";
    const opportunityContact = (contactId: string, opportunityId: string, email: string) => ({
      id: contactId,
      opportunityId,
      prospectId,
      normalizedEmail: email,
      contactRole: "editorial",
      confirmedAt: new Date("2026-08-03T02:00:00.000Z"),
      status: "active",
      guessed: false,
      version: 2,
    });
    const commands = createContactCommands({
      query: async (_text, values) => {
        const opportunityId = String(values?.[3]);
        if (opportunityId === missingOpportunityId) {
          return { rows: [{ opportunityExists: false, items: [] }] };
        }
        if (opportunityId === singleOpportunityId) {
          return {
            rows: [{
              opportunityExists: true,
              items: [opportunityContact(
                firstContactId,
                opportunityId,
                "editor@example.com",
              )],
            }],
          };
        }
        if (opportunityId === multipleOpportunityId) {
          return {
            rows: [{
              opportunityExists: true,
              items: [
                opportunityContact(firstContactId, opportunityId, "editor@example.com"),
                opportunityContact(secondContactId, opportunityId, "owner@example.com"),
              ],
            }],
          };
        }
        return { rows: [{ opportunityExists: true, items: [] }] };
      },
    });
    const app = Fastify({ logger: false, genReqId: () => "request-contacts" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = member;
    });
    registerBacklinksContactsRoutes(app, {
      module: createBacklinksModule({
        projectContext: {
          resolve: async ({ actor, websiteProjectKey }) => {
            if (websiteProjectKey === "foreign") {
              throw new BacklinkError({
                code: backlinkErrorCodes.accessDenied,
                message: "Project denied.",
              });
            }
            return { ...baseContext, actor };
          },
        },
        queries: {},
      }),
      commands,
    });
    await app.ready();
    afterAll(() => app.close());
    const list = (opportunityId: string, projectKey = "project-key") => app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectKey}/backlinks/opportunities/${opportunityId}/contacts`,
    });

    expect((await list(emptyOpportunityId)).json()).toMatchObject({
      items: [],
      selection: {
        state: "CONTACT_CONFIRMATION_REQUIRED",
        autoSelectedContactId: null,
      },
    });
    expect((await list(singleOpportunityId)).json()).toMatchObject({
      items: [{
        id: firstContactId,
        status: "active",
        guessed: false,
        version: 2,
      }],
      selection: {
        state: "AUTO_SELECTED",
        autoSelectedContactId: firstContactId,
      },
    });
    expect((await list(multipleOpportunityId)).json()).toMatchObject({
      items: [{ id: firstContactId }, { id: secondContactId }],
      selection: {
        state: "USER_SELECTION_REQUIRED",
        autoSelectedContactId: null,
      },
    });
    expect((await list(missingOpportunityId)).statusCode).toBe(404);
    expect((await list(singleOpportunityId, "foreign")).statusCode).toBe(403);
  });

  it("enforces project scope, permissions, ExpectedVersion, and audit", async () => {
    let inferredPurpose = "editorial";
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const commands = createContactCommands({ query: async (text, values) => {
      calls.push({ text, values });
      if (text.includes("contact.candidate.create")) return { rows: [{
        state: "completed",
        requestHash: values?.[10],
        responseBody: {
          candidateId,
          prospectId,
          recommendationContextVersionId: "018f0000-0000-7000-8000-000000000076",
          normalizedEmail: "editor@publisher.test",
          contactRole: "editorial",
          status: "candidate",
          version: 1,
          lifecycleEventId: "life-create-73",
          auditEventId: "audit-create-73",
        },
      }] };
      if (!text.includes("contact_candidate.confirmed")) return { rows: [{
        id: candidateId, prospectId, recommendationContextVersionId:
          "018f0000-0000-7000-8000-000000000076",
        normalizedEmail: "editor@example.com", domainRelation: "same_registrable_domain",
        confidence: 90, observedRole: "editor", inferredPurpose,
        purposeConfidence: 98, purposeRuleVersion: "contact-purpose-rules.v1",
        purposeEvidence: [{ tier: "high", field: "email_local_part", value: "editor",
          matchedToken: "editor", ruleId: "editorial.editor" }],
        guessed: false, status: "candidate", version: 3,
        evidence: [{ sourceUrl: "https://example.com/contact",
          observedAt: "2026-07-23T02:00:00.000Z", extractionMethod: "mailto",
          evidenceSnippet: "editor@example.com", method: "mailto",
          snippet: "editor@example.com", confidence: 90,
          ruleVersion: "contact-extraction-rules.v1",
          contentHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          domainRelation: "same_registrable_domain",
          expiresAt: "2027-07-23T02:00:00.000Z" }],
      }] };
      if (values?.[4] === foreignCandidateId) return { rows: [{ state: "not_found" }] };
      if (values?.[5] === 7) return { rows: [{ state: "version_conflict" }] };
      return { rows: [{ state: "completed", candidateId, contactId:
        "018f0000-0000-7000-8000-000000000077", candidateVersion: 4,
        contactVersion: 1, lifecycleEventId: "life-73", auditEventId: "audit-73" }] };
    } });
    const app = Fastify({ logger: false, genReqId: () => "request-73" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => { request.actor = request.headers["x-role"] === "viewer"
      ? createActorContext({
        userId: "viewer-1", sessionId: "session-2", roles: ["viewer"] }) : member; });
    registerBacklinksContactsRoutes(app, {
      module: createBacklinksModule({ projectContext: {
        resolve: async ({ actor, websiteProjectKey }) => {
          if (websiteProjectKey === "foreign") throw new BacklinkError({
            code: backlinkErrorCodes.accessDenied, message: "Project denied.",
          });
          return { ...baseContext, actor };
        },
      }, queries: {} }), commands,
    });
    await app.ready();
    afterAll(() => app.close());
    const list = await app.inject({ method: "GET",
      url: `/api/v1/projects/project-key/backlinks/contacts/candidates?prospectId=${prospectId}` });
    expect(list.json()).toMatchObject({ items: [{ id: candidateId,
      observedRole: "editor", inferredPurpose: "editorial",
      purposeConfidence: 98, purposeRuleVersion: "contact-purpose-rules.v1",
      purposeEvidence: [{ ruleId: "editorial.editor" }],
      evidence: [{ extractionMethod: "mailto" }] }],
      meta: { websiteProjectId: "project-1", requestId: "request-73" } });
    expect(calls[0]?.values).toEqual(["org-1", "workspace-1", "project-1", prospectId, 25]);
    expect(calls[0]?.text).toContain("backlink_contact_evidence");
    for (const purpose of ["business", "marketing", "site_owner"]) {
      inferredPurpose = purpose;
      const response = await app.inject({ method: "GET",
        url: `/api/v1/projects/project-key/backlinks/contacts/candidates?prospectId=${prospectId}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().items[0].inferredPurpose).toBe(purpose);
    }
    inferredPurpose = "editorial";
    calls.splice(1);
    const create = (email: string, role?: string, idempotencyKey = "contact-create-once") =>
      app.inject({
        method: "POST",
        url: `/api/v1/projects/project-key/backlinks/opportunities/018f0000-0000-7000-8000-000000000078/contacts/candidates`,
        headers: {
          "idempotency-key": idempotencyKey,
          ...(role === undefined ? {} : { "x-role": role }),
        },
        payload: {
          normalizedEmail: email,
          contactRole: "editorial",
          reason: "Manually verified for this Opportunity.",
        },
      });
    expect((await create("editor@publisher.test")).json()).toMatchObject({
      candidateId,
      normalizedEmail: "editor@publisher.test",
      contactRole: "editorial",
      status: "candidate",
      version: 1,
      replayed: false,
      lifecycleEventId: "life-create-73",
      auditEventId: "audit-create-73",
    });
    expect(calls[1]?.values?.slice(0, 11)).toEqual([
      "org-1",
      "workspace-1",
      "project-1",
      "user-1",
      "018f0000-0000-7000-8000-000000000078",
      "editor@publisher.test",
      "publisher.test",
      "editorial",
      "Manually verified for this Opportunity.",
      "contact-create-once",
      calls[1]?.values?.[10],
    ]);
    expect(calls[1]?.text).toContain("backlink_idempotency_records");
    expect(calls[1]?.text).toContain("contact_candidate.created");
    expect(calls[1]?.text).toContain("backlink_audit_events");
    expect((await create("noreply@publisher.test", undefined, "contact-noreply")).statusCode)
      .toBe(400);
    expect((await create("editor@publisher.test", "viewer", "contact-viewer")).statusCode)
      .toBe(403);
    expect((await create("editor@publisher.test", undefined, "")).statusCode).toBe(400);
    const confirm = (id: string, expectedVersion: number, role?: string) => app.inject({
      method: "POST",
      url: `/api/v1/projects/project-key/backlinks/contacts/candidates/${id}/confirm`,
      headers: role === undefined ? {} : { "x-role": role },
      payload: { expectedVersion, contactRole: "editorial",
        reason: "Verified on the publisher contact page." },
    });
    expect((await confirm(candidateId, 3)).json()).toMatchObject({
      candidateId, candidateStatus: "promoted", candidateVersion: 4,
      contactStatus: "active", contactVersion: 1,
      lifecycleEventId: "life-73", auditEventId: "audit-73",
    });
    expect(calls[2]?.values?.slice(0, 8)).toEqual(["org-1", "workspace-1", "project-1",
      "user-1", candidateId, 3, "editorial", "Verified on the publisher contact page."]);
    expect(calls[2]?.text).toContain("backlink_audit_events");
    expect(calls[2]?.text).toContain("manual-contact-purpose.v1");
    expect(calls[2]?.text).toContain("purposeCorrected");
    expect((await confirm(candidateId, 7)).statusCode).toBe(409);
    expect((await confirm(foreignCandidateId, 1)).statusCode).toBe(404);
    expect((await confirm(candidateId, 3, "viewer")).statusCode).toBe(403);
    expect((await app.inject({ method: "GET",
      url: `/api/v1/projects/foreign/backlinks/contacts/candidates?prospectId=${prospectId}` }))
      .statusCode).toBe(403);
  });
});
