import { createHash } from "node:crypto";

import { load } from "cheerio";

import {
  createPlacementUrlKey,
} from "../../domain/placements/url-key.js";
import type {
  SafeFetchResult,
} from "../../ports/safe-fetch.port.js";

export const linkOccurrenceParserVersion =
  "cheerio@1.1.2-link-occurrence-v2";

export type LinkOccurrence = Readonly<{
  occurrenceIndex: number;
  occurrenceHash: string;
  rawHref: string;
  resolvedHref: string;
  normalizedHref: string;
  anchorText: string;
  contextText: string;
  rel: readonly string[];
  nofollow: boolean;
  sponsored: boolean;
  ugc: boolean;
  domPath: string;
}>;

export type StaticLinkOccurrenceEvidence = Readonly<{
  pageUrl: string;
  targetUrl: string;
  targetUrlHash: string;
  fetchedAt: string;
  parserVersion: typeof linkOccurrenceParserVersion;
  contentSha256: string;
  canonicalUrl: string | null;
  robotsDirectives: readonly string[];
  noindex: boolean;
  occurrences: readonly LinkOccurrence[];
}>;

export type ParseStaticLinkOccurrencesInput = Readonly<{
  page: SafeFetchResult;
  targetUrl: string;
}>;

const htmlTypes = new Set(["text/html", "application/xhtml+xml"]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const maxNodes = 20_000;
const maxContextCharacters = 500;
const contextSelector =
  "p, li, blockquote, td, th, figcaption, section, article, div";

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function parsePageMetadata(
  $: ReturnType<typeof load>,
  baseUrl: string,
): Readonly<{
  canonicalUrl: string | null;
  robotsDirectives: readonly string[];
  noindex: boolean;
}> {
  const robotsDirectives = new Set<string>();
  $("meta[name]").each((_, element) => {
    if (($(element).attr("name") ?? "").toLowerCase() !== "robots") return;
    for (const directive of ($(element).attr("content") ?? "")
      .toLowerCase()
      .split(/[\s,]+/u)
      .filter((value) => value.length > 0)) {
      robotsDirectives.add(directive);
    }
  });

  let canonicalUrl: string | null = null;
  $("link[rel][href]").each((_, element) => {
    if (canonicalUrl !== null) return;
    const rel = ($(element).attr("rel") ?? "")
      .toLowerCase()
      .split(/\s+/u);
    if (!rel.includes("canonical")) return;
    try {
      canonicalUrl = createPlacementUrlKey(
        new URL($(element).attr("href") ?? "", baseUrl).toString(),
      ).normalizedUrl;
    } catch {
      // Invalid canonical evidence remains unavailable.
    }
  });

  const directives = Object.freeze([...robotsDirectives]);
  return Object.freeze({
    canonicalUrl,
    robotsDirectives: directives,
    noindex: directives.includes("noindex"),
  });
}

function resolveBaseUrl(html: string, pageUrl: string): {
  baseUrl: string;
  $: ReturnType<typeof load>;
} {
  const $ = load(html);
  const baseValue = $("base[href]").first().attr("href");
  if (baseValue === undefined) return { baseUrl: pageUrl, $ };

  try {
    const resolved = new URL(baseValue, pageUrl);
    if (resolved.protocol === "http:" || resolved.protocol === "https:") {
      return { baseUrl: resolved.toString(), $ };
    }
  } catch {
    // Invalid base evidence falls back to the fetched page URL.
  }

  return { baseUrl: pageUrl, $ };
}

export function parseStaticLinkOccurrences(
  input: ParseStaticLinkOccurrencesInput,
): StaticLinkOccurrenceEvidence {
  const mediaType = input.page.contentType
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType === undefined || !htmlTypes.has(mediaType)) {
    throw new Error("Link occurrence parser requires HTML content.");
  }

  const { baseUrl, $ } = resolveBaseUrl(
    decoder.decode(input.page.body),
    input.page.finalUrl,
  );
  if ($("*").length > maxNodes) {
    throw new Error("Link occurrence parser node limit exceeded.");
  }

  const targetKey = createPlacementUrlKey(input.targetUrl);
  const metadata = parsePageMetadata($, baseUrl);
  const visible = $("body").clone();
  visible.find("script, style, template, noscript").remove();
  visible.find("[hidden], [aria-hidden='true']").remove();
  visible.find("[style]").each((_, element) => {
    const style = $(element).attr("style") ?? "";
    if (
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu
        .test(style)
    ) {
      $(element).remove();
    }
  });

  const occurrences: LinkOccurrence[] = [];
  visible.find("a[href]").each((_, element) => {
    const rawHref = $(element).attr("href");
    if (rawHref === undefined) return;

    let resolvedHref: string;
    try {
      resolvedHref = new URL(rawHref, baseUrl).toString();
    } catch {
      return;
    }

    let observedKey;
    try {
      observedKey = createPlacementUrlKey(resolvedHref);
    } catch {
      return;
    }
    if (observedKey.normalizedUrlHash !== targetKey.normalizedUrlHash) return;

    const rel = Object.freeze([
      ...new Set(
        ($(element).attr("rel") ?? "")
          .toLowerCase()
          .split(/\s+/u)
          .filter((token) => token.length > 0),
      ),
    ]);
    const anchorText = normalizeText($(element).text());
    const nearestContext = $(element).closest(contextSelector).first();
    const contextText = normalizeText(
      (nearestContext.length > 0 ? nearestContext : $(element).parent()).text(),
    ).slice(0, maxContextCharacters).trimEnd();

    const ancestors = $(element).parentsUntil("html").toArray().reverse();
    const pathNodes = [...ancestors, element];
    const domPath = pathNodes.map((node) => {
      const current = $(node);
      const tagName = current.prop("tagName")?.toLowerCase() ?? "unknown";
      const position = current.parent().children(tagName).index(current) + 1;
      return `${tagName}:nth-of-type(${Math.max(position, 1)})`;
    }).join(">");
    const occurrenceIndex = occurrences.length;
    const occurrenceHash = createHash("sha256").update([
      linkOccurrenceParserVersion,
      input.page.finalUrl,
      targetKey.normalizedUrlHash,
      domPath,
      String(occurrenceIndex),
      anchorText,
      rel.join(" "),
      contextText,
    ].join("\u0000"), "utf8").digest("hex");

    occurrences.push(Object.freeze({
      occurrenceIndex,
      occurrenceHash,
      rawHref,
      resolvedHref,
      normalizedHref: observedKey.normalizedUrl,
      anchorText,
      contextText,
      rel,
      nofollow: rel.includes("nofollow"),
      sponsored: rel.includes("sponsored"),
      ugc: rel.includes("ugc"),
      domPath,
    }));
  });

  return Object.freeze({
    pageUrl: input.page.finalUrl,
    targetUrl: targetKey.normalizedUrl,
    targetUrlHash: targetKey.normalizedUrlHash,
    fetchedAt: input.page.fetchedAt,
    parserVersion: linkOccurrenceParserVersion,
    contentSha256: createHash("sha256")
      .update(input.page.body)
      .digest("hex"),
    ...metadata,
    occurrences: Object.freeze(occurrences),
  });
}
