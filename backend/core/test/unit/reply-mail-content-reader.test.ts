import { describe, expect, it } from "vitest";

import {
  createSanitizedReplyMailContentReader,
} from "../../src/modules/backlinks/adapters/gmail/sanitizer-mail-content-reader.js";
import {
  backlinkErrorCodes,
} from "../../src/modules/backlinks/domain/errors/backlink-error.js";

const scope = Object.freeze({
  organizationId: "organization-139",
  workspaceId: "workspace-139",
  websiteProjectId: "project-139",
});
const rawObjectKey = [
  "backlinks",
  "mail",
  "raw",
  scope.organizationId,
  scope.workspaceId,
  scope.websiteProjectId,
  "connection-139",
  "message-139.eml",
].join("/");

describe("BL-AI-139 sanitized reply mail content reader", () => {
  it("parses MIME and exposes only sanitized HTML", async () => {
    const raw = [
      "From: Reply <reply@example.test>",
      "To: Owner <owner@example.test>",
      "Subject: Re: GrowthOS",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p onclick="steal()">Safe reply</p><script>steal()</script>',
    ].join("\r\n");
    const reader = createSanitizedReplyMailContentReader({
      rawObjectReader: {
        async get(input) {
          expect(input).toEqual({ ...scope, rawObjectKey });
          return Buffer.from(raw);
        },
      },
    });

    const body = await reader.read({ ...scope, rawObjectKey });

    expect(body).toMatchObject({
      plainText: null,
      sanitizedHtml: {
        trust: "SANITIZED",
        sanitized: true,
        policyVersion: "growthos-gmail-html-v1",
      },
    });
    expect(body.sanitizedHtml?.content).toContain("<p>Safe reply</p>");
    expect(JSON.stringify(body)).not.toMatch(/onclick|<script|UNTRUSTED/iu);
  });

  it("returns plain text and handles a purged raw object without network fallback", async () => {
    const plainReader = createSanitizedReplyMailContentReader({
      rawObjectReader: {
        async get() {
          return Buffer.from([
            "Content-Type: text/plain; charset=utf-8",
            "",
            "Plain reply",
          ].join("\r\n"));
        },
      },
    });
    const purgedReader = createSanitizedReplyMailContentReader({
      rawObjectReader: { get: async () => null },
    });

    await expect(plainReader.read({ ...scope, rawObjectKey }))
      .resolves.toEqual({
        plainText: "Plain reply\n",
        sanitizedHtml: null,
      });
    await expect(purgedReader.read({ ...scope, rawObjectKey }))
      .resolves.toEqual({
        plainText: null,
        sanitizedHtml: null,
      });
  });

  it("rejects an object key outside the resolved project before reading", async () => {
    let reads = 0;
    const reader = createSanitizedReplyMailContentReader({
      rawObjectReader: {
        async get() {
          reads += 1;
          return null;
        },
      },
    });

    await expect(reader.read({
      ...scope,
      rawObjectKey:
        "backlinks/mail/raw/organization-139/workspace-139/foreign/raw.eml",
    })).rejects.toMatchObject({
      code: backlinkErrorCodes.accessDenied,
    });
    expect(reads).toBe(0);
  });
});
