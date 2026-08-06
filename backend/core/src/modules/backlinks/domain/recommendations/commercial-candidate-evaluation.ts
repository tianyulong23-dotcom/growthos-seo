import type {
  CommercialStaticAssessment,
} from "./commercial-static-assessment.js";
import {
  scoreCommercialRecommendation,
  type CommercialEvidenceState,
  type CommercialGateInput,
  type CommercialScoreDecision,
  type CommercialScoreInput,
} from "./commercial-score.js";

export type CommercialCandidateBusinessFacts = Readonly<{
  selfOrRelatedDomain: boolean;
  existingBacklinkOrOpportunity: boolean;
  permanentlyRejectedOrSuppressed: boolean;
  unsafeOrDisallowedIndustry: boolean;
  strictMarketMode: boolean;
  expectedLanguages: readonly string[];
}>;

export type CommercialCandidateProviderFacts = Readonly<{
  rank: number | null;
  backlinkCount: number | null;
  referringDomainCount: number | null;
  spamScore: number | null;
  evidenceRefs: readonly string[];
  collectedAt: string;
}>;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function evidenceState(
  assessment: CommercialStaticAssessment,
): CommercialEvidenceState {
  return assessment.decision === "ready"
    ? "observed"
    : assessment.decision;
}

function scoreInput(input: Readonly<{
  id: CommercialScoreInput["id"];
  state: CommercialEvidenceState;
  rawValue: CommercialScoreInput["rawValue"];
  normalizedValue: number | null;
  evidenceRefs: readonly string[];
  collectedAt: string;
  normalizationRuleVersion: string;
}>): CommercialScoreInput {
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

export function evaluateCommercialCandidate(input: Readonly<{
  business: CommercialCandidateBusinessFacts;
  provider: CommercialCandidateProviderFacts;
  staticAssessment: CommercialStaticAssessment;
}>): CommercialScoreDecision {
  const assessment = input.staticAssessment;
  const staticState = evidenceState(assessment);
  const expectedLanguages = new Set(input.business.expectedLanguages.map(
    (language) => language.trim().toLowerCase().split(/[-_]/u)[0],
  ));
  const languageKnown = assessment.language !== null
    && expectedLanguages.size > 0;
  const marketMismatch = languageKnown
    ? !expectedLanguages.has(assessment.language!)
    : null;
  const commonGate = (
    id: CommercialGateInput["id"],
    matched: boolean,
    ref: string,
  ): CommercialGateInput => Object.freeze({
    id,
    state: "derived",
    matched,
    evidenceRefs: Object.freeze([ref]),
  });
  const gates: readonly CommercialGateInput[] = Object.freeze([
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
      id: "unsafe_or_malicious",
      state: assessment.unsafeOrMalicious === null
        ? staticState
        : "observed",
      matched: input.business.unsafeOrDisallowedIndustry
        || assessment.unsafeOrMalicious,
      evidenceRefs: assessment.evidenceRefs,
    }),
    Object.freeze({
      id: "pbn_or_link_farm",
      state: assessment.highConfidenceLinkFarm === null
        && input.provider.spamScore === null
        ? staticState
        : "derived",
      matched: assessment.highConfidenceLinkFarm === null
        && input.provider.spamScore === null
        ? null
        : assessment.highConfidenceLinkFarm === true
          || (input.provider.spamScore ?? 0) >= 70,
      evidenceRefs: Object.freeze([
        ...assessment.evidenceRefs,
        ...input.provider.evidenceRefs,
      ]),
    }),
    Object.freeze({
      id: "strict_market_mismatch",
      state: !input.business.strictMarketMode
        ? "derived"
        : marketMismatch === null ? staticState : "observed",
      matched: input.business.strictMarketMode ? marketMismatch : false,
      evidenceRefs: assessment.evidenceRefs,
    }),
  ]);

  const cooperationSignal = assessment.cooperationPages.length > 0
    ? 1
    : assessment.monetizationMethods.length > 0 ? 0.7 : 0;
  const editorialCommercial = assessment.editorialQuality === null
    || assessment.outboundLinkDensity === null
    ? null
    : clamp(
        assessment.editorialQuality * 0.65
        + cooperationSignal * 0.25
        + (1 - assessment.outboundLinkDensity) * 0.1,
      );
  const authority = providerAuthority(input.provider);
  const components: readonly CommercialScoreInput[] = Object.freeze([
    scoreInput({
      id: "relevance",
      state: assessment.productRelevance === null
        ? staticState
        : "derived",
      rawValue: assessment.topics.join(", ") || null,
      normalizedValue: assessment.productRelevance,
      evidenceRefs: assessment.evidenceRefs,
      collectedAt: assessment.collectedAt,
      normalizationRuleVersion: "commercial-relevance-overlap.v1",
    }),
    scoreInput({
      id: "market_language",
      state: languageKnown ? "observed" : staticState,
      rawValue: assessment.language,
      normalizedValue: marketMismatch === null
        ? null
        : marketMismatch ? 0 : 1,
      evidenceRefs: assessment.evidenceRefs,
      collectedAt: assessment.collectedAt,
      normalizationRuleVersion: "commercial-market-language.v1",
    }),
    scoreInput({
      id: "target_cooperation_angle",
      state: assessment.decision === "ready" ? "derived" : staticState,
      rawValue: assessment.cooperationPages.length,
      normalizedValue: assessment.decision === "ready"
        ? cooperationSignal
        : null,
      evidenceRefs: assessment.evidenceRefs,
      collectedAt: assessment.collectedAt,
      normalizationRuleVersion: "commercial-cooperation-signal.v1",
    }),
    scoreInput({
      id: "editorial_commercial_feasibility",
      state: editorialCommercial === null ? staticState : "derived",
      rawValue: assessment.siteType,
      normalizedValue: editorialCommercial,
      evidenceRefs: assessment.evidenceRefs,
      collectedAt: assessment.collectedAt,
      normalizationRuleVersion:
        "commercial-editorial-commercial-feasibility.v1",
    }),
    scoreInput({
      id: "dataforseo_authority_risk",
      state: authority === null ? "unavailable" : "derived",
      rawValue: input.provider.spamScore,
      normalizedValue: authority,
      evidenceRefs: input.provider.evidenceRefs,
      collectedAt: input.provider.collectedAt,
      normalizationRuleVersion: "commercial-dataforseo-authority-risk.v1",
    }),
    scoreInput({
      id: "traffic_visibility",
      state: input.provider.rank === null ? "unavailable" : "derived",
      rawValue: input.provider.rank,
      normalizedValue: input.provider.rank === null
        ? null
        : clamp(input.provider.rank / 100),
      evidenceRefs: input.provider.evidenceRefs,
      collectedAt: input.provider.collectedAt,
      normalizationRuleVersion: "commercial-rank-visibility-proxy.v1",
    }),
    scoreInput({
      id: "technical",
      state: assessment.technicalAccessibility === null
        ? staticState
        : "observed",
      rawValue: assessment.failedUrls.length,
      normalizedValue: assessment.technicalAccessibility,
      evidenceRefs: assessment.evidenceRefs,
      collectedAt: assessment.collectedAt,
      normalizationRuleVersion: "commercial-static-accessibility.v1",
    }),
  ]);
  return scoreCommercialRecommendation({ gates, components });
}
