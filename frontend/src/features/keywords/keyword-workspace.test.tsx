import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import type {
  KeywordBuildRun,
  KeywordLibraryStatus,
  KeywordListResult,
} from "@/api/keywords"
import { KeywordWorkspace } from "@/features/keywords/keyword-workspace"
import {
  DEFAULT_KEYWORD_LIBRARY_QUERY,
  keywordQueryClient,
  keywordQueryKeys,
} from "@/features/keywords/keyword-query-client"

const keywordApi = vi.hoisted(() => ({
  assignKeywordTags: vi.fn(),
  getCompetitorAnalysisStatus: vi.fn(),
  getKeywordStatus: vi.fn(),
  listCompetitorAnalysisRuns: vi.fn(),
  listKeywordCompetitorOpportunities: vi.fn(),
  listKeywordCompetitors: vi.fn(),
  listKeywords: vi.fn(),
  retryKeywordBuild: vi.fn(),
  saveGSCKeywords: vi.fn(),
  startCompetitorAnalysis: vi.fn(),
  updateCompetitorOpportunities: vi.fn(),
  updateKeywordStatus: vi.fn(),
}))

const settingsApi = vi.hoisted(() => ({
  getGSCConnection: vi.fn(),
  getGSCPerformance: vi.fn(),
  getGSCPerformanceTable: vi.fn(),
  exportGSCPerformance: vi.fn(),
}))

vi.mock("@/api/keywords", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/keywords")>()),
  ...keywordApi,
}))

vi.mock("@/api/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/settings")>()),
  ...settingsApi,
}))

const completedRun: KeywordBuildRun = {
  runId: "run-1",
  kind: "initial",
  roundNumber: 1,
  status: "completed",
  stage: "completed",
  message: "关键词库已建立",
  progress: 100,
  discoveredCount: 900,
  selectedCount: 20,
  keywordCount: 420,
  resultVersion: 1,
  profileSource: "site_profile",
  gapStatus: "not_requested",
  gapMessage: "",
  gapCount: 0,
  partialFailures: [],
  errorCode: null,
  recoveryCount: 0,
  nextRetryAt: null,
  startedAt: "2026-07-27T00:00:00Z",
  finishedAt: "2026-07-27T00:03:00Z",
  elapsedSeconds: 180,
}

const queuedCompetitorRun = {
  runId: "competitor-run-queued",
  targetDomain: "example.com",
  country: "US",
  language: "en",
  mode: "auto" as const,
  requestedCompetitorDomains: [],
  status: "queued" as const,
  stage: "queued",
  message: "正在准备竞争分析",
  progress: 0,
  competitorLimit: 5,
  keywordLimit: 100,
  discoveredCount: 0,
  completedCompetitors: 0,
  failedCompetitors: 0,
  rawKeywordCount: 0,
  uniqueKeywordCount: 0,
  totalCostUsd: 0,
  errorCode: null,
  recoveryCount: 0,
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-08-04T00:00:00Z",
}

const completedStatus: KeywordLibraryStatus = {
  run: completedRun,
  totalKeywords: 420,
  activeKeywords: 420,
  pendingMetricsCount: 0,
  resultVersion: 1,
}

const keywordResult: KeywordListResult = {
  items: [
    {
      id: "keyword-1",
      keyword: "solar panel installation",
      primarySeed: "solar panels",
      classificationConfidence: 0.94,
      reviewStatus: "approved",
      intent: "commercial",
      searchVolume: 2400,
      cpc: 3.2,
      competition: 0.7,
      competitionLevel: "HIGH",
      keywordDifficulty: 42,
      monthlySearches: [],
      priorityScore: 86,
      priorityConfidence: 1,
      priorityDetails: {},
      sources: ["google_ads_site"],
      tags: [],
      status: "active",
      metricsStatus: "fresh",
      metricsUpdatedAt: "2026-07-27T00:02:30Z",
      createdAt: "2026-07-27T00:03:00Z",
      updatedAt: "2026-07-27T00:03:00Z",
    },
  ],
  total: 420,
  page: 1,
  pageSize: 50,
  resultVersion: 1,
}

const performanceReport = {
  siteUrl: "sc-domain:example.com",
  range: {
    startDate: "2026-07-05",
    endDate: "2026-08-02",
    previousStartDate: "2026-06-06",
    previousEndDate: "2026-07-04",
  },
  totals: {
    clicks: 80,
    impressions: 1600,
    ctr: 0.05,
    position: 8.2,
  },
  previousTotals: {
    clicks: 60,
    impressions: 1400,
    ctr: 60 / 1400,
    position: 9.1,
  },
  strikingDistance: [
    {
      query: "solar panels",
      page: "https://example.com/solar-panels",
      clicks: 12,
      impressions: 240,
      position: 6.4,
    },
  ],
  countries: [
    { key: "usa", clicks: 80, impressions: 1600, ctr: 0.05, position: 8.2 },
  ],
}

beforeEach(() => {
  keywordQueryClient.clear()
  vi.clearAllMocks()
  keywordApi.getKeywordStatus.mockResolvedValue(completedStatus)
  settingsApi.getGSCConnection.mockResolvedValue({
    oauthConfigured: true,
    grantConnected: true,
    propertyConnected: true,
    siteUrl: "sc-domain:example.com",
    connectedAccountEmail: "owner@example.com",
    requiresReconnect: false,
  })
  settingsApi.getGSCPerformance.mockResolvedValue(performanceReport)
  settingsApi.getGSCPerformanceTable.mockResolvedValue({
    dimension: "query",
    page: 1,
    pageSize: 25,
    hasNextPage: false,
    rows: [
      {
        key: "solar panels",
        clicks: 12,
        impressions: 240,
        ctr: 0.05,
        position: 6.4,
      },
    ],
  })
  settingsApi.exportGSCPerformance.mockResolvedValue([])
  keywordApi.saveGSCKeywords.mockResolvedValue({
    saved: 1,
    addedToLibrary: 1,
    alreadyInLibrary: 0,
  })
  keywordApi.listKeywords.mockResolvedValue(keywordResult)
  keywordApi.getCompetitorAnalysisStatus.mockResolvedValue(null)
  keywordApi.listCompetitorAnalysisRuns.mockResolvedValue([])
  keywordApi.listKeywordCompetitors.mockResolvedValue({
    runId: null,
    items: [],
  })
  keywordApi.listKeywordCompetitorOpportunities.mockResolvedValue({
    runId: null,
    analyzedAt: null,
    items: [],
    total: 0,
    page: 1,
    pageSize: 50,
  })
  keywordApi.updateCompetitorOpportunities.mockResolvedValue({
    updated: 1,
    addedToLibrary: 1,
    alreadyInLibrary: 0,
  })
  keywordApi.startCompetitorAnalysis.mockResolvedValue(queuedCompetitorRun)
  keywordApi.retryKeywordBuild.mockResolvedValue({
    ...completedRun,
    status: "queued",
    stage: "queued",
    message: "关键词库重试已进入队列",
    progress: 0,
  })
})

afterEach(() => {
  cleanup()
})

describe("KeywordWorkspace", () => {
  it("未连接 GSC 时也允许手动添加竞品", async () => {
    settingsApi.getGSCConnection.mockResolvedValue({
      oauthConfigured: true,
      grantConnected: false,
      propertyConnected: false,
      siteUrl: null,
      connectedAccountEmail: null,
      requiresReconnect: false,
    })
    render(<KeywordWorkspace projectId="project-1" view="competitor-gap" />)

    await screen.findByText("竞争对手")
    fireEvent.click(screen.getByRole("button", { name: "手动添加" }))
    fireEvent.change(screen.getByRole("textbox", { name: "竞争对手域名 1" }), {
      target: { value: "manual.example" },
    })
    fireEvent.click(screen.getByRole("button", { name: "开始分析" }))

    await waitFor(() => {
      expect(keywordApi.startCompetitorAnalysis).toHaveBeenCalledWith(
        "project-1",
        { mode: "manual", competitorDomains: ["manual.example"] }
      )
    })
  })

  it("自动发现无需二次确认并直接提交全国自动模式", async () => {
    render(<KeywordWorkspace projectId="project-1" view="competitor-gap" />)

    await screen.findByText("竞争对手")
    const autoButton = screen.getByRole("button", { name: "分析竞争对手" })
    await waitFor(() => expect(autoButton.hasAttribute("disabled")).toBe(false))
    fireEvent.click(autoButton)

    await waitFor(() => {
      expect(keywordApi.startCompetitorAnalysis).toHaveBeenCalledWith(
        "project-1",
        { mode: "auto" }
      )
    })
    expect(screen.queryByText("全国搜索")).toBeNull()
    expect(screen.queryByRole("button", { name: "开始发现" })).toBeNull()
  })

  it("打开自动发现时重新读取 GSC 连接，避免使用旧的未连接缓存", async () => {
    keywordQueryClient.setQueryData(keywordQueryKeys.connection("project-1"), {
      oauthConfigured: true,
      grantConnected: false,
      propertyConnected: false,
      siteUrl: null,
      connectedAccountEmail: null,
      requiresReconnect: false,
    })

    render(<KeywordWorkspace projectId="project-1" view="competitor-gap" />)

    await screen.findByText("竞争对手")
    fireEvent.click(screen.getByRole("button", { name: "分析竞争对手" }))

    await waitFor(() => {
      expect(keywordApi.startCompetitorAnalysis).toHaveBeenCalledWith(
        "project-1",
        { mode: "auto" }
      )
    })
    expect(settingsApi.getGSCConnection).toHaveBeenCalledWith("project-1")
  })

  it("不再展示本地发现入口和本地参数表单", async () => {
    render(<KeywordWorkspace projectId="project-1" view="competitor-gap" />)

    await screen.findByText("竞争对手")
    expect(screen.queryByRole("button", { name: "本地发现" })).toBeNull()
    expect(screen.queryByText("本地发现竞争对手")).toBeNull()
  })

  it("尚未分析时只展示竞品分析引导，不展示结果表格和筛选", async () => {
    render(<KeywordWorkspace projectId="project-1" view="competitor-gap" />)

    expect(await screen.findByText("竞争对手情报")).toBeTruthy()
    expect(screen.getByText("发现内容机会")).toBeTruthy()
    expect(
      screen.getByText("找出竞争对手已有排名、但当前网站尚未覆盖的关键词")
    ).toBeTruthy()
    expect(screen.getByText("自动发现")).toBeTruthy()
    expect(screen.getByText("差距分析")).toBeTruthy()
    expect(screen.getByText("机会评分")).toBeTruthy()
    expect(screen.getByRole("button", { name: "分析竞争对手" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "手动添加" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "重新分析" })).toBeNull()
    expect(screen.getByText("大约需要 2 分钟")).toBeTruthy()
    expect(screen.queryByText("内容差距")).toBeNull()
    expect(screen.queryByRole("columnheader", { name: "关键词" })).toBeNull()
    expect(screen.queryByRole("button", { name: "筛选" })).toBeNull()
  })

  it("分析中展示实时进度和两栏空结果框架", async () => {
    keywordApi.getCompetitorAnalysisStatus.mockResolvedValue({
      ...queuedCompetitorRun,
      status: "running",
      stage: "gap_analysis",
      message: "正在分析竞争对手关键词",
      progress: 36,
      completedCompetitors: 0,
    })

    render(<KeywordWorkspace projectId="project-1" view="competitor-gap" />)

    expect(await screen.findByText("分析竞争对手（0/5）")).toBeTruthy()
    expect(screen.getByText("正在分析竞争对手关键词")).toBeTruthy()
    expect(screen.getByText("36%")).toBeTruthy()
    expect(screen.getByText("尚未分析任何竞争对手")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "手动添加" }).hasAttribute("disabled")
    ).toBe(true)
    expect(screen.getByText("内容差距")).toBeTruthy()
    expect(screen.getByRole("tab", { name: "全部" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "高机会" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "快速取胜" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "未覆盖" })).toBeTruthy()
    expect(screen.getByText("尚未发现关键词差距。")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "重新分析" })).toBeNull()
  })

  it("最新分析没有有效结果时仍保留项目中已保存的竞品", async () => {
    keywordApi.getCompetitorAnalysisStatus.mockResolvedValue({
      ...queuedCompetitorRun,
      status: "completed",
      stage: "completed",
      message: "竞争对手关键词分析未完成",
      progress: 100,
      discoveredCount: 25,
      analyzedCompetitorCount: 0,
      completedCompetitors: 0,
      finishedAt: "2026-08-04T00:01:00Z",
    })
    keywordApi.listKeywordCompetitors.mockResolvedValue({
      runId: "competitor-run-queued",
      items: [
        {
          id: "candidate-only",
          domain: "candidate-only.example",
          selectedForGap: true,
          status: "pending",
        },
      ],
    })

    render(
      <KeywordWorkspace
        projectId="project-1"
        view="competitor-gap"
        savedCompetitorDomain="stremio.com"
      />
    )

    expect(await screen.findByText("竞争对手情报")).toBeTruthy()
    expect(screen.queryByText("已分析 25 个竞品")).toBeNull()
    expect(screen.queryByText("25 个竞争对手")).toBeNull()
    expect(screen.queryByText("candidate-only.example")).toBeNull()
    expect(screen.queryByRole("button", { name: "重新分析" })).toBeNull()
    expect(screen.getByText("stremio.com")).toBeTruthy()
    expect(screen.getByText("待分析")).toBeTruthy()
  })

  it("未连接 GSC 时仍加载竞品差距，只拦截自动发现", async () => {
    settingsApi.getGSCConnection.mockResolvedValue({
      oauthConfigured: true,
      grantConnected: false,
      propertyConnected: false,
      siteUrl: null,
      connectedAccountEmail: null,
      requiresReconnect: false,
    })
    render(<KeywordWorkspace projectId="project-1" view="competitor-gap" />)

    await screen.findByText("竞争对手")
    expect(screen.getByRole("button", { name: "手动添加" })).toBeTruthy()
    const autoButton = screen.getByRole("button", { name: "分析竞争对手" })
    await waitFor(() => expect(autoButton.hasAttribute("disabled")).toBe(false))
    fireEvent.click(autoButton)

    expect(
      await screen.findByText(
        "请先连接当前项目的 Google Search Console，再使用自动发现。"
      )
    ).toBeTruthy()
    expect(
      screen.queryByText(/连接并为当前项目选择对应的 Search Console/)
    ).toBeNull()
    expect(keywordApi.getCompetitorAnalysisStatus).toHaveBeenCalledWith(
      "project-1"
    )
    expect(keywordApi.startCompetitorAnalysis).not.toHaveBeenCalled()
    expect(
      screen.getByRole("button", { name: "前往连接" }).getAttribute("href")
    ).toContain("/settings/data-sources?returnTo=")
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull()
  })

  it("搜索表现未授权时不读取数据，授权后显示 GSC 指标", async () => {
    settingsApi.getGSCConnection.mockResolvedValueOnce({
      oauthConfigured: true,
      grantConnected: false,
      propertyConnected: false,
      siteUrl: null,
      connectedAccountEmail: null,
      requiresReconnect: false,
    })
    const view = render(
      <KeywordWorkspace projectId="project-1" view="search-performance" />
    )

    await screen.findByText("连接 Google Search Console")
    expect(settingsApi.getGSCPerformance).not.toHaveBeenCalled()
    view.unmount()
    keywordQueryClient.clear()

    settingsApi.getGSCConnection.mockResolvedValue({
      oauthConfigured: true,
      grantConnected: true,
      propertyConnected: true,
      siteUrl: "sc-domain:example.com",
      connectedAccountEmail: "owner@example.com",
      requiresReconnect: false,
    })
    render(<KeywordWorkspace projectId="project-1" view="search-performance" />)

    expect(await screen.findByText("Google 搜索表现")).toBeTruthy()
    expect(await screen.findByText("solar panels")).toBeTruthy()
    expect(screen.getByText("1,600")).toBeTruthy()
    expect(
      screen.getByRole("combobox", { name: "设备筛选" }).textContent
    ).toContain("全部设备")
    expect(
      screen.getByRole("combobox", { name: "国家筛选" }).textContent
    ).toContain("全部国家")
    expect(
      screen.getByRole("combobox", { name: "时间范围" }).textContent
    ).toContain("最近 28 天")
    expect(settingsApi.getGSCPerformance).toHaveBeenCalledWith("project-1", {
      dateRange: "last_28_days",
    })
    expect(keywordApi.getKeywordStatus).not.toHaveBeenCalled()
  })

  it("重复进入搜索表现时直接使用缓存数据", async () => {
    const firstView = render(
      <KeywordWorkspace projectId="project-1" view="search-performance" />
    )

    expect(await screen.findByText("Google 搜索表现")).toBeTruthy()
    firstView.unmount()
    render(<KeywordWorkspace projectId="project-1" view="search-performance" />)

    expect(await screen.findByText("Google 搜索表现")).toBeTruthy()
    expect(settingsApi.getGSCConnection).toHaveBeenCalledTimes(1)
    expect(settingsApi.getGSCPerformance).toHaveBeenCalledTimes(1)
  })

  it("搜索表现按 OpenSEO 展示提升机会、查询与关键词保存操作", async () => {
    render(<KeywordWorkspace projectId="project-1" view="search-performance" />)

    expect(await screen.findByText("提升机会（1）")).toBeTruthy()
    expect(screen.getByText("https://example.com/solar-panels")).toBeTruthy()
    expect(screen.getByText("+33.3%")).toBeTruthy()

    fireEvent.click(screen.getByRole("tab", { name: "搜索查询" }))
    expect(
      await screen.findByRole("columnheader", { name: "查询" })
    ).toBeTruthy()
    expect(settingsApi.getGSCPerformanceTable).toHaveBeenCalledWith(
      "project-1",
      {
        dateRange: "last_28_days",
        dimension: "query",
        page: 1,
        pageSize: 25,
      }
    )

    fireEvent.click(screen.getByRole("tab", { name: "提升机会（1）" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 solar panels" }))
    fireEvent.click(screen.getByRole("button", { name: "保存到关键词库" }))
    await waitFor(() => {
      expect(keywordApi.saveGSCKeywords).toHaveBeenCalledWith("project-1", [
        "solar panels",
      ])
    })
    expect(await screen.findByText(/已保存 1 个关键词/)).toBeTruthy()
  })

  it("提升机会使用独立的 50 条分页并全选全部已加载结果", async () => {
    settingsApi.getGSCPerformance.mockResolvedValue({
      ...performanceReport,
      strikingDistance: Array.from({ length: 60 }, (_, index) => ({
        query: `query-${index}`,
        page: `https://example.com/page-${index}`,
        clicks: index,
        impressions: 1000 - index,
        position: 6 + index / 100,
      })),
    })

    render(<KeywordWorkspace projectId="project-1" view="search-performance" />)

    await screen.findByText("query-0")
    expect(
      screen.getByRole("combobox", { name: "每页数量" }).textContent
    ).toContain("50")
    expect(screen.getByText("1–50，共 60")).toBeTruthy()
    expect(screen.getByText("第 1 页，共 2 页")).toBeTruthy()
    expect(screen.queryByText("query-50")).toBeNull()

    fireEvent.click(screen.getByRole("checkbox", { name: "选择全部提升机会" }))
    expect(await screen.findByText("已选择 60 个查询")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "下一页" }))
    expect(await screen.findByText("query-50")).toBeTruthy()
    expect(screen.getByText("51–60，共 60")).toBeTruthy()
    expect(screen.getByText("已选择 60 个查询")).toBeTruthy()
  })

  it("提升机会支持 Shift 连续选择", async () => {
    settingsApi.getGSCPerformance.mockResolvedValue({
      ...performanceReport,
      strikingDistance: Array.from({ length: 5 }, (_, index) => ({
        query: `range-${index}`,
        page: `https://example.com/range-${index}`,
        clicks: index,
        impressions: 100 - index,
        position: 6 + index,
      })),
    })

    render(<KeywordWorkspace projectId="project-1" view="search-performance" />)

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "选择 range-0" })
    )
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 range-3" }), {
      shiftKey: true,
    })

    expect(await screen.findByText("已选择 4 个查询")).toBeTruthy()
  })

  it("提升机会为空时显示说明且不显示分页", async () => {
    settingsApi.getGSCPerformance.mockResolvedValue({
      ...performanceReport,
      strikingDistance: [],
    })

    render(<KeywordWorkspace projectId="project-1" view="search-performance" />)

    expect(
      await screen.findByText(/当前周期没有排名第 5–20 位的提升机会/)
    ).toBeTruthy()
    expect(screen.queryByRole("combobox", { name: "每页数量" })).toBeNull()
  })

  it("查询表读取失败时不显示分页", async () => {
    settingsApi.getGSCPerformanceTable.mockRejectedValue(
      new ApiError(502, "Google Search Console 暂时不可用")
    )

    render(<KeywordWorkspace projectId="project-1" view="search-performance" />)

    fireEvent.click(await screen.findByRole("tab", { name: "搜索查询" }))
    expect(
      await screen.findByText("Google Search Console 暂时不可用", undefined, {
        timeout: 2500,
      })
    ).toBeTruthy()
    expect(screen.queryByRole("combobox", { name: "每页数量" })).toBeNull()
  })

  it("GSC 授权失效后立即切换到重新连接提示", async () => {
    settingsApi.getGSCConnection
      .mockResolvedValueOnce({
        oauthConfigured: true,
        grantConnected: true,
        propertyConnected: true,
        siteUrl: "sc-domain:example.com",
        connectedAccountEmail: "owner@example.com",
        requiresReconnect: false,
      })
      .mockResolvedValue({
        oauthConfigured: true,
        grantConnected: true,
        propertyConnected: false,
        siteUrl: "sc-domain:example.com",
        connectedAccountEmail: "owner@example.com",
        requiresReconnect: true,
      })
    settingsApi.getGSCPerformance.mockRejectedValue(
      new ApiError(409, "Search Console 授权已失效，请重新连接")
    )

    render(<KeywordWorkspace projectId="project-1" view="search-performance" />)

    expect(await screen.findByText("连接 Google Search Console")).toBeTruthy()
    expect(settingsApi.getGSCConnection).toHaveBeenCalledTimes(2)
  })

  it("竞争分析完成后自动刷新竞品和机会结果", async () => {
    keywordApi.getCompetitorAnalysisStatus
      .mockResolvedValueOnce(null)
      .mockResolvedValue(queuedCompetitorRun)
    render(<KeywordWorkspace projectId="project-1" view="competitor-gap" />)

    await screen.findByText("竞争对手")
    const autoButton = screen.getByRole("button", { name: "分析竞争对手" })
    await waitFor(() => expect(autoButton.hasAttribute("disabled")).toBe(false))
    fireEvent.click(autoButton)
    await waitFor(() => {
      expect(keywordApi.startCompetitorAnalysis).toHaveBeenCalledWith(
        "project-1",
        { mode: "auto" }
      )
    })
    expect(await screen.findByText("分析竞争对手（0/5）")).toBeTruthy()
    expect(screen.getByText("竞争分析已进入队列")).toBeTruthy()
    expect(screen.getAllByText("竞争分析已进入队列")).toHaveLength(1)
    expect(screen.getByText("0%")).toBeTruthy()

    const competitorCalls = keywordApi.listKeywordCompetitors.mock.calls.length
    const opportunityCalls =
      keywordApi.listKeywordCompetitorOpportunities.mock.calls.length
    const finishedRun = {
      ...queuedCompetitorRun,
      status: "completed" as const,
      stage: "completed",
      message: "竞争分析已完成",
      progress: 100,
      completedCompetitors: 5,
      finishedAt: "2026-08-04T00:01:00Z",
    }
    await act(async () => {
      keywordQueryClient.setQueryData(
        keywordQueryKeys.competitorStatus("project-1"),
        finishedRun
      )
    })

    await waitFor(() => {
      expect(screen.queryByText("竞争分析已进入队列")).toBeNull()
      expect(
        keywordApi.listKeywordCompetitors.mock.calls.length
      ).toBeGreaterThan(competitorCalls)
      expect(
        keywordApi.listKeywordCompetitorOpportunities.mock.calls.length
      ).toBeGreaterThan(opportunityCalls)
    })
  })

  it("指标更新期间只展示用户需要的信息并继续读取状态", async () => {
    vi.useFakeTimers()
    keywordApi.getKeywordStatus
      .mockResolvedValueOnce({
        ...completedStatus,
        pendingMetricsCount: 2,
      } satisfies KeywordLibraryStatus)
      .mockResolvedValue(completedStatus)
    const view = render(<KeywordWorkspace projectId="project-1" />)

    try {
      await act(async () => undefined)
      expect(keywordApi.getKeywordStatus).toHaveBeenCalledTimes(1)
      expect(screen.getByRole("status").textContent).toContain(
        "部分关键词指标正在更新"
      )
      expect(screen.queryByText(/Google Ads 补充/)).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000)
      })
      expect(keywordApi.getKeywordStatus).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })

  it("页面隐藏时暂停指标状态轮询并在返回时立即刷新", async () => {
    vi.useFakeTimers()
    let visibilityState: DocumentVisibilityState = "visible"
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibilityState)
    keywordApi.getKeywordStatus.mockResolvedValue({
      ...completedStatus,
      pendingMetricsCount: 2,
    } satisfies KeywordLibraryStatus)
    const view = render(<KeywordWorkspace projectId="project-1" />)

    try {
      await act(async () => undefined)
      expect(keywordApi.getKeywordStatus).toHaveBeenCalledTimes(1)

      visibilityState = "hidden"
      document.dispatchEvent(new Event("visibilitychange"))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60000)
      })
      expect(keywordApi.getKeywordStatus).toHaveBeenCalledTimes(1)

      visibilityState = "visible"
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"))
      })
      expect(keywordApi.getKeywordStatus).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
      visibility.mockRestore()
      vi.useRealTimers()
    }
  })

  it("支持搜索量和难度高级筛选", async () => {
    render(<KeywordWorkspace projectId="project-1" />)

    expect(await screen.findByText("solar panel installation")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /^筛选/ }))
    fireEvent.change(screen.getByLabelText("最低月搜索量"), {
      target: { value: "500" },
    })
    fireEvent.change(screen.getByLabelText("最高关键词难度"), {
      target: { value: "40" },
    })

    await vi.waitFor(() => {
      expect(keywordApi.listKeywords).toHaveBeenLastCalledWith(
        "project-1",
        expect.objectContaining({ minVolume: 500, maxDifficulty: 40 })
      )
    })
  })

  it("点击关键词打开指标详情", async () => {
    render(<KeywordWorkspace projectId="project-1" />)

    const keyword = await screen.findByRole("button", {
      name: "solar panel installation",
    })
    fireEvent.click(keyword)

    expect(await screen.findByText("关键词指标、趋势、来源和标签")).toBeTruthy()
    expect(screen.getByText("关键词难度")).toBeTruthy()
    expect(screen.getByText("加入词库")).toBeTruthy()
    expect(screen.getAllByText("来源").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Google Ads").length).toBeGreaterThan(0)
    expect(screen.queryByText("Google Ads 补充")).toBeNull()
    expect(screen.queryByText("数据状态")).toBeNull()
  })

  it("只在初次建库中显示进度，不提前读取关键词列表", async () => {
    keywordApi.getKeywordStatus.mockResolvedValue({
      run: {
        ...completedRun,
        status: "running",
        stage: "seed_ai_ranking",
        message: "正在分析关键词",
        progress: 32,
        resultVersion: 0,
      },
      totalKeywords: 0,
      activeKeywords: 0,
      pendingMetricsCount: 0,
      resultVersion: 0,
    } satisfies KeywordLibraryStatus)

    render(<KeywordWorkspace projectId="project-1" />)

    expect(await screen.findByText("正在为当前网站创建关键词库")).toBeTruthy()
    expect(screen.getByText("正在分析关键词")).toBeTruthy()
    expect(keywordApi.listKeywords).not.toHaveBeenCalled()
    expect(screen.queryByText(/备用种子/)).toBeNull()
    expect(screen.queryByRole("button", { name: /扩展下一批/ })).toBeNull()
  })

  it("任务完成后先读取对应结果版本，成功后才显示已完成", async () => {
    let resolveList: ((value: KeywordListResult) => void) | undefined
    keywordApi.listKeywords.mockReturnValue(
      new Promise<KeywordListResult>((resolve) => {
        resolveList = resolve
      })
    )

    render(<KeywordWorkspace projectId="project-1" />)

    expect(
      await screen.findByText("任务已完成，正在读取关键词数据")
    ).toBeTruthy()
    expect(screen.queryByText("已完成")).toBeNull()

    resolveList?.(keywordResult)

    expect(await screen.findByText("solar panel installation")).toBeTruthy()
    expect(screen.queryByText("业务主题")).toBeNull()
    expect(screen.queryByText("优先级")).toBeNull()
    expect(screen.getByText("已完成")).toBeTruthy()
    expect(keywordApi.listKeywords).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        page: 1,
        pageSize: 50,
        sort: "search_volume",
      })
    )
    expect(keywordApi.listKeywords).toHaveBeenCalledWith(
      "project-1",
      expect.not.objectContaining({
        source: expect.anything(),
        metricsStatus: expect.anything(),
      })
    )
    expect(screen.getByText("来源")).toBeTruthy()
    expect(screen.getByText("Google Ads")).toBeTruthy()
    expect(screen.queryByText("Google Ads 补充")).toBeNull()
    expect(screen.queryByText("数据")).toBeNull()
    expect(screen.getByRole("columnheader", { name: "趋势" })).toBeTruthy()
  })

  it("后台结果版本更新后绕过旧列表缓存并自动展示关键词", async () => {
    keywordQueryClient.setQueryData(
      keywordQueryKeys.libraryList("project-1", DEFAULT_KEYWORD_LIBRARY_QUERY),
      {
        ...keywordResult,
        items: [],
        total: 0,
        resultVersion: 0,
      } satisfies KeywordListResult
    )

    render(<KeywordWorkspace projectId="project-1" />)

    expect(await screen.findByText("solar panel installation")).toBeTruthy()
    expect(keywordApi.listKeywords).toHaveBeenCalledTimes(1)
  })

  it("有分析结果时按竞品信息层级展示摘要、竞品和关键词差距", async () => {
    const analysisRun = {
      runId: "competitor-run-1",
      targetDomain: "example.com",
      country: "US",
      language: "en",
      mode: "auto" as const,
      requestedCompetitorDomains: [],
      discoveryMethod: "serp_competitors" as const,
      discoveryKeywords: ["solar panels", "solar installation"],
      discoveryResultTypes: [],
      discoveryIncludeSubdomains: null,
      discoverySort: "traffic_estimate" as const,
      discoveryLimit: 50,
      discoveryOffset: 0,
      gscQueryEvidence: [
        {
          query: "solar panels",
          clicks: 120,
          impressions: 1200,
          ctr: 0.1,
          position: 5.4,
          intent: "commercial",
          selection_reason: "Core commercial query",
          search_volume: 5400,
          keyword_difficulty: 48,
          cpc: 3.5,
          monthly_searches: [{ year: 2026, month: 7, search_volume: 5400 }],
        },
        { query: "solar installation" },
      ],
      queryMetrics: [],
      serpSnapshots: [
        { keyword: "solar panels", ok: true, items: [] },
        {
          keyword: "solar installation",
          ok: false,
          error_code: "dataforseo_serp_unavailable",
          error: "SERP service unavailable",
        },
      ],
      costBreakdown: { serp_competitors: 0.0126 },
      landscapeSummary: {
        market_read: "Solar SERPs are led by established specialists.",
        market_leaders: [
          { domain: "competitor.example", why: "Ranks across the query set." },
        ],
        most_winnable_opportunity: "Commercial comparison content",
        biggest_barrier: "Authority",
        content_formats: ["Comparison pages"],
        winning_themes: ["Installation costs"],
        keyword_theme_gaps: ["Buyer calculators"],
        backlink_authority_observations: [
          "Leader has stronger referring domains",
        ],
        competitor_findings: [
          {
            domain: "competitor.example",
            type: "direct_product_competitor",
            why_they_matter: "Ranks across the representative query set.",
            organic_footprint:
              "1,200 organic keywords; estimated traffic 9,000",
            winning_themes: ["Installation costs"],
            weakness_gap: "Limited buyer calculator coverage",
          },
        ],
        recommended_workflows: ["competitor_analysis"],
      },
      directionalResult: false,
      marketSummary: "Solar SERPs are led by established specialists.",
      status: "completed" as const,
      stage: "completed",
      message: "竞争分析已完成",
      progress: 100,
      competitorLimit: 5,
      keywordLimit: 100,
      discoveredCount: 5,
      analyzedCompetitorCount: 5,
      completedCompetitors: 5,
      failedCompetitors: 0,
      rawKeywordCount: 500,
      uniqueKeywordCount: 320,
      discoveryCostUsd: 0.0126,
      totalCostUsd: 0.1326,
      errorCode: null,
      recoveryCount: 0,
      startedAt: "2026-08-04T00:00:00Z",
      finishedAt: "2026-08-04T00:01:00Z",
      createdAt: "2026-08-04T00:00:00Z",
    }
    keywordApi.getCompetitorAnalysisStatus.mockResolvedValue(analysisRun)
    keywordApi.listCompetitorAnalysisRuns.mockResolvedValue([analysisRun])
    keywordApi.listKeywordCompetitors.mockResolvedValue({
      runId: analysisRun.runId,
      items: [
        {
          id: "competitor-1",
          domain: "competitor.example",
          providerRank: 1,
          avgPosition: 8.2,
          medianPosition: 7,
          rating: 24,
          etv: 9000,
          keywordsCount: 4,
          visibility: 12.5,
          relevantSerpItems: 6,
          keywordsPositions: { "1": 1, "2_3": 2 },
          domainType: "direct_product_competitor",
          isSeoCompetitor: true,
          isBusinessCompetitor: true,
          classificationConfidence: 0.9,
          whyTheyMatter: "Ranks across the representative query set.",
          serpEvidence: [],
          domainOverview: { organic_keywords: 1200, organic_traffic: 9000 },
          rankedKeywordsEvidence: [],
          rankedKeywordsEvidenceCount: 0,
          rankedKeywordsChecked: true,
          backlinksEvidence: {},
          selectedForGap: true,
          siteCheckStatus: "verified",
          siteRelation: "related",
          siteVerification: { final_domain: "competitor.example" },
          intersections: 500,
          organicKeywords: 1200,
          organicTraffic: 9000,
          status: "completed",
          keywordCount: 100,
          costUsd: 0.024,
          errorCode: null,
          errorDetail: null,
        },
      ],
    })
    const opportunityResult = {
      runId: analysisRun.runId,
      analyzedAt: analysisRun.finishedAt,
      items: [
        {
          id: "opportunity-1",
          keyword: "commercial solar panels",
          normalizedKeyword: "commercial solar panels",
          bestCompetitorRank: 6,
          competitorCount: 2,
          opportunityScore: 78.4,
          searchVolume: 1300,
          cpc: 4.1,
          competition: 0.78,
          competitionLevel: "HIGH",
          keywordDifficulty: 48,
          intent: "commercial",
          monthlySearches: [],
          metricsFetchedAt: "2026-08-04T00:00:30Z",
          status: "new",
          keywordId: null,
          inLibrary: false,
          analyzedAt: "2026-08-04T00:01:00Z",
          updatedAt: "2026-08-04T00:01:00Z",
          rankings: [
            {
              competitorId: "competitor-1",
              domain: "competitor.example",
              rank: 6,
              url: "https://competitor.example/solar",
            },
          ],
        },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    }
    keywordApi.listKeywordCompetitorOpportunities.mockResolvedValue(
      opportunityResult
    )

    render(<KeywordWorkspace projectId="project-1" view="competitor-gap" />)

    expect(await screen.findByText("所有竞争对手")).toBeTruthy()
    expect(screen.getByText("分析于 2026/08/04")).toBeTruthy()
    expect(screen.getByRole("button", { name: "重新分析" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "手动添加" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "添加竞争对手" })).toBeNull()
    expect(
      screen.getAllByText("1", { selector: "[data-slot='metric-value']" })
    ).toHaveLength(3)
    expect(
      screen.getByText("1,300", { selector: "[data-slot='metric-value']" })
    ).toBeTruthy()
    expect(screen.getByText("关键词")).toBeTruthy()
    expect(screen.getByText("/月")).toBeTruthy()
    expect(screen.getByText("所有竞争对手")).toBeTruthy()
    expect(screen.getByText("内容差距")).toBeTruthy()
    expect(screen.queryByText("市场判断")).toBeNull()
    expect(screen.queryByRole("button", { name: "分析历史" })).toBeNull()
    expect(screen.getAllByText("competitor.example").length).toBeGreaterThan(1)
    expect(screen.getByText("月流量 9,000")).toBeTruthy()
    expect(screen.getByRole("tab", { name: "全部" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "高机会" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "快速取胜" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "未覆盖" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "关键词" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "搜索量" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "难度" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "CPC" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "机会分" })).toBeTruthy()
    expect(screen.getByRole("columnheader", { name: "排名竞品" })).toBeTruthy()
    expect(screen.queryByRole("columnheader", { name: "意图" })).toBeNull()
    expect(screen.queryByRole("columnheader", { name: "竞争度" })).toBeNull()
    expect(screen.queryByRole("columnheader", { name: "最佳排名" })).toBeNull()
    expect(screen.queryByRole("columnheader", { name: "状态" })).toBeNull()
    expect(screen.queryByRole("button", { name: "筛选" })).toBeNull()
    expect(await screen.findByText("commercial solar panels")).toBeTruthy()
    expect(screen.getByText("$4.10")).toBeTruthy()
    expect(screen.getByText("78")).toBeTruthy()
    expect(
      screen.getByRole("checkbox", { name: "选择 commercial solar panels" })
    ).toBeTruthy()
  })

  it("竞争支线失败时主关键词库仍显示已完成", async () => {
    keywordApi.getKeywordStatus.mockResolvedValue({
      ...completedStatus,
      run: {
        ...completedRun,
        status: "partial",
        stage: "partial",
        message: "关键词库已建立，竞争对手分析未完成",
        gapStatus: "failed",
        gapMessage: "竞争对手分析暂时未完成",
      },
    } satisfies KeywordLibraryStatus)

    render(<KeywordWorkspace projectId="project-1" />)

    expect(await screen.findByText("solar panel installation")).toBeTruthy()
    expect(screen.getByText("已完成")).toBeTruthy()
    expect(screen.queryByText("部分完成")).toBeNull()
    expect(screen.queryByText("竞争对手机会缺口")).toBeNull()
    expect(keywordApi.getCompetitorAnalysisStatus).not.toHaveBeenCalled()
  })

  it("等待恢复时持续显示后台恢复状态，不要求用户重建", async () => {
    keywordApi.getKeywordStatus.mockResolvedValue({
      run: {
        ...completedRun,
        status: "waiting",
        stage: "waiting_for_recovery",
        message: "服务暂时不可用，稍后自动继续",
        progress: 42,
        keywordCount: 0,
        resultVersion: 0,
        recoveryCount: 1,
        nextRetryAt: "2026-07-27T00:04:00Z",
      },
      totalKeywords: 0,
      activeKeywords: 0,
      pendingMetricsCount: 0,
      resultVersion: 0,
    } satisfies KeywordLibraryStatus)

    render(<KeywordWorkspace projectId="project-1" />)

    expect(await screen.findByText("后台自动恢复中")).toBeTruthy()
    expect(
      screen.getByText("已保存当前进度，服务恢复后会自动继续")
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "重新创建" })).toBeNull()
    expect(keywordApi.listKeywords).not.toHaveBeenCalled()
  })

  it("历史失败且没有数据时如实显示中断状态", async () => {
    keywordApi.getKeywordStatus.mockResolvedValue({
      run: {
        ...completedRun,
        status: "failed",
        stage: "failed",
        message: "旧任务已中断",
        progress: 8,
        keywordCount: 0,
        resultVersion: 0,
      },
      totalKeywords: 0,
      activeKeywords: 0,
      pendingMetricsCount: 0,
      resultVersion: 0,
    } satisfies KeywordLibraryStatus)

    render(<KeywordWorkspace projectId="project-1" />)

    expect(await screen.findByText("暂时无法生成关键词库")).toBeTruthy()
    expect(screen.getByText("旧任务已中断")).toBeTruthy()
    const retry = screen.getByRole("button", { name: "重新创建" })
    retry.click()
    await vi.waitFor(() => {
      expect(keywordApi.retryKeywordBuild).toHaveBeenCalledWith("project-1")
    })
    expect(screen.queryByText("后台自动恢复中")).toBeNull()
  })

  it("已有关键词时忽略遗留附加任务失败并继续显示完成结果", async () => {
    keywordApi.getKeywordStatus.mockResolvedValue({
      ...completedStatus,
      run: {
        ...completedRun,
        status: "failed",
        stage: "failed",
        message: "附加任务暂时未完成",
      },
    } satisfies KeywordLibraryStatus)

    render(<KeywordWorkspace projectId="project-1" />)

    expect(await screen.findByText("solar panel installation")).toBeTruthy()
    expect(screen.getByText("已完成")).toBeTruthy()
    expect(screen.queryByText("附加任务暂时未完成")).toBeNull()
  })
})
