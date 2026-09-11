import { describe, expect, it, vi } from "vitest";

import {
  createAiSdkObjectOutput,
  createAiSdkDraftTransport,
  createAiSdkProviderModel,
  defaultGenerateProviderText,
  mapAiSdkProviderError,
  normalizeOpenAiCompatibleRequestBody,
  selectAiSdkResponseMode,
} from "../../src/modules/backlinks/adapters/ai/ai-sdk-draft.transport.js";
import type {
  AiDraftInput,
} from "../../src/modules/backlinks/ports/ai-draft.port.js";
import { z } from "zod";

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
const validBody = [
  "Hello, I am reaching out from GrowthOS after reviewing publisher.test and the audience it serves. The published context appears relevant to teams researching practical SEO workflow topics, so I wanted to ask whether a focused editorial collaboration could be useful.",
  "We would like to explore a relevant content partnership around GrowthOS. The proposed destination is https://growthos.test/. We can provide concise product context, factual source material, and a clear outline while leaving topic selection, wording, review standards, and publication decisions with your editorial team.",
  "Any link treatment would remain entirely subject to your policy. We are not assuming acceptance, publication, ranking, indexing, placement, pricing, or a dofollow attribute, and the final format should only proceed if it is genuinely useful to your readers.",
  "Would you be open to a brief review of the collaboration idea? If it is not a fit, no action is needed. If it may be relevant, please share the information or format your team would need before considering it.",
].join("\n\n");
const validOutput = JSON.stringify({
  subject: "SEO workflow collaboration",
  bodyText: validBody,
  factsUsed: [{
    claim: "You publish SEO workflow research.",
    evidenceIds: ["profile:1"],
  }],
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
  it("bounds reasoning for compatible GPT-5 draft requests while preserving explicit settings", () => {
    expect(normalizeOpenAiCompatibleRequestBody({ model: "gpt-5.6-terra" }))
      .toMatchObject({ reasoning_effort: "low" });
    expect(normalizeOpenAiCompatibleRequestBody({ model: "gpt-5.6-terra", reasoning_effort: "minimal" }))
      .toMatchObject({ reasoning_effort: "minimal" });
    expect(normalizeOpenAiCompatibleRequestBody({ model: "other" }))
      .not.toHaveProperty("reasoning_effort");
  });
  it("identifies unsupported account models without retrying or exposing provider details", () => {
    const error = mapAiSdkProviderError({
      statusCode: 400,
      message: "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
    });
    expect(error).toMatchObject({
      code: "MISCONFIGURED",
      retryable: false,
      diagnosticCode: "PROVIDER_MODEL_UNSUPPORTED",
    });
  });
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
        responseMode: "native-structured",
        telemetry: { isEnabled: false },
      });
      expect(request.output).toMatchObject({ name: "object" });
      expect(request).not.toHaveProperty("tools");
      expect(JSON.stringify(request)).not.toContain("PROTECTED_API_KEY");
    }
  });

  it("repairs an otherwise valid draft that violates the length policy", async () => {
    const generateProviderText = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          ...JSON.parse(validOutput),
          bodyText: "Hello, I would like to discuss a relevant collaboration.",
        }),
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 20 },
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
      createModel: () => ({ model: true }),
      generateProviderText,
    });

    await expect(transport.generate(input)).resolves.toMatchObject({
      repairCount: 1,
    });
    expect(JSON.parse(
      generateProviderText.mock.calls[1]?.[0].prompt as string,
    )).toMatchObject({
      repair: {
        validationIssues: [
          "bodyText must contain at least 130 words; received 9.",
          "bodyText must contain at least 3 paragraphs; received 1.",
        ],
      },
    });
  });

  it("repairs an otherwise valid draft that violates content policy", async () => {
    const generateProviderText = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          ...JSON.parse(validOutput),
          bodyText: validBody.replace(
            "We are not assuming acceptance",
            "We promise publication and are not assuming acceptance",
          ),
        }),
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 20 },
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
      createModel: () => ({ model: true }),
      generateProviderText,
    });

    await expect(transport.generate(input)).resolves.toMatchObject({
      repairCount: 1,
    });
    expect(JSON.parse(
      generateProviderText.mock.calls[1]?.[0].prompt as string,
    )).toMatchObject({
      repair: {
        validationIssues: [
          "Draft output contains a prohibited promise.",
        ],
      },
    });
  });

  it("repairs recipient-visible internal Evidence metadata", async () => {
    const generateProviderText = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          ...JSON.parse(validOutput),
          bodyText:
            `${validBody}\n\n[profile:1, opportunity:current]`,
        }),
        finishReason: "stop",
        usage: { inputTokens: 20, outputTokens: 20 },
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
      createModel: () => ({ model: true }),
      generateProviderText,
    });

    await expect(transport.generate(input)).resolves.toMatchObject({
      repairCount: 1,
    });
    expect(JSON.parse(
      generateProviderText.mock.calls[1]?.[0].prompt as string,
    )).toMatchObject({
      repair: {
        instruction: expect.stringContaining(
          "Remove internal evidence metadata",
        ),
        validationIssues: [
          "Draft output contains internal evidence metadata.",
        ],
      },
    });
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
    expect(createModel).toHaveBeenCalledTimes(1);
  });

  it("uses Chat Completions for OpenAI-compatible base URLs", () => {
    const model = createAiSdkProviderModel({
      apiKey: "PROTECTED_OPENAI_KEY",
      baseUrl: "https://sub2.indexarc.net/v1",
      modelId: "gpt-5.6-sol",
      providerRef: "openai",
    }) as Readonly<{
      config?: Readonly<{ provider?: string }>;
      modelId?: string;
    }>;

    expect(model.modelId).toBe("gpt-5.6-sol");
    expect(model.config?.provider).toBe("openai.chat");
  });

  it("uses JSON text mode for compatible gateways and native mode for official providers", () => {
    expect(selectAiSdkResponseMode({
      providerRef: "openai",
      providerBaseUrl: "https://sub2.indexarc.net/v1",
    })).toBe("json-text");
    expect(selectAiSdkResponseMode({
      providerRef: "openai",
      providerBaseUrl: "https://api.openai.com/v1",
    })).toBe("native-structured");
    expect(selectAiSdkResponseMode({
      providerRef: "vercel-ai-gateway",
      providerBaseUrl: "https://ai-gateway.vercel.sh/v1",
    })).toBe("native-structured");
  });

  it("normalizes reasoning-model requests for an OpenAI-compatible gateway", async () => {
    const requests: Array<Readonly<{ url: string; body: unknown }>> = [];
    const model = createAiSdkProviderModel({
      apiKey: "PROTECTED_OPENAI_KEY",
      baseUrl: "https://provider.example/v1",
      modelId: "gpt-5.4-mini",
      providerRef: "openai",
      fetch: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(JSON.stringify({
          id: "chatcmpl-contract",
          object: "chat.completion",
          created: 1,
          model: "gpt-5.4-mini",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: '{"subject":"Contract response"}',
            },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(defaultGenerateProviderText({
      model,
      system: "Return JSON.",
      prompt: "{}",
      output: createAiSdkObjectOutput(z.object({ subject: z.string() })),
      responseMode: "json-text",
      maxRetries: 0,
      maxOutputTokens: 100,
      timeout: 1_000,
      telemetry: { isEnabled: false },
    })).resolves.toMatchObject({
      text: '{"subject":"Contract response"}',
      finishReason: "stop",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "https://provider.example/v1/chat/completions",
    );
    expect(requests[0]?.body).not.toHaveProperty("response_format");
    expect(requests[0]?.body).not.toHaveProperty("max_completion_tokens");
    expect(requests[0]?.body).toMatchObject({
      max_tokens: 100,
      messages: [
        { role: "system", content: "Return JSON." },
        { role: "user", content: "{}" },
      ],
    });
  });

  it.each([
    [{ statusCode: 400 }, "MISCONFIGURED", false, "PROVIDER_HTTP_400"],
    [{
      name: "APICallError",
      cause: { code: "ECONNRESET" },
    }, "UNAVAILABLE", true, "PROVIDER_NETWORK_ECONNRESET"],
  ] as const)(
    "keeps provider diagnostics safe for %s",
    (failure, code, retryable, diagnosticCode) => {
      expect(mapAiSdkProviderError(failure)).toMatchObject({
        code,
        retryable,
        diagnosticCode,
      });
    },
  );

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
    [{
      name: "APICallError",
      message: "request failed",
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    }, "TIMEOUT"],
    [{ statusCode: 429, message: "provider returned 429" }, "RATE_LIMITED"],
    [{ statusCode: 401, message: "unauthorized" }, "MISCONFIGURED"],
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
      retryable: code !== "MISCONFIGURED",
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
