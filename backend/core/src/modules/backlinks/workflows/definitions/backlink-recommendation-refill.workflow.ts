import { proxyActivities } from "@temporalio/workflow";

import type {
  BacklinkRecommendationRefillActivities,
  BacklinkRecommendationRefillInput,
  BacklinkRecommendationRefillResult,
} from "./backlink-recommendation-refill.orchestration.js";
import {
  runBacklinkRecommendationRefillWorkflow,
} from "./backlink-recommendation-refill.orchestration.js";

type DurableWorkflowActivities = Readonly<{
  backlinksReserveRecommendationRefillV1:
    BacklinkRecommendationRefillActivities["reserveRecommendationRefill"];
  backlinksStoreReadyRecommendationsV1:
    BacklinkRecommendationRefillActivities["storeReadyRecommendations"];
  backlinksRecordRecommendationRefillFailureV1:
    BacklinkRecommendationRefillActivities["recordRecommendationRefillFailure"];
}>;
type ProviderWorkflowActivities = Readonly<{
  backlinksExecuteRecommendationRefillV1:
    BacklinkRecommendationRefillActivities["executeRecommendationRefill"];
}>;
const durableActivities = proxyActivities<DurableWorkflowActivities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 3 },
});
const providerActivities = proxyActivities<ProviderWorkflowActivities>({
  startToCloseTimeout: "4 minutes",
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
    recordRecommendationRefillFailure:
      durableActivities.backlinksRecordRecommendationRefillFailureV1,
  });
}
