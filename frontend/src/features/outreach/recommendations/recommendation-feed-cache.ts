import {
  backlinksProjectQueries,
  createProjectQueryKey,
  type ProjectQueryKey,
} from "@/features/outreach/api/project-query"

import type { RecommendationFeedFilters } from "./recommendation-feed-api"

export function recommendationFeedCachePrefix(websiteProjectKey: string) {
  return ["backlinks", websiteProjectKey, "recommendation-feed"] as const
}

export function recommendationFeedActorCachePrefix(
  websiteProjectKey: string,
  actorScope: string
) {
  if (!actorScope.trim()) throw new Error("actorScope is required")
  return [
    ...recommendationFeedCachePrefix(websiteProjectKey),
    actorScope,
  ] as const
}

export function recommendationFeedFilterFingerprint(
  filters: RecommendationFeedFilters
) {
  return JSON.stringify({
    batchId: filters.batchId ?? null,
    recommendedOnly: filters.recommendedOnly ?? null,
    category: filters.category ?? null,
    trafficMin: filters.trafficMin ?? null,
    trafficMax: filters.trafficMax ?? null,
    rankMin: filters.rankMin ?? null,
    rankMax: filters.rankMax ?? null,
    spamMin: filters.spamMin ?? null,
    spamMax: filters.spamMax ?? null,
    sort: filters.sort ?? "released_desc",
    domainSearch: filters.domainSearch ?? null,
    limit: filters.limit ?? 50,
  })
}

export function recommendationFeedQueryKey(
  websiteProjectKey: string,
  actorScope: string,
  contextVersion: number,
  filters: RecommendationFeedFilters,
  cursor: string | null
): ProjectQueryKey {
  return createProjectQueryKey(
    websiteProjectKey,
    "recommendation-feed",
    actorScope,
    contextVersion,
    "items",
    recommendationFeedFilterFingerprint(filters),
    cursor
  )
}

export function recommendationFeedStatusQueryKey(
  websiteProjectKey: string,
  actorScope: string,
  contextVersion: number
): ProjectQueryKey {
  return createProjectQueryKey(
    websiteProjectKey,
    "recommendation-feed",
    actorScope,
    contextVersion,
    "status"
  )
}

export function activateRecommendationFeedContext(
  websiteProjectKey: string,
  actorScope: string,
  contextVersion: number
) {
  backlinksProjectQueries.activateScope(
    recommendationFeedActorCachePrefix(websiteProjectKey, actorScope),
    contextVersion
  )
}

export function invalidateRecommendationFeed(websiteProjectKey: string) {
  backlinksProjectQueries.invalidate(
    recommendationFeedCachePrefix(websiteProjectKey)
  )
}

export function invalidateRecommendationOpportunityCaches(
  websiteProjectKey: string
) {
  invalidateRecommendationFeed(websiteProjectKey)
  backlinksProjectQueries.invalidate([
    "backlinks",
    websiteProjectKey,
    "opportunities",
  ])
}
