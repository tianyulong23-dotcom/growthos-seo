
import { performance } from "node:perf_hooks";

import { load } from "cheerio";
import { z } from "zod";

import { createCommercialOfficialDataForSeoRuntime } from "../adapters/dataforseo/commercial-official-runtime.js";

import { resolveDataForSeoProjectLocale } from "../adapters/dataforseo/project-locale.js";

import { SafeFetchAdapter } from "../adapters/http/safe-fetch.adapter.js";
import {
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import {
  DataForSeoCallPolicy,
  type DataForSeoAvailabilityDecision,
} from "../application/policies/dataforseo-call.policy.js";
import type {
  RecommendationSeedCommands,
  RecommendationSeedPersisted,
} from "../application/commands/recommendation-seeds.command.js";

import { type ContactEnrichmentJobOptions } from "../application/commands/contact-enrichment.command.js";
import { type CommercialQualificationMetricCollectionMode } from "../application/services/commercial-qualification-production.service.js";
import { executeCommercialRecommendationDiscovery, type CommercialRecommendationNativeV2RequestPort } from "../application/services/commercial-recommendation-discovery.service.js";
import { type CurrentCommercialCandidateEnrichment } from "../application/services/current-commercial-candidate-enrichment.service.js";

import type {
  BacklinkRecommendationRefillActivities,
  RecommendationProviderExecutionSummary,
} from "../workflows/definitions/backlink-recommendation-refill.orchestration.js";
import type { EvidenceValue } from "../domain/evidence/evidence.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../domain/context/index.js";

import { createRecommendationDomainKey } from "../domain/recommendations/domain-key.js";

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
import { isRecommendationPoolV2ProjectGeneratable } from "../domain/recommendations/recommendation-pool-v2-project-generation-eligibility.js";
import { recommendationPoolV2AdmissionContractVersion } from "../domain/recommendations/recommendation-pool-v2-policy.js";

import { createProjectInputPersistenceRepository } from "../db/repositories/project-input-persistence.repository.js";
import { createProviderBudgetRepository } from "../db/repositories/provider-budget.repository.js";

import {
  withBacklinkTenantTransaction,
  type BacklinkTenantContext,
  type BacklinkTenantPool,
  type BacklinkTenantPoolClient,
} from "../db/tenant-transaction.js";
import type { ReferringDomainEvidence } from "../ports/dataforseo.port.js";
import type { AiCommercialDiscoveryBlueprintPort } from "../ports/ai-commercial-discovery-blueprint.port.js";
import { CORRECTED_QUALIFICATION_CONTRACT_VERSION } from "../ports/recommendation-contract.port.js";
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
    executionCeiling: z.object({
      startedAt: z.string().datetime({ offset: true }),
      limitMicros: z.number().int().positive().max(100_000_000),
    }).strict().optional(),
    candidateLimit: z.number().int().min(10).max(100),
    discoveryConcurrency: z.number().int().min(1).max(4).optional(),
    qualificationConcurrency: z.number().int().min(1).max(4).optional(),
    externalAvailability: z.enum(["not_checked", "available", "unavailable"]),
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
      value.externalAvailability === "unavailable" &&
      (value.externalReasonCode === null ||
        value.externalReasonCode === "provider_disabled" ||
        value.externalReasonCode === "provider_not_checked" ||
        value.externalRecoveryAction === null)
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
const projectRecommendationContextDatabaseRowSchema = z
  .object({
    poolContractVersion: z
      .enum(["recommendation-pool.v1", "recommendation-pool.v2"])
      .nullable(),
    poolMigrationState: z
      .enum([
        "V1_ACTIVE",
        "V2_READY",
        "V2_ACTIVE",
        "MIGRATION_BLOCKED",
        "V2_MAINTENANCE_READ_ONLY",
      ])
      .nullable(),
    poolRecommendationContextVersionId: z.string().uuid().nullable(),
  })
  .passthrough();

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

export function parseLocalProductRecommendationContextDatabaseRow(
  value: unknown,
): Readonly<{
  context: LocalProductRecommendationContext;
  poolContractVersion:
    "recommendation-pool.v1" | "recommendation-pool.v2" | null;
  migrationState:
    | "V1_ACTIVE"
    | "V2_READY"
    | "V2_ACTIVE"
    | "MIGRATION_BLOCKED"
    | "V2_MAINTENANCE_READ_ONLY"
    | null;
  contractRecommendationContextVersionId: string | null;
}> {
  const {
    poolContractVersion,
    poolMigrationState,
    poolRecommendationContextVersionId,
    ...projectContext
  } = projectRecommendationContextDatabaseRowSchema.parse(value);
  return Object.freeze({
    context: parseLocalProductRecommendationContext(projectContext),
    poolContractVersion,
    migrationState: poolMigrationState,
    contractRecommendationContextVersionId: poolRecommendationContextVersionId,
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
  return (
    evidence.snapshot.status === "ready" &&
    Number.isFinite(expiresAt) &&
    expiresAt > now.getTime()
  );
}

function isReadyPinnedEvidence(evidence: PinnedSharedSeoEvidence): boolean {
  return evidence.snapshot.status !== "failed";
}

function normalizedStringArray(value: unknown): readonly string[] {
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

function eligiblePreparedSeeds(
  prepared: RecommendationSeedPersisted | null | undefined,
) {
  return (
    prepared?.seeds.filter(
      (seed) =>
        seed.validationStatus === "VERIFIED" ||
        seed.validationStatus === "RETAINED_LOW_CONFIDENCE",
    ) ?? []
  );
}

function validatePreparedSeedBlueprintLineage(
  prepared: RecommendationSeedPersisted,
): void {
  const eligible = eligiblePreparedSeeds(prepared);
  if (
    eligible.length === 0 ||
    prepared.blueprintSeedReferences.length !== eligible.length
  ) {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "regenerate_recommendation_seeds",
      "recommendation_seed_blueprint_lineage_invalid",
    );
  }
  const eligibleById = new Map(
    eligible.map((seed) => [seed.id, seed.seedFingerprint]),
  );
  const referenceIds = new Set<string>();
  const referenceRecordIds = new Set<string>();
  const referenceOrdinals = new Set<number>();
  const blueprintIds = new Set<string>();
  for (const reference of prepared.blueprintSeedReferences) {
    if (
      eligibleById.get(reference.seedId) !== reference.seedFingerprint ||
      referenceIds.has(reference.seedId) ||
      reference.id.length === 0 ||
      referenceRecordIds.has(reference.id) ||
      reference.blueprintId.length === 0 ||
      referenceOrdinals.has(reference.seedOrdinal) ||
      !Number.isInteger(reference.seedOrdinal) ||
      reference.seedOrdinal < 1 ||
      reference.seedOrdinal > eligible.length
    ) {
      return discoveryInputRequired(
        "WEBSITE_PROJECT",
        "regenerate_recommendation_seeds",
        "recommendation_seed_blueprint_lineage_invalid",
      );
    }
    referenceIds.add(reference.seedId);
    referenceRecordIds.add(reference.id);
    referenceOrdinals.add(reference.seedOrdinal);
    blueprintIds.add(reference.blueprintId);
  }
  if (
    referenceIds.size !== eligible.length ||
    referenceOrdinals.size !== eligible.length ||
    blueprintIds.size !== 1
  ) {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "regenerate_recommendation_seeds",
      "recommendation_seed_blueprint_lineage_invalid",
    );
  }
}

const preTaskSeedProjectContextSchema = z.object({
  canonicalDomain: z.string().trim().min(1),
  locale: z.string().trim().min(1),
  countryCode: z.string().trim().min(1),
  profileVersionId: z.string().trim().min(1),
  promotionTargetVersionId: z.string().trim().min(1),
});

export async function prepareRecommendationSeedsBeforeProjectReadiness(
  input: Readonly<{
    commands:
      | Pick<
          RecommendationSeedCommands,
          "prepareBeforeTask" | "prepareForGeneration"
        >
      | undefined;
    poolContractVersion: unknown;
    migrationState: unknown;
    contractRecommendationContextVersionId: unknown;
    expectedRecommendationContextVersionId: string;
    targetGenerationContractId?: string;
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    actorId: string;
    jobId: string;
    workflowId: string;
    correlationId: string;
    projectContext: unknown;
  }>,
): Promise<RecommendationSeedPersisted | null> {
  if (input.poolContractVersion !== "recommendation-pool.v2") {
    return null;
  }
  if (
    input.migrationState !== "V2_READY" &&
    input.migrationState !== "V2_ACTIVE"
  ) {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "complete_recommendation_pool_v2_migration",
      "recommendation_seed_contract_not_writable",
    );
  }
  if (
    input.contractRecommendationContextVersionId !==
    input.expectedRecommendationContextVersionId
  ) {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "reproject_current_website_project",
      "recommendation_seed_context_mismatch",
    );
  }
  if (input.commands === undefined) {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "restore_recommendation_seed_service",
      "recommendation_seed_service_unavailable",
    );
  }
  const project = preTaskSeedProjectContextSchema.parse(input.projectContext);
  const context = Object.freeze({
    actor: createActorContext({
      userId: input.actorId,
      sessionId: `recommendation-seed-pre-task:${input.workflowId}`,
      roles: ["member"],
    }),
    tenant: createTenantContext({
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
    }),
    project: createProjectContext({
      websiteProjectId: input.websiteProjectId,
      canonicalDomain: project.canonicalDomain,
      locale: project.locale,
      countryCode: project.countryCode,
      profileVersionId: project.profileVersionId,
      promotionTargetVersionId: project.promotionTargetVersionId,
    }),
  });
  const commandInput = {
    context,
    idempotencyKey:
      input.targetGenerationContractId === undefined
        ? `recommendation-seeds:pre-task:${input.jobId}`
        : [
            "recommendation-seeds",
            "generation",
            input.targetGenerationContractId,
          ].join(":"),
    requestId: input.correlationId,
    userSeeds: [],
    systemCandidates: [],
  } as const;
  const prepared =
    input.targetGenerationContractId === undefined
      ? await input.commands.prepareBeforeTask(commandInput)
      : await input.commands.prepareForGeneration({
          ...commandInput,
          targetGenerationContractId: input.targetGenerationContractId,
        });
  if (prepared.state !== "READY") {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "add_or_verify_recommendation_seeds",
      "recommendation_seeds_input_required",
    );
  }
  validatePreparedSeedBlueprintLineage(prepared);
  return prepared;
}

export function applyPreparedSeedsToProjectContext(
  context: unknown,
  prepared: RecommendationSeedPersisted | null,
): unknown {
  if (
    prepared === null ||
    typeof context !== "object" ||
    context === null ||
    Array.isArray(context)
  ) {
    return context;
  }
  const eligible = eligiblePreparedSeeds(prepared);
  const topics = eligible
    .filter((seed) => seed.kind === "KEYWORD" || seed.kind === "CATEGORY")
    .map((seed) => seed.normalizedValue);
  const competitors = eligible
    .filter((seed) => seed.kind === "SEO_COMPETITOR")
    .map((seed) => seed.normalizedValue);
  const record = context as Readonly<Record<string, unknown>>;
  return {
    ...record,
    keywords: normalizedStringArray([
      ...normalizedStringArray(record.keywords),
      ...topics,
    ]),
    explicitCompetitorDomains: normalizedStringArray([
      ...normalizedStringArray(record.explicitCompetitorDomains),
      ...competitors,
    ]),
  };
}

export function resolveLocalProductProjectDiscoveryInput(
  input: Readonly<{
    organizationId: string;
    websiteProjectId: string;
    context: LocalProductRecommendationContext;
    binding: GenerationInputBinding | null;
    preparedSeeds?: RecommendationSeedPersisted | null;
    qualificationContractVersion?: string;
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
  const preparedTopics = eligiblePreparedSeeds(input.preparedSeeds)
    .filter((seed) => seed.kind === "KEYWORD" || seed.kind === "CATEGORY")
    .map((seed) => seed.normalizedValue);
  const effectiveKeywords = normalizedStringArray([
    ...profile.keywordsAndTopics,
    ...preparedTopics,
  ]);
  if (
    pins.organizationId !== input.organizationId ||
    pins.websiteProjectId !== input.websiteProjectId ||
    pins.projectContextVersion !== input.context.snapshotVersion ||
    pins.siteProfileVersionId !== input.context.profileVersionId ||
    pins.outreachProfileVersionId !== profile.profileVersionId ||
    pins.promotionTargetVersionId !== input.context.promotionTargetVersionId ||
    pins.qualificationContractVersion !==
      (input.qualificationContractVersion ?? CORRECTED_QUALIFICATION_CONTRACT_VERSION) ||
    pins.market !== input.context.countryCode ||
    profile.organizationId !== input.organizationId ||
    profile.websiteProjectId !== input.websiteProjectId ||
    profile.profileVersionId !== input.context.profileVersionId ||
    profile.promotionTargetVersionId !==
      input.context.promotionTargetVersionId ||
    profile.market !== input.context.countryCode ||
    profile.location !== input.context.countryCode ||
    profile.language !== input.context.locale
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
  if (effectiveKeywords.length === 0 && profile.targetUrls.length === 0) {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "add_promotion_topic_or_publish_target",
      "missing_promotion_topic_or_published_target",
    );
  }
  const readyEvidence = binding.sharedEvidence.filter(isReadyPinnedEvidence);
  const freshEvidence = readyEvidence.filter((evidence) =>
    isFreshPinnedEvidence(evidence, input.now),
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
    effectiveKeywords.length === 0 &&
    !readyEvidence.some(({ snapshot }) => snapshot.sourceModule === "content")
  ) {
    return discoveryInputRequired(
      "CONTENT",
      "publish_target_content",
      "published_target_evidence_missing",
    );
  }
  const canonicalDomain =
    siteProfileEvidence.snapshot.normalizedParameters.canonicalDomain;
  let evidenceDomainKey: string;
  let contextDomainKey: string;
  try {
    evidenceDomainKey =
      typeof canonicalDomain === "string"
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
  const authorizedSources = new Set(profile.authorizedDiscoverySources);
  if (
    !authorizedSources.has("WEBSITE_PROJECT") ||
    !authorizedSources.has("CURATED_RESOURCE_LIBRARY")
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
  const explicitCompetitorDomains =
    competitorEvidence === undefined
      ? Object.freeze([] as string[])
      : normalizedStringArray(
          competitorEvidence.snapshot.normalizedParameters.domains,
        );
  const preparedCompetitorDomains = eligiblePreparedSeeds(input.preparedSeeds)
    .filter((seed) => seed.kind === "SEO_COMPETITOR")
    .map((seed) => seed.normalizedValue);
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
      keywords: Object.freeze([...effectiveKeywords]),
      targetUrls: Object.freeze([...profile.targetUrls]),
      targetAudiences: Object.freeze([...profile.targetAudiences]),
      partnershipGoals: Object.freeze([...profile.partnershipGoals]),
      explicitCompetitorDomains: Object.freeze(
        normalizedStringArray([
          ...explicitCompetitorDomains,
          ...preparedCompetitorDomains,
        ]),
      ),
    }),
  });
}

export async function executeRecommendationSeedReadinessGate<T>(
  input: Parameters<
    typeof prepareRecommendationSeedsBeforeProjectReadiness
  >[0] &
    Readonly<{
      loadInputBinding(
        context: LocalProductRecommendationContext,
      ): Promise<GenerationInputBinding | null>;
      onReady(
        input: Readonly<{
          context: LocalProductRecommendationContext;
          binding: GenerationInputBinding;
          preparedSeeds: RecommendationSeedPersisted | null;
        }>,
      ): Promise<T> | T;
      now: Date;
      seedPreparationMode?: "prepare_before_task" | "confirmed_native_v2";
    }>,
): Promise<T> {
  const usesConfirmedNativeV2Seeds =
    input.seedPreparationMode === "confirmed_native_v2";
  if (
    usesConfirmedNativeV2Seeds &&
    (input.poolContractVersion !== "recommendation-pool.v2" ||
      !["V2_READY", "V2_ACTIVE", "MIGRATION_BLOCKED"].includes(
        String(input.migrationState),
      ))
  ) {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "complete_recommendation_pool_v2_migration",
      "recommendation_seed_contract_not_writable",
    );
  }
  if (
    usesConfirmedNativeV2Seeds &&
    input.contractRecommendationContextVersionId !==
      input.expectedRecommendationContextVersionId
  ) {
    return discoveryInputRequired(
      "WEBSITE_PROJECT",
      "reproject_current_website_project",
      "recommendation_seed_context_mismatch",
    );
  }
  const preparedSeeds = usesConfirmedNativeV2Seeds
    ? null
    : await prepareRecommendationSeedsBeforeProjectReadiness(input);
  const context = parseLocalProductRecommendationContext(
    applyPreparedSeedsToProjectContext(input.projectContext, preparedSeeds),
  );
  const binding = await input.loadInputBinding(context);
  const resolved = resolveLocalProductProjectDiscoveryInput({
    organizationId: input.organizationId,
    websiteProjectId: input.websiteProjectId,
    context,
    binding,
    preparedSeeds,
    ...(usesConfirmedNativeV2Seeds
      ? { qualificationContractVersion: recommendationPoolV2AdmissionContractVersion }
      : {}),
    now: input.now,
  });
  return input.onReady({
    ...resolved,
    preparedSeeds,
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
  const approvedPaidCalls =
    input.authorization === null
      ? applyProviderBudgetAutomaticOverage(input.configuration.maxPaidCalls)
      : input.authorization.maxPaidCalls;
  const approvedCostMicros =
    input.authorization === null
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

function optionalPositiveIntegerEnvironmentValue(
  environment: Environment,
  name: string,
  fallback: number,
): number {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) return fallback;
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
    ...(environment.DATAFORSEO_EXECUTION_STARTED_AT === undefined
      && environment.DATAFORSEO_EXECUTION_LIMIT_MICROS === undefined
      ? {}
      : {
          executionCeiling: {
            startedAt: requiredEnvironmentValue(
              environment, "DATAFORSEO_EXECUTION_STARTED_AT",
            ),
            limitMicros: positiveIntegerEnvironmentValue(
              environment, "DATAFORSEO_EXECUTION_LIMIT_MICROS",
            ),
          },
        }),
    candidateLimit: positiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_CANDIDATE_LIMIT",
    ),
    discoveryConcurrency: optionalPositiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_DISCOVERY_CONCURRENCY",
      2,
    ),
    qualificationConcurrency: optionalPositiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_QUALIFICATION_CONCURRENCY",
      2,
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
      "BACKLINKS_DATAFORSEO_CREDENTIAL_UNAVAILABLE" +
        ` root=${options.secretStoreRoot}` +
        ` reference=${configuration.credentialSecretRef}`,
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
  const businessEvidence = (value: boolean, reason: string) =>
    booleanEvidence(value, "postgresql_business_truth", [
      ...sourceRefs,
      reason,
    ]);
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
        : booleanEvidence(linkFarm, "commercial_static_and_provider_safety"),
    ),
    crawl_not_permitted: gate(
      "crawl_not_permitted",
      booleanEvidence(false, "commercial_fit_v4_admission", [
        ...sourceRefs,
        "commercial-fit-v4:technical-evidence-not-hard-gate",
      ]),
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
      booleanEvidence(false, "commercial_fit_v4_admission", [
        ...sourceRefs,
        "commercial-fit-v4:market-language-scored",
      ]),
    ),
    duplicate_domain: gate(
      "duplicate_domain",
      businessEvidence(false, "postgresql:current-generation-domain-dedup"),
    ),
  });
  const eligible =
    score.decision === "eligible" &&
    score.total !== null &&
    score.total >= score.admission.appliedThreshold &&
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
            }),
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

type RefillExecuteInput = Parameters<
  BacklinkRecommendationRefillActivities["executeRecommendationRefill"]
>[0];

export type LocalProductDataForSeoNativeV2Execution = Readonly<{
  generationContractId: string;
  discoveryBudgetPolicyVersion: string;
  round: 1 | 2;
  maxCostMicros: number;
  requestFingerprint: string;
  requestPort: CommercialRecommendationNativeV2RequestPort;
}>;

export type LocalProductDataForSeoExecuteInput = RefillExecuteInput &
  Readonly<{
    nativeV2: LocalProductDataForSeoNativeV2Execution;
  }>;

export type LocalProductDataForSeoRuntime = Readonly<{
  execute(
    input: LocalProductDataForSeoExecuteInput,
  ): ReturnType<
    BacklinkRecommendationRefillActivities["executeRecommendationRefill"]
  >;
}>;

type RuntimeOptions = Readonly<{
  pool: BacklinkTenantPool;
  secretStoreRoot: string;
  configuration: LocalProductDataForSeoConfiguration;
  now?: () => Date;
  monotonicNow?: () => number;
  safeFetch?: Pick<SafeFetchPort, "fetch">;
  browserFetch?: Pick<SafeFetchPort, "fetch">;
  blueprintGenerator?: AiCommercialDiscoveryBlueprintPort | undefined;
  recommendationSeedCommands?: Pick<
    RecommendationSeedCommands,
    "prepareBeforeTask" | "prepareForGeneration"
  >;
  contactEnrichment?: Readonly<{
    limit: number;
    options: ContactEnrichmentJobOptions;
  }>;
}>;

function scopeFrom(
  input: LocalProductDataForSeoExecuteInput,
): BacklinkTenantContext {
  return {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
  };
}

export function createLocalProductDataForSeoGate(
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
        return localProductDataForSeoAvailabilityDecision(input.configuration);
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
            row.layer === "provider" && row.provider === gateInput.providerId,
        );
        return project?.blocked === false && providerDecision?.blocked === false
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
                requiredPaidCalls: 1 + gateInput.requiredRemainingPaidCalls,
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
              input.configuration.executionCeiling,
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
                          authorization: input.operationBudget.authorization,
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

function elapsedMilliseconds(startedAt: number, completedAt: number): number {
  return Math.max(0, Math.round(completedAt - startedAt));
}

export function createLocalProductDataForSeoRuntime(
  options: RuntimeOptions,
): LocalProductDataForSeoRuntime {
  const configuration = configurationSchema.parse(options.configuration);
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
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
  const qualificationInputRepository = createProjectInputPersistenceRepository(
    options.pool,
  );

  return Object.freeze({
    async execute(input) {
      if (input.nativeV2 === undefined) {
        throw new Error("BACKLINKS_V1_RECOMMENDATION_PROVIDER_RETIRED");
      }
      const scope = scopeFrom(input);
      const execution = await withBacklinkTenantTransaction(
        options.pool,
        scope,
        async (client) => {
          const authorizationResult = await client.query(
            `SELECT result_summary->'providerBudgetAuthorization'
                    AS "providerBudgetAuthorization",
                    created_at AS "createdAt"
               FROM backlink_jobs
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3 AND id=$4
                AND source_object_type=$6
                AND source_object_id=$5`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.jobId,
              input.recommendationContextVersionId,
              input.nativeV2 === undefined
                ? "recommendation_context"
                : "project-context-snapshot",
            ],
          );
          if (
            input.nativeV2 !== undefined &&
            authorizationResult.rows[0] === undefined
          ) {
            throw new Error("RECOMMENDATION_POOL_V2_JOB_LINEAGE_INVALID");
          }
          const authorizationValue =
            authorizationResult.rows[0]?.providerBudgetAuthorization;
          const providerBudgetAuthorization =
            authorizationValue === undefined || authorizationValue === null
              ? null
              : parseProviderOperationBudgetAuthorization(authorizationValue);
          const createdAt = new Date(
            String(authorizationResult.rows[0]?.createdAt ?? ""),
          ).getTime();
          const recommendationQueueMs = Number.isFinite(createdAt)
            ? Math.max(0, now().getTime() - createdAt)
            : 0;

          const generation = await client.query(
              `SELECT generation.input_pin_id "inputPinId",
                      contract.pool_contract_version "poolContractVersion",
                      contract.migration_state "migrationState",
                      contract.state_reason_codes "stateReasonCodes",
                      CASE
                        WHEN contract.migration_state='MIGRATION_BLOCKED'
                          THEN COALESCE((
                            backlinks
                              .backlink_recommendation_pool_v2_native_generation_verify()
                              ->>'v1WritesFrozen'
                          )::boolean,false)
                        ELSE false
                      END "v1WritesFrozen"
                 FROM backlink_recommendation_generation_contracts AS generation
                 JOIN backlink_recommendation_pool_project_contracts AS contract
                   ON contract.organization_id=generation.organization_id
                  AND contract.workspace_id=generation.workspace_id
                  AND contract.website_project_id=generation.website_project_id
                  AND (
                    contract.recommendation_context_version_id=
                      generation.recommendation_context_version_id
                    OR (
                      contract.migration_state='V2_READY'
                      AND contract.generation_contract_id IS NULL
                      AND contract.recommendation_context_version_id IS NULL
                    )
                  )
                WHERE generation.organization_id=$1
                  AND generation.workspace_id=$2
                  AND generation.website_project_id=$3
                  AND generation.recommendation_context_version_id=$4
                  AND generation.visible_pool_generation=$5
                  AND generation.id=$6
                  AND generation.pool_contract_version='recommendation-pool.v2'
                  AND generation.discovery_budget_policy_version=$7
                  AND generation.discovery_completed_at IS NULL`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                input.visiblePoolGeneration,
                input.nativeV2.generationContractId,
                input.nativeV2.discoveryBudgetPolicyVersion,
              ],
            );
if (
              generation.rows[0] === undefined ||
              !isRecommendationPoolV2ProjectGeneratable(generation.rows[0])
            ) {
              throw new Error("RECOMMENDATION_POOL_V2_PROJECT_NOT_GENERATABLE");
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
              refillCycle: Object.freeze({
                tier: "exact_product_target_market" as const,
                round: input.nativeV2.round,
                window: 1,
              }),
              providerBudgetAuthorization,
              recommendationQueueMs,
              inputPinId: String(generation.rows[0].inputPinId),
            });
        },
      );
      const {
        refillCycle,
        providerBudgetAuthorization,
        recommendationQueueMs,
      } = execution;
      const operationBudget = resolveLocalProductDataForSeoOperationBudget({
        configuration,
        authorization: providerBudgetAuthorization,
      });

      const providerClient = await options.pool.connect();
      let tenantReady = false;
      let recommendationDiscoveryMs = 0;
      const recommendationQualificationMs = 0;
      const persistExecutionStageTimings = async () => {
        if (!tenantReady) return;
        await providerClient.query(
          `UPDATE backlink_jobs
              SET result_summary=COALESCE(result_summary,'{}'::jsonb)
                    || $5::jsonb,
                  updated_at=now(),version=version+1
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3 AND id=$4`,
          [
            scope.organizationId,
            scope.workspaceId,
            scope.websiteProjectId,
            input.jobId,
            JSON.stringify({
              recommendationQueueMs,
              recommendationDiscoveryMs,
              recommendationQualificationMs,
            }),
          ],
        );
      };
      try {
        await setSessionTenant(providerClient, scope);
        tenantReady = true;
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
                  contract.pool_contract_version AS "poolContractVersion",
                  contract.migration_state AS "poolMigrationState",
                  CASE
                    WHEN contract.migration_state='V2_READY'
                      AND contract.generation_contract_id IS NULL
                      AND contract.recommendation_context_version_id IS NULL
                    THEN context.id
                    ELSE contract.recommendation_context_version_id
                  END
                    AS "poolRecommendationContextVersionId",
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
             LEFT JOIN backlink_recommendation_pool_project_contracts
               AS contract
               ON contract.organization_id=context.organization_id
              AND contract.workspace_id=context.workspace_id
              AND contract.website_project_id=context.website_project_id
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
        const parsedContextRow =
          parseLocalProductRecommendationContextDatabaseRow(contextRow);
        const resolvedProjectInput =
          await executeRecommendationSeedReadinessGate({
            commands: options.recommendationSeedCommands,
            poolContractVersion: parsedContextRow.poolContractVersion,
            migrationState: parsedContextRow.migrationState,
            contractRecommendationContextVersionId:
              parsedContextRow.contractRecommendationContextVersionId,
            expectedRecommendationContextVersionId:
              input.recommendationContextVersionId,
            ...(input.nativeV2 === undefined
              ? {}
              : {
                  seedPreparationMode: "confirmed_native_v2" as const,
                }),
            organizationId: scope.organizationId,
            workspaceId: scope.workspaceId,
            websiteProjectId: scope.websiteProjectId,
            actorId: input.actorId,
            jobId: input.jobId,
            workflowId: input.workflowId,
            correlationId: input.correlationId,
            projectContext: parsedContextRow.context,
            loadInputBinding: (parsedRecommendationContext) =>
              qualificationInputRepository.readGenerationInputBinding(
                {
                  organizationId: scope.organizationId,
                  workspaceId: scope.workspaceId,
                  websiteProjectId: scope.websiteProjectId,
                  inputPinId: execution.inputPinId,
                  qualificationContractVersion:
                    recommendationPoolV2AdmissionContractVersion,
                  market: parsedRecommendationContext.countryCode,
                },
              ),
            onReady: ({ context, binding }) =>
              Object.freeze({ context, binding }),
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
          providerRequestConcurrency: configuration.discoveryConcurrency ?? 2,
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

        const providerBudgetOperationPrefix = `commercial-refill-operation:${input.jobId}`;

        if (refillCycle === null) {
          throw new Error("COMMERCIAL_REFILL_CYCLE_KEY_INVALID");
        }
        const gate = createGate(providerClient, providerBudgetOperationPrefix);
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
              throw new Error("DATAFORSEO_ACCEPTED_TASK_RECOVERY_UNAVAILABLE");
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
              throw new Error("DATAFORSEO_DISPATCH_RECONCILIATION_UNAVAILABLE");
            }
            return runtime.reconcileDispatchedTask(call, reconciliation);
          },
        });
        const discoveryStartedAt = monotonicNow();
        const commercial = await (async () => {
          try {
            return await executeCommercialRecommendationDiscovery({
              client: providerClient,
              provider,
              gate,
              safeFetch,
              ...(options.browserFetch === undefined
                ? {}
                : { browserFetch: options.browserFetch }),
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
              ...(input.nativeV2 === undefined
                ? {}
                : { nativeV2: input.nativeV2.requestPort }),
            });
          } finally {
            recommendationDiscoveryMs += elapsedMilliseconds(
              discoveryStartedAt,
              monotonicNow(),
            );
          }
        })();
        await persistExecutionStageTimings();
return Object.freeze({
            candidates: Object.freeze([]),
            provider: Object.freeze(
              commercial.provider satisfies RecommendationProviderExecutionSummary,
            ),
          });
      } catch (error) {
        await persistExecutionStageTimings().catch(() => undefined);
        throw error;
      } finally {
        await clearSessionTenant(providerClient).catch(() => undefined);
        providerClient.release();
      }
    },

  });
}
