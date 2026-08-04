import { useCallback, useEffect, useMemo, useState } from "react"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { reportsClient } from "./api"
import type {
  MetricSummary,
  ReportExport,
  ReportExportFormat,
  ReportingWindow,
  ReportsClient,
  ReportRevision,
} from "./types"

type ViewState =
  | "loading"
  | "ready"
  | "empty"
  | "error"
  | "forbidden"
  | "stale"
type CommandState = "idle" | "submitting" | "error" | "forbidden"

const PDF_EXPORT_DISABLED = true
const exportStates = [
  "queued",
  "running",
  "failed",
  "completed",
  "expired",
] as const

const metricLabels: Record<string, string> = {
  draft_created_count: "Draft 创建量",
  send_accepted_count: "Send 接受量",
  reply_received_count: "Reply 接收量",
  placement_success_rate: "Placement 成功率",
  placement_monitoring_health_rate: "Monitoring 健康率",
}

const exportLabels: Record<ReportExport["status"], string> = {
  queued: "排队中",
  running: "生成中",
  failed: "失败",
  completed: "已完成",
  expired: "已过期",
}

function reportErrorState(error: unknown): "error" | "forbidden" {
  return error instanceof ApiError && error.status === 403
    ? "forbidden"
    : "error"
}

function displayMetric(metric: MetricSummary): string {
  if (metric.value === null) return "暂无值"
  return metric.denominator === null
    ? new Intl.NumberFormat("zh-CN").format(metric.value)
    : new Intl.NumberFormat("zh-CN", {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(metric.value)
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
  const [reports, setReports] = useState<ReportRevision[]>([])
  const [exports, setExports] = useState<ReportExport[]>([])
  const [commandState, setCommandState] = useState<CommandState>("idle")

  const load = useCallback(async () => {
    setViewState("loading")
    try {
      const [dashboardResponse, reportResponse] = await Promise.all([
        client.getMetricDashboard(websiteProjectKey, {
          ...reportingWindow,
          timezone: workspaceTimezone,
        }),
        client.listReports(websiteProjectKey, {
          asOf: reportingWindow.asOf,
        }),
      ])
      setMetrics(dashboardResponse.dashboard.summary)
      setReports(reportResponse.reports)
      if (
        dashboardResponse.dashboard.summary.length === 0 &&
        reportResponse.reports.length === 0
      ) {
        setViewState("empty")
      } else if (reportResponse.reports.some((report) => report.freshness === "stale")) {
        setViewState("stale")
      } else {
        setViewState("ready")
      }
    } catch (error) {
      setViewState(reportErrorState(error))
    }
  }, [
    client,
    reportingWindow.asOf,
    reportingWindow.from,
    reportingWindow.to,
    websiteProjectKey,
    workspaceTimezone,
  ])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load()
    })
    return () => {
      active = false
    }
  }, [load])

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
      setCommandState("idle")
    } catch (error) {
      setCommandState(reportErrorState(error))
    }
  }

  async function refreshExport(item: ReportExport) {
    setCommandState("submitting")
    try {
      const response = await client.getReportExport(
        websiteProjectKey,
        item.id
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
    return (
      <div className="space-y-4" aria-label="报告加载中">
        <Skeleton className="h-20 w-full" />
        <div className="grid gap-3 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    )
  }

  if (viewState === "forbidden" || viewState === "error") {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 border-y bg-muted/20 px-6 text-center">
        <AlertTriangle className="size-6 text-destructive" />
        <h2 className="text-base font-semibold">
          {viewState === "forbidden" ? "无权查看报告" : "报告读取失败"}
        </h2>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCw data-icon="inline-start" />
          重试
        </Button>
      </div>
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
            {formatDate(reportingWindow.from, workspaceTimezone)} 至{" "}
            {formatDate(reportingWindow.to, workspaceTimezone)} ·{" "}
            {workspaceTimezone}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void load()}
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

      {viewState === "empty" ? (
        <div className="flex min-h-64 flex-col items-center justify-center border-y text-center">
          <BarChart3 className="mb-3 size-7 text-muted-foreground" />
          <h3 className="font-medium">当前时间窗无已发布快照</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            指标与报告将在服务端发布不可变快照后显示。
          </p>
        </div>
      ) : (
        <Tabs defaultValue="summary">
          <TabsList variant="line" className="max-w-full overflow-x-auto">
            <TabsTrigger value="summary">指标摘要</TabsTrigger>
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
                        {displayMetric(metric)}
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
                  <p className="mt-3 truncate font-mono text-[11px] text-muted-foreground">
                    snapshot {metric.snapshotId}
                  </p>
                </article>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
              {definitionVersions.map((version) => (
                <span key={version}>口径版本 {version}</span>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="revisions" className="pt-3">
            <div className="divide-y border-y">
              {reports.map((report) => (
                <article
                  key={report.id}
                  className="grid gap-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">{report.reportKey}</h3>
                      <Badge variant="outline">revision {report.revision}</Badge>
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
                      {formatDate(report.generatedAt, workspaceTimezone)} ·{" "}
                      {report.inputSnapshotIds.length} 个输入快照
                    </p>
                    <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">
                      checksum {report.resultChecksum}
                    </p>
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
                    item.status !== "expired" && item.object !== null
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
                          {formatDate(item.createdAt, workspaceTimezone)}
                          {item.failureCode ? ` · ${item.failureCode}` : ""}
                        </p>
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
                          disabled={!downloadable || commandState === "submitting"}
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

      {commandState === "forbidden" && (
        <p className="text-sm text-destructive">当前账号无权执行该操作。</p>
      )}
      {commandState === "error" && (
        <p className="text-sm text-destructive">操作失败，请刷新后重试。</p>
      )}
    </div>
  )
}
