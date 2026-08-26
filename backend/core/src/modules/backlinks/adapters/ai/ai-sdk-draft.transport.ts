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
export type AiSdkResponseMode = "native-structured" | "json-text";

export type AiSdkGenerateProviderText = (input: Readonly<{
  model: AiSdkLanguageModel;
  system: string;
  prompt: string;
  output: AiSdkStructuredOutput;
  responseMode: AiSdkResponseMode;
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
  createGateway(options: Readonly<{
    apiKey: string;
    fetch?: typeof globalThis.fetch;
  }>):
    (modelId: string) => AiSdkLanguageModel;
  generateText(options: Readonly<{
    model: AiSdkLanguageModel;
    system: string;
    prompt: string;
    output?: AiSdkStructuredOutput;
    maxRetries: number;
    maxOutputTokens: number;
    timeout: number;
    telemetry: Readonly<{ isEnabled: false }>;
  }>): Promise<Readonly<{
    output?: AiDraftOutput;
    text: string;
    finishReason: string;
    usage: Readonly<{
      inputTokens: number | undefined;
      outputTokens: number | undefined;
    }>;
  }>>;
}>;
const openAiSdk = require("@ai-sdk/openai") as Readonly<{
  createOpenAI(options: Readonly<{
    apiKey: string;
    baseURL: string;
    fetch?: typeof globalThis.fetch;
  }>):
    Readonly<{
      (modelId: string): AiSdkLanguageModel;
      chat(modelId: string): AiSdkLanguageModel;
    }>;
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
const jsonTextDraftInstruction = [
  "Return exactly one valid JSON object with no Markdown or surrounding text.",
  "Use exactly these top-level fields: subject, bodyText, factsUsed, riskFlags, requiresUserConfirmation, canAutoSend.",
  "factsUsed must be an array of objects with claim and evidenceIds.",
  "Evidence IDs and provenance metadata must appear only in factsUsed.evidenceIds, never in subject or bodyText.",
  "requiresUserConfirmation must be true and canAutoSend must be false.",
].join(" ");

export type AiSdkDraftTransportOptions = Readonly<{
  providerBaseUrl: string;
  providerFetch?: typeof globalThis.fetch;
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
    fetch?: typeof globalThis.fetch;
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
          "Return one corrected JSON object only. Do not add unsupported facts. Remove internal evidence metadata from subject and bodyText; keep Evidence IDs only in factsUsed.evidenceIds.",
        validationIssues: repair.validationIssues,
      },
});

type ProviderErrorCandidate = Readonly<{
  name?: unknown;
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  cause?: unknown;
}>;

const providerErrorChain = (error: unknown): readonly ProviderErrorCandidate[] => {
  const chain: ProviderErrorCandidate[] = [];
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) break;
    const candidate = current as ProviderErrorCandidate;
    chain.push(candidate);
    if (candidate.cause === current) break;
    current = candidate.cause;
  }
  return chain;
};

const safeProviderDiagnosticCode = (
  chain: readonly ProviderErrorCandidate[],
  statuses: readonly number[],
): string => {
  const status = statuses.find((value) => value >= 100 && value <= 599);
  if (status !== undefined) return `PROVIDER_HTTP_${status}`;
  const code = chain
    .map((candidate) => String(candidate.code ?? "").trim().toUpperCase())
    .find((value) => /^[A-Z0-9_]+$/u.test(value));
  if (code !== undefined) return `PROVIDER_NETWORK_${code}`;
  const name = chain
    .map((candidate) => String(candidate.name ?? "").trim().toUpperCase())
    .find((value) => /^[A-Z][A-Z0-9_]*$/u.test(value));
  return name === undefined ? "PROVIDER_UNKNOWN" : `PROVIDER_${name}`;
};

export const mapAiSdkProviderError = (error: unknown): AiDraftError => {
  const chain = providerErrorChain(error);
  const names = chain.map((candidate) => String(candidate.name ?? ""));
  const messages = chain.map((candidate) => String(candidate.message ?? ""));
  const codes = chain.map((candidate) => String(candidate.code ?? ""));
  const statuses = chain.flatMap((candidate) => [
    Number(candidate.status),
    Number(candidate.statusCode),
  ]).filter(Number.isFinite);
  const diagnosticCode = safeProviderDiagnosticCode(chain, statuses);
  if (
    names.some((name) => name === "AbortError" || name === "TimeoutError")
    || codes.some((code) =>
      ["ABORT_ERR", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code)
    )
    || messages.some((message) => /timed?\s*out/iu.test(message))
    || statuses.some((status) => status === 408 || status === 504)
  ) {
    return new AiDraftError({
      code: "TIMEOUT",
      message: "AI Draft provider timed out.",
      retryable: true,
      diagnosticCode,
    });
  }
  if (
    statuses.some((status) => status === 429)
    || messages.some((message) => /\b429\b/iu.test(message))
  ) {
    return new AiDraftError({
      code: "RATE_LIMITED",
      message: "AI Draft provider rate limit was reached.",
      retryable: true,
      diagnosticCode,
    });
  }
  if (statuses.some((status) => [400, 401, 403, 404, 422].includes(status))) {
    return new AiDraftError({
      code: "MISCONFIGURED",
      message: "AI Draft provider rejected the configured request.",
      retryable: false,
      diagnosticCode,
    });
  }
  return new AiDraftError({
    code: "UNAVAILABLE",
    message: "AI Draft provider is unavailable.",
    retryable: true,
    diagnosticCode,
  });
};

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const normalizeOpenAiCompatibleRequestBody = (
  value: unknown,
): unknown => {
  if (!isJsonObject(value)) return value;
  const normalized: JsonObject = { ...value };
  if (
    normalized.max_tokens === undefined
    && typeof normalized.max_completion_tokens === "number"
  ) {
    normalized.max_tokens = normalized.max_completion_tokens;
  }
  delete normalized.max_completion_tokens;
  if (Array.isArray(normalized.messages)) {
    normalized.messages = normalized.messages.map((message) =>
      isJsonObject(message) && message.role === "developer"
        ? { ...message, role: "system" }
        : message
    );
  }
  return normalized;
};

const createOpenAiCompatibleFetch = (
  request: typeof globalThis.fetch,
): typeof globalThis.fetch =>
  async (url, init) => {
    if (typeof init?.body !== "string") return request(url, init);
    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return request(url, init);
    }
    return request(url, {
      ...init,
      body: JSON.stringify(normalizeOpenAiCompatibleRequestBody(parsed)),
    });
  };

export const defaultGenerateProviderText: AiSdkGenerateProviderText =
  async (input) => {
  try {
    const result = await aiSdk.generateText({
      model: input.model,
      system: input.system,
      prompt: input.prompt,
      ...(input.responseMode === "native-structured"
        ? { output: input.output }
        : {}),
      maxRetries: input.maxRetries,
      maxOutputTokens: input.maxOutputTokens,
      timeout: input.timeout,
      telemetry: input.telemetry,
    });
    return {
      text: input.responseMode === "native-structured"
        ? JSON.stringify(result.output)
        : result.text,
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

export const selectAiSdkResponseMode = (input: Readonly<{
  providerRef: string;
  providerBaseUrl: string;
}>): AiSdkResponseMode => {
  if (input.providerRef === "vercel-ai-gateway") {
    return "native-structured";
  }
  try {
    return new URL(input.providerBaseUrl).hostname === "api.openai.com"
      ? "native-structured"
      : "json-text";
  } catch {
    return "json-text";
  }
};

export const createAiSdkProviderModel = (input: Readonly<{
  apiKey: string;
  baseUrl: string;
  modelId: string;
  providerRef: string;
  fetch?: typeof globalThis.fetch;
}>): AiSdkLanguageModel => {
  switch (input.providerRef) {
    case "openai": {
      const officialOpenAi =
        new URL(input.baseUrl).hostname === "api.openai.com";
      const provider = openAiSdk.createOpenAI({
        apiKey: input.apiKey,
        baseURL: input.baseUrl,
        ...(officialOpenAi
          ? (input.fetch === undefined ? {} : { fetch: input.fetch })
          : {
              fetch: createOpenAiCompatibleFetch(
                input.fetch ?? globalThis.fetch,
              ),
            }),
      });
      // Chat Completions is the supported common denominator for both OpenAI
      // and OpenAI-compatible base URLs configured by the local product.
      return provider.chat(input.modelId);
    }
    case "vercel-ai-gateway":
      if (input.baseUrl !== "https://ai-gateway.vercel.sh/v1") {
        throw new AiDraftError({
          code: "MISCONFIGURED",
          message: "Vercel AI Gateway Base URL is not approved.",
          retryable: false,
        });
      }
      return aiSdk.createGateway({
        apiKey: input.apiKey,
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      })(input.modelId);
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
      const responseMode = selectAiSdkResponseMode({
        providerRef: input.providerRef,
        providerBaseUrl: options.providerBaseUrl,
      });
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
        ...(options.providerFetch === undefined
          ? {}
          : { fetch: options.providerFetch }),
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
              system: responseMode === "json-text"
                ? `${input.draft.systemInstruction} ${jsonTextDraftInstruction}`
                : input.draft.systemInstruction,
              prompt: serializePrompt(input.draft, repair),
              output: structuredDraftOutput,
              responseMode,
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
          (output) => draftOutputContentPolicyIssues(
            output,
            input.draft.evidence.map((item) => item.id),
          ),
        );
      } catch (error) {
        if (error instanceof AiDraftError) throw error;
        throw mapAiSdkProviderError(error);
      }
    },
  });
}
