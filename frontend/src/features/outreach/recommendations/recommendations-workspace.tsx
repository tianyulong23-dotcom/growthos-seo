import * as React from "react"
import {
  Archive,
  CirclePlus,
  Clock3,
  ExternalLink,
  LoaderCircle,
  Mail,
  RefreshCw,
  RotateCw,
  Search,
} from "lucide-react"
import { useNavigate, useSearchParams } from "react-router"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ApiError } from "@/api/client"
import { backlinksProjectQueries } from "@/features/outreach/api/project-query"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"
import type { OutreachProject } from "@/features/outreach/project"

import {
  archiveRecommendationPool,
  createCooperationPathOpportunity,
  createOpportunity,
  getRecommendationInventory,
  requestRecommendationRefill,
  retryContactEnrichment,
  retryUnpublishedContacts,
  runCurrentPoolContactEnrichment,
  startContactEnrichment,
  type RecommendationInventoryStatus,
  type RecommendationItem,
} from "./api"
import { sortRecommendationsByContactAndScore } from "./recommendation-contact-ranking"
import {
  type RecommendationRefillState,
  useRecommendationRefill,
} from "./use-recommendation-refill"
import {
  releaseRecommendationStartLease,
  subscribeRecommendationOperation,
  tryAcquireRecommendationStartLease,
} from "./recommendation-operation-session"
import { productStateLabel } from "./recommendation-product-state"
import { RecommendationProjectGate } from "./promotion-target-setup"
import { useRecommendations } from "./use-recommendations"

const reasonLabels: Record<string, string> = {
  PUBLIC_EMAIL_FOUND: "公开邮箱已验证",
  CONTACT_FORM_ONLY: "仅发现联系表单",
  LOGIN_REQUIRED: "页面需要登录",
  CAPTCHA_OR_BOT_CHALLENGE: "触发人机验证",
  ROBOTS_DISALLOWED: "站点禁止自动访问",
  ACCESS_DENIED: "页面拒绝访问",
  NO_PUBLIC_EMAIL: "未发现公开邮箱",
  SITE_UNREACHABLE: "站点无法访问",
  UNSUPPORTED_CONTENT: "页面内容暂不支持",
  MANUAL_REVIEW_REQUIRED: "需要人工复核",
  COMPLETED_PARTIAL: "部分页面已完成",
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

function metric(value: number | null) {
  return value === null
    ? "数据源未提供"
    : value.toLocaleString("zh-CN", { maximumFractionDigits: 0 })
}

function fitTierLabel(value: RecommendationItem["fitDecision"]["matchTier"]) {
  return value === "high_fit" ? "高适合度" : "合格适合度"
}

function marketTierLabel(
  value: RecommendationItem["fitDecision"]["market"]["tier"]
) {
  return value === "target_market"
    ? "目标市场匹配"
    : value === "same_language_expansion"
      ? "同语种扩展市场"
      : "市场语言不匹配"
}

function candidateSourceLabel(value: RecommendationItem["candidateSource"]) {
  return {
    paid_discovery: "DataForSEO 发现",
    resource_library: "资源库补充",
    mixed: "统一供给",
    existing_history: "历史候选",
  }[value]
}

function metricsSourceLabel(value: RecommendationItem["metricsSource"]) {
  return {
    dataforseo: "DataForSEO 指标",
    resource_library_snapshot: "资源库快照指标",
    mixed_snapshot: "混合来源快照",
    historical_snapshot: "历史快照指标",
  }[value]
}

function formatQueryTime(value: number | null) {
  if (value === null) return "尚未查询"
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

function formatServerTime(value: string | null) {
  return value === null ? "服务端未提供" : formatDate(value)
}

function formatProviderCost(value: number) {
  return `$${(value / 1_000_000).toFixed(4)}`
}

function formatDurationSeconds(value: number) {
  const hours = Math.floor(value / 3_600)
  const minutes = Math.floor((value % 3_600) / 60)
  const seconds = value % 60
  return [
    hours > 0 ? `${hours} 小时` : null,
    minutes > 0 ? `${minutes} 分` : null,
    hours === 0 ? `${seconds} 秒` : null,
  ]
    .filter(Boolean)
    .join(" ")
}

const providerAvailabilityLabels: Record<
  RecommendationInventoryStatus["providerAvailability"],
  string
> = {
  available: "可用",
  paused: "暂停",
  unknown: "未知",
}

const recoveryCommandLabels: Record<
  Exclude<RecommendationInventoryStatus["recoveryCommand"], null>,
  string
> = {
  CONTINUE_SAME_CRITERIA: "按当前条件继续",
  EDIT_PROJECT_MATCH_INPUTS: "编辑项目匹配条件",
  BROADEN_MARKET_OR_KEYWORDS: "扩大市场或关键词",
  CHANGE_DISCOVERY_SOURCE: "更换候选来源",
  WAIT_PROVIDER: "等待数据服务恢复",
  RESTART_SERVICE: "恢复推荐服务",
  CONTACT_SUPPORT: "联系支持并提供诊断信息",
}

const outreachReadinessLabels: Record<
  RecommendationItem["outreachReadiness"],
  string
> = {
  ready: "联系人已就绪",
  manual_action: "人工合作路径已就绪",
  contact_pending: "联系人处理中",
  manual_review: "联系人待复核",
  unavailable: "联系人不可用",
}

type RecommendationCooperationPath = NonNullable<
  RecommendationItem["cooperationPath"]
>
type ActionableManualPath = RecommendationCooperationPath & {
  pathType: Exclude<
    NonNullable<RecommendationCooperationPath["pathType"]>,
    "public_email"
  >
  url: string
  contentType: "FORM_MESSAGE" | "SUBMISSION_PITCH"
}

function actionableManualPath(
  item: RecommendationItem
): ActionableManualPath | null {
  const path = item.cooperationPath
  if (
    path === null ||
    path.decision !== "verified" ||
    path.url === null ||
    path.pathType === null ||
    path.pathType === "public_email" ||
    path.contentType === null ||
    path.contentType === "EMAIL"
  ) {
    return null
  }
  return path as ActionableManualPath
}

function cooperationPathLabel(pathType: ActionableManualPath["pathType"]) {
  return {
    contact_form: "联系表单",
    guest_post_submission: "客座文章投稿",
    resource_submission: "资源提交",
    editor_author_page: "编辑或作者页面",
  }[pathType]
}

function initialManualContent(
  project: OutreachProject,
  item: RecommendationItem
) {
  const targetUrl = project.targetUrls[0] ?? item.rootUrl
  const cooperationAngle =
    item.fitDecision.cooperationAngles[0] ?? "a relevant content partnership"
  return [
    "Hello,",
    "",
    `I am reaching out on behalf of ${project.name} (${targetUrl}).`,
    `We would like to discuss ${cooperationAngle}.`,
    "Please let us know the submission requirements and next steps.",
    "",
    "Thank you.",
  ].join("\n")
}

function initialManualNextAction(path: ActionableManualPath) {
  return {
    contact_form: "打开联系表单，核对字段，粘贴文案并由人工提交。",
    guest_post_submission: "打开投稿页面，核对要求并由人工完成投稿。",
    resource_submission: "打开资源提交页面，核对要求并由人工提交。",
    editor_author_page: "打开编辑或作者页面，核对身份信息并选择人工联系动作。",
  }[path.pathType]
}

function productStateMessage(inventory: RecommendationInventoryStatus) {
  const messages: Record<string, string> = {
    VISIBLE_TARGET_REACHED: "当前轮次已达到匹配目标。",
    REFILL_IN_PROGRESS: "系统正在补充并验证候选网站。",
    READY_TO_CONTINUE: "当前条件可继续补充候选网站。",
    RETRY_SCHEDULED: "系统已安排下一次重试。",
    PROVIDER_UNAVAILABLE: "候选数据服务当前不可用，已有结果已保留。",
    BUDGET: "本轮授权预算已用尽，已有结果已保留。",
    BUDGET_PAUSED: "本轮授权预算已用尽，已有结果已保留。",
    TIERS_EXHAUSTED: "当前发现范围已完成，但尚未达到目标数量。",
    SUPPLY_FLOOR_REACHED: "当前发现范围已完成，但尚未达到目标数量。",
    PROJECT_CONTEXT: "项目匹配资料不足，无法继续发现候选。",
    PROJECT_CONTEXT_REQUIRED: "项目匹配资料不足，无法继续发现候选。",
    STALE_BUILD: "当前运行实例不是最新构建。",
    ORPHAN_OPERATION: "任务所有者不可用，需要恢复推荐服务。",
    PROVIDER_CHARGE_REQUIRES_RECONCILIATION:
      "检测到待核对的 Provider 计费状态。",
    RECOVERY_CONFLICT: "任务恢复状态存在冲突。",
    UNKNOWN_INTERNAL:
      inventory.recoveryCommand === "CONTINUE_SAME_CRITERIA"
        ? "推荐流程在调用供应商前中断，可复用原任务继续。"
        : "推荐流程遇到未分类的内部错误。",
  }
  return messages[inventory.productStateReason] ?? inventory.productStateReason
}

function aiCapacityLabel(inventory: RecommendationInventoryStatus) {
  if (inventory.aiCapacity.status === "unconfigured") return "未配置"
  if (inventory.aiCapacity.status === "exhausted") return "已用尽"
  const calls =
    inventory.aiCapacity.remainingCalls === null
      ? "调用次数未提供"
      : `剩余 ${inventory.aiCapacity.remainingCalls} 次`
  const budget =
    inventory.aiCapacity.remainingBudgetMicros === null
      ? "金额未提供"
      : `剩余 ${formatProviderCost(inventory.aiCapacity.remainingBudgetMicros)}`
  return `${calls} · ${budget}`
}

const refillTierLabels: Record<
  RecommendationInventoryStatus["currentRefillTier"],
  string
> = {
  exact_product_target_market: "精确产品与目标市场",
  same_topic_target_market: "同主题与目标市场",
  adjacent_industry_same_audience: "邻近行业与相同受众",
  resource_media_review_partner_ecosystem: "资源、媒体、评测与伙伴生态",
  same_language_expansion: "同语种扩展",
  curated_resource_library: "高权重资源库补充",
}

function refillTerminationMessage(
  inventory: RecommendationInventoryStatus | null
) {
  if (inventory === null) return null
  const count = inventory.visibleMatchCount
  switch (inventory.terminationReason) {
    case "BUDGET":
      return `本轮授权预算已用尽。当前保留 ${count} 个已验证匹配网站。`
    case "PROVIDER_UNAVAILABLE":
      return `候选数据服务当前不可用。当前保留 ${count} 个已验证匹配网站。`
    case "TIERS_EXHAUSTED":
      return `当前发现范围已完成，仍只有 ${count} 个已验证匹配网站。系统不会用不合格网站补足。`
    case "PROJECT_CONTEXT":
      return `当前项目资料不足，无法继续发现。已保留 ${count} 个匹配网站。`
    default:
      return null
  }
}

function ContactBatchWaitView({
  project,
  wait,
  batch,
  inventory,
  error,
  retrying,
  requesting,
  archiving,
  actionLabel,
  actionDisabledReason,
  canArchiveIncompatibleGeneration,
  onStart,
  onRetry,
  onRefresh,
  onArchiveIncompatibleGeneration,
}: {
  project: OutreachProject
  wait: RecommendationRefillState & { active: boolean }
  batch: RecommendationInventoryStatus["contactBatch"]
  inventory: RecommendationInventoryStatus | null
  error: string | null
  retrying: boolean
  requesting: boolean
  archiving: boolean
  actionLabel: string
  actionDisabledReason: string | null
  canArchiveIncompatibleGeneration: boolean
  onStart: () => void | Promise<void>
  onRetry: () => void
  onRefresh: () => void
  onArchiveIncompatibleGeneration: () => void
}) {
  const running =
    wait.active &&
    inventory?.productState === "running" &&
    inventory.stage !== "pause"
  const terminationMessage = refillTerminationMessage(inventory)
  const poolMessage = canArchiveIncompatibleGeneration
    ? "当前轮次仍占用旧版筛选合同。现有任务已终止且没有未决 Provider 状态后，可归档旧版本轮次；归档不会自动调用 DataForSEO。"
    : inventory?.visiblePoolState === "awaiting_refresh"
      ? `第 ${inventory.visiblePoolGeneration - 1} 轮已归档。生成下一轮后，系统会重新寻找 10 个未在历史轮次出现的可联系网站。`
      : null
  const progressMetrics: ReadonlyArray<readonly [string, string | number]> =
    inventory === null
      ? [
          ["产品状态", "等待服务端"],
          ["服务端更新", formatServerTime(wait.lastServerUpdateAt)],
        ]
      : [
          ["产品状态", productStateLabel(inventory, wait.active)],
          [
            "匹配进度",
            `${inventory.visibleMatchCount}/${inventory.visiblePoolTargetCount}`,
          ],
          [
            "活动处理时长",
            formatDurationSeconds(inventory.activeProcessingSeconds),
          ],
          [
            "下次重试",
            inventory.nextRetryAt === null
              ? "未安排"
              : formatDate(inventory.nextRetryAt),
          ],
          [
            "Provider 状态",
            providerAvailabilityLabels[inventory.providerAvailability],
          ],
          [
            "Provider 成本",
            formatProviderCost(inventory.providerActualCostMicros),
          ],
          ...(inventory.providerBalanceMicros === null
            ? []
            : ([
                [
                  "Provider 余额",
                  formatProviderCost(inventory.providerBalanceMicros),
                ],
              ] as const)),
          ["AI 容量", aiCapacityLabel(inventory)],
          ["服务端更新", formatServerTime(wait.lastServerUpdateAt)],
        ]
  return (
    <div
      className="flex min-h-64 flex-col items-center justify-center border-y bg-muted/20 px-4 py-8 text-center"
      role={
        wait.status === "failed" || wait.status === "partial"
          ? "alert"
          : "status"
      }
      aria-busy={running || undefined}
    >
      {running ? (
        <LoaderCircle className="mb-3 size-5 animate-spin text-muted-foreground" />
      ) : (
        <Clock3 className="mb-3 size-5 text-muted-foreground" />
      )}
      <h2 className="text-sm font-medium">
        {canArchiveIncompatibleGeneration
          ? "旧版本推荐轮次待归档"
          : inventory?.visiblePoolState === "awaiting_refresh"
            ? "当前推荐轮次已归档"
            : inventory === null
              ? "正在读取推荐状态"
              : productStateLabel(inventory, wait.active)}
      </h2>
      <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
        {poolMessage ??
          terminationMessage ??
          (inventory === null
            ? `正在读取 ${project.name} 的推荐库存。`
            : productStateMessage(inventory))}
      </p>
      {wait.backgroundContinuation && (
        <p className="mt-2 max-w-xl text-xs leading-5 text-muted-foreground">
          {wait.phase}
        </p>
      )}
      {inventory !== null && (
        <div className="mt-5 grid w-full max-w-2xl grid-cols-2 gap-3 text-left sm:grid-cols-4">
          {[
            ["原始候选", inventory.rawCandidateCount],
            ["已验证匹配", inventory.visibleMatchCount],
            ["联系人已就绪", inventory.publishedContactReadyCount],
            ["推荐轮次", `第 ${inventory.visiblePoolGeneration} 轮`],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0 border-l-2 pl-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1 text-sm font-medium">{value}</div>
            </div>
          ))}
        </div>
      )}
      {wait.status !== "idle" && (
        <div className="mt-5 grid w-full max-w-4xl grid-cols-2 gap-3 text-left sm:grid-cols-4">
          {progressMetrics.map(([label, value]) => (
            <div key={label} className="min-w-0 border-l-2 pl-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1 truncate text-sm font-medium">{value}</div>
            </div>
          ))}
        </div>
      )}
      {(inventory?.providerUnknownChargeCount ?? 0) > 0 && (
        <div className="mt-4 text-sm text-destructive">
          检测到 {inventory?.providerUnknownChargeCount}{" "}
          个未知扣费请求，当前轮次已按治理规则暂停。
        </div>
      )}
      {batch !== null && (
        <>
          <div className="mt-5 grid w-full max-w-2xl grid-cols-2 gap-3 text-left sm:grid-cols-4">
            {[
              ["候选网站", batch.totalJobCount],
              ["已发布", batch.publishedCount],
              ["未发布", batch.unpublishedCount],
              ["已终态", `${batch.terminalJobCount}/${batch.totalJobCount}`],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 border-l-2 pl-3">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-1 text-sm font-medium">{value}</div>
              </div>
            ))}
          </div>
          {batch.reasonCounts.length > 0 && (
            <div className="mt-4 flex max-w-2xl flex-wrap justify-center gap-2">
              {batch.reasonCounts.map((reason) => (
                <Badge key={reason.reasonCode} variant="outline">
                  {reasonLabels[reason.reasonCode] ?? reason.reasonCode}{" "}
                  {reason.count}
                </Badge>
              ))}
            </div>
          )}
        </>
      )}
      {inventory !== null && inventory.attemptedRefillTiers.length > 0 && (
        <div className="mt-4 flex max-w-2xl flex-wrap justify-center gap-2">
          {inventory.attemptedRefillTiers.map((attempt, attemptIndex) => (
            <Badge
              key={`${attempt.round}:${attempt.tier}:${attemptIndex}`}
              variant="outline"
            >
              第 {attempt.round} 轮 · {refillTierLabels[attempt.tier]}
            </Badge>
          ))}
        </div>
      )}
      {inventory !== null && inventory.eliminationReasonCounts.length > 0 && (
        <div className="mt-3 flex max-w-2xl flex-wrap justify-center gap-2">
          {inventory.eliminationReasonCounts.map((reason) => (
            <Badge key={reason.reasonCode} variant="secondary">
              {reasonLabels[reason.reasonCode] ?? reason.reasonCode}{" "}
              {reason.count}
            </Badge>
          ))}
        </div>
      )}
      {(wait.error || error) && (
        <p className="mt-4 text-sm text-destructive">{wait.error ?? error}</p>
      )}
      {actionDisabledReason !== null && (
        <p className="mt-4 max-w-xl text-sm text-destructive">
          阻塞原因：{actionDisabledReason} 恢复操作：{actionLabel}。
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {canArchiveIncompatibleGeneration ? (
          <Button
            onClick={onArchiveIncompatibleGeneration}
            disabled={archiving}
          >
            {archiving ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Archive />
            )}
            归档旧版本轮次
          </Button>
        ) : (
          <Button
            onClick={() => void onStart()}
            disabled={
              requesting || inventory === null || actionDisabledReason !== null
            }
          >
            {running || requesting ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Search />
            )}
            {inventory === null ? "读取服务端状态" : actionLabel}
          </Button>
        )}
        <Button variant="outline" onClick={onRefresh}>
          <RefreshCw />
          重新读取
        </Button>
        {batch !== null && batch.retryableUnpublishedCount > 0 && (
          <Button variant="outline" onClick={onRetry} disabled={retrying}>
            <RefreshCw className={retrying ? "animate-spin" : undefined} />
            仅重试未发布
          </Button>
        )}
      </div>
    </div>
  )
}

function WebsiteIdentity({ item }: { item: RecommendationItem }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-primary/15 bg-primary/5 text-xs font-semibold text-primary">
        {item.hostname.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0">
        <a
          href={item.rootUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-center gap-1 text-base font-semibold hover:underline"
        >
          <span className="truncate">{item.hostname}</span>
          <ExternalLink className="size-3.5 shrink-0" />
        </a>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {item.rootUrl}
        </div>
      </div>
    </div>
  )
}

function ProjectRecommendationsWorkspace({
  project,
}: {
  project: OutreachProject
}) {
  const websiteProjectKey = project.id
  const navigate = useNavigate()
  const [recommendationParams, setRecommendationParams] = useSearchParams()
  const query = useRecommendations(websiteProjectKey, true)
  const refreshRecommendations = query.refresh
  const readInventory = React.useCallback(
    (signal: AbortSignal) =>
      getRecommendationInventory(websiteProjectKey, signal),
    [websiteProjectKey]
  )
  const refreshRecommendationsFromInventory = React.useCallback(async () => {
    await refreshRecommendations()
  }, [refreshRecommendations])
  const wait = useRecommendationRefill(
    project,
    readInventory,
    refreshRecommendationsFromInventory
  )
  const inventory = wait.inventory
  const [requestingRefill, setRequestingRefill] = React.useState(false)
  const [poolAction, setPoolAction] = React.useState<
    "archive" | "archive-and-refresh" | null
  >(null)
  const [error, setError] = React.useState<string | null>(null)
  const refillRequestInFlight = React.useRef(false)
  const [startLeaseOwnerId] = React.useState(() => crypto.randomUUID())
  const refreshWait = wait.refresh
  const recommendationContextVersionId =
    inventory?.recommendationContextVersionId ?? null
  const visiblePoolGeneration = inventory?.visiblePoolGeneration ?? null
  React.useEffect(() => {
    if (
      recommendationContextVersionId === null ||
      visiblePoolGeneration === null
    ) {
      return
    }
    return subscribeRecommendationOperation(
      {
        websiteProjectKey,
        recommendationContextVersionId,
        visiblePoolGeneration,
      },
      () => refreshWait()
    )
  }, [
    recommendationContextVersionId,
    refreshWait,
    visiblePoolGeneration,
    websiteProjectKey,
  ])
  const hasEverDiscovered =
    inventory !== null &&
    (inventory.refillJob !== null ||
      inventory.latestRefillAt !== null ||
      inventory.rawCandidateCount > 0 ||
      inventory.contactBatch !== null)
  const refillPaused =
    inventory?.terminalState === "PAUSED_BUDGET" ||
    inventory?.terminalState === "PAUSED_PROVIDER" ||
    inventory?.productState === "paused_provider"
  const incompatibleGeneration =
    inventory?.visiblePoolState === "building" &&
    inventory.pauseReason === "incompatible_generation"
  const canArchiveCurrentPool =
    inventory?.visiblePoolState === "active" || incompatibleGeneration
  const contactRecoveryRequired =
    wait.contactBatchActivity === "recovery_required"
  const refillActionLabel = contactRecoveryRequired
    ? "重新检查状态"
    : refillPaused
      ? "继续原任务"
      : wait.active
        ? "连接当前批次"
        : inventory?.visiblePoolState === "awaiting_refresh"
          ? "生成下一轮"
          : hasEverDiscovered
            ? "补充推荐"
            : "生成推荐"
  const recoveryCommand = inventory?.recoveryCommand ?? null
  const primaryActionLabel =
    recoveryCommand === null
      ? refillActionLabel
      : recoveryCommandLabels[recoveryCommand]
  const primaryActionDisabledReason = incompatibleGeneration
    ? "当前轮次使用旧版筛选合同，需先归档旧版本轮次。"
    : inventory === null ||
        !["WAIT_PROVIDER", "RESTART_SERVICE", "CONTACT_SUPPORT"].includes(
          recoveryCommand ?? ""
        )
      ? null
      : productStateMessage(inventory)
  const refreshAll = React.useCallback(async () => {
    setError(null)
    refreshWait()
    await refreshRecommendations()
  }, [refreshRecommendations, refreshWait])

  const startOrReconnectRefill = React.useCallback(
    async (
      options: {
        startNewOperation?: boolean
        operationId?: string
      } = {}
    ) => {
      if (contactRecoveryRequired) {
        wait.refresh()
        return
      }
      if (wait.active && !refillPaused) {
        wait.refresh()
        return
      }
      if (
        refillRequestInFlight.current ||
        inventory === null ||
        inventory.recommendationContextVersionId === null
      ) {
        if (inventory !== null) {
          setError("当前项目缺少可用的推荐 Context，请重新读取项目资料。")
        }
        return
      }

      const operationScope = {
        websiteProjectKey,
        recommendationContextVersionId:
          inventory.recommendationContextVersionId,
        visiblePoolGeneration: inventory.visiblePoolGeneration,
      }
      if (
        !tryAcquireRecommendationStartLease(
          window.localStorage,
          operationScope,
          startLeaseOwnerId
        )
      ) {
        setError("另一个标签页正在连接当前任务，正在读取同一 operation。")
        wait.refresh()
        return
      }

      refillRequestInFlight.current = true
      setRequestingRefill(true)
      setError(null)
      try {
        const result = await requestRecommendationRefill(
          websiteProjectKey,
          inventory.recommendationContextVersionId,
          inventory.visiblePoolGeneration,
          options
        )
        wait.connectJob(result)
      } catch (requestError) {
        if (requestError instanceof ApiError && requestError.status === 409) {
          setError("服务端已有当前项目批次，正在重新连接该批次。")
          wait.refresh()
        } else {
          setError("未能创建推荐批次，请重新读取服务端状态后再试。")
        }
      } finally {
        releaseRecommendationStartLease(
          window.localStorage,
          operationScope,
          startLeaseOwnerId
        )
        refillRequestInFlight.current = false
        setRequestingRefill(false)
      }
    },
    [
      contactRecoveryRequired,
      inventory,
      refillPaused,
      startLeaseOwnerId,
      wait,
      websiteProjectKey,
    ]
  )

  const runPrimaryAction = React.useCallback(() => {
    if (
      recoveryCommand === "EDIT_PROJECT_MATCH_INPUTS" ||
      recoveryCommand === "BROADEN_MARKET_OR_KEYWORDS" ||
      recoveryCommand === "CHANGE_DISCOVERY_SOURCE"
    ) {
      navigate(`/projects/${websiteProjectKey}/settings/profile`)
      return
    }
    const operationId = inventory?.operationId ?? undefined
    return startOrReconnectRefill({
      startNewOperation:
        inventory?.terminal === true || operationId === undefined,
      ...(inventory?.terminal === true || operationId === undefined
        ? {}
        : { operationId }),
    })
  }, [
    inventory?.operationId,
    inventory?.terminal,
    navigate,
    recoveryCommand,
    startOrReconnectRefill,
    websiteProjectKey,
  ])

  async function archiveCurrentPool(generateNext: boolean) {
    if (
      poolAction !== null ||
      inventory === null ||
      inventory.recommendationContextVersionId === null ||
      !canArchiveCurrentPool ||
      (generateNext && incompatibleGeneration)
    ) {
      return
    }
    setPoolAction(generateNext ? "archive-and-refresh" : "archive")
    setError(null)
    try {
      const archived = await archiveRecommendationPool(
        websiteProjectKey,
        inventory.recommendationContextVersionId,
        inventory.visiblePoolGeneration
      )
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "recommendations",
      ])
      await refreshRecommendations()
      refreshWait()
      if (!generateNext) {
        setOpportunityAnnouncement(
          `第 ${archived.archivedGeneration} 轮推荐已归档。`
        )
        return
      }

      const nextScope = {
        websiteProjectKey,
        recommendationContextVersionId:
          inventory.recommendationContextVersionId,
        visiblePoolGeneration: archived.nextGeneration,
      }
      if (
        !tryAcquireRecommendationStartLease(
          window.localStorage,
          nextScope,
          startLeaseOwnerId
        )
      ) {
        setError("本轮已归档，另一个标签页正在生成下一轮。")
        refreshWait()
        return
      }
      try {
        const refill = await requestRecommendationRefill(
          websiteProjectKey,
          inventory.recommendationContextVersionId,
          archived.nextGeneration
        )
        wait.connectJob(refill)
        setOpportunityAnnouncement(
          `第 ${archived.archivedGeneration} 轮已归档，第 ${archived.nextGeneration} 轮已开始生成。`
        )
      } finally {
        releaseRecommendationStartLease(
          window.localStorage,
          nextScope,
          startLeaseOwnerId
        )
      }
    } catch (poolError) {
      setError(
        poolError instanceof ApiError && poolError.status === 409
          ? "推荐池状态已变化，请重新读取后再操作。"
          : "推荐池操作失败，请重新读取服务端状态后再试。"
      )
      refreshWait()
    } finally {
      setPoolAction(null)
    }
  }
  const [search, setSearch] = React.useState("")
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const addRequestInFlight = React.useRef(false)
  const [joinedOpportunityIds, setJoinedOpportunityIds] = React.useState<
    Readonly<Record<string, string>>
  >({})
  const [opportunityError, setOpportunityError] = React.useState<{
    recommendationId: string
    message: string
  } | null>(null)
  const [opportunityAnnouncement, setOpportunityAnnouncement] =
    React.useState("")
  const [retrying, setRetrying] = React.useState(false)
  const [batchContactRunning, setBatchContactRunning] = React.useState(false)
  const [batchContactMessage, setBatchContactMessage] = React.useState<
    string | null
  >(null)
  const [contactBusyId, setContactBusyId] = React.useState<string | null>(null)
  const [contactLookupError, setContactLookupError] = React.useState<{
    recommendationId: string
    message: string
  } | null>(null)

  async function retryUnpublished() {
    if (retrying) return
    setRetrying(true)
    setError(null)
    try {
      const result = await retryUnpublishedContacts(websiteProjectKey)
      const batchId = result.batchId
      if (batchId === null) {
        wait.refresh()
      } else {
        wait.connectBatch(batchId)
      }
    } catch {
      setError("未能重试本批未发布网站，请重新读取批次状态。")
    } finally {
      setRetrying(false)
    }
  }

  async function runContactLookup(item: RecommendationItem) {
    if (
      contactBusyId !== null ||
      item.contactJob?.status === "pending" ||
      item.contactJob?.status === "running" ||
      item.contactJob?.status === "retry_scheduled"
    ) {
      return
    }
    setContactBusyId(item.id)
    setContactLookupError(null)
    try {
      if (item.contactJob === null) {
        const started = await startContactEnrichment(websiteProjectKey, item.id)
        if (
          started.replayed &&
          (started.status === "completed" ||
            started.status === "partially_completed" ||
            started.status === "no_contact_found")
        ) {
          await retryContactEnrichment(websiteProjectKey, started.id)
        }
      } else {
        await retryContactEnrichment(websiteProjectKey, item.contactJob.id)
      }
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "recommendations",
      ])
      await refreshRecommendations()
      refreshWait()
      setOpportunityAnnouncement(
        `${item.hostname} 的联系方式查找任务已加入队列。`
      )
    } catch (contactError) {
      setContactLookupError({
        recommendationId: item.id,
        message:
          contactError instanceof ApiError && contactError.status === 409
            ? "任务状态已变化，请刷新后再试。"
            : "未能启动联系方式查找，请稍后重试。",
      })
    } finally {
      setContactBusyId(null)
    }
  }

  async function runCurrentPoolContactLookup() {
    if (batchContactRunning || contactBusyId !== null) return
    setBatchContactRunning(true)
    setBatchContactMessage(null)
    setError(null)
    try {
      const result = await runCurrentPoolContactEnrichment(websiteProjectKey)
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "recommendations",
      ])
      if (result.batchId === null) {
        refreshWait()
      } else {
        wait.connectBatch(result.batchId)
      }
      await refreshRecommendations()

      const queuedCount = result.jobsCreated + result.jobsRetried
      if (queuedCount > 0) {
        setBatchContactMessage(
          `已为 ${queuedCount} 个网站提交联系方式查找任务。`
        )
      } else if (result.activeJobsPreserved > 0) {
        setBatchContactMessage(
          `${result.activeJobsPreserved} 个网站的联系方式任务已在运行。`
        )
      } else if (result.poolRecommendationCount === 0) {
        setBatchContactMessage("当前推荐池没有可批量处理的网站。")
      } else if (result.attemptLimitsSkipped > 0) {
        setBatchContactMessage(
          `${result.attemptLimitsSkipped} 个网站已达到自动重试上限。`
        )
      } else {
        setBatchContactMessage("当前推荐池的网站已有有效联系方式。")
      }
    } catch {
      setError("未能启动批量联系方式查找，请重新读取后再试。")
    } finally {
      setBatchContactRunning(false)
    }
  }

  async function addOpportunity(item: RecommendationItem) {
    const contact = item.contacts.find(
      (candidate) =>
        candidate.id === item.recommendedContactCandidateId &&
        candidate.eligible
    )
    const manualPath = actionableManualPath(item)
    if (busyId || addRequestInFlight.current || joinedOpportunityIds[item.id]) {
      return
    }
    addRequestInFlight.current = true
    setBusyId(item.id)
    setOpportunityError(null)
    try {
      const result =
        contact !== undefined
          ? await createOpportunity(
              websiteProjectKey,
              item.id,
              contact.id,
              item.version
            )
          : manualPath !== null
            ? await createCooperationPathOpportunity(websiteProjectKey, {
                recommendationId: item.id,
                cooperationPathFactId: manualPath.factId,
                expectedVersion: item.version,
                editableContent: initialManualContent(project, item),
                nextAction: initialManualNextAction(manualPath),
              })
            : await createOpportunity(
                websiteProjectKey,
                item.id,
                undefined,
                item.version
              )
      if (result.websiteProjectId !== result.meta.websiteProjectId) {
        throw new Error("Opportunity project identity mismatch")
      }
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "recommendations",
      ])
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "opportunities",
      ])
      setJoinedOpportunityIds((current) => ({
        ...current,
        [item.id]: result.opportunityId,
      }))
      setOpportunityAnnouncement(
        `${item.hostname} 已加入 Opportunity。你仍在推荐池中。`
      )
    } catch {
      setOpportunityError({
        recommendationId: item.id,
        message: "创建 Opportunity 失败。请刷新推荐后重试。",
      })
    } finally {
      addRequestInFlight.current = false
      setBusyId(null)
    }
  }

  if (query.status === "loading") {
    return <OutreachStandardStateView state="loading" title="正在加载推荐池" />
  }
  if (query.status === "empty") {
    if (project.inputRequired.length > 0) {
      return (
        <OutreachStandardStateView
          state="empty"
          title="先完善当前项目资料"
          description={`缺少 ${project.inputRequired.join("、")}，服务端不会使用其他项目资料代替。`}
          onRetry={() =>
            navigate(`/projects/${websiteProjectKey}/settings/profile`)
          }
          retryLabel="完善项目资料"
        />
      )
    }
    return (
      <ContactBatchWaitView
        project={project}
        wait={wait}
        batch={wait.batch ?? inventory?.contactBatch ?? null}
        inventory={inventory}
        error={error}
        retrying={retrying}
        requesting={requestingRefill}
        archiving={poolAction === "archive"}
        actionLabel={primaryActionLabel}
        actionDisabledReason={primaryActionDisabledReason}
        canArchiveIncompatibleGeneration={incompatibleGeneration}
        onStart={runPrimaryAction}
        onRetry={() => void retryUnpublished()}
        onRefresh={() => void refreshAll()}
        onArchiveIncompatibleGeneration={() => void archiveCurrentPool(false)}
      />
    )
  }
  if (query.status !== "data") {
    return (
      <OutreachStandardStateView
        state={query.status}
        title={
          query.status === "forbidden"
            ? "当前账号无权查看该项目的推荐"
            : query.status === "offline"
              ? "推荐池当前离线"
              : "推荐池加载失败"
        }
        description="不会回退到演示数据或其他项目数据。"
        onRetry={() => void refreshAll()}
        retryLabel="重新读取"
      />
    )
  }

  const batch = wait.batch ?? inventory?.contactBatch ?? null
  const rows = sortRecommendationsByContactAndScore(
    query.items.filter((item) =>
      item.hostname.toLowerCase().includes(search.trim().toLowerCase())
    )
  )
  const selectedRecommendationId = recommendationParams.get("recommendationId")
  const selectedItem =
    rows.find((item) => item.id === selectedRecommendationId) ?? rows[0] ?? null
  const selectedContact =
    selectedItem?.contacts.find(
      (candidate) =>
        candidate.id === selectedItem.recommendedContactCandidateId &&
        candidate.eligible
    ) ?? null
  const selectedEvidence = selectedContact?.evidence[0] ?? null
  const selectedManualPath =
    selectedItem === null ? null : actionableManualPath(selectedItem)
  const selectedJoinedOpportunityId =
    selectedItem === null ? undefined : joinedOpportunityIds[selectedItem.id]

  return (
    <div>
      <div className="sr-only" role="status" aria-live="polite">
        {opportunityAnnouncement}
      </div>
      {query.presentationState === "legacy_stale" && (
        <div
          className="mb-4 border-l-2 border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          role="status"
        >
          <div className="font-medium">正在按 V4 新规则重算</div>
          <p className="mt-1 text-xs">
            暂时显示上一次已发布结果。这些旧结果不会参与当前 V4
            排序或资格判断，新的 V4 候选发布后会自动替换。
          </p>
        </div>
      )}
      {inventory !== null && (
        <div
          className="mb-4 flex flex-col gap-3 border-l-2 border-primary bg-muted/30 px-4 py-3 text-sm lg:flex-row lg:items-start lg:justify-between"
          role={
            inventory.productState === "blocked" ||
            inventory.productState === "partial_exhausted"
              ? "alert"
              : "status"
          }
          aria-busy={wait.active || undefined}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-medium">
              {wait.active && inventory.stage !== "pause" ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Clock3 className="size-4" />
              )}
              {productStateLabel(inventory, wait.active)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              已验证匹配 {inventory.visibleMatchCount}/
              {inventory.visiblePoolTargetCount} · 原始候选{" "}
              {inventory.rawCandidateCount} · 活动处理{" "}
              {formatDurationSeconds(inventory.activeProcessingSeconds)} ·
              Provider{" "}
              {providerAvailabilityLabels[inventory.providerAvailability]} ·
              成本 {formatProviderCost(inventory.providerActualCostMicros)}
              {inventory.providerBalanceMicros === null
                ? ""
                : ` · 余额 ${formatProviderCost(
                    inventory.providerBalanceMicros
                  )}`}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              AI 容量 {aiCapacityLabel(inventory)} · 下次重试{" "}
              {inventory.nextRetryAt === null
                ? "未安排"
                : formatDate(inventory.nextRetryAt)}{" "}
              · 最后读取 {formatQueryTime(wait.lastQueryAt)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {productStateMessage(inventory)}
            </div>
            {wait.error && (
              <div className="mt-1 text-xs text-destructive">{wait.error}</div>
            )}
          </div>
          {recoveryCommand !== null && (
            <div className="shrink-0">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runPrimaryAction()}
                disabled={
                  requestingRefill || primaryActionDisabledReason !== null
                }
              >
                {requestingRefill ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                {primaryActionLabel}
              </Button>
              {primaryActionDisabledReason !== null && (
                <div className="mt-1 max-w-xs text-xs text-destructive">
                  阻塞原因：{primaryActionDisabledReason}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:flex sm:items-stretch">
        {[
          ["已验证匹配", inventory?.visibleMatchCount ?? query.items.length],
          ["本轮目标", inventory?.visiblePoolTargetCount ?? 10],
          [
            "已加入机会",
            query.items.filter(
              (item) =>
                item.existingOpportunityId !== null ||
                joinedOpportunityIds[item.id] !== undefined
            ).length,
          ],
          ["历史已归档", inventory?.archivedVisiblePoolCount ?? 0],
        ].map(([label, value]) => (
          <div
            key={label}
            className="flex min-w-0 flex-1 items-center justify-between gap-3 bg-background px-4 py-2.5 sm:justify-start"
          >
            <span className="truncate text-xs text-muted-foreground">
              {label}
            </span>
            <span className="text-base font-semibold tabular-nums">
              {value}
            </span>
          </div>
        ))}
      </div>

      <Card className="overflow-hidden rounded-lg border-border/80 shadow-sm ring-0">
        <div className="space-y-3 border-b bg-muted/15 p-3 sm:p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索网站域名..."
                className="rounded-md border-border bg-background pl-9 shadow-none xl:max-w-sm"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => void runCurrentPoolContactLookup()}
                disabled={
                  batchContactRunning ||
                  contactBusyId !== null ||
                  poolAction !== null ||
                  query.items.length === 0 ||
                  query.presentationState === "legacy_stale"
                }
                className="rounded-md shadow-none"
              >
                {batchContactRunning ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Mail />
                )}
                {batchContactRunning ? "正在批量提交" : "批量查找联系方式"}
              </Button>
              <Button
                variant="outline"
                onClick={() => void archiveCurrentPool(false)}
                disabled={poolAction !== null || !canArchiveCurrentPool}
                className="rounded-md shadow-none"
              >
                {poolAction === "archive" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Archive />
                )}
                {incompatibleGeneration ? "归档旧版本轮次" : "归档本轮"}
              </Button>
              <Button
                onClick={() => void archiveCurrentPool(true)}
                disabled={
                  poolAction !== null ||
                  inventory?.visiblePoolState !== "active"
                }
                className="rounded-md shadow-none"
              >
                {poolAction === "archive-and-refresh" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RotateCw />
                )}
                归档并生成下一轮
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => void refreshAll()}
                title="重新读取"
                aria-label="重新读取"
                className="rounded-md shadow-none"
              >
                <RefreshCw />
              </Button>
            </div>
          </div>
          {batch !== null && batch.reasonCounts.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">
                联系人处理摘要
              </summary>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {batch.reasonCounts.map((reason) => (
                  <span key={reason.reasonCode}>
                    {reasonLabels[reason.reasonCode] ?? reason.reasonCode}{" "}
                    {reason.count}
                  </span>
                ))}
              </div>
            </details>
          )}
          {batchContactMessage !== null && (
            <div role="status" className="text-xs text-muted-foreground">
              {batchContactMessage}
            </div>
          )}
          {error && (
            <div role="alert" className="text-sm text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="grid min-h-[36rem] lg:grid-cols-[minmax(18rem,0.34fr)_minmax(0,1fr)]">
          <aside className="min-w-0 border-b bg-muted/10 lg:border-r lg:border-b-0">
            <div className="flex h-11 items-center justify-between border-b bg-muted/20 px-4">
              <span className="text-xs font-semibold text-foreground">
                推荐网站
              </span>
              <span className="text-xs text-muted-foreground">
                {rows.length} 个结果
              </span>
            </div>
            <div className="max-h-80 overflow-y-auto lg:max-h-[46rem]">
              {rows.map((item) => {
                const isSelected = selectedItem?.id === item.id
                const joinedOpportunityId = joinedOpportunityIds[item.id]
                const isJoined =
                  item.existingOpportunityId !== null ||
                  joinedOpportunityId !== undefined
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() =>
                      setRecommendationParams({ recommendationId: item.id })
                    }
                    className={`group w-full border-b border-l-[3px] px-4 py-3.5 text-left transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none ${
                      isSelected
                        ? "border-l-primary bg-background"
                        : "border-l-transparent hover:bg-background/80"
                    }`}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div
                          className={`truncate text-sm font-semibold ${
                            isSelected
                              ? "text-foreground"
                              : "text-foreground/90"
                          }`}
                        >
                          {item.hostname}
                        </div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          {marketTierLabel(item.fitDecision.market.tier)}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 rounded-md border px-1.5 py-0.5 text-xs font-semibold tabular-nums ${
                          isSelected
                            ? "border-primary/20 bg-primary/5 text-primary"
                            : "border-border bg-muted/40 text-foreground"
                        }`}
                      >
                        {item.fitDecision.overallFit.toFixed(1)}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                      <span className="truncate text-muted-foreground">
                        Rank {metric(item.fitDecision.dataForSeo.rank)} · 流量{" "}
                        {metric(item.fitDecision.dataForSeo.traffic)}
                      </span>
                      <span
                        className={
                          isJoined
                            ? "shrink-0 font-medium text-primary"
                            : "shrink-0 text-muted-foreground"
                        }
                      >
                        {isJoined
                          ? "已加入机会"
                          : outreachReadinessLabels[item.outreachReadiness]}
                      </span>
                    </div>
                  </button>
                )
              })}
              {rows.length === 0 && (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  当前搜索条件下没有已验证匹配网站。
                </div>
              )}
            </div>
          </aside>

          <section className="min-w-0 bg-background p-4 sm:p-5 lg:p-7">
            {selectedItem === null ? (
              <div className="flex min-h-72 items-center justify-center text-sm text-muted-foreground">
                选择一个网站查看详情
              </div>
            ) : (
              <div className="mx-auto max-w-5xl">
                <header className="flex flex-col gap-4 border-b pb-5 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <WebsiteIdentity item={selectedItem} />
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Badge
                        variant="secondary"
                        className="rounded-md border border-border/60"
                      >
                        {fitTierLabel(selectedItem.fitDecision.matchTier)} ·{" "}
                        {selectedItem.presentationState === "legacy_stale"
                          ? "旧模型分数"
                          : "综合适合度"}{" "}
                        {selectedItem.fitDecision.overallFit.toFixed(1)}
                      </Badge>
                      <Badge variant="outline" className="rounded-md">
                        {marketTierLabel(selectedItem.fitDecision.market.tier)}
                      </Badge>
                      <Badge
                        variant={
                          selectedItem.outreachReadiness === "ready" ||
                          selectedItem.outreachReadiness === "manual_action"
                            ? "default"
                            : "outline"
                        }
                        className="rounded-md"
                      >
                        {
                          outreachReadinessLabels[
                            selectedItem.outreachReadiness
                          ]
                        }
                      </Badge>
                    </div>
                  </div>

                  <div className="shrink-0">
                    {selectedJoinedOpportunityId ? (
                      <Button
                        onClick={() =>
                          navigate(
                            `/projects/${websiteProjectKey}/backlinks/opportunities?opportunityId=${selectedJoinedOpportunityId}`
                          )
                        }
                        className="rounded-md px-4 shadow-sm"
                      >
                        <ExternalLink />
                        已加入 · 打开机会
                      </Button>
                    ) : selectedItem.existingOpportunityId ? (
                      <Button
                        onClick={() =>
                          navigate(
                            `/projects/${websiteProjectKey}/backlinks/opportunities?opportunityId=${selectedItem.existingOpportunityId}`
                          )
                        }
                        className="rounded-md px-4 shadow-sm"
                      >
                        <ExternalLink />
                        打开 Opportunity
                      </Button>
                    ) : (
                      <Button
                        onClick={() => void addOpportunity(selectedItem)}
                        disabled={
                          Boolean(busyId) ||
                          !selectedItem.canCreateOpportunity ||
                          selectedItem.presentationState === "legacy_stale"
                        }
                        className="rounded-md px-4 shadow-sm"
                      >
                        {busyId === selectedItem.id ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <CirclePlus />
                        )}
                        {selectedItem.presentationState === "legacy_stale"
                          ? "重算中，暂不可加入"
                          : selectedItem.canCreateOpportunity
                            ? "加入 Opportunity"
                            : "当前不可加入"}
                      </Button>
                    )}
                    {opportunityError?.recommendationId === selectedItem.id && (
                      <p
                        role="alert"
                        className="mt-2 max-w-xs text-xs text-destructive"
                      >
                        {opportunityError.message}
                      </p>
                    )}
                  </div>
                </header>

                <section className="border-b py-5">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-4 w-1 rounded-full bg-primary/70"
                    />
                    <h3 className="text-sm font-semibold">匹配摘要</h3>
                  </div>
                  <dl className="mt-3 grid gap-x-8 gap-y-4 text-sm md:grid-cols-2">
                    <div className="border-l-2 border-border pl-3">
                      <dt className="text-xs text-muted-foreground">市场</dt>
                      <dd className="mt-1 leading-6">
                        目标 {selectedItem.fitDecision.market.targetCountry} /{" "}
                        {selectedItem.fitDecision.market.targetLanguage}；候选{" "}
                        {selectedItem.fitDecision.market.candidateCountry ??
                          "国家未提供"}{" "}
                        /{" "}
                        {selectedItem.fitDecision.market.candidateLanguage ??
                          "语言未识别"}
                      </dd>
                    </div>
                    <div className="border-l-2 border-border pl-3">
                      <dt className="text-xs text-muted-foreground">
                        合作角度
                      </dt>
                      <dd className="mt-1 leading-6">
                        {selectedItem.fitDecision.cooperationAngles.join(
                          "、"
                        ) || "编辑合作评估合格"}
                      </dd>
                    </div>
                    <div className="border-l-2 border-border pl-3">
                      <dt className="text-xs text-muted-foreground">
                        匹配主题
                      </dt>
                      <dd className="mt-1 leading-6">
                        {selectedItem.fitDecision.matchedTopics.join("、") ||
                          "未提供"}
                      </dd>
                    </div>
                    <div className="border-l-2 border-border pl-3">
                      <dt className="text-xs text-muted-foreground">
                        匹配关键词
                      </dt>
                      <dd className="mt-1 leading-6">
                        {selectedItem.fitDecision.matchedKeywords.join("、") ||
                          "未提供"}
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
                    <span>
                      来源 {candidateSourceLabel(selectedItem.candidateSource)}
                    </span>
                    <span>
                      优先级 {selectedItem.priority === "high" ? "高" : "标准"}
                    </span>
                    <span>风险 {selectedItem.risk.level}</span>
                    {selectedItem.resourceType !== null && (
                      <span>
                        资源库{" "}
                        {selectedItem.resourceType === "free" ? "免费" : "付费"}
                      </span>
                    )}
                  </div>
                </section>

                <section className="border-b py-5">
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-4 w-1 rounded-full bg-primary/70"
                    />
                    <h3 className="text-sm font-semibold">关键指标</h3>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border text-sm md:grid-cols-5">
                    {[
                      ["Rank", selectedItem.fitDecision.dataForSeo.rank],
                      ["流量", selectedItem.fitDecision.dataForSeo.traffic],
                      [
                        "Backlinks",
                        selectedItem.fitDecision.dataForSeo.backlinks,
                      ],
                      [
                        "Ref. Domains",
                        selectedItem.fitDecision.dataForSeo.referringDomains,
                      ],
                      [
                        "垃圾风险",
                        selectedItem.fitDecision.dataForSeo.spamScore,
                      ],
                    ].map(([label, value], index) => (
                      <div
                        key={label}
                        className={`bg-background px-3 py-3 ${
                          index === 4 ? "col-span-2 md:col-span-1" : ""
                        }`}
                      >
                        <div className="text-xs text-muted-foreground">
                          {label}
                        </div>
                        <div className="mt-1 text-base font-semibold break-all tabular-nums">
                          {metric(value as number | null)}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 text-xs text-muted-foreground">
                    指标来源：{metricsSourceLabel(selectedItem.metricsSource)}
                  </div>
                </section>

                <section className="border-b py-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="h-4 w-1 rounded-full bg-primary/70"
                      />
                      <Mail className="size-4 text-muted-foreground" />
                      <h3 className="text-sm font-semibold">
                        联系人与外联准备
                      </h3>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-start rounded-md sm:self-auto"
                      onClick={() => void runContactLookup(selectedItem)}
                      disabled={
                        contactBusyId !== null ||
                        selectedItem.contactJob?.status === "pending" ||
                        selectedItem.contactJob?.status === "running" ||
                        selectedItem.contactJob?.status === "retry_scheduled" ||
                        selectedItem.contactJob?.status === "stale_context" ||
                        (selectedItem.contactJob?.attemptCount ?? 0) >= 10
                      }
                    >
                      <RefreshCw
                        className={
                          contactBusyId === selectedItem.id ||
                          selectedItem.contactJob?.status === "pending" ||
                          selectedItem.contactJob?.status === "running" ||
                          selectedItem.contactJob?.status === "retry_scheduled"
                            ? "animate-spin"
                            : undefined
                        }
                      />
                      {contactBusyId === selectedItem.id
                        ? "正在提交"
                        : selectedItem.contactJob?.status === "pending" ||
                            selectedItem.contactJob?.status === "running" ||
                            selectedItem.contactJob?.status ===
                              "retry_scheduled"
                          ? "正在查找"
                          : selectedItem.contactJob === null
                            ? "查找联系方式"
                            : (selectedItem.contactJob?.attemptCount ?? 0) >= 10
                              ? "已达重试上限"
                              : "重新查找联系方式"}
                    </Button>
                  </div>
                  {selectedContact &&
                  selectedEvidence &&
                  selectedItem.contactDecision !== null &&
                  selectedItem.emailSource !== null ? (
                    <div className="mt-3 border-l-2 border-primary bg-muted/20 px-4 py-3 text-sm">
                      <div className="font-medium break-all">
                        {selectedContact.normalizedEmail}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>用途 {selectedContact.inferredPurpose}</span>
                        <span>联系人置信度 {selectedContact.confidence}</span>
                        <span>
                          用途置信度 {selectedContact.purposeConfidence}
                        </span>
                      </div>
                      <a
                        href={selectedItem.contactDecision.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex max-w-full items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <span className="truncate">
                          查看公开证据 · {selectedEvidence.extractionMethod}
                        </span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                    </div>
                  ) : selectedManualPath ? (
                    <div className="mt-3 border-l-2 border-primary bg-muted/20 px-4 py-3 text-sm">
                      <div className="font-medium">
                        {cooperationPathLabel(selectedManualPath.pathType)}
                        已验证
                      </div>
                      <a
                        href={selectedManualPath.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex max-w-full items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <span className="truncate">查看合作路径证据</span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                      <p className="mt-2 text-xs text-muted-foreground">
                        加入后会生成可编辑文案和人工操作记录，不会自动提交表单。
                      </p>
                    </div>
                  ) : selectedItem.contactPageUrl !== null ? (
                    <div className="mt-3 border-l-2 border-primary bg-muted/20 px-4 py-3 text-sm">
                      <div className="font-medium">发现公开联系页面</div>
                      <a
                        href={selectedItem.contactPageUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex max-w-full items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <span className="truncate">
                          {selectedItem.contactPageUrl}
                        </span>
                        <ExternalLink className="size-3 shrink-0" />
                      </a>
                      <p className="mt-2 text-xs text-muted-foreground">
                        页面包含可用联系表单，需要人工打开并提交。
                      </p>
                    </div>
                  ) : (
                    <div className="mt-3 border-l-2 border-border bg-muted/20 px-4 py-3 text-sm">
                      <div className="font-medium">
                        {selectedItem.contactStatus === "running"
                          ? "正在查找公开联系方式"
                          : selectedItem.contactStatus === "not_started"
                            ? "尚未开始查找联系方式"
                            : "本次未找到可验证联系方式"}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedItem.contactStatus === "running"
                          ? "任务完成后会自动返回邮箱、联系页面或明确失败原因。"
                          : selectedItem.contactStatus === "not_started"
                            ? "点击上方按钮即可单独运行联系人查找，不影响推荐结果。"
                            : "可以重新查找；网站会继续保留在推荐池中。"}
                      </p>
                    </div>
                  )}
                  {contactLookupError?.recommendationId === selectedItem.id && (
                    <p role="alert" className="mt-2 text-xs text-destructive">
                      {contactLookupError.message}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
                    <span>
                      已访问 {selectedItem.contactJob?.pagesVisited ?? 0} 页
                    </span>
                    <span>
                      证据 {selectedItem.contactJob?.evidenceCount ?? 0} 条
                    </span>
                    <span>
                      方法 {selectedItem.contactJob?.method ?? "none"}
                    </span>
                    <span>
                      终态{" "}
                      {selectedItem.contactJob?.terminalReasonCode === null ||
                      selectedItem.contactJob === null
                        ? "待同步"
                        : (reasonLabels[
                            selectedItem.contactJob.terminalReasonCode
                          ] ?? selectedItem.contactJob.terminalReasonCode)}
                    </span>
                  </div>
                  {selectedItem.createBlockReason ===
                    "existing_opportunity" && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      该域名已在当前项目的 Opportunity 中。
                    </p>
                  )}
                </section>

                <details className="py-4 text-sm">
                  <summary className="cursor-pointer rounded-md px-2 py-2 font-semibold hover:bg-muted/50">
                    查看证据与数据来源
                  </summary>
                  <div className="mt-4 space-y-4">
                    {selectedItem.relevantPages.length > 0 && (
                      <div>
                        <div className="text-xs text-muted-foreground">
                          相关内容页
                        </div>
                        <div className="mt-2 space-y-1">
                          {selectedItem.relevantPages.map((url) => (
                            <a
                              key={url}
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="flex max-w-full items-center gap-1 text-xs text-primary hover:underline"
                            >
                              <span className="truncate">{url}</span>
                              <ExternalLink className="size-3 shrink-0" />
                            </a>
                          ))}
                        </div>
                      </div>
                    )}
                    {selectedItem.fitDecision.dataForSeo.backlinkPageEvidence
                      .length > 0 && (
                      <div>
                        <div className="text-xs text-muted-foreground">
                          页面级外链证据
                        </div>
                        <div className="mt-2 divide-y border-y">
                          {selectedItem.fitDecision.dataForSeo.backlinkPageEvidence.map(
                            (evidence) => (
                              <div
                                key={`${evidence.sourceUrl}:${evidence.targetUrl}`}
                                className="space-y-1 py-3 text-xs"
                              >
                                <div>
                                  {evidence.linkStatus === "active"
                                    ? "Active"
                                    : "Lost"}{" "}
                                  · 锚文本 {evidence.anchorText || "未提供"}
                                </div>
                                <a
                                  href={evidence.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block truncate text-primary hover:underline"
                                >
                                  来源页：{evidence.sourceUrl}
                                </a>
                                <a
                                  href={evidence.targetUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block truncate text-primary hover:underline"
                                >
                                  竞争对手目标页：{evidence.targetUrl}
                                </a>
                                <div className="text-muted-foreground">
                                  首次发现{" "}
                                  {evidence.firstSeenAt === null
                                    ? "未提供"
                                    : formatDate(evidence.firstSeenAt)}
                                  {" · "}
                                  最后发现{" "}
                                  {evidence.lastSeenAt === null
                                    ? "未提供"
                                    : formatDate(evidence.lastSeenAt)}
                                </div>
                              </div>
                            )
                          )}
                        </div>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                      <span>获取于 {formatDate(selectedItem.acquiredAt)}</span>
                      <span>
                        候选来源{" "}
                        {candidateSourceLabel(selectedItem.candidateSource)}
                      </span>
                      <span>
                        指标来源{" "}
                        {metricsSourceLabel(selectedItem.metricsSource)}
                      </span>
                    </div>
                  </div>
                </details>
              </div>
            )}
          </section>
        </div>
      </Card>
    </div>
  )
}

export function RecommendationsWorkspace({
  project,
}: {
  project: OutreachProject
}) {
  return (
    <RecommendationProjectGate
      key={`${project.id}:${project.profileVersion ?? "no-profile"}:${project.contextVersion}`}
      project={project}
    >
      {(readyProject) => (
        <ProjectRecommendationsWorkspace
          key={`${readyProject.id}:${readyProject.profileVersion ?? "no-profile"}:${readyProject.targetUrls.join(",")}`}
          project={readyProject}
        />
      )}
    </RecommendationProjectGate>
  )
}
