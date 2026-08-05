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
  SendExecutionContext,
} from "../services/send-attempt.repository.js";

export interface UnknownSendResultContextResolver {
  resolve(sendIntentId: string): Promise<SendExecutionContext>;
}

type UnknownSendResultActivityDependencies = Readonly<{
  repository: SendReconciliationRepository;
  contextResolver: UnknownSendResultContextResolver;
  gmailQuery: GmailSentMessageQueryPort;
  clock?: () => Date;
}>;

export class UnknownSendResultActivity {
  readonly #repository: SendReconciliationRepository;
  readonly #contextResolver: UnknownSendResultContextResolver;
  readonly #gmailQuery: GmailSentMessageQueryPort;
  readonly #clock: () => Date;

  constructor(dependencies: UnknownSendResultActivityDependencies) {
    this.#repository = dependencies.repository;
    this.#contextResolver = dependencies.contextResolver;
    this.#gmailQuery = dependencies.gmailQuery;
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  async load(input: Readonly<{
    sendIntentId: string;
  }>): Promise<LoadUnknownSendResult> {
    const context = await this.#contextResolver.resolve(input.sendIntentId);
    return this.#repository.load({ ...context, ...input });
  }

  async query(input: Readonly<{
    sendIntentId: string;
    rfcMessageId: string;
  }>): Promise<GmailSentMessageQueryResult> {
    const context = await this.#contextResolver.resolve(input.sendIntentId);
    return this.#gmailQuery.findByRfcMessageId({
      gmailConnectionId: context.gmailConnectionId,
      rfcMessageId: input.rfcMessageId,
    });
  }

  async reconcile(input: Readonly<{
    attempt: UnknownSendResultAttempt;
    decision: SendReconciliationDecision;
  }>): Promise<SendReconciliationResult> {
    const context = await this.#contextResolver.resolve(
      input.attempt.sendIntentId,
    );
    return this.#repository.reconcile({
      ...context,
      ...input,
      reconciledAt: this.#clock(),
    });
  }
}
