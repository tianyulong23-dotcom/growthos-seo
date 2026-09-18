import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import {
  confirmPromotionTarget,
  getProjectOutreachReadiness,
} from "@/api/projects"
import type { OutreachProject } from "@/features/outreach/project"
import type {
  ProjectOutreachReadinessState,
  PromotionTargetVersion,
} from "@/features/projects/types"

import { getRecommendationFeedStatus } from "./recommendation-feed-api"
import { RecommendationProjectGate } from "./promotion-target-setup"

vi.mock("@/api/projects", () => ({
  confirmPromotionTarget: vi.fn(),
  getProjectOutreachReadiness: vi.fn(),
}))

vi.mock("./recommendation-feed-api", () => ({
  getRecommendationFeedStatus: vi.fn(),
}))

const getReadiness = vi.mocked(getProjectOutreachReadiness)
const confirmTarget = vi.mocked(confirmPromotionTarget)
const getInventory = vi.mocked(getRecommendationFeedStatus)

const project: OutreachProject = {
  id: "project-1",
  name: "Example",
  domain: "example.com",
  language: "en",
  contextVersion: 4,
  targetUrls: [],
  suggestedTopics: ["projector reviews"],
  suggestedTargetUrls: ["https://example.com/products/projector"],
  profileVersion: 2,
  inputRequired: [],
}

function readiness(
  overrides: Partial<ProjectOutreachReadinessState> = {}
): ProjectOutreachReadinessState {
  return {
    websiteProjectId: "project-1",
    status: "INPUT_REQUIRED",
    siteProfileVersionId: "profile-v4",
    outreachProfileVersionId: "profile-v4",
    promotionTargetVersionId: null,
    fingerprint: "sha256:input-required",
    inputRequired: ["WEBSITE_PROJECT:publish_promotion_target"],
    primaryRecoveryAction: "PUBLISH_PROMOTION_TARGET",
    ...overrides,
  }
}

const confirmedTarget: PromotionTargetVersion = {
  id: "target-5",
  projectId: "project-1",
  version: 5,
  keywords: ["projector reviews"],
  targetUrls: ["https://example.com/products/projector"],
  targetAudiences: [],
  partnershipGoals: [],
  inputRequired: [],
  sourceKeywordIds: [],
  sourcePublishedTargetIds: [],
  sourceSiteProfileVersionId: "profile-v4",
  createdAt: "2026-08-25T08:00:00Z",
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("RecommendationProjectGate", () => {
  it("automatically leaves an open setup form after Agent confirmation", async () => {
    vi.useFakeTimers()
    getReadiness.mockResolvedValue(readiness())
    getInventory.mockResolvedValue({} as never)
    render(
      <MemoryRouter>
        <RecommendationProjectGate project={project}>
          {() => <div>V2 pool</div>}
        </RecommendationProjectGate>
      </MemoryRouter>
    )
    await act(async () => {})
    expect(screen.getByText("设置本次外链推广目标")).toBeTruthy()
    getReadiness.mockResolvedValue(readiness({
      status: "READY", fingerprint: "agent-confirmed",
      promotionTargetVersionId: "target-5", inputRequired: [],
      primaryRecoveryAction: "OPEN_RECOMMENDATIONS",
    }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByText("V2 pool")).toBeTruthy()
    expect(screen.queryByText("设置本次外链推广目标")).toBeNull()
    expect(confirmTarget).not.toHaveBeenCalled()
    const calls = getReadiness.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(getReadiness).toHaveBeenCalledTimes(calls)
  })

  it("rechecks on focus without overwriting an unsubmitted form", async () => {
    getReadiness.mockResolvedValue(readiness())
    const view = render(
      <MemoryRouter>
        <RecommendationProjectGate project={project}>
          {() => <div>V2 pool</div>}
        </RecommendationProjectGate>
      </MemoryRouter>
    )
    await screen.findByText("设置本次外链推广目标")
    const input = screen.getByDisplayValue("projector reviews")
    fireEvent.change(input, { target: { value: "edited topic" } })
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(getReadiness).toHaveBeenCalledTimes(2))
    expect(screen.getByDisplayValue("edited topic")).toBeTruthy()
    expect(confirmTarget).not.toHaveBeenCalled()
    view.unmount()
    fireEvent(window, new Event("focus"))
    expect(getReadiness).toHaveBeenCalledTimes(2)
  })

  it("pauses hidden-page polling and rechecks when visible again", async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, "visibilityState", "get")
    visibility.mockReturnValue("visible")
    getReadiness.mockResolvedValue(readiness())
    getInventory.mockResolvedValue({} as never)
    const view = render(
      <MemoryRouter>
        <RecommendationProjectGate project={project}>
          {() => <div>V2 pool</div>}
        </RecommendationProjectGate>
      </MemoryRouter>
    )
    await act(async () => {})
    visibility.mockReturnValue("hidden")
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(getReadiness).toHaveBeenCalledTimes(1)
    getReadiness.mockResolvedValue(readiness({
      status: "READY", fingerprint: "agent-confirmed",
      inputRequired: [], primaryRecoveryAction: "OPEN_RECOMMENDATIONS",
    }))
    visibility.mockReturnValue("visible")
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(screen.getByText("V2 pool")).toBeTruthy()
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(getReadiness).toHaveBeenCalledTimes(2)
    expect(confirmTarget).not.toHaveBeenCalled()
  })

  it("explains archived projects without requesting a feed or editing their data", async () => {
    getReadiness.mockResolvedValueOnce(readiness({
      primaryRecoveryAction: "RESTORE_PROJECT",
      inputRequired: ["PROJECTS:restore_project"],
    }))
    render(
      <MemoryRouter>
        <RecommendationProjectGate project={project}>
          {() => <div>V2 pool</div>}
        </RecommendationProjectGate>
      </MemoryRouter>
    )
    expect(await screen.findByText("项目已归档")).toBeTruthy()
    expect(screen.queryByText("设置本次外链推广目标")).toBeNull()
    expect(getInventory).not.toHaveBeenCalled()
    expect(confirmTarget).not.toHaveBeenCalled()
  })

  it("keeps the pool unmounted until the V2 context has synchronized", async () => {
    getReadiness.mockResolvedValue(
      readiness({
        status: "READY",
        inputRequired: [],
        primaryRecoveryAction: "OPEN_RECOMMENDATIONS",
      })
    )
    getInventory
      .mockRejectedValueOnce(new ApiError(404, "Not yet projected"))
      .mockResolvedValueOnce({} as never)
    const child = vi.fn(() => <div>V2 pool</div>)
    render(
      <MemoryRouter>
        <RecommendationProjectGate project={project}>
          {child}
        </RecommendationProjectGate>
      </MemoryRouter>
    )
    await waitFor(() => expect(getInventory).toHaveBeenCalledTimes(1))
    expect(child).not.toHaveBeenCalled()
    expect(
      await screen.findByText("V2 pool", {}, { timeout: 3000 })
    ).toBeTruthy()
    expect(getInventory).toHaveBeenCalledTimes(2)
    expect(confirmTarget).not.toHaveBeenCalled()
  })

  it("does not treat a readiness request failure as missing promotion inputs", async () => {
    getReadiness.mockRejectedValueOnce(new Error("Service unavailable"))
    render(
      <MemoryRouter>
        <RecommendationProjectGate project={project}>
          {() => <div>V2 pool</div>}
        </RecommendationProjectGate>
      </MemoryRouter>
    )
    expect(await screen.findByText("无法读取外链准备状态")).toBeTruthy()
    expect(screen.queryByText("设置本次外链推广目标")).toBeNull()
    expect(getInventory).not.toHaveBeenCalled()
  })

  it("rejects readiness belonging to another project", async () => {
    getReadiness.mockResolvedValueOnce(
      readiness({
        websiteProjectId: "other-project",
        status: "READY",
      })
    )
    render(
      <MemoryRouter>
        <RecommendationProjectGate project={project}>
          {() => <div>V2 pool</div>}
        </RecommendationProjectGate>
      </MemoryRouter>
    )
    expect(await screen.findByText("项目状态不匹配，请重新读取。")).toBeTruthy()
    expect(getInventory).not.toHaveBeenCalled()
  })

  it("collects promotion inputs before mounting the recommendation workspace", async () => {
    getReadiness.mockResolvedValueOnce(readiness()).mockResolvedValueOnce(
      readiness({
        status: "READY",
        promotionTargetVersionId: "target-5",
        fingerprint: "sha256:ready",
        inputRequired: [],
        primaryRecoveryAction: "OPEN_RECOMMENDATIONS",
      })
    )
    confirmTarget.mockResolvedValue(confirmedTarget)
    getInventory.mockResolvedValue({} as never)

    render(
      <MemoryRouter>
        <RecommendationProjectGate project={project}>
          {(readyProject) => (
            <div>推荐池已接通：{readyProject.targetUrls.join(",")}</div>
          )}
        </RecommendationProjectGate>
      </MemoryRouter>
    )

    expect(await screen.findByText("设置本次外链推广目标")).toBeTruthy()
    expect(getInventory).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "确认并进入推荐池" }))

    await waitFor(() => {
      expect(confirmTarget).toHaveBeenCalledWith("project-1", {
        confirmedTopics: ["projector reviews"],
        confirmedTargetUrls: ["https://example.com/products/projector"],
        expectedProjectContextVersion: 4,
        expectedSiteProfileVersionId: "profile-v4",
      })
    })
    expect(
      await screen.findByText(
        "推荐池已接通：https://example.com/products/projector"
      )
    ).toBeTruthy()
    expect(getInventory).toHaveBeenCalledTimes(1)
  })

  it("splits explicitly delimited promotion topics without breaking phrases", async () => {
    getReadiness.mockResolvedValueOnce(readiness()).mockResolvedValueOnce(
      readiness({
        status: "READY",
        promotionTargetVersionId: "target-5",
        fingerprint: "sha256:ready",
        inputRequired: [],
        primaryRecoveryAction: "OPEN_RECOMMENDATIONS",
      })
    )
    confirmTarget.mockResolvedValue(confirmedTarget)
    getInventory.mockResolvedValue({} as never)

    render(
      <MemoryRouter>
        <RecommendationProjectGate project={project}>
          {() => <div>推荐池已接通</div>}
        </RecommendationProjectGate>
      </MemoryRouter>
    )

    const topicInput = await screen.findByLabelText("推广关键词或主题")
    fireEvent.change(topicInput, {
      target: {
        value:
          "finest mulberry silk, luxe pajamas；loungewear\nfinest mulberry silk",
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "确认并进入推荐池" }))

    await waitFor(() => {
      expect(confirmTarget).toHaveBeenCalledWith("project-1", {
        confirmedTopics: ["finest mulberry silk", "luxe pajamas", "loungewear"],
        confirmedTargetUrls: ["https://example.com/products/projector"],
        expectedProjectContextVersion: 4,
        expectedSiteProfileVersionId: "profile-v4",
      })
    })
  })

  it("shows a validation message instead of calling the API with empty input", async () => {
    getReadiness.mockResolvedValue(readiness())

    render(
      <MemoryRouter>
        <RecommendationProjectGate
          project={{
            ...project,
            suggestedTopics: [],
            suggestedTargetUrls: [],
          }}
        >
          {() => <div>ready</div>}
        </RecommendationProjectGate>
      </MemoryRouter>
    )

    expect(await screen.findByText("设置本次外链推广目标")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "确认并进入推荐池" }))

    expect(
      await screen.findByText("请至少填写一个推广主题或一个推广目标页。")
    ).toBeTruthy()
    expect(confirmTarget).not.toHaveBeenCalled()
    expect(getInventory).not.toHaveBeenCalled()
  })
})
