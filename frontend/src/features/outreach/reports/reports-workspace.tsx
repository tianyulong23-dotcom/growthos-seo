import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  BarChart3,
  Clock3,
  Download,
  FileDown,
  RefreshCw,
} from "lucide-react"

import { ApiError } from "@/api/client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import { isOutreachOffline } from "@/features/outreach/shared/outreach-network-state"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"

import { reportsClient } from "./api"
import type {
  MetricSummary,
  MetricTrend,
  ReportExport,
  ReportExportFormat,
  ReportingWindow,
  ReportsClient,
  ReportRevision,
} from "./types"

type ViewState =
  "loading" | "ready" | "empty" | "error" | "forbidden" | "stale" | "offline"
type CommandState = "idle" | "submitting" | "error" | "forbidden" | "conflict"

const PDF_EXPORT_DISABLED = true
const exportStates = [
  "queued",
  "running",
  "failed",
  "completed",
  "expired",
] as const

const metricLabels: Record<string, string> = {
  draft_approval_count: "Draft 审批量",
  send_count: "Provider 接受发送量",
  reply_rate: "有效人工回复率",
  negotiation_conversion_rate: "协商转化率",
  link_acquisition_rate: "外链获取率",
  gained_placement_count: "新增 Confirmed Placement",
  active_placement_count: "Active Placement",
  suspected_lost_placement_count: "Suspected Lost Placement",
  lost_placement_count: "Lost Placement",
  recovered_placement_count: "Recovered Placement",
}

const exportLabels: Record<ReportExport["status"], string> = {
  queued: "排队中",
  running: "生成中",
  failed: "失败",
  completed: "已完成",
  expired: "已过期",
}

function reportErrorState(error: unknown): "error" | "forbidden" | "conflict" {
  if (!(error instanceof ApiError)) return "error"
  if (error.status === 403) return "forbidden"
  if (error.status === 409) return "conflict"
  return "error"
}

function displayMetricValue(
  value: number | null,
  denominator: number | null
): string {
  if (value === null) return "暂无值"
  return denominator === null
    ? new Intl.NumberFormat("zh-CN").format(value)
    : new Intl.NumberFormat("zh-CN", {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(value)
}

function formatDate(value: string, workspaceTimezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: workspaceTimezone,
  }).format(new Date(value))
}

function ExportStatusBadge({ status }: { status: ReportExport["status"] }) {
  const variant =
    status === "failed" || status === "expired"
      ? "destructive"
      : status === "completed"
        ? "default"
        : "secondary"
  return <Badge variant={variant}>{exportLabels[status]}</Badge>
}

export function ReportsWorkspace({
  websiteProjectKey,
  workspaceTimezone,
  reportingWindow,
  client = reportsClient,
}: {
  websiteProjectKey: string
  workspaceTimezone: string
  reportingWindow: ReportingWindow
  client?: ReportsClient
}) {
  const [viewState, setViewState] = useState<ViewState>("loading")
  const [metrics, setMetrics] = useState<MetricSummary[]>([])
  const [trends, setTrends] = useState<MetricTrend[]>([])
  const [reports, setReports] = useState<ReportRevision[]>([])
  const [exports, setExports] = useState<ReportExport[]>([])
  const [commandState, setCommandState] = useState<CommandState>("idle")
  const [displayWindow, setDisplayWindow] = useState(reportingWindow)
  const [displayTimezone, setDisplayTimezone] = useState(workspaceTimezone)
  const loadRequest = useRef(0)
  const dashboardKey = useMemo(
    () =>
      createProjectQueryKey(
        websiteProjectKey,
        "metric-dashboard",
        reportingWindow.from,
        reportingWindow.to,
        reportingWindow.asOf,
        workspaceTimezone
      ),
    [
      reportingWindow.asOf,
      reportingWindow.from,
      reportingWindow.to,
      websiteProjectKey,
      workspaceTimezone,
    ]
  )
  const reportsKey = useMemo(
    () =>
      createProjectQueryKey(
        websiteProjectKey,
        "published-reports",
        reportingWindow.asOf
      ),
    [reportingWindow.asOf, websiteProjectKey]
  )

  const load = useCallback(
    async (force = false) => {
      const request = ++loadRequest.current
      if (force) {
        backlinksProjectQueries.invalidate(dashboardKey)
        backlinksProjectQueries.invalidate(reportsKey)
      }
      setViewState("loading")
      try {
        const [dashboardResponse, reportResponse] = await Promise.all([
          backlinksProjectQueries.fetch(dashboardKey, (signal) =>
            client.getMetricDashboard(
              websiteProjectKey,
              {
                from: reportingWindow.from,
                to: reportingWindow.to,
                asOf: reportingWindow.asOf,
                timezone: workspaceTimezone,
              },
              signal
            )
          ),
          backlinksProjectQueries.fetch(reportsKey, (signal) =>
            client.listReports(
              websiteProjectKey,
              {
                asOf: reportingWindow.asOf,
              },
              signal
            )
          ),
        ])
        if (request !== loadRequest.current) return
        setMetrics(dashboardResponse.dashboard.summary)
        setTrends(dashboardResponse.dashboard.trends)
        setReports(reportResponse.reports)
        setDisplayWindow({
          from: dashboardResponse.dashboard.from,
          to: dashboardResponse.dashboard.to,
          asOf: dashboardResponse.dashboard.asOf,
        })
        setDisplayTimezone(dashboardResponse.dashboard.timezone)
        if (
          dashboardResponse.dashboard.summary.length === 0 &&
          reportResponse.reports.length === 0
        ) {
          setViewState("empty")
        } else if (
          reportResponse.reports.some((report) => report.freshness === "stale")
        ) {
          setViewState("stale")
        } else {
          setViewState("ready")
        }
      } catch (error) {
        if (request !== loadRequest.current) return
        if (error instanceof DOMException && error.name === "AbortError") return
        setViewState(
          isOutreachOffline()
            ? "offline"
            : reportErrorState(error) === "forbidden"
              ? "forbidden"
              : "error"
        )
      }
    },
    [
      client,
      dashboardKey,
      reportingWindow.asOf,
      reportingWindow.from,
      reportingWindow.to,
      reportsKey,
      websiteProjectKey,
      workspaceTimezone,
    ]
  )

  useEffect(() => {
    queueMicrotask(() => void load())
    return () => {
      loadRequest.current += 1
      backlinksProjectQueries.invalidate(dashboardKey)
      backlinksProjectQueries.invalidate(reportsKey)
    }
  }, [dashboardKey, load, reportsKey])

  const definitionVersions = useMemo(
    () =>
      Array.from(
        new Set(metrics.map((metric) => metric.metricDefinitionVersion))
      ),
    [metrics]
  )

  async function requestExport(
    report: ReportRevision,
    format: ReportExportFormat
  ) {
    setCommandState("submitting")
    try {
      const response = await client.requestReportExport(
        websiteProjectKey,
        report.reportKey,
        report.id,
        format
      )
      setExports((current) => [
        response.export,
        ...current.filter((item) => item.id !== response.export.id),
      ])
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "report-export",
        response.export.id,
      ])
      setCommandState("idle")
    } catch (error) {
      setCommandState(reportErrorState(error))
    }
  }

  async function refreshExport(item: ReportExport) {
    setCommandState("submitting")
    try {
      const exportKey = createProjectQueryKey(
        websiteProjectKey,
        "report-export",
        item.id
      )
      backlinksProjectQueries.invalidate(exportKey)
      const response = await backlinksProjectQueries.fetch(
        exportKey,
        (signal) => client.getReportExport(websiteProjectKey, item.id, signal)
      )
      setExports((current) =>
        current.map((existing) =>
          existing.id === response.export.id ? response.export : existing
        )
      )
      setCommandState("idle")
    } catch (error) {
      setCommandState(reportErrorState(error))
    }
  }

  async function downloadExport(item: ReportExport) {
    const nonExpired = item.status !== "expired"
    if (!nonExpired || item.status !== "completed") return
    setCommandState("submitting")
    try {
      const response = await client.authorizeExportDownload(
        websiteProjectKey,
        item.id
      )
      window.location.assign(response.download.url)
      setCommandState("idle")
    } catch (error) {
      setCommandState(reportErrorState(error))
    }
  }

  if (viewState === "loading") {
    return <OutreachStandardStateView state="loading" title="报告加载中" />
  }

  if (
    viewState === "forbidden" ||
    viewState === "error" ||
    viewState === "offline"
  ) {
    return (
      <OutreachStandardStateView
        state={viewState}
        title={
          viewState === "forbidden"
            ? "无权查看报告"
            : viewState === "offline"
              ? "报告中心当前离线"
              : "报告读取失败"
        }
        description="不会回退到本地指标、报告或导出状态。"
        onRetry={() => void load(true)}
      />
    )
  }

  return (
    <div className="min-w-0 space-y-5">
      <section className="flex flex-col gap-3 border-y bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">外链事实指标</h2>
            {viewState === "stale" && (
              <Badge variant="destructive">stale</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatDate(displayWindow.from, displayTimezone)} 至{" "}
            {formatDate(displayWindow.to, displayTimezone)} · {displayTimezone}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            快照截至 {formatDate(displayWindow.asOf, displayTimezone)}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void load(true)}
          disabled={commandState === "submitting"}
        >
          <RefreshCw data-icon="inline-start" />
          刷新
        </Button>
      </section>

      <div className="flex items-start gap-2 border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>Candidate 不计入成功 Placement KPI。</span>
      </div>

      {viewState === "stale" && (
        <OutreachStandardStateView
          state="stale"
          title="报告 Revision 需要刷新"
          description="服务端标记当前已发布报告为 stale，请刷新或等待新 Revision。"
          compact
        />
      )}

      {viewState === "empty" ? (
        <OutreachStandardStateView
          state="empty"
          title="当前时间窗无已发布快照"
          description="指标与报告将在服务端发布不可变快照后显示。"
          onRetry={() => void load(true)}
        />
      ) : (
        <Tabs defaultValue="summary">
          <TabsList variant="line" className="max-w-full overflow-x-auto">
            <TabsTrigger value="summary">指标摘要</TabsTrigger>
            <TabsTrigger value="trends">指标趋势</TabsTrigger>
            <TabsTrigger value="revisions">报告修订</TabsTrigger>
            <TabsTrigger value="exports">导出任务</TabsTrigger>
          </TabsList>

          <TabsContent value="summary" className="pt-3">
            <div className="grid gap-px overflow-hidden border bg-border md:grid-cols-2 xl:grid-cols-3">
              {metrics.map((metric) => (
                <article
                  key={`${metric.metricKey}:${metric.snapshotId}`}
                  className="min-w-0 bg-background p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {metricLabels[metric.metricKey] ?? metric.metricKey}
                      </p>
                      <p className="mt-2 text-2xl font-semibold tabular-nums">
                        {displayMetricValue(metric.value, metric.denominator)}
                      </p>
                    </div>
                    <Badge variant="outline">
                      v{metric.metricDefinitionVersion}
                    </Badge>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <dt className="text-muted-foreground">分子</dt>
                      <dd className="mt-1 font-medium tabular-nums">
                        {metric.numerator}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">分母</dt>
                      <dd className="mt-1 font-medium tabular-nums">
                        {metric.denominator ?? "不适用"}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-3 space-y-1 font-mono text-[11px] text-muted-foreground">
                    <p className="truncate">snapshot {metric.snapshotId}</p>
                    <p>
                      snapshot v{metric.snapshotVersion} ·{" "}
                      {formatDate(metric.asOf, displayTimezone)}
                    </p>
                  </div>
                </article>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
              {definitionVersions.map((version) => (
                <span key={version}>口径版本 {version}</span>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="trends" className="pt-3">
            {trends.length === 0 ? (
              <div className="flex min-h-48 flex-col items-center justify-center border-y text-center">
                <BarChart3 className="mb-3 size-6 text-muted-foreground" />
                <p className="font-medium">当前时间窗无趋势快照</p>
              </div>
            ) : (
              <div className="divide-y border-y">
                {trends.map((trend) => (
                  <article
                    key={`${trend.metricKey}:${trend.metricDefinitionVersion}`}
                    className="py-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">
                        {metricLabels[trend.metricKey] ?? trend.metricKey}
                      </h3>
                      <Badge variant="outline">
                        {trend.metricDefinitionVersion}
                      </Badge>
                    </div>
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full min-w-[36rem] text-left text-sm">
                        <thead className="text-xs text-muted-foreground">
                          <tr className="border-b">
                            <th className="py-2 pr-4 font-medium">
                              时间窗结束
                            </th>
                            <th className="py-2 pr-4 font-medium">值</th>
                            <th className="py-2 pr-4 font-medium">
                              分子 / 分母
                            </th>
                            <th className="py-2 font-medium">Snapshot</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trend.points.map((point) => (
                            <tr
                              key={`${point.snapshotId}:${point.snapshotVersion}`}
                              className="border-b last:border-0"
                            >
                              <td className="py-2 pr-4">
                                {formatDate(point.windowEnd, displayTimezone)}
                              </td>
                              <td className="py-2 pr-4 font-medium tabular-nums">
                                {displayMetricValue(
                                  point.value,
                                  point.denominator
                                )}
                              </td>
                              <td className="py-2 pr-4 text-muted-foreground tabular-nums">
                                {point.numerator} /{" "}
                                {point.denominator ?? "不适用"}
                              </td>
                              <td className="max-w-56 truncate py-2 font-mono text-xs text-muted-foreground">
                                {point.snapshotId} · v{point.snapshotVersion}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="revisions" className="pt-3">
            {reports.length === 0 ? (
              <div className="flex min-h-48 flex-col items-center justify-center border-y text-center">
                <Clock3 className="mb-3 size-6 text-muted-foreground" />
                <p className="font-medium">暂无已发布 Report Revision</p>
              </div>
            ) : (
              <div className="divide-y border-y">
                {reports.map((report) => (
                  <article
                    key={report.id}
                    className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium">{report.reportKey}</h3>
                        <Badge variant="outline">
                          revision {report.revision}
                        </Badge>
                        <Badge
                          variant={
                            report.freshness === "stale"
                              ? "destructive"
                              : "secondary"
                          }
                        >
                          {report.freshness}
                        </Badge>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {formatDate(report.generatedAt, displayTimezone)} ·{" "}
                        {report.inputSnapshotIds.length} 个输入快照
                      </p>
                      <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
                        checksum {report.resultChecksum}
                      </p>
                      <details className="mt-3 text-xs">
                        <summary className="cursor-pointer font-medium">
                          Revision 来源
                        </summary>
                        <div className="mt-2 space-y-2 text-muted-foreground">
                          <p>
                            watermark{" "}
                            {formatDate(
                              report.sourceWatermarkAt,
                              displayTimezone
                            )}{" "}
                            · {report.sourceWatermarkId}
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {report.inputSnapshotIds.map((snapshotId) => (
                              <code
                                key={snapshotId}
                                className="max-w-full truncate border px-1.5 py-0.5"
                              >
                                {snapshotId}
                              </code>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {Object.entries(
                              report.metricDefinitionVersions
                            ).map(([metricKey, version]) => (
                              <span key={metricKey}>
                                {metricKey}: {version}
                              </span>
                            ))}
                          </div>
                        </div>
                      </details>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void requestExport(report, "csv")}
                        disabled={commandState === "submitting"}
                      >
                        <FileDown data-icon="inline-start" />
                        CSV
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void requestExport(report, "xlsx")}
                        disabled={commandState === "submitting"}
                      >
                        <FileDown data-icon="inline-start" />
                        XLSX
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={PDF_EXPORT_DISABLED}
                        title="PDF_EXPORT_DISABLED"
                      >
                        <FileDown data-icon="inline-start" />
                        PDF
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="exports" className="pt-3">
            {exports.length === 0 ? (
              <div className="flex min-h-48 flex-col items-center justify-center border-y text-center">
                <Clock3 className="mb-3 size-6 text-muted-foreground" />
                <p className="font-medium">暂无导出任务</p>
              </div>
            ) : (
              <div className="divide-y border-y">
                {exports.map((item) => {
                  const downloadable =
                    item.status === "completed" && item.object !== null
                  return (
                    <div
                      key={item.id}
                      className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{item.reportKey}</span>
                          <Badge variant="outline">
                            {item.format.toUpperCase()}
                          </Badge>
                          <ExportStatusBadge status={item.status} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatDate(item.createdAt, displayTimezone)}
                          {item.failureCode ? ` · ${item.failureCode}` : ""}
                        </p>
                        {item.expiresAt && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            到期 {formatDate(item.expiresAt, displayTimezone)}
                          </p>
                        )}
                        {item.object && (
                          <p className="mt-1 max-w-full truncate font-mono text-[11px] text-muted-foreground">
                            sha256 {item.object.sha256}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="刷新导出状态"
                          title="刷新导出状态"
                          onClick={() => void refreshExport(item)}
                          disabled={commandState === "submitting"}
                        >
                          <RefreshCw />
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => void downloadExport(item)}
                          disabled={
                            !downloadable || commandState === "submitting"
                          }
                        >
                          <Download data-icon="inline-start" />
                          下载
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <span className="sr-only">{exportStates.join(",")}</span>
          </TabsContent>
        </Tabs>
      )}

      {exports.some(
        (item) => item.status === "queued" || item.status === "running"
      ) && (
        <OutreachStandardStateView
          state="job-running"
          title="报告导出任务运行中"
          description="导出状态由服务端维护；刷新后读取最新任务事实。"
          compact
        />
      )}

      {commandState === "forbidden" && (
        <p className="text-sm text-destructive">当前账号无权执行该操作。</p>
      )}
      {commandState === "error" && (
        <p className="text-sm text-destructive">操作失败，请刷新后重试。</p>
      )}
      {commandState === "conflict" && (
        <p className="text-sm text-destructive">
          导出状态已变化，请刷新任务状态后重试。
        </p>
      )}
    </div>
  )
}
