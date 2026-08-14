import type { CommercialStaticAssessment } from "./commercial-static-assessment.js";
import {
  scoreCommercialRecommendationFit,
  type CommercialFitDecision,
  type CommercialFitEvidenceState,
  type CommercialFitGateInput,
  type CommercialFitScoreInput,
} from "./commercial-score-v3.js";

export type CommercialCandidateBusinessFacts = Readonly<{
  selfOrRelatedDomain: boolean;
  existingBacklinkOrOpportunity: boolean;
  permanentlyRejectedOrSuppressed: boolean;
  unsafeOrDisallowedIndustry: boolean;
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
    tier: "target_market" | "same_language_expansion" | "forbidden_mismatch";
    reasonCode: string;
  }>;
  cooperationAngles: readonly string[];
  dataForSeo: Readonly<{
    rank: number | null;
    traffic: number | null;
    backlinks: number | null;
    referringDomains: number | null;
    spamScore: number | null;
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
  const values = [
    provider.rank === null ? null : clamp(provider.rank / 100),
    provider.backlinkCount === null
      ? null
      : clamp(Math.log10(provider.backlinkCount + 1) / 6),
    provider.referringDomainCount === null
      ? null
      : clamp(Math.log10(provider.referringDomainCount + 1) / 5),
    provider.spamScore === null ? null : clamp(1 - provider.spamScore / 100),
  ].filter((value): value is number => value !== null);
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
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
          : "forbidden_mismatch";
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
        : "FORBIDDEN_MARKET_MISMATCH";
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
            (input.provider.spamScore ?? 0) >= 70,
      evidenceRefs: Object.freeze([
        ...assessment.evidenceRefs,
        ...input.provider.evidenceRefs,
      ]),
    }),
    Object.freeze({
      id: "forbidden_market_mismatch",
      state: candidateLanguage === null ? staticState : "derived",
      matched:
        candidateLanguage === null ? null : marketTier === "forbidden_mismatch",
      evidenceRefs: assessment.evidenceRefs,
    }),
  ]);

  const audienceMatch = assessment.matchedAudiences.length > 0 ? 1 : 0;
  const cooperationSignal =
    assessment.cooperationPages.length > 0
      ? 1
      : assessment.monetizationMethods.length > 0
        ? 0.7
        : 0;
  const partnershipMatch =
    assessment.matchedPartnershipGoals.length > 0 ? 1 : 0;
  const audiencePartnership = clamp(
    audienceMatch * 0.45 + partnershipMatch * 0.25 + cooperationSignal * 0.3,
  );
  const editorialCommercial =
    assessment.editorialQuality === null ||
    assessment.outboundLinkDensity === null
      ? null
      : clamp(
          assessment.editorialQuality * 0.65 +
            cooperationSignal * 0.25 +
            (1 - assessment.outboundLinkDensity) * 0.1,
        );
  const authority = providerAuthority(input.provider);
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
      id: "audience_partnership",
      state: assessment.decision === "ready" ? "derived" : staticState,
      rawValue:
        [
          ...assessment.matchedAudiences,
          ...assessment.matchedPartnershipGoals,
        ].join(", ") || null,
      normalizedValue:
        assessment.decision === "ready" ? audiencePartnership : null,
      evidenceRefs: assessment.evidenceRefs,
      collectedAt: assessment.collectedAt,
      normalizationRuleVersion: "commercial-audience-partnership.v1",
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
      normalizationRuleVersion: "commercial-market-language-tier.v1",
    }),
    scoreInput({
      id: "site_editorial_commercial",
      state: editorialCommercial === null ? staticState : "derived",
      rawValue: assessment.siteType,
      normalizedValue: editorialCommercial,
      evidenceRefs: assessment.evidenceRefs,
      collectedAt: assessment.collectedAt,
      normalizationRuleVersion: "commercial-site-editorial-commercial.v1",
    }),
    scoreInput({
      id: "dataforseo_authority_risk",
      state: authority === null ? "unavailable" : "derived",
      rawValue: input.provider.spamScore,
      normalizedValue: authority,
      evidenceRefs: input.provider.evidenceRefs,
      collectedAt: input.provider.collectedAt,
      normalizationRuleVersion: "commercial-dataforseo-authority-risk.v2",
    }),
    scoreInput({
      id: "dataforseo_traffic_visibility",
      state: input.provider.traffic === null ? "unavailable" : "derived",
      rawValue: input.provider.traffic,
      normalizedValue:
        input.provider.traffic === null
          ? null
          : clamp(Math.log10(input.provider.traffic + 1) / 6),
      evidenceRefs: input.provider.evidenceRefs,
      collectedAt: input.provider.collectedAt,
      normalizationRuleVersion: "commercial-dataforseo-traffic.v1",
    }),
    scoreInput({
      id: "safefetch_technical_access",
      state:
        assessment.technicalAccessibility === null ? staticState : "observed",
      rawValue: assessment.failedUrls.length,
      normalizedValue: assessment.technicalAccessibility,
      evidenceRefs: assessment.evidenceRefs,
      collectedAt: assessment.collectedAt,
      normalizationRuleVersion: "commercial-safefetch-technical.v1",
    }),
  ]);
  const score = scoreCommercialRecommendationFit({ gates, components });
  const reasonCodes = [
    ...(assessment.matchedProducts.length > 0 ? ["PRODUCT_MATCH"] : []),
    ...(assessment.matchedTopics.length > 0 ? ["TOPIC_MATCH"] : []),
    ...(assessment.matchedKeywords.length > 0 ? ["KEYWORD_MATCH"] : []),
    ...(assessment.matchedTargetPages.length > 0 ? ["TARGET_PAGE_MATCH"] : []),
    marketReasonCode,
    ...(cooperationSignal > 0 ? ["COOPERATION_PATH_AVAILABLE"] : []),
    ...score.hitGates.map((gate) => `HARD_GATE_${gate.toUpperCase()}`),
  ];
  return Object.freeze({
    ...score,
    details: Object.freeze({
      matchTier:
        score.decision !== "eligible"
          ? "not_eligible"
          : (score.total ?? 0) >= 75
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
      dataForSeo: Object.freeze({
        rank: input.provider.rank,
        traffic: input.provider.traffic,
        backlinks: input.provider.backlinkCount,
        referringDomains: input.provider.referringDomainCount,
        spamScore: input.provider.spamScore,
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
