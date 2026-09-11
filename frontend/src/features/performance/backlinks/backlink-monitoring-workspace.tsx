import * as React from "react"
import { Link } from "react-router"
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CircleCheck,
  ExternalLink,
  Eye,
  FileClock,
  Globe2,
  Link2,
  LoaderCircle,
  RefreshCw,
  SearchX,
  ShieldCheck,
} from "lucide-react"

import {
  getPerformanceBacklinkEvents,
  getPerformanceBacklinkEvidence,
  getPerformanceBacklinkInventory,
  getPerformanceBacklinkPlacement,
  getPerformanceBacklinkProfile,
  getPerformanceBacklinkProfileSyncJob,
  getPerformanceBacklinks,
  requestPerformanceBacklinkProfileSync,
  reverifyPerformanceBacklink,
  type PerformanceBacklinkEvidence,
  type PerformanceBacklinkEvents,
  type PerformanceBacklinkInventoryItem,
  type PerformanceBacklinkInventoryResponse,
  type PerformanceBacklinkInventoryView,
  type PerformanceBacklinkItem,
  type PerformanceBacklinkPlacement,
  type PerformanceBacklinkPlacementDetail,
  type PerformanceBacklinkProfileResponse,
  type PerformanceBacklinkProfileSyncJob,
  type PerformanceBacklinkReverifyResult,
  type PerformanceBacklinksResponse,
  type PerformanceBacklinkView,
} from "@/api/performance"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"

const pageSize = 25
const inventoryPageSize = 25
const profileSyncPollIntervalMs = 1_500
const profileSyncPollLimit = 40
const profileSyncTerminalStatuses = new Set([
  "completed",
  "partial",
  "waiting_provider",
  "failed",
])
const viewOptions: ReadonlyArray<{
  value: PerformanceBacklinkView
  label: string
}> = [
  { value: "all", label: "全部记录" },
  { value: "placements", label: "全部 Placement" },
  { value: "pending_verification", label: "等待首次验证" },
  { value: "active", label: "正常" },
  { value: "suspected_changed", label: "疑似变化" },
  { value: "changed", label: "已变化" },
  { value: "suspected_lost", label: "疑似丢失" },
  { value: "lost", label: "已丢失" },
  { value: "recovered", label: "已恢复" },
  { value: "candidate", label: "Candidate（不计 KPI）" },
]

const monitoringLabels: Record<
  PerformanceBacklinkPlacement["monitoringState"],
  string
> = {
  pending_verification: "等待首次验证",
  active: "正常",
  suspected_changed: "疑似变化",
  changed: "已变化",
  suspected_lost: "疑似丢失",
  lost: "已丢失",
}

const eventLabels: Record<
  PerformanceBacklinkEvents["items"][number]["eventType"],
  string
> = {
  "placement.confirmed": "Placement 已确认",
  "placement.changed": "外链发生变化",
  "placement.lost": "外链丢失",
  "placement.recovered": "外链恢复",
  "placement.restored": "Placement 已恢复",
}

function dateTime(value: string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

function formatCount(value: number | null | undefined) {
  if (value === null || value === undefined) return "-"
  return new Intl.NumberFormat("zh-CN").format(value)
}

function formatSignedCount(value: number) {
  if (value === 0) return "0"
  return `${value > 0 ? "+" : ""}${formatCount(value)}`
}

function urlPresentation(value: string) {
  try {
    const url = new URL(value)
    const path = url.pathname === "/" ? "首页" : url.pathname
    return {
      host: url.hostname,
      path: path.length > 52 ? `${path.slice(0, 49)}...` : path,
    }
  } catch {
    return { host: value, path: "" }
  }
}

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError"
}

function initialProfileSyncKey(projectId: string) {
  return `performance-backlinks-profile-initial-v1:${projectId}`
}

function waitForNextProfilePoll(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, profileSyncPollIntervalMs)
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer)
        reject(new DOMException("Aborted", "AbortError"))
      },
      { once: true }
    )
  })
}

function stateLabel(item: PerformanceBacklinkItem) {
  if (item.recordType === "candidate") return "Candidate"
  if (item.displayState === "recovered") return "已恢复"
  return monitoringLabels[item.monitoringState]
}

function stateVariant(item: PerformanceBacklinkItem) {
  if (item.recordType === "candidate") return "secondary" as const
  if (item.monitoringState === "lost" || item.monitoringState === "changed") {
    return "destructive" as const
  }
  if (
    item.monitoringState === "suspected_changed" ||
    item.monitoringState === "suspected_lost" ||
    item.monitoringState === "pending_verification"
  ) {
    return "outline" as const
  }
  return "default" as const
}

function contextPath(
  projectId: string,
  view: "links" | "opportunities",
  item: PerformanceBacklinkItem
) {
  const search = new URLSearchParams()
  if (item.opportunityId) search.set("opportunityId", item.opportunityId)
  if (item.replyId) search.set("replyId", item.replyId)
  if (item.recordType === "placement") {
    search.set("placementId", item.placementId)
  }
  search.set("returnTo", `/projects/${projectId}/performance/backlinks`)
  return `/projects/${projectId}/backlinks/${view}?${search.toString()}`
}

function PlacementSummary({
  response,
}: {
  response: PerformanceBacklinksResponse
}) {
  const { placements, candidates } = response.summary
  const risk =
    placements.suspectedChanged + placements.changed + placements.suspectedLost

  if (placements.total === 0) {
    return (
      <section className="flex flex-col gap-3 rounded-md border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Activity className="size-4" />
          </div>
          <div>
            <h2 className="font-medium">尚无已确认的外链成效</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              已发现的外链仍会显示在下方，不会被隐藏。
            </p>
          </div>
        </div>
        {candidates.total > 0 ? (
          <Badge variant="outline">{candidates.total} 条待确认</Badge>
        ) : null}
      </section>
    )
  }

  const metrics = [
    ["已确认外链", placements.total],
    ["正常", placements.active],
    ["需关注", risk],
    ["已丢失", placements.lost],
    ["已恢复", placements.recovered],
  ] as const

  return (
    <section className="overflow-hidden rounded-md border">
      <div className="flex flex-col gap-2 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-medium">已确认外链</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            仅统计经过确认并进入持续监控的外链成效。
          </p>
        </div>
        {candidates.total > 0 ? (
          <Badge variant="outline">{candidates.total} 条待确认</Badge>
        ) : null}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5">
        {metrics.map(([label, value], index) => (
          <div
            className={`min-w-0 px-4 py-3 ${
              index > 0 ? "border-t sm:border-t-0 sm:border-l" : ""
            } ${index === 2 ? "border-l-0 sm:border-l" : ""}`}
            key={label}
          >
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {formatCount(value)}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function EvidenceLegend() {
  return (
    <details className="group rounded-md border px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">数据口径</summary>
      <div className="mt-3 grid gap-4 border-t pt-3 text-xs text-muted-foreground md:grid-cols-2 xl:grid-cols-4">
        <div>
          <span className="font-medium text-foreground">外链发现</span>
          <div className="mt-1">来自 DataForSEO 或手动导入的项目外链库存。</div>
        </div>
        <div>
          <span className="font-medium text-foreground">直接验证</span>
          <div className="mt-1">确认来源页面和目标链接当前是否可访问。</div>
        </div>
        <div>
          <span className="font-medium text-foreground">持续监控</span>
          <div className="mt-1">跟踪已确认外链的正常、变化、丢失与恢复。</div>
        </div>
        <div>
          <span className="font-medium text-foreground">搜索索引</span>
          <div className="mt-1">索引状态独立记录，不等同于外链存活状态。</div>
        </div>
      </div>
    </details>
  )
}

function profileStatusLabel(
  profile: PerformanceBacklinkProfileResponse,
  syncing: boolean
) {
  if (syncing) return "正在同步"
  if (profile.sync.providerInputRequired) return "需要配置"
  if (!profile.sync.providerEnabled) return "Provider 未开启"
  if (profile.snapshot?.freshness === "fresh") return "数据新鲜"
  if (profile.snapshot?.freshness === "stale") return "数据已过期"
  if (profile.snapshot) return "数据不完整"
  return "等待首次同步"
}

function profileStatusVariant(
  profile: PerformanceBacklinkProfileResponse,
  syncing: boolean
) {
  if (profile.sync.status === "failed") {
    return "destructive" as const
  }
  if (
    syncing ||
    profile.sync.providerInputRequired ||
    !profile.sync.providerEnabled ||
    !profile.snapshot ||
    profile.snapshot.freshness !== "fresh"
  ) {
    return "outline" as const
  }
  return "default" as const
}

function ProfileSummary({
  profile,
  loading,
  error,
  syncing,
  syncMessage,
  refreshing,
  inventoryView,
  onInventoryViewChange,
  onRefresh,
}: {
  profile: PerformanceBacklinkProfileResponse | null
  loading: boolean
  error: string
  syncing: boolean
  syncMessage: string
  refreshing: boolean
  inventoryView: PerformanceBacklinkInventoryView
  onInventoryViewChange: (view: PerformanceBacklinkInventoryView) => void
  onRefresh: () => void
}) {
  if (loading && !profile) {
    return <Skeleton className="h-44 w-full" />
  }

  if (!profile) {
    return (
      <section className="rounded-md border px-4 py-4">
        <h2 className="font-medium">外链表现</h2>
        <p className="mt-2 text-sm text-destructive">
          {error || "暂时无法读取当前项目的外链概览。"}
        </p>
      </section>
    )
  }

  const snapshot = profile.snapshot
  const netChange =
    (snapshot?.newBacklinks ?? 0) - (snapshot?.lostBacklinks ?? 0)
  const metrics: ReadonlyArray<{
    label: string
    value: number | null | undefined
    tone: "positive" | "negative" | null
    view: PerformanceBacklinkInventoryView | null
    ariaLabel: string | null
  }> = [
    {
      label: "总外链",
      value: snapshot?.totalBacklinks,
      tone: null,
      view: "all",
      ariaLabel: "查看全部外链",
    },
    {
      label: "引用域",
      value: snapshot?.referringDomains,
      tone: null,
      view: "referring_domains",
      ariaLabel: "查看引用域",
    },
    {
      label: "新增",
      value: snapshot?.newBacklinks,
      tone: "positive",
      view: "new",
      ariaLabel: "查看新增外链",
    },
    {
      label: "丢失",
      value: snapshot?.lostBacklinks,
      tone: "negative",
      view: "lost",
      ariaLabel: "查看丢失外链",
    },
    {
      label: "净变化",
      value: snapshot ? netChange : null,
      tone: netChange >= 0 ? "positive" : "negative",
      view: null,
      ariaLabel: null,
    },
  ]

  return (
    <section className="overflow-hidden rounded-md border">
      <div className="flex flex-col gap-3 border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Globe2 className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold">外链表现</h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="truncate font-medium">
                {profile.canonicalDomain}
              </span>
              <span className="text-xs text-muted-foreground">
                {snapshot
                  ? `更新于 ${dateTime(snapshot.observedAt)}`
                  : "正在建立首次数据快照"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={profileStatusVariant(profile, syncing)}>
            {profileStatusLabel(profile, syncing)}
          </Badge>
          <Button
            aria-label="刷新外链数据"
            size="icon"
            title="刷新"
            variant="outline"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw className={refreshing ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5">
        {metrics.map((metric, index) => {
          const { label, value, tone } = metric
          const selected = inventoryView === metric.view
          const display =
            label === "净变化" && typeof value === "number"
              ? formatSignedCount(value)
              : formatCount(value)
          const content = (
            <>
              <div
                className={`text-xs ${
                  selected ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {label}
              </div>
              <div
                className={`mt-2 flex items-center gap-1 text-2xl font-semibold tabular-nums ${
                  tone === "positive" && value
                    ? "text-emerald-700 dark:text-emerald-400"
                    : tone === "negative" && value
                      ? "text-destructive"
                      : ""
                }`}
              >
                {label === "新增" && value ? (
                  <ArrowUpRight className="size-4" />
                ) : label === "丢失" && value ? (
                  <ArrowDownRight className="size-4" />
                ) : label === "净变化" && value ? (
                  value > 0 ? (
                    <ArrowUpRight className="size-4" />
                  ) : (
                    <ArrowDownRight className="size-4" />
                  )
                ) : null}
                {display}
              </div>
            </>
          )
          return (
            <div
              className={`min-w-0 ${
                index > 0 ? "border-t sm:border-t-0 sm:border-l" : ""
              } ${index === 2 ? "border-l-0 sm:border-l" : ""}`}
              key={label}
            >
              {metric.view && metric.ariaLabel ? (
                <button
                  aria-label={metric.ariaLabel}
                  aria-pressed={selected}
                  className={`w-full px-4 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none focus-visible:ring-inset ${
                    selected ? "bg-primary/5" : ""
                  }`}
                  type="button"
                  onClick={() => onInventoryViewChange(metric.view!)}
                >
                  {content}
                </button>
              ) : (
                <div className="px-4 py-4">{content}</div>
              )}
            </div>
          )
        })}
      </div>
      <div className="flex flex-col gap-2 border-t bg-muted/20 px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            已采集 {formatCount(snapshot?.inventoryPulledCount)} 条明细
          </span>
          {snapshot?.inventoryCoverage !== null &&
          snapshot?.inventoryCoverage !== undefined ? (
            <span>
              当前覆盖率{" "}
              {new Intl.NumberFormat("zh-CN", {
                style: "percent",
                maximumFractionDigits: 0,
              }).format(snapshot.inventoryCoverage)}
            </span>
          ) : null}
        </div>
        <span>
          {snapshot
            ? `下次同步 ${dateTime(snapshot.nextSyncAt)}`
            : "后台同步完成后会自动更新"}
        </span>
      </div>
      {syncMessage || error ? (
        <div
          className={`border-t px-4 py-2 text-xs ${
            error ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {error || syncMessage}
        </div>
      ) : null}
    </section>
  )
}

function inventoryStateLabel(item: PerformanceBacklinkInventoryItem) {
  if (item.providerStatus === "lost") return "供应商标记丢失"
  if (item.providerStatus === "unknown") return "待确认"
  if (item.directValidationStatus === "VALID") return "直接验证正常"
  return "已发现"
}

function inventoryStateVariant(item: PerformanceBacklinkInventoryItem) {
  if (
    item.providerStatus === "lost" ||
    item.providerStatus === "unknown" ||
    item.directValidationStatus === "UNVERIFIED"
  ) {
    return "outline" as const
  }
  return "default" as const
}

function inventoryMonitoringLabel(item: PerformanceBacklinkInventoryItem) {
  if (item.placementId) return "已纳入 Placement"
  if (item.monitoringStatus === "enabled") return "直接监控开启"
  if (item.monitoringStatus === "paused") return "监控暂停"
  return "Provider 库存"
}

function InventorySection({
  view,
  inventory,
  loading,
  error,
  onPreviousPage,
  onNextPage,
}: {
  view: PerformanceBacklinkInventoryView
  inventory: PerformanceBacklinkInventoryResponse | null
  loading: boolean
  error: string
  onPreviousPage: () => void
  onNextPage: () => void
}) {
  const content = {
    all: {
      title: "全部外链",
      description: "当前项目已发现或导入的外链明细，按最近发现时间排序。",
      tableLabel: "全部外链列表",
      emptyTitle: "当前项目尚未发现外链",
      emptyDescription:
        "发现任务或手动导入产生数据后，会按当前项目自动显示在这里。",
    },
    referring_domains: {
      title: "引用域明细",
      description:
        "基于当前已采集明细按来源域去重，每个引用域展示一条代表链接。",
      tableLabel: "引用域列表",
      emptyTitle: "当前项目尚无引用域明细",
      emptyDescription: "完成外链数据同步后，会按当前项目汇总已采集的引用域。",
    },
    new: {
      title: "新增外链",
      description: "当前项目最新一次同步快照中首次发现的外链。",
      tableLabel: "新增外链列表",
      emptyTitle: "最近一次同步没有新增外链",
      emptyDescription: "下一次同步发现新外链后，会自动显示在这里。",
    },
    lost: {
      title: "丢失外链",
      description: "当前项目最新一次同步快照中被 Provider 标记丢失的外链。",
      tableLabel: "丢失外链列表",
      emptyTitle: "最近一次同步没有丢失外链",
      emptyDescription: "后续同步检测到丢失记录后，会自动显示在这里。",
    },
  }[view]
  const countLabel =
    view === "referring_domains"
      ? `已采集 ${formatCount(inventory?.totalCount)} 个引用域`
      : view === "new"
        ? `本次新增 ${formatCount(inventory?.totalCount)} 条`
        : view === "lost"
          ? `本次丢失 ${formatCount(inventory?.totalCount)} 条`
          : `共 ${formatCount(inventory?.totalCount)} 条`

  return (
    <section className="overflow-hidden rounded-md border">
      <div className="flex flex-col gap-2 border-b px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Link2 className="size-4" />
          </div>
          <div>
            <h2 className="font-medium">{content.title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {content.description}
            </p>
          </div>
        </div>
        {inventory ? (
          <div className="flex items-center gap-2">
            <Badge variant="outline">{countLabel}</Badge>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {loading && !inventory ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : inventory?.items.length ? (
        <>
          <div>
            <table
              aria-label={content.tableLabel}
              className="w-full table-auto text-left text-sm md:table-fixed"
            >
              <thead className="hidden border-b bg-muted/20 text-xs text-muted-foreground md:table-header-group">
                <tr>
                  <th className="w-36 px-4 py-3 font-medium">状态</th>
                  <th className="w-[28%] px-4 py-3 font-medium">来源网站</th>
                  <th className="w-[28%] px-4 py-3 font-medium">链接到</th>
                  <th className="w-44 px-4 py-3 font-medium">锚文本</th>
                  <th className="w-36 px-4 py-3 font-medium">最近发现</th>
                  <th className="w-36 px-4 py-3 font-medium">监控</th>
                </tr>
              </thead>
              <tbody className="block md:table-row-group">
                {inventory.items.map((item) => {
                  const source = urlPresentation(item.sourceUrl)
                  const target = urlPresentation(item.targetUrl)
                  return (
                    <tr
                      className="grid grid-cols-2 gap-x-4 gap-y-4 border-b p-4 align-top last:border-b-0 hover:bg-muted/20 md:table-row md:p-0"
                      key={item.inventoryItemId}
                    >
                      <td className="col-span-2 block md:table-cell md:px-4 md:py-3">
                        <div className="flex items-center justify-between gap-3 md:block">
                          <Badge variant={inventoryStateVariant(item)}>
                            {inventoryStateLabel(item)}
                          </Badge>
                          <span className="text-[11px] text-muted-foreground md:mt-1.5 md:block">
                            {item.sourceType === "DATAFORSEO"
                              ? "DataForSEO"
                              : "手动导入"}
                          </span>
                        </div>
                      </td>
                      <td className="block min-w-0 md:table-cell md:px-4 md:py-3">
                        <span className="mb-1 block text-[11px] text-muted-foreground md:hidden">
                          来源网站
                        </span>
                        <a
                          className="group block min-w-0"
                          href={item.sourceUrl}
                          rel="noreferrer"
                          target="_blank"
                          title={item.sourceUrl}
                        >
                          <span className="flex items-center gap-1 truncate text-sm font-medium group-hover:text-primary">
                            {source.host}
                            <ExternalLink className="size-3 shrink-0 opacity-50" />
                          </span>
                          {source.path ? (
                            <span className="mt-1 block truncate text-xs text-muted-foreground">
                              {source.path}
                            </span>
                          ) : null}
                        </a>
                      </td>
                      <td className="block min-w-0 md:table-cell md:px-4 md:py-3">
                        <span className="mb-1 block text-[11px] text-muted-foreground md:hidden">
                          链接到
                        </span>
                        <a
                          className="group block min-w-0"
                          href={item.targetUrl}
                          rel="noreferrer"
                          target="_blank"
                          title={item.targetUrl}
                        >
                          <span className="block truncate text-sm font-medium group-hover:text-primary">
                            {target.host}
                          </span>
                          {target.path ? (
                            <span className="mt-1 block truncate text-xs text-muted-foreground">
                              {target.path}
                            </span>
                          ) : null}
                        </a>
                      </td>
                      <td className="col-span-2 block min-w-0 md:table-cell md:px-4 md:py-3">
                        <span className="mb-1 block text-[11px] text-muted-foreground md:hidden">
                          锚文本
                        </span>
                        <div className="text-xs break-words">
                          {item.anchorText || (
                            <span className="text-muted-foreground">
                              未提供锚文本
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="block md:table-cell md:px-4 md:py-3">
                        <span className="mb-1 block text-[11px] text-muted-foreground md:hidden">
                          最近发现
                        </span>
                        <div className="text-xs">
                          {dateTime(item.lastSeenAt ?? item.firstSeenAt)}
                        </div>
                      </td>
                      <td className="block md:table-cell md:px-4 md:py-3">
                        <span className="mb-1 block text-[11px] text-muted-foreground md:hidden">
                          监控
                        </span>
                        <div className="flex items-center gap-1.5 text-xs">
                          {item.placementId ? (
                            <CircleCheck className="size-3.5 text-emerald-600" />
                          ) : null}
                          <span>{inventoryMonitoringLabel(item)}</span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {inventory.totalPages > 1 ? (
            <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
              <span className="text-muted-foreground">
                第 {inventory.page} / {inventory.totalPages} 页
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={inventory.page <= 1 || loading}
                  onClick={onPreviousPage}
                >
                  <ArrowLeft />
                  上一页
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={inventory.page >= inventory.totalPages || loading}
                  onClick={onNextPage}
                >
                  下一页
                  <ArrowRight />
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex min-h-40 flex-col items-center justify-center px-6 text-center">
          <Link2 className="size-7 text-muted-foreground" />
          <h3 className="mt-3 font-medium">{content.emptyTitle}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {content.emptyDescription}
          </p>
        </div>
      )}
    </section>
  )
}

function LinkRow({
  item,
  mode,
  projectId,
  openPlacement,
}: {
  item: PerformanceBacklinkItem
  mode: "desktop" | "mobile"
  projectId: string
  openPlacement: (item: PerformanceBacklinkPlacement) => void
}) {
  const action =
    item.recordType === "placement" ? (
      <Button
        aria-label={`查看 ${item.sourcePageUrl} 监控详情`}
        size="icon-xs"
        title="查看监控详情"
        variant="ghost"
        onClick={() => openPlacement(item)}
      >
        <Eye />
      </Button>
    ) : (
      <Button
        aria-label="打开 Candidate 来源"
        size="icon-xs"
        title="打开 Candidate 来源"
        variant="ghost"
        nativeButton={false}
        render={<Link to={contextPath(projectId, "links", item)} />}
      >
        <ExternalLink />
      </Button>
    )
  if (mode === "desktop") {
    return (
      <tr className="border-b align-top hover:bg-muted/30">
        <td className="px-4 py-3">
          <Badge variant={stateVariant(item)}>{stateLabel(item)}</Badge>
          {item.recordType === "placement" &&
          item.latestFailure.status === "failed" ? (
            <div className="mt-1 text-[11px] text-destructive">
              最近尝试失败
            </div>
          ) : null}
        </td>
        <td className="max-w-72 px-4 py-3 text-xs break-all">
          {item.sourcePageUrl || "服务端未提供"}
        </td>
        <td className="max-w-72 px-4 py-3 text-xs break-all">
          {item.targetUrl}
        </td>
        <td className="px-4 py-3 text-xs">
          {item.recordType === "placement" ? (
            <>
              <div>{dateTime(item.lastSuccessfulObservationAt)}</div>
              <div className="mt-1 text-muted-foreground">
                {item.freshness} · Direct Monitor
              </div>
            </>
          ) : (
            <>
              <div>{item.validationStatus}</div>
              <div className="mt-1 text-muted-foreground">
                Direct validation · 不计 KPI
              </div>
            </>
          )}
        </td>
        <td className="px-4 py-3 text-xs">
          {item.opportunityId ? (
            <Link
              className="break-all text-primary hover:underline"
              to={contextPath(projectId, "opportunities", item)}
            >
              {item.opportunityId}
            </Link>
          ) : (
            <span className="text-muted-foreground">未归因</span>
          )}
        </td>
        <td className="px-4 py-3 text-right">{action}</td>
      </tr>
    )
  }
  return (
    <div className="border-b px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Badge variant={stateVariant(item)}>{stateLabel(item)}</Badge>
          <div className="mt-3 text-xs text-muted-foreground">来源页面</div>
          <div className="mt-1 text-sm break-all">
            {item.sourcePageUrl || "服务端未提供"}
          </div>
          <div className="mt-3 text-xs text-muted-foreground">目标 URL</div>
          <div className="mt-1 text-sm break-all">{item.targetUrl}</div>
        </div>
        {action}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {item.recordType === "placement"
            ? `Direct Monitor · ${item.freshness}`
            : "Direct validation · 不计 KPI"}
        </span>
        <span>
          最近证据{" "}
          {item.recordType === "placement"
            ? dateTime(item.lastSuccessfulObservationAt)
            : dateTime(item.createdAt)}
        </span>
      </div>
    </div>
  )
}

function DetailSheet({
  projectId,
  selected,
  onClose,
  onListRefresh,
}: {
  projectId: string
  selected: PerformanceBacklinkPlacement
  onClose: () => void
  onListRefresh: () => void
}) {
  const [detail, setDetail] =
    React.useState<PerformanceBacklinkPlacementDetail | null>(null)
  const [events, setEvents] = React.useState<PerformanceBacklinkEvents | null>(
    null
  )
  const [evidence, setEvidence] =
    React.useState<PerformanceBacklinkEvidence | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [evidenceLoading, setEvidenceLoading] = React.useState(false)
  const [command, setCommand] = React.useState<
    "idle" | "submitting" | "accepted" | "error"
  >("idle")
  const [commandResult, setCommandResult] =
    React.useState<PerformanceBacklinkReverifyResult | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      getPerformanceBacklinkPlacement(
        projectId,
        selected.placementId,
        controller.signal
      ),
      getPerformanceBacklinkEvents(
        projectId,
        selected.placementId,
        controller.signal
      ),
    ])
      .then(([nextDetail, nextEvents]) => {
        if (controller.signal.aborted) return
        setDetail(nextDetail)
        setEvents(nextEvents)
      })
      .catch((nextError) => {
        if (
          nextError instanceof DOMException &&
          nextError.name === "AbortError"
        ) {
          return
        }
        setError(message(nextError, "读取外链证据详情失败"))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [projectId, selected.placementId])

  const latestEvidenceId =
    detail?.latestObservation?.evidence.evidenceId ??
    detail?.lastSuccessfulObservation?.evidence.evidenceId ??
    null

  async function readEvidence() {
    if (!latestEvidenceId) return
    setEvidenceLoading(true)
    setError("")
    try {
      setEvidence(
        await getPerformanceBacklinkEvidence(projectId, latestEvidenceId)
      )
    } catch (nextError) {
      setError(message(nextError, "读取不可变监控证据失败"))
    } finally {
      setEvidenceLoading(false)
    }
  }

  async function requestReverify() {
    if (!detail) return
    setCommand("submitting")
    setCommandResult(null)
    try {
      const result = await reverifyPerformanceBacklink(
        projectId,
        selected.placementId,
        detail.version,
        crypto.randomUUID()
      )
      setCommandResult(result)
      setCommand("accepted")
      onListRefresh()
    } catch {
      setCommand("error")
    }
  }

  const sourcePath = contextPath(projectId, "links", selected)
  const opportunityPath = contextPath(projectId, "opportunities", selected)

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-hidden data-[side=right]:h-dvh data-[side=right]:w-[75dvw] sm:max-w-2xl [&_[data-slot=sheet-close]]:right-5 sm:[&_[data-slot=sheet-close]]:right-4">
        <SheetHeader className="shrink-0 border-b pr-14">
          <div className="flex flex-wrap gap-2">
            <Badge variant={stateVariant(selected)}>
              {stateLabel(selected)}
            </Badge>
            <Badge variant="outline">Direct Monitor</Badge>
            <Badge variant="secondary">
              {selected.lineageStatus === "OUTREACH_DERIVED"
                ? "外联归因"
                : "未归因库存"}
            </Badge>
          </div>
          <SheetTitle className="mt-2 break-all">外链证据与时间线</SheetTitle>
          <SheetDescription>{selected.sourcePageUrl}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-36 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          ) : error && !detail ? (
            <div className="flex min-h-56 flex-col items-center justify-center text-center">
              <SearchX className="size-8 text-muted-foreground" />
              <p className="mt-3 text-sm text-destructive">{error}</p>
            </div>
          ) : detail ? (
            <div className="space-y-6">
              {error ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <section className="grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <div className="text-xs text-muted-foreground">目标 URL</div>
                  <div className="mt-1 break-all">{detail.targetUrl}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Opportunity
                  </div>
                  <div className="mt-1 break-all">
                    {detail.opportunityId || "未绑定"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Reply</div>
                  <div className="mt-1 break-all">
                    {detail.replyId || "未绑定"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Placement</div>
                  <div className="mt-1 break-all">{detail.placementId}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    最后成功证据
                  </div>
                  <div className="mt-1">
                    {dateTime(
                      detail.lastSuccessfulObservation?.observedAt ?? null
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">下次检查</div>
                  <div className="mt-1">{dateTime(detail.nextCheckAt)}</div>
                </div>
              </section>

              {detail.latestObservation?.failure.status === "failed" &&
              detail.lastSuccessfulObservation ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-800">
                  最近一次 Direct Monitor 尝试失败；页面保留并展示上次成功证据。
                </div>
              ) : null}

              <section className="border-t pt-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-medium">不可变监控证据</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Direct Monitor · hash 与契约版本由服务端返回
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!latestEvidenceId || evidenceLoading}
                    onClick={() => void readEvidence()}
                  >
                    {evidenceLoading ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <ShieldCheck />
                    )}
                    读取证据
                  </Button>
                </div>
                {!latestEvidenceId ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    等待首次直接验证，当前尚无 Observation 证据。
                  </p>
                ) : evidence ? (
                  <div className="mt-4 grid gap-3 rounded-md border p-3 text-xs sm:grid-cols-2">
                    <div>
                      <span className="text-muted-foreground">结果：</span>
                      {evidence.result}
                    </div>
                    <div>
                      <span className="text-muted-foreground">采集方式：</span>
                      {evidence.executionMode}
                    </div>
                    <div>
                      <span className="text-muted-foreground">HTTP：</span>
                      {evidence.source.httpStatus ?? "-"}
                    </div>
                    <div>
                      <span className="text-muted-foreground">证据时间：</span>
                      {dateTime(evidence.observedAt)}
                    </div>
                    <div className="break-all sm:col-span-2">
                      <span className="text-muted-foreground">Hash：</span>
                      {evidence.hash}
                    </div>
                    <div className="sm:col-span-2">
                      <span className="text-muted-foreground">
                        链接出现次数：
                      </span>
                      {evidence.link.occurrenceCount ?? "-"}
                    </div>
                  </div>
                ) : null}
              </section>

              <section className="border-t pt-5">
                <h3 className="font-medium">Placement 时间线</h3>
                {events?.items.length ? (
                  <div className="mt-4 space-y-4 border-l pl-4">
                    {events.items.map((event) => (
                      <div className="relative" key={event.eventId}>
                        <span className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-primary" />
                        <div className="text-sm font-medium">
                          {eventLabels[event.eventType]}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {dateTime(event.occurredAt)} · 版本{" "}
                          {event.placementVersion}
                        </div>
                        {event.reason ? (
                          <div className="mt-1 text-xs">{event.reason}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">
                    尚无状态变化事件。
                  </p>
                )}
              </section>

              <section className="border-t pt-5">
                <div className="flex items-center gap-2">
                  <FileClock className="size-4 text-muted-foreground" />
                  <h3 className="font-medium">重新验证</h3>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  命令使用当前 Placement
                  版本与幂等键；服务端决定是否接受及调度。
                </p>
                {command === "accepted" && commandResult ? (
                  <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700">
                    已受理，监控任务状态：{commandResult.monitorRun.status}
                    {commandResult.replayed ? "（幂等重放）" : ""}
                  </div>
                ) : command === "error" ? (
                  <div className="mt-3 text-sm text-destructive">
                    重新验证未被受理；未在前端推断任务状态。
                  </div>
                ) : null}
              </section>
            </div>
          ) : null}
        </div>

        <SheetFooter className="shrink-0 border-t sm:flex-row">
          {selected.opportunityId ? (
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to={opportunityPath} />}
            >
              <Link2 />
              Opportunity
            </Button>
          ) : null}
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link to={sourcePath} />}
          >
            <ExternalLink />
            外链工作区
          </Button>
          <Button
            disabled={!detail || command === "submitting"}
            onClick={() => void requestReverify()}
          >
            {command === "submitting" ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            重新验证
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function ProjectBacklinkMonitoringWorkspace({
  projectId,
}: {
  projectId: string
}) {
  const [view, setView] = React.useState<PerformanceBacklinkView>("placements")
  const [cursors, setCursors] = React.useState<Array<string | null>>([null])
  const [pageIndex, setPageIndex] = React.useState(0)
  const [response, setResponse] =
    React.useState<PerformanceBacklinksResponse | null>(null)
  const [inventoryPage, setInventoryPage] = React.useState(1)
  const [inventoryView, setInventoryView] =
    React.useState<PerformanceBacklinkInventoryView>("all")
  const [inventory, setInventory] =
    React.useState<PerformanceBacklinkInventoryResponse | null>(null)
  const [inventoryLoading, setInventoryLoading] = React.useState(true)
  const [inventoryError, setInventoryError] = React.useState("")
  const [profile, setProfile] =
    React.useState<PerformanceBacklinkProfileResponse | null>(null)
  const [profileLoading, setProfileLoading] = React.useState(true)
  const [profileError, setProfileError] = React.useState("")
  const [profileSyncing, setProfileSyncing] = React.useState(false)
  const [profileSyncMessage, setProfileSyncMessage] = React.useState("")
  const initialProfileSyncStarted = React.useRef(false)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [selected, setSelected] =
    React.useState<PerformanceBacklinkPlacement | null>(null)
  const [revision, setRevision] = React.useState(0)
  const cursor = cursors[pageIndex]

  React.useEffect(() => {
    const controller = new AbortController()
    void getPerformanceBacklinks(projectId, {
      view,
      limit: pageSize,
      cursor,
      signal: controller.signal,
    })
      .then((nextResponse) => {
        if (!controller.signal.aborted) setResponse(nextResponse)
      })
      .catch((nextError) => {
        if (isAbortError(nextError)) return
        setError(message(nextError, "读取外链监控数据失败"))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [cursor, projectId, revision, view])

  React.useEffect(() => {
    const controller = new AbortController()
    void getPerformanceBacklinkInventory(projectId, {
      page: inventoryPage,
      pageSize: inventoryPageSize,
      view: inventoryView,
      sort: "last_seen_desc",
      signal: controller.signal,
    })
      .then((nextInventory) => {
        if (!controller.signal.aborted) setInventory(nextInventory)
      })
      .catch((nextError) => {
        if (isAbortError(nextError)) return
        setInventoryError(message(nextError, "读取项目外链数据失败"))
      })
      .finally(() => {
        if (!controller.signal.aborted) setInventoryLoading(false)
      })
    return () => controller.abort()
  }, [inventoryPage, inventoryView, projectId, revision])

  React.useEffect(() => {
    const controller = new AbortController()

    async function loadProfileAndReconnect() {
      try {
        const nextProfile = await getPerformanceBacklinkProfile(
          projectId,
          controller.signal
        )
        if (controller.signal.aborted) return
        setProfile(nextProfile)
        setProfileError("")

        if (
          nextProfile.snapshot ||
          !nextProfile.sync.providerEnabled ||
          nextProfile.sync.providerInputRequired ||
          initialProfileSyncStarted.current
        ) {
          return
        }

        initialProfileSyncStarted.current = true
        setProfileSyncing(true)
        setProfileSyncMessage("首次外链数据同步已交由后台处理。")
        const started = await requestPerformanceBacklinkProfileSync(
          projectId,
          initialProfileSyncKey(projectId)
        )
        if (controller.signal.aborted) return

        let job: PerformanceBacklinkProfileSyncJob | null = null
        for (let attempt = 0; attempt < profileSyncPollLimit; attempt += 1) {
          job = await getPerformanceBacklinkProfileSyncJob(
            projectId,
            started.jobId,
            controller.signal
          )
          if (profileSyncTerminalStatuses.has(job.status)) break
          await waitForNextProfilePoll(controller.signal)
        }
        if (controller.signal.aborted) return

        if (!job) {
          setProfileSyncMessage("后台同步已受理，稍后返回页面会继续读取状态。")
        } else if (job.status === "completed" || job.status === "partial") {
          setProfileSyncMessage(
            `同步完成，已拉取 ${job.pulledCount} 条项目外链记录。`
          )
        } else if (job.status === "waiting_provider") {
          setProfileSyncMessage(
            "同步正在等待 Provider 或预算恢复，已保留后台任务。"
          )
        } else if (job.status === "failed") {
          setProfileError(
            job.errorCode
              ? `项目外链同步失败（${job.errorCode}）。`
              : "项目外链同步失败，请稍后刷新重试。"
          )
        } else {
          setProfileSyncMessage(
            "后台同步仍在执行，稍后返回页面会继续读取状态。"
          )
        }

        const refreshedProfile = await getPerformanceBacklinkProfile(
          projectId,
          controller.signal
        )
        if (!controller.signal.aborted) {
          setProfile(refreshedProfile)
          setRevision((value) => value + 1)
        }
      } catch (nextError) {
        if (isAbortError(nextError)) return
        setProfileError(message(nextError, "读取项目外链概览失败"))
      } finally {
        if (!controller.signal.aborted) {
          setProfileLoading(false)
          setProfileSyncing(false)
        }
      }
    }

    void loadProfileAndReconnect()
    return () => controller.abort()
  }, [projectId, revision])

  function changeView(nextView: PerformanceBacklinkView) {
    setLoading(true)
    setError("")
    setView(nextView)
    setCursors([null])
    setPageIndex(0)
    setResponse(null)
    setSelected(null)
  }

  function nextPage() {
    if (!response?.nextCursor) return
    setLoading(true)
    setError("")
    setCursors((current) => [
      ...current.slice(0, pageIndex + 1),
      response.nextCursor,
    ])
    setPageIndex((current) => current + 1)
  }

  function previousPage() {
    setLoading(true)
    setError("")
    setPageIndex((value) => Math.max(0, value - 1))
  }

  function changeInventoryView(nextView: PerformanceBacklinkInventoryView) {
    if (nextView === inventoryView) return
    setInventoryLoading(true)
    setInventoryError("")
    setInventory(null)
    setInventoryPage(1)
    setInventoryView(nextView)
  }

  function refreshList() {
    setLoading(true)
    setInventoryLoading(true)
    setProfileLoading(true)
    setError("")
    setInventoryError("")
    setProfileError("")
    setRevision((value) => value + 1)
  }

  if (loading && !response) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    )
  }

  if (error && !response) {
    return (
      <div className="flex min-h-72 flex-col items-center justify-center text-center">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="mt-3 text-sm text-destructive">{error}</p>
        <Button className="mt-4" variant="outline" onClick={refreshList}>
          <RefreshCw />
          重新读取
        </Button>
      </div>
    )
  }

  if (!response) return null

  const { summary } = response
  const hasHistoricalEvidence = summary.evidence.dataCutoff !== null
  return (
    <div className="space-y-4">
      <ProfileSummary
        profile={profile}
        loading={profileLoading}
        error={profileError}
        syncing={profileSyncing}
        syncMessage={profileSyncMessage}
        refreshing={loading || inventoryLoading || profileLoading}
        inventoryView={inventoryView}
        onInventoryViewChange={changeInventoryView}
        onRefresh={refreshList}
      />

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}。已有历史证据仍保留。
        </div>
      ) : null}

      {summary.evidence.latestFailure.status === "failed" &&
      hasHistoricalEvidence ? (
        <div className="flex gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            最近一次 Direct Monitor 尝试失败
            {summary.evidence.latestFailure.code
              ? `（${summary.evidence.latestFailure.code}）`
              : ""}
            ，当前展示截止 {dateTime(summary.evidence.dataCutoff)} 的历史事实。
          </div>
        </div>
      ) : null}

      <InventorySection
        view={inventoryView}
        inventory={inventory}
        loading={inventoryLoading}
        error={inventoryError}
        onPreviousPage={() => {
          setInventoryLoading(true)
          setInventoryPage((value) => Math.max(1, value - 1))
        }}
        onNextPage={() => {
          setInventoryLoading(true)
          setInventoryPage((value) => value + 1)
        }}
      />
      <PlacementSummary response={response} />

      {summary.placements.total > 0 && !hasHistoricalEvidence ? (
        <div className="flex gap-3 rounded-md border px-4 py-3 text-sm">
          <LoaderCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <div className="font-medium">等待首次 Direct Monitor 验证</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Placement 已存在，但尚无成功 Observation；Candidate 不计入 KPI。
            </div>
          </div>
        </div>
      ) : null}

      <section className="overflow-hidden rounded-md border">
        <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-medium">监控明细</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              已确认外链与待确认候选分开计量，共显示 {response.items.length} 条
            </p>
          </div>
          <Select
            value={view}
            onValueChange={(value) =>
              changeView(value as PerformanceBacklinkView)
            }
          >
            <SelectTrigger className="w-full sm:w-48" aria-label="外链状态">
              <SelectValue>
                {viewOptions.find((item) => item.value === view)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {viewOptions.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {response.items.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
            <Link2 className="size-8 text-muted-foreground" />
            <h3 className="mt-3 font-medium">
              {summary.placements.total === 0
                ? "暂无 Placement"
                : "当前筛选没有记录"}
            </h3>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {summary.candidates.total > 0
                ? `当前有 ${summary.candidates.total} 个 Candidate，但它们不会冒充已建立的外链成效。`
                : "Placement 会在外联回复与谈判事实确认后进入此处。"}
            </p>
            <Button
              className="mt-4"
              variant="outline"
              nativeButton={false}
              render={<Link to={`/projects/${projectId}/backlinks/links`} />}
            >
              <ExternalLink />
              打开外链工作区
            </Button>
          </div>
        ) : (
          <>
            <table className="hidden w-full min-w-[900px] text-left text-sm md:table">
              <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">来源页面</th>
                  <th className="px-4 py-3 font-medium">目标 URL</th>
                  <th className="px-4 py-3 font-medium">最近证据</th>
                  <th className="px-4 py-3 font-medium">Opportunity</th>
                  <th aria-label="操作" className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {response.items.map((item) => (
                  <LinkRow
                    item={item}
                    key={
                      item.recordType === "placement"
                        ? item.placementId
                        : item.candidateId
                    }
                    mode="desktop"
                    projectId={projectId}
                    openPlacement={setSelected}
                  />
                ))}
              </tbody>
            </table>
            <div className="md:hidden">
              {response.items.map((item) => (
                <LinkRow
                  item={item}
                  key={
                    item.recordType === "placement"
                      ? item.placementId
                      : item.candidateId
                  }
                  mode="mobile"
                  projectId={projectId}
                  openPlacement={setSelected}
                />
              ))}
            </div>
          </>
        )}
        {(pageIndex > 0 || response.hasMore) && (
          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">第 {pageIndex + 1} 页</span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pageIndex === 0 || loading}
                onClick={previousPage}
              >
                <ArrowLeft />
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!response.hasMore || !response.nextCursor || loading}
                onClick={nextPage}
              >
                下一页
                <ArrowRight />
              </Button>
            </div>
          </div>
        )}
      </section>
      <EvidenceLegend />

      {selected ? (
        <DetailSheet
          key={`${projectId}:${selected.placementId}`}
          projectId={projectId}
          selected={selected}
          onClose={() => setSelected(null)}
          onListRefresh={refreshList}
        />
      ) : null}
    </div>
  )
}

export function BacklinkMonitoringWorkspace({
  projectId,
}: {
  projectId: string
}) {
  if (!projectId) return null
  return (
    <ProjectBacklinkMonitoringWorkspace key={projectId} projectId={projectId} />
  )
}
