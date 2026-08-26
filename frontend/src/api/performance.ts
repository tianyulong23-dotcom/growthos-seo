import { apiRequest } from "@/api/client"
import {
  requestBacklinks,
  type BacklinksRequest,
  type BacklinksResponse,
  type PerformanceBacklinkCandidate,
  type PerformanceBacklinkPlacement,
  type PerformanceBacklinksResponse,
} from "@/api/generated/backlinks"

export type {
  PerformanceBacklinkCandidate,
  PerformanceBacklinkEvidenceSummary,
  PerformanceBacklinkFailure,
  PerformanceBacklinkMeta,
  PerformanceBacklinkPlacement,
  PerformanceBacklinkSummary,
  PerformanceBacklinksResponse,
} from "@/api/generated/backlinks"

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

type PerformanceBacklinksRequest =
  BacklinksRequest<"get_project_backlink_performance_v1">
export type PerformanceBacklinkView = Exclude<
  NonNullable<PerformanceBacklinksRequest["query"]>["view"],
  undefined
>
export type PerformanceBacklinkItem =
  | PerformanceBacklinkCandidate
  | PerformanceBacklinkPlacement
export type PerformanceBacklinkOptions = {
  view?: PerformanceBacklinkView
  limit?: number
  cursor?: string | null
  signal?: AbortSignal
}
export type PerformanceBacklinkPlacementDetail =
  BacklinksResponse<"backlinksGetPlacementLinkV1">["link"]
export type PerformanceBacklinkEvents =
  BacklinksResponse<"backlinksListPlacementLifecycleEventsV1">
export type PerformanceBacklinkEvidence =
  BacklinksResponse<"backlinksGetPlacementEvidenceV1">["evidence"]
export type PerformanceBacklinkReverifyResult =
  BacklinksResponse<"backlinksReverifyPlacementV1">

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

export function getPerformanceBacklinks(
  projectId: string,
  options: PerformanceBacklinkOptions = {}
): Promise<PerformanceBacklinksResponse> {
  return requestBacklinks(
    "get_project_backlink_performance_v1",
    {
      path: { project_id: projectId },
      query: {
        view: options.view,
        limit: options.limit,
        cursor: options.cursor,
      },
    },
    { signal: options.signal }
  )
}

export async function getPerformanceBacklinkPlacement(
  projectId: string,
  placementId: string,
  signal?: AbortSignal
): Promise<PerformanceBacklinkPlacementDetail> {
  const response = await requestBacklinks(
    "backlinksGetPlacementLinkV1",
    {
      path: { websiteProjectKey: projectId, placementId },
    },
    { signal }
  )
  return response.link
}

export function getPerformanceBacklinkEvents(
  projectId: string,
  placementId: string,
  signal?: AbortSignal
): Promise<PerformanceBacklinkEvents> {
  return requestBacklinks(
    "backlinksListPlacementLifecycleEventsV1",
    {
      path: { websiteProjectKey: projectId, placementId },
      query: { limit: 50 },
    },
    { signal }
  )
}

export async function getPerformanceBacklinkEvidence(
  projectId: string,
  evidenceId: string,
  signal?: AbortSignal
): Promise<PerformanceBacklinkEvidence> {
  const response = await requestBacklinks(
    "backlinksGetPlacementEvidenceV1",
    {
      path: { websiteProjectKey: projectId, evidenceId },
    },
    { signal }
  )
  return response.evidence
}

export function reverifyPerformanceBacklink(
  projectId: string,
  placementId: string,
  expectedVersion: number,
  idempotencyKey: string
): Promise<PerformanceBacklinkReverifyResult> {
  return requestBacklinks("backlinksReverifyPlacementV1", {
    path: { websiteProjectKey: projectId, placementId },
    headers: { "idempotency-key": idempotencyKey },
    body: { expectedVersion },
  })
}
