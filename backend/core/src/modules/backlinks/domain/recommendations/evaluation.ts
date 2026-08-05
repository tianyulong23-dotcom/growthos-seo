import { createRecommendationDomainKey } from "./domain-key.js";
import {
  evaluateRecommendationGates,
  type RecommendationRuleFacts,
  type RuleDecision,
} from "./gates.js";
import { rankRecommendations } from "./ranking.js";
import {
  findRecommendationScoreEvidenceGaps,
  scoreRecommendation,
  type RecommendationScore,
  type RecommendationScoreComponentInput,
} from "./scoring.js";

export type RecommendationEvidenceCandidate = Readonly<{
  hostnameAscii: string;
  sourceReleaseId: string;
  evidencePolicyVersion: string;
  gates: RecommendationRuleFacts;
  components: readonly RecommendationScoreComponentInput[];
}>;

type RecommendationDecisionBase = Readonly<{
  hostnameAscii: string;
  sourceReleaseId: string;
  evidencePolicyVersion: string;
  gateDecision: RuleDecision;
  missingEvidenceKeys: readonly string[];
}>;

export type ReadyRecommendationDecision = RecommendationDecisionBase &
  Readonly<{
    decision: "ready";
    score: RecommendationScore;
  }>;

export type RecommendationEvaluation =
  | ReadyRecommendationDecision
  | RecommendationDecisionBase & Readonly<{
    decision: "excluded" | "insufficient_data";
    score: null;
  }>;

function assertCandidateIdentity(
  candidate: RecommendationEvidenceCandidate,
): void {
  const normalized = createRecommendationDomainKey(candidate.hostnameAscii);
  if (normalized.hostnameAscii !== candidate.hostnameAscii) {
    throw new TypeError("Recommendation candidate hostnameAscii is not normalized");
  }
  if (
    candidate.sourceReleaseId.trim().length === 0 ||
    candidate.sourceReleaseId !== candidate.sourceReleaseId.trim() ||
    candidate.evidencePolicyVersion.trim().length === 0 ||
    candidate.evidencePolicyVersion !== candidate.evidencePolicyVersion.trim()
  ) {
    throw new TypeError("Recommendation candidate requires evidence versions");
  }
}

export function evaluateRecommendationCandidate(
  candidate: RecommendationEvidenceCandidate,
): RecommendationEvaluation {
  assertCandidateIdentity(candidate);
  const gateDecision = evaluateRecommendationGates(
    candidate.gates,
    candidate.sourceReleaseId,
  );
  const base = {
    hostnameAscii: candidate.hostnameAscii,
    sourceReleaseId: candidate.sourceReleaseId.trim(),
    evidencePolicyVersion: candidate.evidencePolicyVersion.trim(),
    gateDecision,
  } as const;

  if (gateDecision.decision === "excluded") {
    return Object.freeze({
      ...base,
      decision: "excluded",
      score: null,
      missingEvidenceKeys: gateDecision.missingEvidenceKeys,
    });
  }
  if (gateDecision.decision === "insufficient_data") {
    return Object.freeze({
      ...base,
      decision: "insufficient_data",
      score: null,
      missingEvidenceKeys: gateDecision.missingEvidenceKeys,
    });
  }

  const missingEvidenceKeys = findRecommendationScoreEvidenceGaps({
    sourceReleaseId: base.sourceReleaseId,
    components: candidate.components,
  });
  if (missingEvidenceKeys.length > 0) {
    return Object.freeze({
      ...base,
      decision: "insufficient_data",
      score: null,
      missingEvidenceKeys,
    });
  }

  return Object.freeze({
    ...base,
    decision: "ready",
    missingEvidenceKeys: Object.freeze([]),
    score: scoreRecommendation({
      ruleVersion: gateDecision.ruleVersion,
      evidencePolicyVersion: base.evidencePolicyVersion,
      sourceReleaseId: base.sourceReleaseId,
      components: candidate.components,
    }),
  });
}

export type ReadyRecommendationRefill = Readonly<{
  ready: readonly ReadyRecommendationDecision[];
  counts: Readonly<{
    evaluated: number;
    ready: number;
    excluded: number;
    insufficientData: number;
  }>;
}>;

export function prepareReadyRecommendationRefill(input: Readonly<{
  candidates: readonly RecommendationEvidenceCandidate[];
  requestedCount: number;
}>): ReadyRecommendationRefill {
  if (!Number.isInteger(input.requestedCount) || input.requestedCount < 0) {
    throw new TypeError("requestedCount must be a non-negative integer");
  }

  const first = input.candidates[0];
  const seenHostnames = new Set<string>();
  for (const candidate of input.candidates) {
    assertCandidateIdentity(candidate);
    if (seenHostnames.has(candidate.hostnameAscii)) {
      throw new TypeError(
        `duplicate hostnameAscii in refill input: ${candidate.hostnameAscii}`,
      );
    }
    seenHostnames.add(candidate.hostnameAscii);
    if (
      first !== undefined &&
      (candidate.sourceReleaseId !== first.sourceReleaseId ||
        candidate.evidencePolicyVersion !== first.evidencePolicyVersion)
    ) {
      throw new TypeError("refill input mixes evidence contracts");
    }
  }

  const evaluations = input.candidates.map(evaluateRecommendationCandidate);
  const ready = rankRecommendations(
    evaluations.filter(
      (evaluation): evaluation is ReadyRecommendationDecision =>
        evaluation.decision === "ready",
    ),
  ).slice(0, input.requestedCount);

  return Object.freeze({
    ready: Object.freeze(ready),
    counts: Object.freeze({
      evaluated: evaluations.length,
      ready: ready.length,
      excluded: evaluations.filter(
        ({ decision }) => decision === "excluded",
      ).length,
      insufficientData: evaluations.filter(
        ({ decision }) => decision === "insufficient_data",
      ).length,
    }),
  });
}
