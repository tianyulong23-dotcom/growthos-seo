import { afterEach, describe, expect, it } from "vitest"

import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"

import {
  invalidateRecommendationFeed,
  invalidateRecommendationOpportunityCaches,
  recommendationFeedQueryKey,
  recommendationFeedStatusQueryKey,
} from "./recommendation-feed-cache"

const projectKey = "recommendation-feed-cache-test"

afterEach(() => {
  backlinksProjectQueries.invalidateProject(projectKey)
})

describe("recommendation feed cache", () => {
  it("uses a project, context, filters, and cursor specific key", () => {
    expect(
      recommendationFeedQueryKey(
        projectKey,
        "actor-a",
        7,
        {
          recommendedOnly: true,
          category: "Editorial",
          sort: "traffic_desc",
          limit: 25,
        },
        "cursor-2"
      )
    ).toEqual([
      "backlinks",
      projectKey,
      "recommendation-feed",
      "actor-a",
      7,
      "items",
      JSON.stringify({
        batchId: null,
        recommendedOnly: true,
        category: "Editorial",
        trafficMin: null,
        trafficMax: null,
        rankMin: null,
        rankMax: null,
        spamMin: null,
        spamMax: null,
        sort: "traffic_desc",
        domainSearch: null,
        limit: 25,
      }),
      "cursor-2",
    ])
    expect(recommendationFeedStatusQueryKey(projectKey, "actor-a", 7)).toEqual([
      "backlinks",
      projectKey,
      "recommendation-feed",
      "actor-a",
      7,
      "status",
    ])
  })

  it("isolates identical project queries by actor scope", () => {
    const filters = { sort: "released_desc" } as const
    expect(
      recommendationFeedQueryKey(projectKey, "actor-a", 7, filters, null)
    ).not.toEqual(
      recommendationFeedQueryKey(projectKey, "actor-b", 7, filters, null)
    )
  })

  it("invalidates feed data without clearing opportunities, mail, links, or reports", async () => {
    const resources = [
      "recommendation-feed",
      "opportunities",
      "mail",
      "links",
      "reports",
    ] as const
    const calls = new Map<string, number>()

    for (const resource of resources) {
      await backlinksProjectQueries.fetch(
        createProjectQueryKey(projectKey, resource, "list"),
        async () => {
          calls.set(resource, (calls.get(resource) ?? 0) + 1)
          return resource
        }
      )
    }

    invalidateRecommendationFeed(projectKey)
    for (const resource of resources) {
      await backlinksProjectQueries.fetch(
        createProjectQueryKey(projectKey, resource, "list"),
        async () => {
          calls.set(resource, (calls.get(resource) ?? 0) + 1)
          return resource
        }
      )
    }

    expect(Object.fromEntries(calls)).toEqual({
      "recommendation-feed": 2,
      opportunities: 1,
      mail: 1,
      links: 1,
      reports: 1,
    })
  })

  it("invalidates only feed and opportunities after Opportunity creation", async () => {
    const resources = [
      "recommendation-feed",
      "opportunities",
      "mail",
      "links",
      "reports",
    ] as const
    const calls = new Map<string, number>()

    for (const resource of resources) {
      await backlinksProjectQueries.fetch(
        createProjectQueryKey(projectKey, resource, "list"),
        async () => {
          calls.set(resource, (calls.get(resource) ?? 0) + 1)
          return resource
        }
      )
    }

    invalidateRecommendationOpportunityCaches(projectKey)
    for (const resource of resources) {
      await backlinksProjectQueries.fetch(
        createProjectQueryKey(projectKey, resource, "list"),
        async () => {
          calls.set(resource, (calls.get(resource) ?? 0) + 1)
          return resource
        }
      )
    }

    expect(Object.fromEntries(calls)).toEqual({
      "recommendation-feed": 2,
      opportunities: 2,
      mail: 1,
      links: 1,
      reports: 1,
    })
  })
})
