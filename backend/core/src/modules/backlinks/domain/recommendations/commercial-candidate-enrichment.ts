import {
  applyCommercialCandidateAdmissionThreshold,
  evaluateCommercialCandidate,
  type CommercialCandidateBusinessFacts,
  type CommercialCandidateFitDecision,
  type CommercialCandidateProviderFacts,
} from "./commercial-candidate-evaluation.js";
import type { CommercialStaticAssessment } from "./commercial-static-assessment.js";
import {
  commercialFitBaselineAdmissionThreshold,
  commercialFitWeights,
  hasUnresolvedCommercialFitHardGate,
} from "./commercial-score-v4.js";

export const commercialCandidateEnrichmentMaximumCandidates = 25;

export type CommercialCandidateEnrichmentInput = Readonly<{
  hostnameAscii: string;
  business: CommercialCandidateBusinessFacts;
  provider: CommercialCandidateProviderFacts;
  staticAssessment: CommercialStaticAssessment;
  commercialScore: CommercialCandidateFitDecision;
}>;

export type CommercialCandidateEnrichmentMetricState =
  | "completed"
  | "missing"
  | "unknown_charge"
  | "unavailable";

export type CommercialCandidateEnrichmentMetrics = Readonly<{
  trafficOrganicEtv: number | null;
  spamScore: number | null;
  authorityRank: number | null;
  trafficState: CommercialCandidateEnrichmentMetricState;
  spamState: CommercialCandidateEnrichmentMetricState;
  rankState: CommercialCandidateEnrichmentMetricState;
  requestFingerprints: Readonly<{
    traffic: string;
    spam: string;
    rank: string;
  }>;
}>;

export type CommercialCandidateEnrichmentState =
  | "candidate_ready"
  | "excluded"
  | "insufficient_data"
  | "manual_review";

export type CommercialCandidateEnrichmentDecision = Readonly<{
  hostnameAscii: string;
  decision:
    | "enrichment_eligible"
    | "excluded"
    | "insufficient_data"
    | "not_selected";
  currentScore: number | null;
  maximumReachableScore: number | null;
  hitGates: CommercialCandidateFitDecision["hitGates"];
  market: CommercialCandidateFitDecision["details"]["market"];
  missingEvidence: CommercialCandidateFitDecision["missingEvidence"];
}>;

const enrichmentComponentIds = new Set([
  "relative_authority",
  "traffic_basic_quality",
  "evidence_completeness",
]);

function roundFour(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

function maximumReachableScore(
  score: CommercialCandidateFitDecision,
): number | null {
  if (
    score.total === null
    || score.hitGates.length > 0
  ) {
    return null;
  }
  const fixedComponents = score.components.filter(
    ({ id }) => !enrichmentComponentIds.has(id),
  );
  return roundFour(
    fixedComponents.reduce((sum, { points }) => sum + (points ?? 0), 0)
      + commercialFitWeights.relative_authority
      + commercialFitWeights.traffic_basic_quality
      + commercialFitWeights.evidence_completeness,
  );
}

export function selectCommercialCandidateEnrichment<
  T extends CommercialCandidateEnrichmentInput,
>(
  candidates: readonly T[],
  options: Readonly<{ maximumCandidates?: number }> = {},
): Readonly<{
  candidates: readonly T[];
  decisions: readonly CommercialCandidateEnrichmentDecision[];
}> {
  const maximumCandidates =
    options.maximumCandidates ?? commercialCandidateEnrichmentMaximumCandidates;
  if (
    !Number.isSafeInteger(maximumCandidates)
    || maximumCandidates < 1
    || maximumCandidates > commercialCandidateEnrichmentMaximumCandidates
  ) {
    throw new TypeError(
      `Commercial enrichment maximumCandidates must be from 1 to ${
        commercialCandidateEnrichmentMaximumCandidates
      }.`,
    );
  }
  const assessed = candidates.map((candidate) => {
    const maximum = maximumReachableScore(candidate.commercialScore);
    return Object.freeze({
      candidate,
      maximum,
      eligible:
        maximum !== null
        && maximum >= commercialFitBaselineAdmissionThreshold,
    });
  });
  const selected = new Set(
    assessed
      .filter(({ eligible }) => eligible)
      .sort((left, right) =>
        (right.candidate.commercialScore.total ?? -1)
          - (left.candidate.commercialScore.total ?? -1)
        || (right.maximum ?? -1) - (left.maximum ?? -1)
        || left.candidate.hostnameAscii.localeCompare(
          right.candidate.hostnameAscii,
          "en",
        ))
      .slice(0, maximumCandidates)
      .map(({ candidate }) => candidate.hostnameAscii),
  );
  return Object.freeze({
    candidates: Object.freeze(
      assessed
        .filter(({ candidate }) => selected.has(candidate.hostnameAscii))
        .map(({ candidate }) => candidate),
    ),
    decisions: Object.freeze(assessed.map(({ candidate, maximum, eligible }) =>
      Object.freeze({
        hostnameAscii: candidate.hostnameAscii,
        decision: selected.has(candidate.hostnameAscii)
          ? "enrichment_eligible"
          : candidate.commercialScore.hitGates.length > 0
            ? "excluded"
            : eligible
              ? "not_selected"
              : "insufficient_data",
        currentScore: candidate.commercialScore.total,
        maximumReachableScore: maximum,
        hitGates: candidate.commercialScore.hitGates,
        market: candidate.commercialScore.details.market,
        missingEvidence: candidate.commercialScore.missingEvidence,
      }))),
  });
}

function withMetricEvidence(
  score: CommercialCandidateFitDecision,
  metrics: CommercialCandidateEnrichmentMetrics,
): CommercialCandidateFitDecision {
  const missingEvidence = [
    ...score.missingEvidence,
    ...(metrics.trafficState === "completed"
      ? []
      : [`qualification.traffic.${metrics.trafficState}`]),
    ...(metrics.spamState === "completed"
      ? []
      : [`qualification.spam.${metrics.spamState}`]),
    ...(metrics.rankState === "completed"
      ? []
      : [`qualification.rank.${metrics.rankState}`]),
  ];
  return Object.freeze({
    ...score,
    missingEvidence: Object.freeze([...new Set(missingEvidence)]),
  });
}

export function finalizeCommercialCandidateEnrichment(
  input: Readonly<{
    candidate: CommercialCandidateEnrichmentInput;
    metrics: CommercialCandidateEnrichmentMetrics;
    qualificationDecision:
      | "eligible"
      | "ineligible"
      | "insufficient_data"
      | "manual_review";
  }>,
): Readonly<{
  state: CommercialCandidateEnrichmentState;
  commercialScore: CommercialCandidateFitDecision;
  provider: CommercialCandidateProviderFacts;
}> {
  const provider = Object.freeze({
    ...input.candidate.provider,
    rank:
      input.metrics.rankState === "completed"
      && input.metrics.authorityRank !== null
        ? input.metrics.authorityRank
        : input.candidate.provider.rank,
    traffic:
      input.metrics.trafficState === "completed"
      && input.metrics.trafficOrganicEtv !== null
        ? input.metrics.trafficOrganicEtv
        : input.candidate.provider.traffic,
    spamScore:
      input.metrics.spamState === "completed"
      && input.metrics.spamScore !== null
        ? input.metrics.spamScore
        : input.candidate.provider.spamScore,
    evidenceRefs: Object.freeze([
      ...new Set([
        ...input.candidate.provider.evidenceRefs,
        ...Object.values(input.metrics.requestFingerprints).filter(Boolean),
      ]),
    ]),
  });
  const rescored = applyCommercialCandidateAdmissionThreshold(
    evaluateCommercialCandidate({
      business: input.candidate.business,
      provider,
      staticAssessment: input.candidate.staticAssessment,
    }),
    input.candidate.commercialScore.admission.appliedThreshold,
  );
  const scoredWithEvidence = withMetricEvidence(rescored, input.metrics);
  if (
    input.qualificationDecision === "insufficient_data"
    || scoredWithEvidence.decision === "insufficient_data"
  ) {
    return Object.freeze({
      state: "insufficient_data",
      commercialScore: scoredWithEvidence,
      provider,
    });
  }
  if (input.qualificationDecision === "manual_review") {
    return Object.freeze({
      state: "manual_review",
      commercialScore: scoredWithEvidence,
      provider,
    });
  }
  if (hasUnresolvedCommercialFitHardGate(scoredWithEvidence)) {
    return Object.freeze({
      state: "insufficient_data",
      commercialScore: scoredWithEvidence,
      provider,
    });
  }
  if (
    scoredWithEvidence.decision === "eligible"
    && (scoredWithEvidence.total ?? 0)
      >= scoredWithEvidence.admission.appliedThreshold
  ) {
    return Object.freeze({
      state: "candidate_ready",
      commercialScore: scoredWithEvidence,
      provider,
    });
  }
  return Object.freeze({
    state: "excluded",
    commercialScore: scoredWithEvidence,
    provider,
  });
}
