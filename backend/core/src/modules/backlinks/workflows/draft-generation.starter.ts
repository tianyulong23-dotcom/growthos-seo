import type {
  DraftGenerationScheduler,
} from "../application/commands/draft.command.js";
import {
  assertBacklinksTaskQueue,
  buildBacklinksWorkflowId,
  backlinksRuntimeContract,
} from "./namespaces.js";

type TemporalWorkflowClient = Readonly<{
  start(type: string, options: Readonly<{
    workflowId: string;
    taskQueue: string;
    args: readonly unknown[];
  }>): Promise<unknown>;
}>;

const workflowAlreadyStarted = (error: unknown): boolean =>
  error instanceof Error
  && (
    error.name === "WorkflowExecutionAlreadyStartedError"
    || /workflow execution.*already (?:started|exists)/iu.test(error.message)
  );

export function createTemporalDraftGenerationScheduler(
  client: TemporalWorkflowClient,
  taskQueue: string,
): DraftGenerationScheduler {
  assertBacklinksTaskQueue(taskQueue);
  return Object.freeze({
    async start(input) {
      const workflowId = buildBacklinksWorkflowId({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        workflow: "draft-generation",
        instanceId: input.runId,
      });
      try {
        await client.start(
          backlinksRuntimeContract.workflows.draftGeneration.workflowType,
          { workflowId, taskQueue, args: [input] },
        );
      } catch (error) {
        if (!workflowAlreadyStarted(error)) throw error;
      }
      return { workflowId };
    },
  });
}
