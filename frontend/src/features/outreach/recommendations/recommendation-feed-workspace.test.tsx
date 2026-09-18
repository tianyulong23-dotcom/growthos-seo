import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { OutreachProject } from "@/features/outreach/project"

import {
  confirmRecommendationSeeds,
  createRecommendationFeedOpportunity,
  generateRecommendationPool,
  getMoreRecommendationFeed,
  previewRecommendationSeeds,
  publishInitialRecommendationFeed,
  setRecommendationFeedItemArchived,
  type RecommendationFeedResponse,
  type RecommendationSeedConfirmationResponse,
  type RecommendationSeedPreviewResponse,
  type RecommendationFeedStatus,
} from "./recommendation-feed-api"
import {
  invalidateRecommendationFeed,
  invalidateRecommendationOpportunityCaches,
} from "./recommendation-feed-cache"
import { RecommendationFeedWorkspace } from "./recommendation-feed-workspace"
import {
  useRecommendationFeed,
  useRecommendationFeedStatus,
} from "./use-recommendation-feed"

vi.mock("./use-recommendation-feed", () => ({
  useRecommendationFeed: vi.fn(),
  useRecommendationFeedStatus: vi.fn(),
}))

vi.mock("./recommendation-feed-api", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./recommendation-feed-api")>()
  return {
    ...original,
    observeRecommendationFeed: vi.fn().mockResolvedValue({ recorded: true }),
    confirmRecommendationSeeds: vi.fn(),
    createRecommendationFeedOpportunity: vi.fn(),
    exportRecommendationFeed: vi.fn(),
    generateRecommendationPool: vi.fn(),
    getMoreRecommendationFeed: vi.fn(),
    previewRecommendationSeeds: vi.fn(),
    publishInitialRecommendationFeed: vi.fn(),
    setRecommendationFeedItemArchived: vi.fn(),
  }
})

vi.mock("./recommendation-feed-cache", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./recommendation-feed-cache")>()
  return {
    ...original,
    invalidateRecommendationFeed: vi.fn(),
    invalidateRecommendationOpportunityCaches: vi.fn(),
  }
})

const project: OutreachProject = {
  id: "project-a",
  name: "Project A",
  domain: "project-a.example",
  language: "zh",
  contextVersion: 7,
  targetUrls: [],
  suggestedTopics: [],
  suggestedTargetUrls: [],
  profileVersion: 3,
  inputRequired: [],
}

const response: RecommendationFeedResponse & {
  latestGeneration: NonNullable<RecommendationFeedResponse["latestGeneration"]>
} = {
  items: [
    {
      itemId: "00000000-0000-4000-8000-000000000001",
      domain: "publisher.example",
      displayUrl: "https://publisher.example/",
      recommended: true,
      reasons: ["受众与项目匹配"],
      category: "Editorial",
      metrics: {
        targetMarketOrganicTraffic: null,
        dataForSeoRank: null,
        spamScore: null,
      },
      contact: {
        email: null,
        contactPage: "https://publisher.example/contact",
        outcome: "CONTACT_PAGE_FOUND",
      },
      opportunity: {
        opportunityId: null,
        businessStage: null,
        managementStatus: null,
        outcomeStatus: null,
        createdByCurrentUser: false,
      },
      archived: false,
      releasedAt: "2026-08-31T00:00:00.000Z",
    },
  ],
  releasedPool: {
    generationCount: 2,
    oldestVisiblePoolGeneration: 1,
    newestVisiblePoolGeneration: 2,
    filterOptions: {
      batches: [{
        batchId: "00000000-0000-4000-8000-000000000101",
        batchOrdinal: 1,
        visiblePoolGeneration: 2,
        releasedAt: "2026-08-31T00:00:00.000Z",
        count: 1,
      }],
      categories: ["Editorial"],
      hasUncategorized: true,
    },
  },
  latestGeneration: {
    generationContractId: "00000000-0000-4000-8000-000000000021",
    visiblePoolGeneration: 3,
    jobState: "RUNNING",
    progress: 45,
    discoveryResult: "IN_PROGRESS",
    contactPreparation: "PENDING",
    releaseResult: "PENDING",
    effectiveUniqueCandidateCount: 12,
    admittedCount: 0,
    releasedCount: 0,
    terminalReason: null,
    retrySafe: false,
  },
  totalCount: 1,
  nextCursor: "cursor-2",
  meta: {
    organizationId: "organization-1",
    workspaceId: "workspace-1",
    websiteProjectId: "project-1",
    requestId: "request-1",
    schemaVersion: "backlinks.recommendation-feed.v2",
    generatedAt: "2026-08-31T00:00:00.000Z",
  },
}

const completedResponse: typeof response = {
  ...response,
  latestGeneration: {
    ...response.latestGeneration,
    jobState: "SUCCESS",
    progress: 100,
    discoveryResult: "COMPLETED",
    contactPreparation: "COMPLETED",
    releaseResult: "RELEASED",
    admittedCount: 8,
    releasedCount: 5,
  },
}

const seedMeta = {
  organizationId: "organization-1",
  workspaceId: "workspace-1",
  websiteProjectId: "project-1",
  requestId: "seed-request",
  schemaVersion: "backlinks.recommendation-seeds.v2" as const,
  generatedAt: "2026-08-31T00:00:00.000Z",
}

function previewSeed(
  kind: "KEYWORD" | "CATEGORY" | "SEO_COMPETITOR",
  rawValue: string,
  fingerprintCharacter: string
) {
  return {
    kind,
    rawValue,
    normalizedValue: rawValue.toLowerCase(),
    source: "USER_TRIGGERED_GENERATION" as const,
    validationStatus: "VERIFIED" as const,
    validationReasonCodes: [],
    evidenceRefs: [
      {
        evidenceType: "PROJECT_CONTEXT" as const,
        recordId: "project-1",
        field: "keywords",
      },
    ],
    confidenceBand: "HIGH" as const,
    seedFingerprint: fingerprintCharacter.repeat(64),
    supersedesSeedId: null,
  }
}

const previewResponse: RecommendationSeedPreviewResponse = {
  state: "READY",
  reasonCodes: [],
  seeds: [
    previewSeed("KEYWORD", "email outreach", "a"),
    previewSeed("CATEGORY", "SaaS", "b"),
    previewSeed("SEO_COMPETITOR", "competitor.example", "c"),
  ],
  blueprintSeedReferences: [
    { seedFingerprint: "a".repeat(64), seedOrdinal: 1 },
    { seedFingerprint: "b".repeat(64), seedOrdinal: 2 },
    { seedFingerprint: "c".repeat(64), seedOrdinal: 3 },
  ],
  meta: seedMeta,
}

const confirmationResponse: RecommendationSeedConfirmationResponse = {
  state: "READY",
  replayed: false,
  reasonCodes: [],
  confirmation: {
    generationContractId: "00000000-0000-4000-8000-000000000031",
    seedSnapshotFingerprint: "d".repeat(64),
  },
  snapshot: {
    projectContextSnapshotId: "00000000-0000-4000-8000-000000000041",
    projectContextSnapshotVersion: 1,
    canonicalDomain: "project-a.example",
    locale: "zh-CN",
    countryCode: "CN",
    siteProfileVersionId: "site-profile-1",
    outreachProfileVersionId: "outreach-profile-1",
    outreachProfileFingerprint: "e".repeat(64),
    promotionTargetVersionId: "promotion-1",
    market: "CN",
    location: "China",
    language: "zh",
    keywords: ["email outreach"],
    categories: ["SaaS"],
    products: [],
    targetAudiences: [],
    seoCompetitors: ["competitor.example"],
  },
  seeds: previewResponse.seeds.map((seed, index) => ({
    ...seed,
    id: `00000000-0000-4000-8000-${String(index + 51).padStart(12, "0")}`,
  })),
  blueprintSeedReferences: previewResponse.seeds.map((seed, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 61).padStart(12, "0")}`,
    blueprintId: "00000000-0000-4000-8000-000000000071",
    seedId: `00000000-0000-4000-8000-${String(index + 51).padStart(12, "0")}`,
    seedFingerprint: seed.seedFingerprint,
    seedOrdinal: index + 1,
  })),
  meta: seedMeta,
}

const status: RecommendationFeedStatus = {
  state: "PUBLISHED",
  currentBatchOrdinal: 1,
  requiredOpportunityCount: 1,
  successfulOpportunityCount: 1,
  unlockAt: "2026-08-31T18:00:00.000Z",
  unlockReason: "OPPORTUNITY_RATIO",
  canGetMore: true,
  getMoreState: "RELEASE_NEXT",
  meta: {
    organizationId: "organization-1",
    workspaceId: "workspace-1",
    websiteProjectId: "project-1",
    requestId: "request-status",
    schemaVersion: "backlinks.recommendation-user-release.v2",
    generatedAt: "2026-08-31T00:00:00.000Z",
  },
}

const refreshFeed = vi.fn().mockResolvedValue(response)
const refreshStatus = vi.fn().mockResolvedValue(status)
const useFeedMock = vi.mocked(useRecommendationFeed)
const useStatusMock = vi.mocked(useRecommendationFeedStatus)

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  refreshFeed.mockResolvedValue(response)
  refreshStatus.mockResolvedValue(status)
})

function renderWorkspace(feedResponse: RecommendationFeedResponse = response, openSeedEditor = true) {
  useFeedMock.mockReturnValue({
    response: feedResponse,
    state: "data",
    refresh: refreshFeed,
    poll: refreshFeed,
  })
  useStatusMock.mockReturnValue({
    status,
    state: "data",
    refresh: refreshStatus,
    poll: refreshStatus,
  })
  const view = render(<RecommendationFeedWorkspace project={project} />)
  if (openSeedEditor) {
    fireEvent.click(screen.getByRole("button", { name: "新建推荐池" }))
  }
  return view
}

describe("RecommendationFeedWorkspace", () => {
  it.each([
    ["CONTACT_FORM_ONLY", "仅找到联系表单"],
    ["COMPLETED_PARTIAL", "联系信息检查未完整完成"],
    ["MANUAL_REVIEW_REQUIRED", "联系信息需要人工核查"],
    ["LOGIN_REQUIRED", "需要登录才能查看"],
    ["UNKNOWN", "联系信息状态待确认"],
  ])("does not present %s as a completed no-email search", (outcome, label) => {
    renderWorkspace({
      ...completedResponse,
      items: [{
        ...response.items[0]!,
        recommended: false,
        reasons: ["RELEVANCE_EVIDENCE_MISSING"],
        contact: { email: null, contactPage: null, outcome },
      }],
    }, false)
    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.getByText("尚未确认与项目的相关性")).toBeTruthy()
    expect(screen.queryByText("未找到公开邮箱")).toBeNull()
    expect(screen.queryByText("其他推荐依据")).toBeNull()
  })

  it("distinguishes historical results from the current unpublished generation", () => {
    renderWorkspace({
      ...response,
      latestGeneration: { ...response.latestGeneration, contactPreparation: "IN_PROGRESS" },
    }, false)
    const status = screen.getByRole("status", { name: "本轮推荐发布状态" })
    expect(within(status).getByText(/第 3 轮尚未发布/)).toBeTruthy()
    expect(within(status).getByText(/下方仍是历史已发布结果/)).toBeTruthy()
    expect(screen.getByText("候选网站")).toBeTruthy()
    expect(screen.queryByText("已入推荐池")).toBeNull()
    expect(generateRecommendationPool).not.toHaveBeenCalled()
  })

  it("does not label partially released current results as history", () => {
    renderWorkspace({
      ...response,
      latestGeneration: { ...response.latestGeneration, releasedCount: 1 },
    }, false)
    expect(screen.queryByRole("status", { name: "本轮推荐发布状态" })).toBeNull()
  })

  it("does not claim history exists before the first publication", () => {
    renderWorkspace({ ...response, items: [], totalCount: 0 }, false)
    expect(screen.getByRole("status", { name: "本轮推荐发布状态" })).toBeTruthy()
    expect(screen.queryByText(/下方仍是历史已发布结果/)).toBeNull()
  })

  it("shows an ungenerated project without errors, indefinite loading or automatic work", () => {
    renderWorkspace({
      ...response, items: [], latestGeneration: null, totalCount: 0, nextCursor: null,
      releasedPool: {
        generationCount: 0,
        oldestVisiblePoolGeneration: null,
        newestVisiblePoolGeneration: null,
      },
    }, false)
    expect(screen.getByText("尚未生成")).toBeTruthy()
    expect(screen.queryByText("状态加载中")).toBeNull()
    expect(screen.queryByRole("region", { name: "推荐池解锁状态" })).toBeNull()
    expect(screen.queryByRole("button", { name: "首批准备中" })).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByRole("button", { name: "新建推荐池" })).toBeTruthy()
    expect(generateRecommendationPool).not.toHaveBeenCalled()
    expect(publishInitialRecommendationFeed).not.toHaveBeenCalled()
  })

  it("shows a compact completed summary without internal codes or a completed progress bar", () => {
    renderWorkspace({
      ...completedResponse,
      latestGeneration: {
        ...completedResponse.latestGeneration,
        discoveryResult: "PATHS_EXHAUSTED",
        terminalReason: "PATHS_EXHAUSTED",
      },
    }, false)
    expect(screen.getByText("本轮检索范围已完成")).toBeTruthy()
    expect(screen.queryByText("PATHS_EXHAUSTED")).toBeNull()
    expect(screen.queryByText("COMPLETED")).toBeNull()
    expect(screen.queryByText("RELEASED")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByRole("progressbar", { name: "最新推荐池生成进度" })).toBeNull()
    expect(screen.queryByRole("button", { name: "生成新推荐池" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "新建推荐池" }))
    expect(screen.getByRole("button", { name: "生成新推荐池" })).toBeTruthy()
    expect(previewRecommendationSeeds).not.toHaveBeenCalled()
    expect(generateRecommendationPool).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "新建推荐池" }))
    expect(screen.queryByRole("button", { name: "生成新推荐池" })).toBeNull()
  })

  it("keeps active progress visible and uses a safe label for unknown stage codes", () => {
    renderWorkspace({
      ...response,
      latestGeneration: { ...response.latestGeneration, discoveryResult: "NEW_INTERNAL_STATUS" },
    }, false)
    expect(screen.getByRole("progressbar", { name: "最新推荐池生成进度" }).getAttribute("aria-valuenow")).toBe("45")
    expect(screen.getByText("状态待确认")).toBeTruthy()
    expect(screen.queryByText("NEW_INTERNAL_STATUS")).toBeNull()
  })

  it("resets filters and batch options when the active project changes", () => {
    const view = renderWorkspace()
    fireEvent.change(screen.getByRole("combobox", { name: "推荐池批次" }), {
      target: { value: response.releasedPool.filterOptions!.batches[0].batchId },
    })
    useFeedMock.mockReturnValue({
      response: {
        ...response,
        releasedPool: { ...response.releasedPool, filterOptions: {
          batches: [], categories: [], hasUncategorized: false,
        } },
      },
      state: "data", refresh: refreshFeed, poll: refreshFeed,
    })
    view.rerender(<RecommendationFeedWorkspace project={{ ...project, id: "project-b" }} />)
    expect(useFeedMock.mock.calls.at(-1)?.[0]).toBe("project-b")
    expect(useFeedMock.mock.calls.at(-1)?.[3].batchId).toBeUndefined()
    expect(within(screen.getByRole("combobox", { name: "推荐池批次" })).getAllByRole("option")).toHaveLength(1)
  })

  it("selects real batch and category options and resets pagination", () => {
    renderWorkspace()
    fireEvent.click(screen.getByRole("button", { name: "下一页" }))
    expect(useFeedMock.mock.calls.at(-1)?.[4]).toBe("cursor-2")
    fireEvent.change(screen.getByRole("combobox", { name: "推荐池批次" }), {
      target: { value: response.releasedPool.filterOptions!.batches[0].batchId },
    })
    fireEvent.change(screen.getByRole("combobox", { name: "分类" }), {
      target: { value: "__uncategorized__" },
    })
    expect(useFeedMock.mock.calls.at(-1)?.[3]).toMatchObject({
      batchId: response.releasedPool.filterOptions!.batches[0].batchId,
      category: "__uncategorized__",
    })
    expect(useFeedMock.mock.calls.at(-1)?.[4]).toBeNull()
    fireEvent.change(screen.getByRole("combobox", { name: "推荐池批次" }), {
      target: { value: "" },
    })
    expect(useFeedMock.mock.calls.at(-1)?.[3].batchId).toBeUndefined()
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }))
    expect(useFeedMock.mock.calls.at(-1)?.[3]).toEqual({ sort: "released_desc", limit: 35 })
  })

  it("disables inverted metric ranges without treating unknown values as zero", () => {
    renderWorkspace()
    fireEvent.change(screen.getByLabelText("最低流量"), { target: { value: "1000" } })
    const maximum = screen.getByLabelText("最高流量")
    expect((within(maximum).getByRole("option", { name: "100" }) as HTMLOptionElement).disabled).toBe(true)
    expect((within(maximum).getByRole("option", { name: "不限" }) as HTMLOptionElement).disabled).toBe(false)
    expect(screen.getAllByText("暂无数据")).toHaveLength(3)
  })

  it("renders persisted traffic, rank and a known zero spam score", () => {
    renderWorkspace({
      ...response,
      items: response.items.map((item) => ({
        ...item,
        metrics: {
          targetMarketOrganicTraffic: 321,
          dataForSeoRank: 45,
          spamScore: 0,
        },
      })),
    })
    expect(screen.getByText("321", { selector: "dd" })).toBeTruthy()
    expect(screen.getByText("45", { selector: "dd" })).toBeTruthy()
    expect(within(screen.getByRole("article")).getByText("0", { selector: "dd" })).toBeTruthy()
    expect(screen.queryAllByText("暂无数据")).toHaveLength(0)
  })

  it("shows library DR zero separately from unknown DFS metrics without unlock controls", () => {
    renderWorkspace({
      ...response,
      items: response.items.map((item) => ({
        ...item,
        metrics: { ...item.metrics, ahrefsDr: 0, libraryMonthlyTraffic: 12345 },
      })),
    })
    expect(screen.getByText("Ahrefs DR")).toBeTruthy()
    expect(screen.getByText("库月流量")).toBeTruthy()
    expect(within(screen.getByRole("article")).getByText("0", { selector: "dd" })).toBeTruthy()
    expect(screen.getByText("12,345", { selector: "dd" })).toBeTruthy()
    expect(screen.getAllByText("暂无数据")).toHaveLength(3)
    expect(screen.queryByRole("progressbar", { name: /解锁/ })).toBeNull()
    expect(screen.queryByText(/18 小时|25%|尚未解锁/)).toBeNull()
  })

  it("refreshes both current-member projections after initial publication", async () => {
    vi.mocked(publishInitialRecommendationFeed).mockResolvedValue({
      state: "PUBLISHED",
      currentBatchOrdinal: 1,
      replayed: false,
      meta: status.meta,
    })
    renderWorkspace(completedResponse)
    useStatusMock.mockReturnValue({
      status: { ...status, state: "NOT_PUBLISHED", currentBatchOrdinal: null },
      state: "data",
      refresh: refreshStatus,
      poll: refreshStatus,
    })
    fireEvent.change(screen.getByPlaceholderText("example.com"), {
      target: { value: "publisher" },
    })
    await waitFor(() => expect(refreshFeed).toHaveBeenCalledTimes(1))
    expect(refreshStatus).toHaveBeenCalledTimes(1)
    expect(publishInitialRecommendationFeed).toHaveBeenCalledWith(
      project.id,
      expect.any(AbortSignal)
    )
    expect(generateRecommendationPool).not.toHaveBeenCalled()
    expect(getMoreRecommendationFeed).not.toHaveBeenCalled()
  })

  it("aborts initial publication on project exit and ignores its late result", async () => {
    let finish!: (
      value: Awaited<ReturnType<typeof publishInitialRecommendationFeed>>
    ) => void
    vi.mocked(publishInitialRecommendationFeed).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    renderWorkspace(completedResponse)
    useStatusMock.mockReturnValue({
      status: { ...status, state: "NOT_PUBLISHED", currentBatchOrdinal: null },
      state: "data",
      refresh: refreshStatus,
      poll: refreshStatus,
    })
    fireEvent.change(screen.getByPlaceholderText("example.com"), {
      target: { value: "publisher" },
    })
    const signal = vi.mocked(publishInitialRecommendationFeed).mock.calls[0][1]
    cleanup()
    expect(signal.aborted).toBe(true)
    finish({
      state: "PUBLISHED",
      currentBatchOrdinal: 1,
      replayed: false,
      meta: status.meta,
    })
    await Promise.resolve()
    expect(refreshFeed).not.toHaveBeenCalled()
    expect(refreshStatus).not.toHaveBeenCalled()
  })

  it("renders only public V2 fields and keeps missing metrics unknown", () => {
    renderWorkspace()

    expect(screen.getByText("最新生成 · 第 3 轮")).toBeTruthy()
    expect(screen.getByText("第 1–2 轮")).toBeTruthy()
    expect(screen.getByText("publisher.example")).toBeTruthy()
    expect(screen.getByText("受众与项目匹配")).toBeTruthy()
    expect(screen.getAllByText("暂无数据")).toHaveLength(3)
    expect(screen.getByRole("link", { name: "打开联系页面" }).getAttribute("href")).toBe("https://publisher.example/contact")
    expect(screen.queryByText(/score/i)).toBeNull()
    expect(screen.getByRole("button", { name: "生成新推荐池" })).toBeTruthy()
  })

  it("binds filters and pagination to the V2 feed hook", async () => {
    renderWorkspace()

    fireEvent.change(screen.getByPlaceholderText("example.com"), {
      target: { value: "publisher" },
    })
    fireEvent.change(screen.getByLabelText("最低流量"), {
      target: { value: "100" },
    })
    fireEvent.change(screen.getByLabelText("最高流量"), {
      target: { value: "1000" },
    })
    fireEvent.change(screen.getByLabelText("最低权重"), {
      target: { value: "10" },
    })
    fireEvent.change(screen.getByLabelText("最高权重"), {
      target: { value: "90" },
    })
    fireEvent.change(screen.getByLabelText("最低垃圾评分"), {
      target: { value: "0" },
    })
    fireEvent.change(screen.getByLabelText("最高垃圾评分"), {
      target: { value: "20" },
    })
    fireEvent.click(screen.getByRole("button", { name: "下一页" }))

    await waitFor(() => {
      const latest = useFeedMock.mock.calls.at(-1)
      expect(latest?.[3]).toMatchObject({
        domainSearch: "publisher",
        trafficMin: 100,
        trafficMax: 1000,
        rankMin: 10,
        rankMax: 90,
        spamMin: 0,
        spamMax: 20,
      })
      expect(latest?.[4]).toBe("cursor-2")
    })
  })

  it("uses existing release and Opportunity contracts with scoped invalidation", async () => {
    vi.mocked(getMoreRecommendationFeed).mockResolvedValue({
      state: "RELEASED",
      currentBatchOrdinal: 1,
      releasedBatchOrdinal: 2,
      replayed: false,
      meta: status.meta,
    })
    vi.mocked(setRecommendationFeedItemArchived).mockResolvedValue({
      itemId: response.items[0].itemId,
      archived: true,
      replayed: false,
      meta: status.meta,
    })
    vi.mocked(createRecommendationFeedOpportunity).mockResolvedValue({
      opportunityId: "00000000-0000-4000-8000-000000000010",
      recommendationId: "00000000-0000-4000-8000-000000000011",
      cycleId: "00000000-0000-4000-8000-000000000012",
      websiteProjectId: project.id,
      targetSiteKey: "publisher.example",
      targetHostAscii: "publisher.example",
      contactCandidateId: null,
      contactReviewRequired: true,
      joinSequence: 1,
      businessStage: "JOINED",
      managementStatus: "ACTIVE",
      outcomeStatus: "OPEN",
      fulfillmentStatus: "NOT_EXPECTED",
      version: 1,
      lifecycleEventId: "00000000-0000-4000-8000-000000000013",
      auditEventId: "00000000-0000-4000-8000-000000000014",
      replayed: false,
      recommendationFeedItemId: response.items[0].itemId,
      existingOpportunity: false,
      teamAdded: false,
      createdByCurrentUser: true,
      meta: {
        ...status.meta,
        schemaVersion: "backlinks.v1",
      },
    })
    renderWorkspace()

    fireEvent.click(screen.getByRole("button", { name: "获取更多" }))
    await waitFor(() =>
      expect(getMoreRecommendationFeed).toHaveBeenCalledWith(
        "project-a",
        expect.any(String)
      )
    )

    const item = screen.getByRole("article")
    fireEvent.click(within(item).getByRole("button", { name: "归档" }))
    await waitFor(() =>
      expect(setRecommendationFeedItemArchived).toHaveBeenCalledWith(
        "project-a",
        response.items[0].itemId,
        true
      )
    )
    expect(invalidateRecommendationFeed).toHaveBeenCalledWith("project-a")

    fireEvent.click(within(item).getByRole("button", { name: "加入" }))
    await waitFor(() =>
      expect(createRecommendationFeedOpportunity).toHaveBeenCalledWith(
        "project-a",
        response.items[0].itemId
      )
    )
    expect(invalidateRecommendationOpportunityCaches).toHaveBeenCalledWith(
      "project-a"
    )
  })

  it("does not launch generation before the prepared seed set is confirmed", () => {
    renderWorkspace(completedResponse)

    const generateButton = screen.getByRole("button", {
      name: "生成新推荐池",
    }) as HTMLButtonElement
    expect(generateButton.disabled).toBe(true)

    fireEvent.click(generateButton)
    expect(generateRecommendationPool).not.toHaveBeenCalled()
    expect(invalidateRecommendationFeed).not.toHaveBeenCalled()
  })

  it("previews generated seed kinds, invalidates edited snapshots, then confirms and launches", async () => {
    vi.mocked(previewRecommendationSeeds).mockResolvedValue(previewResponse)
    vi.mocked(confirmRecommendationSeeds).mockResolvedValue(
      confirmationResponse
    )
    vi.mocked(generateRecommendationPool).mockResolvedValue({
      generationContractId:
        confirmationResponse.confirmation!.generationContractId,
      visiblePoolGeneration: 4,
      jobId: "00000000-0000-4000-8000-000000000081",
      workflowId: "recommendation-pool-v2-project-a-4",
      state: "STARTED",
      replayed: false,
      meta: seedMeta,
    })
    renderWorkspace(completedResponse)

    fireEvent.click(screen.getByRole("button", { name: "准备建议种子" }))
    await waitFor(() =>
      expect(previewRecommendationSeeds).toHaveBeenCalledWith("project-a", [])
    )

    expect(screen.getByDisplayValue("email outreach")).toBeTruthy()
    expect(screen.getByDisplayValue("SaaS")).toBeTruthy()
    expect(screen.getByDisplayValue("competitor.example")).toBeTruthy()

    fireEvent.change(screen.getByLabelText("种子内容 1"), {
      target: { value: "email outreach software" },
    })
    expect(
      (
        screen.getByRole("button", {
          name: "确认种子",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)

    vi.mocked(previewRecommendationSeeds).mockResolvedValue({
      ...previewResponse,
      seeds: [
        previewSeed("KEYWORD", "email outreach software", "f"),
        ...previewResponse.seeds.slice(1),
      ],
    })
    fireEvent.click(screen.getByRole("button", { name: "准备建议种子" }))
    await waitFor(() =>
      expect(screen.getByDisplayValue("email outreach software")).toBeTruthy()
    )

    fireEvent.click(screen.getByRole("button", { name: "确认种子" }))
    await waitFor(() =>
      expect(confirmRecommendationSeeds).toHaveBeenCalledWith(
        "project-a",
        expect.any(String),
        [
          { kind: "KEYWORD", value: "email outreach software" },
          { kind: "CATEGORY", value: "SaaS" },
          { kind: "SEO_COMPETITOR", value: "competitor.example" },
        ]
      )
    )

    const generateButton = screen.getByRole("button", {
      name: "生成新推荐池",
    }) as HTMLButtonElement
    expect(generateButton.disabled).toBe(false)
    fireEvent.click(generateButton)
    await waitFor(() =>
      expect(generateRecommendationPool).toHaveBeenCalledWith(
        "project-a",
        expect.any(String),
        confirmationResponse.confirmation
      )
    )
    expect(invalidateRecommendationFeed).toHaveBeenCalledWith("project-a")
  })

  it.each([
    ["CONTACT_FORM_ONLY", "打开联系表单"],
    ["LOGIN_REQUIRED", "打开登录受限页面"],
    ["CAPTCHA_OR_BOT_CHALLENGE", "打开验证页面"],
    ["ACCESS_DENIED", "打开受限页面"],
  ])("links the observed page for %s", (outcome, label) => {
    renderWorkspace({
      ...completedResponse,
      items: [{
        ...response.items[0],
        contact: { email: null, contactPage: "https://publisher.example/fale-conosco/", outcome },
      }],
    }, false)
    const link = screen.getByRole("link", { name: label })
    expect(link.getAttribute("href")).toBe("https://publisher.example/fale-conosco/")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noopener noreferrer")
  })

  it.each([null, "javascript:alert(1)", "https://user:secret@publisher.example/login"])(
    "does not invent a form URL when evidence is missing or unsafe: %s", contactPage => {
      renderWorkspace({
        ...completedResponse,
        items: [{
          ...response.items[0],
          contact: { email: null, contactPage, outcome: "CONTACT_FORM_ONLY" },
        }],
      }, false)
      expect(screen.queryByRole("link", { name: "打开联系表单" })).toBeNull()
      expect(screen.getByRole("link", { name: "访问网站" }).getAttribute("href"))
        .toBe(response.items[0].displayUrl)
    }
  )

  it("keeps non-retryable failed generations fail-closed", () => {
    renderWorkspace({
      ...completedResponse,
      latestGeneration: {
        ...completedResponse.latestGeneration,
        jobState: "FAILED",
        terminalReason: "PROVIDER_SYSTEM_FAILURE",
        retrySafe: false,
      },
    })

    expect(screen.getByText(/不可自动重试/)).toBeTruthy()
    expect(
      (
        screen.getByRole("button", {
          name: "准备建议种子",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(
      (
        screen.getByRole("button", {
          name: "生成新推荐池",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })
})
