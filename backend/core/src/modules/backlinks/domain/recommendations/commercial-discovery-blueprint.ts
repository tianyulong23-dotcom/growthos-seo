import { z } from "zod";

import { createRecommendationDomainKey } from "./domain-key.js";

export const commercialDiscoveryBlueprintSchemaVersion =
  "commercial-discovery-blueprint.v1";
export const commercialDiscoveryPromptVersion =
  "commercial-discovery-blueprint-prompt.v1";
export const commercialDiscoveryRuleVersion =
  "commercial-discovery-blueprint-rules.v1";

const nonBlank = z.string().trim().min(1).max(2_048);
const nonBlankList = z.array(nonBlank).max(100);
const domainList = z.array(z.string().trim().min(1).max(253)).max(50);

export const commercialDiscoveryHypothesisSchema = z.object({
  targetAudience: nonBlankList,
  productValuePropositions: nonBlankList,
  topicClusters: nonBlankList,
  searchQueryClusters: nonBlankList,
  targetSiteArchetypes: nonBlankList,
  cooperationAngles: nonBlankList,
  negativeKeywords: nonBlankList,
  excludedSiteTypes: nonBlankList,
  discoveredCompetitorSeeds: domainList,
}).strict();

export type CommercialDiscoveryHypothesis = Readonly<
  z.output<typeof commercialDiscoveryHypothesisSchema>
>;

export type CommercialDiscoveryBlueprint = Readonly<{
  schemaVersion: typeof commercialDiscoveryBlueprintSchemaVersion;
  projectContextVersionId: string;
  countries: readonly string[];
  languages: readonly string[];
  products: readonly string[];
  keywords: readonly string[];
  promotionTargetUrls: readonly string[];
  targetAudience: readonly string[];
  productValuePropositions: readonly string[];
  topicClusters: readonly string[];
  searchQueryClusters: readonly string[];
  targetSiteArchetypes: readonly string[];
  cooperationAngles: readonly string[];
  negativeKeywords: readonly string[];
  excludedSiteTypes: readonly string[];
  explicitCompetitorDomains: readonly string[];
  discoveredCompetitorSeeds: readonly string[];
  evidenceRefs: readonly string[];
  generator: "AI" | "DETERMINISTIC_FALLBACK";
  promptVersion: typeof commercialDiscoveryPromptVersion;
  modelVersion: string | null;
  ruleVersion: typeof commercialDiscoveryRuleVersion;
}>;

type BlueprintContext = Readonly<{
  projectContextVersionId: string;
  countries: readonly string[];
  languages: readonly string[];
  products: readonly string[];
  keywords: readonly string[];
  promotionTargetUrls: readonly string[];
  explicitCompetitorDomains?: readonly string[];
  evidenceRefs: readonly string[];
}>;

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
      // Domain hypotheses are untrusted input and cannot block the Blueprint.
    }
  }
  return Object.freeze([...new Set(normalized)].sort());
}

function deterministicHypothesis(
  context: BlueprintContext,
): CommercialDiscoveryHypothesis {
  const subjects = unique([...context.products, ...context.keywords]).slice(0, 20);
  const countries = unique(context.countries);
  return Object.freeze({
    targetAudience: subjects.map((subject) => `${subject} buyers and operators`),
    productValuePropositions: context.products.map(
      (product) => `${product} practical value and use cases`,
    ),
    topicClusters: subjects,
    searchQueryClusters: subjects.flatMap((subject) => [
      `${subject} resources`,
      `${subject} guide`,
      `${subject} industry publication`,
    ]).slice(0, 50),
    targetSiteArchetypes: [
      "industry publication",
      "specialist blog",
      "resource directory",
      "partner ecosystem",
    ],
    cooperationAngles: [
      "expert contribution",
      "resource inclusion",
      "data-backed editorial collaboration",
    ],
    negativeKeywords: [
      "casino", "adult", "payday loan", "link farm", "pbn",
    ],
    excludedSiteTypes: [
      "social network", "search engine", "generic tool", "link marketplace",
    ],
    discoveredCompetitorSeeds: [],
    ...(countries.length === 0 ? {} : {
      targetAudience: subjects.map(
        (subject) => `${countries.join("/")} ${subject} buyers and operators`,
      ),
    }),
  });
}

export function buildCommercialDiscoveryBlueprint(input: Readonly<{
  context: BlueprintContext;
  aiOutput?: unknown;
  aiModelVersion?: string;
  observedCompetitorDomains?: readonly string[];
}>): CommercialDiscoveryBlueprint {
  const context = input.context;
  if (context.projectContextVersionId.trim().length === 0) {
    throw new TypeError("projectContextVersionId is required");
  }
  const parsedAi = input.aiOutput === undefined
    ? null
    : commercialDiscoveryHypothesisSchema.safeParse(input.aiOutput);
  const hypothesis = parsedAi?.success === true
    ? parsedAi.data
    : deterministicHypothesis(context);
  const observed = new Set(domains(input.observedCompetitorDomains ?? []));
  const discoveredCompetitorSeeds = domains(
    hypothesis.discoveredCompetitorSeeds,
  ).filter((domain) => observed.has(domain));

  return Object.freeze({
    schemaVersion: commercialDiscoveryBlueprintSchemaVersion,
    projectContextVersionId: context.projectContextVersionId.trim(),
    countries: unique(context.countries),
    languages: unique(context.languages),
    products: unique(context.products),
    keywords: unique(context.keywords),
    promotionTargetUrls: unique(context.promotionTargetUrls),
    targetAudience: unique(hypothesis.targetAudience),
    productValuePropositions: unique(hypothesis.productValuePropositions),
    topicClusters: unique(hypothesis.topicClusters),
    searchQueryClusters: unique(hypothesis.searchQueryClusters),
    targetSiteArchetypes: unique(hypothesis.targetSiteArchetypes),
    cooperationAngles: unique(hypothesis.cooperationAngles),
    negativeKeywords: unique(hypothesis.negativeKeywords),
    excludedSiteTypes: unique(hypothesis.excludedSiteTypes),
    explicitCompetitorDomains: domains(
      context.explicitCompetitorDomains ?? [],
    ),
    discoveredCompetitorSeeds,
    evidenceRefs: unique(context.evidenceRefs),
    generator: parsedAi?.success === true ? "AI" : "DETERMINISTIC_FALLBACK",
    promptVersion: commercialDiscoveryPromptVersion,
    modelVersion: parsedAi?.success === true
      ? input.aiModelVersion?.trim() || "unknown"
      : null,
    ruleVersion: commercialDiscoveryRuleVersion,
  });
}
