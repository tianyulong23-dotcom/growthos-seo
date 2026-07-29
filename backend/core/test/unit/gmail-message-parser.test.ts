import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  GmailMessageParseError,
  gmailMessageParseErrorCodes,
  gmailMessageParserIdentity,
  gmailMessageParserLimits,
  parseGmailMimeMessage,
} from "../../src/modules/backlinks/adapters/gmail/message-parser.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/mail/${name}`, import.meta.url));

const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");

describe("BL-AI-132 Gmail MIME message parser", () => {
  it("maps multipart and encoded content to the internal MailMessage", async () => {
    const raw = fixture("complex-multipart.eml");
    const message = await parseGmailMimeMessage(raw);

    expect(message).toMatchObject({
      parser: gmailMessageParserIdentity,
      rawSizeBytes: raw.byteLength,
      rfcMessageId: "<complex@example.com>",
      inReplyToMessageId: null,
      referenceMessageIds: [],
      from: {
        address: "sender@example.com",
        displayName: "Sender",
      },
      to: [{
        address: "recipient@example.com",
        displayName: "Recipient",
      }],
      cc: [],
      replyTo: [],
      subject: "Quarterly ✓",
      sentAt: null,
      body: {
        text: "Plain body with encoded equals = sign.\n",
        html: {
          content: "<p><strong>HTML body</strong></p>",
          trust: "UNTRUSTED",
          sanitized: false,
        },
      },
    });
    expect(message.attachments).toEqual([{
      filename: "rates.txt",
      mimeType: "text/plain",
      disposition: "attachment",
      contentId: null,
      sizeBytes: Buffer.from("rate=100\n").byteLength,
      contentSha256: sha256("rate=100\n"),
      untrusted: true,
    }]);
    expect(message.attachments[0]).not.toHaveProperty("content");
    expect(message.rawContentSha256).toBe(sha256(raw));
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.attachments)).toBe(true);
  });

  it("flattens address groups and maps reply relationship headers", async () => {
    const raw = [
      "From: =?UTF-8?B?5byg5LiJ?= <Sender@Example.COM>",
      "To: Reviewers: One <one@example.com>, Two <two@example.com>;",
      "Cc: Copy <copy@example.com>",
      "Reply-To: Replies <reply@example.com>",
      "Subject: =?UTF-8?Q?Re=3A_Collaboration_=E2=9C=93?=",
      "Message-ID: <reply@example.com>",
      "In-Reply-To: <parent@example.com>",
      "References: <root@example.com> <parent@example.com>",
      "Date: Tue, 28 Jul 2026 08:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Reply body",
    ].join("\r\n");

    const message = await parseGmailMimeMessage(raw);

    expect(message).toMatchObject({
      rfcMessageId: "<reply@example.com>",
      inReplyToMessageId: "<parent@example.com>",
      referenceMessageIds: [
        "<root@example.com>",
        "<parent@example.com>",
      ],
      from: {
        address: "Sender@Example.COM",
        displayName: "张三",
      },
      to: [
        { address: "one@example.com", displayName: "One" },
        { address: "two@example.com", displayName: "Two" },
      ],
      cc: [{ address: "copy@example.com", displayName: "Copy" }],
      replyTo: [{
        address: "reply@example.com",
        displayName: "Replies",
      }],
      subject: "Re: Collaboration ✓",
      sentAt: "2026-07-28T08:00:00.000Z",
      body: {
        text: "Reply body\n",
        html: null,
      },
    });
  });

  it("keeps nested message/rfc822 content as untrusted attachment metadata", async () => {
    const message = await parseGmailMimeMessage(
      fixture("nested-message.eml"),
    );

    expect(message.subject).toBe("Outer message");
    expect(message.body.text).toBe("Outer body\n");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({
      filename: "forwarded.eml",
      mimeType: "message/rfc822",
      disposition: "attachment",
      untrusted: true,
    });
    expect(message.attachments[0]?.sizeBytes).toBeGreaterThan(0);
    expect(message.attachments[0]?.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(message.attachments[0]).not.toHaveProperty("content");
  });

  it("returns a stable MailMessage for the malformed boundary fixture", async () => {
    await expect(
      parseGmailMimeMessage(fixture("malformed-boundary.eml")),
    ).resolves.toMatchObject({
      subject: "Malformed boundary",
      body: {
        text:
          "This fixture intentionally omits the closing MIME boundary.\n",
        html: null,
      },
      attachments: [],
    });
  });

  it("rejects empty or oversized raw input before parsing", async () => {
    await expect(parseGmailMimeMessage("")).rejects.toMatchObject({
      name: "GmailMessageParseError",
      code: gmailMessageParseErrorCodes.invalidInput,
    });

    await expect(
      parseGmailMimeMessage(
        new Uint8Array(gmailMessageParserLimits.maxRawBytes + 1),
      ),
    ).rejects.toMatchObject({
      code: gmailMessageParseErrorCodes.inputTooLarge,
    });
  });

  it("converts parser resource-limit failures to a stable error", async () => {
    const raw = [
      `X-Oversized: ${"a".repeat(
        gmailMessageParserLimits.maxHeadersBytes,
      )}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body",
    ].join("\r\n");

    await expect(parseGmailMimeMessage(raw)).rejects.toBeInstanceOf(
      GmailMessageParseError,
    );
    await expect(parseGmailMimeMessage(raw)).rejects.toMatchObject({
      code: gmailMessageParseErrorCodes.parseFailed,
    });
  });
});
