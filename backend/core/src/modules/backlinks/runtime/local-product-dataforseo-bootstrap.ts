import { z } from "zod";

import {
  localProductDataForSeoCredentialReference,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import { secretKinds } from "../ports/secret-store.port.js";

export const localProductDataForSeoEndpoint =
  "https://api.dataforseo.com/v3/backlinks/referring_domains/live";
const maximumBudgetMicros = 100_000_000;
const projectKeySchema = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const domainSchema = z.string().trim().toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u,
  )
  .refine(
    (value) =>
      value !== "example.invalid" && !value.endsWith(".example.invalid"),
    "Demo domains are forbidden.",
  );
const nonBlankList = z.array(z.string().trim().min(1).max(512))
  .min(1)
  .max(100);
const targetUrlSchema = z.string().trim().url().max(2_048)
  .superRefine((value, context) => {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.hostname === "example.invalid"
      || url.hostname.endsWith(".example.invalid")
    ) {
      context.addIssue({
        code: "custom",
        message: "Target URLs must be credential-free HTTPS product URLs.",
      });
    }
  });
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
  if (!value.includes(localProductDataForSeoEndpoint)) {
    context.addIssue({
      code: "custom",
      message: "DataForSEO endpoint allowlist must include the runtime endpoint.",
    });
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
  websiteProjectKey: projectKeySchema,
  credentialSecretRef: localProductDataForSeoCredentialReferenceSchema
    .default(localProductDataForSeoCredentialReference),
  endpointAllowlist: localProductDataForSeoEndpointAllowlistSchema,
  timeoutMs: z.coerce.number().int().positive().max(120_000),
  estimatedCostMicros: z.coerce.number().int().positive()
    .max(maximumBudgetMicros),
  absoluteBudgetMicros: z.coerce.number().int().positive()
    .max(maximumBudgetMicros),
  maxPaidCalls: z.coerce.number().int().min(1).max(1_000),
  candidateLimit: z.coerce.number().int().min(10).max(100),
  locationCode: z.string().trim().min(1).max(64),
  languageCode: z.string().trim().min(1).max(32),
  discoveryTargets: z.array(domainSchema).min(1).max(100),
  keywords: nonBlankList,
  products: nonBlankList,
  targetUrls: z.array(targetUrlSchema).min(1).max(100),
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
  runtime: z.object({
    websiteProjectKey: projectKeySchema,
  }).passthrough(),
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
  "DATAFORSEO_LOCATION_CODE",
  "DATAFORSEO_LANGUAGE_CODE",
  "DATAFORSEO_DISCOVERY_TARGETS_JSON",
  "DATAFORSEO_PROJECT_KEYWORDS_JSON",
  "DATAFORSEO_PROJECT_PRODUCTS_JSON",
  "DATAFORSEO_TARGET_URLS_JSON",
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
    DATAFORSEO_LOCATION_CODE: input.locationCode,
    DATAFORSEO_LANGUAGE_CODE: input.languageCode,
    DATAFORSEO_DISCOVERY_TARGETS_JSON:
      JSON.stringify(input.discoveryTargets),
    DATAFORSEO_PROJECT_KEYWORDS_JSON: JSON.stringify(input.keywords),
    DATAFORSEO_PROJECT_PRODUCTS_JSON: JSON.stringify(input.products),
    DATAFORSEO_TARGET_URLS_JSON: JSON.stringify(input.targetUrls),
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
  if (manifest.runtime.websiteProjectKey !== input.websiteProjectKey) {
    throw new Error("LOCAL_PRODUCT_DATAFORSEO_PROJECT_CONTEXT_MISMATCH");
  }
  return {
    ...manifest,
    dataForSeo: {
      provider: "dataforseo",
      websiteProjectKey: input.websiteProjectKey,
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
