import type {
  CommercialPageFacts,
  CommercialPageParserPort,
} from "../../ports/commercial-page-parser.port.js";
import type { SafeFetchPort } from "../../ports/safe-fetch.port.js";
import { SafeFetchError } from "../../ports/safe-fetch.port.js";
import { createRecommendationDomainKey } from "./domain-key.js";

export const commercialStaticAssessmentRuleVersion =
  "commercial-static-assessment.v3";

const maxPageBytes = 2_000_000;
const maxRedirects = 4;
const maxSecondaryPages = 4;
const maxFetchAttempts = 2;
const retryableHttpStatuses = new Set([408, 425, 500, 502, 503, 504]);
const explicitTermSeparator = /[,，;；\r\n]+/u;
export type CommercialStaticAssessment = Readonly<{
  canonicalDomain: string;
  decision: "ready" | "insufficient_data" | "manual_review";
  language: string | null;
  topics: readonly string[];
  matchedProducts: readonly string[];
  matchedTopics: readonly string[];
  matchedKeywords: readonly string[];
  matchedTargetPages: readonly string[];
  matchedAudiences: readonly string[];
  matchedPartnershipGoals: readonly string[];
  relatedContentPages: readonly string[];
  productRelevance: number | null;
  editorialQuality: number | null;
  siteType: string | null;
  monetizationMethods: readonly string[];
  cooperationPages: readonly string[];
  outboundLinkDensity: number | null;
  technicalAccessibility: number | null;
  unsafeOrMalicious: boolean | null;
  highConfidenceLinkFarm: boolean | null;
  unrelatedIndustry: boolean | null;
  evidenceUrls: readonly string[];
  evidenceRefs: readonly string[];
  failedUrls: readonly string[];
  collectedAt: string;
  ruleVersion: typeof commercialStaticAssessmentRuleVersion;
}>;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter(Boolean))].sort());
}

function uniqueInOrder(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter(Boolean))]);
}

function sameDomainUrl(value: string, canonicalDomain: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (
      createRecommendationDomainKey(url.hostname).registrableDomain !==
      canonicalDomain
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeTerms(values: readonly string[]): readonly string[] {
  return unique(values.flatMap((value) =>
    value.split(explicitTermSeparator)
  ).map((value) =>
    value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  ).filter(Boolean));
}

const weakTerms = new Set([
  "best",
  "blog",
  "guide",
  "home",
  "news",
  "online",
  "pool",
  "product",
  "products",
  "review",
  "site",
  "website",
]);

function significantTokens(value: string): readonly string[] {
  return value.split(/\s+/u).filter(
    (term) => term.length >= 3 && !weakTerms.has(term),
  );
}

function textMatches(text: string, value: string): boolean {
  if (value.length >= 4 && text.includes(value)) return true;
  const tokens = significantTokens(value);
  return tokens.length > 0 && tokens.every((term) => text.includes(term));
}

function matchedValues(
  text: string,
  values: readonly string[],
): readonly string[] {
  return unique(normalizeTerms(values).filter((value) =>
    textMatches(text, value)
  ));
}

function targetPageSemanticTerms(value: string): readonly string[] {
  try {
    const url = new URL(value);
    return normalizeTerms(
      decodeURIComponent(url.pathname).split("/").filter(Boolean),
    );
  } catch {
    return normalizeTerms([value]);
  }
}

function matchedTargetPageValues(
  text: string,
  values: readonly string[],
): readonly string[] {
  return unique(values.filter((value) =>
    targetPageSemanticTerms(value).some((term) => textMatches(text, term))
  ));
}

function industrySignals(text: string): ReadonlySet<string> {
  const industries = [
    ["pool_care", ["pool cleaner", "pool cleaning", "pool maintenance"]],
    ["home_cinema", ["projector", "home cinema", "streaming device"]],
    ["technology", ["software", "technology", "developer", "automation"]],
    ["entertainment", ["celebrity", "movie news", "music news", "gaming news"]],
    ["general_news", ["breaking news", "politics", "world news"]],
  ] as const;
  return new Set(industries
    .filter(([, signals]) => signals.some((signal) => text.includes(signal)))
    .map(([industry]) => industry));
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
  discoveryUrls?: readonly string[];
  workspaceId: string;
  websiteProjectId: string;
  project: Readonly<{
    products: readonly string[];
    topics: readonly string[];
    keywords: readonly string[];
    targetPages: readonly string[];
    targetAudiences: readonly string[];
    partnershipGoals: readonly string[];
  }>;
  safeFetch: Pick<SafeFetchPort, "fetch">;
  browserFetch?: Pick<SafeFetchPort, "fetch">;
  pageParser: CommercialPageParserPort;
  now?: () => string;
}>): Promise<CommercialStaticAssessment> {
  const canonicalDomain =
    createRecommendationDomainKey(input.canonicalDomain).registrableDomain;
  const homepage = `https://${canonicalDomain}/`;
  const pages: CommercialPageFacts[] = [];
  const failedUrls: string[] = [];
  const attemptedUrls: string[] = [];
  const browserEvidenceUrls = new Set<string>();
  let successfulDiscoveryEvidence = false;
  let degradedDecision: "insufficient_data" | "manual_review" | null = null;

  const fetchPage = async (
    url: string,
  ): Promise<CommercialPageFacts | null> => {
    attemptedUrls.push(url);
    for (let attempt = 1; attempt <= maxFetchAttempts; attempt += 1) {
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
          if (input.browserFetch !== undefined) {
            try {
              const browserResult = await input.browserFetch.fetch({
                url,
                purpose: "seo-assessment",
                workspaceId: input.workspaceId,
                websiteProjectId: input.websiteProjectId,
                maxBytes: maxPageBytes,
                maxRedirects,
              });
              if (
                browserResult.status >= 200 &&
                browserResult.status < 400
              ) {
                const parsed = input.pageParser.parse({
                  body: browserResult.body,
                  finalUrl: browserResult.finalUrl,
                  fetchedAt: browserResult.fetchedAt,
                  canonicalDomain,
                });
                browserEvidenceUrls.add(parsed.url);
                return parsed;
              }
            } catch {
              // Preserve the original 403/429 as the assessment decision.
            }
          }
          failedUrls.push(url);
          degradedDecision = "manual_review";
          return null;
        }
        if (result.status < 200 || result.status >= 400) {
          if (
            retryableHttpStatuses.has(result.status)
            && attempt < maxFetchAttempts
          ) {
            continue;
          }
          failedUrls.push(url);
          degradedDecision ??= "insufficient_data";
          return null;
        }
        return input.pageParser.parse({
          body: result.body,
          finalUrl: result.finalUrl,
          fetchedAt: result.fetchedAt,
          canonicalDomain,
        });
      } catch (error) {
        if (
          error instanceof SafeFetchError
          && error.retryable
          && attempt < maxFetchAttempts
        ) {
          continue;
        }
        failedUrls.push(url);
        const decision = failureDecision(error);
        if (decision === "manual_review" || degradedDecision === null) {
          degradedDecision = decision;
        }
        return null;
      }
    }
    return null;
  };

  const initialUrls = uniqueInOrder([
    homepage,
    ...(input.discoveryUrls ?? []).flatMap((value) => {
      const url = sameDomainUrl(value, canonicalDomain);
      return url === null ? [] : [url];
    }),
  ]).slice(0, maxSecondaryPages + 1);
  for (const url of initialUrls) {
    const facts = await fetchPage(url);
    if (facts !== null) {
      pages.push(facts);
      if (url !== homepage) successfulDiscoveryEvidence = true;
    }
  }
  if (pages.length === 0) {
    return Object.freeze({
      canonicalDomain,
      decision: degradedDecision ?? "insufficient_data",
      language: null,
      topics: Object.freeze([]),
      matchedProducts: Object.freeze([]),
      matchedTopics: Object.freeze([]),
      matchedKeywords: Object.freeze([]),
      matchedTargetPages: Object.freeze([]),
      matchedAudiences: Object.freeze([]),
      matchedPartnershipGoals: Object.freeze([]),
      relatedContentPages: Object.freeze([]),
      productRelevance: null,
      editorialQuality: null,
      siteType: null,
      monetizationMethods: Object.freeze([]),
      cooperationPages: Object.freeze([]),
      outboundLinkDensity: null,
      technicalAccessibility: null,
      unsafeOrMalicious: null,
      highConfidenceLinkFarm: null,
      unrelatedIndustry: null,
      evidenceUrls: Object.freeze([]),
      evidenceRefs: Object.freeze([]),
      failedUrls: unique(failedUrls),
      collectedAt: input.now?.() ?? new Date().toISOString(),
      ruleVersion: commercialStaticAssessmentRuleVersion,
    });
  }
  const secondaryUrls = uniqueInOrder(
    pages.flatMap(({ highValueLinks }) => highValueLinks),
  )
    .filter((url) => !attemptedUrls.includes(url))
    .slice(0, maxSecondaryPages + 1 - attemptedUrls.length);
  for (const url of secondaryUrls) {
    const facts = await fetchPage(url);
    if (facts !== null) pages.push(facts);
  }

  const combinedText = pages.map(({ text }) => text.toLowerCase()).join(" ");
  const matchedProducts = matchedValues(combinedText, input.project.products);
  const matchedTopics = matchedValues(combinedText, input.project.topics);
  const matchedKeywords = matchedValues(combinedText, input.project.keywords);
  const matchedTargetPages = matchedTargetPageValues(
    combinedText,
    input.project.targetPages,
  );
  const matchedAudiences = matchedValues(
    combinedText,
    input.project.targetAudiences,
  );
  const matchedPartnershipGoals = matchedValues(
    combinedText,
    input.project.partnershipGoals,
  );
  const targetPagesWithSemanticTerms = input.project.targetPages.filter(
    (value) => targetPageSemanticTerms(value).length > 0,
  );
  const semanticGroups = [
    [matchedProducts.length, normalizeTerms(input.project.products).length, 0.4],
    [matchedTopics.length, normalizeTerms(input.project.topics).length, 0.25],
    [matchedKeywords.length, normalizeTerms(input.project.keywords).length, 0.2],
    [
      matchedTargetPages.length,
      targetPagesWithSemanticTerms.length,
      0.15,
    ],
  ] as const;
  const availableWeight = semanticGroups.reduce(
    (sum, [, count, weight]) => sum + (count > 0 ? weight : 0),
    0,
  );
  const productRelevance = availableWeight === 0
    ? null
    : clamp(semanticGroups.reduce(
      (sum, [matched, count, weight]) =>
        sum + (count === 0 ? 0 : Math.min(matched / count, 1) * weight),
      0,
    ) / availableWeight);
  const relatedContentPages = unique(pages.filter(({ text }) => {
    const normalized = text.toLowerCase();
    const semanticTerms = [
      ...input.project.products,
      ...input.project.topics,
      ...input.project.keywords,
    ].flatMap((value) => normalizeTerms([value]));
    const targetPageTerms = input.project.targetPages.flatMap(
      targetPageSemanticTerms,
    );
    return [...semanticTerms, ...targetPageTerms].some((value) =>
      textMatches(normalized, value)
    );
  }).map(({ url }) => url));
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
    (url) =>
      `${browserEvidenceUrls.has(url) ? "browser" : "safefetch"}:`
      + `${canonicalDomain}:${collectedAt}:${url}`,
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
  const projectIndustries = industrySignals([
    ...input.project.products,
    ...input.project.topics,
    ...input.project.keywords,
  ].join(" ").toLowerCase());
  const candidateIndustries = industrySignals(combinedText);
  const unrelatedIndustry = projectIndustries.size > 0
    && candidateIndustries.size > 0
    && [...projectIndustries].every((industry) =>
      !candidateIndustries.has(industry)
    )
    && (productRelevance ?? 0) === 0;

  return Object.freeze({
    canonicalDomain,
    decision:
      degradedDecision !== null && !successfulDiscoveryEvidence
        ? degradedDecision
        : "ready",
    language: languages[0] ?? null,
    topics: Object.freeze([
      ...matchedProducts,
      ...matchedTopics,
      ...matchedKeywords,
    ].slice(0, 20)),
    matchedProducts,
    matchedTopics,
    matchedKeywords,
    matchedTargetPages,
    matchedAudiences,
    matchedPartnershipGoals,
    relatedContentPages,
    productRelevance,
    editorialQuality,
    siteType: classifySite(combinedText),
    monetizationMethods: monetizationMethods(combinedText),
    cooperationPages,
    outboundLinkDensity: totalLinks === 0
      ? 0
      : clamp(externalLinks / totalLinks),
    technicalAccessibility: clamp(pages.length / attemptedUrls.length),
    unsafeOrMalicious,
    highConfidenceLinkFarm,
    unrelatedIndustry,
    evidenceUrls,
    evidenceRefs,
    failedUrls: unique(failedUrls),
    collectedAt,
    ruleVersion: commercialStaticAssessmentRuleVersion,
  });
}
