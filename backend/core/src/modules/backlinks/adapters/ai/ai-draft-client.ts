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
}>;

export type AiDraftTransport = Readonly<{
  generate(input: Readonly<{
    draft: AiDraftInput;
    secretRef: string;
    providerRef: string;
    modelId: string;
    modelVersion: string;
    timeoutMs: number;
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
  if (
    config.timeoutMs === undefined
    || !Number.isFinite(config.timeoutMs)
    || config.timeoutMs <= 0
  ) {
    throw fail("MISCONFIGURED", "AI Draft timeoutMs must be positive.");
  }
  return {
    secretRef: config.secretRef,
    providerRef: config.providerRef?.trim() || "configured-provider",
    modelId: config.modelId,
    modelVersion: config.modelVersion?.trim() || "unspecified",
    timeoutMs: config.timeoutMs,
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
        const result = await options.transport.generate({ draft, ...config });
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
