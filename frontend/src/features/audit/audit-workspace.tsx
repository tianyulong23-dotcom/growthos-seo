import * as React from "react"
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  Eye,
  FileJson,
  FileSpreadsheet,
  FileType2,
  Link2,
  LoaderCircle,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Search,
  Settings2,
  Smartphone,
  Square,
  Trash2,
} from "lucide-react"
import { useNavigate } from "react-router"

import {
  archiveAuditRun,
  deleteAuditRun,
  downloadAuditExport,
  getAuditActivity,
  getAuditExternalResources,
  getAuditIssues,
  getAuditLinks,
  getAuditPages,
  getAuditPageSpeed,
  getAuditStatusCodes,
  getAuditVisualization,
  listAuditRuns,
  pauseAuditRun,
  recalculateAuditIssues,
  resumeAuditRun,
  stopAuditRun,
  type AuditActivity,
  type AuditExternalResource,
  type AuditExportDataset,
  type AuditExportFormat,
  type AuditIssue,
  type AuditLink,
  type AuditPage,
  type AuditPageSpeedResult,
  type AuditRun,
  type AuditSeverity,
  type AuditStatusCode,
  type AuditStatusFamily,
  type AuditVisualization,
} from "@/api/audits"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { AuditSetup } from "@/features/audit/audit-setup"
import type { AuditSettings } from "@/features/audit/audit-settings"
import type { Project } from "@/features/projects/types"

type AuditWorkspaceProps = {
  project: Project
  view: string
  run: AuditRun | null
  error: string
  onStart: (settings: AuditSettings) => Promise<void>
  onRunChange: (run: AuditRun | null) => void
  onProjectRefresh: () => Promise<unknown>
}

const SiteStructureVisualization = React.lazy(() =>
  import("@/features/audit/site-structure-visualization").then((module) => ({
    default: module.SiteStructureVisualization,
  }))
)

const statusLabels: Record<AuditRun["status"], string> = {
  queued: "排队中",
  running: "运行中",
  paused: "已暂停",
  stopping: "停止中",
  stopped: "已停止",
  recalculating: "重算问题中",
  completed: "已完成",
  failed: "失败",
}

const severityLabels: Record<AuditSeverity, string> = {
  error: "错误",
  warning: "警告",
  notice: "提示",
}

function formatDate(value?: string) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function statusVariant(status: AuditRun["status"]) {
  if (status === "failed") return "destructive" as const
  if (status === "completed") return "default" as const
  if (
    status === "running" ||
    status === "queued" ||
    status === "stopping" ||
    status === "recalculating"
  ) {
    return "secondary" as const
  }
  return "outline" as const
}

function severityVariant(severity: AuditSeverity) {
  if (severity === "error") return "destructive" as const
  if (severity === "warning") return "secondary" as const
  return "outline" as const
}

function EmptyState({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="border-y py-14 text-center">
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{description}</div>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle className="size-4 animate-spin" />
      正在读取审计数据
    </div>
  )
}

function CrawlPendingState({ finalizing }: { finalizing: boolean }) {
  return (
    <section className="flex min-h-64 flex-col items-center justify-center border-y px-4 text-center">
      <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      <h2 className="mt-3 text-sm font-semibold">
        {finalizing ? "正在整理审计结果" : "网站仍在抓取中"}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        审计完成后将自动显示当前页面的结果。
      </p>
    </section>
  )
}

function FinalResultsState({
  error,
  onRetry,
}: {
  error: string
  onRetry: () => void
}) {
  return (
    <section className="flex min-h-64 flex-col items-center justify-center border-y px-4 text-center">
      {error ? (
        <>
          <CircleAlert className="size-5 text-destructive" />
          <h2 className="mt-3 text-sm font-semibold">审计结果加载失败</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">{error}</p>
          <Button
            className="mt-4"
            variant="outline"
            size="sm"
            onClick={onRetry}
          >
            <RotateCcw />
            重新加载
          </Button>
        </>
      ) : (
        <>
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          <h2 className="mt-3 text-sm font-semibold">正在加载审计结果</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            数据读取完成后将自动显示本页。
          </p>
        </>
      )}
    </section>
  )
}

function TableToolbar({
  search,
  onSearch,
  children,
}: {
  search: string
  onSearch: (value: string) => void
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
      <div className="relative min-w-0 flex-1">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="搜索当前列表..."
          className="w-full pl-9 sm:max-w-md"
        />
      </div>
      {children}
    </div>
  )
}

function TablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)

  return (
    <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="text-muted-foreground">
        {start}-{end} / 共 {total} 项
      </div>
      <div className="flex items-center justify-between gap-3 sm:justify-end">
        <Select
          value={String(pageSize)}
          onValueChange={(value) => {
            if (value) onPageSizeChange(Number(value))
          }}
        >
          <SelectTrigger className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="25">25 / 页</SelectItem>
            <SelectItem value="50">50 / 页</SelectItem>
            <SelectItem value="100">100 / 页</SelectItem>
          </SelectContent>
        </Select>
        <span className="min-w-20 text-center tabular-nums">
          {page} / {totalPages}
        </span>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            title="上一页"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            title="下一页"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  )
}

function AuditStatusPanel({
  run,
  resultsReady,
  resultsError,
  actionBusy,
  onPause,
  onResume,
  onStop,
  onArchive,
  onDelete,
  onRecalculate,
  onNew,
  onExport,
}: {
  run: AuditRun
  resultsReady: boolean
  resultsError: string
  actionBusy: boolean
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onArchive: () => void
  onDelete: () => void
  onRecalculate: () => void
  onNew: () => void
  onExport: (dataset: AuditExportDataset, format: AuditExportFormat) => void
}) {
  const finalizing = run.status === "running" && run.stage === "completed"
  const loadingResults = run.status === "completed" && !resultsReady
  const active = ["queued", "running"].includes(run.status) && !finalizing
  const locked =
    active || finalizing || loadingResults || run.status === "recalculating"
  const stoppable = active || run.status === "paused"
  const archivable = ["paused", "stopped", "completed", "failed"].includes(
    run.status
  )
  const displayLabel = loadingResults
    ? resultsError
      ? "结果加载失败"
      : "加载结果中"
    : finalizing
      ? "整理结果中"
      : statusLabels[run.status]
  const displayMessage = loadingResults
    ? resultsError
      ? "审计已结束，但结果读取失败"
      : "审计已结束，正在读取最终结果"
    : finalizing
      ? "页面抓取已结束，正在整理最终结果"
      : run.message
  const controlsDisabled = actionBusy || loadingResults || finalizing

  return (
    <section className="mb-6 border-y bg-muted/20">
      <div className="flex flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                resultsError && loadingResults
                  ? "destructive"
                  : loadingResults || finalizing
                    ? "secondary"
                    : statusVariant(run.status)
              }
            >
              {displayLabel}
            </Badge>
            {run.archived_at && <Badge variant="outline">已归档</Badge>}
            <span className="text-sm font-medium">{displayMessage}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span>
              阶段：
              {loadingResults
                ? "读取结果"
                : finalizing
                  ? "整理结果"
                  : run.stage || "-"}
            </span>
            <span>发现：{run.discovered}</span>
            <span>已处理：{run.processed}</span>
            <span>已选择：{run.selected}</span>
            <span>创建：{formatDate(run.created_at)}</span>
          </div>
          <Progress
            value={loadingResults || finalizing ? 99 : run.progress}
            className="mt-3 h-1.5"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {active && (
            <Button
              variant="outline"
              size="sm"
              onClick={onPause}
              disabled={controlsDisabled}
            >
              <Pause />
              暂停
            </Button>
          )}
          {run.can_resume &&
            ["paused", "stopped", "failed"].includes(run.status) && (
              <Button
                variant="outline"
                size="sm"
                onClick={onResume}
                disabled={controlsDisabled}
              >
                <RotateCcw />
                恢复
              </Button>
            )}
          {stoppable && (
            <Button
              variant="outline"
              size="sm"
              onClick={onStop}
              disabled={controlsDisabled}
            >
              <Square />
              停止
            </Button>
          )}
          {run.status === "completed" && resultsReady && !run.archived_at && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRecalculate}
              disabled={controlsDisabled}
            >
              <Settings2 />
              调整排除规则
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="sm" />}
              disabled={controlsDisabled}
            >
              <Download />
              导出
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rounded-md">
              <DropdownMenuGroup>
                <DropdownMenuLabel>选择导出内容</DropdownMenuLabel>
                {(
                  [
                    ["issues", "问题清单"],
                    ["pages", "页面资源"],
                    ["links", "链接"],
                  ] as const
                ).map(([dataset, label]) => (
                  <DropdownMenuSub key={dataset}>
                    <DropdownMenuSubTrigger className="rounded-sm">
                      {dataset === "issues" ? (
                        <CircleAlert />
                      ) : dataset === "pages" ? (
                        <FileType2 />
                      ) : (
                        <Link2 />
                      )}
                      {label}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="rounded-md">
                      <DropdownMenuItem
                        className="rounded-sm"
                        onClick={() => onExport(dataset, "csv")}
                      >
                        <FileSpreadsheet />
                        CSV
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="rounded-sm"
                        onClick={() => onExport(dataset, "xlsx")}
                      >
                        <FileSpreadsheet />
                        XLSX
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="rounded-sm"
                        onClick={() => onExport(dataset, "json")}
                      >
                        <FileJson />
                        JSON
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="rounded-sm"
                        onClick={() => onExport(dataset, "xml")}
                      >
                        <FileType2 />
                        XML
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {archivable && !run.archived_at && (
                <DropdownMenuItem className="rounded-sm" onClick={onArchive}>
                  <Archive />
                  归档本次审计
                </DropdownMenuItem>
              )}
              {archivable && (
                <DropdownMenuItem
                  variant="destructive"
                  className="rounded-sm"
                  onClick={onDelete}
                >
                  <Trash2 />
                  删除本次审计
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" onClick={onNew} disabled={actionBusy || locked}>
            <Play />
            新建审计
          </Button>
        </div>
      </div>
    </section>
  )
}

function formatActivityTime(value?: string) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date)
}

function CrawlActivityPanel({
  items,
  loading,
  error,
}: {
  items: AuditActivity[]
  loading: boolean
  error: string
}) {
  return (
    <section className="mb-6 border-y">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">实时抓取</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">最近处理的页面</p>
        </div>
        {loading && (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        )}
      </div>
      {error ? (
        <div className="flex items-start gap-2 px-4 py-3 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          正在等待第一个页面
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">时间</TableHead>
                <TableHead className="w-20">状态</TableHead>
                <TableHead>页面</TableHead>
                <TableHead className="w-24 text-right">耗时</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={`${item.sequence}-${item.url}`}>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatActivityTime(item.fetched_at)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={item.status_code} />
                  </TableCell>
                  <TableCell className="max-w-0">
                    <div
                      className="truncate text-sm font-medium"
                      title={item.url}
                    >
                      {item.title || item.final_url || item.url}
                    </div>
                    <div
                      className={
                        item.error
                          ? "truncate text-xs text-destructive"
                          : "truncate text-xs text-muted-foreground"
                      }
                      title={item.error || item.final_url || item.url}
                    >
                      {item.error || item.final_url || item.url}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                    {item.response_time_ms === null
                      ? "-"
                      : `${item.response_time_ms} ms`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function resourceDomain(value: string) {
  try {
    return new URL(value).hostname || "-"
  } catch {
    return "-"
  }
}

function StatusBadge({ status }: { status: number | null }) {
  const label = status === null || status === 0 ? "无响应" : String(status)
  const variant =
    status !== null && status >= 400
      ? "destructive"
      : status !== null && status >= 300
        ? "secondary"
        : "outline"
  return <Badge variant={variant}>{label}</Badge>
}

function analyticsSummary(analytics: Record<string, unknown>) {
  const names = Object.entries(analytics)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key.replaceAll("_", " "))
  return names.length > 0 ? names.join(", ") : "-"
}

function DetailGrid({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0 border-t pt-2">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-sm break-words">{value || "-"}</div>
        </div>
      ))}
    </div>
  )
}

function PageDetailDialog({
  page,
  onClose,
}: {
  page: AuditPage | null
  onClose: () => void
}) {
  return (
    <Dialog open={page !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88dvh] overflow-y-auto rounded-md sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>页面完整分析</DialogTitle>
          <DialogDescription className="break-all">
            {page?.final_url}
          </DialogDescription>
        </DialogHeader>
        {page && (
          <div className="space-y-6">
            <section>
              <h3 className="mb-3 text-sm font-semibold">基础 SEO</h3>
              <DetailGrid
                items={[
                  ["Title", page.title],
                  ["H1", page.h1.join(" | ")],
                  ["Meta Description", page.description],
                  ["词数", page.word_count ?? "-"],
                  ["语言", page.language],
                  ["字符集", page.charset],
                  ["Canonical", page.canonical],
                  ["Robots", page.robots],
                ]}
              />
            </section>
            <section>
              <h3 className="mb-3 text-sm font-semibold">分析与跟踪</h3>
              <DetailGrid
                items={[
                  ["已检测工具", analyticsSummary(page.analytics)],
                  ["Analytics 字段", Object.keys(page.analytics).length],
                  [
                    "OpenGraph",
                    `${Object.keys(page.open_graph).length} 个标签`,
                  ],
                  [
                    "Twitter Cards",
                    `${Object.keys(page.twitter_tags).length} 个标签`,
                  ],
                ]}
              />
            </section>
            <section>
              <h3 className="mb-3 text-sm font-semibold">链接与结构</h3>
              <DetailGrid
                items={[
                  ["内部链接", page.internal_links],
                  ["外部链接", page.external_links],
                  ["图片", page.images.length],
                  ["损坏图片", page.broken_images.length],
                  ["H2", page.h2.length],
                  ["H3", page.h3.length],
                  ["JSON-LD", page.structured_data.length],
                  ["Schema.org", page.schema_org.length],
                ]}
              />
            </section>
            <section>
              <h3 className="mb-3 text-sm font-semibold">响应与性能</h3>
              <DetailGrid
                items={[
                  ["状态码", page.status_code || "无响应"],
                  [
                    "响应时间",
                    page.response_time_ms === null
                      ? "-"
                      : `${page.response_time_ms} ms`,
                  ],
                  ["Content-Type", page.content_type],
                  ["页面大小", formatBytes(page.size_bytes)],
                  ["渲染方式", page.rendered ? "JavaScript" : "HTML"],
                  ["错误类型", page.error_type],
                  ["错误", page.error],
                  ["抓取深度", page.depth ?? "-"],
                ]}
              />
            </section>
            {page.linked_from.length > 0 && (
              <section>
                <h3 className="mb-3 text-sm font-semibold">
                  入链来源（{page.linked_from.length}）
                </h3>
                <div className="max-h-48 overflow-y-auto border-y">
                  {page.linked_from.slice(0, 20).map((url) => (
                    <div
                      key={url}
                      className="border-b px-2 py-2 text-xs break-all last:border-b-0"
                    >
                      {url}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function PageFilters({
  search,
  status,
  total,
  onSearchChange,
  onStatusChange,
}: {
  search: string
  status: "all" | AuditStatusFamily
  total: number
  onSearchChange: (value: string) => void
  onStatusChange: (value: "all" | AuditStatusFamily) => void
}) {
  return (
    <TableToolbar search={search} onSearch={onSearchChange}>
      <Select
        value={status}
        onValueChange={(value) =>
          onStatusChange((value ?? "all") as "all" | AuditStatusFamily)
        }
      >
        <SelectTrigger className="w-full sm:w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部状态</SelectItem>
          <SelectItem value="2xx">2xx 成功</SelectItem>
          <SelectItem value="3xx">3xx 重定向</SelectItem>
          <SelectItem value="4xx">4xx 客户端错误</SelectItem>
          <SelectItem value="5xx">5xx 服务器错误</SelectItem>
          <SelectItem value="unknown">无响应</SelectItem>
        </SelectContent>
      </Select>
      <span className="text-xs text-muted-foreground">共 {total} 项</span>
    </TableToolbar>
  )
}

function OverviewView({
  pages,
  total,
  page,
  pageSize,
  search,
  status,
  loading,
  onSearchChange,
  onStatusChange,
  onPageChange,
  onPageSizeChange,
}: {
  pages: AuditPage[]
  total: number
  page: number
  pageSize: number
  search: string
  status: "all" | AuditStatusFamily
  loading: boolean
  onSearchChange: (value: string) => void
  onStatusChange: (value: "all" | AuditStatusFamily) => void
  onPageChange: (value: number) => void
  onPageSizeChange: (value: number) => void
}) {
  const [selected, setSelected] = React.useState<AuditPage | null>(null)
  return (
    <>
      <section className="overflow-hidden rounded-md border">
        <PageFilters
          search={search}
          status={status}
          total={total}
          onSearchChange={onSearchChange}
          onStatusChange={onStatusChange}
        />
        {loading ? (
          <LoadingState />
        ) : pages.length === 0 ? (
          <EmptyState
            title="没有匹配的页面"
            description="修改搜索词或状态筛选后重试。"
          />
        ) : (
          <Table className="min-w-[1780px]">
            <TableHeader>
              <TableRow>
                <TableHead>地址</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Meta Description</TableHead>
                <TableHead>H1</TableHead>
                <TableHead className="text-right">词数</TableHead>
                <TableHead className="text-right">响应</TableHead>
                <TableHead>Analytics</TableHead>
                <TableHead className="text-right">OG</TableHead>
                <TableHead className="text-right">JSON-LD</TableHead>
                <TableHead className="text-right">链接（内/外）</TableHead>
                <TableHead className="text-right">图片</TableHead>
                <TableHead>JS</TableHead>
                <TableHead className="w-16">详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pages.map((item) => (
                <TableRow key={item.id}>
                  <TableCell
                    className="max-w-72 truncate font-medium"
                    title={item.final_url}
                  >
                    {item.final_url}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={item.status_code} />
                  </TableCell>
                  <TableCell className="max-w-56 truncate" title={item.title}>
                    {item.title || "-"}
                  </TableCell>
                  <TableCell
                    className="max-w-64 truncate text-muted-foreground"
                    title={item.description}
                  >
                    {item.description || "-"}
                  </TableCell>
                  <TableCell
                    className="max-w-48 truncate"
                    title={item.h1.join(" | ")}
                  >
                    {item.h1.join(" | ") || "-"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.word_count ?? 0}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.response_time_ms === null
                      ? "-"
                      : `${item.response_time_ms} ms`}
                  </TableCell>
                  <TableCell
                    className="max-w-52 truncate"
                    title={analyticsSummary(item.analytics)}
                  >
                    {analyticsSummary(item.analytics)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Object.keys(item.open_graph).length}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.structured_data.length}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.internal_links}/{item.external_links}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.images.length}
                  </TableCell>
                  <TableCell>{item.rendered ? "JS" : "-"}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="查看页面详情"
                      onClick={() => setSelected(item)}
                    >
                      <Eye />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      </section>
      <PageDetailDialog page={selected} onClose={() => setSelected(null)} />
    </>
  )
}

function IssuesView({
  issues,
  total,
  page,
  pageSize,
  search,
  severity,
  loading,
  onSearchChange,
  onSeverityChange,
  onPageChange,
  onPageSizeChange,
}: {
  issues: AuditIssue[]
  total: number
  page: number
  pageSize: number
  search: string
  severity: "all" | AuditSeverity
  loading: boolean
  onSearchChange: (value: string) => void
  onSeverityChange: (value: "all" | AuditSeverity) => void
  onPageChange: (value: number) => void
  onPageSizeChange: (value: number) => void
}) {
  const [selected, setSelected] = React.useState<AuditIssue | null>(null)

  return (
    <>
      <section className="overflow-hidden rounded-md border">
        <TableToolbar search={search} onSearch={onSearchChange}>
          <Select
            value={severity}
            onValueChange={(value) =>
              onSeverityChange((value ?? "all") as "all" | AuditSeverity)
            }
          >
            <SelectTrigger className="w-full sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部级别</SelectItem>
              <SelectItem value="error">错误</SelectItem>
              <SelectItem value="warning">警告</SelectItem>
              <SelectItem value="notice">提示</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">共 {total} 项</span>
        </TableToolbar>
        {loading ? (
          <LoadingState />
        ) : issues.length === 0 ? (
          <EmptyState
            title="没有匹配的问题"
            description="修改搜索词或严重级别筛选后重试。"
          />
        ) : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>问题</TableHead>
                <TableHead>级别</TableHead>
                <TableHead>分类</TableHead>
                <TableHead className="text-right">受影响页面</TableHead>
                <TableHead>修复建议</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {issues.map((issue) => (
                <TableRow key={issue.id}>
                  <TableCell className="max-w-96 whitespace-normal">
                    <div className="font-medium">{issue.title}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {issue.code}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={severityVariant(issue.severity)}>
                      {severityLabels[issue.severity]}
                    </Badge>
                  </TableCell>
                  <TableCell>{issue.category}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {issue.affected_count}
                  </TableCell>
                  <TableCell className="max-w-md whitespace-normal text-muted-foreground">
                    {issue.recommendation || "-"}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="查看受影响页面"
                      onClick={() => setSelected(issue)}
                    >
                      <Eye />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      </section>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent className="max-h-[80vh] overflow-y-auto rounded-md sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.title}</DialogTitle>
            <DialogDescription>{selected?.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {selected?.urls.map((url) => (
              <div
                key={url}
                className="rounded-md border px-3 py-2 text-xs break-all"
              >
                {url}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function InternalView({
  pages,
  total,
  page,
  pageSize,
  search,
  status,
  loading,
  onSearchChange,
  onStatusChange,
  onPageChange,
  onPageSizeChange,
}: {
  pages: AuditPage[]
  total: number
  page: number
  pageSize: number
  search: string
  status: "all" | AuditStatusFamily
  loading: boolean
  onSearchChange: (value: string) => void
  onStatusChange: (value: "all" | AuditStatusFamily) => void
  onPageChange: (value: number) => void
  onPageSizeChange: (value: number) => void
}) {
  return (
    <section className="overflow-hidden rounded-md border">
      <TableToolbar search={search} onSearch={onSearchChange}>
        <Select
          value={status}
          onValueChange={(value) =>
            onStatusChange((value ?? "all") as "all" | AuditStatusFamily)
          }
        >
          <SelectTrigger className="w-full sm:w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="2xx">2xx</SelectItem>
            <SelectItem value="3xx">3xx</SelectItem>
            <SelectItem value="4xx">4xx</SelectItem>
            <SelectItem value="5xx">5xx</SelectItem>
            <SelectItem value="unknown">无响应</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">共 {total} 项</span>
      </TableToolbar>
      {loading ? (
        <LoadingState />
      ) : pages.length === 0 ? (
        <EmptyState
          title="没有匹配的页面"
          description="修改搜索词或状态筛选后重试。"
        />
      ) : (
        <Table className="min-w-[1000px]">
          <TableHeader>
            <TableRow>
              <TableHead>地址</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>Content-Type</TableHead>
              <TableHead className="text-right">大小</TableHead>
              <TableHead>Title</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pages.map((item) => (
              <TableRow key={item.id}>
                <TableCell
                  className="max-w-md truncate font-medium"
                  title={item.final_url}
                >
                  {item.final_url}
                </TableCell>
                <TableCell>
                  <StatusBadge status={item.status_code} />
                </TableCell>
                <TableCell>{item.content_type || "-"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatBytes(item.size_bytes)}
                </TableCell>
                <TableCell className="max-w-sm truncate" title={item.title}>
                  {item.title || "-"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <TablePagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </section>
  )
}

function ExternalView({
  resources,
  total,
  page,
  pageSize,
  search,
  status,
  loading,
  onSearchChange,
  onStatusChange,
  onPageChange,
  onPageSizeChange,
}: {
  resources: AuditExternalResource[]
  total: number
  page: number
  pageSize: number
  search: string
  status: "all" | AuditStatusFamily
  loading: boolean
  onSearchChange: (value: string) => void
  onStatusChange: (value: "all" | AuditStatusFamily) => void
  onPageChange: (value: number) => void
  onPageSizeChange: (value: number) => void
}) {
  return (
    <section className="overflow-hidden rounded-md border">
      <PageFilters
        search={search}
        status={status}
        total={total}
        onSearchChange={onSearchChange}
        onStatusChange={onStatusChange}
      />
      {loading ? (
        <LoadingState />
      ) : resources.length === 0 ? (
        <EmptyState
          title="没有匹配的外部资源"
          description="修改搜索词或状态筛选后重试。"
        />
      ) : (
        <Table className="min-w-[900px]">
          <TableHeader>
            <TableRow>
              <TableHead>地址</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>Content-Type</TableHead>
              <TableHead className="text-right">大小</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>域名</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {resources.map((item) => (
              <TableRow key={item.id}>
                <TableCell
                  className="max-w-md truncate font-medium"
                  title={item.final_url}
                >
                  {item.final_url}
                </TableCell>
                <TableCell>
                  <StatusBadge status={item.status_code} />
                </TableCell>
                <TableCell>{item.content_type || "-"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatBytes(item.size_bytes)}
                </TableCell>
                <TableCell className="max-w-sm truncate" title={item.title}>
                  {item.title || item.error || "-"}
                </TableCell>
                <TableCell>{resourceDomain(item.final_url)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <TablePagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </section>
  )
}

function StatusCodesView({
  items,
  loading,
}: {
  items: AuditStatusCode[]
  loading: boolean
}) {
  if (loading) return <LoadingState />
  return (
    <section className="overflow-hidden rounded-md border">
      {items.length === 0 ? (
        <EmptyState
          title="暂无状态码数据"
          description="抓取页面后会在这里显示响应分布。"
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>状态码</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">数量</TableHead>
              <TableHead className="text-right">占比</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={`${item.status_code}-${item.error_type}`}>
                <TableCell>
                  <StatusBadge status={item.status_code} />
                </TableCell>
                <TableCell>{item.status}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.count}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.percentage.toFixed(1)}%
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}

type LinkTableState = {
  links: AuditLink[]
  total: number
  page: number
  pageSize: number
  search: string
  status: "all" | AuditStatusFamily
}

function AuditLinkTable({
  title,
  external,
  state,
  loading,
  onSearchChange,
  onStatusChange,
  onPageChange,
  onPageSizeChange,
}: {
  title: string
  external: boolean
  state: LinkTableState
  loading: boolean
  onSearchChange: (value: string) => void
  onStatusChange: (value: "all" | AuditStatusFamily) => void
  onPageChange: (value: number) => void
  onPageSizeChange: (value: number) => void
}) {
  return (
    <section className="overflow-hidden rounded-md border">
      <div className="border-b px-4 py-3 text-sm font-semibold">{title}</div>
      <PageFilters
        search={state.search}
        status={state.status}
        total={state.total}
        onSearchChange={onSearchChange}
        onStatusChange={onStatusChange}
      />
      {loading ? (
        <LoadingState />
      ) : state.links.length === 0 ? (
        <EmptyState
          title={`没有匹配的${title}`}
          description="修改搜索词或状态筛选后重试。"
        />
      ) : (
        <Table className="min-w-[1100px]">
          <TableHeader>
            <TableRow>
              <TableHead>来源 URL</TableHead>
              <TableHead>目标 URL</TableHead>
              <TableHead>状态</TableHead>
              {external ? (
                <TableHead>域名</TableHead>
              ) : (
                <TableHead>锚文本</TableHead>
              )}
              <TableHead>位置</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.links.map((item) => (
              <TableRow key={item.id}>
                <TableCell
                  className="max-w-xs truncate text-muted-foreground"
                  title={item.source_url}
                >
                  {item.source_url}
                </TableCell>
                <TableCell
                  className="max-w-sm truncate font-medium"
                  title={item.target_url}
                >
                  {item.target_url}
                </TableCell>
                <TableCell>
                  <StatusBadge status={item.status_code} />
                </TableCell>
                <TableCell
                  className="max-w-60 truncate"
                  title={external ? item.target_domain : item.anchor_text}
                >
                  {(external ? item.target_domain : item.anchor_text) || "-"}
                </TableCell>
                <TableCell>{item.placement || "body"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <TablePagination
        page={state.page}
        pageSize={state.pageSize}
        total={state.total}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </section>
  )
}

function LinksView({
  internal,
  external,
  loading,
  onInternalSearch,
  onInternalStatus,
  onInternalPage,
  onInternalPageSize,
  onExternalSearch,
  onExternalStatus,
  onExternalPage,
  onExternalPageSize,
}: {
  internal: LinkTableState
  external: LinkTableState
  loading: boolean
  onInternalSearch: (value: string) => void
  onInternalStatus: (value: "all" | AuditStatusFamily) => void
  onInternalPage: (value: number) => void
  onInternalPageSize: (value: number) => void
  onExternalSearch: (value: string) => void
  onExternalStatus: (value: "all" | AuditStatusFamily) => void
  onExternalPage: (value: number) => void
  onExternalPageSize: (value: number) => void
}) {
  return (
    <div className="space-y-6">
      <AuditLinkTable
        title="内部链接"
        external={false}
        state={internal}
        loading={loading}
        onSearchChange={onInternalSearch}
        onStatusChange={onInternalStatus}
        onPageChange={onInternalPage}
        onPageSizeChange={onInternalPageSize}
      />
      <AuditLinkTable
        title="外部链接"
        external
        state={external}
        loading={loading}
        onSearchChange={onExternalSearch}
        onStatusChange={onExternalStatus}
        onPageChange={onExternalPage}
        onPageSizeChange={onExternalPageSize}
      />
    </div>
  )
}

function metricValue(
  metrics: Record<string, unknown>,
  key: string,
  suffix = ""
) {
  const value = metrics[key]
  return typeof value === "number" ? `${value}${suffix}` : "-"
}

function scoreColor(score: number | null) {
  if (score === null) return "text-muted-foreground"
  if (score >= 90) return "text-emerald-600"
  if (score >= 50) return "text-amber-600"
  return "text-destructive"
}

function PageSpeedView({
  run,
  results,
  loading,
}: {
  run: AuditRun
  results: AuditPageSpeedResult[]
  loading: boolean
}) {
  if (loading) return <LoadingState />
  if (!run.pagespeed?.configured) {
    return (
      <EmptyState
        title="本次审计未启用 PageSpeed"
        description="新建审计时可在高级设置中开启 PageSpeed 分析。"
      />
    )
  }
  if (results.length === 0) {
    return (
      <EmptyState
        title="暂无 PageSpeed 结果"
        description={run.pagespeed?.message || "页面抓取完成后开始性能分析。"}
      />
    )
  }
  const groupedResults = Array.from(
    results.reduce((groups, result) => {
      const group = groups.get(result.url) ?? {
        url: result.url,
        results: new Map<string, AuditPageSpeedResult>(),
      }
      group.results.set(result.strategy, result)
      groups.set(result.url, group)
      return groups
    }, new Map<string, { url: string; results: Map<string, AuditPageSpeedResult> }>())
  )
    .map(([, group]) => group)
    .sort((left, right) => left.url.localeCompare(right.url))

  return (
    <div className="space-y-4">
      {groupedResults.map((group) => (
        <section key={group.url} className="overflow-hidden rounded-md border">
          <div className="border-b px-5 py-4">
            <div className="truncate font-medium" title={group.url}>
              {group.url}
            </div>
          </div>
          <div className="grid lg:grid-cols-2 lg:divide-x">
            {(["mobile", "desktop"] as const).map((strategy) => {
              const result = group.results.get(strategy)
              const DeviceIcon = strategy === "mobile" ? Smartphone : Monitor
              return (
                <div
                  key={strategy}
                  className="border-b p-5 last:border-b-0 lg:border-b-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <DeviceIcon className="size-4 shrink-0 text-muted-foreground" />
                      <div>
                        <div className="text-sm font-medium">
                          {strategy === "mobile" ? "移动端" : "桌面端"}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {result ? formatDate(result.analyzed_at) : "尚未分析"}
                        </div>
                      </div>
                    </div>
                    <Badge variant={result?.error ? "destructive" : "outline"}>
                      {result?.error ? "分析失败" : strategy}
                    </Badge>
                  </div>
                  {!result ? (
                    <div className="mt-5 text-sm text-muted-foreground">
                      暂无该设备的分析结果
                    </div>
                  ) : result.error ? (
                    <div className="mt-5 text-sm text-destructive">
                      {result.error}
                    </div>
                  ) : (
                    <>
                      <div className="mt-5 grid grid-cols-[minmax(0,1.25fr)_repeat(3,minmax(0,1fr))] gap-px overflow-hidden rounded-md border bg-border">
                        {[
                          ["性能", result.performance_score],
                          ["无障碍", result.accessibility_score],
                          ["最佳实践", result.best_practices_score],
                          ["SEO", result.seo_score],
                        ].map(([label, score], index) => (
                          <div
                            key={String(label)}
                            className="min-w-0 bg-background p-3"
                          >
                            <div className="truncate text-xs text-muted-foreground">
                              {label}
                            </div>
                            <div
                              className={`${index === 0 ? "text-2xl" : "text-lg"} mt-1 font-semibold tabular-nums ${scoreColor(
                                score as number | null
                              )}`}
                            >
                              {score ?? "-"}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5 lg:grid-cols-2 xl:grid-cols-5">
                        {[
                          [
                            "FCP",
                            metricValue(
                              result.metrics,
                              "first_contentful_paint",
                              " s"
                            ),
                          ],
                          [
                            "LCP",
                            metricValue(
                              result.metrics,
                              "largest_contentful_paint",
                              " s"
                            ),
                          ],
                          [
                            "CLS",
                            metricValue(
                              result.metrics,
                              "cumulative_layout_shift"
                            ),
                          ],
                          [
                            "Speed Index",
                            metricValue(result.metrics, "speed_index", " s"),
                          ],
                          [
                            "TTI",
                            metricValue(
                              result.metrics,
                              "time_to_interactive",
                              " s"
                            ),
                          ],
                        ].map(([label, value]) => (
                          <div key={label} className="border-t pt-2">
                            <div className="text-xs text-muted-foreground">
                              {label}
                            </div>
                            <div className="mt-1 font-medium tabular-nums">
                              {value}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

function HistoryView({
  runs,
  total,
  page,
  pageSize,
  search,
  status,
  loading,
  includeArchived,
  onIncludeArchived,
  onSearchChange,
  onStatusChange,
  onPageChange,
  onPageSizeChange,
  onSelect,
  onArchive,
  onDelete,
}: {
  runs: AuditRun[]
  total: number
  page: number
  pageSize: number
  search: string
  status: "all" | AuditRun["status"]
  loading: boolean
  includeArchived: boolean
  onIncludeArchived: (value: boolean) => void
  onSearchChange: (value: string) => void
  onStatusChange: (value: "all" | AuditRun["status"]) => void
  onPageChange: (value: number) => void
  onPageSizeChange: (value: number) => void
  onSelect: (run: AuditRun) => void
  onArchive: (run: AuditRun) => void
  onDelete: (run: AuditRun) => void
}) {
  return (
    <section className="overflow-hidden rounded-md border">
      <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
        <div>
          <div className="text-sm font-medium">审计历史</div>
          <div className="text-xs text-muted-foreground">共 {total} 次审计</div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={includeArchived}
            onCheckedChange={onIncludeArchived}
          />
          包含已归档
        </label>
      </div>
      <TableToolbar search={search} onSearch={onSearchChange}>
        <Select
          value={status}
          onValueChange={(value) =>
            onStatusChange((value ?? "all") as "all" | AuditRun["status"])
          }
        >
          <SelectTrigger className="w-full sm:w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {Object.entries(statusLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableToolbar>
      {loading ? (
        <LoadingState />
      ) : runs.length === 0 ? (
        <EmptyState
          title={search || status !== "all" ? "没有匹配的审计" : "暂无审计历史"}
          description={
            search || status !== "all"
              ? "请调整搜索内容或状态筛选。"
              : "启动首次审计后会在这里保存记录。"
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>开始时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">页面</TableHead>
                <TableHead className="text-right">健康度</TableHead>
                <TableHead className="text-right">错误</TableHead>
                <TableHead className="text-right">警告</TableHead>
                <TableHead className="w-52">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((item) => (
                <TableRow key={item.run_id}>
                  <TableCell>
                    <div>{formatDate(item.created_at)}</div>
                    {item.archived_at && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        已归档
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(item.status)}>
                      {statusLabels[item.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.summary?.page_count ?? item.processed}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.summary?.health_score ?? "-"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.summary?.errors ?? "-"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.summary?.warnings ?? "-"}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onSelect(item)}
                      >
                        <Eye />
                        查看
                      </Button>
                      {!item.archived_at &&
                        !["queued", "running"].includes(item.status) && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="归档"
                            onClick={() => onArchive(item)}
                          >
                            <Archive />
                          </Button>
                        )}
                      {!["queued", "running"].includes(item.status) && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="删除"
                          onClick={() => onDelete(item)}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
          />
        </>
      )}
    </section>
  )
}

export function AuditWorkspace({
  project,
  view,
  run,
  error,
  onStart,
  onRunChange,
  onProjectRefresh,
}: AuditWorkspaceProps) {
  const navigate = useNavigate()
  const [issues, setIssues] = React.useState<AuditIssue[]>([])
  const [issueTotal, setIssueTotal] = React.useState(0)
  const [issuePage, setIssuePage] = React.useState(1)
  const [issuePageSize, setIssuePageSize] = React.useState(50)
  const [issueSearch, setIssueSearch] = React.useState("")
  const [issueQuery, setIssueQuery] = React.useState("")
  const [issueSeverity, setIssueSeverity] = React.useState<
    "all" | AuditSeverity
  >("all")
  const [pages, setPages] = React.useState<AuditPage[]>([])
  const [pageTotal, setPageTotal] = React.useState(0)
  const [pagePage, setPagePage] = React.useState(1)
  const [pagePageSize, setPagePageSize] = React.useState(50)
  const [pageSearch, setPageSearch] = React.useState("")
  const [pageQuery, setPageQuery] = React.useState("")
  const [pageStatus, setPageStatus] = React.useState<"all" | AuditStatusFamily>(
    "all"
  )
  const [externalResources, setExternalResources] = React.useState<
    AuditExternalResource[]
  >([])
  const [externalResourceTotal, setExternalResourceTotal] = React.useState(0)
  const [externalResourcePage, setExternalResourcePage] = React.useState(1)
  const [externalResourcePageSize, setExternalResourcePageSize] =
    React.useState(50)
  const [externalResourceSearch, setExternalResourceSearch] = React.useState("")
  const [externalResourceQuery, setExternalResourceQuery] = React.useState("")
  const [externalResourceStatus, setExternalResourceStatus] = React.useState<
    "all" | AuditStatusFamily
  >("all")
  const [statusCodes, setStatusCodes] = React.useState<AuditStatusCode[]>([])
  const [internalLinks, setInternalLinks] = React.useState<AuditLink[]>([])
  const [internalLinkTotal, setInternalLinkTotal] = React.useState(0)
  const [internalLinkPage, setInternalLinkPage] = React.useState(1)
  const [internalLinkPageSize, setInternalLinkPageSize] = React.useState(50)
  const [internalLinkSearch, setInternalLinkSearch] = React.useState("")
  const [internalLinkQuery, setInternalLinkQuery] = React.useState("")
  const [internalLinkStatus, setInternalLinkStatus] = React.useState<
    "all" | AuditStatusFamily
  >("all")
  const [externalLinks, setExternalLinks] = React.useState<AuditLink[]>([])
  const [externalLinkTotal, setExternalLinkTotal] = React.useState(0)
  const [externalLinkPage, setExternalLinkPage] = React.useState(1)
  const [externalLinkPageSize, setExternalLinkPageSize] = React.useState(50)
  const [externalLinkSearch, setExternalLinkSearch] = React.useState("")
  const [externalLinkQuery, setExternalLinkQuery] = React.useState("")
  const [externalLinkStatus, setExternalLinkStatus] = React.useState<
    "all" | AuditStatusFamily
  >("all")
  const [pageSpeed, setPageSpeed] = React.useState<AuditPageSpeedResult[]>([])
  const [graph, setGraph] = React.useState<AuditVisualization | null>(null)
  const [history, setHistory] = React.useState<AuditRun[]>([])
  const [historyTotal, setHistoryTotal] = React.useState(0)
  const [historyPage, setHistoryPage] = React.useState(1)
  const [historyPageSize, setHistoryPageSize] = React.useState(25)
  const [historySearch, setHistorySearch] = React.useState("")
  const [historyQuery, setHistoryQuery] = React.useState("")
  const [historyStatus, setHistoryStatus] = React.useState<
    "all" | AuditRun["status"]
  >("all")
  const [activityState, setActivityState] = React.useState<{
    runId: string | null
    items: AuditActivity[]
    error: string
  }>({
    runId: null,
    items: [],
    error: "",
  })
  const [activityLoading, setActivityLoading] = React.useState(false)
  const activityCursor = React.useRef({
    runId: null as string | null,
    value: 0,
  })
  const [includeArchived, setIncludeArchived] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [historyLoading, setHistoryLoading] = React.useState(false)
  const [actionBusy, setActionBusy] = React.useState(false)
  const [workspaceError, setWorkspaceError] = React.useState("")
  const [newAuditOpen, setNewAuditOpen] = React.useState(false)
  const [recalculateOpen, setRecalculateOpen] = React.useState(false)
  const [recalculatePatterns, setRecalculatePatterns] = React.useState("")
  const [deleteTarget, setDeleteTarget] = React.useState<AuditRun | null>(null)
  const [historyVersion, setHistoryVersion] = React.useState(0)
  const [dataRefreshTick, setDataRefreshTick] = React.useState(0)
  const [readyRunKey, setReadyRunKey] = React.useState<string | null>(null)
  const dataRequestKey = React.useRef<string | null>(null)
  const activeProjectId = React.useRef(project.id)
  React.useLayoutEffect(() => {
    activeProjectId.current = project.id
    return () => {
      activeProjectId.current = ""
    }
  }, [project.id])
  const runId = run?.run_id ?? null
  const runDataKey = run
    ? `${run.run_id}:${
        ["queued", "running", "stopping", "recalculating"].includes(run.status)
          ? "active"
          : run.status
      }`
    : null
  const crawling =
    run?.status === "queued" ||
    run?.status === "running" ||
    run?.status === "stopping"
  const running = crawling || run?.status === "recalculating"
  const finalizing = run?.status === "running" && run.stage === "completed"
  const currentRunKey = runId ? `${project.id}:${runId}` : null
  const completedRunKey = run?.status === "completed" ? currentRunKey : null
  const finalResultsReady =
    completedRunKey === null || readyRunKey === completedRunKey
  const finalResultsPending = completedRunKey !== null && !finalResultsReady
  const activity = activityState.runId === runId ? activityState.items : []
  const activityError = activityState.runId === runId ? activityState.error : ""

  React.useEffect(() => {
    if (run?.status === "completed" || !currentRunKey) return
    setReadyRunKey((value) => (value === currentRunKey ? null : value))
  }, [currentRunKey, run?.status])

  React.useEffect(() => {
    if (
      !runId ||
      !running ||
      view === "history" ||
      (crawling && view !== "overview")
    ) {
      return
    }
    const interval = window.setInterval(() => {
      setDataRefreshTick((value) => value + 1)
    }, 1500)
    return () => window.clearInterval(interval)
  }, [crawling, runId, running, view])

  React.useEffect(() => {
    if (!runId || !crawling || view !== "overview") return
    let active = true
    let timeout = 0
    if (activityCursor.current.runId !== runId) {
      activityCursor.current = { runId, value: 0 }
    }

    const poll = async () => {
      if (!active) return
      setActivityLoading(true)
      try {
        const result = await getAuditActivity(
          project.id,
          runId,
          activityCursor.current.value
        )
        if (!active) return
        activityCursor.current = {
          runId,
          value: result.next_cursor,
        }
        setActivityState((current) => ({
          runId,
          items:
            result.items.length > 0
              ? [
                  ...(current.runId === runId ? current.items : []),
                  ...result.items,
                ].slice(-12)
              : current.runId === runId
                ? current.items
                : [],
          error: "",
        }))
      } catch (requestError) {
        if (!active) return
        setActivityState((current) => ({
          runId,
          items: current.runId === runId ? current.items : [],
          error:
            requestError instanceof Error
              ? requestError.message
              : "读取实时抓取记录失败",
        }))
      } finally {
        if (active) {
          setActivityLoading(false)
          timeout = window.setTimeout(poll, 1500)
        }
      }
    }

    void poll()
    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [crawling, project.id, runId, view])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      setIssuePage(1)
      setIssueQuery(issueSearch.trim())
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [issueSearch])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      setPagePage(1)
      setPageQuery(pageSearch.trim())
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [pageSearch])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      setExternalResourcePage(1)
      setExternalResourceQuery(externalResourceSearch.trim())
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [externalResourceSearch])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      setInternalLinkPage(1)
      setInternalLinkQuery(internalLinkSearch.trim())
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [internalLinkSearch])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      setExternalLinkPage(1)
      setExternalLinkQuery(externalLinkSearch.trim())
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [externalLinkSearch])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      setHistoryPage(1)
      setHistoryQuery(historySearch.trim())
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [historySearch])

  React.useEffect(() => {
    if (!runId || view === "history" || (crawling && view !== "overview")) {
      return
    }
    let active = true
    const requestKey = [
      project.id,
      runId,
      view,
      issuePage,
      issuePageSize,
      issueQuery,
      issueSeverity,
      pagePage,
      pagePageSize,
      pageQuery,
      pageStatus,
      externalResourcePage,
      externalResourcePageSize,
      externalResourceQuery,
      externalResourceStatus,
      internalLinkPage,
      internalLinkPageSize,
      internalLinkQuery,
      internalLinkStatus,
      externalLinkPage,
      externalLinkPageSize,
      externalLinkQuery,
      externalLinkStatus,
    ].join("\x1f")
    const replacingData = dataRequestKey.current !== requestKey
    dataRequestKey.current = requestKey
    void Promise.resolve().then(async () => {
      if (!active) return
      if (replacingData || completedRunKey) {
        setLoading(true)
        setWorkspaceError("")
      }
      try {
        if (view === "overview" || view === "internal") {
          if (replacingData) {
            setPages([])
            setPageTotal(0)
          }
          const result = await getAuditPages(project.id, runId, {
            page: pagePage,
            pageSize: pagePageSize,
            search: pageQuery,
            statusFamily: pageStatus === "all" ? undefined : pageStatus,
          })
          if (active) {
            setPages(result.items)
            setPageTotal(result.total)
          }
        } else if (view === "external") {
          if (replacingData) {
            setExternalResources([])
            setExternalResourceTotal(0)
          }
          const result = await getAuditExternalResources(project.id, runId, {
            page: externalResourcePage,
            pageSize: externalResourcePageSize,
            search: externalResourceQuery,
            statusFamily:
              externalResourceStatus === "all"
                ? undefined
                : externalResourceStatus,
          })
          if (active) {
            setExternalResources(result.items)
            setExternalResourceTotal(result.total)
          }
        } else if (view === "status-codes") {
          if (replacingData) setStatusCodes([])
          const result = await getAuditStatusCodes(project.id, runId)
          if (active) setStatusCodes(result)
        } else if (view === "issues") {
          if (replacingData) {
            setIssues([])
            setIssueTotal(0)
          }
          const result = await getAuditIssues(project.id, runId, {
            page: issuePage,
            pageSize: issuePageSize,
            search: issueQuery,
            severity: issueSeverity === "all" ? undefined : issueSeverity,
          })
          if (active) {
            setIssues(result.items)
            setIssueTotal(result.total)
          }
        } else if (view === "links") {
          if (replacingData) {
            setInternalLinks([])
            setInternalLinkTotal(0)
            setExternalLinks([])
            setExternalLinkTotal(0)
          }
          const [internalResult, externalResult] = await Promise.all([
            getAuditLinks(project.id, runId, {
              page: internalLinkPage,
              pageSize: internalLinkPageSize,
              search: internalLinkQuery,
              internal: true,
              statusFamily:
                internalLinkStatus === "all" ? undefined : internalLinkStatus,
            }),
            getAuditLinks(project.id, runId, {
              page: externalLinkPage,
              pageSize: externalLinkPageSize,
              search: externalLinkQuery,
              internal: false,
              statusFamily:
                externalLinkStatus === "all" ? undefined : externalLinkStatus,
            }),
          ])
          if (active) {
            setInternalLinks(internalResult.items)
            setInternalLinkTotal(internalResult.total)
            setExternalLinks(externalResult.items)
            setExternalLinkTotal(externalResult.total)
          }
        } else if (view === "pagespeed") {
          if (replacingData) setPageSpeed([])
          const result = await getAuditPageSpeed(project.id, runId)
          if (active) setPageSpeed(result)
        } else if (view === "visualization") {
          if (replacingData) setGraph(null)
          const result = await getAuditVisualization(project.id, runId)
          if (active) setGraph(result)
        }
        if (active && completedRunKey) {
          setReadyRunKey(completedRunKey)
        }
      } catch (requestError) {
        if (active) {
          setWorkspaceError(
            requestError instanceof Error
              ? requestError.message
              : "读取审计数据失败"
          )
        }
      } finally {
        if (active) setLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [
    completedRunKey,
    crawling,
    externalLinkPage,
    externalLinkPageSize,
    externalLinkQuery,
    externalLinkStatus,
    externalResourcePage,
    externalResourcePageSize,
    externalResourceQuery,
    externalResourceStatus,
    dataRefreshTick,
    internalLinkPage,
    internalLinkPageSize,
    internalLinkQuery,
    internalLinkStatus,
    issuePage,
    issuePageSize,
    issueQuery,
    issueSeverity,
    pagePage,
    pagePageSize,
    pageQuery,
    pageStatus,
    project.id,
    runDataKey,
    runId,
    view,
  ])

  React.useEffect(() => {
    if (view !== "history" || !project.id || crawling) return
    let active = true
    void Promise.resolve().then(async () => {
      if (!active) return
      setHistoryLoading(true)
      setWorkspaceError("")
      try {
        const result = await listAuditRuns(project.id, {
          includeArchived,
          page: historyPage,
          pageSize: historyPageSize,
          search: historyQuery,
          status: historyStatus === "all" ? undefined : historyStatus,
        })
        if (active) {
          setHistory(result.items)
          setHistoryTotal(result.total)
          if (completedRunKey) {
            setReadyRunKey(completedRunKey)
          }
        }
      } catch (requestError) {
        if (active) {
          setWorkspaceError(
            requestError instanceof Error
              ? requestError.message
              : "读取审计历史失败"
          )
        }
      } finally {
        if (active) setHistoryLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [
    completedRunKey,
    crawling,
    historyPage,
    historyPageSize,
    historyQuery,
    historyStatus,
    historyVersion,
    includeArchived,
    project.id,
    view,
  ])

  async function performAction(
    action: (projectId: string, runId: string) => Promise<AuditRun>,
    target = run
  ) {
    if (!target) return
    const projectId = project.id
    setActionBusy(true)
    setWorkspaceError("")
    try {
      const nextRun = await action(projectId, target.run_id)
      if (activeProjectId.current !== projectId) return
      if (run?.run_id === target.run_id) onRunChange(nextRun)
      setHistoryVersion((value) => value + 1)
    } catch (actionError) {
      if (activeProjectId.current !== projectId) return
      setWorkspaceError(
        actionError instanceof Error ? actionError.message : "审计操作失败"
      )
      setActionBusy(false)
      return
    }

    try {
      await onProjectRefresh()
    } catch (refreshError) {
      if (activeProjectId.current !== projectId) return
      setWorkspaceError(
        `审计操作已完成，但项目状态刷新失败：${
          refreshError instanceof Error ? refreshError.message : "未知错误"
        }`
      )
    } finally {
      if (activeProjectId.current === projectId) {
        setActionBusy(false)
      }
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const projectId = project.id
    setActionBusy(true)
    setWorkspaceError("")
    const target = deleteTarget
    try {
      await deleteAuditRun(projectId, target.run_id)
    } catch (deleteError) {
      if (activeProjectId.current !== projectId) return
      setWorkspaceError(
        deleteError instanceof Error ? deleteError.message : "删除审计失败"
      )
      setActionBusy(false)
      return
    }

    if (activeProjectId.current !== projectId) return
    setDeleteTarget(null)
    setHistory((current) =>
      current.filter((item) => item.run_id !== target.run_id)
    )
    setHistoryTotal((current) => Math.max(0, current - 1))
    if (run?.run_id === target.run_id) {
      onRunChange(null)
      navigate(`/projects/${projectId}/audit/overview`, { replace: true })
    }

    const refreshErrors: string[] = []
    try {
      const remaining = await listAuditRuns(projectId, {
        page: 1,
        pageSize: 1,
      })
      if (activeProjectId.current !== projectId) return
      setHistoryVersion((value) => value + 1)
      if (run?.run_id === target.run_id) {
        const fallback = remaining.items[0] ?? null
        onRunChange(fallback)
        navigate(
          fallback
            ? `/projects/${projectId}/audit/overview?runId=${encodeURIComponent(
                fallback.run_id
              )}`
            : `/projects/${projectId}/audit/overview`,
          { replace: true }
        )
      }
    } catch (historyError) {
      refreshErrors.push(
        `重新读取审计历史失败：${
          historyError instanceof Error ? historyError.message : "未知错误"
        }`
      )
    }

    try {
      await onProjectRefresh()
    } catch (refreshError) {
      if (activeProjectId.current !== projectId) return
      refreshErrors.push(
        `项目状态刷新失败：${
          refreshError instanceof Error ? refreshError.message : "未知错误"
        }`
      )
    }

    if (activeProjectId.current === projectId && refreshErrors.length > 0) {
      setWorkspaceError(`审计已删除，但${refreshErrors.join("；")}`)
    }

    if (activeProjectId.current === projectId) {
      setActionBusy(false)
    }
  }

  async function handleExport(
    dataset: AuditExportDataset,
    format: AuditExportFormat
  ) {
    if (!run) return
    setActionBusy(true)
    setWorkspaceError("")
    try {
      const result = await downloadAuditExport(
        project.id,
        run.run_id,
        dataset,
        format
      )
      const url = URL.createObjectURL(result.blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = result.filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } catch (exportError) {
      setWorkspaceError(
        exportError instanceof Error ? exportError.message : "导出审计失败"
      )
    } finally {
      setActionBusy(false)
    }
  }

  async function handleRecalculate() {
    if (!run) return
    const patterns = Array.from(
      new Set(
        recalculatePatterns
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean)
      )
    )
    if (patterns.length > 250) {
      setWorkspaceError("排除规则最多 250 条")
      return
    }
    if (patterns.some((value) => value.length > 2048)) {
      setWorkspaceError("单条排除规则最多 2048 个字符")
      return
    }

    const projectId = project.id
    setActionBusy(true)
    setWorkspaceError("")
    try {
      const nextRun = await recalculateAuditIssues(
        projectId,
        run.run_id,
        patterns
      )
      if (activeProjectId.current !== projectId) return
      onRunChange(nextRun)
      setRecalculateOpen(false)
      setHistoryVersion((value) => value + 1)
      await onProjectRefresh()
    } catch (recalculateError) {
      if (activeProjectId.current !== projectId) return
      setWorkspaceError(
        recalculateError instanceof Error
          ? recalculateError.message
          : "重新计算问题失败"
      )
    } finally {
      if (activeProjectId.current === projectId) {
        setActionBusy(false)
      }
    }
  }

  function selectHistoryRun(item: AuditRun) {
    onRunChange(item)
    navigate(
      `/projects/${project.id}/audit/overview?runId=${encodeURIComponent(
        item.run_id
      )}`
    )
  }

  function retryFinalResults() {
    setWorkspaceError("")
    if (view === "history") {
      setHistoryVersion((value) => value + 1)
      return
    }
    setDataRefreshTick((value) => value + 1)
  }

  if (!run && view !== "history") {
    return (
      <>
        {(error || workspaceError) && (
          <div className="mb-5 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span>{error || workspaceError}</span>
          </div>
        )}
        <AuditSetup project={project} running={false} onStart={onStart} />
      </>
    )
  }

  return (
    <>
      {run && (
        <AuditStatusPanel
          run={run}
          resultsReady={finalResultsReady}
          resultsError={finalResultsPending ? workspaceError || error : ""}
          actionBusy={actionBusy}
          onPause={() => void performAction(pauseAuditRun)}
          onResume={() => void performAction(resumeAuditRun)}
          onStop={() => void performAction(stopAuditRun)}
          onArchive={() => void performAction(archiveAuditRun)}
          onDelete={() => setDeleteTarget(run)}
          onRecalculate={() => {
            setRecalculatePatterns(
              (run.issue_exclusion_patterns ?? []).join("\n")
            )
            setRecalculateOpen(true)
          }}
          onNew={() => setNewAuditOpen(true)}
          onExport={(dataset, format) => void handleExport(dataset, format)}
        />
      )}

      {run && crawling && !finalizing && view === "overview" && (
        <CrawlActivityPanel
          items={activity}
          loading={activityLoading}
          error={activityError}
        />
      )}

      {(error || workspaceError) && !finalResultsPending && (
        <div className="mb-5 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>{workspaceError || error}</span>
        </div>
      )}

      {crawling && view !== "overview" ? (
        <CrawlPendingState finalizing={finalizing} />
      ) : finalResultsPending ? (
        <FinalResultsState
          error={workspaceError || error}
          onRetry={retryFinalResults}
        />
      ) : view === "history" ? (
        <HistoryView
          runs={history}
          total={historyTotal}
          page={historyPage}
          pageSize={historyPageSize}
          search={historySearch}
          status={historyStatus}
          loading={historyLoading}
          includeArchived={includeArchived}
          onIncludeArchived={(value) => {
            setIncludeArchived(value)
            setHistoryPage(1)
          }}
          onSearchChange={setHistorySearch}
          onStatusChange={(value) => {
            setHistoryStatus(value)
            setHistoryPage(1)
          }}
          onPageChange={setHistoryPage}
          onPageSizeChange={(value) => {
            setHistoryPageSize(value)
            setHistoryPage(1)
          }}
          onSelect={selectHistoryRun}
          onArchive={(item) => void performAction(archiveAuditRun, item)}
          onDelete={setDeleteTarget}
        />
      ) : !run ? null : view === "overview" ? (
        <OverviewView
          pages={pages}
          total={pageTotal}
          page={pagePage}
          pageSize={pagePageSize}
          search={pageSearch}
          status={pageStatus}
          loading={loading}
          onSearchChange={setPageSearch}
          onStatusChange={(value) => {
            setPageStatus(value)
            setPagePage(1)
          }}
          onPageChange={setPagePage}
          onPageSizeChange={(value) => {
            setPagePageSize(value)
            setPagePage(1)
          }}
        />
      ) : view === "internal" ? (
        <InternalView
          pages={pages}
          total={pageTotal}
          page={pagePage}
          pageSize={pagePageSize}
          search={pageSearch}
          status={pageStatus}
          loading={loading}
          onSearchChange={setPageSearch}
          onStatusChange={(value) => {
            setPageStatus(value)
            setPagePage(1)
          }}
          onPageChange={setPagePage}
          onPageSizeChange={(value) => {
            setPagePageSize(value)
            setPagePage(1)
          }}
        />
      ) : view === "external" ? (
        <ExternalView
          resources={externalResources}
          total={externalResourceTotal}
          page={externalResourcePage}
          pageSize={externalResourcePageSize}
          search={externalResourceSearch}
          status={externalResourceStatus}
          loading={loading}
          onSearchChange={setExternalResourceSearch}
          onStatusChange={(value) => {
            setExternalResourceStatus(value)
            setExternalResourcePage(1)
          }}
          onPageChange={setExternalResourcePage}
          onPageSizeChange={(value) => {
            setExternalResourcePageSize(value)
            setExternalResourcePage(1)
          }}
        />
      ) : view === "status-codes" ? (
        <StatusCodesView items={statusCodes} loading={loading} />
      ) : view === "issues" ? (
        <IssuesView
          issues={issues}
          total={issueTotal}
          page={issuePage}
          pageSize={issuePageSize}
          search={issueSearch}
          severity={issueSeverity}
          loading={loading}
          onSearchChange={setIssueSearch}
          onSeverityChange={(value) => {
            setIssueSeverity(value)
            setIssuePage(1)
          }}
          onPageChange={setIssuePage}
          onPageSizeChange={(value) => {
            setIssuePageSize(value)
            setIssuePage(1)
          }}
        />
      ) : view === "links" ? (
        <LinksView
          internal={{
            links: internalLinks,
            total: internalLinkTotal,
            page: internalLinkPage,
            pageSize: internalLinkPageSize,
            search: internalLinkSearch,
            status: internalLinkStatus,
          }}
          external={{
            links: externalLinks,
            total: externalLinkTotal,
            page: externalLinkPage,
            pageSize: externalLinkPageSize,
            search: externalLinkSearch,
            status: externalLinkStatus,
          }}
          loading={loading}
          onInternalSearch={setInternalLinkSearch}
          onInternalStatus={(value) => {
            setInternalLinkStatus(value)
            setInternalLinkPage(1)
          }}
          onInternalPage={setInternalLinkPage}
          onInternalPageSize={(value) => {
            setInternalLinkPageSize(value)
            setInternalLinkPage(1)
          }}
          onExternalSearch={setExternalLinkSearch}
          onExternalStatus={(value) => {
            setExternalLinkStatus(value)
            setExternalLinkPage(1)
          }}
          onExternalPage={setExternalLinkPage}
          onExternalPageSize={(value) => {
            setExternalLinkPageSize(value)
            setExternalLinkPage(1)
          }}
        />
      ) : view === "pagespeed" ? (
        <PageSpeedView run={run} results={pageSpeed} loading={loading} />
      ) : (
        <React.Suspense
          fallback={
            <div className="flex min-h-96 items-center justify-center text-sm text-muted-foreground">
              <LoaderCircle className="mr-2 size-4 animate-spin" />
              正在加载网站结构
            </div>
          }
        >
          <SiteStructureVisualization graph={graph} loading={loading} />
        </React.Suspense>
      )}

      <Dialog open={recalculateOpen} onOpenChange={setRecalculateOpen}>
        <DialogContent className="rounded-md sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>调整问题排除规则</DialogTitle>
            <DialogDescription>
              每行一条 URL 或通配规则。只重新计算问题，不重新访问网站。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={recalculatePatterns}
            onChange={(event) => setRecalculatePatterns(event.target.value)}
            placeholder={"/admin/*\n*.json"}
            className="min-h-64 font-mono text-sm"
            disabled={actionBusy}
          />
          <div className="text-xs text-muted-foreground">
            {
              recalculatePatterns
                .split(/\r?\n/)
                .map((value) => value.trim())
                .filter(Boolean).length
            }{" "}
            / 250 条
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRecalculateOpen(false)}
              disabled={actionBusy}
            >
              取消
            </Button>
            <Button
              onClick={() => void handleRecalculate()}
              disabled={actionBusy}
            >
              {actionBusy && <LoaderCircle className="animate-spin" />}
              重新计算
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newAuditOpen} onOpenChange={setNewAuditOpen}>
        <DialogContent className="block max-h-[90dvh] overflow-hidden rounded-md p-0 sm:max-w-4xl">
          <DialogTitle className="sr-only">新建网站审计</DialogTitle>
          <AuditSetup
            project={project}
            running={running}
            mode="new"
            contained
            onStart={onStart}
            onSuccess={() => setNewAuditOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="rounded-md">
          <DialogHeader>
            <DialogTitle>删除这次审计？</DialogTitle>
            <DialogDescription>
              页面、问题、链接、PageSpeed 和检查点数据都会被永久删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={actionBusy}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={actionBusy}
            >
              {actionBusy ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
