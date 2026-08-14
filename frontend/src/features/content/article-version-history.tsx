import * as React from "react"
import {
  GitCompareArrows,
  History,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
} from "lucide-react"

import {
  compareArticleVersions,
  listArticleVersions,
  type ArticleVersionDiff,
  type ArticleVersionSummary,
} from "@/api/articles"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ArticleTypedDiff } from "@/features/content/article-typed-diff"

const VERSION_TYPE_LABELS: Record<string, string> = {
  outline: "提纲",
  draft: "初稿",
  revised: "AI 修订稿",
  final: "生成完成稿",
  manual_edit: "手工编辑",
  restored: "恢复版本",
  review_submitted: "提交审核",
  review_approved: "审核批准",
  review_changes_requested: "审核退回",
}

type VersionGroup = "generation" | "editing" | "review" | "restore" | "other"

const GROUP_LABELS: Record<VersionGroup, string> = {
  generation: "生成版本",
  editing: "编辑版本",
  review: "审核版本",
  restore: "恢复版本",
  other: "其他版本",
}

function versionGroup(versionType: string): VersionGroup {
  if (["outline", "draft", "revised", "final"].includes(versionType)) {
    return "generation"
  }
  if (versionType === "manual_edit") return "editing"
  if (versionType === "restored") return "restore"
  if (
    versionType.includes("review") ||
    versionType.includes("approved") ||
    versionType.includes("publish")
  ) {
    return "review"
  }
  return "other"
}

function versionTypeLabel(value: string) {
  return VERSION_TYPE_LABELS[value] ?? value
}

function actorLabel(value: string) {
  return value === "system" ? "系统" : value
}

function dateTimeLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

export function ArticleVersionHistory({
  projectId,
  articleId,
  currentVersionNumber,
  dirty,
  working,
  refreshToken,
  onRestore,
}: {
  projectId: string
  articleId: string
  currentVersionNumber: number
  dirty: boolean
  working: boolean
  refreshToken: number
  onRestore: (version: ArticleVersionSummary) => Promise<void>
}) {
  const [versions, setVersions] = React.useState<ArticleVersionSummary[]>([])
  const [selected, setSelected] = React.useState<number[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [diff, setDiff] = React.useState<ArticleVersionDiff | null>(null)
  const [diffOpen, setDiffOpen] = React.useState(false)
  const [dialogMode, setDialogMode] = React.useState<"compare" | "restore">(
    "compare"
  )
  const [restoreTarget, setRestoreTarget] =
    React.useState<ArticleVersionSummary | null>(null)
  const [comparing, setComparing] = React.useState(false)
  const [restoring, setRestoring] = React.useState(false)
  const latestRequest = React.useRef(0)

  const applyVersions = React.useCallback((items: ArticleVersionSummary[]) => {
    setVersions(items)
    setSelected((current) =>
      current.filter((versionNumber) =>
        items.some((version) => version.version_number === versionNumber)
      )
    )
  }, [])

  const loadVersions = React.useCallback(async () => {
    const requestId = ++latestRequest.current
    setLoading(true)
    setError("")
    try {
      const response = await listArticleVersions(projectId, articleId)
      if (requestId !== latestRequest.current) return
      applyVersions(response.items)
    } catch (requestError) {
      if (requestId !== latestRequest.current) return
      setError(
        requestError instanceof Error ? requestError.message : "读取版本历史失败"
      )
    } finally {
      if (requestId === latestRequest.current) setLoading(false)
    }
  }, [applyVersions, articleId, projectId])

  React.useEffect(() => {
    void loadVersions()
    return () => {
      latestRequest.current += 1
    }
  }, [loadVersions, refreshToken])

  function toggleVersion(versionNumber: number) {
    setSelected((current) => {
      if (current.includes(versionNumber)) {
        return current.filter((item) => item !== versionNumber)
      }
      if (current.length === 2) return [current[1], versionNumber]
      return [...current, versionNumber]
    })
  }

  async function openDiff(
    fromVersion: number,
    toVersion: number,
    mode: "compare" | "restore",
    target: ArticleVersionSummary | null = null
  ) {
    setComparing(true)
    setError("")
    setDiff(null)
    setDialogMode(mode)
    setRestoreTarget(target)
    setDiffOpen(true)
    try {
      setDiff(
        await compareArticleVersions(
          projectId,
          articleId,
          fromVersion,
          toVersion
        )
      )
    } catch (requestError) {
      setDiffOpen(false)
      setRestoreTarget(null)
      setError(
        requestError instanceof Error ? requestError.message : "读取版本差异失败"
      )
    } finally {
      setComparing(false)
    }
  }

  async function handleCompare() {
    if (selected.length !== 2 || comparing) return
    const [fromVersion, toVersion] = [...selected].sort((a, b) => a - b)
    await openDiff(fromVersion, toVersion, "compare")
  }

  async function handleRestore(version: ArticleVersionSummary) {
    if (
      dirty ||
      working ||
      !version.restorable ||
      version.version_number === currentVersionNumber
    ) {
      return
    }
    await openDiff(
      version.version_number,
      currentVersionNumber,
      "restore",
      version
    )
  }

  async function confirmRestore() {
    if (!restoreTarget || restoring || !diff) return
    setRestoring(true)
    setError("")
    try {
      await onRestore(restoreTarget)
      setDiffOpen(false)
      setRestoreTarget(null)
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "恢复版本失败"
      )
    } finally {
      setRestoring(false)
    }
  }

  const groups = React.useMemo(() => {
    const grouped = new Map<VersionGroup, ArticleVersionSummary[]>()
    for (const version of versions) {
      const group = versionGroup(version.version_type)
      grouped.set(group, [...(grouped.get(group) ?? []), version])
    }
    return (["generation", "editing", "review", "restore", "other"] as const)
      .map((group) => ({ group, items: grouped.get(group) ?? [] }))
      .filter((entry) => entry.items.length > 0)
  }, [versions])

  return (
    <>
      <Card className="rounded-md shadow-sm">
        <CardHeader className="flex-row items-center justify-between border-b">
          <div>
            <CardTitle className="flex items-center gap-2">
              <History className="size-4" /> 版本历史
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              选择两个版本比较；恢复前会与当前永久版本完整对照
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            title="刷新版本历史"
            aria-label="刷新版本历史"
            disabled={loading}
            onClick={() => void loadVersions()}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && versions.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="space-y-3 py-3 text-sm">
              <p className="text-destructive" role="alert">{error}</p>
              <Button variant="outline" size="sm" onClick={() => void loadVersions()}>
                <RefreshCw /> 重试
              </Button>
            </div>
          ) : versions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">暂无版本记录</p>
          ) : (
            groups.map(({ group, items }) => (
              <section key={group} className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {GROUP_LABELS[group]} · {items.length}
                </h3>
                <div className="divide-y rounded-md border px-3">
                  {items.map((version) => {
                    const isCurrent = version.version_number === currentVersionNumber
                    return (
                      <div key={version.id} className="space-y-2 py-3">
                        <div className="flex items-start gap-2">
                          <Checkbox
                            aria-label={`选择版本 ${version.version_number}`}
                            checked={selected.includes(version.version_number)}
                            onCheckedChange={() => toggleVersion(version.version_number)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-sm font-medium">
                                版本 {version.version_number}
                              </span>
                              <Badge variant="outline">
                                {versionTypeLabel(version.version_type)}
                              </Badge>
                              {isCurrent && <Badge variant="secondary">当前</Badge>}
                            </div>
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {actorLabel(version.created_by)} · {dateTimeLabel(version.created_at)}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {version.review_version
                                ? `审核序号 ${version.review_version}`
                                : "执行阶段快照"}
                              {!version.restorable ? " · 无完整正文快照" : ""}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title={
                              isCurrent
                                ? "这是当前永久版本"
                                : version.restorable
                                  ? `恢复版本 ${version.version_number}`
                                  : "该阶段版本没有完整正文快照"
                            }
                            aria-label={`恢复版本 ${version.version_number}`}
                            disabled={
                              isCurrent || !version.restorable || dirty || working || comparing
                            }
                            onClick={() => void handleRestore(version)}
                          >
                            <RotateCcw />
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </section>
            ))
          )}

          {versions.length > 0 && !error && (
            <Button
              variant="outline"
              className="w-full"
              disabled={selected.length !== 2 || comparing}
              onClick={() => void handleCompare()}
            >
              {comparing ? <LoaderCircle className="animate-spin" /> : <GitCompareArrows />}
              比较所选版本
            </Button>
          )}
          {dirty && (
            <p className="text-xs text-muted-foreground">
              当前有未保存修改，保存或放弃修改后才能恢复历史版本。
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={diffOpen} onOpenChange={setDiffOpen}>
        <DialogContent className="max-h-[94vh] gap-0 overflow-hidden rounded-md p-0 sm:max-w-6xl">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>
              {dialogMode === "restore" ? "恢复前版本差异" : "版本差异"}
            </DialogTitle>
            <DialogDescription>
              {diff
                ? dialogMode === "restore"
                  ? `目标版本 ${restoreTarget?.version_number} 与当前永久版本 ${currentVersionNumber}`
                  : `版本 ${diff.from_version.version_number} → 版本 ${diff.to_version.version_number}`
                : "正在读取完整结构化差异"}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {!diff ? (
              <div className="flex min-h-64 items-center justify-center">
                <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <ArticleTypedDiff diff={diff} />
            )}
          </div>
          {dialogMode === "restore" && (
            <DialogFooter className="border-t px-6 py-4">
              <Button variant="outline" disabled={restoring} onClick={() => setDiffOpen(false)}>
                取消
              </Button>
              <Button disabled={!diff || restoring} onClick={() => void confirmRestore()}>
                {restoring ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
                确认恢复版本 {restoreTarget?.version_number}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
