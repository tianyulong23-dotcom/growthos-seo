import { recommendationMarkerVersion } from "./recommendation-pool-v2-policy.js";

export const recommendationRelevanceEvidenceKinds = [
  "PRODUCT_TOPIC_OVERLAP",
  "AUDIENCE_OVERLAP",
  "COMPETITOR_BACKLINK_SOURCE",
  "TARGET_MARKET_SEARCH_TOPIC",
] as const;

export const recommendationPositiveEvidenceKinds = [
  "MARKET_LANGUAGE_MATCH",
  "VERIFIED_SOURCE_RELATION",
  "PUBLIC_CONTACT_PATH",
  "RELIABLE_METRIC",
  "COOPERATION_PATH",
] as const;

export type RecommendationRelevanceEvidence =
  (typeof recommendationRelevanceEvidenceKinds)[number];
export type RecommendationPositiveEvidence =
  (typeof recommendationPositiveEvidenceKinds)[number];

export type RecommendationMarkerDecision = Readonly<{
  recommended: boolean;
  recommendationReasonCodes: readonly string[];
  recommendationMarkerVersion: typeof recommendationMarkerVersion;
}>;

export function markRecommendation(
  input: Readonly<{
    passedRequiredExclusions: boolean;
    relevanceEvidence: readonly RecommendationRelevanceEvidence[];
    positiveEvidence: readonly RecommendationPositiveEvidence[];
  }>,
): RecommendationMarkerDecision {
  const relevanceEvidence = [...new Set(input.relevanceEvidence)].sort();
  const positiveEvidence = [...new Set(input.positiveEvidence)].sort();
  const recommended =
    input.passedRequiredExclusions &&
    relevanceEvidence.length > 0 &&
    positiveEvidence.length > 0;
  const reasons = recommended
    ? [
        ...relevanceEvidence.map((kind) => `RELEVANCE_${kind}`),
        ...positiveEvidence.map((kind) => `EVIDENCE_${kind}`),
      ]
    : [
        ...(!input.passedRequiredExclusions
          ? ["REQUIRED_EXCLUSION_FAILED"]
          : []),
        ...(relevanceEvidence.length === 0
          ? ["RELEVANCE_EVIDENCE_MISSING"]
          : []),
        ...(positiveEvidence.length === 0
          ? ["INDEPENDENT_POSITIVE_EVIDENCE_MISSING"]
          : []),
      ];
  return {
    recommended,
    recommendationReasonCodes: reasons,
    recommendationMarkerVersion,
  };
}
