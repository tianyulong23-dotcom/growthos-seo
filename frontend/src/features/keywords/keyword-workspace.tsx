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
  listKeywordCompetitorOpportunities,
  listKeywordCompetitors,
  listKeywords,
  retryKeywordBuild,
  startCompetitorAnalysis,
  updateKeywordStatus,
  type KeywordBuildRun,
  type CompetitorAnalysisRun,
  type CompetitorOpportunityQuery,
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
const COMPETITOR_OPPORTUNITY_PAGE_SIZE = 100
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting"])
const READABLE_RUN_STATUSES = new Set(["completed", "partial"])

type KeywordWorkspaceProps = {
  projectId: string
  view?: string
  savedCompetitorDomain?: string | null
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
  savedCompetitorDomain,
}: KeywordWorkspaceProps) {
  return (
    <KeywordQueryProvider>
      <KeywordWorkspaceContent
        projectId={projectId}
        view={view}
        savedCompetitorDomain={savedCompetitorDomain}
      />
    </KeywordQueryProvider>
  )
}

function KeywordWorkspaceContent({
  projectId,
  view = "library",
  savedCompetitorDomain,
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
      <CompetitorOpportunityPanel
        projectId={projectId}
        savedCompetitorDomain={savedCompetitorDomain}
      />
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
          staleTime:
            listRefreshKey > 0 ||
            (cached && cached.resultVersion < expectedVersion)
              ? 0
              : 5 * 60 * 1000,
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

  const pageCount = Math.max(
    1,
    Math.ceil((result?.total ?? 0) / COMPETITOR_OPPORTUNITY_PAGE_SIZE)
  )
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
            <Label className="space-y-1.5 text-xs font-medium text-muted-foreground">
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
            </Label>
            <Label className="space-y-1.5 text-xs font-medium text-muted-foreground">
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
            </Label>
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
  savedCompetitorDomain,
}: {
  projectId: string
  savedCompetitorDomain?: string | null
}) {
  const queryClient = useQueryClient()
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const [starting, setStarting] = React.useState(false)
  const [manualOpen, setManualOpen] = React.useState(false)
  const [manualDomains, setManualDomains] = React.useState([""])
  const [autoOpen, setAutoOpen] = React.useState(false)
  const [error, setError] = React.useState("")
  const [message, setMessage] = React.useState("")

  const connectionQuery = useQuery({
    queryKey: keywordQueryKeys.connection(projectId),
    queryFn: () => getGSCConnection(projectId),
    staleTime: 5 * 60 * 1000,
  })
  const autoDiscoveryReady = Boolean(
    connectionQuery.data?.propertyConnected &&
    !connectionQuery.data.requiresReconnect &&
    !connectionQuery.error
  )

  const opportunityQuery = React.useMemo<CompetitorOpportunityQuery>(
    () => ({
      page: 1,
      pageSize: COMPETITOR_OPPORTUNITY_PAGE_SIZE,
      status: "all",
      sort: "opportunity_score",
      order: "desc",
    }),
    []
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
  const previousRunStatusRef = React.useRef<
    CompetitorAnalysisRun["status"] | null
  >(null)
  const competitors = competitorsQuery.data?.items ?? []
  const result = opportunitiesQuery.data ?? null
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
  const panelError = manualOpen ? "" : displayError

  React.useEffect(() => {
    const previous = previousRunStatusRef.current
    const current = run?.status ?? null
    previousRunStatusRef.current = current

    if (
      previous &&
      ["queued", "running"].includes(previous) &&
      current &&
      !["queued", "running"].includes(current)
    ) {
      void queryClient.invalidateQueries({
        queryKey: ["keywords", projectId, "competitors"],
      })
      void queryClient.invalidateQueries({
        queryKey: ["keywords", projectId, "opportunities"],
      })
    }
  }, [projectId, queryClient, run?.status])

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
  }

  async function openAutoDiscovery() {
    setError("")
    const refreshed = await connectionQuery.refetch()
    const ready = Boolean(
      refreshed.data?.propertyConnected &&
      !refreshed.data.requiresReconnect &&
      !refreshed.error
    )
    if (!ready) {
      setAutoOpen(true)
      return
    }
    void handleStart({ mode: "auto" })
  }

  async function handleStart(input: {
    mode: "manual" | "auto"
    competitorDomains?: string[]
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

  const items = result?.items ?? []
  const active = Boolean(run && ["queued", "running"].includes(run.status))
  const analyzedCompetitors = competitors.filter(
    (competitor) =>
      competitor.selectedForGap && competitor.status === "completed"
  )
  const savedDomain = savedCompetitorDomain?.trim() ?? ""
  const savedCompetitorIsInResults = analyzedCompetitors.some(
    (competitor) =>
      competitor.domain.toLowerCase() === savedDomain.toLowerCase()
  )
  const gapVolume = items.reduce(
    (total, item) => total + (item.searchVolume ?? 0),
    0
  )
  const highOpportunityCount = items.filter(isHighOpportunity).length
  const hasAnalyzedResults = Boolean(
    analyzedCompetitors.length || (result?.total ?? 0) > 0
  )
  const analyzedAt = hasAnalyzedResults ? (result?.analyzedAt ?? null) : null
  const summary = (
    <CompetitorIntelligenceSummary
      analyzedCompetitors={analyzedCompetitors.length}
      opportunityCount={result?.total ?? 0}
      gapVolume={gapVolume}
      highOpportunityCount={highOpportunityCount}
      analyzedAt={analyzedAt}
      hasAnalyzedResults={hasAnalyzedResults}
      analyzePending={active || starting || connectionQuery.isFetching}
      manualPending={active || starting}
      onAnalyze={() => void openAutoDiscovery()}
      onManualAdd={() => {
        setError("")
        setManualOpen(true)
      }}
    />
  )
  const dialogs = (
    <>
      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent showCloseButton={!starting} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>手动添加竞争对手</DialogTitle>
            <DialogDescription>
              输入最多 5 个域名，不需要连接 GSC。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {manualDomains.map((domain, index) => (
              <div key={index} className="space-y-1.5">
                <Label htmlFor={`competitor-domain-${index}`}>
                  竞争对手域名 {index + 1}
                </Label>
                <InputGroup>
                  <InputGroupInput
                    id={`competitor-domain-${index}`}
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
                    <InputGroupAddon align="inline-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`删除竞争对手 ${index + 1}`}
                        disabled={starting}
                        onClick={() =>
                          setManualDomains((current) =>
                            current.filter(
                              (_, itemIndex) => itemIndex !== index
                            )
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    </InputGroupAddon>
                  ) : null}
                </InputGroup>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3">
              {manualDomains.length < 5 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={starting}
                  onClick={() =>
                    setManualDomains((current) => [...current, ""])
                  }
                >
                  <Plus />
                  添加域名
                </Button>
              ) : (
                <span />
              )}
              <span className="text-xs text-muted-foreground">
                {manualDomains.length} / 5
              </span>
            </div>
          </div>
          {displayError ? (
            <p className="text-sm text-destructive" role="alert">
              {displayError}
            </p>
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

      <Dialog open={autoOpen && !autoDiscoveryReady} onOpenChange={setAutoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              请先连接当前项目的 Google Search Console，再使用自动发现。
            </DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button
              nativeButton={false}
              render={<a href={gscSettingsHref(projectId, "competitor-gap")} />}
            >
              <ExternalLink />
              前往连接
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
  if (!active && !hasAnalyzedResults) {
    return (
      <div id="competitor-gap" className="scroll-mt-4 space-y-4">
        {summary}
        {panelError ? (
          <Card size="sm" role="alert">
            <CardContent className="text-destructive">{panelError}</CardContent>
          </Card>
        ) : null}
        <Card size="sm">
          <CardContent className="flex min-h-80 flex-col items-center justify-center px-6 py-10 text-center">
            <Radar className="size-8 text-primary" />
            <h3 className="mt-4 text-lg font-semibold">发现内容机会</h3>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              找出竞争对手已有排名、但当前网站尚未覆盖的关键词
            </p>
            <div className="mt-7 grid w-full max-w-3xl gap-5 text-left sm:grid-cols-3">
              <OnboardingFeature
                icon={<Search />}
                title="自动发现"
                description="找到排名关键词相似的竞争对手"
              />
              <OnboardingFeature
                icon={<Radar />}
                title="差距分析"
                description="显示竞争对手已有、当前网站缺失的关键词"
              />
              <OnboardingFeature
                icon={<Tag />}
                title="机会评分"
                description="按流量潜力与难度排列关键词差距"
              />
            </div>
            {savedDomain && !savedCompetitorIsInResults ? (
              <Badge variant="outline" className="mt-7">
                {savedDomain}
                <span className="text-muted-foreground">待分析</span>
              </Badge>
            ) : null}
            <Button
              className="mt-7"
              disabled={starting || connectionQuery.isFetching}
              onClick={() => void openAutoDiscovery()}
            >
              {starting || connectionQuery.isFetching ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Radar />
              )}
              分析竞争对手
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              大约需要 2 分钟
            </p>
          </CardContent>
        </Card>
        {dialogs}
      </div>
    )
  }

  if (active && run) {
    return (
      <div id="competitor-gap" className="scroll-mt-4 space-y-4">
        {summary}
        <Card size="sm">
          <CardHeader>
            <CardTitle>
              分析竞争对手（{run.completedCompetitors}/{run.competitorLimit}）
            </CardTitle>
            <CardDescription>
              {displayMessage || run.message || "正在分析"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Progress value={run.progress} />
            <p className="mt-2 text-right text-xs text-muted-foreground tabular-nums">
              {run.progress}%
            </p>
          </CardContent>
        </Card>
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(240px,0.32fr)_minmax(0,1fr)]">
          <Card size="sm">
            <CardHeader>
              <CardTitle>竞争对手</CardTitle>
              <CardDescription>
                {analyzedCompetitors.length} 个已分析
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {analyzedCompetitors.length ? (
                analyzedCompetitors.map((competitor, index) => (
                  <CompetitorListItem
                    key={competitor.id}
                    rank={index + 1}
                    competitor={competitor}
                    highOpportunityCount={0}
                  />
                ))
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  尚未分析任何竞争对手
                </p>
              )}
            </CardContent>
          </Card>
          <OpportunityGapCard
            items={items}
            total={result?.total ?? 0}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
          />
        </div>
        {dialogs}
      </div>
    )
  }

  if (hasAnalyzedResults) {
    return (
      <div id="competitor-gap" className="scroll-mt-4 space-y-4">
        {summary}
        {run?.status === "failed" ? (
          <Card size="sm" role="alert">
            <CardContent className="text-destructive">
              {run.message || "竞争分析失败"}
            </CardContent>
          </Card>
        ) : null}
        {panelError ? (
          <Card size="sm" role="alert">
            <CardContent className="text-destructive">{panelError}</CardContent>
          </Card>
        ) : null}
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(240px,0.32fr)_minmax(0,1fr)]">
          <Card size="sm">
            <CardHeader>
              <CardTitle>所有竞争对手</CardTitle>
              <CardDescription>
                {analyzedCompetitors.length} 个已分析
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {analyzedCompetitors.map((competitor, index) => (
                <CompetitorListItem
                  key={competitor.id}
                  rank={index + 1}
                  competitor={competitor}
                  highOpportunityCount={
                    items.filter(
                      (item) =>
                        isHighOpportunity(item) &&
                        item.rankings.some(
                          (ranking) => ranking.domain === competitor.domain
                        )
                    ).length
                  }
                />
              ))}
              {savedDomain && !savedCompetitorIsInResults ? (
                <div className="flex items-center gap-3 rounded-md border p-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium tabular-nums">
                    {analyzedCompetitors.length + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {savedDomain}
                    </p>
                    <p className="text-xs text-muted-foreground">待分析</p>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
          <OpportunityGapCard
            items={items}
            total={result?.total ?? 0}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
          />
        </div>
        {dialogs}
      </div>
    )
  }
}
function CompetitorIntelligenceSummary({
  analyzedCompetitors,
  opportunityCount,
  gapVolume,
  highOpportunityCount,
  analyzedAt,
  hasAnalyzedResults,
  analyzePending,
  manualPending,
  onAnalyze,
  onManualAdd,
}: {
  analyzedCompetitors: number
  opportunityCount: number
  gapVolume: number
  highOpportunityCount: number
  analyzedAt: string | null
  hasAnalyzedResults: boolean
  analyzePending: boolean
  manualPending: boolean
  onAnalyze: () => void
  onManualAdd: () => void
}) {
  const metrics = [
    {
      label: "竞争对手",
      value: formatNumber(analyzedCompetitors),
      unit: "已分析",
    },
    {
      label: "机会关键词",
      value: formatNumber(opportunityCount),
      unit: "个关键词",
    },
    {
      label: "缺口搜索量",
      value: formatNumber(gapVolume),
      unit: "/月",
    },
    {
      label: "高机会关键词",
      value: formatNumber(highOpportunityCount),
      unit: "个关键词",
    },
  ]

  return (
    <Card size="sm">
      <CardHeader className="items-center">
        <CardTitle>竞争对手情报</CardTitle>
        <CardDescription>
          {analyzedAt ? `分析于 ${formatDate(analyzedAt)}` : "尚未进行竞品分析"}
        </CardDescription>
        <CardAction>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={manualPending}
              onClick={onManualAdd}
            >
              <Plus />
              手动添加
            </Button>
            {hasAnalyzedResults ? (
              <Button
                variant="outline"
                size="sm"
                disabled={analyzePending}
                onClick={onAnalyze}
              >
                {analyzePending ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                重新分析
              </Button>
            ) : null}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <div key={metric.label} className="min-w-0 bg-background p-4">
            <p className="text-xs text-muted-foreground">{metric.label}</p>
            <p className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1 text-2xl font-semibold tabular-nums">
              <span data-slot="metric-value">{metric.value}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {metric.unit}
              </span>
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function OnboardingFeature({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex gap-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground [&_svg]:size-4">
        {icon}
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  )
}

function CompetitorListItem({
  rank,
  competitor,
  highOpportunityCount,
}: {
  rank: number
  competitor: KeywordCompetitor
  highOpportunityCount: number
}) {
  return (
    <div
      className="flex items-start gap-3 rounded-md border p-3 data-[selected=true]:border-primary/40 data-[selected=true]:bg-primary/5"
      data-selected={competitor.selectedForGap}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium tabular-nums">
        {rank}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{competitor.domain}</p>
          {competitor.selectedForGap ? (
            <Badge variant="secondary">已选择</Badge>
          ) : null}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <span>
            月流量 {nullableNumber(competitor.etv ?? competitor.organicTraffic)}
          </span>
          <span>高机会 {formatNumber(highOpportunityCount)}</span>
        </div>
      </div>
    </div>
  )
}

type OpportunityView = "all" | "high" | "quick" | "untapped"

function isHighOpportunity(item: KeywordCompetitorOpportunity) {
  return (item.opportunityScore ?? 0) >= 70
}

function isQuickWin(item: KeywordCompetitorOpportunity) {
  return (
    (item.opportunityScore ?? 0) >= 50 &&
    (item.keywordDifficulty ?? Number.POSITIVE_INFINITY) <= 40
  )
}

function OpportunityGapCard({
  items,
  total,
  selectedIds,
  onSelectionChange,
}: {
  items: KeywordCompetitorOpportunity[]
  total: number
  selectedIds: Set<string>
  onSelectionChange: React.Dispatch<React.SetStateAction<Set<string>>>
}) {
  const [view, setView] = React.useState<OpportunityView>("all")
  const visibleItems = items.filter((item) => {
    if (view === "high") return isHighOpportunity(item)
    if (view === "quick") return isQuickWin(item)
    if (view === "untapped") return !item.inLibrary
    return true
  })
  const allVisibleSelected = Boolean(
    visibleItems.length &&
    visibleItems.every((item) => selectedIds.has(item.id))
  )

  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle>内容差距</CardTitle>
        <CardDescription>
          {formatNumber(visibleItems.length)}/{formatNumber(total)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Tabs
          value={view}
          onValueChange={(value) => setView(value as OpportunityView)}
        >
          <TabsList className="max-w-full justify-start overflow-x-auto">
            <TabsTrigger value="all">全部</TabsTrigger>
            <TabsTrigger value="high">高机会</TabsTrigger>
            <TabsTrigger value="quick">快速取胜</TabsTrigger>
            <TabsTrigger value="untapped">未覆盖</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="overflow-x-auto">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="选择当前关键词差距"
                    checked={allVisibleSelected}
                    onCheckedChange={(checked) => {
                      onSelectionChange((current) => {
                        const next = new Set(current)
                        visibleItems.forEach((item) => {
                          if (checked) next.add(item.id)
                          else next.delete(item.id)
                        })
                        return next
                      })
                    }}
                  />
                </TableHead>
                <TableHead className="min-w-52">关键词</TableHead>
                <TableHead className="text-right">搜索量</TableHead>
                <TableHead className="text-right">难度</TableHead>
                <TableHead className="text-right">CPC</TableHead>
                <TableHead className="text-right">机会分</TableHead>
                <TableHead className="min-w-44">排名竞品</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleItems.length ? (
                visibleItems.map((item) => (
                  <OpportunityRow
                    key={item.id}
                    item={item}
                    selected={selectedIds.has(item.id)}
                    onSelectedChange={(selected) => {
                      onSelectionChange((current) => {
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
                    colSpan={7}
                    className="h-32 text-center text-sm text-muted-foreground"
                  >
                    尚未发现关键词差距。
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
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
      <TableCell className="text-right tabular-nums">
        {nullableNumber(item.searchVolume)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {nullableNumber(item.keywordDifficulty)}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {item.cpc === null ? "-" : `$${item.cpc.toFixed(2)}`}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {item.opportunityScore === null
          ? "-"
          : Math.round(item.opportunityScore)}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {item.rankings.slice(0, 3).map((ranking) =>
            ranking.url ? (
              <Badge
                key={ranking.competitorId}
                variant="outline"
                className="max-w-44"
                render={
                  <a
                    href={ranking.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`打开 ${ranking.domain} 排名页面`}
                  />
                }
              >
                <span className="truncate">{ranking.domain}</span>
                <span className="tabular-nums">#{ranking.rank ?? "-"}</span>
                <ExternalLink data-icon="inline-end" />
              </Badge>
            ) : (
              <Badge
                key={ranking.competitorId}
                variant="outline"
                className="max-w-44"
              >
                <span className="truncate">{ranking.domain}</span>
                <span className="tabular-nums">#{ranking.rank ?? "-"}</span>
              </Badge>
            )
          )}
          {item.competitorCount > 3 ? (
            <Badge variant="ghost">+{item.competitorCount - 3}</Badge>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
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
        <Button
          type="button"
          variant="link"
          className="h-auto w-full justify-start p-0 text-left leading-5 break-words whitespace-normal"
          onClick={onOpenDetails}
        >
          {item.keyword}
        </Button>
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
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

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
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
