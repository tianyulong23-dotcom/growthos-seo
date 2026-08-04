import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import {
  createReplyMatchCommands,
} from "../../../src/modules/backlinks/application/commands/reply-match.command.js";
import type {
  ConfirmReplyMatchInput,
  ReplyMatchRepository,
} from "../../../src/modules/backlinks/application/services/reply-match.repository.js";
import {
  registerBacklinksReplyMatchRoutes,
} from "../../../src/modules/backlinks/api/reply-match.route.js";
import { registerBacklinksOpenApi } from "../../../src/modules/backlinks/api/openapi.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../../src/modules/backlinks/domain/errors/backlink-error.js";

const inboundMessageId = "018f0000-0000-7000-8000-000000000135";
const candidateId = "018f0000-0000-7000-8000-000000000235";
const opportunityId = "018f0000-0000-7000-8000-000000000335";
const member = createActorContext({
  userId: "user-135",
  sessionId: "session-135",
  roles: ["member"],
});
const context = {
  actor: member,
  tenant: createTenantContext({
    organizationId: "organization-135",
    workspaceId: "workspace-135",
  }),
  project: createProjectContext({
    websiteProjectId: "project-135",
    canonicalDomain: "example.test",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-135",
    promotionTargetVersionId: "target-135",
  }),
};

describe("BL-AI-135 Reply Match Candidate APIs", () => {
  let app: FastifyInstance;
  let confirmation: ConfirmReplyMatchInput | undefined;
  let confirmState: "confirmed" | "not_found" | "conflict";

  beforeEach(async () => {
    confirmation = undefined;
    confirmState = "confirmed";
    const repository: ReplyMatchRepository = {
      async saveMatchResult() {
        throw new Error("not used");
      },
      async listCandidates(input) {
        expect(input).toEqual({
          organizationId: "organization-135",
          workspaceId: "workspace-135",
          websiteProjectId: "project-135",
          inboundMessageId,
        });
        return {
          state: "found",
          inboundMessageId,
          matchStatus: "CANDIDATES_READY",
          candidates: [{
            id: candidateId,
            inboundMessageId,
            opportunityId,
            candidateRank: 1,
            confidenceScore: 0.25,
            reasonCodes: [{
              kind: "RULE_VERSION",
              value: "reply-matcher-v1",
            }, {
              kind: "NORMALIZED_SUBJECT",
              value: "growthos collaboration",
            }],
            requiresManualConfirmation: true,
            createdAt: "2026-07-28T09:35:00.000Z",
          }],
        };
      },
      async confirmCandidate(input) {
        confirmation = input;
        if (confirmState !== "confirmed") return { state: confirmState };
        return {
          state: "confirmed",
          candidateId,
          inboundMessageId,
          opportunityId,
          matchStatus: "MATCH_CONFIRMED",
          auditEventId: "018f0000-0000-7000-8000-000000000435",
        };
      },
    };

    app = Fastify({ logger: false, genReqId: () => "request-135" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = request.headers["x-role"] === "viewer"
        ? createActorContext({
            userId: "viewer-135",
            sessionId: "viewer-session-135",
            roles: ["viewer"],
          })
        : member;
    });
    registerBacklinksReplyMatchRoutes(app, {
      module: createBacklinksModule({
        projectContext: {
          resolve: async ({ actor, websiteProjectKey }) => {
            if (websiteProjectKey === "foreign") {
              throw new BacklinkError({
                code: backlinkErrorCodes.accessDenied,
                message: "Project denied.",
              });
            }
            return { ...context, actor };
          },
        },
        queries: {},
      }),
      commands: createReplyMatchCommands({ repository }),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists only the resolved project candidate without auto-ownership", async () => {
    const response = await app.inject({
      method: "GET",
      url:
        `/api/v1/projects/project-key/backlinks/replies/${inboundMessageId}`
        + "/match-candidates",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      inboundMessageId,
      matchStatus: "CANDIDATES_READY",
      items: [{
        id: candidateId,
        opportunityId,
        confidenceScore: 0.25,
        requiresManualConfirmation: true,
      }],
      meta: {
        websiteProjectId: "project-135",
        requestId: "request-135",
      },
    });
    expect((await app.inject({
      method: "GET",
      url:
        `/api/v1/projects/foreign/backlinks/replies/${inboundMessageId}`
        + "/match-candidates",
    })).statusCode).toBe(403);
  });

  it("confirms with an optimistic status guard, actor, reason, and audit request", async () => {
    const response = await app.inject({
      method: "POST",
      url:
        `/api/v1/projects/project-key/backlinks/replies/${inboundMessageId}`
        + `/match-candidates/${candidateId}/confirm`,
      payload: {
        expectedMatchStatus: "CANDIDATES_READY",
        reason: "Verified against the original outreach thread.",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      candidateId,
      inboundMessageId,
      opportunityId,
      matchStatus: "MATCH_CONFIRMED",
      auditEventId: "018f0000-0000-7000-8000-000000000435",
    });
    expect(confirmation).toEqual({
      organizationId: "organization-135",
      workspaceId: "workspace-135",
      websiteProjectId: "project-135",
      inboundMessageId,
      candidateId,
      expectedMatchStatus: "CANDIDATES_READY",
      actorId: "user-135",
      requestId: "request-135",
      reason: "Verified against the original outreach thread.",
    });
  });

  it("rejects viewers, stale confirmations, and foreign candidates", async () => {
    const confirm = () => app.inject({
      method: "POST",
      url:
        `/api/v1/projects/project-key/backlinks/replies/${inboundMessageId}`
        + `/match-candidates/${candidateId}/confirm`,
      payload: {
        expectedMatchStatus: "CANDIDATES_READY",
        reason: "Verified manually.",
      },
    });

    expect((await app.inject({
      method: "POST",
      url:
        `/api/v1/projects/project-key/backlinks/replies/${inboundMessageId}`
        + `/match-candidates/${candidateId}/confirm`,
      headers: { "x-role": "viewer" },
      payload: {
        expectedMatchStatus: "CANDIDATES_READY",
        reason: "Viewer must not confirm.",
      },
    })).statusCode).toBe(403);

    confirmState = "conflict";
    expect((await confirm()).statusCode).toBe(409);
    confirmState = "not_found";
    expect((await confirm()).statusCode).toBe(404);
  });
});
