import { createRequire } from "node:module";

import {
  AiDraftError,
  aiDraftOutputSchema,
  type AiDraftInput,
  type AiDraftOutput,
} from "../../ports/ai-draft.port.js";
import { draftOutputContentPolicyIssues } from
  "../../domain/drafts/evidence-policy.js";
import type { AiDraftTransport } from "./ai-draft-client.js";
import {
  generateStructuredDraftWithRepair,
  type AiDraftRepairRequest,
} from "./structured-draft-output.js";

export type AiSdkProviderResult = Readonly<{
  text: string;
  finishReason: string;
  usage: Readonly<{
    inputTokens: number | undefined;
    outputTokens: number | undefined;
  }>;
}>;

export type AiSdkLanguageModel = unknown;
export type AiSdkStructuredOutput = unknown;

export type AiSdkGenerateProviderText = (input: Readonly<{
  model: AiSdkLanguageModel;
  system: string;
  prompt: string;
  output: AiSdkStructuredOutput;
  maxRetries: number;
  maxOutputTokens: number;
  timeout: number;
  telemetry: Readonly<{ isEnabled: false }>;
}>) => Promise<AiSdkProviderResult>;

const require = createRequire(import.meta.url);
const aiSdk = require("ai") as Readonly<{
  Output: Readonly<{
    object(input: Readonly<{
      schema: unknown;
      name?: string;
      description?: string;
    }>): AiSdkStructuredOutput;
  }>;
  NoObjectGeneratedError: Readonly<{
    isInstance(error: unknown): error is Readonly<{
      text?: string;
      finishReason?: string;
      usage?: Readonly<{
        inputTokens?: number;
        outputTokens?: number;
      }>;
    }>;
  }>;
  createGateway(options: Readonly<{ apiKey: string }>):
    (modelId: string) => AiSdkLanguageModel;
  generateText(options: Readonly<{
    model: AiSdkLanguageModel;
    system: string;
    prompt: string;
    output: AiSdkStructuredOutput;
    maxRetries: number;
    maxOutputTokens: number;
    timeout: number;
    telemetry: Readonly<{ isEnabled: false }>;
  }>): Promise<Readonly<{
    output: AiDraftOutput;
    text: string;
    finishReason: string;
    usage: Readonly<{
      inputTokens: number | undefined;
      outputTokens: number | undefined;
    }>;
  }>>;
}>;
const openAiSdk = require("@ai-sdk/openai") as Readonly<{
  createOpenAI(options: Readonly<{ apiKey: string; baseURL: string }>):
    (modelId: string) => AiSdkLanguageModel;
}>;

export const createAiSdkObjectOutput = (
  schema: unknown,
  name?: string,
  description?: string,
): AiSdkStructuredOutput => aiSdk.Output.object({
  schema,
  ...(name === undefined ? {} : { name }),
  ...(description === undefined ? {} : { description }),
});

const structuredDraftOutput = createAiSdkObjectOutput(
  aiDraftOutputSchema,
  "growthos_backlinks_email_draft",
  "A human-review-only outreach email draft grounded in supplied evidence.",
);

export type AiSdkDraftTransportOptions = Readonly<{
  providerBaseUrl: string;
  resolveSecret(input: Readonly<{
    organizationId: string;
    secretRef: string;
  }>): Promise<string>;
  inputCostUsdPerMillionTokens: number;
  outputCostUsdPerMillionTokens: number;
  beforeProviderCall?(input: Readonly<{
    organizationId: string;
    workspaceId: string;
    websiteProjectId: string;
    providerRef: string;
    modelId: string;
    attempt: 1 | 2;
  }>): Promise<void>;
  createModel?: (input: Readonly<{
    apiKey: string;
    baseUrl: string;
    modelId: string;
    providerRef: string;
  }>) => AiSdkLanguageModel;
  generateProviderText?: AiSdkGenerateProviderText;
  now?: () => number;
}>;

export const safeAiSdkTokenCount = (value: number | undefined): number =>
  Number.isInteger(value) && value !== undefined && value >= 0 ? value : 0;

export const calculateAiSdkCost = (
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number,
): number => Number((
  (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000
).toFixed(6));

const serializePrompt = (
  draft: AiDraftInput,
  repair: AiDraftRepairRequest | null,
): string => JSON.stringify({
  outputSchemaVersion: draft.outputSchemaVersion,
  userContext: draft.userContext,
  evidence: draft.evidence,
  repair: repair === null
    ? null
    : {
        instruction:
          "Return one corrected JSON object only. Do not add unsupported facts.",
        validationIssues: repair.validationIssues,
      },
});

const mapProviderError = (error: unknown): AiDraftError => {
  const candidate = error as Readonly<{
    name?: unknown;
    message?: unknown;
    statusCode?: unknown;
  }>;
  const name = String(candidate.name ?? "");
  const message = String(candidate.message ?? "");
  if (
    name === "AbortError"
    || name === "TimeoutError"
    || /timed?\s*out/iu.test(message)
  ) {
    return new AiDraftError({
      code: "TIMEOUT",
      message: "AI Draft provider timed out.",
      retryable: true,
    });
  }
  if (candidate.statusCode === 429 || /\b429\b/iu.test(message)) {
    return new AiDraftError({
      code: "RATE_LIMITED",
      message: "AI Draft provider rate limit was reached.",
      retryable: true,
    });
  }
  return new AiDraftError({
    code: "UNAVAILABLE",
    message: "AI Draft provider is unavailable.",
    retryable: true,
  });
};

export const defaultGenerateProviderText: AiSdkGenerateProviderText =
  async (input) => {
  try {
    const result = await aiSdk.generateText({
      model: input.model,
      system: input.system,
      prompt: input.prompt,
      output: input.output,
      maxRetries: input.maxRetries,
      maxOutputTokens: input.maxOutputTokens,
      timeout: input.timeout,
      telemetry: input.telemetry,
    });
    return {
      text: JSON.stringify(result.output),
      finishReason: result.finishReason,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
    };
  } catch (error) {
    if (
      aiSdk.NoObjectGeneratedError.isInstance(error)
      && typeof error.text === "string"
      && error.text.trim() !== ""
    ) {
      return {
        text: error.text,
        finishReason: error.finishReason ?? "error",
        usage: {
          inputTokens: error.usage?.inputTokens,
          outputTokens: error.usage?.outputTokens,
        },
      };
    }
    throw error;
  }
  };

export const createAiSdkProviderModel = (input: Readonly<{
  apiKey: string;
  baseUrl: string;
  modelId: string;
  providerRef: string;
}>): AiSdkLanguageModel => {
  switch (input.providerRef) {
    case "openai":
      return openAiSdk.createOpenAI({
        apiKey: input.apiKey,
        baseURL: input.baseUrl,
      })(input.modelId);
    case "vercel-ai-gateway":
      if (input.baseUrl !== "https://ai-gateway.vercel.sh/v1") {
        throw new AiDraftError({
          code: "MISCONFIGURED",
          message: "Vercel AI Gateway Base URL is not approved.",
          retryable: false,
        });
      }
      return aiSdk.createGateway({ apiKey: input.apiKey })(input.modelId);
    default:
      throw new AiDraftError({
        code: "MISCONFIGURED",
        message: "AI Draft provider is not supported by this Transport.",
        retryable: false,
      });
  }
};

export function createAiSdkDraftTransport(
  options: AiSdkDraftTransportOptions,
): AiDraftTransport {
  if (
    !Number.isFinite(options.inputCostUsdPerMillionTokens)
    || options.inputCostUsdPerMillionTokens < 0
    || !Number.isFinite(options.outputCostUsdPerMillionTokens)
    || options.outputCostUsdPerMillionTokens < 0
  ) {
    throw new TypeError("AI Draft token rates must be non-negative.");
  }
  const now = options.now ?? Date.now;
  const generateProviderText = options.generateProviderText
    ?? defaultGenerateProviderText;
  const createModel = options.createModel ?? createAiSdkProviderModel;

  return Object.freeze({
    async generate(input) {
      if (!["openai", "vercel-ai-gateway"].includes(input.providerRef)) {
        throw new AiDraftError({
          code: "MISCONFIGURED",
          message: "AI Draft provider is not supported by this Transport.",
          retryable: false,
        });
      }
      let apiKey: string;
      try {
        apiKey = await options.resolveSecret({
          organizationId: input.draft.organizationId,
          secretRef: input.secretRef,
        });
      } catch {
        throw new AiDraftError({
          code: "MISCONFIGURED",
          message: "AI Draft credential could not be resolved.",
          retryable: false,
        });
      }
      if (apiKey.trim() === "") {
        throw new AiDraftError({
          code: "MISCONFIGURED",
          message: "AI Draft credential is empty.",
          retryable: false,
        });
      }

      const model = createModel({
        apiKey,
        baseUrl: options.providerBaseUrl,
        modelId: input.modelId,
        providerRef: input.providerRef,
      });
      try {
        return await generateStructuredDraftWithRepair(
          async ({ repair }) => {
            await options.beforeProviderCall?.({
              organizationId: input.draft.organizationId,
              workspaceId: input.draft.workspaceId,
              websiteProjectId: input.draft.websiteProjectId,
              providerRef: input.providerRef,
              modelId: input.modelId,
              attempt: repair === null ? 1 : 2,
            });
            const startedAt = now();
            const result = await generateProviderText({
              model,
              system: input.draft.systemInstruction,
              prompt: serializePrompt(input.draft, repair),
              output: structuredDraftOutput,
              maxRetries: 0,
              maxOutputTokens: input.maxOutputTokens,
              timeout: input.timeoutMs,
              telemetry: { isEnabled: false },
            });
            if (
              result.finishReason === "content-filter"
              || result.text.trim() === ""
            ) {
              throw new AiDraftError({
                code: "REFUSED",
                message: "AI Draft provider refused to generate a draft.",
                retryable: false,
              });
            }
            const usage = {
              inputTokens: safeAiSdkTokenCount(result.usage.inputTokens),
              outputTokens: safeAiSdkTokenCount(result.usage.outputTokens),
            };
            if (usage.inputTokens > input.maxInputTokens) {
              throw new AiDraftError({
                code: "BUDGET_EXCEEDED",
                message: "AI Draft input token limit was exceeded.",
                retryable: false,
              });
            }
            return {
              content: result.text,
              usage,
              estimatedCostUsd: calculateAiSdkCost(
                usage.inputTokens,
                usage.outputTokens,
                options.inputCostUsdPerMillionTokens,
                options.outputCostUsdPerMillionTokens,
              ),
              model: {
                providerRef: input.providerRef,
                modelId: input.modelId,
                modelVersion: input.modelVersion,
              },
              latencyMs: Math.max(0, now() - startedAt),
            };
          },
          draftOutputContentPolicyIssues,
        );
      } catch (error) {
        if (error instanceof AiDraftError) throw error;
        throw mapProviderError(error);
      }
    },
  });
}
