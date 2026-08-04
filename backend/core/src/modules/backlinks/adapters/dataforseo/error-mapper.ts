export type DataForSeoRuntimeFailureKind =
  | "authentication"
  | "balance"
  | "invalid_request"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network"
  | "malformed_response";

export type DataForSeoProviderErrorCode =
  | "DATAFORSEO_AUTHENTICATION_FAILED"
  | "DATAFORSEO_BALANCE_EXHAUSTED"
  | "DATAFORSEO_INVALID_REQUEST"
  | "DATAFORSEO_RATE_LIMITED"
  | "DATAFORSEO_MALFORMED_RESPONSE"
  | "DATAFORSEO_UNAVAILABLE"
  | "DATAFORSEO_RESULT_UNKNOWN";

export type DataForSeoProviderRequestStatus = "failed" | "unknown_charge";

type RuntimeErrorInput = Readonly<{
  kind: DataForSeoRuntimeFailureKind;
  requestDispatched: boolean;
  statusCode?: number | undefined;
  costMicros?: number | undefined;
  path?: readonly string[] | undefined;
}>;

type ProviderErrorInput = Readonly<{
  code: DataForSeoProviderErrorCode;
  providerRequestStatus: DataForSeoProviderRequestStatus;
  reconciliationRequired: boolean;
  runtime?: DataForSeoRuntimeError;
}>;

export class DataForSeoRuntimeError extends Error {
  readonly kind: DataForSeoRuntimeFailureKind;
  readonly requestDispatched: boolean;
  readonly statusCode: number | undefined;
  readonly costMicros: number | undefined;
  readonly path: readonly string[] | undefined;

  constructor(input: RuntimeErrorInput, cause?: unknown) {
    super("DataForSEO runtime failure", { cause });
    this.name = "DataForSeoRuntimeError";
    this.kind = input.kind;
    this.requestDispatched = input.requestDispatched;
    this.statusCode = input.statusCode;
    this.costMicros = input.costMicros;
    this.path =
      input.path === undefined ? undefined : Object.freeze([...input.path]);
  }
}

export class DataForSeoProviderError extends Error {
  readonly code: DataForSeoProviderErrorCode;
  readonly providerRequestStatus: DataForSeoProviderRequestStatus;
  readonly retryable = false;
  readonly reconciliationRequired: boolean;
  readonly statusCode: number | undefined;
  readonly costMicros: number | undefined;
  readonly path: readonly string[] | undefined;

  constructor(input: ProviderErrorInput, cause?: unknown) {
    super(
      input.providerRequestStatus === "unknown_charge"
        ? "DataForSEO result and charge are unknown"
        : "DataForSEO provider request failed",
      { cause },
    );
    this.name = "DataForSeoProviderError";
    this.code = input.code;
    this.providerRequestStatus = input.providerRequestStatus;
    this.reconciliationRequired = input.reconciliationRequired;
    this.statusCode = input.runtime?.statusCode;
    this.costMicros = input.runtime?.costMicros;
    this.path =
      input.runtime?.path === undefined
        ? undefined
        : Object.freeze([...input.runtime.path]);
  }
}

const finalFailureCodes = {
  authentication: "DATAFORSEO_AUTHENTICATION_FAILED",
  balance: "DATAFORSEO_BALANCE_EXHAUSTED",
  invalid_request: "DATAFORSEO_INVALID_REQUEST",
  rate_limited: "DATAFORSEO_RATE_LIMITED",
  malformed_response: "DATAFORSEO_MALFORMED_RESPONSE",
} as const;

export function mapDataForSeoProviderError(
  error: unknown,
): DataForSeoProviderError {
  if (error instanceof DataForSeoProviderError) {
    return error;
  }

  if (!(error instanceof DataForSeoRuntimeError)) {
    return new DataForSeoProviderError(
      {
        code: "DATAFORSEO_RESULT_UNKNOWN",
        providerRequestStatus: "unknown_charge",
        reconciliationRequired: true,
      },
      error,
    );
  }

  if (
    error.requestDispatched &&
    (error.kind === "timeout" ||
      error.kind === "network" ||
      error.kind === "server_error" ||
      error.kind === "malformed_response")
  ) {
    return new DataForSeoProviderError(
      {
        code: "DATAFORSEO_RESULT_UNKNOWN",
        providerRequestStatus: "unknown_charge",
        reconciliationRequired: true,
        runtime: error,
      },
      error,
    );
  }

  if (
    error.kind === "timeout" ||
    error.kind === "network" ||
    error.kind === "server_error"
  ) {
    return new DataForSeoProviderError(
      {
        code: "DATAFORSEO_UNAVAILABLE",
        providerRequestStatus: "failed",
        reconciliationRequired: false,
        runtime: error,
      },
      error,
    );
  }

  return new DataForSeoProviderError(
    {
      code: finalFailureCodes[error.kind],
      providerRequestStatus: "failed",
      reconciliationRequired: false,
      runtime: error,
    },
    error,
  );
}
