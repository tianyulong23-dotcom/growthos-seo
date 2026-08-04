import * as React from "react"
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  List,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

type PlanStatus = "scheduled" | "triggered" | "cancelled"

type LinkedArticle = {
  id: string
  state: "running" | "completed"
  progress: number
}

type ContentPlanItem = {
  id: string
  primaryKeyword: string
  targetPublishDate: string
  plannedGenerationDate: string
  status: PlanStatus
  article?: LinkedArticle
}

type Rhythm = {
  enabled: boolean
  weekdays: number[]
  leadDays: number
}

type PlanFilter = "all" | "waiting" | "running" | "completed"

const weekdayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
const calendarWeekdays = [
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
  "周日",
]

const initialPlans: ContentPlanItem[] = [
  {
    id: "plan-1",
    primaryKeyword: "solar tax credit 2026",
    targetPublishDate: "2026-08-04",
    plannedGenerationDate: "2026-08-02",
    status: "triggered",
    article: { id: "article-1", state: "running", progress: 45 },
  },
  {
    id: "plan-2",
    primaryKeyword: "solar battery payback",
    targetPublishDate: "2026-08-06",
    plannedGenerationDate: "2026-08-04",
    status: "scheduled",
  },
  {
    id: "plan-3",
    primaryKeyword: "solaredge vs enphase",
    targetPublishDate: "2026-08-11",
    plannedGenerationDate: "2026-08-09",
    status: "triggered",
    article: { id: "article-2", state: "completed", progress: 100 },
  },
  {
    id: "plan-4",
    primaryKeyword: "solar panel cost by state",
    targetPublishDate: "2026-08-13",
    plannedGenerationDate: "2026-08-11",
    status: "scheduled",
  },
  {
    id: "plan-5",
    primaryKeyword: "how long do solar panels last",
    targetPublishDate: "2026-08-18",
    plannedGenerationDate: "2026-08-16",
    status: "scheduled",
  },
  {
    id: "plan-6",
    primaryKeyword: "best solar companies florida",
    targetPublishDate: "2026-08-27",
    plannedGenerationDate: "2026-08-25",
    status: "scheduled",
  },
  {
    id: "plan-7",
    primaryKeyword: "solar inverter replacement cost",
    targetPublishDate: "2026-08-11",
    plannedGenerationDate: "2026-08-09",
    status: "scheduled",
  },
  {
    id: "plan-8",
    primaryKeyword: "solar panel maintenance checklist",
    targetPublishDate: "2026-08-11",
    plannedGenerationDate: "2026-08-09",
    status: "scheduled",
  },
  {
    id: "plan-9",
    primaryKeyword: "solar warranty explained",
    targetPublishDate: "2026-08-11",
    plannedGenerationDate: "2026-08-09",
    status: "scheduled",
  },
]

function dateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year, month - 1, day)
}

function addDays(value: string, amount: number) {
  const date = parseDate(value)
  date.setDate(date.getDate() + amount)
  return dateKey(date)
}

function formatMonth(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
  }).format(date)
}

function formatShortDate(value: string, showWeekday = false) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    weekday: showWeekday ? "short" : undefined,
  }).format(parseDate(value))
}

function monthCells(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const mondayOffset = (first.getDay() + 6) % 7
  const start = new Date(first)
  start.setDate(first.getDate() - mondayOffset)
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    return date
  })
}

function monthSlotDates(month: Date, weekdays: number[]) {
  const dates: Date[] = []
  const cursor = new Date(month.getFullYear(), month.getMonth(), 1)
  while (cursor.getMonth() === month.getMonth()) {
    if (weekdays.includes(cursor.getDay())) dates.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return dates
}

function planStatusLabel(item: ContentPlanItem) {
  if (item.status === "cancelled") return "已取消"
  if (item.article?.state === "completed") return "已完成"
  if (item.article?.state === "running") return "生成中"
  return "待生成"
}

function articleSummary(item: ContentPlanItem) {
  if (!item.article) return null
  return item.article.state === "completed"
    ? "文章已完成"
    : `文章生成中 ${item.article.progress}%`
}

function PlanBadge({ item }: { item: ContentPlanItem }) {
  const className =
    item.status === "cancelled"
      ? "border-border bg-muted text-muted-foreground"
      : item.article?.state === "completed"
        ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
        : item.status === "triggered"
          ? "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300"
          : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"

  return (
    <Badge variant="outline" className={className}>
      {planStatusLabel(item)}
    </Badge>
  )
}

function PlanItemButton({
  item,
  compact = false,
  onClick,
}: {
  item: ContentPlanItem
  compact?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${item.primaryKeyword}，${articleSummary(item) ?? planStatusLabel(item)}`}
      className={cn(
        "w-full rounded-sm border border-transparent bg-muted/45 px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            item.article?.state === "completed"
              ? "bg-emerald-500"
              : item.status === "triggered"
                ? "bg-sky-500"
                : "bg-amber-500"
          )}
        />
        <span className="block min-w-0 truncate text-[13px] font-medium">
          {item.primaryKeyword}
        </span>
      </span>
      {!compact && (
        <span className="mt-1 block truncate pl-3.5 text-[11px] text-muted-foreground">
          {articleSummary(item) ?? planStatusLabel(item)}
        </span>
      )}
    </button>
  )
}

type ContentPlanProps = {
  addRequestVersion: number
  onOpenArticle: (articleId: string) => void
}

export function ContentPlan({
  addRequestVersion,
  onOpenArticle,
}: ContentPlanProps) {
  const [plans, setPlans] = React.useState(initialPlans)
  const [month, setMonth] = React.useState(new Date(2026, 7, 1))
  const [view, setView] = React.useState("calendar")
  const [search, setSearch] = React.useState("")
  const [filter, setFilter] = React.useState<PlanFilter>("all")
  const [expandedDates, setExpandedDates] = React.useState<string[]>([])
  const [addOpen, setAddOpen] = React.useState(false)
  const [rhythmOpen, setRhythmOpen] = React.useState(false)
  const [selectedPlanId, setSelectedPlanId] = React.useState<string | null>(
    null
  )
  const [keywords, setKeywords] = React.useState("")
  const [startDate, setStartDate] = React.useState("2026-08-20")
  const [rhythm, setRhythm] = React.useState<Rhythm>({
    enabled: true,
    weekdays: [2, 4],
    leadDays: 2,
  })
  const [draftRhythm, setDraftRhythm] = React.useState(rhythm)
  const previousRequestVersion = React.useRef(addRequestVersion)

  React.useEffect(() => {
    if (previousRequestVersion.current !== addRequestVersion) {
      previousRequestVersion.current = addRequestVersion
      setAddOpen(true)
    }
  }, [addRequestVersion])

  const monthPlans = plans.filter((plan) => {
    const date = parseDate(plan.targetPublishDate)
    return (
      date.getFullYear() === month.getFullYear() &&
      date.getMonth() === month.getMonth() &&
      plan.status !== "cancelled"
    )
  })
  const slots = monthSlotDates(month, rhythm.weekdays)
  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId) ?? null
  const visiblePlans = monthPlans.filter((plan) => {
    const matchesSearch = plan.primaryKeyword
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase())
    const matchesFilter =
      filter === "all" ||
      (filter === "waiting" && !plan.article) ||
      (filter === "running" && plan.article?.state === "running") ||
      (filter === "completed" && plan.article?.state === "completed")
    return matchesSearch && matchesFilter
  })

  function moveMonth(amount: number) {
    setMonth(
      (current) =>
        new Date(current.getFullYear(), current.getMonth() + amount, 1)
    )
  }

  function goToToday() {
    const now = new Date()
    setMonth(new Date(now.getFullYear(), now.getMonth(), 1))
  }

  function plansForDate(value: string) {
    return monthPlans.filter((plan) => plan.targetPublishDate === value)
  }

  function toggleExpandedDate(value: string) {
    setExpandedDates((current) =>
      current.includes(value)
        ? current.filter((date) => date !== value)
        : [...current, value]
    )
  }

  function openRhythm() {
    setDraftRhythm(rhythm)
    setRhythmOpen(true)
  }

  function openAddAt(date: Date) {
    setStartDate(dateKey(date))
    setAddOpen(true)
  }

  function addKeywords(event: React.FormEvent) {
    event.preventDefault()
    const values = keywords
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)
    if (values.length === 0) return

    const usedDates = new Set(
      plans
        .filter((plan) => plan.status !== "cancelled")
        .map((plan) => plan.targetPublishDate)
    )
    const additions: ContentPlanItem[] = []
    const cursor = parseDate(startDate)

    for (const [index, primaryKeyword] of values.entries()) {
      while (
        usedDates.has(dateKey(cursor)) ||
        (rhythm.enabled && !rhythm.weekdays.includes(cursor.getDay()))
      ) {
        cursor.setDate(cursor.getDate() + 1)
      }
      const targetPublishDate = dateKey(cursor)
      usedDates.add(targetPublishDate)
      additions.push({
        id: `plan-${Date.now()}-${index}`,
        primaryKeyword,
        targetPublishDate,
        plannedGenerationDate: addDays(targetPublishDate, -rhythm.leadDays),
        status: "scheduled",
      })
      cursor.setDate(cursor.getDate() + 1)
    }

    setPlans((current) => [...current, ...additions])
    setMonth(new Date(cursor.getFullYear(), cursor.getMonth(), 1))
    setKeywords("")
    setAddOpen(false)
  }

  function updateSelectedPlan(changes: Partial<ContentPlanItem>) {
    if (!selectedPlanId) return
    setPlans((current) =>
      current.map((plan) =>
        plan.id === selectedPlanId ? { ...plan, ...changes } : plan
      )
    )
  }

  const today = dateKey(new Date())
  return (
    <div className="@container/content-plan overflow-hidden rounded-md border bg-background">
      <div className="flex min-h-16 flex-col gap-3 border-b px-3 py-3 @min-[46rem]/content-plan:flex-row @min-[46rem]/content-plan:items-center @min-[46rem]/content-plan:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => moveMonth(-1)}
            title="上个月"
            aria-label="上个月"
            className="rounded-md"
          >
            <ChevronLeft />
          </Button>
          <h2 className="min-w-30 px-1 text-center text-xl font-semibold tabular-nums sm:min-w-36 sm:text-2xl">
            {formatMonth(month)}
          </h2>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => moveMonth(1)}
            title="下个月"
            aria-label="下个月"
            className="rounded-md"
          >
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="ml-1 rounded-md"
            onClick={goToToday}
          >
            今天
          </Button>
        </div>

        <div className="flex min-w-0 items-center justify-between gap-2 sm:justify-end">
          <Tabs value={view} onValueChange={(value) => setView(value)}>
            <TabsList className="h-8 rounded-md p-0.5">
              <TabsTrigger
                value="calendar"
                className="rounded-sm px-2.5"
                aria-label="月历"
                title="月历"
              >
                <CalendarDays />
                <span className="hidden sm:inline">月历</span>
              </TabsTrigger>
              <TabsTrigger
                value="list"
                className="rounded-sm px-2.5"
                aria-label="列表"
                title="列表"
              >
                <List />
                <span className="hidden sm:inline">列表</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            variant="outline"
            size="sm"
            className="rounded-md"
            onClick={openRhythm}
            title="发布频率"
          >
            <SlidersHorizontal />
            发布频率
          </Button>
        </div>
      </div>

      {view === "list" && (
        <div className="flex flex-col gap-2 border-b bg-muted/15 px-3 py-2.5 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索主关键词"
              className="h-8 w-full rounded-md bg-background pl-8"
            />
          </div>
          <Select
            value={filter}
            onValueChange={(value) => setFilter((value ?? "all") as PlanFilter)}
          >
            <SelectTrigger className="h-8 w-full rounded-md bg-background sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="waiting">待生成</SelectItem>
              <SelectItem value="running">生成中</SelectItem>
              <SelectItem value="completed">已完成</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {view === "calendar" ? (
        <>
          <div className="hidden @min-[62rem]/content-plan:block">
            <div className="grid grid-cols-7 border-b bg-muted/25">
              {calendarWeekdays.map((day) => (
                <div
                  key={day}
                  className="px-2 py-2.5 text-center text-xs font-medium text-muted-foreground"
                >
                  {day}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-px bg-border/70">
              {monthCells(month).map((date) => {
                const key = dateKey(date)
                const datePlans = plansForDate(key)
                const currentMonth = date.getMonth() === month.getMonth()
                const isSlot =
                  rhythm.enabled && rhythm.weekdays.includes(date.getDay())
                const expanded = expandedDates.includes(key)
                const displayedPlans = expanded
                  ? datePlans
                  : datePlans.slice(0, 3)
                return (
                  <div
                    key={key}
                    className={cn(
                      "group min-h-32 bg-background p-1.5 xl:min-h-36",
                      !currentMonth && "bg-muted/25 text-muted-foreground"
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between px-1 text-xs tabular-nums">
                      <span
                        className={cn(
                          "inline-flex size-6 items-center justify-center font-medium",
                          key === today &&
                            "rounded-full bg-primary text-primary-foreground"
                        )}
                      >
                        {date.getDate()}
                      </span>
                      {currentMonth && (
                        <button
                          type="button"
                          onClick={() => openAddAt(date)}
                          className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                          aria-label={`在${formatShortDate(key)}添加计划`}
                          title="添加计划"
                        >
                          <Plus className="size-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="space-y-1">
                      {displayedPlans.map((item) => (
                        <PlanItemButton
                          key={item.id}
                          item={item}
                          compact
                          onClick={() => setSelectedPlanId(item.id)}
                        />
                      ))}
                    </div>
                    {datePlans.length > 3 && (
                      <button
                        type="button"
                        onClick={() => toggleExpandedDate(key)}
                        className="mt-1 w-full rounded-sm px-2 py-1 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {expanded ? "收起" : `还有 ${datePlans.length - 3} 条`}
                      </button>
                    )}
                    {datePlans.length === 0 && currentMonth && isSlot && (
                      <button
                        type="button"
                        onClick={() => openAddAt(date)}
                        className="flex h-8 w-full items-center gap-1 rounded-sm border border-dashed px-2 text-left text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        <Plus className="size-3" />
                        添加计划
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="@min-[62rem]/content-plan:hidden">
            <div className="grid @min-[42rem]/content-plan:grid-cols-2">
              {slots.map((date) => {
                const key = dateKey(date)
                const datePlans = plansForDate(key)
                return (
                  <div
                    key={key}
                    className="grid min-h-24 grid-cols-[4.25rem_1fr] border-b @min-[42rem]/content-plan:[&:nth-child(odd)]:border-r"
                  >
                    <div className="border-r bg-muted/20 px-3 py-3">
                      <div className="text-lg font-semibold tabular-nums">
                        {date.getDate()}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {weekdayLabels[date.getDay()]}
                      </div>
                    </div>
                    <div className="min-w-0 p-2">
                      {datePlans.length > 0 ? (
                        <div className="space-y-1">
                          {datePlans.map((item) => (
                            <PlanItemButton
                              key={item.id}
                              item={item}
                              onClick={() => setSelectedPlanId(item.id)}
                            />
                          ))}
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start rounded-sm text-muted-foreground"
                          onClick={() => openAddAt(date)}
                        >
                          <Plus />
                          添加计划
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>目标上稿日</TableHead>
                <TableHead>计划内容</TableHead>
                <TableHead>预计生成日</TableHead>
                <TableHead>计划状态</TableHead>
                <TableHead>关联文章</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...visiblePlans]
                .sort((a, b) =>
                  a.targetPublishDate.localeCompare(b.targetPublishDate)
                )
                .map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium whitespace-nowrap">
                      {formatShortDate(item.targetPublishDate, true)}
                    </TableCell>
                    <TableCell className="min-w-64 font-medium">
                      {item.primaryKeyword}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatShortDate(item.plannedGenerationDate)}
                    </TableCell>
                    <TableCell>
                      <PlanBadge item={item} />
                    </TableCell>
                    <TableCell>
                      {item.article ? (
                        <div className="min-w-36">
                          <div className="text-xs">{articleSummary(item)}</div>
                          {item.article.state === "running" && (
                            <Progress
                              value={item.article.progress}
                              className="mt-1.5 h-1"
                            />
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">尚未创建</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="查看计划"
                        onClick={() => setSelectedPlanId(item.id)}
                      >
                        <ChevronRight />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              {visiblePlans.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-32 text-center text-muted-foreground"
                  >
                    没有匹配的计划
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="rounded-md sm:max-w-lg">
          <form onSubmit={addKeywords} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>添加到内容计划</DialogTitle>
              <DialogDescription>
                每行输入一个主关键词，系统会按发布频率依次安排目标日期。
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-2 text-sm">
              <span className="font-medium">主关键词</span>
              <Textarea
                autoFocus
                value={keywords}
                onChange={(event) => setKeywords(event.target.value)}
                placeholder={
                  "solar installation cost\nbest solar panels for home"
                }
                className="min-h-32 resize-none"
              />
              <span className="text-xs text-muted-foreground">
                已输入{" "}
                {keywords.split("\n").filter((value) => value.trim()).length}{" "}
                个关键词
              </span>
            </label>
            <label className="grid gap-2 text-sm">
              <span className="font-medium">从哪个目标日期开始安排</span>
              <Input
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                required
              />
              <span className="text-xs text-muted-foreground">
                已有计划日期会自动跳过，不会覆盖现有计划。
              </span>
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={!keywords.trim()}>
                <Plus />
                加入计划
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Sheet open={rhythmOpen} onOpenChange={setRhythmOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="text-lg">发布频率</SheetTitle>
            <SheetDescription>
              设置每周目标上稿日，以及文章应该提前多久开始生成。
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-6 overflow-y-auto px-6 pb-6">
            <label className="flex items-center justify-between gap-4 border-b pb-5">
              <span>
                <span className="block font-medium">启用固定节奏</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  关闭后保留已有计划，不再自动安排目标日期。
                </span>
              </span>
              <Switch
                checked={draftRhythm.enabled}
                onCheckedChange={(checked) =>
                  setDraftRhythm((current) => ({
                    ...current,
                    enabled: checked,
                  }))
                }
              />
            </label>
            <fieldset className="grid gap-3" disabled={!draftRhythm.enabled}>
              <legend className="mb-1 text-sm font-medium">目标上稿日</legend>
              <div className="grid grid-cols-2 gap-2">
                {[1, 2, 3, 4, 5].map((day) => (
                  <label
                    key={day}
                    className="flex items-center gap-2 rounded-md border px-3 py-2.5 text-sm"
                  >
                    <Checkbox
                      checked={draftRhythm.weekdays.includes(day)}
                      onCheckedChange={(checked) =>
                        setDraftRhythm((current) => ({
                          ...current,
                          weekdays: checked
                            ? [...current.weekdays, day].sort()
                            : current.weekdays.filter((value) => value !== day),
                        }))
                      }
                    />
                    {weekdayLabels[day]}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="grid gap-2 text-sm">
              <span className="font-medium">提前生成</span>
              <Select
                value={String(draftRhythm.leadDays)}
                onValueChange={(value) =>
                  setDraftRhythm((current) => ({
                    ...current,
                    leadDays: Number(value ?? 2),
                  }))
                }
                disabled={!draftRhythm.enabled}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">提前 1 天</SelectItem>
                  <SelectItem value="2">提前 2 天</SelectItem>
                  <SelectItem value="3">提前 3 天</SelectItem>
                  <SelectItem value="5">提前 5 天</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <div className="border-l-2 border-primary/40 bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
              当前规则预计每周安排 {draftRhythm.weekdays.length}{" "}
              篇。标题、搜索意图和文章结构会在文章生成时确定，不会在计划阶段预填。
            </div>
          </div>
          <SheetFooter>
            <Button variant="outline" onClick={() => setRhythmOpen(false)}>
              取消
            </Button>
            <Button
              disabled={
                draftRhythm.enabled && draftRhythm.weekdays.length === 0
              }
              onClick={() => {
                setRhythm(draftRhythm)
                setRhythmOpen(false)
              }}
            >
              保存节奏
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Sheet
        open={Boolean(selectedPlan)}
        onOpenChange={(open) => !open && setSelectedPlanId(null)}
      >
        <SheetContent className="sm:max-w-md">
          {selectedPlan && (
            <>
              <SheetHeader>
                <SheetTitle className="text-lg">计划详情</SheetTitle>
                <SheetDescription>
                  计划阶段只保存生成前已经确定的信息。
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-5 overflow-y-auto px-6 pb-6">
                <div>
                  <div className="text-xs text-muted-foreground">主关键词</div>
                  <div className="mt-1 text-base font-medium break-words">
                    {selectedPlan.primaryKeyword}
                  </div>
                </div>
                <label className="grid gap-2 text-sm">
                  <span className="font-medium">目标上稿日期</span>
                  <Input
                    type="date"
                    value={selectedPlan.targetPublishDate}
                    onChange={(event) =>
                      updateSelectedPlan({
                        targetPublishDate: event.target.value,
                        plannedGenerationDate: addDays(
                          event.target.value,
                          -rhythm.leadDays
                        ),
                      })
                    }
                  />
                </label>
                <div className="grid grid-cols-2 gap-3 border-y py-4">
                  <div>
                    <div className="text-xs text-muted-foreground">
                      预计生成
                    </div>
                    <div className="mt-1 text-sm font-medium">
                      {formatShortDate(selectedPlan.plannedGenerationDate)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">
                      计划状态
                    </div>
                    <div className="mt-1">
                      <PlanBadge item={selectedPlan} />
                    </div>
                  </div>
                </div>
                {selectedPlan.article ? (
                  <div className="rounded-md border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium">关联文章</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {articleSummary(selectedPlan)}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onOpenArticle(selectedPlan.article!.id)}
                      >
                        <ExternalLink />
                        查看文章
                      </Button>
                    </div>
                    {selectedPlan.article.state === "running" && (
                      <Progress
                        value={selectedPlan.article.progress}
                        className="mt-3 h-1.5"
                      />
                    )}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    尚未创建文章任务。到预计生成时间后，系统才会根据主关键词开始文章流程。
                  </div>
                )}
              </div>
              <SheetFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    updateSelectedPlan({ status: "cancelled" })
                    setSelectedPlanId(null)
                  }}
                >
                  取消计划
                </Button>
                <Button onClick={() => setSelectedPlanId(null)}>完成</Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
