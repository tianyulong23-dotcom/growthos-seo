import * as React from "react"
import {
  BookOpenText,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  ExternalLink,
  List,
  LoaderCircle,
  Plus,
  Search,
  SlidersHorizontal,
  XCircle,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
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
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
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
  title: string
  primaryKeyword: string
  writingDirection: string
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
    title: "How the 2026 Solar Tax Credit Works",
    primaryKeyword: "solar tax credit 2026",
    writingDirection:
      "解释 2026 年税收抵免的适用条件、申请步骤和常见误区，帮助屋主判断自己可以节省多少。",
    targetPublishDate: "2026-08-04",
    plannedGenerationDate: "2026-08-02",
    status: "triggered",
    article: { id: "article-1", state: "running", progress: 45 },
  },
  {
    id: "plan-2",
    title: "Solar Battery Payback Period: Cost, Savings and ROI",
    primaryKeyword: "solar battery payback",
    writingDirection:
      "从电池价格、电价峰谷差和停电备用价值三个方面，计算不同家庭的典型回本周期。",
    targetPublishDate: "2026-08-06",
    plannedGenerationDate: "2026-08-04",
    status: "scheduled",
  },
  {
    id: "plan-3",
    title: "SolarEdge vs Enphase: Which Inverter Is Better?",
    primaryKeyword: "solaredge vs enphase",
    writingDirection:
      "对比两种逆变器方案的可靠性、监控能力、保修和适用屋顶类型，给出清晰的选择建议。",
    targetPublishDate: "2026-08-11",
    plannedGenerationDate: "2026-08-09",
    status: "triggered",
    article: { id: "article-2", state: "completed", progress: 100 },
  },
  {
    id: "plan-4",
    title: "Solar Panel Costs by State in 2026",
    primaryKeyword: "solar panel cost by state",
    writingDirection:
      "按州比较安装价格、电价和主要激励政策，并说明为什么相同规模系统的报价差异很大。",
    targetPublishDate: "2026-08-13",
    plannedGenerationDate: "2026-08-11",
    status: "scheduled",
  },
  {
    id: "plan-5",
    title: "How Long Do Solar Panels Last?",
    primaryKeyword: "how long do solar panels last",
    writingDirection:
      "说明组件寿命、年度衰减、保修期限和需要更换的信号，让用户理解寿命不等于保修期。",
    targetPublishDate: "2026-08-18",
    plannedGenerationDate: "2026-08-16",
    status: "scheduled",
  },
  {
    id: "plan-6",
    title: "Best Solar Companies in Florida",
    primaryKeyword: "best solar companies florida",
    writingDirection:
      "基于服务区域、安装经验、保修和客户支持建立筛选标准，再帮助用户比较佛州安装商。",
    targetPublishDate: "2026-08-27",
    plannedGenerationDate: "2026-08-25",
    status: "scheduled",
  },
  {
    id: "plan-7",
    title: "Solar Inverter Replacement Cost Guide",
    primaryKeyword: "solar inverter replacement cost",
    writingDirection:
      "拆分设备、人工和停机成本，比较组串逆变器、微型逆变器的更换方式与费用。",
    targetPublishDate: "2026-08-20",
    plannedGenerationDate: "2026-08-18",
    status: "scheduled",
  },
  {
    id: "plan-8",
    title: "The Complete Solar Panel Maintenance Checklist",
    primaryKeyword: "solar panel maintenance checklist",
    writingDirection:
      "按月度、季度和年度整理维护动作，区分屋主可以完成的检查与需要专业人员处理的问题。",
    targetPublishDate: "2026-08-25",
    plannedGenerationDate: "2026-08-23",
    status: "scheduled",
  },
  {
    id: "plan-9",
    title: "Solar Panel Warranties Explained",
    primaryKeyword: "solar warranty explained",
    writingDirection:
      "解释产品、性能、安装和工艺保修的区别，并列出用户比较保修条款时需要检查的细节。",
    targetPublishDate: "2026-08-31",
    plannedGenerationDate: "2026-08-29",
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
  const variant =
    item.status === "cancelled"
      ? "ghost"
      : item.article?.state === "running"
        ? "default"
        : item.article?.state === "completed"
          ? "secondary"
          : "outline"

  const StatusIcon =
    item.status === "cancelled"
      ? XCircle
      : item.article?.state === "running"
        ? LoaderCircle
        : item.article?.state === "completed"
          ? CheckCircle2
          : Clock3

  return (
    <Badge variant={variant}>
      <StatusIcon />
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
  const StatusIcon =
    item.status === "cancelled"
      ? XCircle
      : item.article?.state === "running"
        ? LoaderCircle
        : item.article?.state === "completed"
          ? CheckCircle2
          : Clock3

  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onClick}
      aria-label={`${item.title}，主关键词 ${item.primaryKeyword}，${articleSummary(item) ?? planStatusLabel(item)}`}
      className="h-auto w-full min-w-0 items-start justify-start gap-1.5 px-1.5 py-1.5 text-left"
    >
      <StatusIcon className="mt-0.5 size-3 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-xs leading-4 font-medium whitespace-normal">
          {item.title}
        </span>
        <span className="mt-0.5 block truncate text-[10px] leading-4 font-normal text-muted-foreground">
          {item.primaryKeyword}
        </span>
        {!compact && (
          <span className="mt-1 block truncate text-[11px] font-normal text-muted-foreground">
            {articleSummary(item) ?? planStatusLabel(item)}
          </span>
        )}
      </span>
    </Button>
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
  const [addOpen, setAddOpen] = React.useState(false)
  const [rhythmOpen, setRhythmOpen] = React.useState(false)
  const [selectedPlanId, setSelectedPlanId] = React.useState<string | null>(
    null
  )
  const [writingDirectionOpen, setWritingDirectionOpen] = React.useState(false)
  const [dateError, setDateError] = React.useState("")
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
    const query = search.trim().toLocaleLowerCase()
    const matchesSearch = [plan.title, plan.primaryKeyword].some((value) =>
      value.toLocaleLowerCase().includes(query)
    )
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

  function openRhythm() {
    setDraftRhythm(rhythm)
    setRhythmOpen(true)
  }

  function openAddAt(date: Date) {
    const key = dateKey(date)
    const occupied = plans.some(
      (plan) => plan.status !== "cancelled" && plan.targetPublishDate === key
    )
    if (occupied) return
    setStartDate(key)
    setAddOpen(true)
  }

  function openPlan(planId: string) {
    setWritingDirectionOpen(false)
    setDateError("")
    setSelectedPlanId(planId)
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
        title: primaryKeyword,
        primaryKeyword,
        writingDirection:
          "围绕主关键词回答用户的核心问题，并提供清晰、可执行的选择建议。",
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

  function updateSelectedPlanDate(value: string) {
    if (!selectedPlanId) return
    const occupied = plans.some(
      (plan) =>
        plan.id !== selectedPlanId &&
        plan.status !== "cancelled" &&
        plan.targetPublishDate === value
    )
    if (occupied) {
      setDateError("该日期已有一篇文章计划，请选择其他日期。")
      return
    }
    setDateError("")
    updateSelectedPlan({
      targetPublishDate: value,
      plannedGenerationDate: addDays(value, -rhythm.leadDays),
    })
  }

  const today = dateKey(new Date())
  return (
    <Card className="@container/content-plan gap-0 overflow-hidden py-0">
      <CardHeader className="border-b py-4">
        <div className="flex flex-col gap-3 @min-[32rem]/content-plan:flex-row @min-[32rem]/content-plan:items-center @min-[32rem]/content-plan:justify-between">
          <div className="flex min-w-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => moveMonth(-1)}
              title="上个月"
              aria-label="上个月"
            >
              <ChevronLeft />
            </Button>
            <Button variant="ghost" className="px-2" onClick={goToToday}>
              <span className="min-w-24 text-center text-base font-semibold tabular-nums">
                {formatMonth(month)}
              </span>
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => moveMonth(1)}
              title="下个月"
              aria-label="下个月"
            >
              <ChevronRight />
            </Button>
            <Button variant="ghost" size="sm" onClick={goToToday}>
              今天
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Tabs value={view} onValueChange={(value) => setView(value)}>
              <TabsList>
                <TabsTrigger value="calendar" aria-label="月历" title="月历">
                  <CalendarDays />
                  <span className="hidden sm:inline">月历</span>
                </TabsTrigger>
                <TabsTrigger value="list" aria-label="列表" title="列表">
                  <List />
                  <span className="hidden sm:inline">列表</span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              variant="outline"
              onClick={openRhythm}
              aria-label="发布频率"
              title="发布频率"
            >
              <SlidersHorizontal />
              <span className="hidden @min-[52rem]/content-plan:inline">
                发布频率
              </span>
            </Button>
          </div>
        </div>
      </CardHeader>

      {view === "list" && (
        <div className="flex flex-col gap-3 border-b px-6 py-4 sm:flex-row sm:items-center">
          <InputGroup className="sm:max-w-sm">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索标题或主关键词"
            />
          </InputGroup>
          <Select
            value={filter}
            onValueChange={(value) => setFilter((value ?? "all") as PlanFilter)}
          >
            <SelectTrigger className="w-full sm:w-36">
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

      <CardContent className="px-0">
        {view === "calendar" ? (
          <>
            <div className="hidden @min-[32rem]/content-plan:block">
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
                  const datePlan = datePlans[0]
                  const currentMonth = date.getMonth() === month.getMonth()
                  const isSlot =
                    rhythm.enabled && rhythm.weekdays.includes(date.getDay())
                  return (
                    <div
                      key={key}
                      className={cn(
                        "group min-h-32 min-w-0 bg-background p-1 @min-[48rem]/content-plan:min-h-36 @min-[48rem]/content-plan:p-1.5",
                        !currentMonth && "bg-muted/25 text-muted-foreground"
                      )}
                    >
                      <div className="mb-1 flex h-6 items-center justify-between px-0.5 text-xs tabular-nums @min-[48rem]/content-plan:px-1">
                        <span
                          className={cn(
                            "inline-flex size-6 items-center justify-center font-medium",
                            key === today &&
                              "rounded-full bg-primary text-primary-foreground"
                          )}
                        >
                          {date.getDate()}
                        </span>
                        {currentMonth && !datePlan && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => openAddAt(date)}
                            className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label={`在${formatShortDate(key)}添加计划`}
                            title="添加计划"
                          >
                            <Plus />
                          </Button>
                        )}
                      </div>
                      {datePlan && (
                        <PlanItemButton
                          item={datePlan}
                          compact
                          onClick={() => openPlan(datePlan.id)}
                        />
                      )}
                      {!datePlan && currentMonth && isSlot && (
                        <Button
                          variant="outline"
                          size="xs"
                          onClick={() => openAddAt(date)}
                          className="w-full justify-start border-dashed text-muted-foreground"
                        >
                          <Plus />
                          添加计划
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="@min-[32rem]/content-plan:hidden">
              <div>
                {slots.map((date) => {
                  const key = dateKey(date)
                  const datePlan = plansForDate(key)[0]
                  return (
                    <div
                      key={key}
                      className="grid min-h-24 grid-cols-[4.5rem_1fr] border-b last:border-b-0"
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
                        {datePlan ? (
                          <PlanItemButton
                            item={datePlan}
                            onClick={() => openPlan(datePlan.id)}
                          />
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start text-muted-foreground"
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
                        <div>{item.title}</div>
                        <div className="mt-1 text-xs font-normal text-muted-foreground">
                          {item.primaryKeyword}
                        </div>
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
                            <div className="text-xs">
                              {articleSummary(item)}
                            </div>
                            {item.article.state === "running" && (
                              <Progress
                                value={item.article.progress}
                                className="mt-1.5 h-1"
                              />
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">
                            尚未创建
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="查看计划"
                          onClick={() => openPlan(item.id)}
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
      </CardContent>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
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
            <label className="flex items-center justify-between gap-4">
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
            <Separator />
            <fieldset className="grid gap-3" disabled={!draftRhythm.enabled}>
              <legend className="mb-1 text-sm font-medium">目标上稿日</legend>
              <Card size="sm" className="gap-0 py-0 shadow-none">
                {[1, 2, 3, 4, 5].map((day) => (
                  <label
                    key={day}
                    className="flex min-h-11 items-center gap-3 border-b px-4 last:border-b-0"
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
              </Card>
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
            <Card size="sm" className="bg-muted/30 shadow-none">
              <CardContent className="text-xs leading-5 text-muted-foreground">
                当前规则预计每周安排 {draftRhythm.weekdays.length}{" "}
                篇，每个目标上稿日最多安排一篇。标题和简单写作方向可在计划阶段查看，完整文章结构会在生成时确定。
              </CardContent>
            </Card>
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
                  查看计划标题、主关键词和目标上稿时间。
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-5 overflow-y-auto px-6 pb-6">
                <Card size="sm" className="shadow-none">
                  <CardContent className="space-y-4">
                    <div>
                      <div className="text-xs text-muted-foreground">标题</div>
                      <div className="mt-1 text-lg leading-6 font-semibold break-words">
                        {selectedPlan.title}
                      </div>
                    </div>
                    <Separator />
                    <div>
                      <div className="text-xs text-muted-foreground">
                        主关键词
                      </div>
                      <div className="mt-1 text-sm font-medium break-words">
                        {selectedPlan.primaryKeyword}
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card size="sm" className="gap-0 py-0 shadow-none">
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setWritingDirectionOpen((current) => !current)
                    }
                    aria-expanded={writingDirectionOpen}
                    className="h-12 w-full justify-start rounded-none px-4"
                  >
                    <BookOpenText />
                    简单写作方向
                    {writingDirectionOpen ? (
                      <ChevronUp className="ml-auto" />
                    ) : (
                      <ChevronDown className="ml-auto" />
                    )}
                  </Button>
                  {writingDirectionOpen && (
                    <CardContent className="border-t py-4 text-sm leading-6 text-muted-foreground">
                      {selectedPlan.writingDirection}
                    </CardContent>
                  )}
                </Card>
                <label className="grid gap-2 text-sm">
                  <span className="font-medium">目标上稿日期</span>
                  <Input
                    type="date"
                    value={selectedPlan.targetPublishDate}
                    aria-invalid={Boolean(dateError)}
                    onInput={(event) =>
                      updateSelectedPlanDate(event.currentTarget.value)
                    }
                    onChange={(event) =>
                      updateSelectedPlanDate(event.target.value)
                    }
                    onBlur={(event) =>
                      updateSelectedPlanDate(event.currentTarget.value)
                    }
                  />
                  {dateError && (
                    <span className="text-xs text-destructive">
                      {dateError}
                    </span>
                  )}
                </label>
                <Card size="sm" className="shadow-none">
                  <CardContent className="grid grid-cols-2 gap-4">
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
                  </CardContent>
                </Card>
                {selectedPlan.article ? (
                  <Card size="sm" className="gap-3 py-4 shadow-none">
                    <CardContent>
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
                          onClick={() =>
                            onOpenArticle(selectedPlan.article!.id)
                          }
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
                    </CardContent>
                  </Card>
                ) : (
                  <Card
                    size="sm"
                    className="border border-dashed py-4 shadow-none ring-0"
                  >
                    <CardContent className="text-sm text-muted-foreground">
                      尚未创建文章任务。到预计生成时间后，系统才会根据主关键词开始文章流程。
                    </CardContent>
                  </Card>
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
    </Card>
  )
}
