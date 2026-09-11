import { createHash } from "node:crypto";

export const recommendationBatchSelectionPolicyVersion =
  "recommendation-batch-selection.v1";
export const recommendationHybridBatchSelectionPolicyVersion =
  "recommendation-batch-selection.hybrid.v2";

export type RecommendationBatchOrderingCandidate = Readonly<{
  id: string;
  canonicalDomain: string;
  recommended: boolean;
  recommendationReasonStrengthBand: number;
  evidenceCompleteness: number;
}>;

function assertCandidateCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000) {
    throw new TypeError("Recommendation V2 candidate count is invalid");
  }
}

export function calculateRecommendationBatchSize(
  effectiveUniqueCandidateCount: number,
): number {
  assertCandidateCount(effectiveUniqueCandidateCount);
  if (effectiveUniqueCandidateCount < 25) {
    return effectiveUniqueCandidateCount;
  }
  return Math.min(100, Math.ceil(effectiveUniqueCandidateCount / 5));
}

export function calculateRecommendationBatchCount(
  effectiveUniqueCandidateCount: number,
): number {
  const batchSize = calculateRecommendationBatchSize(
    effectiveUniqueCandidateCount,
  );
  return batchSize === 0
    ? 0
    : Math.ceil(effectiveUniqueCandidateCount / batchSize);
}

export function orderRecommendationBatchCandidates(
  candidates: readonly RecommendationBatchOrderingCandidate[],
): readonly RecommendationBatchOrderingCandidate[] {
  const domains = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.canonicalDomain !== candidate.canonicalDomain.toLowerCase()) {
      throw new TypeError("Recommendation V2 canonical domain is invalid");
    }
    if (domains.has(candidate.canonicalDomain)) {
      throw new TypeError("Recommendation V2 canonical domain is duplicated");
    }
    domains.add(candidate.canonicalDomain);
  }
  return [...candidates].sort(
    (left, right) =>
      Number(right.recommended) - Number(left.recommended) ||
      right.recommendationReasonStrengthBand -
        left.recommendationReasonStrengthBand ||
      right.evidenceCompleteness - left.evidenceCompleteness ||
      left.canonicalDomain.localeCompare(right.canonicalDomain) ||
      left.id.localeCompare(right.id),
  );
}

export function buildRecommendationOrderFingerprint(
  candidates: readonly RecommendationBatchOrderingCandidate[],
): string {
  const ordered = orderRecommendationBatchCandidates(candidates);
  return createHash("sha256")
    .update(
      JSON.stringify({
        policyVersion: recommendationBatchSelectionPolicyVersion,
        order: ordered.map((candidate, position) => ({
          position: position + 1,
          id: candidate.id,
          canonicalDomain: candidate.canonicalDomain,
          recommended: candidate.recommended,
          recommendationReasonStrengthBand:
            candidate.recommendationReasonStrengthBand,
          evidenceCompleteness: candidate.evidenceCompleteness,
        })),
      }),
    )
    .digest("hex");
}

export function buildRecommendationBatchFingerprint(
  input: Readonly<{
    ordinal: number;
    candidates: readonly RecommendationBatchOrderingCandidate[];
  }>,
): string {
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) {
    throw new TypeError("Recommendation V2 batch ordinal is invalid");
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        policyVersion: recommendationBatchSelectionPolicyVersion,
        ordinal: input.ordinal,
        order: input.candidates.map((candidate, position) => ({
          position: position + 1,
          id: candidate.id,
          canonicalDomain: candidate.canonicalDomain,
        })),
      }),
    )
    .digest("hex");
}

export function partitionRecommendationBatches(
  candidates: readonly RecommendationBatchOrderingCandidate[],
): readonly (readonly RecommendationBatchOrderingCandidate[])[] {
  const ordered = orderRecommendationBatchCandidates(candidates);
  const batchSize = calculateRecommendationBatchSize(ordered.length);
  if (batchSize === 0) {
    return [];
  }
  const batches: RecommendationBatchOrderingCandidate[][] = [];
  for (let index = 0; index < ordered.length; index += batchSize) {
    batches.push(ordered.slice(index, index + batchSize));
  }
  return batches;
}

export type RecommendationHybridBatchAllocation = Readonly<{
  ordinal: number;
  dataForSeoCount: number;
  resourceLibraryCount: number;
}>;

export type RecommendationHybridOrderingCandidate =
  RecommendationBatchOrderingCandidate & Readonly<{
    sourceType?: "DATAFORSEO" | "CURATED_RESOURCE_LIBRARY";
    resourceBatchOrdinal?: number;
  }>;

export function partitionRecommendationHybridBatches<T extends RecommendationHybridOrderingCandidate>(
  candidates: readonly T[],
): readonly (readonly T[])[] {
  assertCandidateCount(candidates.length);
  const ordered = orderRecommendationBatchCandidates(candidates) as readonly T[];
  const dfs = ordered.filter((item) => item.sourceType !== "CURATED_RESOURCE_LIBRARY");
  const library = ordered.filter((item) => item.sourceType === "CURATED_RESOURCE_LIBRARY");
  const allocation = planRecommendationHybridBatchAllocation({
    dataForSeoCount: dfs.length, resourceLibraryCount: library.length,
  });
  const reserved = library.some((item) => item.resourceBatchOrdinal !== undefined);
  if (reserved && library.some((item) =>
    typeof item.resourceBatchOrdinal !== "number"
    || !Number.isSafeInteger(item.resourceBatchOrdinal) || item.resourceBatchOrdinal < 1
    || item.resourceBatchOrdinal > 10)) {
    throw new TypeError("Hybrid library batch reservation is invalid");
  }
  let dfsOffset = 0;
  let libraryOffset = 0;
  const batchCount = Math.max(allocation.length,
    ...library.map((item) => item.resourceBatchOrdinal ?? 0));
  const result: T[][] = [];
  for (let index = 0; index < batchCount; index += 1) {
    const count = allocation[index]?.dataForSeoCount ?? 0;
    const libraryCount = allocation[index]?.resourceLibraryCount ?? 0;
    const libraryItems = reserved
      ? library.filter((item) => item.resourceBatchOrdinal === index + 1)
      : library.slice(libraryOffset, libraryOffset + libraryCount);
    const items = [...dfs.slice(dfsOffset, dfsOffset + count), ...libraryItems];
    if (items.length > 100) throw new TypeError("Hybrid batch exceeds capacity");
    if (items.length > 0) result.push(items);
    dfsOffset += count;
    libraryOffset += libraryCount;
  }
  return result;
}

export function buildRecommendationHybridBatchFingerprint(input: Readonly<{
  ordinal: number;
  candidates: readonly RecommendationBatchOrderingCandidate[];
}>): string {
  return createHash("sha256").update(JSON.stringify({
    policyVersion: recommendationHybridBatchSelectionPolicyVersion,
    ordinal: input.ordinal,
    order: input.candidates.map((candidate, index) => ({
      position: index + 1, id: candidate.id, canonicalDomain: candidate.canonicalDomain,
    })),
  })).digest("hex");
}

export function buildRecommendationHybridOrderFingerprint(
  batches: readonly (readonly RecommendationBatchOrderingCandidate[])[],
): string {
  return createHash("sha256").update(JSON.stringify({
    policyVersion: recommendationHybridBatchSelectionPolicyVersion,
    batches: batches.map((candidates, index) =>
      buildRecommendationHybridBatchFingerprint({ ordinal: index + 1, candidates })),
  })).digest("hex");
}

// Supply must already be qualified, deduplicated and bounded to one generation.
// This plans the entire snapshot, not a retry against remaining inventory.
export function planRecommendationHybridBatchAllocation(
  input: Readonly<{
    dataForSeoCount: number;
    resourceLibraryCount: number;
  }>,
): readonly RecommendationHybridBatchAllocation[] {
  assertCandidateCount(input.dataForSeoCount);
  assertCandidateCount(input.resourceLibraryCount);
  assertCandidateCount(input.dataForSeoCount + input.resourceLibraryCount);

  const initialDataForSeoCount = Math.min(input.dataForSeoCount, 200);
  let dataForSeoRemaining = input.dataForSeoCount;
  let libraryRemaining = input.resourceLibraryCount;
  const batches: RecommendationHybridBatchAllocation[] = [];
  while (dataForSeoRemaining + libraryRemaining > 0) {
    const ordinal = batches.length + 1;
    const dataForSeoCount = ordinal === 1
      ? Math.ceil(initialDataForSeoCount / 2)
      : ordinal === 2
        ? Math.floor(initialDataForSeoCount / 2)
        : Math.min(dataForSeoRemaining, 100);
    const resourceLibraryCount = Math.min(libraryRemaining, 100 - dataForSeoCount);
    batches.push({ ordinal, dataForSeoCount, resourceLibraryCount });
    dataForSeoRemaining -= dataForSeoCount;
    libraryRemaining -= resourceLibraryCount;
  }
  return batches;
}
