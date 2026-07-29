import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Inbox,
  LoaderCircle,
  Mail,
  RefreshCw,
  ShieldAlert,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"

import {
  confirmReplyMatchCandidate,
  getReplyMailThread,
  isMailApiStatus,
  listReplyMailMessages,
  listReplyMatchCandidates,
} from "./api"
import type {
  MailListItem,
  MailMatchStatus,
  MailThread,
  ReplyMatchCandidate,
} from "./types"

type LoadState = "loading" | "ready" | "empty" | "error" | "forbidden"
type MatchActionState =
  "idle" | "confirming" | "confirmed" | "conflict" | "stale"
type MatchFilter = "ALL" | MailMatchStatus

const filters: ReadonlyArray<{ label: string; value: MatchFilter }> = [
  { label: "全部", value: "ALL" },
  { label: "待匹配", value: "UNMATCHED" },
  { label: "需确认", value: "CANDIDATES_READY" },
  { label: "已确认", value: "MATCH_CONFIRMED" },
]

const matchLabels: Record<MailMatchStatus, string> = {
  UNMATCHED: "待匹配",
  CANDIDATES_READY: "需人工确认",
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
  isMailApiStatus(error, 403) ? "forbidden" : "error"

function StateNotice({
  state,
  retry,
}: {
  state: Exclude<LoadState, "ready">
  retry?: () => void
}) {
  if (state === "loading") {
    return (
      <div className="space-y-3 py-4" aria-label="邮件加载中">
        <Skeleton className="h-16 w-full rounded-md" />
        <Skeleton className="h-16 w-full rounded-md" />
        <Skeleton className="h-16 w-full rounded-md" />
      </div>
    )
  }

  const forbidden = state === "forbidden"
  const empty = state === "empty"
  return (
    <div
      className="flex min-h-36 flex-col items-center justify-center border-y px-4 py-8 text-center"
      role={empty ? "status" : "alert"}
    >
      {forbidden ? (
        <ShieldAlert className="mb-3 size-5 text-destructive" />
      ) : empty ? (
        <Inbox className="mb-3 size-5 text-muted-foreground" />
      ) : (
        <AlertTriangle className="mb-3 size-5 text-destructive" />
      )}
      <div className="text-sm font-medium">
        {forbidden
          ? "没有读取此项目邮件的权限"
          : empty
            ? "当前筛选下没有邮件"
            : "邮件请求失败"}
      </div>
      <div className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
        {forbidden
          ? "服务端返回 403；界面不会回退到其他项目或缓存数据。"
          : empty
            ? "可切换匹配状态，或等待只读同步产生新记录。"
            : "结果保持未知。请重试读取，不会将失败推断为成功。"}
      </div>
      {retry && !empty ? (
        <Button className="mt-4" size="sm" variant="outline" onClick={retry}>
          <RefreshCw data-icon="inline-start" />
          重试
        </Button>
      ) : null}
    </div>
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
      正文不可用或已清理；未显示原始 MIME 内容。
    </div>
  )
}

function reasonEvidence(reasonCodes: Array<Record<string, unknown>>) {
  if (reasonCodes.length === 0) return "无规则证据"
  return reasonCodes
    .map((reason) =>
      Object.entries(reason)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(", ")
    )
    .join("；")
}

export function MailCenter({
  websiteProjectKey,
}: {
  websiteProjectKey: string
}) {
  const [filter, setFilter] = useState<MatchFilter>("ALL")
  const [items, setItems] = useState<MailListItem[]>([])
  const [listState, setListState] = useState<LoadState>("loading")
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
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
  const [actionState, setActionState] = useState<MatchActionState>("idle")

  const loadFirstPage = async () => {
    setListState("loading")
    setSelectedMessageId(null)
    setThread(null)
    setThreadState("empty")
    setCandidates([])
    setCandidateState("empty")
    setActionState("idle")
    try {
      const response = await listReplyMailMessages(websiteProjectKey, {
        matchStatus: filter === "ALL" ? undefined : filter,
        limit: 25,
      })
      setItems(response.items)
      setNextCursor(response.nextCursor)
      setHasMore(response.hasMore)
      setListState(response.items.length === 0 ? "empty" : "ready")
    } catch (error) {
      setItems([])
      setNextCursor(null)
      setHasMore(false)
      setListState(errorState(error))
    }
  }

  useEffect(() => {
    let active = true
    void listReplyMailMessages(websiteProjectKey, {
      matchStatus: filter === "ALL" ? undefined : filter,
      limit: 25,
    })
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
    }
  }, [filter, websiteProjectKey])

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
      const response = await listReplyMailMessages(websiteProjectKey, {
        matchStatus: filter === "ALL" ? undefined : filter,
        limit: 25,
        cursor: nextCursor,
      })
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
    setActionState("idle")

    try {
      const response = await getReplyMailThread(
        websiteProjectKey,
        message.threadId
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
      const response = await listReplyMatchCandidates(
        websiteProjectKey,
        message.inboundMessageId
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

  return (
    <section className="border-t pt-5" aria-labelledby="mail-center-title">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Mail className="size-5 text-primary" />
            <h2 id="mail-center-title" className="text-base font-semibold">
              Email Center
            </h2>
            <Badge variant="outline">BL-AI-130..139</Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            项目隔离的邮件、线程与未匹配回信队列。低置信度候选只允许人工确认。
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

      <div className="mt-4 grid min-h-[34rem] border-y lg:grid-cols-[minmax(17rem,0.9fr)_minmax(0,1.6fr)]">
        <div className="min-w-0 border-b lg:border-r lg:border-b-0">
          <div className="flex h-11 items-center justify-between border-b px-3">
            <span className="text-xs font-medium text-muted-foreground">
              {filter === "ALL" ? "全部邮件" : matchLabels[filter]}
            </span>
            <Button
              aria-label="刷新邮件列表"
              size="icon-xs"
              title="刷新邮件列表"
              variant="ghost"
              onClick={() => void loadFirstPage()}
            >
              <RefreshCw />
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
                      {thread.messageCount} 封邮件 · 线程 {thread.id}
                    </div>
                  </div>
                  <Badge variant="outline">线程版本 {thread.version}</Badge>
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
                        <div className="mt-1 text-muted-foreground">
                          {message.direction === "INBOUND"
                            ? `发送至 ${message.toAddresses.join(", ")}`
                            : `抄送 ${message.ccAddresses.join(", ") || "无"}`}
                        </div>
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
                        选择候选并核对证据。候选不会被自动确认。
                      </p>
                    </div>
                    <Badge variant="destructive">CANDIDATES_READY</Badge>
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
                                候选 #{candidate.candidateRank}
                              </span>
                              <Badge variant="outline">
                                置信度{" "}
                                {Math.round(candidate.confidenceScore * 100)}%
                              </Badge>
                              {candidate.requiresManualConfirmation ? (
                                <Badge variant="destructive">
                                  必须人工确认
                                </Badge>
                              ) : null}
                            </span>
                            <span className="mt-2 block text-xs break-all">
                              目标 Opportunity：{candidate.opportunityId}
                            </span>
                            <span className="mt-1 block text-xs leading-5 break-words text-muted-foreground">
                              证据：{reasonEvidence(candidate.reasonCodes)}
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
                      <div className="grid gap-2 text-xs sm:grid-cols-2">
                        <div className="break-all">
                          目标 Opportunity：
                          {selectedCandidate?.opportunityId || "尚未选择"}
                        </div>
                        <div className="break-all">线程：{thread.id}</div>
                        <div>线程版本：{thread.version}</div>
                        <div>消息版本：{selectedMessage.version}</div>
                      </div>
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
                        人工确认匹配
                      </Button>
                    </div>
                  ) : null}

                  <div className="mt-3 text-xs" aria-live="polite">
                    {actionState === "confirmed" ? (
                      <span className="text-emerald-700">
                        服务端已确认该候选，并返回 MATCH_CONFIRMED。
                      </span>
                    ) : actionState === "conflict" ? (
                      <span className="text-destructive">
                        conflict：服务端返回
                        409，候选或匹配状态已变化。请刷新后重新核对。
                      </span>
                    ) : actionState === "stale" ? (
                      <span className="text-destructive">
                        stale：响应或本地选择不足以证明确认结果，当前结果保持未知。
                      </span>
                    ) : null}
                  </div>
                </section>
              ) : selectedMessage?.matchStatus === "MATCH_CONFIRMED" ? (
                <div className="border-t bg-emerald-500/5 px-4 py-3 text-xs">
                  已匹配 Opportunity：
                  {selectedMessage.matchedOpportunityId || "服务端未返回标识"}
                </div>
              ) : null}
            </div>
          ) : threadState === "empty" && selectedMessageId === null ? (
            <div className="flex min-h-72 flex-col items-center justify-center px-4 text-center">
              <Mail className="mb-3 size-6 text-muted-foreground" />
              <div className="text-sm font-medium">选择一封邮件查看线程</div>
              <div className="mt-1 text-xs text-muted-foreground">
                正文仅显示纯文本或服务端标记为已净化的 HTML。
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
