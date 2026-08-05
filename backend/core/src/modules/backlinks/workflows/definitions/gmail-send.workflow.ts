import { proxyActivities, sleep } from "@temporalio/workflow";

import type {
  SendWorkflowActivities,
  GmailSendWorkflowInput,
} from "../../application/workflows/send-workflow.js";
import {
  runGmailSendWorkflow,
} from "../../application/workflows/send-workflow.js";

type GmailSendActivities = Readonly<{
  backlinksClaimGmailSendAttemptV1:
    SendWorkflowActivities["claimAttempt"];
  backlinksDispatchGmailSendAttemptV1:
    SendWorkflowActivities["dispatchAttempt"];
  backlinksSettleGmailSendAttemptV1:
    SendWorkflowActivities["settleAttempt"];
}>;

const activities = proxyActivities<GmailSendActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});

export async function backlinksGmailSendV1Workflow(
  input: GmailSendWorkflowInput,
) {
  return runGmailSendWorkflow(
    input,
    {
      claimAttempt: activities.backlinksClaimGmailSendAttemptV1,
      dispatchAttempt: activities.backlinksDispatchGmailSendAttemptV1,
      settleAttempt: activities.backlinksSettleGmailSendAttemptV1,
    },
    {
      maxAttempts: 1,
      wait: sleep,
    },
  );
}
