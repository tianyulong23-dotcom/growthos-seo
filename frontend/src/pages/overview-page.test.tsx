import { cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Project } from "@/features/projects/types"
import { OverviewPage } from "@/pages/overview-page"

const project: Project = {
  id: "project-1",
  name: "Example",
  domain: "example.com",
  country: "US",
  language: "en",
  understandingRunId: "understanding-1",
  understandingStatus: "running",
  understandingStage: "discovering_pages",
  understandingMessage: "正在发现重要页面",
  understandingProgress: 35,
  understandingAttempt: 1,
  understandingStartedAt: "2026-07-23T00:00:00Z",
  understandingFinishedAt: null,
  understandingElapsedSeconds: 1,
  auditRunId: null,
  auditStatus: "never_started",
  auditHealth: null,
  siteProfile: null,
  createdAt: "2026-07-23",
}

vi.mock("@/features/projects/project-context", () => ({
  useProjects: () => ({
    getProject: () => project,
  }),
}))

vi.mock("@/components/shared/page-header", () => ({
  PageHeader: () => null,
}))

afterEach(() => {
  cleanup()
})

describe("OverviewPage", () => {
  it("does not present a technical audit as completed before the user starts it", () => {
    render(
      <MemoryRouter initialEntries={["/projects/project-1/overview"]}>
        <Routes>
          <Route
            path="/projects/:projectId/overview"
            element={<OverviewPage />}
          />
        </Routes>
      </MemoryRouter>
    )

    expect(screen.getByText("尚未开始网站审计")).toBeTruthy()
    expect(screen.queryByText("网站审计已完成")).toBeNull()
    expect(screen.queryByText("发现 29 个需要优先处理的问题")).toBeNull()
    expect(screen.queryByText("本周提升 4 分")).toBeNull()
  })
})
