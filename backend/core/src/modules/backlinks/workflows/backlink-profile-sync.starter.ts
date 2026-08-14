import type {
  BacklinkProfileSyncScheduler,
} from "../application/services/backlink-profile.service.js";
import {
  assertBacklinksTaskQueue,
  backlinksRuntimeContract,
  buildBacklinksWorkflowId,
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

export function createTemporalBacklinkProfileSyncScheduler(
  client: TemporalWorkflowClient,
  taskQueue: string,
): BacklinkProfileSyncScheduler {
  assertBacklinksTaskQueue(taskQueue);
  return Object.freeze({
    async start(input) {
      const workflowId = buildBacklinksWorkflowId({
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        workflow: "backlink-profile-sync",
        instanceId: input.profileSyncJobId,
      });
      try {
        await client.start(
          backlinksRuntimeContract.workflows.backlinkProfileSync.workflowType,
          { workflowId, taskQueue, args: [input] },
        );
      } catch (error) {
        if (!workflowAlreadyStarted(error)) throw error;
      }
    },
  });
}
