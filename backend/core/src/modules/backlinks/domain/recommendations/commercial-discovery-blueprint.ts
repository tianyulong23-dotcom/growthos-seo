import { createHash } from "node:crypto";

import { createRecommendationDomainKey } from "./domain-key.js";

export const commercialDiscoveryBlueprintVersion = 3;
export const commercialDiscoveryBlueprintSchemaVersion =
  "commercial-discovery-blueprint.v3";
export const commercialDiscoveryPromptVersion =
  "commercial-discovery-blueprint-prompt.v3";
export const commercialDiscoveryRuleVersion =
  "commercial-discovery-blueprint-rules.v3";
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
  const targetAudience = stringList(record.targetAudience, 1, 100, 2_048);
  const productValuePropositions = stringList(
    record.productValuePropositions,
    1,
    100,
    2_048,
  );
  const topicClusters = stringList(record.topicClusters, 1, 100, 2_048);
  const searchQueryClusters = stringList(
    record.searchQueryClusters,
    1,
    100,
    2_048,
  );
  const targetSiteArchetypes = stringList(
    record.targetSiteArchetypes,
    1,
    100,
    2_048,
  );
  const cooperationAngles = stringList(
    record.cooperationAngles,
    1,
    100,
    2_048,
  );
  const negativeKeywords = stringList(
    record.negativeKeywords,
    0,
    100,
    2_048,
  );
  const excludedSiteTypes = stringList(
    record.excludedSiteTypes,
    0,
    100,
    2_048,
  );
  const discoveredCompetitorSeeds = stringList(
    record.discoveredCompetitorSeeds,
    0,
    50,
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

function deterministicHypothesis(
  context: CommercialDiscoveryBlueprintContext,
): CommercialDiscoveryHypothesis {
  const canonicalDomain =
    createRecommendationDomainKey(context.canonicalDomain).registrableDomain;
  const subjects = unique([...context.products, ...context.keywords])
    .slice(0, 20);
  const boundedSubjects = subjects.length > 0 ? subjects : [canonicalDomain];
  const countries = unique(context.countries);
  const market = countries.length > 0 ? `${countries.join("/")} ` : "";
  const audiences = unique(context.declaredTargetAudiences);
  const goals = unique(context.partnershipGoals);
  const topicFamilies = unique([
    ...boundedSubjects,
    ...boundedSubjects.map((subject) => `${subject} use cases`),
    ...boundedSubjects.map((subject) => `${subject} buying advice`),
    ...boundedSubjects.map((subject) => `${subject} industry trends`),
    ...boundedSubjects.map((subject) => `${subject} customer education`),
  ]).slice(0, 100);
  const siteArchetypes = [
    "industry publication",
    "specialist editorial blog",
    "consumer guide",
    "review and comparison site",
    "trade association",
    "professional community",
    "resource hub",
    "partner directory",
    "newsletter",
    "podcast or expert interview site",
    "local or regional publication",
    "adjacent industry publication",
  ];
  return Object.freeze({
    targetAudience: audiences.length > 0
      ? audiences
      : boundedSubjects.map(
        (subject) => `${market}${subject} buyers and operators`,
      ),
    productValuePropositions: (context.products.length > 0
      ? context.products
      : boundedSubjects
    ).map((product) => `${product} practical value and use cases`),
    topicClusters: topicFamilies,
    searchQueryClusters: topicFamilies.flatMap((subject) =>
      siteArchetypes.map((archetype) =>
        `${market}${subject} ${archetype}`,
      )
    ).slice(0, 100),
    targetSiteArchetypes: siteArchetypes,
    cooperationAngles: goals.length > 0
      ? goals
      : [
        "expert contribution",
        "resource inclusion",
        "data-backed editorial collaboration",
        "product review or comparison",
        "expert interview",
        "audience education",
        "partner directory inclusion",
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
  const hypothesis = parsedAi ?? deterministicHypothesis(context);
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
