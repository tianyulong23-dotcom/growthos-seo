import type {
  SendAttemptClaimResult,
  SendAttemptReference,
  SendAttemptSettlement,
  SendAttemptSettlementResult,
  SendExecutionContext,
} from "../services/send-attempt.repository.js";
import {
  gmailSendFailureCodes,
  type GmailSendResult,
} from "../../ports/gmail-send.port.js";

export type GmailSendWorkflowInput = SendExecutionContext & Readonly<{
  sendIntentId: string;
}>;

export interface SendWorkflowActivities {
  claimAttempt(input: SendExecutionContext & Readonly<{
    sendIntentId: string;
    maxAttempts: number;
  }>): Promise<SendAttemptClaimResult>;
  dispatchAttempt(input: Readonly<{
    context: SendExecutionContext;
    attempt: SendAttemptReference;
  }>): Promise<GmailSendResult>;
  settleAttempt(input: Readonly<{
    context: SendExecutionContext;
    attempt: SendAttemptReference;
    settlement: SendAttemptSettlement;
  }>): Promise<SendAttemptSettlementResult>;
}

export type GmailSendWorkflowOptions = Readonly<{
  maxAttempts?: number;
  wait?: (milliseconds: number) => Promise<void>;
}>;

export const defaultGmailSendMaxAttempts = 3;
export const gmailSendRetryDelayMaxSeconds = 300;

export const sendIntentWorkflowId = (sendIntentId: string): string =>
  `send-intent/${sendIntentId}`;

const retryDelaySeconds = (
  result: Extract<GmailSendResult, { kind: "definitely_not_sent" }>,
  attemptNo: number,
): number => {
  const requested = result.code === gmailSendFailureCodes.rateLimited
    ? result.retryAfterSeconds ?? 30
    : 5 * (2 ** Math.max(0, attemptNo - 1));
  return Math.max(
    1,
    Math.min(requested, gmailSendRetryDelayMaxSeconds),
  );
};

const settlementFor = (
  result: GmailSendResult,
  attempt: SendAttemptReference,
  maxAttempts: number,
): SendAttemptSettlement => {
  if (result.kind === "accepted") {
    return {
      status: "PROVIDER_ACCEPTED",
      providerMessageId: result.providerMessageId,
      ...(result.providerThreadId === undefined
        ? {}
        : { providerThreadId: result.providerThreadId }),
    };
  }
  if (result.kind === "acceptance_unknown") {
    return {
      status: "DELIVERY_UNKNOWN",
      errorCode: result.code,
    };
  }
  if (result.retryable && attempt.attemptNo < maxAttempts) {
    return {
      status: "FAILED_RETRYABLE",
      errorCode: result.code,
      retryAfterSeconds: retryDelaySeconds(result, attempt.attemptNo),
    };
  }
  return {
    status: "FAILED_FINAL",
    errorCode: result.code,
  };
};

const resultFromClaim = (
  claim: Exclude<SendAttemptClaimResult, { state: "claimed" | "wait" }>,
) => {
  if (claim.state === "already_completed") {
    return {
      outcome: "already_completed" as const,
      providerMessageId: claim.providerMessageId,
      providerThreadId: claim.providerThreadId,
      rfcMessageId: claim.rfcMessageId,
    };
  }
  if (claim.state === "failed_final") {
    return {
      outcome: "failed_final" as const,
      errorCode: claim.errorCode,
    };
  }
  return {
    outcome: "reconciliation_required" as const,
    attemptId: claim.attemptId,
    rfcMessageId: claim.rfcMessageId,
    errorCode: claim.errorCode ?? null,
  };
};

const resultFromSettlement = (
  settlement: Exclude<
    SendAttemptSettlementResult,
    { state: "retry_scheduled" }
  >,
) => {
  if (settlement.state === "completed") {
    return {
      outcome: "completed" as const,
      providerMessageId: settlement.providerMessageId,
      providerThreadId: settlement.providerThreadId,
      rfcMessageId: settlement.rfcMessageId,
    };
  }
  if (settlement.state === "failed_final") {
    return {
      outcome: "failed_final" as const,
      errorCode: settlement.errorCode,
    };
  }
  return {
    outcome: "reconciliation_required" as const,
    attemptId: settlement.attemptId,
    rfcMessageId: settlement.rfcMessageId,
    errorCode: settlement.errorCode,
  };
};

export async function runGmailSendWorkflow(
  input: GmailSendWorkflowInput,
  activities: SendWorkflowActivities,
  options: GmailSendWorkflowOptions = {},
) {
  if (input.sendIntentId.trim().length === 0) {
    throw new TypeError("Gmail Send Workflow requires a Send Intent ID.");
  }
  const maxAttempts = options.maxAttempts ?? defaultGmailSendMaxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("Gmail Send maxAttempts must be positive.");
  }

  const context: SendExecutionContext = {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
    gmailConnectionId: input.gmailConnectionId,
    actorId: input.actorId,
  };

  for (;;) {
    const claim = await activities.claimAttempt({
      ...context,
      sendIntentId: input.sendIntentId,
      maxAttempts,
    });
    if (claim.state === "wait") {
      if (options.wait === undefined) {
        throw new Error("Gmail Send Workflow retry timer is unavailable.");
      }
      await options.wait(claim.retryAfterSeconds * 1_000);
      continue;
    }
    if (claim.state !== "claimed") {
      return resultFromClaim(claim);
    }

    const sendResult = await activities.dispatchAttempt({
      context,
      attempt: claim.attempt,
    });
    const settlement = settlementFor(
      sendResult,
      claim.attempt,
      maxAttempts,
    );
    const persisted = await activities.settleAttempt({
      context,
      attempt: claim.attempt,
      settlement,
    });
    if (persisted.state !== "retry_scheduled") {
      return resultFromSettlement(persisted);
    }
    if (options.wait === undefined) {
      throw new Error("Gmail Send Workflow retry timer is unavailable.");
    }
    await options.wait(persisted.retryAfterSeconds * 1_000);
  }
}
