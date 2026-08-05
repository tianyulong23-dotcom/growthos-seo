from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class CreateProjectRequest(BaseModel):
    domain: str = Field(min_length=1, max_length=253)
    country: str = Field(min_length=1, max_length=100)
    language: str = Field(min_length=1, max_length=100)
    competitor_domain: str | None = Field(default=None, max_length=253)

    @field_validator("domain", "country", "language")
    @classmethod
    def clean_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("competitor_domain")
    @classmethod
    def clean_optional_domain(cls, value: str | None) -> str | None:
        cleaned = value.strip() if value is not None else ""
        return cleaned or None


class UpdateBusinessProfileRequest(BaseModel):
    business_name: str = Field(min_length=1, max_length=200)
    business_type: str = Field(min_length=1, max_length=200)
    business_summary: str = Field(default="", max_length=10_000)
    target_audiences: list[str] = Field(default_factory=list, max_length=100)
    products_services: list[str] = Field(default_factory=list, max_length=100)
    value_propositions: list[str] = Field(default_factory=list, max_length=100)
    ai_content_rules: str = Field(default="", max_length=10_000)

    @field_validator(
        "business_name",
        "business_type",
        "business_summary",
        "ai_content_rules",
    )
    @classmethod
    def clean_profile_text(cls, value: str) -> str:
        return value.strip()

    @field_validator(
        "target_audiences",
        "products_services",
        "value_propositions",
    )
    @classmethod
    def clean_profile_items(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(value.strip() for value in values if value.strip()))


class SiteProfileKeyPage(BaseModel):
    url: str
    title: str
    description: str = ""


class SiteProfileEvidence(BaseModel):
    field: str
    value: str
    source_url: str
    quote: str = ""


class SiteProfileResponse(BaseModel):
    profile_version: int = 1
    extraction_method: str = ""
    source_page_count: int = Field(default=0, ge=0)
    favicon_url: str = ""
    business_name: str
    business_type: str
    business_summary: str
    products_services: list[str] = Field(default_factory=list)
    target_audiences: list[str] = Field(default_factory=list)
    value_propositions: list[str] = Field(default_factory=list)
    use_cases: list[str] = Field(default_factory=list)
    target_markets: list[str] = Field(default_factory=list)
    languages: list[str] = Field(default_factory=list)
    content_topics: list[str] = Field(default_factory=list)
    conversion_actions: list[str] = Field(default_factory=list)
    key_pages: list[SiteProfileKeyPage] = Field(default_factory=list)
    evidence: list[SiteProfileEvidence] = Field(default_factory=list)
    user_overridden_fields: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)
    ai_content_rules: str = ""
    confirmed_at: datetime | None = None


class BusinessProfileRunResponse(BaseModel):
    run_id: str
    attempt: int = Field(ge=1)
    status: Literal["queued", "running", "partial", "completed", "failed"]
    stage: str | None
    message: str
    progress: int = Field(ge=0, le=100)
    started_at: datetime | None
    finished_at: datetime | None
    elapsed_seconds: float = Field(ge=0)
    created_at: datetime


class ProjectResponse(BaseModel):
    id: str
    name: str
    domain: str
    country: str
    language: str
    competitor_domain: str | None
    understanding_run_id: str | None
    understanding_status: (
        Literal[
            "queued",
            "running",
            "partial",
            "completed",
            "failed",
        ]
        | None
    )
    understanding_stage: str | None
    understanding_message: str
    understanding_progress: int = Field(ge=0, le=100)
    understanding_attempt: int = Field(ge=1)
    understanding_started_at: datetime | None
    understanding_finished_at: datetime | None
    understanding_elapsed_seconds: float = Field(ge=0)
    audit_run_id: str | None
    audit_status: Literal[
        "never_started",
        "queued",
        "running",
        "paused",
        "stopping",
        "stopped",
        "completed",
        "failed",
    ]
    audit_health: int | None = Field(default=None, ge=0, le=100)
    site_profile: SiteProfileResponse | None
    created_at: datetime
