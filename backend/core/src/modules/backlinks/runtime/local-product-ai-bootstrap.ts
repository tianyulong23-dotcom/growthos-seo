import { z } from "zod";

import {
  localProductAiProviderCredentialReference,
} from "../adapters/security/local-product-secret-store-client.js";

export const localProductAiProviderRefs = Object.freeze([
  "openai",
  "vercel-ai-gateway",
] as const);
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
  modelId: safeIdentifier,
  modelVersion: safeIdentifier,
  maxCalls: positiveInteger.max(10_000),
  timeoutMs: positiveInteger.max(45_000),
  maxInputTokens: positiveInteger.max(100_000),
  maxOutputTokens: positiveInteger.max(20_000),
  absoluteBudgetUsd: positiveNumber.max(maxLocalProductBudgetUsd),
  inputCostUsdPerMillionTokens: positiveNumber.max(1_000),
  outputCostUsdPerMillionTokens: positiveNumber.max(1_000),
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
  "AI_MODEL_ID",
  "AI_MODEL_VERSION",
  "AI_PROVIDER_CREDENTIAL_SECRET_REF",
  "AI_PROVIDER_MAX_CALLS",
  "AI_PROVIDER_TIMEOUT_MS",
  "AI_PROVIDER_MAX_INPUT_TOKENS",
  "AI_PROVIDER_MAX_OUTPUT_TOKENS",
  "AI_PROVIDER_ABSOLUTE_BUDGET_USD",
  "AI_PROVIDER_INPUT_COST_USD_PER_MILLION_TOKENS",
  "AI_PROVIDER_OUTPUT_COST_USD_PER_MILLION_TOKENS",
] as const);

export function calculateMaximumReservationUsd(
  input: Readonly<{
    maxInputTokens: number;
    maxOutputTokens: number;
    inputCostUsdPerMillionTokens: number;
    outputCostUsdPerMillionTokens: number;
  }>,
): number {
  return Number((2 * (
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
    AI_MODEL_ID: input.modelId,
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
      model: input.modelId,
      credentialSecretRef: localProductAiProviderCredentialReference,
      maxCalls: input.maxCalls,
      maxInputTokens: input.maxInputTokens,
      maxOutputTokens: input.maxOutputTokens,
      currency: "USD",
      absoluteBudget: input.absoluteBudgetUsd,
    },
  };
}
