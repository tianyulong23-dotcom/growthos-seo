export const backlinkErrorCodes = {
  invalidRequest: "BACKLINK_INVALID_REQUEST",
  authenticationRequired: "BACKLINK_AUTHENTICATION_REQUIRED",
  accessDenied: "BACKLINK_ACCESS_DENIED",
  notFound: "BACKLINK_NOT_FOUND",
  conflict: "BACKLINK_CONFLICT",
  rateLimited: "BACKLINK_RATE_LIMITED",
  gmailConnectionNotSelected: "GMAIL_CONNECTION_NOT_SELECTED",
  gmailReauthRequired: "GMAIL_REAUTH_REQUIRED",
  gmailSendDisabled: "GMAIL_SEND_DISABLED",
  gmailScopeInsufficient: "GMAIL_SCOPE_INSUFFICIENT",
  gmailWorkerUnavailable: "GMAIL_WORKER_UNAVAILABLE",
  gmailOAuthProviderUnavailable: "GMAIL_OAUTH_PROVIDER_UNAVAILABLE",
  contactVersionStale: "CONTACT_VERSION_STALE",
  draftVersionStale: "DRAFT_VERSION_STALE",
  sendPolicyRejected: "SEND_POLICY_REJECTED",
  sendReadinessStale: "SEND_READINESS_STALE",
  internal: "BACKLINK_INTERNAL_ERROR",
} as const;

export type BacklinkErrorCode =
  (typeof backlinkErrorCodes)[keyof typeof backlinkErrorCodes];

export type BacklinkFieldError = Readonly<{
  field: string;
  message: string;
}>;

export type BacklinkChangedCondition = Readonly<{
  code: string;
  reason: "CHANGED" | "MISSING" | "EXPIRED";
  expectedRevision: string | null;
  currentRevision: string | null;
  retryable: boolean;
  recoveryAction: string;
}>;

export type BacklinkErrorInput = Readonly<{
  code: BacklinkErrorCode;
  message: string;
  retryable?: boolean;
  fieldErrors?: readonly BacklinkFieldError[];
  changedConditions?: readonly BacklinkChangedCondition[];
  cause?: unknown;
}>;

const backlinkErrorBrand = Symbol.for("growthos.backlinks.BacklinkError");
const backlinkErrorCodeValues = new Set<unknown>(
  Object.values(backlinkErrorCodes),
);

export class BacklinkError extends Error {
  readonly code: BacklinkErrorCode;
  readonly retryable: boolean;
  readonly fieldErrors?: readonly BacklinkFieldError[];
  readonly changedConditions?: readonly BacklinkChangedCondition[];

  constructor(input: BacklinkErrorInput) {
    super(input.message);

    if (input.message.trim().length === 0) {
      throw new TypeError("BacklinkError message must not be empty");
    }

    this.name = "BacklinkError";
    this.cause = input.cause;
    Object.defineProperty(this, backlinkErrorBrand, { value: true });
    this.code = input.code;
    this.retryable = input.retryable ?? false;

    if (input.fieldErrors !== undefined) {
      this.fieldErrors = Object.freeze(
        input.fieldErrors.map((error) => Object.freeze({ ...error })),
      );
    }
    if (input.changedConditions !== undefined) {
      this.changedConditions = Object.freeze(
        input.changedConditions.map((condition) =>
          Object.freeze({ ...condition })),
      );
    }
  }
}

export function isBacklinkError(error: unknown): error is BacklinkError {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as Record<PropertyKey, unknown>;
  const fieldErrors = candidate.fieldErrors;
  const changedConditions = candidate.changedConditions;
  const hasValidFieldErrors =
    fieldErrors === undefined
    || (
      Array.isArray(fieldErrors)
      && fieldErrors.every((fieldError) =>
        typeof fieldError === "object"
        && fieldError !== null
        && typeof (fieldError as Record<string, unknown>).field === "string"
        && (fieldError as Record<string, unknown>).field !== ""
        && typeof (fieldError as Record<string, unknown>).message === "string"
        && (fieldError as Record<string, unknown>).message !== ""
      )
    );
  const hasValidChangedConditions =
    changedConditions === undefined
    || (
      Array.isArray(changedConditions)
      && changedConditions.every((condition) =>
        typeof condition === "object"
        && condition !== null
        && typeof (condition as Record<string, unknown>).code === "string"
        && (condition as Record<string, unknown>).code !== ""
        && ["CHANGED", "MISSING", "EXPIRED"].includes(String(
          (condition as Record<string, unknown>).reason,
        ))
        && (
          (condition as Record<string, unknown>).expectedRevision === null
          || typeof (condition as Record<string, unknown>)
              .expectedRevision === "string"
        )
        && (
          (condition as Record<string, unknown>).currentRevision === null
          || typeof (condition as Record<string, unknown>)
              .currentRevision === "string"
        )
        && typeof (condition as Record<string, unknown>)
            .retryable === "boolean"
        && typeof (condition as Record<string, unknown>)
            .recoveryAction === "string"
      )
    );

  return (
    error instanceof BacklinkError
    || candidate[backlinkErrorBrand] === true
    || candidate.name === "BacklinkError"
  )
    && backlinkErrorCodeValues.has(candidate.code)
    && typeof candidate.message === "string"
    && candidate.message.trim().length > 0
    && typeof candidate.retryable === "boolean"
    && hasValidFieldErrors
    && hasValidChangedConditions;
}
