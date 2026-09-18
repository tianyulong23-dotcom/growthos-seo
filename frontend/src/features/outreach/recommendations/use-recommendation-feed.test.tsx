import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { backlinksProjectQueries } from "@/features/outreach/api/project-query"

import {
  listRecommendationFeed,
  type RecommendationFeedResponse,
} from "./recommendation-feed-api"
import { useRecommendationFeed } from "./use-recommendation-feed"

vi.mock("./recommendation-feed-api", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./recommendation-feed-api")>()
  return {
    ...original,
    listRecommendationFeed: vi.fn(),
  }
})

const listMock = vi.mocked(listRecommendationFeed)
const filters = { sort: "released_desc" } as const

function feed(domain: string, requestId: string): RecommendationFeedResponse {
  return {
    items: [
      {
        itemId: "00000000-0000-4000-8000-000000000001",
        domain,
        displayUrl: `https://${domain}/`,
        recommended: true,
        reasons: ["Relevant audience"],
        category: "Editorial",
        metrics: {
          targetMarketOrganicTraffic: null,
          dataForSeoRank: null,
          spamScore: null,
        },
        contact: {
          email: null,
          contactPage: `https://${domain}/contact`,
          outcome: "CONTACT_PAGE_FOUND",
        },
        opportunity: {
          opportunityId: null,
          businessStage: null,
          managementStatus: null,
          outcomeStatus: null,
          createdByCurrentUser: false,
        },
        archived: false,
        releasedAt: "2026-08-31T00:00:00.000Z",
      },
    ],
    releasedPool: {
      generationCount: 1,
      oldestVisiblePoolGeneration: 1,
      newestVisiblePoolGeneration: 1,
    },
    latestGeneration: {
      generationContractId: "00000000-0000-4000-8000-000000000002",
      visiblePoolGeneration: 1,
      jobState: "SUCCESS",
      progress: 100,
      discoveryResult: "COMPLETED",
      contactPreparation: "COMPLETED",
      releaseResult: "COMPLETED",
      effectiveUniqueCandidateCount: 1,
      admittedCount: 1,
      releasedCount: 1,
      terminalReason: null,
      retrySafe: false,
    },
    totalCount: 1,
    nextCursor: null,
    meta: {
      organizationId: "organization-1",
      workspaceId: "workspace-1",
      websiteProjectId: "project-1",
      requestId,
      schemaVersion: "backlinks.recommendation-feed.v2",
      generatedAt: "2026-08-31T00:00:00.000Z",
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  listMock.mockReset()
  backlinksProjectQueries.invalidateProject("project-a")
  backlinksProjectQueries.invalidateProject("project-b")
})

describe("useRecommendationFeed", () => {
  it("never exposes the previous project's progress while loading or on failure", async () => {
    const next = deferred<RecommendationFeedResponse>()
    listMock
      .mockResolvedValueOnce(feed("project-a.example", "a"))
      .mockReturnValueOnce(next.promise)
    const hook = renderHook(
      ({ project }) =>
        useRecommendationFeed(
          project,
          "actor-session-a",
          1,
          filters,
          null,
          true
        ),
      { initialProps: { project: "project-a" } }
    )
    await waitFor(() => expect(hook.result.current.response).not.toBeNull())
    hook.rerender({ project: "project-b" })
    expect(hook.result.current.response).toBeNull()
    expect(hook.result.current.state).toBe("loading")
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))
    await act(async () => {
      next.resolve(feed("project-b.example", "b"))
    })
    expect(hook.result.current.response?.items[0].domain).toBe(
      "project-b.example"
    )
    listMock.mockRejectedValueOnce(new Error("offline"))
    hook.rerender({ project: "project-a" })
    await waitFor(() => expect(hook.result.current.state).toBe("error"))
    expect(hook.result.current.response).toBeNull()
  })

  it("retains running progress on a transient poll failure and recovers", async () => {
    const running = feed("running.example", "running")
    running.latestGeneration!.jobState = "RUNNING"
    listMock
      .mockResolvedValueOnce(running)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(feed("completed.example", "completed"))
    const hook = renderHook(() =>
      useRecommendationFeed(
        "project-a",
        "actor-session-a",
        1,
        filters,
        null,
        true
      )
    )
    await waitFor(() => expect(hook.result.current.response).toEqual(running))
    await act(async () => {
      await hook.result.current.poll()
    })
    expect(hook.result.current.response?.latestGeneration?.jobState).toBe(
      "RUNNING"
    )
    expect(hook.result.current.state).toBe("error")
    await act(async () => {
      await hook.result.current.poll()
    })
    expect(hook.result.current.response?.items[0].domain).toBe(
      "completed.example"
    )
  })

  it("rejects a late response from a superseded project context", async () => {
    const oldRequest = deferred<RecommendationFeedResponse>()
    const currentRequest = deferred<RecommendationFeedResponse>()
    listMock
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)

    const hook = renderHook(
      ({ contextVersion }) =>
        useRecommendationFeed(
          "project-a",
          "actor-session-a",
          contextVersion,
          filters,
          null,
          true
        ),
      { initialProps: { contextVersion: 1 } }
    )

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1))
    hook.rerender({ contextVersion: 2 })
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))

    await act(async () => {
      oldRequest.resolve(feed("stale.example", "request-old"))
      currentRequest.resolve(feed("current.example", "request-current"))
      await Promise.all([oldRequest.promise, currentRequest.promise])
    })

    await waitFor(() =>
      expect(hook.result.current.response?.items[0]?.domain).toBe(
        "current.example"
      )
    )
  })

  it("restores from the server after a route remount", async () => {
    listMock
      .mockResolvedValueOnce(feed("first.example", "request-1"))
      .mockResolvedValueOnce(feed("restored.example", "request-2"))

    const first = renderHook(() =>
      useRecommendationFeed(
        "project-a",
        "actor-session-a",
        3,
        filters,
        null,
        true
      )
    )
    await waitFor(() =>
      expect(first.result.current.response?.items[0]?.domain).toBe(
        "first.example"
      )
    )
    first.unmount()

    const restored = renderHook(() =>
      useRecommendationFeed(
        "project-a",
        "actor-session-b",
        3,
        filters,
        null,
        true
      )
    )
    await waitFor(() =>
      expect(restored.result.current.response?.items[0]?.domain).toBe(
        "restored.example"
      )
    )
    expect(listMock).toHaveBeenCalledTimes(2)
  })
})
