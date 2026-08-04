import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  FakeGmailSendAdapter,
} from "../../src/modules/backlinks/adapters/gmail/send-fake.adapter.js";
import {
  gmailSendCommandSchema,
  gmailSendFailureCodes,
  gmailSendResultSchema,
  type GmailSendPort,
} from "../../src/modules/backlinks/ports/gmail-send.port.js";

const command = {
  gmailConnectionId: "018f0000-0000-7000-8000-000000000201",
  rawBase64Url: Buffer.from(
    "MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nApproved body.",
  ).toString("base64url"),
  gmailThreadId: "thread-existing",
  rfcMessageId: "<send-intent-201-attempt-1@growthos.test>",
  requestId: "send-intent-201-attempt-1",
} as const;

describe("BL-AI-116 GmailSendPort and Fake Send Adapter contract", () => {
  it("returns a provider-accepted result without retaining raw MIME", async () => {
    const adapter = new FakeGmailSendAdapter({
      scenario: {
        kind: "success",
        providerMessageId: "gmail-message-201",
        providerThreadId: "gmail-thread-201",
      },
    });
    const port: GmailSendPort = adapter;

    const result = await port.send(command);

    expect(gmailSendCommandSchema.parse(command)).toEqual(command);
    expect(gmailSendResultSchema.parse(result)).toEqual({
      kind: "accepted",
      providerMessageId: "gmail-message-201",
      providerThreadId: "gmail-thread-201",
    });
    expect(adapter.calls).toBe(1);
    expect(JSON.stringify(adapter)).not.toContain(command.rawBase64Url);
  });

  it("maps an explicit 429 response to definitely-not-sent", async () => {
    const result = await new FakeGmailSendAdapter({
      scenario: {
        kind: "rate_limited",
        retryAfterSeconds: 60,
      },
    }).send(command);

    expect(result).toEqual({
      kind: "definitely_not_sent",
      code: gmailSendFailureCodes.rateLimited,
      retryable: true,
      retryAfterSeconds: 60,
    });
    expect(gmailSendResultSchema.parse(result)).toEqual(result);
  });

  it("maps a 5xx response to acceptance-unknown", async () => {
    const result = await new FakeGmailSendAdapter({
      scenario: { kind: "server_failure", httpStatus: 503 },
    }).send(command);

    expect(result).toEqual({
      kind: "acceptance_unknown",
      code: gmailSendFailureCodes.provider5xx,
    });
    expect(gmailSendResultSchema.parse(result)).toEqual(result);
  });

  it("maps a post-request timeout to acceptance-unknown", async () => {
    const result = await new FakeGmailSendAdapter({
      scenario: { kind: "timeout" },
    }).send(command);

    expect(result).toEqual({
      kind: "acceptance_unknown",
      code: gmailSendFailureCodes.timeout,
    });
  });

  it("preserves an ambiguous provider result without making it retryable", async () => {
    const result = await new FakeGmailSendAdapter({
      scenario: { kind: "ambiguous" },
    }).send(command);

    expect(result).toEqual({
      kind: "acceptance_unknown",
      code: gmailSendFailureCodes.ambiguous,
    });
    expect(result).not.toHaveProperty("retryable");
  });

  it("keeps bounce as a post-acceptance delivery fact", async () => {
    const adapter = new FakeGmailSendAdapter({
      scenario: {
        kind: "bounce",
        bounceClass: "hard",
        diagnosticCode: "5.1.1",
      },
    });

    const result = await adapter.send(command);

    expect(result).toMatchObject({
      kind: "accepted",
      providerMessageId: "fake-gmail-message-1",
    });
    expect(adapter.deliveryFacts).toEqual([{
      kind: "bounce",
      providerMessageId: "fake-gmail-message-1",
      providerThreadId: "fake-gmail-thread-1",
      bounceClass: "hard",
      diagnosticCode: "5.1.1",
    }]);
    expect(gmailSendResultSchema.safeParse({
      kind: "bounce",
      providerMessageId: "fake-gmail-message-1",
    }).success).toBe(false);
  });

  it("rejects malformed commands and provider SDK leakage", () => {
    expect(gmailSendCommandSchema.safeParse({
      ...command,
      rawBase64Url: "contains=padding",
    }).success).toBe(false);
    expect(gmailSendCommandSchema.safeParse({
      ...command,
      rfcMessageId: "<approved@growthos.test>\r\nBcc: attacker@example.test",
    }).success).toBe(false);
    expect(gmailSendCommandSchema.safeParse({
      ...command,
      accessToken: "plaintext-token",
    }).success).toBe(false);

    const portSource = readFileSync(new URL(
      "../../src/modules/backlinks/ports/gmail-send.port.ts",
      import.meta.url,
    ), "utf8");
    expect(portSource).not.toMatch(
      /@googleapis\/gmail|\bgmail_v1\b|\bGaxiosError\b|accessToken|refreshToken/,
    );
    expectTypeOf(new FakeGmailSendAdapter()).toMatchTypeOf<GmailSendPort>();
  });
});
