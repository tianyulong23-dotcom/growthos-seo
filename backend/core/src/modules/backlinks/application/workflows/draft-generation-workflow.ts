import type {
  AiDraftInput,
  AiDraftPort,
} from "../../ports/ai-draft.port.js";
import { AiDraftError } from "../../ports/ai-draft.port.js";
import type {
  DraftGenerationRepository,
} from "../repositories/draft-generation.repository.js";

export type DraftGenerationWorkflowInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  runId: string;
  versionId: string;
  actorId: string;
  recordedAt: Date;
  prompt: AiDraftInput;
}>;

export async function runDraftGenerationWorkflow(
  input: DraftGenerationWorkflowInput,
  repository: DraftGenerationRepository,
  ai: AiDraftPort,
) {
  const job = await repository.claimJob(input);
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
  if (
    input.prompt.organizationId !== input.organizationId
    || input.prompt.workspaceId !== input.workspaceId
    || input.prompt.websiteProjectId !== input.websiteProjectId
    || input.prompt.opportunityId !== job.opportunityId
    || input.prompt.evidenceSnapshotId !== job.evidenceSnapshotId
    || input.prompt.promptVersion !== job.promptVersion
    || input.prompt.outputSchemaVersion !== job.outputSchemaVersion
  ) {
    await repository.failJob({
      ...input,
      errorClass: "DraftPolicyError",
      errorCode: "PROMPT_SCOPE_MISMATCH",
      refused: false,
    });
    throw new Error("Draft generation Prompt does not match the Job.");
  }

  try {
    const result = await ai.generate(input.prompt);
    const completed = await repository.completeJob({
      ...input,
      result,
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
      ...input,
      errorClass: known ? error.name : "DraftGenerationError",
      errorCode: known ? error.code : "DRAFT_GENERATION_FAILED",
      refused: known && error.code === "REFUSED",
    });
    throw error;
  }
}
