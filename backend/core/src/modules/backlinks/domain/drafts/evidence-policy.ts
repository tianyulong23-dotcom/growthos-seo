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
  factsUsed: readonly Readonly<{
    claim: string;
    evidenceIds: readonly string[];
  }>[];
  riskFlags: readonly string[];
  requiresUserConfirmation: boolean;
  canAutoSend: boolean;
}>;

const subjectStopWords = new Set([
  "about",
  "hello",
  "idea",
  "quick",
  "question",
  "regarding",
  "the",
  "this",
  "thoughts",
  "with",
  "your",
]);

const semanticTerms = (value: string): readonly string[] =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? [];

export function draftBodyLengthPolicyIssues(
  bodyText: string,
): readonly string[] {
  const words = bodyText
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "").length;
  const paragraphs = bodyText
    .trim()
    .split(/\n\s*\n/u)
    .filter((paragraph) => paragraph.trim() !== "").length;
  const issues: string[] = [];
  if (words < 130) {
    issues.push(`bodyText must contain at least 130 words; received ${words}.`);
  } else if (words > 220) {
    issues.push(`bodyText must contain at most 220 words; received ${words}.`);
  }
  if (paragraphs < 3) {
    issues.push(
      `bodyText must contain at least 3 paragraphs; received ${paragraphs}.`,
    );
  } else if (paragraphs > 5) {
    issues.push(
      `bodyText must contain at most 5 paragraphs; received ${paragraphs}.`,
    );
  }
  return issues;
}

export function draftOutputContentPolicyIssues(
  output: Pick<DraftOutput, "subject" | "bodyText">,
): readonly string[] {
  const issues = [...draftBodyLengthPolicyIssues(output.bodyText)];

  const outboundText = `${output.subject}\n${output.bodyText}`;
  if (
    /\[(?:name|company|website)\]|\{\{[^}]+\}\}|\b(?:TBD|lorem ipsum)\b/iu
      .test(outboundText)
  ) {
    issues.push("Draft output contains a placeholder.");
  }
  if (
    /\b(?:guaranteed?|promise(?:d|s)?)\s+(?:publication|ranking|indexing|placement|dofollow)\b/iu
      .test(outboundText)
    || /\b(?:will|shall)\s+(?:be\s+)?dofollow\b/iu.test(outboundText)
  ) {
    issues.push("Draft output contains a prohibited promise.");
  }

  const body = output.bodyText
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  const subjectTerms = semanticTerms(output.subject)
    .filter((term) => term.length >= 4 && !subjectStopWords.has(term));
  if (
    subjectTerms.length === 0
    || !subjectTerms.some((term) => body.includes(term))
  ) {
    issues.push("Draft output subject is not coherent with the body.");
  }
  return issues;
}

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
  const referencesUnapprovedEvidence = input.output.factsUsed.some(
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
    ...input.output.factsUsed.map((claim) => claim.claim),
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

  const contentPolicyIssue = draftOutputContentPolicyIssues(input.output)[0];
  if (contentPolicyIssue?.startsWith("bodyText ") === true) {
    throw new Error("Draft output violated the length policy.");
  }
  if (contentPolicyIssue !== undefined) throw new Error(contentPolicyIssue);
}
