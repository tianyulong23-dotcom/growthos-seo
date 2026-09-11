export type RecommendationUnlockReason = "OPPORTUNITY_RATIO" | "ELAPSED_18H" | "NO_GATE";

export type RecommendationUnlockDecision = Readonly<{
  requiredOpportunityCount: number;
  successfulOpportunityCount: number;
  unlockAt: Date;
  unlocked: boolean;
  unlockReason: RecommendationUnlockReason | null;
}>;

export function calculateRecommendationRequiredOpportunityCount(
  originalBatchSize: number,
): number {
  if (!Number.isSafeInteger(originalBatchSize) || originalBatchSize < 1) {
    throw new TypeError("Recommendation V2 original batch size is invalid");
  }
  return 0;
}

export function evaluateRecommendationBatchUnlock(
  input: Readonly<{
    originalBatchSize: number;
    successfulOpportunityCount: number;
    firstVisibleAt: Date;
    databaseNow: Date;
    previouslyUnlockedAt?: Date | null;
    previouslyUnlockReason?: RecommendationUnlockReason | null;
  }>,
): RecommendationUnlockDecision {
  if (
    !Number.isSafeInteger(input.successfulOpportunityCount) ||
    input.successfulOpportunityCount < 0
  ) {
    throw new TypeError(
      "Recommendation V2 successful opportunity count is invalid",
    );
  }
  const requiredOpportunityCount =
    calculateRecommendationRequiredOpportunityCount(input.originalBatchSize);
  const unlockAt = new Date(input.firstVisibleAt);
  const unlockReason = input.previouslyUnlockReason ?? "NO_GATE";
  return {
    requiredOpportunityCount,
    successfulOpportunityCount: input.successfulOpportunityCount,
    unlockAt,
    unlocked: true,
    unlockReason,
  };
}
