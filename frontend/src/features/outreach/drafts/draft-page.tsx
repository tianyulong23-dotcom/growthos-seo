import * as React from "react"
import {
  ArrowLeft,
  Check,
  LoaderCircle,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  TriangleAlert,
  WandSparkles,
} from "lucide-react"
import { Link, useParams } from "react-router"

import { ApiError } from "@/api/client"
import { useCurrentProject } from "@/app/project-context"
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
  listOpportunityContacts,
  preflightSendIntent,
  saveDraftVersion,
} from "@/features/outreach/drafts/api"
import {
  emptyDraftDocument,
  normalizeDraftDocument,
} from "@/features/outreach/drafts/draft-document"
import { DraftEditor } from "@/features/outreach/drafts/draft-editor"
import { DraftGeneration } from "@/features/outreach/drafts/draft-generation"
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

const sendIntentStatusLabels: Record<SendIntentView["status"], string> = {
  READY: "QUEUED · 已排队",
  DISPATCHING: "正在发送",
  PROVIDER_ACCEPTED: "SUBMITTED/SENT · Gmail Provider 已接受",
  DELIVERY_UNKNOWN: "UNKNOWN · 发送结果未知",
  FAILED_RETRYABLE: "发送失败，等待受控恢复",
  FAILED_FINAL: "发送失败",
  CANCELLED: "已取消",
  REJECTED: "已拒绝",
}

const terminalSendIntentStatuses = new Set<SendIntentView["status"]>([
  "PROVIDER_ACCEPTED",
  "DELIVERY_UNKNOWN",
  "FAILED_FINAL",
  "CANCELLED",
  "REJECTED",
])

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "草稿版本已变化，请刷新后再继续。"
  }
  if (error instanceof ApiError && error.status === 404) {
    return "未找到该草稿，或草稿不属于当前项目。"
  }
  return error instanceof Error ? error.message : "请求失败，请稍后重试。"
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN")
}

type SendPreflightFailure = {
  code: string
  message: string
  repair: string
}

const sendPreflightFailures: Record<string, Omit<SendPreflightFailure, "code">> =
  {
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
  }

function problemCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || typeof error.detail !== "object") {
    return null
  }
  if (
    error.detail !== null &&
    "code" in error.detail &&
    typeof error.detail.code === "string"
  ) {
    return error.detail.code
  }
  return null
}

function sendPreflightError(error: unknown): SendPreflightFailure {
  const code = problemCode(error) ?? "PREFLIGHT_UNAVAILABLE"
  const known = sendPreflightFailures[code]
  if (known) return { code, ...known }
  return {
    code,
    message: "发送预检未完成，发送按钮保持关闭。",
    repair: "检查本地服务状态后重新检查；本次预检不会创建 Send Intent。",
  }
}

function sendIntentErrorMessage(error: unknown): {
  message: string
  unknown: boolean
} {
  if (error instanceof ApiError) {
    const code = problemCode(error)
    const known = code ? sendPreflightFailures[code] : undefined
    if (known) {
      return {
        message: `确定未发送：${known.message} ${known.repair}`,
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
  const gmailConnection = useGmailConnection(projectId, Boolean(draftId))

  const loadRecipient = React.useCallback(
    async (opportunityId: string) => {
      setRecipientStatus("loading")
      setRecipientCandidates([])
      setRecipientError(null)
      try {
        const response = await listOpportunityContacts(
          projectId,
          opportunityId
        )
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
      setSnapshot(response.draft)
      setSubjectText(currentVersion?.subjectText ?? "")
      setBodyDocument(
        currentVersion
          ? normalizeDraftDocument(currentVersion.bodyDocument)
          : emptyDraftDocument
      )
      setDirty(false)
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
  const fallbackDiagnostic =
    currentVersion?.source === "TEMPLATE_FALLBACK"
  const readOnly =
    snapshot?.status === "approved" || snapshot?.status === "sent"
  const busy = loading || saving || approving || creatingSendIntent
  const recipient =
    recipientStatus === "ready" && snapshot?.contactId
      ? recipientCandidates.find(
          (candidate) =>
            candidate.id === snapshot.contactId &&
            candidate.version === snapshot.contactVersion
        ) ?? null
      : null
  const approvedVersionMatchesCurrent =
    snapshot?.approvedVersionId !== null &&
    snapshot?.approvedVersionId === currentVersion?.id
  const gmailReady =
    gmailConnection.status === "ready" &&
    gmailConnection.connection?.connectionStatus === "CONNECTED" &&
    gmailConnection.connection.sendAvailability === "AVAILABLE"
  const sendPreflightReady =
    sendPreflightStatus === "ready" &&
    sendPreflight?.allowed === true &&
    sendPreflight.deliveryState === "NOT_SENT"
  const sendPreconditionsReady =
    snapshot?.status === "approved" &&
    approvedVersionMatchesCurrent &&
    !fallbackDiagnostic &&
    gmailReady &&
    recipient !== null &&
    sendPreflightReady
  const canCreateSendIntent =
    sendPreconditionsReady &&
    sendConfirmed &&
    !busy &&
    sendIntent === null &&
    !sendIntentUnknown

  React.useEffect(() => {
    const controller = new AbortController()
    const startTimer = window.setTimeout(() => {
      if (
        snapshot?.status !== "approved" ||
        !snapshot.approvedVersionId ||
        !approvedVersionMatchesCurrent ||
        fallbackDiagnostic ||
        !recipient
      ) {
        setSendPreflight(null)
        setSendPreflightStatus("idle")
        setSendPreflightFailure(null)
        setSendConfirmed(false)
        return
      }

      if (!gmailConnection.connection) {
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
          setSendPreflight(response)
          setSendPreflightStatus("ready")
        },
        (preflightError) => {
          if (controller.signal.aborted) return
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
    fallbackDiagnostic,
    gmailConnection.connection,
    projectId,
    recipient,
    sendPreflightRefresh,
    snapshot?.approvedVersionId,
    snapshot?.status,
  ])

  const createApprovedSendIntent = async () => {
    if (
      !draftId ||
      !snapshot?.approvedVersionId ||
      !gmailConnection.connection ||
      !recipient ||
      !canCreateSendIntent
    ) {
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
        },
        idempotencyKey
      )
      setSendIntent(response)
      setNotice(
        "已创建 Send Intent，当前为 QUEUED；正在读取服务端状态，尚未确认 Gmail 接受。"
      )
    } catch (sendError) {
      const result = sendIntentErrorMessage(sendError)
      setSendIntentUnknown(result.unknown)
      if (!result.unknown) {
        setSendPreflight(null)
        setSendPreflightStatus("error")
        setSendPreflightFailure(sendPreflightError(sendError))
        setSendConfirmed(false)
      }
      setError(result.message)
    } finally {
      setCreatingSendIntent(false)
    }
  }

  React.useEffect(() => {
    if (!sendIntent) return

    const controller = new AbortController()
    let timer: number | null = null

    const poll = async () => {
      try {
        const response = await getSendIntent(
          projectId,
          sendIntent.sendIntentId,
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
  }, [projectId, sendIntent])

  const persistedSendStatus = sendIntentView?.status ?? sendIntent?.status ?? null

  return (
    <div className="min-w-0">
      <div className="border-b px-4 py-4 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link
              to={`/projects/${projectId}/backlinks/email`}
              className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              邮件草稿
            </Link>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">草稿编辑</h1>
              {snapshot && (
                <Badge
                  variant={
                    snapshot.status === "approved" ? "default" : "outline"
                  }
                >
                  {statusLabels[snapshot.status]}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
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
              size="sm"
              disabled={busy}
              onClick={() => void load()}
            >
              <RefreshCw className={loading ? "animate-spin" : undefined} />
              刷新
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
                    fallbackDiagnostic ||
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

      <main className="mx-auto max-w-5xl p-4 sm:p-6 lg:p-8">
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
            <section className="grid gap-3 rounded-lg border bg-muted/20 p-4 sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">后端版本</div>
                <div className="mt-1 text-sm font-medium">
                  v{snapshot.draftVersion}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">版本来源</div>
                <div className="mt-1 text-sm font-medium">
                  {currentVersion.source}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">创建时间</div>
                <div className="mt-1 text-sm font-medium">
                  {formatTimestamp(currentVersion.createdAt)}
                </div>
              </div>
            </section>

            {fallbackDiagnostic && (
              <div
                role="alert"
                className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  模板诊断稿不计为 AI 生成成功，不能批准或解锁发送。请重新生成真实 AI 草稿。
                </span>
              </div>
            )}

            {snapshot.status === "approved" && (
              <section
                aria-labelledby="send-confirmation-title"
                className="grid gap-4 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2
                      id="send-confirmation-title"
                      className="text-sm font-semibold"
                    >
                      发送前最终确认
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      确认后会创建不可变发送快照并交给 Worker。服务端仍会重新校验联系人、批准版本、发送身份、抑制和配额。
                    </p>
                  </div>
                  <Badge variant="outline">人工最终确认</Badge>
                </div>

                <dl className="grid gap-3 border-y py-3 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-muted-foreground">Gmail</dt>
                    <dd className="mt-1 font-medium break-all">
                      {sendPreflight?.gmail.primaryEmail ??
                        gmailConnection.connection?.primaryEmail ??
                        "未选择账号"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">连接</dt>
                    <dd className="mt-1 font-medium">
                      {sendPreflight?.gmail.connectionStatus ??
                        gmailConnection.connection?.connectionStatus ??
                        "NOT_SELECTED"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">发送</dt>
                    <dd className="mt-1 font-medium">
                      {sendPreflightStatus === "ready"
                        ? "可提交 · NOT_SENT"
                        : sendPreflightStatus === "loading"
                          ? "预检中 · NOT_SENT"
                          : sendPreflightStatus === "error"
                            ? "确定未发送 · NOT_SENT"
                            : "等待前置条件 · NOT_SENT"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">同步</dt>
                    <dd className="mt-1 font-medium">
                      {(sendPreflight?.gmail.mailSyncCapability ??
                      gmailConnection.connection?.mailSyncCapability)
                        ? "可用"
                        : "暂停"}
                    </dd>
                  </div>
                </dl>

                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">收件人</dt>
                    <dd className="mt-1 font-medium break-all">
                      {recipient?.normalizedEmail ??
                        (recipientStatus === "loading"
                          ? "正在读取候选"
                          : "未获得唯一候选")}
                      {recipient && (
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                          仅展示联系人候选，执行时仍由服务端重新校验。
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      已批准版本
                    </dt>
                    <dd className="mt-1 font-medium">
                      {approvedVersionMatchesCurrent
                        ? `v${currentVersion.versionNo}`
                        : "当前版本未获批准"}
                    </dd>
                  </div>
                </dl>

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
                    </div>
                    {sendPreflightFailure.code ===
                    "GMAIL_CONNECTION_NOT_SELECTED" ? (
                      <Button
                        nativeButton={false}
                        render={
                          <Link
                            to={`/projects/${projectId}/backlinks/email`}
                          />
                        }
                        size="sm"
                        variant="outline"
                      >
                        选择 Gmail
                      </Button>
                    ) : sendPreflightFailure.code ===
                        "GMAIL_REAUTH_REQUIRED" ||
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
                    ) : sendPreflightFailure.code ===
                        "CONTACT_VERSION_STALE" ||
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

                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={sendConfirmed}
                    disabled={
                      !sendPreconditionsReady ||
                      sendIntent !== null ||
                      sendIntentUnknown
                    }
                    onCheckedChange={setSendConfirmed}
                  />
                  <span>
                    我已核对 Gmail 发送身份、收件人和已批准版本，并确认立即提交发送。
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
                    {sendIntentUnknown
                      ? "等待服务端核对"
                      : "最终确认并发送"}
                  </Button>
                  {sendIntentUnknown && (
                    <span className="text-xs text-destructive">
                      结果未知，禁止再次提交发送。请刷新页面并核对服务端记录。
                    </span>
                  )}
                </div>

                {sendIntent && (
                  <div
                    role="status"
                    className="flex items-start gap-2 border-t pt-3 text-sm"
                  >
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <div className="font-medium">
                        {persistedSendStatus
                          ? sendIntentStatusLabels[persistedSendStatus]
                          : "正在读取发送状态"}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        提交时间 {formatTimestamp(sendIntent.requestedSendAt)}
                        {persistedSendStatus
                          ? ` · ${persistedSendStatus}`
                          : ""}
                      </div>
                      {sendStatusError && (
                        <p className="mt-2 text-xs text-destructive">
                          状态读取失败，页面会继续受控重试：{sendStatusError}
                        </p>
                      )}
                      {sendIntentView?.attempt && (
                        <dl className="mt-3 grid gap-1 text-xs text-muted-foreground">
                          <div className="grid gap-0.5">
                            <dt>RFC Message-ID</dt>
                            <dd className="font-mono break-all">
                              {sendIntentView.attempt.rfcMessageId}
                            </dd>
                          </div>
                          {sendIntentView.attempt.providerMessageId && (
                            <div className="grid gap-0.5">
                              <dt>Gmail Message ID</dt>
                              <dd className="font-mono break-all">
                                {sendIntentView.attempt.providerMessageId}
                              </dd>
                            </div>
                          )}
                          {sendIntentView.attempt.providerThreadId && (
                            <div className="grid gap-0.5">
                              <dt>Gmail Thread ID</dt>
                              <dd className="font-mono break-all">
                                {sendIntentView.attempt.providerThreadId}
                              </dd>
                            </div>
                          )}
                        </dl>
                      )}
                      {persistedSendStatus === "DELIVERY_UNKNOWN" && (
                        <p className="mt-2 text-xs font-medium text-destructive">
                          Gmail 返回未知结果。系统不会自动重试，请先人工核对收件箱和 Provider 记录。
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}

            <section className="grid gap-2">
              <label htmlFor="draft-subject" className="text-sm font-medium">
                邮件主题
              </label>
              <Input
                id="draft-subject"
                value={subjectText}
                maxLength={500}
                disabled={readOnly}
                onChange={(event) => {
                  setSubjectText(event.target.value)
                  setDirty(true)
                  setNotice(null)
                }}
              />
            </section>

            <section className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">正文</span>
                {dirty && (
                  <span className="text-xs text-muted-foreground">
                    有未保存更改
                  </span>
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
            </section>
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
  const { currentProject } = useCurrentProject()
  const { draftId } = useParams<{ draftId: string }>()
  if (!currentProject) {
    throw new Error("DraftPage requires an authorized current project.")
  }
  const projectId = currentProject.id
  if (!draftId) {
    return <div className="p-6 text-sm text-destructive">草稿 ID 缺失。</div>
  }
  if (draftId === "new") {
    return <DraftGeneration project={currentProject} />
  }
  return <DraftEditorPage projectId={projectId} draftId={draftId} />
}
