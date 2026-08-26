import type {
  LoadUnknownSendResult,
  SendReconciliationDecision,
  SendReconciliationRepository,
  SendReconciliationResult,
  UnknownSendResultAttempt,
} from "../services/send-reconciliation.repository.js";
import type {
  GmailSentMessageQueryPort,
  GmailSentMessageQueryResult,
} from "../../ports/gmail-sent-message-query.port.js";
import type {
  SendAttemptReference,
  SendAttemptSettlement,
  SendAttemptSettlementResult,
  SendExecutionContext,
} from "../services/send-attempt.repository.js";

export interface DispatchRecoverySettlement {
  settleAttempt(input: Readonly<{
    context: SendExecutionContext;
    attempt: SendAttemptReference;
    settlement: SendAttemptSettlement;
  }>): Promise<SendAttemptSettlementResult>;
}

type UnknownSendResultActivityDependencies = Readonly<{
  repository: SendReconciliationRepository;
  gmailQuery: GmailSentMessageQueryPort;
  dispatchRecovery: DispatchRecoverySettlement;
  clock?: () => Date;
}>;

export class UnknownSendResultActivity {
  readonly #repository: SendReconciliationRepository;
  readonly #gmailQuery: GmailSentMessageQueryPort;
  readonly #dispatchRecovery: DispatchRecoverySettlement;
  readonly #clock: () => Date;

  constructor(dependencies: UnknownSendResultActivityDependencies) {
    this.#repository = dependencies.repository;
    this.#gmailQuery = dependencies.gmailQuery;
    this.#dispatchRecovery = dependencies.dispatchRecovery;
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  async load(input: SendExecutionContext & Readonly<{
    sendIntentId: string;
  }>): Promise<LoadUnknownSendResult> {
    return this.#repository.load(input);
  }

  async query(input: SendExecutionContext & Readonly<{
    sendIntentId: string;
    rfcMessageId: string;
  }>): Promise<GmailSentMessageQueryResult> {
    return this.#gmailQuery.findByRfcMessageId(input);
  }

  async recoverDispatch(input: Readonly<{
    context: SendExecutionContext;
    attempt: UnknownSendResultAttempt;
    queryResult: GmailSentMessageQueryResult;
  }>) {
    if (input.attempt.status !== "DISPATCHING") {
      throw new Error("Only a dispatching Gmail attempt can be recovered.");
    }
    if (input.queryResult.kind === "inconclusive") {
      return {
        outcome: "recheck_required" as const,
        attemptId: input.attempt.attemptId,
        rfcMessageId: input.attempt.rfcMessageId,
        errorCode: input.queryResult.code,
      };
    }
    const settlement: SendAttemptSettlement =
      input.queryResult.kind === "found"
        ? {
            status: "PROVIDER_ACCEPTED",
            providerMessageId: input.queryResult.providerMessageId,
            ...(input.queryResult.providerThreadId === undefined
              ? {}
              : { providerThreadId: input.queryResult.providerThreadId }),
          }
        : {
            status: "FAILED_RETRYABLE",
            errorCode: "GMAIL_SEND_RFC_MESSAGE_NOT_FOUND",
            retryAfterSeconds: 5,
          };
    const result = await this.#dispatchRecovery.settleAttempt({
      context: input.context,
      attempt: {
        sendIntentId: input.attempt.sendIntentId,
        attemptId: input.attempt.attemptId,
        attemptNo: input.attempt.attemptNo,
        fencingToken: input.attempt.fencingToken,
        rfcMessageId: input.attempt.rfcMessageId,
      },
      settlement,
    });
    if (result.state === "completed") {
      return {
        outcome: "completed" as const,
        providerMessageId: result.providerMessageId,
        providerThreadId: result.providerThreadId,
        rfcMessageId: result.rfcMessageId,
      };
    }
    if (result.state === "retry_scheduled") {
      return {
        outcome: "retry_scheduled" as const,
        retryAfterSeconds: result.retryAfterSeconds,
      };
    }
    if (result.state === "failed_final") {
      return {
        outcome: "failed_final" as const,
        errorCode: result.errorCode,
      };
    }
    return {
      outcome: "recheck_required" as const,
      attemptId: result.attemptId,
      rfcMessageId: result.rfcMessageId,
      errorCode: result.errorCode,
    };
  }

  async reconcile(input: SendExecutionContext & Readonly<{
    attempt: UnknownSendResultAttempt;
    decision: SendReconciliationDecision;
  }>): Promise<SendReconciliationResult> {
    return this.#repository.reconcile({
      ...input,
      reconciledAt: this.#clock(),
    });
  }
}
