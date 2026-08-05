import {
  AiDraftError,
  aiDraftInputSchema,
  aiDraftOutputSchema,
  type AiDraftErrorCode,
  type AiDraftPort,
} from "../../ports/ai-draft.port.js";

type Scenario = Readonly<Record<string, unknown>>;

const failure = (code: AiDraftErrorCode) => new AiDraftError({
  code,
  message: "Fake AI Draft generation failed.",
  retryable: code === "TIMEOUT" || code === "RATE_LIMITED",
});

function parseOutput(value: unknown) {
  if (
    typeof value === "object"
    && value !== null
    && (
      (value as { canAutoSend?: unknown }).canAutoSend === true
      || (value as { requiresUserConfirmation?: unknown })
        .requiresUserConfirmation === false
    )
  ) {
    throw failure("POLICY_VIOLATION");
  }
  const result = aiDraftOutputSchema.safeParse(value);
  if (!result.success) {
    throw failure("MALFORMED_OUTPUT");
  }
  return result.data;
}

export function createFakeAiDraftAdapter(options: Readonly<{
  scenario: unknown;
}>): AiDraftPort {
  const scenario = options.scenario as Scenario;
  return Object.freeze({
    async generate(input) {
      aiDraftInputSchema.parse(input);
      if (scenario.kind === "error") {
        throw failure(scenario.code as AiDraftErrorCode);
      }
      let value: unknown;
      if (scenario.kind === "raw") {
        try {
          value = JSON.parse(String(scenario.content));
        } catch {
          throw failure("MALFORMED_OUTPUT");
        }
      } else if (scenario.kind === "success") {
        value = scenario.output;
      } else {
        throw failure("MALFORMED_OUTPUT");
      }
      return {
        output: parseOutput(value),
        usage: { inputTokens: 10, outputTokens: 20 },
        model: {
          providerRef: "fake-ai",
          modelId: "fake-draft-model",
          modelVersion: "v1",
        },
        latencyMs: 1,
        repairCount: 0,
      };
    },
  });
}
