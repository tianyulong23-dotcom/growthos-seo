import { describe, expect, it } from "vitest";

import type {
  BacklinkTenantPool,
} from "../../src/modules/backlinks/db/tenant-transaction.js";
import {
  AiCapabilityBudgetError,
} from "../../src/modules/backlinks/db/repositories/ai-capability-budget.repository.js";
import {
  createLocalProductAiRuntime,
  readLocalProductAiConfiguration,
} from "../../src/modules/backlinks/runtime/local-product-ai-runtime.js";

const configuration = {
  providerRef: "vercel-ai-gateway",
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  proxyMode: "direct",
  modelId: "provider/model",
  discoveryModelId: "gpt-5.6-terra",
  modelVersion: "2026-08-01",
  credentialSecretReference:
    "secret://growthos/local-product/ai/provider-credential/v1",
  timeoutMs: 30_000,
  maxInputTokens: 100,
  maxOutputTokens: 100,
  inputCostUsdPerMillionTokens: 1,
  outputCostUsdPerMillionTokens: 1,
  discoveryMaxCalls: 5,
  discoveryAbsoluteBudgetUsd: 0.001,
  discoveryWindowSeconds: 3_600,
  discoveryMaxConcurrency: 1,
  discoveryMaxWorkItemsPerGeneration: 1,
  outreachDraftMaxCalls: 25,
  outreachDraftAbsoluteBudgetUsd: 0.002,
  outreachDraftWindowSeconds: 7_200,
  outreachDraftMaxConcurrency: 2,
} as const;

const scope = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
};

function killSwitchPool(blocked: boolean | null): BacklinkTenantPool {
  return {
    async connect() {
      return {
        async query(text) {
          if (text.includes("backlink_kill_switch_versions")) {
            return {
              rows: blocked === null
                ? []
                : [{
                    layer: "project",
                    capability: "AI_PROVIDER",
                    provider: null,
                    blocked,
                    version: 1,
                  }],
              rowCount: blocked === null ? 0 : 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
}

const legacyEnvironment = {
  AI_PROVIDER_REF: "vercel-ai-gateway",
  AI_PROVIDER_BASE_URL: "https://ai-gateway.vercel.sh/v1",
  AI_MODEL_ID: "provider/model",
  AI_MODEL_VERSION: "2026-08-01",
  AI_PROVIDER_CREDENTIAL_SECRET_REF:
    "secret://growthos/local-product/ai/provider-credential/v1",
  AI_PROVIDER_MAX_CALLS: "25",
  AI_PROVIDER_TIMEOUT_MS: "30000",
  AI_PROVIDER_MAX_INPUT_TOKENS: "100",
  AI_PROVIDER_MAX_OUTPUT_TOKENS: "100",
  AI_PROVIDER_ABSOLUTE_BUDGET_USD: "0.002",
  AI_PROVIDER_INPUT_COST_USD_PER_MILLION_TOKENS: "1",
  AI_PROVIDER_OUTPUT_COST_USD_PER_MILLION_TOKENS: "1",
} as const;

describe("LOCAL_PRODUCT AI runtime", () => {
  it("keeps legacy shared limits as independent capability defaults", () => {
    expect(readLocalProductAiConfiguration({
      ...legacyEnvironment,
    })).toMatchObject({
      discoveryModelId: "gpt-5.6-terra",
      discoveryMaxCalls: 25,
      discoveryAbsoluteBudgetUsd: 0.002,
      discoveryWindowSeconds: 86_400,
      discoveryMaxConcurrency: 1,
      discoveryMaxWorkItemsPerGeneration: 1,
      outreachDraftMaxCalls: 25,
      outreachDraftAbsoluteBudgetUsd: 0.002,
      outreachDraftWindowSeconds: 86_400,
      outreachDraftMaxConcurrency: 2,
    });
  });

  it("parses explicit independent capability limits", () => {
    expect(readLocalProductAiConfiguration({
      ...legacyEnvironment,
      AI_DISCOVERY_MAX_CALLS: "5",
      AI_DISCOVERY_MODEL_ID: "gpt-5.6-terra",
      AI_DISCOVERY_ABSOLUTE_BUDGET_USD: "0.001",
      AI_DISCOVERY_WINDOW_SECONDS: "3600",
      AI_DISCOVERY_MAX_CONCURRENCY: "1",
      AI_DISCOVERY_MAX_WORK_ITEMS_PER_GENERATION: "1",
      AI_OUTREACH_DRAFT_MAX_CALLS: "25",
      AI_OUTREACH_DRAFT_ABSOLUTE_BUDGET_USD: "0.002",
      AI_OUTREACH_DRAFT_WINDOW_SECONDS: "7200",
      AI_OUTREACH_DRAFT_MAX_CONCURRENCY: "2",
    })).toEqual(configuration);

    expect(readLocalProductAiConfiguration({
      ...legacyEnvironment,
      AI_PROVIDER_REF: "openai",
      AI_PROVIDER_BASE_URL: "https://sub2.indexarc.net/v1",
      AI_PROVIDER_PROXY_MODE: "inherit",
      AI_MODEL_ID: "gpt-5.6-sol",
      AI_DISCOVERY_MODEL_ID: "gpt-5.6-terra",
    })).toMatchObject({
      providerRef: "openai",
      baseUrl: "https://sub2.indexarc.net/v1",
      proxyMode: "inherit",
      modelId: "gpt-5.6-sol",
      discoveryModelId: "gpt-5.6-terra",
    });

    expect(() => readLocalProductAiConfiguration({
      ...legacyEnvironment,
      AI_PROVIDER_REF: "unapproved-provider",
    })).toThrow("BACKLINKS_AI_CONFIGURATION_INVALID:AI_PROVIDER_REF");

    expect(() => readLocalProductAiConfiguration({
      ...legacyEnvironment,
      AI_DISCOVERY_MAX_CONCURRENCY: "0",
    })).toThrow(
      "BACKLINKS_AI_CONFIGURATION_INVALID:AI_DISCOVERY_MAX_CONCURRENCY",
    );
  });

  it("fails closed when the Kill Switch authority has no allow decision", async () => {
    const runtime = createLocalProductAiRuntime({
      pool: killSwitchPool(null),
      secretStoreRoot: "C:\\GrowthOS\\secrets",
      configuration,
    });

    await expect(runtime.budgetGate.assertAvailable({
      ...scope,
      operation: "draft_generation",
    })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: false,
    });
  });

  it("preserves terminal draft replay without creating a new reservation", async () => {
    let budgetTouched = false;
    const runtime = createLocalProductAiRuntime({
      pool: {
        async connect() {
          return {
            async query(text) {
              if (text.includes("backlink_kill_switch_versions")) {
                return {
                  rows: [{
                    layer: "project",
                    capability: "AI_PROVIDER",
                    provider: null,
                    blocked: false,
                    version: 1,
                  }],
                  rowCount: 1,
                };
              }
              if (text.includes('quality_result AS "qualityResult"')) {
                return {
                  rows: [{
                    status: "SUCCEEDED",
                    qualityResult: { generationMode: "MODEL" },
                  }],
                  rowCount: 1,
                };
              }
              if (text.includes("backlink_ai_capability_")) {
                budgetTouched = true;
              }
              return { rows: [], rowCount: 0 };
            },
            release() {},
          };
        },
      },
      secretStoreRoot: "C:\\GrowthOS\\secrets",
      configuration,
    });

    await expect(runtime.reserve({
      ...scope,
      runId: "018f0000-0000-7000-8000-000000000004",
      actorId: "phase-3-unit",
    })).resolves.toBe("terminal");
    expect(budgetTouched).toBe(false);
  });

  it("rejects capability envelopes that cannot cover bounded work", () => {
    expect(() => createLocalProductAiRuntime({
      pool: killSwitchPool(false),
      secretStoreRoot: "C:\\GrowthOS\\secrets",
      configuration: {
        ...configuration,
        discoveryAbsoluteBudgetUsd: 0.0001,
      },
    })).toThrow("BACKLINKS_AI_BUDGET_CONFIGURATION_INVALID");

    expect(() => createLocalProductAiRuntime({
      pool: killSwitchPool(false),
      secretStoreRoot: "C:\\GrowthOS\\secrets",
      configuration: {
        ...configuration,
        outreachDraftMaxCalls: 1,
      },
    })).toThrow("BACKLINKS_AI_BUDGET_CONFIGURATION_INVALID");
  });

  it("reports a provider-call ceiling as a budget error, not content policy", async () => {
    const base = killSwitchPool(false);
    const runtime = createLocalProductAiRuntime({
      pool: {
        async connect() {
          const client = await base.connect();
          return {
            ...client,
            async query(text, values) {
              if (text.includes("pg_advisory_xact_lock")) {
                throw new AiCapabilityBudgetError(
                  "PROVIDER_CALL_LIMIT_EXCEEDED",
                  "AI_OUTREACH_DRAFT provider-call limit is exceeded.",
                );
              }
              return client.query(text, values);
            },
          };
        },
      },
      secretStoreRoot: "C:\\GrowthOS\\secrets",
      configuration,
    });
    await expect(runtime.budgetGate.assertAvailable({
      ...scope,
      operation: "draft_generation",
    })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      diagnosticCode: "AI_CAPABILITY_PROVIDER_CALL_LIMIT_EXCEEDED",
      retryable: false,
    });
  });
});
