import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BusinessProfileForm } from "@/features/projects/business-profile-form"
import type { Project } from "@/features/projects/types"

const projectApi = vi.hoisted(() => ({
  listBusinessProfileRuns: vi.fn(),
}))

vi.mock("@/api/projects", () => projectApi)

const project: Project = {
  id: "project-1",
  name: "Example",
  domain: "example.com",
  country: "US",
  language: "en",
  understandingRunId: "understanding-1",
  understandingStatus: "completed",
  understandingStage: "completed",
  understandingMessage: "",
  understandingProgress: 100,
  understandingAttempt: 1,
  understandingStartedAt: "2026-07-23T08:00:00Z",
  understandingFinishedAt: "2026-07-23T08:00:12.34Z",
  understandingElapsedSeconds: 12.34,
  auditRunId: null,
  auditStatus: "never_started",
  auditHealth: null,
  siteProfile: {
    profileVersion: 1,
    extractionMethod: "rules",
    sourcePageCount: 3,
    faviconUrl: "https://example.com/favicon.ico",
    businessName: "Example Inc.",
    businessType: "SaaS",
    businessSummary: "Original summary",
    productsServices: ["Analytics"],
    targetAudiences: ["Teams"],
    valuePropositions: ["Fast setup"],
    useCases: [],
    targetMarkets: [],
    languages: ["en"],
    contentTopics: [],
    conversionActions: [],
    keyPages: [],
    evidence: [],
    userOverriddenFields: [],
    confidence: 0.8,
    aiContentRules: "Use a concise tone.",
    confirmedAt: null,
  },
  createdAt: "2026-07-22",
}

afterEach(() => {
  cleanup()
})

describe("BusinessProfileForm", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    projectApi.listBusinessProfileRuns.mockResolvedValue([])
  })

  it("submits all editable business fields", async () => {
    const onSave = vi.fn().mockResolvedValue(project)
    render(<BusinessProfileForm project={project} onSave={onSave} />)

    expect(screen.getByDisplayValue("Example Inc.")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("业务类型"), {
      target: { value: "Analytics SaaS" },
    })
    fireEvent.change(screen.getByLabelText("目标客户"), {
      target: { value: "Teams\nAgencies\nTeams" },
    })
    fireEvent.change(screen.getByLabelText("产品与服务"), {
      target: { value: "Analytics\nReporting" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }))

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        businessName: "Example Inc.",
        businessType: "Analytics SaaS",
        businessSummary: "Original summary",
        targetAudiences: ["Teams", "Agencies"],
        productsServices: ["Analytics", "Reporting"],
        valuePropositions: ["Fast setup"],
        aiContentRules: "Use a concise tone.",
      })
    })
  })

  it("shows field ownership and grounded source quotes", () => {
    render(
      <BusinessProfileForm
        project={{
          ...project,
          siteProfile: {
            ...project.siteProfile!,
            userOverriddenFields: ["business_type"],
            evidence: [
              {
                field: "business_summary",
                value: "Example provides analytics.",
                sourceUrl: "https://example.com/about",
                quote: "Analytics for modern teams",
              },
              {
                field: "conversion_actions",
                value: "Start free",
                sourceUrl: "https://example.com/signup",
                quote: "Start free",
              },
            ],
          },
        }}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByText("人工确认")).toBeTruthy()
    expect(screen.getAllByText("AI 识别").length).toBeGreaterThan(0)
    expect(screen.getByText("转化动作")).toBeTruthy()
    expect(screen.queryByText("conversion_actions")).toBeNull()
    fireEvent.click(screen.getByText("Example provides analytics."))
    expect(screen.getByText("Analytics for modern teams")).toBeTruthy()
    expect(
      screen
        .getByRole("link", { name: /https:\/\/example.com\/about/ })
        .getAttribute("href")
    ).toBe("https://example.com/about")
  })

  it("starts website business recognition without submitting the form", async () => {
    const onSave = vi.fn().mockResolvedValue(project)
    const onRefresh = vi.fn().mockResolvedValue(project)
    render(
      <BusinessProfileForm
        project={project}
        onSave={onSave}
        onRefresh={onRefresh}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "重新识别" }))

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1)
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("shows a partial status and the concrete reason for usable fallback data", () => {
    render(
      <BusinessProfileForm
        project={{
          ...project,
          understandingStatus: "partial",
          understandingMessage:
            "AI 整理失败，已使用规则生成业务资料：模型请求超时",
        }}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByText("部分完成")).toBeTruthy()
    expect(
      screen.getByText("AI 整理失败，已使用规则生成业务资料：模型请求超时")
    ).toBeTruthy()
  })

  it("shows the latest website recognition history", async () => {
    projectApi.listBusinessProfileRuns.mockResolvedValueOnce([
      {
        runId: "run-2",
        attempt: 2,
        status: "failed",
        stage: "failed",
        message: "目标网站拒绝访问",
        progress: 20,
        startedAt: "2026-07-23T08:05:00Z",
        finishedAt: "2026-07-23T08:05:03Z",
        elapsedSeconds: 3,
        createdAt: "2026-07-23T08:05:00Z",
      },
      {
        runId: "run-1",
        attempt: 1,
        status: "completed",
        stage: "completed",
        message: "网站业务资料已生成",
        progress: 100,
        startedAt: "2026-07-23T08:00:00Z",
        finishedAt: "2026-07-23T08:00:12Z",
        elapsedSeconds: 12,
        createdAt: "2026-07-23T08:00:00Z",
      },
    ])

    render(<BusinessProfileForm project={project} onSave={vi.fn()} />)

    expect(await screen.findByText("目标网站拒绝访问")).toBeTruthy()
    expect(screen.getByText("网站业务资料已生成")).toBeTruthy()
    expect(screen.getByText("第 2 次")).toBeTruthy()
    expect(screen.getByText("3.0 秒")).toBeTruthy()
  })

  it("replaces form values when a newer recognition run finishes", async () => {
    const rerunningProject = {
      ...project,
      understandingRunId: "understanding-2",
      understandingStatus: "running" as const,
      understandingStage: "extracting_pages",
      understandingProgress: 70,
    }
    const refreshedProject = {
      ...rerunningProject,
      name: "Updated Example",
      understandingStatus: "completed" as const,
      understandingStage: "completed",
      understandingProgress: 100,
      understandingFinishedAt: "2026-07-23T08:10:10Z",
      siteProfile: {
        ...project.siteProfile!,
        businessName: "Updated Example",
        businessSummary: "Updated summary",
        productsServices: ["Updated analytics"],
      },
    }
    const { rerender } = render(
      <BusinessProfileForm project={project} onSave={vi.fn()} />
    )

    fireEvent.change(screen.getByLabelText("公司简介"), {
      target: { value: "Unsaved local edit" },
    })
    rerender(
      <BusinessProfileForm project={rerunningProject} onSave={vi.fn()} />
    )
    expect(screen.getByDisplayValue("Unsaved local edit")).toBeTruthy()

    rerender(
      <BusinessProfileForm project={refreshedProject} onSave={vi.fn()} />
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue("Updated Example")).toBeTruthy()
      expect(screen.getByDisplayValue("Updated summary")).toBeTruthy()
      expect(screen.getByDisplayValue("Updated analytics")).toBeTruthy()
    })
  })

  it("reloads recognition history when the current run finishes", async () => {
    const runningProject = {
      ...project,
      understandingRunId: "understanding-2",
      understandingStatus: "running" as const,
      understandingStage: "extracting_pages",
      understandingProgress: 70,
      understandingFinishedAt: null,
    }
    const completedRun = {
      runId: "understanding-2",
      attempt: 2,
      status: "completed" as const,
      stage: "completed",
      message: "第二次识别完成",
      progress: 100,
      startedAt: "2026-07-23T08:10:00Z",
      finishedAt: "2026-07-23T08:10:10Z",
      elapsedSeconds: 10,
      createdAt: "2026-07-23T08:10:00Z",
    }
    projectApi.listBusinessProfileRuns
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([completedRun])
    const { rerender } = render(
      <BusinessProfileForm project={runningProject} onSave={vi.fn()} />
    )

    await waitFor(() => {
      expect(projectApi.listBusinessProfileRuns).toHaveBeenCalledTimes(1)
    })

    rerender(
      <BusinessProfileForm
        project={{
          ...runningProject,
          understandingStatus: "completed",
          understandingStage: "completed",
          understandingProgress: 100,
          understandingFinishedAt: "2026-07-23T08:10:10Z",
        }}
        onSave={vi.fn()}
      />
    )

    expect(await screen.findByText("第二次识别完成")).toBeTruthy()
    expect(projectApi.listBusinessProfileRuns).toHaveBeenCalledTimes(2)
  })
})
