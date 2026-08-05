import { z } from "zod";

const nonBlankValueSchema = z.string().min(1).max(8_192)
  .refine((value) => value.trim().length > 0, "Value must not be blank.");
const urlSchema = z.url().max(2_048);
const scopeSchema = z.string().trim().min(1).max(2_048);
const timestampSchema = z.string().datetime({ offset: true });

export const googleAuthOperationSchema = z.enum([
  "authorize",
  "callback",
  "refresh",
  "revoke",
]);

export type GoogleAuthOperation = z.output<
  typeof googleAuthOperationSchema
>;

export const googleAuthRequestInputSchema = z.object({
  redirectUri: urlSchema,
  state: nonBlankValueSchema,
  codeChallenge: nonBlankValueSchema,
  codeChallengeMethod: z.literal("S256"),
  requestedScopes: z.array(scopeSchema).min(1).max(32),
}).strict();

type ParsedGoogleAuthRequestInput = z.output<
  typeof googleAuthRequestInputSchema
>;

export type GoogleAuthRequestInput = Readonly<
  Omit<ParsedGoogleAuthRequestInput, "requestedScopes"> & {
    requestedScopes: readonly string[];
  }
>;

export const googleAuthRequestResultSchema = z.object({
  authorizationUrl: urlSchema,
}).strict();

export type GoogleAuthRequestResult = Readonly<
  z.output<typeof googleAuthRequestResultSchema>
>;

export const googleAuthCallbackInputSchema = z.object({
  authorizationCode: nonBlankValueSchema,
  codeVerifier: nonBlankValueSchema,
  redirectUri: urlSchema,
}).strict();

export type GoogleAuthCallbackInput = Readonly<
  z.output<typeof googleAuthCallbackInputSchema>
>;

export const googleIdentitySchema = z.object({
  subject: nonBlankValueSchema,
  email: z.email(),
  emailVerified: z.boolean(),
  displayName: z.string().trim().min(1).max(255).optional(),
  hostedDomain: z.string().trim().min(1).max(255).optional(),
}).strict();

export type GoogleIdentity = Readonly<
  z.output<typeof googleIdentitySchema>
>;

export const googleAuthTokenSetSchema = z.object({
  accessToken: nonBlankValueSchema,
  refreshToken: nonBlankValueSchema.optional(),
  tokenType: z.literal("Bearer"),
  expiresAt: timestampSchema,
  grantedScopes: z.array(scopeSchema).min(1).max(32),
}).strict();

type ParsedGoogleAuthTokenSet = z.output<
  typeof googleAuthTokenSetSchema
>;

export type GoogleAuthTokenSet = Readonly<
  Omit<ParsedGoogleAuthTokenSet, "grantedScopes"> & {
    grantedScopes: readonly string[];
  }
>;

export const googleAuthCallbackResultSchema = z.object({
  identity: googleIdentitySchema,
  tokens: googleAuthTokenSetSchema,
}).strict();

export type GoogleAuthCallbackResult = Readonly<{
  identity: GoogleIdentity;
  tokens: GoogleAuthTokenSet;
}>;

export const googleAuthRefreshInputSchema = z.object({
  refreshToken: nonBlankValueSchema,
}).strict();

export type GoogleAuthRefreshInput = Readonly<
  z.output<typeof googleAuthRefreshInputSchema>
>;

export const googleAuthRefreshResultSchema = googleAuthTokenSetSchema;

export type GoogleAuthRefreshResult = GoogleAuthTokenSet;

export const googleAuthRevokeInputSchema = z.object({
  token: nonBlankValueSchema,
}).strict();

export type GoogleAuthRevokeInput = Readonly<
  z.output<typeof googleAuthRevokeInputSchema>
>;

export const googleAuthRevokeResultSchema = z.object({
  revoked: z.literal(true),
}).strict();

export type GoogleAuthRevokeResult = Readonly<
  z.output<typeof googleAuthRevokeResultSchema>
>;

export const googleAuthFailureCodes = {
  invalidRequest: "GOOGLE_AUTH_INVALID_REQUEST",
  authorizationDenied: "GOOGLE_AUTH_AUTHORIZATION_DENIED",
  authExpired: "GOOGLE_AUTH_EXPIRED",
  rateLimited: "GOOGLE_AUTH_RATE_LIMITED",
  temporaryFailure: "GOOGLE_AUTH_TEMPORARY_FAILURE",
  permanentFailure: "GOOGLE_AUTH_PERMANENT_FAILURE",
} as const;

export type GoogleAuthFailureCode =
  (typeof googleAuthFailureCodes)[keyof typeof googleAuthFailureCodes];

export const googleAuthFailureRetryability = {
  [googleAuthFailureCodes.invalidRequest]: false,
  [googleAuthFailureCodes.authorizationDenied]: false,
  [googleAuthFailureCodes.authExpired]: false,
  [googleAuthFailureCodes.rateLimited]: true,
  [googleAuthFailureCodes.temporaryFailure]: true,
  [googleAuthFailureCodes.permanentFailure]: false,
} as const satisfies Record<GoogleAuthFailureCode, boolean>;

export const googleAuthFailureCodeSchema = z.enum(
  Object.values(googleAuthFailureCodes),
);

export const googleAuthFailureSchema = z.object({
  operation: googleAuthOperationSchema,
  code: googleAuthFailureCodeSchema,
  retryable: z.boolean(),
  httpStatus: z.number().int().min(400).max(599).optional(),
  providerRequestId: z.string().trim().min(1).max(255).optional(),
}).strict().superRefine((failure, context) => {
  if (failure.retryable !== googleAuthFailureRetryability[failure.code]) {
    context.addIssue({
      code: "custom",
      path: ["retryable"],
      message: `Retryability does not match ${failure.code}.`,
    });
  }
});

export type GoogleAuthFailure = Readonly<
  z.output<typeof googleAuthFailureSchema>
>;

export class GoogleAuthError extends Error {
  readonly operation: GoogleAuthOperation;
  readonly code: GoogleAuthFailureCode;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly providerRequestId: string | undefined;

  constructor(failure: GoogleAuthFailure, options?: ErrorOptions) {
    const parsed = googleAuthFailureSchema.parse(failure);
    super(`Google OAuth ${parsed.operation} failed with ${parsed.code}.`, options);
    this.name = "GoogleAuthError";
    this.operation = parsed.operation;
    this.code = parsed.code;
    this.retryable = parsed.retryable;
    this.httpStatus = parsed.httpStatus;
    this.providerRequestId = parsed.providerRequestId;
  }
}

export interface GoogleAuthPort {
  authorize(input: GoogleAuthRequestInput): Promise<GoogleAuthRequestResult>;
  callback(
    input: GoogleAuthCallbackInput,
  ): Promise<GoogleAuthCallbackResult>;
  refresh(input: GoogleAuthRefreshInput): Promise<GoogleAuthRefreshResult>;
  revoke(input: GoogleAuthRevokeInput): Promise<GoogleAuthRevokeResult>;
}
