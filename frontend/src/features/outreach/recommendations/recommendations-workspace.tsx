import * as React from "react"
import {
  Archive,
  CirclePlus,
  Clock3,
  ExternalLink,
  LoaderCircle,
  Mail,
  RefreshCw,
  RotateCw,
  Search,
} from "lucide-react"
import { useNavigate } from "react-router"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ApiError } from "@/api/client"
import { backlinksProjectQueries } from "@/features/outreach/api/project-query"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"
import type { OutreachProject } from "@/features/outreach/project"

import {
  archiveRecommendationPool,
  createOpportunity,
  getRecommendationInventory,
  requestRecommendationRefill,
  retryUnpublishedContacts,
  type RecommendationInventoryStatus,
  type RecommendationItem,
} from "./api"
import {
  type RecommendationRefillState,
  useRecommendationRefill,
} from "./use-recommendation-refill"
import {
  releaseRecommendationStartLease,
  subscribeRecommendationOperation,
  tryAcquireRecommendationStartLease,
} from "./recommendation-operation-session"
import { useRecommendations } from "./use-recommendations"

const reasonLabels: Record<string, string> = {
  PUBLIC_EMAIL_FOUND: "公开邮箱已验证",
  CONTACT_FORM_ONLY: "仅发现联系表单",
  LOGIN_REQUIRED: "页面需要登录",
  CAPTCHA_OR_BOT_CHALLENGE: "触发人机验证",
  ROBOTS_DISALLOWED: "站点禁止自动访问",
  ACCESS_DENIED: "页面拒绝访问",
  NO_PUBLIC_EMAIL: "未发现公开邮箱",
  SITE_UNREACHABLE: "站点无法访问",
  UNSUPPORTED_CONTENT: "页面内容暂不支持",
  MANUAL_REVIEW_REQUIRED: "需要人工复核",
  COMPLETED_PARTIAL: "部分页面已完成",
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

function metric(value: number | null) {
  return value === null ? "数据源未提供" : value.toLocaleString("zh-CN")
}

function fitTierLabel(value: RecommendationItem["fitDecision"]["matchTier"]) {
  return value === "high_fit" ? "高适合度" : "合格适合度"
}

function marketTierLabel(
  value: RecommendationItem["fitDecision"]["market"]["tier"]
) {
  return value === "target_market" ? "目标市场匹配" : "同语种扩展市场"
}

function candidateSourceLabel(value: RecommendationItem["candidateSource"]) {
  return {
    paid_discovery: "DataForSEO 发现",
    resource_library: "资源库补充",
    mixed: "统一供给",
    existing_history: "历史候选",
  }[value]
}

function metricsSourceLabel(value: RecommendationItem["metricsSource"]) {
  return {
    dataforseo: "DataForSEO 指标",
    resource_library_snapshot: "资源库快照指标",
    mixed_snapshot: "混合来源快照",
    historical_snapshot: "历史快照指标",
  }[value]
}

function formatQueryTime(value: number | null) {
  if (value === null) return "尚未查询"
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

function formatServerTime(value: string | null) {
  return value === null ? "服务端未提供" : formatDate(value)
}

function formatProviderCost(value: number) {
  return `$${(value / 1_000_000).toFixed(4)}`
}

const refillTierLabels: Record<
  RecommendationInventoryStatus["currentRefillTier"],
  string
> = {
  exact_product_target_market: "精确产品与目标市场",
  same_topic_target_market: "同主题与目标市场",
  adjacent_industry_same_audience: "邻近行业与相同受众",
  resource_media_review_partner_ecosystem: "资源、媒体、评测与伙伴生态",
  same_language_expansion: "同语种扩展",
  curated_resource_library: "高权重资源库补充",
}

function refillTerminationMessage(
  inventory: RecommendationInventoryStatus | null
) {
  if (inventory === null) return null
  const count = inventory.publishedContactReadyCount
  switch (inventory.terminationReason) {
    case "BUDGET":
      return `本轮因 DataForSEO 预算不足停止。当前真实可发布网站为 ${count} 个。`
    case "PROVIDER_UNAVAILABLE":
      return `本轮因 DataForSEO 当前不可用停止。当前真实可发布网站为 ${count} 个。`
    case "TIERS_EXHAUSTED":
      return `五层付费发现与资源库补充均已完成，仍只有 ${count} 个真实可发布网站。系统不会伪造补足。`
    case "PROJECT_CONTEXT":
      return `当前项目资料不足，无法继续发现。当前真实可发布网站为 ${count} 个。`
    default:
      return null
  }
}

function ContactBatchWaitView({
  project,
  wait,
  batch,
  inventory,
  error,
  retrying,
  requesting,
  actionLabel,
  onStart,
  onRetry,
  onRefresh,
}: {
  project: Project
  wait: RecommendationRefillState
  batch: RecommendationInventoryStatus["contactBatch"]
  inventory: RecommendationInventoryStatus | null
  error: string | null
  retrying: boolean
  requesting: boolean
  actionLabel: string
  onStart: () => void | Promise<void>
  onRetry: () => void
  onRefresh: () => void
}) {
  const running = wait.status === "running" && inventory?.stage !== "pause"
  const terminationMessage = refillTerminationMessage(inventory)
  const poolMessage =
    inventory?.visiblePoolState === "awaiting_refresh"
      ? `第 ${inventory.visiblePoolGeneration - 1} 轮已归档。生成下一轮后，系统会重新寻找 10 个未在历史轮次出现的可联系网站。`
      : null
  const progressMetrics: ReadonlyArray<readonly [string, string | number]> = [
    ["阶段", wait.phase],
    [
      "当前层级",
      inventory === null
        ? "等待服务端"
        : refillTierLabels[inventory.currentRefillTier],
    ],
    ["原始候选", inventory?.rawCandidateCount ?? 0],
    ["联系人终态", batch?.terminalJobCount ?? 0],
    [
      "Provider 成本",
      formatProviderCost(inventory?.providerActualCostMicros ?? 0),
    ],
    ["付费调用", inventory?.providerPaidCallCount ?? 0],
    ["服务端更新", formatServerTime(wait.lastServerUpdateAt)],
  ]
  return (
    <div
      className="flex min-h-64 flex-col items-center justify-center border-y bg-muted/20 px-4 py-8 text-center"
      role={
        wait.status === "failed" || wait.status === "partial"
          ? "alert"
          : "status"
      }
      aria-busy={running || undefined}
    >
      {running ? (
        <LoaderCircle className="mb-3 size-5 animate-spin text-muted-foreground" />
      ) : (
        <Clock3 className="mb-3 size-5 text-muted-foreground" />
      )}
      <h2 className="text-sm font-medium">
        {inventory?.visiblePoolState === "awaiting_refresh"
          ? "当前推荐轮次已归档"
          : "当前没有已发布的可联系推荐"}
      </h2>
      <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
        {poolMessage ??
          terminationMessage ??
          `${project.name} 的候选网站会自动进入联系人发现批次。这里只显示具备公开证据、已冻结默认联系人并通过发布门禁的网站。`}
      </p>
      {inventory !== null && (
        <div className="mt-5 grid w-full max-w-2xl grid-cols-2 gap-3 text-left sm:grid-cols-4">
          {[
            ["原始候选", inventory.rawCandidateCount],
            ["真实可发布", inventory.publishedContactReadyCount],
            ["推荐轮次", `第 ${inventory.visiblePoolGeneration} 轮`],
            ["本轮目标", inventory.visiblePoolTargetCount],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0 border-l-2 pl-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1 text-sm font-medium">{value}</div>
            </div>
          ))}
        </div>
      )}
      {wait.status !== "idle" && (
        <div className="mt-5 grid w-full max-w-4xl grid-cols-2 gap-3 text-left sm:grid-cols-4">
          {progressMetrics.map(([label, value]) => (
            <div key={label} className="min-w-0 border-l-2 pl-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1 truncate text-sm font-medium">{value}</div>
            </div>
          ))}
        </div>
      )}
      {(inventory?.providerUnknownChargeCount ?? 0) > 0 && (
        <div className="mt-4 text-sm text-destructive">
          检测到 {inventory?.providerUnknownChargeCount} 个未知扣费请求，当前轮次已按治理规则暂停。
        </div>
      )}
      {batch !== null && (
        <>
          <div className="mt-5 grid w-full max-w-2xl grid-cols-2 gap-3 text-left sm:grid-cols-4">
            {[
              ["候选网站", batch.totalJobCount],
              ["已发布", batch.publishedCount],
              ["未发布", batch.unpublishedCount],
              ["已终态", `${batch.terminalJobCount}/${batch.totalJobCount}`],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 border-l-2 pl-3">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-1 text-sm font-medium">{value}</div>
              </div>
            ))}
          </div>
          {batch.reasonCounts.length > 0 && (
            <div className="mt-4 flex max-w-2xl flex-wrap justify-center gap-2">
              {batch.reasonCounts.map((reason) => (
                <Badge key={reason.reasonCode} variant="outline">
                  {reasonLabels[reason.reasonCode] ?? reason.reasonCode}{" "}
                  {reason.count}
                </Badge>
              ))}
            </div>
          )}
        </>
      )}
      {inventory !== null && inventory.attemptedRefillTiers.length > 0 && (
        <div className="mt-4 flex max-w-2xl flex-wrap justify-center gap-2">
          {inventory.attemptedRefillTiers.map((attempt, attemptIndex) => (
            <Badge
              key={`${attempt.round}:${attempt.tier}:${attemptIndex}`}
              variant="outline"
            >
              第 {attempt.round} 轮 · {refillTierLabels[attempt.tier]}
            </Badge>
          ))}
        </div>
      )}
      {inventory !== null && inventory.eliminationReasonCounts.length > 0 && (
        <div className="mt-3 flex max-w-2xl flex-wrap justify-center gap-2">
          {inventory.eliminationReasonCounts.map((reason) => (
            <Badge key={reason.reasonCode} variant="secondary">
              {reasonLabels[reason.reasonCode] ?? reason.reasonCode}{" "}
              {reason.count}
            </Badge>
          ))}
        </div>
      )}
      {(wait.error || error) && (
        <p className="mt-4 text-sm text-destructive">{wait.error ?? error}</p>
      )}
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button
          onClick={() => void onStart()}
          disabled={requesting || inventory === null}
        >
          {running || requesting ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Search />
          )}
          {inventory === null ? "读取服务端状态" : actionLabel}
        </Button>
        <Button variant="outline" onClick={onRefresh}>
          <RefreshCw />
          重新读取
        </Button>
        {batch !== null && batch.retryableUnpublishedCount > 0 && (
          <Button variant="outline" onClick={onRetry} disabled={retrying}>
            <RefreshCw className={retrying ? "animate-spin" : undefined} />
            仅重试未发布
          </Button>
        )}
      </div>
    </div>
  )
}

function WebsiteIdentity({ item }: { item: RecommendationItem }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted text-xs font-semibold">
        {item.hostname.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0">
        <a
          href={item.rootUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-center gap-1 font-medium hover:underline"
        >
          <span className="truncate">{item.hostname}</span>
          <ExternalLink className="size-3.5 shrink-0" />
        </a>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {item.rootUrl}
        </div>
      </div>
    </div>
  )
}

function ProjectRecommendationsWorkspace({
  project,
}: {
  project: OutreachProject
}) {
  const websiteProjectKey = project.id
  const navigate = useNavigate()
  const query = useRecommendations(websiteProjectKey, true)
  const refreshRecommendations = query.refresh
  const readInventory = React.useCallback(
    (signal: AbortSignal) =>
      getRecommendationInventory(websiteProjectKey, signal),
    [websiteProjectKey]
  )
  const refreshRecommendationsFromInventory = React.useCallback(async () => {
    await refreshRecommendations()
  }, [refreshRecommendations])
  const wait = useRecommendationRefill(
    project,
    readInventory,
    refreshRecommendationsFromInventory
  )
  const inventory = wait.inventory
  const [requestingRefill, setRequestingRefill] = React.useState(false)
  const [poolAction, setPoolAction] = React.useState<
    "archive" | "archive-and-refresh" | null
  >(null)
  const [error, setError] = React.useState<string | null>(null)
  const refillRequestInFlight = React.useRef(false)
  const automaticFirstPoolKey = React.useRef<string | null>(null)
  const [startLeaseOwnerId] = React.useState(() => crypto.randomUUID())
  const refreshWait = wait.refresh
  const recommendationContextVersionId =
    inventory?.recommendationContextVersionId ?? null
  const visiblePoolGeneration = inventory?.visiblePoolGeneration ?? null
  React.useEffect(() => {
    if (
      recommendationContextVersionId === null ||
      visiblePoolGeneration === null
    ) {
      return
    }
    return subscribeRecommendationOperation(
      {
        websiteProjectKey,
        recommendationContextVersionId,
        visiblePoolGeneration,
      },
      () => refreshWait()
    )
  }, [
    recommendationContextVersionId,
    refreshWait,
    visiblePoolGeneration,
    websiteProjectKey,
  ])
  const hasEverDiscovered =
    inventory !== null &&
    (inventory.refillJob !== null ||
      inventory.latestRefillAt !== null ||
      inventory.rawCandidateCount > 0 ||
      inventory.contactBatch !== null)
  const refillPaused =
    inventory?.terminalState === "PAUSED_BUDGET" ||
    inventory?.terminalState === "PAUSED_PROVIDER"
  const contactRecoveryRequired =
    wait.contactBatchActivity === "recovery_required"
  const refillActionLabel = contactRecoveryRequired
    ? "重新检查状态"
    : refillPaused
      ? "继续原任务"
      : wait.active
        ? "连接当前批次"
        : inventory?.visiblePoolState === "awaiting_refresh"
          ? "生成下一轮"
          : hasEverDiscovered
            ? "继续生成本轮"
            : "生成推荐"
  const refreshAll = React.useCallback(async () => {
    setError(null)
    refreshWait()
    await refreshRecommendations()
  }, [refreshRecommendations, refreshWait])

  const startOrReconnectRefill = React.useCallback(async () => {
    if (contactRecoveryRequired) {
      wait.refresh()
      return
    }
    if (wait.active && !refillPaused) {
      wait.refresh()
      return
    }
    if (
      refillRequestInFlight.current ||
      inventory === null ||
      inventory.recommendationContextVersionId === null
    ) {
      if (inventory !== null) {
        setError("当前项目缺少可用的推荐 Context，请重新读取项目资料。")
      }
      return
    }

    const operationScope = {
      websiteProjectKey,
      recommendationContextVersionId: inventory.recommendationContextVersionId,
      visiblePoolGeneration: inventory.visiblePoolGeneration,
    }
    if (
      !tryAcquireRecommendationStartLease(
        window.localStorage,
        operationScope,
        startLeaseOwnerId
      )
    ) {
      setError("另一个标签页正在连接当前任务，正在读取同一 operation。")
      wait.refresh()
      return
    }

    refillRequestInFlight.current = true
    setRequestingRefill(true)
    setError(null)
    try {
      const result = await requestRecommendationRefill(
        websiteProjectKey,
        inventory.recommendationContextVersionId,
        inventory.visiblePoolGeneration,
        9,
        10
      )
      wait.connectJob(result)
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.status === 409) {
        setError("服务端已有当前项目批次，正在重新连接该批次。")
        wait.refresh()
      } else {
        setError("未能创建推荐批次，请重新读取服务端状态后再试。")
      }
    } finally {
      releaseRecommendationStartLease(
        window.localStorage,
        operationScope,
        startLeaseOwnerId
      )
      refillRequestInFlight.current = false
      setRequestingRefill(false)
    }
  }, [
    contactRecoveryRequired,
    inventory,
    refillPaused,
    startLeaseOwnerId,
    wait,
    websiteProjectKey,
  ])

  React.useEffect(() => {
    if (
      inventory === null ||
      inventory.recommendationContextVersionId === null ||
      inventory.visiblePoolGeneration !== 1 ||
      inventory.visiblePoolState !== "idle" ||
      hasEverDiscovered ||
      project.inputRequired.length > 0 ||
      wait.active
    ) {
      return
    }
    const key = `${websiteProjectKey}:${inventory.recommendationContextVersionId}:g1`
    if (automaticFirstPoolKey.current === key) return
    automaticFirstPoolKey.current = key
    void startOrReconnectRefill()
  }, [
    hasEverDiscovered,
    inventory,
    project.inputRequired.length,
    startOrReconnectRefill,
    wait.active,
    websiteProjectKey,
  ])

  async function archiveCurrentPool(generateNext: boolean) {
    if (
      poolAction !== null ||
      inventory === null ||
      inventory.recommendationContextVersionId === null ||
      inventory.visiblePoolState !== "active"
    ) {
      return
    }
    setPoolAction(generateNext ? "archive-and-refresh" : "archive")
    setError(null)
    try {
      const archived = await archiveRecommendationPool(
        websiteProjectKey,
        inventory.recommendationContextVersionId,
        inventory.visiblePoolGeneration
      )
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "recommendations",
      ])
      await refreshRecommendations()
      refreshWait()
      if (!generateNext) {
        setOpportunityAnnouncement(
          `第 ${archived.archivedGeneration} 轮推荐已归档。`
        )
        return
      }

      const nextScope = {
        websiteProjectKey,
        recommendationContextVersionId:
          inventory.recommendationContextVersionId,
        visiblePoolGeneration: archived.nextGeneration,
      }
      if (
        !tryAcquireRecommendationStartLease(
          window.localStorage,
          nextScope,
          startLeaseOwnerId
        )
      ) {
        setError("本轮已归档，另一个标签页正在生成下一轮。")
        refreshWait()
        return
      }
      try {
        const refill = await requestRecommendationRefill(
          websiteProjectKey,
          inventory.recommendationContextVersionId,
          archived.nextGeneration,
          9,
          10
        )
        wait.connectJob(refill)
        setOpportunityAnnouncement(
          `第 ${archived.archivedGeneration} 轮已归档，第 ${archived.nextGeneration} 轮已开始生成。`
        )
      } finally {
        releaseRecommendationStartLease(
          window.localStorage,
          nextScope,
          startLeaseOwnerId
        )
      }
    } catch (poolError) {
      setError(
        poolError instanceof ApiError && poolError.status === 409
          ? "推荐池状态已变化，请重新读取后再操作。"
          : "推荐池操作失败，请重新读取服务端状态后再试。"
      )
      refreshWait()
    } finally {
      setPoolAction(null)
    }
  }
  const [search, setSearch] = React.useState("")
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const addRequestInFlight = React.useRef(false)
  const [joinedOpportunityIds, setJoinedOpportunityIds] = React.useState<
    Readonly<Record<string, string>>
  >({})
  const [opportunityError, setOpportunityError] = React.useState<{
    recommendationId: string
    message: string
  } | null>(null)
  const [opportunityAnnouncement, setOpportunityAnnouncement] =
    React.useState("")
  const [retrying, setRetrying] = React.useState(false)

  async function retryUnpublished() {
    if (retrying) return
    setRetrying(true)
    setError(null)
    try {
      const result = await retryUnpublishedContacts(websiteProjectKey)
      const batchId = result.batchId
      if (batchId === null) {
        wait.refresh()
      } else {
        wait.connectBatch(batchId)
      }
    } catch {
      setError("未能重试本批未发布网站，请重新读取批次状态。")
    } finally {
      setRetrying(false)
    }
  }

  async function addOpportunity(item: RecommendationItem) {
    const contact = item.contacts.find(
      (candidate) =>
        candidate.id === item.recommendedContactCandidateId &&
        candidate.eligible
    )
    if (
      !contact ||
      busyId ||
      addRequestInFlight.current ||
      joinedOpportunityIds[item.id]
    ) {
      return
    }
    addRequestInFlight.current = true
    setBusyId(item.id)
    setOpportunityError(null)
    try {
      const result = await createOpportunity(
        websiteProjectKey,
        item.id,
        contact.id,
        item.version
      )
      if (result.websiteProjectId !== result.meta.websiteProjectId) {
        throw new Error("Opportunity project identity mismatch")
      }
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "recommendations",
      ])
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "opportunities",
      ])
      setJoinedOpportunityIds((current) => ({
        ...current,
        [item.id]: result.opportunityId,
      }))
      setOpportunityAnnouncement(
        `${item.hostname} 已加入 Opportunity。你仍在推荐池中。`
      )
    } catch {
      setOpportunityError({
        recommendationId: item.id,
        message:
          "创建 Opportunity 失败。请刷新推荐，确认冻结联系人证据仍有效。",
      })
    } finally {
      addRequestInFlight.current = false
      setBusyId(null)
    }
  }

  if (query.status === "loading") {
    return <OutreachStandardStateView state="loading" title="正在加载推荐池" />
  }
  if (query.status === "empty") {
    if (project.inputRequired.length > 0) {
      return (
        <OutreachStandardStateView
          state="empty"
          title="先完善当前项目资料"
          description={`缺少 ${project.inputRequired.join("、")}，服务端不会使用其他项目资料代替。`}
          onRetry={() =>
            navigate(`/projects/${websiteProjectKey}/settings/profile`)
          }
          retryLabel="完善项目资料"
        />
      )
    }
    return (
      <ContactBatchWaitView
        project={project}
        wait={wait}
        batch={wait.batch ?? inventory?.contactBatch ?? null}
        inventory={inventory}
        error={error}
        retrying={retrying}
        requesting={requestingRefill}
        actionLabel={refillActionLabel}
        onStart={startOrReconnectRefill}
        onRetry={() => void retryUnpublished()}
        onRefresh={() => void refreshAll()}
      />
    )
  }
  if (query.status !== "data") {
    return (
      <OutreachStandardStateView
        state={query.status}
        title={
          query.status === "forbidden"
            ? "当前账号无权查看该项目的推荐"
            : query.status === "offline"
              ? "推荐池当前离线"
              : "推荐池加载失败"
        }
        description="不会回退到演示数据或其他项目数据。"
        onRetry={() => void refreshAll()}
        retryLabel="重新读取"
      />
    )
  }

  const batch = wait.batch ?? inventory?.contactBatch ?? null
  const rows = query.items.filter((item) =>
    item.hostname.toLowerCase().includes(search.trim().toLowerCase())
  )

  return (
    <div>
      <div className="sr-only" role="status" aria-live="polite">
        {opportunityAnnouncement}
      </div>
      {wait.status !== "idle" && (
        <div
          className="mb-4 border-l-2 border-primary bg-muted/30 px-4 py-3 text-sm"
          role={
            wait.status === "failed" || wait.status === "partial"
              ? "alert"
              : "status"
          }
          aria-busy={
            (wait.status === "running" && inventory?.stage !== "pause") ||
            undefined
          }
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-medium">
              {wait.status === "running" && inventory?.stage !== "pause" ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Clock3 className="size-4" />
              )}
              {wait.phase}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              原始候选 {inventory?.rawCandidateCount ?? 0} · 联系人终态{" "}
              {batch?.terminalJobCount ?? 0} · 当前层级{" "}
              {inventory
                ? refillTierLabels[inventory.currentRefillTier]
                : "等待服务端"}{" "}
              · Provider 成本{" "}
              {formatProviderCost(inventory?.providerActualCostMicros ?? 0)}
              {" "}· 付费调用 {inventory?.providerPaidCallCount ?? 0}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              已读取 {wait.pollCount} 次 · 最后读取{" "}
              {formatQueryTime(wait.lastQueryAt)}
            </div>
            {wait.error && (
              <div className="mt-1 text-xs text-destructive">{wait.error}</div>
            )}
          </div>
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["本轮推荐", query.items.length],
          ["本轮目标", inventory?.visiblePoolTargetCount ?? 10],
          [
            "已加入机会",
            query.items.filter(
              (item) =>
                item.existingOpportunityId !== null ||
                joinedOpportunityIds[item.id] !== undefined
            ).length,
          ],
          ["历史已归档", inventory?.archivedVisiblePoolCount ?? 0],
        ].map(([label, value]) => (
          <Card key={label} size="sm">
            <CardContent>
              <div className="text-sm text-muted-foreground">{label}</div>
              <div className="mt-2 text-2xl font-semibold">{value}</div>
              <div className="mt-1 text-xs text-muted-foreground">当前项目</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="space-y-3 border-b p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索已发布网站..."
                className="pl-9 sm:max-w-sm"
              />
            </div>
            <Button
              variant="outline"
              onClick={() => void archiveCurrentPool(false)}
              disabled={
                poolAction !== null || inventory?.visiblePoolState !== "active"
              }
            >
              {poolAction === "archive" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Archive />
              )}
              归档本轮
            </Button>
            <Button
              onClick={() => void archiveCurrentPool(true)}
              disabled={
                poolAction !== null || inventory?.visiblePoolState !== "active"
              }
            >
              {poolAction === "archive-and-refresh" ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RotateCw />
              )}
              归档并生成下一轮
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => void refreshAll()}
              title="重新读取"
              aria-label="重新读取"
            >
              <RefreshCw />
            </Button>
          </div>
          {batch !== null && batch.reasonCounts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {batch.reasonCounts.map((reason) => (
                <Badge key={reason.reasonCode} variant="outline">
                  {reasonLabels[reason.reasonCode] ?? reason.reasonCode}{" "}
                  {reason.count}
                </Badge>
              ))}
            </div>
          )}
          {error && (
            <div role="alert" className="text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="divide-y">
          {rows.map((item) => {
            const fit = item.fitDecision
            const contact = item.contacts.find(
              (candidate) =>
                candidate.id === item.recommendedContactCandidateId &&
                candidate.eligible
            )
            const evidence = contact?.evidence[0]
            const isBusy = busyId === item.id
            const joinedOpportunityId = joinedOpportunityIds[item.id]
            return (
              <article
                key={item.id}
                className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(15rem,0.9fr)_minmax(16rem,1fr)]"
              >
                <section className="min-w-0 space-y-3">
                  <WebsiteIdentity item={item} />
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">
                      {fitTierLabel(fit.matchTier)} · 综合适合度{" "}
                      {fit.overallFit.toFixed(1)}
                    </Badge>
                    <Badge variant="outline">
                      {marketTierLabel(fit.market.tier)}
                    </Badge>
                    <Badge variant="outline">
                      {candidateSourceLabel(item.candidateSource)}
                    </Badge>
                    {item.resourceType !== null && (
                      <Badge variant="outline">
                        资源库 {item.resourceType === "free" ? "免费" : "付费"}
                      </Badge>
                    )}
                    <Badge variant="outline">
                      {item.priority === "high" ? "高优先级" : "标准优先级"}
                    </Badge>
                    <Badge variant="outline">风险 {item.risk.level}</Badge>
                    <Badge>公开邮箱已验证</Badge>
                    <span className="text-xs text-muted-foreground">
                      获取于 {formatDate(item.acquiredAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      ...fit.matchedProducts.map((value) => `产品：${value}`),
                      ...fit.matchedTopics.map((value) => `主题：${value}`),
                      ...fit.matchedKeywords.map((value) => `关键词：${value}`),
                    ].map((reason) => (
                      <Badge key={reason} variant="outline">
                        {reason}
                      </Badge>
                    ))}
                  </div>
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <div>
                      市场：目标 {fit.market.targetCountry} /{" "}
                      {fit.market.targetLanguage}；候选{" "}
                      {fit.market.candidateCountry ?? "国家未提供"} /{" "}
                      {fit.market.candidateLanguage ?? "语言未识别"}
                    </div>
                    <div>
                      合作角度：
                      {fit.cooperationAngles.join("、") || "编辑合作评估合格"}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    指标来源：{metricsSourceLabel(item.metricsSource)}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                    <div>
                      <span className="text-muted-foreground">Rank</span>
                      <div className="mt-1 font-medium">
                        {metric(fit.dataForSeo.rank)}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">流量</span>
                      <div className="mt-1 font-medium">
                        {metric(fit.dataForSeo.traffic)}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Backlinks</span>
                      <div className="mt-1 font-medium">
                        {metric(fit.dataForSeo.backlinks)}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">
                        Ref. Domains
                      </span>
                      <div className="mt-1 font-medium">
                        {metric(fit.dataForSeo.referringDomains)}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">垃圾风险</span>
                      <div className="mt-1 font-medium">
                        {metric(fit.dataForSeo.spamScore)}
                      </div>
                    </div>
                  </div>
                  {item.relevantPages.length > 0 && (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {item.relevantPages.map((url) => (
                        <a
                          key={url}
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
                        >
                          <span className="truncate">相关内容页</span>
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      ))}
                    </div>
                  )}
                </section>

                <section className="min-w-0 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Mail className="size-4" />
                    冻结默认联系人
                  </div>
                  {contact && evidence ? (
                    <div className="space-y-2 rounded-md border p-3 text-xs">
                      <div className="font-medium break-all">
                        {contact.normalizedEmail}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                        <span>用途 {contact.inferredPurpose}</span>
                        <span>联系人置信度 {contact.confidence}</span>
                        <span>用途置信度 {contact.purposeConfidence}</span>
                      </div>
                      <a
                        href={item.contactDecision.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
                      >
                        <span className="truncate">
                          查看公开证据 · {evidence.extractionMethod}
                        </span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                      <div className="text-muted-foreground">
                        邮箱来源：{item.emailSource.extractionMethod} ·{" "}
                        {formatDate(item.emailSource.observedAt)}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-destructive">
                      已发布记录缺少冻结联系人证据，请刷新后重试。
                    </p>
                  )}
                </section>

                <section className="flex min-w-0 flex-col justify-between gap-4">
                  <div className="space-y-2 text-xs text-muted-foreground">
                    <div>
                      已访问 {item.contactJob?.pagesVisited ?? 0} 页，证据{" "}
                      {item.contactJob?.evidenceCount ?? 0} 条
                    </div>
                    <div>
                      方法 {item.contactJob?.method ?? "none"} · 终态{" "}
                      {item.contactJob?.terminalReasonCode ?? "待同步"}
                    </div>
                    {item.createBlockReason === "existing_opportunity" && (
                      <div>该域名已在当前项目的 Opportunity 中。</div>
                    )}
                  </div>
                  {joinedOpportunityId ? (
                    <div className="space-y-2">
                      <Button disabled className="w-full">
                        已加入
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        已加入机会池，可稍后在机会页面查看。
                      </p>
                    </div>
                  ) : item.existingOpportunityId ? (
                    <Button
                      onClick={() =>
                        navigate(
                          `/projects/${websiteProjectKey}/backlinks/opportunities?opportunityId=${item.existingOpportunityId}`
                        )
                      }
                    >
                      打开 Opportunity
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void addOpportunity(item)}
                      disabled={
                        Boolean(busyId) ||
                        !item.canCreateOpportunity ||
                        !contact
                      }
                    >
                      {isBusy ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <CirclePlus />
                      )}
                      加入 Opportunity
                    </Button>
                  )}
                  {opportunityError?.recommendationId === item.id && (
                    <p role="alert" className="text-xs text-destructive">
                      {opportunityError.message}
                    </p>
                  )}
                </section>
              </article>
            )
          })}
          {rows.length === 0 && (
            <div className="p-10 text-center text-sm text-muted-foreground">
              当前搜索条件下没有已发布网站。
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}

export function RecommendationsWorkspace({
  project,
}: {
  project: OutreachProject
}) {
  return (
    <ProjectRecommendationsWorkspace
      key={`${project.id}:${project.profileVersion ?? "no-profile"}`}
      project={project}
    />
  )
}
