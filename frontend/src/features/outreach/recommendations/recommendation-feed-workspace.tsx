import * as React from "react"
import {
  Archive,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Compass,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  WandSparkles,
} from "lucide-react"
import "../shared/discovery-workspace.css"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { OutreachProject } from "@/features/outreach/project"
import { useRecommendationFeedObservation } from "./use-recommendation-feed-observation"

import {
  confirmRecommendationSeeds,
  createRecommendationFeedOpportunity,
  exportRecommendationFeed,
  generateRecommendationPool,
  getMoreRecommendationFeed,
  previewRecommendationSeeds,
  publishInitialRecommendationFeed,
  setRecommendationFeedItemArchived,
  type RecommendationFeedFilters,
  type RecommendationFeedItem,
  type RecommendationSeedConfirmation,
  type RecommendationSeedInput,
  type RecommendationSeedPreviewResponse,
} from "./recommendation-feed-api"
import {
  invalidateRecommendationFeed,
  invalidateRecommendationOpportunityCaches,
} from "./recommendation-feed-cache"
import {
  recommendationGetMoreState,
  recommendationOpportunityLabel,
  recommendationPoolStateLabel,
} from "./recommendation-feed-state"
import {
  useRecommendationFeed,
  useRecommendationFeedStatus,
} from "./use-recommendation-feed"

type PendingAction = "archive" | "opportunity" | null
type SeedDraft = Readonly<{
  id: string
  kind: RecommendationSeedInput["kind"]
  value: string
  supersedesSeedId?: string
}>

const activeGenerationStates = new Set([
  "QUEUED",
  "RUNNING",
  "WAITING_PROVIDER",
])

const seedKindLabels: Readonly<
  Record<RecommendationSeedInput["kind"], string>
> = {
  KEYWORD: "关键词",
  CATEGORY: "分类",
  SEO_COMPETITOR: "SEO 竞品",
}

const generationStateLabels: Readonly<Record<string, string>> = {
  PENDING_LAUNCH: "等待启动",
  QUEUED: "排队中",
  RUNNING: "生成中",
  WAITING_PROVIDER: "等待数据",
  SUCCESS: "已完成",
  PARTIAL_SUCCESS: "部分完成",
  FAILED: "生成失败",
  CANCELLED: "已取消",
}

const stageLabels: Readonly<Record<string, string>> = {
  PENDING: "等待开始",
  IN_PROGRESS: "处理中",
  RUNNING: "处理中",
  COMPLETED: "已完成",
  COMPLETED_PARTIAL: "部分完成",
  PARTIAL_SUCCESS: "部分完成",
  AVAILABLE: "可查看",
  RELEASED: "已发布",
  PATHS_EXHAUSTED: "本轮检索完成",
  PARTIAL_EXHAUSTED: "检索结束，部分完成",
  BUDGET_EXHAUSTED: "已达预算上限",
  TARGET_REACHED: "已达目标数量",
  FAILED: "处理失败",
  BLOCKED: "暂时受阻",
  NOT_AVAILABLE: "暂无可用结果",
  NOT_STARTED: "尚未开始",
  WAITING_PROVIDER: "等待数据服务",
}

function generationReasonLabel(reason: string, failed: boolean) {
  const labels: Readonly<Record<string, string>> = {
    PATHS_EXHAUSTED: "本轮检索范围已完成",
    PARTIAL_EXHAUSTED: "本轮检索已结束，已保留可用推荐",
    BUDGET_EXHAUSTED: "本轮已达预算上限",
    TARGET_REACHED: "已达到本轮推荐目标",
    PROVIDER_SYSTEM_FAILURE: "数据服务暂时异常",
    INPUT_REQUIRED: "项目资料需要补充",
    NO_CANDIDATES: "本轮未找到符合条件的网站",
  }
  return labels[reason] ?? (failed ? "本轮生成遇到问题" : "本轮任务已结束")
}

function metric(value: number | null) {
  return value === null ? "暂无数据" : new Intl.NumberFormat("zh-CN").format(value)
}

function recommendationReasonLabel(value: string) {
  const labels: Record<string, string> = {
    RELEVANCE_TARGET_MARKET_SEARCH_TOPIC: "与目标市场和主题相关",
    EVIDENCE_VERIFIED_SOURCE_RELATION: "已验证推荐来源",
    RELEVANCE_EVIDENCE_MISSING: "尚未确认与项目的相关性",
    INDEPENDENT_POSITIVE_EVIDENCE_MISSING: "尚缺独立推荐依据",
    REQUIRED_EXCLUSION_FAILED: "未通过推荐条件检查",
  }
  return labels[value] ?? (/^[A-Z][A-Z0-9_]+$/.test(value) ? "其他推荐依据" : value)
}

function optionalNumber(value: string) {
  return value === "" ? undefined : Number(value)
}

function contactOutcome(item: RecommendationFeedItem) {
  if (item.contact.email) return item.contact.email
  return (
    {
      NO_PUBLIC_CONTACT: "未找到公开邮箱",
      NO_PUBLIC_EMAIL: "未找到公开邮箱",
      CONTACT_FORM_ONLY: "仅找到联系表单",
      CONTACT_PAGE_FOUND: "已找到联系页面",
      COMPLETED_PARTIAL: "联系信息检查未完整完成",
      MANUAL_REVIEW_REQUIRED: "联系信息需要人工核查",
      LOGIN_REQUIRED: "需要登录才能查看",
      UNSUPPORTED_CONTENT: "暂不支持此网站内容格式",
      ACCESS_DENIED: "网站拒绝访问",
      CAPTCHA_OR_BOT_CHALLENGE: "网站访问验证受限",
      ROBOTS_DISALLOWED: "网站限制自动采集",
      SITE_UNREACHABLE: "暂时无法访问网站",
      UNREACHABLE: "网站不可达",
      UNSUPPORTED: "暂不支持",
    }[item.contact.outcome] ?? "联系信息状态待确认"
  )
}

function safeContactUrl(value: string | null | undefined) {
  if (!value) return null
  try {
    const url = new URL(value)
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href : null
  } catch {
    return null
  }
}

function ContactDestination({ item }: { item: RecommendationFeedItem }) {
  if (item.contact.email) return <>{item.contact.email}</>
  const observed = safeContactUrl(item.contact.contactPage)
  const href = observed ?? safeContactUrl(item.displayUrl)
  const label = !observed ? "访问网站" : (
    {
      CONTACT_FORM_ONLY: "打开联系表单",
      LOGIN_REQUIRED: "打开登录受限页面",
      CAPTCHA_OR_BOT_CHALLENGE: "打开验证页面",
      ACCESS_DENIED: "打开受限页面",
    }[item.contact.outcome] ?? "打开联系页面"
  )
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>{contactOutcome(item)}</span>
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer" title={href}
          className="inline-flex items-center gap-1 underline underline-offset-4">
          {label}<ExternalLink aria-hidden="true" className="size-3" />
        </a>
      )}
    </span>
  )
}

function releasedAt(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date)
}

function seedInputs(drafts: readonly SeedDraft[]): RecommendationSeedInput[] {
  return drafts
    .filter((draft) => draft.value.trim().length > 0)
    .map((draft) => ({
      kind: draft.kind,
      value: draft.value.trim(),
      ...(draft.supersedesSeedId
        ? { supersedesSeedId: draft.supersedesSeedId }
        : {}),
    }))
}

function releasedPoolLabel(
  response: ReturnType<typeof useRecommendationFeed>["response"]
) {
  const releasedPool = response?.releasedPool
  if (
    !releasedPool ||
    releasedPool.generationCount === 0 ||
    releasedPool.oldestVisiblePoolGeneration === null ||
    releasedPool.newestVisiblePoolGeneration === null
  ) {
    return "暂无已发布代次"
  }
  if (
    releasedPool.oldestVisiblePoolGeneration ===
    releasedPool.newestVisiblePoolGeneration
  ) {
    return `第 ${releasedPool.newestVisiblePoolGeneration} 轮`
  }
  return `第 ${releasedPool.oldestVisiblePoolGeneration}–${releasedPool.newestVisiblePoolGeneration} 轮`
}

export function RecommendationFeedWorkspace({
  project,
}: {
  project: OutreachProject
}) {
  return (
    <RecommendationFeedWorkspaceScope
      key={`${project.id}:${project.contextVersion}`}
      project={project}
    />
  )
}

function RecommendationFeedWorkspaceScope({
  project,
}: {
  project: OutreachProject
}) {
  const [actorScope] = React.useState(
    () => `actor-session:${crypto.randomUUID()}`
  )
  const [filters, setFilters] = React.useState<RecommendationFeedFilters>({
    sort: "released_desc",
    limit: 35,
  })
  const [cursorStack, setCursorStack] = React.useState<
    readonly (string | null)[]
  >([null])
  const [selectedIds, setSelectedIds] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [pendingItem, setPendingItem] = React.useState<{
    id: string
    action: PendingAction
  } | null>(null)
  const [getMorePending, setGetMorePending] = React.useState(false)
  const [seedDrafts, setSeedDrafts] = React.useState<readonly SeedDraft[]>([])
  const [seedPreview, setSeedPreview] =
    React.useState<RecommendationSeedPreviewResponse | null>(null)
  const [seedConfirmation, setSeedConfirmation] =
    React.useState<RecommendationSeedConfirmation | null>(null)
  const [seedPreviewPending, setSeedPreviewPending] = React.useState(false)
  const [seedConfirmationPending, setSeedConfirmationPending] =
    React.useState(false)
  const [generationPending, setGenerationPending] = React.useState(false)
  const [seedEditorOpen, setSeedEditorOpen] = React.useState(false)
  const [exportPending, setExportPending] = React.useState(false)
  const [recentlyArchived, setRecentlyArchived] = React.useState<{
    id: string
    domain: string
  } | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [actionNotice, setActionNotice] = React.useState<string | null>(null)
  const getMoreIdempotencyKey = React.useRef(crypto.randomUUID())
  const seedConfirmationIdempotencyKey = React.useRef(crypto.randomUUID())
  const generationLaunchIdempotencyKey = React.useRef(crypto.randomUUID())
  const cursor = cursorStack.at(-1) ?? null

  const feed = useRecommendationFeed(
    project.id,
    actorScope,
    project.contextVersion,
    filters,
    cursor,
    true
  )
  const release = useRecommendationFeedStatus(
    project.id,
    actorScope,
    project.contextVersion,
    true
  )
  const pollFeed = feed.poll
  const selectedBatch = feed.response?.releasedPool.filterOptions?.batches.find(
    (batch) => batch.batchId === filters.batchId
  )
  const pollRelease = release.poll
  const latestGeneration = feed.response?.latestGeneration ?? null
  useRecommendationFeedObservation(project.id, latestGeneration)
  const generationActive =
    latestGeneration !== null &&
    activeGenerationStates.has(latestGeneration.jobState)
  const initialBatchReady =
    latestGeneration?.releaseResult === "AVAILABLE" ||
    latestGeneration?.releaseResult === "RELEASED"
  const retryBlocked =
    latestGeneration?.jobState === "FAILED" && !latestGeneration.retrySafe
  const confirmedSeedInputs = React.useMemo(
    () => seedInputs(seedDrafts),
    [seedDrafts]
  )

  React.useEffect(() => {
    if (!initialBatchReady || release.status?.state !== "NOT_PUBLISHED") return
    const controller = new AbortController()
    void publishInitialRecommendationFeed(project.id, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted || result.state !== "PUBLISHED") return
        await Promise.all([pollFeed(), pollRelease()])
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setActionError("首批推荐发布失败，请刷新重试。")
        }
      })
    return () => controller.abort()
  }, [
    initialBatchReady,
    latestGeneration?.generationContractId,
    project.id,
    release.status,
    pollFeed,
    pollRelease,
  ])

  React.useEffect(() => {
    if (!generationActive) return
    let polling = false
    const timer = window.setInterval(() => {
      if (polling) return
      polling = true
      void Promise.all([pollFeed(), pollRelease()]).finally(() => {
        polling = false
      })
    }, 2_500)
    return () => window.clearInterval(timer)
  }, [generationActive, pollFeed, pollRelease])

  const updateFilters = React.useCallback(
    (next: Partial<RecommendationFeedFilters>) => {
      setCursorStack([null])
      setSelectedIds(new Set())
      setFilters((current) => ({ ...current, ...next }))
    },
    []
  )

  const refresh = React.useCallback(async () => {
    setActionError(null)
    setActionNotice(null)
    await Promise.all([feed.refresh(), release.refresh()])
  }, [feed, release])

  const updateSeedDraft = React.useCallback(
    (id: string, next: Partial<Pick<SeedDraft, "kind" | "value">>) => {
      setSeedDrafts((current) =>
        current.map((draft) =>
          draft.id === id ? { ...draft, ...next } : draft
        )
      )
      setSeedPreview(null)
      setSeedConfirmation(null)
      setActionNotice(null)
    },
    []
  )

  const handlePreviewSeeds = React.useCallback(async () => {
    if (seedPreviewPending || generationActive || retryBlocked) return
    setSeedPreviewPending(true)
    setActionError(null)
    setActionNotice(null)
    try {
      const result = await previewRecommendationSeeds(
        project.id,
        confirmedSeedInputs
      )
      setSeedPreview(result)
      setSeedConfirmation(null)
      if (result.state === "INPUT_REQUIRED") {
        setActionError(
          `需要补充发现种子：${result.reasonCodes.join("、") || "DISCOVERY_SEEDS_REQUIRED"}`
        )
        return
      }
      const eligibleSeeds = result.seeds.filter(
        (seed) =>
          seed.validationStatus === "VERIFIED" ||
          seed.validationStatus === "RETAINED_LOW_CONFIDENCE"
      )
      setSeedDrafts(
        eligibleSeeds.map((seed) => ({
          id: crypto.randomUUID(),
          kind: seed.kind,
          value: seed.rawValue,
          ...(seed.supersedesSeedId
            ? { supersedesSeedId: seed.supersedesSeedId }
            : {}),
        }))
      )
      setActionNotice("建议种子已准备，可编辑后确认。")
    } catch {
      setActionError("种子预览失败，请稍后重试。")
    } finally {
      setSeedPreviewPending(false)
    }
  }, [
    confirmedSeedInputs,
    generationActive,
    project.id,
    retryBlocked,
    seedPreviewPending,
  ])

  const handleConfirmSeeds = React.useCallback(async () => {
    if (
      seedConfirmationPending ||
      seedPreview?.state !== "READY" ||
      confirmedSeedInputs.length === 0
    ) {
      return
    }
    setSeedConfirmationPending(true)
    setActionError(null)
    setActionNotice(null)
    try {
      const result = await confirmRecommendationSeeds(
        project.id,
        seedConfirmationIdempotencyKey.current,
        confirmedSeedInputs
      )
      if (result.state !== "READY" || result.confirmation === null) {
        setSeedConfirmation(null)
        setActionError(
          `种子仍需补充：${result.reasonCodes.join("、") || "DISCOVERY_SEEDS_REQUIRED"}`
        )
        return
      }
      seedConfirmationIdempotencyKey.current = crypto.randomUUID()
      setSeedConfirmation(result.confirmation)
      setActionNotice("种子快照已确认，可以启动新推荐池。")
      await feed.refresh()
    } catch {
      setActionError("种子确认失败，请重新预览后再试。")
    } finally {
      setSeedConfirmationPending(false)
    }
  }, [
    confirmedSeedInputs,
    feed,
    project.id,
    seedConfirmationPending,
    seedPreview?.state,
  ])

  const handleGenerate = React.useCallback(async () => {
    if (generationPending || seedConfirmation === null) return
    setGenerationPending(true)
    setActionError(null)
    setActionNotice(null)
    try {
      await generateRecommendationPool(
        project.id,
        generationLaunchIdempotencyKey.current,
        seedConfirmation
      )
      generationLaunchIdempotencyKey.current = crypto.randomUUID()
      invalidateRecommendationFeed(project.id)
      setCursorStack([null])
      setSelectedIds(new Set())
      setSeedPreview(null)
      setSeedConfirmation(null)
      setActionNotice("新推荐池已开始生成，现有发布池仍可继续使用。")
      await Promise.all([feed.refresh(), release.refresh()])
    } catch {
      setActionError("新推荐池启动失败，请稍后重试。")
    } finally {
      setGenerationPending(false)
    }
  }, [feed, generationPending, project.id, release, seedConfirmation])

  const handleGetMore = React.useCallback(async () => {
    if (getMorePending) return
    setGetMorePending(true)
    setActionError(null)
    try {
      await getMoreRecommendationFeed(project.id, getMoreIdempotencyKey.current)
      getMoreIdempotencyKey.current = crypto.randomUUID()
      invalidateRecommendationFeed(project.id)
      setCursorStack([null])
      await Promise.all([feed.refresh(), release.refresh()])
    } catch {
      setActionError("暂时无法获取更多，请稍后重试。")
    } finally {
      setGetMorePending(false)
    }
  }, [feed, getMorePending, project.id, release])

  const handleArchive = React.useCallback(
    async (item: RecommendationFeedItem) => {
      setPendingItem({ id: item.itemId, action: "archive" })
      setActionError(null)
      try {
        await setRecommendationFeedItemArchived(project.id, item.itemId, true)
        setRecentlyArchived({ id: item.itemId, domain: item.domain })
        invalidateRecommendationFeed(project.id)
        await feed.refresh()
      } catch {
        setActionError("归档失败，请重试。")
      } finally {
        setPendingItem(null)
      }
    },
    [feed, project.id]
  )

  const handleUndoArchive = React.useCallback(async () => {
    if (!recentlyArchived) return
    setActionError(null)
    try {
      await setRecommendationFeedItemArchived(
        project.id,
        recentlyArchived.id,
        false
      )
      setRecentlyArchived(null)
      invalidateRecommendationFeed(project.id)
      await feed.refresh()
    } catch {
      setActionError("恢复归档失败，请重试。")
    }
  }, [feed, project.id, recentlyArchived])

  const handleOpportunity = React.useCallback(
    async (item: RecommendationFeedItem) => {
      setPendingItem({ id: item.itemId, action: "opportunity" })
      setActionError(null)
      try {
        await createRecommendationFeedOpportunity(project.id, item.itemId)
        invalidateRecommendationOpportunityCaches(project.id)
        await Promise.all([feed.refresh(), release.refresh()])
      } catch {
        setActionError("加入 Opportunity 失败，请重试。")
      } finally {
        setPendingItem(null)
      }
    },
    [feed, project.id, release]
  )

  const handleExport = React.useCallback(async () => {
    setExportPending(true)
    setActionError(null)
    try {
      const csv = await exportRecommendationFeed(project.id, filters, [
        ...selectedIds,
      ])
      const url = URL.createObjectURL(
        new Blob([csv], { type: "text/csv;charset=utf-8" })
      )
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `${project.domain}-recommendations.csv`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch {
      setActionError("导出失败，请重试。")
    } finally {
      setExportPending(false)
    }
  }, [filters, project.domain, project.id, selectedIds])

  const getMoreState = release.status
    ? recommendationGetMoreState(release.status)
    : { enabled: false, label: "获取更多" }
  const hasNoGeneration = feed.response !== null && !latestGeneration

  return (
    <div className="discovery-workspace recommendation-workspace">
      <header className="discovery-heading">
        <div className="min-w-0">
          <h1><Compass aria-hidden="true" />外链推荐</h1>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {project.name} · {project.domain}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void refresh()}
            aria-label="刷新推荐"
          >
            <RefreshCw className="size-4" />
            刷新
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={exportPending}
            onClick={() => void handleExport()}
          >
            <Download className="size-4" />
            {exportPending ? "导出中" : "导出"}
          </Button>
          {!hasNoGeneration ? <Button
            type="button"
            disabled={!getMoreState.enabled || getMorePending}
            onClick={() => void handleGetMore()}
          >
            <Plus className="size-4" />
            {getMorePending ? "处理中" : getMoreState.label}
          </Button> : null}
          <Button
            type="button"
            variant="outline"
            aria-expanded={seedEditorOpen}
            aria-controls="recommendation-seed-editor"
            onClick={() => setSeedEditorOpen((open) => !open)}
          >
            <Plus className="size-4" />
            新建推荐池
            <ChevronDown className={`size-4 transition-transform ${seedEditorOpen ? "rotate-180" : ""}`} />
          </Button>
        </div>
      </header>

      <section
        className="recommendation-generation space-y-4"
        aria-label="新推荐池生成"
      >
        <div className="recommendation-generation-summary">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-base font-semibold text-foreground">
                {latestGeneration
                  ? `最新生成 · 第 ${latestGeneration.visiblePoolGeneration} 轮`
                  : "最新生成"}
              </h2>
              <span className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium ${
                latestGeneration?.jobState === "SUCCESS"
                  ? "bg-emerald-50 text-emerald-700"
                  : latestGeneration?.jobState === "FAILED"
                    ? "bg-red-50 text-red-700"
                    : "bg-muted text-muted-foreground"
              }`}>
                {latestGeneration?.jobState === "SUCCESS" ? <CheckCircle2 className="size-3.5" /> : null}
                {latestGeneration
                  ? (generationStateLabels[latestGeneration.jobState] ??
                    "状态待确认")
                  : feed.response
                    ? "尚未生成"
                    : feed.state === "error"
                      ? "状态加载失败"
                      : "状态加载中"}
              </span>
            </div>
            {latestGeneration ? (
              <>
                {generationActive ? <div
                  className="mt-3 h-1 overflow-hidden rounded bg-muted"
                  role="progressbar"
                  aria-label="最新推荐池生成进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={latestGeneration.progress}
                >
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{ width: `${latestGeneration.progress}%` }}
                  />
                </div> : null}
                <dl className="recommendation-generation-metrics mt-4 grid grid-cols-3 gap-3 text-sm">
                  <div className="min-w-0 border-l-2 border-border pl-3">
                    <dt className="text-xs text-muted-foreground">发现网站</dt>
                    <dd className="mt-1 text-xl font-semibold tabular-nums">
                      {latestGeneration.effectiveUniqueCandidateCount}
                    </dd>
                    <dd className="mt-1 text-xs text-muted-foreground">{stageLabels[latestGeneration.discoveryResult] ?? "状态待确认"}</dd>
                  </div>
                  <div className="min-w-0 border-l-2 border-border pl-3">
                    <dt className="text-xs text-muted-foreground">候选网站</dt>
                    <dd className="mt-1 text-xl font-semibold tabular-nums">
                      {latestGeneration.admittedCount}
                    </dd>
                    <dd className="mt-1 text-xs text-muted-foreground">联系：{stageLabels[latestGeneration.contactPreparation] ?? "状态待确认"}</dd>
                  </div>
                  <div className="min-w-0 border-l-2 border-emerald-500 pl-3">
                    <dt className="text-xs text-muted-foreground">本轮已发布</dt>
                    <dd className="mt-1 text-xl font-semibold tabular-nums">
                      {latestGeneration.releasedCount}
                    </dd>
                    <dd className="mt-1 text-xs text-muted-foreground">{stageLabels[latestGeneration.releaseResult] ?? "状态待确认"}</dd>
                  </div>
                </dl>
                {latestGeneration.terminalReason ? (
                  <p
                    role={
                      latestGeneration.jobState === "FAILED"
                        ? "alert"
                        : undefined
                    }
                    className={`mt-3 text-xs break-words ${
                      latestGeneration.jobState === "FAILED" ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {generationReasonLabel(latestGeneration.terminalReason, latestGeneration.jobState === "FAILED")}
                    {latestGeneration.jobState === "FAILED"
                      ? latestGeneration.retrySafe
                        ? " · 可安全重试"
                        : " · 不可自动重试"
                      : null}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="border-t border-border pt-4 xl:border-t-0 xl:border-l xl:pt-0 xl:pl-5">
            <p className="text-xs font-medium text-muted-foreground">
              当前筛选结果
            </p>
            <p className="mt-1 text-lg font-semibold text-foreground">
              <span className="text-2xl tabular-nums">{feed.response?.totalCount ?? 0}</span>
              <span className="ml-1 text-sm font-normal text-muted-foreground">个网站</span>
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {feed.response?.releasedPool.generationCount ?? 0} 个已发布代次
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{releasedPoolLabel(feed.response)}</p>
          </div>
        </div>

        {generationActive && latestGeneration && latestGeneration.releasedCount === 0 ? (
          <div role="status" aria-label="本轮推荐发布状态" className="border-l-2 border-primary bg-accent/40 px-4 py-3 text-sm">
            <p className="font-medium">
              第 {latestGeneration.visiblePoolGeneration} 轮尚未发布
              {latestGeneration.contactPreparation === "IN_PROGRESS" ? " · 正在整理联系信息" : " · 正在生成"}
            </p>
            {feed.response && feed.response.items.length > 0 ? (
              <p className="mt-1 text-muted-foreground">
                下方仍是历史已发布结果，不代表本轮生成结果。新一轮网站及其 SEO 数据、联系方式尚未进入列表。
              </p>
            ) : (
              <p className="mt-1 text-muted-foreground">本轮网站及其 SEO 数据、联系方式尚未进入列表。</p>
            )}
          </div>
        ) : null}

        {seedEditorOpen ? <div id="recommendation-seed-editor" className="space-y-3 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                新一轮推荐 · 发现条件
              </h3>
              {seedPreview ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {seedPreview.state === "READY" ? "建议条件已就绪" : "发现条件需要补充"}
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={generationActive || retryBlocked}
              onClick={() => {
                setSeedDrafts((current) => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    kind: "KEYWORD",
                    value: "",
                  },
                ])
                setSeedPreview(null)
                setSeedConfirmation(null)
                setActionNotice(null)
              }}
            >
              <Plus className="size-4" />
              添加种子
            </Button>
          </div>

          {seedDrafts.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">
              暂无发现条件
            </p>
          ) : (
            <div className="grid gap-2">
              {seedDrafts.map((draft, index) => (
                <div
                  key={draft.id}
                  className="grid min-w-0 gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_2rem]"
                >
                  <select
                    aria-label={`种子类型 ${index + 1}`}
                    className="h-9 w-full border border-input bg-background px-3 text-sm"
                    value={draft.kind}
                    onChange={(event) =>
                      updateSeedDraft(draft.id, {
                        kind: event.target
                          .value as RecommendationSeedInput["kind"],
                      })
                    }
                  >
                    {Object.entries(seedKindLabels).map(([kind, label]) => (
                      <option key={kind} value={kind}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <Input
                    aria-label={`种子内容 ${index + 1}`}
                    value={draft.value}
                    onChange={(event) =>
                      updateSeedDraft(draft.id, { value: event.target.value })
                    }
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`删除种子 ${index + 1}`}
                    title="删除种子"
                    onClick={() => {
                      setSeedDrafts((current) =>
                        current.filter((candidate) => candidate.id !== draft.id)
                      )
                      setSeedPreview(null)
                      setSeedConfirmation(null)
                      setActionNotice(null)
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={seedPreviewPending || generationActive || retryBlocked}
              onClick={() => void handlePreviewSeeds()}
            >
              <WandSparkles className="size-4" />
              {seedPreviewPending
                ? "准备中"
                : latestGeneration?.jobState === "FAILED" &&
                    latestGeneration.retrySafe
                  ? "准备安全重试"
                  : "准备建议种子"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={
                seedConfirmationPending ||
                seedPreview?.state !== "READY" ||
                confirmedSeedInputs.length === 0 ||
                generationActive ||
                retryBlocked
              }
              onClick={() => void handleConfirmSeeds()}
            >
              <Check className="size-4" />
              {seedConfirmationPending ? "确认中" : "确认种子"}
            </Button>
            <Button
              type="button"
              disabled={
                generationPending ||
                seedConfirmation === null ||
                generationActive ||
                retryBlocked
              }
              onClick={() => void handleGenerate()}
            >
              <Play className="size-4" />
              {generationPending ? "启动中" : "生成新推荐池"}
            </Button>
            {seedConfirmation ? (
              <span className="text-xs text-emerald-700">快照已确认</span>
            ) : null}
          </div>
        </div> : null}
      </section>

      {release.status && !hasNoGeneration ? (
        <section
          className="recommendation-supply"
          aria-label="推荐池供应状态"
        >
          <div>
            <p className="text-sm font-medium text-foreground">
              {recommendationPoolStateLabel(release.status)}
            </p>
          </div>
        </section>
      ) : null}

      <div className="recommendation-browser">
      <section
        className="recommendation-filters"
        aria-label="推荐筛选"
      >
        <h2>筛选网站</h2>
        <label className="col-span-2 min-w-0 space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            推荐池批次
          </span>
          <select
            className="h-9 w-full min-w-0 border border-input bg-background px-3 text-sm"
            value={filters.batchId ?? ""}
            onChange={(event) => updateFilters({ batchId: event.target.value || undefined })}
          >
            <option value="">全部批次</option>
            {feed.response?.releasedPool.filterOptions?.batches.map((batch) => (
              <option key={batch.batchId} value={batch.batchId} title={new Date(batch.releasedAt).toLocaleString()}>
                第 {batch.visiblePoolGeneration} 轮 · 第 {batch.batchOrdinal} 批 · {batch.count} 条
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-2 min-w-0 space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            搜索域名
          </span>
          <Input
            value={filters.domainSearch ?? ""}
            onChange={(event) =>
              updateFilters({
                domainSearch: event.target.value || undefined,
              })
            }
            placeholder="example.com"
          />
        </label>
        <label className="col-span-2 min-w-0 space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            分类
          </span>
          <select
            className="h-9 w-full border border-input bg-background px-3 text-sm"
            value={filters.category ?? ""}
            onChange={(event) =>
              updateFilters({ category: event.target.value || undefined })
            }
          >
            <option value="">全部</option>
            {feed.response?.releasedPool.filterOptions?.categories.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
            {feed.response?.releasedPool.filterOptions?.hasUncategorized ? (
              <option value="__uncategorized__">未分类</option>
            ) : null}
          </select>
        </label>
        {([
          ["trafficMin", "trafficMax", "最低流量", [0, 100, 1000, 10000, 100000, 1000000]],
          ["trafficMax", "trafficMin", "最高流量", [0, 100, 1000, 10000, 100000, 1000000]],
          ["rankMin", "rankMax", "最低权重", [0, 10, 50, 90, 100, 200, 300, 500, 700, 1000]],
          ["rankMax", "rankMin", "最高权重", [0, 10, 50, 90, 100, 200, 300, 500, 700, 1000]],
          ["spamMin", "spamMax", "最低垃圾评分", [0, 10, 20, 30, 50, 75, 100]],
          ["spamMax", "spamMin", "最高垃圾评分", [0, 10, 20, 30, 50, 75, 100]],
        ] as const).map(([field, opposite, label, values]) => (
          <label key={field} className="min-w-0 space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <select
              className="h-9 w-full border border-input bg-background px-3 text-sm"
              value={filters[field] ?? ""}
              onChange={(event) => updateFilters({ [field]: optionalNumber(event.target.value) })}
            >
              <option value="">不限</option>
              {values.map((value) => (
                <option key={value} value={value} disabled={
                  filters[opposite] !== undefined && (field.endsWith("Min")
                    ? value > filters[opposite]!
                    : value < filters[opposite]!)
                }>{value.toLocaleString()}</option>
              ))}
            </select>
          </label>
        ))}
        <label className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            排序
          </span>
          <select
            className="h-9 w-full border border-input bg-background px-3 text-sm"
            value={filters.sort ?? "released_desc"}
            onChange={(event) =>
              updateFilters({
                sort: event.target.value as RecommendationFeedFilters["sort"],
              })
            }
          >
            <option value="released_desc">联系方式优先 · 最新发布</option>
            <option value="released_asc">最早发布</option>
            <option value="domain_asc">域名</option>
            <option value="traffic_desc">流量</option>
            <option value="rank_desc">网站权重从高到低</option>
            <option value="spam_asc">垃圾评分从低到高</option>
          </select>
        </label>
        <label className="flex min-h-9 items-end gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={filters.recommendedOnly ?? false}
            onChange={(event) =>
              updateFilters({
                recommendedOnly: event.target.checked || undefined,
              })
            }
          />
          仅推荐
        </label>
        <div className="flex items-end">
          <Button
            variant="outline"
            size="icon"
            aria-label="重置筛选"
            title="重置筛选"
            onClick={() => {
              setFilters({ sort: "released_desc", limit: 35 })
              setCursorStack([null])
              setSelectedIds(new Set())
            }}
          >
            <RotateCcw className="size-4" />
          </Button>
        </div>
      </section>

      <div className="recommendation-content">
      {recentlyArchived ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-muted/40 px-3 py-2 text-sm">
          <span>{recentlyArchived.domain} 已归档</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void handleUndoArchive()}
          >
            <RotateCcw className="size-4" />
            撤销
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {actionNotice ? (
        <p role="status" className="text-sm text-emerald-700">
          {actionNotice}
        </p>
      ) : null}

      {feed.state === "loading" ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          正在加载推荐…
        </p>
      ) : feed.state === "empty" ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          当前筛选条件下没有已发布推荐。
        </p>
      ) : feed.state === "forbidden" ? (
        <p role="alert" className="py-12 text-center text-sm text-destructive">
          你没有查看此项目推荐的权限。
        </p>
      ) : feed.state === "conflict" ? (
        <p role="alert" className="py-12 text-center text-sm text-destructive">
          推荐上下文已更新，请刷新后继续。
        </p>
      ) : feed.state === "offline" ? (
        <p role="alert" className="py-12 text-center text-sm text-destructive">
          当前离线，恢复网络后可重试。
        </p>
      ) : feed.state === "error" ? (
        <p role="alert" className="py-12 text-center text-sm text-destructive">
          推荐加载失败，请重试。
        </p>
      ) : (
        <section aria-label="已发布推荐" className="recommendation-results space-y-2">
          <div className="recommendation-results-heading flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              {selectedBatch
                ? `第 ${selectedBatch.visiblePoolGeneration} 轮 · 第 ${selectedBatch.batchOrdinal} 批`
                : releasedPoolLabel(feed.response)} · 共{" "}
              {feed.response?.totalCount ?? 0} 条已发布推荐
            </span>
            <span>{selectedIds.size} 条已选择</span>
          </div>
          <div className="recommendation-items">
            {feed.response?.items.map((item) => {
              const selected = selectedIds.has(item.itemId)
              const busy = pendingItem?.id === item.itemId
              return (
                <article
                  key={item.itemId}
                  className="recommendation-item"
                  data-selected={selected}
                >
                  <div className="recommendation-identity min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        aria-label={`选择 ${item.domain}`}
                        checked={selected}
                        onChange={(event) => {
                          setSelectedIds((current) => {
                            const next = new Set(current)
                            if (event.target.checked) next.add(item.itemId)
                            else next.delete(item.itemId)
                            return next
                          })
                        }}
                      />
                      <a
                        href={item.displayUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate font-medium text-foreground hover:underline"
                      >
                        {item.domain}
                      </a>
                      {item.recommended ? (
                        <span className="shrink-0 bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                          推荐
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {item.category ?? "未分类"} · 发布于{" "}
                      {releasedAt(item.releasedAt)}
                    </p>
                    {item.reasons.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                        {item.reasons.map((reason) => (
                          <li key={reason} className="[overflow-wrap:anywhere]">
                            {recommendationReasonLabel(reason)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <dl className="recommendation-metrics grid grid-cols-3 gap-3 text-sm [&_dd]:mt-2 [&_dd]:tabular-nums">
                    <div>
                      <dt className="text-xs text-muted-foreground">自然搜索 ETV</dt>
                      <dd>{metric(item.metrics.targetMarketOrganicTraffic)}</dd>
                    </div>
                    <div>
                      <dt title="DataForSEO Rank" className="text-xs text-muted-foreground">
                        DataForSEO Rank
                      </dt>
                      <dd>{metric(item.metrics.dataForSeoRank)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">垃圾评分</dt>
                      <dd>{metric(item.metrics.spamScore)}</dd>
                    </div>
                    {item.metrics.ahrefsDr != null || item.metrics.libraryMonthlyTraffic != null ? (
                      <>
                        <div>
                          <dt className="text-xs text-muted-foreground">Ahrefs DR</dt>
                          <dd>{metric(item.metrics.ahrefsDr ?? null)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">库月流量</dt>
                          <dd>{metric(item.metrics.libraryMonthlyTraffic ?? null)}</dd>
                        </div>
                      </>
                    ) : null}
                  </dl>
                  <div className="recommendation-contact min-w-0 text-sm">
                    <p className="text-xs text-muted-foreground">联系方式</p>
                    <p className="mt-1 break-words">
                      <ContactDestination item={item} />
                    </p>
                    <p className="mt-3 text-xs text-muted-foreground">
                      外链机会
                    </p>
                    <p className="mt-1">
                      {recommendationOpportunityLabel(item)}
                    </p>
                  </div>
                  <div className="recommendation-actions">
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        busy || item.opportunity.createdByCurrentUser === true
                      }
                      onClick={() => void handleOpportunity(item)}
                    >
                      <Plus className="size-4" />
                      {pendingItem?.id === item.itemId &&
                      pendingItem.action === "opportunity"
                        ? "处理中"
                        : "加入"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void handleArchive(item)}
                    >
                      <Archive className="size-4" />
                      归档
                    </Button>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}

      <footer className="recommendation-pagination flex items-center justify-between border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={cursorStack.length === 1}
          onClick={() =>
            setCursorStack((current) =>
              current.length > 1 ? current.slice(0, -1) : current
            )
          }
        >
          <ChevronLeft className="size-4" />
          上一页
        </Button>
        <span className="text-sm text-muted-foreground">
          第 {cursorStack.length} 页
        </span>
        <Button
          type="button"
          variant="outline"
          disabled={!feed.response?.nextCursor}
          onClick={() => {
            const nextCursor = feed.response?.nextCursor
            if (nextCursor) {
              setCursorStack((current) => [...current, nextCursor])
            }
          }}
        >
          下一页
          <ChevronRight className="size-4" />
        </Button>
      </footer>
      </div>
      </div>
    </div>
  )
}
