import { evaluateRecommendationBatchUnlock } from "../../domain/recommendations/recommendation-user-unlock-policy.js";

export function evaluateRecommendationUserRelease(
  input: Readonly<{
    originalBatchSize: number;
    successfulOpportunityCount: number;
    firstVisibleAt: Date;
    databaseNow: Date;
    previouslyUnlockedAt: Date | null;
    previouslyUnlockReason: "OPPORTUNITY_RATIO" | "ELAPSED_18H" | "NO_GATE" | null;
    nextBatchState: "AVAILABLE" | "PREPARING" | "NONE";
  }>,
): Readonly<{
  requiredOpportunityCount: number;
  successfulOpportunityCount: number;
  unlockAt: Date;
  unlockReason: "OPPORTUNITY_RATIO" | "ELAPSED_18H" | "NO_GATE" | null;
  canGetMore: boolean;
  getMoreState:
    | "RELEASE_NEXT"
    | "NOT_UNLOCKED"
    | "NEXT_BATCH_PREPARING"
    | "POOL_EXHAUSTED";
}> {
  const unlock = evaluateRecommendationBatchUnlock(input);
  const getMoreState = !unlock.unlocked
    ? "NOT_UNLOCKED"
    : input.nextBatchState === "AVAILABLE"
      ? "RELEASE_NEXT"
      : input.nextBatchState === "PREPARING"
        ? "NEXT_BATCH_PREPARING"
        : "POOL_EXHAUSTED";
  return Object.freeze({
    requiredOpportunityCount: unlock.requiredOpportunityCount,
    successfulOpportunityCount: unlock.successfulOpportunityCount,
    unlockAt: unlock.unlockAt,
    unlockReason: unlock.unlockReason,
    canGetMore: getMoreState === "RELEASE_NEXT",
    getMoreState,
  });
}
