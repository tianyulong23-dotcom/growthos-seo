import * as React from "react"
import {
  Archive,
  Ellipsis,
  MailPlus,
  Pause,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react"
import { Link, useSearchParams } from "react-router"

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
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
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import { isOutreachOffline } from "@/features/outreach/shared/outreach-network-state"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"

import {
  getOpportunity,
  isOpportunityApiStatus,
  listOpportunities,
  patchOpportunityManagement,
  transitionOpportunity,
  type OpportunityBusinessStage,
  type OpportunityDetail,
  type OpportunityFilters,
  type OpportunityFulfillmentStatus,
  type OpportunityListItem,
  type OpportunityManagementStatus,
  type OpportunityOutcomeStatus,
} from "./api"

type QueryStatus =
  | "loading"
  | "empty"
  | "data"
  | "forbidden"
  | "conflict"
  | "offline"
  | "not-found"
  | "error"

type CommandStatus =
  "idle" | "submitting" | "forbidden" | "conflict" | "offline" | "error"

type ManagementFilter = "CURRENT" | OpportunityManagementStatus

type ManagementAction = Readonly<{
  opportunityId: string
  targetHostAscii: string
  expectedVersion: number
  nextStatus: OpportunityManagementStatus
  hasDownstreamFacts: boolean
  idempotencyKey: string
}>

type ManagementCommandResponse = Awaited<
  ReturnType<typeof patchOpportunityManagement>
>
type OpportunityDetailEnvelope = Awaited<ReturnType<typeof getOpportunity>>

const stageMeta: Record<
  OpportunityBusinessStage,
  {
    label: string
    variant: "default" | "secondary" | "outline" | "destructive"
  }
> = {
  JOINED: { label: "已加入", variant: "outline" },
  CONTACT_PREPARING: { label: "准备联系人", variant: "destructive" },
  READY_TO_CONTACT: { label: "可联系", variant: "secondary" },
  OUTREACH_ACTIVE: { label: "外联中", variant: "secondary" },
  NEGOTIATING: { label: "洽谈中", variant: "default" },
  AGREED: { label: "已达成", variant: "default" },
  WAITING_PLACEMENT: { label: "等待投放", variant: "secondary" },
  RELATIONSHIP_ACTIVE: { label: "合作活跃", variant: "default" },
  CLOSED: { label: "已关闭", variant: "outline" },
}

const managementMeta: Record<
  OpportunityManagementStatus,
  { label: string; variant: "secondary" | "outline" | "destructive" }
> = {
  ACTIVE: { label: "进行中", variant: "secondary" },
  PAUSED: { label: "已暂停", variant: "outline" },
  ARCHIVED: { label: "已归档", variant: "destructive" },
}

const outcomeLabels: Record<OpportunityOutcomeStatus, string> = {
  OPEN: "推进中",
  WON: "已成功",
  LOST: "已失效",
}

const fulfillmentLabels: Record<OpportunityFulfillmentStatus, string> = {
  NOT_EXPECTED: "未开始",
  PENDING: "待履约",
  PARTIAL: "部分履约",
  FULFILLED: "已履约",
}

function mapQueryStatus(error: unknown): QueryStatus {
  if (isOutreachOffline()) return "offline"
  if (isOpportunityApiStatus(error, 403)) return "forbidden"
  if (isOpportunityApiStatus(error, 404)) return "not-found"
  if (isOpportunityApiStatus(error, 409)) return "conflict"
  return "error"
}

function mapCommandStatus(error: unknown): CommandStatus {
  if (isOutreachOffline()) return "offline"
  if (isOpportunityApiStatus(error, 403)) return "forbidden"
  if (isOpportunityApiStatus(error, 409)) return "conflict"
  return "error"
}

function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

function evidenceValue(
  value:
    | NonNullable<OpportunityDetail["placementCandidate"]>["sourcePageUrl"]
    | NonNullable<OpportunityDetail["placementCandidate"]>["targetUrl"]
    | NonNullable<OpportunityDetail["placementCandidate"]>["anchorText"]
    | null
) {
  if (!value || value.availability === "unavailable") return "不可用"
  return value.value
}

function DomainCell({
  domain,
  email,
}: {
  domain: string
  email: string | null
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-xs font-semibold text-primary">
        {domain.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{domain}</span>
        {email && (
          <span className="block truncate text-xs text-muted-foreground">
            {email}
          </span>
        )}
      </span>
    </div>
  )
}

function archiveLabel(item: Pick<OpportunityListItem, "hasDownstreamFacts">) {
  return item.hasDownstreamFacts ? "归档" : "撤销加入"
}

function managementReason(action: ManagementAction, note: string) {
  const standardReason =
    action.nextStatus === "ARCHIVED"
      ? action.hasDownstreamFacts
        ? "Opportunity archived from current work."
        : "Opportunity join removed from current work."
      : action.nextStatus === "PAUSED"
        ? "Opportunity paused from current work."
        : "Opportunity restored to active work."
  return note.trim()
    ? `${standardReason} Note: ${note.trim()}`
    : standardReason
}

function StateCard({
  status,
  onRetry,
}: {
  status: Exclude<QueryStatus, "data">
  onRetry: () => void
}) {
  return (
    <OutreachStandardStateView
      state={status === "not-found" ? "error" : status}
      title={
        status === "loading"
          ? "正在加载外链机会"
          : status === "empty"
            ? "当前筛选条件下没有外链机会"
            : status === "forbidden"
              ? "当前账号无权查看该项目的外链机会"
              : status === "conflict"
                ? "服务端版本已变化，请刷新后重试"
                : status === "offline"
                  ? "外链机会当前离线"
                  : status === "not-found"
                    ? "该外链机会不存在或已不可见"
                    : "外链机会加载失败"
      }
      description="不会回退到本地机会数据或推断服务端状态。"
      onRetry={status === "loading" ? undefined : onRetry}
    />
  )
}

export function OpportunitiesWorkspace({
  websiteProjectKey,
}: {
  websiteProjectKey: string
}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = React.useState("")
  const [stageFilter, setStageFilter] = React.useState<
    OpportunityBusinessStage | "ALL"
  >("ALL")
  const [managementFilter, setManagementFilter] =
    React.useState<ManagementFilter>("CURRENT")
  const [outcomeFilter, setOutcomeFilter] = React.useState<
    OpportunityOutcomeStatus | "ALL"
  >("ALL")
  const [fulfillmentFilter, setFulfillmentFilter] = React.useState<
    OpportunityFulfillmentStatus | "ALL"
  >("ALL")
  const deferredSearch = React.useDeferredValue(search.trim())
  const filters = React.useMemo<OpportunityFilters>(
    () => ({
      businessStage: stageFilter === "ALL" ? undefined : stageFilter,
      managementStatus:
        managementFilter === "CURRENT" ? undefined : managementFilter,
      outcomeStatus: outcomeFilter === "ALL" ? undefined : outcomeFilter,
      fulfillmentStatus:
        fulfillmentFilter === "ALL" ? undefined : fulfillmentFilter,
      search: deferredSearch || undefined,
    }),
    [
      deferredSearch,
      fulfillmentFilter,
      managementFilter,
      outcomeFilter,
      stageFilter,
    ]
  )
  const listKey = React.useMemo(
    () =>
      createProjectQueryKey(
        websiteProjectKey,
        "opportunities",
        "list",
        stageFilter,
        managementFilter,
        outcomeFilter,
        fulfillmentFilter,
        deferredSearch
      ),
    [
      deferredSearch,
      fulfillmentFilter,
      managementFilter,
      outcomeFilter,
      stageFilter,
      websiteProjectKey,
    ]
  )
  const [listStatus, setListStatus] = React.useState<QueryStatus>("loading")
  const [items, setItems] = React.useState<OpportunityListItem[]>([])
  const listRequest = React.useRef(0)
  const listHasValue = React.useRef(false)
  const selectedId = searchParams.get("opportunityId")
  const [detailStatus, setDetailStatus] = React.useState<QueryStatus>("loading")
  const [detail, setDetail] = React.useState<OpportunityDetail | null>(null)
  const detailRequest = React.useRef(0)
  const [transitionStage, setTransitionStage] =
    React.useState<OpportunityBusinessStage>("JOINED")
  const [transitionReason, setTransitionReason] = React.useState("")
  const [managementAction, setManagementAction] =
    React.useState<ManagementAction | null>(null)
  const [managementNote, setManagementNote] = React.useState("")
  const [commandStatus, setCommandStatus] =
    React.useState<CommandStatus>("idle")

  const loadList = React.useCallback(
    async (force = false) => {
      const request = ++listRequest.current
      if (force) backlinksProjectQueries.invalidate(listKey)
      if (!listHasValue.current) setListStatus("loading")
      try {
        const response = await backlinksProjectQueries.fetch(
          listKey,
          (signal) => listOpportunities(websiteProjectKey, filters, signal)
        )
        if (request !== listRequest.current) return
        listHasValue.current = true
        setItems(response.items)
        setListStatus(response.items.length === 0 ? "empty" : "data")
      } catch (error) {
        if (request !== listRequest.current) return
        if (error instanceof DOMException && error.name === "AbortError") return
        listHasValue.current = false
        setItems([])
        setListStatus(mapQueryStatus(error))
      }
    },
    [filters, listKey, websiteProjectKey]
  )

  const loadDetail = React.useCallback(
    async (force = false) => {
      if (!selectedId) return
      const request = ++detailRequest.current
      const detailKey = createProjectQueryKey(
        websiteProjectKey,
        "opportunities",
        "detail",
        selectedId
      )
      if (force) backlinksProjectQueries.invalidate(detailKey)
      setDetailStatus("loading")
      try {
        const response = await backlinksProjectQueries.fetch(
          detailKey,
          (signal) => getOpportunity(websiteProjectKey, selectedId, signal)
        )
        if (request !== detailRequest.current) return
        setDetail(response.item)
        setTransitionStage(response.item.businessStage)
        setDetailStatus("data")
      } catch (error) {
        if (request !== detailRequest.current) return
        if (error instanceof DOMException && error.name === "AbortError") return
        setDetail(null)
        setDetailStatus(mapQueryStatus(error))
      }
    },
    [selectedId, websiteProjectKey]
  )

  React.useEffect(() => {
    queueMicrotask(() => void loadList())
    return () => {
      listRequest.current += 1
      backlinksProjectQueries.invalidate(listKey)
    }
  }, [listKey, loadList])

  React.useEffect(() => {
    if (!selectedId) return
    queueMicrotask(() => void loadDetail())
    return () => {
      detailRequest.current += 1
    }
  }, [loadDetail, selectedId])

  async function refreshAfterCommand() {
    backlinksProjectQueries.invalidate([
      "backlinks",
      websiteProjectKey,
      "opportunities",
    ])
    await Promise.all([loadList(), loadDetail()])
  }

  function openManagementAction(
    item: OpportunityListItem,
    nextStatus: OpportunityManagementStatus
  ) {
    setCommandStatus("idle")
    setManagementNote("")
    setManagementAction({
      opportunityId: item.id,
      targetHostAscii: item.targetHostAscii,
      expectedVersion: item.version,
      nextStatus,
      hasDownstreamFacts: item.hasDownstreamFacts,
      idempotencyKey: crypto.randomUUID(),
    })
  }

  async function applyAuthoritativeManagement(
    action: ManagementAction,
    command?: ManagementCommandResponse,
    existingRead?: OpportunityDetailEnvelope
  ) {
    const response =
      existingRead ??
      (await getOpportunity(websiteProjectKey, action.opportunityId))
    if (
      response.item.id !== action.opportunityId ||
      response.item.managementStatus !== action.nextStatus ||
      response.item.version <= action.expectedVersion ||
      (command !== undefined &&
        (command.opportunityId !== response.item.id ||
          command.managementStatus !== response.item.managementStatus ||
          command.version !== response.item.version ||
          command.meta.websiteProjectId !== response.meta.websiteProjectId))
    ) {
      throw new Error("Opportunity management reread did not match the command")
    }

    backlinksProjectQueries.invalidate([
      "backlinks",
      websiteProjectKey,
      "opportunities",
    ])
    if (selectedId === response.item.id) {
      setDetail(response.item)
      setTransitionStage(response.item.businessStage)
      setDetailStatus("data")
    }
    await loadList()
  }

  async function submitTransition() {
    if (
      !detail ||
      !transitionReason.trim() ||
      transitionStage === detail.businessStage
    ) {
      return
    }
    setCommandStatus("submitting")
    try {
      await transitionOpportunity(websiteProjectKey, detail.id, {
        expectedVersion: detail.version,
        toBusinessStage: transitionStage,
        reason: transitionReason.trim(),
      })
      setTransitionReason("")
      setCommandStatus("idle")
      await refreshAfterCommand()
    } catch (error) {
      setCommandStatus(mapCommandStatus(error))
    }
  }

  async function submitManagement() {
    const action = managementAction
    if (!action) return
    setCommandStatus("submitting")
    const execute = () =>
      patchOpportunityManagement(
        websiteProjectKey,
        action.opportunityId,
        {
          expectedVersion: action.expectedVersion,
          managementStatus: action.nextStatus,
          reason: managementReason(action, managementNote),
        },
        action.idempotencyKey
      )

    try {
      let result: ManagementCommandResponse
      try {
        result = await execute()
      } catch (error) {
        if (
          isOpportunityApiStatus(error, 403) ||
          isOpportunityApiStatus(error, 409)
        ) {
          setCommandStatus(mapCommandStatus(error))
          await refreshAfterCommand()
          return
        }

        try {
          result = await execute()
        } catch (reconcileError) {
          try {
            const current = await getOpportunity(
              websiteProjectKey,
              action.opportunityId
            )
            await applyAuthoritativeManagement(action, undefined, current)
            setManagementAction(null)
            setManagementNote("")
            setCommandStatus("idle")
            return
          } catch {
            setCommandStatus(mapCommandStatus(reconcileError))
            await refreshAfterCommand()
            return
          }
        }
      }

      await applyAuthoritativeManagement(action, result)
      setManagementAction(null)
      setManagementNote("")
      setCommandStatus("idle")
    } catch (error) {
      setCommandStatus(mapCommandStatus(error))
      await refreshAfterCommand()
    }
  }

  return (
    <div>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          [
            "活跃机会",
            items.filter((item) => item.managementStatus === "ACTIVE").length,
          ],
          [
            "待补联系人",
            items.filter((item) =>
              ["JOINED", "CONTACT_PREPARING"].includes(item.businessStage)
            ).length,
          ],
          [
            "可联系",
            items.filter((item) => item.businessStage === "READY_TO_CONTACT")
              .length,
          ],
          [
            "回复与洽谈",
            items.filter((item) => item.businessStage === "NEGOTIATING").length,
          ],
        ].map(([label, value]) => (
          <Card key={label} size="sm">
            <CardContent>
              <div className="text-sm text-muted-foreground">{label}</div>
              <div className="mt-2 text-2xl font-semibold">{value}</div>
              <div className="mt-1 text-xs text-muted-foreground">当前项目</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {listStatus !== "data" && listStatus !== "empty" && (
        <StateCard status={listStatus} onRetry={() => void loadList(true)} />
      )}

      {(listStatus === "data" || listStatus === "empty") && (
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-3 border-b p-4 xl:flex-row xl:items-center">
            <div className="relative flex-1">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索外链机会..."
                className="pl-9 sm:max-w-sm"
              />
            </div>
            <div className="grid w-full gap-2 sm:grid-cols-2 xl:w-auto xl:grid-cols-4">
              <Select
                value={stageFilter}
                onValueChange={(value) =>
                  setStageFilter(
                    (value ?? "ALL") as OpportunityBusinessStage | "ALL"
                  )
                }
              >
                <SelectTrigger
                  className="w-full xl:w-36"
                  aria-label="按推进阶段筛选"
                >
                  <SelectValue>
                    {stageFilter === "ALL"
                      ? "全部阶段"
                      : stageMeta[stageFilter].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">全部阶段</SelectItem>
                  {Object.entries(stageMeta).map(([value, meta]) => (
                    <SelectItem key={value} value={value}>
                      {meta.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={managementFilter}
                onValueChange={(value) =>
                  setManagementFilter(
                    (value ?? "CURRENT") as ManagementFilter
                  )
                }
              >
                <SelectTrigger
                  className="w-full xl:w-32"
                  aria-label="按管理状态筛选"
                >
                  <SelectValue>
                    {managementFilter === "CURRENT"
                      ? "当前工作"
                      : managementMeta[managementFilter].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CURRENT">当前工作</SelectItem>
                  {Object.entries(managementMeta).map(([value, meta]) => (
                    <SelectItem key={value} value={value}>
                      {meta.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={outcomeFilter}
                onValueChange={(value) =>
                  setOutcomeFilter(
                    (value ?? "ALL") as OpportunityOutcomeStatus | "ALL"
                  )
                }
              >
                <SelectTrigger
                  className="w-full xl:w-28"
                  aria-label="按结果筛选"
                >
                  <SelectValue>
                    {outcomeFilter === "ALL"
                      ? "全部结果"
                      : outcomeLabels[outcomeFilter]}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">全部结果</SelectItem>
                  {Object.entries(outcomeLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={fulfillmentFilter}
                onValueChange={(value) =>
                  setFulfillmentFilter(
                    (value ?? "ALL") as OpportunityFulfillmentStatus | "ALL"
                  )
                }
              >
                <SelectTrigger
                  className="w-full xl:w-32"
                  aria-label="按履约状态筛选"
                >
                  <SelectValue>
                    {fulfillmentFilter === "ALL"
                      ? "全部履约"
                      : fulfillmentLabels[fulfillmentFilter]}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">全部履约</SelectItem>
                  {Object.entries(fulfillmentLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>网站</TableHead>
                  <TableHead>当前阶段</TableHead>
                  <TableHead>管理状态</TableHead>
                  <TableHead>结果</TableHead>
                  <TableHead>履约</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <DomainCell
                        domain={item.targetHostAscii}
                        email={item.contactEmail}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge variant={stageMeta[item.businessStage].variant}>
                        {stageMeta[item.businessStage].label}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={managementMeta[item.managementStatus].variant}
                      >
                        {managementMeta[item.managementStatus].label}
                      </Badge>
                    </TableCell>
                    <TableCell>{outcomeLabels[item.outcomeStatus]}</TableCell>
                    <TableCell>
                      {fulfillmentLabels[item.fulfillmentStatus]}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatUpdatedAt(item.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setCommandStatus("idle")
                            setSearchParams({ opportunityId: item.id })
                          }}
                        >
                          详情
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`管理 ${item.targetHostAscii}`}
                              />
                            }
                          >
                            <Ellipsis />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {item.managementStatus === "ACTIVE" && (
                              <DropdownMenuItem
                                onClick={() =>
                                  openManagementAction(item, "PAUSED")
                                }
                              >
                                <Pause />
                                暂停
                              </DropdownMenuItem>
                            )}
                            {item.managementStatus !== "ACTIVE" && (
                              <DropdownMenuItem
                                onClick={() =>
                                  openManagementAction(item, "ACTIVE")
                                }
                              >
                                <RotateCcw />
                                恢复
                              </DropdownMenuItem>
                            )}
                            {item.managementStatus !== "ARCHIVED" && (
                              <DropdownMenuItem
                                variant="destructive"
                                aria-label={`移出当前列表：${archiveLabel(item)}`}
                                onClick={() =>
                                  openManagementAction(item, "ARCHIVED")
                                }
                              >
                                <Archive />
                                {archiveLabel(item)}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {items.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="h-32 text-center text-muted-foreground"
                    >
                      当前筛选条件下没有外链机会
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex min-h-12 items-center justify-between gap-3 border-t px-4 py-2 text-sm">
            <span className="text-muted-foreground">
              {items.length} 个结果
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadList(true)}
            >
              <RefreshCw />
              刷新
            </Button>
          </div>
        </Card>
      )}

      <Sheet
        open={Boolean(selectedId)}
        onOpenChange={(open) => {
          if (!open) {
            setSearchParams({})
            setDetail(null)
            setTransitionReason("")
            setCommandStatus("idle")
          }
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{detail?.targetHostAscii ?? "外链机会详情"}</SheetTitle>
            <SheetDescription>
              查看当前进度、投放信息和下一步操作
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-5 px-6 pb-6">
            {detailStatus !== "data" && (
              <StateCard
                status={detailStatus}
                onRetry={() => void loadDetail(true)}
              />
            )}

            {detailStatus === "data" && detail && (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge variant={stageMeta[detail.businessStage].variant}>
                    {stageMeta[detail.businessStage].label}
                  </Badge>
                  <Badge
                    variant={managementMeta[detail.managementStatus].variant}
                  >
                    {managementMeta[detail.managementStatus].label}
                  </Badge>
                  {detail.contactReviewRequired && (
                    <Badge variant="outline">联系人需复核</Badge>
                  )}
                </div>

                <Link
                  className={buttonVariants({
                    className: "w-full sm:w-fit",
                  })}
                  to={`/projects/${websiteProjectKey}/backlinks/drafts/new?opportunityId=${detail.id}`}
                >
                  <MailPlus />
                  撰写邮件
                </Link>

                <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-y py-4 text-sm">
                  <span className="text-muted-foreground">结果状态</span>
                  <span className="text-right">
                    {outcomeLabels[detail.outcomeStatus]}
                  </span>
                  <span className="text-muted-foreground">履约状态</span>
                  <span className="text-right">
                    {fulfillmentLabels[detail.fulfillmentStatus]}
                  </span>
                  <span className="text-muted-foreground">评估分数</span>
                  <span className="text-right">
                    {detail.assessment?.score ?? "不可用"}
                  </span>
                  <span className="text-muted-foreground">数据状态</span>
                  <span className="text-right">
                    {detail.assessment?.availability === "available"
                      ? "完整"
                      : detail.assessment?.availability === "partial"
                        ? "部分可用"
                        : "不适用"}
                  </span>
                  <span className="text-muted-foreground">更新时间</span>
                  <span className="text-right">
                    {formatUpdatedAt(detail.updatedAt)}
                  </span>
                  <span className="text-muted-foreground">联系人邮箱</span>
                  <span className="truncate text-right">
                    {detail.contactEmail ?? "待确认"}
                  </span>
                </div>

                <section className="space-y-2 border-b pb-4">
                  <div className="text-sm font-medium">链接投放信息</div>
                  {detail.placementCandidate ? (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <span className="text-muted-foreground">来源页</span>
                      <span className="truncate text-right">
                        {evidenceValue(detail.placementCandidate.sourcePageUrl)}
                      </span>
                      <span className="text-muted-foreground">目标页</span>
                      <span className="truncate text-right">
                        {evidenceValue(detail.placementCandidate.targetUrl)}
                      </span>
                      <span className="text-muted-foreground">锚文本</span>
                      <span className="truncate text-right">
                        {evidenceValue(detail.placementCandidate.anchorText)}
                      </span>
                      <span className="text-muted-foreground">核验方式</span>
                      <span className="text-right">
                        {detail.placementCandidate.verification?.method ??
                          "未核验"}
                      </span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      暂时没有可用的链接投放信息。
                    </p>
                  )}
                </section>

                {commandStatus !== "idle" && commandStatus !== "submitting" && (
                  <Card role="alert">
                    <CardContent className="space-y-3 py-4 text-sm">
                      <p>
                        {
                          {
                            forbidden: "当前账号无权更新该机会。",
                            conflict: "机会状态已更新，请刷新详情后重试。",
                            offline: "机会更新请求当前离线，结果保持未知。",
                            error: "机会更新失败，请稍后重试。",
                          }[commandStatus]
                        }
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setCommandStatus("idle")
                          void Promise.all([loadList(true), loadDetail(true)])
                        }}
                      >
                        <RefreshCw />
                        刷新状态
                      </Button>
                    </CardContent>
                  </Card>
                )}

                <section className="space-y-3 border-b pb-4">
                  <div>
                    <div className="text-sm font-medium">更新推进阶段</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      选择新的阶段并记录调整原因。
                    </div>
                  </div>
                  <Select
                    value={transitionStage}
                    onValueChange={(value) =>
                      setTransitionStage(
                        (value ??
                          detail.businessStage) as OpportunityBusinessStage
                      )
                    }
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label="选择新的推进阶段"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(stageMeta).map(([value, meta]) => (
                        <SelectItem key={value} value={value}>
                          {meta.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Textarea
                    value={transitionReason}
                    onChange={(event) =>
                      setTransitionReason(event.target.value)
                    }
                    maxLength={500}
                    placeholder="填写阶段转换原因"
                  />
                  <Button
                    disabled={
                      commandStatus === "submitting" ||
                      !transitionReason.trim() ||
                      transitionStage === detail.businessStage
                    }
                    onClick={() => void submitTransition()}
                  >
                    更新阶段
                  </Button>
                </section>

                <section className="space-y-3">
                  <div>
                    <div className="text-sm font-medium">管理状态操作</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      暂停或归档不会改变当前推进阶段。
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {detail.managementStatus === "ACTIVE" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={commandStatus === "submitting"}
                        onClick={() =>
                          openManagementAction(detail, "PAUSED")
                        }
                      >
                        <Pause />
                        暂停
                      </Button>
                    )}
                    {detail.managementStatus !== "ARCHIVED" && (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={commandStatus === "submitting"}
                        onClick={() =>
                          openManagementAction(detail, "ARCHIVED")
                        }
                      >
                        <Archive />
                        {archiveLabel(detail)}
                      </Button>
                    )}
                    {detail.managementStatus !== "ACTIVE" && (
                      <Button
                        size="sm"
                        disabled={commandStatus === "submitting"}
                        onClick={() =>
                          openManagementAction(detail, "ACTIVE")
                        }
                      >
                        <RotateCcw />
                        恢复
                      </Button>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={managementAction !== null}
        onOpenChange={(open) => {
          if (!open && commandStatus !== "submitting") {
            setManagementAction(null)
            setManagementNote("")
            setCommandStatus("idle")
          }
        }}
      >
        {managementAction && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {managementAction.nextStatus === "ARCHIVED"
                  ? `${archiveLabel(managementAction)} ${managementAction.targetHostAscii}？`
                  : managementAction.nextStatus === "PAUSED"
                    ? `暂停 ${managementAction.targetHostAscii}？`
                    : `恢复 ${managementAction.targetHostAscii}？`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {managementAction.nextStatus === "ARCHIVED"
                  ? managementAction.hasDownstreamFacts
                    ? "归档后该机会会退出当前工作列表，联系人、邮件、回复、投放及进度记录仍会保留。"
                    : "撤销加入会将该机会归档并移出当前工作列表，不会删除推荐或机会历史。"
                  : managementAction.nextStatus === "PAUSED"
                    ? "暂停后该机会仍保留在当前工作中，不会改变推进阶段或已有记录。"
                    : "恢复后该机会回到当前工作，推进阶段、邮件和投放记录保持不变。"}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Textarea
              value={managementNote}
              onChange={(event) => setManagementNote(event.target.value)}
              maxLength={300}
              placeholder="可选：补充说明"
              disabled={commandStatus === "submitting"}
            />
            {commandStatus !== "idle" && commandStatus !== "submitting" && (
              <p role="alert" className="text-sm text-destructive">
                {
                  {
                    forbidden: "当前账号无权更新该机会。",
                    conflict: "机会版本已变化；页面已重新读取服务端状态。",
                    offline:
                      "请求结果仍不明确；未在页面中推断或伪造操作成功。",
                    error: "未能通过服务端回读确认操作成功。",
                  }[commandStatus]
                }
              </p>
            )}
            <AlertDialogFooter>
              <Button
                variant="outline"
                disabled={commandStatus === "submitting"}
                onClick={() => {
                  setManagementAction(null)
                  setManagementNote("")
                  setCommandStatus("idle")
                }}
              >
                {commandStatus === "idle" ? "取消" : "关闭"}
              </Button>
              <Button
                variant={
                  managementAction.nextStatus === "ARCHIVED"
                    ? "destructive"
                    : "default"
                }
                disabled={commandStatus === "submitting"}
                onClick={() => void submitManagement()}
              >
                {commandStatus === "submitting"
                  ? "正在确认..."
                  : managementAction.nextStatus === "ARCHIVED"
                    ? `确认${archiveLabel(managementAction)}`
                    : managementAction.nextStatus === "PAUSED"
                      ? "确认暂停"
                      : "确认恢复"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  )
}
