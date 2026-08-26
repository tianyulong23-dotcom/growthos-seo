export const draftFreshnessStates = [
  "FRESH",
  "STALE",
  "UNKNOWN",
] as const;
export type DraftFreshnessState = typeof draftFreshnessStates[number];

export const draftStaleReasons = [
  "PROJECT_CONTEXT_CHANGED",
  "OPPORTUNITY_CHANGED",
  "CONTACT_CHANGED",
] as const;
export type DraftStaleReason = typeof draftStaleReasons[number];

export type DraftFreshness = Readonly<{
  state: DraftFreshnessState;
  staleReasons: DraftStaleReason[];
  unknownReason: "SNAPSHOT_CONTEXT_INCOMPLETE" | null;
  regenerateRequired: boolean;
  manualEditsPreserved: true;
}>;

type DraftFreshnessInput = Readonly<{
  snapshotProfileVersionId: string | null;
  currentProfileVersionId: string | null;
  snapshotPromotionTargetVersionId: string | null;
  currentPromotionTargetVersionId: string | null;
  snapshotOpportunityVersion: number | null;
  currentOpportunityVersion: number | null;
  snapshotContactId: string | null;
  snapshotContactVersion: number | null;
  currentContactId: string | null;
  currentContactVersion: number | null;
  currentContactUsable: boolean;
}>;

const missing = (value: string | number | null): boolean => value === null;

export function deriveDraftFreshness(
  input: DraftFreshnessInput,
): DraftFreshness {
  const staleReasons: DraftStaleReason[] = [];
  let incomplete = false;

  if (
    missing(input.snapshotProfileVersionId)
    || missing(input.currentProfileVersionId)
    || missing(input.snapshotPromotionTargetVersionId)
    || missing(input.currentPromotionTargetVersionId)
  ) {
    incomplete = true;
  } else if (
    input.snapshotProfileVersionId !== input.currentProfileVersionId
    || input.snapshotPromotionTargetVersionId
      !== input.currentPromotionTargetVersionId
  ) {
    staleReasons.push("PROJECT_CONTEXT_CHANGED");
  }

  if (
    missing(input.snapshotOpportunityVersion)
    || missing(input.currentOpportunityVersion)
  ) {
    incomplete = true;
  } else if (
    input.snapshotOpportunityVersion !== input.currentOpportunityVersion
  ) {
    staleReasons.push("OPPORTUNITY_CHANGED");
  }

  if (
    missing(input.snapshotContactId)
    || missing(input.snapshotContactVersion)
  ) {
    incomplete = true;
  } else if (
    !input.currentContactUsable
    || input.snapshotContactId !== input.currentContactId
    || input.snapshotContactVersion !== input.currentContactVersion
  ) {
    staleReasons.push("CONTACT_CHANGED");
  }

  if (staleReasons.length > 0) {
    return {
      state: "STALE",
      staleReasons,
      unknownReason: null,
      regenerateRequired: true,
      manualEditsPreserved: true,
    };
  }
  if (incomplete) {
    return {
      state: "UNKNOWN",
      staleReasons,
      unknownReason: "SNAPSHOT_CONTEXT_INCOMPLETE",
      regenerateRequired: false,
      manualEditsPreserved: true,
    };
  }
  return {
    state: "FRESH",
    staleReasons,
    unknownReason: null,
    regenerateRequired: false,
    manualEditsPreserved: true,
  };
}
