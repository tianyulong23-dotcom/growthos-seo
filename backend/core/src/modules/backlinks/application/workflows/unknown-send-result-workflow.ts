import type {
  LoadUnknownSendResult,
  SendReconciliationDecision,
  SendReconciliationResult,
  UnknownSendResultAttempt,
} from "../services/send-reconciliation.repository.js";
import type {
  GmailSentMessageQueryResult,
} from "../../ports/gmail-sent-message-query.port.js";

export type UnknownSendResultWorkflowInput = Readonly<{
  sendIntentId: string;
  manualDecision?: SendReconciliationDecision;
}>;

export type UnknownSendResultWorkflowActivities = Readonly<{
  load(input: Readonly<{ sendIntentId: string }>): Promise<LoadUnknownSendResult>;
  query(input: Readonly<{
    sendIntentId: string;
    rfcMessageId: string;
  }>): Promise<GmailSentMessageQueryResult>;
  reconcile(input: Readonly<{
    attempt: UnknownSendResultAttempt;
    decision: SendReconciliationDecision;
  }>): Promise<SendReconciliationResult>;
}>;

export type UnknownSendResultWorkflowResult =
  | SendReconciliationResult
  | Readonly<{
    outcome: "manual_confirmation_required";
    attemptId: string;
    rfcMessageId: string;
    errorCode: string;
  }>
  | Readonly<{
    outcome: "not_reconcilable";
    status: string;
    rfcMessageId: string;
  }>;

export const unknownSendResultWorkflowId = (sendIntentId: string): string =>
  `send-reconciliation/${sendIntentId}`;

const decisionFromQuery = (
  result: GmailSentMessageQueryResult,
): SendReconciliationDecision | null => {
  if (result.kind !== "found") return null;
  return {
    outcome: "PROVIDER_ACCEPTED",
    providerMessageId: result.providerMessageId,
    ...(result.providerThreadId === undefined
      ? {}
      : { providerThreadId: result.providerThreadId }),
    evidenceReference: result.evidenceReference,
  };
};

export async function runUnknownSendResultWorkflow(
  input: UnknownSendResultWorkflowInput,
  activities: UnknownSendResultWorkflowActivities,
): Promise<UnknownSendResultWorkflowResult> {
  const loaded = await activities.load({ sendIntentId: input.sendIntentId });
  if (loaded.state === "reconciled") {
    if (loaded.outcome === "completed") {
      return {
        outcome: "completed",
        providerMessageId: loaded.providerMessageId,
        providerThreadId: loaded.providerThreadId,
        rfcMessageId: loaded.rfcMessageId,
      };
    }
    return {
      outcome: "failed_final",
      errorCode: loaded.errorCode,
      rfcMessageId: loaded.rfcMessageId,
    };
  }
  if (loaded.state === "not_reconcilable") {
    return {
      outcome: "not_reconcilable",
      status: loaded.status,
      rfcMessageId: loaded.rfcMessageId,
    };
  }

  const decision = input.manualDecision
    ?? decisionFromQuery(await activities.query({
      sendIntentId: input.sendIntentId,
      rfcMessageId: loaded.attempt.rfcMessageId,
    }));
  if (decision === null) {
    return {
      outcome: "manual_confirmation_required",
      attemptId: loaded.attempt.attemptId,
      rfcMessageId: loaded.attempt.rfcMessageId,
      errorCode: loaded.attempt.errorCode,
    };
  }
  return activities.reconcile({ attempt: loaded.attempt, decision });
}
