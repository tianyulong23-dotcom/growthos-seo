import { useCallback, useEffect, useMemo, useState } from "react"
import {
  CheckCircle2,
  ChevronDown,
  LoaderCircle,
  Mail,
  RefreshCw,
  Unlink2,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import { isOutreachOffline } from "@/features/outreach/shared/outreach-network-state"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"
import { getRuntimeStatus } from "@/runtime-status"

import {
  confirmReplyMatchCandidate,
  getGmailPollingSyncStatus,
  getReplyMailThread,
  isMailApiStatus,
  listReplyMailMessages,
  listReplyMatchCandidates,
  startGmailPollingSync,
  unbindReplyMatch,
} from "./api"
import type {
  GmailPollingSyncStatus,
  MailListItem,
  MailMatchStatus,
  MailThread,
  ReplyMatchCandidate,
} from "./types"

type LoadState =
  "loading" | "ready" | "empty" | "error" | "forbidden" | "offline"
type MatchActionState =
  | "idle"
  | "confirming"
  | "confirmed"
  | "unbinding"
  | "unbound"
  | "conflict"
  | "stale"
type MatchFilter = "ALL" | MailMatchStatus
type SyncNotice = "paused" | "failed" | null

const filters: ReadonlyArray<{ label: string; value: MatchFilter }> = [
  { label: "全部邮件", value: "ALL" },
  { label: "待处理", value: "UNMATCHED" },
  { label: "需确认", value: "CANDIDATES_READY" },
  { label: "已确认", value: "MATCH_CONFIRMED" },
]

const matchLabels: Record<MailMatchStatus, string> = {
  UNMATCHED: "待处理",
  CANDIDATES_READY: "需确认",
  MATCH_CONFIRMED: "已确认",
}

const dateTime = (value: string | null) =>
  value === null
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))

const errorState = (error: unknown): LoadState =>
  isOutreachOffline()
    ? "offline"
    : isMailApiStatus(error, 403)
      ? "forbidden"
      : "error"

function StateNotice({
  state,
  retry,
}: {
  state: Exclude<LoadState, "ready">
  retry?: () => void
}) {
  return (
    <OutreachStandardStateView
      state={state}
      title={
        state === "loading"
          ? "邮件加载中"
          : state === "forbidden"
            ? "没有读取此项目邮件的权限"
            : state === "empty"
              ? "当前筛选下没有邮件"
              : state === "offline"
                ? "邮件中心当前离线"
                : "邮件加载失败"
      }
      description={
        state === "empty"
          ? "可以切换筛选条件，或稍后刷新查看新邮件。"
          : "不会回退到本地邮件或其他项目数据。"
      }
      onRetry={state === "loading" || state === "empty" ? undefined : retry}
      className="min-h-36"
    />
  )
}

function MailBody({ message }: { message: MailThread["messages"][number] }) {
  if (message.body.plainText) {
    return (
      <pre className="mt-3 font-sans text-sm leading-6 break-words whitespace-pre-wrap">
        {message.body.plainText}
      </pre>
    )
  }

  const html = message.body.sanitizedHtml
  if (
    html?.trust === "SANITIZED" &&
    html.sanitized === true &&
    html.policyVersion.trim().length > 0
  ) {
    return (
      <iframe
        className="mt-3 min-h-56 w-full border bg-background"
        referrerPolicy="no-referrer"
        sandbox=""
        srcDoc={html.content}
        title={`已净化邮件正文 ${message.id}`}
      />
    )
  }

  return (
    <div className="mt-3 border-l-2 border-muted pl-3 text-xs text-muted-foreground">
      这封邮件暂时没有可显示的正文。
    </div>
  )
}

function reasonEvidence(reasonCodes: Array<Record<string, unknown>>) {
  const labels = reasonCodes.flatMap((reason) => {
    const kind = typeof reason.kind === "string" ? reason.kind : ""
    switch (kind) {
      case "PROVIDER_THREAD_EXACT":
        return ["Gmail 会话 ID 精确匹配"]
      case "IN_REPLY_TO_EXACT":
        return ["In-Reply-To 精确匹配"]
      case "REFERENCES_EXACT":
        return ["References 精确匹配"]
      case "QUOTED_BODY_FINGERPRINT":
        return ["引用正文指纹匹配"]
      case "KNOWN_CONTACT":
        return ["已确认联系人匹配"]
      case "NORMALIZED_SUBJECT":
        return ["规范化主题匹配"]
      case "PARTICIPANT_OVERLAP":
        return ["参与人重合"]
      case "TIME_WINDOW":
        return [
          typeof reason.hours === "number"
            ? `发送时间窗口 ${Math.round(reason.hours)} 小时`
            : "发送时间窗口匹配",
        ]
      case "RULE_VERSION":
        return [
          typeof reason.value === "string"
            ? `匹配规则 ${reason.value}`
            : "匹配规则已记录",
        ]
      default:
        return []
    }
  })
  return labels.length === 0 ? "暂无足够的匹配依据" : labels.join("、")
}

export function MailCenter({
  websiteProjectKey,
  connectionId,
}: {
  websiteProjectKey: string
  connectionId: string | null
}) {
  const [filter, setFilter] = useState<MatchFilter>("ALL")
  const [items, setItems] = useState<MailListItem[]>([])
  const [listState, setListState] = useState<LoadState>("loading")
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncNotice, setSyncNotice] = useState<SyncNotice>(null)
  const [syncStatus, setSyncStatus] =
    useState<GmailPollingSyncStatus | null>(null)
  const [syncStatusState, setSyncStatusState] =
    useState<LoadState>("loading")
  const [businessConsumersRunning, setBusinessConsumersRunning] =
    useState<boolean | null>(null)
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    null
  )
  const [thread, setThread] = useState<MailThread | null>(null)
  const [threadState, setThreadState] = useState<LoadState>("empty")
  const [candidates, setCandidates] = useState<ReplyMatchCandidate[]>([])
  const [candidateState, setCandidateState] = useState<LoadState>("empty")
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    null
  )
  const [confirmationReason, setConfirmationReason] = useState("")
  const [unbindReason, setUnbindReason] = useState("")
  const [actionState, setActionState] = useState<MatchActionState>("idle")
  const listKey = useMemo(
    () =>
      createProjectQueryKey(
        websiteProjectKey,
        "mail-messages",
        filter,
        25,
        null
    ),
    [filter, websiteProjectKey]
  )

  const fetchFirstPage = () => {
    backlinksProjectQueries.invalidate(listKey)
    return backlinksProjectQueries.fetch(listKey, (signal) =>
      listReplyMailMessages(
        websiteProjectKey,
        {
          matchStatus: filter === "ALL" ? undefined : filter,
          limit: 25,
        },
        signal
      )
    )
  }

  const loadSyncStatus = useCallback(async () => {
    if (connectionId === null) {
      setSyncStatus(null)
      setSyncStatusState("empty")
      return
    }
    setSyncStatusState("loading")
    try {
      const response = await getGmailPollingSyncStatus(
        websiteProjectKey,
        connectionId
      )
      setSyncStatus(response)
      setSyncStatusState("ready")
    } catch (error) {
      setSyncStatus(null)
      setSyncStatusState(errorState(error))
    }
  }, [connectionId, websiteProjectKey])

  const loadRuntimeStatus = useCallback(async () => {
    try {
      const runtime = await getRuntimeStatus()
      setBusinessConsumersRunning(runtime.business_consumers_running)
    } catch {
      setBusinessConsumersRunning(false)
    }
  }, [])

  const applyFirstPage = (
    response: Awaited<ReturnType<typeof listReplyMailMessages>>
  ) => {
    setItems(response.items)
    setNextCursor(response.nextCursor)
    setHasMore(response.hasMore)
    setListState(response.items.length === 0 ? "empty" : "ready")
  }

  const loadFirstPage = async () => {
    setListState("loading")
    setSelectedMessageId(null)
    setThread(null)
    setThreadState("empty")
    setCandidates([])
    setCandidateState("empty")
    setActionState("idle")
    try {
      applyFirstPage(await fetchFirstPage())
    } catch (error) {
      setItems([])
      setNextCursor(null)
      setHasMore(false)
      setListState(errorState(error))
    }
  }

  const syncAndRefresh = async () => {
    if (
      connectionId === null ||
      syncing ||
      businessConsumersRunning !== true
    ) {
      return
    }
    setSyncing(true)
    setSyncNotice(null)
    try {
      const existingIds = new Set(items.map((item) => item.id))
      await startGmailPollingSync(websiteProjectKey, connectionId)
      await loadSyncStatus()
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000))
        const response = await fetchFirstPage()
        applyFirstPage(response)
        if (
          response.items.some((item) => !existingIds.has(item.id)) ||
          attempt === 14
        ) {
          break
        }
      }
    } catch (error) {
      try {
        applyFirstPage(await fetchFirstPage())
        setSyncNotice(isMailApiStatus(error, 409) ? "paused" : "failed")
      } catch (listError) {
        setListState(errorState(listError))
      }
    } finally {
      setSyncing(false)
      await loadSyncStatus()
    }
  }

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      void loadSyncStatus()
    }, 0)
    return () => window.clearTimeout(loadTimer)
  }, [loadSyncStatus])

  useEffect(() => {
    const initialCheck = window.setTimeout(() => void loadRuntimeStatus(), 0)
    const poller = window.setInterval(() => void loadRuntimeStatus(), 5_000)
    return () => {
      window.clearTimeout(initialCheck)
      window.clearInterval(poller)
    }
  }, [loadRuntimeStatus])

  useEffect(() => {
    let active = true
    void backlinksProjectQueries
      .fetch(listKey, (signal) =>
        listReplyMailMessages(
          websiteProjectKey,
          {
            matchStatus: filter === "ALL" ? undefined : filter,
            limit: 25,
          },
          signal
        )
      )
      .then((response) => {
        if (!active) return
        setItems(response.items)
        setNextCursor(response.nextCursor)
        setHasMore(response.hasMore)
        setListState(response.items.length === 0 ? "empty" : "ready")
      })
      .catch((error: unknown) => {
        if (!active) return
        setItems([])
        setNextCursor(null)
        setHasMore(false)
        setListState(errorState(error))
      })

    return () => {
      active = false
      backlinksProjectQueries.invalidate(listKey)
    }
  }, [filter, listKey, websiteProjectKey])

  const changeFilter = (value: MatchFilter) => {
    if (value === filter) return
    setListState("loading")
    setSelectedMessageId(null)
    setThread(null)
    setThreadState("empty")
    setCandidates([])
    setCandidateState("empty")
    setActionState("idle")
    setFilter(value)
  }

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const pageKey = createProjectQueryKey(
        websiteProjectKey,
        "mail-messages",
        filter,
        25,
        nextCursor
      )
      const response = await backlinksProjectQueries.fetch(pageKey, (signal) =>
        listReplyMailMessages(
          websiteProjectKey,
          {
            matchStatus: filter === "ALL" ? undefined : filter,
            limit: 25,
            cursor: nextCursor,
          },
          signal
        )
      )
      setItems((current) => [...current, ...response.items])
      setNextCursor(response.nextCursor)
      setHasMore(response.hasMore)
    } catch (error) {
      setListState(errorState(error))
    } finally {
      setLoadingMore(false)
    }
  }

  const openMessage = async (message: MailListItem) => {
    setSelectedMessageId(message.id)
    setThreadState("loading")
    setThread(null)
    setCandidates([])
    setCandidateState("empty")
    setSelectedCandidateId(null)
    setConfirmationReason("")
    setUnbindReason("")
    setActionState("idle")

    try {
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "mail-thread",
      ])
      const threadKey = createProjectQueryKey(
        websiteProjectKey,
        "mail-thread",
        message.threadId
      )
      const response = await backlinksProjectQueries.fetch(
        threadKey,
        (signal) =>
          getReplyMailThread(websiteProjectKey, message.threadId, signal)
      )
      setThread(response.item)
      setThreadState(response.item.messages.length === 0 ? "empty" : "ready")
    } catch (error) {
      setThreadState(errorState(error))
      return
    }

    if (
      message.matchStatus !== "CANDIDATES_READY" ||
      !message.inboundMessageId
    ) {
      return
    }

    setCandidateState("loading")
    try {
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "reply-match-candidates",
      ])
      const candidateKey = createProjectQueryKey(
        websiteProjectKey,
        "reply-match-candidates",
        message.inboundMessageId
      )
      const response = await backlinksProjectQueries.fetch(
        candidateKey,
        (signal) =>
          listReplyMatchCandidates(
            websiteProjectKey,
            message.inboundMessageId!,
            signal
          )
      )
      setCandidates(response.items)
      setCandidateState(response.items.length === 0 ? "empty" : "ready")
    } catch (error) {
      setCandidateState(errorState(error))
    }
  }

  const selectedMessage = useMemo(
    () => items.find((item) => item.id === selectedMessageId) ?? null,
    [items, selectedMessageId]
  )
  const selectedCandidate = useMemo(
    () =>
      candidates.find((candidate) => candidate.id === selectedCandidateId) ??
      null,
    [candidates, selectedCandidateId]
  )
  const threadParticipants = useMemo(() => {
    if (thread === null) return []
    return [
      ...new Set(
        thread.messages.flatMap((message) => [
          ...(message.fromAddress ? [message.fromAddress] : []),
          ...message.toAddresses,
          ...message.ccAddresses,
        ])
      ),
    ]
  }, [thread])
  const latestThreadMessage = thread?.messages.at(-1) ?? null

  const confirmCandidate = async () => {
    if (
      !selectedMessage?.inboundMessageId ||
      !selectedCandidate ||
      confirmationReason.trim().length === 0
    ) {
      setActionState("stale")
      return
    }

    setActionState("confirming")
    try {
      const response = await confirmReplyMatchCandidate(
        websiteProjectKey,
        selectedMessage.inboundMessageId,
        selectedCandidate.id,
        confirmationReason.trim()
      )
      if (
        response.matchStatus !== "MATCH_CONFIRMED" ||
        response.candidateId !== selectedCandidate.id ||
        response.opportunityId !== selectedCandidate.opportunityId ||
        response.inboundMessageId !== selectedMessage.inboundMessageId
      ) {
        setActionState("stale")
        return
      }

      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "mail-messages",
      ])
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "reply-match-candidates",
      ])
      setActionState("confirmed")
      setCandidates([])
      setCandidateState("empty")
      setItems((current) =>
        current.map((item) =>
          item.id === selectedMessage.id
            ? {
                ...item,
                matchStatus: "MATCH_CONFIRMED",
                matchedOpportunityId: response.opportunityId,
              }
            : item
        )
      )
    } catch (error) {
      if (isMailApiStatus(error, 409)) {
        setActionState("conflict")
      } else if (isMailApiStatus(error, 403)) {
        setCandidateState("forbidden")
        setActionState("idle")
      } else {
        setActionState("stale")
      }
    }
  }

  const unbindConfirmedMatch = async () => {
    if (
      !selectedMessage?.inboundMessageId ||
      unbindReason.trim().length === 0
    ) {
      setActionState("stale")
      return
    }

    setActionState("unbinding")
    try {
      const response = await unbindReplyMatch(
        websiteProjectKey,
        selectedMessage.inboundMessageId,
        unbindReason.trim()
      )
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "mail-messages",
      ])
      backlinksProjectQueries.invalidate([
        "backlinks",
        websiteProjectKey,
        "reply-match-candidates",
      ])
      setItems((current) =>
        current.map((item) =>
          item.id === selectedMessage.id
            ? {
                ...item,
                matchStatus: response.matchStatus,
                matchedOpportunityId: null,
              }
            : item
        )
      )
      setUnbindReason("")
      setActionState("unbound")

      if (response.matchStatus === "CANDIDATES_READY") {
        setCandidateState("loading")
        const candidateResponse = await listReplyMatchCandidates(
          websiteProjectKey,
          selectedMessage.inboundMessageId
        )
        setCandidates(candidateResponse.items)
        setCandidateState(
          candidateResponse.items.length === 0 ? "empty" : "ready"
        )
      }
    } catch (error) {
      if (isMailApiStatus(error, 409)) {
        setActionState("conflict")
      } else if (isMailApiStatus(error, 403)) {
        setCandidateState("forbidden")
        setActionState("idle")
      } else {
        setActionState("stale")
      }
    }
  }

  return (
    <section aria-labelledby="mail-center-title">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Mail className="size-5 text-primary" />
            <h2 id="mail-center-title" className="text-base font-semibold">
              邮件中心
            </h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            集中查看邮件往来，并处理需要确认的回复。
          </p>
        </div>
        <div
          className="flex max-w-full gap-1 overflow-x-auto pb-1"
          aria-label="邮件匹配状态筛选"
        >
          {filters.map((item) => (
            <Button
              key={item.value}
              aria-pressed={filter === item.value}
              size="sm"
              variant={filter === item.value ? "secondary" : "ghost"}
              onClick={() => changeFilter(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>

      <div
        data-testid="mail-sync-diagnostics"
        className="mt-4 border-y bg-muted/20 px-3 py-3 text-xs"
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge
            variant={businessConsumersRunning === true ? "secondary" : "outline"}
          >
            {businessConsumersRunning === true
              ? "后台 Worker 运行中"
              : "维护模式：后台 Worker 未运行"}
          </Badge>
          {businessConsumersRunning !== true ? (
            <span className="text-muted-foreground">
              已保存邮件仍可读取；立即同步暂不可用。
            </span>
          ) : null}
        </div>
        {syncStatusState === "ready" && syncStatus ? (
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,auto)]">
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-medium">
                同步状态：
                {syncStatus.state === "POLLING"
                  ? "持续轮询"
                  : syncStatus.state === "WAITING_FOR_ACCEPTED_SEND"
                    ? "等待真实发送记录"
                    : "已暂停"}
              </span>
              <span className="text-muted-foreground">
                间隔 {syncStatus.pollingIntervalSeconds} 秒
              </span>
              <span className="text-muted-foreground">
                可匹配发送 {syncStatus.acceptedSendCount} 条
              </span>
              <span className="text-muted-foreground">
                Kill Switch {syncStatus.killSwitchOpen ? "已开启" : "已关闭"}
              </span>
            </div>
            <div className="min-w-0 text-muted-foreground lg:text-right">
              {syncStatus.cursor ? (
                <span className="break-all">
                  游标 {syncStatus.cursor.historyId} · 版本{" "}
                  {syncStatus.cursor.version} · 最近同步{" "}
                  {dateTime(syncStatus.cursor.lastSyncedAt)}
                </span>
              ) : (
                <span>当前项目尚未建立 Gmail History 游标</span>
              )}
            </div>
            <div className="min-w-0 text-muted-foreground">
              最近成功：{dateTime(syncStatus.lastSuccessfulSyncAt)}
            </div>
            <div
              className={
                syncStatus.lastError
                  ? "min-w-0 break-words text-destructive lg:text-right"
                  : "min-w-0 text-muted-foreground lg:text-right"
              }
            >
              {syncStatus.lastError
                ? `错误分类：${syncStatus.lastErrorCategory ?? "UNKNOWN"} · ` +
                  `最近错误：${syncStatus.lastError} · ` +
                  (syncStatus.lastErrorCategory === "GOOGLE_AUTH_EXPIRED"
                    ? "下次重试：等待重新授权"
                    : `下次重试 ${dateTime(syncStatus.nextRetryAt)}`)
                : `下次重试：${dateTime(syncStatus.nextRetryAt)}`}
            </div>
          </div>
        ) : syncStatusState === "loading" ? (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            正在读取同步状态
          </span>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              暂时无法读取同步状态，已保存邮件不受影响。
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={connectionId === null}
              onClick={() => void loadSyncStatus()}
            >
              <RefreshCw data-icon="inline-start" />
              重新检查
            </Button>
          </div>
        )}
      </div>

      <div className="mt-4 grid min-h-[34rem] border-y lg:grid-cols-[minmax(17rem,0.9fr)_minmax(0,1.6fr)]">
        <div className="min-w-0 border-b lg:border-r lg:border-b-0">
          <div className="flex h-11 items-center justify-between border-b px-3">
            <div className="min-w-0">
              <span className="text-xs font-medium text-muted-foreground">
                {filter === "ALL" ? "全部邮件" : matchLabels[filter]}
              </span>
              {syncNotice ? (
                <p
                  className="truncate text-[11px] text-muted-foreground"
                  role="status"
                >
                  {syncNotice === "paused"
                    ? "Gmail 同步已暂停，当前显示已保存邮件。"
                    : "Gmail 同步暂时失败，当前显示已保存邮件。"}
                </p>
              ) : null}
            </div>
            <Button
              aria-label="立即同步并刷新邮件"
              size="icon-xs"
              title={
                businessConsumersRunning === true
                  ? "立即同步并刷新邮件"
                  : "后台 Worker 未运行，立即同步暂不可用"
              }
              variant="ghost"
              disabled={
                connectionId === null ||
                syncing ||
                businessConsumersRunning !== true
              }
              onClick={() => void syncAndRefresh()}
            >
              <RefreshCw className={syncing ? "animate-spin" : undefined} />
            </Button>
          </div>

          {listState === "ready" ? (
            <div>
              <div className="divide-y">
                {items.map((item) => (
                  <button
                    key={item.id}
                    className="block min-h-24 w-full px-3 py-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    type="button"
                    aria-current={
                      selectedMessageId === item.id ? "true" : undefined
                    }
                    onClick={() => void openMessage(item)}
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <span className="truncate text-sm font-medium">
                        {item.subject || "（无主题）"}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {dateTime(item.receivedAt)}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {item.direction === "INBOUND"
                        ? item.fromAddress || "发件人未知"
                        : item.toAddresses.join(", ") || "收件人未知"}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <Badge variant="outline">
                        {item.direction === "INBOUND" ? "收件" : "发件"}
                      </Badge>
                      {item.matchStatus ? (
                        <Badge
                          variant={
                            item.matchStatus === "CANDIDATES_READY"
                              ? "destructive"
                              : "secondary"
                          }
                          className={
                            item.matchStatus === "CANDIDATES_READY"
                              ? "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200"
                              : undefined
                          }
                        >
                          {matchLabels[item.matchStatus]}
                        </Badge>
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>
              {hasMore && nextCursor ? (
                <div className="border-t p-3">
                  <Button
                    className="w-full"
                    disabled={loadingMore}
                    size="sm"
                    variant="outline"
                    onClick={() => void loadMore()}
                  >
                    {loadingMore ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : (
                      <ChevronDown data-icon="inline-start" />
                    )}
                    加载更多
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <StateNotice state={listState} retry={() => void loadFirstPage()} />
          )}
        </div>

        <div className="min-w-0">
          {threadState === "ready" && thread ? (
            <div>
              <header className="border-b px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">
                      {selectedMessage?.subject || "（无主题）"}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {thread.messageCount} 封邮件
                    </div>
                    <div className="mt-1 text-xs break-words text-muted-foreground">
                      参与人：{threadParticipants.join(", ") || "未知"}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      最新邮件：{dateTime(latestThreadMessage?.receivedAt ?? null)}
                    </div>
                  </div>
                </div>
              </header>

              <div className="divide-y">
                {thread.messages.map((message) => (
                  <article className="px-4 py-4" key={message.id}>
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 text-xs">
                        <div className="font-medium">
                          {message.direction === "INBOUND"
                            ? message.fromAddress || "发件人未知"
                            : message.toAddresses.join(", ") || "收件人未知"}
                        </div>
                        {message.ccAddresses.length > 0 && (
                          <div className="mt-1 text-muted-foreground">
                            抄送 {message.ccAddresses.join(", ")}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-[11px] text-muted-foreground">
                        {dateTime(message.receivedAt)}
                      </div>
                    </div>
                    <MailBody message={message} />
                  </article>
                ))}
              </div>

              {selectedMessage?.matchStatus === "CANDIDATES_READY" &&
              selectedMessage.inboundMessageId ? (
                <section
                  className="border-t bg-muted/20 px-4 py-4"
                  aria-labelledby="manual-match-title"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3
                        id="manual-match-title"
                        className="text-sm font-semibold"
                      >
                        回信人工确认
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        选择最符合当前邮件的外链机会并记录确认理由。
                      </p>
                    </div>
                    <Badge
                      variant="destructive"
                      className="bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200"
                    >
                      待确认
                    </Badge>
                  </div>

                  {candidateState === "ready" ? (
                    <fieldset className="mt-4 space-y-2">
                      <legend className="sr-only">选择匹配候选</legend>
                      {candidates.map((candidate) => (
                        <label
                          className="flex cursor-pointer gap-3 border p-3 hover:bg-background"
                          key={candidate.id}
                        >
                          <input
                            className="mt-1 size-4 accent-primary"
                            name="reply-match-candidate"
                            type="radio"
                            checked={selectedCandidateId === candidate.id}
                            onChange={() =>
                              setSelectedCandidateId(candidate.id)
                            }
                          />
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium">
                                匹配建议 {candidate.candidateRank}
                              </span>
                              <Badge variant="outline">
                                置信度{" "}
                                {Math.round(candidate.confidenceScore * 100)}%
                              </Badge>
                              {candidate.requiresManualConfirmation ? (
                                <Badge
                                  variant="destructive"
                                  className="bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200"
                                >
                                  需要确认
                                </Badge>
                              ) : null}
                            </span>
                            <span className="mt-1 block text-xs break-all text-foreground">
                              Opportunity：{candidate.opportunityId}
                            </span>
                            <span className="mt-1 block text-xs leading-5 break-words text-muted-foreground">
                              匹配依据：{reasonEvidence(candidate.reasonCodes)}
                            </span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  ) : (
                    <StateNotice
                      state={candidateState}
                      retry={() => void openMessage(selectedMessage)}
                    />
                  )}

                  {candidateState === "ready" ? (
                    <div className="mt-4 border-t pt-4">
                      <label className="mt-3 block text-xs font-medium">
                        确认理由
                        <Textarea
                          className="mt-2 min-h-20 rounded-md"
                          maxLength={500}
                          placeholder="记录人工核对依据"
                          value={confirmationReason}
                          onChange={(event) =>
                            setConfirmationReason(event.target.value)
                          }
                        />
                      </label>
                      <Button
                        className="mt-3"
                        disabled={
                          actionState === "confirming" ||
                          !selectedCandidate ||
                          confirmationReason.trim().length === 0
                        }
                        onClick={() => void confirmCandidate()}
                      >
                        {actionState === "confirming" ? (
                          <LoaderCircle
                            className="animate-spin"
                            data-icon="inline-start"
                          />
                        ) : (
                          <CheckCircle2 data-icon="inline-start" />
                        )}
                        确认关联
                      </Button>
                    </div>
                  ) : null}

                  <div className="mt-3 text-xs" aria-live="polite">
                    {actionState === "confirmed" ? (
                      <span className="text-emerald-700">
                        已确认匹配并关联到对应的外链机会。
                      </span>
                    ) : actionState === "conflict" ? (
                      <span className="text-destructive">
                        邮件状态已更新，请刷新后重新确认。
                      </span>
                    ) : actionState === "stale" ? (
                      <span className="text-destructive">
                        本次确认未完成，请检查选择和确认理由后重试。
                      </span>
                    ) : null}
                  </div>
                </section>
              ) : selectedMessage?.matchStatus === "MATCH_CONFIRMED" ? (
                <section className="border-t bg-emerald-500/5 px-4 py-4 text-xs">
                  <div className="font-medium text-emerald-800 dark:text-emerald-200">
                    已关联到外链机会
                  </div>
                  <div className="mt-1 break-all text-muted-foreground">
                    Opportunity：{selectedMessage.matchedOpportunityId}
                  </div>
                  <label className="mt-4 block font-medium">
                    解除理由
                    <Textarea
                      className="mt-2 min-h-20 rounded-md bg-background"
                      maxLength={500}
                      placeholder="说明为什么当前关联不正确"
                      value={unbindReason}
                      onChange={(event) => setUnbindReason(event.target.value)}
                    />
                  </label>
                  <Button
                    className="mt-3"
                    size="sm"
                    variant="outline"
                    disabled={
                      actionState === "unbinding" ||
                      unbindReason.trim().length === 0
                    }
                    onClick={() => void unbindConfirmedMatch()}
                  >
                    {actionState === "unbinding" ? (
                      <LoaderCircle
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : (
                      <Unlink2 data-icon="inline-start" />
                    )}
                    解除错误关联
                  </Button>
                  <div className="mt-3" aria-live="polite">
                    {actionState === "conflict" ? (
                      <span className="text-destructive">
                        邮件状态已更新，请刷新后重试。
                      </span>
                    ) : actionState === "stale" ? (
                      <span className="text-destructive">
                        解除未完成，请检查理由后重试。
                      </span>
                    ) : null}
                  </div>
                </section>
              ) : null}
            </div>
          ) : threadState === "empty" && selectedMessageId === null ? (
            <div className="flex min-h-72 flex-col items-center justify-center px-4 text-center">
              <Mail className="mb-3 size-6 text-muted-foreground" />
              <div className="text-sm font-medium">选择一封邮件查看对话</div>
              <div className="mt-1 text-xs text-muted-foreground">
                邮件正文和关联机会会显示在这里。
              </div>
            </div>
          ) : (
            <StateNotice
              state={threadState === "ready" ? "error" : threadState}
              retry={
                selectedMessage
                  ? () => void openMessage(selectedMessage)
                  : undefined
              }
            />
          )}
        </div>
      </div>
    </section>
  )
}
