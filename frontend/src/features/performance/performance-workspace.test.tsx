import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  PerformanceArticle,
  PerformanceArticleDetail,
  PerformanceOverview,
} from "@/api/performance"
import { PerformanceWorkspace } from "@/features/performance/performance-workspace"

const performanceApi = vi.hoisted(() => ({
  getPerformanceArticle: vi.fn(),
  getPerformanceArticles: vi.fn(),
  getPerformanceOverview: vi.fn(),
  resolvePerformanceSignal: vi.fn(),
  syncPerformance: vi.fn(),
}))

vi.mock("@/api/performance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/performance")>()),
  ...performanceApi,
}))

const article: PerformanceArticle = {
  article_id: "article-1",
  title: "Solar panel installation guide",
  url: "https://example.com/solar-panel-installation",
  primary_keyword: "solar panel installation",
  published_at: "2026-07-01T08:00:00Z",
  last_published_at: "2026-07-20T08:00:00Z",
  metrics: { clicks: 32, impressions: 800, ctr: 0.04, position: 7.2 },
  previous_metrics: {
    clicks: 20,
    impressions: 600,
    ctr: 20 / 600,
    position: 8.6,
  },
  change: {
    clicks: 0.6,
    impressions: 1 / 3,
    ctr: 0.2,
    position: -1.4,
  },
  status: "growing",
  signal_count: 1,
}

function overview(
  overrides: Partial<PerformanceOverview> = {}
): PerformanceOverview {
  return {
    gsc_connected: true,
    site_url: "sc-domain:example.com",
    date_range: 28,
    range_start: "2026-07-14",
    range_end: "2026-08-10",
    previous_start: "2026-06-16",
    previous_end: "2026-07-13",
    metrics: article.metrics,
    previous_metrics: article.previous_metrics,
    change: article.change,
    trend: [
      {
        date: "2026-08-10",
        clicks: 3,
        impressions: 80,
        ctr: 0.0375,
        position: 7.1,
      },
    ],
    article_count: 1,
    status_counts: { growing: 1 },
    growing_articles: [article],
    declining_articles: [],
    sync: {
      status: "completed",
      data_through: "2026-08-10",
      synced_at: "2026-08-12T08:00:00Z",
      error: null,
    },
    ...overrides,
  }
}

const detail: PerformanceArticleDetail = {
  article,
  trend: [
    {
      date: "2026-08-10",
      clicks: 3,
      impressions: 80,
      ctr: 0.0375,
      position: 7.1,
    },
  ],
  queries: [
    {
      query: "best solar panel installation",
      clicks: 6,
      impressions: 120,
      ctr: 0.05,
      position: 5.8,
    },
  ],
  query_status: "available",
  query_error: null,
  publications: [
    {
      publication_id: "publication-1",
      kind: "published",
      version_number: 1,
      occurred_at: "2026-07-01T08:00:00Z",
    },
  ],
  signals: [
    {
      id: "signal-1",
      kind: "growing",
      message: "近 28 天点击增长 60%",
      status: "open",
      detected_at: "2026-08-12T08:00:00Z",
    },
  ],
  update_comparison: {
    updated_at: "2026-07-20T08:00:00Z",
    before_start: "2026-07-06",
    before_end: "2026-07-19",
    after_start: "2026-07-20",
    after_end: "2026-08-02",
    before_metrics: article.previous_metrics,
    after_metrics: article.metrics,
    change: article.change,
    observation_complete: true,
  },
  data_through: "2026-08-10",
}

beforeEach(() => {
  vi.clearAllMocks()
  performanceApi.getPerformanceOverview.mockResolvedValue(overview())
  performanceApi.getPerformanceArticles.mockResolvedValue({
    items: [article],
    total: 1,
    page: 1,
    page_size: 25,
  })
  performanceApi.getPerformanceArticle.mockResolvedValue(detail)
  performanceApi.resolvePerformanceSignal.mockResolvedValue(undefined)
  performanceApi.syncPerformance.mockResolvedValue({
    sync: overview().sync,
    target_count: 1,
  })
})

afterEach(cleanup)

describe("PerformanceWorkspace", () => {
  it("waits for a valid project id before loading data", async () => {
    const { rerender } = render(
      <PerformanceWorkspace
        view="overview"
        projectId=""
        onOpenArticle={vi.fn()}
      />
    )

    expect(performanceApi.getPerformanceOverview).not.toHaveBeenCalled()
    expect(performanceApi.getPerformanceArticles).not.toHaveBeenCalled()

    rerender(
      <PerformanceWorkspace
        view="overview"
        projectId="project-1"
        onOpenArticle={vi.fn()}
      />
    )

    await screen.findByText("Google Search Console")
    expect(screen.getByText("GSC 数据通常延迟 2 至 3 天", { exact: false })).toBeTruthy()
    expect(performanceApi.getPerformanceOverview).toHaveBeenCalledWith(
      "project-1",
      28
    )
    expect(performanceApi.getPerformanceArticles).toHaveBeenCalledWith(
      "project-1",
      28,
      {
        page: 1,
        pageSize: 25,
        status: "all",
        sort: "clicks",
        order: "desc",
      }
    )
  })

  it("shows the GSC connection requirement", async () => {
    performanceApi.getPerformanceOverview.mockResolvedValue(
      overview({ gsc_connected: false, site_url: null })
    )

    render(
      <PerformanceWorkspace
        view="overview"
        projectId="project-1"
        onOpenArticle={vi.fn()}
      />
    )

    expect(await screen.findByText("尚未连接 Search Console")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "前往服务连接" }).getAttribute("href")
    ).toBe("/projects/project-1/settings/connections")
  })

  it("starts the first sync from the unsynced state", async () => {
    performanceApi.getPerformanceOverview
      .mockResolvedValueOnce(
        overview({
          sync: {
            status: "never",
            data_through: null,
            synced_at: null,
            error: null,
          },
        })
      )
      .mockResolvedValue(overview())

    render(
      <PerformanceWorkspace
        view="overview"
        projectId="project-1"
        onOpenArticle={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByRole("button", { name: "开始同步" }))

    await waitFor(() => {
      expect(performanceApi.syncPerformance).toHaveBeenCalledWith("project-1")
      expect(performanceApi.getPerformanceOverview).toHaveBeenCalledTimes(2)
    })
  })

  it("keeps historical metrics visible after a failed refresh", async () => {
    performanceApi.getPerformanceOverview.mockResolvedValue(
      overview({
        sync: {
          status: "failed",
          data_through: "2026-08-10",
          synced_at: "2026-08-13T08:00:00Z",
          error: "upstream unavailable",
        },
      })
    )

    render(
      <PerformanceWorkspace
        view="overview"
        projectId="project-1"
        onOpenArticle={vi.fn()}
      />
    )

    expect(
      await screen.findByText("最近一次同步失败，当前展示上次成功同步的数据。")
    ).toBeTruthy()
    expect(screen.getByText("搜索趋势")).toBeTruthy()
  })

  it("shows a dedicated state while the first sync is running", async () => {
    performanceApi.getPerformanceOverview.mockResolvedValue(
      overview({
        article_count: 0,
        sync: {
          status: "running",
          data_through: null,
          synced_at: "2026-08-13T08:00:00Z",
          error: null,
        },
      })
    )
    performanceApi.getPerformanceArticles.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 25,
    })

    render(
      <PerformanceWorkspace
        view="overview"
        projectId="project-1"
        onOpenArticle={vi.fn()}
      />
    )

    expect(await screen.findByText("正在同步效果数据")).toBeTruthy()
    expect(screen.queryByText("搜索趋势")).toBeNull()
  })

  it("shows real article metrics and opens article details", async () => {
    render(
      <PerformanceWorkspace
        view="articles"
        projectId="project-1"
        onOpenArticle={vi.fn()}
      />
    )

    const articleTitle = await screen.findByText(
      "Solar panel installation guide"
    )
    expect(
      screen.getByRole("combobox", { name: "文章状态" }).textContent
    ).toContain("全部状态")
    expect(
      screen.getByRole("combobox", { name: "文章排序" }).textContent
    ).toContain("按点击排序")

    fireEvent.click(articleTitle)

    expect(
      await screen.findByText("best solar panel installation")
    ).toBeTruthy()
    expect(screen.getByText("目标关键词：solar panel installation")).toBeTruthy()
    expect(screen.getByText("5.0%")).toBeTruthy()
    expect(screen.getByText("近 28 天点击增长 60%")).toBeTruthy()
    expect(screen.getByText("14 天观察完成")).toBeTruthy()
    expect(performanceApi.getPerformanceArticle).toHaveBeenCalledWith(
      "project-1",
      "article-1",
      28
    )
  })

  it("uses the selected range for overview, list, and article detail", async () => {
    render(
      <PerformanceWorkspace
        view="articles"
        projectId="project-1"
        onOpenArticle={vi.fn()}
      />
    )

    await screen.findByText("Solar panel installation guide")
    fireEvent.click(screen.getByRole("button", { name: "7 天" }))

    await waitFor(() => {
      expect(performanceApi.getPerformanceOverview).toHaveBeenLastCalledWith(
        "project-1",
        7
      )
      expect(performanceApi.getPerformanceArticles).toHaveBeenLastCalledWith(
        "project-1",
        7,
        expect.objectContaining({ page: 1 })
      )
    })

    fireEvent.click(screen.getByText("Solar panel installation guide"))

    await waitFor(() => {
      expect(performanceApi.getPerformanceArticle).toHaveBeenLastCalledWith(
        "project-1",
        "article-1",
        7
      )
    })
  })

  it("returns from the detail sheet to the existing article editor", async () => {
    const onOpenArticle = vi.fn()
    render(
      <PerformanceWorkspace
        view="articles"
        projectId="project-1"
        onOpenArticle={onOpenArticle}
      />
    )

    fireEvent.click(await screen.findByText("Solar panel installation guide"))
    fireEvent.click(await screen.findByRole("button", { name: "打开文章优化" }))

    expect(onOpenArticle).toHaveBeenCalledWith("article-1")
  })

  it("keeps a signal visible when resolving it fails", async () => {
    performanceApi.resolvePerformanceSignal.mockRejectedValue(
      new Error("request failed")
    )

    render(
      <PerformanceWorkspace
        view="articles"
        projectId="project-1"
        onOpenArticle={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByText("Solar panel installation guide"))
    fireEvent.click(await screen.findByRole("button", { name: "已查看" }))

    expect(await screen.findByText("处理效果信号失败")).toBeTruthy()
    expect(screen.getByText("近 28 天点击增长 60%")).toBeTruthy()
  })

  it("distinguishes unavailable query data from an empty query result", async () => {
    performanceApi.getPerformanceArticle.mockResolvedValue({
      ...detail,
      queries: [],
      query_status: "unavailable",
      query_error: "gsc_query_unavailable",
    })

    render(
      <PerformanceWorkspace
        view="articles"
        projectId="project-1"
        onOpenArticle={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByText("Solar panel installation guide"))

    expect(
      await screen.findByText(
        "查询数据暂时不可用，文章趋势和历史指标仍可查看。"
      )
    ).toBeTruthy()
    expect(screen.queryByText("当前范围暂无查询数据。")).toBeNull()
  })

  it("requests the next article page without replacing the overview", async () => {
    performanceApi.getPerformanceArticles.mockResolvedValue({
      items: [article],
      total: 26,
      page: 1,
      page_size: 25,
    })

    render(
      <PerformanceWorkspace
        view="articles"
        projectId="project-1"
        onOpenArticle={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByRole("button", { name: "下一页" }))

    await waitFor(() => {
      expect(performanceApi.getPerformanceArticles).toHaveBeenLastCalledWith(
        "project-1",
        28,
        expect.objectContaining({ page: 2, pageSize: 25 })
      )
    })
  })
})
