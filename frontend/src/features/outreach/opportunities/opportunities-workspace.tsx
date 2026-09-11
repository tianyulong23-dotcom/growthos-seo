import * as React from "react"
import {
  Archive,
  ArrowLeft,
  Copy,
  Ellipsis,
  ExternalLink,
  MailPlus,
  Pause,
  RefreshCw,
  RotateCcw,
  Save,
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
  patchCooperationPathContent,
  patchOpportunityManagement,
  transitionManualAction,
  transitionOpportunity,
  type OpportunityBusinessStage,
  type OpportunityDetail,
  type OpportunityFilters,
  type OpportunityFulfillmentStatus,
  type OpportunityListItem,
  type OpportunityManualActionState,
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

const manualActionLabels: Record<OpportunityManualActionState, string> = {
  READY_FOR_MANUAL_ACTION: "待人工处理",
  IN_PROGRESS: "处理中",
  SUBMITTED: "已提交",
  RESPONSE_RECEIVED: "已收到回复",
  BLOCKED: "受阻",
  ABANDONED: "已放弃",
}

const cooperationPathLabels: Record<
  NonNullable<OpportunityDetail["cooperationPath"]>["pathType"],
  string
> = {
  contact_form: "联系表单",
  guest_post_submission: "客座文章投稿",
  resource_submission: "资源提交",
  editor_author_page: "编辑或作者页面",
}

const engagementPathLabels: Record<
  OpportunityDetail["engagementPathState"],
  string
> = {
  EMAIL_READY: "邮件路径已就绪",
  MANUAL_PATH_READY: "人工路径已就绪",
  CONTACT_PENDING: "待补联系人或合作路径",
}

const primaryNextActionLabels: Record<
  OpportunityDetail["primaryNextAction"]["kind"],
  string
> = {
  CREATE_EMAIL_DRAFT: "创建邮件草稿",
  WAIT_FOR_DRAFT: "等待草稿生成",
  EDIT_DRAFT: "编辑基础草稿",
  REVIEW_DRAFT: "审阅草稿",
  REVIEW_SEND_READINESS: "检查发送就绪",
  VIEW_MAIL_STATUS: "查看邮件状态",
  CONTINUE_MANUAL_PATH: "继续人工合作路径",
  RESOLVE_CONTACT_OR_PATH: "补齐联系人或合作路径",
}

function draftActionHref(
  websiteProjectKey: string,
  detail: OpportunityDetail,
  primaryNextActionKind: OpportunityDetail["primaryNextAction"]["kind"]
): string | null {
  if (primaryNextActionKind === "CREATE_EMAIL_DRAFT") {
    return `/projects/${websiteProjectKey}/backlinks/drafts/new?opportunityId=${detail.id}`
  }
  if (
    detail.draftId &&
    [
      "EDIT_DRAFT",
      "REVIEW_DRAFT",
      "REVIEW_SEND_READINESS",
      "VIEW_MAIL_STATUS",
    ].includes(primaryNextActionKind)
  ) {
    return `/projects/${websiteProjectKey}/backlinks/drafts/${detail.draftId}`
  }
  return null
}

function contactResolutionHref(
  websiteProjectKey: string,
  detail: OpportunityDetail,
  engagementPathState: OpportunityDetail["engagementPathState"]
): string | null {
  if (
    detail.engagementChannel !== "EMAIL" ||
    engagementPathState !== "CONTACT_PENDING"
  ) {
    return null
  }
  return `/projects/${websiteProjectKey}/backlinks/drafts/new?opportunityId=${detail.id}`
}

function resolveEngagementPathState(
  detail: OpportunityDetail
): OpportunityDetail["engagementPathState"] {
  if (detail.engagementPathState) return detail.engagementPathState
  if (detail.cooperationPath) return "MANUAL_PATH_READY"
  if (
    detail.engagementChannel === "EMAIL" &&
    detail.contactEmail &&
    !detail.contactReviewRequired
  ) {
    return "EMAIL_READY"
  }
  return "CONTACT_PENDING"
}

function resolvePrimaryNextActionKind(
  detail: OpportunityDetail,
  engagementPathState: OpportunityDetail["engagementPathState"]
): OpportunityDetail["primaryNextAction"]["kind"] {
  if (detail.primaryNextAction?.kind) return detail.primaryNextAction.kind
  if (engagementPathState === "MANUAL_PATH_READY") {
    return "CONTINUE_MANUAL_PATH"
  }
  if (engagementPathState === "CONTACT_PENDING") {
    return "RESOLVE_CONTACT_OR_PATH"
  }
  return detail.draftId ? "EDIT_DRAFT" : "CREATE_EMAIL_DRAFT"
}

function primaryManualTransition(state: OpportunityManualActionState): {
  toState: OpportunityManualActionState
  label: string
} {
  const transitions: Record<
    OpportunityManualActionState,
    { toState: OpportunityManualActionState; label: string }
  > = {
    READY_FOR_MANUAL_ACTION: { toState: "IN_PROGRESS", label: "开始处理" },
    IN_PROGRESS: { toState: "SUBMITTED", label: "确认已提交" },
    SUBMITTED: {
      toState: "RESPONSE_RECEIVED",
      label: "记录已收到回复",
    },
    RESPONSE_RECEIVED: { toState: "IN_PROGRESS", label: "继续跟进" },
    BLOCKED: { toState: "IN_PROGRESS", label: "恢复处理" },
    ABANDONED: { toState: "IN_PROGRESS", label: "恢复处理" },
  }
  return transitions[state]
}

function nextActionForManualState(state: OpportunityManualActionState) {
  return {
    READY_FOR_MANUAL_ACTION: "开始人工处理并核对页面要求。",
    IN_PROGRESS: "完成当前人工步骤后，明确确认是否已提交。",
    SUBMITTED: "等待并记录网站回复。",
    RESPONSE_RECEIVED: "根据回复继续推进合作。",
    BLOCKED: "解决阻塞原因后恢复人工处理。",
    ABANDONED: "如需重新启动，恢复人工处理。",
  }[state]
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
  channel,
  domain,
  email,
}: {
  channel: OpportunityListItem["engagementChannel"]
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
        {!email && channel === "COOPERATION_PATH" && (
          <span className="block truncate text-xs text-muted-foreground">
            人工合作路径
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
  return note.trim() ? `${standardReason} Note: ${note.trim()}` : standardReason
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
  const [manualContent, setManualContent] = React.useState("")
  const [manualNextAction, setManualNextAction] = React.useState("")
  const [submissionConfirmationOpen, setSubmissionConfirmationOpen] =
    React.useState(false)
  const [commandStatus, setCommandStatus] =
    React.useState<CommandStatus>("idle")
  const engagementPathState = detail ? resolveEngagementPathState(detail) : null
  const primaryNextActionKind =
    detail && engagementPathState
      ? resolvePrimaryNextActionKind(detail, engagementPathState)
      : null
  const selectionSnapshot = detail?.selectionSnapshot ?? null
  const draftHref =
    detail && primaryNextActionKind
      ? draftActionHref(websiteProjectKey, detail, primaryNextActionKind)
      : null
  const resolveContactHref =
    detail && engagementPathState
      ? contactResolutionHref(websiteProjectKey, detail, engagementPathState)
      : null

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
        setManualContent(response.item.cooperationPath?.editableContent ?? "")
        setManualNextAction(response.item.cooperationPath?.nextAction ?? "")
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

  async function saveManualContent() {
    const path = detail?.cooperationPath
    if (!detail || !path || !manualContent.trim() || !manualNextAction.trim()) {
      return
    }
    setCommandStatus("submitting")
    try {
      await patchCooperationPathContent(websiteProjectKey, detail.id, {
        expectedVersion: path.version,
        editableContent: manualContent.trim(),
        nextAction: manualNextAction.trim(),
      })
      setCommandStatus("idle")
      await refreshAfterCommand()
    } catch (error) {
      setCommandStatus(mapCommandStatus(error))
    }
  }

  async function applyManualTransition(
    toState: OpportunityManualActionState,
    submissionConfirmed = false
  ) {
    const path = detail?.cooperationPath
    if (!detail || !path) return
    setCommandStatus("submitting")
    try {
      await transitionManualAction(websiteProjectKey, detail.id, {
        expectedVersion: path.version,
        toState,
        nextAction: nextActionForManualState(toState),
        evidence: {
          source: "operator_ui",
          pathUrl: path.pathUrl,
        },
        ...(submissionConfirmed ? { submissionConfirmed: true } : {}),
      })
      setSubmissionConfirmationOpen(false)
      setCommandStatus("idle")
      await refreshAfterCommand()
    } catch (error) {
      setCommandStatus(mapCommandStatus(error))
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
            items.filter(
              (item) =>
                item.engagementChannel === "EMAIL" &&
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
                  setManagementFilter((value ?? "CURRENT") as ManagementFilter)
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
                        channel={item.engagementChannel}
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
            <span className="text-muted-foreground">{items.length} 个结果</span>
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
            setManualContent("")
            setManualNextAction("")
            setSubmissionConfirmationOpen(false)
            setCommandStatus("idle")
          }
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-lg [&_[data-slot=select-trigger]]:rounded-md [&_textarea]:rounded-md">
          <SheetHeader>
            <SheetTitle>{detail?.targetHostAscii ?? "外链机会详情"}</SheetTitle>
            <SheetDescription>
              外链合作详情
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
                  {engagementPathState && engagementPathState !== "CONTACT_PENDING" && (
                    <Badge variant="outline">
                      {engagementPathLabels[engagementPathState]}
                    </Badge>
                  )}
                </div>

                <details className="space-y-3 border-y py-3">
                  <summary className="cursor-pointer text-sm text-muted-foreground">推荐来源与推广目标</summary>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium">推荐来源</div>
                      <div className="text-xs text-muted-foreground">
                        {primaryNextActionKind
                          ? primaryNextActionLabels[primaryNextActionKind]
                          : "下一步信息暂不可用"}
                      </div>
                    </div>
                    <Link
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                      to={`/projects/${websiteProjectKey}/backlinks/recommendations?recommendationId=${detail.recommendationId}`}
                    >
                      <ArrowLeft />
                      返回推荐
                    </Link>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <span className="text-muted-foreground">推荐轮次</span>
                    <span className="text-right">
                      {selectionSnapshot?.visiblePoolGeneration ?? "不可用"}
                    </span>
                    <span className="text-muted-foreground">推广目标</span>
                    <span className="truncate text-right">
                      {selectionSnapshot?.selectedTargetUrl ?? "不可用"}
                    </span>
                  </div>
                </details>

                {engagementPathState === "EMAIL_READY" && draftHref && (
                  <Link
                    className={buttonVariants({
                      className: "w-full sm:w-fit",
                    })}
                    to={draftHref}
                  >
                    <MailPlus />
                    {primaryNextActionKind
                      ? primaryNextActionLabels[primaryNextActionKind]
                      : "打开邮件草稿"}
                  </Link>
                )}

                {primaryNextActionKind === "WAIT_FOR_DRAFT" && (
                  <div role="status" className="border-l-2 py-1 pl-3 text-sm">
                    草稿正在生成，请稍后刷新查看。
                  </div>
                )}

                {engagementPathState === "CONTACT_PENDING" && (
                  <section className="space-y-3 border-b pb-5">
                    <div role="status" className="space-y-1 text-sm">
                      <div className="font-medium">下一步：确认收件人</div>
                      <p className="text-muted-foreground">
                        {detail.contactEmail ?? "尚未确认收件邮箱"}
                      </p>
                    </div>
                    {resolveContactHref && (
                      <Link
                        className={buttonVariants({
                          className: "w-full sm:w-fit",
                        })}
                        to={resolveContactHref}
                      >
                        <MailPlus />
                        确认邮箱并写邮件
                      </Link>
                    )}
                    <p className="text-xs text-muted-foreground">
                      邮件不会自动发送。
                    </p>
                  </section>
                )}

                {engagementPathState === "MANUAL_PATH_READY" &&
                  detail.cooperationPath && (
                    <section className="space-y-3 border-b pb-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-medium">
                          {
                            cooperationPathLabels[
                              detail.cooperationPath.pathType
                            ]
                          }
                        </div>
                        <Badge variant="outline">
                          {manualActionLabels[detail.cooperationPath.state]}
                        </Badge>
                      </div>
                      <a
                        href={detail.cooperationPath.pathUrl}
                        target="_blank"
                        rel="noreferrer"
                        className={buttonVariants({
                          variant: "outline",
                          className: "w-full sm:w-fit",
                        })}
                      >
                        <ExternalLink />
                        打开合作页面
                      </a>
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">
                          可编辑外联文案
                        </div>
                        <Textarea
                          value={manualContent}
                          onChange={(event) =>
                            setManualContent(event.target.value)
                          }
                          rows={7}
                          maxLength={5000}
                          disabled={commandStatus === "submitting"}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!manualContent.trim()}
                            onClick={() =>
                              void navigator.clipboard.writeText(manualContent)
                            }
                          >
                            <Copy />
                            复制文案
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={
                              commandStatus === "submitting" ||
                              !manualContent.trim() ||
                              !manualNextAction.trim()
                            }
                            onClick={() => void saveManualContent()}
                          >
                            <Save />
                            保存文案
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="text-xs font-medium text-muted-foreground">
                          下一步动作
                        </div>
                        <Input
                          value={manualNextAction}
                          onChange={(event) =>
                            setManualNextAction(event.target.value)
                          }
                          maxLength={500}
                          disabled={commandStatus === "submitting"}
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {(() => {
                          const action = primaryManualTransition(
                            detail.cooperationPath.state
                          )
                          return (
                            <Button
                              type="button"
                              size="sm"
                              disabled={commandStatus === "submitting"}
                              onClick={() => {
                                if (action.toState === "SUBMITTED") {
                                  setSubmissionConfirmationOpen(true)
                                  return
                                }
                                void applyManualTransition(action.toState)
                              }}
                            >
                              {action.label}
                            </Button>
                          )
                        })()}
                        {detail.cooperationPath.state !== "BLOCKED" &&
                          detail.cooperationPath.state !== "ABANDONED" && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={commandStatus === "submitting"}
                              onClick={() =>
                                void applyManualTransition("BLOCKED")
                              }
                            >
                              标记受阻
                            </Button>
                          )}
                        {detail.cooperationPath.state !== "ABANDONED" && (
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={commandStatus === "submitting"}
                            onClick={() =>
                              void applyManualTransition("ABANDONED")
                            }
                          >
                            放弃
                          </Button>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        打开或复制不会改变状态；只有明确确认后才会记录为已提交。
                      </p>
                    </section>
                  )}

                <details className="space-y-3 border-b pb-4">
                  <summary className="cursor-pointer text-sm font-medium">更多合作信息</summary>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
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
                    {detail.engagementChannel === "EMAIL"
                      ? (detail.contactEmail ?? "待确认")
                      : "非邮件合作路径"}
                  </span>
                </div>
                </details>

                {detail.placementCandidate && <section className="space-y-2 border-b pb-4">
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
                </section>}

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

                <details className="space-y-3 border-b pb-4">
                  <summary className="cursor-pointer text-sm font-medium">调整合作进度</summary>
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
                      <SelectValue>{stageMeta[transitionStage].label}</SelectValue>
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
                </details>

                <section className="space-y-3">
                  <div>
                    <div className="text-sm font-medium">管理此机会</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {detail.managementStatus === "ACTIVE" && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={commandStatus === "submitting"}
                        onClick={() => openManagementAction(detail, "PAUSED")}
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
                        onClick={() => openManagementAction(detail, "ARCHIVED")}
                      >
                        <Archive />
                        {archiveLabel(detail)}
                      </Button>
                    )}
                    {detail.managementStatus !== "ACTIVE" && (
                      <Button
                        size="sm"
                        disabled={commandStatus === "submitting"}
                        onClick={() => openManagementAction(detail, "ACTIVE")}
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
        open={submissionConfirmationOpen}
        onOpenChange={(open) => {
          if (!open && commandStatus !== "submitting") {
            setSubmissionConfirmationOpen(false)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认已完成外部提交？</AlertDialogTitle>
            <AlertDialogDescription>
              只有你已经在目标网站完成表单、投稿或资源提交时才能确认。仅打开页面或复制文案不算提交。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={commandStatus === "submitting"}
              onClick={() => setSubmissionConfirmationOpen(false)}
            >
              取消
            </Button>
            <Button
              disabled={commandStatus === "submitting"}
              onClick={() => void applyManualTransition("SUBMITTED", true)}
            >
              {commandStatus === "submitting" ? "正在确认..." : "确认已提交"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
                    offline: "请求结果仍不明确；未在页面中推断或伪造操作成功。",
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
