import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuditRun } from "@/api/audits"
import { AuditWorkspace } from "@/features/audit/audit-workspace"
import type { Project } from "@/features/projects/types"

const auditApi = vi.hoisted(() => ({
  archiveAuditRun: vi.fn(),
  deleteAuditRun: vi.fn(),
  downloadAuditExport: vi.fn(),
  getAuditActivity: vi.fn(),
  getAuditExternalResources: vi.fn(),
  getAuditIssues: vi.fn(),
  getAuditLinks: vi.fn(),
  getAuditPages: vi.fn(),
  getAuditPageSpeed: vi.fn(),
  getAuditStatusCodes: vi.fn(),
  getAuditVisualization: vi.fn(),
  listAuditRuns: vi.fn(),
  pauseAuditRun: vi.fn(),
  recalculateAuditIssues: vi.fn(),
  resumeAuditRun: vi.fn(),
  stopAuditRun: vi.fn(),
}))

vi.mock("@/api/audits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/audits")>()),
  ...auditApi,
}))

const project: Project = {
  id: "project-1",
  name: "Example",
  domain: "example.com",
  country: "US",
  language: "en",
  competitorDomain: null,
  understandingRunId: null,
  understandingStatus: "completed",
  understandingStage: "completed",
  understandingMessage: "",
  understandingProgress: 100,
  understandingAttempt: 1,
  understandingStartedAt: null,
  understandingFinishedAt: null,
  understandingElapsedSeconds: 0,
  auditRunId: "run-1",
  auditStatus: "running",
  auditHealth: null,
  siteProfile: null,
  createdAt: "2026-07-22",
}

function createRun(overrides: Partial<AuditRun> = {}): AuditRun {
  return {
    run_id: "run-1",
    project_id: project.id,
    status: "running",
    stage: "crawl",
    message: "正在抓取",
    progress: 42,
    discovered: 10,
    processed: 4,
    selected: 10,
    created_at: "2026-07-22T00:00:00Z",
    can_resume: false,
    summary: null,
    pagespeed: null,
    ...overrides,
  }
}

function renderWorkspace(
  run: AuditRun,
  options: {
    onRunChange?: (nextRun: AuditRun | null) => void
    onProjectRefresh?: () => Promise<unknown>
    view?: string
  } = {}
) {
  const onRunChange = options.onRunChange ?? vi.fn()
  const onProjectRefresh =
    options.onProjectRefresh ?? vi.fn().mockResolvedValue(undefined)
  const view = options.view ?? "overview"

  const renderResult = render(
    <MemoryRouter>
      <AuditWorkspace
        project={project}
        view={view}
        run={run}
        error=""
        onStart={vi.fn()}
        onRunChange={onRunChange}
        onProjectRefresh={onProjectRefresh}
      />
    </MemoryRouter>
  )

  return {
    onRunChange,
    onProjectRefresh,
    rerenderRun(nextRun: AuditRun) {
      renderResult.rerender(
        <MemoryRouter>
          <AuditWorkspace
            project={project}
            view={view}
            run={nextRun}
            error=""
            onStart={vi.fn()}
            onRunChange={onRunChange}
            onProjectRefresh={onProjectRefresh}
          />
        </MemoryRouter>
      )
    },
  }
}

function createPage(finalUrl: string) {
  return {
    id: finalUrl,
    url: finalUrl,
    final_url: finalUrl,
    status_code: 200,
    title: "Example",
    description: "",
    content_type: "text/html",
    indexable: true,
    word_count: 100,
    response_time_ms: 20,
    rendered: false,
    issues_count: 0,
    depth: 0,
    canonical: "",
    h1: [],
    h2: [],
    h3: [],
    headings: [],
    meta_tags: {},
    size_bytes: 1000,
    language: "en",
    charset: "utf-8",
    viewport: "",
    robots: "",
    author: "",
    keywords: "",
    generator: "",
    theme_color: "",
    open_graph: {},
    twitter_tags: {},
    structured_data: [],
    schema_org: [],
    analytics: {},
    images: [],
    broken_images: [],
    internal_links: 0,
    external_links: 0,
    hreflang: [],
    redirects: [],
    linked_from: [],
    discovered_from: "",
    error: "",
    error_type: "",
    raw: {},
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  auditApi.getAuditActivity.mockResolvedValue({
    items: [],
    next_cursor: 0,
  })
  auditApi.getAuditPages.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    page_size: 50,
  })
  auditApi.getAuditExternalResources.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    page_size: 50,
  })
  auditApi.listAuditRuns.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    page_size: 25,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("AuditWorkspace actions", () => {
  it("recalculates completed audit issues with edited exclusion rules", async () => {
    const completedRun = createRun({
      status: "completed",
      progress: 100,
      issue_exclusion_patterns: ["/old/*"],
    })
    const recalculatingRun = createRun({
      status: "recalculating",
      stage: "recalculating_issues",
      progress: 99,
      issue_exclusion_patterns: ["/old/*"],
    })
    auditApi.recalculateAuditIssues.mockResolvedValue(recalculatingRun)
    const { onRunChange } = renderWorkspace(completedRun)

    fireEvent.click(await screen.findByRole("button", { name: "调整排除规则" }))
    const textarea = screen.getByRole("textbox")
    expect((textarea as HTMLTextAreaElement).value).toBe("/old/*")
    fireEvent.change(textarea, {
      target: { value: "/new/*\n*.json\n/new/*" },
    })
    fireEvent.click(screen.getByRole("button", { name: "重新计算" }))

    await waitFor(() => {
      expect(auditApi.recalculateAuditIssues).toHaveBeenCalledWith(
        "project-1",
        "run-1",
        ["/new/*", "*.json"]
      )
    })
    expect(onRunChange).toHaveBeenCalledWith(recalculatingRun)
    expect(screen.queryByText("调整问题排除规则")).toBeNull()
  })

  it("pauses the current audit and publishes the updated run", async () => {
    const pausedRun = createRun({
      status: "paused",
      message: "已暂停",
      can_resume: true,
    })
    auditApi.pauseAuditRun.mockResolvedValue(pausedRun)
    const { onRunChange, onProjectRefresh } = renderWorkspace(createRun())

    fireEvent.click(screen.getByRole("button", { name: "暂停" }))

    await waitFor(() => {
      expect(auditApi.pauseAuditRun).toHaveBeenCalledWith("project-1", "run-1")
    })
    expect(onRunChange).toHaveBeenCalledWith(pausedRun)
    expect(onProjectRefresh).toHaveBeenCalledOnce()
  })

  it("resumes a resumable audit", async () => {
    const pausedRun = createRun({
      status: "paused",
      message: "已暂停",
      can_resume: true,
    })
    const resumedRun = createRun({ message: "继续抓取" })
    auditApi.resumeAuditRun.mockResolvedValue(resumedRun)
    const { onRunChange } = renderWorkspace(pausedRun)

    fireEvent.click(screen.getByRole("button", { name: "恢复" }))

    await waitFor(() => {
      expect(auditApi.resumeAuditRun).toHaveBeenCalledWith("project-1", "run-1")
    })
    expect(onRunChange).toHaveBeenCalledWith(resumedRun)
  })

  it("keeps a successful action when the project refresh fails", async () => {
    const pausedRun = createRun({
      status: "paused",
      message: "已暂停",
      can_resume: true,
    })
    auditApi.pauseAuditRun.mockResolvedValue(pausedRun)
    const onProjectRefresh = vi
      .fn()
      .mockRejectedValue(new Error("refresh failed"))
    const { onRunChange } = renderWorkspace(createRun(), {
      onProjectRefresh,
    })

    fireEvent.click(screen.getByRole("button", { name: "暂停" }))

    await waitFor(() => {
      expect(onRunChange).toHaveBeenCalledWith(pausedRun)
    })
    expect(
      await screen.findByText(
        "审计操作已完成，但项目状态刷新失败：refresh failed"
      )
    ).toBeTruthy()
    expect(screen.queryByText("审计操作失败")).toBeNull()
  })

  it("downloads the selected export with the response filename", async () => {
    const blob = new Blob(["url,title"], { type: "text/csv" })
    auditApi.downloadAuditExport.mockResolvedValue({
      blob,
      filename: "example-issues.csv",
    })
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:audit-export")
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined)
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined)

    renderWorkspace(createRun({ status: "completed", progress: 100 }))

    const exportButton = screen.getByRole("button", { name: /导出/ })
    await waitFor(() => {
      expect((exportButton as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(exportButton)
    fireEvent.click(await screen.findByText("问题清单"))
    fireEvent.click(await screen.findByText("CSV"))

    await waitFor(() => {
      expect(auditApi.downloadAuditExport).toHaveBeenCalledWith(
        "project-1",
        "run-1",
        "issues",
        "csv"
      )
    })
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(anchorClick).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audit-export")
  })

  it("keeps a deleted audit removed when follow-up refreshes fail", async () => {
    const completedRun = createRun({
      status: "completed",
      progress: 100,
      message: "审计完成",
    })
    auditApi.listAuditRuns
      .mockResolvedValueOnce({
        items: [completedRun],
        total: 1,
        page: 1,
        page_size: 25,
      })
      .mockRejectedValueOnce(new Error("history refresh failed"))
    auditApi.deleteAuditRun.mockResolvedValue(undefined)
    const onProjectRefresh = vi
      .fn()
      .mockRejectedValue(new Error("project refresh failed"))
    const { onRunChange } = renderWorkspace(completedRun, {
      onProjectRefresh,
      view: "history",
    })

    await screen.findByText("共 1 次审计")
    fireEvent.click(screen.getByTitle("删除"))
    fireEvent.click(
      await screen.findByRole("button", {
        name: "删除",
      })
    )

    await waitFor(() => {
      expect(auditApi.deleteAuditRun).toHaveBeenCalledWith("project-1", "run-1")
    })
    expect(auditApi.listAuditRuns).toHaveBeenCalledTimes(2)
    expect(auditApi.listAuditRuns).toHaveBeenLastCalledWith("project-1", {
      page: 1,
      pageSize: 1,
    })
    expect(onRunChange).toHaveBeenCalledWith(null)
    expect(screen.queryByText("共 1 次审计")).toBeNull()
    expect(screen.queryByText("删除这次审计？")).toBeNull()
    expect(
      await screen.findByText(
        "审计已删除，但重新读取审计历史失败：history refresh failed；项目状态刷新失败：project refresh failed"
      )
    ).toBeTruthy()
    expect(screen.queryByText("删除审计失败")).toBeNull()
  })
})

describe("AuditWorkspace data loading", () => {
  it("shows only a crawl message on non-overview views while running", async () => {
    renderWorkspace(createRun(), { view: "issues" })

    expect(screen.getByText("网站仍在抓取中")).toBeTruthy()
    expect(
      screen.getByText("审计完成后将自动显示当前页面的结果。")
    ).toBeTruthy()
    expect(screen.queryByText("实时抓取")).toBeNull()

    await act(async () => {
      await Promise.resolve()
    })

    expect(auditApi.getAuditIssues).not.toHaveBeenCalled()
    expect(auditApi.getAuditActivity).not.toHaveBeenCalled()
  })

  it("does not present the finalizing stage as completed", () => {
    renderWorkspace(
      createRun({
        stage: "completed",
        message: "技术审计处理完成",
        progress: 99,
      }),
      { view: "external" }
    )

    expect(screen.getByText("整理结果中")).toBeTruthy()
    expect(screen.getByText("正在整理审计结果")).toBeTruthy()
    expect(screen.queryByText("技术审计处理完成")).toBeNull()
    expect(screen.queryByText("已完成")).toBeNull()
    expect(auditApi.getAuditExternalResources).not.toHaveBeenCalled()
  })

  it("loads the selected view immediately and reports completion only after success", async () => {
    type PageResult = {
      items: ReturnType<typeof createPage>[]
      total: number
      page: number
      page_size: number
    }
    let resolvePages: ((result: PageResult) => void) | undefined
    auditApi.getAuditPages.mockImplementationOnce(
      () =>
        new Promise<PageResult>((resolve) => {
          resolvePages = resolve
        })
    )
    const { rerenderRun } = renderWorkspace(createRun(), {
      view: "internal",
    })

    expect(screen.getByText("网站仍在抓取中")).toBeTruthy()
    expect(auditApi.getAuditPages).not.toHaveBeenCalled()

    rerenderRun(
      createRun({
        status: "completed",
        stage: "completed",
        message: "技术审计已完成",
        progress: 100,
      })
    )

    await waitFor(() => {
      expect(auditApi.getAuditPages).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByText("加载结果中")).toBeTruthy()
    expect(screen.getByText("正在加载审计结果")).toBeTruthy()
    expect(screen.queryByText("已完成")).toBeNull()

    await act(async () => {
      resolvePages?.({
        items: [createPage("https://example.com/ready")],
        total: 1,
        page: 1,
        page_size: 50,
      })
      await Promise.resolve()
    })

    expect(await screen.findByText("https://example.com/ready")).toBeTruthy()
    expect(screen.getByText("已完成")).toBeTruthy()
    expect(screen.queryByText("正在加载审计结果")).toBeNull()
  })

  it("keeps completion hidden when results fail and retries immediately", async () => {
    auditApi.getAuditPages
      .mockRejectedValueOnce(new Error("result unavailable"))
      .mockResolvedValueOnce({
        items: [createPage("https://example.com/retried")],
        total: 1,
        page: 1,
        page_size: 50,
      })

    renderWorkspace(
      createRun({
        status: "completed",
        stage: "completed",
        message: "技术审计已完成",
        progress: 100,
      }),
      { view: "internal" }
    )

    expect(await screen.findByText("审计结果加载失败")).toBeTruthy()
    expect(screen.getByText("result unavailable")).toBeTruthy()
    expect(screen.queryByText("已完成")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "重新加载" }))

    expect(await screen.findByText("https://example.com/retried")).toBeTruthy()
    expect(auditApi.getAuditPages).toHaveBeenCalledTimes(2)
    expect(screen.getByText("已完成")).toBeTruthy()
  })

  it("shows checkpoint pages while an audit is running", async () => {
    auditApi.getAuditActivity.mockResolvedValueOnce({
      items: [
        {
          sequence: 1,
          url: "https://example.com/missing",
          final_url: "https://example.com/missing",
          status_code: 404,
          title: "Missing",
          error: "",
          error_type: "",
          depth: 1,
          rendered: false,
          response_time_ms: 321,
          fetched_at: "2026-07-22T08:00:01Z",
        },
      ],
      next_cursor: 1,
    })

    renderWorkspace(createRun())

    await waitFor(() => {
      expect(auditApi.getAuditActivity).toHaveBeenCalledWith(
        "project-1",
        "run-1",
        0
      )
    })
    expect(await screen.findByText("Missing")).toBeTruthy()
    expect(screen.getByText("https://example.com/missing")).toBeTruthy()
    expect(screen.getByText("404")).toBeTruthy()
    expect(screen.getByText("321 ms")).toBeTruthy()
  })

  it("shows an activity error without hiding the audit workspace", async () => {
    auditApi.getAuditActivity.mockRejectedValueOnce(
      new Error("activity unavailable")
    )

    renderWorkspace(createRun())

    expect(await screen.findByText("activity unavailable")).toBeTruthy()
    expect(screen.getByText("实时抓取")).toBeTruthy()
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy()
  })

  it("does not reload the current table for polling-only run updates", async () => {
    const { rerenderRun } = renderWorkspace(createRun())

    await waitFor(() => {
      expect(auditApi.getAuditPages).toHaveBeenCalledTimes(1)
    })

    rerenderRun(createRun({ progress: 48, processed: 5 }))
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(auditApi.getAuditPages).toHaveBeenCalledTimes(1)
  })

  it("refreshes the current table while an audit is running", async () => {
    vi.useFakeTimers()
    try {
      renderWorkspace(createRun())

      await act(async () => {
        await Promise.resolve()
      })
      expect(auditApi.getAuditPages).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500)
      })

      expect(auditApi.getAuditPages).toHaveBeenCalledTimes(2)
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it("shows fetched external resource details", async () => {
    auditApi.getAuditExternalResources.mockResolvedValueOnce({
      items: [
        {
          id: "resource-1",
          url: "https://cdn.example.net/document.pdf",
          final_url: "https://cdn.example.net/document.pdf",
          status_code: 404,
          content_type: "application/pdf",
          size_bytes: 2048,
          title: "Missing document",
          error: "",
          error_type: "",
          checked_at: "2026-07-22T00:00:00Z",
          raw: {},
        },
      ],
      total: 1,
      page: 1,
      page_size: 50,
    })

    renderWorkspace(createRun({ status: "completed" }), {
      view: "external",
    })

    expect(
      await screen.findByText("https://cdn.example.net/document.pdf")
    ).toBeTruthy()
    expect(auditApi.getAuditExternalResources).toHaveBeenCalledWith(
      "project-1",
      "run-1",
      {
        page: 1,
        pageSize: 50,
        search: "",
        statusFamily: undefined,
      }
    )
    expect(screen.getByText("404")).toBeTruthy()
    expect(screen.getByText("application/pdf")).toBeTruthy()
    expect(screen.getByText("2.0 KB")).toBeTruthy()
    expect(screen.getByText("Missing document")).toBeTruthy()
    expect(screen.getByText("cdn.example.net")).toBeTruthy()
  })

  it("does not show pages from the previous audit after a switch fails", async () => {
    auditApi.getAuditPages.mockResolvedValueOnce({
      items: [createPage("https://example.com/old")],
      total: 1,
      page: 1,
      page_size: 50,
    })
    const { rerenderRun } = renderWorkspace(
      createRun({ run_id: "run-old", status: "completed" })
    )

    await screen.findByText("https://example.com/old")

    auditApi.getAuditPages.mockRejectedValueOnce(new Error("load failed"))
    rerenderRun(createRun({ run_id: "run-new", status: "completed" }))

    await screen.findByText("load failed")
    expect(screen.queryByText("https://example.com/old")).toBeNull()
  })
})
