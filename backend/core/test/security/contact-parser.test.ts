import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isCandidateEmail, parseContactPage,
} from "../../src/modules/backlinks/adapters/html/contact-parser.adapter.js";
import type { SafeFetchResult } from "../../src/modules/backlinks/ports/safe-fetch.port.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/contact-page.html", import.meta.url),
);
function page(body: Uint8Array, contentType = "text/html"): SafeFetchResult {
  return {
    requestedUrl: "https://example.com/contact",
    finalUrl: "https://example.com/contact",
    status: 200,
    contentType,
    body,
    redirectChain: [],
    resolvedIps: ["8.8.8.8"],
    fetchedAt: "2026-07-23T08:00:00.000Z",
  };
}

describe("BL-AI-070 contact Candidate parser", () => {
  it("extracts deduplicated email Candidates and bounded page evidence", async () => {
    const evidence = parseContactPage(page(await readFile(fixturePath)));
    expect(evidence).toMatchObject({
      pageUrl: "https://example.com/contact",
      title: "Contact Example",
      parser: "cheerio@1.1.2",
      syntaxValidator: "validator@13.15.35",
      canonicalUrls: ["https://example.com/company/contact"],
    });
    expect(evidence.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.candidates).toEqual([
      expect.objectContaining({
        email: "sales@example.com",
        status: "candidate",
        syntaxValid: true,
        confirmed: false,
        evidence: expect.objectContaining({ source: "mailto" }),
        purposeDecision: expect.objectContaining({
          observedRole: "sales",
          inferredPurpose: "business",
          confidence: 98,
          ruleVersion: "contact-purpose-rules.v4",
        }),
      }),
      expect.objectContaining({
        email: "support@example.com",
        status: "candidate",
        syntaxValid: true,
        confirmed: false,
        evidence: expect.objectContaining({ source: "visible_text" }),
        purposeDecision: expect.objectContaining({
          observedRole: "support",
          inferredPurpose: "support",
          confidence: 98,
        }),
      }),
    ]);
  });

  it.each([
    ["user@例子.公司", true],
    ["Display Name <user@example.com>", false],
    ["user(comment)@example.com", false],
    [`${"a".repeat(65)}@example.com`, false],
    ["user@localhost", false],
    ["üser@example.com", false],
    ["user\u0000@example.com", false],
    ["bad@all.voter", false],
    ["editorial@weekendspecial.co.zawe", false],
  ] as const)("locks conservative email syntax for %s", (value, expected) => {
    expect(isCandidateEmail(value)).toBe(expected);
  });

  it("does not join adjacent DOM text or natural language into email candidates", () => {
    const body = new TextEncoder().encode(`
      <body>
        <span>editorial@weekendspecial.co.za</span><span>We publish weekly.</span>
        <span>info@dstvproinstallation.co.za</span><strong>Professional service.</strong>
        <p>Bad at all. Voter participation and risks are at stake. Research matters.</p>
        <p>press at example dot com</p>
      </body>
    `);

    expect(parseContactPage(page(body)).candidates.map(({ email }) => email))
      .toEqual([
        "editorial@weekendspecial.co.za",
        "info@dstvproinstallation.co.za",
        "press@example.com",
      ]);
  });

  it("rejects non-HTML and excessive DOM input", () => {
    expect(() => parseContactPage(page(new TextEncoder().encode("x"), "text/plain")))
      .toThrow("HTML");
    const huge = `<main>${"<i></i>".repeat(20_001)}</main>`;
    expect(() => parseContactPage(page(new TextEncoder().encode(huge))))
      .toThrow("node limit");
  });

  it("bounds marker-free text scanning", () => {
    const body = new TextEncoder().encode(
      `<body><p>${"x".repeat(200_000)}</p></body>`,
    );

    expect(parseContactPage(page(body)).candidates).toEqual([]);
  });

  it("retains a restricted verified email without promoting short substrings", () => {
    const body = new TextEncoder().encode(`
      <title>No Smart TV? No Problem</title>
      <body><a href="mailto:legal@elephtv.com">Privacy</a></body>
    `);
    const evidence = parseContactPage(page(body));

    expect(evidence.candidates).toEqual([
      expect.objectContaining({
        email: "legal@elephtv.com",
        status: "candidate",
        confirmed: false,
        purposeDecision: expect.objectContaining({
          inferredPurpose: "legal",
          confidence: 98,
        }),
      }),
    ]);
  });

  it("extracts a public bare-email anchor without crawling it as a page URL", () => {
    const body = new TextEncoder().encode(`
      <title>Contact</title>
      <body><a href="person@example.com">Email our editor</a></body>
    `);

    expect(parseContactPage(page(body)).candidates).toEqual([
      expect.objectContaining({
        email: "person@example.com",
        evidence: expect.objectContaining({ source: "mailto" }),
        purposeDecision: expect.objectContaining({
          inferredPurpose: "editorial",
          confidence: 96,
        }),
      }),
    ]);
  });
});
