import { z } from "zod";

import {
  gmailSendCommandSchema,
  gmailSendFailureCodes,
  gmailSendResultSchema,
  type GmailSendCommand,
  type GmailSendPort,
  type GmailSendResult,
} from "../../ports/gmail-send.port.js";
import {
  googleAuthFailureCodeSchema,
  googleAuthFailureCodes,
} from "../../ports/google-auth.port.js";

export const gmailSendClientConfigSchema = z.object({
  enabled: z.boolean().default(false),
}).strict();

export const gmailSendClientAdapterFailureCodes = {
  disabled: "GMAIL_SEND_CLIENT_DISABLED",
  misconfigured: "GMAIL_SEND_CLIENT_MISCONFIGURED",
} as const;

export type GmailSendClientAdapterFailureCode =
  (typeof gmailSendClientAdapterFailureCodes)[
    keyof typeof gmailSendClientAdapterFailureCodes
  ];

export class GmailSendClientAdapterError extends Error {
  readonly code: GmailSendClientAdapterFailureCode;
  readonly retryable = false;

  constructor(code: GmailSendClientAdapterFailureCode) {
    super(`Gmail Send Client failed with ${code}.`);
    this.name = "GmailSendClientAdapterError";
    this.code = code;
  }
}

const providerReasonSchema = z.enum([
  "rate_limit",
  "quota",
  "scope",
  "domain_policy",
]);

const retryAfterSecondsSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const gmailSendProviderResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  data: z.object({
    id: z.unknown().optional(),
    threadId: z.unknown().optional(),
  }).passthrough().optional(),
  reason: providerReasonSchema.optional(),
  retryAfterSeconds: retryAfterSecondsSchema.optional(),
}).passthrough();

export type GmailSendProviderRequest = Readonly<{
  gmailConnectionId: string;
  userId: "me";
  requestBody: Readonly<{
    raw: string;
    threadId?: string;
  }>;
}>;

export interface GmailSendProviderClient {
  send(request: GmailSendProviderRequest): Promise<unknown>;
}

const gmailSendProviderFailureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("http_response"),
    httpStatus: z.number().int().min(100).max(599),
    reason: providerReasonSchema.optional(),
    retryAfterSeconds: retryAfterSecondsSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("timeout"),
    requestDispatched: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("transport"),
    requestDispatched: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("auth"),
    authCode: googleAuthFailureCodeSchema,
  }).strict(),
]);

export type GmailSendProviderFailure = Readonly<
  z.output<typeof gmailSendProviderFailureSchema>
>;

export class GmailSendProviderError extends Error {
  readonly failure: GmailSendProviderFailure;

  constructor(failure: GmailSendProviderFailure, options?: ErrorOptions) {
    const parsed = gmailSendProviderFailureSchema.parse(failure);
    super(`Gmail Send provider failed with ${parsed.kind}.`, options);
    this.name = "GmailSendProviderError";
    this.failure = Object.freeze(parsed);
  }
}

export type GmailSendClientAdapterOptions = Readonly<{
  config?: Readonly<{
    enabled?: boolean;
  }>;
  client?: GmailSendProviderClient;
}>;

const providerIdentifierSchema = z.string().trim().min(1).max(255);

const acceptanceUnknown = (
  code: typeof gmailSendFailureCodes.provider5xx
    | typeof gmailSendFailureCodes.timeout
    | typeof gmailSendFailureCodes.ambiguous,
): GmailSendResult => gmailSendResultSchema.parse({
  kind: "acceptance_unknown",
  code,
});

const definitelyNotSent = (
  code: typeof gmailSendFailureCodes.invalidRequest
    | typeof gmailSendFailureCodes.reauthRequired
    | typeof gmailSendFailureCodes.forbidden,
): GmailSendResult => gmailSendResultSchema.parse({
  kind: "definitely_not_sent",
  code,
  retryable: false,
});

const retryableDefinitelyNotSent = (
  code: typeof gmailSendFailureCodes.rateLimited
    | typeof gmailSendFailureCodes.preRequestFailed
    | typeof gmailSendFailureCodes.tokenRefreshFailed
    | typeof gmailSendFailureCodes.providerNetwork,
  retryAfterSeconds?: number,
): GmailSendResult => gmailSendResultSchema.parse({
  kind: "definitely_not_sent",
  code,
  retryable: true,
  ...(code === gmailSendFailureCodes.rateLimited
      && retryAfterSeconds !== undefined
    ? { retryAfterSeconds }
    : {}),
});

const mapAcceptedResponse = (
  data: z.output<typeof gmailSendProviderResponseSchema>["data"],
): GmailSendResult => {
  const messageId = providerIdentifierSchema.safeParse(data?.id);
  if (!messageId.success) {
    return acceptanceUnknown(gmailSendFailureCodes.ambiguous);
  }

  if (data?.threadId === undefined) {
    return gmailSendResultSchema.parse({
      kind: "accepted",
      providerMessageId: messageId.data,
    });
  }

  const threadId = providerIdentifierSchema.safeParse(data.threadId);
  if (!threadId.success) {
    return acceptanceUnknown(gmailSendFailureCodes.ambiguous);
  }

  return gmailSendResultSchema.parse({
    kind: "accepted",
    providerMessageId: messageId.data,
    providerThreadId: threadId.data,
  });
};

const mapHttpResponse = (
  status: number,
  reason?: z.output<typeof providerReasonSchema>,
  retryAfterSeconds?: number,
  data?: z.output<typeof gmailSendProviderResponseSchema>["data"],
): GmailSendResult => {
  if (status >= 200 && status <= 299) {
    return mapAcceptedResponse(data);
  }
  if (
    status === 429
    || (status === 403 && (reason === "rate_limit" || reason === "quota"))
  ) {
    return retryableDefinitelyNotSent(
      gmailSendFailureCodes.rateLimited,
      retryAfterSeconds,
    );
  }
  if (status === 400) {
    return definitelyNotSent(gmailSendFailureCodes.invalidRequest);
  }
  if (status === 401) {
    return definitelyNotSent(gmailSendFailureCodes.reauthRequired);
  }
  if (status === 403) {
    return definitelyNotSent(gmailSendFailureCodes.forbidden);
  }
  if (status >= 500 && status <= 599) {
    return acceptanceUnknown(gmailSendFailureCodes.provider5xx);
  }
  return acceptanceUnknown(gmailSendFailureCodes.ambiguous);
};

const mapProviderFailure = (
  error: GmailSendProviderError,
): GmailSendResult => {
  switch (error.failure.kind) {
    case "http_response":
      return mapHttpResponse(
        error.failure.httpStatus,
        error.failure.reason,
        error.failure.retryAfterSeconds,
      );
    case "timeout":
      return error.failure.requestDispatched
        ? acceptanceUnknown(gmailSendFailureCodes.timeout)
        : retryableDefinitelyNotSent(
          gmailSendFailureCodes.providerNetwork,
        );
    case "transport":
      return error.failure.requestDispatched
        ? acceptanceUnknown(gmailSendFailureCodes.ambiguous)
        : retryableDefinitelyNotSent(
          gmailSendFailureCodes.providerNetwork,
        );
    case "auth":
      if (error.failure.authCode === googleAuthFailureCodes.temporaryFailure) {
        return retryableDefinitelyNotSent(
          gmailSendFailureCodes.tokenRefreshFailed,
        );
      }
      if (error.failure.authCode === googleAuthFailureCodes.rateLimited) {
        return retryableDefinitelyNotSent(gmailSendFailureCodes.rateLimited);
      }
      if (
        error.failure.authCode === googleAuthFailureCodes.authExpired
        || error.failure.authCode === googleAuthFailureCodes.authorizationDenied
      ) {
        return definitelyNotSent(gmailSendFailureCodes.reauthRequired);
      }
      return definitelyNotSent(gmailSendFailureCodes.invalidRequest);
  }
};

export class GmailSendClientAdapter implements GmailSendPort {
  readonly #enabled: boolean;
  readonly #client: GmailSendProviderClient | undefined;

  constructor(options: GmailSendClientAdapterOptions = {}) {
    const config = gmailSendClientConfigSchema.parse(options.config ?? {});
    if (config.enabled && options.client === undefined) {
      throw new GmailSendClientAdapterError(
        gmailSendClientAdapterFailureCodes.misconfigured,
      );
    }
    this.#enabled = config.enabled;
    this.#client = options.client;
  }

  async send(command: GmailSendCommand): Promise<GmailSendResult> {
    if (!this.#enabled) {
      throw new GmailSendClientAdapterError(
        gmailSendClientAdapterFailureCodes.disabled,
      );
    }

    const parsed = gmailSendCommandSchema.parse(command);
    const client = this.#client;
    if (client === undefined) {
      throw new GmailSendClientAdapterError(
        gmailSendClientAdapterFailureCodes.misconfigured,
      );
    }

    try {
      const response = gmailSendProviderResponseSchema.safeParse(
        await client.send({
          gmailConnectionId: parsed.gmailConnectionId,
          userId: "me",
          requestBody: {
            raw: parsed.rawBase64Url,
            ...(parsed.gmailThreadId === undefined
              ? {}
              : { threadId: parsed.gmailThreadId }),
          },
        }),
      );
      if (!response.success) {
        return acceptanceUnknown(gmailSendFailureCodes.ambiguous);
      }
      return mapHttpResponse(
        response.data.status,
        response.data.reason,
        response.data.retryAfterSeconds,
        response.data.data,
      );
    } catch (error) {
      return error instanceof GmailSendProviderError
        ? mapProviderFailure(error)
        : acceptanceUnknown(gmailSendFailureCodes.ambiguous);
    }
  }
}
