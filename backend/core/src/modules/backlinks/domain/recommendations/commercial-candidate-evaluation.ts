import type { CommercialStaticAssessment } from "./commercial-static-assessment.js";
import type { CommercialBacklinkPageEvidence } from "./commercial-discovery-source.js";
import {
  applyCommercialFitAdmissionThreshold,
  commercialFitBaselineAdmissionThreshold,
  commercialFitProgressiveAdmissionPolicyVersion,
  commercialFitSpamHardRejectMinimum,
  commercialFitSpamReviewMinimum,
  resolveProgressiveCommercialFitAdmissionThreshold,
  scoreCommercialRecommendationFit,
  type CommercialFitAdmission,
  type CommercialFitDecision,
  type CommercialFitEvidenceState,
  type CommercialFitGateInput,
  type CommercialFitScoreInput,
} from "./commercial-score-v4.js";

export type CommercialCandidateBusinessFacts = Readonly<{
  selfOrRelatedDomain: boolean;
  existingBacklinkOrOpportunity: boolean;
  permanentlyRejectedOrSuppressed: boolean;
  unsafeOrDisallowedIndustry: boolean;
  projectAuthorityScore?: number | null;
  targetCountryCode: string;
  candidateCountryCode: string | null;
  targetLanguages: readonly string[];
  allowSameLanguageExpansion: boolean;
  targetMarketScopedDiscovery: boolean;
}>;

export type CommercialCandidateProviderFacts = Readonly<{
  rank: number | null;
  traffic: number | null;
  backlinkCount: number | null;
  referringDomainCount: number | null;
  spamScore: number | null;
  backlinkPageEvidence?: readonly CommercialBacklinkPageEvidence[];
  evidenceRefs: readonly string[];
  collectedAt: string;
}>;

export type CommercialFitDetails = Readonly<{
  matchTier: "high_fit" | "qualified_fit" | "not_eligible";
  reasonCodes: readonly string[];
  matchedProducts: readonly string[];
  matchedTopics: readonly string[];
  matchedKeywords: readonly string[];
  matchedTargetPages: readonly string[];
  matchedAudiences: readonly string[];
  market: Readonly<{
    targetCountry: string;
    candidateCountry: string | null;
    targetLanguage: string;
    candidateLanguage: string | null;
    tier:
      | "target_market"
      | "same_language_expansion"
      | "market_language_mismatch";
    reasonCode: string;
  }>;
  cooperationAngles: readonly string[];
  authority: Readonly<{
    projectAuthority: number;
    candidateAuthority: number | null;
    confidence: "observed" | "neutral_default";
    tier:
      | "candidate_below_range"
      | "normal_relative_range"
      | "elevated_authority_gap"
      | "extreme_authority_gap";
  }>;
  dataForSeo: Readonly<{
    rank: number | null;
    traffic: number | null;
    backlinks: number | null;
    referringDomains: number | null;
    spamScore: number | null;
    backlinkPageEvidence: readonly CommercialBacklinkPageEvidence[];
    evidenceRefs: readonly string[];
    collectedAt: string;
  }>;
  safeFetch: Readonly<{
    relatedContentPages: readonly string[];
    evidenceUrls: readonly string[];
    evidenceRefs: readonly string[];
    failedUrls: readonly string[];
    technicalAccessibility: number | null;
  }>;
}>;

export type CommercialCandidateFitDecision = CommercialFitDecision &
  Readonly<{
    details: CommercialFitDetails;
  }>;

export type ProgressiveCommercialCandidateAdmission = Readonly<{
  scores: readonly CommercialCandidateFitDecision[];
  admission: CommercialFitAdmission;
}>;

export type ProgressiveCommercialCandidateAdmissionOptions = Readonly<{
  visiblePoolGeneration?: number;
}>;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function languageCode(value: string): string {
  return value.trim().toLowerCase().split(/[-_]/u)[0] ?? "";
}

function evidenceState(
  assessment: CommercialStaticAssessment,
): CommercialFitEvidenceState {
  return assessment.decision === "ready" ? "observed" : assessment.decision;
}

function scoreInput(
  input: Readonly<{
    id: CommercialFitScoreInput["id"];
    state: CommercialFitEvidenceState;
    rawValue: CommercialFitScoreInput["rawValue"];
    normalizedValue: number | null;
    evidenceRefs: readonly string[];
    collectedAt: string;
    normalizationRuleVersion: string;
  }>,
): CommercialFitScoreInput {
  return Object.freeze({
    ...input,
    evidenceRefs: Object.freeze([...input.evidenceRefs]),
  });
}

function providerAuthority(
  provider: CommercialCandidateProviderFacts,
): number | null {
  if (provider.rank !== null) return Math.max(0, Math.min(100, provider.rank));
  const values = [
    provider.backlinkCount === null
      ? null
      : clamp(Math.log10(provider.backlinkCount + 1) / 6) * 100,
    provider.referringDomainCount === null
      ? null
      : clamp(Math.log10(provider.referringDomainCount + 1) / 5) * 100,
    provider.spamScore === null
      ? null
      : clamp(1 - provider.spamScore / 100) * 100,
  ].filter((value): value is number => value !== null);
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

const megaPlatformSiteTypes = new Set([
  "global_platform",
  "infrastructure_platform",
  "marketplace",
  "social_network",
  "search_engine",
  "code_hosting",
  "cloud_platform",
  "encyclopedia",
]);

const minimumProjectRelevantPlacementRelevance = 0.35;

function normalizedPageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function healthyActiveBacklinkEvidence(
  provider: CommercialCandidateProviderFacts,
): readonly CommercialBacklinkPageEvidence[] {
  return Object.freeze((provider.backlinkPageEvidence ?? []).filter(
    (evidence) =>
      evidence.linkStatus === "active" &&
      (evidence.sourceHttpStatus === null ||
        evidence.sourceHttpStatus < 400) &&
      (evidence.targetHttpStatus === null ||
        evidence.targetHttpStatus < 400),
  ));
}

function projectRelevantPageUrls(
  assessment: CommercialStaticAssessment,
): ReadonlySet<string> {
  return new Set(assessment.relatedContentPages.flatMap((value) => {
    const normalized = normalizedPageUrl(value);
    return normalized === null ? [] : [normalized];
  }));
}

function currentProjectRelevantPlacementEvidence(
  assessment: CommercialStaticAssessment,
  provider: CommercialCandidateProviderFacts,
): Readonly<{
  cooperationPage: string | null;
  backlinkPage: CommercialBacklinkPageEvidence | null;
}> {
  if (
    (assessment.productRelevance ?? 0) <
      minimumProjectRelevantPlacementRelevance
  ) {
    return Object.freeze({ cooperationPage: null, backlinkPage: null });
  }
  const relevantPages = projectRelevantPageUrls(assessment);
  const cooperationPage = assessment.cooperationPages.find((value) => {
    const normalized = normalizedPageUrl(value);
    return normalized !== null && relevantPages.has(normalized);
  }) ?? null;
  const backlinkPage = healthyActiveBacklinkEvidence(provider).find(
    (evidence) => {
      const normalized = normalizedPageUrl(evidence.sourceUrl);
      return normalized !== null && relevantPages.has(normalized);
    },
  ) ?? null;
  return Object.freeze({ cooperationPage, backlinkPage });
}

export function applyCommercialCandidateAdmissionThreshold(
  score: CommercialCandidateFitDecision,
  threshold: number,
): CommercialCandidateFitDecision {
  const adjusted = applyCommercialFitAdmissionThreshold(score, threshold);
  const reasonCodes = [...score.details.reasonCodes];
  if (adjusted.admission.fallbackApplied && adjusted.decision === "eligible") {
    reasonCodes.push(
      "PROGRESSIVE_SCORE_THRESHOLD",
      `ADMISSION_THRESHOLD_${adjusted.admission.appliedThreshold}`,
    );
  }
  return Object.freeze({
    ...adjusted,
    details: Object.freeze({
      ...score.details,
      matchTier:
        adjusted.decision !== "eligible"
          ? "not_eligible"
          : score.details.matchTier === "high_fit"
            ? "high_fit"
            : "qualified_fit",
      reasonCodes: Object.freeze([...new Set(reasonCodes)]),
    }),
  });
}

export function applyProgressiveCommercialCandidateAdmission(
  scores: readonly CommercialCandidateFitDecision[],
  options: ProgressiveCommercialCandidateAdmissionOptions = {},
): ProgressiveCommercialCandidateAdmission {
  const appliedThreshold =
    resolveProgressiveCommercialFitAdmissionThreshold(scores, options);
  return Object.freeze({
    scores: Object.freeze(
      scores.map((score) => {
        const hasExplicitSemanticMatch = [
          score.details.matchedProducts,
          score.details.matchedTopics,
          score.details.matchedKeywords,
          score.details.matchedTargetPages,
        ].some((values) => values.length > 0);
        const candidateThreshold =
          appliedThreshold < commercialFitBaselineAdmissionThreshold &&
            score.hitGates.length === 0 &&
            score.details.market.tier === "target_market" &&
            hasExplicitSemanticMatch &&
            score.total !== null &&
            score.total < commercialFitBaselineAdmissionThreshold
            ? appliedThreshold
            : commercialFitBaselineAdmissionThreshold;
        return applyCommercialCandidateAdmissionThreshold(
          score,
          candidateThreshold,
        );
      }),
    ),
    admission: Object.freeze({
      policyVersion: commercialFitProgressiveAdmissionPolicyVersion,
      baselineThreshold: commercialFitBaselineAdmissionThreshold,
      appliedThreshold,
      fallbackApplied:
        appliedThreshold < commercialFitBaselineAdmissionThreshold,
    }),
  });
}

export function evaluateCommercialCandidate(
  input: Readonly<{
    business: CommercialCandidateBusinessFacts;
    provider: CommercialCandidateProviderFacts;
    staticAssessment: CommercialStaticAssessment;
  }>,
): CommercialCandidateFitDecision {
  const assessment = input.staticAssessment;
  const staticState = evidenceState(assessment);
  const targetLanguages = [
    ...new Set(
      input.business.targetLanguages.map(languageCode).filter(Boolean),
    ),
  ];
  const candidateLanguage =
    assessment.language === null ? null : languageCode(assessment.language);
  const sameLanguage =
    candidateLanguage !== null && targetLanguages.includes(candidateLanguage);
  const sameCountry =
    input.business.candidateCountryCode !== null &&
    input.business.candidateCountryCode.toUpperCase() ===
      input.business.targetCountryCode.toUpperCase();
  const targetMarketScopedUnknownCountry =
    sameLanguage &&
    input.business.candidateCountryCode === null &&
    input.business.targetMarketScopedDiscovery;
  const marketTier =
    sameLanguage && sameCountry
      ? "target_market"
      : targetMarketScopedUnknownCountry
        ? "target_market"
        : sameLanguage && input.business.allowSameLanguageExpansion
          ? "same_language_expansion"
          : "market_language_mismatch";
  const marketScore =
    sameLanguage && sameCountry
      ? 1
      : targetMarketScopedUnknownCountry
        ? 0.75
        : marketTier === "same_language_expansion"
          ? 0.75
          : 0;
  const marketReasonCode = targetMarketScopedUnknownCountry
    ? "TARGET_MARKET_SCOPED_CANDIDATE"
    : marketTier === "target_market"
      ? "TARGET_MARKET_MATCH"
      : marketTier === "same_language_expansion"
        ? "SAME_LANGUAGE_EXPANSION"
        : "MARKET_LANGUAGE_MISMATCH_DEPRIORITIZED";
  const projectAuthority =
    input.business.projectAuthorityScore === null ||
      input.business.projectAuthorityScore === undefined
      ? 50
      : Math.max(0, Math.min(100, input.business.projectAuthorityScore));
  const authorityConfidence =
    input.business.projectAuthorityScore === null ||
      input.business.projectAuthorityScore === undefined
      ? "neutral_default"
      : "observed";
  const candidateAuthority = providerAuthority(input.provider);
  const authorityGap =
    candidateAuthority === null ? null : candidateAuthority - projectAuthority;
  const authorityTier =
    authorityGap === null || (authorityGap >= -15 && authorityGap <= 40)
      ? "normal_relative_range"
      : authorityGap < -15
        ? "candidate_below_range"
        : authorityGap <= 55
          ? "elevated_authority_gap"
          : "extreme_authority_gap";
  const placementEvidence = currentProjectRelevantPlacementEvidence(
    assessment,
    input.provider,
  );
  const hasProjectRelevantPlacementEvidence =
    placementEvidence.cooperationPage !== null ||
    placementEvidence.backlinkPage !== null;
  const hasGenericPlacementSignal =
    assessment.cooperationPages.length > 0 ||
    healthyActiveBacklinkEvidence(input.provider).length > 0;
  const megaPlatform =
    assessment.siteType !== null &&
    megaPlatformSiteTypes.has(assessment.siteType);
  const commonGate = (
    id: CommercialFitGateInput["id"],
    matched: boolean,
    ref: string,
  ): CommercialFitGateInput =>
    Object.freeze({
      id,
      state: "derived",
      matched,
      evidenceRefs: Object.freeze([ref]),
    });
  const gates: readonly CommercialFitGateInput[] = Object.freeze([
    commonGate(
      "self_or_related_domain",
      input.business.selfOrRelatedDomain,
      "postgresql:self-or-related-domain",
    ),
    commonGate(
      "existing_backlink_or_opportunity",
      input.business.existingBacklinkOrOpportunity,
      "postgresql:backlink-opportunity-dedup",
    ),
    commonGate(
      "permanently_rejected_or_suppressed",
      input.business.permanentlyRejectedOrSuppressed,
      "postgresql:rejection-suppression",
    ),
    Object.freeze({
      id: "zero_topic_relevance",
      state: assessment.productRelevance === null ? staticState : "derived",
      matched:
        assessment.productRelevance === null
          ? null
          : assessment.productRelevance === 0,
      evidenceRefs: assessment.evidenceRefs,
    }),
    Object.freeze({
      id: "unrelated_industry",
      state: assessment.unrelatedIndustry === null ? staticState : "derived",
      matched: assessment.unrelatedIndustry,
      evidenceRefs: assessment.evidenceRefs,
    }),
    Object.freeze({
      id: "unsafe_or_disallowed",
      state: assessment.unsafeOrMalicious === null ? staticState : "observed",
      matched:
        assessment.unsafeOrMalicious === null
          ? null
          : input.business.unsafeOrDisallowedIndustry ||
            assessment.unsafeOrMalicious,
      evidenceRefs: assessment.evidenceRefs,
    }),
    Object.freeze({
      id: "pbn_or_link_farm",
      state:
        assessment.highConfidenceLinkFarm === null &&
        input.provider.spamScore === null
          ? staticState
          : "derived",
      matched:
        assessment.highConfidenceLinkFarm === null &&
        input.provider.spamScore === null
          ? null
          : assessment.highConfidenceLinkFarm === true ||
            (input.provider.spamScore ?? 0) >=
              commercialFitSpamHardRejectMinimum,
      evidenceRefs: Object.freeze([
        ...assessment.evidenceRefs,
        ...input.provider.evidenceRefs,
      ]),
    }),
    Object.freeze({
      id: "confirmed_inaccessible",
      state:
        assessment.technicalAccessibility === null ? staticState : "observed",
      matched:
        assessment.technicalAccessibility === null
          ? null
          : assessment.technicalAccessibility === 0,
      evidenceRefs: assessment.evidenceRefs,
    }),
    Object.freeze({
      id: "mega_platform_without_placement_evidence",
      state: assessment.siteType === null ? staticState : "derived",
      matched:
        assessment.siteType === null
          ? null
          : megaPlatform &&
            authorityTier === "extreme_authority_gap" &&
            !hasProjectRelevantPlacementEvidence,
      evidenceRefs: Object.freeze([
        ...assessment.evidenceRefs,
        ...input.provider.evidenceRefs,
      ]),
    }),
  ]);

  const placementAttainability = placementEvidence.cooperationPage !== null
    ? 1
    : placementEvidence.backlinkPage !== null
      ? 0.85
      : hasGenericPlacementSignal
        ? 0.3 + clamp(assessment.productRelevance ?? 0) * 0.15
        : assessment.monetizationMethods.length > 0 ||
            assessment.matchedPartnershipGoals.length > 0
          ? 0.15 + clamp(assessment.productRelevance ?? 0) * 0.15
        : assessment.editorialQuality === null
          ? null
          : clamp(assessment.editorialQuality * 0.45);
  const relativeAuthority = candidateAuthority === null
    ? 0.5
    : authorityTier === "normal_relative_range"
      ? 1
      : authorityTier === "candidate_below_range"
        ? 0.6
       : authorityTier === "elevated_authority_gap"
          ? hasProjectRelevantPlacementEvidence
            ? 0.75
            : 0.35
          : hasProjectRelevantPlacementEvidence
            ? 0.6
            : 0;
  const trafficSignal =
    input.provider.traffic === null
      ? null
      : clamp(Math.log10(input.provider.traffic + 1) / 6);
  const spamSignal =
    input.provider.spamScore === null
      ? null
      : input.provider.spamScore >= commercialFitSpamReviewMinimum
        ? clamp(
            (
              commercialFitSpamHardRejectMinimum -
              input.provider.spamScore
            ) / 80,
          )
        : clamp(1 - input.provider.spamScore / 100);
  const basicQualitySignals = [
    trafficSignal,
    spamSignal,
    assessment.technicalAccessibility,
  ].filter((value): value is number => value !== null);
  const trafficBasicQuality =
    basicQualitySignals.length === 0
      ? null
      : basicQualitySignals.reduce((sum, value) => sum + value, 0) /
        basicQualitySignals.length;
  const evidenceSignals = [
    assessment.productRelevance,
    placementAttainability,
    candidateAuthority,
    candidateLanguage,
    input.provider.traffic,
    input.provider.spamScore,
    assessment.technicalAccessibility,
  ];
  const evidenceCompleteness =
    evidenceSignals.filter((value) => value !== null).length /
    evidenceSignals.length;
  const components: readonly CommercialFitScoreInput[] = Object.freeze([
    scoreInput({
      id: "semantic_relevance",
      state: assessment.productRelevance === null ? staticState : "derived",
      rawValue: assessment.topics.join(", ") || null,
      normalizedValue: assessment.productRelevance,
      evidenceRefs: assessment.evidenceRefs,
      collectedAt: assessment.collectedAt,
      normalizationRuleVersion: "commercial-semantic-relevance.v2",
    }),
    scoreInput({
      id: "placement_attainability",
      state: placementAttainability === null ? staticState : "derived",
      rawValue:
        placementEvidence.cooperationPage ??
        placementEvidence.backlinkPage?.sourceUrl ??
        assessment.cooperationPages[0] ??
        healthyActiveBacklinkEvidence(input.provider)[0]?.sourceUrl ??
        assessment.monetizationMethods[0] ??
        null,
      normalizedValue: placementAttainability,
      evidenceRefs: assessment.evidenceRefs,
      collectedAt: assessment.collectedAt,
      normalizationRuleVersion: "commercial-placement-attainability.v6",
    }),
    scoreInput({
      id: "relative_authority",
      state: candidateAuthority === null ? "derived" : "observed",
      rawValue: candidateAuthority,
      normalizedValue: relativeAuthority,
      evidenceRefs: input.provider.evidenceRefs,
      collectedAt: input.provider.collectedAt,
      normalizationRuleVersion: "commercial-relative-authority.v4",
    }),
    scoreInput({
      id: "market_language_tier",
      state: candidateLanguage === null ? staticState : "derived",
      rawValue:
        `${input.business.candidateCountryCode ?? "unknown"}:` +
        `${candidateLanguage ?? "unknown"}`,
      normalizedValue: candidateLanguage === null ? null : marketScore,
      evidenceRefs: assessment.evidenceRefs,
      collectedAt: assessment.collectedAt,
      normalizationRuleVersion: "commercial-market-language-tier.v2",
    }),
    scoreInput({
      id: "traffic_basic_quality",
      state: trafficBasicQuality === null ? "unavailable" : "derived",
      rawValue: input.provider.traffic,
      normalizedValue: trafficBasicQuality,
      evidenceRefs: Object.freeze([
        ...input.provider.evidenceRefs,
        ...assessment.evidenceRefs,
      ]),
      collectedAt: input.provider.collectedAt,
      normalizationRuleVersion: "commercial-traffic-basic-quality.v4",
    }),
    scoreInput({
      id: "evidence_completeness",
      state: "derived",
      rawValue: evidenceSignals.filter((value) => value !== null).length,
      normalizedValue: evidenceCompleteness,
      evidenceRefs: Object.freeze([
        ...assessment.evidenceRefs,
        ...input.provider.evidenceRefs,
      ]),
      collectedAt: assessment.collectedAt,
      normalizationRuleVersion: "commercial-evidence-completeness.v4",
    }),
  ]);
  const score = scoreCommercialRecommendationFit({ gates, components });
  const reasonCodes = [
    ...(assessment.matchedProducts.length > 0 ? ["PRODUCT_MATCH"] : []),
    ...(assessment.matchedTopics.length > 0 ? ["TOPIC_MATCH"] : []),
    ...(assessment.matchedKeywords.length > 0 ? ["KEYWORD_MATCH"] : []),
    ...(assessment.matchedTargetPages.length > 0 ? ["TARGET_PAGE_MATCH"] : []),
    marketReasonCode,
    ...(hasProjectRelevantPlacementEvidence
      ? ["COOPERATION_PATH_AVAILABLE"]
      : hasGenericPlacementSignal
        ? ["COOPERATION_PATH_REQUIRES_TOPIC_EVIDENCE"]
        : []),
    `RELATIVE_AUTHORITY_${authorityTier.toUpperCase()}`,
    ...score.hitGates.map((gate) => `HARD_GATE_${gate.toUpperCase()}`),
  ];
  return Object.freeze({
    ...score,
    details: Object.freeze({
      matchTier:
        score.decision !== "eligible"
          ? "not_eligible"
          : assessment.decision === "ready" && (score.total ?? 0) >= 75
            ? "high_fit"
            : "qualified_fit",
      reasonCodes: Object.freeze(reasonCodes),
      matchedProducts: assessment.matchedProducts,
      matchedTopics: assessment.matchedTopics,
      matchedKeywords: assessment.matchedKeywords,
      matchedTargetPages: assessment.matchedTargetPages,
      matchedAudiences: assessment.matchedAudiences,
      market: Object.freeze({
        targetCountry: input.business.targetCountryCode.toUpperCase(),
        candidateCountry:
          input.business.candidateCountryCode?.toUpperCase() ?? null,
        targetLanguage: targetLanguages[0] ?? "",
        candidateLanguage,
        tier: marketTier,
        reasonCode: marketReasonCode,
      }),
      cooperationAngles: Object.freeze([
        ...assessment.matchedPartnershipGoals,
        ...assessment.monetizationMethods,
        ...(assessment.cooperationPages.length > 0
          ? ["published_cooperation_page"]
          : []),
      ]),
      authority: Object.freeze({
        projectAuthority,
        candidateAuthority,
        confidence: authorityConfidence,
        tier: authorityTier,
      }),
      dataForSeo: Object.freeze({
        rank: input.provider.rank,
        traffic: input.provider.traffic,
        backlinks: input.provider.backlinkCount,
        referringDomains: input.provider.referringDomainCount,
        spamScore: input.provider.spamScore,
        backlinkPageEvidence: Object.freeze([
          ...(input.provider.backlinkPageEvidence ?? []),
        ]),
        evidenceRefs: Object.freeze([...input.provider.evidenceRefs]),
        collectedAt: input.provider.collectedAt,
      }),
      safeFetch: Object.freeze({
        relatedContentPages: assessment.relatedContentPages,
        evidenceUrls: assessment.evidenceUrls,
        evidenceRefs: assessment.evidenceRefs,
        failedUrls: assessment.failedUrls,
        technicalAccessibility: assessment.technicalAccessibility,
      }),
    }),
  });
}
