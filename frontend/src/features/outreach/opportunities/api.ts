import {
  requestBacklinks,
  type BacklinksResponse,
} from "@/api/generated/backlinks"
import { ApiError } from "@/api/client"

export type OpportunityListResponse =
  BacklinksResponse<"backlinksListOpportunitiesV1">
export type OpportunityListItem = OpportunityListResponse["items"][number]
export type OpportunityDetailResponse =
  BacklinksResponse<"backlinksGetOpportunityV1">
export type OpportunityDetail = OpportunityDetailResponse["item"]
export type OpportunityBusinessStage = OpportunityDetail["businessStage"]
export type OpportunityManagementStatus = OpportunityDetail["managementStatus"]
export type OpportunityOutcomeStatus = OpportunityDetail["outcomeStatus"]
export type OpportunityFulfillmentStatus =
  OpportunityDetail["fulfillmentStatus"]
export type OpportunityManualActionState = NonNullable<
  OpportunityDetail["cooperationPath"]
>["state"]

export type OpportunityFilters = {
  businessStage?: OpportunityBusinessStage
  managementStatus?: OpportunityManagementStatus
  outcomeStatus?: OpportunityOutcomeStatus
  fulfillmentStatus?: OpportunityFulfillmentStatus
  search?: string
}

export function listOpportunities(
  websiteProjectKey: string,
  filters: OpportunityFilters,
  signal: AbortSignal
) {
  return requestBacklinks(
    "backlinksListOpportunitiesV1",
    {
      path: { websiteProjectKey },
      query: { ...filters, limit: 100 },
    },
    { signal }
  )
}

export function getOpportunity(
  websiteProjectKey: string,
  opportunityId: string,
  signal?: AbortSignal
) {
  return requestBacklinks(
    "backlinksGetOpportunityV1",
    {
      path: { websiteProjectKey, opportunityId },
    },
    { signal }
  )
}

export function transitionOpportunity(
  websiteProjectKey: string,
  opportunityId: string,
  input: {
    expectedVersion: number
    toBusinessStage: OpportunityBusinessStage
    reason: string
  }
) {
  return requestBacklinks("backlinksTransitionOpportunityBusinessStageV1", {
    path: { websiteProjectKey, opportunityId },
    headers: { "idempotency-key": crypto.randomUUID() },
    body: input,
  })
}

export function patchOpportunityManagement(
  websiteProjectKey: string,
  opportunityId: string,
  input: {
    expectedVersion: number
    managementStatus: OpportunityManagementStatus
    reason: string
  },
  idempotencyKey: string
) {
  return requestBacklinks("backlinksPatchOpportunityManagementV1", {
    path: { websiteProjectKey, opportunityId },
    headers: { "idempotency-key": idempotencyKey },
    body: input,
  })
}

export function patchCooperationPathContent(
  websiteProjectKey: string,
  opportunityId: string,
  input: {
    expectedVersion: number
    editableContent: string
    nextAction: string
  }
) {
  return requestBacklinks("backlinksPatchCooperationPathContentV1", {
    path: { websiteProjectKey, opportunityId },
    headers: { "idempotency-key": crypto.randomUUID() },
    body: input,
  })
}

export function transitionManualAction(
  websiteProjectKey: string,
  opportunityId: string,
  input: {
    expectedVersion: number
    toState: OpportunityManualActionState
    nextAction: string
    evidence?: Record<string, unknown>
    submissionConfirmed?: boolean
  }
) {
  return requestBacklinks("backlinksTransitionManualActionV1", {
    path: { websiteProjectKey, opportunityId },
    headers: { "idempotency-key": crypto.randomUUID() },
    body: input,
  })
}

export const isOpportunityApiStatus = (error: unknown, status: number) =>
  error instanceof ApiError && error.status === status
