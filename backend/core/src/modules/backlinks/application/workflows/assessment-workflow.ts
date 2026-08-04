import {
  assessBacklinkEvidence,
  assessmentPolicyVersion,
  type AssessmentDimensionInput,
  type AssessmentPolicyResult,
} from "../../domain/assessments/assessment-policy.js";
import type {
  AssessmentRunInput,
  AssessmentWorkflowRepository,
} from "../../repositories/assessment.repository.js";
export type BacklinkAssessmentWorkflowInput = Omit<
  AssessmentRunInput, "policyVersion" | "sourceReleaseIds"
> & Readonly<{
  snapshotId: string; dimensions: readonly AssessmentDimensionInput[] }>;
type Evaluator = (input: Readonly<{
  evidenceContractVersion: string;
  dimensions: readonly AssessmentDimensionInput[] }>) => AssessmentPolicyResult;
export async function runBacklinkAssessmentWorkflow(
  input: BacklinkAssessmentWorkflowInput,
  repository: AssessmentWorkflowRepository,
  evaluate: Evaluator = assessBacklinkEvidence,
) {
  const sourceReleaseIds = [...new Set(input.dimensions.map(({ evidence }) =>
    evidence.sourceReleaseId))].sort();
  const run = await repository.begin({
    ...input, policyVersion: assessmentPolicyVersion, sourceReleaseIds,
  });
  if (run.status === "SUCCEEDED") return {
    outcome: "already_completed" as const, runId: run.runId,
    snapshotId: run.lastSuccessfulSnapshotId,
    snapshotVersion: run.snapshotVersion,
  };
  if (!run.started) return { outcome: run.status === "CANCELLED"
    ? "cancelled" as const : "already_running" as const, runId: run.runId };
  try {
    const result = evaluate({
      evidenceContractVersion: input.evidenceContractVersion,
      dimensions: input.dimensions,
    });
    const snapshot = await repository.complete({ ...input, result });
    return { outcome: "completed" as const, runId: run.runId, ...snapshot };
  } catch (error) {
    await repository.fail({ ...input, errorCode: "ASSESSMENT_WORKFLOW_FAILED" });
    throw error;
  }
}
