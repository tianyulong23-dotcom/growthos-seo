import * as React from "react"
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  List,
  LoaderCircle,
  Search,
  SlidersHorizontal,
  Trash2,
  XCircle,
} from "lucide-react"

import {
  cancelContentPlanItem,
  getContentPlanItem,
  getContentPlanSettings,
  listContentPlanItems,
  updateContentPlanItem,
  updateContentPlanSettings,
  type ContentPlanCadence,
  type ContentPlanItem,
  type ContentPlanItemSummary,
  type ContentPlanSettings,
  type PlanItemUpdate,
} from "@/api/content-plan"
import { ApiError } from "@/api/client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
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
import { Skeleton } from "@/components/ui/skeleton"
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

type PlanFilter = "all" | "waiting" | "running" | "completed" | "failed"
type DetailDraft = {
  title: string
  writingDirection: string
  publishLocalDate: string
  seedKeyword: string
  primaryKeyword: string
  secondaryKeywords: string
}

const calendarWeekdays = [
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
  "周日",
]
const cadenceLabels: Record<ContentPlanCadence, string> = {
  weekly_1: "每周 1 篇",
  weekly_2_3: "每周 2-3 篇",
  weekly_5: "每周 5 篇",
  weekly_7: "每天 1 篇",
}

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

function formatMonth(date: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
  }).format(date)
}

function formatShortDate(value: string | null, showWeekday = false) {
  if (!value) return "待排期"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    weekday: showWeekday ? "short" : undefined,
  }).format(parseDate(value))
}

function formatGenerationDate(value: string | null) {
  if (!value) return "待确定"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "待确定"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
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

function monthRange(month: Date) {
  return {
    startDate: dateKey(new Date(month.getFullYear(), month.getMonth(), 1)),
    endDate: dateKey(new Date(month.getFullYear(), month.getMonth() + 1, 0)),
  }
}

function errorText(error: unknown) {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      active_automatic_batch_exists: "当前已有一个自动批次正在运行。",
      business_context_missing: "项目资料不完整，暂时不能生成内容计划。",
      content_plan_batch_not_retryable:
        "这个批次涉及不明确的付费请求，不能直接重试。",
      content_plan_date_range_invalid: "读取日期范围无效。",
      plan_keyword_conflict: "这个关键词已在计划或文章中使用。",
      primary_keyword_covered: "这个主关键词已有内容覆盖。",
      schedule_date_conflict: "该日期已有计划，请选择其他日期。",
      stale_version: "计划已被其他操作更新，已重新读取最新内容。",
      timezone_required: "请输入有效的时区。",
    }
    if (error.code && messages[error.code]) return messages[error.code]
  }
  return error instanceof Error ? error.message : "请求失败，请稍后重试。"
}

function planState(item: ContentPlanItemSummary) {
  if (item.status === "cancelled") return "cancelled"
  if (item.status === "failed" || item.edit_state === "reprepare_failed")
    return "failed"
  if (item.status === "generated") return "completed"
  if (["triggering", "generating"].includes(item.status)) return "running"
  return "waiting"
}

function planStatusLabel(item: ContentPlanItemSummary) {
  const state = planState(item)
  if (state === "cancelled") return "已取消"
  if (state === "failed") return "需处理"
  if (state === "completed") return "已生成"
  if (state === "running") return "生成中"
  if (item.edit_state === "repreparing") return "重新准备中"
  if (item.schedule_attention_reason) return "排期待处理"
  return item.publish_local_date ? "待生成" : "待排期"
}

function PlanBadge({ item }: { item: ContentPlanItemSummary }) {
  const state = planState(item)
  const Icon =
    state === "cancelled"
      ? XCircle
      : state === "failed"
        ? AlertTriangle
        : state === "completed"
          ? CheckCircle2
          : state === "running" || item.edit_state === "repreparing"
            ? LoaderCircle
            : Clock3
  return (
    <Badge
      variant={
        state === "running"
          ? "default"
          : state === "waiting"
            ? "outline"
            : "secondary"
      }
    >
      <Icon
        className={cn(
          (state === "running" || item.edit_state === "repreparing") &&
            "animate-spin"
        )}
      />
      {planStatusLabel(item)}
    </Badge>
  )
}

function PlanButton({
  item,
  onClick,
}: {
  item: ContentPlanItemSummary
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={onClick}
      className="h-auto w-full min-w-0 items-start justify-start px-1.5 py-1.5 text-left"
      aria-label={`${item.title}，${planStatusLabel(item)}`}
    >
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-base leading-6 font-medium whitespace-normal">
          {item.title}
        </span>
        <span className="mt-0.5 block truncate text-sm leading-5 text-muted-foreground">
          {item.primary_keyword}
        </span>
      </span>
    </Button>
  )
}

function detailDraft(item: ContentPlanItem): DetailDraft {
  return {
    title: item.title,
    writingDirection: item.writing_direction,
    publishLocalDate: item.publish_local_date ?? "",
    seedKeyword: item.seed_keyword,
    primaryKeyword: item.primary_keyword,
    secondaryKeywords: item.secondary_keywords.join("\n"),
  }
}

type ContentPlanProps = {
  projectId: string
  onOpenArticle: (articleId: string) => void
}

export function ContentPlan({ projectId, onOpenArticle }: ContentPlanProps) {
  const [month, setMonth] = React.useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [plans, setPlans] = React.useState<ContentPlanItemSummary[]>([])
  const [settings, setSettings] = React.useState<ContentPlanSettings | null>(
    null
  )
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState("")
  const [view, setView] = React.useState("calendar")
  const [search, setSearch] = React.useState("")
  const [filter, setFilter] = React.useState<PlanFilter>("all")
  const [actionError, setActionError] = React.useState("")
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [draftCadence, setDraftCadence] =
    React.useState<ContentPlanCadence>("weekly_2_3")
  const [draftPaused, setDraftPaused] = React.useState(false)
  const [draftTimezone, setDraftTimezone] = React.useState("")
  const [settingsBusy, setSettingsBusy] = React.useState(false)
  const [selectedPlanId, setSelectedPlanId] = React.useState<string | null>(
    null
  )
  const [selectedPlan, setSelectedPlan] =
    React.useState<ContentPlanItem | null>(null)
  const [detail, setDetail] = React.useState<DetailDraft | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [detailBusy, setDetailBusy] = React.useState(false)
  const [detailError, setDetailError] = React.useState("")

  const fetchMonth = React.useCallback(async () => {
    const range = monthRange(month)
    return listContentPlanItems(projectId, range)
  }, [month, projectId])

  const loadMonth = React.useCallback(async () => {
    try {
      const collection = await fetchMonth()
      setPlans(collection.items)
      setLoadError("")
    } catch (error) {
      setPlans([])
      setLoadError(errorText(error))
    } finally {
      setLoading(false)
    }
  }, [fetchMonth])

  const openPlan = React.useCallback(
    async (planId: string, showLoading = true) => {
      setSelectedPlanId(planId)
      setDetailError("")
      if (showLoading) setDetailLoading(true)
      try {
        const item = await getContentPlanItem(projectId, planId)
        setSelectedPlan(item)
        setDetail(detailDraft(item))
      } catch (error) {
        setDetailError(errorText(error))
      } finally {
        setDetailLoading(false)
      }
    },
    [projectId]
  )

  React.useEffect(() => {
    let active = true
    void Promise.all([fetchMonth(), getContentPlanSettings(projectId)])
      .then(([collection, nextSettings]) => {
        if (!active) return
        setPlans(collection.items)
        setSettings(nextSettings)
        setLoadError("")
      })
      .catch((error: unknown) => {
        if (!active) return
        setPlans([])
        setSettings(null)
        setLoadError(errorText(error))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [fetchMonth, projectId])

  React.useEffect(() => {
    if (!selectedPlan || selectedPlan.edit_state !== "repreparing") return
    const timer = window.setInterval(
      () => void openPlan(selectedPlan.id, false),
      3000
    )
    return () => window.clearInterval(timer)
  }, [openPlan, selectedPlan])

  const visiblePlans = plans.filter((plan) => {
    const query = search.trim().toLocaleLowerCase()
    return (
      (!query ||
        [plan.title, plan.primary_keyword].some((value) =>
          value.toLocaleLowerCase().includes(query)
        )) &&
      (filter === "all" || planState(plan) === filter)
    )
  })

  function moveMonth(amount: number) {
    setLoading(true)
    setMonth(
      (current) =>
        new Date(current.getFullYear(), current.getMonth() + amount, 1)
    )
  }

  function openSettings() {
    if (!settings) return
    setDraftCadence(settings.cadence)
    setDraftPaused(settings.paused)
    setDraftTimezone(settings.timezone)
    setActionError("")
    setSettingsOpen(true)
  }

  async function saveSettings() {
    if (!settings) return
    setSettingsBusy(true)
    setActionError("")
    try {
      const updated = await updateContentPlanSettings(projectId, {
        version: settings.version,
        cadence: draftCadence,
        paused: draftPaused,
        timezone: draftTimezone.trim(),
      })
      setSettings(updated)
      setSettingsOpen(false)
      await loadMonth()
    } catch (error) {
      setActionError(errorText(error))
      if (error instanceof ApiError && error.status === 409) {
        setSettings(await getContentPlanSettings(projectId))
      }
    } finally {
      setSettingsBusy(false)
    }
  }

  function updatePlanSummary(item: ContentPlanItem) {
    setPlans((current) =>
      current.map((row) => (row.id === item.id ? item : row))
    )
    setSelectedPlan(item)
    setDetail(detailDraft(item))
  }

  async function saveDetail() {
    if (!selectedPlan || !detail) return
    const changes: PlanItemUpdate = { version: selectedPlan.version }
    if (detail.title.trim() !== selectedPlan.title)
      changes.title = detail.title.trim()
    if (detail.writingDirection.trim() !== selectedPlan.writing_direction) {
      changes.writing_direction = detail.writingDirection.trim()
    }
    if (
      detail.publishLocalDate &&
      detail.publishLocalDate !== selectedPlan.publish_local_date
    ) {
      changes.publish_local_date = detail.publishLocalDate
    }
    const secondaryKeywords = detail.secondaryKeywords
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)
    if (
      secondaryKeywords.join("\n") !==
      selectedPlan.secondary_keywords.join("\n")
    ) {
      changes.secondary_keywords = secondaryKeywords
    }
    if (Object.keys(changes).length === 1) return
    setDetailBusy(true)
    setDetailError("")
    try {
      const updated = await updateContentPlanItem(
        projectId,
        selectedPlan.id,
        changes
      )
      if ("title" in updated) updatePlanSummary(updated)
      await loadMonth()
    } catch (error) {
      setDetailError(errorText(error))
      if (error instanceof ApiError && error.code === "stale_version") {
        await openPlan(selectedPlan.id, false)
        await loadMonth()
      } else {
        setDetail(detailDraft(selectedPlan))
      }
    } finally {
      setDetailBusy(false)
    }
  }

  async function reprepareKeyword(kind: "seed_keyword" | "primary_keyword") {
    if (!selectedPlan || !detail) return
    const value =
      kind === "seed_keyword" ? detail.seedKeyword : detail.primaryKeyword
    if (!value.trim() || value.trim() === selectedPlan[kind]) return
    setDetailBusy(true)
    setDetailError("")
    try {
      await updateContentPlanItem(projectId, selectedPlan.id, {
        version: selectedPlan.version,
        [kind]: value.trim(),
      })
      await openPlan(selectedPlan.id, false)
      await loadMonth()
    } catch (error) {
      setDetailError(errorText(error))
      if (error instanceof ApiError && error.code === "stale_version") {
        await openPlan(selectedPlan.id, false)
      } else {
        setDetail(detailDraft(selectedPlan))
      }
    } finally {
      setDetailBusy(false)
    }
  }

  async function cancelPlan() {
    if (!selectedPlan) return
    setDetailBusy(true)
    setDetailError("")
    try {
      await cancelContentPlanItem(
        projectId,
        selectedPlan.id,
        selectedPlan.version
      )
      setSelectedPlanId(null)
      setSelectedPlan(null)
      await loadMonth()
    } catch (error) {
      setDetailError(errorText(error))
      if (error instanceof ApiError && error.code === "stale_version")
        await openPlan(selectedPlan.id, false)
    } finally {
      setDetailBusy(false)
    }
  }

  const today = dateKey(new Date())
  return (
    <div>
      {(actionError || loadError) && (
        <div className="mb-4 border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {actionError || loadError}
        </div>
      )}

      <Card className="@container/content-plan gap-0 overflow-hidden py-0">
        <CardHeader className="border-b py-4">
          <div className="flex flex-col gap-3 @min-[32rem]/content-plan:flex-row @min-[32rem]/content-plan:items-center @min-[32rem]/content-plan:justify-between">
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => moveMonth(-1)}
                title="上个月"
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="ghost"
                className="min-w-28 px-2"
                onClick={() => {
                  const now = new Date()
                  setMonth(new Date(now.getFullYear(), now.getMonth(), 1))
                }}
              >
                {formatMonth(month)}
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={() => moveMonth(1)}
                title="下个月"
              >
                <ChevronRight />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Tabs value={view} onValueChange={setView}>
                <TabsList>
                  <TabsTrigger value="calendar">
                    <CalendarDays />
                    月历
                  </TabsTrigger>
                  <TabsTrigger value="list">
                    <List />
                    列表
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <Button
                variant="outline"
                onClick={openSettings}
                disabled={!settings}
              >
                <SlidersHorizontal />
                发布频率
              </Button>
            </div>
          </div>
        </CardHeader>

        {view === "list" && (
          <div className="flex flex-col gap-3 border-b px-6 py-4 sm:flex-row">
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
              onValueChange={(value) =>
                setFilter((value ?? "all") as PlanFilter)
              }
            >
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="waiting">待生成</SelectItem>
                <SelectItem value="running">生成中</SelectItem>
                <SelectItem value="completed">已生成</SelectItem>
                <SelectItem value="failed">需处理</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <CardContent className="px-0">
          {loading ? (
            <div
              className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4 lg:grid-cols-7"
              aria-label="正在读取内容计划"
            >
              {Array.from({ length: 14 }, (_, index) => (
                <Skeleton key={index} className="h-32 rounded-none" />
              ))}
            </div>
          ) : view === "calendar" ? (
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
                    const datePlans = plans.filter(
                      (plan) =>
                        plan.publish_local_date === key &&
                        plan.status !== "cancelled"
                    )
                    const currentMonth = date.getMonth() === month.getMonth()
                    return (
                      <div
                        key={key}
                        className={cn(
                          "group min-h-32 min-w-0 bg-background p-1.5",
                          !currentMonth && "bg-muted/25 text-muted-foreground"
                        )}
                      >
                        <div className="mb-1 flex h-6 items-center px-1 text-xs tabular-nums">
                          <span
                            className={cn(
                              "inline-flex size-6 items-center justify-center font-medium",
                              key === today &&
                                "rounded-full bg-primary text-primary-foreground"
                            )}
                          >
                            {date.getDate()}
                          </span>
                        </div>
                        {datePlans.map((item) => (
                          <PlanButton
                            key={item.id}
                            item={item}
                            onClick={() => void openPlan(item.id)}
                          />
                        ))}
                      </div>
                    )
                  })}
                </div>
              </div>
              <div className="@min-[32rem]/content-plan:hidden">
                {visiblePlans.length === 0 ? (
                  <div className="px-6 py-16 text-center text-sm text-muted-foreground">
                    本月还没有内容计划
                  </div>
                ) : (
                  visiblePlans.map((item) => (
                    <Button
                      key={item.id}
                      type="button"
                      variant="ghost"
                      onClick={() => void openPlan(item.id)}
                      className="h-auto w-full justify-start gap-3 rounded-none border-b px-4 py-3 text-left whitespace-normal last:border-b-0"
                    >
                      <div className="w-16 shrink-0 text-sm font-medium">
                        {formatShortDate(item.publish_local_date)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-base font-medium">
                          {item.title}
                        </div>
                        <div className="mt-1 truncate text-sm text-muted-foreground">
                          {item.primary_keyword}
                        </div>
                      </div>
                      <PlanBadge item={item} />
                    </Button>
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>目标上稿日</TableHead>
                    <TableHead>计划内容</TableHead>
                    <TableHead>预计生成</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>关联文章</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visiblePlans.map((item) => (
                    <TableRow
                      key={item.id}
                      className="cursor-pointer"
                      onClick={() => void openPlan(item.id)}
                    >
                      <TableCell className="font-medium whitespace-nowrap">
                        {formatShortDate(item.publish_local_date, true)}
                      </TableCell>
                      <TableCell className="min-w-64">
                        <div className="text-base font-medium">
                          {item.title}
                        </div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          {item.primary_keyword}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatGenerationDate(item.generation_at)}
                      </TableCell>
                      <TableCell>
                        <PlanBadge item={item} />
                      </TableCell>
                      <TableCell>
                        {item.article_id ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(event) => {
                              event.stopPropagation()
                              onOpenArticle(item.article_id!)
                            }}
                          >
                            <ExternalLink />
                            查看文章
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">
                            尚未创建
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {visiblePlans.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="h-32 text-center text-muted-foreground"
                      >
                        本月没有匹配的计划
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>发布设置</SheetTitle>
            <SheetDescription>排期规则以后端保存的设置为准。</SheetDescription>
          </SheetHeader>
          <div className="space-y-6 overflow-y-auto px-6 pb-6">
            <Label className="flex items-center justify-between gap-4">
              <span>
                <span className="block font-medium">暂停自动生成</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  已有计划保留，暂停到期触发。
                </span>
              </span>
              <Switch checked={draftPaused} onCheckedChange={setDraftPaused} />
            </Label>
            <Separator />
            <Label className="grid gap-2 text-sm">
              <span className="font-medium">发布频率</span>
              <Select
                value={draftCadence}
                onValueChange={(value) =>
                  setDraftCadence((value ?? "weekly_2_3") as ContentPlanCadence)
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(cadenceLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
            <Label className="grid gap-2 text-sm">
              <span className="font-medium">时区</span>
              <Input
                value={draftTimezone}
                onChange={(event) => setDraftTimezone(event.target.value)}
                placeholder="Asia/Shanghai"
              />
            </Label>
            <div className="border-t pt-4 text-xs text-muted-foreground">
              文章固定在目标上稿日前 1 天开始生成。
            </div>
          </div>
          <SheetFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => void saveSettings()}
              disabled={settingsBusy || !draftTimezone.trim()}
            >
              {settingsBusy && <LoaderCircle className="animate-spin" />}
              保存设置
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Sheet
        open={Boolean(selectedPlanId)}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedPlanId(null)
            setSelectedPlan(null)
            setDetail(null)
          }
        }}
      >
        <SheetContent className="sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>计划详情</SheetTitle>
            <SheetDescription>
              {selectedPlan
                ? `版本 ${selectedPlan.version} · ${planStatusLabel(selectedPlan)}`
                : "正在读取最新计划"}
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-5 overflow-y-auto px-6 pb-6">
            {detailLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-10" />
                <Skeleton className="h-24" />
                <Skeleton className="h-10" />
              </div>
            ) : selectedPlan && detail ? (
              <>
                {selectedPlan.edit_state === "repreparing" && (
                  <div className="flex items-center gap-2 border border-primary/25 bg-primary/5 px-3 py-2 text-sm">
                    <LoaderCircle className="size-4 animate-spin" />
                    正在重新准备关键词包
                  </div>
                )}
                {detailError && (
                  <div className="border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    {detailError}
                  </div>
                )}
                <Label className="grid gap-2 text-sm">
                  <span className="font-medium">标题</span>
                  <Input
                    value={detail.title}
                    onChange={(event) =>
                      setDetail({ ...detail, title: event.target.value })
                    }
                    disabled={detailBusy}
                  />
                </Label>
                <Label className="grid gap-2 text-sm">
                  <span className="font-medium">写作方向</span>
                  <Textarea
                    value={detail.writingDirection}
                    onChange={(event) =>
                      setDetail({
                        ...detail,
                        writingDirection: event.target.value,
                      })
                    }
                    className="min-h-28"
                    disabled={detailBusy}
                  />
                </Label>
                <Label className="grid gap-2 text-sm">
                  <span className="font-medium">目标上稿日期</span>
                  <Input
                    type="date"
                    aria-label="目标上稿日期"
                    value={detail.publishLocalDate}
                    onChange={(event) =>
                      setDetail({
                        ...detail,
                        publishLocalDate: event.target.value,
                      })
                    }
                    disabled={detailBusy}
                  />
                  <span className="text-xs text-muted-foreground">
                    预计生成：{formatGenerationDate(selectedPlan.generation_at)}
                  </span>
                </Label>
                <Label className="grid gap-2 text-sm">
                  <span className="font-medium">次关键词（每行一个）</span>
                  <Textarea
                    value={detail.secondaryKeywords}
                    onChange={(event) =>
                      setDetail({
                        ...detail,
                        secondaryKeywords: event.target.value,
                      })
                    }
                    className="min-h-24"
                    disabled={detailBusy}
                  />
                </Label>
                <Separator />
                <div className="grid gap-4">
                  <Label className="grid gap-2 text-sm">
                    <span className="font-medium">种子词</span>
                    <div className="flex gap-2">
                      <Input
                        value={detail.seedKeyword}
                        onChange={(event) =>
                          setDetail({
                            ...detail,
                            seedKeyword: event.target.value,
                          })
                        }
                        disabled={detailBusy}
                      />
                      <Button
                        variant="outline"
                        onClick={() => void reprepareKeyword("seed_keyword")}
                        disabled={
                          detailBusy ||
                          detail.seedKeyword.trim() ===
                            selectedPlan.seed_keyword
                        }
                      >
                        重新准备
                      </Button>
                    </div>
                  </Label>
                  <Label className="grid gap-2 text-sm">
                    <span className="font-medium">主关键词</span>
                    <div className="flex gap-2">
                      <Input
                        value={detail.primaryKeyword}
                        onChange={(event) =>
                          setDetail({
                            ...detail,
                            primaryKeyword: event.target.value,
                          })
                        }
                        disabled={detailBusy}
                      />
                      <Button
                        variant="outline"
                        onClick={() => void reprepareKeyword("primary_keyword")}
                        disabled={
                          detailBusy ||
                          detail.primaryKeyword.trim() ===
                            selectedPlan.primary_keyword
                        }
                      >
                        重新准备
                      </Button>
                    </div>
                  </Label>
                </div>
                {selectedPlan.article_id ? (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => onOpenArticle(selectedPlan.article_id!)}
                  >
                    <ExternalLink />
                    打开关联文章
                  </Button>
                ) : (
                  <div className="border border-dashed px-4 py-3 text-sm text-muted-foreground">
                    文章会在计划时间自动生成。
                  </div>
                )}
              </>
            ) : detailError ? (
              <div className="text-sm text-destructive">{detailError}</div>
            ) : null}
          </div>
          {selectedPlan && detail && (
            <SheetFooter className="border-t">
              <div className="flex w-full gap-2">
                <Button
                  variant="outline"
                  className="text-destructive"
                  onClick={() => void cancelPlan()}
                  disabled={detailBusy}
                >
                  <Trash2 />
                  取消计划
                </Button>
                <Button
                  className="ml-auto"
                  onClick={() => void saveDetail()}
                  disabled={detailBusy}
                >
                  {detailBusy ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <CheckCircle2 />
                  )}
                  保存修改
                </Button>
              </div>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
