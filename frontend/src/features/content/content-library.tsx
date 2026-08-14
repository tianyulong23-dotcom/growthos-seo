import * as React from "react"
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCw,
  Search,
} from "lucide-react"

import {
  listArticles,
  regenerateArticle,
  retryArticle,
  type ArticleStatus,
  type ArticleSummary,
} from "@/api/articles"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ARTICLE_STATUS_LABELS,
  articlePublicationLabel,
  articleStageLabel,
  articleStatusLabel,
} from "@/features/content/article-labels"

const PAGE_SIZE = 20

function formatDate(value: string | null | undefined) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "-"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function ArticleStatusBadge({ article }: { article: ArticleSummary }) {
  const completed =
    article.status === "completed" ||
    article.status === "completed_with_warnings"
  return (
    <Badge
      variant={
        completed && article.publication_status === "publish_ready"
          ? "default"
          : article.status === "failed"
            ? "destructive"
            : article.status === "cancelled"
              ? "outline"
              : "secondary"
      }
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
  )
}

export function ContentLibrary({
  projectId,
  onOpenArticle,
}: {
  projectId: string
  onOpenArticle: (articleId: string) => void
}) {
  const [items, setItems] = React.useState<ArticleSummary[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [searchInput, setSearchInput] = React.useState("")
  const [search, setSearch] = React.useState("")
  const [status, setStatus] = React.useState<ArticleStatus | "all">("all")
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [workingId, setWorkingId] = React.useState<string | null>(null)

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1)
      setSearch(searchInput.trim())
    }, 300)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  React.useEffect(() => {
    let active = true
    void Promise.resolve()
      .then(() => {
        if (!active) return null
        setLoading(true)
        setError("")
        return listArticles(projectId, {
          page,
          pageSize: PAGE_SIZE,
          status: status === "all" ? undefined : status,
          search,
        })
      })
      .then((collection) => {
        if (!active || !collection) return
        setItems(collection.items)
        setTotal(collection.total)
      })
      .catch((requestError: unknown) => {
        if (!active) return
        setItems([])
        setTotal(0)
        setError(
          requestError instanceof Error
            ? requestError.message
            : "读取内容库失败"
        )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [page, projectId, search, status])

  async function handleFollowup(
    article: ArticleSummary,
    action: "retry" | "regenerate"
  ) {
    setWorkingId(article.id)
    setError("")
    try {
      const key = crypto.randomUUID()
      if (action === "retry") await retryArticle(projectId, article.id, key)
      else await regenerateArticle(projectId, article.id, key)
      onOpenArticle(article.id)
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "创建文章任务失败"
      )
    } finally {
      setWorkingId(null)
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return (
    <Card className="gap-0 overflow-hidden rounded-md py-0 shadow-sm">
      <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="搜索标题或关键词"
            className="w-full pl-9 sm:max-w-sm"
          />
        </div>
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus((value ?? "all") as ArticleStatus | "all")
            setPage(1)
          }}
        >
          <SelectTrigger className="w-full sm:w-52">
            <SelectValue>
              {status === "all" ? "全部状态" : articleStatusLabel(status)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            {Object.entries(ARTICLE_STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div
          className="border-b border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}
      {loading ? (
        <div className="space-y-3 p-4" aria-label="正在读取内容库">
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-12 rounded-md" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-16 text-center">
          <FileText className="size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">
            {!search && status === "all" ? "还没有文章" : "没有符合条件的文章"}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>内容</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>目标关键词</TableHead>
                <TableHead>阶段 / 完成时间</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead className="w-36" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((article) => {
                const terminal = [
                  "completed",
                  "completed_with_warnings",
                  "failed",
                  "cancelled",
                ].includes(article.status)
                return (
                  <TableRow
                    key={article.id}
                    className="cursor-pointer"
                    onClick={() => onOpenArticle(article.id)}
                  >
                    <TableCell className="max-w-80 font-medium">
                      <span className="block truncate">
                        {article.title || article.primary_keyword}
                      </span>
                      {article.status === "failed" &&
                        article.run?.error_detail && (
                          <span className="mt-1 block truncate text-xs font-normal text-destructive">
                            {article.run.error_detail}
                          </span>
                        )}
                    </TableCell>
                    <TableCell>
                      <ArticleStatusBadge article={article} />
                    </TableCell>
                    <TableCell>{article.primary_keyword}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {terminal
                        ? formatDate(article.run?.finished_at)
                        : articleStageLabel(
                            article.run?.stage ?? article.status
                          )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(article.updated_at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {article.status === "failed" &&
                          article.run?.retryable === true && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title="重试"
                              disabled={workingId === article.id}
                              onClick={(event) => {
                                event.stopPropagation()
                                void handleFollowup(article, "retry")
                              }}
                            >
                              {workingId === article.id ? (
                                <LoaderCircle className="animate-spin" />
                              ) : (
                                <RefreshCw />
                              )}
                            </Button>
                          )}
                        {terminal && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="重新生成"
                            disabled={workingId === article.id}
                            onClick={(event) => {
                              event.stopPropagation()
                              void handleFollowup(article, "regenerate")
                            }}
                          >
                            <RefreshCw />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="打开文章"
                          onClick={(event) => {
                            event.stopPropagation()
                            onOpenArticle(article.id)
                          }}
                        >
                          <ExternalLink />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {!loading && total > 0 && (
        <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            共 {total} 篇 · 第 {page}/{pageCount} 页
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              title="上一页"
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              title="下一页"
              disabled={page >= pageCount}
              onClick={() => setPage((value) => value + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
