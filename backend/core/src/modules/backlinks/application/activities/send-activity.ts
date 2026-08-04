import {
  gmailSendCommandSchema,
  type GmailSendCommand,
  type GmailSendPort,
  type GmailSendResult,
} from "../../ports/gmail-send.port.js";
import type {
  ClaimSendAttemptInput,
  SendAttemptClaimResult,
  SendAttemptReference,
  SendAttemptRepository,
  SendAttemptSettlement,
  SendAttemptSettlementResult,
  SendExecutionContext,
} from "../services/send-attempt.repository.js";

export interface SendExecutionContextResolver {
  resolve(sendIntentId: string): Promise<SendExecutionContext>;
}

export interface GmailSendCommandLoader {
  load(input: Readonly<{
    context: SendExecutionContext;
    attempt: SendAttemptReference;
  }>): Promise<GmailSendCommand>;
}

type GmailSendActivityDependencies = Readonly<{
  repository: SendAttemptRepository;
  contextResolver: SendExecutionContextResolver;
  commandLoader: GmailSendCommandLoader;
  gmail: GmailSendPort;
  clock?: () => Date;
}>;

export class GmailSendActivity {
  readonly #repository: SendAttemptRepository;
  readonly #contextResolver: SendExecutionContextResolver;
  readonly #commandLoader: GmailSendCommandLoader;
  readonly #gmail: GmailSendPort;
  readonly #clock: () => Date;

  constructor(dependencies: GmailSendActivityDependencies) {
    this.#repository = dependencies.repository;
    this.#contextResolver = dependencies.contextResolver;
    this.#commandLoader = dependencies.commandLoader;
    this.#gmail = dependencies.gmail;
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  async claimAttempt(input: Readonly<{
    sendIntentId: string;
    maxAttempts: number;
  }>): Promise<SendAttemptClaimResult> {
    const context = await this.#contextResolver.resolve(input.sendIntentId);
    const repositoryInput: ClaimSendAttemptInput = {
      ...context,
      ...input,
      claimedAt: this.#clock(),
    };
    return this.#repository.claim(repositoryInput);
  }

  async dispatchAttempt(
    attempt: SendAttemptReference,
  ): Promise<GmailSendResult> {
    const context = await this.#contextResolver.resolve(
      attempt.sendIntentId,
    );
    const command = gmailSendCommandSchema.parse(
      await this.#commandLoader.load({ context, attempt }),
    );
    if (
      command.gmailConnectionId !== context.gmailConnectionId
      || command.rfcMessageId !== attempt.rfcMessageId
      || command.requestId !== attempt.attemptId
    ) {
      throw new Error(
        "Gmail Send command does not match the claimed Attempt.",
      );
    }
    return this.#gmail.send(command);
  }

  async settleAttempt(input: Readonly<{
    attempt: SendAttemptReference;
    settlement: SendAttemptSettlement;
  }>): Promise<SendAttemptSettlementResult> {
    const context = await this.#contextResolver.resolve(
      input.attempt.sendIntentId,
    );
    const completedAt = this.#clock();
    const retryEligibleAt =
      input.settlement.status === "FAILED_RETRYABLE"
        ? new Date(
            completedAt.getTime()
            + input.settlement.retryAfterSeconds * 1_000,
          )
        : null;
    return this.#repository.settle({
      ...context,
      ...input.attempt,
      status: input.settlement.status,
      providerMessageId:
        input.settlement.status === "PROVIDER_ACCEPTED"
          ? input.settlement.providerMessageId
          : null,
      providerThreadId:
        input.settlement.status === "PROVIDER_ACCEPTED"
          ? input.settlement.providerThreadId ?? null
          : null,
      errorCode:
        input.settlement.status === "PROVIDER_ACCEPTED"
          ? null
          : input.settlement.errorCode,
      completedAt,
      retryEligibleAt,
    });
  }
}
