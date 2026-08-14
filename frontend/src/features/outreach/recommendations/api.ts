import {
  requestBacklinks,
  type BacklinksResponse,
} from "@/api/generated/backlinks"

import {
  readRecommendationOperation,
  storeRecommendationOperation,
} from "./recommendation-operation-session"

export type RecommendationsResponse =
  BacklinksResponse<"backlinksListRecommendationsV1">
export type RecommendationItem = RecommendationsResponse["items"][number]
export type CreateOpportunityResponse =
  BacklinksResponse<"backlinksCreateOpportunityV1">
export type RecommendationInventoryStatus =
  BacklinksResponse<"backlinksGetRecommendationInventoryV1">
export type RequestRecommendationRefillResponse =
  BacklinksResponse<"backlinksRequestRecommendationRefillV1">
export type ArchiveRecommendationPoolResponse =
  BacklinksResponse<"backlinksArchiveRecommendationPoolV1">
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
      query: { limit: 100 },
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

export function requestRecommendationRefill(
  websiteProjectKey: string,
  recommendationContextVersionId: string,
  visiblePoolGeneration: number,
  lowWatermark: 9,
  highWatermark: 10
) {
  const scope = {
    websiteProjectKey,
    recommendationContextVersionId,
    visiblePoolGeneration,
  }
  const operationId =
    readRecommendationOperation(window.localStorage, scope) ?? undefined
  return requestBacklinks("backlinksRequestRecommendationRefillV1", {
    path: { websiteProjectKey },
    body: {
      expectedVersion: 0,
      recommendationContextVersionId,
      visiblePoolGeneration,
      lowWatermark,
      highWatermark,
      ...(operationId === undefined ? {} : { operationId }),
    },
  }).then((result) => {
    storeRecommendationOperation(window.localStorage, scope, result.operationId)
    return result
  })
}

export function archiveRecommendationPool(
  websiteProjectKey: string,
  recommendationContextVersionId: string,
  visiblePoolGeneration: number
) {
  return requestBacklinks("backlinksArchiveRecommendationPoolV1", {
    path: { websiteProjectKey, visiblePoolGeneration },
    headers: {
      "idempotency-key": `recommendation-pool-archive:${recommendationContextVersionId}:g${visiblePoolGeneration}`,
    },
    body: { recommendationContextVersionId },
  })
}
