import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sanitizeGmailHtml } from "../../src/modules/backlinks/adapters/gmail/sanitizer.js";

const maliciousFixturePath = fileURLToPath(
  new URL("../fixtures/mail/malicious-email.html", import.meta.url),
);

describe("sanitizeGmailHtml", () => {
  it("removes active content while preserving safe email content", async () => {
    const rawHtml = await readFile(maliciousFixturePath, "utf8");

    const result = await sanitizeGmailHtml(rawHtml);

    expect(result).toMatchObject({
      sanitized: true,
      trust: "SANITIZED",
      sanitizer: {
        name: "dompurify",
      },
    });
    expect(result.content).toContain("Safe body text");
    expect(result.content).toContain('href="https://safe.example/path"');
    expect(result.content).toContain('href="mailto:safe@example.com"');
    expect(result.content).not.toMatch(
      /<script|<iframe|<img|<form|<input|<object|<svg|\son\w+\s*=|javascript:|data:|\sstyle\s*=/i,
    );
  });
});
