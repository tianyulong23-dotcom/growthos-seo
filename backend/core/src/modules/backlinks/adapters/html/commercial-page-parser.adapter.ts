import { load } from "cheerio";
import { parse } from "tldts";

import type {
  CommercialPageFacts,
  CommercialPageParserPort,
} from "../../ports/commercial-page-parser.port.js";

const highValuePathTerms = [
  "about",
  "advertise",
  "advertising",
  "contact",
  "contribute",
  "guest-post",
  "partner",
  "partnership",
  "resource",
  "sponsor",
  "write-for-us",
] as const;

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter(Boolean))].sort());
}

function siteDomain(url: URL): string | null {
  return parse(url.hostname, { allowPrivateDomains: true }).domain;
}

export const commercialPageParser: CommercialPageParserPort = Object.freeze({
  parse(
    input: Parameters<CommercialPageParserPort["parse"]>[0],
  ): CommercialPageFacts {
    const $ = load(Buffer.from(input.body).toString("utf8"));
    const title = $("title").first().text().trim();
    const description =
      $("meta[name='description']").first().attr("content")?.trim() ?? "";
    const bodyText = $("body").text().replace(/\s+/gu, " ").trim();
    const text = `${title} ${description} ${bodyText}`
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 200_000)
      .toLowerCase();
    const links: string[] = [];
    const cooperationLinks: string[] = [];
    let externalLinkCount = 0;
    let totalLinkCount = 0;
    $("a[href]").each((_index, element) => {
      const rawHref = $(element).attr("href");
      if (rawHref === undefined) return;
      try {
        const target = new URL(rawHref, input.finalUrl);
        if (!["http:", "https:"].includes(target.protocol)) return;
        totalLinkCount += 1;
        if (siteDomain(target) !== input.canonicalDomain) {
          externalLinkCount += 1;
          return;
        }
        target.hash = "";
        const normalized = target.href;
        const haystack = `${target.pathname} ${$(element).text()}`
          .toLowerCase();
        if (highValuePathTerms.some((term) => haystack.includes(term))) {
          links.push(normalized);
        }
        if (
          [
            "advertis",
            "contribut",
            "guest post",
            "partner",
            "sponsor",
            "write for us",
          ].some((term) => haystack.includes(term))
        ) {
          cooperationLinks.push(normalized);
        }
      } catch {
        return;
      }
    });
    const language = ($("html").attr("lang") ?? "")
      .trim()
      .toLowerCase()
      .split(/[-_]/u)[0] || null;
    return Object.freeze({
      url: input.finalUrl,
      collectedAt: input.fetchedAt,
      language,
      text,
      wordCount: bodyText.split(/\s+/u).filter(Boolean).length,
      externalLinkCount,
      totalLinkCount,
      hasTitle: title.length > 0,
      hasDescription: description.length > 0,
      hasEditorialContainer:
        $("article, main, [role='main']").length > 0,
      cooperationLinks: unique(cooperationLinks),
      highValueLinks: unique(links),
    });
  },
});
