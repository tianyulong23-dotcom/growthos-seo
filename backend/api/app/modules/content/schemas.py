from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


ArticleStatus = Literal[
    "queued", "running", "completed", "completed_with_warnings", "cancelled"
]
ArticlePublicationStatus = Literal["publish_ready", "complete_draft"]


class CreateArticleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    primary_keyword: str = Field(min_length=1, max_length=200)

    @field_validator("primary_keyword", mode="before")
    @classmethod
    def normalize_keyword(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


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
