import { describe, expect, it } from "vitest";

import {
  createReplyMailQuery,
  type ReplyMailContentReader,
  type ReplyMailQueryClient,
} from "../../src/modules/backlinks/application/queries/reply-mail.query.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../src/modules/backlinks/domain/errors/backlink-error.js";

const messageId = "018f0000-0000-7000-8000-000000000139";
const olderMessageId = "018f0000-0000-7000-8000-000000000239";
const threadId = "018f0000-0000-7000-8000-000000000339";
const inboundMessageId = "018f0000-0000-7000-8000-000000000439";
const opportunityId = "018f0000-0000-7000-8000-000000000539";
const receivedAt = "2026-07-29T01:39:00.000Z";
const context = {
  actor: createActorContext({
    userId: "user-139",
    sessionId: "session-139",
    roles: ["member"],
  }),
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

const messageRow = Object.freeze({
  id: messageId,
  threadId,
  direction: "INBOUND",
  fromAddress: "reply@example.test",
  toAddresses: ["owner@example.test"],
  ccAddresses: [],
  subject: "Re: GrowthOS collaboration",
  receivedAt: new Date(receivedAt),
  parseStatus: "PARSED",
  version: 2,
  inboundMessageId,
  matchStatus: "MATCH_CONFIRMED",
  matchedOpportunityId: opportunityId,
  rawObjectKey: "mail/project-139/raw-139",
});

const safeContent: Awaited<ReturnType<ReplyMailContentReader["read"]>> =
  Object.freeze({
    plainText: "Thanks, please send the next steps.",
    sanitizedHtml: Object.freeze({
      content: "<p>Thanks, please send the next steps.</p>",
      trust: "SANITIZED",
      sanitized: true,
      policyVersion: "growthos-gmail-html-v1",
    }),
  });

function clientWith(
  results: readonly (readonly Record<string, unknown>[])[],
  calls: { text: string; values: readonly unknown[] }[],
): ReplyMailQueryClient {
  let index = 0;
  return {
    async query(text, values = []) {
      calls.push({ text, values });
      const rows = results[index];
      index += 1;
      return { rows: rows ?? [] };
    },
  };
}

describe("BL-AI-139 Reply mail query", () => {
  it("lists a project-scoped page with stable pagination and match status", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const query = createReplyMailQuery({
      client: clientWith([[
        messageRow,
        {
          ...messageRow,
          id: olderMessageId,
          receivedAt: new Date("2026-07-28T01:39:00.000Z"),
          inboundMessageId: null,
          matchStatus: null,
          matchedOpportunityId: null,
        },
      ]], calls),
      contentReader: { read: async () => safeContent },
    });

    const page = await query.listMailMessages(context, {
      limit: 1,
      matchStatus: "MATCH_CONFIRMED",
    });

    expect(page).toEqual({
      items: [{
        id: messageId,
        threadId,
        direction: "INBOUND",
        fromAddress: "reply@example.test",
        toAddresses: ["owner@example.test"],
        ccAddresses: [],
        subject: "Re: GrowthOS collaboration",
        receivedAt,
        parseStatus: "PARSED",
        version: 2,
        inboundMessageId,
        matchStatus: "MATCH_CONFIRMED",
        matchedOpportunityId: opportunityId,
      }],
      hasMore: true,
      nextCursor: Buffer.from(
        JSON.stringify([receivedAt, messageId]),
      ).toString("base64url"),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.values).toEqual([
      "organization-139",
      "workspace-139",
      "project-139",
      "MATCH_CONFIRMED",
      null,
      null,
      2,
    ]);
    expect(calls[0]?.text).toContain("website_project_id");
  });

  it("returns only plain text and explicitly sanitized HTML for detail", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const reads: unknown[] = [];
    const query = createReplyMailQuery({
      client: clientWith([[messageRow]], calls),
      contentReader: {
        async read(input) {
          reads.push(input);
          return safeContent;
        },
      },
    });

    const detail = await query.getMailMessage(context, messageId);

    expect(detail).toMatchObject({
      id: messageId,
      body: safeContent,
      matchStatus: "MATCH_CONFIRMED",
      matchedOpportunityId: opportunityId,
    });
    expect(detail).not.toHaveProperty("rawObjectKey");
    expect(JSON.stringify(detail)).not.toContain("raw-139");
    expect(reads).toEqual([{
      organizationId: "organization-139",
      workspaceId: "workspace-139",
      websiteProjectId: "project-139",
      rawObjectKey: "mail/project-139/raw-139",
    }]);
  });

  it("returns a project-scoped thread in chronological order", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const query = createReplyMailQuery({
      client: clientWith([
        [{
          id: threadId,
          latestMessageAt: new Date(receivedAt),
          messageCount: 1,
          version: 3,
        }],
        [messageRow],
      ], calls),
      contentReader: { read: async () => safeContent },
    });

    const thread = await query.getMailThread(context, threadId);

    expect(thread).toMatchObject({
      id: threadId,
      latestMessageAt: receivedAt,
      messageCount: 1,
      version: 3,
      messages: [{
        id: messageId,
        body: safeContent,
      }],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.values).toEqual([
      "organization-139",
      "workspace-139",
      "project-139",
      threadId,
    ]);
    expect(calls[1]?.text).toContain("ORDER BY");
    expect(calls[1]?.text).toContain("ASC");
  });

  it("rejects invalid cursors and foreign-project misses without reading content", async () => {
    let queryCount = 0;
    let readCount = 0;
    const query = createReplyMailQuery({
      client: {
        async query() {
          queryCount += 1;
          return { rows: [] };
        },
      },
      contentReader: {
        async read() {
          readCount += 1;
          return safeContent;
        },
      },
    });

    await expect(query.listMailMessages(context, {
      limit: 25,
      cursor: "not-a-cursor",
    })).rejects.toMatchObject({
      code: backlinkErrorCodes.invalidRequest,
    } satisfies Partial<BacklinkError>);
    await expect(query.getMailMessage(context, messageId))
      .rejects.toMatchObject({ code: backlinkErrorCodes.notFound });
    await expect(query.getMailThread(context, threadId))
      .rejects.toMatchObject({ code: backlinkErrorCodes.notFound });
    expect(queryCount).toBe(2);
    expect(readCount).toBe(0);
  });
});
