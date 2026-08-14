import * as React from "react"
import {
  AlertTriangle,
  ArrowLeft,
  Clock3,
  ExternalLink,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Save,
  Send,
  SlidersHorizontal,
  X,
} from "lucide-react"

import { ApiError } from "@/api/client"
import {
  cancelArticle,
  deleteArticleAutosave,
  getArticle,
  getArticleDocumentCapabilities,
  getLatestArticleAutosave,
  regenerateArticle,
  restoreArticleVersion,
  retryArticle,
  saveArticleDocument,
  type ArticleDetail,
  type ArticleDocumentCapabilities,
  type ArticleDocument,
  type ArticleIndexing,
  type ArticleRun,
  type ArticleSeoFieldKey,
  type ArticleSeoFieldState,
  type ArticleSource,
  type ArticleSummary,
  type ArticleVersionSummary,
} from "@/api/articles"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  ArticleEditor,
  type ArticleEditorHandle,
} from "@/features/content/article-editor"
import { ArticleGovernancePanel } from "@/features/content/article-governance-panel"
import {
  articleDocumentToEditorJson,
  articleDocumentText,
  articleDocumentAssetReferences,
  articleMetadata,
  articleSnapshotHash,
  canonicalizeArticleDocument,
  documentCompatibility,
  editorJsonToArticleDocument,
} from "@/features/content/article-document"
import {
  discardLocalArticleBackup,
  loadLocalArticleBackups,
  type LocalArticleBackup,
} from "@/features/content/article-recovery"
import { articleSaveStatusLabel } from "@/features/content/article-save-state"
import { useArticleReliableSave } from "@/features/content/use-article-reliable-save"
import { useArticleEditLock } from "@/features/content/use-article-edit-lock"
import { ArticleEditLockStatusBar } from "@/features/content/article-edit-lock-status"
import { ArticleReviewWorkflow } from "@/features/content/article-review-workflow"
import { ArticleVersionHistory } from "@/features/content/article-version-history"
import {
  articlePublicationLabel,
  articleStageLabel,
  articleStatusLabel,
  cmsPublicationLabel,
  publicationBlockedReasonLabel,
} from "@/features/content/article-labels"
import { useArticleRunPolling } from "@/features/content/use-article-run-polling"

const ACTIVE_STATUSES = new Set(["queued", "running"])
const LOCK_LOSS_PROTECTION_MESSAGE =
  "编辑锁已失效，当前修改已保护到本地，编辑器已转为只读。"
const COMPLETED_STATUSES = new Set(["completed", "completed_with_warnings"])
type GovernanceTab =
  "seo" | "links" | "versions" | "assets" | "review" | "sources"

function elapsedLabel(startedAt: string | null, createdAt: string) {
  const started = new Date(startedAt ?? createdAt).getTime()
  if (Number.isNaN(started)) return "0:00"
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

function validDocument(document: ArticleDocument) {
  return document?.type === "doc" && Array.isArray(document.content)
}

function SourceList({
  title,
  items,
}: {
  title: string
  items: ArticleSource[]
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Link2 className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无记录</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={`${item.source_type}:${item.url}`}>
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="group flex min-w-0 items-start gap-2 text-sm hover:text-primary"
              >
                <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate">
                    {item.title || item.url}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.domain || item.url}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const assetRoleLabel = {
  image: "图片",
  gallery_item: "图库图片",
  file: "文件",
  audio: "音频",
  video: "视频",
  poster: "视频封面",
  thumbnail: "卡片缩略图",
} as const

function ArticleAssetLibrary({ document }: { document: ArticleDocument }) {
  const references = articleDocumentAssetReferences(document)
  return (
    <section
      className="border-b bg-background px-5 py-5"
      aria-label="文章资产库"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">资产库</h2>
        <Badge variant="secondary">只读 · {references.length}</Badge>
      </div>
      {references.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          当前文章没有引用媒体资产。
        </p>
      ) : (
        <ul className="mt-3 divide-y rounded-md border">
          {references.map((reference, index) => (
            <li
              key={`${reference.nodeId}:${reference.role}:${reference.itemId ?? index}`}
              className="px-3 py-2.5"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">
                  {assetRoleLabel[reference.role]}
                </span>
                <span className="text-xs text-muted-foreground">已引用</span>
              </div>
              <p
                className="mt-1 truncate font-mono text-xs text-muted-foreground"
                title={reference.assetId}
              >
                {reference.assetId}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        这里展示正文已经绑定的资产；上传、复用和替换请在正文编辑器的媒体入口中操作。
      </p>
    </section>
  )
}

function mergeSummary(
  article: ArticleDetail,
  summary: ArticleSummary
): ArticleDetail {
  return { ...article, ...summary }
}

export function ArticleWorkspace({
  projectId,
  articleId,
  onBack,
  onProtectionChange,
}: {
  projectId: string
  articleId: string
  onBack: () => void
  onProtectionChange?: (protectedChange: {
    dirty: boolean
    flush: () => Promise<boolean>
    protectLocally: () => boolean
  }) => void
}) {
  const [article, setArticle] = React.useState<ArticleDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [notice, setNotice] = React.useState("")
  const [working, setWorking] = React.useState<string | null>(null)
  const [document, setDocument] = React.useState<ArticleDocument | null>(null)
  const [capabilities, setCapabilities] =
    React.useState<ArticleDocumentCapabilities | null>(null)
  const [baselineHash, setBaselineHash] = React.useState("")
  const [recovery, setRecovery] = React.useState<
    | { kind: "local"; backup: LocalArticleBackup }
    | {
        kind: "server"
        backup: Awaited<ReturnType<typeof getLatestArticleAutosave>>
      }
    | null
  >(null)
  const [recoveryOpen, setRecoveryOpen] = React.useState(false)
  const [governanceTab, setGovernanceTab] = React.useState<GovernanceTab>("seo")
  const [versionsRefreshToken, refreshVersions] = React.useReducer(
    (value) => value + 1,
    0
  )
  const [, tick] = React.useReducer((value) => value + 1, 0)
  const selectionKey = `${projectId}:${articleId}`
  const selectionRef = React.useRef(selectionKey)
  const followupKeyRef = React.useRef<{ action: string; key: string } | null>(
    null
  )
  const editorRef = React.useRef<ArticleEditorHandle>(null)
  const lockLossProtectionRef = React.useRef<() => void>(() => undefined)
  const externalDocumentSyncRef = React.useRef(false)

  React.useLayoutEffect(() => {
    selectionRef.current = selectionKey
    return () => {
      selectionRef.current = ""
    }
  }, [selectionKey])

  const loadArticle = React.useCallback(async () => {
    const requested = `${projectId}:${articleId}`
    const [next, nextCapabilities] = await Promise.all([
      getArticle(projectId, articleId),
      getArticleDocumentCapabilities(projectId, articleId),
    ])
    if (selectionRef.current !== requested) return
    const metadata = articleMetadata(next)
    const durableHash =
      next.current_content_hash ||
      (await articleSnapshotHash(next.document, metadata))
    const serverBackup = await getLatestArticleAutosave(projectId, articleId)
    const localBackup = loadLocalArticleBackups({
      projectId,
      articleId,
      recoveryScope: nextCapabilities.recovery_scope,
    })[0]
    const candidates = [
      localBackup && localBackup.contentHash !== durableHash
        ? {
            kind: "local" as const,
            backup: localBackup,
            createdAt: localBackup.createdAt,
          }
        : null,
      serverBackup && serverBackup.content_hash !== durableHash
        ? {
            kind: "server" as const,
            backup: serverBackup,
            createdAt: serverBackup.created_at,
          }
        : null,
    ].filter((item): item is NonNullable<typeof item> => Boolean(item))
    candidates.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    )
    if (selectionRef.current !== requested) return
    setArticle(next)
    externalDocumentSyncRef.current = false
    setDocument(validDocument(next.document) ? next.document : null)
    setCapabilities(nextCapabilities)
    setBaselineHash(durableHash)
    setRecovery(candidates[0] ?? null)
    setRecoveryOpen(false)
    setError("")
    return next
  }, [articleId, projectId])

  React.useEffect(() => {
    let active = true
    async function loadSelection() {
      await Promise.resolve()
      if (!active) return
      setLoading(true)
      setArticle(null)
      setDocument(null)
      setCapabilities(null)
      setBaselineHash("")
      setRecovery(null)
      setError("")
      setNotice("")
      try {
        await loadArticle()
      } catch (requestError) {
        if (active) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "读取文章失败"
          )
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadSelection()
    return () => {
      active = false
    }
  }, [loadArticle])

  const compatibility = document ? documentCompatibility(document) : null
  const metadata = React.useMemo(
    () => (article ? articleMetadata(article) : null),
    [article]
  )
  const documentWritable = Boolean(
    capabilities?.writable &&
    compatibility?.writable &&
    document &&
    document.schema_version <= capabilities.schema_version
  )
  const editLock = useArticleEditLock({
    projectId,
    articleId,
    enabled: Boolean(article && document && documentWritable),
    onLost: () => lockLossProtectionRef.current(),
  })
  const writable = documentWritable && editLock.status === "held" && !working
  const reliableSave = useArticleReliableSave({
    projectId,
    articleId,
    recoveryScope: capabilities?.recovery_scope ?? null,
    document,
    metadata,
    baselineHash,
    baseVersionNumber: article?.current_version_number ?? 0,
    baseReviewVersion: article?.review_version ?? 1,
    lockCredential: editLock.credential,
    enabled: Boolean(article && document && writable),
    onLockLost: () => editLock.markLost(),
  })
  const protectLocally = reliableSave.protectLocally
  const invalidateSaveRequests = reliableSave.invalidateRequests
  React.useEffect(() => {
    lockLossProtectionRef.current = () => {
      protectLocally()
      invalidateSaveRequests()
    }
    return () => {
      lockLossProtectionRef.current = () => undefined
    }
  }, [invalidateSaveRequests, protectLocally])
  const dirty = documentWritable && reliableSave.state.dirty
  const acquireEditLock = editLock.acquire

  const handleAcquireEditLock = React.useCallback(async () => {
    const acquired = await acquireEditLock()
    if (acquired) {
      setError((current) =>
        current === LOCK_LOSS_PROTECTION_MESSAGE ? "" : current
      )
    }
    return acquired
  }, [acquireEditLock])

  const handleMetadataChange = React.useCallback(
    (
      field: ArticleSeoFieldKey,
      value: string | string[] | ArticleIndexing,
      state: ArticleSeoFieldState = "modified"
    ) => {
      setArticle((current) => {
        if (!current) return current
        return {
          ...current,
          [field]: value,
          field_states: {
            ...current.field_states,
            [field]: state,
          },
        }
      })
      setNotice("")
    },
    []
  )

  React.useEffect(() => {
    onProtectionChange?.({
      dirty,
      flush: reliableSave.flushAutosave,
      protectLocally,
    })
  }, [dirty, onProtectionChange, reliableSave.flushAutosave, protectLocally])

  React.useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      protectLocally()
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [dirty, protectLocally])

  const handleRunChange = React.useCallback((run: ArticleRun) => {
    setArticle((current) =>
      current
        ? {
            ...current,
            status: run.status,
            warning_count: run.warnings.length,
            run,
          }
        : current
    )
  }, [])

  useArticleRunPolling({
    projectId,
    articleId,
    run: article?.run ?? null,
    onRunChange: handleRunChange,
    onError: setError,
    onTerminal: loadArticle,
  })

  const active = Boolean(article && ACTIVE_STATUSES.has(article.status))
  React.useEffect(() => {
    if (!active) return
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [active])

  async function runAction(name: string, action: () => Promise<void>) {
    if (working) return
    setWorking(name)
    setError("")
    setNotice("")
    try {
      await action()
    } catch (requestError) {
      if (
        requestError instanceof ApiError &&
        requestError.code === "stale_review_version"
      ) {
        await loadArticle()
        setError("文章已被其他操作更新，已载入最新版本，请重新检查后再操作。")
      } else if (
        requestError instanceof ApiError &&
        requestError.code &&
        [
          "article_lock_already_held",
          "article_edit_lock_not_found",
          "article_lock_expired",
          "article_lock_stale_fence",
          "article_lock_type_mismatch",
        ].includes(requestError.code)
      ) {
        reliableSave.protectLocally()
        reliableSave.invalidateRequests()
        editLock.markLost()
        setError(LOCK_LOSS_PROTECTION_MESSAGE)
      } else {
        setError(
          requestError instanceof Error ? requestError.message : "操作失败"
        )
      }
    } finally {
      setWorking(null)
    }
  }

  function idempotencyKey(action: string) {
    const prior = followupKeyRef.current
    if (prior?.action === action) return prior.key
    const key = crypto.randomUUID()
    followupKeyRef.current = { action, key }
    return key
  }

  async function handleFollowup(action: "retry" | "regenerate") {
    if (!article) return
    await runAction(action, async () => {
      const key = idempotencyKey(action)
      const next =
        action === "retry"
          ? await retryArticle(projectId, articleId, key)
          : await regenerateArticle(projectId, articleId, key)
      setArticle((current) => (current ? mergeSummary(current, next) : current))
      setNotice(
        action === "retry" ? "已创建新的重试任务。" : "已创建新的重新生成任务。"
      )
      followupKeyRef.current = null
    })
  }

  async function handleSave() {
    const lockCredential = editLock.credential
    if (!article || !document || !documentWritable || !lockCredential || !dirty)
      return
    await runAction("save", async () => {
      const savingDocument = canonicalizeArticleDocument(document)
      const savingMetadata = articleMetadata(article)
      const savingHash = await articleSnapshotHash(
        savingDocument,
        savingMetadata
      )
      reliableSave.invalidateRequests()
      const saved = await saveArticleDocument(
        projectId,
        articleId,
        {
          document: savingDocument,
          metadata: savingMetadata,
          content_hash: savingHash,
          base_review_version: article.review_version,
          base_version_number: article.current_version_number,
          autosave_id:
            reliableSave.state.protectedHash === savingHash
              ? reliableSave.state.autosaveId
              : null,
        },
        lockCredential
      )
      setArticle(saved)
      setBaselineHash(saved.current_content_hash || savingHash)
      const hasNewerChanges = reliableSave.getCurrentHash() !== savingHash
      if (!hasNewerChanges) setDocument(saved.document)
      reliableSave.markManualSaved(savingHash, hasNewerChanges)
      refreshVersions()
      setNotice(
        `已保存为永久版本 ${saved.current_version_number}，需要重新提交审核。`
      )
    })
  }

  async function handleRestoreVersion(version: ArticleVersionSummary) {
    const lockCredential = editLock.credential
    if (!article || !lockCredential || dirty) return
    await runAction("restore-version", async () => {
      const restored = await restoreArticleVersion(
        projectId,
        articleId,
        version.version_number,
        article.review_version,
        lockCredential
      )
      setArticle(restored)
      externalDocumentSyncRef.current = true
      setDocument(validDocument(restored.document) ? restored.document : null)
      setBaselineHash(restored.current_content_hash)
      reliableSave.reset(restored.current_content_hash)
      refreshVersions()
      setNotice(
        `已从版本 ${version.version_number} 创建永久版本 ${restored.current_version_number}，需要重新提交审核。`
      )
    })
  }

  function recoveryDocument() {
    if (!recovery?.backup) return null
    return recovery.kind === "local"
      ? recovery.backup.document
      : (recovery.backup?.document ?? null)
  }

  function recoveryMetadata() {
    if (!recovery?.backup) return null
    return recovery.backup.metadata ?? null
  }

  async function discardRecovery() {
    if (!recovery || !capabilities) return
    if (recovery.kind === "local") {
      discardLocalArticleBackup(
        { projectId, articleId, recoveryScope: capabilities.recovery_scope },
        recovery.backup.id
      )
    } else if (recovery.backup) {
      await deleteArticleAutosave(projectId, articleId, recovery.backup.id)
    }
    setRecovery(null)
    setRecoveryOpen(false)
  }

  function restoreRecovery() {
    const candidate = recoveryDocument()
    if (!candidate) return
    externalDocumentSyncRef.current = true
    setDocument(
      editorJsonToArticleDocument(articleDocumentToEditorJson(candidate))
    )
    const recoveredMetadata = recoveryMetadata()
    if (recoveredMetadata) {
      setArticle((current) =>
        current ? { ...current, ...recoveredMetadata } : current
      )
    }
    setRecovery(null)
    setRecoveryOpen(false)
    setNotice("已载入恢复副本。确认内容后请手动保存为永久版本。")
  }

  if (loading) {
    return (
      <div
        className="min-h-dvh bg-muted/20"
        aria-label="正在读取文章"
        data-layout="fullscreen"
      >
        <div className="flex min-h-16 items-center border-b bg-background px-4 sm:px-6">
          <Skeleton className="h-9 w-36 rounded-md" />
        </div>
        <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6">
          <Skeleton className="h-12 w-full rounded-md" />
          <Skeleton className="h-[calc(100dvh-10rem)] w-full rounded-md" />
        </div>
      </div>
    )
  }

  if (!article || !capabilities) {
    return (
      <div
        className="flex min-h-dvh items-center justify-center bg-muted/20 px-4"
        data-layout="fullscreen"
      >
        <div className="text-center">
          <p className="text-sm text-destructive">{error || "文章不存在"}</p>
          <Button variant="outline" className="mt-4" onClick={onBack}>
            <ArrowLeft /> 返回内容库
          </Button>
        </div>
      </div>
    )
  }

  const completed = COMPLETED_STATUSES.has(article.status)
  const retryable =
    article.status === "failed" && article.run?.retryable === true
  const publishBlocked = publicationBlockedReasonLabel(
    article.publication_blocked_reason
  )

  const governancePanel =
    metadata && document ? (
      <ArticleGovernancePanel
        projectId={projectId}
        articleId={articleId}
        article={article}
        document={document}
        metadata={metadata}
        capabilities={capabilities}
        dirty={dirty}
        disabled={!writable}
        editorRef={editorRef}
        onMetadataChange={handleMetadataChange}
        versionContent={
          <section className="p-4">
            <ArticleVersionHistory
              projectId={projectId}
              articleId={articleId}
              currentVersionNumber={article.current_version_number}
              dirty={dirty}
              working={Boolean(working)}
              refreshToken={versionsRefreshToken}
              onRestore={handleRestoreVersion}
            />
          </section>
        }
        assetContent={<ArticleAssetLibrary document={document} />}
        reviewContent={
          <>
            <section className="border-b bg-background px-5 py-4">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-muted-foreground">质量状态</p>
                  <p className="mt-1 font-medium">
                    {articlePublicationLabel(article.publication_status)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">CMS 状态</p>
                  <p className="mt-1 font-medium">
                    {cmsPublicationLabel(article.cms_publication_status)}
                  </p>
                </div>
              </div>
              {article.wordpress_url && (
                <a
                  href={article.wordpress_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                >
                  <ExternalLink className="size-4" /> 查看 WordPress 文章
                </a>
              )}
              {publishBlocked && (
                <p className="mt-3 text-xs text-muted-foreground">
                  发布门禁：{publishBlocked}
                </p>
              )}
              {article.cms_publication_status === "uncertain" && (
                <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  发布结果不确定。请先在 WordPress
                  后台核对，不要更换请求重复发布。
                </p>
              )}
            </section>
            <ArticleReviewWorkflow
              projectId={projectId}
              article={article}
              capabilities={capabilities}
              dirty={dirty}
              parentWorking={Boolean(working)}
              autosaveId={reliableSave.state.autosaveId}
              onRefreshArticle={loadArticle}
            />
          </>
        }
        sourceContent={
          <>
            <section className="space-y-6 border-b bg-background px-5 py-5">
              <SourceList title="外部来源" items={article.external_sources} />
              <SourceList title="已插入内链" items={article.internal_links} />
            </section>
            {(article.run?.warnings.length ?? 0) > 0 && (
              <section className="border-b border-amber-300 bg-amber-50 px-5 py-5 dark:border-amber-900 dark:bg-amber-950/40">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <AlertTriangle className="size-4" />
                  生成说明
                </h2>
                <ul className="mt-3 space-y-2 text-sm text-foreground">
                  {article.run?.warnings.map((warning) => (
                    <li key={warning.code}>{warning.message}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        }
        value={governanceTab}
        onValueChange={setGovernanceTab}
      />
    ) : null

  return (
    <div
      className="min-h-dvh bg-muted/30 xl:h-dvh xl:overflow-hidden"
      aria-label="文章编辑工作区"
      data-layout="fullscreen"
    >
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/90 xl:relative">
        <div className="flex min-h-14 flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:px-4 xl:h-14 xl:py-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  onClick={onBack}
                  aria-label="返回内容库"
                />
              }
            >
              <ArrowLeft />
            </TooltipTrigger>
            <TooltipContent>返回内容库</TooltipContent>
          </Tooltip>

          <div className="min-w-0 flex-1 border-l pl-3">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-semibold sm:text-base">
                {article.title || article.primary_keyword}
              </h1>
              <Badge
                variant={completed ? "default" : "secondary"}
                className="hidden shrink-0 sm:inline-flex"
              >
                {articleStatusLabel(article.status)}
              </Badge>
              {completed && (
                <Badge
                  variant="outline"
                  className="hidden shrink-0 md:inline-flex"
                >
                  {articlePublicationLabel(article.publication_status)}
                </Badge>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {!documentWritable
                ? `只读模式 · 永久版本 ${article.current_version_number}`
                : editLock.status !== "held"
                  ? `只读模式 · ${editLock.status === "acquiring" ? "正在获取编辑锁" : "无可用编辑锁"}`
                  : dirty
                    ? `${articleSaveStatusLabel[reliableSave.state.status]} · 永久版本 ${article.current_version_number}`
                    : `目标关键词：${article.primary_keyword} · ${articleSaveStatusLabel[reliableSave.state.status]}`}
            </p>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {active && (
              <Button
                variant="outline"
                size="sm"
                disabled={Boolean(working)}
                onClick={() =>
                  runAction("cancel", async () => {
                    const next = await cancelArticle(projectId, articleId)
                    setArticle((current) =>
                      current ? mergeSummary(current, next) : current
                    )
                  })
                }
              >
                {working === "cancel" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <X />
                )}
                <span className="hidden sm:inline">取消生成</span>
              </Button>
            )}
            {retryable && (
              <Button
                size="sm"
                disabled={Boolean(working)}
                onClick={() => handleFollowup("retry")}
              >
                {working === "retry" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                <span className="hidden sm:inline">重试</span>
              </Button>
            )}
            {completed && document && (
              <Button
                variant="outline"
                size="sm"
                disabled={!documentWritable || !dirty || Boolean(working)}
                onClick={handleSave}
              >
                {working === "save" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Save />
                )}
                <span className="hidden sm:inline">保存</span>
              </Button>
            )}
            {completed && document && (
              <Button
                size="sm"
                onClick={() => setGovernanceTab("review")}
              >
                <Send />
                发布
              </Button>
            )}
            {(completed ||
              article.status === "cancelled" ||
              article.status === "failed") && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="更多文章操作"
                      disabled={Boolean(working)}
                    />
                  }
                >
                  {working === "regenerate" ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <MoreHorizontal />
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="rounded-md">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>文章操作</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {completed && document && (
                      <DropdownMenuItem
                        className="rounded-sm"
                        onClick={() => setGovernanceTab("review")}
                      >
                        <SlidersHorizontal /> 审核与发布
                      </DropdownMenuItem>
                    )}
                    {recovery && recoveryDocument() && (
                      <DropdownMenuItem
                        className="rounded-sm"
                        onClick={() => setRecoveryOpen(true)}
                      >
                        <Clock3 /> 恢复未保存内容
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      className="rounded-sm"
                      onClick={() => handleFollowup("regenerate")}
                    >
                      <RefreshCw /> 重新生成文章
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </header>

      {completed && document && (
        <div className="min-w-0 xl:grid xl:h-[calc(100dvh-3.5rem)] xl:grid-cols-[minmax(0,1fr)_minmax(22rem,36rem)] xl:overflow-hidden">
          <main
            className="min-w-0 bg-muted/20 xl:h-full xl:overflow-y-auto"
            aria-label="文章正文编辑区"
          >
            <div className="mx-auto max-w-[56rem] px-0 py-4 sm:px-6 sm:py-8 lg:py-10">
              <ArticleEditLockStatusBar
                status={editLock.status}
                lock={editLock.lock}
                error={editLock.error}
                canForceRelease={Boolean(capabilities?.can_manage_locks)}
                onAcquire={handleAcquireEditLock}
                onForceRelease={editLock.forceRelease}
              />
              {error && (
                <div
                  className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                  role="alert"
                >
                  {error}
                </div>
              )}
              {notice && (
                <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
                  {notice}
                </div>
              )}
              {!documentWritable && compatibility && capabilities && (
                <div
                  className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
                  role="alert"
                >
                  当前文章包含此编辑器不支持的 schema、节点或格式，或服务端已将
                  当前文档标记为只读，已切换为只读，避免覆盖原始内容。
                  {document.schema_version > capabilities.schema_version && (
                    <span className="mt-1 block text-xs">
                      文档 schema 版本 {document.schema_version}
                      ，当前编辑器支持到版本 {capabilities.schema_version}。
                    </span>
                  )}
                  {!capabilities.writable && (
                    <span className="mt-1 block text-xs">
                      服务端能力合同不允许修改此文档。
                    </span>
                  )}
                  {compatibility.unsupportedNodes.length > 0 && (
                    <span className="mt-1 block text-xs">
                      未支持节点：{compatibility.unsupportedNodes.join("、")}
                    </span>
                  )}
                  {compatibility.unsupportedMarks.length > 0 && (
                    <span className="mt-1 block text-xs">
                      未支持格式：{compatibility.unsupportedMarks.join("、")}
                    </span>
                  )}
                </div>
              )}
              {dirty && reliableSave.state.error && (
                <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                  {articleSaveStatusLabel[reliableSave.state.status]}：
                  {reliableSave.state.error}
                </div>
              )}
              <ArticleEditor
                ref={editorRef}
                key={`${article.id}:${article.review_version}`}
                projectId={projectId}
                articleId={articleId}
                document={document}
                metadata={metadata!}
                reviewVersion={article.review_version}
                capabilities={capabilities}
                readOnly={!writable}
                className="border-x-0 shadow-sm sm:border-x"
                onMetadataChange={(field, value) =>
                  handleMetadataChange(field, value)
                }
                onChange={(next, context) => {
                  if (
                    context.source === "initialization" &&
                    externalDocumentSyncRef.current
                  ) {
                    return
                  }
                  if (context.source === "editor") {
                    externalDocumentSyncRef.current = false
                  }
                  setDocument(next)
                  if (context.source === "editor") setNotice("")
                }}
              />
            </div>
          </main>
          <aside
            className="h-[48rem] min-h-0 border-t bg-background xl:h-full xl:border-t-0 xl:border-l"
            aria-label="文章治理面板"
          >
            {governancePanel}
          </aside>
        </div>
      )}

      {recovery && recoveryDocument() && (
        <Dialog open={recoveryOpen} onOpenChange={setRecoveryOpen}>
          <DialogContent className="rounded-md sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>恢复未保存内容</DialogTitle>
              <DialogDescription>
                仅在你确认后恢复，不会自动替换当前文章。
              </DialogDescription>
            </DialogHeader>
            <div className="grid min-h-0 gap-3 md:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-1 text-xs font-medium">当前文章</p>
                <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap">
                  {articleDocumentText(article.document) || "（空正文）"}
                </pre>
              </div>
              <div className="min-w-0">
                <p className="mb-1 text-xs font-medium">未保存内容</p>
                <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap">
                  {articleDocumentText(recoveryDocument()!) || "（空正文）"}
                </pre>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => void discardRecovery()}>
                丢弃副本
              </Button>
              <Button onClick={restoreRecovery}>恢复到编辑器</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {(!completed || !document) && (
        <main className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:px-6">
          {error && (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              role="alert"
            >
              {error}
            </div>
          )}
          {notice && (
            <div className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
              {notice}
            </div>
          )}

          {active && article.run && (
            <Card className="rounded-md shadow-sm">
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <LoaderCircle className="size-4 animate-spin text-primary" />
                    <span className="font-medium">
                      {articleStageLabel(article.run.stage)}
                    </span>
                  </div>
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground tabular-nums">
                    <Clock3 className="size-4" /> 已用{" "}
                    {elapsedLabel(
                      article.run.started_at,
                      article.run.created_at
                    )}
                  </span>
                </div>
                <Progress value={article.run.progress} />
                <p className="text-right text-xs text-muted-foreground tabular-nums">
                  {article.run.progress}%
                </p>
              </CardContent>
            </Card>
          )}

          {article.status === "failed" && (
            <Card className="rounded-md border-destructive/30 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base">生成失败</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>{article.run?.error_detail || "文章生成任务未完成。"}</p>
                {article.run?.failed_stage && (
                  <p className="text-muted-foreground">
                    失败阶段：{articleStageLabel(article.run.failed_stage)}
                  </p>
                )}
                {!retryable && (
                  <p className="text-muted-foreground">
                    该失败不可直接重试，可使用“重新生成”创建新任务。
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {article.status === "cancelled" && (
            <div className="rounded-md border bg-background px-5 py-10 text-center">
              <p className="font-medium">文章生成已取消</p>
              <p className="mt-1 text-sm text-muted-foreground">
                当前任务已终止，可重新生成一个新版本。
              </p>
            </div>
          )}

          {completed && !document && (
            <div className="rounded-md border bg-background px-5 py-10 text-center">
              <p className="font-medium">文章正文暂不可编辑</p>
              <p className="mt-1 text-sm text-muted-foreground">
                当前文章缺少结构化正文，请重新生成后再编辑。
              </p>
            </div>
          )}
        </main>
      )}
    </div>
  )
}
