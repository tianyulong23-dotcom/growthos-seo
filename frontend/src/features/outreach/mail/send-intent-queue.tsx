import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ListChecks, LoaderCircle, RefreshCw } from "lucide-react"
import { Link } from "react-router"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  backlinksProjectQueries,
  createProjectQueryKey,
} from "@/features/outreach/api/project-query"
import { isOutreachOffline } from "@/features/outreach/shared/outreach-network-state"
import { OutreachStandardStateView } from "@/features/outreach/shared/outreach-standard-state"

import { getSendIntent, isMailApiStatus, listSendIntents } from "./api"
import type {
  SendIntentDetail,
  SendIntentListItem,
  SendIntentQueueKind,
} from "./types"

type LoadState =
  "loading" | "ready" | "empty" | "error" | "forbidden" | "offline"
type SendIntentFilter = "ALL" | SendIntentQueueKind

const filters: ReadonlyArray<{
  label: string
  value: SendIntentFilter
}> = [
  { label: "全部发送", value: "ALL" },
  { label: "待发送", value: "PENDING_SEND" },
  { label: "需对账", value: "RECONCILIATION_REQUIRED" },
  { label: "等回复", value: "WAITING_REPLY" },
]

const queueLabels: Record<SendIntentQueueKind, string> = {
  PENDING_SEND: "待发送",
  RECONCILIATION_REQUIRED: "需对账",
  WAITING_REPLY: "等待回复",
}

const statusLabels: Record<SendIntentListItem["status"], string> = {
  READY: "等待 Worker",
  DISPATCHING: "提交结果待落库",
  PROVIDER_ACCEPTED: "已发送",
  DELIVERY_UNKNOWN: "发送结果未知",
  FAILED_RETRYABLE: "等待重试",
  FAILED_FINAL: "发送失败",
  CANCELLED: "已取消",
  REJECTED: "已拒绝",
}

const nextActionLabels: Record<
  SendIntentListItem["diagnostics"]["primaryNextAction"],
  string
> = {
  WAIT_FOR_WORKER: "等待后台 Worker",
  RESTORE_WORKER: "恢复后台 Worker 后继续",
  WAIT_FOR_PERSISTED_RESULT: "等待发送结果持久化",
  START_OR_CONTINUE_SYNC: "继续 Gmail 同步并等待回复",
  RECONCILE_BEFORE_RETRY: "先核对 Gmail 结果，禁止自动重发",
  WAIT_FOR_RETRY: "等待已安排的重试",
  RECHECK_BEFORE_RESUBMIT: "返回草稿重新检查发送条件",
  REVIEW_FAILURE: "人工检查最终失败",
  NONE: "无需操作",
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

function QueueStateNotice({
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
          ? "发送队列加载中"
          : state === "forbidden"
            ? "没有读取此项目发送队列的权限"
            : state === "empty"
              ? "当前筛选下没有发送记录"
              : state === "offline"
                ? "发送队列当前离线"
                : "发送队列加载失败"
      }
      description="这里只展示已有发送记录，不会自动发送邮件。"
      onRetry={state === "loading" || state === "empty" ? undefined : retry}
      className="min-h-36"
    />
  )
}

export function SendIntentQueue({
  websiteProjectKey,
}: {
  websiteProjectKey: string
}) {
  const activeProjectRef = useRef(websiteProjectKey)
  const [filter, setFilter] = useState<SendIntentFilter>("ALL")
  const [items, setItems] = useState<SendIntentListItem[]>([])
  const [listState, setListState] = useState<LoadState>("loading")
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedIntentId, setSelectedIntentId] = useState<string | null>(null)
  const [detail, setDetail] = useState<SendIntentDetail | null>(null)
  const [detailState, setDetailState] = useState<LoadState>("empty")
  const listKey = useMemo(
    () =>
      createProjectQueryKey(
        websiteProjectKey,
        "send-intents",
        filter,
        25,
        null
      ),
    [filter, websiteProjectKey]
  )
  const selectedItem = useMemo(
    () => items.find((item) => item.sendIntentId === selectedIntentId) ?? null,
    [items, selectedIntentId]
  )

  useEffect(() => {
    activeProjectRef.current = websiteProjectKey
    setSelectedIntentId(null)
    setDetail(null)
    setDetailState("empty")
  }, [websiteProjectKey])

  const applyFirstPage = (
    response: Awaited<ReturnType<typeof listSendIntents>>
  ) => {
    setItems(response.items)
    setNextCursor(response.nextCursor)
    setHasMore(response.hasMore)
    setListState(response.items.length === 0 ? "empty" : "ready")
  }

  const fetchFirstPage = () => {
    backlinksProjectQueries.invalidate(listKey)
    return backlinksProjectQueries.fetch(listKey, (signal) =>
      listSendIntents(
        websiteProjectKey,
        {
          queueKind: filter === "ALL" ? undefined : filter,
          limit: 25,
        },
        signal
      )
    )
  }

  useEffect(() => {
    let active = true
    setListState("loading")
    void backlinksProjectQueries
      .fetch(listKey, (signal) =>
        listSendIntents(
          websiteProjectKey,
          {
            queueKind: filter === "ALL" ? undefined : filter,
            limit: 25,
          },
          signal
        )
      )
      .then((response) => {
        if (active) applyFirstPage(response)
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

  const changeFilter = (value: SendIntentFilter) => {
    if (value === filter) return
    setListState("loading")
    setSelectedIntentId(null)
    setDetail(null)
    setDetailState("empty")
    setFilter(value)
  }

  const refresh = async () => {
    const requestProjectKey = websiteProjectKey
    setListState("loading")
    try {
      const response = await fetchFirstPage()
      if (activeProjectRef.current === requestProjectKey) {
        applyFirstPage(response)
      }
    } catch (error) {
      if (activeProjectRef.current === requestProjectKey) {
        setListState(errorState(error))
      }
    }
  }

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    const requestProjectKey = websiteProjectKey
    setLoadingMore(true)
    try {
      const pageKey = createProjectQueryKey(
        websiteProjectKey,
        "send-intents",
        filter,
        25,
        nextCursor
      )
      const response = await backlinksProjectQueries.fetch(pageKey, (signal) =>
        listSendIntents(
          websiteProjectKey,
          {
            queueKind: filter === "ALL" ? undefined : filter,
            limit: 25,
            cursor: nextCursor,
          },
          signal
        )
      )
      if (activeProjectRef.current !== requestProjectKey) return
      setItems((current) => [...current, ...response.items])
      setNextCursor(response.nextCursor)
      setHasMore(response.hasMore)
    } catch (error) {
      if (activeProjectRef.current === requestProjectKey) {
        setListState(errorState(error))
      }
    } finally {
      if (activeProjectRef.current === requestProjectKey) {
        setLoadingMore(false)
      }
    }
  }

  const openIntent = async (item: SendIntentListItem) => {
    const requestProjectKey = websiteProjectKey
    setSelectedIntentId(item.sendIntentId)
    setDetail(null)
    setDetailState("loading")
    const detailKey = createProjectQueryKey(
      websiteProjectKey,
      "send-intent-detail",
      item.sendIntentId
    )
    backlinksProjectQueries.invalidate(detailKey)
    try {
      const response = await backlinksProjectQueries.fetch(
        detailKey,
        (signal) => getSendIntent(websiteProjectKey, item.sendIntentId, signal)
      )
      if (activeProjectRef.current !== requestProjectKey) return
      setDetail(response.sendIntent)
      setDetailState("ready")
    } catch (error) {
      if (activeProjectRef.current !== requestProjectKey) return
      setDetailState(errorState(error))
    }
  }

  return (
    <section
      className="mt-5 overflow-hidden rounded-lg border border-border/80 shadow-sm"
      aria-labelledby="send-queue-title"
    >
      <header className="flex flex-col gap-3 border-b px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ListChecks className="size-4 text-primary" />
            <h3 id="send-queue-title" className="text-sm font-semibold">
              发送记录
            </h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            查看待发送、异常对账和等待回复的邮件。
          </p>
        </div>
        <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-md bg-muted/60 p-1">
          {filters.map((item) => (
            <Button
              key={item.value}
              aria-pressed={filter === item.value}
              className="rounded-md"
              size="sm"
              variant={filter === item.value ? "secondary" : "ghost"}
              onClick={() => changeFilter(item.value)}
            >
              {item.label}
            </Button>
          ))}
          <Button
            aria-label="刷新发送队列"
            size="icon-sm"
            title="刷新发送队列"
            variant="ghost"
            onClick={() => void refresh()}
          >
            <RefreshCw />
          </Button>
        </div>
      </header>

      {listState === "ready" ? (
        <div className="grid min-h-64 lg:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.4fr)]">
          <div className="min-w-0 border-b lg:border-r lg:border-b-0">
            <div className="divide-y">
              {items.map((item) => (
                <button
                  key={item.sendIntentId}
                  type="button"
                  className={`block min-h-24 w-full border-l-[3px] px-3 py-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
                    selectedIntentId === item.sendIntentId
                      ? "border-l-primary bg-primary/5"
                      : "border-l-transparent"
                  }`}
                  aria-current={
                    selectedIntentId === item.sendIntentId ? "true" : undefined
                  }
                  onClick={() => void openIntent(item)}
                >
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <span className="truncate text-sm font-medium">
                      {item.deliveryEnvelope?.recipient ?? "发送身份待持久化"}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {dateTime(item.updatedAt)}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    Opportunity：{item.opportunityId}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge
                      variant={
                        item.queueKind === "RECONCILIATION_REQUIRED"
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {item.queueKind ? queueLabels[item.queueKind] : "已结束"}
                    </Badge>
                    <Badge variant="secondary">
                      {statusLabels[item.status]}
                    </Badge>
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

          <div className="min-w-0">
            {detailState === "ready" && detail ? (
              <div>
                <header className="border-b px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">
                      {statusLabels[detail.status]}
                    </span>
                    {detail.queueKind ? (
                      <Badge
                        variant={
                          detail.queueKind === "RECONCILIATION_REQUIRED"
                            ? "destructive"
                            : "outline"
                        }
                      >
                        {queueLabels[detail.queueKind]}
                      </Badge>
                    ) : null}
                  </div>
                </header>

                <dl className="grid gap-x-6 gap-y-3 px-4 py-4 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">下一步</dt>
                    <dd
                      className={
                        detail.diagnostics.primaryNextAction ===
                        "RECONCILE_BEFORE_RETRY"
                          ? "mt-1 font-medium text-destructive"
                          : "mt-1 font-medium"
                      }
                    >
                      {nextActionLabels[detail.diagnostics.primaryNextAction]}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Gmail 账号</dt>
                    <dd className="mt-1 break-all">
                      {detail.deliveryEnvelope?.gmailAccountEmail ??
                        "尚未持久化"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">实际发件身份</dt>
                    <dd className="mt-1 break-all">
                      {detail.deliveryEnvelope?.fromAddress ?? "尚未持久化"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">收件人</dt>
                    <dd className="mt-1 break-all">
                      {detail.deliveryEnvelope?.recipient ?? "尚未持久化"}
                    </dd>
                  </div>
                </dl>

                <details className="group border-t px-4 py-3 text-xs">
                  <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-muted-foreground hover:text-foreground">
                    <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
                    技术详情
                  </summary>
                  <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">Send Intent</dt>
                      <dd className="mt-1 break-all">{detail.sendIntentId}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">持久化检查点</dt>
                      <dd className="mt-1 break-all">
                        {detail.diagnostics.operationCheckpoint}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Worker / Build</dt>
                      <dd className="mt-1 break-all">
                        {detail.diagnostics.workerMode} /{" "}
                        {detail.diagnostics.buildIdentity}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Provider 线程</dt>
                      <dd className="mt-1 break-all">
                        {detail.attempt?.providerThreadId ?? "尚未确认"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">下一重试时间</dt>
                      <dd className="mt-1">
                        {dateTime(detail.diagnostics.nextRetryAt)}
                      </dd>
                    </div>
                  </dl>
                </details>

                <div className="border-t px-4 py-3 text-xs">
                  <Link
                    className="text-primary hover:underline"
                    to={`/projects/${websiteProjectKey}/backlinks/opportunities?opportunityId=${encodeURIComponent(detail.opportunityId)}`}
                  >
                    查看关联 Opportunity
                  </Link>
                </div>
              </div>
            ) : detailState === "empty" ? (
              <div className="flex min-h-56 flex-col items-center justify-center px-4 text-center">
                <ListChecks className="mb-3 size-6 text-muted-foreground" />
                <div className="text-sm font-medium">选择一条记录查看详情</div>
              </div>
            ) : (
              <QueueStateNotice
                state={detailState === "ready" ? "error" : detailState}
                retry={
                  selectedItem ? () => void openIntent(selectedItem) : undefined
                }
              />
            )}
          </div>
        </div>
      ) : (
        <QueueStateNotice state={listState} retry={() => void refresh()} />
      )}
    </section>
  )
}
