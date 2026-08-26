import { createHash } from "node:crypto";

import {
  collectCommercialQualificationBulkMetrics,
  type CommercialQualificationBulkResult,
  type CommercialQualificationBulkRuntime,
} from "./commercial-qualification-bulk.service.js";
import {
  persistCommercialQualificationFacts,
  type CommercialQualificationCandidate,
  type CommercialQualificationRankedResult,
} from "./commercial-qualification.service.js";
import { createRecommendationDomainKey } from "../../domain/recommendations/domain-key.js";
import {
  CORRECTED_QUALIFICATION_CONTRACT_VERSION,
  type RecommendationContractJson,
  type RecommendationContractPort,
  type RecommendationContractScope,
} from "../../ports/recommendation-contract.port.js";
import type { CommercialDiscoverySourceType } from "../../domain/recommendations/commercial-discovery-source.js";
import type { CommercialCandidateFitDecision } from "../../domain/recommendations/commercial-candidate-evaluation.js";
import {
  commercialFitBaselineAdmissionThreshold,
  commercialRecommendationFitModelVersion,
  commercialRecommendationFitRuleVersion,
} from "../../domain/recommendations/commercial-score-v4.js";
import type {
  GenerationInputBinding,
} from "../../ports/shared-seo-evidence.port.js";

const maximumCandidateDomains = 25;

export type CommercialQualificationProductionCandidate = Readonly<{
  candidateId: string;
  hostnameAscii: string;
  sourceTypes: readonly CommercialDiscoverySourceType[];
  provider: Readonly<{
    rank: number | null;
    traffic: number | null;
    spamScore: number | null;
    evidenceRefs: readonly string[];
  }>;
  staticAssessment: Readonly<{
    decision: "ready" | "insufficient_data" | "manual_review";
    matchedProducts: readonly string[];
    matchedTopics: readonly string[];
    matchedKeywords: readonly string[];
    matchedAudiences: readonly string[];
    matchedPartnershipGoals: readonly string[];
    technicalAccessibility: number | null;
    unrelatedIndustry: boolean | null;
    evidenceUrls: readonly string[];
    evidenceRefs: readonly string[];
    failedUrls: readonly string[];
  }>;
  commercialScore: CommercialCandidateFitDecision;
}>;

export type CommercialQualificationProductionResult = Readonly<{
  mode: "authoritative";
  state: CommercialQualificationBulkResult["state"] | "candidate_supply_required";
  generationContractId: string;
  inputPinId: string;
  candidateCount: number;
  persistedCount: number;
  websiteProjectCount: number;
  resourceLibraryCount: number;
  callCount: number;
  costMicros: number;
  qualifications: readonly CommercialQualificationRankedResult[];
}>;

export type CommercialQualificationMetricCollectionMode =
  | "provider"
  | "existing_evidence";

type ProjectContext = Readonly<{
  snapshotVersion: number;
  profileVersionId: string;
  promotionTargetVersionId: string;
  projectSettingsVersionId: string;
  canonicalDomain: string;
  locale: string;
  countryCode: string;
  products: readonly string[];
  keywords: readonly string[];
  targetUrls: readonly string[];
  targetAudiences: readonly string[];
  partnershipGoals: readonly string[];
}>;

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
  return JSON.stringify(value);
}

function deterministicUuid(namespace: string, value: unknown): string {
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

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ]);
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertQualificationInputBinding(
  input: Readonly<{
    scope: RecommendationContractScope;
    context: ProjectContext;
    binding: GenerationInputBinding;
  }>,
): void {
  const { pins, outreachProfile: profile } = input.binding;
  if (
    pins.organizationId !== input.scope.organizationId
    || pins.websiteProjectId !== input.scope.websiteProjectId
    || pins.projectContextVersion !== input.context.snapshotVersion
    || pins.siteProfileVersionId !== input.context.profileVersionId
    || pins.outreachProfileVersionId !== input.context.profileVersionId
    || pins.promotionTargetVersionId
      !== input.context.promotionTargetVersionId
    || pins.qualificationContractVersion
      !== CORRECTED_QUALIFICATION_CONTRACT_VERSION
    || pins.market !== input.context.countryCode
    || profile.organizationId !== input.scope.organizationId
    || profile.websiteProjectId !== input.scope.websiteProjectId
    || profile.profileVersionId !== input.context.profileVersionId
    || profile.promotionTargetVersionId
      !== input.context.promotionTargetVersionId
    || profile.market !== input.context.countryCode
    || profile.location !== input.context.countryCode
    || profile.language !== input.context.locale
    || !sameStrings(profile.productsAndServices, input.context.products)
    || !sameStrings(profile.keywordsAndTopics, input.context.keywords)
    || !sameStrings(profile.targetUrls, input.context.targetUrls)
    || !sameStrings(profile.targetAudiences, input.context.targetAudiences)
    || !sameStrings(profile.partnershipGoals, input.context.partnershipGoals)
  ) {
    throw new Error(
      "WEBSITE_PROJECT_DISCOVERY_INPUT_REQUIRED owner=WEBSITE_PROJECT recovery=reproject_current_website_project reason=qualification_input_binding_mismatch",
    );
  }
}

function normalizeCandidates(
  candidates: readonly CommercialQualificationProductionCandidate[],
): readonly CommercialQualificationProductionCandidate[] {
  const unique = new Map<
    string,
    CommercialQualificationProductionCandidate
  >();
  for (const candidate of candidates) {
    const canonicalDomain = createRecommendationDomainKey(
      candidate.hostnameAscii,
    ).registrableDomain;
    if (!unique.has(canonicalDomain)) {
      unique.set(canonicalDomain, Object.freeze({
        ...candidate,
        hostnameAscii: canonicalDomain,
      }));
    }
  }
  if (unique.size > maximumCandidateDomains) {
    throw new TypeError(
      `Commercial qualification supports at most ${
        maximumCandidateDomains
      } candidate domains.`,
    );
  }
  return Object.freeze(
    [...unique.values()].sort((left, right) =>
      left.hostnameAscii.localeCompare(right.hostnameAscii, "en")),
  );
}

function assertAlreadyPublishableCandidates(
  candidates: readonly CommercialQualificationProductionCandidate[],
): void {
  if (candidates.some((candidate) =>
    candidate.commercialScore.decision !== "eligible"
    || candidate.commercialScore.hitGates.length > 0
    || candidate.commercialScore.total === null
    || candidate.commercialScore.total
      < commercialFitBaselineAdmissionThreshold
  )) {
    throw new Error(
      "Existing-evidence qualification requires an already publishable candidate.",
    );
  }
}

function existingEvidenceMetrics(
  candidates: readonly CommercialQualificationProductionCandidate[],
): CommercialQualificationBulkResult {
  const records = candidates.map((candidate) => Object.freeze({
    canonicalDomain: candidate.hostnameAscii,
    trafficOrganicEtv: candidate.provider.traffic,
    spamScore: candidate.provider.spamScore,
    authorityRank: candidate.provider.rank,
    trafficState: candidate.provider.traffic === null
      ? "missing" as const
      : "completed" as const,
    spamState: candidate.provider.spamScore === null
      ? "missing" as const
      : "completed" as const,
    rankState: candidate.provider.rank === null
      ? "missing" as const
      : "completed" as const,
    requestFingerprints: Object.freeze({
      traffic: "",
      spam: "",
      rank: "",
    }),
  }));
  return Object.freeze({
    state: records.every((record) =>
        record.trafficState === "completed"
        && record.spamState === "completed"
        && record.rankState === "completed"
      )
      ? "completed"
      : "partial",
    metricScope: "TARGET_MARKET",
    records: Object.freeze(records),
    callCount: 0,
    costMicros: 0,
  });
}

function normalizeSemanticTerm(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function semanticRelevance(
  matchedValues: readonly string[],
  authoritativeValues: readonly string[],
): number | null {
  const authoritative = new Set(
    authoritativeValues.map(normalizeSemanticTerm).filter(Boolean),
  );
  if (authoritative.size === 0) return null;
  const matched = new Set(
    matchedValues.map(normalizeSemanticTerm).filter(Boolean),
  );
  const matchedCount = [...authoritative].filter((value) =>
    matched.has(value)
  ).length;
  return Number(((matchedCount / authoritative.size) * 100).toFixed(4));
}

function qualificationCandidate(
  candidate: CommercialQualificationProductionCandidate,
  context: ProjectContext,
  topics: readonly string[],
): CommercialQualificationCandidate {
  const assessment = candidate.staticAssessment;
  const accessibilityDecision = assessment.technicalAccessibility === null
    ? "insufficient_data"
    : assessment.technicalAccessibility > 0
      ? "accessible"
      : "inaccessible";
  return Object.freeze({
    candidateId: candidate.candidateId,
    canonicalDomain: candidate.hostnameAscii,
    attempt: 1,
    commercialScore: candidate.commercialScore,
    accessibility: Object.freeze({
      decision: accessibilityDecision,
      attempt: 1,
      evidence: Object.freeze({
        source: "commercial-static-assessment.v3",
        technicalAccessibility: assessment.technicalAccessibility,
        evidenceUrls: [...assessment.evidenceUrls],
        failedUrls: [...assessment.failedUrls],
      }),
    }),
    semantic: Object.freeze({
      productRelevance: semanticRelevance(
        assessment.matchedProducts,
        context.products,
      ),
      topicRelevance: semanticRelevance(
        assessment.matchedTopics,
        topics,
      ),
      keywordRelevance: semanticRelevance(
        assessment.matchedKeywords,
        context.keywords,
      ),
      unrelated: assessment.unrelatedIndustry,
      attempt: 1,
      state:
        assessment.decision === "ready"
          && assessment.unrelatedIndustry !== null
          && context.products.length > 0
          && topics.length > 0
          && context.keywords.length > 0
          ? "observed"
          : assessment.decision === "manual_review"
            ? "malformed"
            : "unavailable",
      modelVersion: null,
      promptVersion: null,
      evidence: Object.freeze({
        source: "commercial-static-assessment.v3",
        derivation: "authoritative-input-match-ratios.v1",
        assessmentDecision: assessment.decision,
        matchedProducts: [...assessment.matchedProducts],
        matchedTopics: [...assessment.matchedTopics],
        matchedKeywords: [...assessment.matchedKeywords],
        matchedAudiences: [...assessment.matchedAudiences],
        matchedPartnershipGoals: [...assessment.matchedPartnershipGoals],
      }),
    }),
    evidenceRefs: Object.freeze(uniqueStrings([
      ...candidate.provider.evidenceRefs,
      ...assessment.evidenceRefs,
    ])),
  });
}

function requestFingerprints(
  metrics: CommercialQualificationBulkResult,
): RecommendationContractJson {
  const kinds = ["traffic", "spam", "rank"] as const;
  return Object.freeze(Object.fromEntries(kinds.map((kind) => [
    kind,
    uniqueStrings(
      metrics.records.map((record) => record.requestFingerprints[kind]),
    ),
  ])));
}

function operationFor(
  state: CommercialQualificationProductionResult["state"],
): Readonly<{
  state: "succeeded" | "failed" | "frozen";
  reasonCode: string;
}> {
  if (state === "candidate_supply_required") {
    return Object.freeze({
      state: "frozen",
      reasonCode: "CANDIDATE_SUPPLY_REQUIRED",
    });
  }
  if (state === "unknown_charge") {
    return Object.freeze({
      state: "frozen",
      reasonCode: "DATAFORSEO_QUALIFICATION_UNKNOWN_CHARGE",
    });
  }
  if (state === "unavailable") {
    return Object.freeze({
      state: "failed",
      reasonCode: "DATAFORSEO_QUALIFICATION_UNAVAILABLE",
    });
  }
  return Object.freeze({
    state: "succeeded",
    reasonCode: state === "completed"
      ? "QUALIFICATION_COMPLETED"
      : "QUALIFICATION_PARTIAL",
  });
}

export async function executeCommercialQualificationProduction(
  input: Readonly<{
    scope: RecommendationContractScope;
    context: ProjectContext;
    topics: readonly string[];
    candidates: readonly CommercialQualificationProductionCandidate[];
    visiblePoolGeneration: number;
    locationCode: number;
    languageCode: string;
    endpointAllowlist: readonly string[];
    metricRuntime: CommercialQualificationBulkRuntime;
    inputBinding: GenerationInputBinding;
    recommendationRepository: Pick<
      RecommendationContractPort,
      | "assertCorrectedGenerationAvailable"
      | "createCorrectedGeneration"
      | "writeQualificationFact"
    >;
    createdBy: string;
    observedAt?: Date;
    metricCollectionMode?: CommercialQualificationMetricCollectionMode;
  }>,
): Promise<CommercialQualificationProductionResult> {
  if (
    !Number.isSafeInteger(input.visiblePoolGeneration)
    || input.visiblePoolGeneration < 1
  ) {
    throw new TypeError("Visible pool generation must be positive.");
  }
  if (!Number.isSafeInteger(input.locationCode) || input.locationCode < 1) {
    throw new TypeError("Qualification location code must be positive.");
  }
  const languageCode = input.languageCode.trim();
  if (languageCode.length === 0) {
    throw new TypeError("Qualification language code is required.");
  }
  const observedAt = input.observedAt ?? new Date();
  const candidates = normalizeCandidates(input.candidates);
  const metricCollectionMode = input.metricCollectionMode ?? "provider";
  if (metricCollectionMode === "existing_evidence") {
    assertAlreadyPublishableCandidates(candidates);
  }
  assertQualificationInputBinding({
    scope: input.scope,
    context: input.context,
    binding: input.inputBinding,
  });
  const inputPinId = input.inputBinding.inputPinId;

  const generationIdentity = {
    ...input.scope,
    visiblePoolGeneration: input.visiblePoolGeneration,
  };
  const generationContractId = deterministicUuid(
    "commercial-qualification-generation",
    generationIdentity,
  );
  await input.recommendationRepository.assertCorrectedGenerationAvailable({
    ...input.scope,
    generationContractId,
    visiblePoolGeneration: input.visiblePoolGeneration,
    workerContractVersion: CORRECTED_QUALIFICATION_CONTRACT_VERSION,
  });

  const metrics: CommercialQualificationBulkResult | null =
    candidates.length === 0
      ? null
      : metricCollectionMode === "existing_evidence"
        ? existingEvidenceMetrics(candidates)
        : await collectCommercialQualificationBulkMetrics({
            domains: candidates.map(({ hostnameAscii }) => hostnameAscii),
            metricScope: "TARGET_MARKET",
            locationCode: input.locationCode,
            languageCode,
            endpointAllowlist: input.endpointAllowlist,
            chunkSize: 1_000,
            concurrency: 1,
            runtime: input.metricRuntime,
          });
  const state: CommercialQualificationProductionResult["state"] =
    metrics?.state ?? "candidate_supply_required";
  const operation = operationFor(state);
  const operationId = metricCollectionMode === "existing_evidence"
    ? `commercial-qualification-v4-existing-evidence:${
      input.visiblePoolGeneration
    }`
    : `commercial-qualification-v4:${input.visiblePoolGeneration}`;
  const operationEvidence = Object.freeze({
    mode: "authoritative",
    candidateCount: candidates.length,
    metricCollectionState: state,
    freshMetricsRole: metricCollectionMode === "existing_evidence"
      ? "evidence_only"
      : "qualification_authority",
    metricCollectionMode,
    scoreModelVersion: commercialRecommendationFitModelVersion,
    ruleVersion: commercialRecommendationFitRuleVersion,
    callCount: metrics?.callCount ?? 0,
    costMicros: metrics?.costMicros ?? 0,
  });
  await input.recommendationRepository.createCorrectedGeneration({
    ...input.scope,
    generationContractId,
    inputPinId,
    visiblePoolGeneration: input.visiblePoolGeneration,
    metricScope: "TARGET_MARKET",
    market: input.context.countryCode,
    location: input.context.countryCode,
    language: input.context.locale,
    trafficLocationCode: input.locationCode,
    trafficLanguageCode: languageCode,
    requestFingerprints:
      metrics === null || metricCollectionMode === "existing_evidence"
      ? Object.freeze({})
      : requestFingerprints(metrics),
    workerContractVersion: CORRECTED_QUALIFICATION_CONTRACT_VERSION,
    operation: {
      factId: deterministicUuid("commercial-qualification-operation-fact", {
        ...generationIdentity,
        operationId,
        operationState: operation.state,
        reasonCode: operation.reasonCode,
        evidence: operationEvidence,
      }),
      operationId,
      state: operation.state,
      attempt: 1,
      reasonCode: operation.reasonCode,
      evidence: operationEvidence,
      observedAt,
    },
    createdBy: input.createdBy,
  });

  let persistedCount = 0;
  let websiteProjectCount = 0;
  let resourceLibraryCount = 0;
  const qualifications: CommercialQualificationRankedResult[] = [];
  if (metrics !== null) {
    const grouped = [
      {
        sourceKind: "WEBSITE_PROJECT" as const,
        candidates: candidates.filter((candidate) =>
          !candidate.sourceTypes.includes("CURATED_RESOURCE_LIBRARY")),
      },
      {
        sourceKind: "RESOURCE_LIBRARY" as const,
        candidates: candidates.filter((candidate) =>
          candidate.sourceTypes.includes("CURATED_RESOURCE_LIBRARY")),
      },
    ];
    for (const group of grouped) {
      if (group.candidates.length === 0) continue;
      const result = await persistCommercialQualificationFacts({
        scope: input.scope,
        generationContractId,
        sourceKind: group.sourceKind,
        candidates: group.candidates.map((candidate) =>
          qualificationCandidate(candidate, input.context, input.topics)
        ),
        metrics,
        repository: input.recommendationRepository,
        createdBy: input.createdBy,
        observedAt,
        freshMetricsRole: metricCollectionMode === "existing_evidence"
          ? "evidence_only"
          : "qualification_authority",
        newId: (identity) =>
          deterministicUuid(
            "commercial-qualification-fact-v2",
            {
              ...generationIdentity,
              ...identity,
            },
          ),
      });
      persistedCount += result.persistedCount;
      qualifications.push(...result.ranked);
      if (group.sourceKind === "WEBSITE_PROJECT") {
        websiteProjectCount = result.persistedCount;
      } else {
        resourceLibraryCount = result.persistedCount;
      }
    }
  }

  return Object.freeze({
    mode: "authoritative",
    state,
    generationContractId,
    inputPinId,
    candidateCount: candidates.length,
    persistedCount,
    websiteProjectCount,
    resourceLibraryCount,
    callCount: metrics?.callCount ?? 0,
    costMicros: metrics?.costMicros ?? 0,
    qualifications: Object.freeze(
      qualifications.sort((left, right) =>
        left.canonicalDomain.localeCompare(right.canonicalDomain, "en")
      ),
    ),
  });
}
