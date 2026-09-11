import type { RecommendationPoolV2DiscoveryRound } from "../application/services/recommendation-pool-v2-workflow.service.js";
import {
  assertBacklinksTaskQueue,
  backlinksRuntimeContract,
  buildBacklinksWorkflowId,
} from "./namespaces.js";

type TemporalWorkflowClient = Readonly<{
  start(
    type: string,
    options: Readonly<{
      workflowId: string;
      taskQueue: string;
      args: readonly unknown[];
    }>,
  ): Promise<unknown>;
}>;

export type RecommendationPoolV2WorkflowLaunchInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  generationContractId: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  inputPinId: string;
  actorId: string;
  jobId: string;
  rounds: readonly RecommendationPoolV2DiscoveryRound[];
}>;

export type RecommendationPoolV2WorkflowInput =
  RecommendationPoolV2WorkflowLaunchInput &
    Readonly<{
      workflowId: string;
    }>;

export type RecommendationPoolV2WorkflowStartResult = Readonly<{
  workflowId: string;
  status: "started" | "already_started";
}>;

const workflowAlreadyStarted = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "WorkflowExecutionAlreadyStartedError" ||
    /workflow execution.*already (?:started|exists)/iu.test(error.message));

export function createTemporalRecommendationPoolV2Starter(
  client: TemporalWorkflowClient,
  taskQueue: string,
): Readonly<{
  start(
    input: RecommendationPoolV2WorkflowLaunchInput,
  ): Promise<RecommendationPoolV2WorkflowStartResult>;
}> {
  assertBacklinksTaskQueue(taskQueue);
  return Object.freeze({
    async start(input) {
      const workflowId = buildBacklinksWorkflowId({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        workflow: "recommendation-pool-v2",
        instanceId: input.generationContractId,
      });
      try {
        await client.start(
          backlinksRuntimeContract.workflows.recommendationPoolV2.workflowType,
          {
            workflowId,
            taskQueue,
            args: [{ ...input, workflowId }],
          },
        );
        return Object.freeze({ workflowId, status: "started" as const });
      } catch (error) {
        if (!workflowAlreadyStarted(error)) throw error;
        return Object.freeze({
          workflowId,
          status: "already_started" as const,
        });
      }
    },
  });
}
