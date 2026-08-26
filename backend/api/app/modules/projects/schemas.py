from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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
    business_type: str = Field(default="", max_length=200)
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


class PublishPromotionTargetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    approved_keyword_ids: list[str] = Field(default_factory=list, max_length=100)
    published_target_ids: list[str] = Field(default_factory=list, max_length=100)
    expected_project_context_version: int = Field(ge=1)
    expected_site_profile_version_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=200,
    )

    @field_validator("approved_keyword_ids", "published_target_ids")
    @classmethod
    def clean_reference_ids(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(value.strip() for value in values if value.strip()))

    @model_validator(mode="after")
    def require_topic_or_target(self) -> "PublishPromotionTargetRequest":
        if not self.approved_keyword_ids and not self.published_target_ids:
            raise ValueError("至少需要一个已批准关键词 ID 或已发布目标 ID")
        return self


class ConfirmPromotionTargetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmed_topics: list[str] = Field(default_factory=list, max_length=100)
    confirmed_target_urls: list[str] = Field(default_factory=list, max_length=100)
    expected_project_context_version: int = Field(ge=1)
    expected_site_profile_version_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=200,
    )

    @field_validator("confirmed_topics")
    @classmethod
    def clean_topics(cls, values: list[str]) -> list[str]:
        cleaned = list(
            dict.fromkeys(value.strip() for value in values if value.strip())
        )
        if any(len(value) > 200 for value in cleaned):
            raise ValueError("每个推广主题不能超过 200 个字符")
        return cleaned

    @field_validator("confirmed_target_urls")
    @classmethod
    def clean_target_urls(cls, values: list[str]) -> list[str]:
        cleaned = list(
            dict.fromkeys(value.strip() for value in values if value.strip())
        )
        if any(len(value) > 2_048 for value in cleaned):
            raise ValueError("每个推广目标页不能超过 2048 个字符")
        return cleaned

    @model_validator(mode="after")
    def require_topic_or_target(self) -> "ConfirmPromotionTargetRequest":
        if not self.confirmed_topics and not self.confirmed_target_urls:
            raise ValueError("至少需要一个已确认推广主题或推广目标页")
        return self


class PromotionTargetVersionResponse(BaseModel):
    id: str
    project_id: str
    version: int = Field(ge=1)
    keywords: list[str]
    target_urls: list[str]
    target_audiences: list[str]
    partnership_goals: list[str]
    input_required: list[str]
    source_keyword_ids: list[str]
    source_published_target_ids: list[str]
    source_site_profile_version_id: str | None
    created_at: datetime


class ProjectOutreachReadinessResponse(BaseModel):
    website_project_id: str
    status: Literal["READY", "INPUT_REQUIRED", "REFRESHING", "STALE"]
    site_profile_version_id: str | None
    outreach_profile_version_id: str | None
    promotion_target_version_id: str | None
    fingerprint: str
    input_required: list[str]
    primary_recovery_action: Literal[
        "RESTORE_PROJECT",
        "WAIT_FOR_SITE_PROFILE",
        "COMPLETE_SITE_PROFILE",
        "CONFIRM_BUSINESS_PROFILE",
        "SET_PROJECT_LANGUAGE_MARKET",
        "PUBLISH_PROMOTION_TARGET",
        "ADD_PROMOTION_TOPIC_OR_PUBLISHED_TARGET",
        "REPUBLISH_PROMOTION_TARGET",
        "REVIEW_PROJECT_INPUTS",
        "OPEN_RECOMMENDATIONS",
    ]


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
    partnership_goals: list[str] = Field(default_factory=list)
    input_required: list[str] | None = None
    evidence: list[SiteProfileEvidence] = Field(default_factory=list)
    user_overridden_fields: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0, le=1)
    ai_content_rules: str = ""
    confirmed_at: datetime | None = None

    @field_validator(
        "products_services",
        "target_audiences",
        "value_propositions",
        "use_cases",
        "target_markets",
        "languages",
        "content_topics",
        "conversion_actions",
        "key_pages",
        "partnership_goals",
        "evidence",
        "user_overridden_fields",
        mode="before",
    )
    @classmethod
    def normalize_legacy_null_lists(cls, value: object) -> object:
        return [] if value is None else value


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
    workspace_id: str
    lifecycle_status: Literal["ACTIVE", "ARCHIVED"]
    lifecycle_version: int = Field(ge=1)
    archived_at: datetime | None
    archive_reason: str | None
    context_version: int = Field(ge=1)
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
