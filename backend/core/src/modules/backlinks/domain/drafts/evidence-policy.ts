import type { DraftEvidence } from "./draft.js";

type DraftScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  opportunityId: string;
}>;

type EvidenceSnapshot = DraftScope & Readonly<{
  id: string;
  evidence: readonly DraftEvidence[];
}>;

export type ApprovedDraftEvidence = Readonly<{
  id: string;
  sourceKind: Exclude<
    DraftEvidence["sourceKind"],
    "AI_SUMMARY" | "AI_INFERENCE"
  >;
  value: string;
  untrustedContent: true;
}>;

type DraftOutput = Readonly<{
  subject: string;
  bodyText: string;
  personalizationClaims: readonly Readonly<{
    text: string;
    evidenceIds: readonly string[];
  }>[];
  missingInformation: readonly string[];
  riskFlags: readonly string[];
  requiresUserConfirmation: boolean;
  canAutoSend: boolean;
}>;

export function approveDraftEvidence(
  snapshot: EvidenceSnapshot,
  scope: DraftScope,
): readonly ApprovedDraftEvidence[] {
  if (
    snapshot.organizationId !== scope.organizationId
    || snapshot.workspaceId !== scope.workspaceId
    || snapshot.websiteProjectId !== scope.websiteProjectId
    || snapshot.opportunityId !== scope.opportunityId
  ) {
    throw new Error("Evidence Snapshot is outside the Draft scope.");
  }

  const approved = snapshot.evidence
    .filter((item) =>
      item.status === "ACTIVE"
      && item.visibility === "VISIBLE"
      && item.confidence >= 0.7
      && item.sourceKind !== "AI_SUMMARY"
      && item.sourceKind !== "AI_INFERENCE")
    .map((item) => ({
      id: item.id,
      sourceKind: item.sourceKind as ApprovedDraftEvidence["sourceKind"],
      value: item.value,
      untrustedContent: true as const,
    }));

  if (approved.length === 0) {
    throw new Error("Evidence Snapshot has no approved Evidence.");
  }

  return approved;
}

export function validateDraftOutputPolicy(input: Readonly<{
  output: DraftOutput;
  approvedEvidence: readonly ApprovedDraftEvidence[];
  forbiddenValues: readonly string[];
}>): void {
  const approvedIds = new Set(input.approvedEvidence.map((item) => item.id));
  const referencesUnapprovedEvidence = input.output.personalizationClaims.some(
    (claim) =>
      claim.evidenceIds.length === 0
      || claim.evidenceIds.some((evidenceId) => !approvedIds.has(evidenceId)),
  );
  if (referencesUnapprovedEvidence) {
    throw new Error("Draft output references unapproved Evidence.");
  }

  const outputText = [
    input.output.subject,
    input.output.bodyText,
    ...input.output.personalizationClaims.map((claim) => claim.text),
    ...input.output.missingInformation,
    ...input.output.riskFlags,
  ].join("\n");
  if (
    input.forbiddenValues.some((value) =>
      value.length > 0 && outputText.includes(value))
  ) {
    throw new Error("Draft output violated a data boundary.");
  }

  if (
    input.output.requiresUserConfirmation !== true
    || input.output.canAutoSend !== false
  ) {
    throw new Error("Draft output violated the human-approval policy.");
  }
}
