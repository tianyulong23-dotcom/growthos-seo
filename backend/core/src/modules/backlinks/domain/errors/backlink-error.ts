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
    this.code = input.code;
    this.retryable = input.retryable ?? false;

    if (input.fieldErrors !== undefined) {
      this.fieldErrors = Object.freeze(
        input.fieldErrors.map((error) => Object.freeze({ ...error })),
      );
    }
  }
}
