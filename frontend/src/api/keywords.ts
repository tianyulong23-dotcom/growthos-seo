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
  competitionLevel: string | null
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
  competition_level: string | null
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
    competitionLevel: item.competition_level,
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

export type CompetitorAnalysisStatus =
  "queued" | "running" | "partial" | "completed" | "failed"

export type CompetitorLocalMarket = {
  latitude: number
  longitude: number
  radiusKm: number
  zoom: number
  searchType: "maps" | "local_finder"
  device: "desktop" | "mobile"
  depth: number
  businessQuery?: string
  categories: string[]
  includeQuestions: boolean
  questionsKeyword?: string
  questionsDepth: number
}

export type CompetitorAnalysisRun = {
  runId: string
  targetDomain: string
  country: string
  language: string
  mode: "manual" | "auto"
  requestedCompetitorDomains: string[]
  discoveryMethod: "manual" | "serp_competitors"
  discoveryKeywords: string[]
  discoveryResultTypes: Array<
    "organic" | "paid" | "featured_snippet" | "local_pack"
  >
  discoveryIncludeSubdomains: boolean | null
  discoverySort:
    "visibility" | "traffic_estimate" | "avg_position" | "keyword_count"
  discoveryLimit: number
  discoveryOffset: number
  gscQueryEvidence: Array<Record<string, unknown>>
  queryMetrics: Array<Record<string, unknown>>
  serpSnapshots: Array<Record<string, unknown>>
  costBreakdown: Record<string, number>
  landscapeSummary: Record<string, unknown>
  directionalResult: boolean
  marketSummary: string | null
  localMarket: CompetitorLocalMarket | null
  status: CompetitorAnalysisStatus
  stage: string
  message: string
  progress: number
  competitorLimit: number
  keywordLimit: number
  discoveredCount: number
  analyzedCompetitorCount: number
  completedCompetitors: number
  failedCompetitors: number
  rawKeywordCount: number
  uniqueKeywordCount: number
  discoveryCostUsd: number
  totalCostUsd: number
  errorCode: string | null
  recoveryCount: number
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export type CompetitorAnalysisRunSummary = Pick<
  CompetitorAnalysisRun,
  | "runId"
  | "mode"
  | "status"
  | "discoveredCount"
  | "analyzedCompetitorCount"
  | "completedCompetitors"
  | "uniqueKeywordCount"
  | "totalCostUsd"
  | "createdAt"
>

type CompetitorAnalysisRunResponse = {
  run_id: string
  target_domain: string
  country: string
  language: string
  mode: "manual" | "auto"
  requested_competitor_domains: string[]
  discovery_method: "manual" | "serp_competitors"
  discovery_keywords: string[]
  discovery_result_types: Array<
    "organic" | "paid" | "featured_snippet" | "local_pack"
  >
  discovery_include_subdomains: boolean | null
  discovery_sort:
    "visibility" | "traffic_estimate" | "avg_position" | "keyword_count"
  discovery_limit: number
  discovery_offset: number
  gsc_query_evidence: Array<Record<string, unknown>>
  query_metrics: Array<Record<string, unknown>>
  serp_snapshots: Array<Record<string, unknown>>
  cost_breakdown: Record<string, number>
  landscape_summary: Record<string, unknown>
  directional_result: boolean
  market_summary: string | null
  local_market: {
    latitude?: number
    longitude?: number
    radius_km?: number
    zoom?: number
    search_type?: "maps" | "local_finder"
    device?: "desktop" | "mobile"
    depth?: number
    business_query?: string
    categories?: string[]
    include_questions?: boolean
    questions_keyword?: string
    questions_depth?: number
  }
  status: CompetitorAnalysisStatus
  stage: string
  message: string
  progress: number
  competitor_limit: number
  keyword_limit: number
  discovered_count: number
  analyzed_competitor_count: number
  completed_competitors: number
  failed_competitors: number
  raw_keyword_count: number
  unique_keyword_count: number
  discovery_cost_usd: number
  total_cost_usd: number
  error_code: string | null
  recovery_count: number
  started_at: string | null
  finished_at: string | null
  created_at: string
}

export type KeywordCompetitor = {
  id: string
  domain: string
  providerRank: number
  avgPosition: number | null
  medianPosition: number | null
  rating: number | null
  etv: number | null
  keywordsCount: number | null
  visibility: number | null
  relevantSerpItems: number | null
  keywordsPositions: Record<string, unknown>
  domainType:
    | "direct_product_competitor"
    | "publisher_media"
    | "marketplace_directory"
    | "community_forum"
    | "documentation_resource"
  isSeoCompetitor: boolean
  isBusinessCompetitor: boolean
  classificationConfidence: number | null
  whyTheyMatter: string | null
  serpEvidence: Array<Record<string, unknown>>
  domainOverview: Record<string, unknown>
  rankedKeywordsEvidence: Array<Record<string, unknown>>
  rankedKeywordsEvidenceCount: number
  rankedKeywordsChecked: boolean
  backlinksEvidence: Record<string, unknown>
  selectedForGap: boolean
  siteCheckStatus:
    | "not_checked"
    | "verified"
    | "redirected_related"
    | "redirected_unrelated"
    | "unverified_redirect"
    | "blocked"
    | "temporarily_unavailable"
    | "permanently_unavailable"
    | "non_html"
    | "unsafe_target"
    | "redirect_loop"
    | "platform_or_login"
  siteRelation: "related" | "unrelated" | "uncertain"
  siteVerification: Record<string, unknown>
  intersections: number | null
  organicKeywords: number | null
  organicTraffic: number | null
  status: "pending" | "running" | "completed" | "failed" | "excluded"
  keywordCount: number
  costUsd: number
  errorCode: string | null
  errorDetail: string | null
}

export type CompetitorOpportunityStatus = "new" | "accepted" | "dismissed"

export type KeywordCompetitorOpportunity = {
  id: string
  keyword: string
  normalizedKeyword: string
  bestCompetitorRank: number | null
  competitorCount: number
  opportunityScore: number | null
  searchVolume: number | null
  cpc: number | null
  competition: number | null
  competitionLevel: string | null
  keywordDifficulty: number | null
  intent: string | null
  monthlySearches: KeywordListItem["monthlySearches"]
  metricsFetchedAt: string
  status: CompetitorOpportunityStatus
  keywordId: string | null
  inLibrary: boolean
  analyzedAt: string
  updatedAt: string
  rankings: Array<{
    competitorId: string
    domain: string
    rank: number | null
    url: string | null
  }>
}

export type CompetitorOpportunityQuery = {
  page?: number
  pageSize?: number
  search?: string
  competitorDomain?: string
  intent?: string
  status?: CompetitorOpportunityStatus | "all"
  minVolume?: number
  maxDifficulty?: number
  inLibrary?: boolean
  sort?:
    | "keyword"
    | "opportunity_score"
    | "search_volume"
    | "difficulty"
    | "best_rank"
    | "competitor_count"
    | "updated_at"
  order?: "asc" | "desc"
}

function mapCompetitorRun(
  run: CompetitorAnalysisRunResponse
): CompetitorAnalysisRun {
  const localMarket =
    typeof run.local_market?.latitude === "number" &&
    typeof run.local_market?.longitude === "number"
      ? {
          latitude: run.local_market.latitude,
          longitude: run.local_market.longitude,
          radiusKm: run.local_market.radius_km ?? 10,
          zoom: run.local_market.zoom ?? 12,
          searchType: run.local_market.search_type ?? "maps",
          device: run.local_market.device ?? "desktop",
          depth: run.local_market.depth ?? 20,
          businessQuery: run.local_market.business_query,
          categories: run.local_market.categories ?? [],
          includeQuestions: run.local_market.include_questions ?? false,
          questionsKeyword: run.local_market.questions_keyword,
          questionsDepth: run.local_market.questions_depth ?? 20,
        }
      : null
  return {
    runId: run.run_id,
    targetDomain: run.target_domain,
    country: run.country,
    language: run.language,
    mode: run.mode,
    requestedCompetitorDomains: run.requested_competitor_domains,
    discoveryMethod: run.discovery_method,
    discoveryKeywords: run.discovery_keywords,
    discoveryResultTypes: run.discovery_result_types,
    discoveryIncludeSubdomains: run.discovery_include_subdomains,
    discoverySort: run.discovery_sort,
    discoveryLimit: run.discovery_limit,
    discoveryOffset: run.discovery_offset,
    gscQueryEvidence: run.gsc_query_evidence,
    queryMetrics: run.query_metrics,
    serpSnapshots: run.serp_snapshots,
    costBreakdown: run.cost_breakdown,
    landscapeSummary: run.landscape_summary,
    directionalResult: run.directional_result,
    marketSummary: run.market_summary,
    localMarket,
    status: run.status,
    stage: run.stage,
    message: run.message,
    progress: run.progress,
    competitorLimit: run.competitor_limit,
    keywordLimit: run.keyword_limit,
    discoveredCount: run.discovered_count,
    analyzedCompetitorCount: run.analyzed_competitor_count,
    completedCompetitors: run.completed_competitors,
    failedCompetitors: run.failed_competitors,
    rawKeywordCount: run.raw_keyword_count,
    uniqueKeywordCount: run.unique_keyword_count,
    discoveryCostUsd: run.discovery_cost_usd,
    totalCostUsd: run.total_cost_usd,
    errorCode: run.error_code,
    recoveryCount: run.recovery_count,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    createdAt: run.created_at,
  }
}

export async function startCompetitorAnalysis(
  projectId: string,
  input: {
    mode: "manual" | "auto"
    competitorDomains?: string[]
    localMarket?: CompetitorLocalMarket
  }
): Promise<CompetitorAnalysisRun> {
  return mapCompetitorRun(
    await apiRequest<CompetitorAnalysisRunResponse>(
      keywordPath(projectId, "/competitor-analysis"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: input.mode,
          competitor_domains: input.competitorDomains ?? [],
          local_market: input.localMarket
            ? {
                latitude: input.localMarket.latitude,
                longitude: input.localMarket.longitude,
                radius_km: input.localMarket.radiusKm,
                zoom: input.localMarket.zoom,
                search_type: input.localMarket.searchType,
                device: input.localMarket.device,
                depth: input.localMarket.depth,
                business_query: input.localMarket.businessQuery,
                categories: input.localMarket.categories,
                include_questions: input.localMarket.includeQuestions,
                questions_keyword: input.localMarket.questionsKeyword,
                questions_depth: input.localMarket.questionsDepth,
              }
            : null,
        }),
      }
    )
  )
}

export async function getCompetitorAnalysisStatus(
  projectId: string
): Promise<CompetitorAnalysisRun | null> {
  const response = await apiRequest<CompetitorAnalysisRunResponse | null>(
    keywordPath(projectId, "/competitor-analysis/status")
  )
  return response ? mapCompetitorRun(response) : null
}

export async function listCompetitorAnalysisRuns(
  projectId: string,
  limit = 10
): Promise<CompetitorAnalysisRunSummary[]> {
  const response = await apiRequest<{
    items: Array<{
      run_id: string
      mode: "manual" | "auto"
      status: CompetitorAnalysisStatus
      discovered_count: number
      analyzed_competitor_count: number
      completed_competitors: number
      unique_keyword_count: number
      total_cost_usd: number
      created_at: string
    }>
  }>(keywordPath(projectId, `/competitor-analysis/runs?limit=${limit}`))
  return response.items.map((run) => ({
    runId: run.run_id,
    mode: run.mode,
    status: run.status,
    discoveredCount: run.discovered_count,
    analyzedCompetitorCount: run.analyzed_competitor_count,
    completedCompetitors: run.completed_competitors,
    uniqueKeywordCount: run.unique_keyword_count,
    totalCostUsd: run.total_cost_usd,
    createdAt: run.created_at,
  }))
}

export async function listKeywordCompetitors(
  projectId: string
): Promise<{ runId: string | null; items: KeywordCompetitor[] }> {
  const response = await apiRequest<{
    run_id: string | null
    items: Array<{
      id: string
      domain: string
      provider_rank: number
      avg_position: number | null
      median_position: number | null
      rating: number | null
      etv: number | null
      keywords_count: number | null
      visibility: number | null
      relevant_serp_items: number | null
      keywords_positions?: Record<string, unknown>
      domain_type: KeywordCompetitor["domainType"]
      is_seo_competitor: boolean
      is_business_competitor: boolean
      classification_confidence: number | null
      why_they_matter: string | null
      serp_evidence?: Array<Record<string, unknown>>
      domain_overview: Record<string, unknown>
      ranked_keywords_evidence?: Array<Record<string, unknown>>
      ranked_keywords_evidence_count?: number
      ranked_keywords_checked: boolean
      backlinks_evidence?: Record<string, unknown>
      selected_for_gap: boolean
      site_check_status: KeywordCompetitor["siteCheckStatus"]
      site_relation: KeywordCompetitor["siteRelation"]
      site_verification: Record<string, unknown>
      intersections: number | null
      organic_keywords: number | null
      organic_traffic: number | null
      status: KeywordCompetitor["status"]
      keyword_count: number
      cost_usd: number
      error_code: string | null
      error_detail: string | null
    }>
  }>(keywordPath(projectId, "/competitor-analysis/competitors"))
  return {
    runId: response.run_id,
    items: response.items.map((item) => ({
      id: item.id,
      domain: item.domain,
      providerRank: item.provider_rank,
      avgPosition: item.avg_position,
      medianPosition: item.median_position,
      rating: item.rating,
      etv: item.etv,
      keywordsCount: item.keywords_count,
      visibility: item.visibility,
      relevantSerpItems: item.relevant_serp_items,
      keywordsPositions: item.keywords_positions ?? {},
      domainType: item.domain_type,
      isSeoCompetitor: item.is_seo_competitor,
      isBusinessCompetitor: item.is_business_competitor,
      classificationConfidence: item.classification_confidence,
      whyTheyMatter: item.why_they_matter,
      serpEvidence: item.serp_evidence ?? [],
      domainOverview: item.domain_overview,
      rankedKeywordsEvidence: item.ranked_keywords_evidence ?? [],
      rankedKeywordsEvidenceCount:
        item.ranked_keywords_evidence_count ??
        item.ranked_keywords_evidence?.length ??
        0,
      rankedKeywordsChecked: item.ranked_keywords_checked,
      backlinksEvidence: item.backlinks_evidence ?? {},
      selectedForGap: item.selected_for_gap,
      siteCheckStatus: item.site_check_status,
      siteRelation: item.site_relation,
      siteVerification: item.site_verification,
      intersections: item.intersections,
      organicKeywords: item.organic_keywords,
      organicTraffic: item.organic_traffic,
      status: item.status,
      keywordCount: item.keyword_count,
      costUsd: item.cost_usd,
      errorCode: item.error_code,
      errorDetail: item.error_detail,
    })),
  }
}

export async function listKeywordCompetitorOpportunities(
  projectId: string,
  query: CompetitorOpportunityQuery = {}
): Promise<{
  runId: string | null
  analyzedAt: string | null
  items: KeywordCompetitorOpportunity[]
  total: number
  page: number
  pageSize: number
}> {
  const params = new URLSearchParams()
  params.set("page", String(query.page ?? 1))
  params.set("page_size", String(query.pageSize ?? 50))
  if (query.search?.trim()) params.set("search", query.search.trim())
  if (query.competitorDomain)
    params.set("competitor_domain", query.competitorDomain)
  if (query.intent) params.set("intent", query.intent)
  if (query.status) params.set("opportunity_status", query.status)
  if (query.minVolume !== undefined)
    params.set("min_volume", String(query.minVolume))
  if (query.maxDifficulty !== undefined) {
    params.set("max_difficulty", String(query.maxDifficulty))
  }
  if (query.inLibrary !== undefined)
    params.set("in_library", String(query.inLibrary))
  if (query.sort) params.set("sort", query.sort)
  if (query.order) params.set("order", query.order)
  const response = await apiRequest<{
    run_id: string | null
    analyzed_at: string | null
    items: Array<{
      id: string
      keyword: string
      normalized_keyword: string
      best_competitor_rank: number | null
      competitor_count: number
      opportunity_score: number | null
      search_volume: number | null
      cpc: number | null
      competition: number | null
      competition_level: string | null
      keyword_difficulty: number | null
      intent: string | null
      monthly_searches: KeywordListItem["monthlySearches"]
      metrics_fetched_at: string
      status: CompetitorOpportunityStatus
      keyword_id: string | null
      in_library: boolean
      analyzed_at: string
      updated_at: string
      rankings: Array<{
        competitor_id: string
        domain: string
        rank: number | null
        url: string | null
      }>
    }>
    total: number
    page: number
    page_size: number
  }>(
    `${keywordPath(projectId, "/competitor-analysis/opportunities")}?${params}`
  )
  return {
    runId: response.run_id,
    analyzedAt: response.analyzed_at,
    items: response.items.map((item) => ({
      id: item.id,
      keyword: item.keyword,
      normalizedKeyword: item.normalized_keyword,
      bestCompetitorRank: item.best_competitor_rank,
      competitorCount: item.competitor_count,
      opportunityScore: item.opportunity_score,
      searchVolume: item.search_volume,
      cpc: item.cpc,
      competition: item.competition,
      competitionLevel: item.competition_level,
      keywordDifficulty: item.keyword_difficulty,
      intent: item.intent,
      monthlySearches: item.monthly_searches,
      metricsFetchedAt: item.metrics_fetched_at,
      status: item.status,
      keywordId: item.keyword_id,
      inLibrary: item.in_library,
      analyzedAt: item.analyzed_at,
      updatedAt: item.updated_at,
      rankings: item.rankings.map((ranking) => ({
        competitorId: ranking.competitor_id,
        domain: ranking.domain,
        rank: ranking.rank,
        url: ranking.url,
      })),
    })),
    total: response.total,
    page: response.page,
    pageSize: response.page_size,
  }
}

export async function updateCompetitorOpportunities(
  projectId: string,
  opportunityIds: string[],
  action: "accept" | "dismiss" | "restore"
): Promise<{
  updated: number
  addedToLibrary: number
  alreadyInLibrary: number
}> {
  const response = await apiRequest<{
    updated: number
    added_to_library: number
    already_in_library: number
  }>(keywordPath(projectId, "/competitor-analysis/opportunities"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ opportunity_ids: opportunityIds, action }),
  })
  return {
    updated: response.updated,
    addedToLibrary: response.added_to_library,
    alreadyInLibrary: response.already_in_library,
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

export async function saveGSCKeywords(
  projectId: string,
  keywords: string[]
): Promise<{
  saved: number
  addedToLibrary: number
  alreadyInLibrary: number
}> {
  const response = await apiRequest<{
    saved: number
    added_to_library: number
    already_in_library: number
  }>(keywordPath(projectId, "/gsc"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keywords }),
  })
  return {
    saved: response.saved,
    addedToLibrary: response.added_to_library,
    alreadyInLibrary: response.already_in_library,
  }
}
