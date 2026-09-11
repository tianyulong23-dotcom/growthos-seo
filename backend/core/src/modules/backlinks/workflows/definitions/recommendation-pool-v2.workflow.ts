import {
  condition,
  defineQuery,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";

import {
  runRecommendationPoolV2Workflow,
  type RecommendationPoolV2Supersession,
  type RecommendationPoolV2WorkflowActivities,
  type RecommendationPoolV2WorkflowResult,
} from "../../application/services/recommendation-pool-v2-workflow.service.js";
import { backlinksRuntimeContract } from "../namespaces.js";
import { recommendationPoolV2PublicationPollingPolicy } from "../../domain/recommendations/recommendation-pool-v2-policy.js";
import type { RecommendationPoolV2WorkflowInput } from "../recommendation-pool-v2.starter.js";

type DurableActivities = Readonly<{
  backlinksLoadRecommendationPoolV2Generation: RecommendationPoolV2WorkflowActivities["loadGeneration"];
  backlinksExecuteRecommendationPoolV2DiscoveryRound: RecommendationPoolV2WorkflowActivities["executeDiscoveryRound"];
  backlinksFinalizeRecommendationPoolV2Generation: RecommendationPoolV2WorkflowActivities["finalizeGeneration"];
  backlinksPrepareRecommendationPoolV2CanonicalBatches: RecommendationPoolV2WorkflowActivities["prepareCanonicalBatches"];
  backlinksInspectRecommendationPoolV2CanonicalBatchPreparation: RecommendationPoolV2WorkflowActivities["inspectCanonicalBatchPreparation"];
  backlinksConvergeRecommendationPoolV2CanonicalBatchPreparation: RecommendationPoolV2WorkflowActivities["convergeCanonicalBatchPreparation"];
  backlinksActivateRecommendationPoolV2Generation: RecommendationPoolV2WorkflowActivities["activateGeneration"];
  backlinksCompleteRecommendationPoolV2GenerationWithoutPublication: RecommendationPoolV2WorkflowActivities["completeGenerationWithoutPublication"];
  backlinksFailRecommendationPoolV2Generation: RecommendationPoolV2WorkflowActivities["failGeneration"];
  backlinksCompleteRecommendationPoolV2GenerationSupersession: RecommendationPoolV2WorkflowActivities["completeGenerationSupersession"];
}>;

export type RecommendationPoolV2TemporalResult =
  RecommendationPoolV2WorkflowResult;

export const recommendationPoolV2TerminalSemanticsPatchId =
  "backlinks-recommendation-pool-v2-terminal-semantics-v2";
export const recommendationPoolV2PublicationPollingPatchId =
  recommendationPoolV2PublicationPollingPolicy.version;

const activities = proxyActivities<DurableActivities>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 3 },
});
const supersededSignal = defineSignal<[RecommendationPoolV2Supersession]>(
  backlinksRuntimeContract.signals.recommendationPoolV2Superseded,
);
const supersessionStatusQuery =
  defineQuery<RecommendationPoolV2Supersession | null>(
    backlinksRuntimeContract.queries.recommendationPoolV2SupersessionStatus,
  );

function matchesWorkflow(
  input: RecommendationPoolV2WorkflowInput,
  supersession: RecommendationPoolV2Supersession,
): boolean {
  return (
    supersession.contractVersion === 2 &&
    supersession.organizationId === input.organizationId &&
    supersession.workspaceId === input.workspaceId &&
    supersession.websiteProjectId === input.websiteProjectId &&
    supersession.generationContractId === input.generationContractId &&
    supersession.oldRecommendationContextVersionId ===
      input.recommendationContextVersionId &&
    supersession.authoritativeRecommendationContextVersionId !==
      input.recommendationContextVersionId
  );
}

export async function backlinksRecommendationPoolV2Workflow(
  input: RecommendationPoolV2WorkflowInput,
): Promise<RecommendationPoolV2TemporalResult> {
  const terminalSemanticsVersion = patched(
    recommendationPoolV2TerminalSemanticsPatchId,
  )
    ? 2
    : 1;
  let supersession: RecommendationPoolV2Supersession | undefined;
  setHandler(supersededSignal, (candidate) => {
    if (matchesWorkflow(input, candidate)) supersession = candidate;
  });
  setHandler(supersessionStatusQuery, () => supersession ?? null);

  return runRecommendationPoolV2Workflow(
    input,
    {
      loadGeneration:
        activities.backlinksLoadRecommendationPoolV2Generation,
      executeDiscoveryRound:
        activities.backlinksExecuteRecommendationPoolV2DiscoveryRound,
      finalizeGeneration:
        activities.backlinksFinalizeRecommendationPoolV2Generation,
      prepareCanonicalBatches:
        activities.backlinksPrepareRecommendationPoolV2CanonicalBatches,
      inspectCanonicalBatchPreparation:
        activities.backlinksInspectRecommendationPoolV2CanonicalBatchPreparation,
      convergeCanonicalBatchPreparation:
        activities.backlinksConvergeRecommendationPoolV2CanonicalBatchPreparation,
      activateGeneration:
        activities.backlinksActivateRecommendationPoolV2Generation,
      completeGenerationWithoutPublication:
        activities.backlinksCompleteRecommendationPoolV2GenerationWithoutPublication,
      failGeneration:
        activities.backlinksFailRecommendationPoolV2Generation,
      completeGenerationSupersession:
        activities.backlinksCompleteRecommendationPoolV2GenerationSupersession,
    },
    {
      terminalSemanticsVersion,
      readSupersession: () => supersession,
      waitForPreparationPoll: async ({ delayMs }) => {
        const pollDelayMs = patched(recommendationPoolV2PublicationPollingPatchId)
          ? Math.min(delayMs, recommendationPoolV2PublicationPollingPolicy.pollIntervalMs)
          : delayMs;
        await condition(() => supersession !== undefined, pollDelayMs);
      },
    },
  );
}
