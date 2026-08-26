import type { RecommendationInventoryStatus } from "./api"

export type RecommendationInventoryIdentity = {
  websiteProjectId: string
  contractKind: string
  recommendationContextVersionId: string | null
  visiblePoolGeneration: number
  serverUpdatedAt: string | null
}

export function recommendationInventoryIdentity(
  inventory: RecommendationInventoryStatus
): RecommendationInventoryIdentity {
  return {
    websiteProjectId: inventory.meta.websiteProjectId,
    contractKind: inventory.contractKind,
    recommendationContextVersionId:
      inventory.recommendationContextVersionId,
    visiblePoolGeneration: inventory.visiblePoolGeneration,
    serverUpdatedAt: inventory.serverUpdatedAt,
  }
}

export function isStaleRecommendationInventoryIdentity(
  expectedWebsiteProjectId: string,
  accepted: RecommendationInventoryIdentity | null,
  incoming: RecommendationInventoryIdentity
) {
  if (incoming.websiteProjectId !== expectedWebsiteProjectId) return true
  if (accepted === null) return false
  if (
    incoming.websiteProjectId !== accepted.websiteProjectId ||
    incoming.contractKind !== accepted.contractKind ||
    (accepted.recommendationContextVersionId !== null &&
      incoming.recommendationContextVersionId !==
        accepted.recommendationContextVersionId) ||
    incoming.visiblePoolGeneration < accepted.visiblePoolGeneration
  ) {
    return true
  }
  if (
    incoming.visiblePoolGeneration !== accepted.visiblePoolGeneration ||
    incoming.recommendationContextVersionId !==
      accepted.recommendationContextVersionId ||
    incoming.serverUpdatedAt === null ||
    accepted.serverUpdatedAt === null
  ) {
    return false
  }
  return Date.parse(incoming.serverUpdatedAt) < Date.parse(accepted.serverUpdatedAt)
}
