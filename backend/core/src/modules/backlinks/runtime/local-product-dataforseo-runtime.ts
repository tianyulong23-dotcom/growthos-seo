import { randomUUID } from "node:crypto";

import { load } from "cheerio";
import { z } from "zod";

import { createCommercialOfficialDataForSeoRuntime } from "../adapters/dataforseo/commercial-official-runtime.js";
import { SafeFetchAdapter } from "../adapters/http/safe-fetch.adapter.js";
import {
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import { DataForSeoCallPolicy } from "../application/policies/dataforseo-call.policy.js";
import { executeCommercialRecommendationDiscovery } from "../application/services/commercial-recommendation-discovery.service.js";
import type {
  BacklinkRecommendationRefillActivities,
  RecommendationProviderExecutionSummary,
} from "../workflows/definitions/backlink-recommendation-refill.orchestration.js";
import type { EvidenceValue } from "../domain/evidence/evidence.js";
import { createRecommendationDomainKey } from "../domain/recommendations/domain-key.js";
import { commercialRecommendationFitRuleVersion } from "../domain/recommendations/commercial-score-v3.js";
import {
  isCommercialRefillTier,
  parseCommercialRefillWindowKey,
  type CommercialRefillTier,
} from "../domain/recommendations/commercial-refill-cycle.js";
import type { RecommendationEvidenceCandidate } from "../domain/recommendations/evaluation.js";
import {
  type RecommendationGateRuleId,
  type RecommendationRuleFacts,
} from "../domain/recommendations/gates.js";
import {
  recommendationScoreComponentIds,
  type RecommendationScoreComponentId,
  type RecommendationScoreComponentInput,
} from "../domain/recommendations/scoring.js";
import { createProviderBudgetRepository } from "../db/repositories/provider-budget.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantContext,
  type BacklinkTenantPool,
  type BacklinkTenantPoolClient,
} from "../db/tenant-transaction.js";
import type { ReferringDomainEvidence } from "../ports/dataforseo.port.js";
import type { AiCommercialDiscoveryBlueprintPort } from "../ports/ai-commercial-discovery-blueprint.port.js";
import type { SafeFetchPort } from "../ports/safe-fetch.port.js";
import { secretKinds } from "../ports/secret-store.port.js";
import {
  localProductDataForSeoCredentialReferenceSchema,
  localProductDataForSeoEndpointAllowlistSchema,
  localProductDataForSeoMaximumTimeoutMs,
} from "./local-product-dataforseo-bootstrap.js";

const evidencePolicyVersion = "recommendation-evidence-policy.v1";
const evidenceDerivationRuleVersion = "local-product-dataforseo-evidence.v1";
const scoreNormalizationRuleVersion =
  "local-product-dataforseo-score-normalization.v1";
const maxWebsiteEvidenceBytes = 512_000;
const maxWebsiteRedirects = 4;
const websiteFetchConcurrency = 8;

const jsonStringArraySchema = z
  .array(z.string().trim().min(1).max(2_048))
  .min(1)
  .max(100);
const dataForSeoCredentialSchema = z
  .object({
    login: z.string().trim().min(1).max(512),
    password: z.string().min(1).max(2_048),
  })
  .strict();
const storedCommercialScoreSchema = z
  .object({
    decision: z.literal("eligible"),
    scoreModelVersion: z.literal("recommendation-commercial-fit.v3"),
    ruleVersion: z.literal(commercialRecommendationFitRuleVersion),
    total: z.number().min(0).max(100),
    components: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          weight: z.number().min(0).max(100),
        })
        .passthrough(),
    ),
    hitGates: z.array(z.string()),
    missingEvidence: z.array(z.string()),
    details: z
      .object({
        market: z
          .object({
            candidateCountry: z.string().nullable(),
          })
          .passthrough(),
        dataForSeo: z
          .object({
            rank: z.number().nullable(),
            backlinks: z.number().nullable(),
            spamScore: z.number().nullable(),
            collectedAt: z.string().trim().min(1),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
const configurationSchema = z
  .object({
    credentialSecretRef: localProductDataForSeoCredentialReferenceSchema,
    endpointAllowlist: localProductDataForSeoEndpointAllowlistSchema,
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(localProductDataForSeoMaximumTimeoutMs),
    estimatedCostMicros: z.number().int().positive().max(100_000_000),
    absoluteBudgetMicros: z.number().int().positive().max(100_000_000),
    maxPaidCalls: z.number().int().min(1).max(1_000),
    candidateLimit: z.number().int().min(10).max(100),
    locationCode: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]*$/u),
    languageCode: z.string().trim().min(2).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.absoluteBudgetMicros < value.estimatedCostMicros) {
      context.addIssue({
        code: "custom",
        path: ["absoluteBudgetMicros"],
        message: "DataForSEO budget must cover the estimated request.",
      });
    }
  });
const projectRecommendationContextSchema = z
  .object({
    snapshotVersion: z.coerce.number().int().positive(),
    projectSettingsVersionId: z.string().uuid(),
    projectSettingsVersion: z.coerce.number().int().positive(),
    projectStatus: z.literal("ACTIVE"),
    canonicalDomain: z.string().trim().min(1).max(253),
    locale: z.string().trim().min(1).max(32),
    countryCode: z.string().trim().min(1).max(64),
    products: jsonStringArraySchema,
    keywords: jsonStringArraySchema,
    targetUrls: z.array(z.string().trim().url().max(2_048)).min(1).max(100),
    targetAudiences: z
      .array(z.string().trim().min(1).max(2_048))
      .max(100)
      .default([]),
    partnershipGoals: z
      .array(z.string().trim().min(1).max(2_048))
      .max(100)
      .default([]),
    explicitCompetitorDomains: z
      .array(z.string().trim().min(1).max(253))
      .max(100)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      createRecommendationDomainKey(value.canonicalDomain);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["canonicalDomain"],
        message: "Project canonical domain must be a public domain.",
      });
    }
    for (const targetUrl of value.targetUrls) {
      const url = new URL(targetUrl);
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.hostname === "example.invalid" ||
        url.hostname.endsWith(".example.invalid")
      ) {
        context.addIssue({
          code: "custom",
          path: ["targetUrls"],
          message:
            "Project target URLs must be real credential-free HTTPS URLs.",
        });
      }
    }
    for (const domain of value.explicitCompetitorDomains) {
      try {
        createRecommendationDomainKey(domain);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["explicitCompetitorDomains"],
          message: "Project explicit competitor domain is invalid.",
        });
      }
    }
  });

export type LocalProductDataForSeoConfiguration = Readonly<
  z.output<typeof configurationSchema>
>;
export type LocalProductRecommendationContext = Readonly<
  Omit<
    z.output<typeof projectRecommendationContextSchema>,
    | "products"
    | "keywords"
    | "targetUrls"
    | "targetAudiences"
    | "partnershipGoals"
    | "explicitCompetitorDomains"
  > &
    Readonly<{
      products: readonly string[];
      keywords: readonly string[];
      targetUrls: readonly string[];
      targetAudiences: readonly string[];
      partnershipGoals: readonly string[];
      explicitCompetitorDomains: readonly string[];
    }>
>;

export function parseLocalProductRecommendationContext(
  value: unknown,
): LocalProductRecommendationContext {
  const parsed = projectRecommendationContextSchema.parse(value);
  return Object.freeze({
    ...parsed,
    products: Object.freeze([...parsed.products]),
    keywords: Object.freeze([...parsed.keywords]),
    targetUrls: Object.freeze([...parsed.targetUrls]),
    targetAudiences: Object.freeze([...parsed.targetAudiences]),
    partnershipGoals: Object.freeze([...parsed.partnershipGoals]),
    explicitCompetitorDomains: Object.freeze([
      ...parsed.explicitCompetitorDomains,
    ]),
  });
}

export function isLocalProductDataForSeoPaidCallAllowed(
  paidCallCount: number,
  maxPaidCalls: number,
): boolean {
  return paidCallCount < maxPaidCalls;
}

type Environment = Readonly<Record<string, string | undefined>>;

function requiredEnvironmentValue(
  environment: Environment,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`INPUT_REQUIRED: ${name}`);
  }
  return value;
}

function positiveIntegerEnvironmentValue(
  environment: Environment,
  name: string,
): number {
  const value = requiredEnvironmentValue(environment, name);
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`INPUT_REQUIRED: ${name}`);
  }
  return Number(value);
}

function jsonArrayEnvironmentValue(
  environment: Environment,
  name: string,
): readonly string[] {
  const value = requiredEnvironmentValue(environment, name);
  try {
    return jsonStringArraySchema.parse(JSON.parse(value));
  } catch (error) {
    throw new Error(`INPUT_REQUIRED: ${name}`, { cause: error });
  }
}

export function readLocalProductDataForSeoConfiguration(
  environment: Environment = process.env,
): LocalProductDataForSeoConfiguration {
  return configurationSchema.parse({
    credentialSecretRef: requiredEnvironmentValue(
      environment,
      "DATAFORSEO_CREDENTIAL_SECRET_REF",
    ),
    endpointAllowlist: jsonArrayEnvironmentValue(
      environment,
      "DATAFORSEO_ENDPOINT_ALLOWLIST",
    ),
    timeoutMs: positiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_REQUEST_TIMEOUT_MS",
    ),
    estimatedCostMicros: positiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_ESTIMATED_COST_MICROS",
    ),
    absoluteBudgetMicros: positiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_ABSOLUTE_BUDGET_MICROS",
    ),
    maxPaidCalls: positiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_MAX_PAID_CALLS",
    ),
    candidateLimit: positiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_CANDIDATE_LIMIT",
    ),
    locationCode: requiredEnvironmentValue(
      environment,
      "DATAFORSEO_LOCATION_CODE",
    ),
    languageCode: requiredEnvironmentValue(
      environment,
      "DATAFORSEO_LANGUAGE_CODE",
    ),
  });
}

function evidenceMetadata(
  input: Readonly<{
    sourceType: string;
    sourceReleaseId: string;
    observedAt: string;
    evidenceRefs: readonly string[];
  }>,
) {
  return {
    sourceType: input.sourceType,
    sourceReleaseId: input.sourceReleaseId,
    observedAt: input.observedAt,
    stale: false,
    evidenceRefs: Object.freeze([...input.evidenceRefs]),
  } as const;
}

function derivedEvidence<T>(
  input: Readonly<{
    value: T;
    sourceType: string;
    sourceReleaseId: string;
    observedAt: string;
    confidence: number;
    evidenceRefs: readonly string[];
  }>,
): EvidenceValue<T> {
  return Object.freeze({
    ...evidenceMetadata(input),
    availability: "derived",
    value: input.value,
    confidence: input.confidence,
    derivationRuleVersion: evidenceDerivationRuleVersion,
  });
}

function unavailableEvidence<T>(
  input: Readonly<{
    sourceType: string;
    sourceReleaseId: string;
    observedAt: string;
    evidenceRefs?: readonly string[];
  }>,
): EvidenceValue<T> {
  return Object.freeze({
    ...evidenceMetadata({
      ...input,
      evidenceRefs: input.evidenceRefs ?? [],
    }),
    availability: "unavailable",
    confidence: 0,
    reason: "source_unavailable",
  });
}

function normalizeScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function tokenize(values: readonly string[]): ReadonlySet<string> {
  return new Set(
    values.flatMap((value) =>
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter((token) => token.length >= 3),
    ),
  );
}

function scoreComponent(
  input: Readonly<{
    id: RecommendationScoreComponentId;
    value: number;
    sourceType: string;
    sourceReleaseId: string;
    observedAt: string;
    evidenceRefs: readonly string[];
    reasonCode: string;
  }>,
): RecommendationScoreComponentInput {
  const value = normalizeScore(input.value);
  return Object.freeze({
    id: input.id,
    evidence: derivedEvidence({
      value,
      sourceType: input.sourceType,
      sourceReleaseId: input.sourceReleaseId,
      observedAt: input.observedAt,
      confidence: 0.85,
      evidenceRefs: input.evidenceRefs,
    }),
    normalizedValue: value,
    normalizationRuleVersion: scoreNormalizationRuleVersion,
    reasonCode: input.reasonCode,
  });
}

function unavailableScoreComponent(
  input: Readonly<{
    id: RecommendationScoreComponentId;
    sourceReleaseId: string;
    observedAt: string;
    evidenceRefs: readonly string[];
  }>,
): RecommendationScoreComponentInput {
  return Object.freeze({
    id: input.id,
    evidence: unavailableEvidence<number>({
      sourceType: "static_safe_fetch",
      sourceReleaseId: input.sourceReleaseId,
      observedAt: input.observedAt,
      evidenceRefs: input.evidenceRefs,
    }),
    normalizedValue: null,
    normalizationRuleVersion: scoreNormalizationRuleVersion,
    reasonCode: "WEBSITE_EVIDENCE_UNAVAILABLE",
  });
}

function gateFact(
  ruleId: RecommendationGateRuleId,
  result: EvidenceValue<boolean>,
) {
  return Object.freeze({
    evidenceKey: `recommendation.gate.${ruleId}`,
    result,
  });
}

type BuildCandidateInput = Readonly<{
  context: Readonly<{
    workspaceId: string;
    websiteProjectId: string;
  }>;
  evidence: ReferringDomainEvidence;
  sourceReleaseId: string;
  acquiredAt: string;
  locationCode: string;
  languageCode: string;
  projectTerms: readonly string[];
  existingHostname: boolean;
  existingBacklink: boolean;
  previouslyExcluded: boolean;
  duplicateDomain: boolean;
  safeFetch: Pick<SafeFetchPort, "fetch">;
}>;

function databaseGateFacts(
  input: BuildCandidateInput,
  sourceRefs: readonly string[],
): Pick<
  RecommendationRuleFacts,
  | "user_suppressed"
  | "workspace_suppressed"
  | "platform_suppressed"
  | "existing_backlink"
  | "already_joined"
  | "previously_excluded"
  | "duplicate_domain"
> {
  const value = (flag: boolean, reason: string) =>
    derivedEvidence({
      value: flag,
      sourceType: "postgresql_business_truth",
      sourceReleaseId: input.sourceReleaseId,
      observedAt: input.acquiredAt,
      confidence: 1,
      evidenceRefs: [...sourceRefs, reason],
    });
  return {
    user_suppressed: gateFact(
      "user_suppressed",
      value(false, "postgresql:user-suppression:none"),
    ),
    workspace_suppressed: gateFact(
      "workspace_suppressed",
      value(false, "postgresql:workspace-suppression:none"),
    ),
    platform_suppressed: gateFact(
      "platform_suppressed",
      value(false, "postgresql:platform-suppression:none"),
    ),
    existing_backlink: gateFact(
      "existing_backlink",
      value(input.existingBacklink, "postgresql:placement-dedup"),
    ),
    already_joined: gateFact(
      "already_joined",
      value(input.existingHostname, "postgresql:prospect-dedup"),
    ),
    previously_excluded: gateFact(
      "previously_excluded",
      value(input.previouslyExcluded, "postgresql:recommendation-history"),
    ),
    duplicate_domain: gateFact(
      "duplicate_domain",
      value(input.duplicateDomain, "provider:batch-domain-dedup"),
    ),
  };
}

export async function buildLocalProductRecommendationEvidenceCandidate(
  input: BuildCandidateInput,
): Promise<RecommendationEvidenceCandidate> {
  const domain = createRecommendationDomainKey(input.evidence.domain);
  const providerRef = `dataforseo:${input.sourceReleaseId}:${domain.hostnameAscii}`;
  const sourceRefs = Object.freeze([providerRef]);
  const databaseFacts = databaseGateFacts(input, sourceRefs);
  const providerGraphScore = normalizeScore(
    (Math.log10(input.evidence.backlinkCount + 1) / 5) * 0.55 +
      ((input.evidence.rank ?? 0) / 100) * 0.45,
  );

  try {
    const fetched = await input.safeFetch.fetch({
      url: `https://${domain.hostnameAscii}/`,
      purpose: "seo-assessment",
      workspaceId: input.context.workspaceId,
      websiteProjectId: input.context.websiteProjectId,
      maxBytes: maxWebsiteEvidenceBytes,
      maxRedirects: maxWebsiteRedirects,
    });
    const $ = load(Buffer.from(fetched.body).toString("utf8"));
    const title = $("title").first().text().trim();
    const description =
      $("meta[name='description']").first().attr("content")?.trim() ?? "";
    const pageText = `${title} ${description} ${$("body").text()}`
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 200_000)
      .toLowerCase();
    const pageLanguage = ($("html").attr("lang") ?? "").trim().toLowerCase();
    const totalLinks = $("a[href]").length;
    let externalLinks = 0;
    $("a[href]").each((_index, element) => {
      const href = $(element).attr("href");
      if (href === undefined) return;
      try {
        const target = new URL(href, fetched.finalUrl);
        if (target.protocol === "http:" || target.protocol === "https:") {
          const targetDomain = createRecommendationDomainKey(target.hostname);
          if (targetDomain.registrableDomain !== domain.registrableDomain) {
            externalLinks += 1;
          }
        }
      } catch {
        return;
      }
    });

    const unsafeTerms = [
      "malware",
      "phishing",
      "credential theft",
      "ransomware",
    ];
    const linkFarmTerms = [
      "buy backlinks",
      "sell backlinks",
      "guest post marketplace",
      "link farm",
      "sponsored links for sale",
    ];
    const unsafe = unsafeTerms.some((term) => pageText.includes(term));
    const linkFarm =
      (input.evidence.spamScore ?? 0) >= 70 ||
      linkFarmTerms.some((term) => pageText.includes(term));
    const crawlNotPermitted = [401, 403, 451].includes(fetched.status);
    const expectedLanguage =
      input.languageCode.toLowerCase().split(/[-_]/u)[0] ??
      input.languageCode.toLowerCase();
    const languageMismatch =
      pageLanguage.length > 0 && !pageLanguage.startsWith(expectedLanguage);
    const marketMismatch =
      input.evidence.countryCode !== null &&
      input.evidence.countryCode !== input.locationCode.toUpperCase() &&
      languageMismatch;
    const websiteRef = `safefetch:${domain.hostnameAscii}:${fetched.fetchedAt}`;
    const combinedRefs = Object.freeze([...sourceRefs, websiteRef]);
    const booleanEvidence = (
      value: boolean,
      sourceType = "static_safe_fetch",
    ) =>
      derivedEvidence({
        value,
        sourceType,
        sourceReleaseId: input.sourceReleaseId,
        observedAt: fetched.fetchedAt,
        confidence: 0.9,
        evidenceRefs: combinedRefs,
      });
    const gates: RecommendationRuleFacts = Object.freeze({
      unsafe_or_malicious: gateFact(
        "unsafe_or_malicious",
        booleanEvidence(unsafe),
      ),
      high_confidence_pbn_or_link_farm: gateFact(
        "high_confidence_pbn_or_link_farm",
        booleanEvidence(linkFarm, "dataforseo_and_static_safe_fetch"),
      ),
      crawl_not_permitted: gateFact(
        "crawl_not_permitted",
        booleanEvidence(crawlNotPermitted),
      ),
      ...databaseFacts,
      market_mismatch: gateFact(
        "market_mismatch",
        booleanEvidence(marketMismatch, "provider_market_and_static_language"),
      ),
    });

    const projectTokens = tokenize(input.projectTerms);
    const pageTokens = tokenize([pageText]);
    const matchedTerms = [...projectTokens].filter((term) =>
      pageTokens.has(term),
    ).length;
    const topicScore =
      projectTokens.size === 0
        ? 0
        : normalizeScore(matchedTerms / Math.min(projectTokens.size, 12));
    const outboundRatio = totalLinks === 0 ? 0 : externalLinks / totalLinks;
    const commercializationScore = normalizeScore(
      1 - outboundRatio * 0.7 - (linkFarm ? 0.3 : 0),
    );
    const networkRiskScore = normalizeScore(
      1 - (input.evidence.spamScore ?? (linkFarm ? 70 : 20)) / 100,
    );
    const technicalScore = normalizeScore(
      (fetched.status >= 200 && fetched.status < 400 ? 0.35 : 0) +
        (fetched.finalUrl.startsWith("https://") ? 0.25 : 0) +
        (title.length > 0 ? 0.25 : 0) +
        (!languageMismatch ? 0.15 : 0),
    );
    const components: readonly RecommendationScoreComponentInput[] =
      Object.freeze([
        scoreComponent({
          id: "graph_authority_diversity",
          value: providerGraphScore,
          sourceType: "dataforseo",
          sourceReleaseId: input.sourceReleaseId,
          observedAt: input.acquiredAt,
          evidenceRefs: sourceRefs,
          reasonCode: "PROVIDER_AUTHORITY_AND_REFERRING_LINKS",
        }),
        scoreComponent({
          id: "topic_content_editorial_quality",
          value: topicScore,
          sourceType: "static_safe_fetch",
          sourceReleaseId: input.sourceReleaseId,
          observedAt: fetched.fetchedAt,
          evidenceRefs: combinedRefs,
          reasonCode: "PROJECT_TERM_CONTENT_OVERLAP",
        }),
        scoreComponent({
          id: "outbound_commercialization",
          value: commercializationScore,
          sourceType: "static_safe_fetch",
          sourceReleaseId: input.sourceReleaseId,
          observedAt: fetched.fetchedAt,
          evidenceRefs: combinedRefs,
          reasonCode: "OUTBOUND_LINK_AND_SELL_LINK_SIGNAL",
        }),
        scoreComponent({
          id: "network_risk",
          value: networkRiskScore,
          sourceType: "dataforseo_and_static_safe_fetch",
          sourceReleaseId: input.sourceReleaseId,
          observedAt: fetched.fetchedAt,
          evidenceRefs: combinedRefs,
          reasonCode: "PROVIDER_SPAM_AND_LINK_FARM_SIGNAL",
        }),
        scoreComponent({
          id: "technical_health",
          value: technicalScore,
          sourceType: "static_safe_fetch",
          sourceReleaseId: input.sourceReleaseId,
          observedAt: fetched.fetchedAt,
          evidenceRefs: combinedRefs,
          reasonCode: "STATIC_FETCH_STATUS_TLS_TITLE_LANGUAGE",
        }),
      ]);
    return Object.freeze({
      hostnameAscii: domain.hostnameAscii,
      sourceReleaseId: input.sourceReleaseId,
      evidencePolicyVersion,
      gates,
      components,
    });
  } catch {
    const unavailable = <T>() =>
      unavailableEvidence<T>({
        sourceType: "static_safe_fetch",
        sourceReleaseId: input.sourceReleaseId,
        observedAt: input.acquiredAt,
        evidenceRefs: sourceRefs,
      });
    const gates: RecommendationRuleFacts = Object.freeze({
      unsafe_or_malicious: gateFact(
        "unsafe_or_malicious",
        unavailable<boolean>(),
      ),
      high_confidence_pbn_or_link_farm: gateFact(
        "high_confidence_pbn_or_link_farm",
        input.evidence.spamScore === null
          ? unavailable<boolean>()
          : derivedEvidence({
              value: input.evidence.spamScore >= 70,
              sourceType: "dataforseo",
              sourceReleaseId: input.sourceReleaseId,
              observedAt: input.acquiredAt,
              confidence: 0.8,
              evidenceRefs: sourceRefs,
            }),
      ),
      crawl_not_permitted: gateFact(
        "crawl_not_permitted",
        unavailable<boolean>(),
      ),
      ...databaseFacts,
      market_mismatch: gateFact("market_mismatch", unavailable<boolean>()),
    });
    const components = Object.freeze(
      recommendationScoreComponentIds.map((id) =>
        id === "graph_authority_diversity"
          ? scoreComponent({
              id,
              value: providerGraphScore,
              sourceType: "dataforseo",
              sourceReleaseId: input.sourceReleaseId,
              observedAt: input.acquiredAt,
              evidenceRefs: sourceRefs,
              reasonCode: "PROVIDER_AUTHORITY_AND_REFERRING_LINKS",
            })
          : unavailableScoreComponent({
              id,
              sourceReleaseId: input.sourceReleaseId,
              observedAt: input.acquiredAt,
              evidenceRefs: sourceRefs,
            }),
      ),
    );
    return Object.freeze({
      hostnameAscii: domain.hostnameAscii,
      sourceReleaseId: input.sourceReleaseId,
      evidencePolicyVersion,
      gates,
      components,
    });
  }
}

type ExecuteInput = Parameters<
  BacklinkRecommendationRefillActivities["executeRecommendationRefill"]
>[0];
type StoreInput = Parameters<
  BacklinkRecommendationRefillActivities["storeReadyRecommendations"]
>[0];

export type LocalProductDataForSeoRuntime = Readonly<{
  execute(
    input: ExecuteInput,
  ): ReturnType<
    BacklinkRecommendationRefillActivities["executeRecommendationRefill"]
  >;
  store(
    input: StoreInput,
  ): ReturnType<
    BacklinkRecommendationRefillActivities["storeReadyRecommendations"]
  >;
}>;

type RuntimeOptions = Readonly<{
  pool: BacklinkTenantPool;
  secretStoreRoot: string;
  configuration: LocalProductDataForSeoConfiguration;
  now?: () => Date;
  safeFetch?: Pick<SafeFetchPort, "fetch">;
  blueprintGenerator?: AiCommercialDiscoveryBlueprintPort | undefined;
}>;

function scopeFrom(input: ExecuteInput | StoreInput): BacklinkTenantContext {
  return {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
  };
}

export function resolveLocalProductCommercialRefillCycle(
  input: Readonly<{
    refillWindowKey: string;
    triggerReason: string;
    websiteProjectId: string;
    projectContextVersionId: string;
    visiblePoolGeneration: number;
    currentTier: unknown;
    currentRound: unknown;
    terminationReason: unknown;
  }>,
): Readonly<{
  tier: CommercialRefillTier;
  round: number;
  window: number;
}> {
  if (
    !isCommercialRefillTier(input.currentTier) ||
    !Number.isSafeInteger(input.currentRound) ||
    Number(input.currentRound) < 1
  ) {
    throw new Error("COMMERCIAL_REFILL_CYCLE_KEY_INVALID");
  }
  const currentTier = input.currentTier;
  const currentRound = Number(input.currentRound);
  const parsed = parseCommercialRefillWindowKey(input.refillWindowKey);
  const manualResume =
    input.triggerReason === "manual" &&
    input.refillWindowKey.startsWith("manual:");
  let tier = currentTier;
  if (
    input.terminationReason === "PROVIDER_UNAVAILABLE" ||
    input.terminationReason === "BUDGET" ||
    input.terminationReason === "TIERS_EXHAUSTED"
  ) {
    if (currentTier === "curated_resource_library") {
      throw new Error("COMMERCIAL_REFILL_TIERS_EXHAUSTED");
    }
    tier = "curated_resource_library";
  }
  if (parsed === null) {
    if (!manualResume) {
      throw new Error("COMMERCIAL_REFILL_CYCLE_KEY_INVALID");
    }
    return Object.freeze({ tier, round: currentRound, window: 1 });
  }
  if (
    parsed.websiteProjectId !== input.websiteProjectId ||
    parsed.projectContextVersionId !== input.projectContextVersionId ||
    parsed.visiblePoolGeneration !== input.visiblePoolGeneration ||
    parsed.tier !== tier ||
    parsed.round !== currentRound
  ) {
    throw new Error("COMMERCIAL_REFILL_CYCLE_KEY_INVALID");
  }
  return Object.freeze({
    tier: parsed.tier,
    round: parsed.round,
    window: parsed.window,
  });
}

async function setSessionTenant(
  client: BacklinkTenantPoolClient,
  scope: BacklinkTenantContext,
): Promise<void> {
  await client.query(
    `SELECT set_config('app.current_organization_id',$1,false),
            set_config('app.current_workspace_id',$2,false),
            set_config('app.current_website_project_id',$3,false)`,
    [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
  );
}

async function clearSessionTenant(
  client: BacklinkTenantPoolClient,
): Promise<void> {
  await client.query(
    `SELECT set_config('app.current_organization_id','',false),
            set_config('app.current_workspace_id','',false),
            set_config('app.current_website_project_id','',false)`,
  );
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const output: R[] = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) {
          output[index] = await mapper(value, index);
        }
      }
    }),
  );
  return Object.freeze(output);
}

export function createLocalProductDataForSeoRuntime(
  options: RuntimeOptions,
): LocalProductDataForSeoRuntime {
  const configuration = configurationSchema.parse(options.configuration);
  const now = options.now ?? (() => new Date());
  const safeFetch =
    options.safeFetch ??
    new SafeFetchAdapter({
      timeoutMs: Math.min(configuration.timeoutMs, 15_000),
    });
  const secretStore = new LocalProductSecretStoreClient({
    rootDirectory: options.secretStoreRoot,
  });
  const credentialReference = parseLocalProductSecretReference(
    configuration.credentialSecretRef,
    secretKinds.dataForSeoCredential,
  );

  return Object.freeze({
    async execute(input) {
      const scope = scopeFrom(input);
      const refillCycle = await withBacklinkTenantTransaction(
        options.pool,
        scope,
        async (client) => {
          if (input.source === "existing") {
            await client.query(
              `UPDATE backlink_jobs
                  SET status='running',step='reusing_assessed_candidates',
                      progress=25,error=NULL,finished_at=NULL,
                      updated_at=now(),updated_by=$5,version=version+1
                WHERE (organization_id,workspace_id,website_project_id,id)=
                      ($1,$2,$3,$4)
                  AND status IN ('queued','running','waiting_provider')`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.jobId,
                input.actorId,
              ],
            );
            return null;
          }
          const state = await client.query(
            `SELECT refill.trigger_reason AS "triggerReason",
                    refill.visible_pool_generation AS "refillGeneration",
                    policy.visible_pool_generation AS "policyGeneration",
                    policy.visible_pool_state AS "visiblePoolState",
                    policy.current_refill_tier AS "currentTier",
                    policy.current_refill_round AS "currentRound",
                    policy.termination_reason AS "terminationReason"
               FROM backlink_recommendation_refills AS refill
               JOIN backlink_commercial_inventory_policies AS policy
                 ON (
                   policy.organization_id,policy.workspace_id,
                   policy.website_project_id,
                   policy.project_context_version_id
                 )=(
                   refill.organization_id,refill.workspace_id,
                   refill.website_project_id,
                   refill.recommendation_context_version_id
                 )
              WHERE refill.organization_id=$1 AND refill.workspace_id=$2
                AND refill.website_project_id=$3 AND refill.job_id=$4
                AND refill.recommendation_context_version_id=$5
                AND refill.visible_pool_generation=$6
                AND policy.visible_pool_generation=$6
                AND policy.visible_pool_state='building'`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.jobId,
              input.recommendationContextVersionId,
              input.visiblePoolGeneration,
            ],
          );
          const row = state.rows[0];
          if (row === undefined) {
            throw new Error("COMMERCIAL_REFILL_CYCLE_KEY_INVALID");
          }
          const cycle = resolveLocalProductCommercialRefillCycle({
            refillWindowKey: input.refillWindowKey,
            triggerReason: String(row.triggerReason),
            websiteProjectId: scope.websiteProjectId,
            projectContextVersionId: input.recommendationContextVersionId,
            visiblePoolGeneration: input.visiblePoolGeneration,
            currentTier: row.currentTier,
            currentRound: row.currentRound,
            terminationReason: row.terminationReason,
          });
          if (row.triggerReason === "manual") {
            const attempt = JSON.stringify([
              {
                tier: cycle.tier,
                round: cycle.round,
                window: cycle.window,
              },
            ]);
            await client.query(
              `UPDATE backlink_commercial_inventory_policies
                  SET refill_state='running',
                      current_refill_tier=$5,
                      current_refill_round=$6,
                      attempted_refill_tiers=CASE
                        WHEN attempted_refill_tiers @> $7::jsonb
                          THEN attempted_refill_tiers
                        ELSE attempted_refill_tiers || $7::jsonb
                      END,
                      termination_reason=NULL,pause_reason=NULL,
                      next_refill_at=NULL,updated_at=now(),
                      updated_by=$8,version=version+1
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND project_context_version_id=$4
                  AND visible_pool_generation=$9
                  AND visible_pool_state='building'`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                cycle.tier,
                cycle.round,
                attempt,
                input.actorId,
                input.visiblePoolGeneration,
              ],
            );
          }
          await client.query(
            `UPDATE backlink_jobs
                SET status='waiting_provider',
                    step='provider_request_authorizing',
                    progress=10,updated_at=now(),version=version+1
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3 AND id=$4`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.jobId,
            ],
          );
          return cycle;
        },
      );

      const providerClient = await options.pool.connect();
      try {
        await setSessionTenant(providerClient, scope);
        const contextResult = await providerClient.query(
          `SELECT context.snapshot_version AS "snapshotVersion",
                  settings.id AS "projectSettingsVersionId",
                  settings.version AS "projectSettingsVersion",
                  context.project_status AS "projectStatus",
                  context.canonical_domain AS "canonicalDomain",
                  context.locale, context.country_code AS "countryCode",
                  context.products, context.keywords,
                  context.target_urls AS "targetUrls",
                  COALESCE(
                    settings.settings_values->'discoveryTargetAudiences',
                    '[]'::jsonb
                  ) AS "targetAudiences",
                  COALESCE(
                    settings.settings_values->'discoveryPartnershipGoals',
                    '[]'::jsonb
                  ) AS "partnershipGoals",
                  COALESCE(
                    settings.settings_values
                      ->'discoveryExplicitCompetitorDomains',
                    '[]'::jsonb
                  ) AS "explicitCompetitorDomains"
             FROM backlink_project_context_snapshots AS context
             LEFT JOIN LATERAL (
               SELECT id,version,settings_values
                 FROM backlink_project_settings_versions
                WHERE organization_id=context.organization_id
                  AND workspace_id=context.workspace_id
                  AND website_project_id=context.website_project_id
                ORDER BY version DESC
                LIMIT 1
             ) AS settings ON true
            WHERE context.organization_id=$1 AND context.workspace_id=$2
              AND context.website_project_id=$3 AND context.id=$4`,
          [
            scope.organizationId,
            scope.workspaceId,
            scope.websiteProjectId,
            input.recommendationContextVersionId,
          ],
        );
        const contextRow = contextResult.rows[0];
        if (contextRow === undefined) {
          throw new Error("BACKLINK_RECOMMENDATION_CONTEXT_NOT_FOUND");
        }
        const recommendationContext =
          parseLocalProductRecommendationContext(contextRow);
        if (input.source === "existing") {
          const existing = await providerClient.query(
            `SELECT canonical_domain "canonicalDomain",
                    commercial_score "commercialScore"
               FROM backlink_commercial_candidates
              WHERE (
                organization_id,workspace_id,website_project_id,
                project_context_version_id
              )=($1,$2,$3,$4)
                AND score_model_version=
                  'recommendation-commercial-fit.v3'
                AND visible_pool_generation=$7
                AND commercial_score->>'ruleVersion'=$5
                AND commercial_score->>'decision'='eligible'
                AND state='candidate_ready'
              ORDER BY (commercial_score->>'total')::numeric DESC,
                       canonical_domain,id
              LIMIT $6`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.recommendationContextVersionId,
              commercialRecommendationFitRuleVersion,
              input.requestedCount,
              input.visiblePoolGeneration,
            ],
          );
          const sourceReleaseId = input.refillWindowKey;
          const projectTerms = Object.freeze([
            ...recommendationContext.keywords,
            ...recommendationContext.products,
          ]);
          const candidates = await mapConcurrent(
            existing.rows,
            websiteFetchConcurrency,
            async (row) => {
              const score = storedCommercialScoreSchema.parse(
                row.commercialScore,
              );
              return buildLocalProductRecommendationEvidenceCandidate({
                context: scope,
                evidence: {
                  domain: String(row.canonicalDomain),
                  backlinkCount: score.details.dataForSeo.backlinks ?? 0,
                  rank: score.details.dataForSeo.rank,
                  spamScore: score.details.dataForSeo.spamScore,
                  countryCode: score.details.market.candidateCountry,
                },
                sourceReleaseId,
                acquiredAt: score.details.dataForSeo.collectedAt,
                locationCode: recommendationContext.countryCode,
                languageCode: recommendationContext.locale,
                projectTerms,
                existingHostname: false,
                existingBacklink: false,
                previouslyExcluded: false,
                duplicateDomain: false,
                safeFetch,
              });
            },
          );
          return Object.freeze({
            candidates,
            provider: Object.freeze({
              source: "cache",
              acquiredAt: now().toISOString(),
              costMicros: 0,
              requestFingerprint: sourceReleaseId,
            } satisfies RecommendationProviderExecutionSummary),
          });
        }
        if (refillCycle === null) {
          throw new Error("COMMERCIAL_REFILL_CYCLE_KEY_INVALID");
        }
        const createGate = (gateClient: BacklinkTenantPoolClient) =>
          new DataForSeoCallPolicy({
            async checkKillSwitch(gateInput) {
              const result = await gateClient.query(
              `WITH ranked AS (
                 SELECT layer,provider,blocked,
                        row_number() OVER (
                          PARTITION BY layer,provider ORDER BY version DESC
                        ) AS rank
                   FROM backlink_kill_switch_versions
                  WHERE organization_id=$1 AND workspace_id=$2
                    AND website_project_id=$3 AND capability=$4
                    AND (
                      (layer='project' AND provider IS NULL)
                      OR (layer='provider' AND provider=$5)
                    )
               )
               SELECT layer,provider,blocked
                 FROM ranked WHERE rank=1`,
              [
                gateInput.context.organizationId,
                gateInput.context.workspaceId,
                gateInput.context.websiteProjectId,
                gateInput.killSwitchKey,
                gateInput.providerId,
              ],
            );
              const project = result.rows.find(
                (row) => row.layer === "project" && row.provider === null,
              );
              const providerDecision = result.rows.find(
                (row) =>
                  row.layer === "provider" &&
                  row.provider === gateInput.providerId,
              );
              return project?.blocked === false &&
                providerDecision?.blocked === false
                ? "allow"
                : "deny";
            },
            async checkQuota(gateInput) {
              const result = await gateClient.query(
              `WITH current_budget AS (
                 SELECT id
                   FROM backlink_provider_budgets
                  WHERE organization_id=$1 AND workspace_id=$2
                    AND provider=$4
                    AND period_start<=now() AND period_end>now()
                  ORDER BY period_start DESC LIMIT 1
               ), current_batch AS (
                 SELECT id
                   FROM provider_batch_requests
                  WHERE organization_id=$1 AND workspace_id=$2
                    AND website_project_id=$3 AND provider=$4
                    AND request_id=$5 AND status='running'
                  ORDER BY started_at DESC,id DESC
                  LIMIT 1
               )
               SELECT count(*)::integer AS count
                 FROM backlink_provider_usage_ledger AS usage
                 JOIN current_budget AS budget ON budget.id=usage.budget_id
                WHERE usage.organization_id=$1 AND usage.workspace_id=$2
                  AND usage.provider=$4
                  AND usage.status IN ('reserved','settled')
                  AND usage.provider_request_id<>COALESCE(
                    (SELECT id FROM current_batch),
                    '00000000-0000-0000-0000-000000000000'::uuid
                  )`,
              [
                gateInput.context.organizationId,
                gateInput.context.workspaceId,
                gateInput.context.websiteProjectId,
                gateInput.provider,
                gateInput.context.requestId,
              ],
            );
              return isLocalProductDataForSeoPaidCallAllowed(
                Number(result.rows[0]?.count ?? 0),
                configuration.maxPaidCalls,
              )
                ? "allow"
                : "deny";
            },
            async reserveBudget(gateInput) {
              return withBacklinkTenantTransaction(
                options.pool,
                scope,
                async (transaction) =>
                  createProviderBudgetRepository(
                    transaction,
                    now,
                  ).reserveBudgetWithinPaidCallCeiling(
                    gateInput,
                    configuration.maxPaidCalls,
                  ),
              );
            },
          });
        const gate = createGate(providerClient);
        let providerRuntime: Promise<
          ReturnType<typeof createCommercialOfficialDataForSeoRuntime>
        > | null = null;
        const resolveProviderRuntime = () => {
          providerRuntime ??= (async () => {
            const credentials = dataForSeoCredentialSchema.parse(
              JSON.parse(
                await secretStore.resolve({
                  reference: credentialReference,
                  context: {
                    organizationId: "local-product",
                    subjectProvider: "dataforseo",
                  },
                }),
              ) as unknown,
            );
            return createCommercialOfficialDataForSeoRuntime({
              credentials,
              endpointAllowlist: configuration.endpointAllowlist,
              timeoutMs: configuration.timeoutMs,
            });
          })();
          return providerRuntime;
        };
        const provider = Object.freeze({
          async execute(
            call: Parameters<
              ReturnType<
                typeof createCommercialOfficialDataForSeoRuntime
              >["execute"]
            >[0],
            hooks?: Parameters<
              ReturnType<
                typeof createCommercialOfficialDataForSeoRuntime
              >["execute"]
            >[1],
          ) {
            return (await resolveProviderRuntime()).execute(call, hooks);
          },
          async recoverAcceptedTask(
            call: Parameters<
              NonNullable<
                ReturnType<
                  typeof createCommercialOfficialDataForSeoRuntime
                >["recoverAcceptedTask"]
              >
            >[0],
            providerTaskId: string,
          ) {
            const runtime = await resolveProviderRuntime();
            if (runtime.recoverAcceptedTask === undefined) {
              throw new Error(
                "DATAFORSEO_ACCEPTED_TASK_RECOVERY_UNAVAILABLE",
              );
            }
            return runtime.recoverAcceptedTask(call, providerTaskId);
          },
        });
        const commercial = await executeCommercialRecommendationDiscovery({
          client: providerClient,
          provider,
          gate,
          safeFetch,
          scope,
          contextVersionId: input.recommendationContextVersionId,
          context: recommendationContext,
          configuration,
          blueprintGenerator: options.blueprintGenerator,
          requestClientFactory: async () => {
            const client = await options.pool.connect();
            try {
              await setSessionTenant(client, scope);
            } catch (error) {
              client.release();
              throw error;
            }
            return Object.freeze({
              client,
              gate: createGate(client),
              async release() {
                await clearSessionTenant(client).catch(() => undefined);
                client.release();
              },
            });
          },
          requestedCount: input.requestedCount,
          jobId: input.jobId,
          visiblePoolGeneration: input.visiblePoolGeneration,
          refillTier: refillCycle.tier,
          refillRound: refillCycle.round,
          refillWindow: refillCycle.window,
          actorId: input.actorId,
          now,
        });
        const sourceReleaseId = `commercial-dataforseo:${commercial.provider.requestFingerprint}`;
        const projectTerms = Object.freeze([
          ...recommendationContext.keywords,
          ...recommendationContext.products,
        ]);
        const candidates = await mapConcurrent(
          commercial.candidates,
          websiteFetchConcurrency,
          async (candidate) =>
            buildLocalProductRecommendationEvidenceCandidate({
              context: scope,
              evidence: {
                domain: candidate.hostnameAscii,
                backlinkCount: candidate.provider.backlinkCount ?? 0,
                rank: candidate.provider.rank,
                spamScore: candidate.provider.spamScore,
                countryCode: null,
              },
              sourceReleaseId,
              acquiredAt: commercial.provider.acquiredAt,
              locationCode: recommendationContext.countryCode,
              languageCode: recommendationContext.locale,
              projectTerms,
              existingHostname: false,
              existingBacklink: false,
              previouslyExcluded: false,
              duplicateDomain: false,
              safeFetch,
            }),
        );
        return Object.freeze({
          candidates,
          provider: Object.freeze(
            commercial.provider satisfies RecommendationProviderExecutionSummary,
          ),
        });
      } finally {
        await clearSessionTenant(providerClient).catch(() => undefined);
        providerClient.release();
      }
    },

    async store(input) {
      const scope = scopeFrom(input);
      return withBacklinkTenantTransaction(
        options.pool,
        scope,
        async (client) => {
          const activePool = await client.query(
            `SELECT 1
               FROM backlink_commercial_inventory_policies
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3
                AND project_context_version_id=$4
                AND visible_pool_generation=$5
                AND visible_pool_state='building'
              FOR SHARE`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.recommendationContextVersionId,
              input.visiblePoolGeneration,
            ],
          );
          if (activePool.rows[0] === undefined) {
            throw new Error("COMMERCIAL_VISIBLE_POOL_GENERATION_STALE");
          }
          const current = await client.query(
            `SELECT id
               FROM backlink_project_context_snapshots
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3
              ORDER BY snapshot_version DESC LIMIT 1`,
            [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
          );
          if (current.rows[0]?.id !== input.recommendationContextVersionId) {
            await client.query(
              `UPDATE backlink_recommendations
                  SET status='stale_context',updated_at=now(),
                      updated_by=$5,version=version+1
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND recommendation_context_version_id=$4
                  AND status IN (
                    'candidate_raw','evaluating','ready','shown'
                  )`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                input.actorId,
              ],
            );
            await client.query(
              `UPDATE backlink_recommendation_inventory
                  SET status='stale_context',updated_at=now(),
                      updated_by=$5,version=version+1
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND recommendation_context_version_id=$4
                  AND status IN ('ready','claimed','shown')`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                input.actorId,
              ],
            );
            await client.query(
              `UPDATE backlink_commercial_discovery_blueprints
                  SET status='stale_context'
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND project_context_version_id=$4
                  AND status='active'`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
              ],
            );
            await client.query(
              `UPDATE backlink_commercial_discovery_batches
                  SET status='stale_context',
                      pause_reason='stale_context',
                      finished_at=COALESCE(finished_at,now())
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND project_context_version_id=$4
                  AND status IN (
                    'running','completed','paused','unavailable'
                  )`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
              ],
            );
            await client.query(
              `UPDATE backlink_commercial_candidates
                  SET state='stale_context',updated_at=now(),
                      updated_by=$5,version=version+1
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND project_context_version_id=$4
                  AND state NOT IN ('published','stale_context')`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                input.actorId,
              ],
            );
            await client.query(
              `UPDATE backlink_jobs
                  SET status='success',step='stale_context',
                      progress=100,
                      result_summary=
                        COALESCE(result_summary,'{}'::jsonb)
                        || $5::jsonb,
                      finished_at=now(),updated_at=now(),version=version+1
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3 AND id=$4`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.jobId,
                JSON.stringify({
                  addedCount: 0,
                  staleContext: true,
                  provider: input.provider,
                  evaluation: input.evaluationSummary,
                }),
              ],
            );
            return { addedCount: 0 };
          }

          let addedCount = 0;
          for (const recommendation of input.recommendations) {
            const domain = createRecommendationDomainKey(
              recommendation.hostnameAscii,
            );
            const commercialCandidate = await client.query(
              `SELECT id,source_types AS "sourceTypes",
                      static_assessment AS "staticAssessment",
                      gate_decision AS "gateDecision",
                      commercial_score AS "commercialScore",
                      provider_collected_at AS "providerCollectedAt"
                 FROM backlink_commercial_candidates
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND project_context_version_id=$4
                  AND visible_pool_generation=$6
                  AND canonical_domain=$5
                  AND score_model_version=
                    'recommendation-commercial-fit.v3'
                  AND state='candidate_ready'
                ORDER BY updated_at DESC,id DESC
                LIMIT 1`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                domain.registrableDomain,
                input.visiblePoolGeneration,
              ],
            );
            const commercialRow = commercialCandidate.rows[0];
            const parsedCommercialScore = storedCommercialScoreSchema.safeParse(
              commercialRow?.commercialScore,
            );
            if (!parsedCommercialScore.success) continue;
            const prospectId = randomUUID();
            const recommendationId = randomUUID();
            const scoreId = randomUUID();
            const inventoryId = randomUUID();
            const prospect = await client.query(
              `WITH inserted AS (
                 INSERT INTO backlink_prospects (
                   id,organization_id,workspace_id,website_project_id,
                   recommendation_context_version_id,hostname_ascii,
                   registrable_domain,normalization_version,
                   created_by,updated_by
                 ) VALUES (
                   $1,$2,$3,$4,$5,$6,$7,$8,$9,$9
                 )
                 ON CONFLICT (
                   organization_id,workspace_id,website_project_id,
                   recommendation_context_version_id,hostname_ascii
                 ) DO NOTHING
                 RETURNING id
               )
               SELECT id FROM inserted
               UNION ALL
               SELECT id FROM backlink_prospects
                WHERE organization_id=$2 AND workspace_id=$3
                  AND website_project_id=$4
                  AND recommendation_context_version_id=$5
                  AND hostname_ascii=$6
               LIMIT 1`,
              [
                prospectId,
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                domain.hostnameAscii,
                domain.registrableDomain,
                domain.normalizationVersion,
                input.actorId,
              ],
            );
            const storedProspectId = prospect.rows[0]?.id;
            if (storedProspectId === undefined) continue;
            const recommendationRow = await client.query(
              `WITH inserted AS (
                 INSERT INTO backlink_recommendations (
                   id,organization_id,workspace_id,website_project_id,
                   prospect_id,recommendation_context_version_id,status,
                   created_by,updated_by
                 ) VALUES ($1,$2,$3,$4,$5,$6,'ready',$7,$7)
                 ON CONFLICT (
                   organization_id,workspace_id,website_project_id,
                   prospect_id,recommendation_context_version_id
                 ) DO NOTHING
                 RETURNING id,status
               )
               SELECT id,status FROM inserted
               UNION ALL
               SELECT id,status FROM backlink_recommendations
                WHERE organization_id=$2 AND workspace_id=$3
                  AND website_project_id=$4 AND prospect_id=$5
                  AND recommendation_context_version_id=$6
               LIMIT 1`,
              [
                recommendationId,
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                storedProspectId,
                input.recommendationContextVersionId,
                input.actorId,
              ],
            );
            const storedRecommendation = recommendationRow.rows[0];
            if (
              storedRecommendation === undefined ||
              !["ready", "shown"].includes(String(storedRecommendation.status))
            ) {
              continue;
            }
            const storedRecommendationId = String(storedRecommendation.id);
            const commercialScore = parsedCommercialScore.data;
            const score = commercialScore;
            const weights = Object.fromEntries(
              commercialScore.components.map((component) => [
                component.id,
                component.weight,
              ]),
            );
            const scoreEvidence = {
              sourceReleaseId: recommendation.sourceReleaseId,
              evidencePolicyVersion: recommendation.evidencePolicyVersion,
              provider: {
                providerId: "dataforseo",
                source: input.provider.source,
                acquiredAt: input.provider.acquiredAt,
                costMicros: input.provider.costMicros,
                requestFingerprint: input.provider.requestFingerprint,
              },
              gateDecision: recommendation.gateDecision,
              missingEvidenceKeys: recommendation.missingEvidenceKeys,
              commercial: {
                sourceTypes: commercialRow?.sourceTypes,
                staticAssessment: commercialRow?.staticAssessment,
                gateDecision: commercialRow?.gateDecision,
                hitGates: commercialScore.hitGates,
                missingEvidence: commercialScore.missingEvidence,
              },
            };
            await client.query(
              `INSERT INTO backlink_recommendation_scores (
                 id,organization_id,workspace_id,website_project_id,
                 recommendation_id,prospect_id,
                 recommendation_context_version_id,score_model_version,
                 rule_version,total_score,components,weights,evidence,
                 generated_at,created_by
               )
               SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,
                      $12::jsonb,$13::jsonb,$14,$15
                WHERE NOT EXISTS (
                  SELECT 1 FROM backlink_recommendation_scores
                   WHERE organization_id=$2 AND workspace_id=$3
                     AND website_project_id=$4
                     AND recommendation_id=$5
                     AND score_model_version=$8
                     AND evidence->>'sourceReleaseId'=$16
                )`,
              [
                scoreId,
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                storedRecommendationId,
                storedProspectId,
                input.recommendationContextVersionId,
                score.scoreModelVersion,
                score.ruleVersion,
                score.total,
                JSON.stringify(score.components),
                JSON.stringify(weights),
                JSON.stringify(scoreEvidence),
                commercialRow?.providerCollectedAt ?? input.provider.acquiredAt,
                input.actorId,
                recommendation.sourceReleaseId,
              ],
            );
            const inventory = await client.query(
              `INSERT INTO backlink_recommendation_inventory (
                 id,organization_id,workspace_id,website_project_id,
                 recommendation_id,prospect_id,
                 recommendation_context_version_id,visible_pool_generation,
                 status,fit_decision,
                 contact_decision,contact_reason_code,
                 fit_score_model_version,publication_status,
                 created_by,updated_by
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,$8,'ready','eligible','pending',
                 'CONTACT_PENDING','recommendation-commercial-fit.v3',
                 'CONTACT_PENDING',$9,$9
               )
               ON CONFLICT (
                 organization_id,workspace_id,website_project_id,
                 recommendation_id,recommendation_context_version_id,
                 visible_pool_generation
               ) DO UPDATE SET
                 fit_decision='eligible',
                 fit_score_model_version=
                   'recommendation-commercial-fit.v3',
                 contact_decision=CASE
                   WHEN backlink_recommendation_inventory
                          .contact_evidence_snapshot_id IS NOT NULL
                     AND backlink_recommendation_inventory
                          .verified_public_email_count>=1
                     THEN 'eligible'
                   ELSE 'pending'
                 END,
                 contact_reason_code=CASE
                   WHEN backlink_recommendation_inventory
                          .contact_evidence_snapshot_id IS NOT NULL
                     AND backlink_recommendation_inventory
                          .verified_public_email_count>=1
                     THEN 'PUBLIC_EMAIL_FOUND'
                   ELSE 'CONTACT_PENDING'
                 END,
                 publication_status=CASE
                   WHEN backlink_recommendation_inventory
                          .contact_evidence_snapshot_id IS NOT NULL
                     AND backlink_recommendation_inventory
                          .verified_public_email_count>=1
                     THEN 'PUBLISHED'
                   ELSE 'CONTACT_PENDING'
                 END,
                 updated_at=now(),updated_by=EXCLUDED.updated_by,
                 version=backlink_recommendation_inventory.version+1
               RETURNING id`,
              [
                inventoryId,
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                storedRecommendationId,
                storedProspectId,
                input.recommendationContextVersionId,
                input.visiblePoolGeneration,
                input.actorId,
              ],
            );
            if (inventory.rows[0] !== undefined) addedCount += 1;
            if (commercialRow?.id !== undefined) {
              await client.query(
                `UPDATE backlink_commercial_candidates
                    SET recommendation_id=$5,prospect_id=$6,
                        state='contact_enrichment',updated_at=now(),
                        updated_by=$7,version=version+1
                  WHERE organization_id=$1 AND workspace_id=$2
                    AND website_project_id=$3 AND id=$4
                    AND visible_pool_generation=$8
                    AND score_model_version=
                      'recommendation-commercial-fit.v3'
                    AND state='candidate_ready'`,
                [
                  scope.organizationId,
                  scope.workspaceId,
                  scope.websiteProjectId,
                  commercialRow.id,
                  storedRecommendationId,
                  storedProspectId,
                  input.actorId,
                  input.visiblePoolGeneration,
                ],
              );
            }
          }
          await client.query(
            input.finalizeJob === false
              ? `UPDATE backlink_jobs
                     SET status='running',step=$5,progress=60,
                         result_summary=
                           COALESCE(result_summary,'{}'::jsonb)
                           || $6::jsonb,
                         error=NULL,
                         finished_at=NULL,updated_at=now(),version=version+1
                   WHERE organization_id=$1 AND workspace_id=$2
                     AND website_project_id=$3 AND id=$4`
              : `UPDATE backlink_jobs
                    SET status='success',step=$5,progress=100,
                        result_summary=$6::jsonb,error=NULL,
                        finished_at=now(),updated_at=now(),version=version+1
                  WHERE organization_id=$1 AND workspace_id=$2
                    AND website_project_id=$3 AND id=$4`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.jobId,
              input.finalizeJob === false
                ? "supply_window_stored"
                : addedCount > 0
                  ? "ready_inventory_stored"
                  : "no_evaluable_recommendations",
              JSON.stringify({
                addedCount,
                provider: input.provider,
                evaluation: input.evaluationSummary,
                refillWindowKey: input.refillWindowKey,
                final: input.finalizeJob !== false,
              }),
            ],
          );
          return { addedCount };
        },
      );
    },
  });
}
