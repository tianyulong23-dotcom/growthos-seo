import {
  AiDraftError,
  aiDraftOutputSchema,
  type AiDraftOutput,
  type AiDraftResult,
} from "../../ports/ai-draft.port.js";

export type RawAiDraftAttempt = Readonly<{
  content: string;
  usage: Readonly<{ inputTokens: number; outputTokens: number }>;
  estimatedCostUsd: number;
  model: AiDraftResult["model"];
  latencyMs: number;
}>;

export type AiDraftRepairRequest = Readonly<{
  outputSchemaVersion: "draft-output.v1";
  validationIssues: readonly string[];
}>;

type GenerateAttempt = (
  input: Readonly<{ repair: AiDraftRepairRequest | null }>,
) => Promise<RawAiDraftAttempt>;

type ValidateAttempt = (output: AiDraftOutput) => readonly string[];

type ParsedAttempt =
  | Readonly<{ success: true; output: AiDraftOutput }>
  | Readonly<{ success: false; issues: readonly string[] }>;

function parseAttempt(
  content: string,
  validate: ValidateAttempt,
): ParsedAttempt {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { success: false, issues: ["invalid_json"] };
  }
  if (
    typeof value === "object"
    && value !== null
    && (
      (value as { canAutoSend?: unknown }).canAutoSend === true
      || (value as { requiresUserConfirmation?: unknown })
        .requiresUserConfirmation === false
    )
  ) {
    throw new AiDraftError({
      code: "POLICY_VIOLATION",
      message: "AI Draft output attempted to bypass human confirmation.",
      retryable: false,
    });
  }
  const parsed = aiDraftOutputSchema.safeParse(value);
  if (parsed.success) {
    const validationIssues = validate(parsed.data);
    if (validationIssues.length > 0) {
      return { success: false, issues: validationIssues };
    }
    return { success: true, output: parsed.data };
  }
  return {
    success: false,
    issues: parsed.error.issues.map((issue) =>
      `${issue.path.join(".") || "output"}:${issue.code}`
    ),
  };
}

const malformed = () => new AiDraftError({
  code: "MALFORMED_OUTPUT",
  message: "AI Draft output failed schema validation after one repair.",
  retryable: false,
});

export async function generateStructuredDraftWithRepair(
  generate: GenerateAttempt,
  validate: ValidateAttempt = () => [],
): Promise<AiDraftResult> {
  const first = await generate({ repair: null });
  const parsedFirst = parseAttempt(first.content, validate);
  if (parsedFirst.success) {
    return {
      output: parsedFirst.output,
      usage: first.usage,
      estimatedCostUsd: first.estimatedCostUsd,
      model: first.model,
      latencyMs: first.latencyMs,
      repairCount: 0,
    };
  }

  const second = await generate({
    repair: {
      outputSchemaVersion: "draft-output.v1",
      validationIssues: parsedFirst.issues,
    },
  });
  const parsedSecond = parseAttempt(second.content, validate);
  if (!parsedSecond.success) {
    throw malformed();
  }
  return {
    output: parsedSecond.output,
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens,
    },
    estimatedCostUsd: Number((
      first.estimatedCostUsd + second.estimatedCostUsd
    ).toFixed(6)),
    model: second.model,
    latencyMs: first.latencyMs + second.latencyMs,
    repairCount: 1,
  };
}
