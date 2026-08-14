import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(255);
const urlValueSchema = z.string().trim().min(1).max(2_048);
const timestampSchema = z.string().datetime({ offset: true });
const safeIntegerSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const safeFetchPurposeSchema = z.enum([
  "contact-enrichment",
  "seo-assessment",
  "placement-check",
]);

export type SafeFetchPurpose = z.output<typeof safeFetchPurposeSchema>;

export const safeFetchRequestSchema = z.object({
  url: urlValueSchema,
  purpose: safeFetchPurposeSchema,
  workspaceId: identifierSchema,
  websiteProjectId: identifierSchema,
  maxBytes: safeIntegerSchema.positive(),
  maxRedirects: safeIntegerSchema,
}).strict();

export type SafeFetchRequest = Readonly<
  z.output<typeof safeFetchRequestSchema>
>;

export const safeFetchResultSchema = z.object({
  requestedUrl: urlValueSchema,
  finalUrl: urlValueSchema,
  status: z.number().int().min(100).max(599),
  contentType: z.string().trim().min(1).max(255),
  xRobotsTag: z.string().trim().min(1).max(2_048).nullable().optional(),
  body: z.instanceof(Uint8Array),
  redirectChain: z.array(urlValueSchema),
  resolvedIps: z.array(z.string().trim().min(1).max(64)),
  fetchedAt: timestampSchema,
}).strict();

type ParsedSafeFetchResult = z.output<typeof safeFetchResultSchema>;

export type SafeFetchResult = Readonly<
  Omit<ParsedSafeFetchResult, "redirectChain" | "resolvedIps"> & {
    redirectChain: readonly string[];
    resolvedIps: readonly string[];
  }
>;

export const safeFetchFailureCodes = {
  invalidRequest: "SAFE_FETCH_INVALID_REQUEST",
  urlBlocked: "SAFE_FETCH_URL_BLOCKED",
  dnsResolutionFailed: "SAFE_FETCH_DNS_RESOLUTION_FAILED",
  networkBlocked: "SAFE_FETCH_NETWORK_BLOCKED",
  redirectLimitExceeded: "SAFE_FETCH_REDIRECT_LIMIT_EXCEEDED",
  timeout: "SAFE_FETCH_TIMEOUT",
  responseTooLarge: "SAFE_FETCH_RESPONSE_TOO_LARGE",
  unsupportedContentType: "SAFE_FETCH_UNSUPPORTED_CONTENT_TYPE",
  transportFailed: "SAFE_FETCH_TRANSPORT_FAILED",
} as const;

export type SafeFetchFailureCode =
  (typeof safeFetchFailureCodes)[keyof typeof safeFetchFailureCodes];

export const safeFetchFailureRetryability = {
  [safeFetchFailureCodes.invalidRequest]: false,
  [safeFetchFailureCodes.urlBlocked]: false,
  [safeFetchFailureCodes.dnsResolutionFailed]: true,
  [safeFetchFailureCodes.networkBlocked]: false,
  [safeFetchFailureCodes.redirectLimitExceeded]: false,
  [safeFetchFailureCodes.timeout]: true,
  [safeFetchFailureCodes.responseTooLarge]: false,
  [safeFetchFailureCodes.unsupportedContentType]: false,
  [safeFetchFailureCodes.transportFailed]: true,
} as const satisfies Record<SafeFetchFailureCode, boolean>;

export const safeFetchFailureCodeSchema = z.enum(
  Object.values(safeFetchFailureCodes),
);

export const safeFetchFailureSchema = z.object({
  code: safeFetchFailureCodeSchema,
  requestedUrl: urlValueSchema,
  message: z.string().trim().min(1).max(1_024),
  retryable: z.boolean(),
}).strict().superRefine((failure, context) => {
  if (failure.retryable !== safeFetchFailureRetryability[failure.code]) {
    context.addIssue({
      code: "custom",
      path: ["retryable"],
      message: `Retryability does not match ${failure.code}.`,
    });
  }
});

export type SafeFetchFailure = Readonly<
  z.output<typeof safeFetchFailureSchema>
>;

export class SafeFetchError extends Error {
  readonly code: SafeFetchFailureCode;
  readonly requestedUrl: string;
  readonly retryable: boolean;

  constructor(failure: SafeFetchFailure, options?: ErrorOptions) {
    const parsed = safeFetchFailureSchema.parse(failure);
    super(parsed.message, options);
    this.name = "SafeFetchError";
    this.code = parsed.code;
    this.requestedUrl = parsed.requestedUrl;
    this.retryable = parsed.retryable;
  }
}

export interface SafeFetchPort {
  fetch(request: SafeFetchRequest): Promise<SafeFetchResult>;
}
