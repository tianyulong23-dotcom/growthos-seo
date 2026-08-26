import type { gmail_v1 } from "@googleapis/gmail";
import { describe, expect, it, vi } from "vitest";

import {
  GoogleGmailProviderClient,
} from "../../src/modules/backlinks/adapters/gmail/google-gmail-provider-client.js";
import {
  GoogleAuthError,
  googleAuthFailureCodes,
} from "../../src/modules/backlinks/ports/google-auth.port.js";
import {
  GmailSendProviderError,
} from "../../src/modules/backlinks/adapters/gmail/send-client.js";

const input = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
  gmailConnectionId: "018f0000-0000-7000-8000-000000000004",
  actorId: "worker-google-gmail-query",
  sendIntentId: "018f0000-0000-7000-8000-000000000119",
  rfcMessageId:
    "<018f0000-0000-7000-8000-000000000119.1@send.growthos.invalid>",
};

const createClient = (list: ReturnType<typeof vi.fn>) =>
  ({
    users: {
      messages: { list },
    },
  }) as unknown as gmail_v1.Gmail;

describe("Google Gmail sent-message query", () => {
  it("queries Sent by the exact RFC Message-ID and returns provider evidence", async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        messages: [{ id: "gmail-message-119", threadId: "gmail-thread-119" }],
      },
    });
    const resolveAccessToken = vi.fn().mockResolvedValue("access-token");
    const client = new GoogleGmailProviderClient({
      resolveAccessToken,
      createClient: () => createClient(list),
    });

    await expect(client.findByRfcMessageId(input)).resolves.toEqual({
      kind: "found",
      providerMessageId: "gmail-message-119",
      providerThreadId: "gmail-thread-119",
      evidenceReference: "gmail:message/gmail-message-119",
    });
    expect(resolveAccessToken).toHaveBeenCalledWith(input.gmailConnectionId);
    expect(list).toHaveBeenCalledWith({
      userId: "me",
      q: `in:sent rfc822msgid:${input.rfcMessageId}`,
      maxResults: 2,
    });
  });

  it("returns not_found only after a successful empty Gmail response", async () => {
    const client = new GoogleGmailProviderClient({
      resolveAccessToken: vi.fn().mockResolvedValue("access-token"),
      createClient: () => createClient(
        vi.fn().mockResolvedValue({ data: { messages: [] } }),
      ),
    });

    await expect(client.findByRfcMessageId(input)).resolves.toEqual({
      kind: "not_found",
    });
  });

  it("keeps transport and authorization failures inconclusive", async () => {
    const authorizationError = Object.assign(new Error("unauthorized"), {
      response: { status: 401 },
    });
    const client = new GoogleGmailProviderClient({
      resolveAccessToken: vi.fn().mockResolvedValue("access-token"),
      createClient: () => createClient(
        vi.fn().mockRejectedValue(authorizationError),
      ),
    });

    await expect(client.findByRfcMessageId(input)).resolves.toEqual({
      kind: "inconclusive",
      code: "GMAIL_SEND_RECONCILIATION_AUTH_REQUIRED",
    });
  });
});

describe("Google Gmail send authentication", () => {
  it("preserves a token refresh failure before provider dispatch", async () => {
    const send = vi.fn();
    const error = new GoogleAuthError({
      operation: "refresh",
      code: googleAuthFailureCodes.temporaryFailure,
      retryable: true,
    });
    const client = new GoogleGmailProviderClient({
      resolveAccessToken: vi.fn().mockRejectedValue(error),
      createClient: () => ({
        users: { messages: { send } },
      }) as unknown as gmail_v1.Gmail,
    });

    await expect(client.send({
      gmailConnectionId: input.gmailConnectionId,
      userId: "me",
      requestBody: { raw: "bWltZQ" },
    })).rejects.toMatchObject<GmailSendProviderError>({
      failure: {
        kind: "auth",
        authCode: googleAuthFailureCodes.temporaryFailure,
      },
    });
    expect(send).not.toHaveBeenCalled();
  });
});
