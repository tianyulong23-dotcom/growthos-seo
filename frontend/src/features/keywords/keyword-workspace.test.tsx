import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  KeywordBuildRun,
  KeywordLibraryStatus,
  KeywordListResult,
} from "@/api/keywords"
import { KeywordWorkspace } from "@/features/keywords/keyword-workspace"

const keywordApi = vi.hoisted(() => ({
  assignKeywordTags: vi.fn(),
  getKeywordStatus: vi.fn(),
  listKeywordCompetitorGaps: vi.fn(),
  listKeywords: vi.fn(),
  retryKeywordBuild: vi.fn(),
  updateKeywordStatus: vi.fn(),
}))

vi.mock("@/api/keywords", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/keywords")>()),
  ...keywordApi,
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

beforeEach(() => {
  vi.clearAllMocks()
  keywordApi.getKeywordStatus.mockResolvedValue(completedStatus)
  keywordApi.listKeywords.mockResolvedValue(keywordResult)
  keywordApi.listKeywordCompetitorGaps.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 50,
  })
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

  it("竞争对手验证通过后展示独立的关键词差距结果", async () => {
    keywordApi.getKeywordStatus.mockResolvedValue({
      ...completedStatus,
      run: {
        ...completedRun,
        gapStatus: "confirmed",
        gapMessage: "已确认竞争对手",
        gapCount: 1,
      },
    } satisfies KeywordLibraryStatus)
    keywordApi.listKeywordCompetitorGaps.mockResolvedValue({
      items: [
        {
          id: "gap-1",
          competitorDomain: "competitor.example",
          keyword: "commercial solar panels",
          competitorRank: 6,
          searchVolume: 1300,
          cpc: 4.1,
          competition: 0.78,
          keywordDifficulty: 48,
          intent: "commercial",
          monthlySearches: [],
          relevance: 0.9,
          status: "active",
          createdAt: "2026-07-27T00:03:00Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    })

    render(<KeywordWorkspace projectId="project-1" />)

    expect(await screen.findByText("竞争对手关键词差距")).toBeTruthy()
    expect(await screen.findByText("commercial solar panels")).toBeTruthy()
    expect(keywordApi.listKeywordCompetitorGaps).toHaveBeenCalledWith(
      "project-1",
      1,
      50
    )
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
    expect(screen.getByText("竞争对手：竞争对手分析暂时未完成")).toBeTruthy()
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
