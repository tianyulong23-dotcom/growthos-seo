import {
  requestBacklinks,
  type BacklinksResponse,
} from "@/api/generated/backlinks"

import {
  clearRecommendationOperation,
  clearRecommendationRefillAttempt,
  getOrCreateRecommendationRefillAttempt,
  readRecommendationOperation,
  storeRecommendationOperation,
} from "./recommendation-operation-session"

export type RecommendationsResponse =
  BacklinksResponse<"backlinksListRecommendationsV1">
export type RecommendationItem = RecommendationsResponse["items"][number]
export type CreateOpportunityResponse =
  BacklinksResponse<"backlinksCreateOpportunityV1">
export type CreateCooperationPathOpportunityResponse =
  BacklinksResponse<"backlinksCreateCooperationPathOpportunityV1">
export type RecommendationInventoryStatus =
  BacklinksResponse<"backlinksGetRecommendationInventoryV1">
export type RequestRecommendationRefillResponse =
  BacklinksResponse<"backlinksRequestRecommendationRefillV1">
export type ArchiveRecommendationPoolResponse =
  BacklinksResponse<"backlinksArchiveRecommendationPoolV1">
export type RetryUnpublishedContactsResponse =
  BacklinksResponse<"backlinksRetryUnpublishedContactsV1">
export type RunCurrentPoolContactEnrichmentResponse =
  BacklinksResponse<"backlinksRunCurrentPoolContactEnrichmentV1">
export type StartContactEnrichmentResponse =
  BacklinksResponse<"backlinksStartContactEnrichmentV1">
export type RetryContactEnrichmentResponse =
  BacklinksResponse<"backlinksRetryContactEnrichmentV1">

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
  contactCandidateId: string | undefined,
  expectedVersion: number
) {
  return requestBacklinks("backlinksCreateOpportunityV1", {
    path: { websiteProjectKey },
    headers: { "idempotency-key": crypto.randomUUID() },
    body: { recommendationId, contactCandidateId, expectedVersion },
  })
}

export function createCooperationPathOpportunity(
  websiteProjectKey: string,
  input: {
    recommendationId: string
    cooperationPathFactId: string
    expectedVersion: number
    editableContent: string
    nextAction: string
  }
) {
  return requestBacklinks("backlinksCreateCooperationPathOpportunityV1", {
    path: { websiteProjectKey },
    headers: { "idempotency-key": crypto.randomUUID() },
    body: input,
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

export function runCurrentPoolContactEnrichment(websiteProjectKey: string) {
  return requestBacklinks("backlinksRunCurrentPoolContactEnrichmentV1", {
    path: { websiteProjectKey },
  })
}

export function startContactEnrichment(
  websiteProjectKey: string,
  recommendationId: string
) {
  return requestBacklinks("backlinksStartContactEnrichmentV1", {
    path: { websiteProjectKey, recommendationId },
  })
}

export function retryContactEnrichment(
  websiteProjectKey: string,
  jobId: string
) {
  return requestBacklinks("backlinksRetryContactEnrichmentV1", {
    path: { websiteProjectKey, jobId },
  })
}

export function requestRecommendationRefill(
  websiteProjectKey: string,
  recommendationContextVersionId: string,
  visiblePoolGeneration: number,
  options: Readonly<{
    startNewOperation?: boolean
    operationId?: string
  }> = {}
) {
  const scope = {
    websiteProjectKey,
    recommendationContextVersionId,
    visiblePoolGeneration,
  }
  if (options.startNewOperation === true) {
    clearRecommendationOperation(window.localStorage, scope)
  }
  const operationId =
    options.startNewOperation === true
      ? undefined
      : options.operationId ??
        readRecommendationOperation(window.localStorage, scope) ??
        undefined
  const idempotencyKey =
    operationId === undefined
      ? `recommendation-refill-attempt:${getOrCreateRecommendationRefillAttempt(
          window.localStorage,
          scope,
          () => crypto.randomUUID()
        )}`
      : `recommendation-refill-operation:${operationId}`
  return requestBacklinks("backlinksRequestRecommendationRefillV1", {
    path: { websiteProjectKey },
    headers: { "idempotency-key": idempotencyKey },
    body: {
      expectedVersion: 0,
      recommendationContextVersionId,
      visiblePoolGeneration,
      ...(operationId === undefined ? {} : { operationId }),
    },
  }).then((result) => {
    clearRecommendationRefillAttempt(window.localStorage, scope)
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
