import { describe, expect, it } from "vitest";
import { replyRecipient, replySubject, replySendSchema } from "../../src/modules/backlinks/application/services/mail-reply.service.js";
import { buildGmailMimeMessage } from "../../src/modules/backlinks/adapters/gmail/message-builder.js";

describe("mail reply addressing and MIME", () => {
  it("uses the inbound Reply-To or sender, not the original outreach contact", () => {
    expect(replyRecipient("bruno@publisher.test", [])).toBe("bruno@publisher.test");
    expect(replyRecipient("bruno@publisher.test", ["partnerships@publisher.test"])).toBe("partnerships@publisher.test");
    expect(replySubject("Cooperation")).toBe("Re: Cooperation");
    expect(replySubject("Re: Cooperation")).toBe("Re: Cooperation");
  });
  it.each([
    ["no-reply@publisher.test", []],
    ["bruno@publisher.test", ["a@publisher.test", "b@publisher.test"]],
    ["bruno@publisher.test\r\nBcc: x@evil.test", []],
  ] as [string, string[]][])("rejects unsafe or ambiguous recipients", (from, headers) => {
    expect(() => replyRecipient(from, headers)).toThrow();
  });
  it("requires explicit confirmation and rejects subject injection", () => {
    expect(() => replySubject("Re: Test\r\nBcc: evil@test.com")).toThrow();
    expect(replySendSchema.safeParse({
      expectedVersion: 1, gmailConnectionId: "00000000-0000-4000-8000-000000000001",
      recipient: "a@test.com", subject: "Re: Test", body: "Reply", confirmed: false,
    }).success).toBe(false);
  });
  it("preserves RFC reply references without changing the new Message-ID", async () => {
    const input = {
      identity: { from: { identityId: "identity", emailAddress: "sender@example.test", identityVersion: 1 },
        replyTo: { identityId: "identity", emailAddress: "sender@example.test", identityVersion: 1 } },
      recipient: { emailAddress: "bruno@publisher.test" }, subject: "Re: Cooperation", bodyText: "Obrigado.",
      rfcMessageId: "<reply@example.test>", inReplyTo: "<received@publisher.test>",
      references: ["<original@example.test>", "<received@publisher.test>"],
    };
    const mime = await buildGmailMimeMessage(input);
    const raw = mime.raw.toString("utf8").replace(/\r\n[ \t]+/gu, " ");
    expect(raw).toContain("In-Reply-To: <received@publisher.test>");
    expect(raw).toContain("References: <original@example.test> <received@publisher.test>");
    expect(raw).toContain("Message-ID: <reply@example.test>");
    await expect(buildGmailMimeMessage({ ...input, inReplyTo: "<bad@test>\r\nBcc: evil@test" })).rejects.toThrow();
  });
});
