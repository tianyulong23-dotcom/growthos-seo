import type {
  ManualActionState,
} from "../../domain/opportunities/cooperation-path.js";

export const engagementPathStates = [
  "EMAIL_READY",
  "MANUAL_PATH_READY",
  "CONTACT_PENDING",
] as const;
export type EngagementPathState = typeof engagementPathStates[number];

export const opportunityPrimaryNextActionKinds = [
  "CREATE_EMAIL_DRAFT",
  "WAIT_FOR_DRAFT",
  "EDIT_DRAFT",
  "REVIEW_DRAFT",
  "REVIEW_SEND_READINESS",
  "VIEW_MAIL_STATUS",
  "CONTINUE_MANUAL_PATH",
  "RESOLVE_CONTACT_OR_PATH",
] as const;
export type OpportunityPrimaryNextActionKind =
  typeof opportunityPrimaryNextActionKinds[number];

export type OpportunityPrimaryNextAction = Readonly<{
  kind: OpportunityPrimaryNextActionKind;
  enabled: boolean;
  blockerCode: "CONTACT_OR_PATH_REQUIRED" | "DRAFT_GENERATING" | null;
}>;

export type OpportunityHandoffState = Readonly<{
  engagementPathState: EngagementPathState;
  primaryNextAction: OpportunityPrimaryNextAction;
}>;

export function deriveOpportunityHandoffState(input: Readonly<{
  engagementChannel: "EMAIL" | "COOPERATION_PATH";
  contactEmail: string | null;
  contactReviewRequired: boolean;
  manualActionState: ManualActionState | null;
  draftStatus:
    | "generating"
    | "draft"
    | "approved"
    | "rejected"
    | "sent"
    | null;
  draftVersionSource:
    | "MODEL"
    | "TEMPLATE_FALLBACK"
    | "MANUAL"
    | "RESTORED"
    | null;
}>): OpportunityHandoffState {
  if (
    input.engagementChannel === "EMAIL"
    && input.contactEmail !== null
    && !input.contactReviewRequired
  ) {
    const primaryNextAction: OpportunityPrimaryNextAction =
      input.draftStatus === null
        ? {
            kind: "CREATE_EMAIL_DRAFT",
            enabled: true,
            blockerCode: null,
          }
        : input.draftStatus === "generating"
          ? {
              kind: "WAIT_FOR_DRAFT",
              enabled: false,
              blockerCode: "DRAFT_GENERATING",
            }
          : input.draftStatus === "approved"
            ? {
                kind: "REVIEW_SEND_READINESS",
                enabled: true,
                blockerCode: null,
              }
            : input.draftStatus === "sent"
              ? {
                  kind: "VIEW_MAIL_STATUS",
                  enabled: true,
                  blockerCode: null,
                }
              : input.draftVersionSource === "TEMPLATE_FALLBACK"
                || input.draftStatus === "rejected"
                ? {
                    kind: "EDIT_DRAFT",
                    enabled: true,
                    blockerCode: null,
                  }
                : {
                    kind: "REVIEW_DRAFT",
                    enabled: true,
                    blockerCode: null,
                  };
    return {
      engagementPathState: "EMAIL_READY",
      primaryNextAction,
    };
  }
  if (
    input.engagementChannel === "COOPERATION_PATH"
    && input.manualActionState !== null
  ) {
    return {
      engagementPathState: "MANUAL_PATH_READY",
      primaryNextAction: {
        kind: "CONTINUE_MANUAL_PATH",
        enabled: true,
        blockerCode: null,
      },
    };
  }
  return {
    engagementPathState: "CONTACT_PENDING",
    primaryNextAction: {
      kind: "RESOLVE_CONTACT_OR_PATH",
      enabled: false,
      blockerCode: "CONTACT_OR_PATH_REQUIRED",
    },
  };
}
