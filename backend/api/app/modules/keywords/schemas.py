from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field


KeywordRunStatus = Literal[
    "queued",
    "running",
    "waiting",
    "blocked",
    "partial",
    "completed",
    "failed",
    "cancelled",
]
KeywordMetricsStatus = Literal["pending", "fresh", "stale", "failed"]
KeywordStatus = Literal["active", "archived"]


class KeywordBuildRunResponse(BaseModel):
    run_id: str
    kind: Literal["initial", "expansion"]
    round_number: int = Field(ge=1)
    status: KeywordRunStatus
    stage: str
    message: str
    progress: int = Field(ge=0, le=100)
    discovered_count: int = Field(ge=0)
    selected_count: int = Field(ge=0)
    keyword_count: int = Field(ge=0)
    result_version: int = Field(ge=0)
    profile_source: str
    gap_status: str
    gap_message: str
    gap_count: int = Field(ge=0)
    partial_failures: list[dict | str] = Field(default_factory=list)
    error_code: str | None = None
    recovery_count: int = Field(default=0, ge=0)
    next_retry_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    elapsed_seconds: float = Field(ge=0)


class KeywordLibraryStatusResponse(BaseModel):
    run: KeywordBuildRunResponse | None
    total_keywords: int = Field(ge=0)
    active_keywords: int = Field(ge=0)
    pending_metrics_count: int = Field(default=0, ge=0)
    result_version: int = Field(ge=0)


class KeywordOperationalHealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    worker_healthy: bool
    worker_last_seen_at: datetime | None = None
    active_runs: int = Field(ge=0)
    waiting_runs: int = Field(ge=0)
    blocked_runs: int = Field(ge=0)
    stale_prepared_requests: int = Field(ge=0)
    uncertain_requests: int = Field(ge=0)
    charged_failed_requests: int = Field(ge=0)
    metric_refresh_waiting: int = Field(ge=0)
    metric_refresh_running: int = Field(ge=0)
    metric_refresh_exhausted: int = Field(ge=0)
    failed_metrics: int = Field(ge=0)


class KeywordCostSummaryResponse(BaseModel):
    request_count: int = Field(ge=0)
    dataforseo_cost_usd: float = Field(ge=0)
    ai_reported_cost_usd: float = Field(ge=0)
    total_reported_cost_usd: float = Field(ge=0)
    ai_input_tokens: int = Field(ge=0)
    ai_output_tokens: int = Field(ge=0)
    ai_cost_complete: bool


class KeywordExternalIssueResponse(BaseModel):
    id: int
    provider: str
    endpoint: str
    status: Literal["uncertain", "charged_failed", "completed"]
    error_code: str | None = None
    error_detail: str | None = None
    cost_usd: float = Field(ge=0)
    started_at: datetime
    finished_at: datetime | None = None


class KeywordExternalIssueListResponse(BaseModel):
    items: list[KeywordExternalIssueResponse] = Field(default_factory=list)


class KeywordTagResponse(BaseModel):
    id: str
    name: str
    color: str | None = None


class KeywordListItemResponse(BaseModel):
    id: str
    keyword: str
    primary_seed: str | None = None
    business_topic: str | None = None
    classification_confidence: float | None = Field(default=None, ge=0, le=1)
    review_status: Literal["approved", "needs_review"]
    intent: str | None = None
    search_volume: int | None = None
    cpc: float | None = None
    competition: float | None = None
    competition_level: str | None = None
    keyword_difficulty: int | None = None
    monthly_searches: list[dict] = Field(default_factory=list)
    priority_score: float | None = None
    priority_confidence: float | None = None
    priority_details: dict = Field(default_factory=dict)
    sources: list[str] = Field(default_factory=list)
    tags: list[KeywordTagResponse] = Field(default_factory=list)
    status: KeywordStatus
    metrics_status: KeywordMetricsStatus
    metrics_updated_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class KeywordListResponse(BaseModel):
    items: list[KeywordListItemResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
    result_version: int = Field(ge=0)


class KeywordBatchStatusRequest(BaseModel):
    keyword_ids: list[str] = Field(min_length=1, max_length=700)
    status: KeywordStatus


class KeywordBatchStatusResponse(BaseModel):
    updated: int = Field(ge=0)


class KeywordTagAssignmentRequest(BaseModel):
    keyword_ids: list[str] = Field(min_length=1, max_length=700)
    tag_names: list[str] = Field(default_factory=list, max_length=20)


class KeywordTagAssignmentResponse(BaseModel):
    updated: int = Field(ge=0)
    tags: list[KeywordTagResponse] = Field(default_factory=list)


class KeywordCompetitorGapItemResponse(BaseModel):
    id: str
    competitor_domain: str
    keyword: str
    competitor_rank: int | None = None
    search_volume: int | None = None
    cpc: float | None = None
    competition: float | None = None
    keyword_difficulty: int | None = None
    intent: str | None = None
    monthly_searches: list[dict] = Field(default_factory=list)
    relevance: float | None = Field(default=None, ge=0, le=1)
    status: Literal["active", "needs_review"]
    created_at: datetime


class KeywordCompetitorGapListResponse(BaseModel):
    items: list[KeywordCompetitorGapItemResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)


KeywordCompetitorAnalysisStatus = Literal["queued", "running", "partial", "completed", "failed"]


class KeywordCompetitorLocalMarket(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    radius_km: float = Field(default=10, ge=1, le=100000)
    zoom: int = Field(default=12, ge=4, le=18)
    search_type: Literal["maps", "local_finder"] = "maps"
    device: Literal["desktop", "mobile"] = "desktop"
    depth: int = Field(default=20, ge=1, le=100)
    business_query: str | None = Field(default=None, min_length=1, max_length=200)
    categories: list[Annotated[str, Field(min_length=1, max_length=120)]] = Field(
        default_factory=list,
        max_length=10,
    )
    include_questions: bool = False
    questions_keyword: str | None = Field(default=None, min_length=1, max_length=200)
    questions_depth: int = Field(default=20, ge=1, le=100)


class KeywordCompetitorAnalysisRequest(BaseModel):
    mode: Literal["manual", "auto"]
    competitor_domains: list[str] = Field(default_factory=list, max_length=5)
    local_market: KeywordCompetitorLocalMarket | None = None


class KeywordCompetitorAnalysisRunResponse(BaseModel):
    run_id: str
    target_domain: str
    country: str
    language: str
    mode: Literal["manual", "auto"]
    requested_competitor_domains: list[str] = Field(default_factory=list)
    discovery_method: Literal["manual", "serp_competitors"]
    discovery_keywords: list[str] = Field(default_factory=list)
    discovery_result_types: list[Literal["organic", "paid", "featured_snippet", "local_pack"]] = (
        Field(default_factory=list)
    )
    discovery_include_subdomains: bool | None = None
    discovery_sort: Literal["visibility", "traffic_estimate", "avg_position", "keyword_count"]
    discovery_limit: int = Field(ge=1, le=100)
    discovery_offset: int = Field(ge=0, le=1000)
    gsc_query_evidence: list[dict] = Field(default_factory=list)
    query_metrics: list[dict] = Field(default_factory=list)
    serp_snapshots: list[dict] = Field(default_factory=list)
    cost_breakdown: dict[str, float] = Field(default_factory=dict)
    landscape_summary: dict = Field(default_factory=dict)
    directional_result: bool = False
    market_summary: str | None = None
    local_market: dict = Field(default_factory=dict)
    status: KeywordCompetitorAnalysisStatus
    stage: str
    message: str
    progress: int = Field(ge=0, le=100)
    competitor_limit: int = Field(ge=1, le=5)
    keyword_limit: int = Field(ge=1, le=100)
    discovered_count: int = Field(ge=0)
    analyzed_competitor_count: int = Field(ge=0)
    completed_competitors: int = Field(ge=0)
    failed_competitors: int = Field(ge=0)
    raw_keyword_count: int = Field(ge=0)
    unique_keyword_count: int = Field(ge=0)
    discovery_cost_usd: float = Field(ge=0)
    total_cost_usd: float = Field(ge=0)
    error_code: str | None = None
    recovery_count: int = Field(ge=0)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    created_at: datetime


class KeywordCompetitorAnalysisRunSummaryResponse(BaseModel):
    run_id: str
    mode: Literal["manual", "auto"]
    status: KeywordCompetitorAnalysisStatus
    discovered_count: int = Field(ge=0)
    analyzed_competitor_count: int = Field(ge=0)
    completed_competitors: int = Field(ge=0)
    unique_keyword_count: int = Field(ge=0)
    total_cost_usd: float = Field(ge=0)
    created_at: datetime


class KeywordCompetitorResponse(BaseModel):
    id: str
    domain: str
    provider_rank: int = Field(ge=1)
    avg_position: float | None = None
    median_position: float | None = None
    rating: float | None = None
    etv: float | None = None
    keywords_count: int | None = Field(default=None, ge=0)
    visibility: float | None = None
    relevant_serp_items: int | None = Field(default=None, ge=0)
    keywords_positions: dict = Field(default_factory=dict)
    domain_type: Literal[
        "direct_product_competitor",
        "publisher_media",
        "marketplace_directory",
        "community_forum",
        "documentation_resource",
    ]
    is_seo_competitor: bool
    is_business_competitor: bool
    classification_confidence: float | None = Field(default=None, ge=0, le=1)
    why_they_matter: str | None = None
    serp_evidence: list[dict] = Field(default_factory=list)
    domain_overview: dict = Field(default_factory=dict)
    ranked_keywords_evidence: list[dict] = Field(default_factory=list)
    ranked_keywords_evidence_count: int = Field(default=0, ge=0)
    ranked_keywords_checked: bool = False
    backlinks_evidence: dict = Field(default_factory=dict)
    selected_for_gap: bool
    site_check_status: Literal[
        "not_checked",
        "verified",
        "redirected_related",
        "redirected_unrelated",
        "unverified_redirect",
        "blocked",
        "temporarily_unavailable",
        "permanently_unavailable",
        "non_html",
        "unsafe_target",
        "redirect_loop",
        "platform_or_login",
    ]
    site_relation: Literal["related", "unrelated", "uncertain"]
    site_verification: dict = Field(default_factory=dict)
    intersections: int | None = Field(default=None, ge=0)
    organic_keywords: int | None = Field(default=None, ge=0)
    organic_traffic: float | None = Field(default=None, ge=0)
    status: Literal["pending", "running", "completed", "failed", "excluded"]
    keyword_count: int = Field(ge=0)
    cost_usd: float = Field(ge=0)
    error_code: str | None = None
    error_detail: str | None = None


class KeywordCompetitorListResponse(BaseModel):
    run_id: str | None = None
    items: list[KeywordCompetitorResponse] = Field(default_factory=list)


class KeywordCompetitorRankingResponse(BaseModel):
    competitor_id: str
    domain: str
    rank: int | None = None
    url: str | None = None


class KeywordCompetitorOpportunityResponse(BaseModel):
    id: str
    keyword: str
    normalized_keyword: str
    best_competitor_rank: int | None = None
    competitor_count: int = Field(ge=0)
    opportunity_score: float | None = Field(default=None, ge=0, le=100)
    search_volume: int | None = None
    cpc: float | None = None
    competition: float | None = None
    competition_level: str | None = None
    keyword_difficulty: int | None = None
    intent: str | None = None
    monthly_searches: list[dict] = Field(default_factory=list)
    metrics_fetched_at: datetime
    status: Literal["new", "accepted", "dismissed"]
    keyword_id: str | None = None
    in_library: bool
    analyzed_at: datetime
    updated_at: datetime
    rankings: list[KeywordCompetitorRankingResponse] = Field(default_factory=list)


class KeywordCompetitorOpportunityListResponse(BaseModel):
    run_id: str | None = None
    analyzed_at: datetime | None = None
    items: list[KeywordCompetitorOpportunityResponse] = Field(default_factory=list)
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)


class KeywordCompetitorAnalysisRunListResponse(BaseModel):
    items: list[KeywordCompetitorAnalysisRunSummaryResponse] = Field(default_factory=list)


class KeywordCompetitorOpportunityBatchRequest(BaseModel):
    opportunity_ids: list[str] = Field(min_length=1, max_length=100)
    action: Literal["accept", "dismiss", "restore"]


class KeywordCompetitorOpportunityBatchResponse(BaseModel):
    updated: int = Field(ge=0)
    added_to_library: int = Field(ge=0)
    already_in_library: int = Field(ge=0)
