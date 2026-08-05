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
export type ContactEnrichmentJob =
  BacklinksResponse<"backlinksGetContactEnrichmentJobV1">
export type RecommendationRefillJob =
  BacklinksResponse<"backlinksRequestRecommendationRefillV1">
export type PublicContactRole =
  BacklinksResponse<"backlinksAddPublicContactCandidateV1">["normalizedEmail"] extends string
    ? | "press"
      | "editorial"
      | "partnerships"
      | "advertising"
      | "support"
      | "general"
    : never

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

export function requestRecommendationRefill(
  websiteProjectKey: string,
  recommendationContextVersionId: string,
  idempotencyKey: string,
  refillWindowKey: string
) {
  return requestBacklinks("backlinksRequestRecommendationRefillV1", {
    path: { websiteProjectKey },
    headers: { "idempotency-key": idempotencyKey },
    body: {
      expectedVersion: 0,
      recommendationContextVersionId,
      lowWatermark: 20,
      highWatermark: 21,
      refillWindowKey,
    },
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

export function getContactEnrichmentJob(
  websiteProjectKey: string,
  jobId: string,
  signal: AbortSignal
) {
  return requestBacklinks(
    "backlinksGetContactEnrichmentJobV1",
    {
      path: { websiteProjectKey, jobId },
    },
    { signal }
  )
}

export function retryContactEnrichment(
  websiteProjectKey: string,
  jobId: string
) {
  return requestBacklinks("backlinksRetryContactEnrichmentV1", {
    path: { websiteProjectKey, jobId },
  })
}

export function addPublicContactCandidate(
  websiteProjectKey: string,
  recommendationId: string,
  input: {
    normalizedEmail: string
    contactRole: PublicContactRole
    sourceUrl: string
    reason: string
  }
) {
  return requestBacklinks("backlinksAddPublicContactCandidateV1", {
    path: { websiteProjectKey, recommendationId },
    body: input,
  })
}
