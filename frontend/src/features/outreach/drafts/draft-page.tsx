import * as React from "react"
import {
  ArrowLeft,
  Check,
  CircleCheck,
  CircleX,
  Clock3,
  Info,
  Languages,
  LoaderCircle,
  Mail,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  TriangleAlert,
  WandSparkles,
  type LucideIcon,
} from "lucide-react"
import { Link, useParams } from "react-router"

import { ApiError } from "@/api/client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import {
  approveDraft,
  createSendIntent,
  getDraft,
  getSendIntent,
  listDraftSendIntents,
  listOpportunityContacts,
  preflightSendIntent,
  saveDraftVersion,
} from "@/features/outreach/drafts/api"
import {
  emptyDraftDocument,
  normalizeDraftDocument,
  sanitizeDraftRecipientDocument,
  sanitizeDraftRecipientText,
} from "@/features/outreach/drafts/draft-document"
import { DraftEditor } from "@/features/outreach/drafts/draft-editor"
import { DraftGeneration } from "@/features/outreach/drafts/draft-generation"
import { isSendReadinessSnapshotUsable } from "@/features/outreach/drafts/send-readiness"
import { toOutreachProject } from "@/features/outreach/project"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"
import { useProjects } from "@/features/projects/project-context"
import type {
  DraftDocument,
  DraftSnapshot,
  DraftStatus,
  OpportunityContact,
  SendIntentPreflight,
  SendIntentResult,
  SendIntentView,
} from "@/features/outreach/drafts/types"
import { useGmailConnection } from "@/features/outreach/gmail/use-gmail-connection"

const statusLabels: Record<DraftStatus, string> = {
  generating: "生成中",
  draft: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  sent: "已发送",
}

const terminalSendIntentStatuses = new Set<SendIntentView["status"]>([
  "PROVIDER_ACCEPTED",
  "DELIVERY_UNKNOWN",
  "FAILED_FINAL",
  "CANCELLED",
  "REJECTED",
])

type SendStatusPresentation = {
  icon: LucideIcon
  title: string
  description: string
  iconClassName: string
}

function sendFailureDescription(
  errorCode: string | null,
  retryScheduled: boolean
): string {
  switch (errorCode) {
    case "GMAIL_SEND_PRE_REQUEST_FAILED":
      return retryScheduled
        ? "发送前置检查暂时失败，邮件确定未发送。系统已安排安全重试。"
        : "发送前置检查失败，邮件确定未发送。系统未安排后续任务，请检查 Gmail 连接后重新提交。"
    case "GMAIL_SEND_TOKEN_REFRESH_FAILED":
      return retryScheduled
        ? "Gmail 凭据暂时无法刷新，邮件确定未发送。系统已安排安全重试。"
        : "Gmail 凭据无法刷新，邮件确定未发送。请重新检查 Gmail 连接后再提交。"
    case "GMAIL_SEND_PROVIDER_NETWORK":
      return retryScheduled
        ? "连接 Gmail 时发生网络故障，邮件确定未发送。系统已安排安全重试。"
        : "连接 Gmail 时发生网络故障，邮件确定未发送。系统没有安排自动重试，请重新提交。"
    case "GMAIL_SEND_REAUTH_REQUIRED":
      return "Gmail 授权已失效，邮件确定未发送。请重新授权后再提交。"
    case "GMAIL_SEND_RATE_LIMITED":
      return retryScheduled
        ? "Gmail 暂时限制发送，邮件确定未发送。系统已按允许时间安排重试。"
        : "Gmail 暂时限制发送，邮件确定未发送。系统没有安排自动重试。"
    case "GMAIL_SEND_FORBIDDEN":
      return "发送策略阻止了本次邮件，邮件确定未发送。"
    case "GMAIL_SEND_INVALID_REQUEST":
      return "发送内容或身份校验未通过，邮件确定未发送。"
    case "GMAIL_SEND_RFC_MESSAGE_NOT_FOUND":
      return "Gmail 中没有找到本次邮件，已确认邮件未发送。可以重新准备后再次提交。"
    default:
      return "邮件没有完成发送，请查看处理建议。"
  }
}

function sendStatusPresentation(
  status: SendIntentView["status"],
  errorCode: string | null,
  retryScheduled: boolean
): SendStatusPresentation {
  switch (status) {
    case "READY":
      return {
        icon: Clock3,
        title: "已加入发送队列",
        description: "Worker 将接管本次发送，无需重复点击。",
        iconClassName: "text-muted-foreground",
      }
    case "DISPATCHING":
      return {
        icon: LoaderCircle,
        title: "正在提交至 Gmail",
        description: "系统正在提交并核对结果。为避免重复邮件，请勿重复操作。",
        iconClassName: "animate-spin text-primary",
      }
    case "PROVIDER_ACCEPTED":
      return {
        icon: CircleCheck,
        title: "邮件发送成功",
        description:
          "Gmail 已确认本次发送，系统将继续同步后续回复；这不代表收件人已读。",
        iconClassName: "text-emerald-700",
      }
    case "DELIVERY_UNKNOWN":
      return {
        icon: TriangleAlert,
        title: "发送结果需要核对",
        description:
          "Gmail 的最终结果尚未确认。系统不会直接重发，以免收件人收到重复邮件。",
        iconClassName: "text-amber-700",
      }
    case "FAILED_RETRYABLE":
      return {
        icon: RefreshCw,
        title: "暂时未发送",
        description: sendFailureDescription(errorCode, retryScheduled),
        iconClassName: "text-amber-700",
      }
    case "FAILED_FINAL":
      return {
        icon: CircleX,
        title: "邮件未发送",
        description: sendFailureDescription(errorCode, retryScheduled),
        iconClassName: "text-destructive",
      }
    case "CANCELLED":
      return {
        icon: CircleX,
        title: "发送已取消",
        description: "本次发送任务已取消，没有继续提交。",
        iconClassName: "text-muted-foreground",
      }
    case "REJECTED":
      return {
        icon: CircleX,
        title: "发送未获批准",
        description: "本次发送被拒绝，没有提交至 Gmail。",
        iconClassName: "text-destructive",
      }
  }
}

const draftStaleReasonLabels = {
  PROJECT_CONTEXT_CHANGED: "项目资料或推广目标版本已变化",
  OPPORTUNITY_CHANGED: "Opportunity 版本已变化",
  CONTACT_CHANGED: "联系人已变化或不可再使用",
} as const

const draftSourceLabels: Record<
  NonNullable<DraftSnapshot["currentVersion"]>["source"],
  string
> = {
  MODEL: "AI 生成",
  TEMPLATE_FALLBACK: "基础模板",
  MANUAL: "人工编辑",
  RESTORED: "恢复版本",
}

const draftReadinessLabels: Record<
  NonNullable<DraftSnapshot["currentVersion"]>["readiness"],
  string
> = {
  AI_DRAFT_READY: "可审批",
  BASIC_DRAFT_READY: "需要人工编辑",
  EDITED_DRAFT_READY: "已人工编辑",
}

function fallbackReasonLabel(reason: string | null): string {
  switch (reason) {
    case "UNAVAILABLE":
      return "AI 服务当时不可用"
    case "TIMEOUT":
      return "AI 生成请求超时"
    case "RATE_LIMITED":
      return "AI 服务达到调用限制"
    default:
      return "AI 生成未成功完成"
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "草稿版本已变化，请刷新后再继续。"
  }
  if (error instanceof ApiError && error.status === 404) {
    return "未找到该草稿，或草稿不属于当前项目。"
  }
  return error instanceof Error ? error.message : "请求失败，请稍后重试。"
}

type SendPreflightFailure = {
  code: string
  message: string
  repair: string
  details?: readonly string[]
}

const sendPreflightFailures: Record<
  string,
  Omit<SendPreflightFailure, "code">
> = {
  GMAIL_CONNECTION_NOT_SELECTED: {
    message: "当前项目尚未选择 Gmail 发件账号。",
    repair: "前往邮件中心选择组织已有账号。",
  },
  GMAIL_REAUTH_REQUIRED: {
    message: "Gmail 授权已失效或需要重新确认。",
    repair: "重新完成 Gmail 授权后再检查。",
  },
  GMAIL_SEND_DISABLED: {
    message: "本地 Gmail Send 运行能力当前关闭。",
    repair: "恢复运行配置并正常重启本地产品后再检查。",
  },
  GMAIL_SCOPE_INSUFFICIENT: {
    message: "当前 Gmail 授权缺少发送所需权限。",
    repair: "重新授权 Gmail 并授予 Send 权限。",
  },
  GMAIL_WORKER_UNAVAILABLE: {
    message: "Temporal Gmail Worker 当前不可用。",
    repair: "启动或修复 Worker 后重新检查。",
  },
  CONTACT_VERSION_STALE: {
    message: "已确认联系人或联系人版本已经变化。",
    repair: "刷新机会联系人并重新生成、批准草稿。",
  },
  DRAFT_VERSION_STALE: {
    message: "当前草稿不再是服务端已批准版本。",
    repair: "刷新草稿并重新人工批准正确版本。",
  },
  SEND_POLICY_REJECTED: {
    message: "抑制、退订、频率、配额或 Kill Switch 门禁拒绝发送。",
    repair: "核对具体治理状态，处理后重新检查。",
  },
  SEND_READINESS_STALE: {
    message: "发送条件快照已过期或发生变化。",
    repair: "系统会重新执行预检；通过后请再次人工确认。",
  },
}

function problemCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null
}

function sendPreflightError(error: unknown): SendPreflightFailure {
  const code = problemCode(error) ?? "PREFLIGHT_UNAVAILABLE"
  const known = sendPreflightFailures[code]
  const details =
    error instanceof ApiError
      ? error.changedConditions.map(
          (condition) =>
            `${condition.code} · ${condition.reason} · ${condition.recoveryAction}`
        )
      : []
  if (known) {
    return {
      code,
      ...known,
      ...(details.length ? { details } : {}),
    }
  }
  return {
    code,
    message: "发送预检未完成，发送按钮保持关闭。",
    repair: "检查本地服务状态后重新检查；本次预检不会创建 Send Intent。",
    ...(details.length ? { details } : {}),
  }
}

function sendIntentErrorMessage(error: unknown): {
  message: string
  unknown: boolean
} {
  if (error instanceof ApiError) {
    const code = problemCode(error)
    const known = code ? sendPreflightFailures[code] : undefined
    const changedConditions = error.changedConditions.map(
      (condition) =>
        `${condition.code}（${condition.reason}）：${condition.recoveryAction}`
    )
    if (known) {
      return {
        message: `确定未发送：${known.message} ${known.repair}${
          changedConditions.length
            ? ` 具体变化：${changedConditions.join("；")}`
            : ""
        }`,
        unknown: false,
      }
    }
    if (error.status === 409) {
      return {
        message: "确定未发送：草稿、身份或服务端门禁已变化；请刷新后重新核对。",
        unknown: false,
      }
    }
    if (error.status === 429) {
      return {
        message: "确定未发送：服务端配额或频率门禁已拒绝，未创建 Send Intent。",
        unknown: false,
      }
    }
    if (error.status >= 400 && error.status < 500) {
      return {
        message:
          "确定未发送：服务端拒绝创建 Send Intent；请刷新并核对批准版本和 Gmail 身份。",
        unknown: false,
      }
    }
  }

  return {
    message:
      "最终提交结果未知。不要再次点击发送；请刷新页面并核对服务端发送记录。",
    unknown: true,
  }
}

function DraftEditorPage({
  projectId,
  draftId,
}: {
  projectId: string
  draftId: string
}) {
  const [snapshot, setSnapshot] = React.useState<DraftSnapshot | null>(null)
  const [subjectText, setSubjectText] = React.useState("")
  const [bodyDocument, setBodyDocument] =
    React.useState<DraftDocument>(emptyDraftDocument)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)
  const [approving, setApproving] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)
  const [removedInternalMetadata, setRemovedInternalMetadata] =
    React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [recipientStatus, setRecipientStatus] = React.useState<
    "idle" | "loading" | "ready" | "error"
  >("idle")
  const [recipientCandidates, setRecipientCandidates] = React.useState<
    OpportunityContact[]
  >([])
  const [recipientError, setRecipientError] = React.useState<string | null>(
    null
  )
  const [sendConfirmed, setSendConfirmed] = React.useState(false)
  const [creatingSendIntent, setCreatingSendIntent] = React.useState(false)
  const [sendRequestKey, setSendRequestKey] = React.useState<string | null>(
    null
  )
  const [sendIntent, setSendIntent] = React.useState<SendIntentResult | null>(
    null
  )
  const [sendIntentView, setSendIntentView] =
    React.useState<SendIntentView | null>(null)
  const [sendHistoryStatus, setSendHistoryStatus] = React.useState<
    "idle" | "ready" | "error"
  >("idle")
  const [resubmissionArmed, setResubmissionArmed] = React.useState(false)
  const [sendStatusError, setSendStatusError] = React.useState<string | null>(
    null
  )
  const [sendIntentUnknown, setSendIntentUnknown] = React.useState(false)
  const [sendPreflight, setSendPreflight] =
    React.useState<SendIntentPreflight | null>(null)
  const [sendPreflightStatus, setSendPreflightStatus] = React.useState<
    "idle" | "loading" | "ready" | "error"
  >("idle")
  const [sendPreflightFailure, setSendPreflightFailure] =
    React.useState<SendPreflightFailure | null>(null)
  const [sendPreflightRefresh, setSendPreflightRefresh] = React.useState(0)
  const pendingSendConfirmationKey = React.useRef<string | null>(null)
  const gmailConnection = useGmailConnection(projectId, Boolean(draftId))

  const loadRecipient = React.useCallback(
    async (opportunityId: string) => {
      setRecipientStatus("loading")
      setRecipientCandidates([])
      setRecipientError(null)
      try {
        const response = await listOpportunityContacts(projectId, opportunityId)
        setRecipientCandidates(response.items)
        setRecipientStatus("ready")
      } catch {
        setRecipientStatus("error")
        setRecipientError(
          "无法读取收件人候选；为避免本地推断，不能创建 Send Intent。"
        )
      }
    },
    [projectId]
  )

  const load = React.useCallback(async () => {
    const draftKey = createProjectQueryKey(projectId, "draft", draftId)
    backlinksProjectQueries.invalidate(draftKey)
    setLoading(true)
    setError(null)
    try {
      const response = await backlinksProjectQueries.fetch(draftKey, (signal) =>
        getDraft(projectId, draftId, signal)
      )
      const currentVersion = response.draft.currentVersion
      const normalizedDocument = currentVersion
        ? normalizeDraftDocument(currentVersion.bodyDocument)
        : emptyDraftDocument
      const sanitizedSubject = sanitizeDraftRecipientText(
        currentVersion?.subjectText ?? ""
      )
      const sanitizedDocument =
        sanitizeDraftRecipientDocument(normalizedDocument)
      const repairedHistoricalContent =
        sanitizedSubject.removedInternalMetadata ||
        sanitizedDocument.removedInternalMetadata
      setSnapshot(response.draft)
      setSubjectText(sanitizedSubject.value)
      setBodyDocument(sanitizedDocument.document)
      setRemovedInternalMetadata(repairedHistoricalContent)
      setDirty(repairedHistoricalContent)
      if (repairedHistoricalContent) {
        setNotice(
          "已从历史草稿中移除内部系统标记。请保存为新版本后再人工批准。"
        )
      }
      void loadRecipient(response.draft.opportunityId)
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [draftId, loadRecipient, projectId])

  React.useEffect(() => {
    let cancelled = false
    void Promise.resolve().then(() => {
      if (!cancelled) return load()
    })
    return () => {
      cancelled = true
    }
  }, [load])

  const save = async () => {
    if (!draftId || !snapshot?.currentVersion) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const subject = subjectText.trim()
      if (!subject) throw new Error("主题不能为空。")
      const document = normalizeDraftDocument(bodyDocument)
      await saveDraftVersion(projectId, draftId, {
        expectedVersion: snapshot.draftVersion,
        subjectText: subject,
        bodyDocument: document,
      })
      await load()
      setNotice("新草稿版本已保存。")
    } catch (saveError) {
      setError(errorMessage(saveError))
    } finally {
      setSaving(false)
    }
  }

  const approve = async () => {
    if (
      !draftId ||
      !snapshot?.currentVersion ||
      snapshot.currentVersion.source === "TEMPLATE_FALLBACK" ||
      snapshot.freshness.state !== "FRESH" ||
      dirty
    ) {
      return
    }
    setApproving(true)
    setError(null)
    setNotice(null)
    try {
      await approveDraft(projectId, draftId, snapshot.draftVersion)
      await load()
      setSendConfirmed(false)
      setSendRequestKey(null)
      setSendIntent(null)
      setSendIntentView(null)
      setSendHistoryStatus("idle")
      setResubmissionArmed(false)
      setSendStatusError(null)
      setSendIntentUnknown(false)
      setSendPreflight(null)
      setSendPreflightStatus("idle")
      setSendPreflightFailure(null)
      setNotice("当前草稿版本已人工批准。")
    } catch (approveError) {
      setError(errorMessage(approveError))
    } finally {
      setApproving(false)
    }
  }

  const currentVersion = snapshot?.currentVersion ?? null
  const basicDraftNeedsEdit = currentVersion?.source === "TEMPLATE_FALLBACK"
  const draftFresh = snapshot?.freshness.state === "FRESH"
  const requestedLanguage =
    snapshot?.inputSnapshot?.request.language.trim().toLowerCase() ?? ""
  const draftContainsCjk = /[\u3400-\u9fff]/u.test(
    `${subjectText}\n${JSON.stringify(bodyDocument)}`
  )
  const languageMismatch =
    requestedLanguage.startsWith("en") && draftContainsCjk
  const readOnly =
    snapshot?.status === "sent" ||
    (snapshot?.status === "approved" && !removedInternalMetadata)
  const busy = loading || saving || approving || creatingSendIntent
  const recipient =
    recipientStatus === "ready" && snapshot?.contactId
      ? (recipientCandidates.find(
          (candidate) =>
            candidate.id === snapshot.contactId &&
            candidate.version === snapshot.contactVersion
        ) ?? null)
      : null
  const approvedVersionMatchesCurrent =
    snapshot?.approvedVersionId !== null &&
    snapshot?.approvedVersionId === currentVersion?.id
  const gmailReady =
    gmailConnection.status === "ready" &&
    gmailConnection.readiness?.connection.ready === true
  const sendConfirmationKey =
    snapshot?.approvedVersionId && recipient && gmailConnection.connection
      ? JSON.stringify([
          snapshot.approvedVersionId,
          recipient.id,
          recipient.version,
          gmailConnection.connection.connectionId,
        ])
      : null
  const sendPreflightReady =
    sendPreflightStatus === "ready" &&
    sendPreflight?.allowed === true &&
    sendPreflight.deliveryState === "NOT_SENT"
  const sendRecordPresent = sendIntent !== null || sendIntentView !== null
  const sendPreconditionsReady =
    snapshot?.status === "approved" &&
    approvedVersionMatchesCurrent &&
    !basicDraftNeedsEdit &&
    draftFresh &&
    gmailReady &&
    recipient !== null &&
    sendPreflightReady
  const canCreateSendIntent =
    sendPreconditionsReady &&
    sendConfirmed &&
    !busy &&
    sendHistoryStatus === "ready" &&
    !sendRecordPresent &&
    !sendIntentUnknown
  const snapshotDraftVersion = snapshot?.draftVersion ?? null

  React.useEffect(() => {
    if (snapshotDraftVersion === null || resubmissionArmed || sendIntent) return

    const controller = new AbortController()
    void listDraftSendIntents(projectId, draftId, controller.signal).then(
      (response) => {
        if (controller.signal.aborted) return
        setSendIntentView(response.items[0] ?? null)
        setSendHistoryStatus("ready")
        setSendStatusError(null)
      },
      (historyError) => {
        if (controller.signal.aborted) return
        setSendHistoryStatus("error")
        setSendStatusError(errorMessage(historyError))
      }
    )

    return () => controller.abort()
  }, [draftId, projectId, resubmissionArmed, sendIntent, snapshotDraftVersion])

  React.useEffect(() => {
    const controller = new AbortController()
    const startTimer = window.setTimeout(() => {
      if (
        sendHistoryStatus !== "ready" ||
        sendRecordPresent ||
        snapshot?.status !== "approved" ||
        !snapshot.approvedVersionId ||
        !approvedVersionMatchesCurrent ||
        basicDraftNeedsEdit ||
        !draftFresh ||
        !recipient
      ) {
        pendingSendConfirmationKey.current = null
        setSendPreflight(null)
        setSendPreflightStatus("idle")
        setSendPreflightFailure(null)
        setSendConfirmed(false)
        return
      }

      if (!gmailConnection.connection) {
        pendingSendConfirmationKey.current = null
        setSendPreflight(null)
        setSendPreflightStatus("error")
        setSendPreflightFailure({
          code: "GMAIL_CONNECTION_NOT_SELECTED",
          ...sendPreflightFailures.GMAIL_CONNECTION_NOT_SELECTED,
        })
        setSendConfirmed(false)
        return
      }

      setSendPreflight(null)
      setSendPreflightStatus("loading")
      setSendPreflightFailure(null)
      setSendConfirmed(false)

      void preflightSendIntent(
        projectId,
        draftId,
        {
          approvedDraftVersionId: snapshot.approvedVersionId,
          contactId: recipient.id,
          contactVersion: recipient.version,
          gmailConnectionId: gmailConnection.connection.connectionId,
          messagePurpose: "INITIAL_OUTREACH",
          followUpIndex: 0,
        },
        controller.signal
      ).then(
        (response) => {
          if (controller.signal.aborted) return
          const shouldConfirm =
            sendConfirmationKey !== null &&
            pendingSendConfirmationKey.current === sendConfirmationKey
          pendingSendConfirmationKey.current = null
          setSendPreflight(response)
          setSendPreflightStatus("ready")
          setSendConfirmed(shouldConfirm)
          if (shouldConfirm) {
            setNotice(
              "发送身份、收件人和批准版本已重新核验。请点击“确认并发送”。"
            )
          }
        },
        (preflightError) => {
          if (controller.signal.aborted) return
          pendingSendConfirmationKey.current = null
          setSendPreflight(null)
          setSendPreflightStatus("error")
          setSendPreflightFailure(sendPreflightError(preflightError))
        }
      )
    }, 0)

    return () => {
      window.clearTimeout(startTimer)
      controller.abort()
    }
  }, [
    approvedVersionMatchesCurrent,
    draftId,
    basicDraftNeedsEdit,
    draftFresh,
    gmailConnection.connection,
    projectId,
    recipient,
    sendConfirmationKey,
    sendHistoryStatus,
    sendRecordPresent,
    sendPreflightRefresh,
    snapshot?.approvedVersionId,
    snapshot?.status,
  ])

  const updateSendConfirmation = (checked: boolean) => {
    if (!checked) {
      pendingSendConfirmationKey.current = null
      setSendConfirmed(false)
      return
    }
    if (!sendConfirmationKey || !sendPreflightReady || busy) return

    pendingSendConfirmationKey.current = sendConfirmationKey
    setSendConfirmed(false)
    setError(null)
    setNotice("正在重新核验发送身份、收件人和批准版本。")
    setSendPreflightRefresh((value) => value + 1)
  }

  const createApprovedSendIntent = async () => {
    if (
      !draftId ||
      !snapshot?.approvedVersionId ||
      !gmailConnection.connection ||
      !recipient ||
      !sendPreflight ||
      !canCreateSendIntent
    ) {
      return
    }

    if (
      !isSendReadinessSnapshotUsable(sendPreflight.readinessSnapshot.expiresAt)
    ) {
      pendingSendConfirmationKey.current = null
      setSendConfirmed(false)
      setSendRequestKey(null)
      setError(null)
      setNotice(
        "发送预检刚刚过期，邮件确定未发送。系统正在重新检查；完成后请再次勾选确认。"
      )
      setSendPreflightRefresh((value) => value + 1)
      return
    }

    const idempotencyKey = sendRequestKey ?? crypto.randomUUID()
    setSendRequestKey(idempotencyKey)
    setCreatingSendIntent(true)
    setError(null)
    setNotice(null)
    setSendIntentUnknown(false)
    try {
      const response = await createSendIntent(
        projectId,
        draftId,
        {
          approvedDraftVersionId: snapshot.approvedVersionId,
          contactId: recipient.id,
          contactVersion: recipient.version,
          gmailConnectionId: gmailConnection.connection.connectionId,
          messagePurpose: "INITIAL_OUTREACH",
          followUpIndex: 0,
          readinessSnapshot: sendPreflight.readinessSnapshot,
          humanConfirmation: {
            confirmed: true,
            confirmedAt: new Date().toISOString(),
            readinessSnapshotVersion:
              sendPreflight.readinessSnapshot.snapshotVersion,
          },
        },
        idempotencyKey
      )
      setSendIntent(response)
      setResubmissionArmed(false)
      setNotice(
        "已创建 Send Intent，当前为 QUEUED；正在读取服务端状态，尚未确认 Gmail 接受。"
      )
    } catch (sendError) {
      const result = sendIntentErrorMessage(sendError)
      const readinessExpired =
        sendError instanceof ApiError &&
        sendError.code === "SEND_READINESS_STALE" &&
        sendError.changedConditions.some(
          (condition) =>
            condition.code === "SNAPSHOT_VALIDITY" &&
            condition.reason === "EXPIRED"
        )
      setSendIntentUnknown(result.unknown)
      if (!result.unknown) {
        setSendRequestKey(null)
        setSendPreflight(null)
        setSendPreflightStatus("error")
        setSendPreflightFailure(sendPreflightError(sendError))
        setSendConfirmed(false)
      }
      if (readinessExpired) {
        setError(null)
        setNotice(
          "发送预检已过期，邮件确定未发送。系统正在重新检查；完成后请再次勾选确认。"
        )
        setSendPreflightRefresh((value) => value + 1)
      } else {
        setError(result.message)
      }
    } finally {
      setCreatingSendIntent(false)
    }
  }

  const prepareSendResubmission = () => {
    pendingSendConfirmationKey.current = null
    setResubmissionArmed(true)
    setSendIntent(null)
    setSendIntentView(null)
    setSendHistoryStatus("ready")
    setSendRequestKey(null)
    setSendIntentUnknown(false)
    setSendConfirmed(false)
    setSendPreflight(null)
    setSendPreflightStatus("idle")
    setSendPreflightFailure(null)
    setSendStatusError(null)
    setError(null)
    setNotice(
      "上一封邮件已确认未发送。正在重新检查发送条件；通过后请再次勾选确认并提交。"
    )
    setSendPreflightRefresh((value) => value + 1)
  }

  React.useEffect(() => {
    const activeSendIntentId =
      sendIntent?.sendIntentId ?? sendIntentView?.sendIntentId ?? null
    if (!activeSendIntentId) return

    const controller = new AbortController()
    let timer: number | null = null

    const poll = async () => {
      try {
        const response = await getSendIntent(
          projectId,
          activeSendIntentId,
          controller.signal
        )
        if (controller.signal.aborted) return
        setSendIntentView(response.sendIntent)
        setSendStatusError(null)
        if (!terminalSendIntentStatuses.has(response.sendIntent.status)) {
          timer = window.setTimeout(() => void poll(), 1200)
        }
      } catch (statusError) {
        if (controller.signal.aborted) return
        setSendStatusError(errorMessage(statusError))
        timer = window.setTimeout(() => void poll(), 3000)
      }
    }

    void poll()
    return () => {
      controller.abort()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [projectId, sendIntent?.sendIntentId, sendIntentView?.sendIntentId])

  const persistedSendStatus =
    sendIntentView?.status ?? sendIntent?.status ?? null
  const persistedSendErrorCode = sendIntentView?.attempt?.errorCode ?? null
  const persistedSendRetryScheduled =
    persistedSendStatus === "FAILED_RETRYABLE"
  const persistedSendPresentation =
    persistedSendStatus === null
      ? null
      : sendStatusPresentation(
          persistedSendStatus,
          persistedSendErrorCode,
          persistedSendRetryScheduled
        )
  const effectiveDraftStatus: DraftStatus | null =
    persistedSendStatus === "PROVIDER_ACCEPTED"
      ? "sent"
      : (snapshot?.status ?? null)
  const PersistedSendStatusIcon = persistedSendPresentation?.icon ?? Clock3
  const canPrepareSendResubmission =
    sendIntentView?.diagnostics.resubmittable === true

  return (
    <div className="min-w-0">
      <div className="sticky top-0 z-20 border-b bg-background px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <Link
              to={`/projects/${projectId}/backlinks/email`}
              className="mb-3 inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <ArrowLeft className="size-4" />
              返回邮件中心
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">
                {effectiveDraftStatus === "sent"
                  ? "邮件已发送"
                  : "编辑邮件草稿"}
              </h1>
              {effectiveDraftStatus && (
                <Badge
                  variant={
                    effectiveDraftStatus === "approved" ||
                    effectiveDraftStatus === "sent"
                      ? "default"
                      : "outline"
                  }
                >
                  {statusLabels[effectiveDraftStatus]}
                </Badge>
              )}
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {recipient?.normalizedEmail ??
                (recipientStatus === "loading"
                  ? "正在读取收件人"
                  : "收件人尚未就绪")}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {snapshot?.status === "draft" && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                nativeButton={false}
                render={
                  <Link
                    to={`/projects/${projectId}/backlinks/drafts/new?opportunityId=${snapshot.opportunityId}&regenerate=1`}
                  />
                }
              >
                <WandSparkles />
                重新生成
              </Button>
            )}
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="刷新草稿"
              title="刷新草稿"
              disabled={busy}
              onClick={() => void load()}
            >
              <RefreshCw className={loading ? "animate-spin" : undefined} />
            </Button>
            {!readOnly && currentVersion && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!dirty || busy}
                  onClick={() => void save()}
                >
                  {saving ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Save />
                  )}
                  保存新版本
                </Button>
                <Button
                  size="sm"
                  disabled={
                    dirty ||
                    busy ||
                    basicDraftNeedsEdit ||
                    !draftFresh ||
                    snapshot?.status !== "draft"
                  }
                  onClick={() => void approve()}
                >
                  {approving ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <ShieldCheck />
                  )}
                  人工批准
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
        {error && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="mb-4 flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
          >
            <Check className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>{notice}</span>
          </div>
        )}

        {loading && !snapshot ? (
          <div className="flex min-h-80 items-center justify-center text-sm text-muted-foreground">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            正在读取草稿
          </div>
        ) : snapshot && currentVersion ? (
          <div className="grid gap-5">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
              <div>
                <h2 className="text-base font-semibold">邮件内容</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  编辑收件人将看到的主题和正文。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={basicDraftNeedsEdit ? "outline" : "secondary"}>
                  {draftSourceLabels[currentVersion.source]}
                </Badge>
                <Badge variant="outline">
                  {draftReadinessLabels[currentVersion.readiness]}
                </Badge>
                <Badge
                  variant={
                    snapshot.freshness.state === "FRESH"
                      ? "secondary"
                      : "destructive"
                  }
                >
                  {snapshot.freshness.state === "FRESH"
                    ? "内容为当前版本"
                    : "内容已过期"}
                </Badge>
              </div>
            </div>

            {snapshot.freshness.state !== "FRESH" && (
              <div
                role="alert"
                className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  当前草稿不能批准或发送。
                  {snapshot.freshness.staleReasons.length > 0
                    ? ` ${snapshot.freshness.staleReasons
                        .map((reason) => draftStaleReasonLabels[reason])
                        .join("；")}。`
                    : " 无法证明输入快照仍为当前版本。"}
                  重新生成会创建新快照，已有人工版本不会被覆盖。
                </span>
              </div>
            )}

            {(basicDraftNeedsEdit || languageMismatch) && (
              <div
                role={languageMismatch ? "alert" : "status"}
                className="overflow-hidden rounded-md border border-amber-200 bg-amber-50 text-sm text-amber-950"
              >
                {basicDraftNeedsEdit && (
                  <div className="flex items-start gap-3 px-4 py-3">
                    <Info className="mt-0.5 size-4 shrink-0 text-amber-700" />
                    <div>
                      <div className="font-medium">AI 未参与当前版本</div>
                      <p className="mt-1 text-amber-900/80">
                        {fallbackReasonLabel(currentVersion.fallbackReason)}
                        ，系统改用基础模板。
                        请完成编辑并保存，新版本会标记为人工编辑后再进入审批。
                      </p>
                    </div>
                  </div>
                )}
                {languageMismatch && (
                  <div
                    className={`flex items-start gap-3 px-4 py-3 ${
                      basicDraftNeedsEdit ? "border-t border-amber-200" : ""
                    }`}
                  >
                    <Languages className="mt-0.5 size-4 shrink-0 text-amber-700" />
                    <div>
                      <div className="font-medium">草稿语言需要校对</div>
                      <p className="mt-1 text-amber-900/80">
                        请求语言为英文，但主题或正文中检测到中文。
                        基础模板会直接引用项目主题，请改成英文后保存，或在 AI
                        服务恢复后重新生成。
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {removedInternalMetadata && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-700" />
                <div>
                  <div className="font-medium">已清理历史内部标记</div>
                  <p className="mt-1 text-amber-900/80">
                    编辑器仅保留收件人应看到的内容。保存新版本后，才能进行人工批准。
                  </p>
                </div>
              </div>
            )}

            <section
              aria-labelledby="draft-composer-title"
              className="overflow-hidden rounded-md border bg-background shadow-sm"
            >
              <h2 id="draft-composer-title" className="sr-only">
                邮件编辑器
              </h2>
              <div className="grid gap-2 border-b px-4 py-3 sm:grid-cols-[96px_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Mail className="size-4" />
                  收件人
                </div>
                <div className="min-w-0 text-sm font-medium">
                  {recipient ? (
                    <span className="break-all">
                      {recipient.normalizedEmail}
                    </span>
                  ) : recipientStatus === "loading" ? (
                    <span className="text-muted-foreground">
                      正在读取联系人
                    </span>
                  ) : (
                    <span className="text-destructive">
                      {recipientError ?? "尚未绑定可用联系人"}
                    </span>
                  )}
                </div>
                {recipient && (
                  <Badge variant="outline">{recipient.contactRole}</Badge>
                )}
              </div>

              <div className="grid border-b sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center">
                {readOnly ? (
                  <>
                    <div className="px-4 pt-3 text-sm font-medium text-muted-foreground sm:py-0">
                      邮件主题
                    </div>
                    <div className="min-h-12 px-4 py-3 text-base font-medium break-words">
                      {subjectText}
                    </div>
                  </>
                ) : (
                  <>
                    <label
                      htmlFor="draft-subject"
                      className="px-4 pt-3 text-sm font-medium text-muted-foreground sm:py-0"
                    >
                      邮件主题
                    </label>
                    <Input
                      id="draft-subject"
                      value={subjectText}
                      maxLength={500}
                      className="h-12 rounded-none border-0 bg-transparent px-4 text-base font-medium shadow-none focus-visible:ring-0"
                      onChange={(event) => {
                        setSubjectText(event.target.value)
                        setDirty(true)
                        setNotice(null)
                      }}
                    />
                  </>
                )}
              </div>

              <DraftEditor
                key={currentVersion.id}
                initialDocument={bodyDocument}
                readOnly={readOnly}
                onChange={(document) => {
                  setBodyDocument(document)
                  setDirty(true)
                  setNotice(null)
                }}
              />

              <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/10 px-4 py-2.5 text-xs text-muted-foreground">
                <span>
                  {readOnly
                    ? "当前版本为只读"
                    : dirty
                      ? "有未保存更改"
                      : "所有更改已保存"}
                </span>
                <span>
                  {requestedLanguage
                    ? `目标语言：${requestedLanguage.toUpperCase()}`
                    : "目标语言未指定"}
                </span>
              </div>
            </section>

            {(snapshot.status === "approved" ||
              effectiveDraftStatus === "sent") && (
              <section
                aria-labelledby="send-confirmation-title"
                className="grid gap-5 border-t pt-6"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Send className="size-4" />
                    </div>
                    <div>
                      <h2
                        id="send-confirmation-title"
                        className="text-base font-semibold"
                      >
                        {effectiveDraftStatus === "sent"
                          ? "发送记录"
                          : "发送邮件"}
                      </h2>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {effectiveDraftStatus === "sent"
                          ? "本次邮件已发送，系统将继续同步后续回复。"
                          : canPrepareSendResubmission
                            ? "上次发送未完成，重新检查后可再次人工确认。"
                            : "核对发件账号、收件人和已批准版本后发送。"}
                      </p>
                    </div>
                  </div>
                  {canPrepareSendResubmission && (
                    <Button onClick={prepareSendResubmission} size="sm">
                      <RefreshCw />
                      重新准备发送
                    </Button>
                  )}
                </div>

                <dl className="grid gap-x-6 gap-y-4 border-y py-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">发件账号</dt>
                    <dd className="mt-1 font-medium break-all">
                      {sendPreflight?.gmail.primaryEmail ??
                        gmailConnection.connection?.primaryEmail ??
                        "未选择账号"}
                    </dd>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {gmailReady ? "Gmail 已连接" : "Gmail 尚未就绪"}
                    </span>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">收件人</dt>
                    <dd className="mt-1 font-medium break-all">
                      {recipient?.normalizedEmail ??
                        (recipientStatus === "loading"
                          ? "正在读取收件人"
                          : "未获得唯一联系人")}
                    </dd>
                  </div>
                </dl>

                {!sendRecordPresent && (
                  <div className="flex items-start gap-3 text-sm">
                    {sendHistoryStatus === "idle" ||
                    sendPreflightStatus === "loading" ? (
                      <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-primary" />
                    ) : sendPreflightStatus === "ready" ? (
                      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-700" />
                    ) : (
                      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-700" />
                    )}
                    <div>
                      <div className="font-medium">
                        {sendHistoryStatus === "idle"
                          ? "正在读取最近发送记录"
                          : sendHistoryStatus === "error"
                            ? "无法确认最近发送状态"
                            : sendPreflightStatus === "loading"
                              ? "正在检查发送条件"
                              : sendPreflightStatus === "ready"
                                ? "发送条件已通过"
                                : "发送条件尚未通过"}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        提交时服务端会再次核对联系人、Gmail
                        身份、抑制规则和配额。
                      </p>
                      {sendHistoryStatus === "error" && sendStatusError && (
                        <p className="mt-1 text-xs text-destructive">
                          {sendStatusError} 为避免重复发送，按钮保持关闭。
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {recipientStatus === "error" && recipientError && (
                  <p className="text-xs text-destructive">{recipientError}</p>
                )}
                {recipientStatus === "ready" && recipient === null && (
                  <p className="text-xs text-destructive">
                    {recipientCandidates.length === 0
                      ? "当前机会没有可发送的已确认联系人。"
                      : "草稿绑定的联系人版本已变化，请返回机会详情重新选择并生成草稿。"}
                  </p>
                )}
                {!approvedVersionMatchesCurrent && (
                  <p className="text-xs text-destructive">
                    当前展示版本与已批准版本不一致，不能发送。
                  </p>
                )}
                {!gmailReady && gmailConnection.status !== "loading" && (
                  <p className="text-xs text-destructive">
                    Gmail 连接未处于可发送状态，不能发送。
                  </p>
                )}
                {sendPreflightFailure && (
                  <div
                    className="flex flex-col gap-3 border border-destructive/30 bg-destructive/5 px-3 py-3 text-xs sm:flex-row sm:items-center sm:justify-between"
                    role="alert"
                  >
                    <div>
                      <div className="font-medium text-destructive">
                        确定未发送 · {sendPreflightFailure.code}
                      </div>
                      <p className="mt-1 text-muted-foreground">
                        {sendPreflightFailure.message}{" "}
                        {sendPreflightFailure.repair}
                      </p>
                      {sendPreflightFailure.details &&
                        sendPreflightFailure.details.length > 0 && (
                          <ul className="mt-2 grid gap-1 text-muted-foreground">
                            {sendPreflightFailure.details.map((detail) => (
                              <li key={detail}>{detail}</li>
                            ))}
                          </ul>
                        )}
                    </div>
                    {sendPreflightFailure.code ===
                    "GMAIL_CONNECTION_NOT_SELECTED" ? (
                      <Button
                        nativeButton={false}
                        render={
                          <Link to={`/projects/${projectId}/backlinks/email`} />
                        }
                        size="sm"
                        variant="outline"
                      >
                        选择 Gmail
                      </Button>
                    ) : sendPreflightFailure.code === "GMAIL_REAUTH_REQUIRED" ||
                      sendPreflightFailure.code ===
                        "GMAIL_SCOPE_INSUFFICIENT" ? (
                      <Button
                        disabled={gmailConnection.busyAction === "connect"}
                        onClick={() => void gmailConnection.connect()}
                        size="sm"
                        variant="outline"
                      >
                        重新授权 Gmail
                      </Button>
                    ) : sendPreflightFailure.code === "CONTACT_VERSION_STALE" ||
                      sendPreflightFailure.code === "DRAFT_VERSION_STALE" ? (
                      <Button
                        disabled={busy}
                        onClick={() => void load()}
                        size="sm"
                        variant="outline"
                      >
                        刷新草稿
                      </Button>
                    ) : (
                      <Button
                        onClick={() =>
                          setSendPreflightRefresh((value) => value + 1)
                        }
                        size="sm"
                        variant="outline"
                      >
                        重新检查
                      </Button>
                    )}
                  </div>
                )}

                {!sendRecordPresent ? (
                  <>
                    <label className="flex items-start gap-2 text-sm">
                      <Checkbox
                        checked={sendConfirmed}
                        disabled={!sendPreconditionsReady || sendIntentUnknown}
                        onCheckedChange={updateSendConfirmation}
                      />
                      <span>
                        我已核对发件账号、收件人和已批准版本，并确认立即发送。
                      </span>
                    </label>

                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        disabled={!canCreateSendIntent}
                        onClick={() => void createApprovedSendIntent()}
                      >
                        {creatingSendIntent ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <Send />
                        )}
                        确认并发送
                      </Button>
                      {sendIntentUnknown && (
                        <span className="text-xs text-destructive">
                          服务端结果尚未确认，当前不会重复提交。
                        </span>
                      )}
                    </div>
                  </>
                ) : persistedSendPresentation ? (
                  <div
                    role="status"
                    className="flex items-start gap-3 border-t pt-4 text-sm"
                  >
                    <PersistedSendStatusIcon
                      className={`mt-0.5 size-4 shrink-0 ${persistedSendPresentation.iconClassName}`}
                    />
                    <div className="min-w-0">
                      <div className="font-medium">
                        {persistedSendPresentation.title}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {persistedSendPresentation.description}
                      </p>
                      {sendStatusError && (
                        <p className="mt-1 text-xs text-destructive">
                          状态更新暂时中断，页面会自动重试。
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}
              </section>
            )}
          </div>
        ) : snapshot ? (
          <div className="flex min-h-80 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            草稿尚未生成可编辑版本。
          </div>
        ) : null}
      </main>
    </div>
  )
}

export function DraftPage() {
  const { getProject } = useProjects()
  const { projectId = "", draftId } = useParams<{
    projectId: string
    draftId: string
  }>()
  const project = getProject(projectId)
  if (!projectId || project.id !== projectId) {
    return (
      <OutreachStandardStateView
        state="forbidden"
        title="当前项目不可用"
        description="草稿页面只会读取 URL 中指定的已有项目。"
      />
    )
  }
  if (!draftId) {
    return <div className="p-6 text-sm text-destructive">草稿 ID 缺失。</div>
  }
  if (draftId === "new") {
    return <DraftGeneration project={toOutreachProject(project)} />
  }
  return <DraftEditorPage projectId={projectId} draftId={draftId} />
}
