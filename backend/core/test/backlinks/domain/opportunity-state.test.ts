import { describe, expect, it } from "vitest";
import {
  InvalidOpportunityTransitionError,
  initialOpportunityState,
  isOpportunityBusinessStage,
  opportunityBusinessStageTransitions,
  opportunityBusinessStages,
  opportunityFulfillmentStatuses,
  opportunityManagementStatuses,
  opportunityOutcomeStatuses,
  transitionOpportunityBusinessStage,
  type OpportunityBusinessStage,
} from "../../../src/modules/backlinks/domain/opportunities/opportunity-state.js";

const stateAt = (businessStage: OpportunityBusinessStage) => ({
  ...initialOpportunityState,
  businessStage,
  managementStatus: "PAUSED" as const,
  outcomeStatus: "OPEN" as const,
  fulfillmentStatus: "PARTIAL" as const,
});

describe("BL-AI-075 Opportunity state", () => {
  it("defines four independent axes and their initial values", () => {
    expect(opportunityBusinessStages).toEqual([
      "JOINED",
      "CONTACT_PREPARING",
      "READY_TO_CONTACT",
      "OUTREACH_ACTIVE",
      "NEGOTIATING",
      "AGREED",
      "WAITING_PLACEMENT",
      "RELATIONSHIP_ACTIVE",
      "CLOSED",
    ]);
    expect(opportunityManagementStatuses).toEqual([
      "ACTIVE",
      "PAUSED",
      "ARCHIVED",
    ]);
    expect(opportunityOutcomeStatuses).toEqual(["OPEN", "WON", "LOST"]);
    expect(opportunityFulfillmentStatuses).toEqual([
      "NOT_EXPECTED",
      "PENDING",
      "PARTIAL",
      "FULFILLED",
    ]);
    expect(initialOpportunityState).toEqual({
      businessStage: "JOINED",
      managementStatus: "ACTIVE",
      outcomeStatus: "OPEN",
      fulfillmentStatus: "NOT_EXPECTED",
    });
  });

  it("accepts every declared business transition without changing other axes", () => {
    for (const from of opportunityBusinessStages) {
      for (const to of opportunityBusinessStageTransitions[from]) {
        const current = stateAt(from);
        const next = transitionOpportunityBusinessStage(current, to);

        expect(next).toEqual({ ...current, businessStage: to });
        expect(next).not.toBe(current);
        expect(Object.isFrozen(next)).toBe(true);
      }
    }
  });

  it("rejects every undeclared business transition with a stable error", () => {
    for (const from of opportunityBusinessStages) {
      const allowed = opportunityBusinessStageTransitions[from];
      for (const to of opportunityBusinessStages) {
        if (allowed.includes(to)) continue;

        expect(() => transitionOpportunityBusinessStage(stateAt(from), to))
          .toThrowError(InvalidOpportunityTransitionError);
        try {
          transitionOpportunityBusinessStage(stateAt(from), to);
        } catch (error) {
          expect(error).toMatchObject({
            code: "INVALID_OPPORTUNITY_TRANSITION",
            from,
            to,
          });
        }
      }
    }
  });

  it("does not admit Email or Placement facts as Opportunity main stages", () => {
    const relatedFacts = [
      "DRAFTED",
      "WAITING_SEND",
      "SENT_WAITING_REPLY",
      "REPLIED",
      "pending_verification",
      "active",
      "suspected_changed",
      "changed",
      "suspected_lost",
      "lost",
    ];

    for (const fact of relatedFacts) {
      expect(isOpportunityBusinessStage(fact)).toBe(false);
      expect(() =>
        transitionOpportunityBusinessStage(
          initialOpportunityState,
          fact as OpportunityBusinessStage,
        ),
      ).toThrowError(InvalidOpportunityTransitionError);
    }
  });
});
