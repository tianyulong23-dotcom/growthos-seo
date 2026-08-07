from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


ArticleStatus = Literal[
    "queued", "running", "completed", "completed_with_warnings", "cancelled"
]
ArticlePublicationStatus = Literal["publish_ready", "complete_draft"]
ArticleReviewStatus = Literal["pending_review", "approved", "changes_requested"]


class CreateArticleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    primary_keyword: str = Field(min_length=1, max_length=200)

    @field_validator("primary_keyword", mode="before")
    @classmethod
    def normalize_keyword(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class ContentPlanSecondaryKeyword(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyword: str = Field(min_length=1, max_length=200)
    type: Literal["informational", "service", "product", "unknown"]

    @field_validator("keyword", mode="before")
    @classmethod
    def normalize_keyword(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class ContentPlanPolicyValue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str = Field(min_length=1)
    policy: Literal["suggested", "locked"]

    @field_validator("value", mode="before")
    @classmethod
    def strip_value(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class ContentPlanArticleCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan_item_id: str = Field(min_length=1, max_length=100)
    plan_item_version: int = Field(ge=1)
    project_id: str = Field(min_length=1, max_length=100)
    primary_keyword: str = Field(min_length=1, max_length=200)
    secondary_keywords: list[ContentPlanSecondaryKeyword] = Field(max_length=8)
    title: ContentPlanPolicyValue
    writing_direction: ContentPlanPolicyValue
    serp_snapshot_id: str = Field(min_length=1, max_length=100)
    serp_snapshot_generated_at: datetime
    country: str = Field(min_length=2, max_length=2)
    language: str = Field(min_length=2, max_length=20)
    planned_publish_at: datetime

    @field_validator(
        "plan_item_id",
        "project_id",
        "primary_keyword",
        "serp_snapshot_id",
        "country",
        "language",
        mode="before",
    )
    @classmethod
    def strip_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("serp_snapshot_generated_at", "planned_publish_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("datetime must include a timezone")
        return value

    @property
    def article_idempotency_key(self) -> str:
        return f"content-plan:{self.plan_item_id}:article"

    @property
    def run_idempotency_key(self) -> str:
        return f"content-plan:{self.plan_item_id}:v{self.plan_item_version}:run"


class ArticleRunResponse(BaseModel):
    id: str
    article_id: str
    status: ArticleStatus
    stage: str
    progress: int
    warnings: list = Field(default_factory=list)
    started_at: datetime | None
    soft_deadline_at: datetime | None
    hard_deadline_at: datetime | None
    finished_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ArticleResponse(BaseModel):
    id: str
    project_id: str
    primary_keyword: str
    title: str | None
    slug: str | None
    meta_title: str | None
    meta_description: str | None
    status: ArticleStatus
    publication_status: ArticlePublicationStatus
    review_status: ArticleReviewStatus | None
    review_version: int
    publication_blocked_reason: str | None
    warning_count: int
    run: ArticleRunResponse | None
    created_at: datetime
    updated_at: datetime


class ArticleSourceResponse(BaseModel):
    source_type: str
    url: str
    title: str | None
    domain: str | None


class ArticleDetailResponse(ArticleResponse):
    outline: dict = Field(default_factory=dict)
    markdown: str | None
    html: str | None
    external_sources: list[ArticleSourceResponse] = Field(default_factory=list)
    internal_links: list[ArticleSourceResponse] = Field(default_factory=list)


class ArticleCollection(BaseModel):
    items: list[ArticleResponse]
    total: int
    page: int
    page_size: int


class ReviewArticleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    review_status: Literal["approved", "changes_requested"]
    review_note: str | None = Field(default=None, max_length=2000)
    review_version: int = Field(ge=1)

    @field_validator("review_note", mode="before")
    @classmethod
    def strip_review_note(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value
