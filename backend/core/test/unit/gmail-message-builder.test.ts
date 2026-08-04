import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  GmailMimeBuildError,
  buildGmailMimeMessage,
  gmailMimeBuildErrorCodes,
  gmailMimeMessageVersion,
  gmailMimeSubjectMaxCharacters,
} from "../../src/modules/backlinks/adapters/gmail/message-builder.js";
import type { AuthorizedSendIdentity } from "../../src/modules/backlinks/domain/sending/identity.js";

const authorizedIdentity: AuthorizedSendIdentity = Object.freeze({
  from: Object.freeze({
    identityId: "018f0000-0000-7000-8000-000000000101",
    emailAddress: "owner@example.test",
    displayName: "增长团队",
    identityVersion: 3,
  }),
  replyTo: Object.freeze({
    identityId: "018f0000-0000-7000-8000-000000000102",
    emailAddress: "reply@example.test",
    identityVersion: 2,
  }),
});

const buildInput = () => ({
  identity: authorizedIdentity,
  recipient: {
    emailAddress: "editor@example.test",
    displayName: "编辑团队",
  },
  rfcMessageId:
    "<018f0000-0000-7000-8000-000000000118.1@send.growthos.invalid>",
  subject: "合作提案：GrowthOS 外链研究",
  bodyText: "您好，\n这是经过人工批准的 Unicode 正文。",
});

describe("BL-AI-113 Gmail MIME message builder", () => {
  it("builds an RFC 5322 message with CRLF, Unicode MIME encoding, and Gmail base64url", async () => {
    const result = await buildGmailMimeMessage(buildInput());
    const source = result.raw.toString("utf8");
    const body = source.split("\r\n\r\n", 2)[1] ?? "";

    expect(result).toMatchObject({
      mimeVersion: gmailMimeMessageVersion,
      contentType: "message/rfc822",
      sizeBytes: result.raw.length,
    });
    expect(Buffer.from(result.rawBase64Url, "base64url")).toEqual(result.raw);
    expect(source).toContain("\r\n");
    expect(source.replaceAll("\r\n", "")).not.toContain("\n");
    expect(source).toContain("MIME-Version: 1.0");
    expect(source).toContain("Content-Type: text/plain; charset=utf-8");
    expect(source).toContain("Content-Transfer-Encoding: base64");
    expect(source).toMatch(/From: =\?UTF-8\?B\?.+owner@example\.test/);
    expect(source).toMatch(/To: =\?UTF-8\?B\?.+editor@example\.test/);
    expect(source).toContain("Reply-To: reply@example.test");
    expect(source).toContain(`Message-ID: ${buildInput().rfcMessageId}`);
    expect(source).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(Buffer.from(body.replaceAll("\r\n", ""), "base64").toString("utf8"))
      .toBe(buildInput().bodyText);
  });

  it.each([
    "Approved subject\r\nBcc: attacker@example.test",
    "Approved subject\nX-Injected: true",
  ])("rejects CRLF header injection in the subject", async (subject) => {
    await expect(
      buildGmailMimeMessage({ ...buildInput(), subject }),
    ).rejects.toMatchObject({
      name: "GmailMimeBuildError",
      code: gmailMimeBuildErrorCodes.invalidSubject,
    });
  });

  it("rejects malicious recipient and authorized identity addresses", async () => {
    await expect(
      buildGmailMimeMessage({
        ...buildInput(),
        recipient: {
          emailAddress: "victim@example.test\r\nBcc: attacker@example.test",
        },
      }),
    ).rejects.toMatchObject({
      code: gmailMimeBuildErrorCodes.invalidRecipient,
    });

    await expect(
      buildGmailMimeMessage({
        ...buildInput(),
        identity: {
          ...authorizedIdentity,
          from: {
            ...authorizedIdentity.from,
            emailAddress:
              "owner@example.test\r\nBcc: attacker@example.test",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: gmailMimeBuildErrorCodes.invalidFrom,
    });
  });

  it("rejects oversized subjects before MailComposer is called", async () => {
    await expect(
      buildGmailMimeMessage({
        ...buildInput(),
        subject: "a".repeat(gmailMimeSubjectMaxCharacters + 1),
      }),
    ).rejects.toBeInstanceOf(GmailMimeBuildError);
    await expect(
      buildGmailMimeMessage({
        ...buildInput(),
        subject: "a".repeat(gmailMimeSubjectMaxCharacters + 1),
      }),
    ).rejects.toMatchObject({
      code: gmailMimeBuildErrorCodes.invalidSubject,
    });
  });

  it("rejects a malformed stable RFC Message-ID", async () => {
    await expect(buildGmailMimeMessage({
      ...buildInput(),
      rfcMessageId: "not-a-message-id",
    })).rejects.toMatchObject({
      code: gmailMimeBuildErrorCodes.invalidMessageId,
    });
  });

  it("keeps Nodemailer inside the MailComposer-only adapter boundary", () => {
    const source = readFileSync(
      new URL(
        "../../src/modules/backlinks/adapters/gmail/message-builder.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toMatch(
      /loadModule\(\s*"nodemailer\/lib\/mail-composer\/index\.js",?\s*\)/u,
    );
    expect(source).not.toMatch(/from\s+["']nodemailer["']/u);
    expect(source).not.toContain("createTransport");
    expect(source).not.toContain("sendMail");
    expect(source).not.toContain("attachments:");
    expect(source).not.toContain("headers:");
  });
});
