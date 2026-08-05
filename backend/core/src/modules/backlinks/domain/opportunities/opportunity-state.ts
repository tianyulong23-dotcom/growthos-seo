export const opportunityBusinessStages = Object.freeze([
  "JOINED",
  "CONTACT_PREPARING",
  "READY_TO_CONTACT",
  "OUTREACH_ACTIVE",
  "NEGOTIATING",
  "AGREED",
  "WAITING_PLACEMENT",
  "RELATIONSHIP_ACTIVE",
  "CLOSED",
] as const);

export const opportunityManagementStatuses = Object.freeze([
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
] as const);

export const opportunityOutcomeStatuses = Object.freeze([
  "OPEN",
  "WON",
  "LOST",
] as const);

export const opportunityFulfillmentStatuses = Object.freeze([
  "NOT_EXPECTED",
  "PENDING",
  "PARTIAL",
  "FULFILLED",
] as const);

export type OpportunityBusinessStage =
  (typeof opportunityBusinessStages)[number];
export type OpportunityManagementStatus =
  (typeof opportunityManagementStatuses)[number];
export type OpportunityOutcomeStatus =
  (typeof opportunityOutcomeStatuses)[number];
export type OpportunityFulfillmentStatus =
  (typeof opportunityFulfillmentStatuses)[number];

export type OpportunityState = Readonly<{
  businessStage: OpportunityBusinessStage;
  managementStatus: OpportunityManagementStatus;
  outcomeStatus: OpportunityOutcomeStatus;
  fulfillmentStatus: OpportunityFulfillmentStatus;
}>;

type OpportunityBusinessStageTransitions = Readonly<
  Record<OpportunityBusinessStage, readonly OpportunityBusinessStage[]>
>;

export const opportunityBusinessStageTransitions:
  OpportunityBusinessStageTransitions = Object.freeze({
    JOINED: Object.freeze([
      "CONTACT_PREPARING",
      "READY_TO_CONTACT",
      "CLOSED",
    ] as const),
    CONTACT_PREPARING: Object.freeze(["READY_TO_CONTACT", "CLOSED"] as const),
    READY_TO_CONTACT: Object.freeze(["OUTREACH_ACTIVE", "CLOSED"] as const),
    OUTREACH_ACTIVE: Object.freeze([
      "NEGOTIATING",
      "AGREED",
      "CLOSED",
    ] as const),
    NEGOTIATING: Object.freeze([
      "OUTREACH_ACTIVE",
      "AGREED",
      "CLOSED",
    ] as const),
    AGREED: Object.freeze(["WAITING_PLACEMENT", "CLOSED"] as const),
    WAITING_PLACEMENT: Object.freeze([
      "RELATIONSHIP_ACTIVE",
      "CLOSED",
    ] as const),
    RELATIONSHIP_ACTIVE: Object.freeze(["CLOSED"] as const),
    CLOSED: Object.freeze([] as const),
  });

export const initialOpportunityState: OpportunityState = Object.freeze({
  businessStage: "JOINED",
  managementStatus: "ACTIVE",
  outcomeStatus: "OPEN",
  fulfillmentStatus: "NOT_EXPECTED",
});

export class InvalidOpportunityTransitionError extends Error {
  readonly code = "INVALID_OPPORTUNITY_TRANSITION";

  constructor(
    readonly from: unknown,
    readonly to: unknown,
  ) {
    super(`Invalid Opportunity transition: ${String(from)} -> ${String(to)}`);
  }
}

export function isOpportunityBusinessStage(
  value: unknown,
): value is OpportunityBusinessStage {
  return (opportunityBusinessStages as readonly unknown[]).includes(value);
}

export function canTransitionOpportunityBusinessStage(
  from: unknown,
  to: unknown,
): boolean {
  return isOpportunityBusinessStage(from) &&
    isOpportunityBusinessStage(to) &&
    opportunityBusinessStageTransitions[from].includes(to);
}

export function transitionOpportunityBusinessStage(
  current: OpportunityState,
  to: OpportunityBusinessStage,
): OpportunityState {
  if (!canTransitionOpportunityBusinessStage(current.businessStage, to)) {
    throw new InvalidOpportunityTransitionError(current.businessStage, to);
  }

  return Object.freeze({ ...current, businessStage: to });
}
