export const draftStatuses = Object.freeze([
  "generating",
  "draft",
  "approved",
  "rejected",
  "sent",
] as const);

export type DraftStatus = (typeof draftStatuses)[number];

export const draftEvidenceStatuses = Object.freeze([
  "ACTIVE",
  "STALE",
  "CONTRADICTED",
] as const);
export const draftEvidenceVisibilities = Object.freeze([
  "VISIBLE",
  "HIDDEN",
] as const);
export const draftEvidenceSourceKinds = Object.freeze([
  "PROFILE",
  "PROMOTION_TARGET",
  "OPPORTUNITY",
  "CONTACT",
  "ASSESSMENT",
  "AI_SUMMARY",
  "AI_INFERENCE",
] as const);

export type DraftEvidenceStatus = (typeof draftEvidenceStatuses)[number];
export type DraftEvidenceVisibility =
  (typeof draftEvidenceVisibilities)[number];
export type DraftEvidenceSourceKind =
  (typeof draftEvidenceSourceKinds)[number];

export type Draft = Readonly<{
  id: string;
  opportunityId: string;
  status: DraftStatus;
  version: number;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  lastSuccessfulVersionId: string | null;
}>;

export type DraftEvidence = Readonly<{
  id: string;
  status: DraftEvidenceStatus;
  visibility: DraftEvidenceVisibility;
  confidence: number;
  sourceKind: DraftEvidenceSourceKind;
  value: string;
  observedAt: string;
  dataVersion: string;
  contentHash: string;
}>;

type DraftStatusTransitions = Readonly<
  Record<DraftStatus, readonly DraftStatus[]>
>;

export const draftStatusTransitions: DraftStatusTransitions = Object.freeze({
  generating: Object.freeze(["draft", "rejected"] as const),
  draft: Object.freeze(["generating", "approved", "rejected"] as const),
  approved: Object.freeze(["draft", "rejected", "sent"] as const),
  rejected: Object.freeze(["generating", "draft"] as const),
  sent: Object.freeze([] as const),
});

export class InvalidDraftError extends Error {
  readonly code = "INVALID_DRAFT";

  constructor(readonly field: string) {
    super(`Invalid Draft ${field}.`);
    this.name = "InvalidDraftError";
  }
}

export class InvalidDraftEvidenceError extends Error {
  readonly code = "INVALID_DRAFT_EVIDENCE";

  constructor(readonly field: string) {
    super(`Invalid Draft Evidence ${field}.`);
    this.name = "InvalidDraftEvidenceError";
  }
}

export class InvalidDraftTransitionError extends Error {
  readonly code = "INVALID_DRAFT_TRANSITION";

  constructor(
    readonly from: unknown,
    readonly to: unknown,
  ) {
    super(`Illegal Draft transition: ${String(from)} -> ${String(to)}`);
    this.name = "InvalidDraftTransitionError";
  }
}

const isNonBlankString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isMember = <Value>(
  values: readonly Value[],
  value: unknown,
): value is Value => (values as readonly unknown[]).includes(value);

export function isDraftStatus(value: unknown): value is DraftStatus {
  return isMember(draftStatuses, value);
}

export function canTransitionDraft(from: unknown, to: unknown): boolean {
  return isDraftStatus(from)
    && isDraftStatus(to)
    && draftStatusTransitions[from].includes(to);
}

export function createDraft(input: Draft): Draft {
  if (!isNonBlankString(input.id)) throw new InvalidDraftError("id");
  if (!isNonBlankString(input.opportunityId)) {
    throw new InvalidDraftError("opportunityId");
  }
  if (!isDraftStatus(input.status)) throw new InvalidDraftError("status");
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new InvalidDraftError("version");
  }
  return Object.freeze({ ...input });
}

export function createDraftEvidence(input: DraftEvidence): DraftEvidence {
  if (!isNonBlankString(input.id)) {
    throw new InvalidDraftEvidenceError("id");
  }
  if (!isMember(draftEvidenceStatuses, input.status)) {
    throw new InvalidDraftEvidenceError("status");
  }
  if (!isMember(draftEvidenceVisibilities, input.visibility)) {
    throw new InvalidDraftEvidenceError("visibility");
  }
  if (!isMember(draftEvidenceSourceKinds, input.sourceKind)) {
    throw new InvalidDraftEvidenceError("sourceKind");
  }
  if (
    !Number.isFinite(input.confidence)
    || input.confidence < 0
    || input.confidence > 1
  ) {
    throw new InvalidDraftEvidenceError("confidence");
  }
  if (!isNonBlankString(input.value)) {
    throw new InvalidDraftEvidenceError("value");
  }
  if (
    !isNonBlankString(input.observedAt)
    || !Number.isFinite(Date.parse(input.observedAt))
  ) {
    throw new InvalidDraftEvidenceError("observedAt");
  }
  if (!isNonBlankString(input.dataVersion)) {
    throw new InvalidDraftEvidenceError("dataVersion");
  }
  if (!/^[a-f0-9]{64}$/.test(input.contentHash)) {
    throw new InvalidDraftEvidenceError("contentHash");
  }
  return Object.freeze({ ...input });
}

export function transitionDraft(draft: Draft, target: DraftStatus): Draft {
  const current = createDraft(draft);
  if (!canTransitionDraft(current.status, target)) {
    throw new InvalidDraftTransitionError(current.status, target);
  }
  return Object.freeze({
    ...current,
    status: target,
    version: current.version + 1,
  });
}
