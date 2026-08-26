import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { getProjectOutreachReadiness } from "@/api/projects"
import { ProjectOutreachReadiness } from "@/features/projects/project-outreach-readiness"
import type { ProjectOutreachReadinessState } from "@/features/projects/types"

vi.mock("@/api/projects", () => ({
  getProjectOutreachReadiness: vi.fn(),
}))

const getReadiness = vi.mocked(getProjectOutreachReadiness)

function readiness(
  overrides: Partial<ProjectOutreachReadinessState> = {}
): ProjectOutreachReadinessState {
  return {
    websiteProjectId: "project-1",
    status: "INPUT_REQUIRED",
    siteProfileVersionId: "profile-2",
    outreachProfileVersionId: "profile-2",
    promotionTargetVersionId: null,
    fingerprint: "sha256:input-required",
    inputRequired: ["WEBSITE_PROJECT:publish_promotion_target"],
    primaryRecoveryAction: "PUBLISH_PROMOTION_TARGET",
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("ProjectOutreachReadiness", () => {
  it("shows missing evidence and the primary recovery action", async () => {
    getReadiness.mockResolvedValue(readiness())

    render(
      <MemoryRouter>
        <ProjectOutreachReadiness projectId="project-1" />
      </MemoryRouter>
    )

    expect(await screen.findByText("需要补充")).toBeTruthy()
    expect(screen.getByText("缺少推广主题或已发布目标页")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "前往准备推广主题" })
    ).toBeTruthy()
  })

  it("does not expose a late response from the previously selected project", async () => {
    let resolveProjectOne: (
      value: ProjectOutreachReadinessState
    ) => void = () => undefined
    let resolveProjectTwo: (
      value: ProjectOutreachReadinessState
    ) => void = () => undefined
    getReadiness.mockImplementation(
      (projectId) =>
        new Promise((resolve) => {
          if (projectId === "project-1") {
            resolveProjectOne = resolve
          } else {
            resolveProjectTwo = resolve
          }
        })
    )

    const view = render(
      <MemoryRouter>
        <ProjectOutreachReadiness projectId="project-1" />
      </MemoryRouter>
    )
    view.rerender(
      <MemoryRouter>
        <ProjectOutreachReadiness projectId="project-2" />
      </MemoryRouter>
    )

    resolveProjectOne(
      readiness({
        websiteProjectId: "project-1",
        promotionTargetVersionId: "target-project-1",
      })
    )
    await Promise.resolve()
    expect(screen.queryByText("target-project-1")).toBeNull()

    resolveProjectTwo(
      readiness({
        websiteProjectId: "project-2",
        status: "READY",
        promotionTargetVersionId: "target-project-2",
        fingerprint: "sha256:ready",
        inputRequired: [],
        primaryRecoveryAction: "OPEN_RECOMMENDATIONS",
      })
    )

    await waitFor(() => {
      expect(screen.getByText("target-project-2")).toBeTruthy()
    })
    expect(screen.getByText("已就绪")).toBeTruthy()
  })
})
