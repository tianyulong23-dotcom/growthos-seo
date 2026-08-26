import { z } from "zod";

import {
  localProductDataForSeoCredentialReference,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import { secretKinds } from "../ports/secret-store.port.js";

export const localProductDataForSeoEndpoints = Object.freeze([
  "https://api.dataforseo.com/v3/serp/google/organic/task_post",
  "https://api.dataforseo.com/v3/serp/id_list",
  "https://api.dataforseo.com/v3/serp/google/organic/tasks_ready",
  "https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced",
  "https://api.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live",
  "https://api.dataforseo.com/v3/dataforseo_labs/google/bulk_traffic_estimation/live",
  "https://api.dataforseo.com/v3/backlinks/competitors/live",
  "https://api.dataforseo.com/v3/backlinks/referring_domains/live",
  "https://api.dataforseo.com/v3/backlinks/summary/live",
  "https://api.dataforseo.com/v3/backlinks/backlinks/live",
  "https://api.dataforseo.com/v3/backlinks/bulk_spam_score/live",
  "https://api.dataforseo.com/v3/backlinks/bulk_ranks/live",
] as const);
export const localProductDataForSeoEndpoint =
  "https://api.dataforseo.com/v3/backlinks/referring_domains/live";
export const localProductDataForSeoMaximumTimeoutMs = 300_000;
const maximumBudgetMicros = 100_000_000;
const dataForSeoEndpointSchema = z.string().trim().url().max(2_048)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.hostname !== "api.dataforseo.com"
      || url.port !== ""
      || url.username !== ""
      || url.password !== ""
      || !url.pathname.startsWith("/v3/")
      || url.search !== ""
      || url.hash !== ""
    ) {
      context.addIssue({
        code: "custom",
        message: "DataForSEO endpoints must be credential-free official v3 HTTPS URLs.",
      });
    }
  });
export const localProductDataForSeoEndpointAllowlistSchema = z.array(
  dataForSeoEndpointSchema,
).min(1).max(16).superRefine((value, context) => {
  const approved = new Set<string>(localProductDataForSeoEndpoints);
  for (const endpoint of value) {
    if (!approved.has(endpoint)) {
      context.addIssue({
        code: "custom",
        message:
          "DataForSEO endpoint allowlist contains an unapproved endpoint.",
      });
    }
  }
});
export const localProductDataForSeoCredentialReferenceSchema = z.string()
  .trim().min(1).max(2_048).superRefine((value, context) => {
    try {
      parseLocalProductSecretReference(
        value,
        secretKinds.dataForSeoCredential,
      );
    } catch {
      context.addIssue({
        code: "custom",
        message: "DataForSEO Secret Reference is invalid.",
      });
    }
  });

export const localProductDataForSeoBootstrapInputSchema = z.object({
  login: z.string().trim().min(1).max(1_024),
  password: z.string().min(1).max(4_096),
  credentialSecretRef: localProductDataForSeoCredentialReferenceSchema
    .default(localProductDataForSeoCredentialReference),
  endpointAllowlist: localProductDataForSeoEndpointAllowlistSchema,
  timeoutMs: z.coerce.number().int().positive()
    .max(localProductDataForSeoMaximumTimeoutMs),
  estimatedCostMicros: z.coerce.number().int().positive()
    .max(maximumBudgetMicros),
  absoluteBudgetMicros: z.coerce.number().int().positive()
    .max(maximumBudgetMicros),
  maxPaidCalls: z.coerce.number().int().min(1).max(1_000),
  candidateLimit: z.coerce.number().int().min(10).max(100),
}).strict().superRefine((input, context) => {
  if (input.absoluteBudgetMicros < input.estimatedCostMicros) {
    context.addIssue({
      code: "custom",
      path: ["absoluteBudgetMicros"],
      message: "DataForSEO budget must cover the estimated request cost.",
    });
  }
});

export type LocalProductDataForSeoBootstrapInput = Readonly<
  z.output<typeof localProductDataForSeoBootstrapInputSchema>
>;

const manifestSchema = z.object({
  schemaVersion: z.literal("growthos.live-auth.v1"),
  dataForSeo: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const localProductDataForSeoEnvironmentNames = Object.freeze([
  "DATAFORSEO_CREDENTIAL_SECRET_REF",
  "DATAFORSEO_ENDPOINT_ALLOWLIST",
  "DATAFORSEO_REQUEST_TIMEOUT_MS",
  "DATAFORSEO_ESTIMATED_COST_MICROS",
  "DATAFORSEO_ABSOLUTE_BUDGET_MICROS",
  "DATAFORSEO_MAX_PAID_CALLS",
  "DATAFORSEO_CANDIDATE_LIMIT",
] as const);

export function buildLocalProductDataForSeoEnvironment(
  value: LocalProductDataForSeoBootstrapInput,
): Readonly<Record<
  (typeof localProductDataForSeoEnvironmentNames)[number],
  string
>> {
  const input = localProductDataForSeoBootstrapInputSchema.parse(value);
  return Object.freeze({
    DATAFORSEO_CREDENTIAL_SECRET_REF: input.credentialSecretRef,
    DATAFORSEO_ENDPOINT_ALLOWLIST: JSON.stringify(input.endpointAllowlist),
    DATAFORSEO_REQUEST_TIMEOUT_MS: String(input.timeoutMs),
    DATAFORSEO_ESTIMATED_COST_MICROS: String(input.estimatedCostMicros),
    DATAFORSEO_ABSOLUTE_BUDGET_MICROS: String(input.absoluteBudgetMicros),
    DATAFORSEO_MAX_PAID_CALLS: String(input.maxPaidCalls),
    DATAFORSEO_CANDIDATE_LIMIT: String(input.candidateLimit),
  });
}

export function updateLocalProductDataForSeoManifest(
  current: unknown,
  value: LocalProductDataForSeoBootstrapInput,
  now: Date,
): Record<string, unknown> {
  const manifest = manifestSchema.parse(current);
  const input = localProductDataForSeoBootstrapInputSchema.parse(value);
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("LOCAL_PRODUCT_DATAFORSEO_EXECUTION_TIME_INVALID");
  }
  return {
    ...manifest,
    dataForSeo: {
      provider: "dataforseo",
      endpointAllowlist: input.endpointAllowlist,
      credentialSecretRef: input.credentialSecretRef,
      maxCalls: input.maxPaidCalls,
      candidateLimit: input.candidateLimit,
      estimatedCostMicros: input.estimatedCostMicros,
      currency: "USD_MICROS",
      absoluteBudgetMicros: input.absoluteBudgetMicros,
      configuredAt: now.toISOString(),
    },
  };
}
