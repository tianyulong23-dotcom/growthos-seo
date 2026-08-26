import { randomUUID } from "node:crypto";

import type { CommercialCandidateFitDecision } from "../../domain/recommendations/commercial-candidate-evaluation.js";
import {
  commercialFitBaselineAdmissionThreshold,
  commercialFitSpamHardRejectMinimum,
  commercialFitSpamReviewMinimum,
  commercialRecommendationFitModelVersion,
  commercialRecommendationFitRuleVersion,
} from "../../domain/recommendations/commercial-score-v4.js";
import { createRecommendationDomainKey } from "../../domain/recommendations/domain-key.js";
import {
  CORRECTED_QUALIFICATION_CONTRACT_VERSION,
  type RecommendationContractJson,
  type RecommendationContractPort,
  type RecommendationContractScope,
  type WriteQualificationFactInput,
} from "../../ports/recommendation-contract.port.js";
import type {
  CommercialQualificationBulkRecord,
  CommercialQualificationBulkResult,
} from "./commercial-qualification-bulk.service.js";

export type CommercialQualificationCandidate = Readonly<{
  candidateId: string;
  canonicalDomain: string;
  attempt: number;
  commercialScore: CommercialCandidateFitDecision;
  accessibility: Readonly<{
    decision: "accessible" | "inaccessible" | "insufficient_data";
    attempt: number;
    evidence: RecommendationContractJson;
  }>;
  semantic: Readonly<{
    productRelevance: number | null;
    topicRelevance: number | null;
    keywordRelevance: number | null;
    unrelated: boolean | null;
    attempt: number;
    state: "observed" | "unavailable" | "malformed";
    modelVersion: string | null;
    promptVersion: string | null;
    evidence: RecommendationContractJson;
  }>;
  evidenceRefs: readonly string[];
}>;

export type CommercialQualificationRankedResult = Readonly<{
  candidateId: string;
  hostnameAscii: string;
  canonicalDomain: string;
  decision:
    | "eligible"
    | "ineligible"
    | "insufficient_data"
    | "manual_review";
  decisionReasonCode: string;
  marketDecision: "allowed" | "mismatch" | "insufficient_data";
  total: number | null;
  appliedThreshold: number;
  trafficOrganicEtv: number | null;
  spamScore: number | null;
  authorityRank: number | null;
  trafficState: CommercialQualificationBulkRecord["trafficState"];
  spamState: CommercialQualificationBulkRecord["spamState"];
  rankState: CommercialQualificationBulkRecord["rankState"];
  requestFingerprints: CommercialQualificationBulkRecord["requestFingerprints"];
}>;

export type CommercialQualificationResult = Readonly<{
  mode: "authoritative";
  sourceKind: "WEBSITE_PROJECT" | "RESOURCE_LIBRARY";
  metricCollectionState: CommercialQualificationBulkResult["state"];
  persistedCount: number;
  ranked: readonly CommercialQualificationRankedResult[];
}>;

type AuthoritativeQualification = Readonly<{
  decision: CommercialQualificationRankedResult["decision"];
  decisionReasonCode: string;
  marketDecision: CommercialQualificationRankedResult["marketDecision"];
  total: number | null;
}>;

type CommercialQualificationFactIdentity = Readonly<{
  candidateId: string;
  canonicalDomain: string;
  qualification: Omit<
    WriteQualificationFactInput["qualification"],
    "factId" | "attempt"
  >;
}>;

function metricRecordByDomain(
  metrics: CommercialQualificationBulkResult,
): ReadonlyMap<string, CommercialQualificationBulkRecord> {
  return new Map(metrics.records.map((item) => [
    item.canonicalDomain,
    item,
  ]));
}

function normalizeOptionalVersion(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function marketDecision(
  score: CommercialCandidateFitDecision,
): "allowed" | "mismatch" {
  return score.details.market.tier === "target_market"
    ? "allowed"
    : "mismatch";
}

function decisionReasonCode(
  score: CommercialCandidateFitDecision,
): string {
  const firstGate = score.hitGates[0];
  if (firstGate !== undefined) {
    return `COMMERCIAL_FIT_V4_HARD_GATE_${firstGate.toUpperCase()}`;
  }
  if (score.decision === "eligible") {
    return score.missingEvidence.length === 0
      ? "COMMERCIAL_FIT_V4_ELIGIBLE"
      : "COMMERCIAL_FIT_V4_ELIGIBLE_PARTIAL_EVIDENCE";
  }
  if (score.decision === "manual_review") {
    return "COMMERCIAL_FIT_V4_MANUAL_REVIEW";
  }
  if (score.decision === "insufficient_data") {
    return "COMMERCIAL_FIT_V4_SAFETY_EVIDENCE_REQUIRED";
  }
  return "COMMERCIAL_FIT_V4_BELOW_THRESHOLD";
}

function qualificationResult(
  candidate: CommercialQualificationCandidate,
  metricState: CommercialQualificationBulkResult["state"],
): AuthoritativeQualification {
  const score = candidate.commercialScore;
  if (metricState === "unknown_charge") {
    return Object.freeze({
      decision: "insufficient_data",
      decisionReasonCode: "DATAFORSEO_QUALIFICATION_UNKNOWN_CHARGE",
      marketDecision: marketDecision(score),
      total: null,
    });
  }
  return Object.freeze({
    decision: score.decision,
    decisionReasonCode: decisionReasonCode(score),
    marketDecision: marketDecision(score),
    total: score.total,
  });
}

function rankResults(
  results: readonly Readonly<{
    qualification: AuthoritativeQualification;
    summary: CommercialQualificationRankedResult;
  }>[],
): readonly CommercialQualificationRankedResult[] {
  return Object.freeze(
    [...results]
      .sort(
        (left, right) =>
          (right.qualification.total ?? -1) -
            (left.qualification.total ?? -1) ||
          left.summary.canonicalDomain.localeCompare(
            right.summary.canonicalDomain,
            "en",
          ),
      )
      .map(({ summary }) => summary),
  );
}

export async function persistCommercialQualificationFacts(
  input: Readonly<{
    scope: RecommendationContractScope;
    generationContractId: string;
    sourceKind: CommercialQualificationResult["sourceKind"];
    candidates: readonly CommercialQualificationCandidate[];
    metrics: CommercialQualificationBulkResult;
    repository: Pick<
      RecommendationContractPort,
      "writeQualificationFact"
    >;
    createdBy: string;
    observedAt?: Date;
    newId?: (identity: CommercialQualificationFactIdentity) => string;
    freshMetricsRole?: "qualification_authority" | "evidence_only";
  }>,
): Promise<CommercialQualificationResult> {
  const observedAt = input.observedAt ?? new Date();
  const newId = input.newId ?? (() => randomUUID());
  const freshMetricsRole =
    input.freshMetricsRole ?? "qualification_authority";
  const metricsByDomain = metricRecordByDomain(input.metrics);
  const evaluated: Array<Readonly<{
    qualification: AuthoritativeQualification;
    summary: CommercialQualificationRankedResult;
  }>> = [];

  for (const candidate of input.candidates) {
    if (!Number.isInteger(candidate.attempt) || candidate.attempt < 1) {
      throw new TypeError("Qualification attempt must be positive.");
    }
    if (
      candidate.commercialScore.scoreModelVersion !==
        commercialRecommendationFitModelVersion ||
      candidate.commercialScore.ruleVersion !==
        commercialRecommendationFitRuleVersion
    ) {
      throw new TypeError("Qualification evidence requires the current V4 score.");
    }
    const canonicalDomain = createRecommendationDomainKey(
      candidate.canonicalDomain,
    ).registrableDomain;
    const metric = metricsByDomain.get(canonicalDomain);
    if (metric === undefined) {
      throw new Error(
        `Qualification metrics are missing for ${canonicalDomain}.`,
      );
    }
    const score = candidate.commercialScore;
    const qualification = qualificationResult(
      candidate,
      input.metrics.state,
    );
    const result: CommercialQualificationRankedResult = Object.freeze({
      candidateId: candidate.candidateId,
      hostnameAscii: canonicalDomain,
      canonicalDomain,
      decision: qualification.decision,
      decisionReasonCode: qualification.decisionReasonCode,
      marketDecision: qualification.marketDecision,
      total: qualification.total,
      appliedThreshold: commercialFitBaselineAdmissionThreshold,
      trafficOrganicEtv: metric.trafficOrganicEtv,
      spamScore: metric.spamScore,
      authorityRank: metric.authorityRank,
      trafficState: metric.trafficState,
      spamState: metric.spamState,
      rankState: metric.rankState,
      requestFingerprints: metric.requestFingerprints,
    });
    evaluated.push(Object.freeze({
      qualification,
      summary: result,
    }));
    const qualificationFact = Object.freeze({
      metricScope: input.metrics.metricScope,
      trafficOrganicEtv: metric.trafficOrganicEtv,
      spamScore: metric.spamScore,
      authorityRank: metric.authorityRank,
      accessibilityDecision: candidate.accessibility.decision,
      semanticScore: qualification.total,
      decision: qualification.decision,
      decisionReasonCode: qualification.decisionReasonCode,
      modelVersion: normalizeOptionalVersion(candidate.semantic.modelVersion),
      promptVersion: normalizeOptionalVersion(
        candidate.semantic.promptVersion,
      ),
      ruleVersion: score.ruleVersion,
      requestFingerprints: metric.requestFingerprints,
      evidence: {
        mode: "authoritative",
        sourceKind: input.sourceKind,
        metricCollectionState: input.metrics.state,
        freshMetricsRole,
        freshMetrics: {
          trafficOrganicEtv: metric.trafficOrganicEtv,
          spamScore: metric.spamScore,
          authorityRank: metric.authorityRank,
          states: {
            traffic: metric.trafficState,
            spam: metric.spamState,
            rank: metric.rankState,
          },
        },
        qualificationPolicy: {
          scoreModelVersion: score.scoreModelVersion,
          ruleVersion: score.ruleVersion,
          trafficIsRankingOnly: true,
          spamReviewMinimum: commercialFitSpamReviewMinimum,
          spamHardRejectMinimum: commercialFitSpamHardRejectMinimum,
          finalAdmissionThreshold: commercialFitBaselineAdmissionThreshold,
          partialEvidenceAllowed: true,
          decision: qualification.decision,
          decisionReasonCode: qualification.decisionReasonCode,
        },
        screeningPolicy: {
          policyVersion: score.admission.policyVersion,
          scoreModelVersion: score.scoreModelVersion,
          ruleVersion: score.ruleVersion,
          sourceDecision: score.decision,
          total: score.total,
          components: score.components,
          hitGates: score.hitGates,
          missingEvidence: score.missingEvidence,
          admission: score.admission,
          reasonCodes: score.details.reasonCodes,
          marketTier: score.details.market.tier,
        },
        accessibility: candidate.accessibility.evidence,
        semantic: candidate.semantic.evidence,
        evidenceRefs: [...candidate.evidenceRefs],
      },
    }) satisfies Omit<
      WriteQualificationFactInput["qualification"],
      "factId" | "attempt"
    >;
    await input.repository.writeQualificationFact({
      ...input.scope,
      generationContractId: input.generationContractId,
      workerContractVersion: CORRECTED_QUALIFICATION_CONTRACT_VERSION,
      candidateId: candidate.candidateId,
      canonicalDomain,
      qualification: {
        factId: newId({
          candidateId: candidate.candidateId,
          canonicalDomain,
          qualification: qualificationFact,
        }),
        ...qualificationFact,
        attempt: candidate.attempt,
      },
      observedAt,
      createdBy: input.createdBy,
    });
  }

  return Object.freeze({
    mode: "authoritative",
    sourceKind: input.sourceKind,
    metricCollectionState: input.metrics.state,
    persistedCount: evaluated.length,
    ranked: rankResults(evaluated),
  });
}
