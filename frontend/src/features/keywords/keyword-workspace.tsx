import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  History,
  Info,
  LoaderCircle,
  Plus,
  Radar,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Tag,
  Trash2,
  X,
} from "lucide-react"

import {
  assignKeywordTags,
  getCompetitorAnalysisStatus,
  getKeywordStatus,
  listCompetitorAnalysisRuns,
  listKeywordCompetitorOpportunities,
  listKeywordCompetitors,
  listKeywords,
  retryKeywordBuild,
  startCompetitorAnalysis,
  updateCompetitorOpportunities,
  updateKeywordStatus,
  type KeywordBuildRun,
  type CompetitorAnalysisRun,
  type CompetitorLocalMarket,
  type CompetitorOpportunityQuery,
  type CompetitorOpportunityStatus,
  type KeywordCompetitor,
  type KeywordCompetitorOpportunity,
  type KeywordLibraryStatus,
  type KeywordListItem,
  type KeywordListQuery,
  type KeywordListResult,
  type KeywordStatus,
} from "@/api/keywords"
import { getGSCConnection } from "@/api/settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  DEFAULT_KEYWORD_LIBRARY_QUERY,
  keywordQueryKeys,
} from "@/features/keywords/keyword-query-client"
import { GSCPerformancePanel } from "@/features/keywords/gsc-performance-panel"
import { KeywordQueryProvider } from "@/features/keywords/keyword-query-provider"

const PAGE_SIZE = 50
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting"])
const READABLE_RUN_STATUSES = new Set(["completed", "partial"])

type KeywordWorkspaceProps = {
  projectId: string
  view?: string
}

type Filters = {
  intent: string
  source: string
  keywordStatus: KeywordStatus
  minVolume: string
  maxDifficulty: string
  sort: NonNullable<KeywordListQuery["sort"]>
}

const DEFAULT_FILTERS: Filters = {
  intent: "all",
  source: "all",
  keywordStatus: "active",
  minVolume: "",
  maxDifficulty: "",
  sort: "search_volume",
}

export function KeywordWorkspace({
  projectId,
  view = "library",
}: KeywordWorkspaceProps) {
  return (
    <KeywordQueryProvider>
      <KeywordWorkspaceContent projectId={projectId} view={view} />
    </KeywordQueryProvider>
  )
}

function KeywordWorkspaceContent({
  projectId,
  view = "library",
}: KeywordWorkspaceProps) {
  if (view === "search-performance") {
    return (
      <GSCGuard projectId={projectId} returnView="search-performance">
        <GSCPerformancePanel projectId={projectId} />
      </GSCGuard>
    )
  }
  if (view === "competitor-gap") {
    return (
      <GSCGuard projectId={projectId} returnView="competitor-gap">
        <CompetitorOpportunityPanel
          projectId={projectId}
          onLibraryChanged={() => undefined}
        />
      </GSCGuard>
    )
  }
  return <KeywordLibraryWorkspace projectId={projectId} />
}

function KeywordLibraryWorkspace({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const statusQueryKey = React.useMemo(
    () => keywordQueryKeys.libraryStatus(projectId),
    [projectId]
  )
  const [status, setStatus] = React.useState<KeywordLibraryStatus | null>(
    () => queryClient.getQueryData<KeywordLibraryStatus>(statusQueryKey) ?? null
  )
  const [statusError, setStatusError] = React.useState("")
  const [statusLoading, setStatusLoading] = React.useState(() => !status)
  const [statusRefreshKey, setStatusRefreshKey] = React.useState(0)
  const [result, setResult] = React.useState<KeywordListResult | null>(
    () =>
      queryClient.getQueryData<KeywordListResult>(
        keywordQueryKeys.libraryList(projectId, DEFAULT_KEYWORD_LIBRARY_QUERY)
      ) ?? null
  )
  const [listError, setListError] = React.useState("")
  const [listLoading, setListLoading] = React.useState(false)
  const [listRefreshKey, setListRefreshKey] = React.useState(0)
  const [searchInput, setSearchInput] = React.useState("")
  const [search, setSearch] = React.useState("")
  const [filters, setFilters] = React.useState<Filters>(DEFAULT_FILTERS)
  const [page, setPage] = React.useState(1)
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [tagName, setTagName] = React.useState("")
  const [showAdvancedFilters, setShowAdvancedFilters] = React.useState(false)
  const [detailItem, setDetailItem] = React.useState<KeywordListItem | null>(
    null
  )
  const [actionPending, setActionPending] = React.useState("")
  const [actionError, setActionError] = React.useState("")
  const [actionSuccess, setActionSuccess] = React.useState("")
  const [exporting, setExporting] = React.useState(false)

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  React.useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let requestInFlight = false

    function clearPollTimer() {
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }
    }

    function schedulePoll(delay: number) {
      clearPollTimer()
      if (document.visibilityState === "visible") {
        timer = window.setTimeout(() => readStatus(true), delay)
      }
    }

    async function readStatus(force = false) {
      if (requestInFlight) return
      requestInFlight = true
      try {
        const cached =
          queryClient.getQueryData<KeywordLibraryStatus>(statusQueryKey)
        const next = await queryClient.fetchQuery({
          queryKey: statusQueryKey,
          queryFn: () => getKeywordStatus(projectId),
          staleTime:
            force ||
            statusRefreshKey > 0 ||
            (cached?.run && ACTIVE_RUN_STATUSES.has(cached.run.status))
              ? 0
              : 5 * 60 * 1000,
        })
        if (cancelled) return
        setStatus(next)
        setStatusError("")
        setStatusLoading(false)
        const pollDelay = statusPollDelay(next)
        if (pollDelay !== null) {
          schedulePoll(pollDelay)
        }
      } catch (error) {
        if (cancelled) return
        setStatusError(errorMessage(error, "读取关键词任务状态失败"))
        setStatusLoading(false)
        schedulePoll(3000)
      } finally {
        requestInFlight = false
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        clearPollTimer()
        return
      }
      void readStatus(true)
    }

    void readStatus()
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      cancelled = true
      clearPollTimer()
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [projectId, queryClient, statusQueryKey, statusRefreshKey])

  const run = status?.run ?? null
  const runIsActive = Boolean(run && ACTIVE_RUN_STATUSES.has(run.status))
  const runIsReadable = Boolean(run && READABLE_RUN_STATUSES.has(run.status))
  const expectedVersion = runIsReadable
    ? Math.max(status?.resultVersion ?? 0, run?.resultVersion ?? 0)
    : (status?.resultVersion ?? 0)
  const shouldReadList = Boolean(
    status &&
    (status.totalKeywords > 0 || runIsReadable || (result && result.total > 0))
  )

  const listQuery = React.useMemo<KeywordListQuery>(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      search: search || undefined,
      intent: filters.intent === "all" ? undefined : filters.intent,
      source: filters.source === "all" ? undefined : filters.source,
      status: filters.keywordStatus,
      minVolume: optionalNonNegativeNumber(filters.minVolume),
      maxDifficulty: optionalBoundedNumber(filters.maxDifficulty, 100),
      sort: filters.sort,
      order: filters.sort === "keyword" ? "asc" : "desc",
    }),
    [filters, page, search]
  )

  React.useEffect(() => {
    if (!shouldReadList) return
    let cancelled = false
    let retryTimer: number | undefined
    let versionRetryCount = 0
    let requestRetryCount = 0

    async function readList() {
      const queryKey = keywordQueryKeys.libraryList(projectId, listQuery)
      const cached = queryClient.getQueryData<KeywordListResult>(queryKey)
      if (cached) {
        setResult(cached)
        setListLoading(false)
      } else {
        setListLoading(true)
      }
      try {
        const next = await queryClient.fetchQuery({
          queryKey,
          queryFn: () => listKeywords(projectId, listQuery),
          staleTime: listRefreshKey > 0 ? 0 : 5 * 60 * 1000,
        })
        if (cancelled) return
        if (next.resultVersion < expectedVersion) {
          versionRetryCount += 1
          if (versionRetryCount > 6) {
            setListError("关键词数据版本尚未同步")
            return
          }
          retryTimer = window.setTimeout(
            readList,
            Math.min(500 * 2 ** (versionRetryCount - 1), 5000)
          )
          return
        }
        versionRetryCount = 0
        requestRetryCount = 0
        setResult(next)
        setListError("")
        setSelectedIds(new Set())
        if (next.page > 1 && next.items.length === 0 && next.total > 0) {
          setPage(Math.max(1, Math.ceil(next.total / PAGE_SIZE)))
        }
      } catch (error) {
        if (cancelled) return
        requestRetryCount += 1
        if (requestRetryCount > 5) {
          setListError(errorMessage(error, "读取关键词数据失败"))
          return
        }
        retryTimer = window.setTimeout(
          readList,
          Math.min(1000 * 2 ** (requestRetryCount - 1), 10000)
        )
      } finally {
        if (!cancelled) setListLoading(false)
      }
    }

    void readList()
    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [
    expectedVersion,
    listQuery,
    listRefreshKey,
    projectId,
    queryClient,
    shouldReadList,
  ])

  function refreshStatus() {
    void queryClient.invalidateQueries({ queryKey: statusQueryKey })
    setStatusRefreshKey((value) => value + 1)
  }

  function refreshList() {
    void queryClient.invalidateQueries({
      queryKey: ["keywords", projectId, "library-list"],
    })
    setListRefreshKey((value) => value + 1)
  }

  const dataReady = Boolean(
    result && result.resultVersion >= expectedVersion && !listError
  )
  const initialBuildActive = runIsActive && (status?.totalKeywords ?? 0) === 0
  const initialBuildBlocked =
    run?.status === "blocked" && (status?.totalKeywords ?? 0) === 0
  const initialBuildFailed =
    run?.status === "failed" && (status?.totalKeywords ?? 0) === 0

  async function handleBatchStatus(nextStatus: KeywordStatus) {
    if (selectedIds.size === 0) return
    setActionPending("status")
    setActionError("")
    setActionSuccess("")
    try {
      await updateKeywordStatus(projectId, [...selectedIds], nextStatus)
      refreshList()
      refreshStatus()
    } catch (error) {
      setActionError(errorMessage(error, "批量更新关键词失败"))
    } finally {
      setActionPending("")
    }
  }

  async function handleRetryBuild() {
    setActionPending("retry")
    setActionError("")
    try {
      const nextRun = await retryKeywordBuild(projectId)
      setStatus((current) =>
        current
          ? {
              ...current,
              run: nextRun,
            }
          : current
      )
      refreshStatus()
    } catch (error) {
      setActionError(errorMessage(error, "重新创建关键词库失败"))
    } finally {
      setActionPending("")
    }
  }

  async function handleAssignTag() {
    const name = tagName.trim()
    if (!name || selectedIds.size === 0) return
    setActionPending("tag")
    setActionError("")
    setActionSuccess("")
    try {
      await assignKeywordTags(projectId, [...selectedIds], [name])
      setTagName("")
      refreshList()
    } catch (error) {
      setActionError(errorMessage(error, "添加标签失败"))
    } finally {
      setActionPending("")
    }
  }

  async function handleExport(selectedOnly = false) {
    setExporting(true)
    setActionError("")
    setActionSuccess("")
    try {
      if (selectedOnly) {
        const selectedRows = (result?.items ?? []).filter((item) =>
          selectedIds.has(item.id)
        )
        downloadCsv(selectedRows)
        setActionSuccess(`已导出 ${selectedRows.length} 个关键词`)
        return
      }
      const rows: KeywordListItem[] = []
      let exportPage = 1
      while (true) {
        const batch = await listKeywords(projectId, {
          ...listQuery,
          page: exportPage,
          pageSize: 100,
        })
        rows.push(...batch.items)
        if (rows.length >= batch.total || batch.items.length === 0) break
        exportPage += 1
      }
      downloadCsv(rows)
      setActionSuccess(`已导出 ${rows.length} 个关键词`)
    } catch (error) {
      setActionError(errorMessage(error, "导出关键词失败"))
    } finally {
      setExporting(false)
    }
  }

  async function handleCopySelected() {
    const keywords = (result?.items ?? [])
      .filter((item) => selectedIds.has(item.id))
      .map((item) => item.keyword)
    if (!keywords.length) return
    setActionError("")
    setActionSuccess("")
    try {
      await copyText(keywords.join("\n"))
      setActionSuccess(`已复制 ${keywords.length} 个关键词`)
    } catch (error) {
      setActionError(errorMessage(error, "复制关键词失败"))
    }
  }

  if (statusLoading && !status) {
    return <KeywordLoadingState message="正在读取关键词库" />
  }

  if (statusError && !status) {
    return (
      <KeywordErrorState
        title="暂时无法读取关键词库"
        message={statusError}
        onRetry={() => {
          setStatusLoading(true)
          refreshStatus()
        }}
      />
    )
  }

  if (initialBuildActive) {
    return <KeywordBuildState run={run} />
  }

  if (initialBuildBlocked) {
    return <KeywordBlockedState run={run} />
  }

  if (initialBuildFailed) {
    return (
      <div>
        <KeywordErrorState
          title="暂时无法生成关键词库"
          message={run?.message || "任务状态异常，系统已保留处理记录。"}
          onRetry={() => void handleRetryBuild()}
          actionLabel="重新创建"
          pending={actionPending === "retry"}
        />
        {actionError && (
          <p className="px-4 text-center text-sm text-destructive">
            {actionError}
          </p>
        )}
      </div>
    )
  }

  if (runIsReadable && !dataReady) {
    if (listError) {
      return (
        <KeywordErrorState
          title="关键词数据尚未同步"
          message={listError}
          onRetry={() => {
            setListError("")
            refreshList()
          }}
        />
      )
    }
    return <KeywordLoadingState message="任务已完成，正在读取关键词数据" />
  }

  if (runIsReadable && dataReady && (result?.total ?? 0) === 0) {
    return (
      <div className="space-y-4">
        <KeywordSummary status={status} dataReady={dataReady} />
        <KeywordEmptyState message={run?.message || "暂未发现可用关键词"} />
      </div>
    )
  }

  if (!status?.run && !result) {
    return (
      <KeywordErrorState
        title="关键词库尚未开始创建"
        message="项目没有对应的关键词任务，请刷新后重试。"
        onRetry={refreshStatus}
      />
    )
  }

  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / PAGE_SIZE))
  const allPageSelected = Boolean(
    result?.items.length &&
    result.items.every((item) => selectedIds.has(item.id))
  )
  const activeFilterCount = countActiveFilters(filters)
  const hasActiveFilters = Boolean(search || activeFilterCount)

  return (
    <div className="space-y-4">
      <KeywordSummary status={status} dataReady={dataReady} />

      {runIsActive && (
        <div className="border-y bg-muted/35 px-4 py-3">
          <div className="flex items-center gap-3">
            <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="truncate font-medium">
                  {stageLabel(run?.stage)}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {run?.progress ?? 0}%
                </span>
              </div>
              <Progress value={run?.progress ?? 0} className="mt-2 h-1.5" />
            </div>
          </div>
        </div>
      )}

      {(status?.pendingMetricsCount ?? 0) > 0 && (
        <div
          role="status"
          className="flex items-center gap-3 border-y border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/35 dark:text-sky-200"
        >
          <LoaderCircle className="size-4 shrink-0 animate-spin" />
          <span>部分关键词指标正在更新，当前数据可以正常使用。</span>
        </div>
      )}

      {actionError && (
        <div className="border-y border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      )}
      {actionSuccess && (
        <div className="flex items-center justify-between border-y border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
          <span>{actionSuccess}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭提示"
            onClick={() => setActionSuccess("")}
          >
            <X />
          </Button>
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b p-4 xl:flex-row xl:items-center">
          <div className="relative min-w-56 flex-1">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="搜索关键词"
              className="w-full pl-9 xl:max-w-sm"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <KeywordFilter
              value={filters.intent}
              onChange={(value) => {
                setFilters((current) => ({ ...current, intent: value }))
                setPage(1)
              }}
              label="全部意图"
              options={[
                ["all", "全部意图"],
                ["informational", "信息"],
                ["commercial", "商业"],
                ["transactional", "交易"],
                ["navigational", "导航"],
              ]}
            />
            <KeywordFilter
              value={filters.source}
              onChange={(value) => {
                setFilters((current) => ({ ...current, source: value }))
                setPage(1)
              }}
              label="全部来源"
              options={[
                ["all", "全部来源"],
                ["labs_site", "网站发现"],
                ["google_ads_site", "Google Ads"],
                ["keyword_ideas", "关键词拓展"],
                ["keyword_ideas_broad", "广泛拓展"],
                ["keyword_ideas_close", "相近拓展"],
              ]}
            />
            <KeywordFilter
              value={filters.keywordStatus}
              onChange={(value) => {
                setFilters((current) => ({
                  ...current,
                  keywordStatus: value as KeywordStatus,
                }))
                setPage(1)
              }}
              label="在库关键词"
              options={[
                ["active", "在库关键词"],
                ["archived", "已归档"],
              ]}
            />
            <KeywordFilter
              value={filters.sort}
              onChange={(value) => {
                setFilters((current) => ({
                  ...current,
                  sort: value as Filters["sort"],
                }))
                setPage(1)
              }}
              label="搜索量排序"
              options={[
                ["search_volume", "搜索量排序"],
                ["difficulty", "难度排序"],
                ["keyword", "关键词排序"],
                ["updated_at", "更新时间排序"],
              ]}
            />
            <Button
              variant={showAdvancedFilters ? "secondary" : "outline"}
              size="sm"
              onClick={() => setShowAdvancedFilters((value) => !value)}
            >
              <SlidersHorizontal />
              筛选
              {activeFilterCount > 0 && (
                <Badge className="h-5 min-w-5 px-1.5 tabular-nums">
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleExport(false)}
              disabled={exporting || !result?.total}
            >
              {exporting ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Download />
              )}
              导出
            </Button>
          </div>
        </div>

        {showAdvancedFilters && (
          <div className="grid gap-3 border-b bg-muted/20 px-4 py-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              最低月搜索量
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                value={filters.minVolume}
                onChange={(event) => {
                  setFilters((current) => ({
                    ...current,
                    minVolume: event.target.value,
                  }))
                  setPage(1)
                }}
                placeholder="不限"
                className="h-9 bg-background text-sm text-foreground"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted-foreground">
              最高关键词难度
              <Input
                type="number"
                min={0}
                max={100}
                inputMode="numeric"
                value={filters.maxDifficulty}
                onChange={(event) => {
                  setFilters((current) => ({
                    ...current,
                    maxDifficulty: event.target.value,
                  }))
                  setPage(1)
                }}
                placeholder="不限（0-100）"
                className="h-9 bg-background text-sm text-foreground"
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              disabled={activeFilterCount === 0}
              onClick={() => {
                setFilters(DEFAULT_FILTERS)
                setSearchInput("")
                setSearch("")
                setPage(1)
              }}
            >
              <RotateCcw />
              重置筛选
            </Button>
          </div>
        )}

        {selectedIds.size > 0 && (
          <div className="flex flex-col gap-3 border-b bg-muted/35 px-4 py-3 sm:flex-row sm:items-center">
            <span className="shrink-0 text-sm font-medium">
              已选择 {selectedIds.size} 个
            </span>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Input
                value={tagName}
                onChange={(event) => setTagName(event.target.value)}
                placeholder="输入标签名"
                className="h-8 max-w-48"
                maxLength={80}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleAssignTag}
                disabled={!tagName.trim() || actionPending === "tag"}
              >
                {actionPending === "tag" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Tag />
                )}
                加标签
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleCopySelected()}
            >
              <Copy />
              复制
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleExport(true)}
              disabled={exporting}
            >
              {exporting ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Download />
              )}
              导出所选
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                handleBatchStatus(
                  filters.keywordStatus === "active" ? "archived" : "active"
                )
              }
              disabled={actionPending === "status"}
            >
              {actionPending === "status" ? (
                <LoaderCircle className="animate-spin" />
              ) : filters.keywordStatus === "active" ? (
                <Archive />
              ) : (
                <RotateCcw />
              )}
              {filters.keywordStatus === "active" ? "归档" : "恢复"}
            </Button>
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="选择当前页"
                  checked={allPageSelected}
                  onCheckedChange={(checked) => {
                    setSelectedIds((current) => {
                      const next = new Set(current)
                      for (const item of result?.items ?? []) {
                        if (checked) next.add(item.id)
                        else next.delete(item.id)
                      }
                      return next
                    })
                  }}
                />
              </TableHead>
              <TableHead className="w-[30%] min-w-60">关键词</TableHead>
              <TableHead className="w-24">意图</TableHead>
              <ExplainedTableHead
                align="right"
                className="w-28"
                label="月搜索量"
                explanation="目标国家和语言下的月均搜索次数。"
              />
              <TableHead className="w-24">趋势</TableHead>
              <ExplainedTableHead
                align="right"
                className="w-20"
                label="难度"
                explanation="自然搜索进入 Google 前十名的预估难度，0-100，越高越难。"
              />
              <ExplainedTableHead
                align="right"
                className="w-20"
                label="CPC"
                explanation="Google Ads 预估单次点击费用，用于辅助判断商业价值。"
              />
              <TableHead className="w-36">来源</TableHead>
              <TableHead className="w-[18%] min-w-32">标签</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {listLoading && !result ? (
              <TableRow>
                <TableCell colSpan={9} className="h-40 text-center">
                  <LoaderCircle className="mx-auto size-5 animate-spin text-primary" />
                  <span className="mt-2 block text-sm text-muted-foreground">
                    正在读取关键词
                  </span>
                </TableCell>
              </TableRow>
            ) : result?.items.length ? (
              result.items.map((item) => (
                <KeywordRow
                  key={item.id}
                  item={item}
                  selected={selectedIds.has(item.id)}
                  onSelectedChange={(selected) => {
                    setSelectedIds((current) => {
                      const next = new Set(current)
                      if (selected) next.add(item.id)
                      else next.delete(item.id)
                      return next
                    })
                  }}
                  onOpenDetails={() => setDetailItem(item)}
                />
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={9} className="h-40 text-center">
                  <span className="text-sm text-muted-foreground">
                    {hasActiveFilters
                      ? "没有符合当前条件的关键词"
                      : "关键词库中还没有数据"}
                  </span>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="text-muted-foreground">
            共 {formatNumber(result?.total ?? 0)} 个关键词
            {listLoading && result ? "，正在更新" : ""}
          </span>
          <div className="flex items-center gap-2">
            <span className="min-w-20 text-center tabular-nums">
              {page} / {pageCount}
            </span>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label="上一页"
                      disabled={page <= 1 || listLoading}
                      onClick={() => setPage((value) => Math.max(1, value - 1))}
                    />
                  }
                >
                  <ChevronLeft />
                </TooltipTrigger>
                <TooltipContent>上一页</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label="下一页"
                      disabled={page >= pageCount || listLoading}
                      onClick={() =>
                        setPage((value) => Math.min(pageCount, value + 1))
                      }
                    />
                  }
                >
                  <ChevronRight />
                </TooltipTrigger>
                <TooltipContent>下一页</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </Card>

      <KeywordDetailsSheet
        item={detailItem}
        onOpenChange={(open) => {
          if (!open) setDetailItem(null)
        }}
      />
    </div>
  )
}

function gscSettingsHref(projectId: string, returnView: string) {
  const returnTo = `/projects/${projectId}/keywords/${returnView}`
  return `/projects/${encodeURIComponent(projectId)}/settings/data-sources?returnTo=${encodeURIComponent(returnTo)}#google-search-console`
}

function GSCGuard({
  projectId,
  returnView,
  children,
}: {
  projectId: string
  returnView: "search-performance" | "competitor-gap"
  children: React.ReactNode
}) {
  const connectionQuery = useQuery({
    queryKey: keywordQueryKeys.connection(projectId),
    queryFn: () => getGSCConnection(projectId),
    staleTime: 5 * 60 * 1000,
  })
  const connection = connectionQuery.data
  const ready = Boolean(
    connection?.propertyConnected && !connection.requiresReconnect
  )
  const error = connectionQuery.error
    ? errorMessage(connectionQuery.error, "读取 Search Console 连接失败")
    : ""

  if (connectionQuery.isPending) {
    return <KeywordLoadingState message="正在检查 Search Console 连接" />
  }
  if (!ready) {
    return (
      <div className="max-w-2xl border-l-2 border-amber-500 py-1 pl-4">
        <h2 className="text-base font-semibold">连接 Google Search Console</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {returnView === "search-performance"
            ? "连接与当前项目域名匹配的网站后，才能查看真实的搜索点击、曝光和排名数据。"
            : "连接与当前项目域名匹配的网站后，才能用真实业务查询发现搜索竞品并分析机会缺口。"}
        </p>
        {error ? (
          <p className="mt-2 text-sm text-destructive">{error}</p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            nativeButton={false}
            render={<a href={gscSettingsHref(projectId, returnView)} />}
          >
            <ExternalLink />
            前往连接
          </Button>
          {error ? (
            <Button
              variant="outline"
              onClick={() => {
                void connectionQuery.refetch()
              }}
              disabled={connectionQuery.isFetching}
            >
              <RefreshCw
                className={connectionQuery.isFetching ? "animate-spin" : ""}
              />
              重试
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  return children
}

type OpportunityResult = Awaited<
  ReturnType<typeof listKeywordCompetitorOpportunities>
>

function CompetitorOpportunityPanel({
  projectId,
  onLibraryChanged,
}: {
  projectId: string
  onLibraryChanged: () => void
}) {
  const queryClient = useQueryClient()
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [page, setPage] = React.useState(1)
  const [searchInput, setSearchInput] = React.useState("")
  const [search, setSearch] = React.useState("")
  const [competitorDomain, setCompetitorDomain] = React.useState("all")
  const [intent, setIntent] = React.useState("all")
  const [opportunityStatus, setOpportunityStatus] = React.useState<
    CompetitorOpportunityStatus | "all"
  >("new")
  const [libraryFilter, setLibraryFilter] = React.useState<
    "all" | "in" | "out"
  >("all")
  const [minVolume, setMinVolume] = React.useState("")
  const [maxDifficulty, setMaxDifficulty] = React.useState("")
  const [sort, setSort] =
    React.useState<NonNullable<CompetitorOpportunityQuery["sort"]>>(
      "opportunity_score"
    )
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [starting, setStarting] = React.useState(false)
  const [manualOpen, setManualOpen] = React.useState(false)
  const [manualDomains, setManualDomains] = React.useState([""])
  const [autoOpen, setAutoOpen] = React.useState(false)
  const [autoScope, setAutoScope] = React.useState<"national" | "local">(
    "national"
  )
  const [localLatitude, setLocalLatitude] = React.useState("")
  const [localLongitude, setLocalLongitude] = React.useState("")
  const [localRadius, setLocalRadius] = React.useState("10")
  const [localZoom, setLocalZoom] = React.useState("12")
  const [localSearchType, setLocalSearchType] = React.useState<
    "maps" | "local_finder"
  >("maps")
  const [localDevice, setLocalDevice] = React.useState<"desktop" | "mobile">(
    "desktop"
  )
  const [localDepth, setLocalDepth] = React.useState("20")
  const [localBusinessQuery, setLocalBusinessQuery] = React.useState("")
  const [localCategories, setLocalCategories] = React.useState("")
  const [localIncludeQuestions, setLocalIncludeQuestions] =
    React.useState(false)
  const [localQuestionsKeyword, setLocalQuestionsKeyword] = React.useState("")
  const [localQuestionsDepth, setLocalQuestionsDepth] = React.useState("20")
  const [actionPending, setActionPending] = React.useState("")
  const [error, setError] = React.useState("")
  const [message, setMessage] = React.useState("")
  const selectionScopeRef = React.useRef("")

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  const opportunityQuery = React.useMemo<CompetitorOpportunityQuery>(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      search,
      competitorDomain:
        competitorDomain === "all" ? undefined : competitorDomain,
      intent: intent === "all" ? undefined : intent,
      status: opportunityStatus,
      inLibrary: libraryFilter === "all" ? undefined : libraryFilter === "in",
      minVolume: optionalNonNegativeNumber(minVolume),
      maxDifficulty: optionalBoundedNumber(maxDifficulty, 100),
      sort,
      order: sort === "keyword" || sort === "best_rank" ? "asc" : "desc",
    }),
    [
      competitorDomain,
      intent,
      libraryFilter,
      maxDifficulty,
      minVolume,
      opportunityStatus,
      page,
      search,
      sort,
    ]
  )
  const statusQuery = useQuery({
    queryKey: keywordQueryKeys.competitorStatus(projectId),
    queryFn: () => getCompetitorAnalysisStatus(projectId),
    staleTime: 30 * 1000,
    refetchInterval: (query) => {
      const current = query.state.data
      return current && ["queued", "running"].includes(current.status)
        ? 3000
        : false
    },
  })
  const run = statusQuery.data ?? null
  const runId = run?.runId ?? null
  const competitorsQuery = useQuery({
    queryKey: keywordQueryKeys.competitors(projectId, runId),
    queryFn: () => listKeywordCompetitors(projectId),
    enabled: !statusQuery.isPending,
    staleTime: 30 * 60 * 1000,
  })
  const opportunitiesQuery = useQuery<OpportunityResult>({
    queryKey: keywordQueryKeys.opportunities(
      projectId,
      runId,
      opportunityQuery
    ),
    queryFn: () =>
      listKeywordCompetitorOpportunities(projectId, opportunityQuery),
    enabled: !statusQuery.isPending,
    staleTime: 5 * 60 * 1000,
    placeholderData: (previous) => previous,
  })
  const historyQuery = useQuery({
    queryKey: keywordQueryKeys.competitorHistory(projectId),
    queryFn: () => listCompetitorAnalysisRuns(projectId),
    enabled: historyOpen,
    staleTime: 30 * 60 * 1000,
  })
  const competitors = competitorsQuery.data?.items ?? []
  const result = opportunitiesQuery.data ?? null
  const history = historyQuery.data ?? []
  const loading =
    statusQuery.isFetching ||
    competitorsQuery.isFetching ||
    opportunitiesQuery.isFetching
  const loadError =
    statusQuery.error || competitorsQuery.error || opportunitiesQuery.error
  const displayError =
    error || (loadError ? errorMessage(loadError, "读取竞争机会缺口失败") : "")
  const displayMessage =
    message === "竞争分析已进入队列" &&
    run &&
    !["queued", "running"].includes(run.status)
      ? ""
      : message

  React.useEffect(() => {
    if (!result) return
    const selectionScope = JSON.stringify([
      competitorDomain,
      intent,
      libraryFilter,
      maxDifficulty,
      minVolume,
      opportunityStatus,
      page,
      projectId,
      search,
      sort,
    ])
    const visibleIds = new Set(result.items.map((item) => item.id))
    const scopeChanged = selectionScopeRef.current !== selectionScope
    selectionScopeRef.current = selectionScope
    setSelectedIds((current) =>
      scopeChanged
        ? new Set()
        : new Set([...current].filter((id) => visibleIds.has(id)))
    )
  }, [
    competitorDomain,
    intent,
    libraryFilter,
    maxDifficulty,
    minVolume,
    opportunityStatus,
    page,
    projectId,
    result,
    search,
    sort,
  ])

  function refreshCompetitorData() {
    void queryClient.invalidateQueries({
      queryKey: ["keywords", projectId, "competitor-status"],
    })
    void queryClient.invalidateQueries({
      queryKey: ["keywords", projectId, "competitors"],
    })
    void queryClient.invalidateQueries({
      queryKey: ["keywords", projectId, "opportunities"],
    })
    if (historyOpen) {
      void queryClient.invalidateQueries({
        queryKey: keywordQueryKeys.competitorHistory(projectId),
      })
    }
  }

  async function handleStart(input: {
    mode: "manual" | "auto"
    competitorDomains?: string[]
    localMarket?: CompetitorLocalMarket
  }) {
    setStarting(true)
    setError("")
    setMessage("")
    try {
      const nextRun = await startCompetitorAnalysis(projectId, input)
      queryClient.setQueryData(
        keywordQueryKeys.competitorStatus(projectId),
        nextRun
      )
      setMessage("竞争分析已进入队列")
      if (input.mode === "manual") {
        setManualOpen(false)
        setManualDomains([""])
      }
      if (input.mode === "auto") setAutoOpen(false)
      refreshCompetitorData()
    } catch (requestError) {
      setError(errorMessage(requestError, "启动竞争分析失败"))
    } finally {
      setStarting(false)
    }
  }

  function handleManualStart() {
    const domains = manualDomains.map((value) => value.trim()).filter(Boolean)
    if (!domains.length) {
      setError("请至少输入一个竞争对手域名")
      return
    }
    void handleStart({ mode: "manual", competitorDomains: domains })
  }

  function handleAutoStart() {
    if (autoScope === "national") {
      void handleStart({ mode: "auto" })
      return
    }
    const latitude = Number(localLatitude)
    const longitude = Number(localLongitude)
    const radiusKm = Number(localRadius)
    const zoom = Number(localZoom)
    const depth = Number(localDepth)
    const questionsDepth = Number(localQuestionsDepth)
    const categories = localCategories
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 10)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      setError("纬度必须在 -90 到 90 之间")
      return
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      setError("经度必须在 -180 到 180 之间")
      return
    }
    if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 100000) {
      setError("搜索半径必须在 1 到 100000 公里之间")
      return
    }
    if (!Number.isInteger(zoom) || zoom < 4 || zoom > 18) {
      setError("地图缩放必须在 4 到 18 之间")
      return
    }
    if (!Number.isInteger(depth) || depth < 1 || depth > 100) {
      setError("抓取深度必须在 1 到 100 之间")
      return
    }
    if (
      localIncludeQuestions &&
      (!Number.isInteger(questionsDepth) ||
        questionsDepth < 1 ||
        questionsDepth > 100)
    ) {
      setError("商家问答深度必须在 1 到 100 之间")
      return
    }
    if (categories.some((category) => category.length > 120)) {
      setError("每个商家分类不能超过 120 个字符")
      return
    }
    void handleStart({
      mode: "auto",
      localMarket: {
        latitude,
        longitude,
        radiusKm,
        zoom,
        searchType: localSearchType,
        device: localDevice,
        depth,
        businessQuery: localBusinessQuery.trim() || undefined,
        categories,
        includeQuestions: localIncludeQuestions,
        questionsKeyword: localQuestionsKeyword.trim() || undefined,
        questionsDepth,
      },
    })
  }

  async function handleBatch(action: "accept" | "dismiss" | "restore") {
    if (!selectedIds.size) return
    setActionPending(action)
    setError("")
    setMessage("")
    try {
      const response = await updateCompetitorOpportunities(
        projectId,
        [...selectedIds],
        action
      )
      setMessage(
        action === "accept"
          ? `已处理 ${response.updated} 个机会，新增 ${response.addedToLibrary} 个关键词`
          : `已更新 ${response.updated} 个机会`
      )
      if (action === "accept") onLibraryChanged()
      setSelectedIds(new Set())
      void queryClient.invalidateQueries({
        queryKey: ["keywords", projectId, "opportunities"],
      })
      if (action === "accept") {
        void queryClient.invalidateQueries({
          queryKey: ["keywords", projectId, "library-list"],
        })
        void queryClient.invalidateQueries({
          queryKey: keywordQueryKeys.libraryStatus(projectId),
        })
      }
    } catch (requestError) {
      setError(errorMessage(requestError, "更新机会缺口失败"))
    } finally {
      setActionPending("")
    }
  }

  const items = result?.items ?? []
  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / PAGE_SIZE))
  const allPageSelected = Boolean(
    items.length && items.every((item) => selectedIds.has(item.id))
  )
  const selectedItems = items.filter((item) => selectedIds.has(item.id))
  const canAccept = selectedItems.length === selectedIds.size
  const canDismiss =
    selectedItems.length === selectedIds.size &&
    selectedItems.every((item) => item.status === "new")
  const canRestore =
    selectedItems.length === selectedIds.size &&
    selectedItems.every((item) => item.status === "dismissed")
  const active = Boolean(run && ["queued", "running"].includes(run.status))

  return (
    <Card id="competitor-gap" className="scroll-mt-4 overflow-hidden">
      <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">竞争对手机会缺口</h2>
            {run ? <AnalysisStatusBadge status={run.status} /> : null}
            {run ? (
              <span className="text-xs text-muted-foreground">
                {run.mode === "manual" ? "手动" : "自动"}
              </span>
            ) : null}
            {result?.analyzedAt ? (
              <span className="text-xs text-muted-foreground">
                {formatDateTime(result.analyzedAt)}
              </span>
            ) : null}
          </div>
          {run ? (
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{run.message}</span>
              <span>
                {run.completedCompetitors}/{run.discoveredCount} 个竞品
              </span>
              <span>{formatNumber(run.uniqueKeywordCount)} 个去重机会</span>
              <span>${run.totalCostUsd.toFixed(4)}</span>
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="分析历史"
                    onClick={() => setHistoryOpen((value) => !value)}
                  />
                }
              >
                <History />
              </TooltipTrigger>
              <TooltipContent>分析历史</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="刷新竞争分析"
                    disabled={loading}
                    onClick={refreshCompetitorData}
                  />
                }
              >
                <RefreshCw className={loading ? "animate-spin" : ""} />
              </TooltipTrigger>
              <TooltipContent>刷新</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Button
            variant="outline"
            size="sm"
            disabled={active || starting}
            onClick={() => {
              setError("")
              setManualOpen(true)
            }}
          >
            <Plus />
            手动添加
          </Button>
          <Button
            size="sm"
            disabled={active || starting}
            onClick={() => {
              setError("")
              setAutoOpen(true)
            }}
          >
            {starting || active ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Radar />
            )}
            自动发现
          </Button>
        </div>
      </div>

      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent showCloseButton={!starting}>
          <DialogHeader>
            <DialogTitle>手动添加竞争对手</DialogTitle>
            <DialogDescription>竞争对手域名</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {manualDomains.map((domain, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={domain}
                  placeholder="competitor.com"
                  aria-label={`竞争对手域名 ${index + 1}`}
                  disabled={starting}
                  onChange={(event) => {
                    const value = event.target.value
                    setManualDomains((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? value : item
                      )
                    )
                    setError("")
                  }}
                />
                {manualDomains.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`删除竞争对手 ${index + 1}`}
                    disabled={starting}
                    onClick={() =>
                      setManualDomains((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            ))}
            {manualDomains.length < 5 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={starting}
                onClick={() => setManualDomains((current) => [...current, ""])}
              >
                <Plus />
                添加域名
              </Button>
            ) : null}
          </div>
          {displayError ? (
            <p className="text-sm text-destructive">{displayError}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={starting}
              onClick={() => setManualOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={starting}
              onClick={handleManualStart}
            >
              {starting ? <LoaderCircle className="animate-spin" /> : null}
              开始分析
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={autoOpen} onOpenChange={setAutoOpen}>
        <DialogContent
          showCloseButton={!starting}
          className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        >
          <DialogHeader>
            <DialogTitle>自动发现竞争对手</DialogTitle>
            <DialogDescription>搜索市场</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-1 rounded-md border p-1">
            <Button
              type="button"
              size="sm"
              variant={autoScope === "national" ? "secondary" : "ghost"}
              onClick={() => setAutoScope("national")}
            >
              全国搜索
            </Button>
            <Button
              type="button"
              size="sm"
              variant={autoScope === "local" ? "secondary" : "ghost"}
              onClick={() => setAutoScope("local")}
            >
              本地搜索
            </Button>
          </div>
          {autoScope === "local" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <LocalMarketField
                label="纬度"
                value={localLatitude}
                min={-90}
                max={90}
                step="any"
                onChange={setLocalLatitude}
              />
              <LocalMarketField
                label="经度"
                value={localLongitude}
                min={-180}
                max={180}
                step="any"
                onChange={setLocalLongitude}
              />
              <LocalMarketField
                label="半径（公里）"
                value={localRadius}
                min={1}
                max={100000}
                step="any"
                onChange={setLocalRadius}
              />
              <LocalMarketField
                label="地图缩放"
                value={localZoom}
                min={4}
                max={18}
                onChange={setLocalZoom}
              />
              <label className="space-y-1 text-xs font-medium">
                <span>搜索类型</span>
                <Select
                  value={localSearchType}
                  onValueChange={(value) =>
                    setLocalSearchType(value as "maps" | "local_finder")
                  }
                >
                  <SelectTrigger className="w-full" aria-label="搜索类型">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="maps">Google Maps</SelectItem>
                    <SelectItem value="local_finder">Local Finder</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1 text-xs font-medium">
                <span>设备</span>
                <Select
                  value={localDevice}
                  onValueChange={(value) =>
                    setLocalDevice(value as "desktop" | "mobile")
                  }
                >
                  <SelectTrigger className="w-full" aria-label="设备">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="desktop">桌面</SelectItem>
                    <SelectItem value="mobile">移动</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <LocalMarketField
                label="抓取深度"
                value={localDepth}
                min={1}
                max={100}
                onChange={setLocalDepth}
              />
              <label className="space-y-1 text-xs font-medium">
                <span>商家名称筛选</span>
                <Input
                  value={localBusinessQuery}
                  maxLength={200}
                  onChange={(event) =>
                    setLocalBusinessQuery(event.target.value)
                  }
                />
              </label>
              <label className="space-y-1 text-xs font-medium sm:col-span-2">
                <span>商家分类</span>
                <Input
                  value={localCategories}
                  placeholder="pizza_restaurant, coffee_shop"
                  onChange={(event) => setLocalCategories(event.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 text-xs font-medium sm:col-span-2">
                <Checkbox
                  checked={localIncludeQuestions}
                  onCheckedChange={(checked) =>
                    setLocalIncludeQuestions(checked === true)
                  }
                />
                获取 Google 商家问答证据
              </label>
              {localIncludeQuestions ? (
                <>
                  <label className="space-y-1 text-xs font-medium">
                    <span>商家问答关键词</span>
                    <Input
                      value={localQuestionsKeyword}
                      maxLength={200}
                      placeholder={localBusinessQuery || "默认使用商家名称筛选"}
                      onChange={(event) =>
                        setLocalQuestionsKeyword(event.target.value)
                      }
                    />
                  </label>
                  <LocalMarketField
                    label="商家问答深度"
                    value={localQuestionsDepth}
                    min={1}
                    max={100}
                    onChange={setLocalQuestionsDepth}
                  />
                </>
              ) : null}
            </div>
          ) : null}
          {displayError ? (
            <p className="text-sm text-destructive">{displayError}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={starting}
              onClick={() => setAutoOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={starting} onClick={handleAutoStart}>
              {starting ? <LoaderCircle className="animate-spin" /> : <Radar />}
              开始发现
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {active && run ? (
        <div className="border-b px-4 py-3">
          <Progress value={run.progress} />
        </div>
      ) : null}

      {run?.mode === "auto" &&
      run.landscapeSummary &&
      Object.keys(run.landscapeSummary).length ? (
        <CompetitiveLandscapeSummary run={run} />
      ) : null}

      {historyOpen ? (
        <div className="grid gap-px border-b bg-border sm:grid-cols-2 lg:grid-cols-4">
          {history.slice(0, 8).map((item) => (
            <div key={item.runId} className="bg-background px-4 py-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <AnalysisStatusBadge status={item.status} />
                  <span className="text-muted-foreground">
                    {item.mode === "manual" ? "手动" : "自动"}
                  </span>
                </div>
                <span className="text-muted-foreground">
                  {formatDateTime(item.createdAt)}
                </span>
              </div>
              <div className="mt-2 tabular-nums">
                {item.completedCompetitors}/
                {item.analyzedCompetitorCount ?? item.discoveredCount} 已分析 ·{" "}
                {formatNumber(item.uniqueKeywordCount)} 机会 · $
                {item.totalCostUsd.toFixed(4)}
              </div>
            </div>
          ))}
          {historyQuery.isPending ? (
            <div className="bg-background px-4 py-3 text-xs text-muted-foreground">
              正在读取分析记录
            </div>
          ) : !history.length ? (
            <div className="bg-background px-4 py-3 text-xs text-muted-foreground">
              暂无分析记录
            </div>
          ) : null}
        </div>
      ) : null}

      {competitors.length ? (
        <div className="flex gap-2 overflow-x-auto border-b px-4 py-3">
          {competitors.map((competitor) => (
            <button
              key={competitor.id}
              type="button"
              className={`w-56 shrink-0 rounded-md border px-3 py-2 text-left text-xs ${
                competitorDomain === competitor.domain
                  ? "border-primary bg-primary/5"
                  : competitor.selectedForGap !== false
                    ? "bg-background hover:bg-muted/50"
                    : "cursor-default bg-muted/25"
              }`}
              disabled={competitor.selectedForGap === false}
              onClick={() => {
                setCompetitorDomain((value) =>
                  value === competitor.domain ? "all" : competitor.domain
                )
                setPage(1)
              }}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">
                  {competitor.domain}
                </span>
                <Badge variant="outline">
                  {competitorGapStatusLabel(competitor)}
                </Badge>
              </span>
              {run?.mode === "auto" ? (
                <span className="mt-2 block space-y-2">
                  <span className="flex flex-wrap gap-1">
                    <Badge variant="secondary">
                      {competitorDomainTypeLabel(competitor.domainType)}
                    </Badge>
                    {competitor.isSeoCompetitor ? (
                      <Badge variant="outline">SEO 竞品</Badge>
                    ) : null}
                    {competitor.isBusinessCompetitor ? (
                      <Badge variant="outline">业务竞品</Badge>
                    ) : null}
                    <Badge variant="outline">
                      {competitorSiteStatusLabel(competitor.siteCheckStatus)}
                    </Badge>
                  </span>
                  {competitorRedirectDescription(competitor) ? (
                    <span className="block break-all text-muted-foreground">
                      {competitorRedirectDescription(competitor)}
                    </span>
                  ) : null}
                  {competitorSiteReason(competitor) ? (
                    <span className="line-clamp-3 block leading-5 text-muted-foreground">
                      {competitorSiteReason(competitor)}
                    </span>
                  ) : null}
                  {competitor.whyTheyMatter ? (
                    <span className="line-clamp-3 block leading-5 text-foreground">
                      {competitor.whyTheyMatter}
                    </span>
                  ) : null}
                  <span className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
                    <span>覆盖词 {competitor.keywordsCount ?? "-"}</span>
                    <span>
                      ETV{" "}
                      {competitor.etv == null
                        ? "-"
                        : formatNumber(competitor.etv)}
                    </span>
                    <span>
                      平均排名{" "}
                      {competitor.avgPosition == null
                        ? "-"
                        : competitor.avgPosition.toFixed(1)}
                    </span>
                    <span>
                      中位排名{" "}
                      {competitor.medianPosition == null
                        ? "-"
                        : competitor.medianPosition.toFixed(1)}
                    </span>
                    <span>
                      可见度{" "}
                      {competitor.visibility == null
                        ? "-"
                        : competitor.visibility.toFixed(2)}
                    </span>
                    <span>SERP 项 {competitor.relevantSerpItems ?? "-"}</span>
                    <span>
                      排名词证据{" "}
                      {competitor.rankedKeywordsChecked
                        ? competitor.rankedKeywordsEvidenceCount || "无数据"
                        : "未验证"}
                    </span>
                    <span>
                      自然词{" "}
                      {recordMetric(
                        competitor.domainOverview,
                        "organic_keywords"
                      )}
                    </span>
                    <span>
                      自然流量{" "}
                      {recordMetric(
                        competitor.domainOverview,
                        "organic_traffic"
                      )}
                    </span>
                  </span>
                </span>
              ) : (
                <span className="mt-1 block text-muted-foreground">
                  {competitor.keywordCount} 机会 · $
                  {competitor.costUsd.toFixed(4)}
                  {competitor.status === "failed" ? " · 失败" : ""}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 border-b px-4 py-3 xl:flex-row xl:items-center">
        <div className="relative min-w-52 flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索机会关键词"
            className="pl-9"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:flex">
          <KeywordFilter
            label="意图"
            value={intent}
            onChange={(value) => {
              setIntent(value)
              setPage(1)
            }}
            options={[
              ["all", "全部意图"],
              ["informational", "信息型"],
              ["commercial", "商业型"],
              ["transactional", "交易型"],
              ["navigational", "导航型"],
            ]}
          />
          <KeywordFilter
            label="机会状态"
            value={opportunityStatus}
            onChange={(value) => {
              setOpportunityStatus(value as CompetitorOpportunityStatus | "all")
              setPage(1)
            }}
            options={[
              ["new", "待处理"],
              ["accepted", "已接收"],
              ["dismissed", "已忽略"],
              ["all", "全部状态"],
            ]}
          />
          <KeywordFilter
            label="词库状态"
            value={libraryFilter}
            onChange={(value) => {
              setLibraryFilter(value as "all" | "in" | "out")
              setPage(1)
            }}
            options={[
              ["all", "全部词库状态"],
              ["out", "未加入词库"],
              ["in", "已在词库"],
            ]}
          />
          <KeywordFilter
            label="排序"
            value={sort}
            onChange={(value) => {
              setSort(value as NonNullable<CompetitorOpportunityQuery["sort"]>)
              setPage(1)
            }}
            options={[
              ["opportunity_score", "机会分"],
              ["search_volume", "搜索量"],
              ["difficulty", "难度"],
              ["best_rank", "最佳排名"],
              ["competitor_count", "竞品数"],
              ["keyword", "关键词"],
            ]}
          />
          <Input
            type="number"
            min={0}
            value={minVolume}
            onChange={(event) => {
              setMinVolume(event.target.value)
              setPage(1)
            }}
            placeholder="最低搜索量"
            aria-label="最低搜索量"
            className="h-8 w-full xl:w-32"
          />
          <Input
            type="number"
            min={0}
            max={100}
            value={maxDifficulty}
            onChange={(event) => {
              setMaxDifficulty(event.target.value)
              setPage(1)
            }}
            placeholder="最高难度"
            aria-label="最高难度"
            className="h-8 w-full xl:w-28"
          />
        </div>
      </div>

      {selectedIds.size ? (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/25 px-4 py-2">
          <span className="mr-2 text-sm text-muted-foreground">
            已选择 {selectedIds.size} 项
          </span>
          {canAccept ? (
            <Button
              size="sm"
              disabled={Boolean(actionPending)}
              onClick={() => void handleBatch("accept")}
            >
              {actionPending === "accept" ? (
                <LoaderCircle className="animate-spin" />
              ) : null}
              接收并加入词库
            </Button>
          ) : null}
          {canDismiss ? (
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(actionPending)}
              onClick={() => void handleBatch("dismiss")}
            >
              忽略
            </Button>
          ) : null}
          {canRestore ? (
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(actionPending)}
              onClick={() => void handleBatch("restore")}
            >
              <RotateCcw />
              恢复
            </Button>
          ) : null}
        </div>
      ) : null}

      {displayError || displayMessage ? (
        <div
          className={`border-b px-4 py-2 text-sm ${displayError ? "text-destructive" : "text-foreground"}`}
          role="status"
        >
          {displayError || displayMessage}
        </div>
      ) : null}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                aria-label="选择本页机会"
                checked={allPageSelected}
                onCheckedChange={(checked) => {
                  setSelectedIds(
                    checked ? new Set(items.map((item) => item.id)) : new Set()
                  )
                }}
              />
            </TableHead>
            <TableHead className="min-w-56">关键词</TableHead>
            <TableHead className="text-right">机会分</TableHead>
            <TableHead className="min-w-48">竞品排名</TableHead>
            <TableHead className="text-right">搜索量</TableHead>
            <TableHead className="text-right">难度</TableHead>
            <TableHead>意图</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && !result ? (
            <TableRow>
              <TableCell colSpan={8} className="h-32 text-center">
                <LoaderCircle className="mx-auto size-5 animate-spin text-primary" />
              </TableCell>
            </TableRow>
          ) : items.length ? (
            items.map((item) => (
              <OpportunityRow
                key={item.id}
                item={item}
                selected={selectedIds.has(item.id)}
                onSelectedChange={(selected) => {
                  setSelectedIds((current) => {
                    const next = new Set(current)
                    if (selected) next.add(item.id)
                    else next.delete(item.id)
                    return next
                  })
                }}
              />
            ))
          ) : (
            <TableRow>
              <TableCell
                colSpan={8}
                className="h-32 text-center text-sm text-muted-foreground"
              >
                {run ? "当前条件下没有机会关键词" : "尚未运行竞争分析"}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
        <span className="text-muted-foreground">
          共 {formatNumber(result?.total ?? 0)} 个机会
          {loading && result ? "，正在更新" : ""}
        </span>
        <div className="flex items-center gap-2">
          <span className="min-w-20 text-center tabular-nums">
            {page} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="上一页机会"
            disabled={page <= 1 || loading}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="下一页机会"
            disabled={page >= pageCount || loading}
            onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </Card>
  )
}

function OpportunityRow({
  item,
  selected,
  onSelectedChange,
}: {
  item: KeywordCompetitorOpportunity
  selected: boolean
  onSelectedChange: (selected: boolean) => void
}) {
  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell>
        <Checkbox
          aria-label={`选择 ${item.keyword}`}
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(Boolean(checked))}
        />
      </TableCell>
      <TableCell className="max-w-72 font-medium whitespace-normal">
        {item.keyword}
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">
        {item.opportunityScore?.toFixed(1) ?? "-"}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {item.rankings.slice(0, 3).map((ranking) => (
            <span
              key={ranking.competitorId}
              className="inline-flex max-w-44 items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
            >
              <span className="truncate">{ranking.domain}</span>
              <span className="tabular-nums">#{ranking.rank ?? "-"}</span>
              {ranking.url ? (
                <a
                  href={ranking.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`打开 ${ranking.domain} 排名页面`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
            </span>
          ))}
          {item.competitorCount > 3 ? (
            <span className="text-xs text-muted-foreground">
              +{item.competitorCount - 3}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {nullableNumber(item.searchVolume)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {nullableNumber(item.keywordDifficulty)}
      </TableCell>
      <TableCell>{item.intent ? intentLabel(item.intent) : "-"}</TableCell>
      <TableCell>
        <Badge variant={item.inLibrary ? "secondary" : "outline"}>
          {item.inLibrary
            ? "已在词库"
            : item.status === "dismissed"
              ? "已忽略"
              : item.status === "accepted"
                ? "已接收"
                : "待处理"}
        </Badge>
      </TableCell>
    </TableRow>
  )
}

function AnalysisStatusBadge({
  status,
}: {
  status: CompetitorAnalysisRun["status"]
}) {
  const labels: Record<CompetitorAnalysisRun["status"], string> = {
    queued: "排队中",
    running: "分析中",
    partial: "部分完成",
    completed: "已完成",
    failed: "失败",
  }
  return (
    <Badge variant={status === "failed" ? "destructive" : "outline"}>
      {labels[status]}
    </Badge>
  )
}

function KeywordSummary({
  status,
  dataReady,
}: {
  status: KeywordLibraryStatus | null
  dataReady: boolean
}) {
  const run = status?.run
  const completed = Boolean(
    dataReady &&
    ((run && READABLE_RUN_STATUSES.has(run.status)) ||
      (status?.totalKeywords ?? 0) > 0)
  )
  return (
    <div className="grid gap-px overflow-hidden rounded-md border bg-border md:grid-cols-[1fr_1fr_auto]">
      <div className="bg-background p-4">
        <div className="text-xs text-muted-foreground">关键词总数</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">
          {formatNumber(status?.totalKeywords ?? 0)}
        </div>
      </div>
      <div className="bg-background p-4">
        <div className="text-xs text-muted-foreground">在库关键词</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">
          {formatNumber(status?.activeKeywords ?? 0)}
        </div>
      </div>
      <div className="flex min-w-48 items-center justify-between gap-3 bg-background p-4 md:justify-end">
        <div className="text-sm">
          <span
            className={
              completed
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-muted-foreground"
            }
          >
            {completed ? "已完成" : runStatusLabel(run)}
          </span>
        </div>
      </div>
    </div>
  )
}

function KeywordBuildState({
  run,
  recovering = false,
}: {
  run: KeywordBuildRun | null
  recovering?: boolean
}) {
  const elapsed = useElapsedSeconds(run)
  const isRecovering =
    recovering ||
    run?.status === "waiting" ||
    run?.stage === "waiting_for_recovery"
  return (
    <div className="mx-auto flex min-h-80 max-w-xl items-center px-4">
      <div className="w-full">
        <div className="flex items-start gap-3">
          <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="font-medium">
              {isRecovering ? "后台自动恢复中" : "正在为当前网站创建关键词库"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {isRecovering ? "已保存当前进度，服务恢复后会自动继续" : "处理中"}
            </p>
            <Progress value={run?.progress ?? 0} className="mt-5 h-1.5" />
            <div className="mt-2 flex justify-between text-xs text-muted-foreground">
              <span>
                {isRecovering
                  ? "无需重新创建关键词库"
                  : run?.message || "正在准备关键词库"}
              </span>
              <span className="tabular-nums">{formatDuration(elapsed)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function KeywordBlockedState({ run }: { run: KeywordBuildRun | null }) {
  const delayed = Boolean(run?.nextRetryAt)
  return (
    <div className="mx-auto flex min-h-80 max-w-xl items-center px-4">
      <div className="flex w-full items-start gap-3">
        <Clock3 className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">
            {delayed
              ? "关键词任务已进入后台队列"
              : "关键词任务正在等待外部条件"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {run?.message || "当前进度已经保存，条件恢复后会自动继续。"}
          </p>
          <div className="mt-4 border-t pt-3 text-xs text-muted-foreground">
            {delayed ? "系统将按计划自动检查" : "当前任务不会重复提交付费请求"}
          </div>
        </div>
      </div>
    </div>
  )
}

function KeywordEmptyState({ message }: { message: string }) {
  return (
    <div className="flex min-h-64 items-center justify-center border-y px-4">
      <div className="text-center">
        <Search className="mx-auto size-5 text-muted-foreground" />
        <h2 className="mt-3 font-medium">暂未发现可用关键词</h2>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  )
}

function KeywordLoadingState({
  message,
  retrying = false,
}: {
  message: string
  retrying?: boolean
}) {
  return (
    <div className="flex min-h-72 items-center justify-center">
      <div className="text-center">
        <LoaderCircle className="mx-auto size-5 animate-spin text-primary" />
        <p className="mt-3 text-sm font-medium">{message}</p>
        {retrying && (
          <p className="mt-1 text-xs text-muted-foreground">正在自动重试</p>
        )}
      </div>
    </div>
  )
}

const competitorDomainTypeLabels: Record<
  KeywordCompetitor["domainType"],
  string
> = {
  direct_product_competitor: "直接产品竞品",
  publisher_media: "媒体/出版商",
  marketplace_directory: "市场/目录",
  community_forum: "社区/论坛",
  documentation_resource: "文档/资源",
}

function competitorDomainTypeLabel(value: KeywordCompetitor["domainType"]) {
  return competitorDomainTypeLabels[value]
}

function competitorGapStatusLabel(competitor: KeywordCompetitor) {
  if (!competitor.selectedForGap || competitor.status === "excluded") {
    return "未付费分析"
  }
  const labels: Record<KeywordCompetitor["status"], string> = {
    pending: "等待分析",
    running: "分析中",
    completed: "已分析",
    failed: "分析失败",
    excluded: "未付费分析",
  }
  return labels[competitor.status]
}

const competitorSiteStatusLabels: Record<
  KeywordCompetitor["siteCheckStatus"],
  string
> = {
  not_checked: "未验证",
  verified: "网站已验证",
  redirected_related: "相关跳转",
  redirected_unrelated: "无关跳转",
  unverified_redirect: "跳转待确认",
  blocked: "访问被拦截",
  temporarily_unavailable: "暂时无法访问",
  permanently_unavailable: "网站不可用",
  non_html: "非网页结果",
  unsafe_target: "地址不安全",
  redirect_loop: "循环跳转",
  platform_or_login: "平台或登录页",
}

function competitorSiteStatusLabel(
  value: KeywordCompetitor["siteCheckStatus"]
) {
  return competitorSiteStatusLabels[value]
}

function LocalMarketField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: string
  min: number
  max: number
  step?: string
  onChange: (value: string) => void
}) {
  return (
    <label className="space-y-1 text-xs font-medium">
      <span>{label}</span>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

function verificationText(competitor: KeywordCompetitor, key: string): string {
  const value = competitor.siteVerification[key]
  return typeof value === "string" ? value : ""
}

function competitorRedirectDescription(competitor: KeywordCompetitor) {
  const original = verificationText(competitor, "original_domain")
  const finalDomain = verificationText(competitor, "final_domain")
  if (
    !original ||
    !finalDomain ||
    original.toLowerCase() === finalDomain.toLowerCase()
  ) {
    return ""
  }
  return `${original} 跳转到 ${finalDomain}`
}

function competitorSiteReason(competitor: KeywordCompetitor) {
  const reason = verificationText(competitor, "site_reason")
  if (reason) return reason
  if (competitor.selectedForGap) return ""
  const error = verificationText(competitor, "error")
  return error || "该候选未通过网站与业务相关性验证，不会执行付费差距分析。"
}

function recordMetric(value: Record<string, unknown> | undefined, key: string) {
  const metric = value?.[key]
  if (typeof metric === "number") return formatNumber(metric)
  return value?.has_data === false ? "无数据" : "-"
}

function summaryText(value: unknown) {
  return typeof value === "string" ? value : ""
}

function summaryStrings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function evidenceText(value: Record<string, unknown>, key: string) {
  const item = value[key]
  return typeof item === "string" ? item : ""
}

function evidenceNumber(value: Record<string, unknown>, key: string) {
  const item = value[key]
  return typeof item === "number" && Number.isFinite(item) ? item : null
}

function evidenceMonthlySearches(
  value: Record<string, unknown>
): KeywordListItem["monthlySearches"] {
  const items = value.monthly_searches
  if (!Array.isArray(items)) return []
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const row = item as Record<string, unknown>
    return [
      {
        year: typeof row.year === "number" ? row.year : null,
        month:
          typeof row.month === "number" || typeof row.month === "string"
            ? row.month
            : null,
        search_volume:
          typeof row.search_volume === "number" ? row.search_volume : null,
      },
    ]
  })
}

function CompetitiveQuerySet({ run }: { run: CompetitorAnalysisRun }) {
  const rows = run.gscQueryEvidence.length
    ? run.gscQueryEvidence.filter((row) => evidenceText(row, "query"))
    : run.discoveryKeywords.map((query) => ({ query }))
  if (!rows.length) return null

  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground">查询集</div>
      <div className="mt-2 overflow-x-auto border-y">
        <table className="w-full min-w-[1040px] text-left text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">业务查询</th>
              <th className="px-3 py-2 font-medium">意图</th>
              <th className="px-3 py-2 text-right font-medium">GSC 点击</th>
              <th className="px-3 py-2 text-right font-medium">GSC 曝光</th>
              <th className="px-3 py-2 text-right font-medium">CTR</th>
              <th className="px-3 py-2 text-right font-medium">平均排名</th>
              <th className="px-3 py-2 text-right font-medium">搜索量</th>
              <th className="px-3 py-2 text-right font-medium">难度</th>
              <th className="px-3 py-2 text-right font-medium">CPC</th>
              <th className="px-3 py-2 font-medium">趋势</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => {
              const query = evidenceText(row, "query")
              const intent =
                evidenceText(row, "intent") ||
                evidenceText(row, "provider_intent")
              const clicks = evidenceNumber(row, "clicks")
              const impressions = evidenceNumber(row, "impressions")
              const ctr = evidenceNumber(row, "ctr")
              const position = evidenceNumber(row, "position")
              const volume = evidenceNumber(row, "search_volume")
              const difficulty = evidenceNumber(row, "keyword_difficulty")
              const cpc = evidenceNumber(row, "cpc")
              const reason = evidenceText(row, "selection_reason")
              return (
                <tr key={query} className="align-middle">
                  <td className="max-w-72 px-3 py-3">
                    <div className="font-medium">{query}</div>
                    {reason ? (
                      <div className="mt-0.5 text-xs leading-4 text-muted-foreground">
                        {reason}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-3">
                    {intent ? intentLabel(intent) : "-"}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {clicks === null ? "-" : formatNumber(clicks)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {impressions === null ? "-" : formatNumber(impressions)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {ctr === null ? "-" : `${(ctr * 100).toFixed(1)}%`}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {position === null ? "-" : position.toFixed(1)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {volume === null ? "-" : formatNumber(volume)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {difficulty === null ? "-" : formatNumber(difficulty)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {cpc === null ? "-" : `$${cpc.toFixed(2)}`}
                  </td>
                  <td className="px-3 py-3">
                    <KeywordTrend values={evidenceMonthlySearches(row)} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function CompetitiveLandscapeSummary({ run }: { run: CompetitorAnalysisRun }) {
  const summary = run.landscapeSummary
  const leaders = Array.isArray(summary.market_leaders)
    ? summary.market_leaders.filter(
        (item): item is { domain: string; why: string } =>
          Boolean(
            item &&
            typeof item === "object" &&
            typeof (item as { domain?: unknown }).domain === "string" &&
            typeof (item as { why?: unknown }).why === "string"
          )
      )
    : []
  const findings = Array.isArray(summary.competitor_findings)
    ? summary.competitor_findings.filter(
        (
          item
        ): item is {
          domain: string
          type: KeywordCompetitor["domainType"]
          why_they_matter: string
          organic_footprint: string
          winning_themes: string[]
          weakness_gap: string
        } =>
          Boolean(
            item &&
            typeof item === "object" &&
            typeof (item as { domain?: unknown }).domain === "string" &&
            typeof (item as { type?: unknown }).type === "string" &&
            typeof (item as { why_they_matter?: unknown }).why_they_matter ===
              "string" &&
            typeof (item as { organic_footprint?: unknown })
              .organic_footprint === "string" &&
            Array.isArray(
              (item as { winning_themes?: unknown }).winning_themes
            ) &&
            typeof (item as { weakness_gap?: unknown }).weakness_gap ===
              "string"
          )
      )
    : []
  const serpIssues = run.serpSnapshots.flatMap((snapshot) => {
    const query = evidenceText(snapshot, "keyword") || "未知查询"
    if (snapshot.ok === false) {
      return [
        {
          query,
          detail:
            evidenceText(snapshot, "error") ||
            evidenceText(snapshot, "error_code") ||
            "SERP 请求失败",
        },
      ]
    }
    if (
      snapshot.ok === true &&
      Array.isArray(snapshot.items) &&
      !snapshot.items.length
    ) {
      return [{ query, detail: "接口成功，但没有返回 SERP 结果" }]
    }
    return []
  })
  const groups = [
    ["有效内容形式", summaryStrings(summary.content_formats)],
    ["获胜主题", summaryStrings(summary.winning_themes)],
    ["关键词/主题缺口", summaryStrings(summary.keyword_theme_gaps)],
    ["外链与权威", summaryStrings(summary.backlink_authority_observations)],
    [
      "后续工作流",
      summaryStrings(summary.recommended_workflows).map(
        recommendedWorkflowLabel
      ),
    ],
  ] as const

  return (
    <section className="space-y-4 border-b px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">市场判断</h3>
        {run.directionalResult ? (
          <Badge variant="outline">方向性结果</Badge>
        ) : null}
      </div>
      {run.localMarket ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            本地中心 {run.localMarket.latitude}, {run.localMarket.longitude}
          </span>
          <span>半径 {run.localMarket.radiusKm} 公里</span>
          <span>
            {run.localMarket.searchType === "maps"
              ? "Google Maps"
              : "Local Finder"}
            {` / ${run.localMarket.device === "desktop" ? "桌面" : "移动"}`}
          </span>
          {run.localMarket.includeQuestions ? <span>包含商家问答</span> : null}
        </div>
      ) : null}
      {summaryText(summary.market_read) ? (
        <p className="max-w-5xl text-sm leading-6">
          {summaryText(summary.market_read)}
        </p>
      ) : null}
      <dl className="grid gap-4 text-sm md:grid-cols-2">
        <div>
          <dt className="text-xs font-medium text-muted-foreground">
            最可赢机会
          </dt>
          <dd className="mt-1 leading-5">
            {summaryText(summary.most_winnable_opportunity) || "-"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted-foreground">
            最大排名障碍
          </dt>
          <dd className="mt-1 leading-5">
            {summaryText(summary.biggest_barrier) || "-"}
          </dd>
        </div>
      </dl>
      {leaders.length ? (
        <div>
          <div className="text-xs font-medium text-muted-foreground">
            市场领导者
          </div>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {leaders.map((leader) => (
              <div key={leader.domain} className="border-l-2 pl-3 text-sm">
                <div className="font-medium">{leader.domain}</div>
                <div className="mt-0.5 text-muted-foreground">{leader.why}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <CompetitiveQuerySet run={run} />
      {serpIssues.length ? (
        <div className="border-l-2 border-amber-500 px-3 py-2 text-sm">
          <div className="font-medium">SERP 证据不完整</div>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {serpIssues.map((issue) => (
              <li key={`${issue.query}:${issue.detail}`}>
                {issue.query}：{issue.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {findings.length ? (
        <div className="overflow-x-auto border-y">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">域名</th>
                <th className="px-3 py-2 font-medium">类型</th>
                <th className="px-3 py-2 font-medium">重要原因</th>
                <th className="px-3 py-2 font-medium">自然搜索规模</th>
                <th className="px-3 py-2 font-medium">获胜主题</th>
                <th className="px-3 py-2 font-medium">弱点/缺口</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {findings.map((finding) => (
                <tr key={finding.domain} className="align-top">
                  <td className="px-3 py-3 font-medium">{finding.domain}</td>
                  <td className="px-3 py-3">
                    {competitorDomainTypeLabel(finding.type)}
                  </td>
                  <td className="max-w-64 px-3 py-3 leading-5">
                    {finding.why_they_matter || "-"}
                  </td>
                  <td className="max-w-52 px-3 py-3 leading-5">
                    {finding.organic_footprint || "-"}
                  </td>
                  <td className="max-w-64 px-3 py-3 leading-5">
                    {finding.winning_themes.join("、") || "-"}
                  </td>
                  <td className="max-w-64 px-3 py-3 leading-5">
                    {finding.weakness_gap || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {groups.map(([label, values]) =>
          values.length ? (
            <div key={label}>
              <div className="text-xs font-medium text-muted-foreground">
                {label}
              </div>
              <ul className="mt-1 space-y-1 text-sm">
                {values.map((value) => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
            </div>
          ) : null
        )}
      </div>
      {Object.keys(run.costBreakdown).length ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
          {Object.entries(run.costBreakdown).map(([phase, cost]) => (
            <span key={phase}>
              {landscapeCostLabel(phase)} ${cost.toFixed(4)}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function recommendedWorkflowLabel(value: string) {
  const labels: Record<string, string> = {
    competitor_analysis: "竞品深度分析",
    keyword_clustering: "关键词聚类",
    content_brief: "内容简报",
  }
  return labels[value] ?? value
}

function landscapeCostLabel(value: string) {
  const labels: Record<string, string> = {
    ai_query_selection: "查询集选择",
    keyword_metrics: "关键词指标",
    live_serps: "SERP 复核",
    serp_competitors: "竞品发现",
    local_businesses: "本地商家",
    local_serps: "本地 SERP",
    business_questions: "商家问答",
    ai_domain_classification: "竞品分类",
    domain_overviews: "域名概览",
    ranked_keywords: "排名词验证",
    ai_backlink_assessment: "外链判断",
    backlinks: "外链验证",
    ai_landscape_synthesis: "市场综合",
  }
  return labels[value] ?? value
}

function KeywordErrorState({
  title,
  message,
  onRetry,
  actionLabel = "重新读取",
  pending = false,
}: {
  title: string
  message: string
  onRetry: () => void
  actionLabel?: string
  pending?: boolean
}) {
  return (
    <div className="flex min-h-72 items-center justify-center px-4">
      <div className="max-w-lg text-center">
        <h2 className="font-medium">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={onRetry}
          disabled={pending}
        >
          {pending ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          {actionLabel}
        </Button>
      </div>
    </div>
  )
}

function KeywordFilter({
  value,
  onChange,
  label,
  options,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  options: [string, string][]
}) {
  const selectedLabel =
    options.find(([optionValue]) => optionValue === value)?.[1] ?? label
  return (
    <Select value={value} onValueChange={(next) => onChange(next ?? value)}>
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map(([optionValue, optionLabel]) => (
          <SelectItem key={optionValue} value={optionValue}>
            {optionLabel}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function KeywordRow({
  item,
  selected,
  onSelectedChange,
  onOpenDetails,
}: {
  item: KeywordListItem
  selected: boolean
  onSelectedChange: (selected: boolean) => void
  onOpenDetails: () => void
}) {
  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell>
        <Checkbox
          aria-label={`选择 ${item.keyword}`}
          checked={selected}
          onCheckedChange={(checked) => onSelectedChange(Boolean(checked))}
        />
      </TableCell>
      <TableCell className="max-w-72 whitespace-normal">
        <button
          type="button"
          className="block w-full text-left leading-5 font-medium break-words hover:text-primary hover:underline"
          onClick={onOpenDetails}
        >
          {item.keyword}
        </button>
        {item.reviewStatus === "needs_review" && (
          <Badge variant="outline" className="ml-2">
            待检查
          </Badge>
        )}
      </TableCell>
      <TableCell>
        {item.intent ? (
          <Badge variant="outline">{intentLabel(item.intent)}</Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {nullableNumber(item.searchVolume)}
      </TableCell>
      <TableCell>
        <KeywordTrend values={item.monthlySearches} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {nullableNumber(item.keywordDifficulty)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {item.cpc === null ? "-" : item.cpc.toFixed(2)}
      </TableCell>
      <TableCell>
        <div className="flex max-w-48 flex-wrap gap-1">
          {item.sources.map((source) => (
            <Badge key={source} variant="secondary">
              {sourceLabel(source)}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex max-w-40 flex-wrap gap-1">
          {item.tags.length
            ? item.tags.map((tag) => (
                <Badge key={tag.id} variant="outline">
                  {tag.name}
                </Badge>
              ))
            : "-"}
        </div>
      </TableCell>
    </TableRow>
  )
}

function ExplainedTableHead({
  label,
  explanation,
  align = "left",
  className,
}: {
  label: string
  explanation: string
  align?: "left" | "right"
  className?: string
}) {
  return (
    <TableHead
      className={[align === "right" ? "text-right" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      <span
        className={`inline-flex items-center gap-1 ${align === "right" ? "justify-end" : ""}`}
      >
        {label}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`${label}说明`}
                />
              }
            >
              <Info className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{explanation}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
    </TableHead>
  )
}

function KeywordDetailsSheet({
  item,
  onOpenChange,
}: {
  item: KeywordListItem | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={Boolean(item)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {item && (
          <>
            <SheetHeader className="border-b pr-14">
              <SheetTitle className="text-lg break-words">
                {item.keyword}
              </SheetTitle>
              <SheetDescription>关键词指标、趋势、来源和标签</SheetDescription>
            </SheetHeader>
            <div className="space-y-6 p-6">
              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md border bg-border">
                <DetailMetric
                  label="月搜索量"
                  value={nullableNumber(item.searchVolume)}
                />
                <DetailMetric
                  label="关键词难度"
                  value={nullableNumber(item.keywordDifficulty)}
                />
                <DetailMetric
                  label="CPC"
                  value={item.cpc === null ? "-" : item.cpc.toFixed(2)}
                />
              </div>

              <DetailSection title="搜索意图">
                <div className="flex flex-wrap gap-2">
                  {item.intent && (
                    <Badge variant="outline">{intentLabel(item.intent)}</Badge>
                  )}
                  {item.reviewStatus === "needs_review" && (
                    <Badge variant="outline">待检查</Badge>
                  )}
                </div>
              </DetailSection>

              <DetailSection title="最近 12 个月趋势">
                <KeywordTrendDetails values={item.monthlySearches} />
              </DetailSection>

              <DetailSection title="来源">
                <div className="flex flex-wrap gap-1.5">
                  {item.sources.length ? (
                    item.sources.map((source) => (
                      <Badge key={source} variant="secondary">
                        {sourceLabel(source)}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </div>
              </DetailSection>

              <DetailSection title="标签">
                <div className="flex flex-wrap gap-1.5">
                  {item.tags.length ? (
                    item.tags.map((tag) => (
                      <Badge key={tag.id} variant="outline">
                        {tag.name}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">暂无标签</span>
                  )}
                </div>
              </DetailSection>

              <DetailSection title="更新时间">
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">加入词库</dt>
                    <dd>{formatDateTime(item.createdAt)}</dd>
                  </div>
                </dl>
              </DetailSection>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function DetailSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function KeywordTrendDetails({
  values,
}: {
  values: KeywordListItem["monthlySearches"]
}) {
  const recent = values
    .slice(-12)
    .filter((value) => typeof value.search_volume === "number")
  if (!recent.length) {
    return <p className="text-sm text-muted-foreground">暂无月度趋势数据</p>
  }
  const maximum = Math.max(
    ...recent.map((value) => value.search_volume ?? 0),
    1
  )
  return (
    <div className="flex h-36 items-end gap-1 rounded-md border px-3 pt-4 pb-2">
      {recent.map((entry, index) => {
        const volume = entry.search_volume ?? 0
        return (
          <TooltipProvider key={`${entry.year}-${entry.month}-${index}`}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <div className="flex h-full min-w-0 flex-1 items-end" />
                }
              >
                <span
                  className="block w-full min-w-1 bg-primary/65"
                  style={{
                    height: `${Math.max(4, (volume / maximum) * 100)}%`,
                  }}
                />
              </TooltipTrigger>
              <TooltipContent>
                {formatMonth(entry.year, entry.month)}：{formatNumber(volume)}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )
      })}
    </div>
  )
}

function KeywordTrend({
  values,
}: {
  values: KeywordListItem["monthlySearches"]
}) {
  const volumes = values
    .slice(-12)
    .map((value) => value.search_volume)
    .filter((value): value is number => typeof value === "number")
  if (!volumes.length) return <span className="text-muted-foreground">-</span>
  const maximum = Math.max(...volumes, 1)
  return (
    <div
      className="flex h-8 w-20 items-end gap-px"
      aria-label={`最近搜索趋势：${volumes.join("、")}`}
    >
      {volumes.map((volume, index) => (
        <span
          key={`${index}-${volume}`}
          className="min-h-0.5 flex-1 bg-primary/55"
          style={{ height: `${Math.max(6, (volume / maximum) * 100)}%` }}
        />
      ))}
    </div>
  )
}

function useElapsedSeconds(run: KeywordBuildRun | null): number {
  const [clock, setClock] = React.useState({
    runId: run?.runId ?? null,
    elapsed: Math.floor(run?.elapsedSeconds ?? 0),
  })
  const active = Boolean(run && ACTIVE_RUN_STATUSES.has(run.status))
  const runId = run?.runId ?? null
  const serverElapsed = Math.floor(run?.elapsedSeconds ?? 0)
  React.useEffect(() => {
    if (!active || !runId) return
    const timer = window.setInterval(() => {
      setClock((current) => ({
        runId,
        elapsed:
          current.runId === runId
            ? Math.max(current.elapsed + 1, serverElapsed)
            : serverElapsed + 1,
      }))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [active, runId, serverElapsed])
  if (!runId) return 0
  return clock.runId === runId
    ? Math.max(clock.elapsed, serverElapsed)
    : serverElapsed
}

function stageLabel(stage?: string | null): string {
  const labels: Record<string, string> = {
    queued: "正在准备关键词库",
    discovering_seeds: "正在发现相关关键词",
    waiting_for_business_profile: "正在识别网站业务",
    selecting_seeds: "正在分析业务关键词",
    expanding: "正在拓展关键词",
    filtering: "正在清理关键词",
    classifying: "正在整理关键词分类",
    scoring: "正在整理关键词数据",
    committing: "正在生成关键词库",
    waiting_for_recovery: "后台恢复中",
    waiting_for_worker: "关键词服务正在恢复",
    waiting_for_configuration: "等待数据源配置",
    waiting_for_project_update: "等待项目设置更新",
    waiting_for_reconciliation: "正在核对外部请求",
    delayed: "后台延迟处理中",
    blocked: "等待外部条件",
    completed: "已完成",
    partial: "部分完成",
    failed: "暂时不可用",
  }
  return labels[stage ?? ""] ?? "正在处理关键词"
}

function statusPollDelay(status: KeywordLibraryStatus): number | null {
  if (status.pendingMetricsCount > 0) return 30000
  const run = status.run
  if (!run) return null
  if (run.status === "queued" || run.status === "running") return 2000
  if (run.status !== "waiting" && run.status !== "blocked") return null
  if (!run.nextRetryAt) return run.status === "blocked" ? 60000 : 15000
  const remaining = new Date(run.nextRetryAt).getTime() - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0) return 2000
  return Math.min(Math.max(remaining + 250, 2000), 60000)
}

function runStatusLabel(run?: KeywordBuildRun | null): string {
  if (
    run?.status === "waiting" ||
    run?.status === "blocked" ||
    run?.stage === "waiting_for_recovery"
  ) {
    return run?.status === "blocked" ? "等待恢复" : "后台恢复中"
  }
  if (run && ACTIVE_RUN_STATUSES.has(run.status)) return "处理中"
  return stageLabel(run?.stage)
}

function intentLabel(intent: string): string {
  const labels: Record<string, string> = {
    informational: "信息",
    information: "信息",
    commercial: "商业",
    transactional: "交易",
    transaction: "交易",
    navigational: "导航",
    navigation: "导航",
  }
  return labels[intent.toLowerCase()] ?? intent
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    labs_site: "网站发现",
    google_ads_site: "Google Ads",
    keyword_ideas: "关键词拓展",
    keyword_ideas_broad: "广泛拓展",
    keyword_ideas_close: "相近拓展",
  }
  return labels[source] ?? source
}

function nullableNumber(value: number | null): string {
  return value === null ? "-" : formatNumber(value)
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value)
}

function optionalNonNegativeNumber(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function optionalBoundedNumber(
  value: string,
  maximum: number
): number | undefined {
  const parsed = optionalNonNegativeNumber(value)
  if (parsed === undefined) return undefined
  return Math.min(parsed, maximum)
}

function countActiveFilters(filters: Filters): number {
  return [
    filters.intent !== DEFAULT_FILTERS.intent,
    filters.source !== DEFAULT_FILTERS.source,
    filters.keywordStatus !== DEFAULT_FILTERS.keywordStatus,
    Boolean(filters.minVolume.trim()),
    Boolean(filters.maxDifficulty.trim()),
    filters.sort !== DEFAULT_FILTERS.sort,
  ].filter(Boolean).length
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand("copy")
  textarea.remove()
  if (!copied) throw new Error("浏览器未允许复制")
}

function formatDateTime(value: string | null): string {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function formatMonth(
  year: number | null | undefined,
  month: string | number | null | undefined
): string {
  if (year == null && month == null) return "未知月份"
  return `${year ?? ""}${year != null ? "年" : ""}${month ?? ""}${month != null ? "月" : ""}`
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}:${String(remainder).padStart(2, "0")}`
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function downloadCsv(rows: KeywordListItem[]) {
  const header = [
    "关键词",
    "意图",
    "月搜索量",
    "难度",
    "CPC",
    "来源",
    "标签",
    "加入词库时间",
  ]
  const data = rows.map((row) => [
    row.keyword,
    intentLabel(row.intent ?? ""),
    row.searchVolume ?? "",
    row.keywordDifficulty ?? "",
    row.cpc ?? "",
    row.sources.map(sourceLabel).join("|"),
    row.tags.map((tag) => tag.name).join("|"),
    row.createdAt,
  ])
  const csv = [header, ...data]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")
  const blob = new Blob([`\uFEFF${csv}`], {
    type: "text/csv;charset=utf-8",
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `keywords-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

function csvCell(value: string | number): string {
  let text = String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}
