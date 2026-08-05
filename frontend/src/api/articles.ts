import { apiRequest } from "@/api/client"

export type ArticleStatus =
  | "queued"
  | "running"
  | "completed"
  | "completed_with_warnings"
  | "cancelled"

export type ArticlePublicationStatus = "publish_ready" | "complete_draft"

export type ArticleWarning = {
  code: string
  message: string
}

export type ArticleRun = {
  id: string
  article_id: string
  status: ArticleStatus
  stage: string
  progress: number
  warnings: ArticleWarning[]
  started_at: string | null
  soft_deadline_at: string | null
  hard_deadline_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export type ArticleSummary = {
  id: string
  project_id: string
  primary_keyword: string
  title: string | null
  slug: string | null
  meta_title: string | null
  meta_description: string | null
  status: ArticleStatus
  publication_status: ArticlePublicationStatus
  warning_count: number
  run: ArticleRun | null
  created_at: string
  updated_at: string
}

export type ArticleSource = {
  source_type: string
  url: string
  title: string | null
  domain: string | null
}

export type ArticleDetail = ArticleSummary & {
  outline: Record<string, unknown>
  markdown: string | null
  html: string | null
  external_sources: ArticleSource[]
  internal_links: ArticleSource[]
}

export type ArticleCollection = {
  items: ArticleSummary[]
  total: number
  page: number
  page_size: number
}

function articlePath(projectId: string, suffix = "") {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/articles${suffix}`
}

export function createArticle(
  projectId: string,
  primaryKeyword: string,
  idempotencyKey: string
) {
  return apiRequest<ArticleSummary>(articlePath(projectId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ primary_keyword: primaryKeyword }),
  })
}

export function listArticles(projectId: string) {
  return apiRequest<ArticleCollection>(articlePath(projectId))
}

export function getArticle(projectId: string, articleId: string) {
  return apiRequest<ArticleDetail>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}`)
  )
}

export function getArticleRun(projectId: string, articleId: string) {
  return apiRequest<ArticleRun>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/run`)
  )
}

export function cancelArticle(projectId: string, articleId: string) {
  return apiRequest<ArticleSummary>(
    articlePath(projectId, `/${encodeURIComponent(articleId)}/cancel`),
    { method: "POST" }
  )
}
