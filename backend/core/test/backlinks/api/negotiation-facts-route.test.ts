import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import type {
  NegotiationFactsService,
  NegotiationFactVersion,
} from "../../../src/modules/backlinks/application/services/negotiation-facts.service.js";
import {
  registerBacklinksNegotiationFactsRoutes,
} from "../../../src/modules/backlinks/api/negotiation-facts.route.js";
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

const inboundMessageId = "018f0000-0000-7000-8000-000000000161";
const opportunityId = "018f0000-0000-7000-8000-000000000162";
const sourceFactVersionId = "018f0000-0000-7000-8000-000000000163";
const actor = createActorContext({
  userId: "user-161",
  sessionId: "session-161",
  roles: ["member"],
});
const context = {
  actor,
  tenant: createTenantContext({
    organizationId: "organization-161",
    workspaceId: "workspace-161",
  }),
  project: createProjectContext({
    websiteProjectId: "project-161",
    canonicalDomain: "example.test",
    locale: "en-ZA",
    countryCode: "ZA",
    profileVersionId: "profile-161",
    promotionTargetVersionId: "target-161",
  }),
};
const fact = Object.freeze({
  id: sourceFactVersionId,
  inboundMessageId,
  opportunityId,
  factKey: "commercial.price",
  factVersion: 1,
  factType: "PRICE",
  rawValue: "ZAR 7,500",
  normalizedValue: { currency: "ZAR", amount: 7_500 },
  factAuthority: "INFERRED",
  reviewStatus: "PENDING",
  extractorType: "RULE",
  extractorVersion: "negotiation-rule-v1",
  confidenceScore: 0.85,
  evidenceText: "The placement fee is ZAR 7,500.",
  evidenceStart: 21,
  evidenceEnd: 30,
  supersedesFactVersionId: null,
  decidedBy: null,
  decidedAt: null,
  schemaVersion: 1,
  createdAt: "2026-08-18T08:00:00.000Z",
  createdBy: "gmail-sync",
} satisfies NegotiationFactVersion);

describe("Phase 10 negotiation facts API", () => {
  let app: FastifyInstance;
  let decisionInput:
    Parameters<NegotiationFactsService["decide"]>[0] | undefined;

  beforeEach(async () => {
    decisionInput = undefined;
    const service: NegotiationFactsService = {
      async list(resolvedContext, replyId) {
        expect(resolvedContext.project.websiteProjectId).toBe("project-161");
        expect(replyId).toBe(inboundMessageId);
        return {
          inboundMessageId,
          opportunityId,
          items: [fact],
        };
      },
      async decide(input) {
        decisionInput = input;
        return {
          decision: input.decision,
          replayed: false,
          appendedFactVersionIds: [
            "018f0000-0000-7000-8000-000000000164",
          ],
          latestFact: {
            ...fact,
            id: "018f0000-0000-7000-8000-000000000164",
            factVersion: 2,
            reviewStatus: input.decision === "REJECT"
              ? "REJECTED"
              : "CONFIRMED",
            factAuthority: "MANUAL",
            extractorType: "MANUAL",
            extractorVersion: "manual-review-v1",
            decidedBy: "user-161",
            decidedAt: "2026-08-18T08:05:00.000Z",
            createdAt: "2026-08-18T08:05:00.000Z",
            createdBy: "user-161",
          },
        };
      },
    };

    app = Fastify({ logger: false, genReqId: () => "request-161" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = actor;
    });
    registerBacklinksNegotiationFactsRoutes(app, {
      module: createBacklinksModule({
        projectContext: {
          resolve: async ({ actor: resolvedActor, websiteProjectKey }) => {
            if (websiteProjectKey === "foreign") {
              throw new BacklinkError({
                code: backlinkErrorCodes.accessDenied,
                message: "Project denied.",
              });
            }
            return { ...context, actor: resolvedActor };
          },
        },
        queries: {},
      }),
      service,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists facts with reply, opportunity, project, and request attribution", async () => {
    const response = await app.inject({
      method: "GET",
      url:
        `/api/v1/projects/project-key/backlinks/replies/${inboundMessageId}`
        + "/negotiation-facts",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      inboundMessageId,
      opportunityId,
      items: [{
        id: sourceFactVersionId,
        factVersion: 1,
        reviewStatus: "PENDING",
      }],
      meta: {
        organizationId: "organization-161",
        workspaceId: "workspace-161",
        websiteProjectId: "project-161",
        requestId: "request-161",
      },
    });
    expect((await app.inject({
      method: "GET",
      url:
        `/api/v1/projects/foreign/backlinks/replies/${inboundMessageId}`
        + "/negotiation-facts",
    })).statusCode).toBe(403);
  });

  it("passes optimistic version, actor context, reason, and request id", async () => {
    const response = await app.inject({
      method: "POST",
      url:
        `/api/v1/projects/project-key/backlinks/replies/${inboundMessageId}`
        + "/negotiation-facts/decisions",
      headers: {
        "idempotency-key": "negotiation-review-161",
      },
      payload: {
        sourceFactVersionId,
        expectedFactVersion: 1,
        decision: "CONFIRM",
        reason: "Verified against the original reply.",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      decision: "CONFIRM",
      replayed: false,
      latestFact: {
        opportunityId,
        reviewStatus: "CONFIRMED",
      },
    });
    expect(decisionInput).toEqual({
      context,
      inboundMessageId,
      sourceFactVersionId,
      expectedFactVersion: 1,
      decision: "CONFIRM",
      reason: "Verified against the original reply.",
      requestId: "request-161",
      idempotencyKey: "negotiation-review-161",
    });
  });

  it("rejects incomplete or misplaced correction payloads", async () => {
    const url =
      `/api/v1/projects/project-key/backlinks/replies/${inboundMessageId}`
      + "/negotiation-facts/decisions";
    expect((await app.inject({
      method: "POST",
      url,
      headers: {
        "idempotency-key": "negotiation-review-correct-161",
      },
      payload: {
        sourceFactVersionId,
        expectedFactVersion: 1,
        decision: "CORRECT",
        reason: "Correct currency.",
      },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url,
      headers: {
        "idempotency-key": "negotiation-review-reject-161",
      },
      payload: {
        sourceFactVersionId,
        expectedFactVersion: 1,
        decision: "REJECT",
        reason: "Not a commercial term.",
        correction: {
          factType: "PRICE",
          rawValue: "ZAR 7,500",
          normalizedValue: { currency: "ZAR", amount: 7_500 },
        },
      },
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "POST",
      url,
      payload: {
        sourceFactVersionId,
        expectedFactVersion: 1,
        decision: "CONFIRM",
        reason: "Missing retry identity.",
      },
    })).statusCode).toBe(400);
  });
});
