import {
  AiDraftError,
  aiDraftInputSchema,
  type AiDraftInput,
  type AiDraftPort,
  type AiDraftResult,
} from "../../ports/ai-draft.port.js";

export type AiDraftClientConfig = Readonly<{
  enabled?: boolean;
  secretRef?: string;
  providerRef?: string;
  modelId?: string;
  modelVersion?: string;
  timeoutMs?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  absoluteBudgetUsd?: number;
}>;

export type AiDraftTransport = Readonly<{
  generate(input: Readonly<{
    draft: AiDraftInput;
    secretRef: string;
    providerRef: string;
    modelId: string;
    modelVersion: string;
    timeoutMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  }>): Promise<AiDraftResult>;
}>;

type SafeLogEvent = Readonly<{
  event: string;
  providerRef: string;
  modelId: string;
  latencyMs?: number;
  errorCode?: string;
}>;

const fail = (code: "UNAVAILABLE" | "MISCONFIGURED", message: string) =>
  new AiDraftError({ code, message, retryable: false });

const positiveFinite = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0;

function validateConfig(config: AiDraftClientConfig) {
  if (config.enabled !== true) {
    throw fail("UNAVAILABLE", "AI Draft Adapter is disabled.");
  }
  if (config.secretRef?.trim() === undefined || config.secretRef.trim() === "") {
    throw fail("MISCONFIGURED", "AI Draft secretRef is required.");
  }
  if (config.modelId?.trim() === undefined || config.modelId.trim() === "") {
    throw fail("MISCONFIGURED", "AI Draft modelId is required.");
  }
  if (!positiveFinite(config.timeoutMs)) {
    throw fail("MISCONFIGURED", "AI Draft timeoutMs must be positive.");
  }
  if (!positiveFinite(config.maxInputTokens)) {
    throw fail("MISCONFIGURED", "AI Draft maxInputTokens must be positive.");
  }
  if (!positiveFinite(config.maxOutputTokens)) {
    throw fail("MISCONFIGURED", "AI Draft maxOutputTokens must be positive.");
  }
  if (!positiveFinite(config.absoluteBudgetUsd)) {
    throw fail("MISCONFIGURED", "AI Draft absoluteBudgetUsd must be positive.");
  }
  return {
    secretRef: config.secretRef,
    providerRef: config.providerRef?.trim() || "configured-provider",
    modelId: config.modelId,
    modelVersion: config.modelVersion?.trim() || "unspecified",
    timeoutMs: config.timeoutMs,
    maxInputTokens: config.maxInputTokens,
    maxOutputTokens: config.maxOutputTokens,
    absoluteBudgetUsd: config.absoluteBudgetUsd,
  };
}

export function createAiDraftClient(options: Readonly<{
  config: AiDraftClientConfig;
  transport: AiDraftTransport;
  logger?: (event: SafeLogEvent) => void;
}>): AiDraftPort {
  return Object.freeze({
    async generate(input) {
      const draft = aiDraftInputSchema.parse(input);
      const config = validateConfig(options.config);
      options.logger?.({
        event: "backlinks.ai_draft.started",
        modelId: config.modelId,
        providerRef: config.providerRef,
      });
      try {
        const { absoluteBudgetUsd, ...transportConfig } = config;
        const result = await options.transport.generate({
          draft,
          ...transportConfig,
        });
        if (
          !Number.isInteger(result.usage.inputTokens)
          || result.usage.inputTokens < 0
          || result.usage.inputTokens > config.maxInputTokens * 2
          || !Number.isInteger(result.usage.outputTokens)
          || result.usage.outputTokens < 0
          || result.usage.outputTokens > config.maxOutputTokens * 2
        ) {
          throw new AiDraftError({
            code: "BUDGET_EXCEEDED",
            message: "AI Draft token usage exceeded the configured limit.",
            retryable: false,
          });
        }
        if (
          !Number.isFinite(result.estimatedCostUsd)
          || result.estimatedCostUsd < 0
          || result.estimatedCostUsd > absoluteBudgetUsd
        ) {
          throw new AiDraftError({
            code: "BUDGET_EXCEEDED",
            message: "AI Draft cost exceeded the configured limit.",
            retryable: false,
          });
        }
        options.logger?.({
          event: "backlinks.ai_draft.completed",
          modelId: config.modelId,
          providerRef: config.providerRef,
          latencyMs: result.latencyMs,
        });
        return result;
      } catch (caught) {
        const error = caught instanceof AiDraftError
          ? caught
          : new AiDraftError({
            code: "UNAVAILABLE",
            message: "AI Draft provider is unavailable.",
            retryable: true,
          });
        options.logger?.({
          event: "backlinks.ai_draft.failed",
          modelId: config.modelId,
          providerRef: config.providerRef,
          errorCode: error.code,
        });
        throw error;
      }
    },
  });
}
