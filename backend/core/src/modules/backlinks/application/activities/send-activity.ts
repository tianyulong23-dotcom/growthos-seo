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
import {
  runAfterGmailSendPolicyGate,
  type GmailSendPolicyInput,
} from "../services/send-policy-gate.js";

export interface GmailSendCommandLoader {
  load(input: Readonly<{
    context: SendExecutionContext;
    attempt: SendAttemptReference;
  }>): Promise<GmailSendCommand>;
}

export interface GmailSendPolicyInputLoader {
  load(input: Readonly<{
    context: SendExecutionContext;
    attempt: SendAttemptReference;
  }>): Promise<GmailSendPolicyInput>;
}

type GmailSendActivityDependencies = Readonly<{
  repository: SendAttemptRepository;
  commandLoader: GmailSendCommandLoader;
  policyInputLoader: GmailSendPolicyInputLoader;
  gmail: GmailSendPort;
  clock?: () => Date;
}>;

export class GmailSendActivity {
  readonly #repository: SendAttemptRepository;
  readonly #commandLoader: GmailSendCommandLoader;
  readonly #policyInputLoader: GmailSendPolicyInputLoader;
  readonly #gmail: GmailSendPort;
  readonly #clock: () => Date;

  constructor(dependencies: GmailSendActivityDependencies) {
    this.#repository = dependencies.repository;
    this.#commandLoader = dependencies.commandLoader;
    this.#policyInputLoader = dependencies.policyInputLoader;
    this.#gmail = dependencies.gmail;
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  async claimAttempt(input: SendExecutionContext & Readonly<{
    sendIntentId: string;
    maxAttempts: number;
  }>): Promise<SendAttemptClaimResult> {
    const repositoryInput: ClaimSendAttemptInput = {
      ...input,
      claimedAt: this.#clock(),
    };
    return this.#repository.claim(repositoryInput);
  }

  async dispatchAttempt(input: Readonly<{
    context: SendExecutionContext;
    attempt: SendAttemptReference;
  }>): Promise<GmailSendResult> {
    const { context, attempt } = input;
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
    const policyInput = await this.#policyInputLoader.load({
      context,
      attempt,
    });
    return runAfterGmailSendPolicyGate(
      policyInput,
      () => this.#gmail.send(command),
    );
  }

  async settleAttempt(input: Readonly<{
    context: SendExecutionContext;
    attempt: SendAttemptReference;
    settlement: SendAttemptSettlement;
  }>): Promise<SendAttemptSettlementResult> {
    const { context } = input;
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
