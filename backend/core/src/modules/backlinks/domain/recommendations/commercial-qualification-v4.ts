import { createRecommendationDomainKey } from "./domain-key.js";

export const commercialQualificationRuleVersion =
  "commercial-qualification.v4.2" as const;
export const commercialQualificationScoreModelVersion =
  "recommendation-commercial-fit.v4" as const;
export const commercialQualificationSpamReviewMinimum = 30;
export const commercialQualificationSpamHardRejectMinimum = 70;

export type CommercialQualificationMetricScope =
  "TARGET_MARKET" | "GLOBAL";

export type CommercialQualificationDecision =
  | "eligible"
  | "ineligible"
  | "insufficient_data"
  | "manual_review";

export type CommercialQualificationV4Input = Readonly<{
  canonicalDomain: string;
  metricScope: CommercialQualificationMetricScope;
  trafficOrganicEtv: number | null;
  spamScore: number | null;
  authorityRank: number | null;
  metricAttempt: number;
  accessibilityDecision:
    | "accessible"
    | "inaccessible"
    | "insufficient_data";
  accessibilityAttempt: number;
  marketDecision:
    | "allowed"
    | "mismatch"
    | "forbidden"
    | "insufficient_data";
  hardGateReasonCodes: readonly string[];
  semantic: Readonly<{
    productRelevance: number | null;
    topicRelevance: number | null;
    keywordRelevance: number | null;
    unrelated: boolean | null;
    attempt: number;
    state: "observed" | "unavailable" | "malformed";
  }>;
}>;

export type CommercialQualificationV4Result = Readonly<{
  canonicalDomain: string;
  metricScope: CommercialQualificationMetricScope;
  trafficOrganicEtv: number | null;
  spamScore: number | null;
  authorityRank: number | null;
  accessibilityDecision:
    | "accessible"
    | "inaccessible"
    | "insufficient_data";
  marketDecision: "allowed" | "mismatch" | "insufficient_data";
  semanticScore: number | null;
  decision: CommercialQualificationDecision;
  decisionReasonCode: string;
  ruleVersion: typeof commercialQualificationRuleVersion;
  scoreModelVersion: typeof commercialQualificationScoreModelVersion;
}>;

function assertAttempt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
}

function assertOptionalRange(
  value: number | null,
  name: string,
  maximum: number | null = null,
): void {
  if (
    value !== null
    && (
      !Number.isFinite(value)
      || value < 0
      || (maximum !== null && value > maximum)
    )
  ) {
    throw new TypeError(`${name} is outside its supported range.`);
  }
}

function normalizeScore(value: number | null, name: string): number | null {
  assertOptionalRange(value, name, 100);
  return value;
}

export function scoreCommercialSemanticFit(
  input: Pick<
    CommercialQualificationV4Input["semantic"],
    "productRelevance" | "topicRelevance" | "keywordRelevance"
  >,
): number | null {
  const product = normalizeScore(input.productRelevance, "productRelevance");
  const topic = normalizeScore(input.topicRelevance, "topicRelevance");
  const keyword = normalizeScore(input.keywordRelevance, "keywordRelevance");
  if (product === null || topic === null || keyword === null) return null;
  return Number((product * 0.5 + topic * 0.3 + keyword * 0.2).toFixed(4));
}

function result(
  input: CommercialQualificationV4Input,
  semanticScore: number | null,
  decision: CommercialQualificationDecision,
  decisionReasonCode: string,
): CommercialQualificationV4Result {
  const marketDecision = input.marketDecision === "forbidden"
    ? "mismatch"
    : input.marketDecision;
  return Object.freeze({
    canonicalDomain:
      createRecommendationDomainKey(input.canonicalDomain).registrableDomain,
    metricScope: input.metricScope,
    trafficOrganicEtv: input.trafficOrganicEtv,
    spamScore: input.spamScore,
    authorityRank: input.authorityRank,
    accessibilityDecision: input.accessibilityDecision,
    marketDecision,
    semanticScore,
    decision,
    decisionReasonCode,
    ruleVersion: commercialQualificationRuleVersion,
    scoreModelVersion: commercialQualificationScoreModelVersion,
  });
}

export function evaluateCommercialQualificationV4(
  input: CommercialQualificationV4Input,
): CommercialQualificationV4Result {
  assertAttempt(input.metricAttempt, "metricAttempt");
  assertAttempt(input.accessibilityAttempt, "accessibilityAttempt");
  assertAttempt(input.semantic.attempt, "semantic.attempt");
  assertOptionalRange(input.trafficOrganicEtv, "trafficOrganicEtv");
  assertOptionalRange(input.spamScore, "spamScore", 100);
  assertOptionalRange(input.authorityRank, "authorityRank", 100);
  const semanticScore = scoreCommercialSemanticFit(input.semantic);

  const hardGate = input.hardGateReasonCodes.find(
    (reasonCode) => reasonCode.trim().length > 0,
  );
  if (hardGate !== undefined) {
    return result(input, semanticScore, "ineligible", hardGate.trim());
  }
  if (
    input.spamScore !== null
    && input.spamScore >= commercialQualificationSpamHardRejectMinimum
  ) {
    return result(
      input,
      semanticScore,
      "ineligible",
      "SPAM_SCORE_HIGH_RISK",
    );
  }
  if (
    input.spamScore !== null
    && input.spamScore >= commercialQualificationSpamReviewMinimum
  ) {
    return result(
      input,
      semanticScore,
      "manual_review",
      "SPAM_SCORE_REVIEW_REQUIRED",
    );
  }
  if (input.accessibilityDecision === "inaccessible") {
    return result(input, semanticScore, "ineligible", "SITE_INACCESSIBLE");
  }
  if (input.semantic.unrelated === true) {
    return result(input, semanticScore, "ineligible", "SEMANTIC_UNRELATED");
  }
  const hasPartialEvidence =
    input.marketDecision === "insufficient_data"
    || input.trafficOrganicEtv === null
    || input.spamScore === null
    || input.authorityRank === null
    || input.accessibilityDecision === "insufficient_data"
    || input.semantic.state !== "observed"
    || semanticScore === null
    || input.semantic.unrelated === null;
  if (hasPartialEvidence) {
    return result(
      input,
      semanticScore,
      "eligible",
      "QUALIFICATION_PASSED_WITH_PARTIAL_EVIDENCE",
    );
  }
  return result(
    input,
    semanticScore,
    "eligible",
    input.marketDecision === "allowed"
      ? "QUALIFICATION_PASSED"
      : "QUALIFICATION_PASSED_MARKET_MISMATCH",
  );
}

function descendingNullable(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

function marketPriority(
  decision: CommercialQualificationV4Result["marketDecision"],
): number {
  if (decision === "allowed") return 0;
  if (decision === "mismatch") return 1;
  return 2;
}

export function rankCommercialQualificationsV4(
  candidates: readonly CommercialQualificationV4Result[],
): readonly CommercialQualificationV4Result[] {
  return Object.freeze([...candidates].sort((left, right) =>
    descendingNullable(left.semanticScore, right.semanticScore)
    || marketPriority(left.marketDecision) - marketPriority(right.marketDecision)
    || descendingNullable(left.authorityRank, right.authorityRank)
    || descendingNullable(left.trafficOrganicEtv, right.trafficOrganicEtv)
    || left.canonicalDomain.localeCompare(right.canonicalDomain, "en")));
}
