import { z } from "zod";

import {
  localProductAiProviderCredentialReference,
} from "../adapters/security/local-product-secret-store-client.js";

export const localProductAiProviderRefs = Object.freeze([
  "openai",
  "vercel-ai-gateway",
] as const);
export const localProductAiDiscoveryModelId = "gpt-5.6-terra";
export type LocalProductAiProviderRef =
  (typeof localProductAiProviderRefs)[number];
const maxLocalProductBudgetUsd = 1;
const safeIdentifier = z.string().trim().min(1).max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);
const positiveInteger = z.coerce.number().int().positive();
const positiveNumber = z.coerce.number().finite().positive();
export const localProductAiProviderBaseUrlSchema = z.string()
  .trim()
  .min(1)
  .max(2_048)
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "AI Provider Base URL must be an absolute URL.",
      });
      return z.NEVER;
    }
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.search !== ""
      || url.hash !== ""
    ) {
      context.addIssue({
        code: "custom",
        message:
          "AI Provider Base URL must use HTTPS without credentials, query, or hash.",
      });
      return z.NEVER;
    }
    const pathname = url.pathname.replace(/\/+$/u, "");
    return `${url.origin}${pathname}`;
  });

export const localProductAiBootstrapInputSchema = z.object({
  apiKey: z.string().trim().min(1).max(4_096),
  providerRef: z.enum(localProductAiProviderRefs),
  baseUrl: localProductAiProviderBaseUrlSchema,
  proxyMode: z.enum(["direct", "inherit"]).default("direct"),
  modelId: safeIdentifier,
  discoveryModelId: safeIdentifier.optional(),
  modelVersion: safeIdentifier,
  maxCalls: positiveInteger.max(10_000),
  timeoutMs: positiveInteger.max(45_000),
  maxInputTokens: positiveInteger.max(100_000),
  maxOutputTokens: positiveInteger.max(20_000),
  absoluteBudgetUsd: positiveNumber.max(maxLocalProductBudgetUsd),
  inputCostUsdPerMillionTokens: positiveNumber.max(1_000),
  outputCostUsdPerMillionTokens: positiveNumber.max(1_000),
  discoveryMaxCalls: positiveInteger.max(10_000).optional(),
  discoveryAbsoluteBudgetUsd:
    positiveNumber.max(maxLocalProductBudgetUsd).optional(),
  discoveryWindowSeconds: positiveInteger.max(31_536_000).optional(),
  discoveryMaxConcurrency: positiveInteger.max(100).optional(),
  discoveryMaxWorkItemsPerGeneration: positiveInteger.max(100).optional(),
  outreachDraftMaxCalls: positiveInteger.max(10_000).optional(),
  outreachDraftAbsoluteBudgetUsd:
    positiveNumber.max(maxLocalProductBudgetUsd).optional(),
  outreachDraftWindowSeconds: positiveInteger.max(31_536_000).optional(),
  outreachDraftMaxConcurrency: positiveInteger.max(100).optional(),
}).strict().superRefine((input, context) => {
  if (
    input.providerRef === "vercel-ai-gateway"
    && input.baseUrl !== "https://ai-gateway.vercel.sh/v1"
  ) {
    context.addIssue({
      code: "custom",
      path: ["baseUrl"],
      message: "Vercel AI Gateway must use its fixed Provider Base URL.",
    });
  }
  if (calculateMaximumReservationUsd(input) > input.absoluteBudgetUsd) {
    context.addIssue({
      code: "custom",
      path: ["absoluteBudgetUsd"],
      message: "Absolute budget must cover the bounded two-attempt cost.",
    });
  }
  const oneCallReservationUsd = calculateMaximumReservationUsd(
    input,
    1,
  );
  if (
    input.discoveryAbsoluteBudgetUsd !== undefined
    && oneCallReservationUsd > input.discoveryAbsoluteBudgetUsd
  ) {
    context.addIssue({
      code: "custom",
      path: ["discoveryAbsoluteBudgetUsd"],
      message: "Discovery budget must cover one bounded provider call.",
    });
  }
  if (
    input.outreachDraftAbsoluteBudgetUsd !== undefined
    && calculateMaximumReservationUsd(input)
      > input.outreachDraftAbsoluteBudgetUsd
  ) {
    context.addIssue({
      code: "custom",
      path: ["outreachDraftAbsoluteBudgetUsd"],
      message: "Outreach Draft budget must cover two bounded provider calls.",
    });
  }
});

export type LocalProductAiBootstrapInput = Readonly<
  z.output<typeof localProductAiBootstrapInputSchema>
>;

const manifestSchema = z.object({
  schemaVersion: z.literal("growthos.live-auth.v1"),
  ai: z.record(z.string(), z.unknown()),
}).passthrough();

export const localProductAiEnvironmentNames = Object.freeze([
  "AI_PROVIDER_REF",
  "AI_PROVIDER_BASE_URL",
  "AI_PROVIDER_PROXY_MODE",
  "AI_MODEL_ID",
  "AI_DISCOVERY_MODEL_ID",
  "AI_MODEL_VERSION",
  "AI_PROVIDER_CREDENTIAL_SECRET_REF",
  "AI_PROVIDER_MAX_CALLS",
  "AI_PROVIDER_TIMEOUT_MS",
  "AI_PROVIDER_MAX_INPUT_TOKENS",
  "AI_PROVIDER_MAX_OUTPUT_TOKENS",
  "AI_PROVIDER_ABSOLUTE_BUDGET_USD",
  "AI_PROVIDER_INPUT_COST_USD_PER_MILLION_TOKENS",
  "AI_PROVIDER_OUTPUT_COST_USD_PER_MILLION_TOKENS",
  "AI_DISCOVERY_MAX_CALLS",
  "AI_DISCOVERY_ABSOLUTE_BUDGET_USD",
  "AI_DISCOVERY_WINDOW_SECONDS",
  "AI_DISCOVERY_MAX_CONCURRENCY",
  "AI_DISCOVERY_MAX_WORK_ITEMS_PER_GENERATION",
  "AI_OUTREACH_DRAFT_MAX_CALLS",
  "AI_OUTREACH_DRAFT_ABSOLUTE_BUDGET_USD",
  "AI_OUTREACH_DRAFT_WINDOW_SECONDS",
  "AI_OUTREACH_DRAFT_MAX_CONCURRENCY",
] as const);

export function calculateMaximumReservationUsd(
  input: Readonly<{
    maxInputTokens: number;
    maxOutputTokens: number;
    inputCostUsdPerMillionTokens: number;
    outputCostUsdPerMillionTokens: number;
  }>,
  providerCalls = 2,
): number {
  return Number((providerCalls * (
    input.maxInputTokens * input.inputCostUsdPerMillionTokens
    + input.maxOutputTokens * input.outputCostUsdPerMillionTokens
  ) / 1_000_000).toFixed(6));
}

export function buildLocalProductAiEnvironment(
  value: LocalProductAiBootstrapInput,
): Readonly<Record<
  (typeof localProductAiEnvironmentNames)[number],
  string
>> {
  const input = localProductAiBootstrapInputSchema.parse(value);
  return Object.freeze({
    AI_PROVIDER_REF: input.providerRef,
    AI_PROVIDER_BASE_URL: input.baseUrl,
    AI_PROVIDER_PROXY_MODE: input.proxyMode,
    AI_MODEL_ID: input.modelId,
    AI_DISCOVERY_MODEL_ID:
      input.discoveryModelId ?? localProductAiDiscoveryModelId,
    AI_MODEL_VERSION: input.modelVersion,
    AI_PROVIDER_CREDENTIAL_SECRET_REF:
      localProductAiProviderCredentialReference,
    AI_PROVIDER_MAX_CALLS: String(input.maxCalls),
    AI_PROVIDER_TIMEOUT_MS: String(input.timeoutMs),
    AI_PROVIDER_MAX_INPUT_TOKENS: String(input.maxInputTokens),
    AI_PROVIDER_MAX_OUTPUT_TOKENS: String(input.maxOutputTokens),
    AI_PROVIDER_ABSOLUTE_BUDGET_USD: String(input.absoluteBudgetUsd),
    AI_PROVIDER_INPUT_COST_USD_PER_MILLION_TOKENS:
      String(input.inputCostUsdPerMillionTokens),
    AI_PROVIDER_OUTPUT_COST_USD_PER_MILLION_TOKENS:
      String(input.outputCostUsdPerMillionTokens),
    AI_DISCOVERY_MAX_CALLS:
      String(input.discoveryMaxCalls ?? input.maxCalls),
    AI_DISCOVERY_ABSOLUTE_BUDGET_USD:
      String(input.discoveryAbsoluteBudgetUsd ?? input.absoluteBudgetUsd),
    AI_DISCOVERY_WINDOW_SECONDS:
      String(input.discoveryWindowSeconds ?? 86_400),
    AI_DISCOVERY_MAX_CONCURRENCY:
      String(input.discoveryMaxConcurrency ?? 1),
    AI_DISCOVERY_MAX_WORK_ITEMS_PER_GENERATION:
      String(input.discoveryMaxWorkItemsPerGeneration ?? 1),
    AI_OUTREACH_DRAFT_MAX_CALLS:
      String(input.outreachDraftMaxCalls ?? input.maxCalls),
    AI_OUTREACH_DRAFT_ABSOLUTE_BUDGET_USD:
      String(input.outreachDraftAbsoluteBudgetUsd ?? input.absoluteBudgetUsd),
    AI_OUTREACH_DRAFT_WINDOW_SECONDS:
      String(input.outreachDraftWindowSeconds ?? 86_400),
    AI_OUTREACH_DRAFT_MAX_CONCURRENCY:
      String(input.outreachDraftMaxConcurrency ?? 2),
  });
}

export function updateLocalProductAiManifest(
  current: unknown,
  value: LocalProductAiBootstrapInput,
): Record<string, unknown> {
  const manifest = manifestSchema.parse(current);
  const input = localProductAiBootstrapInputSchema.parse(value);
  return {
    ...manifest,
    ai: {
      ...manifest.ai,
      provider: input.providerRef,
      baseUrl: input.baseUrl,
      proxyMode: input.proxyMode,
      model: input.modelId,
      credentialSecretRef: localProductAiProviderCredentialReference,
      maxCalls: input.maxCalls,
      maxInputTokens: input.maxInputTokens,
      maxOutputTokens: input.maxOutputTokens,
      currency: "USD",
      absoluteBudget: input.absoluteBudgetUsd,
      capabilities: {
        AI_DISCOVERY: {
          model: input.discoveryModelId ?? localProductAiDiscoveryModelId,
          maxCalls: input.discoveryMaxCalls ?? input.maxCalls,
          absoluteBudget:
            input.discoveryAbsoluteBudgetUsd ?? input.absoluteBudgetUsd,
          windowSeconds: input.discoveryWindowSeconds ?? 86_400,
          maxConcurrency: input.discoveryMaxConcurrency ?? 1,
          maxWorkItemsPerGeneration:
            input.discoveryMaxWorkItemsPerGeneration ?? 1,
        },
        AI_OUTREACH_DRAFT: {
          maxCalls: input.outreachDraftMaxCalls ?? input.maxCalls,
          absoluteBudget:
            input.outreachDraftAbsoluteBudgetUsd ?? input.absoluteBudgetUsd,
          windowSeconds: input.outreachDraftWindowSeconds ?? 86_400,
          maxConcurrency: input.outreachDraftMaxConcurrency ?? 2,
        },
      },
    },
  };
}
