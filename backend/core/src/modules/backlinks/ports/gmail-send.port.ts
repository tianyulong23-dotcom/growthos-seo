import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(255);
const rawBase64UrlSchema = z.string().min(1)
  .regex(/^[A-Za-z0-9_-]+$/u, "MIME must use unpadded base64url.");
const rfcMessageIdSchema = z.string().min(3).max(998)
  .regex(
    /^<[^<>\s@]+@[^<>\s@]+>$/u,
    "A single RFC Message-ID is required.",
  );

export const gmailSendCommandSchema = z.object({
  gmailConnectionId: identifierSchema,
  rawBase64Url: rawBase64UrlSchema,
  gmailThreadId: identifierSchema.optional(),
  rfcMessageId: rfcMessageIdSchema,
  requestId: identifierSchema,
}).strict();

export type GmailSendCommand = Readonly<
  z.output<typeof gmailSendCommandSchema>
>;

export const gmailSendFailureCodes = {
  invalidRequest: "GMAIL_SEND_INVALID_REQUEST",
  reauthRequired: "GMAIL_SEND_REAUTH_REQUIRED",
  forbidden: "GMAIL_SEND_FORBIDDEN",
  rateLimited: "GMAIL_SEND_RATE_LIMITED",
  tokenRefreshFailed: "GMAIL_SEND_TOKEN_REFRESH_FAILED",
  providerNetwork: "GMAIL_SEND_PROVIDER_NETWORK",
  preRequestFailed: "GMAIL_SEND_PRE_REQUEST_FAILED",
  provider5xx: "GMAIL_SEND_PROVIDER_5XX",
  timeout: "GMAIL_SEND_TIMEOUT",
  ambiguous: "GMAIL_SEND_AMBIGUOUS_RESULT",
} as const;

export type GmailSendFailureCode =
  (typeof gmailSendFailureCodes)[keyof typeof gmailSendFailureCodes];

const providerIdentifierSchema = z.string().trim().min(1).max(255);

export const gmailSendAcceptedResultSchema = z.object({
  kind: z.literal("accepted"),
  providerMessageId: providerIdentifierSchema,
  providerThreadId: providerIdentifierSchema.optional(),
}).strict();

export const gmailSendDefinitelyNotSentResultSchema = z.discriminatedUnion(
  "code",
  [
    z.object({
      kind: z.literal("definitely_not_sent"),
      code: z.literal(gmailSendFailureCodes.invalidRequest),
      retryable: z.literal(false),
    }).strict(),
    z.object({
      kind: z.literal("definitely_not_sent"),
      code: z.literal(gmailSendFailureCodes.reauthRequired),
      retryable: z.literal(false),
    }).strict(),
    z.object({
      kind: z.literal("definitely_not_sent"),
      code: z.literal(gmailSendFailureCodes.forbidden),
      retryable: z.literal(false),
    }).strict(),
    z.object({
      kind: z.literal("definitely_not_sent"),
      code: z.literal(gmailSendFailureCodes.rateLimited),
      retryable: z.literal(true),
      retryAfterSeconds: z.number().int().nonnegative()
        .max(Number.MAX_SAFE_INTEGER).optional(),
    }).strict(),
    z.object({
      kind: z.literal("definitely_not_sent"),
      code: z.literal(gmailSendFailureCodes.preRequestFailed),
      retryable: z.literal(true),
    }).strict(),
    z.object({
      kind: z.literal("definitely_not_sent"),
      code: z.literal(gmailSendFailureCodes.tokenRefreshFailed),
      retryable: z.literal(true),
    }).strict(),
    z.object({
      kind: z.literal("definitely_not_sent"),
      code: z.literal(gmailSendFailureCodes.providerNetwork),
      retryable: z.literal(true),
    }).strict(),
  ],
);

export const gmailSendAcceptanceUnknownResultSchema = z.object({
  kind: z.literal("acceptance_unknown"),
  code: z.enum([
    gmailSendFailureCodes.provider5xx,
    gmailSendFailureCodes.timeout,
    gmailSendFailureCodes.ambiguous,
  ]),
}).strict();

export const gmailSendResultSchema = z.union([
  gmailSendAcceptedResultSchema,
  gmailSendDefinitelyNotSentResultSchema,
  gmailSendAcceptanceUnknownResultSchema,
]);

export type GmailSendResult = Readonly<
  z.output<typeof gmailSendResultSchema>
>;

export interface GmailSendPort {
  send(command: GmailSendCommand): Promise<GmailSendResult>;
}
