import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  FakeGmailSyncAdapter,
} from "../../src/modules/backlinks/adapters/gmail/sync-fake.adapter.js";
import {
  gmailHistoryInputSchema,
  gmailHistoryResultSchema,
  gmailInitialSyncInputSchema,
  gmailInitialSyncResultSchema,
  gmailMessageInputSchema,
  gmailRawMessageSchema,
  gmailWatchInputSchema,
  gmailWatchResultSchema,
  type GmailSyncPort,
} from "../../src/modules/backlinks/ports/gmail-sync.port.js";

const gmailConnectionId = "018f0000-0000-7000-8000-000000000126";

const rawMessage = {
  providerMessageId: "gmail-message-126",
  providerThreadId: "gmail-thread-126",
  historyId: "510",
  receivedAt: "2026-07-28T06:00:00.000Z",
  rawBase64Url: Buffer.from(
    "MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nReply.",
  ).toString("base64url"),
  estimatedSizeBytes: 60,
} as const;

const adapterOptions = {
  initialResult: {
    snapshotHistoryId: "500",
    messages: [{
      providerMessageId: rawMessage.providerMessageId,
      providerThreadId: rawMessage.providerThreadId,
    }],
    nextPageToken: "initial-page-2",
  },
  historyResult: {
    kind: "page",
    latestHistoryId: "510",
    messages: [{
      providerMessageId: rawMessage.providerMessageId,
      providerThreadId: rawMessage.providerThreadId,
      historyId: rawMessage.historyId,
    }],
    nextPageToken: "history-page-2",
  },
  messages: [rawMessage],
  watchResult: {
    historyId: "511",
    expiresAt: "2026-08-04T06:00:00.000Z",
  },
} as const;

describe("BL-AI-126 GmailSyncPort and Fake Sync Adapter contract", () => {
  it("supports initial sync pagination with a stable snapshot historyId", async () => {
    const adapter = new FakeGmailSyncAdapter(adapterOptions);
    const port: GmailSyncPort = adapter;
    const input = {
      gmailConnectionId,
      receivedAfter: "2026-07-21T06:00:00.000Z",
      pageSize: 100,
    } as const;

    const result = await port.listInitialMessages(input);

    expect(gmailInitialSyncInputSchema.parse(input)).toEqual(input);
    expect(gmailInitialSyncResultSchema.parse(result)).toEqual(
      adapterOptions.initialResult,
    );
    expect(adapter.calls.initial).toEqual([input]);
  });

  it("supports incremental history pagination", async () => {
    const adapter = new FakeGmailSyncAdapter(adapterOptions);
    const input = {
      gmailConnectionId,
      startHistoryId: "500",
      pageToken: "history-page-1",
      pageSize: 100,
    } as const;

    const result = await adapter.listHistory(input);

    expect(gmailHistoryInputSchema.parse(input)).toEqual(input);
    expect(gmailHistoryResultSchema.parse(result)).toEqual(
      adapterOptions.historyResult,
    );
    expect(adapter.calls.history).toEqual([input]);
  });

  it("returns history_expired as an explicit recovery decision", async () => {
    const adapter = new FakeGmailSyncAdapter({
      ...adapterOptions,
      historyResult: {
        kind: "history_expired",
        startHistoryId: "400",
      },
    });

    const result = await adapter.listHistory({
      gmailConnectionId,
      startHistoryId: "400",
      pageSize: 100,
    });

    expect(result).toEqual({
      kind: "history_expired",
      startHistoryId: "400",
    });
    expect(gmailHistoryResultSchema.parse(result)).toEqual(result);
    expect(result).not.toHaveProperty("retryable");
  });

  it("fetches one raw message without parsing MIME or HTML", async () => {
    const adapter = new FakeGmailSyncAdapter(adapterOptions);
    const input = {
      gmailConnectionId,
      providerMessageId: rawMessage.providerMessageId,
    } as const;

    const result = await adapter.getMessage(input);

    expect(gmailMessageInputSchema.parse(input)).toEqual(input);
    expect(gmailRawMessageSchema.parse(result)).toEqual(rawMessage);
    expect(result).not.toHaveProperty("bodyText");
    expect(result).not.toHaveProperty("bodyHtml");
    expect(adapter.calls.message).toEqual([input]);
  });

  it("renews a watch with a stable historyId and ISO expiration", async () => {
    const adapter = new FakeGmailSyncAdapter(adapterOptions);
    const input = {
      gmailConnectionId,
      topicName: "projects/growthos/topics/gmail-mail-sync",
    } as const;

    const result = await adapter.watch(input);

    expect(gmailWatchInputSchema.parse(input)).toEqual(input);
    expect(gmailWatchResultSchema.parse(result)).toEqual(
      adapterOptions.watchResult,
    );
    expect(adapter.calls.watch).toEqual([input]);
  });

  it("rejects malformed inputs and keeps provider SDKs and tokens outside the Port", () => {
    expect(gmailHistoryInputSchema.safeParse({
      gmailConnectionId,
      startHistoryId: "0",
      pageSize: 100,
    }).success).toBe(false);
    expect(gmailInitialSyncInputSchema.safeParse({
      gmailConnectionId,
      receivedAfter: "not-a-timestamp",
      pageSize: 100,
    }).success).toBe(false);
    expect(gmailMessageInputSchema.safeParse({
      gmailConnectionId,
      providerMessageId: " ",
    }).success).toBe(false);
    expect(gmailWatchInputSchema.safeParse({
      gmailConnectionId,
      topicName: "gmail-mail-sync",
      accessToken: "plaintext-token",
    }).success).toBe(false);

    const source = readFileSync(new URL(
      "../../src/modules/backlinks/ports/gmail-sync.port.ts",
      import.meta.url,
    ), "utf8");
    expect(source).not.toMatch(
      /@googleapis\/gmail|\bgmail_v1\b|\bGaxiosError\b|accessToken|refreshToken/,
    );
    expectTypeOf(new FakeGmailSyncAdapter(adapterOptions))
      .toMatchTypeOf<GmailSyncPort>();
  });
});
