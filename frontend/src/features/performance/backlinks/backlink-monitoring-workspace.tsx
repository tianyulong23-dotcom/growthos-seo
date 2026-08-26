import * as React from "react"
import { Link } from "react-router"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Eye,
  FileClock,
  Link2,
  LoaderCircle,
  RefreshCw,
  SearchX,
  ShieldCheck,
} from "lucide-react"

import {
  getPerformanceBacklinkEvents,
  getPerformanceBacklinkEvidence,
  getPerformanceBacklinkPlacement,
  getPerformanceBacklinks,
  reverifyPerformanceBacklink,
  type PerformanceBacklinkEvidence,
  type PerformanceBacklinkEvents,
  type PerformanceBacklinkItem,
  type PerformanceBacklinkPlacement,
  type PerformanceBacklinkPlacementDetail,
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

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
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

function Summary({ response }: { response: PerformanceBacklinksResponse }) {
  const { placements, candidates } = response.summary
  const risk =
    placements.suspectedChanged + placements.changed + placements.suspectedLost
  const metrics = [
    ["Placement", placements.total, "计入外链成效 KPI"],
    ["正常", placements.active, "Direct Monitor 当前正常"],
    ["待处理", risk, "疑似变化、变化或疑似丢失"],
    ["已丢失", placements.lost, "连续证据确认丢失"],
    ["已恢复", placements.recovered, "存在不可变恢复事件"],
    ["Candidate", candidates.total, "不计入成效 KPI"],
  ] as const
  return (
    <div className="grid overflow-hidden rounded-md border sm:grid-cols-3 xl:grid-cols-6">
      {metrics.map(([label, value, detail], index) => (
        <div
          className={`min-w-0 px-4 py-3 ${
            index > 0 ? "border-t sm:border-t-0 sm:border-l" : ""
          } ${index === 3 ? "sm:border-l-0 xl:border-l" : ""}`}
          key={label}
        >
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {value}
          </div>
          <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {detail}
          </div>
        </div>
      ))}
    </div>
  )
}

function EvidenceLegend() {
  return (
    <div className="grid gap-3 border-y py-3 text-xs text-muted-foreground md:grid-cols-4">
      <div>
        <span className="font-medium text-foreground">DataForSEO</span>
        <div>发现与库存证据，不等同于直接存活验证。</div>
      </div>
      <div>
        <span className="font-medium text-foreground">Direct validation</span>
        <div>Placement 建立前的直接页面验证。</div>
      </div>
      <div>
        <span className="font-medium text-foreground">Direct Monitor</span>
        <div>Placement 建立后的持续状态与证据时间线。</div>
      </div>
      <div>
        <span className="font-medium text-foreground">
          Indexification / 索引
        </span>
        <div>加速受理与搜索索引证据分别记录，不与外链存活混称。</div>
      </div>
    </div>
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
        if (
          nextError instanceof DOMException &&
          nextError.name === "AbortError"
        ) {
          return
        }
        setError(message(nextError, "读取外链监控数据失败"))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [cursor, projectId, revision, view])

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

  function refreshList() {
    setLoading(true)
    setError("")
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
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">项目级 Placement 成效</span>
            <Badge variant="outline">
              {summary.evidence.freshness === "fresh"
                ? "数据新鲜"
                : summary.evidence.freshness === "stale"
                  ? "数据已过期"
                  : "尚无数据"}
            </Badge>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            数据截止 {dateTime(summary.evidence.dataCutoff)} · 最近尝试{" "}
            {dateTime(summary.evidence.latestAttemptAt)} ·{" "}
            {summary.evidence.source}
          </div>
        </div>
        <div className="flex gap-2">
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
          <Button
            aria-label="刷新外链监控"
            size="icon"
            title="刷新"
            variant="outline"
            disabled={loading}
            onClick={refreshList}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

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

      <Summary response={response} />
      <EvidenceLegend />

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
        <div className="border-b px-4 py-3">
          <h2 className="font-medium">外链记录</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            共显示 {response.items.length} 条，Candidate 与 Placement 分开计量
          </p>
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
