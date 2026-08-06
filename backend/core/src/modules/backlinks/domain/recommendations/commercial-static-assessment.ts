import { load } from "cheerio";
import { parse } from "tldts";

import type { SafeFetchPort } from "../../ports/safe-fetch.port.js";
import { SafeFetchError } from "../../ports/safe-fetch.port.js";
import { createRecommendationDomainKey } from "./domain-key.js";

export const commercialStaticAssessmentRuleVersion =
  "commercial-static-assessment.v1";

const maxPageBytes = 512_000;
const maxRedirects = 4;
const maxSecondaryPages = 4;
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

export type CommercialStaticAssessment = Readonly<{
  canonicalDomain: string;
  decision: "ready" | "insufficient_data" | "manual_review";
  language: string | null;
  topics: readonly string[];
  productRelevance: number | null;
  editorialQuality: number | null;
  siteType: string | null;
  monetizationMethods: readonly string[];
  cooperationPages: readonly string[];
  outboundLinkDensity: number | null;
  technicalAccessibility: number | null;
  unsafeOrMalicious: boolean | null;
  highConfidenceLinkFarm: boolean | null;
  evidenceUrls: readonly string[];
  evidenceRefs: readonly string[];
  failedUrls: readonly string[];
  collectedAt: string;
  ruleVersion: typeof commercialStaticAssessmentRuleVersion;
}>;

type PageFacts = Readonly<{
  url: string;
  collectedAt: string;
  language: string | null;
  text: string;
  wordCount: number;
  externalLinkCount: number;
  totalLinkCount: number;
  hasTitle: boolean;
  hasDescription: boolean;
  hasEditorialContainer: boolean;
  cooperationLinks: readonly string[];
  highValueLinks: readonly string[];
}>;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter(Boolean))].sort());
}

function siteDomain(url: URL): string | null {
  const result = parse(url.hostname, { allowPrivateDomains: true });
  return result.domain;
}

function pageFacts(
  body: Uint8Array,
  finalUrl: string,
  fetchedAt: string,
  canonicalDomain: string,
): PageFacts {
  const $ = load(Buffer.from(body).toString("utf8"));
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
      const target = new URL(rawHref, finalUrl);
      if (!["http:", "https:"].includes(target.protocol)) return;
      totalLinkCount += 1;
      if (siteDomain(target) !== canonicalDomain) {
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
    url: finalUrl,
    collectedAt: fetchedAt,
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
}

function normalizeTerms(values: readonly string[]): readonly string[] {
  return unique(values.flatMap((value) =>
    value.toLowerCase().split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= 3)
  ));
}

function classifySite(text: string): string | null {
  const types = [
    ["specialist_blog", ["blog", "reviews", "guides", "tutorials"]],
    ["industry_publication", ["news", "editorial", "magazine", "journal"]],
    ["resource_directory", ["directory", "resources", "listings"]],
    ["partner_ecosystem", ["partners", "integrations", "ecosystem"]],
    ["company_site", ["company", "customers", "solutions", "products"]],
  ] as const;
  return types.find(([, terms]) => terms.some((term) => text.includes(term)))
    ?.[0] ?? null;
}

function monetizationMethods(text: string): readonly string[] {
  const methods = [
    ["advertising", ["advertise", "media kit", "advertising"]],
    ["sponsorship", ["sponsor", "sponsored"]],
    ["affiliate", ["affiliate", "commission"]],
    ["subscription", ["subscribe", "subscription", "membership"]],
    ["commercial_partnership", ["partner with us", "partnership"]],
  ] as const;
  return Object.freeze(methods
    .filter(([, terms]) => terms.some((term) => text.includes(term)))
    .map(([method]) => method));
}

function failureDecision(error: unknown): "insufficient_data" | "manual_review" {
  return error instanceof SafeFetchError && error.retryable
    ? "insufficient_data"
    : "manual_review";
}

export async function assessCommercialCandidateSite(input: Readonly<{
  canonicalDomain: string;
  workspaceId: string;
  websiteProjectId: string;
  projectTerms: readonly string[];
  safeFetch: Pick<SafeFetchPort, "fetch">;
  now?: () => string;
}>): Promise<CommercialStaticAssessment> {
  const canonicalDomain =
    createRecommendationDomainKey(input.canonicalDomain).registrableDomain;
  const homepage = `https://${canonicalDomain}/`;
  const pages: PageFacts[] = [];
  const failedUrls: string[] = [];
  let degradedDecision: "insufficient_data" | "manual_review" | null = null;

  const fetchPage = async (url: string): Promise<PageFacts | null> => {
    try {
      const result = await input.safeFetch.fetch({
        url,
        purpose: "seo-assessment",
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        maxBytes: maxPageBytes,
        maxRedirects,
      });
      if (result.status === 403 || result.status === 429) {
        failedUrls.push(url);
        degradedDecision = "manual_review";
        return null;
      }
      if (result.status < 200 || result.status >= 400) {
        failedUrls.push(url);
        degradedDecision ??= "insufficient_data";
        return null;
      }
      return pageFacts(
        result.body,
        result.finalUrl,
        result.fetchedAt,
        canonicalDomain,
      );
    } catch (error) {
      failedUrls.push(url);
      const decision = failureDecision(error);
      if (decision === "manual_review" || degradedDecision === null) {
        degradedDecision = decision;
      }
      return null;
    }
  };

  const homepageFacts = await fetchPage(homepage);
  if (homepageFacts === null) {
    return Object.freeze({
      canonicalDomain,
      decision: degradedDecision ?? "insufficient_data",
      language: null,
      topics: Object.freeze([]),
      productRelevance: null,
      editorialQuality: null,
      siteType: null,
      monetizationMethods: Object.freeze([]),
      cooperationPages: Object.freeze([]),
      outboundLinkDensity: null,
      technicalAccessibility: null,
      unsafeOrMalicious: null,
      highConfidenceLinkFarm: null,
      evidenceUrls: Object.freeze([]),
      evidenceRefs: Object.freeze([]),
      failedUrls: unique(failedUrls),
      collectedAt: input.now?.() ?? new Date().toISOString(),
      ruleVersion: commercialStaticAssessmentRuleVersion,
    });
  }
  pages.push(homepageFacts);
  const secondaryUrls = homepageFacts.highValueLinks
    .filter((url) => url !== homepageFacts.url)
    .slice(0, maxSecondaryPages);
  for (const url of secondaryUrls) {
    const facts = await fetchPage(url);
    if (facts !== null) pages.push(facts);
  }

  const combinedText = pages.map(({ text }) => text).join(" ");
  const projectTerms = normalizeTerms(input.projectTerms);
  const matchedTerms = projectTerms.filter((term) =>
    combinedText.includes(term)
  );
  const productRelevance = projectTerms.length === 0
    ? null
    : clamp(matchedTerms.length / Math.min(projectTerms.length, 20));
  const editorialQuality = clamp(pages.reduce((sum, page) =>
    sum
    + (page.hasTitle ? 0.2 : 0)
    + (page.hasDescription ? 0.2 : 0)
    + (page.hasEditorialContainer ? 0.2 : 0)
    + Math.min(page.wordCount / 1_000, 1) * 0.4
  , 0) / pages.length);
  const totalLinks = pages.reduce((sum, page) => sum + page.totalLinkCount, 0);
  const externalLinks = pages.reduce(
    (sum, page) => sum + page.externalLinkCount,
    0,
  );
  const evidenceUrls = unique(pages.map(({ url }) => url));
  const cooperationPages = unique(pages.flatMap(
    ({ cooperationLinks }) => cooperationLinks,
  ));
  const languages = pages.flatMap(({ language }) =>
    language === null ? [] : [language]
  );
  const collectedAt = pages.map(({ collectedAt }) => collectedAt).sort().at(-1)
    ?? input.now?.()
    ?? new Date().toISOString();
  const evidenceRefs = Object.freeze(evidenceUrls.map(
    (url) => `safefetch:${canonicalDomain}:${collectedAt}:${url}`,
  ));
  const unsafeOrMalicious = [
    "credential theft",
    "malware",
    "phishing",
    "ransomware",
  ].some((term) => combinedText.includes(term));
  const highConfidenceLinkFarm = [
    "buy backlinks",
    "guest post marketplace",
    "link farm",
    "sell backlinks",
    "sponsored links for sale",
  ].some((term) => combinedText.includes(term));

  return Object.freeze({
    canonicalDomain,
    decision: degradedDecision ?? "ready",
    language: languages[0] ?? null,
    topics: Object.freeze(matchedTerms.slice(0, 20)),
    productRelevance,
    editorialQuality,
    siteType: classifySite(combinedText),
    monetizationMethods: monetizationMethods(combinedText),
    cooperationPages,
    outboundLinkDensity: totalLinks === 0
      ? 0
      : clamp(externalLinks / totalLinks),
    technicalAccessibility: clamp(pages.length / (secondaryUrls.length + 1)),
    unsafeOrMalicious,
    highConfidenceLinkFarm,
    evidenceUrls,
    evidenceRefs,
    failedUrls: unique(failedUrls),
    collectedAt,
    ruleVersion: commercialStaticAssessmentRuleVersion,
  });
}
