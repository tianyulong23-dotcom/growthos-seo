import * as React from "react"
import {
  Ban,
  CalendarClock,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Eye,
  FileDiff,
  Image,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Send,
  Server,
  ShieldCheck,
} from "lucide-react"

import {
  cancelArticlePublication,
  createArticlePreview,
  createArticlePublication,
  getArticlePublication,
  getArticlePublicationSnapshot,
  getArticleVersion,
  listArticlePublications,
  listPublicationTargets,
  reconcileArticlePublication,
  retryArticlePublication,
  revokeArticlePreview,
  type ArticleDetail,
  type ArticleDocument,
  type ArticlePreview,
  type ArticlePublication,
  type ArticlePublicationSnapshot,
  type CmsPublicationStatus,
  type PublicationTarget,
} from "@/api/articles"
import { resolveApiUrl } from "@/api/client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ArticleTypedDiff } from "@/features/content/article-typed-diff"
import { articleDocumentAssetReferences } from "@/features/content/article-document"
import { scheduleCandidates } from "@/features/content/article-publication-schedule"

const ACTIVE_STATUSES = new Set<CmsPublicationStatus>([
  "queued",
  "scheduled",
  "submitting",
])

const STATUS_LABELS: Record<CmsPublicationStatus, string> = {
  queued: "等待发布",
  scheduled: "已定时",
  submitting: "正在发布",
  published: "发布成功",
  failed: "发布失败",
  uncertain: "远端结果待校准",
  cancelled: "已取消",
}

const MEDIA_STATUS_LABELS: Record<
  ArticlePublication["media"][number]["status"],
  string
> = {
  pending: "等待同步",
  uploading: "正在上传",
  ready: "同步完成",
  failed: "同步失败",
  uncertain: "远端结果待校准",
}

function dateTimeLabel(value: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN")
}

function browserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

function statusBadgeVariant(status: CmsPublicationStatus) {
  if (status === "failed") return "destructive" as const
  if (status === "published") return "secondary" as const
  return "outline" as const
}

function isArticleDocument(value: unknown): value is ArticleDocument {
  if (!value || typeof value !== "object") return false
  const document = value as Partial<ArticleDocument>
  return document.type === "doc" && Array.isArray(document.content)
}

function publicationCapabilityBlockReason(
  target: PublicationTarget | null | undefined,
  operation: "create" | "update",
  hasAssets: boolean
): string | null {
  if (!target || target.status !== "verified")
    return "WordPress 连接未验证或已不可用。"
  const capabilities = target.capabilities
  if (operation === "create" && capabilities.post_create !== true) {
    return "当前 WordPress 账号缺少发布新文章权限，请重新验证连接权限。"
  }
  if (
    operation === "update" &&
    capabilities.post_update_by_remote_id !== true
  ) {
    return "当前 WordPress 账号缺少更新已发布文章的权限，请重新验证连接权限。"
  }
  if (capabilities.post_reconcile !== true) {
    return "当前 WordPress 账号缺少远端文章查询权限，无法安全校准发布结果。"
  }
  if (hasAssets && capabilities.media_upload !== true) {
    return "批准版本包含媒体，但当前 WordPress 账号缺少媒体上传权限。"
  }
  if (hasAssets && capabilities.media_lookup !== true) {
    return "批准版本包含媒体，但当前 WordPress 账号缺少媒体查询权限，无法安全复用或校准媒体。"
  }
  return null
}

function PreviewControls({
  projectId,
  article,
  autosaveId,
  targetId,
}: {
  projectId: string
  article: ArticleDetail
  autosaveId: string | null
  targetId: string | null
}) {
  const [source, setSource] = React.useState<
    "autosave" | "current" | "approved"
  >(autosaveId ? "autosave" : "current")
  const [working, setWorking] = React.useState(false)
  const [error, setError] = React.useState("")
  const [latest, setLatest] = React.useState<ArticlePreview | null>(null)
  const effectiveSource =
    !autosaveId && source === "autosave" ? "current" : source

  async function openPreview() {
    const previewWindow = window.open("", "_blank")
    if (!previewWindow) {
      setError("浏览器阻止了预览窗口，请允许本站打开新窗口。")
      return
    }
    previewWindow.document.title = "正在生成文章预览"
    previewWindow.document.body.textContent = "正在生成不可变文章预览..."
    setWorking(true)
    setError("")
    try {
      const input =
        effectiveSource === "autosave"
          ? {
              source_type: "autosave" as const,
              autosave_id: autosaveId!,
              target_id: targetId,
            }
          : {
              source_type: "version" as const,
              version_number:
                effectiveSource === "approved"
                  ? article.approved_version_number!
                  : article.current_version_number,
              target_id: targetId,
            }
      const preview = await createArticlePreview(projectId, article.id, input)
      setLatest(preview)
      previewWindow.location.href = resolveApiUrl(preview.preview_url)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "生成预览失败"
      setError(message)
      previewWindow.document.body.textContent = `生成预览失败：${message}`
    } finally {
      setWorking(false)
    }
  }

  async function revokePreview() {
    if (!latest) return
    setWorking(true)
    setError("")
    try {
      await revokeArticlePreview(projectId, article.id, latest.id)
      setLatest({ ...latest, revoked_at: new Date().toISOString() })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "撤销预览失败")
    } finally {
      setWorking(false)
    }
  }

  return (
    <section className="space-y-3 border-t pt-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Eye className="size-4" /> 不可变预览
        </h3>
        {latest &&
          !latest.revoked_at &&
          new Date(latest.expires_at) > new Date() && (
            <Button
              variant="ghost"
              size="sm"
              disabled={working}
              onClick={() => void revokePreview()}
            >
              <Ban /> 撤销链接
            </Button>
          )}
      </div>
      <Select
        value={effectiveSource}
        onValueChange={(value) =>
          setSource((value ?? "current") as "autosave" | "current" | "approved")
        }
      >
        <SelectTrigger className="w-full rounded-md" aria-label="预览版本">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="rounded-md" align="start">
          {autosaveId && (
            <SelectItem value="autosave">当前自动保存快照</SelectItem>
          )}
          <SelectItem value="current">
            当前永久版本 {article.current_version_number}
          </SelectItem>
          {article.approved_version_number && (
            <SelectItem value="approved">
              已批准版本 {article.approved_version_number}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
      <Button
        className="w-full"
        variant="outline"
        disabled={working}
        onClick={() => void openPreview()}
      >
        {working ? <LoaderCircle className="animate-spin" /> : <Eye />}
        在新窗口生成预览
      </Button>
      {latest && (
        <p className="text-xs text-muted-foreground">
          {latest.source_type === "autosave"
            ? `自动保存 ${latest.autosave_id}`
            : `永久版本 ${latest.source_version_number}`}{" "}
          · 到期时间 {dateTimeLabel(latest.expires_at)}
          {latest.revoked_at ? " · 已撤销" : ""}
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function MediaProgress({ publication }: { publication: ArticlePublication }) {
  if (publication.media.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        该版本没有需要同步的媒体。
      </p>
    )
  }
  const ready = publication.media.filter(
    (item) => item.status === "ready"
  ).length
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span>媒体同步</span>
        <span className="text-muted-foreground tabular-nums">
          {ready}/{publication.media.length}
        </span>
      </div>
      <Progress value={(ready / publication.media.length) * 100} />
      <div className="divide-y rounded-md border">
        {publication.media.map((item) => (
          <div
            key={`${item.node_id}:${item.item_id ?? ""}:${item.binding_role}`}
            className="flex items-start gap-2 p-2.5 text-xs"
          >
            <Image className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                {item.binding_role} · {item.asset_id}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {MEDIA_STATUS_LABELS[item.status]}
                {item.remote_media_id
                  ? ` · WordPress #${item.remote_media_id}`
                  : ""}
              </p>
              {item.error_code && (
                <p className="mt-1 break-all text-destructive">
                  {item.error_code}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ArticlePublicationPanel({
  projectId,
  article,
  autosaveId,
  dirty,
  parentWorking,
  onRefreshArticle,
}: {
  projectId: string
  article: ArticleDetail
  autosaveId: string | null
  dirty: boolean
  parentWorking: boolean
  onRefreshArticle: () => Promise<unknown>
}) {
  const [targets, setTargets] = React.useState<PublicationTarget[]>([])
  const [targetId, setTargetId] = React.useState("")
  const [publications, setPublications] = React.useState<ArticlePublication[]>(
    []
  )
  const [selectedId, setSelectedId] = React.useState("")
  const [snapshotState, setSnapshotState] = React.useState<{
    publicationId: string
    value: ArticlePublicationSnapshot
  } | null>(null)
  const [approvedVersionHasAssets, setApprovedVersionHasAssets] =
    React.useState<boolean | null>(null)
  const [mode, setMode] = React.useState<"immediate" | "scheduled">("immediate")
  const [timezone, setTimezone] = React.useState(browserTimezone)
  const [scheduleAt, setScheduleAt] = React.useState("")
  const [scheduleChoice, setScheduleChoice] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [working, setWorking] = React.useState("")
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [cancelReason, setCancelReason] = React.useState("计划调整")
  const publishKeyRef = React.useRef<{ signature: string; key: string } | null>(
    null
  )
  const retryKeyRef = React.useRef<Record<string, string>>({})

  const selected =
    publications.find((item) => item.id === selectedId) ??
    publications[0] ??
    null
  const snapshot =
    selected?.status === "published" &&
    snapshotState?.publicationId === selected.id
      ? snapshotState.value
      : null
  const selectedTarget = targets.find((item) => item.id === targetId) ?? null
  const candidates = React.useMemo(() => {
    try {
      return mode === "scheduled" && scheduleAt && timezone
        ? scheduleCandidates(scheduleAt, timezone)
        : []
    } catch {
      return []
    }
  }, [mode, scheduleAt, timezone])

  const load = React.useCallback(
    async (preserveSelection = true) => {
      setLoading(true)
      setError("")
      try {
        const [targetResult, publicationResult, approvedVersion] =
          await Promise.all([
            listPublicationTargets(projectId),
            listArticlePublications(projectId, article.id),
            article.approved_version_number === null
              ? Promise.resolve(null)
              : getArticleVersion(
                  projectId,
                  article.id,
                  article.approved_version_number
                ),
          ])
        setTargets(targetResult.items)
        setTargetId((current) =>
          targetResult.items.some((item) => item.id === current)
            ? current
            : (targetResult.items.find((item) => item.status === "verified")
                ?.id ?? "")
        )
        setPublications(publicationResult.items)
        setApprovedVersionHasAssets(
          isArticleDocument(approvedVersion?.document)
            ? articleDocumentAssetReferences(approvedVersion.document).length >
                0
            : false
        )
        setSelectedId((current) =>
          preserveSelection &&
          publicationResult.items.some((item) => item.id === current)
            ? current
            : (publicationResult.items[0]?.id ?? "")
        )
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "读取发布信息失败")
      } finally {
        setLoading(false)
      }
    },
    [article.approved_version_number, article.id, projectId]
  )

  React.useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load(false)
    })
    return () => {
      active = false
    }
  }, [load])

  React.useEffect(() => {
    if (!selected || !ACTIVE_STATUSES.has(selected.status)) return
    const timer = window.setInterval(() => {
      void getArticlePublication(projectId, selected.id)
        .then((next) => {
          setPublications((items) =>
            items.map((item) => (item.id === next.id ? next : item))
          )
          if (!ACTIVE_STATUSES.has(next.status)) void onRefreshArticle()
        })
        .catch(() => undefined)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [onRefreshArticle, projectId, selected])

  React.useEffect(() => {
    if (selected?.status !== "published") return
    let active = true
    const publicationId = selected.id
    void getArticlePublicationSnapshot(projectId, selected.id)
      .then((value) => {
        if (active) setSnapshotState({ publicationId, value })
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [projectId, selected?.id, selected?.status])

  async function run(name: string, action: () => Promise<void>) {
    setWorking(name)
    setError("")
    setNotice("")
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发布操作失败")
    } finally {
      setWorking("")
    }
  }

  async function submit() {
    const version = article.approved_version_number
    if (!version || !targetId) return
    if (mode === "scheduled" && candidates.length === 0) {
      setError("定时时间在该时区不存在或时区无效，请检查后重试。")
      return
    }
    const schedule =
      mode === "scheduled"
        ? (candidates[scheduleChoice] ?? candidates[0])
        : null
    const signature = JSON.stringify({
      version,
      targetId,
      mode,
      schedule: schedule?.value,
      timezone,
    })
    const prior = publishKeyRef.current
    const key = prior?.signature === signature ? prior.key : crypto.randomUUID()
    publishKeyRef.current = { signature, key }
    await run("publish", async () => {
      const created = await createArticlePublication(
        projectId,
        article.id,
        {
          version_number: version,
          target_id: targetId,
          mode,
          schedule_at: schedule?.value ?? null,
          source_timezone: timezone,
        },
        key
      )
      setPublications((items) => [
        created,
        ...items.filter((item) => item.id !== created.id),
      ])
      setSelectedId(created.id)
      setNotice(
        mode === "scheduled" ? "发布任务已定时。" : "发布任务已进入队列。"
      )
      await onRefreshArticle()
    })
  }

  async function cancel() {
    if (!selected || !cancelReason.trim()) {
      setError("取消发布任务必须填写原因。")
      return
    }
    await run("cancel", async () => {
      const next = await cancelArticlePublication(
        projectId,
        selected.id,
        cancelReason.trim()
      )
      setPublications((items) =>
        items.map((item) => (item.id === next.id ? next : item))
      )
      setNotice("发布任务已取消。")
      await onRefreshArticle()
    })
  }

  async function retry() {
    if (!selected) return
    const key = retryKeyRef.current[selected.id] ?? crypto.randomUUID()
    retryKeyRef.current[selected.id] = key
    await run("retry", async () => {
      const next = await retryArticlePublication(projectId, selected.id, key)
      setPublications((items) => [
        next,
        ...items.filter((item) => item.id !== next.id),
      ])
      setSelectedId(next.id)
      setNotice("失败任务已创建续跑 attempt。")
    })
  }

  async function reconcile() {
    if (!selected) return
    await run("reconcile", async () => {
      const next = await reconcileArticlePublication(projectId, selected.id)
      setPublications((items) =>
        items.map((item) => (item.id === next.id ? next : item))
      )
      setNotice(
        next.status === "published"
          ? "已确认 WordPress 发布成功。"
          : "未找到匹配的远端文章，可从失败状态续跑。"
      )
      await onRefreshArticle()
    })
  }

  const priorPublished = publications.find(
    (item) => item.target_id === targetId && item.status === "published"
  )
  const capabilityBlockReason = publicationCapabilityBlockReason(
    selectedTarget,
    priorPublished ? "update" : "create",
    approvedVersionHasAssets === true
  )
  const publishAllowed =
    article.approved_version_number !== null &&
    approvedVersionHasAssets !== null &&
    (article.publication_blocked_reason === null ||
      article.publication_blocked_reason === "awaiting_review") &&
    capabilityBlockReason === null &&
    !publications.some((item) =>
      ["queued", "scheduled", "submitting", "uncertain"].includes(item.status)
    )

  return (
    <section
      className="space-y-5 border-t pt-5"
      data-testid="article-publication-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Server className="size-4" /> WordPress 发布
        </h3>
        <Button
          variant="ghost"
          size="icon-sm"
          title="刷新发布状态"
          aria-label="刷新发布状态"
          disabled={loading || Boolean(working)}
          onClick={() => void load()}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-medium" htmlFor="publication-target">
          发布目标
        </Label>
        <Select
          value={targetId}
          onValueChange={(value) => setTargetId(value ?? "")}
        >
          <SelectTrigger id="publication-target" className="w-full rounded-md">
            <SelectValue placeholder="选择 WordPress 目标" />
          </SelectTrigger>
          <SelectContent className="rounded-md" align="start">
            {targets.map((target) => (
              <SelectItem key={target.id} value={target.id}>
                {target.site_url} ·{" "}
                {target.status === "verified" ? "已验证" : "不可用"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedTarget ? (
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <ShieldCheck className="size-3.5" />{" "}
              {selectedTarget.status === "verified"
                ? "连接已验证"
                : "连接不可用"}
            </span>
            <span>
              {selectedTarget.capabilities.post_create === true
                ? "支持新建发布"
                : "不支持新建发布"}
            </span>
            <span>
              {selectedTarget.capabilities.post_update_by_remote_id === true
                ? "支持按远端 ID 更新"
                : "不支持更新"}
            </span>
            <span>
              {selectedTarget.capabilities.post_reconcile === true
                ? "支持远端校准"
                : "不支持远端校准"}
            </span>
            <span>
              {selectedTarget.capabilities.media_upload === true &&
              selectedTarget.capabilities.media_lookup === true
                ? "支持媒体同步"
                : "不支持完整媒体同步"}
            </span>
          </div>
        ) : !loading ? (
          <p className="text-xs text-destructive">
            没有可用的 WordPress 发布目标。
          </p>
        ) : null}
      </div>

      <PreviewControls
        projectId={projectId}
        article={article}
        autosaveId={autosaveId}
        targetId={targetId || null}
      />

      <section className="space-y-3 border-t pt-5">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-muted-foreground">批准版本</p>
            <p className="mt-1 font-medium">
              {article.approved_version_number
                ? `版本 ${article.approved_version_number}`
                : "尚未批准"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">本次操作</p>
            <p className="mt-1 font-medium">
              {priorPublished
                ? `更新 WordPress #${priorPublished.remote_post_id}`
                : "首次创建文章"}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 rounded-md border p-1">
          <Button
            type="button"
            size="sm"
            variant={mode === "immediate" ? "secondary" : "ghost"}
            onClick={() => setMode("immediate")}
          >
            <Send /> 立即发布
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "scheduled" ? "secondary" : "ghost"}
            onClick={() => setMode("scheduled")}
          >
            <CalendarClock /> 定时发布
          </Button>
        </div>
        {mode === "scheduled" && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="space-y-1.5">
              <Label
                htmlFor="publication-schedule"
                className="text-xs font-medium"
              >
                当地日期和时间
              </Label>
              <Input
                id="publication-schedule"
                type="datetime-local"
                value={scheduleAt}
                onChange={(event) => {
                  setScheduleAt(event.target.value)
                  setScheduleChoice(0)
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="publication-timezone"
                className="text-xs font-medium"
              >
                IANA 时区
              </Label>
              <Input
                id="publication-timezone"
                value={timezone}
                onChange={(event) => {
                  setTimezone(event.target.value)
                  setScheduleChoice(0)
                }}
                placeholder="Asia/Shanghai"
              />
            </div>
            {candidates.length > 1 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium">
                  夏令时重复时段，请选择 UTC 偏移
                </p>
                <div className="flex gap-2">
                  {candidates.map((candidate, index) => (
                    <Button
                      key={candidate.value}
                      size="sm"
                      variant={
                        scheduleChoice === index ? "secondary" : "outline"
                      }
                      onClick={() => setScheduleChoice(index)}
                    >
                      UTC{candidate.offset}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {scheduleAt && candidates.length === 0 && (
              <p className="text-xs text-destructive">
                该当地时间在此时区不存在，或时区名称无效。
              </p>
            )}
          </div>
        )}
        <Button
          className="w-full"
          disabled={
            !publishAllowed ||
            dirty ||
            parentWorking ||
            Boolean(working) ||
            (mode === "scheduled" && (!scheduleAt || candidates.length === 0))
          }
          onClick={() => void submit()}
        >
          {working === "publish" ? (
            <LoaderCircle className="animate-spin" />
          ) : mode === "scheduled" ? (
            <Clock3 />
          ) : (
            <Send />
          )}
          {mode === "scheduled"
            ? `定时发布版本 ${article.approved_version_number ?? "-"}`
            : `发布版本 ${article.approved_version_number ?? "-"}`}
        </Button>
        {capabilityBlockReason && (
          <p className="text-xs text-destructive">{capabilityBlockReason}</p>
        )}
        {dirty && (
          <p className="text-xs text-muted-foreground">
            当前修改不影响批准快照；请先保存，以免发布后误判线上差异。
          </p>
        )}
        {notice && (
          <p className="text-xs text-emerald-700 dark:text-emerald-300">
            {notice}
          </p>
        )}
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="space-y-3 border-t pt-5">
        <h4 className="text-xs font-medium">发布 attempts</h4>
        {publications.length === 0 ? (
          <p className="rounded-md border px-3 py-5 text-center text-xs text-muted-foreground">
            暂无发布记录
          </p>
        ) : (
          <Select
            value={selected?.id ?? ""}
            onValueChange={(value) => setSelectedId(value ?? "")}
          >
            <SelectTrigger
              className="w-full rounded-md"
              aria-label="发布 attempt"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-md" align="start">
              {publications.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  版本 {item.version_number} · {STATUS_LABELS[item.status]} ·
                  attempt {item.attempt_count}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {selected && (
          <div className="space-y-4 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge variant={statusBadgeVariant(selected.status)}>
                {STATUS_LABELS[selected.status]}
              </Badge>
              <span className="text-xs text-muted-foreground">
                attempt {selected.attempt_count}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-muted-foreground">操作</p>
                <p className="mt-1 font-medium">
                  {selected.operation === "update"
                    ? "按远端 ID 更新"
                    : "首次创建"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">版本</p>
                <p className="mt-1 font-medium">{selected.version_number}</p>
              </div>
              <div>
                <p className="text-muted-foreground">提交时间</p>
                <p className="mt-1 font-medium">
                  {dateTimeLabel(selected.created_at)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">计划时间</p>
                <p className="mt-1 font-medium">
                  {dateTimeLabel(selected.schedule_at_utc)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">远端 ID</p>
                <p className="mt-1 font-medium">
                  {selected.remote_post_id ?? "-"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">父 attempt</p>
                <p
                  className="mt-1 truncate font-medium"
                  title={selected.parent_publication_id ?? undefined}
                >
                  {selected.parent_publication_id ?? "-"}
                </p>
              </div>
            </div>
            {selected.remote_url && (
              <a
                href={selected.remote_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <ExternalLink className="size-3.5" /> 打开 WordPress 文章
              </a>
            )}
            {selected.last_error_code && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs">
                <p className="font-medium text-destructive">
                  {selected.last_error_code}
                </p>
                {selected.last_error_detail && (
                  <p className="mt-1 break-words text-muted-foreground">
                    {selected.last_error_detail}
                  </p>
                )}
              </div>
            )}
            {selected.status === "uncertain" && (
              <p className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                WordPress 可能已完成副作用。只能校准远端状态，禁止直接重发。
              </p>
            )}
            <MediaProgress publication={selected} />
            {selected.allowed_actions.includes("cancel") && (
              <div className="space-y-2">
                <Input
                  value={cancelReason}
                  onChange={(event) => setCancelReason(event.target.value)}
                  maxLength={500}
                  aria-label="取消发布原因"
                />
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={Boolean(working)}
                  onClick={() => void cancel()}
                >
                  <Ban /> 取消发布任务
                </Button>
              </div>
            )}
            {selected.allowed_actions.includes("retry") && (
              <Button
                className="w-full"
                variant="outline"
                disabled={Boolean(working)}
                onClick={() => void retry()}
              >
                {working === "retry" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RotateCcw />
                )}{" "}
                从失败 checkpoint 续跑
              </Button>
            )}
            {selected.allowed_actions.includes("reconcile") && (
              <Button
                className="w-full"
                variant="outline"
                disabled={Boolean(working)}
                onClick={() => void reconcile()}
              >
                {working === "reconcile" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <ShieldCheck />
                )}{" "}
                校准 WordPress 远端状态
              </Button>
            )}
          </div>
        )}
      </section>

      {selected?.status === "published" && (
        <section className="space-y-3 border-t pt-5">
          <h4 className="flex items-center gap-2 text-sm font-medium">
            <FileDiff className="size-4" /> 线上快照与当前草稿
          </h4>
          {!snapshot ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />{" "}
              正在读取不可变线上快照
            </div>
          ) : snapshot.current_draft_diff ? (
            <>
              <p className="text-xs text-muted-foreground">
                线上版本 {snapshot.published_version_number}，当前永久草稿版本{" "}
                {snapshot.current_draft_version_number}
              </p>
              <ArticleTypedDiff diff={snapshot.current_draft_diff} />
            </>
          ) : (
            <p className="flex items-center gap-2 rounded-md border p-3 text-xs">
              <CheckCircle2 className="size-4 text-emerald-600" />{" "}
              当前永久草稿与线上版本一致。
            </p>
          )}
        </section>
      )}
    </section>
  )
}
