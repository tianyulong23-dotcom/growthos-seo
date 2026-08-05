import type {
  OpportunityState,
} from "../../domain/opportunities/opportunity-state.js";
import {
  replyClassificationCodes,
  type ReplyClassificationCode,
} from "../../domain/replies/classification.js";

export const replyAxes = Object.freeze({
  drafted: "DRAFTED",
  waitingSend: "WAITING_SEND",
  sentWaitingReply: "SENT_WAITING_REPLY",
  replied: "REPLIED",
} as const);

export type ReplyAxis = (typeof replyAxes)[keyof typeof replyAxes];

export const replyManagementRecommendations = Object.freeze({
  confirmMatch: "CONFIRM_MATCH",
  reviewNegotiation: "REVIEW_NEGOTIATION",
  prepareAnswer: "PREPARE_ANSWER",
  reviewClosure: "REVIEW_CLOSURE",
  waitForReturn: "WAIT_FOR_RETURN",
  manualReview: "MANUAL_REVIEW",
} as const);

export type ReplyManagementRecommendation =
  (typeof replyManagementRecommendations)[
    keyof typeof replyManagementRecommendations
  ];

export type ReplyOpportunityProjectionInput = Readonly<{
  opportunityState: OpportunityState;
  currentReplyAxis: ReplyAxis;
  matchConfirmed: boolean;
  classificationCode: ReplyClassificationCode;
}>;

export type ReplyOpportunityProjection = Readonly<{
  opportunityState: OpportunityState;
  replyAxis: ReplyAxis;
  managementRecommendation: ReplyManagementRecommendation;
  requiresUserConfirmation: boolean;
  autoSendAllowed: false;
  projectionVersion: "reply-opportunity-projection-v1";
}>;

type ProjectionDecision = Readonly<{
  replyAxis: ReplyAxis;
  managementRecommendation: ReplyManagementRecommendation;
  requiresUserConfirmation: boolean;
}>;

const decisionFor = (
  input: ReplyOpportunityProjectionInput,
): ProjectionDecision => {
  if (!input.matchConfirmed) {
    return {
      replyAxis: input.currentReplyAxis,
      managementRecommendation: replyManagementRecommendations.confirmMatch,
      requiresUserConfirmation: true,
    };
  }

  switch (input.classificationCode) {
    case replyClassificationCodes.positive:
      return {
        replyAxis: replyAxes.replied,
        managementRecommendation:
          replyManagementRecommendations.reviewNegotiation,
        requiresUserConfirmation: true,
      };
    case replyClassificationCodes.question:
      return {
        replyAxis: replyAxes.replied,
        managementRecommendation: replyManagementRecommendations.prepareAnswer,
        requiresUserConfirmation: true,
      };
    case replyClassificationCodes.negative:
      return {
        replyAxis: replyAxes.replied,
        managementRecommendation: replyManagementRecommendations.reviewClosure,
        requiresUserConfirmation: true,
      };
    case replyClassificationCodes.outOfOffice:
      return {
        replyAxis: input.currentReplyAxis,
        managementRecommendation: replyManagementRecommendations.waitForReturn,
        requiresUserConfirmation: false,
      };
    case replyClassificationCodes.unknown:
      return {
        replyAxis: input.currentReplyAxis,
        managementRecommendation: replyManagementRecommendations.manualReview,
        requiresUserConfirmation: true,
      };
  }
};

export function projectReplyToOpportunity(
  input: ReplyOpportunityProjectionInput,
): ReplyOpportunityProjection {
  const decision = decisionFor(input);
  return Object.freeze({
    opportunityState: input.opportunityState,
    ...decision,
    autoSendAllowed: false,
    projectionVersion: "reply-opportunity-projection-v1",
  });
}
