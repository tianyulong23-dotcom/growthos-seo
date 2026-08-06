import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  LoaderCircle,
  Save,
} from "lucide-react"

import { ApiError } from "@/api/client"
import { saveGSCKeywords } from "@/api/keywords"
import {
  exportGSCPerformance,
  getGSCPerformance,
  getGSCPerformanceTable,
  type GSCPerformanceDateRange,
  type GSCPerformanceDevice,
  type GSCPerformanceDimension,
  type GSCPerformanceFilters,
  type GSCPerformanceMetrics,
  type GSCPerformancePageSize,
  type GSCPerformanceReport,
  type GSCPerformanceRow,
  type GSCStrikingDistanceRow,
} from "@/api/settings"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
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
  buildCsv,
  copyTableToClipboard,
  downloadCsv,
  normalizeExportValue,
  type GSCExportValue,
} from "@/features/keywords/gsc-performance-export"
import { keywordQueryKeys } from "@/features/keywords/keyword-query-client"

type PerformanceTab = "striking" | "queries" | "pages"
type SortKey = "clicks" | "impressions" | "ctr" | "position"
type SortDirection = "asc" | "desc"

const RANGE_OPTIONS: Array<[GSCPerformanceDateRange, string]> = [
  ["last_7_days", "最近 7 天"],
  ["last_28_days", "最近 28 天"],
  ["last_3_months", "最近 3 个月"],
]
const DEVICE_OPTIONS: Array<[GSCPerformanceDevice, string]> = [
  ["DESKTOP", "桌面设备"],
  ["MOBILE", "移动设备"],
  ["TABLET", "平板设备"],
]
const PAGE_SIZES: GSCPerformancePageSize[] = [25, 50, 100]
const ALL = "all"

export function GSCPerformancePanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [dateRange, setDateRange] =
    React.useState<GSCPerformanceDateRange>("last_28_days")
  const [device, setDevice] = React.useState<GSCPerformanceDevice | typeof ALL>(
    ALL
  )
  const [country, setCountry] = React.useState(ALL)
  const [tab, setTab] = React.useState<PerformanceTab>("striking")
  const [tablePage, setTablePage] = React.useState(1)
  const [tablePageSize, setTablePageSize] =
    React.useState<GSCPerformancePageSize>(25)
  const [strikingPage, setStrikingPage] = React.useState(1)
  const [strikingPageSize, setStrikingPageSize] =
    React.useState<GSCPerformancePageSize>(50)
  const [strikingSortKey, setStrikingSortKey] =
    React.useState<SortKey>("impressions")
  const [strikingSortDirection, setStrikingSortDirection] =
    React.useState<SortDirection>("desc")
  const [dimensionSortKey, setDimensionSortKey] =
    React.useState<SortKey>("clicks")
  const [dimensionSortDirection, setDimensionSortDirection] =
    React.useState<SortDirection>("desc")
  const [selectedRowIds, setSelectedRowIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const selectionAnchor = React.useRef<{
    id: string
    selected: boolean
  } | null>(null)
  const [feedback, setFeedback] = React.useState("")
  const [sheetsDialogOpen, setSheetsDialogOpen] = React.useState(false)
  const [sheetsRowCount, setSheetsRowCount] = React.useState(0)

  const filters = React.useMemo<GSCPerformanceFilters>(
    () => ({
      dateRange,
      ...(device === ALL ? {} : { device }),
      ...(country === ALL ? {} : { country }),
    }),
    [country, dateRange, device]
  )
  const dimension: GSCPerformanceDimension = tab === "pages" ? "page" : "query"

  const reportQuery = useQuery({
    queryKey: ["gsc-performance-report", projectId, filters],
    queryFn: () => getGSCPerformance(projectId, filters),
    placeholderData: (previous) => previous,
    staleTime: 5 * 60 * 1000,
    retry: retryGSCQuery,
  })
  const report = reportQuery.data

  const tableQuery = useQuery({
    queryKey: [
      "gsc-performance-table",
      projectId,
      dimension,
      tablePage,
      tablePageSize,
      filters,
    ],
    queryFn: () =>
      getGSCPerformanceTable(projectId, {
        ...filters,
        dimension,
        page: tablePage,
        pageSize: tablePageSize,
      }),
    enabled: Boolean(report) && tab !== "striking",
    placeholderData: (previous) => previous,
    staleTime: 5 * 60 * 1000,
    retry: retryGSCQuery,
  })

  React.useEffect(() => {
    if (!report) return
    void queryClient.prefetchQuery({
      queryKey: ["gsc-performance-table", projectId, "query", 1, 25, filters],
      queryFn: () =>
        getGSCPerformanceTable(projectId, {
          ...filters,
          dimension: "query",
          page: 1,
          pageSize: 25,
        }),
      staleTime: 5 * 60 * 1000,
    })
  }, [filters, projectId, queryClient, report])

  const connectionFailure =
    reportQuery.error instanceof ApiError && reportQuery.error.status === 409
      ? reportQuery.error
      : tableQuery.error instanceof ApiError && tableQuery.error.status === 409
        ? tableQuery.error
        : null

  React.useEffect(() => {
    if (!connectionFailure) return
    void queryClient.invalidateQueries({
      queryKey: keywordQueryKeys.connection(projectId),
    })
  }, [connectionFailure, projectId, queryClient])

  const saveMutation = useMutation({
    mutationFn: (keywords: string[]) => saveGSCKeywords(projectId, keywords),
    onSuccess: (_result, keywords) => {
      setFeedback(`已保存 ${keywords.length} 个关键词`)
      setSelectedRowIds(new Set())
      void queryClient.invalidateQueries({
        queryKey: keywordQueryKeys.libraryStatus(projectId),
      })
      void queryClient.invalidateQueries({
        queryKey: ["keywords", projectId, "library-list"],
      })
    },
    onError: (error) => {
      setFeedback(errorMessage(error, "保存关键词失败"))
    },
  })

  if (reportQuery.isPending) {
    return (
      <div className="space-y-4">
        <SearchPerformanceHeader projectId={projectId} connected={false} />
        <SearchPerformanceLoading />
      </div>
    )
  }
  if (reportQuery.isError) {
    return (
      <div className="space-y-4">
        <SearchPerformanceHeader projectId={projectId} connected={false} />
        <SearchPerformanceError
          message={errorMessage(reportQuery.error, "读取搜索表现失败")}
        />
      </div>
    )
  }
  if (!report) return null
  const loadedReport = report

  const strikingPageCount = Math.max(
    1,
    Math.ceil(report.strikingDistance.length / strikingPageSize)
  )
  const sortedStrikingRows = sortedRows(
    report.strikingDistance,
    strikingSortKey,
    strikingSortDirection
  )
  const strikingRows = sortedStrikingRows.slice(
    (strikingPage - 1) * strikingPageSize,
    strikingPage * strikingPageSize
  )
  const dimensionRows = sortedRows(
    tableQuery.data?.rows ?? [],
    dimensionSortKey,
    dimensionSortDirection
  )
  const allStrikingRowIds = report.strikingDistance.map(strikingRowId)
  const selectedQueries = Array.from(
    new Set(
      report.strikingDistance
        .filter((row) => selectedRowIds.has(strikingRowId(row)))
        .map((row) => row.query)
    )
  )
  const allStrikingSelected =
    allStrikingRowIds.length > 0 &&
    allStrikingRowIds.every((id) => selectedRowIds.has(id))
  const activePage = tab === "striking" ? strikingPage : tablePage
  const activePageSize = tab === "striking" ? strikingPageSize : tablePageSize
  const paginationTotalCount =
    tab === "striking" ? report.strikingDistance.length : null
  const paginationTotalPages =
    paginationTotalCount === null
      ? null
      : Math.max(1, Math.ceil(paginationTotalCount / activePageSize))

  async function exportRows(target: "csv" | "sheets") {
    setFeedback("")
    try {
      const rows =
        tab === "striking"
          ? loadedReport.strikingDistance
          : await exportGSCPerformance(projectId, { ...filters, dimension })
      const table = exportTable(tab, rows, loadedReport)
      if (!table.rows.length) {
        setFeedback("当前筛选条件没有可导出的数据")
        return
      }
      if (target === "csv") {
        downloadCsv(table.filename, buildCsv(table.headers, table.rows))
        setFeedback(`已导出 ${table.rows.length} 行数据`)
        return
      }
      await copyTableToClipboard(table.headers, table.rows)
      setSheetsRowCount(table.rows.length)
      setSheetsDialogOpen(true)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({
          queryKey: keywordQueryKeys.connection(projectId),
        })
      }
      setFeedback(errorMessage(error, "导出失败"))
    }
  }

  return (
    <div className="space-y-4">
      <SearchPerformanceHeader projectId={projectId} connected />

      <PerformanceTotals report={report} />

      <Card className="gap-0 py-0">
        <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              const nextTab = value as PerformanceTab
              const previousTab = tab
              setTab(nextTab)
              setSelectedRowIds(new Set())
              selectionAnchor.current = null
              if (nextTab === "striking") {
                setStrikingPage(1)
                setStrikingPageSize(50)
                setStrikingSortKey("impressions")
                setStrikingSortDirection("desc")
              } else {
                setTablePage(1)
                if (previousTab === "striking") {
                  setDimensionSortKey("clicks")
                  setDimensionSortDirection("desc")
                }
              }
            }}
          >
            <TabsList variant="line" className="max-w-full overflow-x-auto">
              <TabsTrigger value="striking">
                提升机会（{report.strikingDistance.length}）
              </TabsTrigger>
              <TabsTrigger value="queries">搜索查询</TabsTrigger>
              <TabsTrigger value="pages">页面</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex flex-wrap items-center gap-2">
            {reportQuery.isFetching ? (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            ) : null}
            <FilterSelect
              ariaLabel="设备筛选"
              value={device}
              onValueChange={(value) => {
                setDevice(value as GSCPerformanceDevice | typeof ALL)
                resetPaging()
              }}
              options={[[ALL, "全部设备"], ...DEVICE_OPTIONS]}
            />
            <FilterSelect
              ariaLabel="国家筛选"
              value={country}
              onValueChange={(value) => {
                setCountry(value)
                resetPaging()
              }}
              options={[
                [ALL, "全部国家"],
                ...report.countries.map(
                  (row) => [row.key, row.key.toUpperCase()] as [string, string]
                ),
              ]}
            />
            <FilterSelect
              ariaLabel="时间范围"
              value={dateRange}
              onValueChange={(value) => {
                setDateRange(value as GSCPerformanceDateRange)
                resetPaging()
              }}
              options={RANGE_OPTIONS}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="sm" />}
              >
                <Download />
                导出
                <ChevronDown />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="rounded-md">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>导出当前数据集</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => void exportRows("sheets")}>
                    <FileSpreadsheet />
                    复制到 Google 表格
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void exportRows("csv")}>
                    <Download />
                    下载 CSV
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {tab === "striking" && report.strikingDistance.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            当前周期没有排名第 5–20
            位的提升机会。这些查询已有一定排名，通常最可能通过优化带来更多流量。
          </p>
        ) : tab === "striking" ? (
          <>
            <div className="border-b bg-muted/25 px-4 py-3 text-sm text-muted-foreground">
              最佳页面平均排名处于第 5–20
              位的查询，按曝光量排序。优先优化对应页面，更可能进入首页前列。
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label="选择全部提升机会"
                        checked={allStrikingSelected}
                        onCheckedChange={(checked) => {
                          setSelectedRowIds(
                            checked ? new Set(allStrikingRowIds) : new Set()
                          )
                          selectionAnchor.current = null
                        }}
                      />
                    </TableHead>
                    <TableHead className="min-w-56">查询</TableHead>
                    <TableHead className="min-w-72">页面</TableHead>
                    <SortableHead
                      label="曝光"
                      value="impressions"
                      active={strikingSortKey}
                      direction={strikingSortDirection}
                      onSort={toggleStrikingSort}
                    />
                    <SortableHead
                      label="点击"
                      value="clicks"
                      active={strikingSortKey}
                      direction={strikingSortDirection}
                      onSort={toggleStrikingSort}
                    />
                    <SortableHead
                      label="平均排名"
                      value="position"
                      active={strikingSortKey}
                      direction={strikingSortDirection}
                      onSort={toggleStrikingSort}
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {strikingRows.map((row) => (
                    <TableRow
                      key={`${row.query}:${row.page}`}
                      data-state={
                        selectedRowIds.has(strikingRowId(row))
                          ? "selected"
                          : undefined
                      }
                    >
                      <TableCell>
                        <StrikingSelectionCheckbox
                          ariaLabel={`选择 ${row.query}`}
                          checked={selectedRowIds.has(strikingRowId(row))}
                          onCheckedChange={(checked) => {
                            setSelectedRowIds((current) => {
                              const next = new Set(current)
                              const id = strikingRowId(row)
                              if (checked) next.add(id)
                              else next.delete(id)
                              return next
                            })
                          }}
                          onShiftRange={(event) =>
                            applyShiftRangeSelection(
                              event,
                              strikingRowId(row),
                              strikingRows,
                              selectedRowIds,
                              selectionAnchor,
                              setSelectedRowIds
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="max-w-72 font-medium whitespace-normal">
                        {row.query}
                      </TableCell>
                      <TableCell className="max-w-96">
                        <a
                          href={safeHttpUrl(row.page) ? row.page : undefined}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 truncate text-primary hover:underline"
                          title={row.page}
                        >
                          <span className="truncate">{row.page}</span>
                          <ExternalLink className="size-3.5 shrink-0" />
                        </a>
                      </TableCell>
                      <MetricCell value={formatCount(row.impressions)} />
                      <MetricCell value={formatCount(row.clicks)} />
                      <MetricCell value={formatPosition(row.position)} />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        ) : tableQuery.isPending ? (
          <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            正在读取{tab === "queries" ? "搜索查询" : "页面"}
          </div>
        ) : tableQuery.isError ? (
          <SearchPerformanceError
            compact
            message={errorMessage(tableQuery.error, "读取表格失败")}
          />
        ) : (
          <DimensionTable
            rows={dimensionRows}
            keyLabel={tab === "queries" ? "查询" : "页面"}
            sortKey={dimensionSortKey}
            sortDirection={dimensionSortDirection}
            onSort={toggleDimensionSort}
          />
        )}

        {(tab === "striking"
          ? report.strikingDistance.length > 0
          : !tableQuery.isPending && !tableQuery.isError) && (
          <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-muted-foreground tabular-nums">
              <span>
                {formatPaginationRange(
                  activePage,
                  activePageSize,
                  paginationTotalCount
                )}
              </span>
              {tab !== "striking" && tableQuery.isFetching ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-4 sm:gap-6">
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="whitespace-nowrap">每页</span>
                <Select
                  value={String(activePageSize)}
                  onValueChange={(value) => {
                    const nextSize = Number(value) as GSCPerformancePageSize
                    if (tab === "striking") {
                      setStrikingPageSize(nextSize)
                      setStrikingPage(1)
                    } else {
                      setTablePageSize(nextSize)
                      setTablePage(1)
                    }
                  }}
                >
                  <SelectTrigger size="sm" aria-label="每页数量">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZES.map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span>条</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="whitespace-nowrap text-muted-foreground tabular-nums">
                  第 {activePage.toLocaleString()} 页
                  {paginationTotalPages !== null
                    ? `，共 ${paginationTotalPages.toLocaleString()} 页`
                    : ""}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="上一页"
                    disabled={activePage <= 1 || tableQuery.isFetching}
                    onClick={() => {
                      if (tab === "striking") {
                        setStrikingPage((current) => Math.max(1, current - 1))
                      } else {
                        setTablePage((current) => Math.max(1, current - 1))
                      }
                    }}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="下一页"
                    disabled={
                      tableQuery.isFetching ||
                      (tab === "striking"
                        ? strikingPage >= strikingPageCount
                        : !tableQuery.data?.hasNextPage)
                    }
                    onClick={() => {
                      if (tab === "striking") {
                        setStrikingPage((current) => current + 1)
                      } else {
                        setTablePage((current) => current + 1)
                      }
                    }}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      {feedback ? (
        <div className="border-y bg-muted/30 px-4 py-3 text-sm">{feedback}</div>
      ) : null}

      {selectedQueries.length ? (
        <div className="sticky bottom-4 z-20 flex flex-col gap-3 rounded-lg border bg-background px-4 py-3 shadow-lg sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm font-medium">
            已选择 {selectedQueries.length} 个查询
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyKeywords(selectedQueries, setFeedback)}
            >
              <Copy />
              复制关键词
            </Button>
            <Button
              size="sm"
              disabled={saveMutation.isPending}
              onClick={() => saveMutation.mutate(selectedQueries)}
            >
              {saveMutation.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Save />
              )}
              保存到关键词库
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedRowIds(new Set())}
            >
              清除选择
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={sheetsDialogOpen} onOpenChange={setSheetsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>数据已复制</DialogTitle>
            <DialogDescription>
              已复制 {sheetsRowCount} 行数据。打开新的 Google
              表格后直接粘贴即可。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSheetsDialogOpen(false)}
            >
              关闭
            </Button>
            <Button
              onClick={() => {
                window.open(
                  "https://sheets.new",
                  "_blank",
                  "noopener,noreferrer"
                )
                setSheetsDialogOpen(false)
              }}
            >
              <FileSpreadsheet />
              打开 Google 表格
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )

  function toggleStrikingSort(next: SortKey) {
    if (strikingSortKey === next) {
      setStrikingSortDirection((current) =>
        current === "desc" ? "asc" : "desc"
      )
      return
    }
    setStrikingSortKey(next)
    setStrikingSortDirection("desc")
  }

  function toggleDimensionSort(next: SortKey) {
    if (dimensionSortKey === next) {
      setDimensionSortDirection((current) =>
        current === "desc" ? "asc" : "desc"
      )
      return
    }
    setDimensionSortKey(next)
    setDimensionSortDirection("desc")
  }

  function resetPaging() {
    setTablePage(1)
    setStrikingPage(1)
  }
}

function PerformanceTotals({ report }: { report: GSCPerformanceReport }) {
  const items: Array<{
    label: string
    value: string
    delta: { text: string; improved: boolean } | null
  }> = [
    {
      label: "总点击",
      value: formatCount(report.totals.clicks),
      delta: percentDelta(report.totals.clicks, report.previousTotals.clicks),
    },
    {
      label: "总曝光",
      value: formatCount(report.totals.impressions),
      delta: percentDelta(
        report.totals.impressions,
        report.previousTotals.impressions
      ),
    },
    {
      label: "平均 CTR",
      value: formatCtr(report.totals.ctr),
      delta: percentDelta(report.totals.ctr, report.previousTotals.ctr),
    },
    {
      label: "平均排名",
      value: formatPosition(report.totals.position),
      delta: positionDelta(
        report.totals.position,
        report.previousTotals.position
      ),
    },
  ]
  const title = `对比 ${report.range.previousStartDate} 至 ${report.range.previousEndDate}`
  return (
    <dl className="grid border-y sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item, index) => (
        <div
          key={item.label}
          className={`px-4 py-4 ${index ? "border-t sm:border-t-0 sm:border-l" : ""}`}
        >
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="mt-1 flex items-baseline gap-2">
            <span className="text-xl font-semibold tabular-nums">
              {item.value}
            </span>
            {item.delta ? (
              <span
                className={`text-xs font-medium ${
                  item.delta.improved ? "text-emerald-600" : "text-destructive"
                }`}
                title={title}
              >
                {item.delta.text}
              </span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function DimensionTable({
  rows,
  keyLabel,
  sortKey,
  sortDirection,
  onSort,
}: {
  rows: GSCPerformanceRow[]
  keyLabel: string
  sortKey: SortKey
  sortDirection: SortDirection
  onSort: (key: SortKey) => void
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-72">{keyLabel}</TableHead>
            <SortableHead
              label="点击"
              value="clicks"
              active={sortKey}
              direction={sortDirection}
              onSort={onSort}
            />
            <SortableHead
              label="曝光"
              value="impressions"
              active={sortKey}
              direction={sortDirection}
              onSort={onSort}
            />
            <SortableHead
              label="CTR"
              value="ctr"
              active={sortKey}
              direction={sortDirection}
              onSort={onSort}
            />
            <SortableHead
              label="平均排名"
              value="position"
              active={sortKey}
              direction={sortDirection}
              onSort={onSort}
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length ? (
            rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell className="max-w-xl font-medium">
                  <span className="block truncate" title={row.key}>
                    {row.key}
                  </span>
                </TableCell>
                <MetricCell value={formatCount(row.clicks)} />
                <MetricCell value={formatCount(row.impressions)} />
                <MetricCell value={formatCtr(row.ctr)} />
                <MetricCell value={formatPosition(row.position)} />
              </TableRow>
            ))
          ) : (
            <EmptyTable
              colSpan={5}
              message="当前时间范围还没有数据，Search Console 数据通常会延迟几天"
            />
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function StrikingSelectionCheckbox({
  ariaLabel,
  checked,
  onCheckedChange,
  onShiftRange,
}: {
  ariaLabel: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  onShiftRange: (event: React.MouseEvent<HTMLElement>) => boolean
}) {
  const rangeHandled = React.useRef(false)
  return (
    <Checkbox
      aria-label={ariaLabel}
      checked={checked}
      onClick={(event) => {
        event.stopPropagation()
        rangeHandled.current = onShiftRange(event)
      }}
      onCheckedChange={(nextChecked) => {
        if (rangeHandled.current) {
          rangeHandled.current = false
          return
        }
        onCheckedChange(Boolean(nextChecked))
      }}
    />
  )
}

function applyShiftRangeSelection(
  event: React.MouseEvent<HTMLElement>,
  id: string,
  visibleRows: GSCStrikingDistanceRow[],
  selectedRowIds: Set<string>,
  anchorRef: React.MutableRefObject<{
    id: string
    selected: boolean
  } | null>,
  setSelectedRowIds: React.Dispatch<React.SetStateAction<Set<string>>>
): boolean {
  if (!event.shiftKey || !anchorRef.current) {
    anchorRef.current = {
      id,
      selected: !selectedRowIds.has(id),
    }
    return false
  }

  const anchorIndex = visibleRows.findIndex(
    (row) => strikingRowId(row) === anchorRef.current?.id
  )
  const currentIndex = visibleRows.findIndex((row) => strikingRowId(row) === id)
  if (anchorIndex === -1 || currentIndex === -1) {
    anchorRef.current = {
      id,
      selected: !selectedRowIds.has(id),
    }
    return false
  }

  event.preventDefault()
  const from = Math.min(anchorIndex, currentIndex)
  const to = Math.max(anchorIndex, currentIndex)
  const selected = anchorRef.current.selected
  setSelectedRowIds((current) => {
    const next = new Set(current)
    for (let index = from; index <= to; index += 1) {
      const rangeRow = visibleRows[index]
      if (!rangeRow) continue
      const rangeId = strikingRowId(rangeRow)
      if (selected) next.add(rangeId)
      else next.delete(rangeId)
    }
    return next
  })
  anchorRef.current = { id, selected }
  return true
}

function strikingRowId(row: GSCStrikingDistanceRow): string {
  return `${row.query}::${row.page}`
}

function SortableHead({
  label,
  value,
  active,
  direction,
  onSort,
}: {
  label: string
  value: SortKey
  active: SortKey
  direction: SortDirection
  onSort: (key: SortKey) => void
}) {
  const Icon =
    active === value
      ? direction === "desc"
        ? ArrowDown
        : ArrowUp
      : ArrowUpDown
  return (
    <TableHead className="text-right">
      <Button
        variant="ghost"
        size="sm"
        className="-mr-3 ml-auto"
        onClick={() => onSort(value)}
      >
        {label}
        <Icon />
      </Button>
    </TableHead>
  )
}

function MetricCell({ value }: { value: string }) {
  return <TableCell className="text-right tabular-nums">{value}</TableCell>
}

function EmptyTable({
  colSpan,
  message,
}: {
  colSpan: number
  message: string
}) {
  return (
    <TableRow>
      <TableCell
        colSpan={colSpan}
        className="h-40 text-center text-muted-foreground"
      >
        {message}
      </TableCell>
    </TableRow>
  )
}

function FilterSelect({
  ariaLabel,
  value,
  onValueChange,
  options,
}: {
  ariaLabel: string
  value: string
  onValueChange: (value: string) => void
  options: Array<[string, string]>
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next ?? value)}
    >
      <SelectTrigger size="sm" aria-label={ariaLabel}>
        <SelectValue>
          {options.find(([option]) => option === value)?.[1] ?? value}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map(([option, label]) => (
          <SelectItem key={option} value={option}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SearchPerformanceLoading() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="space-y-2 border px-4 py-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </div>
      <Card className="gap-3 p-4">
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 7 }).map((_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </Card>
    </div>
  )
}

function SearchPerformanceHeader({
  projectId,
  connected,
}: {
  projectId: string
  connected: boolean
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 className="text-lg font-semibold">Google 搜索表现</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          查看网站在 Google Search Console 中的点击、曝光、CTR 和平均排名。
        </p>
      </div>
      {connected ? (
        <Button
          variant="link"
          size="sm"
          className="shrink-0 self-start"
          nativeButton={false}
          render={<a href={gscSettingsHref(projectId)} />}
        >
          切换 Property
        </Button>
      ) : null}
    </div>
  )
}

function SearchPerformanceError({
  message,
  compact = false,
}: {
  message: string
  compact?: boolean
}) {
  return (
    <div className={compact ? "p-6" : "border-y px-4 py-8"}>
      <p className="text-sm text-destructive">{message}</p>
    </div>
  )
}

function sortedRows<T extends Partial<GSCPerformanceMetrics>>(
  rows: T[],
  key: SortKey,
  direction: SortDirection
): T[] {
  const multiplier = direction === "desc" ? -1 : 1
  return [...rows].sort(
    (left, right) =>
      ((Number(left[key]) || 0) - (Number(right[key]) || 0)) * multiplier
  )
}

function retryGSCQuery(failureCount: number, error: Error): boolean {
  return (
    !(error instanceof ApiError && error.status === 409) && failureCount < 1
  )
}

function formatPaginationRange(
  page: number,
  pageSize: number,
  totalCount: number | null
): string {
  const start = (page - 1) * pageSize + 1
  if (totalCount === null) {
    return `${start.toLocaleString()}–${(start + pageSize - 1).toLocaleString()}`
  }
  if (totalCount === 0) return "0"
  const end = Math.min(totalCount, start + pageSize - 1)
  return `${start.toLocaleString()}–${end.toLocaleString()}，共 ${totalCount.toLocaleString()}`
}

function percentDelta(current: number, previous: number) {
  if (previous <= 0) return null
  const change = (current - previous) / previous
  return {
    text: `${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}%`,
    improved: change >= 0,
  }
}

function positionDelta(current: number, previous: number) {
  if (previous <= 0 || current <= 0) return null
  const change = previous - current
  return {
    text: `${change >= 0 ? "+" : ""}${change.toFixed(1)}`,
    improved: change >= 0,
  }
}

function formatCount(value: number) {
  return new Intl.NumberFormat("zh-CN").format(Math.round(value))
}

function formatCtr(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function formatPosition(value: number) {
  return value.toFixed(1)
}

function safeHttpUrl(value: string) {
  return /^https?:\/\//i.test(value)
}

function gscSettingsHref(projectId: string) {
  const returnTo = `/projects/${projectId}/keywords/search-performance`
  return `/projects/${encodeURIComponent(projectId)}/settings/data-sources?returnTo=${encodeURIComponent(returnTo)}#google-search-console`
}

async function copyKeywords(
  keywords: string[],
  setFeedback: (message: string) => void
) {
  try {
    await navigator.clipboard.writeText(
      keywords.map((keyword) => normalizeExportValue(keyword)).join("\n")
    )
    setFeedback(`已复制 ${keywords.length} 个关键词`)
  } catch {
    setFeedback("复制失败，请检查浏览器的剪贴板权限")
  }
}

type ExportTable = {
  filename: string
  headers: string[]
  rows: GSCExportValue[][]
}

function exportTable(
  tab: PerformanceTab,
  rows: GSCPerformanceRow[] | GSCStrikingDistanceRow[],
  report: GSCPerformanceReport
): ExportTable {
  const stamp = `${report.range.startDate}-to-${report.range.endDate}`
  if (tab === "striking") {
    return {
      filename: `search-performance-striking-distance-${stamp}.csv`,
      headers: ["查询", "页面", "曝光", "点击", "平均排名"],
      rows: (rows as GSCStrikingDistanceRow[]).map((row) => [
        row.query,
        row.page,
        row.impressions,
        row.clicks,
        row.position,
      ]),
    }
  }
  return {
    filename: `search-performance-${tab}-${stamp}.csv`,
    headers: [
      tab === "pages" ? "页面" : "查询",
      "点击",
      "曝光",
      "CTR",
      "平均排名",
    ],
    rows: (rows as GSCPerformanceRow[]).map((row) => [
      row.key,
      row.clicks,
      row.impressions,
      row.ctr,
      row.position,
    ]),
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}
