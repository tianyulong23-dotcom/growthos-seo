export type CommercialInventoryPolicy = Readonly<{
  candidateLowWatermark: number;
  candidateHighWatermark: number;
  publishedLowWatermark: number;
  publishedHighWatermark: number;
  minimumEmailHitRate: number;
  maximumEmailHitRate: number;
}>;

export type CommercialInventoryDecision = Readonly<{
  shouldRefill: boolean;
  requestedCandidateCount: number;
  effectiveEmailHitRate: number;
  pauseReason: "inflight" | "cooldown" | "budget" | null;
}>;

function assertWatermarks(low: number, high: number, name: string): void {
  if (!Number.isInteger(low) || !Number.isInteger(high) || low < 0 || high <= low) {
    throw new TypeError(`${name} watermarks are invalid`);
  }
}

export function decideCommercialInventoryRefill(input: Readonly<{
  policy: CommercialInventoryPolicy;
  candidateReadyCount: number;
  publishedContactReadyCount: number;
  historicalVerifiedEmailCount: number;
  historicalCandidateCount: number;
  inflight: boolean;
  cooldownActive: boolean;
  budgetAvailable: boolean;
}>): CommercialInventoryDecision {
  const policy = input.policy;
  assertWatermarks(
    policy.candidateLowWatermark,
    policy.candidateHighWatermark,
    "candidate",
  );
  assertWatermarks(
    policy.publishedLowWatermark,
    policy.publishedHighWatermark,
    "published",
  );
  if (
    policy.minimumEmailHitRate <= 0
    || policy.maximumEmailHitRate > 1
    || policy.maximumEmailHitRate < policy.minimumEmailHitRate
  ) {
    throw new TypeError("email hit-rate caps are invalid");
  }
  const observedRate = input.historicalCandidateCount > 0
    ? input.historicalVerifiedEmailCount / input.historicalCandidateCount
    : policy.minimumEmailHitRate;
  const effectiveEmailHitRate = Math.min(
    policy.maximumEmailHitRate,
    Math.max(policy.minimumEmailHitRate, observedRate),
  );
  const candidateDeficit = Math.max(
    0,
    policy.candidateHighWatermark - input.candidateReadyCount,
  );
  const publishedDeficit = Math.max(
    0,
    policy.publishedHighWatermark - input.publishedContactReadyCount,
  );
  const publishedOverfetch = Math.ceil(publishedDeficit / effectiveEmailHitRate);
  const inventoryLow =
    input.candidateReadyCount < policy.candidateLowWatermark
    || input.publishedContactReadyCount < policy.publishedLowWatermark;
  const pauseReason = input.inflight
    ? "inflight" as const
    : input.cooldownActive
      ? "cooldown" as const
      : !input.budgetAvailable ? "budget" as const : null;

  return Object.freeze({
    shouldRefill: inventoryLow && pauseReason === null,
    requestedCandidateCount: inventoryLow
      ? Math.max(candidateDeficit, publishedOverfetch)
      : 0,
    effectiveEmailHitRate,
    pauseReason,
  });
}
