import { DraftOutputPolicyError, validateDraftOutputPolicy } from
  "../../domain/drafts/evidence-policy.js";
import type { AiDraftPort, AiDraftResult } from
  "../../ports/ai-draft.port.js";
import {
  AiDraftError,
} from "../../ports/ai-draft.port.js";
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

const canRetry = (
  error: unknown,
  attemptCount: number,
): error is AiDraftError =>
  error instanceof AiDraftError
  && error.retryable
  && attemptCount < 2;

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
        diagnosticCode: "DRAFT_CONTEXT_MISMATCH",
        retryable: false,
      });
    }
    let result: AiDraftResult;
    let source: "MODEL" | "TEMPLATE_FALLBACK";
    let basicDraftReason: string | null = null;
    if (input.generationMode !== "MODEL") {
      result = createDraftTemplateFallback(
        context.prompt,
        "MODEL_DISABLED",
      );
      source = "TEMPLATE_FALLBACK";
      basicDraftReason = "MODEL_DISABLED";
    } else if (ai === null) {
      result = createDraftTemplateFallback(context.prompt, "MISCONFIGURED");
      source = "TEMPLATE_FALLBACK";
      basicDraftReason = "MISCONFIGURED";
    } else {
      let modelError: unknown = null;
      let modelResult: AiDraftResult | null = null;
      try {
        modelResult = await ai.generate(context.prompt);
      } catch (error) {
        modelError = error;
        if (canRetry(error, job.attemptCount)) {
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
            modelError = new AiDraftError({
              code: "UNAVAILABLE",
              message: "Draft generation retry could not reclaim the Job.",
              retryable: false,
            });
          } else {
            try {
              modelResult = await ai.generate(context.prompt);
              modelError = null;
            } catch (retryError) {
              modelError = retryError;
            }
          }
        }
      }
      if (modelResult === null) {
        throw modelError;
      }
      result = modelResult;
      source = "MODEL";
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
        diagnosticCode: error instanceof DraftOutputPolicyError
          ? error.diagnosticCode : "DRAFT_OUTPUT_POLICY",
        retryable: false,
      });
    }
    const persistenceStartedAt = (dependencies.now ?? (() => new Date()))();
    const completed = await repository.completeJob({
      ...mutation,
      recordedAt: persistenceStartedAt,
      result,
      source,
      fallbackReason: basicDraftReason,
    });
    return {
      outcome: source === "MODEL"
        ? "completed" as const
        : "completed_with_basic_draft" as const,
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
      diagnosticCode: known ? error.diagnosticCode ?? null : null,
      refused: known && error.code === "REFUSED",
    });
    throw error;
  }
}
