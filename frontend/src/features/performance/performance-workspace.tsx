import * as React from "react"
import {
  ArrowDownRight,
  ArrowUpRight,
  ExternalLink,
  FileSearch,
  LoaderCircle,
  RefreshCw,
  SearchX,
} from "lucide-react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import {
  getPerformanceArticle,
  getPerformanceArticles,
  getPerformanceOverview,
  resolvePerformanceSignal,
  syncPerformance,
  type PerformanceArticle,
  type PerformanceArticleCollection,
  type PerformanceArticleDetail,
  type PerformanceMetricChange,
  type PerformanceMetrics,
  type PerformanceOverview,
  type PerformanceRange,
  type PerformanceSort,
  type PerformanceStatus,
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
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const ranges: PerformanceRange[] = [7, 28, 90]
const chartConfig = {
  clicks: { label: "点击", color: "var(--chart-1)" },
  impressions: { label: "曝光", color: "var(--chart-2)" },
} satisfies ChartConfig

const statusLabels: Record<PerformanceStatus, string> = {
  waiting_data: "等待数据",
  insufficient_data: "数据不足",
  impressions: "已有曝光",
  clicks: "已有点击",
  growing: "增长",
  stable: "稳定",
  declining: "下降",
  observing_update: "优化后观察中",
}

const sortLabels: Record<PerformanceSort, string> = {
  clicks: "按点击排序",
  impressions: "按曝光排序",
  ctr: "按 CTR 排序",
  position: "按排名排序",
  change: "按点击变化排序",
  updated_at: "按最近更新排序",
  published_at: "按发布时间排序",
}

function formatCount(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(
    value
  )
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function formatPosition(value: number) {
  return value > 0 ? value.toFixed(1) : "-"
}

function formatDate(value: string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value))
}

function formatDateTime(value: string | null) {
  if (!value) return "尚未同步"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function StatusBadge({ status }: { status: PerformanceStatus }) {
  const variant =
    status === "declining"
      ? "destructive"
      : status === "growing" || status === "clicks"
        ? "default"
        : "secondary"
  return <Badge variant={variant}>{statusLabels[status]}</Badge>
}

function ChangeValue({
  value,
  inverse = false,
  position = false,
}: {
  value: number | null
  inverse?: boolean
  position?: boolean
}) {
  if (value === null) return <span className="text-muted-foreground">-</span>
  const positive = inverse ? value < 0 : value > 0
  const negative = inverse ? value > 0 : value < 0
  return (
    <span
      className={
        positive
          ? "text-emerald-600"
          : negative
            ? "text-destructive"
            : "text-muted-foreground"
      }
    >
      {value > 0 ? "+" : ""}
      {position ? `${value.toFixed(1)} 位` : `${(value * 100).toFixed(1)}%`}
    </span>
  )
}

function MetricChange({
  value,
  position,
}: {
  value: number | null
  position?: boolean
}) {
  if (value === null)
    return <span className="text-xs text-muted-foreground">无上期数据</span>
  const improving = position ? value < 0 : value > 0
  const Icon = improving ? ArrowUpRight : ArrowDownRight
  const display = position
    ? `${value > 0 ? "+" : ""}${value.toFixed(1)} 位`
    : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`
  return (
    <span
      className={`mt-1 flex items-center gap-1 text-xs ${
        improving
          ? "text-emerald-600"
          : value === 0
            ? "text-muted-foreground"
            : "text-destructive"
      }`}
    >
      <Icon className="size-3" />
      {display}
    </span>
  )
}

function MetricsGrid({
  metrics,
  change,
}: {
  metrics: PerformanceMetrics
  change: PerformanceMetricChange
}) {
  const values = [
    ["点击", formatCount(metrics.clicks), change.clicks, false],
    ["曝光", formatCount(metrics.impressions), change.impressions, false],
    ["CTR", formatPercent(metrics.ctr), change.ctr, false],
    ["平均排名", formatPosition(metrics.position), change.position, true],
  ] as const
  return (
    <div className="grid overflow-hidden rounded-md border sm:grid-cols-2 xl:grid-cols-4">
      {values.map(([label, value, delta, position], index) => (
        <div
          key={label}
          className={`min-w-0 p-4 ${index > 0 ? "border-t sm:border-t-0 sm:border-l" : ""} ${index === 2 ? "sm:border-l-0 xl:border-l" : ""}`}
        >
          <div className="text-sm text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">
            {value}
          </div>
          <MetricChange value={delta} position={position} />
        </div>
      ))}
    </div>
  )
}

function TrendChart({
  data,
  publications = [],
}: {
  data: PerformanceOverview["trend"]
  publications?: PerformanceArticleDetail["publications"]
}) {
  const labeledPublications = new Set(
    publications.slice(-3).map((event) => event.publication_id)
  )
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-72 w-full">
      <LineChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          minTickGap={28}
          tickFormatter={(value: string) => value.slice(5)}
        />
        <YAxis yAxisId="clicks" tickLine={false} axisLine={false} width={38} />
        <YAxis
          yAxisId="impressions"
          orientation="right"
          tickLine={false}
          axisLine={false}
          width={44}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_label, payload) =>
                payload[0]?.payload?.date
                  ? formatDate(String(payload[0].payload.date))
                  : ""
              }
            />
          }
        />
        {publications.map((event) => (
          <ReferenceLine
            key={event.publication_id}
            x={event.occurred_at.slice(0, 10)}
            stroke="var(--muted-foreground)"
            strokeDasharray="3 3"
            label={
              labeledPublications.has(event.publication_id)
                ? {
                    value: event.kind === "updated" ? "更新" : "发布",
                    position: "insideTopRight",
                    fontSize: 11,
                  }
                : undefined
            }
          />
        ))}
        <Line
          yAxisId="clicks"
          type="monotone"
          dataKey="clicks"
          stroke="var(--color-clicks)"
          strokeWidth={2}
          dot={false}
        />
        <Line
          yAxisId="impressions"
          type="monotone"
          dataKey="impressions"
          stroke="var(--color-impressions)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  )
}

function ArticleTable({
  items,
  loading,
  onSelect,
}: {
  items: PerformanceArticle[]
  loading: boolean
  onSelect: (articleId: string) => void
}) {
  if (items.length === 0) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center px-6 text-center">
        <SearchX className="size-7 text-muted-foreground" />
        <div className="mt-3 font-medium">暂无可监控文章</div>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          文章成功发布并获得真实发布 URL 后，会出现在这里。
        </p>
      </div>
    )
  }
  return (
    <div
      className={`relative overflow-x-auto transition-opacity ${loading ? "opacity-60" : ""}`}
      aria-busy={loading}
    >
      {loading && (
        <LoaderCircle
          className="absolute top-3 right-4 z-10 size-4 animate-spin text-muted-foreground"
          aria-label="正在更新文章列表"
        />
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-72">文章</TableHead>
            <TableHead className="min-w-36">目标关键词</TableHead>
            <TableHead className="min-w-28">发布 / 更新</TableHead>
            <TableHead className="text-right">点击</TableHead>
            <TableHead className="text-right">曝光</TableHead>
            <TableHead className="text-right">CTR</TableHead>
            <TableHead className="text-right">排名</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow
              key={item.article_id}
              className="cursor-pointer"
              tabIndex={0}
              onClick={() => onSelect(item.article_id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  onSelect(item.article_id)
                }
              }}
            >
              <TableCell>
                <div className="max-w-md truncate font-medium">
                  {item.title}
                </div>
                <div className="mt-1 max-w-md truncate text-xs text-muted-foreground">
                  {item.url}
                </div>
              </TableCell>
              <TableCell>{item.primary_keyword}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <div>{formatDate(item.published_at)}</div>
                {item.last_published_at !== item.published_at && (
                  <div className="mt-1">
                    更新 {formatDate(item.last_published_at)}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCount(item.metrics.clicks)}
                <div className="text-xs">
                  <ChangeValue value={item.change.clicks} />
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCount(item.metrics.impressions)}
                <div className="text-xs">
                  <ChangeValue value={item.change.impressions} />
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent(item.metrics.ctr)}
                <div className="text-xs">
                  <ChangeValue value={item.change.ctr} />
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPosition(item.metrics.position)}
                <div className="text-xs">
                  <ChangeValue value={item.change.position} inverse position />
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <StatusBadge status={item.status} />
                  {item.signal_count > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {item.signal_count} 个信号
                    </span>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ArticleHighlights({ overview }: { overview: PerformanceOverview }) {
  const statusItems = Object.entries(overview.status_counts).filter(
    ([, count]) => count > 0
  ) as Array<[PerformanceStatus, number]>
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-x-6 gap-y-3 border-y py-4">
        <div>
          <div className="text-xs text-muted-foreground">监控文章</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            {overview.article_count}
          </div>
        </div>
        {statusItems.map(([status, count]) => (
          <div key={status}>
            <div className="text-xs text-muted-foreground">
              {statusLabels[status]}
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">
              {count}
            </div>
          </div>
        ))}
      </div>
      {(overview.growing_articles.length > 0 ||
        overview.declining_articles.length > 0) && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-medium">近期增长</h3>
            <div className="divide-y border-y">
              {overview.growing_articles.map((item) => (
                <div
                  key={item.article_id}
                  className="flex items-center justify-between gap-4 py-2.5"
                >
                  <span className="truncate text-sm">{item.title}</span>
                  <ChangeValue value={item.change.clicks} />
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">需要关注</h3>
            <div className="divide-y border-y">
              {overview.declining_articles.map((item) => (
                <div
                  key={item.article_id}
                  className="flex items-center justify-between gap-4 py-2.5"
                >
                  <span className="truncate text-sm">{item.title}</span>
                  <ChangeValue value={item.change.clicks} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DetailSheet({
  detail,
  loading,
  error,
  signalError,
  resolvingSignalId,
  open,
  onOpenChange,
  onOpenArticle,
  onResolveSignal,
}: {
  detail: PerformanceArticleDetail | null
  loading: boolean
  error: string
  signalError: string
  resolvingSignalId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenArticle: (articleId: string) => void
  onResolveSignal: (signalId: string) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {loading ? (
          <div className="space-y-4 p-6">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : error ? (
          <div className="p-6 text-sm text-destructive">{error}</div>
        ) : detail ? (
          <>
            <SheetHeader className="border-b pr-14">
              <SheetTitle>{detail.article.title}</SheetTitle>
              <SheetDescription className="break-all">
                {detail.article.url}
              </SheetDescription>
              <p className="text-sm text-muted-foreground">
                目标关键词：{detail.article.primary_keyword}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusBadge status={detail.article.status} />
                <span className="text-xs text-muted-foreground">
                  数据截止 {formatDate(detail.data_through)}
                </span>
              </div>
            </SheetHeader>
            <div className="space-y-6 p-6">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                {[
                  ["点击", formatCount(detail.article.metrics.clicks)],
                  ["曝光", formatCount(detail.article.metrics.impressions)],
                  ["CTR", formatPercent(detail.article.metrics.ctr)],
                  ["平均排名", formatPosition(detail.article.metrics.position)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className="mt-1 text-lg font-semibold tabular-nums">
                      {value}
                    </div>
                  </div>
                ))}
              </div>

              <section>
                <h3 className="mb-3 font-medium">文章趋势</h3>
                {detail.trend.length ? (
                  <TrendChart
                    data={detail.trend}
                    publications={detail.publications}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    当前范围暂无趋势数据。
                  </p>
                )}
              </section>

              {detail.signals.length > 0 && (
                <section>
                  <h3 className="mb-3 font-medium">效果信号</h3>
                  {signalError && (
                    <p className="mb-2 text-sm text-destructive">{signalError}</p>
                  )}
                  <div className="divide-y rounded-md border">
                    {detail.signals.map((signal) => (
                      <div
                        key={signal.id}
                        className="flex items-start justify-between gap-4 p-3"
                      >
                        <p className="text-sm">{signal.message}</p>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={resolvingSignalId === signal.id}
                          onClick={() => onResolveSignal(signal.id)}
                        >
                          已查看
                        </Button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section>
                <h3 className="mb-3 font-medium">实际搜索查询</h3>
                {detail.query_status === "unavailable" ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-800">
                    查询数据暂时不可用，文章趋势和历史指标仍可查看。
                  </div>
                ) : detail.queries.length ? (
                  <div className="overflow-x-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>查询</TableHead>
                          <TableHead className="text-right">曝光</TableHead>
                          <TableHead className="text-right">点击</TableHead>
                          <TableHead className="text-right">CTR</TableHead>
                          <TableHead className="text-right">排名</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.queries.slice(0, 25).map((row) => (
                          <TableRow key={row.query}>
                            <TableCell className="max-w-64 whitespace-normal">
                              {row.query}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCount(row.impressions)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCount(row.clicks)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatPercent(row.ctr)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatPosition(row.position)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    当前范围暂无查询数据。
                  </p>
                )}
              </section>

              {detail.update_comparison && (
                <section>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">最近更新前后对比</h3>
                    <Badge variant="secondary">
                      {detail.update_comparison.observation_complete
                        ? "14 天观察完成"
                        : "观察中"}
                    </Badge>
                  </div>
                  <div className="grid overflow-hidden rounded-md border sm:grid-cols-2">
                    <div className="p-4">
                      <div className="text-xs text-muted-foreground">
                        更新前{" "}
                        {formatDate(detail.update_comparison.before_start)} 至{" "}
                        {formatDate(detail.update_comparison.before_end)}
                      </div>
                      <div className="mt-3 text-sm tabular-nums">
                        点击{" "}
                        {formatCount(
                          detail.update_comparison.before_metrics.clicks
                        )}{" "}
                        · 曝光{" "}
                        {formatCount(
                          detail.update_comparison.before_metrics.impressions
                        )}
                      </div>
                    </div>
                    <div className="border-t p-4 sm:border-t-0 sm:border-l">
                      <div className="text-xs text-muted-foreground">
                        更新后{" "}
                        {formatDate(detail.update_comparison.after_start)} 至{" "}
                        {formatDate(detail.update_comparison.after_end)}
                      </div>
                      <div className="mt-3 text-sm tabular-nums">
                        点击{" "}
                        {formatCount(
                          detail.update_comparison.after_metrics.clicks
                        )}{" "}
                        · 曝光{" "}
                        {formatCount(
                          detail.update_comparison.after_metrics.impressions
                        )}
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    仅展示更新前后窗口数据，不代表变化由本次更新直接造成。
                  </p>
                </section>
              )}

              <section>
                <h3 className="mb-3 font-medium">发布记录</h3>
                <div className="space-y-3 border-l pl-4">
                  {detail.publications.map((event) => (
                    <div key={event.publication_id} className="relative">
                      <span className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-primary" />
                      <div className="text-sm font-medium">
                        {event.kind === "updated" ? "文章更新" : "首次发布"}
                        {event.version_number
                          ? ` · 版本 ${event.version_number}`
                          : ""}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatDateTime(event.occurred_at)}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
            <SheetFooter className="border-t">
              <Button onClick={() => onOpenArticle(detail.article.article_id)}>
                <FileSearch />
                打开文章优化
              </Button>
              <Button
                variant="outline"
                nativeButton={false}
                render={
                  <a
                    href={detail.article.url}
                    target="_blank"
                    rel="noreferrer"
                  />
                }
              >
                <ExternalLink />
                查看线上文章
              </Button>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

export function PerformanceWorkspace({
  view,
  projectId,
  onOpenArticle,
}: {
  view: string
  projectId: string
  onOpenArticle: (articleId: string) => void
}) {
  const [days, setDays] = React.useState<PerformanceRange>(28)
  const [overview, setOverview] = React.useState<PerformanceOverview | null>(
    null
  )
  const [collection, setCollection] =
    React.useState<PerformanceArticleCollection>({
      items: [],
      total: 0,
      page: 1,
      page_size: 25,
    })
  const [page, setPage] = React.useState(1)
  const [statusFilter, setStatusFilter] = React.useState<
    PerformanceStatus | "all"
  >("all")
  const [sort, setSort] = React.useState<PerformanceSort>("clicks")
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [syncing, setSyncing] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<PerformanceArticleDetail | null>(
    null
  )
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [detailError, setDetailError] = React.useState("")
  const [signalError, setSignalError] = React.useState("")
  const [resolvingSignalId, setResolvingSignalId] = React.useState<
    string | null
  >(null)
  const loadRequestId = React.useRef(0)
  const loadedProjectId = React.useRef("")

  const load = React.useCallback(async () => {
    const requestId = ++loadRequestId.current
    if (!projectId) {
      loadedProjectId.current = ""
      setOverview(null)
      setCollection({ items: [], total: 0, page: 1, page_size: 25 })
      setLoading(false)
      return
    }
    if (loadedProjectId.current !== projectId) {
      loadedProjectId.current = projectId
      setOverview(null)
      setCollection({ items: [], total: 0, page: 1, page_size: 25 })
      setSelectedId(null)
    }
    setLoading(true)
    setError("")
    try {
      const [nextOverview, collection] = await Promise.all([
        getPerformanceOverview(projectId, days),
        getPerformanceArticles(projectId, days, {
          page,
          pageSize: 25,
          status: statusFilter,
          sort,
          order: sort === "position" ? "asc" : "desc",
        }),
      ])
      if (requestId !== loadRequestId.current) return
      setOverview(nextOverview)
      setCollection(collection)
    } catch (nextError) {
      if (requestId !== loadRequestId.current) return
      setError(errorMessage(nextError, "读取效果数据失败"))
    } finally {
      if (requestId === loadRequestId.current) setLoading(false)
    }
  }, [days, page, projectId, sort, statusFilter])

  React.useEffect(() => {
    void load()
  }, [load])

  React.useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    let active = true
    setDetailLoading(true)
    setDetail(null)
    setDetailError("")
    setSignalError("")
    void getPerformanceArticle(projectId, selectedId, days)
      .then((result) => {
        if (active) setDetail(result)
      })
      .catch((nextError) => {
        if (active) setDetailError(errorMessage(nextError, "读取文章效果失败"))
      })
      .finally(() => {
        if (active) setDetailLoading(false)
      })
    return () => {
      active = false
    }
  }, [days, projectId, selectedId])

  async function handleSync() {
    setSyncing(true)
    setError("")
    try {
      await syncPerformance(projectId)
      await load()
    } catch (nextError) {
      setError(errorMessage(nextError, "同步 Search Console 失败"))
    } finally {
      setSyncing(false)
    }
  }

  async function handleResolveSignal(signalId: string) {
    if (!selectedId) return
    setSignalError("")
    setResolvingSignalId(signalId)
    try {
      await resolvePerformanceSignal(projectId, signalId)
      setDetail((current) =>
        current
          ? {
              ...current,
              signals: current.signals.filter((item) => item.id !== signalId),
            }
          : current
      )
      void load()
    } catch {
      setSignalError("处理效果信号失败")
    } finally {
      setResolvingSignalId(null)
    }
  }

  if (loading && !overview) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    )
  }

  if (error && !overview) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center text-center">
        <SearchX className="size-8 text-muted-foreground" />
        <p className="mt-3 text-sm text-destructive">{error}</p>
        <Button className="mt-4" variant="outline" onClick={() => void load()}>
          <RefreshCw />
          重新读取
        </Button>
      </div>
    )
  }

  if (!overview) return null

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Google Search Console</span>
            {overview.site_url && (
              <span className="break-all">· {overview.site_url}</span>
            )}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            数据截止 {formatDate(overview.sync.data_through)} · 最近同步{" "}
            {formatDateTime(overview.sync.synced_at)} · GSC 数据通常延迟 2 至 3 天
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5">
            {ranges.map((range) => (
              <Button
                key={range}
                size="sm"
                variant={days === range ? "secondary" : "ghost"}
                className="rounded-sm"
                onClick={() => {
                  setDays(range)
                  setPage(1)
                }}
              >
                {range} 天
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            disabled={
              syncing ||
              overview.sync.status === "running" ||
              !overview.gsc_connected
            }
            onClick={() => void handleSync()}
          >
            <RefreshCw
              className={
                syncing || overview.sync.status === "running" ? "animate-spin" : ""
              }
            />
            {syncing || overview.sync.status === "running" ? "同步中" : "同步数据"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}。已有历史数据仍保留。
        </div>
      )}

      {overview.sync.status === "failed" && overview.sync.data_through && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-800">
          最近一次同步失败，当前展示上次成功同步的数据。
        </div>
      )}

      {!overview.gsc_connected ? (
        <div className="flex min-h-72 flex-col items-center justify-center rounded-md border px-6 text-center">
          <SearchX className="size-8 text-muted-foreground" />
          <h2 className="mt-3 font-medium">尚未连接 Search Console</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            连接与当前项目域名匹配的 GSC Property 后，才能同步真实搜索效果。
          </p>
          <Button
            className="mt-4"
            variant="outline"
            nativeButton={false}
            render={<a href={`/projects/${projectId}/settings/connections`} />}
          >
            前往服务连接
          </Button>
        </div>
      ) : overview.sync.status === "running" && !overview.sync.data_through ? (
        <div className="flex min-h-72 flex-col items-center justify-center rounded-md border px-6 text-center">
          <LoaderCircle className="size-8 animate-spin text-muted-foreground" />
          <h2 className="mt-3 font-medium">正在同步效果数据</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            首次同步正在回填历史数据，完成后会展示文章趋势和实际搜索查询。
          </p>
        </div>
      ) : overview.sync.status === "never" ||
        (overview.sync.status === "failed" && !overview.sync.data_through) ? (
        <div className="flex min-h-72 flex-col items-center justify-center rounded-md border px-6 text-center">
          <RefreshCw className="size-8 text-muted-foreground" />
          <h2 className="mt-3 font-medium">
            {overview.sync.status === "failed"
              ? "效果数据同步失败"
              : "尚未同步效果数据"}
          </h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {overview.sync.status === "failed"
              ? "尚无可展示的历史数据，请重试同步。"
              : "首次同步会回填用于 7、28 和 90 天周期比较的数据。"}
          </p>
          <Button
            className="mt-4"
            disabled={syncing}
            onClick={() => void handleSync()}
          >
            {syncing && <LoaderCircle className="animate-spin" />}
            {overview.sync.status === "failed" ? "重新同步" : "开始同步"}
          </Button>
        </div>
      ) : (
        <>
          {view === "overview" && (
            <>
              <MetricsGrid
                metrics={overview.metrics}
                change={overview.change}
              />
              <Card>
                <CardHeader>
                  <CardTitle>搜索趋势</CardTitle>
                  <CardDescription>
                    当前周期 {formatDate(overview.range_start)} 至{" "}
                    {formatDate(overview.range_end)}，与上一周期比较
                  </CardDescription>
                  <CardAction className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <span className="size-2 rounded-full bg-(--chart-1)" />
                      点击
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="size-2 rounded-full bg-(--chart-2)" />
                      曝光
                    </span>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <TrendChart data={overview.trend} />
                </CardContent>
              </Card>
              <ArticleHighlights overview={overview} />
            </>
          )}

          <Card>
            <CardHeader>
              <CardTitle>
                {view === "articles" ? "全部文章效果" : "平台文章效果"}
              </CardTitle>
              <CardDescription>
                共监控 {overview.article_count}{" "}
                篇已发布文章，点击行查看实际查询和发布记录
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              {view === "articles" && (
                <div className="flex flex-col gap-2 border-y px-6 py-3 sm:flex-row sm:items-center">
                  <Select
                    value={statusFilter}
                    onValueChange={(value) => {
                      setStatusFilter(value as PerformanceStatus | "all")
                      setPage(1)
                    }}
                  >
                    <SelectTrigger
                      className="w-full sm:w-44"
                      aria-label="文章状态"
                    >
                      <SelectValue>
                        {statusFilter === "all"
                          ? "全部状态"
                          : statusLabels[statusFilter]}
                      </SelectValue>
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
                  <Select
                    value={sort}
                    onValueChange={(value) => {
                      setSort(value as PerformanceSort)
                      setPage(1)
                    }}
                  >
                    <SelectTrigger
                      className="w-full sm:w-44"
                      aria-label="文章排序"
                    >
                      <SelectValue>{sortLabels[sort]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="clicks">按点击排序</SelectItem>
                      <SelectItem value="impressions">按曝光排序</SelectItem>
                      <SelectItem value="ctr">按 CTR 排序</SelectItem>
                      <SelectItem value="position">按排名排序</SelectItem>
                      <SelectItem value="change">按点击变化排序</SelectItem>
                      <SelectItem value="updated_at">按最近更新排序</SelectItem>
                      <SelectItem value="published_at">
                        按发布时间排序
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <ArticleTable
                items={collection.items}
                loading={loading}
                onSelect={setSelectedId}
              />
              {view === "articles" && collection.total > 0 && (
                <div className="flex items-center justify-between border-t px-6 py-3 text-sm">
                  <span className="text-muted-foreground">
                    第 {collection.page} 页，共 {collection.total} 篇
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={page <= 1 || loading}
                      onClick={() => setPage((value) => Math.max(1, value - 1))}
                    >
                      上一页
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        page * collection.page_size >= collection.total ||
                        loading
                      }
                      onClick={() => setPage((value) => value + 1)}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <DetailSheet
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        signalError={signalError}
        resolvingSignalId={resolvingSignalId}
        onOpenArticle={onOpenArticle}
        onResolveSignal={(signalId) => void handleResolveSignal(signalId)}
      />
    </div>
  )
}
