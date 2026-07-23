import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CreateProjectDialog } from "@/features/projects/create-project-dialog"
import type { Project } from "@/features/projects/types"

const projectContext = vi.hoisted(() => ({
  createProject: vi.fn(),
}))

vi.mock("@/features/projects/project-context", () => ({
  useProjects: () => ({
    projects: [],
    createProject: projectContext.createProject,
  }),
}))

const createdProject: Project = {
  id: "project-new",
  name: "Example",
  domain: "example.com",
  country: "US",
  language: "en",
  understandingRunId: "understanding-run",
  understandingStatus: "queued",
  understandingStage: "queued",
  understandingMessage: "网站业务识别任务已进入队列",
  understandingProgress: 0,
  understandingAttempt: 1,
  understandingStartedAt: null,
  understandingFinishedAt: null,
  understandingElapsedSeconds: 0,
  auditRunId: null,
  auditStatus: "never_started",
  auditHealth: null,
  siteProfile: null,
  createdAt: "2026-07-22T00:00:00Z",
}

function Destination() {
  const location = useLocation()
  const waitForBusinessProfile = Boolean(
    (location.state as { waitForBusinessProfile?: boolean } | null)
      ?.waitForBusinessProfile
  )

  return (
    <div>
      <span>{location.pathname}</span>
      <span>{waitForBusinessProfile ? "等待业务资料" : "普通导航"}</span>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  projectContext.createProject.mockResolvedValue(createdProject)
})

afterEach(() => {
  cleanup()
})

describe("CreateProjectDialog", () => {
  it("enters the project immediately and leaves business identification to the project flow", async () => {
    const onOpenChange = vi.fn()

    render(
      <MemoryRouter initialEntries={["/projects"]}>
        <Routes>
          <Route
            path="/projects"
            element={<CreateProjectDialog open onOpenChange={onOpenChange} />}
          />
          <Route
            path="/projects/:projectId/overview"
            element={<Destination />}
          />
        </Routes>
      </MemoryRouter>
    )

    fireEvent.change(screen.getByPlaceholderText("example.com"), {
      target: { value: "www.example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }))

    await waitFor(() => {
      expect(projectContext.createProject).toHaveBeenCalledWith({
        domain: "example.com",
        country: "US",
        language: "en",
      })
    })

    expect(
      await screen.findByText("/projects/project-new/overview")
    ).toBeTruthy()
    expect(screen.getByText("等待业务资料")).toBeTruthy()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(
      window.sessionStorage.getItem(
        "seo:business-profile-onboarding:project-new"
      )
    ).toBe("pending")
    expect(screen.queryByText("确认业务资料")).toBeNull()
    expect(screen.queryByText("正在识别网站业务")).toBeNull()
  })
})
