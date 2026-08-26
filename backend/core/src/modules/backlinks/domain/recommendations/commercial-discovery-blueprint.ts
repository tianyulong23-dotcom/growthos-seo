import { createHash } from "node:crypto";

import { createRecommendationDomainKey } from "./domain-key.js";

export const commercialDiscoveryBlueprintVersion = 5;
export const commercialDiscoveryBlueprintSchemaVersion =
  "commercial-discovery-blueprint.v5";
export const commercialDiscoveryPromptVersion =
  "commercial-discovery-blueprint-prompt.v5";
export const commercialDiscoveryRuleVersion =
  "commercial-discovery-blueprint-rules.v5";
export const commercialDiscoverySourceHierarchy = Object.freeze([
  "PROJECT_EXPLICIT_COMPETITORS",
  "DATAFORSEO_CURRENT_DOMAIN_COMPETITORS",
  "PROJECT_MARKET_SERP",
  "INDUSTRY_EDITORIAL_ECOSYSTEM",
] as const);

export type CommercialDiscoveryHypothesis = Readonly<{
  targetAudience: readonly string[];
  productValuePropositions: readonly string[];
  topicClusters: readonly string[];
  searchQueryClusters: readonly string[];
  targetSiteArchetypes: readonly string[];
  cooperationAngles: readonly string[];
  negativeKeywords: readonly string[];
  excludedSiteTypes: readonly string[];
  discoveredCompetitorSeeds: readonly string[];
}>;

export type CommercialDiscoveryInputReadiness =
  | "READY"
  | "PROJECT_EVIDENCE_REFRESH_REQUIRED";

export type CommercialDiscoveryBlueprintContext = Readonly<{
  projectContextVersionId: string;
  projectSettingsVersionId: string;
  projectSettingsVersion: number;
  canonicalDomain: string;
  countries: readonly string[];
  languages: readonly string[];
  products: readonly string[];
  keywords: readonly string[];
  promotionTargetUrls: readonly string[];
  declaredTargetAudiences: readonly string[];
  partnershipGoals: readonly string[];
  explicitCompetitorDomains: readonly string[];
  historicalFeedbackDomains: readonly string[];
  evidenceRefs: readonly string[];
}>;

export type CommercialDiscoveryAiModel = Readonly<{
  providerRef: string;
  modelId: string;
  modelVersion: string;
}>;

export type CommercialDiscoveryAiGeneration = Readonly<{
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
}>;

export type CommercialDiscoveryBlueprint = Readonly<{
  blueprintVersion: typeof commercialDiscoveryBlueprintVersion;
  schemaVersion: typeof commercialDiscoveryBlueprintSchemaVersion;
  projectContextVersionId: string;
  projectSettingsVersionId: string;
  projectSettingsVersion: number;
  canonicalDomain: string;
  countries: readonly string[];
  languages: readonly string[];
  products: readonly string[];
  keywords: readonly string[];
  promotionTargetUrls: readonly string[];
  declaredTargetAudiences: readonly string[];
  partnershipGoals: readonly string[];
  targetAudience: readonly string[];
  productValuePropositions: readonly string[];
  topicClusters: readonly string[];
  searchQueryClusters: readonly string[];
  targetSiteArchetypes: readonly string[];
  cooperationAngles: readonly string[];
  negativeKeywords: readonly string[];
  excludedSiteTypes: readonly string[];
  explicitCompetitorDomains: readonly string[];
  historicalFeedbackDomains: readonly string[];
  competitorSuggestions: readonly string[];
  discoveredCompetitorSeeds: readonly string[];
  inputReadiness: CommercialDiscoveryInputReadiness;
  sourceHierarchy: typeof commercialDiscoverySourceHierarchy;
  inputSummary: Readonly<{
    fingerprint: string;
    countryCount: number;
    languageCount: number;
    productCount: number;
    keywordCount: number;
    promotionTargetCount: number;
    targetAudienceCount: number;
    partnershipGoalCount: number;
    explicitCompetitorCount: number;
    semanticSeedCount: number;
  }>;
  evidenceRefs: readonly string[];
  generator: "AI" | "DETERMINISTIC_FALLBACK";
  generationMode: "MODEL" | "DETERMINISTIC_FALLBACK";
  fallbackReason: string | null;
  discoveryInputs: Readonly<{
    projectContextVersionId: string;
    projectSettingsVersionId: string;
    projectSettingsVersion: number;
    canonicalDomain: string;
    countries: readonly string[];
    languages: readonly string[];
    products: readonly string[];
    keywords: readonly string[];
    promotionTargetUrls: readonly string[];
    declaredTargetAudiences: readonly string[];
    partnershipGoals: readonly string[];
    explicitCompetitorDomains: readonly string[];
    historicalFeedbackDomains: readonly string[];
  }>;
  promptVersion: typeof commercialDiscoveryPromptVersion;
  modelVersion: string | null;
  model: CommercialDiscoveryAiModel | null;
  generation: CommercialDiscoveryAiGeneration | null;
  ruleVersion: typeof commercialDiscoveryRuleVersion;
}>;

const hypothesisKeys = Object.freeze([
  "targetAudience",
  "productValuePropositions",
  "topicClusters",
  "searchQueryClusters",
  "targetSiteArchetypes",
  "cooperationAngles",
  "negativeKeywords",
  "excludedSiteTypes",
  "discoveredCompetitorSeeds",
] as const);

function stringList(
  value: unknown,
  minimum: number,
  maximum: number,
  maxLength: number,
): readonly string[] | null {
  if (
    !Array.isArray(value)
    || value.length < minimum
    || value.length > maximum
  ) {
    return null;
  }
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const normalized = item.trim();
    if (normalized.length === 0 || normalized.length > maxLength) return null;
    values.push(normalized);
  }
  return Object.freeze(values);
}

function parseHypothesis(value: unknown): CommercialDiscoveryHypothesis | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== hypothesisKeys.length
    || Object.keys(record).some(
      (key) => !hypothesisKeys.includes(
        key as (typeof hypothesisKeys)[number],
      ),
    )
  ) {
    return null;
  }
  const targetAudience = stringList(record.targetAudience, 1, 6, 320);
  const productValuePropositions = stringList(
    record.productValuePropositions,
    1,
    6,
    320,
  );
  const topicClusters = stringList(record.topicClusters, 1, 8, 320);
  const searchQueryClusters = stringList(
    record.searchQueryClusters,
    4,
    12,
    256,
  );
  const targetSiteArchetypes = stringList(
    record.targetSiteArchetypes,
    1,
    6,
    320,
  );
  const cooperationAngles = stringList(
    record.cooperationAngles,
    1,
    6,
    320,
  );
  const negativeKeywords = stringList(
    record.negativeKeywords,
    0,
    12,
    320,
  );
  const excludedSiteTypes = stringList(
    record.excludedSiteTypes,
    0,
    12,
    320,
  );
  const discoveredCompetitorSeeds = stringList(
    record.discoveredCompetitorSeeds,
    0,
    8,
    253,
  );
  if (
    targetAudience === null
    || productValuePropositions === null
    || topicClusters === null
    || searchQueryClusters === null
    || targetSiteArchetypes === null
    || cooperationAngles === null
    || negativeKeywords === null
    || excludedSiteTypes === null
    || discoveredCompetitorSeeds === null
  ) {
    return null;
  }
  return Object.freeze({
    targetAudience,
    productValuePropositions,
    topicClusters,
    searchQueryClusters,
    targetSiteArchetypes,
    cooperationAngles,
    negativeKeywords,
    excludedSiteTypes,
    discoveredCompetitorSeeds,
  });
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ]);
}

function domains(values: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  for (const value of values) {
    try {
      normalized.push(createRecommendationDomainKey(value).registrableDomain);
    } catch {
      // AI and project setting domain candidates are untrusted inputs.
    }
  }
  return Object.freeze([...new Set(normalized)]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function marketName(
  countries: readonly string[],
  languages: readonly string[],
): string {
  const country = unique(countries)[0];
  if (country === undefined) return "";
  try {
    return new Intl.DisplayNames(
      [unique(languages)[0] ?? "en"],
      { type: "region" },
    ).of(country.toUpperCase())?.trim() || country.toUpperCase();
  } catch {
    return country.toUpperCase();
  }
}

function stripProjectBrand(
  value: string,
  canonicalDomain: string,
): string {
  const brand = createRecommendationDomainKey(canonicalDomain)
    .registrableDomain.split(".")[0]?.trim() ?? "";
  if (brand.length < 3) return value.trim();
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return value
    .replace(new RegExp(`\\b${escaped}\\b`, "giu"), " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function semanticSeeds(
  context: CommercialDiscoveryBlueprintContext,
): readonly string[] {
  return unique([...context.keywords, ...context.products]
    .map((value) => stripProjectBrand(value, context.canonicalDomain))
    .filter(Boolean))
    .slice(0, 4);
}

export function assessCommercialDiscoveryInputReadiness(
  context: CommercialDiscoveryBlueprintContext,
): CommercialDiscoveryInputReadiness {
  const hasMarket = unique(context.countries).length > 0;
  const hasLanguage = unique(context.languages).length > 0;
  const hasPromotionTopic =
    unique(context.promotionTargetUrls).length > 0
    || unique(context.keywords).length > 0;
  return hasMarket
      && hasLanguage
      && hasPromotionTopic
      && semanticSeeds(context).length > 0
    ? "READY"
    : "PROJECT_EVIDENCE_REFRESH_REQUIRED";
}

function query(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(" ");
}

export function buildDeterministicCommercialDiscoveryHypothesis(
  context: CommercialDiscoveryBlueprintContext,
): CommercialDiscoveryHypothesis {
  const subjects = semanticSeeds(context);
  const market = marketName(context.countries, context.languages);
  const ready = assessCommercialDiscoveryInputReadiness(context) === "READY";
  const primarySubject = subjects[0] ?? "";
  const adjacentSubject = subjects[1] ?? primarySubject;
  const audiences = unique(context.declaredTargetAudiences).slice(0, 6);
  const goals = unique(context.partnershipGoals);
  const topicFamilies = unique([...subjects, ...audiences]).slice(0, 8);
  const siteArchetypes = [
    "specialist blog",
    "industry publication",
    "local or regional publication",
    "resource directory",
    "review publication",
    "adjacent industry publication",
  ];
  const searchQueryClusters = ready
    ? unique([
        query([market, primarySubject, "blogs"]),
        query([market, primarySubject, "publications"]),
        query([market, primarySubject, "websites"]),
        query([market, primarySubject, "industry publications"]),
        query([`"${primarySubject}"`, "\"write for us\"", market]),
        query([`"${primarySubject}"`, "\"contribute\"", market]),
        query([market, primarySubject, "\"advertise with us\""]),
        query([market, primarySubject, "\"media kit\""]),
        query([market, primarySubject, "\"submit a resource\""]),
        query([market, primarySubject, "useful links"]),
        query([market, primarySubject, "resource directory"]),
        query([
          market,
          adjacentSubject,
          "adjacent industry publications",
        ]),
      ]).slice(0, 12)
    : Object.freeze([]);
  return Object.freeze({
    targetAudience: audiences.length > 0
      ? audiences
      : subjects.map((subject) => query([market, subject, "audience"]))
        .slice(0, 6),
    productValuePropositions: (context.products.length > 0
      ? context.products
      : subjects
    ).map((product) => stripProjectBrand(product, context.canonicalDomain))
      .filter(Boolean)
      .slice(0, 6),
    topicClusters: topicFamilies,
    searchQueryClusters,
    targetSiteArchetypes: siteArchetypes,
    cooperationAngles: goals.length > 0
      ? goals.slice(0, 6)
      : [
        "expert contribution",
        "resource inclusion",
        "editorial review",
        "media partnership",
      ],
    negativeKeywords: [
      "casino", "adult", "payday loan", "link farm", "pbn",
    ],
    excludedSiteTypes: [
      "social network", "search engine", "generic tool", "link marketplace",
    ],
    discoveredCompetitorSeeds: [],
  });
}

function discoveryInputs(context: CommercialDiscoveryBlueprintContext) {
  return Object.freeze({
    projectContextVersionId: context.projectContextVersionId.trim(),
    projectSettingsVersionId: context.projectSettingsVersionId.trim(),
    projectSettingsVersion: context.projectSettingsVersion,
    canonicalDomain:
      createRecommendationDomainKey(context.canonicalDomain).registrableDomain,
    countries: unique(context.countries),
    languages: unique(context.languages),
    products: unique(context.products),
    keywords: unique(context.keywords),
    promotionTargetUrls: unique(context.promotionTargetUrls),
    declaredTargetAudiences: unique(context.declaredTargetAudiences),
    partnershipGoals: unique(context.partnershipGoals),
    explicitCompetitorDomains: domains(context.explicitCompetitorDomains),
    historicalFeedbackDomains: domains(
      context.historicalFeedbackDomains ?? [],
    ),
  });
}

function inputSummary(context: CommercialDiscoveryBlueprintContext) {
  const normalized = discoveryInputs(context);
  return Object.freeze({
    fingerprint: createHash("sha256")
      .update(stableJson(normalized), "utf8")
      .digest("hex"),
    countryCount: normalized.countries.length,
    languageCount: normalized.languages.length,
    productCount: normalized.products.length,
    keywordCount: normalized.keywords.length,
    promotionTargetCount: normalized.promotionTargetUrls.length,
    targetAudienceCount: normalized.declaredTargetAudiences.length,
    partnershipGoalCount: normalized.partnershipGoals.length,
    explicitCompetitorCount: normalized.explicitCompetitorDomains.length,
    semanticSeedCount: semanticSeeds(context).length,
  });
}

export function buildCommercialDiscoveryBlueprint(input: Readonly<{
  context: CommercialDiscoveryBlueprintContext;
  aiOutput?: unknown;
  aiModel?: CommercialDiscoveryAiModel | undefined;
  aiGeneration?: CommercialDiscoveryAiGeneration | undefined;
  observedCompetitorDomains?: readonly string[];
  additionalEvidenceRefs?: readonly string[];
  fallbackReason?: string | undefined;
}>): CommercialDiscoveryBlueprint {
  const context = input.context;
  if (
    context.projectContextVersionId.trim().length === 0
    || context.projectSettingsVersionId.trim().length === 0
    || !Number.isInteger(context.projectSettingsVersion)
    || context.projectSettingsVersion < 1
  ) {
    throw new TypeError("Project context and settings versions are required");
  }
  const canonicalDomain =
    createRecommendationDomainKey(context.canonicalDomain).registrableDomain;
  const explicitCompetitorDomains = domains(context.explicitCompetitorDomains)
    .filter((domain) => domain !== canonicalDomain);
  const historicalFeedbackDomains = domains(
    context.historicalFeedbackDomains ?? [],
  ).filter((domain) => domain !== canonicalDomain);
  const explicit = new Set(explicitCompetitorDomains);
  const parsedAi = input.aiOutput === undefined
    ? null
    : parseHypothesis(input.aiOutput);
  const hypothesis = parsedAi
    ?? buildDeterministicCommercialDiscoveryHypothesis(context);
  const observed = new Set(domains(input.observedCompetitorDomains ?? []));
  const competitorSuggestions = domains(
    hypothesis.discoveredCompetitorSeeds,
  ).filter((domain) => domain !== canonicalDomain && !explicit.has(domain));
  const discoveredCompetitorSeeds = competitorSuggestions.filter(
    (domain) => observed.has(domain),
  );
  const declaredTargetAudiences = unique(context.declaredTargetAudiences);
  const partnershipGoals = unique(context.partnershipGoals);
  const generator = parsedAi === null ? "DETERMINISTIC_FALLBACK" : "AI";
  const fallbackReason = generator === "AI"
    ? null
    : input.fallbackReason?.trim()
      || (input.aiOutput === undefined
        ? "AI_NOT_CONFIGURED"
        : "AI_OUTPUT_INVALID");

  return Object.freeze({
    blueprintVersion: commercialDiscoveryBlueprintVersion,
    schemaVersion: commercialDiscoveryBlueprintSchemaVersion,
    projectContextVersionId: context.projectContextVersionId.trim(),
    projectSettingsVersionId: context.projectSettingsVersionId.trim(),
    projectSettingsVersion: context.projectSettingsVersion,
    canonicalDomain,
    countries: unique(context.countries),
    languages: unique(context.languages),
    products: unique(context.products),
    keywords: unique(context.keywords),
    promotionTargetUrls: unique(context.promotionTargetUrls),
    declaredTargetAudiences,
    partnershipGoals,
    targetAudience: unique([
      ...declaredTargetAudiences,
      ...hypothesis.targetAudience,
    ]),
    productValuePropositions: unique(hypothesis.productValuePropositions),
    topicClusters: unique(hypothesis.topicClusters),
    searchQueryClusters: unique(hypothesis.searchQueryClusters),
    targetSiteArchetypes: unique(hypothesis.targetSiteArchetypes),
    cooperationAngles: unique([
      ...partnershipGoals,
      ...hypothesis.cooperationAngles,
    ]),
    negativeKeywords: unique(hypothesis.negativeKeywords),
    excludedSiteTypes: unique(hypothesis.excludedSiteTypes),
    explicitCompetitorDomains,
    historicalFeedbackDomains,
    competitorSuggestions,
    discoveredCompetitorSeeds,
    inputReadiness: assessCommercialDiscoveryInputReadiness(context),
    sourceHierarchy: commercialDiscoverySourceHierarchy,
    inputSummary: inputSummary(context),
    evidenceRefs: unique([
      ...context.evidenceRefs,
      ...(input.additionalEvidenceRefs ?? []),
    ]),
    generator,
    generationMode: generator === "AI"
      ? "MODEL"
      : "DETERMINISTIC_FALLBACK",
    fallbackReason,
    discoveryInputs: discoveryInputs(context),
    promptVersion: commercialDiscoveryPromptVersion,
    modelVersion: generator === "AI"
      ? input.aiModel?.modelVersion.trim() || "unknown"
      : null,
    model: generator === "AI" && input.aiModel !== undefined
      ? Object.freeze({ ...input.aiModel })
      : null,
    generation: generator === "AI" && input.aiGeneration !== undefined
      ? Object.freeze({ ...input.aiGeneration })
      : null,
    ruleVersion: commercialDiscoveryRuleVersion,
  });
}
