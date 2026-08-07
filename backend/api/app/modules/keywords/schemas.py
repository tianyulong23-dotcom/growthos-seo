from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
KeywordCoverageStatus = Literal["covered", "uncovered", "unknown"]


class KeywordCoverageInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(min_length=1, max_length=100)
    keyword_id: str | None = Field(default=None, min_length=1, max_length=100)
    keyword: str = Field(min_length=1, max_length=200)

    @field_validator("request_id", "keyword_id", "keyword", mode="before")
    @classmethod
    def strip_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class KeywordCoverageBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(min_length=1, max_length=100)
    keywords: list[KeywordCoverageInput] = Field(min_length=1, max_length=100)

    @field_validator("project_id", mode="before")
    @classmethod
    def strip_project_id(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def require_unique_request_ids(self) -> "KeywordCoverageBatchRequest":
        request_ids = [item.request_id for item in self.keywords]
        if len(set(request_ids)) != len(request_ids):
            raise ValueError("request_id values must be unique")
        return self


class KeywordCoverageResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(min_length=1, max_length=100)
    normalized_keyword: str = Field(min_length=1, max_length=200)
    status: KeywordCoverageStatus
    relation_id: str | None = Field(default=None, min_length=1)
    covered_url: str | None = Field(default=None, min_length=1)

    @field_validator(
        "request_id",
        "normalized_keyword",
        "relation_id",
        "covered_url",
        mode="before",
    )
    @classmethod
    def strip_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def require_covered_evidence(self) -> "KeywordCoverageResult":
        if self.status == "covered" and not (self.relation_id or self.covered_url):
            raise ValueError("covered result requires relation_id or covered_url")
        return self


class KeywordCoverageBatchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    results: list[KeywordCoverageResult] = Field(max_length=100)


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
