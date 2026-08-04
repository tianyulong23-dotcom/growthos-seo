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
} from "lucide-react"
import { Link, useParams } from "react-router"

import { ApiError } from "@/api/client"
import { defaultProject } from "@/app/project-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { getBacklinkOpportunity } from "@/features/outreach/api/client"
import {
  approveDraft,
  createSendIntent,
  getDraft,
  listContactCandidates,
  saveDraftVersion,
} from "@/features/outreach/drafts/api"
import {
  emptyDraftDocument,
  normalizeDraftDocument,
} from "@/features/outreach/drafts/draft-document"
import { DraftEditor } from "@/features/outreach/drafts/draft-editor"
import type {
  ContactCandidate,
  DraftDocument,
  DraftSnapshot,
  DraftStatus,
  SendIntentResult,
} from "@/features/outreach/drafts/types"
import { useGmailConnection } from "@/features/outreach/gmail/use-gmail-connection"

const statusLabels: Record<DraftStatus, string> = {
  generating: "生成中",
  draft: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
  sent: "已发送",
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

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN")
}

function sendIntentErrorMessage(error: unknown): {
  message: string
  unknown: boolean
} {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return {
        message: "草稿、身份或服务端门禁已变化；请刷新后重新核对。",
        unknown: false,
      }
    }
    if (error.status === 429) {
      return {
        message: "服务端配额或频率门禁已拒绝此请求，未创建 Send Intent。",
        unknown: false,
      }
    }
    if (error.status >= 400 && error.status < 500) {
      return {
        message: "服务端拒绝创建 Send Intent；请刷新并核对批准版本和 Gmail 身份。",
        unknown: false,
      }
    }
  }

  return {
    message:
      "创建结果未知。不会显示为已发送；请使用相同请求键重试或等待服务端记录可查询。",
    unknown: true,
  }
}

export function DraftPage() {
  const { projectId = defaultProject.id, draftId } = useParams<{
    projectId: string
    draftId: string
  }>()
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
    ContactCandidate[]
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
  const [sendIntentUnknown, setSendIntentUnknown] = React.useState(false)
  const gmailConnection = useGmailConnection(projectId, Boolean(draftId))

  const loadRecipient = React.useCallback(
    async (opportunityId: string) => {
      setRecipientStatus("loading")
      setRecipientCandidates([])
      setRecipientError(null)
      try {
        const opportunity = await getBacklinkOpportunity(
          projectId,
          opportunityId
        )
        const response = await listContactCandidates(
          projectId,
          opportunity.item.prospectId
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
    if (!draftId) return
    setLoading(true)
    setError(null)
    try {
      const response = await getDraft(projectId, draftId)
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
    if (!draftId || !snapshot?.currentVersion || dirty) return
    setApproving(true)
    setError(null)
    setNotice(null)
    try {
      await approveDraft(projectId, draftId, snapshot.draftVersion)
      await load()
      setSendConfirmed(false)
      setSendRequestKey(null)
      setSendIntent(null)
      setSendIntentUnknown(false)
      setNotice("当前草稿版本已人工批准。")
    } catch (approveError) {
      setError(errorMessage(approveError))
    } finally {
      setApproving(false)
    }
  }

  if (!draftId) {
    return <div className="p-6 text-sm text-destructive">草稿 ID 缺失。</div>
  }

  const currentVersion = snapshot?.currentVersion ?? null
  const readOnly =
    snapshot?.status === "approved" || snapshot?.status === "sent"
  const busy = loading || saving || approving || creatingSendIntent
  const recipient =
    recipientStatus === "ready" && recipientCandidates.length === 1
      ? recipientCandidates[0]
      : null
  const approvedVersionMatchesCurrent =
    snapshot?.approvedVersionId !== null &&
    snapshot?.approvedVersionId === currentVersion?.id
  const gmailReady =
    gmailConnection.status === "ready" &&
    gmailConnection.connection?.connectionStatus === "CONNECTED" &&
    gmailConnection.connection.sendAvailability === "AVAILABLE"
  const sendPreconditionsReady =
    snapshot?.status === "approved" &&
    approvedVersionMatchesCurrent &&
    gmailReady &&
    recipient !== null
  const canCreateSendIntent =
    sendPreconditionsReady &&
    sendConfirmed &&
    !busy &&
    sendIntent === null

  const createApprovedSendIntent = async () => {
    if (
      !draftId ||
      !snapshot?.approvedVersionId ||
      !gmailConnection.connection ||
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
          gmailConnectionId: gmailConnection.connection.connectionId,
          messagePurpose: "INITIAL_OUTREACH",
          followUpIndex: 0,
        },
        idempotencyKey
      )
      setSendIntent(response)
      setNotice("Send Intent 已创建并处于 READY；这不是发送成功。")
    } catch (sendError) {
      const result = sendIntentErrorMessage(sendError)
      setSendIntentUnknown(result.unknown)
      setError(result.message)
    } finally {
      setCreatingSendIntent(false)
    }
  }

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
                  disabled={dirty || busy || snapshot?.status !== "draft"}
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
                      发送前二次确认
                    </h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      只会创建服务端 Send Intent；服务端仍会重新校验身份、抑制和配额。
                    </p>
                  </div>
                  <Badge variant="outline">服务端复核</Badge>
                </div>

                <dl className="grid gap-3 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">发送身份</dt>
                    <dd className="mt-1 break-all font-medium">
                      {gmailReady
                        ? gmailConnection.connection?.primaryEmail
                        : "Gmail 身份未就绪"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">收件人</dt>
                    <dd className="mt-1 break-all font-medium">
                      {recipient?.normalizedEmail ??
                        (recipientStatus === "loading"
                          ? "正在读取候选"
                          : "未获得唯一候选")}
                    </dd>
                    {recipient && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        仅展示联系人候选，执行时仍由服务端重新校验。
                      </div>
                    )}
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
                {recipientStatus === "ready" &&
                  recipientCandidates.length !== 1 && (
                    <p className="text-xs text-destructive">
                      {recipientCandidates.length === 0
                        ? "未找到收件人候选，不能创建 Send Intent。"
                        : "候选不止一个，公开契约未定义本地发送目标选择，不能创建 Send Intent。"}
                    </p>
                  )}
                {!approvedVersionMatchesCurrent && (
                  <p className="text-xs text-destructive">
                    当前展示版本与已批准版本不一致，不能创建 Send Intent。
                  </p>
                )}
                {!gmailReady && gmailConnection.status !== "loading" && (
                  <p className="text-xs text-destructive">
                    Gmail 连接未处于可发送状态，不能创建 Send Intent。
                  </p>
                )}

                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={sendConfirmed}
                    disabled={!sendPreconditionsReady || sendIntent !== null}
                    onCheckedChange={setSendConfirmed}
                  />
                  <span>
                    我已核对发送身份、收件人候选与已批准版本，并确认创建
                    Send Intent 不等同于发送成功。
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
                      ? "使用原请求键重试"
                      : "创建 Send Intent"}
                  </Button>
                  {sendIntentUnknown && (
                    <span className="text-xs text-muted-foreground">
                      结果未知时会保留原 idempotency key，避免重复创建。
                    </span>
                  )}
                </div>

                {sendIntent && (
                  <div
                    role="status"
                    className="flex items-start gap-2 border-t pt-3 text-sm"
                  >
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                    <div>
                      <div className="font-medium">
                        Send Intent 已创建 · {sendIntent.status}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        请求时间 {formatTimestamp(sendIntent.requestedSendAt)}
                        。READY 只是服务端已记录发送意图，不是发送成功。
                      </div>
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
