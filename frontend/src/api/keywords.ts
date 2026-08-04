import { apiRequest } from "@/api/client"

export type KeywordRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "partial"
  | "completed"
  | "failed"
  | "cancelled"

export type KeywordMetricsStatus = "pending" | "fresh" | "stale" | "failed"
export type KeywordStatus = "active" | "archived"

export type KeywordBuildRun = {
  runId: string
  kind: "initial" | "expansion"
  roundNumber: number
  status: KeywordRunStatus
  stage: string
  message: string
  progress: number
  discoveredCount: number
  selectedCount: number
  keywordCount: number
  resultVersion: number
  profileSource: string
  gapStatus: string
  gapMessage: string
  gapCount: number
  partialFailures: Array<Record<string, unknown> | string>
  errorCode: string | null
  recoveryCount: number
  nextRetryAt: string | null
  startedAt: string | null
  finishedAt: string | null
  elapsedSeconds: number
}

export type KeywordLibraryStatus = {
  run: KeywordBuildRun | null
  totalKeywords: number
  activeKeywords: number
  pendingMetricsCount: number
  resultVersion: number
}

export type KeywordTag = {
  id: string
  name: string
  color: string | null
}

export type KeywordListItem = {
  id: string
  keyword: string
  primarySeed: string | null
  classificationConfidence: number | null
  reviewStatus: "approved" | "needs_review"
  intent: string | null
  searchVolume: number | null
  cpc: number | null
  competition: number | null
  keywordDifficulty: number | null
  monthlySearches: Array<{
    year?: number | null
    month?: string | number | null
    search_volume?: number | null
  }>
  priorityScore: number | null
  priorityConfidence: number | null
  priorityDetails: Record<string, unknown>
  sources: string[]
  tags: KeywordTag[]
  status: KeywordStatus
  metricsStatus: KeywordMetricsStatus
  metricsUpdatedAt: string | null
  createdAt: string
  updatedAt: string
}

export type KeywordListResult = {
  items: KeywordListItem[]
  total: number
  page: number
  pageSize: number
  resultVersion: number
}

export type KeywordListQuery = {
  page?: number
  pageSize?: number
  search?: string
  intent?: string
  source?: string
  status?: KeywordStatus
  metricsStatus?: KeywordMetricsStatus
  minVolume?: number
  maxDifficulty?: number
  sort?: "keyword" | "search_volume" | "difficulty" | "priority" | "updated_at"
  order?: "asc" | "desc"
}

type KeywordBuildRunResponse = {
  run_id: string
  kind: "initial" | "expansion"
  round_number: number
  status: KeywordRunStatus
  stage: string
  message: string
  progress: number
  discovered_count: number
  selected_count: number
  keyword_count: number
  result_version: number
  profile_source: string
  gap_status: string
  gap_message: string
  gap_count: number
  partial_failures: Array<Record<string, unknown> | string>
  error_code: string | null
  recovery_count: number
  next_retry_at: string | null
  started_at: string | null
  finished_at: string | null
  elapsed_seconds: number
}

type KeywordLibraryStatusResponse = {
  run: KeywordBuildRunResponse | null
  total_keywords: number
  active_keywords: number
  pending_metrics_count: number
  result_version: number
}

type KeywordListItemResponse = {
  id: string
  keyword: string
  primary_seed: string | null
  classification_confidence: number | null
  review_status: "approved" | "needs_review"
  intent: string | null
  search_volume: number | null
  cpc: number | null
  competition: number | null
  keyword_difficulty: number | null
  monthly_searches: KeywordListItem["monthlySearches"]
  priority_score: number | null
  priority_confidence: number | null
  priority_details: Record<string, unknown>
  sources: string[]
  tags: KeywordTag[]
  status: KeywordStatus
  metrics_status: KeywordMetricsStatus
  metrics_updated_at: string | null
  created_at: string
  updated_at: string
}

type KeywordListResponse = {
  items: KeywordListItemResponse[]
  total: number
  page: number
  page_size: number
  result_version: number
}

function keywordPath(projectId: string, suffix = ""): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/keywords${suffix}`
}

function mapRun(run: KeywordBuildRunResponse): KeywordBuildRun {
  return {
    runId: run.run_id,
    kind: run.kind,
    roundNumber: run.round_number,
    status: run.status,
    stage: run.stage,
    message: run.message,
    progress: run.progress,
    discoveredCount: run.discovered_count,
    selectedCount: run.selected_count,
    keywordCount: run.keyword_count,
    resultVersion: run.result_version,
    profileSource: run.profile_source,
    gapStatus: run.gap_status,
    gapMessage: run.gap_message,
    gapCount: run.gap_count,
    partialFailures: run.partial_failures,
    errorCode: run.error_code,
    recoveryCount: run.recovery_count,
    nextRetryAt: run.next_retry_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    elapsedSeconds: run.elapsed_seconds,
  }
}

function mapStatus(
  response: KeywordLibraryStatusResponse
): KeywordLibraryStatus {
  return {
    run: response.run ? mapRun(response.run) : null,
    totalKeywords: response.total_keywords,
    activeKeywords: response.active_keywords,
    pendingMetricsCount: response.pending_metrics_count,
    resultVersion: response.result_version,
  }
}

function mapKeyword(item: KeywordListItemResponse): KeywordListItem {
  return {
    id: item.id,
    keyword: item.keyword,
    primarySeed: item.primary_seed,
    classificationConfidence: item.classification_confidence,
    reviewStatus: item.review_status,
    intent: item.intent,
    searchVolume: item.search_volume,
    cpc: item.cpc,
    competition: item.competition,
    keywordDifficulty: item.keyword_difficulty,
    monthlySearches: item.monthly_searches,
    priorityScore: item.priority_score,
    priorityConfidence: item.priority_confidence,
    priorityDetails: item.priority_details,
    sources: item.sources,
    tags: item.tags,
    status: item.status,
    metricsStatus: item.metrics_status,
    metricsUpdatedAt: item.metrics_updated_at,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }
}

export async function getKeywordStatus(
  projectId: string
): Promise<KeywordLibraryStatus> {
  return mapStatus(
    await apiRequest<KeywordLibraryStatusResponse>(
      keywordPath(projectId, "/status")
    )
  )
}

export async function listKeywords(
  projectId: string,
  query: KeywordListQuery = {}
): Promise<KeywordListResult> {
  const params = new URLSearchParams()
  params.set("page", String(query.page ?? 1))
  params.set("page_size", String(query.pageSize ?? 50))
  if (query.search?.trim()) params.set("search", query.search.trim())
  if (query.intent) params.set("intent", query.intent)
  if (query.source) params.set("source", query.source)
  if (query.status) params.set("keyword_status", query.status)
  if (query.metricsStatus) params.set("metrics_status", query.metricsStatus)
  if (query.minVolume !== undefined) {
    params.set("min_volume", String(query.minVolume))
  }
  if (query.maxDifficulty !== undefined) {
    params.set("max_difficulty", String(query.maxDifficulty))
  }
  if (query.sort) params.set("sort", query.sort)
  if (query.order) params.set("order", query.order)
  const response = await apiRequest<KeywordListResponse>(
    `${keywordPath(projectId)}?${params.toString()}`
  )
  return {
    items: response.items.map(mapKeyword),
    total: response.total,
    page: response.page,
    pageSize: response.page_size,
    resultVersion: response.result_version,
  }
}

export async function retryKeywordBuild(
  projectId: string
): Promise<KeywordBuildRun> {
  return mapRun(
    await apiRequest<KeywordBuildRunResponse>(
      keywordPath(projectId, "/retry"),
      { method: "POST" }
    )
  )
}

export type KeywordCompetitorGap = {
  id: string
  competitorDomain: string
  keyword: string
  competitorRank: number | null
  searchVolume: number | null
  cpc: number | null
  competition: number | null
  keywordDifficulty: number | null
  intent: string | null
  monthlySearches: KeywordListItem["monthlySearches"]
  relevance: number | null
  status: "active" | "needs_review"
  createdAt: string
}

type KeywordCompetitorGapListResponse = {
  items: Array<{
    id: string
    competitor_domain: string
    keyword: string
    competitor_rank: number | null
    search_volume: number | null
    cpc: number | null
    competition: number | null
    keyword_difficulty: number | null
    intent: string | null
    monthly_searches: KeywordListItem["monthlySearches"]
    relevance: number | null
    status: "active" | "needs_review"
    created_at: string
  }>
  total: number
  page: number
  page_size: number
}

export async function listKeywordCompetitorGaps(
  projectId: string,
  page = 1,
  pageSize = 50
): Promise<{
  items: KeywordCompetitorGap[]
  total: number
  page: number
  pageSize: number
}> {
  const response = await apiRequest<KeywordCompetitorGapListResponse>(
    keywordPath(
      projectId,
      `/gaps?page=${encodeURIComponent(page)}&page_size=${encodeURIComponent(pageSize)}`
    )
  )
  return {
    items: response.items.map((item) => ({
      id: item.id,
      competitorDomain: item.competitor_domain,
      keyword: item.keyword,
      competitorRank: item.competitor_rank,
      searchVolume: item.search_volume,
      cpc: item.cpc,
      competition: item.competition,
      keywordDifficulty: item.keyword_difficulty,
      intent: item.intent,
      monthlySearches: item.monthly_searches,
      relevance: item.relevance,
      status: item.status,
      createdAt: item.created_at,
    })),
    total: response.total,
    page: response.page,
    pageSize: response.page_size,
  }
}

export async function updateKeywordStatus(
  projectId: string,
  keywordIds: string[],
  status: KeywordStatus
): Promise<number> {
  const response = await apiRequest<{ updated: number }>(
    keywordPath(projectId, "/status"),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword_ids: keywordIds, status }),
    }
  )
  return response.updated
}

export async function assignKeywordTags(
  projectId: string,
  keywordIds: string[],
  tagNames: string[]
): Promise<number> {
  const response = await apiRequest<{ updated: number }>(
    keywordPath(projectId, "/tags"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword_ids: keywordIds, tag_names: tagNames }),
    }
  )
  return response.updated
}
