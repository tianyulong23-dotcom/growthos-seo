import {
  gmailSendFailureCodes,
  gmailSendCommandSchema,
  type GmailSendCommand,
  type GmailSendPort,
  type GmailSendResult,
} from "../../ports/gmail-send.port.js";
import {
  GoogleAuthError,
  googleAuthFailureCodes,
} from "../../ports/google-auth.port.js";
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
  GmailSendPolicyBlockedError,
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

export interface GmailConnectionHealthCheck {
  run(input: Readonly<{
    context: SendExecutionContext;
    attempt: SendAttemptReference;
  }>): Promise<void>;
}

export interface GmailSendCommandContextCleanup {
  run(input: Readonly<{
    context: SendExecutionContext;
    attempt: SendAttemptReference;
  }>): Promise<void>;
}

export interface GmailAcceptedSendHandler {
  run(input: Readonly<{
    context: SendExecutionContext;
    attempt: SendAttemptReference;
    settlement: Extract<
      SendAttemptSettlement,
      { status: "PROVIDER_ACCEPTED" }
    >;
    result: Extract<
      SendAttemptSettlementResult,
      { state: "completed" }
    >;
  }>): Promise<void>;
}

type GmailSendActivityDependencies = Readonly<{
  repository: SendAttemptRepository;
  commandLoader: GmailSendCommandLoader;
  connectionHealthCheck: GmailConnectionHealthCheck;
  policyInputLoader: GmailSendPolicyInputLoader;
  gmail: GmailSendPort;
  commandContextCleanup?: GmailSendCommandContextCleanup;
  acceptedSendHandler?: GmailAcceptedSendHandler;
  clock?: () => Date;
}>;

const preRequestFailure = (): GmailSendResult => ({
  kind: "definitely_not_sent",
  code: gmailSendFailureCodes.preRequestFailed,
  retryable: true,
});

const authFailureResult = (error: GoogleAuthError): GmailSendResult => {
  if (error.code === googleAuthFailureCodes.rateLimited) {
    return {
      kind: "definitely_not_sent",
      code: gmailSendFailureCodes.rateLimited,
      retryable: true,
    };
  }
  if (error.code === googleAuthFailureCodes.temporaryFailure) {
    return {
      kind: "definitely_not_sent",
      code: gmailSendFailureCodes.tokenRefreshFailed,
      retryable: true,
    };
  }
  if (error.code === googleAuthFailureCodes.invalidRequest) {
    return {
      kind: "definitely_not_sent",
      code: gmailSendFailureCodes.invalidRequest,
      retryable: false,
    };
  }
  return {
    kind: "definitely_not_sent",
    code: gmailSendFailureCodes.reauthRequired,
    retryable: false,
  };
};

const policyBlockResult = (
  error: GmailSendPolicyBlockedError,
  now: Date,
): GmailSendResult => {
  if (
    error.decision.blockCodes.includes("GMAIL_CONNECTION_UNAVAILABLE")
  ) {
    return {
      kind: "definitely_not_sent",
      code: gmailSendFailureCodes.reauthRequired,
      retryable: false,
    };
  }
  if (
    error.decision.blockCodes.includes("GMAIL_DAILY_QUOTA_EXCEEDED")
    || error.decision.blockCodes.includes("GMAIL_SEND_COOLDOWN_ACTIVE")
  ) {
    const retryAt = error.decision.retryAt === null
      ? null
      : new Date(error.decision.retryAt);
    const retryAfterSeconds = retryAt !== null
      && Number.isFinite(retryAt.getTime())
      ? Math.max(0, Math.ceil((retryAt.getTime() - now.getTime()) / 1_000))
      : undefined;
    return {
      kind: "definitely_not_sent",
      code: gmailSendFailureCodes.rateLimited,
      retryable: true,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  }
  return {
    kind: "definitely_not_sent",
    code: gmailSendFailureCodes.forbidden,
    retryable: false,
  };
};

export class GmailSendActivity {
  readonly #repository: SendAttemptRepository;
  readonly #commandLoader: GmailSendCommandLoader;
  readonly #connectionHealthCheck: GmailConnectionHealthCheck;
  readonly #policyInputLoader: GmailSendPolicyInputLoader;
  readonly #gmail: GmailSendPort;
  readonly #commandContextCleanup: GmailSendCommandContextCleanup | undefined;
  readonly #acceptedSendHandler: GmailAcceptedSendHandler | undefined;
  readonly #clock: () => Date;

  constructor(dependencies: GmailSendActivityDependencies) {
    this.#repository = dependencies.repository;
    this.#commandLoader = dependencies.commandLoader;
    this.#connectionHealthCheck = dependencies.connectionHealthCheck;
    this.#policyInputLoader = dependencies.policyInputLoader;
    this.#gmail = dependencies.gmail;
    this.#commandContextCleanup = dependencies.commandContextCleanup;
    this.#acceptedSendHandler = dependencies.acceptedSendHandler;
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
    let providerCallStarted = false;
    try {
      let command: GmailSendCommand;
      try {
        command = gmailSendCommandSchema.parse(
          await this.#commandLoader.load({ context, attempt }),
        );
      } catch {
        return preRequestFailure();
      }
      if (
        command.gmailConnectionId !== context.gmailConnectionId
        || command.rfcMessageId !== attempt.rfcMessageId
        || command.requestId !== attempt.attemptId
      ) {
        return {
          kind: "definitely_not_sent",
          code: gmailSendFailureCodes.invalidRequest,
          retryable: false,
        };
      }
      try {
        await this.#connectionHealthCheck.run({ context, attempt });
      } catch (error) {
        return error instanceof GoogleAuthError
          ? authFailureResult(error)
          : preRequestFailure();
      }
      let policyInput: GmailSendPolicyInput;
      try {
        policyInput = await this.#policyInputLoader.load({
          context,
          attempt,
        });
      } catch {
        return preRequestFailure();
      }
      try {
        return await runAfterGmailSendPolicyGate(
          policyInput,
          () => {
            providerCallStarted = true;
            return this.#gmail.send(command);
          },
        );
      } catch (error) {
        if (providerCallStarted) {
          return {
            kind: "acceptance_unknown",
            code: gmailSendFailureCodes.ambiguous,
          };
        }
        return error instanceof GmailSendPolicyBlockedError
          ? policyBlockResult(error, this.#clock())
          : preRequestFailure();
      }
    } finally {
      if (!providerCallStarted && this.#commandContextCleanup !== undefined) {
        await this.#commandContextCleanup.run({ context, attempt }).catch(
          () => undefined,
        );
      }
    }
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
    const result = await this.#repository.settle({
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
    if (
      input.settlement.status === "PROVIDER_ACCEPTED"
      && result.state === "completed"
      && this.#acceptedSendHandler !== undefined
    ) {
      await this.#acceptedSendHandler.run({
        context,
        attempt: input.attempt,
        settlement: input.settlement,
        result,
      });
    }
    return result;
  }
}
