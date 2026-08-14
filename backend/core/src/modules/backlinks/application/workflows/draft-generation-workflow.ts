import { validateDraftOutputPolicy } from
  "../../domain/drafts/evidence-policy.js";
import type { AiDraftPort, AiDraftResult } from
  "../../ports/ai-draft.port.js";
import { AiDraftError } from "../../ports/ai-draft.port.js";
import { createDraftTemplateFallback } from
  "../services/draft-template-fallback.js";
import type {
  DraftGenerationMode,
  DraftGenerationRepository,
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
  let job = await repository.claimJob(mutation);
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
    let source: "MODEL" | "TEMPLATE_FALLBACK";
    if (input.generationMode !== "MODEL") {
      result = createDraftTemplateFallback(
        context.prompt,
        ai === null ? "PROVIDER_UNAVAILABLE" : "MODEL_DISABLED",
      );
      source = "TEMPLATE_FALLBACK";
    } else {
      if (ai === null) {
        throw new AiDraftError({
          code: "MISCONFIGURED",
          message: "AI Draft Provider is not configured.",
          retryable: false,
        });
      }
      source = "MODEL";
      try {
        result = await ai.generate(context.prompt);
      } catch (error) {
        if (
          error instanceof AiDraftError
          && error.retryable
          && job.attemptCount < 2
        ) {
          await repository.scheduleRetry({
            ...mutation,
            errorClass: error.name,
            errorCode: error.code,
          });
          job = await repository.claimJob({
            ...mutation,
            recordedAt: (dependencies.now ?? (() => new Date()))(),
          });
          if (!job.started || job.status !== "RUNNING") {
            throw new AiDraftError({
              code: "UNAVAILABLE",
              message: "Draft generation retry could not reclaim the Job.",
              retryable: false,
            });
          }
          result = await ai.generate(context.prompt);
        } else {
          throw error;
        }
      }
    }
    try {
      validateDraftOutputPolicy({
        output: result.output,
        approvedEvidence: context.approvedEvidence,
        forbiddenValues: context.forbiddenValues,
      });
    } catch (error) {
      throw new AiDraftError({
        code: "POLICY_VIOLATION",
        message: error instanceof Error
          ? error.message
          : "Draft output violated policy.",
        retryable: false,
      });
    }
    const persistenceStartedAt = (dependencies.now ?? (() => new Date()))();
    const completed = await repository.completeJob({
      ...mutation,
      recordedAt: persistenceStartedAt,
      result,
      source,
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
