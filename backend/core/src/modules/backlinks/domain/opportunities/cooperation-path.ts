export const cooperationPathTypes = Object.freeze([
  "public_email",
  "contact_form",
  "guest_post_submission",
  "resource_submission",
  "editor_author_page",
] as const);

export const nonEmailCooperationPathTypes = Object.freeze([
  "contact_form",
  "guest_post_submission",
  "resource_submission",
  "editor_author_page",
] as const);

export const cooperationContentTypes = Object.freeze([
  "EMAIL",
  "FORM_MESSAGE",
  "SUBMISSION_PITCH",
] as const);

export const manualActionStates = Object.freeze([
  "READY_FOR_MANUAL_ACTION",
  "IN_PROGRESS",
  "SUBMITTED",
  "RESPONSE_RECEIVED",
  "BLOCKED",
  "ABANDONED",
] as const);

export type CooperationPathType = (typeof cooperationPathTypes)[number];
export type NonEmailCooperationPathType =
  (typeof nonEmailCooperationPathTypes)[number];
export type CooperationContentType = (typeof cooperationContentTypes)[number];
export type ManualActionState = (typeof manualActionStates)[number];

export type VerifiedCooperationPath = Readonly<{
  factId: string;
  pathType: CooperationPathType;
  pathUrl: string;
  contentType: CooperationContentType;
  evidence: Readonly<Record<string, unknown>>;
}>;

const manualActionTransitions: Readonly<
  Record<ManualActionState, readonly ManualActionState[]>
> = Object.freeze({
  READY_FOR_MANUAL_ACTION: Object.freeze([
    "IN_PROGRESS",
    "BLOCKED",
    "ABANDONED",
  ] as const),
  IN_PROGRESS: Object.freeze([
    "SUBMITTED",
    "BLOCKED",
    "ABANDONED",
  ] as const),
  SUBMITTED: Object.freeze([
    "RESPONSE_RECEIVED",
    "BLOCKED",
    "ABANDONED",
  ] as const),
  RESPONSE_RECEIVED: Object.freeze([
    "IN_PROGRESS",
    "BLOCKED",
    "ABANDONED",
  ] as const),
  BLOCKED: Object.freeze([
    "IN_PROGRESS",
    "ABANDONED",
  ] as const),
  ABANDONED: Object.freeze([
    "IN_PROGRESS",
  ] as const),
});

export function isCooperationPathType(
  value: unknown,
): value is CooperationPathType {
  return (cooperationPathTypes as readonly unknown[]).includes(value);
}

export function isNonEmailCooperationPathType(
  value: unknown,
): value is NonEmailCooperationPathType {
  return (nonEmailCooperationPathTypes as readonly unknown[]).includes(value);
}

export function cooperationContentTypeFor(
  pathType: CooperationPathType,
): CooperationContentType {
  if (pathType === "public_email") return "EMAIL";
  if (pathType === "contact_form") return "FORM_MESSAGE";
  return "SUBMISSION_PITCH";
}

export function canTransitionManualAction(
  from: ManualActionState,
  to: ManualActionState,
): boolean {
  return manualActionTransitions[from].includes(to);
}

export function allowedManualActionOrigins(
  to: ManualActionState,
): readonly ManualActionState[] {
  return manualActionStates.filter((from) =>
    canTransitionManualAction(from, to));
}

export function normalizeCooperationPathUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)
      || url.username.length > 0 || url.password.length > 0) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function cooperationPathUrlFromEvidence(
  evidence: Readonly<Record<string, unknown>>,
): string | null {
  return normalizeCooperationPathUrl(
    evidence.url ?? evidence.pathUrl ?? evidence.sourceUrl,
  );
}

export function parseVerifiedCooperationPath(input: Readonly<{
  factId: string;
  decision: string;
  pathType: unknown;
  evidence: Readonly<Record<string, unknown>>;
}>): VerifiedCooperationPath | null {
  if (input.decision !== "verified" || !isCooperationPathType(input.pathType)) {
    return null;
  }
  const pathUrl = cooperationPathUrlFromEvidence(input.evidence);
  if (pathUrl === null) return null;
  return Object.freeze({
    factId: input.factId,
    pathType: input.pathType,
    pathUrl,
    contentType: cooperationContentTypeFor(input.pathType),
    evidence: input.evidence,
  });
}
