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

const agentApi = vi.hoisted(() => ({
  cancelAgentRun: vi.fn(),
  createAgentConversation: vi.fn(),
  editAgentMessage: vi.fn(),
  getAgentConversation: vi.fn(),
  listAgentConversations: vi.fn(),
  rewindAgentConversation: vi.fn(),
  sendAgentMessage: vi.fn(),
  subscribeAgentConversation: vi.fn(),
  syncProjectOnboarding: vi.fn(),
}))

vi.mock("@/api/projects", () => projectApi)
vi.mock("@/api/agent", () => agentApi)

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

const conversation = {
  id: "conversation-1",
  projectId: "project-1",
  title: "网站初始化",
  createdAt: "2026-08-12T08:00:00Z",
  updatedAt: "2026-08-12T08:00:00Z",
}

function timelineEvent(
  eventKey: string,
  title: string,
  status: "running" | "waiting" | "completed" | "failed",
  content: string,
  sequence: number
) {
  return {
    id: `event-${sequence}`,
    eventKey,
    conversationId: conversation.id,
    sequence,
    kind: status === "waiting" ? ("action" as const) : ("task" as const),
    status,
    title,
    content,
    action:
      status === "waiting"
        ? {
            label: "确认业务资料",
            href: "/projects/project-1/settings/business",
          }
        : {},
    metadata: {
      source:
        status === "waiting" ? "site_profile" : "site_understanding",
    },
    createdAt: `2026-08-12T08:00:0${sequence}Z`,
    updatedAt: `2026-08-12T08:00:0${sequence}Z`,
  }
}

function agentDetail(timeline = [
  timelineEvent(
    "onboarding:site-entry:understanding-run",
    "检查网站入口",
    "running",
    "我正在检查首页、Sitemap 和导航结构，先确定从哪里理解这个网站。",
    1
  ),
]) {
  return {
    conversation,
    messages: [],
    timeline,
    run: null,
    action: null,
  }
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
  agentApi.listAgentConversations.mockResolvedValue([conversation])
  agentApi.getAgentConversation.mockResolvedValue(agentDetail())
  agentApi.syncProjectOnboarding.mockResolvedValue(undefined)
  agentApi.subscribeAgentConversation.mockReturnValue(() => undefined)
})

afterEach(() => {
  cleanup()
})

describe("BusinessProfileOnboardingController", () => {
  it("shows the concrete failure reason in the AI agent", async () => {
    projectApi.listProjects.mockResolvedValue([failedProject])
    agentApi.getAgentConversation.mockResolvedValue(
      agentDetail([
        timelineEvent(
          "onboarding:core-pages:understanding-run",
          "读取核心页面",
          "failed",
          "网站业务识别失败：未找到符合项目语言 pt-BR 的页面；网站返回的页面语言为 en-US",
          1
        ),
      ])
    )

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <ProjectProvider>
          <Routes>
            <Route path="/projects/:projectId/*" element={<AgentDock />} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText("读取核心页面")).toBeTruthy()
    expect(
      screen.getByText(
        "网站业务识别失败：未找到符合项目语言 pt-BR 的页面；网站返回的页面语言为 en-US"
      )
    ).toBeTruthy()
    expect(screen.queryByText("进行中")).toBeNull()
    expect(screen.queryByText("网站业务识别")).toBeNull()
  })

  it("retries failed website recognition from the AI agent", async () => {
    projectApi.listProjects.mockResolvedValue([failedProject])
    projectApi.refreshBusinessProfile.mockResolvedValue(rerunningProject)
    agentApi.getAgentConversation.mockResolvedValue(
      agentDetail([
        timelineEvent(
          "onboarding:core-pages:understanding-run",
          "读取核心页面",
          "failed",
          "这一步没有完成。",
          1
        ),
      ])
    )

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
    agentApi.getAgentConversation.mockResolvedValue(
      agentDetail([
        timelineEvent(
          "onboarding:core-pages:understanding-run",
          "读取核心页面",
          "failed",
          "这一步没有完成。",
          1
        ),
      ])
    )

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
    agentApi.getAgentConversation.mockResolvedValue(
      agentDetail([
        timelineEvent(
          "onboarding:core-pages:understanding-run",
          "读取核心页面",
          "completed",
          "网站的核心业务页面已经读取完成。",
          1
        ),
        timelineEvent(
          "onboarding:business-understanding:understanding-run",
          "理解业务",
          "running",
          "网站结构已经清楚了。现在我正在判断它提供什么、服务谁，以及客户为什么选择它。",
          2
        ),
      ])
    )

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <ProjectProvider>
          <Routes>
            <Route path="/projects/:projectId/*" element={<AgentDock />} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText("理解业务")).toBeTruthy()
    expect(screen.getByText(/网站结构已经清楚了/)).toBeTruthy()
    expect(screen.queryByText("生成业务资料")).toBeNull()
    expect(screen.queryByText("整理目标客户")).toBeNull()
    expect(screen.queryByText("整理产品与服务")).toBeNull()
  })

  it("shows backend progress while re-identifying an existing profile", async () => {
    projectApi.listProjects.mockResolvedValue([rerunningProject])
    agentApi.getAgentConversation.mockResolvedValue(
      agentDetail([
        timelineEvent(
          "onboarding:site-entry:understanding-run-2",
          "检查网站入口",
          "completed",
          "网站入口已经确认。现在继续寻找最能代表业务的页面。",
          1
        ),
        timelineEvent(
          "onboarding:page-discovery:understanding-run-2",
          "寻找核心页面",
          "running",
          "我正在从站内页面中寻找产品、服务、定价和关于页面。",
          2
        ),
      ])
    )

    render(
      <MemoryRouter initialEntries={["/projects/project-1/audit/overview"]}>
        <ProjectProvider>
          <Routes>
            <Route path="/projects/:projectId/*" element={<AgentDock />} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText("寻找核心页面")).toBeTruthy()
    expect(screen.getByText(/我正在从站内页面中寻找/)).toBeTruthy()
    expect(screen.getByText("进行中")).toBeTruthy()
  })

  it("treats partial recognition as usable instead of failed", async () => {
    projectApi.listProjects.mockResolvedValue([partialProject])
    agentApi.getAgentConversation.mockResolvedValue(
      agentDetail([
        timelineEvent(
          "onboarding:business-understanding:understanding-run",
          "理解业务",
          "completed",
          "这是我目前对 Example 的理解。",
          1
        ),
        timelineEvent(
          "onboarding:business-confirmation",
          "确认业务资料",
          "waiting",
          "业务判断已经整理好。请确认是否准确。",
          2
        ),
      ])
    )

    render(
      <MemoryRouter initialEntries={["/projects/project-1/settings/business"]}>
        <ProjectProvider>
          <Routes>
            <Route path="/projects/:projectId/*" element={<AgentDock />} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>
    )

    expect(await screen.findByText("理解业务")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "确认业务资料" })
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "重新识别" })).toBeNull()
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
    expect(await screen.findByText("检查网站入口")).toBeTruthy()
    expect(screen.queryByText("网站业务识别")).toBeNull()
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
