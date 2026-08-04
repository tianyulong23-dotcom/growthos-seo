import { describe, expect, it } from "vitest";

import {
  projectReplyToOpportunity,
  replyManagementRecommendations,
} from "../../src/modules/backlinks/application/services/reply-opportunity-projection.js";
import {
  replyClassificationCodes,
} from "../../src/modules/backlinks/domain/replies/classification.js";
import type {
  OpportunityState,
} from "../../src/modules/backlinks/domain/opportunities/opportunity-state.js";

const opportunityState: OpportunityState = Object.freeze({
  businessStage: "OUTREACH_ACTIVE",
  managementStatus: "ACTIVE",
  outcomeStatus: "OPEN",
  fulfillmentStatus: "NOT_EXPECTED",
});

describe("BL-AI-138 Reply to Opportunity projection", () => {
  it.each([
    {
      classificationCode: replyClassificationCodes.positive,
      recommendation: replyManagementRecommendations.reviewNegotiation,
    },
    {
      classificationCode: replyClassificationCodes.question,
      recommendation: replyManagementRecommendations.prepareAnswer,
    },
    {
      classificationCode: replyClassificationCodes.negative,
      recommendation: replyManagementRecommendations.reviewClosure,
    },
  ])(
    "projects confirmed $classificationCode replies without changing primary axes",
    ({ classificationCode, recommendation }) => {
      const projection = projectReplyToOpportunity({
        opportunityState,
        currentReplyAxis: "SENT_WAITING_REPLY",
        matchConfirmed: true,
        classificationCode,
      });

      expect(projection.opportunityState).toBe(opportunityState);
      expect(projection.replyAxis).toBe("REPLIED");
      expect(projection.managementRecommendation).toBe(recommendation);
      expect(projection.requiresUserConfirmation).toBe(true);
      expect(projection.autoSendAllowed).toBe(false);
    },
  );

  it("keeps out-of-office replies waiting without changing primary axes", () => {
    const projection = projectReplyToOpportunity({
      opportunityState,
      currentReplyAxis: "SENT_WAITING_REPLY",
      matchConfirmed: true,
      classificationCode: replyClassificationCodes.outOfOffice,
    });

    expect(projection.opportunityState).toBe(opportunityState);
    expect(projection.replyAxis).toBe("SENT_WAITING_REPLY");
    expect(projection.managementRecommendation)
      .toBe(replyManagementRecommendations.waitForReturn);
    expect(projection.requiresUserConfirmation).toBe(false);
  });

  it("does not treat unknown or unconfirmed replies as effective replies", () => {
    expect(projectReplyToOpportunity({
      opportunityState,
      currentReplyAxis: "SENT_WAITING_REPLY",
      matchConfirmed: true,
      classificationCode: replyClassificationCodes.unknown,
    })).toMatchObject({
      opportunityState,
      replyAxis: "SENT_WAITING_REPLY",
      managementRecommendation: replyManagementRecommendations.manualReview,
      requiresUserConfirmation: true,
    });

    expect(projectReplyToOpportunity({
      opportunityState,
      currentReplyAxis: "SENT_WAITING_REPLY",
      matchConfirmed: false,
      classificationCode: replyClassificationCodes.positive,
    })).toMatchObject({
      opportunityState,
      replyAxis: "SENT_WAITING_REPLY",
      managementRecommendation: replyManagementRecommendations.confirmMatch,
      requiresUserConfirmation: true,
    });
  });

  it("preserves an existing replied fact during replay", () => {
    const projection = projectReplyToOpportunity({
      opportunityState,
      currentReplyAxis: "REPLIED",
      matchConfirmed: true,
      classificationCode: replyClassificationCodes.outOfOffice,
    });

    expect(projection.replyAxis).toBe("REPLIED");
    expect(projection.projectionVersion).toBe("reply-opportunity-projection-v1");
  });
});
