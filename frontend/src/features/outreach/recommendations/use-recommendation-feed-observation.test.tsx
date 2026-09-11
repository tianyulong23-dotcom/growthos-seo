import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { observeRecommendationFeed, type RecommendationFeedResponse } from "./recommendation-feed-api"
import { useRecommendationFeedObservation } from "./use-recommendation-feed-observation"

vi.mock("./recommendation-feed-api", () => ({
  observeRecommendationFeed: vi.fn().mockResolvedValue({ recorded: true }),
}))

const generation: RecommendationFeedResponse["latestGeneration"] = {
  generationContractId: "66666666-6666-4666-8666-666666666666",
  visiblePoolGeneration: 1,
  jobState: "RUNNING",
  progress: 40,
  discoveryResult: "IN_PROGRESS",
  contactPreparation: "PENDING",
  releaseResult: "PENDING",
  effectiveUniqueCandidateCount: 0,
  admittedCount: 0,
  releasedCount: 0,
  terminalReason: null,
  retrySafe: false,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("recommendation feed observation", () => {
  it("records visible states once across polling rerenders and follows project scope", async () => {
    const { rerender, unmount } = renderHook(
      ({ project, value }) => useRecommendationFeedObservation(project, value),
      { initialProps: { project: "a", value: generation } }
    )
    await waitFor(() => expect(observeRecommendationFeed).toHaveBeenCalledTimes(1))
    rerender({ project: "a", value: { ...generation, progress: 41 } })
    expect(observeRecommendationFeed).toHaveBeenCalledTimes(1)
    rerender({ project: "b", value: generation })
    await waitFor(() => expect(observeRecommendationFeed).toHaveBeenCalledTimes(2))
    expect(vi.mocked(observeRecommendationFeed).mock.calls[1][0]).toBe("b")
    unmount()
    expect(vi.mocked(observeRecommendationFeed).mock.calls[1][2].aborted).toBe(true)
  })

  it("does not report background rendering as a visible observation", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    renderHook(() => useRecommendationFeedObservation("a", generation))
    expect(observeRecommendationFeed).not.toHaveBeenCalled()
    visibility.mockReturnValue("visible")
    act(() => document.dispatchEvent(new Event("visibilitychange")))
    await waitFor(() => expect(observeRecommendationFeed).toHaveBeenCalledTimes(1))
    expect(vi.mocked(observeRecommendationFeed).mock.calls[0][1]).toMatchObject({
      generationContractId: generation.generationContractId,
      observedState: "RUNNING|IN_PROGRESS|PENDING|PENDING",
    })
  })

  it("does not fabricate observations without a generation", () => {
    renderHook(() => useRecommendationFeedObservation("a", null))
    expect(observeRecommendationFeed).not.toHaveBeenCalled()
  })
})
