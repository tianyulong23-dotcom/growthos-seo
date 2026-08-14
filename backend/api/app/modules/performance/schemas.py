from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

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
