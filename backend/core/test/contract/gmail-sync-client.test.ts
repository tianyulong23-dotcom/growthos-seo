import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  GmailSyncClientAdapter,
  GmailSyncClientAdapterError,
  GmailSyncProviderError,
  gmailSyncClientAdapterFailureCodes,
  gmailSyncClientConfigSchema,
  type GmailSyncProviderClient,
} from "../../src/modules/backlinks/adapters/gmail/sync-client.js";
import {
  type GmailHistoryInput,
  type GmailInitialSyncInput,
  type GmailMessageInput,
  type GmailSyncPort,
  type GmailWatchInput,
} from "../../src/modules/backlinks/ports/gmail-sync.port.js";

const gmailConnectionId = "018f0000-0000-7000-8000-000000000127";
const receivedAfter = "2026-07-21T06:00:00.000Z";

const initialInput: GmailInitialSyncInput = {
  gmailConnectionId,
  receivedAfter,
  pageToken: "initial-page-1",
  pageSize: 100,
};

const historyInput: GmailHistoryInput = {
  gmailConnectionId,
  startHistoryId: "600",
  pageToken: "history-page-1",
  pageSize: 100,
};

const messageInput: GmailMessageInput = {
  gmailConnectionId,
  providerMessageId: "gmail-message-127",
};

const watchInput: GmailWatchInput = {
  gmailConnectionId,
  topicName: "projects/growthos/topics/gmail-mail-sync",
};

const createClient = () => {
  const listInitial = vi.fn(async () => ({
    historyId: "600",
    messages: [{
      id: "gmail-message-127",
      threadId: "gmail-thread-127",
    }],
    nextPageToken: "initial-page-2",
  }));
  const listHistory = vi.fn(async () => ({
    historyId: "611",
    history: [{
      id: "610",
      messagesAdded: [{
        message: {
          id: "gmail-message-127",
          threadId: "gmail-thread-127",
        },
      }],
    }, {
      id: "611",
      messagesAdded: [{
        message: {
          id: "gmail-message-127",
          threadId: "gmail-thread-127",
        },
      }, {
        message: {
          id: "gmail-message-128",
          threadId: "gmail-thread-128",
        },
      }],
    }],
    nextPageToken: "history-page-2",
  }));
  const getMessage = vi.fn(async () => ({
    id: "gmail-message-127",
    threadId: "gmail-thread-127",
    historyId: "611",
    internalDate: String(Date.parse("2026-07-28T06:00:00.000Z")),
    sizeEstimate: 64,
    raw: `${Buffer.from(
      "MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nReply.",
    ).toString("base64url")}==`,
  }));
  const watch = vi.fn(async () => ({
    historyId: "612",
    expiration: String(Date.parse("2026-08-04T06:00:00.000Z")),
  }));
  const client: GmailSyncProviderClient = {
    listInitial,
    listHistory,
    getMessage,
    watch,
  };

  return {
    client,
    listInitial,
    listHistory,
    getMessage,
    watch,
  };
};

const enabledAdapter = (client: GmailSyncProviderClient) =>
  new GmailSyncClientAdapter({
    config: { enabled: true },
    client,
  });

describe("BL-AI-127 Gmail History Real Adapter shell", () => {
  it("defaults off and never invokes the injected provider client", async () => {
    const fake = createClient();
    const adapter = new GmailSyncClientAdapter({ client: fake.client });

    await expect(adapter.listInitialMessages(initialInput)).rejects
      .toMatchObject({
        code: gmailSyncClientAdapterFailureCodes.disabled,
        retryable: false,
      });
    await expect(adapter.listHistory(historyInput)).rejects.toMatchObject({
      code: gmailSyncClientAdapterFailureCodes.disabled,
      retryable: false,
    });
    await expect(adapter.getMessage(messageInput)).rejects.toMatchObject({
      code: gmailSyncClientAdapterFailureCodes.disabled,
      retryable: false,
    });
    await expect(adapter.watch(watchInput)).rejects.toMatchObject({
      code: gmailSyncClientAdapterFailureCodes.disabled,
      retryable: false,
    });

    expect(fake.listInitial).not.toHaveBeenCalled();
    expect(fake.listHistory).not.toHaveBeenCalled();
    expect(fake.getMessage).not.toHaveBeenCalled();
    expect(fake.watch).not.toHaveBeenCalled();
    expect(gmailSyncClientConfigSchema.parse({})).toEqual({
      enabled: false,
    });
    expectTypeOf(adapter).toMatchTypeOf<GmailSyncPort>();

    const source = readFileSync(new URL(
      "../../src/modules/backlinks/adapters/gmail/sync-client.ts",
      import.meta.url,
    ), "utf8");
    expect(source).not.toMatch(
      /\bfetch\s*\(|undici|axios|@googleapis\/gmail|google-auth-library|accessToken|refreshToken/iu,
    );
  });

  it("requires an injected provider client when explicitly enabled", () => {
    expect(() => new GmailSyncClientAdapter({
      config: { enabled: true },
    })).toThrowError(GmailSyncClientAdapterError);
  });

  it("maps initial page tokens and the snapshot historyId without SDK DTO leakage", async () => {
    const fake = createClient();
    const adapter = enabledAdapter(fake.client);

    await expect(adapter.listInitialMessages(initialInput)).resolves.toEqual({
      snapshotHistoryId: "600",
      messages: [{
        providerMessageId: "gmail-message-127",
        providerThreadId: "gmail-thread-127",
      }],
      nextPageToken: "initial-page-2",
    });
    expect(fake.listInitial).toHaveBeenCalledWith({
      gmailConnectionId,
      userId: "me",
      q: `after:${Math.floor(Date.parse(receivedAfter) / 1_000)}`,
      pageToken: "initial-page-1",
      maxResults: 100,
    });
  });

  it("maps and de-duplicates messageAdded history records deterministically", async () => {
    const fake = createClient();
    const adapter = enabledAdapter(fake.client);

    await expect(adapter.listHistory(historyInput)).resolves.toEqual({
      kind: "page",
      latestHistoryId: "611",
      messages: [{
        providerMessageId: "gmail-message-127",
        providerThreadId: "gmail-thread-127",
        historyId: "611",
      }, {
        providerMessageId: "gmail-message-128",
        providerThreadId: "gmail-thread-128",
        historyId: "611",
      }],
      nextPageToken: "history-page-2",
    });
    expect(fake.listHistory).toHaveBeenCalledWith({
      gmailConnectionId,
      userId: "me",
      startHistoryId: "600",
      historyTypes: ["messageAdded"],
      pageToken: "history-page-1",
      maxResults: 100,
    });
  });

  it("maps a provider 404 to the explicit history_expired contract", async () => {
    const adapter = enabledAdapter({
      ...createClient().client,
      listHistory: async () => {
        throw new GmailSyncProviderError({
          kind: "http_response",
          httpStatus: 404,
        });
      },
    });

    await expect(adapter.listHistory(historyInput)).resolves.toEqual({
      kind: "history_expired",
      startHistoryId: "600",
    });
  });

  it("maps raw message metadata and removes provider base64url padding", async () => {
    const fake = createClient();
    const adapter = enabledAdapter(fake.client);
    const result = await adapter.getMessage(messageInput);

    expect(result).toEqual({
      providerMessageId: "gmail-message-127",
      providerThreadId: "gmail-thread-127",
      historyId: "611",
      receivedAt: "2026-07-28T06:00:00.000Z",
      rawBase64Url: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
      estimatedSizeBytes: 64,
    });
    expect(fake.getMessage).toHaveBeenCalledWith({
      gmailConnectionId,
      userId: "me",
      id: "gmail-message-127",
      format: "raw",
    });
  });

  it("maps watch historyId and millisecond expiration to ISO time", async () => {
    const fake = createClient();
    const adapter = enabledAdapter(fake.client);

    await expect(adapter.watch(watchInput)).resolves.toEqual({
      historyId: "612",
      expiresAt: "2026-08-04T06:00:00.000Z",
    });
    expect(fake.watch).toHaveBeenCalledWith({
      gmailConnectionId,
      userId: "me",
      requestBody: {
        topicName: watchInput.topicName,
      },
    });
  });

  it("uses stable adapter errors for malformed or failed provider responses", async () => {
    const malformed = enabledAdapter({
      ...createClient().client,
      listInitial: async () => ({
        historyId: "0",
        messages: [{ id: "missing-thread" }],
      }),
    });
    const failed = enabledAdapter({
      ...createClient().client,
      watch: async () => {
        throw new GmailSyncProviderError({
          kind: "http_response",
          httpStatus: 503,
        });
      },
    });

    await expect(malformed.listInitialMessages(initialInput)).rejects
      .toMatchObject({
        code: gmailSyncClientAdapterFailureCodes.invalidResponse,
        retryable: false,
      });
    await expect(failed.watch(watchInput)).rejects.toMatchObject({
      code: gmailSyncClientAdapterFailureCodes.providerFailure,
      retryable: false,
    });
  });
});
