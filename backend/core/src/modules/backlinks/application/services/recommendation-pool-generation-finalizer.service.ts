import {
  buildRecommendationBatchFingerprint,
  buildRecommendationOrderFingerprint,
  partitionRecommendationBatches,
  partitionRecommendationHybridBatches,
  buildRecommendationHybridBatchFingerprint,
  buildRecommendationHybridOrderFingerprint,
  type RecommendationHybridOrderingCandidate,
  type RecommendationBatchOrderingCandidate,
} from "../../domain/recommendations/recommendation-batch-policy.js";
import type { RecommendationDiscoveryStopReason } from "../../domain/recommendations/recommendation-pool-v2-policy.js";
import { excludedOutreachTarget } from "../../domain/recommendations/outreach-target-policy.js";

export type RecommendationFinalizationCandidate =
  RecommendationBatchOrderingCandidate & RecommendationHybridOrderingCandidate &
    Readonly<{
      recommendationId: string;
      prospectId: string;
      inventoryId: string;
      generationContractId: string;
      inputPinId: string;
      recommendationContextVersionId: string;
    }>;

export type RecommendationCanonicalBatch = Readonly<{
  ordinal: number;
  originalSize: number;
  orderFingerprint: string;
  items: readonly Readonly<{
    position: number;
    candidate: RecommendationFinalizationCandidate;
  }>[];
}>;

function assertCanonicalLineage(
  candidate: RecommendationFinalizationCandidate,
): void {
  const identifiers = [
    candidate.id,
    candidate.recommendationId,
    candidate.prospectId,
    candidate.inventoryId,
    candidate.generationContractId,
    candidate.inputPinId,
    candidate.recommendationContextVersionId,
  ];
  if (identifiers.some((value) => value.trim().length === 0)) {
    throw new TypeError("Recommendation V2 canonical lineage is incomplete");
  }
}

export function finalizeRecommendationGeneration(
  input: Readonly<{
    candidates: readonly RecommendationFinalizationCandidate[];
    terminalReason: RecommendationDiscoveryStopReason;
    completedAt: Date;
    allocationPolicy?: "hybrid";
  }>,
): Readonly<{
  effectiveUniqueCandidateCount: number;
  canonicalBatchSize: number;
  canonicalBatchCount: number;
  canonicalOrderFingerprint: string;
  discoveryTerminalReason: RecommendationDiscoveryStopReason;
  discoveryCompletedAt: Date;
  batches: readonly RecommendationCanonicalBatch[];
}> {
  for (const candidate of input.candidates) {
    assertCanonicalLineage(candidate);
  }
  // Filter the complete supply before ordering and partitioning so rejected
  // targets never consume a release slot or affect the effective pool size.
  const eligibleCandidates = input.candidates.filter(
    (candidate) => excludedOutreachTarget(candidate.canonicalDomain) === null,
  );
  const hybrid = input.allocationPolicy === "hybrid";
  const partitions = hybrid
    ? partitionRecommendationHybridBatches(eligibleCandidates)
    : partitionRecommendationBatches(eligibleCandidates);
  const batches = partitions.map((batch, batchIndex) =>
    Object.freeze({
      ordinal: batchIndex + 1,
      originalSize: batch.length,
      orderFingerprint: (hybrid ? buildRecommendationHybridBatchFingerprint : buildRecommendationBatchFingerprint)({
        ordinal: batchIndex + 1,
        candidates: batch,
      }),
      items: Object.freeze(
        batch.map((candidate, itemIndex) =>
          Object.freeze({
            position: itemIndex + 1,
            candidate: candidate as RecommendationFinalizationCandidate,
          }),
        ),
      ),
    }),
  );
  return Object.freeze({
    effectiveUniqueCandidateCount: eligibleCandidates.length,
    canonicalBatchSize: hybrid
      ? Math.max(0, ...partitions.map((batch) => batch.length))
      : partitions[0]?.length ?? 0,
    canonicalBatchCount: partitions.length,
    canonicalOrderFingerprint: hybrid
      ? buildRecommendationHybridOrderFingerprint(partitions)
      : buildRecommendationOrderFingerprint(eligibleCandidates),
    discoveryTerminalReason: input.terminalReason,
    discoveryCompletedAt: new Date(input.completedAt),
    batches: Object.freeze(batches),
  });
}
