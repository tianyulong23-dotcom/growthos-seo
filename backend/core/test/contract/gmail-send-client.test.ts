import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  GmailSendClientAdapter,
  GmailSendClientAdapterError,
  GmailSendProviderError,
  gmailSendClientAdapterFailureCodes,
  gmailSendClientConfigSchema,
  type GmailSendProviderClient,
} from "../../src/modules/backlinks/adapters/gmail/send-client.js";
import {
  gmailSendFailureCodes,
  type GmailSendCommand,
  type GmailSendPort,
} from "../../src/modules/backlinks/ports/gmail-send.port.js";

const command: GmailSendCommand = {
  gmailConnectionId: "018f0000-0000-7000-8000-000000000217",
  rawBase64Url: Buffer.from(
    "Message-ID: <send-intent-217-attempt-1@growthos.test>\r\n"
      + "\r\nApproved body.",
  ).toString("base64url"),
  gmailThreadId: "gmail-thread-existing",
  rfcMessageId: "<send-intent-217-attempt-1@growthos.test>",
  requestId: "send-intent-217-attempt-1",
};

const clientReturning = (response: unknown) => {
  const send = vi.fn(async () => response);
  const client: GmailSendProviderClient = { send };
  return { client, send };
};

describe("BL-AI-117 Gmail Send Real Adapter shell", () => {
  it("defaults off and never invokes the injected provider client", async () => {
    const fake = clientReturning({
      status: 200,
      data: { id: "gmail-message-217" },
    });
    const adapter = new GmailSendClientAdapter({ client: fake.client });

    await expect(adapter.send(command)).rejects.toMatchObject({
      code: gmailSendClientAdapterFailureCodes.disabled,
      retryable: false,
    });
    expect(fake.send).not.toHaveBeenCalled();
    expect(gmailSendClientConfigSchema.parse({})).toEqual({
      enabled: false,
    });
    expectTypeOf(adapter).toMatchTypeOf<GmailSendPort>();

    const source = readFileSync(new URL(
      "../../src/modules/backlinks/adapters/gmail/send-client.ts",
      import.meta.url,
    ), "utf8");
    expect(source).not.toMatch(
      /\bfetch\s*\(|undici|axios|@googleapis\/gmail|google-auth-library/iu,
    );
  });

  it("requires an injected provider client when explicitly enabled", () => {
    expect(() => new GmailSendClientAdapter({
      config: { enabled: true },
    })).toThrowError(GmailSendClientAdapterError);
  });

  it("passes only connection-scoped raw MIME to users.messages.send shape", async () => {
    const fake = clientReturning({
      status: 200,
      data: {
        id: "gmail-message-217",
        threadId: "gmail-thread-217",
      },
    });
    const adapter = new GmailSendClientAdapter({
      config: { enabled: true },
      client: fake.client,
    });

    await expect(adapter.send(command)).resolves.toEqual({
      kind: "accepted",
      providerMessageId: "gmail-message-217",
      providerThreadId: "gmail-thread-217",
    });
    expect(fake.send).toHaveBeenCalledOnce();
    expect(fake.send).toHaveBeenCalledWith({
      gmailConnectionId: command.gmailConnectionId,
      userId: "me",
      requestBody: {
        raw: command.rawBase64Url,
        threadId: command.gmailThreadId,
      },
    });
    expect(JSON.stringify(fake.send.mock.calls)).not.toMatch(
      /requestId|rfcMessageId|accessToken|refreshToken|recipient|subject|bodyText/,
    );
    expect(JSON.stringify(adapter)).not.toContain(command.rawBase64Url);
  });

  it.each([
    [400, undefined, gmailSendFailureCodes.invalidRequest, false, undefined],
    [401, undefined, gmailSendFailureCodes.preRequestFailed, true, undefined],
    [403, "scope", gmailSendFailureCodes.forbidden, false, undefined],
    [403, "quota", gmailSendFailureCodes.rateLimited, true, 120],
    [429, undefined, gmailSendFailureCodes.rateLimited, true, 120],
  ] as const)(
    "maps explicit HTTP %s responses without an unsafe retry decision",
    async (status, reason, code, retryable, retryAfterSeconds) => {
      const fake = clientReturning({
        status,
        reason,
        retryAfterSeconds,
      });
      const adapter = new GmailSendClientAdapter({
        config: { enabled: true },
        client: fake.client,
      });

      await expect(adapter.send(command)).resolves.toEqual({
        kind: "definitely_not_sent",
        code,
        retryable,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      });
    },
  );

  it("maps a possible provider 5xx acceptance to unknown", async () => {
    const fake = clientReturning({ status: 503 });
    const adapter = new GmailSendClientAdapter({
      config: { enabled: true },
      client: fake.client,
    });

    await expect(adapter.send(command)).resolves.toEqual({
      kind: "acceptance_unknown",
      code: gmailSendFailureCodes.provider5xx,
    });
  });

  it("retries only failures proven to occur before request dispatch", async () => {
    const send = vi.fn(async () => {
      throw new GmailSendProviderError({
        kind: "transport",
        requestDispatched: false,
      });
    });
    const adapter = new GmailSendClientAdapter({
      config: { enabled: true },
      client: { send },
    });

    await expect(adapter.send(command)).resolves.toEqual({
      kind: "definitely_not_sent",
      code: gmailSendFailureCodes.preRequestFailed,
      retryable: true,
    });
  });

  it.each([
    [
      new GmailSendProviderError({
        kind: "timeout",
        requestDispatched: true,
      }),
      gmailSendFailureCodes.timeout,
    ],
    [
      new GmailSendProviderError({
        kind: "transport",
        requestDispatched: true,
      }),
      gmailSendFailureCodes.ambiguous,
    ],
    [new Error("unclassified provider failure"), gmailSendFailureCodes.ambiguous],
  ] as const)(
    "keeps dispatched or unclassified failures acceptance-unknown",
    async (providerError, code) => {
      const adapter = new GmailSendClientAdapter({
        config: { enabled: true },
        client: {
          send: async () => {
            throw providerError;
          },
        },
      });

      await expect(adapter.send(command)).resolves.toEqual({
        kind: "acceptance_unknown",
        code,
      });
    },
  );

  it("maps malformed success responses to an ambiguous result", async () => {
    const fake = clientReturning({
      status: 200,
      data: { id: " " },
    });
    const adapter = new GmailSendClientAdapter({
      config: { enabled: true },
      client: fake.client,
    });

    await expect(adapter.send(command)).resolves.toEqual({
      kind: "acceptance_unknown",
      code: gmailSendFailureCodes.ambiguous,
    });
  });
});
