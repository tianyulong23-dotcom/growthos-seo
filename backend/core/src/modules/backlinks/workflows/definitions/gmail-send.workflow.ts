import { proxyActivities, sleep } from "@temporalio/workflow";

import type {
  SendWorkflowActivities,
  GmailSendWorkflowInput,
} from "../../application/workflows/send-workflow.js";
import {
  runGmailSendWorkflow,
} from "../../application/workflows/send-workflow.js";
import type {
  UnknownSendResultWorkflowActivities,
} from "../../application/workflows/unknown-send-result-workflow.js";
import {
  runUnknownSendResultWorkflow,
} from "../../application/workflows/unknown-send-result-workflow.js";

type GmailSendActivities = Readonly<{
  backlinksClaimGmailSendAttemptV1:
    SendWorkflowActivities["claimAttempt"];
  backlinksDispatchGmailSendAttemptV1:
    SendWorkflowActivities["dispatchAttempt"];
  backlinksSettleGmailSendAttemptV1:
    SendWorkflowActivities["settleAttempt"];
  backlinksLoadGmailSendReconciliationV1:
    UnknownSendResultWorkflowActivities["load"];
  backlinksQueryGmailSentMessageV1:
    UnknownSendResultWorkflowActivities["query"];
  backlinksRecoverGmailDispatchV1:
    UnknownSendResultWorkflowActivities["recoverDispatch"];
  backlinksReconcileGmailSendResultV1:
    UnknownSendResultWorkflowActivities["reconcile"];
}>;

const activities = proxyActivities<GmailSendActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});

export async function backlinksGmailSendV1Workflow(
  input: GmailSendWorkflowInput,
) {
  for (;;) {
    const sendResult = await runGmailSendWorkflow(
      input,
      {
        claimAttempt: activities.backlinksClaimGmailSendAttemptV1,
        dispatchAttempt: activities.backlinksDispatchGmailSendAttemptV1,
        settleAttempt: activities.backlinksSettleGmailSendAttemptV1,
      },
      {
        wait: sleep,
      },
    );
    if (sendResult.outcome !== "reconciliation_required") {
      return sendResult;
    }
    const reconciliation = await runUnknownSendResultWorkflow(input, {
      load: activities.backlinksLoadGmailSendReconciliationV1,
      query: activities.backlinksQueryGmailSentMessageV1,
      recoverDispatch: activities.backlinksRecoverGmailDispatchV1,
      reconcile: activities.backlinksReconcileGmailSendResultV1,
    });
    if (reconciliation.outcome !== "retry_scheduled") {
      return reconciliation;
    }
    await sleep(reconciliation.retryAfterSeconds * 1_000);
  }
}
