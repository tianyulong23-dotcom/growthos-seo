import { beforeEach, describe, expect, it, vi } from "vitest"

const { requestBacklinksMock } = vi.hoisted(() => ({
  requestBacklinksMock: vi.fn(),
}))

vi.mock("@/api/generated/backlinks", () => ({
  requestBacklinks: requestBacklinksMock,
}))

import {
  confirmRecommendationSeeds,
  createRecommendationFeedOpportunity,
  exportRecommendationFeed,
  generateRecommendationPool,
  getMoreRecommendationFeed,
  listRecommendationFeed,
  previewRecommendationSeeds,
  publishInitialRecommendationFeed,
  setRecommendationFeedItemArchived,
} from "./recommendation-feed-api"

describe("recommendation feed API", () => {
  beforeEach(() => {
    requestBacklinksMock.mockReset()
  })

  it("publishes the authenticated member's initial batch with an abortable generated request", () => {
    const signal = new AbortController().signal
    publishInitialRecommendationFeed("project-a", signal)
    expect(requestBacklinksMock).toHaveBeenCalledWith(
      "backlinksPublishInitialRecommendationBatchV2",
      { path: { websiteProjectKey: "project-a" } },
      { signal }
    )
  })

  it("uses the generated list contract with only supported filters", () => {
    const signal = new AbortController().signal

    listRecommendationFeed(
      "project-a",
      {
        recommendedOnly: true,
        batchId: "00000000-0000-4000-8000-000000000101",
        category: "media",
        trafficMin: 100,
        trafficMax: 1_000,
        rankMin: 10,
        rankMax: 90,
        spamMin: 0,
        spamMax: 20,
        sort: "released_desc",
        domainSearch: "publisher",
        limit: 25,
      },
      "cursor-a",
      signal
    )

    expect(requestBacklinksMock).toHaveBeenCalledWith(
      "backlinksListRecommendationFeedV2",
      {
        path: { websiteProjectKey: "project-a" },
        query: {
          batchId: "00000000-0000-4000-8000-000000000101",
          recommendedOnly: "true",
          category: "media",
          trafficMin: 100,
          trafficMax: 1_000,
          rankMin: 10,
          rankMax: 90,
          spamMin: 0,
          spamMax: 20,
          sort: "released_desc",
          domainSearch: "publisher",
          limit: 25,
          cursor: "cursor-a",
        },
      },
      { signal }
    )
  })

  it("exports only the current filters and selected released item IDs", () => {
    exportRecommendationFeed(
      "project-a",
      {
        recommendedOnly: false,
        category: "media",
        sort: "domain_asc",
      },
      ["item-a", "item-b"]
    )

    expect(requestBacklinksMock).toHaveBeenCalledWith(
      "backlinksExportRecommendationFeedV2",
      {
        path: { websiteProjectKey: "project-a" },
        body: {
          filters: {
            recommendedOnly: false,
            category: "media",
            trafficMin: undefined,
            trafficMax: undefined,
            rankMin: undefined,
            rankMax: undefined,
            spamMin: undefined,
            spamMax: undefined,
            sort: "domain_asc",
            domainSearch: undefined,
          },
          selectedItemIds: ["item-a", "item-b"],
        },
      }
    )
  })

  it("uses existing release and canonical Opportunity operations", () => {
    getMoreRecommendationFeed("project-a", "get-more-key")
    setRecommendationFeedItemArchived("project-a", "item-a", true)
    setRecommendationFeedItemArchived("project-a", "item-a", false)
    createRecommendationFeedOpportunity("project-a", "item-a")

    expect(requestBacklinksMock.mock.calls[0]).toEqual([
      "backlinksGetMoreRecommendationFeedV2",
      {
        path: { websiteProjectKey: "project-a" },
        headers: { "idempotency-key": "get-more-key" },
      },
    ])
    expect(requestBacklinksMock.mock.calls[1]?.[0]).toBe(
      "backlinksArchiveRecommendationFeedItemV2"
    )
    expect(requestBacklinksMock.mock.calls[2]?.[0]).toBe(
      "backlinksUnarchiveRecommendationFeedItemV2"
    )
    expect(requestBacklinksMock.mock.calls[3]?.[0]).toBe(
      "backlinksCreateOpportunityV1"
    )
    expect(requestBacklinksMock.mock.calls[3]?.[1]).toMatchObject({
      path: { websiteProjectKey: "project-a" },
      headers: { "idempotency-key": expect.any(String) },
      body: { recommendationFeedItemId: "item-a" },
    })
  })

  it("previews generated seeds without treating an empty preview as confirmation", () => {
    previewRecommendationSeeds("project-a", [])

    expect(requestBacklinksMock).toHaveBeenCalledWith(
      "backlinksValidateRecommendationSeedsV2",
      {
        path: { websiteProjectKey: "project-a" },
        body: { seeds: [] },
      }
    )
  })

  it("confirms only an explicit non-empty seed set", () => {
    expect(() =>
      confirmRecommendationSeeds("project-a", "confirmation-key", [])
    ).toThrow(/non-empty recommendation seed set/i)
    expect(requestBacklinksMock).not.toHaveBeenCalled()

    confirmRecommendationSeeds("project-a", "confirmation-key", [
      { kind: "KEYWORD", value: "email outreach" },
    ])
    expect(requestBacklinksMock).toHaveBeenCalledWith(
      "backlinksGenerateRecommendationSeedsV2",
      {
        path: { websiteProjectKey: "project-a" },
        headers: { "idempotency-key": "confirmation-key" },
        body: {
          seeds: [{ kind: "KEYWORD", value: "email outreach" }],
        },
      }
    )
  })

  it("refuses launch without a confirmation and sends the exact confirmed snapshot", () => {
    expect(() =>
      generateRecommendationPool("project-a", "generation-key", null)
    ).toThrow(/confirmed seed snapshot/i)
    expect(requestBacklinksMock).not.toHaveBeenCalled()

    const confirmation = {
      generationContractId: "00000000-0000-4000-8000-000000000031",
      seedSnapshotFingerprint: "a".repeat(64),
    }
    generateRecommendationPool("project-a", "generation-key", confirmation)
    expect(requestBacklinksMock).toHaveBeenCalledWith(
      "backlinksLaunchRecommendationPoolV2",
      {
        path: { websiteProjectKey: "project-a" },
        headers: { "idempotency-key": "generation-key" },
        body: confirmation,
      }
    )
  })
})
