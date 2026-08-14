import { apiRequest } from "@/api/client"

export type PerformanceRange = 7 | 28 | 90
export type PerformanceSort =
  | "clicks"
  | "impressions"
  | "ctr"
  | "position"
  | "published_at"
  | "updated_at"
  | "change"
export type PerformanceSortOrder = "asc" | "desc"
export type PerformanceStatus =
  | "waiting_data"
  | "insufficient_data"
  | "impressions"
  | "clicks"
  | "growing"
  | "stable"
  | "declining"
  | "observing_update"

export type PerformanceMetrics = {
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export type PerformanceMetricChange = {
  clicks: number | null
  impressions: number | null
  ctr: number | null
  position: number | null
}

export type PerformanceTrendPoint = PerformanceMetrics & { date: string }

export type PerformanceSyncState = {
  status: "never" | "running" | "completed" | "failed"
  data_through: string | null
  synced_at: string | null
  error: string | null
}

export type PerformanceArticle = {
  article_id: string
  title: string
  url: string
  primary_keyword: string
  published_at: string
  last_published_at: string
  metrics: PerformanceMetrics
  previous_metrics: PerformanceMetrics
  change: PerformanceMetricChange
  status: PerformanceStatus
  signal_count: number
}

export type PerformanceOverview = {
  gsc_connected: boolean
  site_url: string | null
  date_range: PerformanceRange
  range_start: string
  range_end: string
  previous_start: string
  previous_end: string
  metrics: PerformanceMetrics
  previous_metrics: PerformanceMetrics
  change: PerformanceMetricChange
  trend: PerformanceTrendPoint[]
  article_count: number
  status_counts: Record<string, number>
  growing_articles: PerformanceArticle[]
  declining_articles: PerformanceArticle[]
  sync: PerformanceSyncState
}

export type PerformanceArticleCollection = {
  items: PerformanceArticle[]
  total: number
  page: number
  page_size: number
}

export type PerformanceArticleDetail = {
  article: PerformanceArticle
  trend: PerformanceTrendPoint[]
  queries: Array<PerformanceMetrics & { query: string }>
  query_status: "available" | "empty" | "unavailable"
  query_error: string | null
  publications: Array<{
    publication_id: string
    kind: "published" | "updated"
    version_number: number | null
    occurred_at: string
  }>
  signals: Array<{
    id: string
    kind: string
    message: string
    status: "open" | "resolved"
    detected_at: string
  }>
  update_comparison: {
    updated_at: string
    before_start: string
    before_end: string
    after_start: string
    after_end: string
    before_metrics: PerformanceMetrics
    after_metrics: PerformanceMetrics
    change: PerformanceMetricChange
    observation_complete: boolean
  } | null
  data_through: string | null
}

export type PerformanceArticleOptions = {
  page?: number
  pageSize?: number
  status?: PerformanceStatus | "all"
  sort?: PerformanceSort
  order?: PerformanceSortOrder
}

function basePath(projectId: string) {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/performance`
}

export function getPerformanceOverview(
  projectId: string,
  days: PerformanceRange
) {
  return apiRequest<PerformanceOverview>(
    `${basePath(projectId)}/overview?days=${days}`
  )
}

export function getPerformanceArticles(
  projectId: string,
  days: PerformanceRange,
  options: PerformanceArticleOptions = {}
) {
  const params = new URLSearchParams({
    days: String(days),
    page: String(options.page ?? 1),
    page_size: String(options.pageSize ?? 25),
    sort: options.sort ?? "clicks",
    order: options.order ?? "desc",
  })
  if (options.status && options.status !== "all") {
    params.set("status", options.status)
  }
  return apiRequest<PerformanceArticleCollection>(
    `${basePath(projectId)}/articles?${params.toString()}`
  )
}

export function getPerformanceArticle(
  projectId: string,
  articleId: string,
  days: PerformanceRange
) {
  return apiRequest<PerformanceArticleDetail>(
    `${basePath(projectId)}/articles/${encodeURIComponent(articleId)}?days=${days}`
  )
}

export function syncPerformance(projectId: string) {
  return apiRequest<{ sync: PerformanceSyncState; target_count: number }>(
    `${basePath(projectId)}/sync`,
    { method: "POST" }
  )
}

export function resolvePerformanceSignal(projectId: string, signalId: string) {
  return apiRequest<void>(
    `${basePath(projectId)}/signals/${encodeURIComponent(signalId)}/resolve`,
    { method: "POST" }
  )
}
