from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


ContentPlanCadence = Literal["weekly_1", "weekly_2_3", "weekly_5", "weekly_7"]
ContentPlanItemStatus = Literal[
    "unscheduled",
    "scheduled",
    "triggering",
    "generating",
    "generated",
    "failed",
    "cancelled",
]


class ContentPlanSettingsResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    cadence: ContentPlanCadence
    paused: bool
    timezone: str
    default_publish_local_time: time
    cadence_anchor_week: date | None
    version: int
    updated_at: datetime


class UpdateContentPlanSettingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1)
    cadence: ContentPlanCadence | None = None
    paused: bool | None = None
    timezone: str | None = Field(default=None, min_length=1, max_length=100)

    @field_validator("timezone", mode="before")
    @classmethod
    def normalize_timezone(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def require_change(self) -> "UpdateContentPlanSettingsRequest":
        if self.cadence is None and self.paused is None and self.timezone is None:
            raise ValueError("settings_change_required")
        return self


class CreateManualPlanItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seed_keyword: str = Field(min_length=1, max_length=500)

    @field_validator("seed_keyword")
    @classmethod
    def normalize_seed_keyword(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("seed_keyword_required")
        return normalized


class UpdateContentPlanItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1)
    seed_keyword: str | None = Field(default=None, min_length=1, max_length=500)
    primary_keyword: str | None = Field(default=None, min_length=1, max_length=500)
    secondary_keywords: list[str] | None = None
    title: str | None = Field(default=None, min_length=1, max_length=1000)
    writing_direction: str | None = Field(default=None, min_length=1, max_length=10000)
    publish_local_date: date | None = None

    @field_validator(
        "seed_keyword", "primary_keyword", "title", "writing_direction"
    )
    @classmethod
    def normalize_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("plan_item_text_required")
        return normalized

    @field_validator("secondary_keywords")
    @classmethod
    def normalize_secondaries(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        normalized = [value.strip() for value in values]
        if any(not value for value in normalized):
            raise ValueError("secondary_keyword_required")
        return normalized

    @model_validator(mode="after")
    def validate_change(self) -> "UpdateContentPlanItemRequest":
        changes = {
            "seed_keyword": self.seed_keyword,
            "primary_keyword": self.primary_keyword,
            "secondary_keywords": self.secondary_keywords,
            "title": self.title,
            "writing_direction": self.writing_direction,
            "publish_local_date": self.publish_local_date,
        }
        changed = [name for name, value in changes.items() if value is not None]
        if not changed:
            raise ValueError("plan_item_change_required")
        if self.seed_keyword is not None and self.primary_keyword is not None:
            raise ValueError("seed_and_primary_keyword_are_mutually_exclusive")
        if (self.seed_keyword is not None or self.primary_keyword is not None) and len(
            changed
        ) != 1:
            raise ValueError("asynchronous_edit_must_not_include_other_fields")
        return self


class ManualPlanAcceptedResponse(BaseModel):
    batch_id: str
    preparation_id: str
    status: Literal["queued"] = "queued"


class AutomaticBatchAcceptedResponse(BaseModel):
    batch_id: str
    status: Literal["queued"] = "queued"
    target_count: Literal[30] = 30


class BatchRetryAcceptedResponse(BaseModel):
    batch_id: str
    status: Literal["queued"] = "queued"
    target_count: int


class ContentPlanBatchResponse(BaseModel):
    batch_id: str
    project_id: str
    source: Literal["automatic", "manual"]
    target_count: int
    status: str
    stage: str
    candidate_snapshot_count: int
    selected_count: int
    valid_pack_count: int
    preparation_count: int
    preview_ready_count: int
    plan_item_count: int
    external_request_count: int
    total_cost_usd: float
    retryable: bool
    error_code: str | None
    error_detail: str | None
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None


class ContentPlanBatchCollectionResponse(BaseModel):
    items: list[ContentPlanBatchResponse]
    total: int


class PlanItemKeywordResponse(BaseModel):
    keyword: str
    role: Literal["primary", "secondary"]
    keyword_type: Literal["informational", "service", "product", "unknown"]
    source: Literal["seed", "related", "ai", "user"]
    position: int


class PlanItemSerpSnapshotResponse(BaseModel):
    id: str
    preparation_id: str
    snapshot_version: int
    primary_keyword: str
    provider: str
    provider_request_id: str | None


class PendingPreparationResponse(BaseModel):
    id: str
    preparation_version: int
    state: str
    stage: str | None
    error_code: str | None
    error_detail: str | None


class ContentPlanItemResponse(BaseModel):
    id: str
    project_id: str
    source: Literal["automatic", "manual"]
    seed_keyword: str
    primary_keyword: str
    secondary_keywords: list[str]
    keywords: list[PlanItemKeywordResponse]
    title: str
    writing_direction: str
    title_source: Literal["system", "user"]
    writing_direction_source: Literal["system", "user"]
    title_user_edited: bool
    direction_user_edited: bool
    edit_state: Literal["idle", "repreparing", "reprepare_failed"]
    pending_preparation_id: str | None
    preparation_version: int
    version: int
    publish_local_date: date | None
    schedule_timezone: str | None
    generation_at: datetime | None
    status: ContentPlanItemStatus
    schedule_attention_reason: str | None
    article_id: str | None
    current_serp_snapshot_id: str
    current_serp_snapshot: PlanItemSerpSnapshotResponse | None
    pending_preparation: PendingPreparationResponse | None
    publication_status: str | None
    review_status: str | None
    review_version: int | None
    publication_blocked_reason: str | None


class ContentPlanItemSummaryResponse(BaseModel):
    id: str
    project_id: str
    source: Literal["automatic", "manual"]
    title: str
    primary_keyword: str
    edit_state: Literal["idle", "repreparing", "reprepare_failed"]
    version: int
    publish_local_date: date | None
    schedule_timezone: str | None
    generation_at: datetime | None
    status: ContentPlanItemStatus
    schedule_attention_reason: str | None
    article_id: str | None
    publication_status: str | None
    review_status: str | None


class ContentPlanItemCollectionResponse(BaseModel):
    items: list[ContentPlanItemSummaryResponse]
    total: int


class CancelContentPlanItemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1)


class PlanItemEditAcceptedResponse(BaseModel):
    item_id: str
    version: int
    pending_preparation_id: str
    preparation_version: int
    edit_state: Literal["repreparing"] = "repreparing"


class PreparationProcessResponse(BaseModel):
    preparation_id: str
    status: Literal["completed", "reprepare_failed", "failed"]
    item_id: str | None = None
