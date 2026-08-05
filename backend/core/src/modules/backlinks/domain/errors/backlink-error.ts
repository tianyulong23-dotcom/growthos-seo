export const backlinkErrorCodes = {
  invalidRequest: "BACKLINK_INVALID_REQUEST",
  authenticationRequired: "BACKLINK_AUTHENTICATION_REQUIRED",
  accessDenied: "BACKLINK_ACCESS_DENIED",
  notFound: "BACKLINK_NOT_FOUND",
  conflict: "BACKLINK_CONFLICT",
  rateLimited: "BACKLINK_RATE_LIMITED",
  internal: "BACKLINK_INTERNAL_ERROR",
} as const;

export type BacklinkErrorCode =
  (typeof backlinkErrorCodes)[keyof typeof backlinkErrorCodes];

export type BacklinkFieldError = Readonly<{
  field: string;
  message: string;
}>;

export type BacklinkErrorInput = Readonly<{
  code: BacklinkErrorCode;
  message: string;
  retryable?: boolean;
  fieldErrors?: readonly BacklinkFieldError[];
}>;

const backlinkErrorBrand = Symbol.for("growthos.backlinks.BacklinkError");
const backlinkErrorCodeValues = new Set<unknown>(
  Object.values(backlinkErrorCodes),
);

export class BacklinkError extends Error {
  readonly code: BacklinkErrorCode;
  readonly retryable: boolean;
  readonly fieldErrors?: readonly BacklinkFieldError[];

  constructor(input: BacklinkErrorInput) {
    super(input.message);

    if (input.message.trim().length === 0) {
      throw new TypeError("BacklinkError message must not be empty");
    }

    this.name = "BacklinkError";
    Object.defineProperty(this, backlinkErrorBrand, { value: true });
    this.code = input.code;
    this.retryable = input.retryable ?? false;

    if (input.fieldErrors !== undefined) {
      this.fieldErrors = Object.freeze(
        input.fieldErrors.map((error) => Object.freeze({ ...error })),
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

  return (
    error instanceof BacklinkError
    || candidate[backlinkErrorBrand] === true
    || candidate.name === "BacklinkError"
  )
    && backlinkErrorCodeValues.has(candidate.code)
    && typeof candidate.message === "string"
    && candidate.message.trim().length > 0
    && typeof candidate.retryable === "boolean"
    && hasValidFieldErrors;
}
