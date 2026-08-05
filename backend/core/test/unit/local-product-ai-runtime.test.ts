import { describe, expect, it } from "vitest";

import {
  createLocalProductAiRuntime,
  readLocalProductAiConfiguration,
} from "../../src/modules/backlinks/runtime/local-product-ai-runtime.js";
import type {
  BacklinkTenantPool,
} from "../../src/modules/backlinks/db/tenant-transaction.js";

const configuration = {
  providerRef: "vercel-ai-gateway",
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  modelId: "provider/model",
  modelVersion: "2026-08-01",
  credentialSecretReference:
    "secret://growthos/local-product/ai/provider-credential/v1",
  maxCalls: 25,
  timeoutMs: 30_000,
  maxInputTokens: 100,
  maxOutputTokens: 100,
  absoluteBudgetUsd: 0.001,
  inputCostUsdPerMillionTokens: 1,
  outputCostUsdPerMillionTokens: 1,
} as const;
const scope = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
};

type RuntimeState = {
  blocked: boolean | null;
  usedUsd: number;
  usedCalls: number;
  status: string;
  quality: Record<string, unknown>;
};

function poolFor(state: RuntimeState): BacklinkTenantPool {
  return {
    async connect() {
      return {
        async query(text, values = []) {
          if (text.includes("backlink_kill_switch_versions")) {
            return {
              rows: state.blocked === null
                ? []
                : [{
                    layer: "project",
                    capability: "AI_PROVIDER",
                    provider: null,
                    blocked: state.blocked,
                    version: 1,
                  }],
              rowCount: state.blocked === null ? 0 : 1,
            };
          }
          if (text.includes('AS "usedUsd"')) {
            return {
              rows: [{
                usedUsd: String(state.usedUsd),
                usedCalls: String(state.usedCalls),
              }],
              rowCount: 1,
            };
          }
          if (text.includes('quality_result AS "qualityResult"')) {
            return {
              rows: [{
                status: state.status,
                qualityResult: state.quality,
              }],
              rowCount: 1,
            };
          }
          if (text.includes("jsonb_set")) {
            state.quality = {
              ...state.quality,
              budgetReservationUsd: Number(values[4]),
            };
          }
          if (text.includes("quality_result-'budgetReservationUsd'")) {
            const remaining = { ...state.quality };
            delete remaining.budgetReservationUsd;
            state.quality = remaining;
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
}

const environment = {
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
  AI_PROVIDER_ABSOLUTE_BUDGET_USD: "0.001",
  AI_PROVIDER_INPUT_COST_USD_PER_MILLION_TOKENS: "1",
  AI_PROVIDER_OUTPUT_COST_USD_PER_MILLION_TOKENS: "1",
} as const;

describe("LOCAL_PRODUCT AI runtime", () => {
  it("parses approved providers and same-kind local Secret References", () => {
    expect(readLocalProductAiConfiguration({ ...environment })).toEqual(
      configuration,
    );
    expect(() => readLocalProductAiConfiguration({
      ...environment,
      AI_PROVIDER_REF: "unapproved-provider",
    })).toThrow(
      "BACKLINKS_AI_CONFIGURATION_INVALID:AI_PROVIDER_REF",
    );
    expect(readLocalProductAiConfiguration({
      ...environment,
      AI_PROVIDER_REF: "openai",
      AI_PROVIDER_BASE_URL: "https://sub2.indexarc.net/v1",
      AI_MODEL_ID: "gpt-5.6-sol",
    })).toMatchObject({
      providerRef: "openai",
      baseUrl: "https://sub2.indexarc.net/v1",
      modelId: "gpt-5.6-sol",
    });
    expect(() => readLocalProductAiConfiguration({
      ...environment,
      AI_PROVIDER_REF: "openai",
      AI_PROVIDER_BASE_URL: "http://sub2.indexarc.net/v1",
    })).toThrow(
      "BACKLINKS_AI_CONFIGURATION_INVALID:AI_PROVIDER_BASE_URL",
    );
    expect(() => readLocalProductAiConfiguration({
      ...environment,
      AI_PROVIDER_CREDENTIAL_SECRET_REF: "plaintext-secret",
    })).toThrow(
      "BACKLINKS_AI_CONFIGURATION_INVALID:"
        + "AI_PROVIDER_CREDENTIAL_SECRET_REF",
    );
    expect(readLocalProductAiConfiguration({
      ...environment,
      AI_PROVIDER_CREDENTIAL_SECRET_REF:
        "secret://growthos/local-product/ai/provider-credential/v7",
    })).toMatchObject({
      credentialSecretReference:
        "secret://growthos/local-product/ai/provider-credential/v7",
    });
    expect(() => readLocalProductAiConfiguration({
      ...environment,
      AI_PROVIDER_CREDENTIAL_SECRET_REF:
        "secret://growthos/local-product/google/oauth-client-secret/v1",
    })).toThrow(
      "BACKLINKS_AI_CONFIGURATION_INVALID:"
        + "AI_PROVIDER_CREDENTIAL_SECRET_REF",
    );
  });

  it("fails closed when the Kill Switch authority has no allow decision", async () => {
    const runtime = createLocalProductAiRuntime({
      pool: poolFor({
        blocked: null,
        usedUsd: 0,
        usedCalls: 0,
        status: "QUEUED",
        quality: { generationMode: "MODEL" },
      }),
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

  it("reserves the maximum two-attempt cost and releases it", async () => {
    const state: RuntimeState = {
      blocked: false,
      usedUsd: 0,
      usedCalls: 0,
      status: "QUEUED",
      quality: { generationMode: "MODEL" },
    };
    const runtime = createLocalProductAiRuntime({
      pool: poolFor(state),
      secretStoreRoot: "C:\\GrowthOS\\secrets",
      configuration,
    });
    const run = {
      ...scope,
      runId: "018f0000-0000-7000-8000-000000000004",
    };
    await expect(runtime.reserve(run)).resolves.toBeUndefined();
    expect(state.quality.budgetReservationUsd).toBe(0.0004);
    await expect(runtime.release(run)).resolves.toBeUndefined();
    expect(state.quality).not.toHaveProperty("budgetReservationUsd");
  });

  it("blocks before a reservation can exceed the absolute budget", async () => {
    const runtime = createLocalProductAiRuntime({
      pool: poolFor({
        blocked: false,
        usedUsd: 0.0007,
        usedCalls: 0,
        status: "QUEUED",
        quality: { generationMode: "MODEL" },
      }),
      secretStoreRoot: "C:\\GrowthOS\\secrets",
      configuration,
    });
    await expect(runtime.reserve({
      ...scope,
      runId: "018f0000-0000-7000-8000-000000000004",
    })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      retryable: false,
    });
  });

  it("blocks when the configured call limit is exhausted", async () => {
    const runtime = createLocalProductAiRuntime({
      pool: poolFor({
        blocked: false,
        usedUsd: 0,
        usedCalls: 25,
        status: "QUEUED",
        quality: { generationMode: "MODEL" },
      }),
      secretStoreRoot: "C:\\GrowthOS\\secrets",
      configuration,
    });
    await expect(runtime.budgetGate.assertAvailable({
      ...scope,
      operation: "draft_generation",
    })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      retryable: false,
    });
  });

  it("rejects a per-run cost envelope larger than the global budget", () => {
    expect(() => createLocalProductAiRuntime({
      pool: poolFor({
        blocked: false,
        usedUsd: 0,
        usedCalls: 0,
        status: "QUEUED",
        quality: { generationMode: "MODEL" },
      }),
      secretStoreRoot: "C:\\GrowthOS\\secrets",
      configuration: {
        ...configuration,
        absoluteBudgetUsd: 0.0001,
      },
    })).toThrow("BACKLINKS_AI_BUDGET_CONFIGURATION_INVALID");
  });
});
