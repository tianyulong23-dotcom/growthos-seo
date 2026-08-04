import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBacklinksModule } from "../../../src/modules/backlinks/application/backlinks.module.js";
import type {
  ReplyMailQuery,
} from "../../../src/modules/backlinks/application/queries/reply-mail.query.js";
import {
  registerBacklinksReplyMailRoutes,
} from "../../../src/modules/backlinks/api/reply-mail.route.js";
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

const messageId = "018f0000-0000-7000-8000-000000000139";
const threadId = "018f0000-0000-7000-8000-000000000239";
const inboundMessageId = "018f0000-0000-7000-8000-000000000339";
const member = createActorContext({
  userId: "user-139",
  sessionId: "session-139",
  roles: ["member"],
});
const context = {
  actor: member,
  tenant: createTenantContext({
    organizationId: "organization-139",
    workspaceId: "workspace-139",
  }),
  project: createProjectContext({
    websiteProjectId: "project-139",
    canonicalDomain: "example.test",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-139",
    promotionTargetVersionId: "target-139",
  }),
};
const listItem = Object.freeze({
  id: messageId,
  threadId,
  direction: "INBOUND" as const,
  fromAddress: "reply@example.test",
  toAddresses: ["owner@example.test"],
  ccAddresses: [],
  subject: "Re: GrowthOS collaboration",
  receivedAt: "2026-07-29T01:39:00.000Z",
  parseStatus: "PARSED" as const,
  version: 2,
  inboundMessageId,
  matchStatus: "CANDIDATES_READY" as const,
  matchedOpportunityId: null,
});
const detail = Object.freeze({
  ...listItem,
  body: Object.freeze({
    plainText: "Please share pricing.",
    sanitizedHtml: Object.freeze({
      content: "<p>Please share pricing.</p>",
      trust: "SANITIZED" as const,
      sanitized: true as const,
      policyVersion: "growthos-gmail-html-v1",
    }),
  }),
});

describe("BL-AI-139 Reply mail APIs", () => {
  let app: FastifyInstance;
  let listInput: unknown;

  beforeEach(async () => {
    listInput = undefined;
    const queries: ReplyMailQuery = {
      async listMailMessages(_context, input) {
        listInput = input;
        return {
          items: [listItem],
          nextCursor: "next-139",
          hasMore: true,
        };
      },
      async getMailMessage(_context, requestedMessageId) {
        if (requestedMessageId !== messageId) {
          throw new BacklinkError({
            code: backlinkErrorCodes.notFound,
            message: "Mail message was not found in this project.",
          });
        }
        return detail;
      },
      async getMailThread(_context, requestedThreadId) {
        if (requestedThreadId !== threadId) {
          throw new BacklinkError({
            code: backlinkErrorCodes.notFound,
            message: "Mail thread was not found in this project.",
          });
        }
        return {
          id: threadId,
          latestMessageAt: listItem.receivedAt,
          messageCount: 1,
          version: 4,
          messages: [detail],
        };
      },
    };

    app = Fastify({ logger: false, genReqId: () => "request-139" });
    await registerBacklinksOpenApi(app);
    app.decorateRequest("actor");
    app.addHook("preHandler", async (request) => {
      request.actor = member;
    });
    registerBacklinksReplyMailRoutes(app, {
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
        queries,
      }),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("lists a paginated unmatched queue with match status", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-key/backlinks/mail/messages"
        + "?limit=10&matchStatus=CANDIDATES_READY&cursor=cursor-139",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{
        id: messageId,
        threadId,
        inboundMessageId,
        matchStatus: "CANDIDATES_READY",
      }],
      nextCursor: "next-139",
      hasMore: true,
      meta: {
        websiteProjectId: "project-139",
        requestId: "request-139",
      },
    });
    expect(listInput).toEqual({
      limit: 10,
      matchStatus: "CANDIDATES_READY",
      cursor: "cursor-139",
    });
  });

  it("returns safe message and chronological thread detail DTOs", async () => {
    const message = await app.inject({
      method: "GET",
      url:
        `/api/v1/projects/project-key/backlinks/mail/messages/${messageId}`,
    });
    const thread = await app.inject({
      method: "GET",
      url:
        `/api/v1/projects/project-key/backlinks/mail/threads/${threadId}`,
    });

    expect(message.statusCode).toBe(200);
    expect(message.json()).toMatchObject({
      item: {
        id: messageId,
        body: {
          plainText: "Please share pricing.",
          sanitizedHtml: {
            trust: "SANITIZED",
            sanitized: true,
            policyVersion: "growthos-gmail-html-v1",
          },
        },
      },
    });
    expect(thread.statusCode).toBe(200);
    expect(thread.json()).toMatchObject({
      item: {
        id: threadId,
        messageCount: 1,
        messages: [{ id: messageId }],
      },
    });
    expect(message.body).not.toContain("rawObjectKey");
    expect(message.body).not.toContain("UNTRUSTED");
    expect(thread.body).not.toContain("<script");
  });

  it("rejects invalid queries, foreign projects, and project-scoped misses", async () => {
    expect((await app.inject({
      method: "GET",
      url: "/api/v1/projects/project-key/backlinks/mail/messages?limit=101",
    })).statusCode).toBe(400);
    expect((await app.inject({
      method: "GET",
      url: "/api/v1/projects/foreign/backlinks/mail/messages",
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: "GET",
      url:
        "/api/v1/projects/project-key/backlinks/mail/messages/"
        + "018f0000-0000-7000-8000-000000000999",
    })).statusCode).toBe(404);
  });
});
