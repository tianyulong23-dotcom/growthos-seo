import {
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";

import type {
  GmailPollingSyncWorkflowActivities,
  GmailPollingSyncWorkflowInput,
} from "../../application/workflows/gmail-polling-sync-workflow.js";
import {
  gmailPollingSyncNowSignal,
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

export async function backlinksGmailPollingSyncV1Workflow(
  input: GmailPollingSyncWorkflowInput,
) {
  let syncRequested = true;
  let completedCycles = 0;
  setHandler(syncNowSignal, () => {
    syncRequested = true;
  });

  while (true) {
    if (syncRequested) {
      syncRequested = false;
      await runGmailPollingSyncWorkflow(input, {
        run: activities.backlinksRunGmailPollingSyncV1,
      });
      completedCycles += 1;
    }
    if (
      workflowInfo().continueAsNewSuggested
      || completedCycles >= 100
    ) {
      return continueAsNew<typeof backlinksGmailPollingSyncV1Workflow>(input);
    }
    const signaled = await condition(
      () => syncRequested,
      input.pollingIntervalSeconds * 1_000,
    );
    if (!signaled) syncRequested = true;
  }
}
