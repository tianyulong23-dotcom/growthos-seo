import { validateDraftOutputPolicy } from
  "../../domain/drafts/evidence-policy.js";
import type { AiDraftPort, AiDraftResult } from
  "../../ports/ai-draft.port.js";
import { AiDraftError } from "../../ports/ai-draft.port.js";
import type {
  DraftGenerationMode,
  DraftGenerationRepository,
  DraftPromptContext,
} from "../repositories/draft-generation.repository.js";

export type DraftGenerationWorkflowInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  runId: string;
  versionId: string;
  actorId: string;
  recordedAt: string;
  generationMode: DraftGenerationMode;
}>;

const manualDraft = (context: DraftPromptContext): AiDraftResult => {
  const opportunity = context.prompt.userContext.opportunity as
    | Readonly<{ targetHost?: unknown }>
    | undefined;
  const targetHost = typeof opportunity?.targetHost === "string"
    ? opportunity.targetHost
    : "your website";
  return {
    output: {
      subject: `Collaboration opportunity for ${targetHost}`,
      bodyText: [
        "Hello,",
        "",
        "I would like to discuss a potential collaboration that may be relevant to your audience.",
        "Please let me know if you are open to reviewing the details.",
        "",
        "Best regards,",
      ].join("\n"),
      personalizationClaims: [],
      missingInformation: [
        "This template was created while the AI provider was disabled.",
      ],
      riskFlags: [],
      requiresUserConfirmation: true,
      canAutoSend: false,
    },
    usage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
    model: {
      providerRef: "manual-template",
      modelId: "manual-template",
      modelVersion: "manual-template.v1",
    },
    latencyMs: 0,
    repairCount: 0,
  };
};

export async function runDraftGenerationWorkflow(
  input: DraftGenerationWorkflowInput,
  repository: DraftGenerationRepository,
  ai: AiDraftPort | null,
  dependencies: Readonly<{ now?: () => Date }> = {},
) {
  const recordedAt = new Date(input.recordedAt);
  if (!Number.isFinite(recordedAt.getTime())) {
    throw new Error("Draft generation recordedAt is invalid.");
  }
  const mutation = { ...input, recordedAt };
  const job = await repository.claimJob(mutation);
  if (job.status === "SUCCEEDED") {
    return {
      outcome: "already_completed" as const,
      runId: job.runId,
      draftId: job.draftId,
      versionId: job.versionId,
    };
  }
  if (!job.started) {
    return {
      outcome: job.status === "RUNNING"
        ? "already_running" as const
        : "failed" as const,
      runId: job.runId,
      draftId: job.draftId,
      status: job.status,
    };
  }
  try {
    const context = await repository.loadPromptContext(mutation);
    if (
      context.prompt.opportunityId !== job.opportunityId
      || context.prompt.evidenceSnapshotId !== job.evidenceSnapshotId
      || context.prompt.promptVersion !== job.promptVersion
      || context.prompt.outputSchemaVersion !== job.outputSchemaVersion
    ) {
      throw new AiDraftError({
        code: "POLICY_VIOLATION",
        message: "Draft generation context does not match the Job.",
        retryable: false,
      });
    }
    let result: AiDraftResult;
    if (input.generationMode === "MODEL") {
      if (ai === null) {
        throw new AiDraftError({
          code: "MISCONFIGURED",
          message: "AI Draft provider is unavailable.",
          retryable: false,
        });
      }
      result = await ai.generate(context.prompt);
    } else {
      result = manualDraft(context);
    }
    validateDraftOutputPolicy({
      output: result.output,
      approvedEvidence: context.approvedEvidence,
      forbiddenValues: context.forbiddenValues,
    });
    const persistenceStartedAt = (dependencies.now ?? (() => new Date()))();
    const completed = await repository.completeJob({
      ...mutation,
      recordedAt: persistenceStartedAt,
      result,
      source: input.generationMode,
    });
    return {
      outcome: "completed" as const,
      runId: job.runId,
      draftId: job.draftId,
      ...completed,
    };
  } catch (error) {
    const known = error instanceof AiDraftError;
    await repository.failJob({
      ...mutation,
      errorClass: known ? error.name : "DraftGenerationError",
      errorCode: known ? error.code : "DRAFT_GENERATION_FAILED",
      refused: known && error.code === "REFUSED",
    });
    throw error;
  }
}
