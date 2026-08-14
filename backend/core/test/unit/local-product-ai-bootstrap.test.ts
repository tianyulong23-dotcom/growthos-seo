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
  modelVersion: "2026-08-03",
  maxCalls: 25,
  timeoutMs: 45_000,
  maxInputTokens: 8_000,
  maxOutputTokens: 1_200,
  absoluteBudgetUsd: 0.1,
  inputCostUsdPerMillionTokens: 1,
  outputCostUsdPerMillionTokens: 2,
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
      AI_PROVIDER_CREDENTIAL_SECRET_REF:
        "secret://growthos/local-product/ai/provider-credential/v1",
      AI_PROVIDER_MAX_CALLS: "25",
      AI_PROVIDER_ABSOLUTE_BUDGET_USD: "0.1",
    });
    expect(JSON.stringify(environment)).not.toContain(input.apiKey);
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
  });

  it("uses the same bounded two-attempt reservation as the runtime", () => {
    expect(calculateMaximumReservationUsd(input)).toBe(0.0208);
  });
});
