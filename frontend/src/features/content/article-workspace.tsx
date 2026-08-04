import * as React from "react"
import {
  AlertTriangle,
  ArrowLeft,
  Clock3,
  ExternalLink,
  FileText,
  Link2,
  LoaderCircle,
  X,
} from "lucide-react"

import {
  cancelArticle,
  getArticle,
  type ArticleDetail,
  type ArticleRun,
  type ArticleSource,
} from "@/api/articles"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import {
  articlePublicationLabel,
  articleStageLabel,
  articleStatusLabel,
} from "@/features/content/article-labels"
import { useArticleRunPolling } from "@/features/content/use-article-run-polling"

const TERMINAL_STATUSES = new Set([
  "completed",
  "completed_with_warnings",
  "cancelled",
])

type OutlineSection = {
  id: string
  heading: string
  objective: string
}

function outlineSections(outline: Record<string, unknown>): OutlineSection[] {
  const value = outline.sections
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return []
    const section = item as Record<string, unknown>
    if (typeof section.heading !== "string" || !section.heading) return []
    return [
      {
        id:
          typeof section.section_id === "string"
            ? section.section_id
            : `section-${index + 1}`,
        heading: section.heading,
        objective:
          typeof section.objective === "string" ? section.objective : "",
      },
    ]
  })
}

function elapsedLabel(startedAt: string | null, createdAt: string) {
  const started = new Date(startedAt ?? createdAt).getTime()
  if (Number.isNaN(started)) return "0:00"
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

function safeArticleHtml(value: string) {
  const document = new DOMParser().parseFromString(value, "text/html")
  const allowedTags = new Set([
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "P",
    "UL",
    "LI",
    "STRONG",
    "CODE",
    "A",
  ])

  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(document.createTextNode(element.textContent ?? ""))
      continue
    }
    for (const attribute of Array.from(element.attributes)) {
      if (element.tagName !== "A" || attribute.name !== "href") {
        element.removeAttribute(attribute.name)
      }
    }
    if (element.tagName === "A") {
      const href = element.getAttribute("href") ?? ""
      try {
        const url = new URL(href)
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          element.removeAttribute("href")
        }
      } catch {
        element.removeAttribute("href")
      }
      element.setAttribute("target", "_blank")
      element.setAttribute("rel", "noopener noreferrer")
    }
  }
  return document.body.innerHTML
}

function SourceList({
  title,
  icon,
  items,
  emptyText,
}: {
  title: string
  icon: React.ReactNode
  items: ArticleSource[]
  emptyText: string
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
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
                <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />
                <span className="min-w-0">
                  <span className="block truncate">{item.title || item.url}</span>
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

type ArticleWorkspaceProps = {
  projectId: string
  articleId: string
  onBack: () => void
}

export function ArticleWorkspace({
  projectId,
  articleId,
  onBack,
}: ArticleWorkspaceProps) {
  const [articleState, setArticleState] = React.useState<{
    key: string
    article: ArticleDetail | null
    error: string
  } | null>(null)
  const [cancelling, setCancelling] = React.useState(false)
  const [, tick] = React.useReducer((value) => value + 1, 0)
  const selectionKey = `${projectId}:${articleId}`
  const selectionKeyRef = React.useRef(selectionKey)

  React.useLayoutEffect(() => {
    selectionKeyRef.current = selectionKey
    return () => {
      selectionKeyRef.current = ""
    }
  }, [selectionKey])

  const refreshArticle = React.useCallback(async () => {
    const requestedKey = `${projectId}:${articleId}`
    const nextArticle = await getArticle(projectId, articleId)
    if (selectionKeyRef.current === requestedKey) {
      setArticleState({ key: requestedKey, article: nextArticle, error: "" })
    }
  }, [articleId, projectId])

  React.useEffect(() => {
    let active = true
    void getArticle(projectId, articleId)
      .then((nextArticle) => {
        if (active) {
          setArticleState({ key: selectionKey, article: nextArticle, error: "" })
        }
      })
      .catch((requestError: unknown) => {
        if (active) {
          setArticleState({
            key: selectionKey,
            article: null,
            error:
              requestError instanceof Error ? requestError.message : "读取文章失败",
          })
        }
      })
    return () => {
      active = false
    }
  }, [articleId, projectId, selectionKey])

  const loading = articleState?.key !== selectionKey
  const article = loading ? null : articleState.article
  const error = loading ? "" : articleState.error

  const setCurrentError = React.useCallback(
    (message: string) => {
      setArticleState((current) =>
        current?.key === selectionKey ? { ...current, error: message } : current
      )
    },
    [selectionKey]
  )

  const handleRunChange = React.useCallback(
    (run: ArticleRun) => {
      if (selectionKeyRef.current !== `${projectId}:${articleId}`) return
      setArticleState((current) =>
        current?.key === selectionKey && current.article
          ? {
              ...current,
              article: {
                ...current.article,
                status: run.status,
                warning_count: run.warnings.length,
                run,
              },
            }
          : current
      )
    },
    [articleId, projectId, selectionKey]
  )

  useArticleRunPolling({
    projectId,
    articleId,
    run: article?.run ?? null,
    onRunChange: handleRunChange,
    onError: setCurrentError,
    onTerminal: refreshArticle,
  })

  const active = article && !TERMINAL_STATUSES.has(article.status)
  React.useEffect(() => {
    if (!active) return
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [active])

  async function handleCancel() {
    if (!article || cancelling) return
    setCancelling(true)
    setCurrentError("")
    try {
      const cancelled = await cancelArticle(projectId, articleId)
      if (selectionKeyRef.current === `${projectId}:${articleId}`) {
        setArticleState((current) =>
          current?.key === selectionKey && current.article
            ? {
                ...current,
                article: {
                  ...current.article,
                  status: cancelled.status,
                  run: cancelled.run,
                },
              }
            : current
        )
      }
    } catch (requestError) {
      setCurrentError(
        requestError instanceof Error ? requestError.message : "取消文章失败"
      )
    } finally {
      if (selectionKeyRef.current === `${projectId}:${articleId}`) {
        setCancelling(false)
      }
    }
  }

  if (loading) {
    return (
      <div className="space-y-4" aria-label="正在读取文章">
        <Skeleton className="h-10 w-64 rounded-md" />
        <Skeleton className="h-28 rounded-md" />
        <Skeleton className="h-96 rounded-md" />
      </div>
    )
  }

  if (!article) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-destructive">{error || "文章不存在"}</p>
        <Button variant="outline" className="mt-4" onClick={onBack}>
          <ArrowLeft />
          返回内容库
        </Button>
      </div>
    )
  }

  const sections = outlineSections(article.outline)
  const warnings = article.run?.warnings ?? []
  const completed =
    article.status === "completed" ||
    article.status === "completed_with_warnings"
  const renderedHtml = article.html ? safeArticleHtml(article.html) : ""

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" className="mb-2 -ml-2" onClick={onBack}>
            <ArrowLeft />
            内容库
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold">
              {article.title || article.primary_keyword}
            </h2>
            <Badge
              variant={completed ? "default" : "secondary"}
              className={
                article.status === "completed_with_warnings"
                  ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                  : undefined
              }
            >
              {completed
                ? articlePublicationLabel(article.publication_status)
                : articleStatusLabel(article.status)}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            目标关键词：{article.primary_keyword}
          </p>
        </div>
        {active && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? <LoaderCircle className="animate-spin" /> : <X />}
            {cancelling ? "取消中..." : "取消生成"}
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
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
                <Clock3 className="size-4" />
                已用 {elapsedLabel(article.run.started_at, article.run.created_at)}
              </span>
            </div>
            <Progress value={article.run.progress} />
            <p className="text-right text-xs text-muted-foreground tabular-nums">
              {article.run.progress}%
            </p>
          </CardContent>
        </Card>
      )}

      {article.status === "cancelled" && (
        <div className="rounded-md border px-5 py-10 text-center">
          <p className="font-medium">文章生成已取消</p>
          <p className="mt-1 text-sm text-muted-foreground">
            已停止当前任务，不会继续消耗生成资源。
          </p>
        </div>
      )}

      {completed && (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <main className="min-w-0 space-y-5">
            <Card className="rounded-md shadow-sm">
              <CardHeader className="border-b">
                <CardTitle>文章信息</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div>
                  <div className="text-xs text-muted-foreground">Meta Title</div>
                  <div className="mt-1 text-sm">{article.meta_title || "-"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Slug</div>
                  <div className="mt-1 break-all text-sm">{article.slug || "-"}</div>
                </div>
                <div className="sm:col-span-2">
                  <div className="text-xs text-muted-foreground">Meta Description</div>
                  <div className="mt-1 text-sm">{article.meta_description || "-"}</div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-md shadow-sm">
              <CardHeader className="border-b">
                <CardTitle className="flex items-center gap-2">
                  <FileText className="size-4" />
                  {articlePublicationLabel(article.publication_status)}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {renderedHtml ? (
                  <article
                    className="text-[15px] leading-7 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_h1]:mb-5 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_p]:my-4"
                    dangerouslySetInnerHTML={{ __html: renderedHtml }}
                  />
                ) : (
                  <article className="whitespace-pre-wrap text-[15px] leading-7">
                    {article.markdown || "文章正文暂不可用"}
                  </article>
                )}
              </CardContent>
            </Card>
          </main>

          <aside className="space-y-5 xl:sticky xl:top-5">
            <Card className="rounded-md shadow-sm">
              <CardHeader className="border-b">
                <CardTitle>最终大纲</CardTitle>
              </CardHeader>
              <CardContent>
                {sections.length === 0 ? (
                  <p className="text-sm text-muted-foreground">暂无大纲</p>
                ) : (
                  <ol className="space-y-3">
                    {sections.map((section, index) => (
                      <li key={section.id} className="flex gap-3 text-sm">
                        <span className="text-muted-foreground tabular-nums">
                          {index + 1}.
                        </span>
                        <span>
                          <span className="block font-medium">{section.heading}</span>
                          {section.objective && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {section.objective}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-md shadow-sm">
              <CardContent className="space-y-6">
                <SourceList
                  title="外部来源"
                  icon={<ExternalLink className="size-4 text-muted-foreground" />}
                  items={article.external_sources}
                  emptyText="本稿未使用外部来源"
                />
                <SourceList
                  title="已插入内链"
                  icon={<Link2 className="size-4 text-muted-foreground" />}
                  items={article.internal_links}
                  emptyText="本稿未插入站内链接"
                />
              </CardContent>
            </Card>

            {warnings.length > 0 && (
              <Card className="rounded-md border-amber-300 bg-amber-50 shadow-sm dark:border-amber-900 dark:bg-amber-950/40">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
                    <AlertTriangle className="size-4" />
                    生成说明
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2 text-sm text-amber-900 dark:text-amber-200">
                    {warnings.map((warning) => (
                      <li key={warning.code}>{warning.message}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
