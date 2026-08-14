import { proxyActivities, sleep } from "@temporalio/workflow";

import type {
  BacklinkRecommendationRefillActivities,
  BacklinkRecommendationRefillInput,
  BacklinkRecommendationRefillResult,
} from "./backlink-recommendation-refill.orchestration.js";
import { runBacklinkRecommendationRefillWorkflow } from "./backlink-recommendation-refill.orchestration.js";

type DurableWorkflowActivities = Readonly<{
  backlinksReserveRecommendationRefillV1: BacklinkRecommendationRefillActivities["reserveRecommendationRefill"];
  backlinksStoreReadyRecommendationsV1: BacklinkRecommendationRefillActivities["storeReadyRecommendations"];
  backlinksPlanRecommendationRefillSupplyV1: BacklinkRecommendationRefillActivities["planRecommendationRefillSupply"];
  backlinksCompleteRecommendationRefillSupplyV1: BacklinkRecommendationRefillActivities["completeRecommendationRefillSupply"];
  backlinksRecordRecommendationRefillFailureV1: BacklinkRecommendationRefillActivities["recordRecommendationRefillFailure"];
}>;
type ProviderWorkflowActivities = Readonly<{
  backlinksExecuteRecommendationRefillV1: BacklinkRecommendationRefillActivities["executeRecommendationRefill"];
}>;
const durableActivities = proxyActivities<DurableWorkflowActivities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 3 },
});
const providerActivities = proxyActivities<ProviderWorkflowActivities>({
  startToCloseTimeout: "2 hours",
  retry: { maximumAttempts: 1 },
});

export async function backlinksRecommendationRefillV1Workflow(
  input: BacklinkRecommendationRefillInput,
): Promise<BacklinkRecommendationRefillResult> {
  return runBacklinkRecommendationRefillWorkflow(input, {
    reserveRecommendationRefill:
      durableActivities.backlinksReserveRecommendationRefillV1,
    executeRecommendationRefill:
      providerActivities.backlinksExecuteRecommendationRefillV1,
    storeReadyRecommendations:
      durableActivities.backlinksStoreReadyRecommendationsV1,
    planRecommendationRefillSupply:
      durableActivities.backlinksPlanRecommendationRefillSupplyV1,
    completeRecommendationRefillSupply:
      durableActivities.backlinksCompleteRecommendationRefillSupplyV1,
    waitForRecommendationRefillRetry: async ({ retryAfterMs }) =>
      sleep(retryAfterMs),
    recordRecommendationRefillFailure:
      durableActivities.backlinksRecordRecommendationRefillFailureV1,
  });
}
