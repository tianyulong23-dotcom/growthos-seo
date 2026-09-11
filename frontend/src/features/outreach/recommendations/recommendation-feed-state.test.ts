import { describe, expect, it } from "vitest"

import type {
  RecommendationFeedItem,
  RecommendationFeedStatus,
} from "./recommendation-feed-api"
import {
  recommendationGetMoreState,
  recommendationOpportunityLabel,
} from "./recommendation-feed-state"

function status(
  overrides: Partial<RecommendationFeedStatus> = {}
): RecommendationFeedStatus {
  return {
    state: "PUBLISHED",
    currentBatchOrdinal: 1,
    successfulOpportunityCount: 2,
    requiredOpportunityCount: 5,
    unlockAt: "2026-08-28T18:00:00.000Z",
    unlockReason: null,
    canGetMore: false,
    getMoreState: "NOT_UNLOCKED",
    meta: {
      organizationId: "organization-1",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      requestId: "request-1",
      schemaVersion: "backlinks.recommendation-user-release.v2",
      generatedAt: "2026-08-28T00:00:00.000Z",
    },
    ...overrides,
  }
}

function item(
  opportunity: RecommendationFeedItem["opportunity"]
): RecommendationFeedItem {
  return {
    itemId: "00000000-0000-4000-8000-000000000001",
    domain: "example.com",
    displayUrl: "https://example.com/",
    recommended: true,
    reasons: ["Matches the target audience"],
    category: "Editorial",
    metrics: {
      targetMarketOrganicTraffic: null,
      dataForSeoRank: null,
      spamScore: null,
    },
    contact: {
      email: null,
      contactPage: "https://example.com/contact",
      outcome: "CONTACT_PAGE_FOUND",
    },
    opportunity,
    archived: false,
    releasedAt: "2026-08-28T00:00:00.000Z",
  }
}

describe("recommendation feed state", () => {
  it("maps get-more transitions without releasing a batch locally", () => {
    expect(recommendationGetMoreState(status())).toEqual({
      enabled: false,
      label: "状态需刷新",
    })
    expect(
      recommendationGetMoreState(
        status({ canGetMore: false, getMoreState: "NEXT_BATCH_PREPARING" })
      )
    ).toEqual({ enabled: false, label: "下一批准备中" })
    expect(
      recommendationGetMoreState(
        status({ canGetMore: true, getMoreState: "RELEASE_NEXT" })
      )
    ).toEqual({ enabled: true, label: "获取更多" })
    expect(
      recommendationGetMoreState(
        status({ canGetMore: false, getMoreState: "POOL_EXHAUSTED" })
      )
    ).toEqual({ enabled: false, label: "暂无更多结果" })
  })

  it("distinguishes current-user and team Opportunity state from archive state", () => {
    expect(
      recommendationOpportunityLabel(
        item({
          opportunityId: "00000000-0000-4000-8000-000000000002",
          businessStage: null,
          managementStatus: null,
          outcomeStatus: null,
          createdByCurrentUser: true,
        })
      )
    ).toBe("已加入外链机会")
    expect(
      recommendationOpportunityLabel(
        item({
          opportunityId: "00000000-0000-4000-8000-000000000003",
          businessStage: null,
          managementStatus: null,
          outcomeStatus: null,
          createdByCurrentUser: false,
        })
      )
    ).toBe("团队已加入外链机会")
    expect(
      recommendationOpportunityLabel(
        item({
          opportunityId: null,
          businessStage: null,
          managementStatus: null,
          outcomeStatus: null,
          createdByCurrentUser: false,
        })
      )
    ).toBe("尚未加入")
  })

})
