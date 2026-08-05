import { describe, expect, it, vi } from "vitest";

import {
  createAiSdkDraftTransport,
} from "../../src/modules/backlinks/adapters/ai/ai-sdk-draft.transport.js";
import type {
  AiDraftInput,
} from "../../src/modules/backlinks/ports/ai-draft.port.js";

const draft: AiDraftInput = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  opportunityId: "opportunity-1",
  evidenceSnapshotId: "evidence-1",
  promptVersion: "prompt.v1",
  outputSchemaVersion: "draft-document.v1",
  systemInstruction: "Use approved evidence only.",
  userContext: { contact: { role: "editor", purpose: "partnerships" } },
  evidence: [{
    id: "profile:1",
    sourceKind: "PROFILE",
    value: "GrowthOS publishes SEO workflow research.",
  }],
};
const validOutput = JSON.stringify({
  subject: "SEO workflow collaboration",
  bodyText: "Hello, I would like to discuss a relevant collaboration.",
  personalizationClaims: [{
    text: "You publish SEO workflow research.",
    evidenceIds: ["profile:1"],
  }],
  missingInformation: [],
  riskFlags: [],
  requiresUserConfirmation: true,
  canAutoSend: false,
});
const input = {
  draft,
  secretRef:
    "secret://growthos/local-product/ai/provider-credential/v1",
  providerRef: "vercel-ai-gateway",
  modelId: "provider/model",
  modelVersion: "2026-08-01",
  timeoutMs: 30_000,
  maxInputTokens: 1_000,
  maxOutputTokens: 500,
} as const;

describe("ai@7 structured Draft Transport", () => {
  it("uses no SDK retries and rechecks the gate for one schema repair", async () => {
    const beforeProviderCall = vi.fn(async () => {});
    const createModel = vi.fn(() => ({ model: true }));
    const generateProviderText = vi.fn()
      .mockResolvedValueOnce({
        text: '{"subject":',
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 10 },
      })
      .mockResolvedValueOnce({
        text: validOutput,
        finishReason: "stop",
        usage: { inputTokens: 30, outputTokens: 40 },
      });
    const transport = createAiSdkDraftTransport({
      providerBaseUrl: "https://ai-gateway.vercel.sh/v1",
      resolveSecret: async () => "PROTECTED_API_KEY",
      inputCostUsdPerMillionTokens: 1,
      outputCostUsdPerMillionTokens: 2,
      createModel,
      generateProviderText,
      beforeProviderCall,
      now: (() => {
        let value = 100;
        return () => value += 5;
      })(),
    });

    await expect(transport.generate(input)).resolves.toMatchObject({
      repairCount: 1,
      usage: { inputTokens: 50, outputTokens: 50 },
      estimatedCostUsd: 0.00015,
    });
    expect(beforeProviderCall).toHaveBeenCalledTimes(2);
    expect(createModel).toHaveBeenCalledWith({
      apiKey: "PROTECTED_API_KEY",
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      modelId: "provider/model",
      providerRef: "vercel-ai-gateway",
    });
    expect(beforeProviderCall.mock.calls.map((call) => call[0].attempt))
      .toEqual([1, 2]);
    expect(generateProviderText).toHaveBeenCalledTimes(2);
    for (const [request] of generateProviderText.mock.calls) {
      expect(request).toMatchObject({
        maxRetries: 0,
        telemetry: { isEnabled: false },
      });
      expect(request.output).toMatchObject({ name: "object" });
      expect(request).not.toHaveProperty("tools");
      expect(JSON.stringify(request)).not.toContain("PROTECTED_API_KEY");
    }
  });

  it("allows the approved direct OpenAI provider", async () => {
    const createModel = vi.fn(() => ({ model: true }));
    const transport = createAiSdkDraftTransport({
      providerBaseUrl: "https://sub2.indexarc.net/v1",
      resolveSecret: async () => "PROTECTED_OPENAI_KEY",
      inputCostUsdPerMillionTokens: 0.1,
      outputCostUsdPerMillionTokens: 0.6,
      createModel,
      generateProviderText: async () => ({
        text: validOutput,
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 40 },
      }),
    });

    await expect(transport.generate({
      ...input,
      providerRef: "openai",
      modelId: "gpt-5.6-sol",
    })).resolves.toMatchObject({
      model: {
        providerRef: "openai",
        modelId: "gpt-5.6-sol",
      },
    });
    expect(createModel).toHaveBeenCalledWith({
      apiKey: "PROTECTED_OPENAI_KEY",
      baseUrl: "https://sub2.indexarc.net/v1",
      modelId: "gpt-5.6-sol",
      providerRef: "openai",
    });
  });

  it("rejects providers outside the exact allowlist before secret resolution", async () => {
    const resolveSecret = vi.fn(async () => "SHOULD_NOT_BE_READ");
    const transport = createAiSdkDraftTransport({
      providerBaseUrl: "https://ai-gateway.vercel.sh/v1",
      resolveSecret,
      inputCostUsdPerMillionTokens: 1,
      outputCostUsdPerMillionTokens: 1,
      createModel: () => ({ model: true }),
      generateProviderText: async () => {
        throw new Error("unreachable");
      },
    });

    await expect(transport.generate({
      ...input,
      providerRef: "unapproved-provider",
    })).rejects.toMatchObject({
      code: "MISCONFIGURED",
      retryable: false,
    });
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: "TimeoutError", message: "timed out" }, "TIMEOUT"],
    [{ statusCode: 429, message: "provider returned 429" }, "RATE_LIMITED"],
  ] as const)("maps provider failure to %s", async (failure, code) => {
    const transport = createAiSdkDraftTransport({
      providerBaseUrl: "https://ai-gateway.vercel.sh/v1",
      resolveSecret: async () => "PROTECTED_API_KEY",
      inputCostUsdPerMillionTokens: 1,
      outputCostUsdPerMillionTokens: 1,
      createModel: () => ({ model: true }),
      generateProviderText: async () => {
        throw failure;
      },
    });
    await expect(transport.generate(input)).rejects.toMatchObject({
      code,
      retryable: true,
    });
  });

  it("treats content filtering as a non-retryable refusal", async () => {
    const transport = createAiSdkDraftTransport({
      providerBaseUrl: "https://ai-gateway.vercel.sh/v1",
      resolveSecret: async () => "PROTECTED_API_KEY",
      inputCostUsdPerMillionTokens: 1,
      outputCostUsdPerMillionTokens: 1,
      createModel: () => ({ model: true }),
      generateProviderText: async () => ({
        text: "",
        finishReason: "content-filter",
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
    });
    await expect(transport.generate(input)).rejects.toMatchObject({
      code: "REFUSED",
      retryable: false,
    });
  });

  it("stops before the provider call when the gate is revoked", async () => {
    const generateProviderText = vi.fn();
    const transport = createAiSdkDraftTransport({
      providerBaseUrl: "https://ai-gateway.vercel.sh/v1",
      resolveSecret: async () => "PROTECTED_API_KEY",
      inputCostUsdPerMillionTokens: 1,
      outputCostUsdPerMillionTokens: 1,
      createModel: () => ({ model: true }),
      generateProviderText,
      beforeProviderCall: async () => {
        throw new Error("AI_PROVIDER_KILL_SWITCH_ACTIVE");
      },
    });
    await expect(transport.generate(input)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(generateProviderText).not.toHaveBeenCalled();
  });
});
