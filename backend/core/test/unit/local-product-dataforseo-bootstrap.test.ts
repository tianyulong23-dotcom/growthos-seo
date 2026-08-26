import { describe, expect, it } from "vitest";

import {
  buildLocalProductDataForSeoEnvironment,
  localProductDataForSeoEndpoints,
  localProductDataForSeoBootstrapInputSchema,
  updateLocalProductDataForSeoManifest,
} from "../../src/modules/backlinks/runtime/local-product-dataforseo-bootstrap.js";

const input = {
  login: "account@example.com",
  password: "protected-provider-password",
  credentialSecretRef:
    "secret://growthos/local-product/dataforseo/provider-credential/v7",
  endpointAllowlist: [...localProductDataForSeoEndpoints],
  timeoutMs: 60_000,
  estimatedCostMicros: 1_000,
  absoluteBudgetMicros: 5_000,
  maxPaidCalls: 25,
  candidateLimit: 25,
} as const;

const manifest = {
  schemaVersion: "growthos.live-auth.v1",
  runtime: { websiteProjectKey: "elephtv" },
  dataForSeo: {
    provider: null,
    credentialSecretRef: null,
  },
};

describe("LOCAL_PRODUCT DataForSEO bootstrap", () => {
  it("builds only bounded non-secret environment values", () => {
    const environment = buildLocalProductDataForSeoEnvironment(input);
    expect(environment).toMatchObject({
      DATAFORSEO_CREDENTIAL_SECRET_REF:
        "secret://growthos/local-product/dataforseo/provider-credential/v7",
      DATAFORSEO_ENDPOINT_ALLOWLIST:
        JSON.stringify(localProductDataForSeoEndpoints),
      DATAFORSEO_REQUEST_TIMEOUT_MS: "60000",
      DATAFORSEO_ESTIMATED_COST_MICROS: "1000",
      DATAFORSEO_ABSOLUTE_BUDGET_MICROS: "5000",
      DATAFORSEO_MAX_PAID_CALLS: "25",
      DATAFORSEO_CANDIDATE_LIMIT: "25",
    });
    expect(JSON.stringify(environment)).not.toContain(input.login);
    expect(JSON.stringify(environment)).not.toContain(input.password);
    expect(environment).not.toHaveProperty("DATAFORSEO_LOCATION_CODE");
    expect(environment).not.toHaveProperty("DATAFORSEO_LANGUAGE_CODE");
    expect(environment).not.toHaveProperty("DATAFORSEO_PROJECT_KEYWORDS_JSON");
    expect(environment).not.toHaveProperty("DATAFORSEO_PROJECT_PRODUCTS_JSON");
    expect(environment).not.toHaveProperty("DATAFORSEO_TARGET_URLS_JSON");
  });

  it("updates only the safe manifest section for bounded paid calls", () => {
    const updated = updateLocalProductDataForSeoManifest(
      manifest,
      input,
      new Date("2026-08-04T10:00:00.000Z"),
    );
    expect(updated).toMatchObject({
      runtime: { websiteProjectKey: "elephtv" },
      dataForSeo: {
        provider: "dataforseo",
        endpointAllowlist: [...localProductDataForSeoEndpoints],
        credentialSecretRef:
          "secret://growthos/local-product/dataforseo/provider-credential/v7",
        maxCalls: 25,
        currency: "USD_MICROS",
        absoluteBudgetMicros: 5_000,
        configuredAt: "2026-08-04T10:00:00.000Z",
      },
    });
    expect(JSON.stringify(updated)).not.toContain(input.login);
    expect(JSON.stringify(updated)).not.toContain(input.password);
  });

  it("allows a bounded approved endpoint subset", () => {
    expect(() => localProductDataForSeoBootstrapInputSchema.parse({
      ...input,
      endpointAllowlist: [
        "https://api.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live",
        "https://api.dataforseo.com/v3/backlinks/backlinks/live",
        "https://api.dataforseo.com/v3/backlinks/bulk_spam_score/live",
      ],
    })).not.toThrow();
  });

  it("rejects unsafe endpoints, excess calls, and fake inputs", () => {
    expect(() => localProductDataForSeoBootstrapInputSchema.parse({
      ...input,
      timeoutMs: 300_000,
    })).not.toThrow();
    expect(() => localProductDataForSeoBootstrapInputSchema.parse({
      ...input,
      timeoutMs: 300_001,
    })).toThrow();
    expect(() => localProductDataForSeoBootstrapInputSchema.parse({
      ...input,
      endpointAllowlist: [
        "https://api.dataforseo.com/v3/backlinks/history/live",
      ],
    })).toThrow();
    expect(() => localProductDataForSeoBootstrapInputSchema.parse({
      ...input,
      maxPaidCalls: 1_001,
    })).toThrow();
    expect(() => localProductDataForSeoBootstrapInputSchema.parse({
      ...input,
      credentialSecretRef:
        "secret://growthos/local-product/google/provider-credential/v1",
    })).toThrow();
    expect(() => localProductDataForSeoBootstrapInputSchema.parse({
      ...input,
      websiteProjectKey: "legacy-project-bound-input",
    })).toThrow();
  });
});
