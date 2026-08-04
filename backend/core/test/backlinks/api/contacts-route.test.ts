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
  it("enforces project scope, permissions, ExpectedVersion, and audit", async () => {
    const calls: { text: string; values?: readonly unknown[] }[] = [];
    const commands = createContactCommands({ query: async (text, values) => {
      calls.push({ text, values });
      if (!text.includes("contact_candidate.confirmed")) return { rows: [{
        id: candidateId, prospectId, recommendationContextVersionId:
          "018f0000-0000-7000-8000-000000000076",
        normalizedEmail: "editor@example.com", domainRelation: "same_registrable_domain",
        confidence: 90, observedRole: "editor", inferredPurpose: "editorial",
        purposeConfidence: 98, purposeRuleVersion: "contact-purpose-rules.v1",
        purposeEvidence: [{ tier: "high", field: "email_local_part", value: "editor",
          matchedToken: "editor", ruleId: "editorial.editor" }],
        guessed: false, status: "candidate", version: 3,
        evidence: [{ sourceUrl: "https://example.com/contact",
          observedAt: "2026-07-23T02:00:00.000Z", extractionMethod: "mailto",
          evidenceSnippet: "editor@example.com", confidence: 90,
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
    expect(calls[1]?.values?.slice(0, 8)).toEqual(["org-1", "workspace-1", "project-1",
      "user-1", candidateId, 3, "editorial", "Verified on the publisher contact page."]);
    expect(calls[1]?.text).toContain("backlink_audit_events");
    expect(calls[1]?.text).toContain("manual-contact-purpose.v1");
    expect(calls[1]?.text).toContain("purposeCorrected");
    expect((await confirm(candidateId, 7)).statusCode).toBe(409);
    expect((await confirm(foreignCandidateId, 1)).statusCode).toBe(404);
    expect((await confirm(candidateId, 3, "viewer")).statusCode).toBe(403);
    expect((await app.inject({ method: "GET",
      url: `/api/v1/projects/foreign/backlinks/contacts/candidates?prospectId=${prospectId}` }))
      .statusCode).toBe(403);
  });
});
