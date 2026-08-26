import { createHash, randomUUID } from "node:crypto";

import { load } from "cheerio";
import { z } from "zod";

import { createCommercialOfficialDataForSeoRuntime } from "../adapters/dataforseo/commercial-official-runtime.js";
import { createCommercialQualificationOfficialRuntime } from "../adapters/dataforseo/commercial-qualification-official-runtime.js";
import { resolveDataForSeoProjectLocale } from "../adapters/dataforseo/project-locale.js";
import { commercialPageParser } from "../adapters/html/commercial-page-parser.adapter.js";
import { SafeFetchAdapter } from "../adapters/http/safe-fetch.adapter.js";
import {
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import {
  DataForSeoCallPolicy,
  type DataForSeoAvailabilityDecision,
} from "../application/policies/dataforseo-call.policy.js";
import { createGovernedCommercialQualificationRuntime } from "../application/services/commercial-qualification-request.service.js";
import {
  ensureReadyContactEnrichmentJobs,
  type ContactEnrichmentJobOptions,
} from "../application/commands/contact-enrichment.command.js";
import {
  executeCommercialQualificationProduction,
  type CommercialQualificationMetricCollectionMode,
  type CommercialQualificationProductionCandidate,
} from "../application/services/commercial-qualification-production.service.js";
import {
  executeCommercialRecommendationDiscovery,
  type CommercialReadyCandidate,
} from "../application/services/commercial-recommendation-discovery.service.js";
import {
  prepareCurrentCommercialCandidateEnrichment,
  type CurrentCommercialCandidateEnrichment,
} from "../application/services/current-commercial-candidate-enrichment.service.js";
import { recoverCurrentCommercialStaticAssessments } from "../application/services/current-commercial-static-assessment-recovery.service.js";
import type {
  BacklinkRecommendationRefillActivities,
  RecommendationProviderExecutionSummary,
} from "../workflows/definitions/backlink-recommendation-refill.orchestration.js";
import type { EvidenceValue } from "../domain/evidence/evidence.js";
import {
  finalizeCommercialCandidateEnrichment,
  type CommercialCandidateEnrichmentState,
} from "../domain/recommendations/commercial-candidate-enrichment.js";
import { createRecommendationDomainKey } from "../domain/recommendations/domain-key.js";
import {
  commercialFitBaselineAdmissionThreshold,
  commercialFitComponentIds,
  commercialFitHardGateIds,
  commercialFitProgressiveAdmissionPolicyVersion,
  commercialRecommendationFitModelVersion,
  commercialRecommendationFitRuleVersion,
} from "../domain/recommendations/commercial-score-v4.js";
import {
  applyProviderBudgetAutomaticOverage,
  parseProviderOperationBudgetAuthorization,
  resolveProviderOperationBudgetWindow,
  type ProviderOperationBudgetAuthorization,
} from "../domain/recommendations/provider-operation-budget.js";
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
import { createCommercialQualificationRequestRepository } from "../db/repositories/commercial-qualification-request.repository.js";
import { createProjectInputPersistenceRepository } from "../db/repositories/project-input-persistence.repository.js";
import { createProviderBudgetRepository } from "../db/repositories/provider-budget.repository.js";
import {
  createRecommendationContractRepository,
  writeCorrectedRecommendationFactsInTransaction,
} from "../db/repositories/recommendation-contract.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantContext,
  type BacklinkTenantPool,
  type BacklinkTenantPoolClient,
} from "../db/tenant-transaction.js";
import type { ReferringDomainEvidence } from "../ports/dataforseo.port.js";
import type { AiCommercialDiscoveryBlueprintPort } from "../ports/ai-commercial-discovery-blueprint.port.js";
import {
  CORRECTED_QUALIFICATION_CONTRACT_VERSION,
  CORRECTED_SCORE_MODEL_VERSION,
  CORRECTED_VISIBILITY_CONTRACT_VERSION,
} from "../ports/recommendation-contract.port.js";
import type { SafeFetchPort } from "../ports/safe-fetch.port.js";
import { secretKinds } from "../ports/secret-store.port.js";
import type {
  GenerationInputBinding,
  PinnedSharedSeoEvidence,
  SharedSeoEvidenceSourceModule,
} from "../ports/shared-seo-evidence.port.js";
import {
  localProductDataForSeoCredentialReferenceSchema,
  localProductDataForSeoEndpointAllowlistSchema,
  localProductDataForSeoMaximumTimeoutMs,
} from "./local-product-dataforseo-bootstrap.js";
import {
  createDataForSeoProviderHealth,
  providerReasonCodeSchema,
  providerRecoveryActionSchema,
} from "./runtime-health.js";

const evidencePolicyVersion = "recommendation-evidence-policy.v1";
const evidenceDerivationRuleVersion = "local-product-dataforseo-evidence.v1";
const scoreNormalizationRuleVersion =
  "local-product-dataforseo-score-normalization.v1";
const maxWebsiteEvidenceBytes = 512_000;
const maxWebsiteRedirects = 4;
const websiteFetchConcurrency = 8;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const object = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deterministicFactId(namespace: string, value: unknown): string {
  const bytes = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

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
const commercialFitEvidenceStateSchema = z.enum([
  "observed",
  "derived",
  "unavailable",
  "insufficient_data",
  "manual_review",
]);
const storedCommercialBacklinkPageEvidenceSchema = z
  .object({
    sourceUrl: z.url(),
    targetUrl: z.url(),
    anchorText: z.string().nullable(),
    linkStatus: z.enum(["active", "lost"]),
    firstSeenAt: z.string().trim().min(1).nullable(),
    lastSeenAt: z.string().trim().min(1).nullable(),
    sourceHttpStatus: z.number().int().nullable(),
    targetHttpStatus: z.number().int().nullable(),
  })
  .strict();
const storedCommercialScoreSchema = z
  .object({
    decision: z.literal("eligible"),
    scoreModelVersion: z.literal(commercialRecommendationFitModelVersion),
    ruleVersion: z.literal(commercialRecommendationFitRuleVersion),
    total: z.number().min(0).max(100),
    components: z.array(
      z
        .object({
          id: z.enum(commercialFitComponentIds),
          state: commercialFitEvidenceStateSchema,
          rawValue: z.union([
            z.number(),
            z.string(),
            z.boolean(),
            z.null(),
          ]),
          normalizedValue: z.number().min(0).max(1).nullable(),
          weight: z.number().min(0).max(100),
          points: z.number().min(0).max(100).nullable(),
          evidenceRefs: z.array(z.string()),
          normalizationRuleVersion: z.string().trim().min(1),
          collectedAt: z.string().trim().min(1),
        })
        .strict(),
    ),
    hitGates: z.array(z.enum(commercialFitHardGateIds)),
    missingEvidence: z.array(z.string()),
    admission: z
      .object({
        policyVersion: z.literal(
          commercialFitProgressiveAdmissionPolicyVersion,
        ),
        baselineThreshold: z.literal(
          commercialFitBaselineAdmissionThreshold,
        ),
        appliedThreshold: z.literal(
          commercialFitBaselineAdmissionThreshold,
        ),
        fallbackApplied: z.literal(false),
      })
      .strict(),
    details: z
      .object({
        matchTier: z.enum(["high_fit", "qualified_fit", "not_eligible"]),
        reasonCodes: z.array(z.string()),
        matchedProducts: z.array(z.string()),
        matchedTopics: z.array(z.string()),
        matchedKeywords: z.array(z.string()),
        matchedTargetPages: z.array(z.string()),
        matchedAudiences: z.array(z.string()),
        market: z
          .object({
            targetCountry: z.string(),
            candidateCountry: z.string().nullable(),
            targetLanguage: z.string(),
            candidateLanguage: z.string().nullable(),
            tier: z.enum([
              "target_market",
              "same_language_expansion",
              "market_language_mismatch",
            ]),
            reasonCode: z.string(),
          })
          .strict(),
        cooperationAngles: z.array(z.string()),
        authority: z
          .object({
            projectAuthority: z.number().min(0).max(100),
            candidateAuthority: z.number().min(0).max(100).nullable(),
            confidence: z.enum(["observed", "neutral_default"]),
            tier: z.enum([
              "candidate_below_range",
              "normal_relative_range",
              "elevated_authority_gap",
              "extreme_authority_gap",
            ]),
          })
          .strict(),
        dataForSeo: z
          .object({
            rank: z.number().nullable(),
            traffic: z.number().nullable(),
            backlinks: z.number().nullable(),
            referringDomains: z.number().nullable(),
            spamScore: z.number().nullable(),
            backlinkPageEvidence: z
              .array(storedCommercialBacklinkPageEvidenceSchema)
              .default([]),
            evidenceRefs: z.array(z.string()).default([]),
            collectedAt: z.string().trim().min(1),
          })
          .strict(),
        safeFetch: z
          .object({
            relatedContentPages: z.array(z.string()),
            evidenceUrls: z.array(z.string()),
            evidenceRefs: z.array(z.string()),
            failedUrls: z.array(z.string()),
            technicalAccessibility: z.number().min(0).max(1).nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.components.length !== commercialFitComponentIds.length ||
      new Set(value.components.map(({ id }) => id)).size !==
        commercialFitComponentIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["components"],
        message: "Stored V4 score must contain every unique component.",
      });
    }
    if (
      value.admission.appliedThreshold % 5 !== 0 ||
      value.admission.fallbackApplied !==
        (value.admission.appliedThreshold <
          commercialFitBaselineAdmissionThreshold)
    ) {
      context.addIssue({
        code: "custom",
        path: ["admission"],
        message: "Stored V4 admission metadata is inconsistent.",
      });
    }
  });
const storedCommercialQualificationFactSchema = z
  .object({
    qualificationFactId: z.string().uuid(),
    generationContractId: z.string().uuid(),
    metricScope: z.enum(["TARGET_MARKET", "GLOBAL"]),
    trafficOrganicEtv: z.coerce.number().nonnegative().nullable(),
    spamScore: z.coerce.number().min(0).max(100).nullable(),
    authorityRank: z.coerce.number().min(0).max(100).nullable(),
    accessibilityDecision: z.enum([
      "accessible",
      "inaccessible",
      "insufficient_data",
    ]),
    semanticScore: z.coerce.number().min(0).max(100).nullable(),
    decision: z.literal("eligible"),
    decisionReasonCode: z.string().trim().min(1),
    modelVersion: z.string().trim().min(1).nullable(),
    promptVersion: z.string().trim().min(1).nullable(),
    ruleVersion: z.string().trim().min(1),
    requestFingerprints: z.record(z.string(), z.unknown()),
    evidence: z.record(z.string(), z.unknown()),
    observedAt: z.coerce.date(),
  })
  .strict();
const storedCommercialBlueprintTopicsSchema = z
  .object({
    topicClusters: z.array(z.string().trim().min(1)).max(100),
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
    externalAvailability: z.enum([
      "not_checked",
      "available",
      "unavailable",
    ]),
    externalReasonCode: providerReasonCodeSchema.nullable(),
    externalRecoveryAction: providerRecoveryActionSchema.nullable(),
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
    if (
      value.externalAvailability === "unavailable"
      && (
        value.externalReasonCode === null
        || value.externalReasonCode === "provider_disabled"
        || value.externalReasonCode === "provider_not_checked"
        || value.externalRecoveryAction === null
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["externalReasonCode"],
        message: "Unavailable DataForSEO requires a recovery contract.",
      });
    }
  });
const projectRecommendationContextSchema = z
  .object({
    snapshotVersion: z.coerce.number().int().positive(),
    profileVersionId: z.string().uuid(),
    promotionTargetVersionId: z.string().uuid(),
    projectSettingsVersionId: z.string().uuid(),
    projectSettingsVersion: z.coerce.number().int().positive(),
    projectStatus: z.literal("ACTIVE"),
    canonicalDomain: z.string().trim().min(1).max(253),
    locale: z.string().trim().min(1).max(32),
    countryCode: z.string().trim().min(1).max(64),
    products: jsonStringArraySchema,
    keywords: z.array(z.string().trim().min(1).max(2_048)).max(100),
    targetUrls: z.array(z.string().trim().url().max(2_048)).max(100),
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
    if (value.keywords.length === 0 && value.targetUrls.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["keywords"],
        message:
          "Project discovery requires a promotion topic or published target.",
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

const optionalSourceModules = Object.freeze({
  KEYWORDS: "keywords",
  CONTENT: "content",
  COMPETITOR_SERP: "competitor-serp",
  GSC: "gsc",
} satisfies Readonly<Record<string, SharedSeoEvidenceSourceModule>>);

function discoveryInputRequired(
  owner: string,
  recovery: string,
  reason: string,
): never {
  throw new Error(
    `WEBSITE_PROJECT_DISCOVERY_INPUT_REQUIRED owner=${owner} recovery=${recovery} reason=${reason}`,
  );
}

function isFreshPinnedEvidence(
  evidence: PinnedSharedSeoEvidence,
  now: Date,
): boolean {
  const expiresAt = Date.parse(evidence.snapshot.expiresAt);
  return evidence.snapshot.status === "ready"
    && Number.isFinite(expiresAt)
    && expiresAt > now.getTime();
}

function isReadyPinnedEvidence(
  evidence: PinnedSharedSeoEvidence,
): boolean {
  return evidence.snapshot.status !== "failed";
}

function normalizedStringArray(
  value: unknown,
): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze([
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]);
}

export function resolveLocalProductProjectDiscoveryInput(
  input: Readonly<{
    organizationId: string;
    websiteProjectId: string;
    context: LocalProductRecommendationContext;
    binding: GenerationInputBinding | null;
    now: Date;
  }>,
): Readonly<{
  context: LocalProductRecommendationContext;
  binding: GenerationInputBinding;
}> {
  const binding = input.binding;
  if (binding === null) {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "reproject_current_website_project",
      "missing_generation_input_binding",
    );
  }
  const { pins, outreachProfile: profile } = binding;
  if (
    pins.organizationId !== input.organizationId
    || pins.websiteProjectId !== input.websiteProjectId
    || pins.projectContextVersion !== input.context.snapshotVersion
    || pins.siteProfileVersionId !== input.context.profileVersionId
    || pins.outreachProfileVersionId !== profile.profileVersionId
    || pins.promotionTargetVersionId
      !== input.context.promotionTargetVersionId
    || pins.qualificationContractVersion
      !== CORRECTED_QUALIFICATION_CONTRACT_VERSION
    || pins.market !== input.context.countryCode
    || profile.organizationId !== input.organizationId
    || profile.websiteProjectId !== input.websiteProjectId
    || profile.profileVersionId !== input.context.profileVersionId
    || profile.promotionTargetVersionId
      !== input.context.promotionTargetVersionId
    || profile.market !== input.context.countryCode
    || profile.location !== input.context.countryCode
    || profile.language !== input.context.locale
  ) {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "reproject_current_website_project",
      "project_or_version_binding_mismatch",
    );
  }
  if (profile.productsAndServices.length === 0) {
    return discoveryInputRequired(
      "SITE_PROFILE",
      "complete_and_publish_site_profile",
      "missing_site_theme",
    );
  }
  if (
    profile.keywordsAndTopics.length === 0
    && profile.targetUrls.length === 0
  ) {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "add_promotion_topic_or_publish_target",
      "missing_promotion_topic_or_published_target",
    );
  }
  const readyEvidence = binding.sharedEvidence.filter(
    isReadyPinnedEvidence,
  );
  const freshEvidence = readyEvidence.filter((evidence) =>
    isFreshPinnedEvidence(evidence, input.now)
  );
  const siteProfileEvidence = readyEvidence.find(
    ({ snapshot }) => snapshot.sourceModule === "site-profile",
  );
  if (siteProfileEvidence === undefined) {
    return discoveryInputRequired(
      "SITE_PROFILE",
      "complete_and_publish_site_profile",
      "missing_site_profile_evidence",
    );
  }
  if (
    profile.keywordsAndTopics.length === 0
    && !readyEvidence.some(
      ({ snapshot }) => snapshot.sourceModule === "content",
    )
  ) {
    return discoveryInputRequired(
      "CONTENT",
      "publish_target_content",
      "published_target_evidence_missing",
    );
  }
  const canonicalDomain = siteProfileEvidence.snapshot
    .normalizedParameters.canonicalDomain;
  let evidenceDomainKey: string;
  let contextDomainKey: string;
  try {
    evidenceDomainKey = typeof canonicalDomain === "string"
      ? createRecommendationDomainKey(canonicalDomain).registrableDomain
      : "";
    contextDomainKey = createRecommendationDomainKey(
      input.context.canonicalDomain,
    ).registrableDomain;
  } catch {
    return discoveryInputRequired(
      "SITE_PROFILE",
      "refresh_and_publish_site_profile",
      "canonical_domain_evidence_invalid",
    );
  }
  if (evidenceDomainKey === "" || evidenceDomainKey !== contextDomainKey) {
    return discoveryInputRequired(
      "SITE_PROFILE",
      "refresh_and_publish_site_profile",
      "canonical_domain_evidence_mismatch",
    );
  }
  const authorizedSources = new Set(
    profile.authorizedDiscoverySources,
  );
  if (
    !authorizedSources.has("WEBSITE_PROJECT")
    || !authorizedSources.has("CURATED_RESOURCE_LIBRARY")
  ) {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "reproject_current_website_project",
      "required_discovery_source_not_authorized",
    );
  }
  const freshModules = new Set(
    freshEvidence.map(({ snapshot }) => snapshot.sourceModule),
  );
  const effectiveAuthorizedSources = new Set([
    "WEBSITE_PROJECT",
    "CURATED_RESOURCE_LIBRARY",
  ]);
  for (const [source, module] of Object.entries(optionalSourceModules)) {
    if (authorizedSources.has(source) && freshModules.has(module)) {
      effectiveAuthorizedSources.add(source);
    }
  }
  const competitorEvidence = freshEvidence.find(
    ({ snapshot }) => snapshot.sourceModule === "competitor-serp",
  );
  const explicitCompetitorDomains = competitorEvidence === undefined
    ? Object.freeze([] as string[])
    : normalizedStringArray(
        competitorEvidence.snapshot.normalizedParameters.domains,
      );
  return Object.freeze({
    binding: Object.freeze({
      ...binding,
      outreachProfile: Object.freeze({
        ...profile,
        authorizedDiscoverySources: Object.freeze([
          ...effectiveAuthorizedSources,
        ]),
      }),
      sharedEvidence: Object.freeze(readyEvidence),
    }),
    context: Object.freeze({
      ...input.context,
      canonicalDomain: evidenceDomainKey,
      products: Object.freeze([...profile.productsAndServices]),
      keywords: Object.freeze([...profile.keywordsAndTopics]),
      targetUrls: Object.freeze([...profile.targetUrls]),
      targetAudiences: Object.freeze([...profile.targetAudiences]),
      partnershipGoals: Object.freeze([...profile.partnershipGoals]),
      explicitCompetitorDomains: Object.freeze([
        ...explicitCompetitorDomains,
      ]),
    }),
  });
}

function discoveredQualificationCandidate(
  candidateId: string,
  candidate: CommercialReadyCandidate,
): CommercialQualificationProductionCandidate {
  return Object.freeze({
    candidateId: z.string().uuid().parse(candidateId),
    hostnameAscii: candidate.hostnameAscii,
    sourceTypes: candidate.sourceTypes,
    provider: Object.freeze({
      rank: candidate.provider.rank,
      traffic: candidate.provider.traffic,
      spamScore: candidate.provider.spamScore,
      evidenceRefs: candidate.provider.evidenceRefs,
    }),
    staticAssessment: candidate.staticAssessment,
    commercialScore: candidate.commercialScore,
  });
}

export function isLocalProductDataForSeoPaidCallAllowed(
  paidCallCount: number,
  maxPaidCalls: number,
  requiredRemainingPaidCalls = 0,
): boolean {
  return paidCallCount + 1 + requiredRemainingPaidCalls <= maxPaidCalls;
}

export function resolveLocalProductDataForSeoOperationBudget(
  input: Readonly<{
    configuration: Pick<
      LocalProductDataForSeoConfiguration,
      "absoluteBudgetMicros" | "maxPaidCalls"
    >;
    authorization: ProviderOperationBudgetAuthorization | null;
  }>,
): Readonly<{
  maxPaidCalls: number;
  operationBudgetLimitMicros: number;
  dailyBudgetLimitMicros: number;
  authorization: ProviderOperationBudgetAuthorization | null;
}> {
  const approvedPaidCalls = input.authorization === null
    ? applyProviderBudgetAutomaticOverage(input.configuration.maxPaidCalls)
    : input.authorization.maxPaidCalls;
  const approvedCostMicros = input.authorization === null
    ? applyProviderBudgetAutomaticOverage(
      input.configuration.absoluteBudgetMicros,
    )
    : input.authorization.maxCostMicros;
  return Object.freeze({
    maxPaidCalls: approvedPaidCalls,
    operationBudgetLimitMicros: approvedCostMicros,
    dailyBudgetLimitMicros: applyProviderBudgetAutomaticOverage(
      Math.max(
        input.authorization?.maxCostMicros ?? 0,
        input.configuration.absoluteBudgetMicros,
      ),
    ),
    authorization: input.authorization,
  });
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
  const providerHealth = createDataForSeoProviderHealth({
    ...environment,
    DATAFORSEO_ENABLED: "true",
  });
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
    externalAvailability: providerHealth.externalAvailability,
    externalReasonCode: providerHealth.reasonCode,
    externalRecoveryAction: providerHealth.recoveryAction,
  });
}

export function localProductDataForSeoAvailabilityDecision(
  configuration: LocalProductDataForSeoConfiguration,
): DataForSeoAvailabilityDecision {
  const parsed = configurationSchema.parse(configuration);
  if (parsed.externalAvailability !== "unavailable") {
    return Object.freeze({ decision: "allow" });
  }
  return Object.freeze({
    decision: "deny",
    reasonCode: parsed.externalReasonCode as string,
    recoveryAction: parsed.externalRecoveryAction as string,
  });
}

export async function assertLocalProductDataForSeoCredentialReady(
  options: Readonly<{
    secretStoreRoot: string;
    configuration: LocalProductDataForSeoConfiguration;
  }>,
): Promise<void> {
  const configuration = configurationSchema.parse(options.configuration);
  const credentialReference = parseLocalProductSecretReference(
    configuration.credentialSecretRef,
    secretKinds.dataForSeoCredential,
  );
  try {
    const plaintext = await new LocalProductSecretStoreClient({
      rootDirectory: options.secretStoreRoot,
    }).resolve({
      reference: credentialReference,
      context: {
        organizationId: "local-product",
        subjectProvider: "dataforseo",
      },
    });
    dataForSeoCredentialSchema.parse(JSON.parse(plaintext) as unknown);
  } catch (error) {
    throw new Error(
      "BACKLINKS_DATAFORSEO_CREDENTIAL_UNAVAILABLE"
      + ` root=${options.secretStoreRoot}`
      + ` reference=${configuration.credentialSecretRef}`,
      { cause: error },
    );
  }
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

export function buildStoredCommercialRecommendationEvidenceCandidate(
  input: Readonly<{
    candidate: CurrentCommercialCandidateEnrichment;
    sourceReleaseId: string;
  }>,
): RecommendationEvidenceCandidate {
  const domain = createRecommendationDomainKey(input.candidate.hostnameAscii);
  const sourceReleaseId = input.sourceReleaseId.trim();
  const score = input.candidate.commercialScore;
  const observedAt = input.candidate.provider.collectedAt;
  const commercialFitRef = `commercial-fit-v4:${domain.hostnameAscii}`;
  const sourceRefs = Object.freeze([
    ...new Set([
      commercialFitRef,
      ...input.candidate.provider.evidenceRefs,
      ...input.candidate.staticAssessment.evidenceRefs,
      ...score.components.flatMap(({ evidenceRefs }) => evidenceRefs),
    ]),
  ]);
  const booleanEvidence = (
    value: boolean,
    sourceType: string,
    evidenceRefs: readonly string[] = sourceRefs,
  ) =>
    derivedEvidence({
      value,
      sourceType,
      sourceReleaseId,
      observedAt,
      confidence: 1,
      evidenceRefs,
    });
  const unavailableBoolean = (
    sourceType: string,
    evidenceRefs: readonly string[] = sourceRefs,
  ) =>
    unavailableEvidence<boolean>({
      sourceType,
      sourceReleaseId,
      observedAt,
      evidenceRefs,
    });
  const gate = (
    ruleId: RecommendationGateRuleId,
    result: EvidenceValue<boolean>,
  ) => gateFact(ruleId, result);
  const unsafe =
    input.candidate.business.unsafeOrDisallowedIndustry ||
    input.candidate.staticAssessment.unsafeOrMalicious === true
      ? true
      : input.candidate.staticAssessment.unsafeOrMalicious === false
        ? false
        : null;
  const spamScore = input.candidate.provider.spamScore;
  const linkFarm =
    input.candidate.staticAssessment.highConfidenceLinkFarm === true ||
      (spamScore !== null && spamScore >= 70)
      ? true
      : spamScore !== null && spamScore >= 30
        ? null
        : input.candidate.staticAssessment.highConfidenceLinkFarm === false ||
            spamScore !== null
          ? false
          : null;
  const businessEvidence = (
    value: boolean,
    reason: string,
  ) =>
    booleanEvidence(
      value,
      "postgresql_business_truth",
      [...sourceRefs, reason],
    );
  const gates: RecommendationRuleFacts = Object.freeze({
    unsafe_or_malicious: gate(
      "unsafe_or_malicious",
      unsafe === null
        ? unavailableBoolean("commercial_static_safety")
        : booleanEvidence(unsafe, "commercial_static_safety"),
    ),
    high_confidence_pbn_or_link_farm: gate(
      "high_confidence_pbn_or_link_farm",
      linkFarm === null
        ? unavailableBoolean("commercial_static_and_provider_safety")
        : booleanEvidence(
            linkFarm,
            "commercial_static_and_provider_safety",
          ),
    ),
    crawl_not_permitted: gate(
      "crawl_not_permitted",
      booleanEvidence(
        false,
        "commercial_fit_v4_admission",
        [...sourceRefs, "commercial-fit-v4:technical-evidence-not-hard-gate"],
      ),
    ),
    user_suppressed: gate(
      "user_suppressed",
      businessEvidence(false, "postgresql:user-suppression:none"),
    ),
    workspace_suppressed: gate(
      "workspace_suppressed",
      businessEvidence(false, "postgresql:workspace-suppression:none"),
    ),
    platform_suppressed: gate(
      "platform_suppressed",
      businessEvidence(
        input.candidate.business.permanentlyRejectedOrSuppressed,
        "postgresql:rejection-suppression",
      ),
    ),
    existing_backlink: gate(
      "existing_backlink",
      businessEvidence(
        input.candidate.business.existingBacklinkOrOpportunity,
        "postgresql:backlink-opportunity-dedup",
      ),
    ),
    already_joined: gate(
      "already_joined",
      businessEvidence(false, "postgresql:prospect-dedup"),
    ),
    previously_excluded: gate(
      "previously_excluded",
      businessEvidence(
        input.candidate.business.permanentlyRejectedOrSuppressed,
        "postgresql:recommendation-history",
      ),
    ),
    market_mismatch: gate(
      "market_mismatch",
      booleanEvidence(
        false,
        "commercial_fit_v4_admission",
        [...sourceRefs, "commercial-fit-v4:market-language-scored"],
      ),
    ),
    duplicate_domain: gate(
      "duplicate_domain",
      businessEvidence(false, "postgresql:current-generation-domain-dedup"),
    ),
  });
  const eligible =
    score.decision === "eligible" &&
    score.total !== null &&
    score.total >= commercialFitBaselineAdmissionThreshold &&
    score.admission.appliedThreshold ===
      commercialFitBaselineAdmissionThreshold &&
    score.hitGates.length === 0;
  const aggregate = eligible ? normalizeScore(score.total / 100) : null;
  const components: readonly RecommendationScoreComponentInput[] =
    Object.freeze(
      recommendationScoreComponentIds.map((id) =>
        aggregate === null
          ? unavailableScoreComponent({
              id,
              sourceReleaseId,
              observedAt,
              evidenceRefs: sourceRefs,
            })
          : scoreComponent({
              id,
              value: aggregate,
              sourceType: "commercial_fit_v4_admission",
              sourceReleaseId,
              observedAt,
              evidenceRefs: sourceRefs,
              reasonCode: "CURRENT_COMMERCIAL_V4_ADMISSION",
            })
      ),
    );

  return Object.freeze({
    hostnameAscii: domain.hostnameAscii,
    sourceReleaseId,
    evidencePolicyVersion,
    gates,
    components,
  });
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
  contactEnrichment?: Readonly<{
    limit: number;
    options: ContactEnrichmentJobOptions;
  }>;
}>;

function scopeFrom(input: ExecuteInput | StoreInput): BacklinkTenantContext {
  return {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
  };
}

function createLocalProductDataForSeoGate(
  input: Readonly<{
    pool: BacklinkTenantPool;
    scope: BacklinkTenantContext;
    configuration: LocalProductDataForSeoConfiguration;
    operationBudget: ReturnType<
      typeof resolveLocalProductDataForSeoOperationBudget
    >;
    now: () => Date;
  }>,
): (
  client: BacklinkTenantPoolClient,
  operationPrefix?: string,
) => DataForSeoCallPolicy {
  return (gateClient, operationPrefix) =>
    new DataForSeoCallPolicy({
      async checkAvailability() {
        return localProductDataForSeoAvailabilityDecision(
          input.configuration,
        );
      },
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
            row.layer === "provider"
            && row.provider === gateInput.providerId,
        );
        return project?.blocked === false
            && providerDecision?.blocked === false
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
              AND (
                $6::text IS NULL
                OR usage.reservation_key LIKE $6 || '%'
              )
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
            operationPrefix === undefined
              ? null
              : operationPrefix.endsWith(":")
              ? operationPrefix
              : `${operationPrefix}:`,
          ],
        );
        const paidCallCount = Number(result.rows[0]?.count ?? 0);
        const effectiveMaxPaidCalls =
          input.operationBudget.authorization === null
            ? input.operationBudget.maxPaidCalls
            : resolveProviderOperationBudgetWindow({
                authorization: input.operationBudget.authorization,
                paidCallCount,
                exposureMicros: 0,
                requiredPaidCalls:
                  1 + gateInput.requiredRemainingPaidCalls,
                requiredCostMicros: 0,
              }).maxPaidCalls;
        return isLocalProductDataForSeoPaidCallAllowed(
          paidCallCount,
          effectiveMaxPaidCalls,
          gateInput.requiredRemainingPaidCalls,
        )
          ? "allow"
          : "deny";
      },
      async reserveBudget(gateInput) {
        return withBacklinkTenantTransaction(
          input.pool,
          input.scope,
          async (transaction) => {
            const repository = createProviderBudgetRepository(
              transaction,
              input.now,
            );
            return operationPrefix === undefined
              ? repository.reserveBudgetWithinPaidCallCeiling(
                gateInput,
                input.operationBudget.maxPaidCalls,
                input.operationBudget.operationBudgetLimitMicros,
              )
              : repository.reserveBudgetWithinOperationCeiling(
                gateInput,
                operationPrefix,
                input.operationBudget.maxPaidCalls,
                input.operationBudget.operationBudgetLimitMicros,
                input.operationBudget.dailyBudgetLimitMicros,
                {
                  requiredRemainingPaidCalls:
                    gateInput.requiredRemainingPaidCalls,
                  requiredRemainingCostMicros:
                    gateInput.requiredRemainingCostMicros,
                  ...(input.operationBudget.authorization === null
                    ? {}
                    : {
                        authorization:
                          input.operationBudget.authorization,
                      }),
                },
              );
          },
        );
      },
    });
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
  if (parsed !== null) {
    if (
      parsed.websiteProjectId !== input.websiteProjectId ||
      parsed.projectContextVersionId !== input.projectContextVersionId ||
      parsed.visiblePoolGeneration !== input.visiblePoolGeneration ||
      parsed.tier !== currentTier ||
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
  if (!manualResume) {
    throw new Error("COMMERCIAL_REFILL_CYCLE_KEY_INVALID");
  }
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
  return Object.freeze({ tier, round: currentRound, window: 1 });
}

export function resolveExistingCandidateQualificationPlan<T>(
  input: Readonly<{
    supplyMode?: "existing_evidence";
    publishableCandidates: readonly T[];
    enrichmentCandidates: readonly T[];
  }>,
): Readonly<{
  candidates: readonly T[];
  metricCollectionMode: CommercialQualificationMetricCollectionMode;
}> {
  if (input.supplyMode === "existing_evidence") {
    return Object.freeze({
      candidates: input.publishableCandidates,
      metricCollectionMode: "existing_evidence",
    });
  }
  if (input.publishableCandidates.length > 0) {
    return Object.freeze({
      candidates: input.publishableCandidates,
      metricCollectionMode: "existing_evidence",
    });
  }
  return Object.freeze({
    candidates: input.enrichmentCandidates,
    metricCollectionMode: "provider",
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
  const qualificationInputRepository =
    createProjectInputPersistenceRepository(options.pool);
  const qualificationRecommendationRepository =
    createRecommendationContractRepository(options.pool);
  const qualificationRequestRepository =
    createCommercialQualificationRequestRepository(options.pool, now);

  return Object.freeze({
    async execute(input) {
      const scope = scopeFrom(input);
      const execution = await withBacklinkTenantTransaction(
        options.pool,
        scope,
        async (client) => {
          const authorizationResult = await client.query(
            `SELECT result_summary->'providerBudgetAuthorization'
                    AS "providerBudgetAuthorization"
               FROM backlink_jobs
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3 AND id=$4
                AND source_object_type='recommendation_context'
                AND source_object_id=$5`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.jobId,
              input.recommendationContextVersionId,
            ],
          );
          const authorizationValue =
            authorizationResult.rows[0]?.providerBudgetAuthorization;
          const providerBudgetAuthorization =
            authorizationValue === undefined ||
              authorizationValue === null
              ? null
              : parseProviderOperationBudgetAuthorization(
                authorizationValue,
              );
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
            return Object.freeze({
              refillCycle: null,
              providerBudgetAuthorization,
            });
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
                 AND (
                   policy.visible_pool_state='building'
                   OR (
                     policy.visible_pool_state='active'
                     AND EXISTS (
                       SELECT 1
                         FROM backlink_recommendation_generation_contracts
                              AS contract
                        WHERE (
                          contract.organization_id,contract.workspace_id,
                          contract.website_project_id,
                          contract.recommendation_context_version_id,
                          contract.visible_pool_generation
                        )=(
                          policy.organization_id,policy.workspace_id,
                          policy.website_project_id,
                          policy.project_context_version_id,
                          policy.visible_pool_generation
                        )
                          AND contract.qualification_contract_version=
                            'recommendation-qualification.v1'
                          AND contract.visibility_contract_version=
                            'recommendation-visibility.v1'
                          AND contract.score_model_version=
                            'recommendation-commercial-fit.v4'
                     )
                   )
                 )`,
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
              `UPDATE backlink_commercial_inventory_policies AS policy
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
                  AND (
                    policy.visible_pool_state='building'
                    OR (
                      policy.visible_pool_state='active'
                      AND EXISTS (
                        SELECT 1
                          FROM backlink_recommendation_generation_contracts
                               AS contract
                         WHERE (
                           contract.organization_id,contract.workspace_id,
                           contract.website_project_id,
                           contract.recommendation_context_version_id,
                           contract.visible_pool_generation
                         )=(
                           policy.organization_id,policy.workspace_id,
                           policy.website_project_id,
                           policy.project_context_version_id,
                           policy.visible_pool_generation
                         )
                           AND contract.qualification_contract_version=
                             'recommendation-qualification.v1'
                           AND contract.visibility_contract_version=
                             'recommendation-visibility.v1'
                           AND contract.score_model_version=
                             'recommendation-commercial-fit.v4'
                      )
                    )
                  )`,
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
          return Object.freeze({
            refillCycle: cycle,
            providerBudgetAuthorization,
          });
        },
      );
      const { refillCycle, providerBudgetAuthorization } = execution;
      const operationBudget =
        resolveLocalProductDataForSeoOperationBudget({
          configuration,
          authorization: providerBudgetAuthorization,
        });

      const providerClient = await options.pool.connect();
      try {
        await setSessionTenant(providerClient, scope);
        const contextResult = await providerClient.query(
          `SELECT context.snapshot_version AS "snapshotVersion",
                  context.profile_version_id AS "profileVersionId",
                  context.promotion_target_version_id
                    AS "promotionTargetVersionId",
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
        const parsedRecommendationContext =
          parseLocalProductRecommendationContext(contextRow);
        const inputBinding =
          await qualificationInputRepository
            .readGenerationInputBindingForContext({
              organizationId: scope.organizationId,
              workspaceId: scope.workspaceId,
              websiteProjectId: scope.websiteProjectId,
              projectContextVersion:
                parsedRecommendationContext.snapshotVersion,
              siteProfileVersionId:
                parsedRecommendationContext.profileVersionId,
              promotionTargetVersionId:
                parsedRecommendationContext.promotionTargetVersionId,
              qualificationContractVersion:
                CORRECTED_QUALIFICATION_CONTRACT_VERSION,
              market: parsedRecommendationContext.countryCode,
            });
        const resolvedProjectInput =
          resolveLocalProductProjectDiscoveryInput({
            organizationId: scope.organizationId,
            websiteProjectId: scope.websiteProjectId,
            context: parsedRecommendationContext,
            binding: inputBinding,
            now: now(),
          });
        const recommendationContext = resolvedProjectInput.context;
        const projectLocale = resolveDataForSeoProjectLocale({
          countryCode: recommendationContext.countryCode,
          locale: recommendationContext.locale,
        });
        const projectConfiguration = Object.freeze({
          ...configuration,
          locationCode: projectLocale.locationCode,
          languageCode: projectLocale.languageCode,
        });
        const createGate = createLocalProductDataForSeoGate({
          pool: options.pool,
          scope,
          configuration,
          operationBudget,
          now,
        });
        let credentialsPromise: Promise<
          z.output<typeof dataForSeoCredentialSchema>
        > | null = null;
        const resolveCredentials = () => {
          credentialsPromise ??= (async () =>
            dataForSeoCredentialSchema.parse(
              JSON.parse(
                await secretStore.resolve({
                  reference: credentialReference,
                  context: {
                    organizationId: "local-product",
                    subjectProvider: "dataforseo",
                  },
                }),
              ) as unknown,
            ))();
          return credentialsPromise;
        };
        let qualificationProviderRuntime: Promise<
          ReturnType<typeof createCommercialQualificationOfficialRuntime>
        > | null = null;
        const qualificationProvider = Object.freeze({
          async execute(
            call: Parameters<
              ReturnType<
                typeof createCommercialQualificationOfficialRuntime
              >["execute"]
            >[0],
          ) {
            qualificationProviderRuntime ??= (async () =>
              createCommercialQualificationOfficialRuntime({
                credentials: await resolveCredentials(),
                endpointAllowlist: configuration.endpointAllowlist,
                timeoutMs: configuration.timeoutMs,
              }))();
            return (await qualificationProviderRuntime).execute(call);
          },
        });
        const providerBudgetOperationPrefix =
          `commercial-refill-operation:${input.jobId}`;
        const loadBlueprintTopics = async (): Promise<readonly string[]> => {
          const blueprintResult = await providerClient.query(
            `SELECT blueprint
               FROM backlink_commercial_discovery_blueprints
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3
                AND project_context_version_id=$4
              ORDER BY generated_at DESC,id DESC
              LIMIT 1`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.recommendationContextVersionId,
            ],
          );
          const blueprint = storedCommercialBlueprintTopicsSchema.safeParse(
            blueprintResult.rows[0]?.blueprint,
          );
          return blueprint.success
            ? Object.freeze([...blueprint.data.topicClusters])
            : Object.freeze([]);
        };
        const runQualification = async (
          candidates: readonly CommercialQualificationProductionCandidate[],
          metricCollectionMode:
            CommercialQualificationMetricCollectionMode = "provider",
        ) => {
          const topics = await loadBlueprintTopics();
          const metricRuntime =
            createGovernedCommercialQualificationRuntime({
              context: scope,
              operationId: input.jobId,
              budgetReservationPrefix: providerBudgetOperationPrefix,
              estimatedCostMicros: configuration.estimatedCostMicros,
              provider: qualificationProvider,
              gate: createGate(
                providerClient,
                providerBudgetOperationPrefix,
              ),
              store: qualificationRequestRepository,
              now,
            });
          return executeCommercialQualificationProduction({
            scope: {
              ...scope,
              recommendationContextVersionId:
                input.recommendationContextVersionId,
            },
            context: recommendationContext,
            topics,
            candidates: Object.freeze(candidates.slice(0, 25)),
            visiblePoolGeneration: input.visiblePoolGeneration,
            locationCode: Number(projectConfiguration.locationCode),
            languageCode: projectConfiguration.languageCode,
            endpointAllowlist: configuration.endpointAllowlist,
            metricCollectionMode,
            metricRuntime,
            inputBinding: resolvedProjectInput.binding,
            recommendationRepository:
              qualificationRecommendationRepository,
            createdBy: input.actorId,
            observedAt: now(),
          });
        };
        if (input.source === "existing") {
          await recoverCurrentCommercialStaticAssessments(providerClient, {
            ...scope,
            projectContextVersionId:
              input.recommendationContextVersionId,
            visiblePoolGeneration: input.visiblePoolGeneration,
            operationId: input.jobId,
            actorId: input.actorId,
            maximumCandidates: Math.min(
              Math.max(input.requestedCount * 2, 10),
              25,
            ),
            project: {
              products: recommendationContext.products,
              topics: await loadBlueprintTopics(),
              keywords: recommendationContext.keywords,
              targetPages: recommendationContext.targetUrls,
              targetAudiences: recommendationContext.targetAudiences,
              partnershipGoals: recommendationContext.partnershipGoals,
            },
            safeFetch,
            pageParser: commercialPageParser,
            now: now(),
          });
          const existing = await prepareCurrentCommercialCandidateEnrichment(
            providerClient,
            {
              ...scope,
              projectContextVersionId:
                input.recommendationContextVersionId,
              visiblePoolGeneration: input.visiblePoolGeneration,
              actorId: input.actorId,
              now: now(),
              generationInputFingerprint:
                resolvedProjectInput.binding.immutableFingerprint,
              maximumCandidates: Math.min(input.requestedCount, 25),
              apply: true,
            },
          );
          const qualificationPlan =
            resolveExistingCandidateQualificationPlan({
              ...(input.supplyMode === undefined
                ? {}
                : { supplyMode: input.supplyMode }),
              publishableCandidates: existing.publishableCandidates,
              enrichmentCandidates: existing.candidates,
            });
          const useExistingEvidence =
            qualificationPlan.metricCollectionMode === "existing_evidence";
          const qualificationCandidates = qualificationPlan.candidates;
          const existingQualification = await runQualification(
            qualificationCandidates.map((candidate) =>
              discoveredQualificationCandidate(
                candidate.candidateId,
                candidate,
              )
            ),
            qualificationPlan.metricCollectionMode,
          );
          const qualificationByDomain = new Map(
            existingQualification.qualifications.map((item) => [
              item.hostnameAscii,
              item,
            ]),
          );
          const finalizedCandidates = await mapConcurrent(
            qualificationCandidates,
            1,
            async (candidate) => {
              const metrics = qualificationByDomain.get(
                candidate.hostnameAscii,
              );
              if (metrics === undefined) {
                throw new Error(
                  "COMMERCIAL_QUALIFICATION_RESULT_NOT_PERSISTED",
                );
              }
              const finalized = finalizeCommercialCandidateEnrichment({
                candidate,
                metrics,
                qualificationDecision: metrics.decision,
              });
              await providerClient.query(
                `UPDATE backlink_commercial_candidates
                    SET commercial_score=$6::jsonb,
                        state=$7,
                        gate_decision=
                          COALESCE(gate_decision,'{}'::jsonb)
                          || $8::jsonb,
                        provider_collected_at=$9,
                        updated_at=now(),updated_by=$10,
                        version=version+1
                  WHERE organization_id=$1 AND workspace_id=$2
                    AND website_project_id=$3
                    AND project_context_version_id=$4
                    AND id=$5
                    AND visible_pool_generation=$11
                    AND score_model_version=
                      'recommendation-commercial-fit.v4'
                    AND (
                      ($12::boolean AND state IS DISTINCT FROM $7)
                      OR (
                        NOT $12::boolean
                        AND state='enrichment_eligible'
                      )
                    )`,
                [
                  scope.organizationId,
                  scope.workspaceId,
                  scope.websiteProjectId,
                  input.recommendationContextVersionId,
                  candidate.candidateId,
                  JSON.stringify(finalized.commercialScore),
                  finalized.state,
                  JSON.stringify({
                    enrichment: {
                      decision: "completed",
                      qualificationDecision: metrics.decision,
                      qualificationReasonCode:
                        metrics.decisionReasonCode,
                      trafficState: metrics.trafficState,
                      spamState: metrics.spamState,
                      rankState: metrics.rankState,
                      inputPinId:
                        resolvedProjectInput.binding.inputPinId,
                      generationInputFingerprint:
                        resolvedProjectInput.binding.immutableFingerprint,
                      requestFingerprints: metrics.requestFingerprints,
                    },
                  }),
                  useExistingEvidence
                    ? new Date(candidate.provider.collectedAt)
                    : now(),
                  input.actorId,
                  input.visiblePoolGeneration,
                  useExistingEvidence,
                ],
              );
              return Object.freeze({
                candidate: Object.freeze({
                  ...candidate,
                  provider: Object.freeze({
                    ...candidate.provider,
                    ...finalized.provider,
                  }),
                  commercialScore: finalized.commercialScore,
                }),
                state: finalized.state,
              });
            },
          );
          const sourceReleaseId = input.refillWindowKey;
          const candidates = Object.freeze(
            finalizedCandidates
              .filter(({ state }) => state === "candidate_ready")
              .map(({ candidate }) =>
                buildStoredCommercialRecommendationEvidenceCandidate({
                  candidate,
                  sourceReleaseId,
                })
              ),
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
        const gate = createGate(
          providerClient,
          providerBudgetOperationPrefix,
        );
        let providerRuntime: Promise<
          ReturnType<typeof createCommercialOfficialDataForSeoRuntime>
        > | null = null;
        const resolveProviderRuntime = () => {
          providerRuntime ??= (async () => {
            return createCommercialOfficialDataForSeoRuntime({
              credentials: await resolveCredentials(),
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
          async reconcileDispatchedTask(
            call: Parameters<
              NonNullable<
                ReturnType<
                  typeof createCommercialOfficialDataForSeoRuntime
                >["reconcileDispatchedTask"]
              >
            >[0],
            reconciliation: Parameters<
              NonNullable<
                ReturnType<
                  typeof createCommercialOfficialDataForSeoRuntime
                >["reconcileDispatchedTask"]
              >
            >[1],
          ) {
            const runtime = await resolveProviderRuntime();
            if (runtime.reconcileDispatchedTask === undefined) {
              throw new Error(
                "DATAFORSEO_DISPATCH_RECONCILIATION_UNAVAILABLE",
              );
            }
            return runtime.reconcileDispatchedTask(call, reconciliation);
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
          inputBinding: resolvedProjectInput.binding,
          configuration: projectConfiguration,
          blueprintGenerator: options.blueprintGenerator,
          providerBudgetOperationPrefix,
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
              gate: createGate(client, providerBudgetOperationPrefix),
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
        await recoverCurrentCommercialStaticAssessments(providerClient, {
          ...scope,
          projectContextVersionId: input.recommendationContextVersionId,
          visiblePoolGeneration: input.visiblePoolGeneration,
          operationId: input.jobId,
          actorId: input.actorId,
          maximumCandidates: Math.min(
            Math.max(input.requestedCount * 2, 10),
            25,
          ),
          project: {
            products: recommendationContext.products,
            topics: await loadBlueprintTopics(),
            keywords: recommendationContext.keywords,
            targetPages: recommendationContext.targetUrls,
            targetAudiences: recommendationContext.targetAudiences,
            partnershipGoals: recommendationContext.partnershipGoals,
          },
          safeFetch,
          pageParser: commercialPageParser,
          now: now(),
        });
        const current = await prepareCurrentCommercialCandidateEnrichment(
          providerClient,
          {
            ...scope,
            projectContextVersionId: input.recommendationContextVersionId,
            visiblePoolGeneration: input.visiblePoolGeneration,
            actorId: input.actorId,
            now: now(),
            generationInputFingerprint:
              resolvedProjectInput.binding.immutableFingerprint,
            maximumCandidates: Math.min(input.requestedCount, 25),
            apply: true,
          },
        );
        const qualificationPlan =
          resolveExistingCandidateQualificationPlan({
            publishableCandidates: current.publishableCandidates,
            enrichmentCandidates: current.candidates,
          });
        const useExistingEvidence =
          qualificationPlan.metricCollectionMode === "existing_evidence";
        const qualificationCandidates = qualificationPlan.candidates;
        let finalizedCandidates: Array<Readonly<{
          candidate: CommercialReadyCandidate;
          state: CommercialCandidateEnrichmentState;
        }>> = [];
        if (qualificationCandidates.length === 0) {
          await runQualification(
            [],
            qualificationPlan.metricCollectionMode,
          );
        } else {
          const candidateIds = new Map(
            qualificationCandidates.map((candidate) => [
              candidate.hostnameAscii,
              candidate.candidateId,
            ]),
          );
          const qualification = await runQualification(
            qualificationCandidates.map((candidate) => {
              const candidateId = candidateIds.get(candidate.hostnameAscii);
              if (candidateId === undefined) {
                throw new Error(
                  "COMMERCIAL_QUALIFICATION_CANDIDATE_NOT_PERSISTED",
                );
              }
              return discoveredQualificationCandidate(candidateId, candidate);
            }),
            qualificationPlan.metricCollectionMode,
          );
          const qualificationByDomain = new Map(
            qualification.qualifications.map((item) => [
              item.hostnameAscii,
              item,
            ]),
          );
          finalizedCandidates = [
            ...await mapConcurrent(
              qualificationCandidates,
              1,
              async (candidate) => {
                const candidateId = candidateIds.get(candidate.hostnameAscii);
                const metrics = qualificationByDomain.get(
                  candidate.hostnameAscii,
                );
                if (candidateId === undefined || metrics === undefined) {
                  throw new Error(
                    "COMMERCIAL_QUALIFICATION_RESULT_NOT_PERSISTED",
                  );
                }
                const finalized = finalizeCommercialCandidateEnrichment({
                  candidate,
                  metrics,
                  qualificationDecision: metrics.decision,
                });
                await providerClient.query(
                  `UPDATE backlink_commercial_candidates
                      SET commercial_score=$6::jsonb,
                          state=$7,
                          gate_decision=
                            COALESCE(gate_decision,'{}'::jsonb)
                            || $8::jsonb,
                          provider_collected_at=$9,
                          updated_at=now(),updated_by=$10,
                          version=version+1
                    WHERE organization_id=$1 AND workspace_id=$2
                      AND website_project_id=$3
                      AND project_context_version_id=$4
                      AND id=$5
                      AND visible_pool_generation=$11
                      AND score_model_version=
                        'recommendation-commercial-fit.v4'
                      AND (
                        ($12::boolean AND state IS DISTINCT FROM $7)
                        OR (
                          NOT $12::boolean
                          AND state='enrichment_eligible'
                        )
                      )`,
                  [
                    scope.organizationId,
                    scope.workspaceId,
                    scope.websiteProjectId,
                    input.recommendationContextVersionId,
                    candidateId,
                    JSON.stringify(finalized.commercialScore),
                    finalized.state,
                    JSON.stringify({
                      enrichment: {
                        decision: "completed",
                        qualificationDecision: metrics.decision,
                        qualificationReasonCode:
                          metrics.decisionReasonCode,
                        trafficState: metrics.trafficState,
                        spamState: metrics.spamState,
                        rankState: metrics.rankState,
                        inputPinId:
                          resolvedProjectInput.binding.inputPinId,
                        generationInputFingerprint:
                          resolvedProjectInput.binding.immutableFingerprint,
                        requestFingerprints: metrics.requestFingerprints,
                      },
                    }),
                    useExistingEvidence
                      ? new Date(candidate.provider.collectedAt)
                      : now(),
                    input.actorId,
                    input.visiblePoolGeneration,
                    useExistingEvidence,
                  ],
                );
                return Object.freeze({
                  candidate: Object.freeze({
                    ...candidate,
                    provider: Object.freeze({
                      ...candidate.provider,
                      ...finalized.provider,
                    }),
                    commercialScore: finalized.commercialScore,
                  }),
                  state: finalized.state,
                });
              },
            ),
          ];
        }
        const finalCandidates = finalizedCandidates.filter(
          ({ state }) => state === "candidate_ready",
        ).map(({ candidate }) => candidate);
        const sourceReleaseId = `commercial-dataforseo:${commercial.provider.requestFingerprint}`;
        const projectTerms = Object.freeze([
          ...recommendationContext.keywords,
          ...recommendationContext.products,
        ]);
        const candidates = await mapConcurrent(
          finalCandidates,
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
               FROM backlink_commercial_inventory_policies AS policy
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3
                AND project_context_version_id=$4
                AND visible_pool_generation=$5
                AND (
                  policy.visible_pool_state='building'
                  OR (
                    policy.visible_pool_state='active'
                    AND EXISTS (
                      SELECT 1
                        FROM backlink_recommendation_generation_contracts
                             AS contract
                       WHERE (
                         contract.organization_id,contract.workspace_id,
                         contract.website_project_id,
                         contract.recommendation_context_version_id,
                         contract.visible_pool_generation
                       )=(
                         policy.organization_id,policy.workspace_id,
                         policy.website_project_id,
                         policy.project_context_version_id,
                         policy.visible_pool_generation
                       )
                         AND contract.qualification_contract_version=
                           'recommendation-qualification.v1'
                         AND contract.visibility_contract_version=
                           'recommendation-visibility.v1'
                         AND contract.score_model_version=
                           'recommendation-commercial-fit.v4'
                    )
                  )
                )
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
                    'recommendation-commercial-fit.v4'
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
            const qualificationFact = await client.query(
              `SELECT qualification.id::text AS "qualificationFactId",
                      qualification.generation_contract_id::text
                        AS "generationContractId",
                      qualification.metric_scope AS "metricScope",
                      qualification.traffic_organic_etv
                        AS "trafficOrganicEtv",
                      qualification.spam_score AS "spamScore",
                      qualification.authority_rank AS "authorityRank",
                      qualification.accessibility_decision
                        AS "accessibilityDecision",
                      qualification.semantic_score AS "semanticScore",
                      qualification.decision,
                      qualification.decision_reason_code
                        AS "decisionReasonCode",
                      qualification.model_version AS "modelVersion",
                      qualification.prompt_version AS "promptVersion",
                      qualification.rule_version AS "ruleVersion",
                      qualification.request_fingerprints
                        AS "requestFingerprints",
                      qualification.evidence,
                      qualification.observed_at AS "observedAt"
                 FROM backlinks.backlink_recommendation_qualification_facts
                        qualification
                 JOIN backlinks.backlink_recommendation_generation_contracts
                        generation
                   ON generation.id=qualification.generation_contract_id
                  AND generation.organization_id=
                        qualification.organization_id
                  AND generation.workspace_id=qualification.workspace_id
                  AND generation.website_project_id=
                        qualification.website_project_id
                WHERE qualification.organization_id=$1
                  AND qualification.workspace_id=$2
                  AND qualification.website_project_id=$3
                  AND qualification.recommendation_context_version_id=$4
                  AND qualification.candidate_id=$5
                  AND qualification.recommendation_id IS NULL
                  AND qualification.prospect_id IS NULL
                  AND qualification.decision='eligible'
                  AND qualification.fact_contract_version=$7
                  AND qualification.score_model_version=$8
                  AND generation.visible_pool_generation=$6
                  AND generation.qualification_contract_version=$7
                  AND generation.visibility_contract_version=$9
                  AND generation.score_model_version=$8
                ORDER BY qualification.attempt DESC,
                         qualification.observed_at DESC,
                         qualification.id DESC
                LIMIT 1`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                commercialRow?.id,
                input.visiblePoolGeneration,
                CORRECTED_QUALIFICATION_CONTRACT_VERSION,
                CORRECTED_SCORE_MODEL_VERSION,
                CORRECTED_VISIBILITY_CONTRACT_VERSION,
              ],
            );
            const parsedQualification =
              storedCommercialQualificationFactSchema.safeParse(
                qualificationFact.rows[0],
              );
            if (!parsedQualification.success) continue;
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
                 'CONTACT_PENDING','recommendation-commercial-fit.v4',
                 'CONTACT_PENDING',$9,$9
               )
               ON CONFLICT (
                 organization_id,workspace_id,website_project_id,
                 recommendation_id,recommendation_context_version_id,
                 visible_pool_generation
               ) DO UPDATE SET
                 fit_decision='eligible',
                 fit_score_model_version=
                   'recommendation-commercial-fit.v4',
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
            const qualification = parsedQualification.data;
            const publicationFactIdentity = {
              organizationId: scope.organizationId,
              workspaceId: scope.workspaceId,
              websiteProjectId: scope.websiteProjectId,
              recommendationContextVersionId:
                input.recommendationContextVersionId,
              generationContractId: qualification.generationContractId,
              recommendationId: storedRecommendationId,
              prospectId: String(storedProspectId),
              canonicalDomain: domain.registrableDomain,
            };
            const publicationQualification = {
              metricScope: qualification.metricScope,
              trafficOrganicEtv: qualification.trafficOrganicEtv,
              spamScore: qualification.spamScore,
              authorityRank: qualification.authorityRank,
              accessibilityDecision: qualification.accessibilityDecision,
              semanticScore: qualification.semanticScore,
              decision: qualification.decision,
              decisionReasonCode: qualification.decisionReasonCode,
              modelVersion: qualification.modelVersion,
              promptVersion: qualification.promptVersion,
              ruleVersion: qualification.ruleVersion,
              requestFingerprints: qualification.requestFingerprints,
              evidence: {
                ...qualification.evidence,
                sourceQualificationFactId:
                  qualification.qualificationFactId,
                publicationScore: {
                  scoreModelVersion: score.scoreModelVersion,
                  ruleVersion: score.ruleVersion,
                  total: score.total,
                  admission: score.admission,
                },
              },
            } as const;
            const publicationVisibility = {
              decision: "visible",
              decisionReasonCode: "QUALIFIED_VISIBLE",
              ruleVersion: "visibility-rules-v1",
              evidence: {
                sourceQualificationFactId:
                  qualification.qualificationFactId,
                qualificationDecision: qualification.decision,
                qualificationReasonCode:
                  qualification.decisionReasonCode,
                scoreModelVersion: score.scoreModelVersion,
                totalScore: score.total,
                admissionThreshold: score.admission.appliedThreshold,
              },
            } as const;
            const publicationContact = {
              decision: "pending",
              decisionReasonCode: "CONTACT_NOT_EVALUATED",
              evidence: {
                source: "commercial-qualification-publication",
              },
            } as const;
            const publicationCooperationPath = {
              decision: "pending",
              decisionReasonCode: "PATH_NOT_EVALUATED",
              pathType: null,
              evidence: {
                source: "commercial-qualification-publication",
              },
            } as const;
            await writeCorrectedRecommendationFactsInTransaction(client, {
              organizationId: scope.organizationId,
              workspaceId: scope.workspaceId,
              websiteProjectId: scope.websiteProjectId,
              recommendationContextVersionId:
                input.recommendationContextVersionId,
              generationContractId: qualification.generationContractId,
              visiblePoolGeneration: input.visiblePoolGeneration,
              workerContractVersion:
                CORRECTED_QUALIFICATION_CONTRACT_VERSION,
              prospectId: String(storedProspectId),
              recommendationId: storedRecommendationId,
              scoreId,
              inventoryId: String(inventory.rows[0]?.id ?? inventoryId),
              canonicalDomain: domain.registrableDomain,
              normalizationVersion: domain.normalizationVersion,
              totalScore: score.total,
              scoreComponents: score.components.map((component) => ({
                ...component,
              })),
              scoreWeights: weights,
              scoreEvidence,
              qualification: {
                factId: deterministicFactId(
                  "recommendation-publication:qualification",
                  {
                    ...publicationFactIdentity,
                    ...publicationQualification,
                  },
                ),
                attempt: 2,
                ...publicationQualification,
              },
              visibility: {
                factId: deterministicFactId(
                  "recommendation-publication:visibility",
                  {
                    ...publicationFactIdentity,
                    ...publicationVisibility,
                  },
                ),
                attempt: 2,
                ...publicationVisibility,
              },
              contact: {
                factId: deterministicFactId(
                  "recommendation-publication:contact",
                  {
                    ...publicationFactIdentity,
                    ...publicationContact,
                  },
                ),
                attempt: 2,
                ...publicationContact,
              },
              cooperationPath: {
                factId: deterministicFactId(
                  "recommendation-publication:cooperation-path",
                  {
                    ...publicationFactIdentity,
                    ...publicationCooperationPath,
                  },
                ),
                attempt: 2,
                ...publicationCooperationPath,
              },
              observedAt: qualification.observedAt,
              createdBy: input.actorId,
            });
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
                      'recommendation-commercial-fit.v4'
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
          const contactJobsQueued =
            options.contactEnrichment === undefined
              ? 0
              : await ensureReadyContactEnrichmentJobs(client, {
                  scope,
                  actorId: input.actorId,
                  limit: options.contactEnrichment.limit,
                  options: options.contactEnrichment.options,
                });
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
                contactJobsQueued,
                provider: input.provider,
                evaluation: input.evaluationSummary,
                refillWindowKey: input.refillWindowKey,
                final: input.finalizeJob !== false,
                ...(input.refillWindowKey.startsWith("commercial-existing:")
                  ? { existingCandidatesCompleted: true }
                  : {}),
              }),
            ],
          );
          return { addedCount };
        },
      );
    },
  });
}
