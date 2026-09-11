import type {
  RecommendationFeedItem,
  RecommendationFeedStatus,
} from "./recommendation-feed-api"

export function recommendationOpportunityLabel(item: RecommendationFeedItem) {
  if (item.opportunity.createdByCurrentUser) {
    return "已加入外链机会"
  }
  if (item.opportunity.opportunityId !== null) {
    return "团队已加入外链机会"
  }
  return "尚未加入"
}

export function recommendationGetMoreState(status: RecommendationFeedStatus) {
  switch (status.getMoreState) {
    case "POOL_EXHAUSTED":
      return { enabled: false, label: "暂无更多结果" } as const
    case "NEXT_BATCH_PREPARING":
      return { enabled: false, label: "下一批准备中" } as const
    case "INITIAL_BATCH_NOT_PUBLISHED":
      return { enabled: false, label: "首批准备中" } as const
    case "NOT_UNLOCKED":
      return { enabled: false, label: "状态需刷新" } as const
    case "RELEASE_NEXT":
      return status.canGetMore
        ? ({ enabled: true, label: "获取更多" } as const)
        : ({ enabled: false, label: "暂不可获取" } as const)
  }
}

export function recommendationPoolStateLabel(status: RecommendationFeedStatus) {
  if (status.state === "NOT_PUBLISHED") return "推荐池正在准备"
  return recommendationGetMoreState(status).enabled
    ? "可以获取更多"
    : "推荐池已发布"
}
