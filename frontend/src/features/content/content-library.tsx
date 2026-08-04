import * as React from "react"
import { ExternalLink, FileText, Search } from "lucide-react"

import {
  listArticles,
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
  ARTICLE_STATUS_LABELS,
  articlePublicationLabel,
  articleStageLabel,
  articleStatusLabel,
} from "@/features/content/article-labels"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

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
  const { status } = article
  const completed = status === "completed" || status === "completed_with_warnings"
  const variant =
    completed && article.publication_status === "publish_ready"
      ? "default"
      : status === "cancelled"
        ? "outline"
        : "secondary"
  return (
    <Badge
      variant={variant}
      className={
        status === "completed_with_warnings"
          ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          : undefined
      }
    >
      {completed
        ? articlePublicationLabel(article.publication_status)
        : articleStatusLabel(status)}
    </Badge>
  )
}

type ContentLibraryProps = {
  projectId: string
  onOpenArticle: (articleId: string) => void
}

export function ContentLibrary({
  projectId,
  onOpenArticle,
}: ContentLibraryProps) {
  const [result, setResult] = React.useState<{
    projectId: string
    articles: ArticleSummary[]
    error: string
  } | null>(null)
  const [search, setSearch] = React.useState("")
  const [status, setStatus] = React.useState<ArticleStatus | "all">("all")

  React.useEffect(() => {
    let active = true
    void listArticles(projectId)
      .then((collection) => {
        if (active) {
          setResult({ projectId, articles: collection.items, error: "" })
        }
      })
      .catch((requestError: unknown) => {
        if (active) {
          setResult({
            projectId,
            articles: [],
            error:
              requestError instanceof Error
                ? requestError.message
                : "读取内容库失败",
          })
        }
      })
    return () => {
      active = false
    }
  }, [projectId])

  const loading = result?.projectId !== projectId
  const articles = loading ? [] : result.articles
  const error = loading ? "" : result.error

  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visibleArticles = articles.filter(
    (article) =>
      (status === "all" || article.status === status) &&
      (!normalizedSearch ||
        article.primary_keyword.toLocaleLowerCase().includes(normalizedSearch) ||
        (article.title ?? "").toLocaleLowerCase().includes(normalizedSearch))
  )

  return (
    <Card className="gap-0 overflow-hidden rounded-md py-0 shadow-sm">
      <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索标题或关键词"
            className="w-full pl-9 sm:max-w-sm"
          />
        </div>
        <Select
          value={status}
          onValueChange={(value) => setStatus((value ?? "all") as ArticleStatus | "all")}
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

      {loading ? (
        <div className="space-y-3 p-4" aria-label="正在读取内容库">
          {[0, 1, 2].map((item) => (
            <Skeleton key={item} className="h-12 rounded-md" />
          ))}
        </div>
      ) : error ? (
        <div className="p-8 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      ) : visibleArticles.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-16 text-center">
          <FileText className="size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">
            {articles.length === 0 ? "还没有文章" : "没有符合条件的文章"}
          </p>
          {articles.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              使用右上角的“创建内容”开始生成。
            </p>
          )}
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
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleArticles.map((article) => (
                <TableRow
                  key={article.id}
                  className="cursor-pointer"
                  onClick={() => onOpenArticle(article.id)}
                >
                  <TableCell className="max-w-80 font-medium">
                    {article.title || article.primary_keyword}
                  </TableCell>
                  <TableCell>
                    <ArticleStatusBadge article={article} />
                  </TableCell>
                  <TableCell>{article.primary_keyword}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {article.status === "completed" ||
                    article.status === "completed_with_warnings"
                      ? formatDate(article.run?.finished_at)
                      : articleStageLabel(article.run?.stage ?? article.status)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(article.updated_at)}
                  </TableCell>
                  <TableCell>
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  )
}
