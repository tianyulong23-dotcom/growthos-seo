import type {
  LoadUnknownSendResult,
  SendReconciliationDecision,
  SendReconciliationResult,
  UnknownSendResultAttempt,
} from "../services/send-reconciliation.repository.js";
import type {
  GmailSentMessageQueryResult,
} from "../../ports/gmail-sent-message-query.port.js";
import type {
  GmailSendWorkflowInput,
} from "./send-workflow.js";

export type UnknownSendResultWorkflowInput = GmailSendWorkflowInput & Readonly<{
  manualDecision?: SendReconciliationDecision;
}>;

export type UnknownSendResultWorkflowActivities = Readonly<{
  load(input: GmailSendWorkflowInput): Promise<LoadUnknownSendResult>;
  query(input: GmailSendWorkflowInput & Readonly<{
    sendIntentId: string;
    rfcMessageId: string;
  }>): Promise<GmailSentMessageQueryResult>;
  recoverDispatch(input: Readonly<{
    context: GmailSendWorkflowInput;
    attempt: UnknownSendResultAttempt;
    queryResult: GmailSentMessageQueryResult;
  }>): Promise<
    | Readonly<{
      outcome: "completed";
      providerMessageId: string;
      providerThreadId: string | null;
      rfcMessageId: string;
    }>
    | Readonly<{
      outcome: "retry_scheduled";
      retryAfterSeconds: number;
    }>
    | Readonly<{ outcome: "failed_final"; errorCode: string }>
    | Readonly<{
      outcome: "recheck_required";
      attemptId: string;
      rfcMessageId: string;
      errorCode: string;
    }>
  >;
  reconcile(input: GmailSendWorkflowInput & Readonly<{
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
  }>
  | Awaited<ReturnType<UnknownSendResultWorkflowActivities["recoverDispatch"]>>;

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
  const executionInput: GmailSendWorkflowInput = {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
    gmailConnectionId: input.gmailConnectionId,
    actorId: input.actorId,
    sendIntentId: input.sendIntentId,
  };
  const loaded = await activities.load(executionInput);
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

  const queryResult = input.manualDecision === undefined
    ? await activities.query({
      ...executionInput,
      rfcMessageId: loaded.attempt.rfcMessageId,
    })
    : null;
  if (loaded.attempt.status === "DISPATCHING") {
    if (queryResult === null) {
      throw new Error("A dispatching send cannot use a manual decision.");
    }
    return activities.recoverDispatch({
      context: executionInput,
      attempt: loaded.attempt,
      queryResult,
    });
  }

  const decision = input.manualDecision
    ?? decisionFromQuery(queryResult as GmailSentMessageQueryResult);
  if (decision === null) {
    return {
      outcome: "manual_confirmation_required",
      attemptId: loaded.attempt.attemptId,
      rfcMessageId: loaded.attempt.rfcMessageId,
      errorCode: loaded.attempt.errorCode,
    };
  }
  return activities.reconcile({
    ...executionInput,
    attempt: loaded.attempt,
    decision,
  });
}
