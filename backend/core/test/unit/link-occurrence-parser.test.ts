import { describe, expect, it } from "vitest";

import {
  parseStaticLinkOccurrences,
} from "../../src/modules/backlinks/adapters/html/link-occurrence-parser.js";
import type {
  SafeFetchResult,
} from "../../src/modules/backlinks/ports/safe-fetch.port.js";

const encoder = new TextEncoder();

function page(
  html: string | Uint8Array,
  contentType = "text/html; charset=utf-8",
): SafeFetchResult {
  return {
    requestedUrl: "https://publisher.example.net/story",
    finalUrl: "https://publisher.example.net/story",
    status: 200,
    contentType,
    body: typeof html === "string" ? encoder.encode(html) : html,
    redirectChain: [],
    resolvedIps: ["203.0.113.10"],
    fetchedAt: "2026-07-27T08:00:00.000Z",
  };
}

describe("BL-AI-146 static HTML link occurrence parser", () => {
  it("parses href, anchor, context, and rel evidence through an HTML base URL", () => {
    const evidence = parseStaticLinkOccurrences({
      page: page(`
        <html>
          <head><base href="https://client.example.com/resources/"></head>
          <body>
            <main>
              <p>Read
                <a href="../Offer?x=1#section"
                   rel="NoFoLlOw sponsored UGC sponsored">
                  Client &amp; Guide
                </a>
                today.
              </p>
            </main>
          </body>
        </html>
      `),
      targetUrl: "https://client.example.com/Offer?x=1",
    });

    expect(evidence).toMatchObject({
      pageUrl: "https://publisher.example.net/story",
      targetUrl: "https://client.example.com/Offer?x=1",
      fetchedAt: "2026-07-27T08:00:00.000Z",
      parserVersion: "cheerio@1.1.2-link-occurrence-v2",
      canonicalUrl: null,
      robotsDirectives: [],
      noindex: false,
    });
    expect(evidence.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.targetUrlHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.occurrences).toHaveLength(1);
    expect(evidence.occurrences[0]).toMatchObject({
      occurrenceIndex: 0,
      rawHref: "../Offer?x=1#section",
      resolvedHref: "https://client.example.com/Offer?x=1#section",
      normalizedHref: "https://client.example.com/Offer?x=1",
      anchorText: "Client & Guide",
      contextText: "Read Client & Guide today.",
      rel: ["nofollow", "sponsored", "ugc"],
      nofollow: true,
      sponsored: true,
      ugc: true,
    });
    expect(evidence.occurrences[0]?.domPath).toMatch(
      /body:nth-of-type\(1\).+a:nth-of-type\(1\)$/u,
    );
    expect(evidence.occurrences[0]?.occurrenceHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
  });

  it("retains every visible matching DOM occurrence without weakening URL identity", () => {
    const html = `
      <body>
        <main>
          <p><a href="https://client.example.com/Offer?x=1#first">First</a></p>
          <section hidden>
            <a href="https://client.example.com/Offer?x=1">Hidden attribute</a>
          </section>
          <div aria-hidden="true">
            <a href="https://client.example.com/Offer?x=1">Aria hidden</a>
          </div>
          <div style="color:red; display: none">
            <a href="https://client.example.com/Offer?x=1">Style hidden</a>
          </div>
          <p><a href="//client.example.com/Offer?x=1#second">Second Link</a></p>
          <a href="mailto:owner@client.example.com">Email</a>
          <a href="https://client.example.com/Offer?x=2">Different query</a>
        </main>
      </body>
    `;

    const first = parseStaticLinkOccurrences({
      page: page(html),
      targetUrl: "https://client.example.com/Offer?x=1",
    });
    const second = parseStaticLinkOccurrences({
      page: page(html),
      targetUrl: "https://client.example.com/Offer?x=1",
    });

    expect(first.occurrences.map((occurrence) => occurrence.anchorText))
      .toEqual(["First", "Second Link"]);
    expect(first.occurrences.map((occurrence) => occurrence.occurrenceIndex))
      .toEqual([0, 1]);
    expect(first.occurrences[0]?.occurrenceHash)
      .not.toBe(first.occurrences[1]?.occurrenceHash);
    expect(first.occurrences.map((occurrence) => occurrence.occurrenceHash))
      .toEqual(second.occurrences.map((occurrence) => occurrence.occurrenceHash));
  });

  it("bounds malformed-page context and emits empty rel flags", () => {
    const longContext = "surrounding ".repeat(80);
    const evidence = parseStaticLinkOccurrences({
      page: page(`
        <body><article><p>${longContext}
          <a href="https://client.example.com/Offer?x=1" rel="">
            Anchor &amp; More
          </a>
        </article>
      `),
      targetUrl: "https://client.example.com/Offer?x=1",
    });

    expect(evidence.occurrences).toHaveLength(1);
    expect(evidence.occurrences[0]).toMatchObject({
      anchorText: "Anchor & More",
      rel: [],
      nofollow: false,
      sponsored: false,
      ugc: false,
    });
    expect(evidence.occurrences[0]?.contextText.length).toBeLessThanOrEqual(500);
  });

  it("captures canonical and robots metadata for initial validation", () => {
    const evidence = parseStaticLinkOccurrences({
      page: page(`
        <html>
          <head>
            <base href="https://publisher.example.net/section/">
            <link rel="alternate canonical" href="../story">
            <meta name="ROBOTS" content="noindex, follow">
          </head>
          <body></body>
        </html>
      `),
      targetUrl: "https://client.example.com/Offer?x=1",
    });

    expect(evidence).toMatchObject({
      canonicalUrl: "https://publisher.example.net/story",
      robotsDirectives: ["noindex", "follow"],
      noindex: true,
    });
  });

  it("rejects non-HTML, invalid UTF-8, and excessive DOM input", () => {
    expect(() => parseStaticLinkOccurrences({
      page: page("plain text", "text/plain"),
      targetUrl: "https://client.example.com/Offer?x=1",
    })).toThrow("HTML");

    expect(() => parseStaticLinkOccurrences({
      page: page(new Uint8Array([0xc3, 0x28])),
      targetUrl: "https://client.example.com/Offer?x=1",
    })).toThrow();

    expect(() => parseStaticLinkOccurrences({
      page: page(`<main>${"<i></i>".repeat(20_001)}</main>`),
      targetUrl: "https://client.example.com/Offer?x=1",
    })).toThrow("node limit");
  });
});
