import {
  CancellationScope,
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";

import type {
  BacklinkRecommendationRefillActivities,
  BacklinkRecommendationRefillInput,
  BacklinkRecommendationRefillResult,
  RecommendationRefillSupersessionSignal,
} from "./backlink-recommendation-refill.orchestration.js";
import { runBacklinkRecommendationRefillWorkflow } from "./backlink-recommendation-refill.orchestration.js";
import { backlinksRuntimeContract } from "../namespaces.js";

type DurableWorkflowActivities = Readonly<{
  backlinksReserveRecommendationRefillV1: BacklinkRecommendationRefillActivities["reserveRecommendationRefill"];
  backlinksStoreReadyRecommendationsV1: BacklinkRecommendationRefillActivities["storeReadyRecommendations"];
  backlinksPlanRecommendationRefillSupplyV1: BacklinkRecommendationRefillActivities["planRecommendationRefillSupply"];
  backlinksCompleteRecommendationRefillSupplyV1: BacklinkRecommendationRefillActivities["completeRecommendationRefillSupply"];
  backlinksCompleteRecommendationRefillSupersessionV1: BacklinkRecommendationRefillActivities["completeRecommendationRefillSupersession"];
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
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 2 },
});
const supersededSignal = defineSignal<[RecommendationRefillSupersessionSignal]>(
  backlinksRuntimeContract.signals.recommendationRefillSuperseded,
);
const supersessionStatusQuery =
  defineQuery<RecommendationRefillSupersessionSignal | null>(
    backlinksRuntimeContract.queries.recommendationRefillSupersessionStatus,
  );

export async function backlinksRecommendationRefillV1Workflow(
  input: BacklinkRecommendationRefillInput,
): Promise<BacklinkRecommendationRefillResult> {
  let supersession = input.continuation?.supersession;
  let providerActivityScope: CancellationScope | undefined;
  let enableProviderActivityCancellation = false;
  setHandler(supersededSignal, (candidate) => {
    const matchesWorkflow = candidate.contractVersion === 1
      && candidate.organizationId === input.organizationId
      && candidate.workspaceId === input.workspaceId
      && candidate.websiteProjectId === input.websiteProjectId
      && candidate.jobId === input.jobId
      && candidate.workflowId === input.workflowId
      && candidate.oldContext.contextVersionId
        === input.recommendationContextVersionId
      && candidate.authoritativeContext.snapshotVersion
        > candidate.oldContext.snapshotVersion;
    if (!matchesWorkflow) return;
    supersession = candidate;
    if (enableProviderActivityCancellation) {
      providerActivityScope?.cancel();
    }
  });
  setHandler(supersessionStatusQuery, () => supersession ?? null);
  const enableNoProgressGuard = patched(
    "backlinks-recommendation-refill-no-progress-v1",
  );
  const enableRefillCycleHistoryGuard = patched(
    "backlinks-recommendation-refill-cycle-history-v1",
  );
  const enableBudgetTerminal = patched(
    "backlinks-recommendation-refill-budget-terminal-v1",
  );
  const allowExistingEvidenceWindowReplay = patched(
    "backlinks-recommendation-refill-existing-window-replay-v1",
  );
  const enforceExistingEvidenceWindowOnce = patched(
    "backlinks-recommendation-refill-existing-window-once-v2",
  );
  enableProviderActivityCancellation = patched(
    "backlinks-recommendation-refill-provider-cancellation-v1",
  );
  const result = await runBacklinkRecommendationRefillWorkflow(input, {
    reserveRecommendationRefill:
      durableActivities.backlinksReserveRecommendationRefillV1,
    executeRecommendationRefill: async (activityInput) => {
      if (!enableProviderActivityCancellation) {
        return providerActivities.backlinksExecuteRecommendationRefillV1(
          activityInput,
        );
      }
      const scope = new CancellationScope();
      providerActivityScope = scope;
      try {
        return await scope.run(() =>
          providerActivities.backlinksExecuteRecommendationRefillV1(
            activityInput,
          )
        );
      } finally {
        if (providerActivityScope === scope) {
          providerActivityScope = undefined;
        }
      }
    },
    storeReadyRecommendations:
      durableActivities.backlinksStoreReadyRecommendationsV1,
    planRecommendationRefillSupply:
      durableActivities.backlinksPlanRecommendationRefillSupplyV1,
    completeRecommendationRefillSupply:
      durableActivities.backlinksCompleteRecommendationRefillSupplyV1,
    completeRecommendationRefillSupersession:
      durableActivities.backlinksCompleteRecommendationRefillSupersessionV1,
    waitForRecommendationRefillRetry: async ({ retryAfterMs }) =>
      void await condition(() => supersession !== undefined, retryAfterMs),
    recordRecommendationRefillFailure:
      durableActivities.backlinksRecordRecommendationRefillFailureV1,
  }, {
    enableNoProgressGuard,
    enableRefillCycleHistoryGuard,
    enableBudgetTerminal,
    allowExistingEvidenceWindowReplay,
    enforceExistingEvidenceWindowOnce,
    completeExistingEvidenceWindow: () => patched(
      "backlinks-recommendation-refill-existing-window-terminal-v1",
    ),
    readSupersession: () => supersession,
  });
  if (result.status === "continue_as_new") {
    return continueAsNew<typeof backlinksRecommendationRefillV1Workflow>(
      result.input,
    );
  }
  return result;
}
