import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AgentDock } from "@/components/agent/agent-dock"
import { BusinessProfileOnboardingController } from "@/features/projects/business-profile-onboarding"
import { ProjectProvider } from "@/features/projects/project-context"
import type { Project, SiteProfile } from "@/features/projects/types"

const projectApi = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getProject: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  refreshBusinessProfile: vi.fn(),
  updateBusinessProfile: vi.fn(),
}))

vi.mock("@/api/projects", () => projectApi)

const siteProfile: SiteProfile = {
  profileVersion: 1,
  extractionMethod: "crawler",
  sourcePageCount: 5,
  faviconUrl: "",
  businessName: "Example",
  businessType: "Software",
  businessSummary: "Example business",
  productsServices: ["SEO software"],
  targetAudiences: ["Marketing teams"],
  valuePropositions: ["Clear workflows"],
  useCases: [],
  targetMarkets: ["US"],
  languages: ["en"],
  contentTopics: [],
  conversionActions: [],
  keyPages: [],
  evidence: [],
  userOverriddenFields: [],
  confidence: 0.9,
  aiContentRules: "",
  confirmedAt: null,
}

const queuedProject: Project = {
  id: "project-1",
  name: "Example",
  domain: "example.com",
  country: "US",
  language: "en",
  competitorDomain: null,
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

const runningProject: Project = {
  ...queuedProject,
  understandingStatus: "running",
  understandingStage: "extracting_pages",
  understandingMessage: "正在整理重要页面",
  understandingProgress: 62,
}

const completedProject: Project = {
  ...runningProject,
  name: "Example",
  understandingStatus: "completed",
  understandingStage: "completed",
  understandingMessage: "网站资料整理完成",
  understandingProgress: 100,
  siteProfile,
}

const generatingProfileProject: Project = {
  ...runningProject,
  understandingStage: "completed",
  understandingMessage: "网站资料整理完成",
  understandingProgress: 99,
}

const failedProject: Project = {
  ...runningProject,
  understandingStatus: "failed",
  understandingStage: "failed",
  understandingMessage:
    "网站业务识别失败：未找到符合项目语言 pt-BR 的页面；网站返回的页面语言为 en-US",
  understandingProgress: 20,
}

const partialProject: Project = {
  ...completedProject,
  understandingStatus: "partial",
  understandingMessage: "业务资料已生成，但部分页面证据不足，请检查后使用",
}

const rerunningProject: Project = {
  ...completedProject,
  understandingRunId: "understanding-run-2",
  understandingStatus: "running",
  understandingStage: "discovering_pages",
  understandingMessage: "正在读取 Sitemap 和导航链接",
  understandingProgress: 28,
}

function RouteState() {
  const location = useLocation()
  return <div data-testid="current-path">{location.pathname}</div>
}

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  projectApi.listProjects.mockResolvedValue([queuedProject])
  projectApi.getProject
    .mockResolvedValueOnce(runningProject)
    .mockResolvedValueOnce(completedProject)
})

afterEach(() => {
  cleanup()
})

describe("BusinessProfileOnboardingController", () => {
  it("shows the concrete failure reason in the AI agent", async () => {
    projectApi.listProjects.mockResolvedValue([failedProject])

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <ProjectProvider>
          <Routes>
            <Route path="/projects/:projectId/*" element={<AgentDock />} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText("失败原因")).toBeTruthy()
    expect(
      screen.getByText(
        "网站业务识别失败：未找到符合项目语言 pt-BR 的页面；网站返回的页面语言为 en-US"
      )
    ).toBeTruthy()
    expect(screen.queryByText("进行中")).toBeNull()
  })

  it("retries failed website recognition from the AI agent", async () => {
    projectApi.listProjects.mockResolvedValue([failedProject])
    projectApi.refreshBusinessProfile.mockResolvedValue(rerunningProject)

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <ProjectProvider>
          <Routes>
            <Route path="/projects/:projectId/*" element={<AgentDock />} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    const retry = await screen.findByRole("button", { name: "重新识别" })
    retry.click()

    await waitFor(() => {
      expect(projectApi.refreshBusinessProfile).toHaveBeenCalledWith(
        "project-1"
      )
    })
  })

  it("keeps polling after a retry started outside project onboarding", async () => {
    projectApi.listProjects.mockResolvedValue([failedProject])
    projectApi.refreshBusinessProfile.mockResolvedValue(rerunningProject)
    projectApi.getProject.mockReset().mockResolvedValue(completedProject)

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <ProjectProvider>
          <Routes>
            <Route path="/projects/:projectId/*" element={<AgentDock />} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    const retry = await screen.findByRole("button", { name: "重新识别" })
    retry.click()

    await waitFor(
      () => {
        expect(projectApi.getProject).toHaveBeenCalledWith("project-1")
        expect(screen.queryByText("网站业务识别")).toBeNull()
      },
      { timeout: 2500 }
    )
  })

  it("shows the real profile-generation stage after crawling finishes", async () => {
    projectApi.listProjects.mockResolvedValue([generatingProfileProject])

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <ProjectProvider>
          <Routes>
            <Route path="/projects/:projectId/*" element={<AgentDock />} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText("生成业务资料")).toBeTruthy()
    expect(screen.queryByText("整理目标客户")).toBeNull()
    expect(screen.queryByText("整理产品与服务")).toBeNull()
  })

  it("shows backend progress while re-identifying an existing profile", async () => {
    projectApi.listProjects.mockResolvedValue([rerunningProject])

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <ProjectProvider>
          <Routes>
            <Route path="/projects/:projectId/*" element={<AgentDock />} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText("正在读取 Sitemap 和导航链接")).toBeTruthy()
    expect(screen.getByText("进行中")).toBeTruthy()
  })

  it("treats partial recognition as usable instead of failed", async () => {
    projectApi.listProjects.mockResolvedValue([partialProject])

    render(
      <MemoryRouter initialEntries={["/projects/project-1/settings/business"]}>
        <ProjectProvider>
          <Routes>
            <Route path="/projects/:projectId/*" element={<AgentDock />} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText("部分完成")).toBeTruthy()
    expect(
      screen.getByText("业务资料已生成，但部分页面证据不足，请检查后使用")
    ).toBeTruthy()
    expect(screen.queryByText("失败原因")).toBeNull()
  })

  it("shows business progress and redirects only after the profile is generated", async () => {
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/projects/project-1/audit/overview",
            state: { waitForBusinessProfile: true },
          },
        ]}
      >
        <ProjectProvider>
          <Routes>
            <Route
              path="/projects/:projectId/*"
              element={
                <>
                  <BusinessProfileOnboardingController />
                  <AgentDock />
                  <RouteState />
                </>
              }
            />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    expect(screen.getByTestId("current-path").textContent).toBe(
      "/projects/project-1/audit/overview"
    )
    expect(await screen.findByText("网站业务识别")).toBeTruthy()
    expect(screen.getByText("项目创建完成")).toBeTruthy()
    expect(screen.queryByText("优先问题分析")).toBeNull()

    await waitFor(
      () => {
        expect(projectApi.getProject).toHaveBeenCalledTimes(2)
        expect(screen.getByTestId("current-path").textContent).toBe(
          "/projects/project-1/settings/business"
        )
      },
      { timeout: 4000 }
    )

    expect(
      window.sessionStorage.getItem("seo:business-profile-onboarding:project-1")
    ).toBeNull()
  })
})
