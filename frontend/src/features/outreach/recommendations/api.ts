import {
  requestBacklinks,
  type BacklinksResponse,
} from "@/api/generated/backlinks"

export type RecommendationsResponse =
  BacklinksResponse<"backlinksListRecommendationsV1">
export type RecommendationItem = RecommendationsResponse["items"][number]
export type RecommendationAssessment = RecommendationItem["assessment"]
export type RecommendationScoreComponentId =
  RecommendationAssessment["components"][number]["id"]
export type CreateOpportunityResponse =
  BacklinksResponse<"backlinksCreateOpportunityV1">
export type RecommendationInventoryStatus =
  BacklinksResponse<"backlinksGetRecommendationInventoryV1">
export type RetryUnpublishedContactsResponse =
  BacklinksResponse<"backlinksRetryUnpublishedContactsV1">

export function listRecommendations(
  websiteProjectKey: string,
  signal: AbortSignal
) {
  return requestBacklinks(
    "backlinksListRecommendationsV1",
    {
      path: { websiteProjectKey },
      query: { status: "ready", limit: 100 },
    },
    { signal }
  )
}

export function createOpportunity(
  websiteProjectKey: string,
  recommendationId: string,
  contactCandidateId: string,
  expectedVersion: number
) {
  return requestBacklinks("backlinksCreateOpportunityV1", {
    path: { websiteProjectKey },
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { recommendationId, contactCandidateId, expectedVersion },
  })
}

export function getRecommendationInventory(
  websiteProjectKey: string,
  signal: AbortSignal
) {
  return requestBacklinks(
    "backlinksGetRecommendationInventoryV1",
    {
      path: { websiteProjectKey },
    },
    { signal }
  )
}

export function retryUnpublishedContacts(websiteProjectKey: string) {
  return requestBacklinks("backlinksRetryUnpublishedContactsV1", {
    path: { websiteProjectKey },
  })
}
