import * as React from "react"
import {
  Check,
  ClipboardCheck,
  Eye,
  Inbox,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Send,
  UserCheck,
  X,
} from "lucide-react"

import {
  addArticleReviewComment,
  cancelArticleReviewTask,
  claimArticleReviewTask,
  decideArticleReviewTask,
  getArticleReviewSnapshot,
  listArticleReviewInbox,
  listArticleReviewTasks,
  submitArticleReview,
  type ArticleDetail,
  type ArticleDocument,
  type ArticleDocumentCapabilities,
  type ArticleReviewSnapshot,
  type ArticleReviewTask,
  type ArticleReviewTaskStatus,
} from "@/api/articles"
import { ApiError } from "@/api/client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ArticleEditor } from "@/features/content/article-editor"
import { ArticlePublicationPanel } from "@/features/content/article-publication-panel"
import { ArticleTypedDiff } from "@/features/content/article-typed-diff"

const STATUS_LABELS: Record<ArticleReviewTaskStatus, string> = {
  pending: "待领取",
  in_review: "审核中",
  approved: "已批准",
  needs_changes: "已退回",
  cancelled: "已取消",
}

const ACTIVE_REVIEW_STATUSES = new Set<ArticleReviewTaskStatus>([
  "pending",
  "in_review",
])

function dateTimeLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN")
}

function taskLabel(task: ArticleReviewTask) {
  return `版本 ${task.version_number} · ${STATUS_LABELS[task.status]}`
}

function validDocument(
  value: ArticleReviewSnapshot["version"]["document"]
): value is ArticleDocument {
  return (
    value.type === "doc" &&
    typeof value.schema_version === "number" &&
    Array.isArray(value.content)
  )
}

function TaskList({
  items,
  empty,
  onOpen,
  onClaim,
  onCancel,
  working,
}: {
  items: ArticleReviewTask[]
  empty: string
  onOpen: (task: ArticleReviewTask) => void
  onClaim: (task: ArticleReviewTask) => void
  onCancel?: (task: ArticleReviewTask) => void
  working: string
}) {
  if (items.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-muted-foreground">{empty}</p>
    )
  }
  return (
    <div className="divide-y rounded-md border">
      {items.map((task) => (
        <article key={task.id} className="space-y-2 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{taskLabel(task)}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                提交人 {task.submitted_by} · {dateTimeLabel(task.submitted_at)}
              </p>
              {(task.assigned_to || task.assigned_group) && (
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  指定：{task.assigned_to || task.assigned_group}
                </p>
              )}
            </div>
            <Badge variant="outline">{STATUS_LABELS[task.status]}</Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(working)}
              onClick={() => onOpen(task)}
            >
              <Eye /> 快照
            </Button>
            {task.status === "pending" && (
              <Button
                variant="outline"
                size="sm"
                disabled={Boolean(working)}
                onClick={() => onClaim(task)}
              >
                {working === `claim:${task.id}` ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <UserCheck />
                )}
                领取
              </Button>
            )}
            {onCancel && ACTIVE_REVIEW_STATUSES.has(task.status) && (
              <Button
                variant="ghost"
                size="sm"
                disabled={Boolean(working)}
                onClick={() => onCancel(task)}
              >
                <X /> 取消
              </Button>
            )}
          </div>
        </article>
      ))}
    </div>
  )
}

export function ArticleReviewWorkflow({
  projectId,
  article,
  capabilities,
  dirty,
  parentWorking,
  autosaveId,
  onRefreshArticle,
}: {
  projectId: string
  article: ArticleDetail
  capabilities: ArticleDocumentCapabilities | null
  dirty: boolean
  parentWorking: boolean
  autosaveId: string | null
  onRefreshArticle: () => Promise<unknown>
}) {
  const [tasks, setTasks] = React.useState<ArticleReviewTask[]>([])
  const [inbox, setInbox] = React.useState<ArticleReviewTask[]>([])
  const [inboxAvailable, setInboxAvailable] = React.useState(true)
  const [loading, setLoading] = React.useState(true)
  const [working, setWorking] = React.useState("")
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [assignedTo, setAssignedTo] = React.useState("")
  const [assignedGroup, setAssignedGroup] = React.useState("")
  const [snapshot, setSnapshot] = React.useState<ArticleReviewSnapshot | null>(
    null
  )
  const [snapshotOpen, setSnapshotOpen] = React.useState(false)
  const [snapshotLoading, setSnapshotLoading] = React.useState(false)
  const [comment, setComment] = React.useState("")
  const [decisionComment, setDecisionComment] = React.useState("")
  const [cancelTask, setCancelTask] = React.useState<ArticleReviewTask | null>(
    null
  )
  const [cancelReason, setCancelReason] = React.useState("")
  const submitKeyRef = React.useRef<{ signature: string; key: string } | null>(
    null
  )
  const decisionKeyRef = React.useRef<Record<string, string>>({})

  const loadTasks = React.useCallback(async () => {
    setLoading(true)
    setError("")
    const [articleResult, inboxResult] = await Promise.allSettled([
      listArticleReviewTasks(projectId, article.id),
      listArticleReviewInbox(projectId),
    ])
    if (articleResult.status === "fulfilled") {
      setTasks(articleResult.value.items)
    } else {
      setError(
        articleResult.reason instanceof Error
          ? articleResult.reason.message
          : "读取审核任务失败"
      )
    }
    if (inboxResult.status === "fulfilled") {
      setInbox(inboxResult.value.items)
      setInboxAvailable(true)
    } else if (
      inboxResult.reason instanceof ApiError &&
      [401, 403].includes(inboxResult.reason.status)
    ) {
      setInbox([])
      setInboxAvailable(false)
    } else {
      setInbox([])
      setInboxAvailable(true)
    }
    setLoading(false)
  }, [article.id, projectId])

  React.useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void loadTasks()
    })
    return () => {
      active = false
    }
  }, [loadTasks])

  async function run(name: string, action: () => Promise<void>) {
    if (working || parentWorking) return
    setWorking(name)
    setError("")
    setNotice("")
    try {
      await action()
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "操作失败"
      )
    } finally {
      setWorking("")
    }
  }

  async function submit() {
    if (dirty) {
      setError("请先保存当前修改，再提交审核。")
      return
    }
    await run("submit", async () => {
      const signature = JSON.stringify([
        article.current_version_number,
        assignedTo.trim(),
        assignedGroup.trim(),
      ])
      const prior = submitKeyRef.current
      const key =
        prior?.signature === signature ? prior.key : crypto.randomUUID()
      submitKeyRef.current = { signature, key }
      await submitArticleReview(
        projectId,
        article.id,
        {
          version_number: article.current_version_number,
          assigned_to: assignedTo.trim() || null,
          assigned_group: assignedGroup.trim() || null,
        },
        key
      )
      submitKeyRef.current = null
      setAssignedTo("")
      setAssignedGroup("")
      setNotice(`版本 ${article.current_version_number} 已提交审核。`)
      await Promise.all([loadTasks(), onRefreshArticle()])
    })
  }

  async function claim(task: ArticleReviewTask) {
    await run(`claim:${task.id}`, async () => {
      await claimArticleReviewTask(projectId, task.id)
      setNotice(`已领取版本 ${task.version_number} 的审核任务。`)
      await loadTasks()
      if (snapshot?.task.id === task.id) await openSnapshot(task)
    })
  }

  async function openSnapshot(task: ArticleReviewTask) {
    setSnapshotOpen(true)
    setSnapshotLoading(true)
    setError("")
    setComment("")
    setDecisionComment("")
    try {
      setSnapshot(await getArticleReviewSnapshot(projectId, task.id))
    } catch (requestError) {
      setSnapshotOpen(false)
      setError(
        requestError instanceof Error
          ? requestError.message
          : "读取审核快照失败"
      )
    } finally {
      setSnapshotLoading(false)
    }
  }

  async function addComment() {
    if (!snapshot || !comment.trim()) return
    await run(`comment:${snapshot.task.id}`, async () => {
      await addArticleReviewComment(projectId, snapshot.task.id, {
        body: comment.trim(),
      })
      setComment("")
      setSnapshot(await getArticleReviewSnapshot(projectId, snapshot.task.id))
      await loadTasks()
    })
  }

  async function decide(decision: "approved" | "needs_changes") {
    if (!snapshot) return
    if (decision === "needs_changes" && !decisionComment.trim()) {
      setError("退回审核必须填写具体修改意见。")
      return
    }
    await run(`decision:${decision}`, async () => {
      const signature = `${snapshot.task.id}:${decision}:${decisionComment.trim()}`
      const key = decisionKeyRef.current[signature] ?? crypto.randomUUID()
      decisionKeyRef.current[signature] = key
      await decideArticleReviewTask(
        projectId,
        snapshot.task.id,
        { decision, comment: decisionComment.trim() || null },
        key
      )
      delete decisionKeyRef.current[signature]
      setNotice(decision === "approved" ? "审核已批准。" : "审核已退回修改。")
      setDecisionComment("")
      setSnapshot(await getArticleReviewSnapshot(projectId, snapshot.task.id))
      await Promise.all([loadTasks(), onRefreshArticle()])
    })
  }

  async function cancel() {
    if (!cancelTask || !cancelReason.trim()) {
      setError("取消审核任务必须填写原因。")
      return
    }
    await run(`cancel:${cancelTask?.id}`, async () => {
      await cancelArticleReviewTask(
        projectId,
        cancelTask!.id,
        cancelReason.trim()
      )
      setCancelTask(null)
      setCancelReason("")
      setNotice("审核任务已取消。")
      await Promise.all([loadTasks(), onRefreshArticle()])
    })
  }

  const approvedDiffers =
    article.approved_version_number !== null &&
    article.approved_version_number !== article.current_version_number
  return (
    <section className="space-y-5 border-b bg-background px-5 py-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardCheck className="size-4" /> 审核与发布
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新审核任务"
          title="刷新审核任务"
          disabled={loading || Boolean(working)}
          onClick={() => void loadTasks()}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <p className="text-muted-foreground">当前草稿</p>
          <p className="mt-1 font-medium">
            版本 {article.current_version_number}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">已批准版本</p>
          <p className="mt-1 font-medium">
            {article.approved_version_number
              ? `版本 ${article.approved_version_number}`
              : "尚未批准"}
          </p>
        </div>
      </div>

      {approvedDiffers && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          当前草稿版本 {article.current_version_number} 与批准版本{" "}
          {article.approved_version_number}{" "}
          不同。发布将严格使用批准版本，不会发布当前未批准草稿。
        </p>
      )}
      {notice && (
        <p className="text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <ArticlePublicationPanel
        projectId={projectId}
        article={article}
        autosaveId={autosaveId}
        dirty={dirty}
        parentWorking={parentWorking || Boolean(working)}
        onRefreshArticle={onRefreshArticle}
      />

      <section className="space-y-3">
        <h3 className="text-xs font-medium">提交当前永久版本</h3>
        <Input
          value={assignedTo}
          onChange={(event) => setAssignedTo(event.target.value)}
          maxLength={200}
          placeholder="指定审核人（可选）"
          aria-label="指定审核人"
        />
        <Input
          value={assignedGroup}
          onChange={(event) => setAssignedGroup(event.target.value)}
          maxLength={200}
          placeholder="指定审核组（可选）"
          aria-label="指定审核组"
        />
        <Button
          className="w-full"
          size="sm"
          disabled={dirty || Boolean(working) || parentWorking}
          onClick={() => void submit()}
        >
          {working === "submit" ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Send />
          )}
          提交版本 {article.current_version_number} 审核
        </Button>
        {dirty && (
          <p className="text-xs text-muted-foreground">
            保存当前修改后才能提交审核。
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium">本文章审核历史</h3>
        <TaskList
          items={tasks}
          empty={loading ? "正在读取" : "暂无审核任务"}
          onOpen={(task) => void openSnapshot(task)}
          onClaim={(task) => void claim(task)}
          onCancel={setCancelTask}
          working={working}
        />
      </section>

      <section className="space-y-2">
        <h3 className="flex items-center gap-2 text-xs font-medium">
          <Inbox className="size-3.5" /> 项目审核收件箱
        </h3>
        {inboxAvailable ? (
          <TaskList
            items={inbox}
            empty={loading ? "正在读取" : "收件箱暂无待办"}
            onOpen={(task) => void openSnapshot(task)}
            onClaim={(task) => void claim(task)}
            working={working}
          />
        ) : (
          <p className="rounded-md border px-3 py-3 text-xs text-muted-foreground">
            当前账号没有审核收件箱权限。
          </p>
        )}
      </section>

      <Dialog open={snapshotOpen} onOpenChange={setSnapshotOpen}>
        <DialogContent className="max-h-[94vh] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-md p-0 sm:max-w-6xl">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>不可变审核快照</DialogTitle>
            <DialogDescription>
              {snapshot
                ? `任务 ${snapshot.task.id} · 版本 ${snapshot.task.version_number} · ${STATUS_LABELS[snapshot.task.status]}`
                : "正在读取审核版本"}
            </DialogDescription>
          </DialogHeader>
          {snapshotLoading || !snapshot ? (
            <div className="flex min-h-72 items-center justify-center">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {snapshot.current_draft_version_number !==
                snapshot.task.version_number && (
                <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                  正在审核版本 {snapshot.task.version_number}
                  ；当前草稿已经是版本 {snapshot.current_draft_version_number}
                  。审核操作不会修改当前草稿。
                </p>
              )}
              <div className="grid gap-6 lg:grid-cols-2">
                <section className="min-w-0 space-y-3">
                  <h3 className="text-sm font-medium">版本快照</h3>
                  {validDocument(snapshot.version.document) && capabilities ? (
                    <ArticleEditor
                      projectId={projectId}
                      articleId={snapshot.task.article_id}
                      document={snapshot.version.document}
                      capabilities={{ ...capabilities, writable: false }}
                      readOnly
                      onChange={() => undefined}
                      className="rounded-md border shadow-none"
                    />
                  ) : (
                    <p className="rounded-md border px-4 py-8 text-center text-sm text-muted-foreground">
                      该阶段版本没有可渲染的完整正文快照。
                    </p>
                  )}
                </section>
                <section className="min-w-0 space-y-3">
                  <h3 className="text-sm font-medium">
                    {snapshot.baseline_version_number
                      ? `相对版本 ${snapshot.baseline_version_number} 的结构化差异`
                      : "结构化差异"}
                  </h3>
                  {snapshot.diff ? (
                    <ArticleTypedDiff diff={snapshot.diff} />
                  ) : (
                    <p className="rounded-md border px-4 py-8 text-center text-sm text-muted-foreground">
                      首次审核没有更早的批准基线。
                    </p>
                  )}
                </section>
              </div>

              <section className="mt-6 space-y-3 border-t pt-5">
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  <MessageSquare className="size-4" /> 审核评论
                </h3>
                {snapshot.task.comments.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无评论</p>
                ) : (
                  <div className="divide-y rounded-md border">
                    {snapshot.task.comments.map((item) => (
                      <article key={item.id} className="p-3 text-sm">
                        <p className="whitespace-pre-wrap">{item.body}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item.author_id} · {dateTimeLabel(item.created_at)}
                        </p>
                      </article>
                    ))}
                  </div>
                )}
                {ACTIVE_REVIEW_STATUSES.has(snapshot.task.status) && (
                  <div className="flex gap-2">
                    <Textarea
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      maxLength={2000}
                      rows={2}
                      placeholder="添加审核评论"
                      aria-label="审核评论"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      title="添加评论"
                      aria-label="添加评论"
                      disabled={!comment.trim() || Boolean(working)}
                      onClick={() => void addComment()}
                    >
                      <Send />
                    </Button>
                  </div>
                )}
              </section>

              {snapshot.task.status === "in_review" && (
                <section className="mt-6 space-y-3 border-t pt-5">
                  <h3 className="text-sm font-medium">审核决定</h3>
                  <Textarea
                    value={decisionComment}
                    onChange={(event) => setDecisionComment(event.target.value)}
                    maxLength={2000}
                    rows={3}
                    placeholder="退回时必须填写具体修改意见；批准时可选"
                    aria-label="审核决定意见"
                  />
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Button
                      variant="outline"
                      disabled={Boolean(working)}
                      onClick={() => void decide("needs_changes")}
                    >
                      <X /> 退回修改
                    </Button>
                    <Button
                      disabled={Boolean(working)}
                      onClick={() => void decide("approved")}
                    >
                      <Check /> 审核批准
                    </Button>
                  </div>
                </section>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(cancelTask)}
        onOpenChange={(open) => !open && setCancelTask(null)}
      >
        <DialogContent className="rounded-md sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>取消审核任务</DialogTitle>
            <DialogDescription>
              取消后该不可变版本的审核任务停止流转，操作原因会进入审计历史。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            maxLength={500}
            rows={3}
            placeholder="填写取消原因"
            aria-label="取消审核原因"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTask(null)}>
              返回
            </Button>
            <Button disabled={Boolean(working)} onClick={() => void cancel()}>
              <X /> 确认取消任务
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
