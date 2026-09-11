import {
  markRecommendation,
  type RecommendationPositiveEvidence,
  type RecommendationRelevanceEvidence,
} from "./recommendation-marker-policy.js";
import {
  recommendationPoolV2AdmissionPolicy,
  type RecommendationPoolV2HardExclusionCode,
} from "./recommendation-pool-v2-policy.js";
import { excludedOutreachTarget } from "./outreach-target-policy.js";

export type RecommendationPoolV2AdmissionInput = Readonly<{
  canonicalDomain: string;
  projectDomain: string;
  relevance?: "RELEVANT";
  relevanceEvidence?: readonly RecommendationRelevanceEvidence[];
  positiveEvidence?: readonly RecommendationPositiveEvidence[];
  metrics: Readonly<{
    targetMarketOrganicTraffic: number | null;
    dataForSeoRank: number | null;
    spamScore: number | null;
  }>;
  v1CommercialScore?: number | null;
  contact: Readonly<{
    email: string | null;
    contactPage: string | null;
  }>;
  hardExclusionSignals: readonly string[];
}>;

export type RecommendationPoolV2AdmissionDecision = Readonly<{
  admissionState: "ADMITTED" | "EXCLUDED";
  hardExclusionCode: RecommendationPoolV2HardExclusionCode | null;
  contactPreparationState: "QUEUED" | "NOT_REQUIRED";
  admissionContractVersion:
    typeof recommendationPoolV2AdmissionPolicy.admissionContractVersion;
  admissionPolicyVersion: typeof recommendationPoolV2AdmissionPolicy.version;
  recommended: boolean;
  recommendationReasonCodes: readonly string[];
  decisionEvidence: Readonly<Record<string, unknown>>;
  exclusionEvidence: Readonly<Record<string, unknown>>;
}>;

function nullableMetric(value: number | null, label: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) {
    throw new TypeError(`Recommendation pool V2 ${label} is invalid.`);
  }
  return value;
}

function canonicalDomain(value: string, label: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/u, "");
  if (
    normalized.length === 0 ||
    normalized.includes("/") ||
    normalized.includes(":")
  ) {
    throw new TypeError(`Recommendation pool V2 ${label} is invalid.`);
  }
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

function hardExclusionSignals(
  values: readonly string[],
): readonly RecommendationPoolV2HardExclusionCode[] {
  const allowed = new Set<string>(
    recommendationPoolV2AdmissionPolicy.hardExclusionCodes,
  );
  const normalized = [...new Set(values.map((value) => value.trim()))].filter(
    (value) => value.length > 0,
  );
  const unsupported = normalized.find((value) => !allowed.has(value));
  if (unsupported !== undefined) {
    throw new TypeError(
      `Recommendation pool V2 hard exclusion ${unsupported} is unsupported.`,
    );
  }
  return Object.freeze(
    recommendationPoolV2AdmissionPolicy.hardExclusionCodes.filter((value) =>
      normalized.includes(value),
    ),
  );
}

export function evaluateRecommendationPoolV2CandidateAdmission(
  input: RecommendationPoolV2AdmissionInput,
): RecommendationPoolV2AdmissionDecision {
  const candidateDomain = canonicalDomain(
    input.canonicalDomain,
    "canonical domain",
  );
  const projectDomain = canonicalDomain(input.projectDomain, "project domain");
  const outreachExclusion = excludedOutreachTarget(candidateDomain);
  const explicitExclusions = hardExclusionSignals([
    ...input.hardExclusionSignals,
    ...(outreachExclusion === null ? [] : ["PERMANENTLY_EXCLUDED"]),
  ]);
  const exclusions =
    candidateDomain === projectDomain &&
    !explicitExclusions.includes("SELF_DOMAIN")
      ? Object.freeze(["SELF_DOMAIN", ...explicitExclusions] as const)
      : explicitExclusions;
  const hardExclusionCode = exclusions[0] ?? null;
  const relevanceEvidence = Object.freeze([
    ...new Set([
      ...(input.relevance === "RELEVANT"
        ? (["PRODUCT_TOPIC_OVERLAP"] as const)
        : []),
      ...(input.relevanceEvidence ?? []),
    ]),
  ]);
  const defaultPositiveEvidence = Object.freeze([
    "VERIFIED_SOURCE_RELATION",
  ] satisfies readonly RecommendationPositiveEvidence[]);
  const positiveEvidence: readonly RecommendationPositiveEvidence[] =
    Object.freeze([
      ...new Set(input.positiveEvidence ?? defaultPositiveEvidence),
    ]);
  const metrics = Object.freeze({
    targetMarketOrganicTraffic: nullableMetric(
      input.metrics.targetMarketOrganicTraffic,
      "target-market organic traffic",
    ),
    dataForSeoRank: nullableMetric(
      input.metrics.dataForSeoRank,
      "DataForSEO rank",
    ),
    spamScore: nullableMetric(input.metrics.spamScore, "spam score"),
  });
  const marker = markRecommendation({
    passedRequiredExclusions: hardExclusionCode === null,
    relevanceEvidence,
    positiveEvidence,
  });
  const admitted = hardExclusionCode === null;
  const recommendationReasonCodes = admitted
    ? marker.recommendationReasonCodes
    : Object.freeze([hardExclusionCode]);
  const exclusionEvidence =
    hardExclusionCode === null
      ? Object.freeze({})
      : Object.freeze({
          policyVersion: recommendationPoolV2AdmissionPolicy.version,
          hardExclusionCode,
          canonicalDomain: candidateDomain,
          projectDomain,
          ...(outreachExclusion === null ? {} : { outreachTarget: outreachExclusion }),
        });

  return Object.freeze({
    admissionState: admitted ? "ADMITTED" : "EXCLUDED",
    hardExclusionCode,
    contactPreparationState: admitted ? "QUEUED" : "NOT_REQUIRED",
    admissionContractVersion:
      recommendationPoolV2AdmissionPolicy.admissionContractVersion,
    admissionPolicyVersion: recommendationPoolV2AdmissionPolicy.version,
    recommended: admitted && marker.recommended,
    recommendationReasonCodes,
    decisionEvidence: Object.freeze({
      admissionContractVersion:
        recommendationPoolV2AdmissionPolicy.admissionContractVersion,
      admissionPolicyVersion: recommendationPoolV2AdmissionPolicy.version,
      canonicalDomain: candidateDomain,
      projectDomain,
      hardExclusionSignals: exclusions,
      relevanceEvidence,
      positiveEvidence,
      metrics,
      ...(outreachExclusion === null ? {} : { outreachTarget: outreachExclusion }),
      recommendationMarkerVersion: marker.recommendationMarkerVersion,
    }),
    exclusionEvidence,
  });
}
