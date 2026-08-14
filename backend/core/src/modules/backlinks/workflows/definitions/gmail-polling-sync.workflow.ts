import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";

import type {
  GmailPollingSyncWorkflowActivities,
  GmailPollingSyncWorkflowInput,
  GmailPollingSyncWorkflowStatus,
} from "../../application/workflows/gmail-polling-sync-workflow.js";
import {
  calculateGmailPollingRetryDelaySeconds,
  classifyGmailPollingSyncError,
  gmailPollingSyncNowSignal,
  gmailPollingSyncStatusQuery,
  isGmailPollingSyncCapabilityPausedResult,
  runGmailPollingSyncWorkflow,
} from "../../application/workflows/gmail-polling-sync-workflow.js";

type GmailPollingSyncActivities = Readonly<{
  backlinksRunGmailPollingSyncV1:
    GmailPollingSyncWorkflowActivities["run"];
}>;

const activities = proxyActivities<GmailPollingSyncActivities>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

const syncNowSignal = defineSignal(gmailPollingSyncNowSignal);
const statusQuery = defineQuery<GmailPollingSyncWorkflowStatus>(
  gmailPollingSyncStatusQuery,
);

const failureMessage = (error: unknown): string => {
  const message = error instanceof Error
    ? error.message
    : "Gmail polling sync failed.";
  return message.slice(0, 1_000);
};

export async function backlinksGmailPollingSyncV1Workflow(
  input: GmailPollingSyncWorkflowInput,
) {
  let syncRequested = input.resume === undefined;
  let completedCycles = 0;
  let lastSuccessfulSyncAt =
    input.resume?.status.lastSuccessfulSyncAt ?? null;
  let lastError = input.resume?.status.lastError ?? null;
  let lastErrorCategory =
    input.resume?.status.lastErrorCategory ?? null;
  let nextRetryAt = input.resume?.status.nextRetryAt ?? null;
  let consecutiveFailures =
    input.resume?.status.consecutiveFailures ?? 0;
  let retryDelaySeconds =
    input.resume?.retryDelaySeconds ?? input.pollingIntervalSeconds;
  setHandler(syncNowSignal, () => {
    syncRequested = true;
    nextRetryAt = null;
  });
  setHandler(statusQuery, () => ({
    lastSuccessfulSyncAt,
    lastError,
    lastErrorCategory,
    nextRetryAt,
    consecutiveFailures,
  }));

  while (true) {
    if (syncRequested) {
      syncRequested = false;
      try {
        const result = await runGmailPollingSyncWorkflow(input, {
          run: activities.backlinksRunGmailPollingSyncV1,
        });
        const capabilityPaused =
          isGmailPollingSyncCapabilityPausedResult(result);
        if (!capabilityPaused) {
          lastSuccessfulSyncAt = new Date().toISOString();
        }
        lastError = null;
        lastErrorCategory = null;
        consecutiveFailures = 0;
        retryDelaySeconds = input.pollingIntervalSeconds;
        nextRetryAt = capabilityPaused
          ? new Date(
              Date.now() + retryDelaySeconds * 1_000,
            ).toISOString()
          : null;
      } catch (error) {
        lastError = failureMessage(error);
        lastErrorCategory = classifyGmailPollingSyncError(error);
        consecutiveFailures += 1;
        retryDelaySeconds = calculateGmailPollingRetryDelaySeconds(
          input.pollingIntervalSeconds,
          consecutiveFailures,
          lastErrorCategory,
        );
        nextRetryAt = new Date(
          Date.now() + retryDelaySeconds * 1_000,
        ).toISOString();
      }
      completedCycles += 1;
    }
    if (
      workflowInfo().continueAsNewSuggested
      || completedCycles >= 100
    ) {
      return continueAsNew<typeof backlinksGmailPollingSyncV1Workflow>({
        ...input,
        resume: {
          status: {
            lastSuccessfulSyncAt,
            lastError,
            lastErrorCategory,
            nextRetryAt,
            consecutiveFailures,
          },
          retryDelaySeconds,
        },
      });
    }
    const signaled = await condition(
      () => syncRequested,
      retryDelaySeconds * 1_000,
    );
    if (!signaled) syncRequested = true;
  }
}
