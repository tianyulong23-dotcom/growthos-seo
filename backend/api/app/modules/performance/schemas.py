from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.modules.performance.domain import PerformanceStatus


DateRange = Literal[7, 28, 90]
PerformanceSort = Literal[
    "clicks",
    "impressions",
    "ctr",
    "position",
    "published_at",
    "updated_at",
    "change",
]
SortOrder = Literal["asc", "desc"]
PerformanceBacklinkView = Literal[
    "all",
    "placements",
    "candidate",
    "confirmed",
    "pending_verification",
    "active",
    "suspected_changed",
    "changed",
    "suspected_lost",
    "lost",
    "recovered",
]


class PerformanceMetrics(BaseModel):
    clicks: float = 0
    impressions: float = 0
    ctr: float = 0
    position: float = 0


class PerformanceMetricChange(BaseModel):
    clicks: float | None = None
    impressions: float | None = None
    ctr: float | None = None
    position: float | None = None


class PerformanceTrendPoint(PerformanceMetrics):
    date: date


class PerformanceSyncState(BaseModel):
    status: Literal["never", "running", "completed", "failed"] = "never"
    data_through: date | None = None
    synced_at: datetime | None = None
    error: str | None = None


class PerformanceArticleItem(BaseModel):
    article_id: str
    title: str
    url: str
    primary_keyword: str
    published_at: datetime
    last_published_at: datetime
    metrics: PerformanceMetrics
    previous_metrics: PerformanceMetrics
    change: PerformanceMetricChange
    status: PerformanceStatus
    signal_count: int = 0


class PerformanceArticleCollection(BaseModel):
    items: list[PerformanceArticleItem] = Field(default_factory=list)
    total: int = 0
    page: int = 1
    page_size: int = 25


class PerformanceOverview(BaseModel):
    gsc_connected: bool
    site_url: str | None = None
    date_range: DateRange
    range_start: date
    range_end: date
    previous_start: date
    previous_end: date
    metrics: PerformanceMetrics
    previous_metrics: PerformanceMetrics
    change: PerformanceMetricChange
    trend: list[PerformanceTrendPoint] = Field(default_factory=list)
    article_count: int = 0
    status_counts: dict[str, int] = Field(default_factory=dict)
    growing_articles: list[PerformanceArticleItem] = Field(default_factory=list)
    declining_articles: list[PerformanceArticleItem] = Field(default_factory=list)
    sync: PerformanceSyncState


class PerformanceQueryRow(PerformanceMetrics):
    query: str


class PerformancePublicationEvent(BaseModel):
    publication_id: str
    kind: Literal["published", "updated"]
    version_number: int | None = None
    occurred_at: datetime


class PerformanceUpdateComparison(BaseModel):
    updated_at: datetime
    before_start: date
    before_end: date
    after_start: date
    after_end: date
    before_metrics: PerformanceMetrics
    after_metrics: PerformanceMetrics
    change: PerformanceMetricChange
    observation_complete: bool


class PerformanceSignalResponse(BaseModel):
    id: str
    kind: str
    message: str
    status: Literal["open", "resolved"]
    detected_at: datetime


class PerformanceArticleDetail(BaseModel):
    article: PerformanceArticleItem
    trend: list[PerformanceTrendPoint] = Field(default_factory=list)
    queries: list[PerformanceQueryRow] = Field(default_factory=list)
    query_status: Literal["available", "empty", "unavailable"] = "empty"
    query_error: str | None = None
    publications: list[PerformancePublicationEvent] = Field(default_factory=list)
    signals: list[PerformanceSignalResponse] = Field(default_factory=list)
    update_comparison: PerformanceUpdateComparison | None = None
    data_through: date | None = None


class PerformanceSyncResponse(BaseModel):
    sync: PerformanceSyncState
    target_count: int


class PerformanceBacklinkContract(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PerformanceBacklinkFailure(PerformanceBacklinkContract):
    status: Literal["none", "failed"]
    code: str | None


class PerformanceBacklinkCandidate(PerformanceBacklinkContract):
    record_type: Literal["candidate"]
    display_state: Literal["candidate"]
    candidate_id: str
    opportunity_id: str | None
    reply_id: str | None
    lineage_status: Literal["OUTREACH_DERIVED", "UNATTRIBUTED"]
    source_page_url: str | None
    target_url: str
    candidate_status: str
    match_status: str
    validation_status: str
    evidence_source: Literal["DIRECT_VALIDATION"]
    version: int
    created_at: datetime
    counts_toward_kpi: Literal[False]


class PerformanceBacklinkPlacement(PerformanceBacklinkContract):
    record_type: Literal["placement"]
    display_state: Literal["confirmed", "changed", "lost", "recovered"]
    placement_id: str
    candidate_id: str
    opportunity_id: str | None
    reply_id: str | None
    lineage_status: Literal["OUTREACH_DERIVED", "UNATTRIBUTED"]
    source_page_url: str
    target_url: str
    initial_validation_status: str
    health_status: str
    monitoring_state: Literal[
        "pending_verification",
        "active",
        "suspected_changed",
        "changed",
        "suspected_lost",
        "lost",
    ]
    monitoring_status: str
    latest_observed_at: datetime | None
    last_successful_observation_at: datetime | None
    next_check_at: datetime | None
    freshness: Literal["fresh", "stale", "unknown"]
    latest_failure: PerformanceBacklinkFailure
    evidence_source: Literal["DIRECT_MONITOR"]
    version: int
    created_at: datetime
    counts_toward_kpi: Literal[True]


class PerformanceBacklinkPlacementSummary(PerformanceBacklinkContract):
    total: int
    pending_verification: int
    active: int
    suspected_changed: int
    changed: int
    suspected_lost: int
    lost: int
    recovered: int


class PerformanceBacklinkCandidateSummary(PerformanceBacklinkContract):
    total: int
    counts_toward_kpi: Literal[False]


class PerformanceBacklinkEvidenceSummary(PerformanceBacklinkContract):
    source: Literal["DIRECT_MONITOR"]
    data_cutoff: datetime | None
    freshness: Literal["fresh", "stale", "unknown"]
    last_successful_observation_at: datetime | None
    latest_attempt_at: datetime | None
    latest_attempt_status: Literal[
        "idle",
        "scheduled",
        "running",
        "retry_wait",
        "failed",
        "completed",
    ]
    latest_failure: PerformanceBacklinkFailure


class PerformanceBacklinkSummary(PerformanceBacklinkContract):
    placements: PerformanceBacklinkPlacementSummary
    candidates: PerformanceBacklinkCandidateSummary
    evidence: PerformanceBacklinkEvidenceSummary


class PerformanceBacklinkMeta(PerformanceBacklinkContract):
    organization_id: str
    workspace_id: str
    website_project_id: str
    request_id: str
    schema_version: Literal["backlinks.v1"]
    generated_at: datetime


class PerformanceBacklinksResponse(PerformanceBacklinkContract):
    items: list[PerformanceBacklinkCandidate | PerformanceBacklinkPlacement]
    next_cursor: str | None
    has_more: bool
    summary: PerformanceBacklinkSummary
    meta: PerformanceBacklinkMeta
