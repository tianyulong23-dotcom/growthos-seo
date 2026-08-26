import { describe, expect, it } from "vitest";

import {
  buildLocalProductAiEnvironment,
  calculateMaximumReservationUsd,
  localProductAiBootstrapInputSchema,
  updateLocalProductAiManifest,
} from "../../src/modules/backlinks/runtime/local-product-ai-bootstrap.js";

const input = {
  apiKey: "protected-provider-key",
  providerRef: "vercel-ai-gateway",
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  modelId: "provider/model",
  discoveryModelId: "gpt-5.6-terra",
  modelVersion: "2026-08-03",
  maxCalls: 25,
  timeoutMs: 45_000,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_200,
  absoluteBudgetUsd: 0.1,
  inputCostUsdPerMillionTokens: 1,
  outputCostUsdPerMillionTokens: 2,
  discoveryMaxCalls: 5,
  discoveryAbsoluteBudgetUsd: 0.05,
  discoveryWindowSeconds: 3_600,
  discoveryMaxConcurrency: 1,
  discoveryMaxWorkItemsPerGeneration: 1,
  outreachDraftMaxCalls: 20,
  outreachDraftAbsoluteBudgetUsd: 0.08,
  outreachDraftWindowSeconds: 7_200,
  outreachDraftMaxConcurrency: 2,
} as const;

const manifest = {
  schemaVersion: "growthos.live-auth.v1",
  authorization: {
    approvedBy: "local-owner",
    validUntil: "2026-08-09T10:00:00.000Z",
  },
  runtime: { websiteProjectKey: "elephtv" },
  ai: {
    provider: null,
    model: null,
    credentialSecretRef: null,
  },
};

describe("LOCAL_PRODUCT AI bootstrap", () => {
  it("builds only non-secret environment values", () => {
    const environment = buildLocalProductAiEnvironment(input);
    expect(environment).toMatchObject({
      AI_PROVIDER_REF: "vercel-ai-gateway",
      AI_PROVIDER_BASE_URL: "https://ai-gateway.vercel.sh/v1",
      AI_MODEL_ID: "provider/model",
      AI_DISCOVERY_MODEL_ID: "gpt-5.6-terra",
      AI_PROVIDER_CREDENTIAL_SECRET_REF:
        "secret://growthos/local-product/ai/provider-credential/v1",
      AI_PROVIDER_MAX_CALLS: "25",
      AI_PROVIDER_ABSOLUTE_BUDGET_USD: "0.1",
      AI_DISCOVERY_MAX_CALLS: "5",
      AI_DISCOVERY_ABSOLUTE_BUDGET_USD: "0.05",
      AI_DISCOVERY_WINDOW_SECONDS: "3600",
      AI_DISCOVERY_MAX_CONCURRENCY: "1",
      AI_DISCOVERY_MAX_WORK_ITEMS_PER_GENERATION: "1",
      AI_OUTREACH_DRAFT_MAX_CALLS: "20",
      AI_OUTREACH_DRAFT_ABSOLUTE_BUDGET_USD: "0.08",
      AI_OUTREACH_DRAFT_WINDOW_SECONDS: "7200",
      AI_OUTREACH_DRAFT_MAX_CONCURRENCY: "2",
    });
    expect(JSON.stringify(environment)).not.toContain(input.apiKey);
  });

  it("uses Terra for discovery when no capability override is supplied", () => {
    const withoutOverride = {
      ...input,
      discoveryModelId: undefined,
    };

    expect(buildLocalProductAiEnvironment(withoutOverride)).toMatchObject({
      AI_MODEL_ID: "provider/model",
      AI_DISCOVERY_MODEL_ID: "gpt-5.6-terra",
    });
    expect(updateLocalProductAiManifest(
      manifest,
      withoutOverride,
    )).toMatchObject({
      ai: {
        model: "provider/model",
        capabilities: {
          AI_DISCOVERY: {
            model: "gpt-5.6-terra",
          },
        },
      },
    });
  });

  it("accepts OpenAI and rejects providers outside the exact allowlist", () => {
    expect(localProductAiBootstrapInputSchema.parse({
      ...input,
      providerRef: "openai",
      baseUrl: "https://sub2.indexarc.net/v1/",
      modelId: "gpt-5.6-sol",
    })).toMatchObject({
      providerRef: "openai",
      baseUrl: "https://sub2.indexarc.net/v1",
      modelId: "gpt-5.6-sol",
    });
    expect(() => localProductAiBootstrapInputSchema.parse({
      ...input,
      providerRef: "unapproved-provider",
    })).toThrow();
  });

  it("updates only the safe Manifest AI section with bounded calls", () => {
    const updated = updateLocalProductAiManifest(manifest, input);
    expect(updated).toMatchObject({
      runtime: { websiteProjectKey: "elephtv" },
      ai: {
        provider: "vercel-ai-gateway",
        baseUrl: "https://ai-gateway.vercel.sh/v1",
        model: "provider/model",
        credentialSecretRef:
          "secret://growthos/local-product/ai/provider-credential/v1",
        maxCalls: 25,
        currency: "USD",
        capabilities: {
          AI_DISCOVERY: {
            model: "gpt-5.6-terra",
            maxCalls: 5,
            absoluteBudget: 0.05,
            windowSeconds: 3_600,
            maxConcurrency: 1,
            maxWorkItemsPerGeneration: 1,
          },
          AI_OUTREACH_DRAFT: {
            maxCalls: 20,
            absoluteBudget: 0.08,
            windowSeconds: 7_200,
            maxConcurrency: 2,
          },
        },
      },
    });
    expect(JSON.stringify(updated)).not.toContain(input.apiKey);
  });

  it("rejects unsafe identifiers, call limits, and excess budgets", () => {
    expect(() => localProductAiBootstrapInputSchema.parse({
      ...input,
      modelId: "provider/model\nLEAK",
    })).toThrow();
    expect(() => localProductAiBootstrapInputSchema.parse({
      ...input,
      providerRef: "openai",
      baseUrl: "http://sub2.indexarc.net/v1",
    })).toThrow();
    expect(() => localProductAiBootstrapInputSchema.parse({
      ...input,
      providerRef: "openai",
      baseUrl: "https://user:password@sub2.indexarc.net/v1",
    })).toThrow();
    expect(() => localProductAiBootstrapInputSchema.parse({
      ...input,
      providerRef: "vercel-ai-gateway",
      baseUrl: "https://unexpected.example/v1",
    })).toThrow();
    expect(() => localProductAiBootstrapInputSchema.parse({
      ...input,
      absoluteBudgetUsd: 1.01,
    })).toThrow();
    expect(() => localProductAiBootstrapInputSchema.parse({
      ...input,
      absoluteBudgetUsd: 0.000001,
    })).toThrow();
    expect(() => localProductAiBootstrapInputSchema.parse({
      ...input,
      maxCalls: 10_001,
    })).toThrow();
    expect(() => localProductAiBootstrapInputSchema.parse({
      ...input,
      discoveryAbsoluteBudgetUsd: 0.001,
    })).toThrow();
    expect(() => localProductAiBootstrapInputSchema.parse({
      ...input,
      outreachDraftAbsoluteBudgetUsd: 0.01,
    })).toThrow();
  });

  it("uses the same bounded two-attempt reservation as the runtime", () => {
    expect(calculateMaximumReservationUsd(input)).toBe(0.0208);
  });
});
