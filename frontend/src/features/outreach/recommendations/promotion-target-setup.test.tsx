import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  confirmPromotionTarget,
  getProjectOutreachReadiness,
} from "@/api/projects"
import type { OutreachProject } from "@/features/outreach/project"
import type {
  ProjectOutreachReadinessState,
  PromotionTargetVersion,
} from "@/features/projects/types"

import { getRecommendationInventory } from "./api"
import { RecommendationProjectGate } from "./promotion-target-setup"

vi.mock("@/api/projects", () => ({
  confirmPromotionTarget: vi.fn(),
  getProjectOutreachReadiness: vi.fn(),
}))

vi.mock("./api", () => ({
  getRecommendationInventory: vi.fn(),
}))

const getReadiness = vi.mocked(getProjectOutreachReadiness)
const confirmTarget = vi.mocked(confirmPromotionTarget)
const getInventory = vi.mocked(getRecommendationInventory)

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
  vi.clearAllMocks()
})

describe("RecommendationProjectGate", () => {
  it("collects promotion inputs before mounting the recommendation workspace", async () => {
    getReadiness
      .mockResolvedValueOnce(readiness())
      .mockResolvedValueOnce(
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
            <div>
              推荐池已接通：{readyProject.targetUrls.join(",")}
            </div>
          )}
        </RecommendationProjectGate>
      </MemoryRouter>
    )

    expect(await screen.findByText("设置本次外链推广目标")).toBeTruthy()
    expect(getInventory).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "保存并生成推荐" }))

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
    fireEvent.click(screen.getByRole("button", { name: "保存并生成推荐" }))

    expect(
      await screen.findByText("请至少填写一个推广主题或一个推广目标页。")
    ).toBeTruthy()
    expect(confirmTarget).not.toHaveBeenCalled()
    expect(getInventory).not.toHaveBeenCalled()
  })
})
