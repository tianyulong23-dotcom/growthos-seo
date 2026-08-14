from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


AIEditCommand = Literal[
    "rewrite",
    "polish",
    "shorten",
    "expand",
    "proofread",
    "translate",
    "continue",
    "title",
    "meta_title",
    "meta_description",
    "faq",
    "cta",
]
AIEditStatus = Literal[
    "queued", "streaming", "ready", "accepted", "rejected", "cancelled", "failed", "stale"
]
AIEditScope = Literal["selection", "block", "cursor", "metadata"]
AIEditAcceptMode = Literal["replace", "insert_after", "apply_metadata"]


class AIEditSelection(BaseModel):
    anchor_node_id: str = Field(min_length=1, max_length=128)
    from_: int = Field(alias="from", ge=0)
    to: int = Field(ge=0)
    selected_text_hash: str = Field(min_length=64, max_length=71)

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode="after")
    def validate_range(self) -> "AIEditSelection":
        if self.to < self.from_:
            raise ValueError("ai_edit_selection_invalid")
        return self


class AIEditContext(BaseModel):
    heading_path: list[str] = Field(default_factory=list, max_length=8)
    focus_keyword: str | None = Field(default=None, max_length=300)
    locale: str = Field(default="zh-CN", min_length=2, max_length=32)
    target_locale: str | None = Field(default=None, min_length=2, max_length=32)
    brand_terms: list[str] = Field(default_factory=list, max_length=30)


class CreateAIEditRequest(BaseModel):
    base_review_version: int = Field(ge=1)
    document_hash: str = Field(min_length=64, max_length=71)
    document: dict[str, Any]
    metadata: dict[str, Any]
    command: AIEditCommand
    scope: AIEditScope
    selection: AIEditSelection | None = None
    context: AIEditContext = Field(default_factory=AIEditContext)

    @model_validator(mode="after")
    def validate_scope(self) -> "CreateAIEditRequest":
        requires_selection = self.scope in {"selection", "block", "cursor"}
        if requires_selection and self.selection is None:
            raise ValueError("ai_edit_selection_required")
        if self.scope == "metadata" and self.command not in {
            "title",
            "meta_title",
            "meta_description",
        }:
            raise ValueError("ai_edit_metadata_command_invalid")
        return self


class AcceptAIEditRequest(BaseModel):
    current_review_version: int = Field(ge=1)
    current_document_hash: str = Field(min_length=64, max_length=71)
    current_document: dict[str, Any]
    current_metadata: dict[str, Any]
    current_selection: AIEditSelection | None = None
    mode: AIEditAcceptMode
    candidate_index: int | None = Field(default=None, ge=0, le=9)


class RejectAIEditRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class RetryAIEditRequest(BaseModel):
    base_review_version: int = Field(ge=1)
    document_hash: str = Field(min_length=64, max_length=71)
    document: dict[str, Any]
    metadata: dict[str, Any]
    selection: AIEditSelection | None = None
    context: AIEditContext = Field(default_factory=AIEditContext)
    reason: str | None = Field(default=None, max_length=500)


class AIEditCandidate(BaseModel):
    kind: Literal["text", "metadata", "slice"]
    text: str | None = None
    metadata: dict[str, Any] | None = None
    slice: dict[str, Any] | None = None


class AIEditOperationResponse(BaseModel):
    id: str
    article_id: str
    parent_operation_id: str | None
    command: str
    scope: str
    status: AIEditStatus
    base_review_version: int
    document_hash: str
    selection: AIEditSelection | None
    prompt_version: str
    provider: str | None
    model: str | None
    candidate: AIEditCandidate
    allowed_modes: list[AIEditAcceptMode]
    error_code: str | None
    error_detail: str | None
    input_tokens: int
    output_tokens: int
    latency_ms: int | None
    stream_revision: int
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    decided_at: datetime | None
    accepted_mode: AIEditAcceptMode | None
    accepted_result: dict[str, Any] | None


class CreateAIEditResponse(BaseModel):
    operation: AIEditOperationResponse
    stream_endpoint: str
    stream_token: str
    stream_expires_at: datetime


class AcceptAIEditResponse(BaseModel):
    operation: AIEditOperationResponse
    canonical_slice: dict[str, Any] | None = None
    canonical_metadata: dict[str, Any] | None = None
    anchor_node_id: str | None = None
    from_: int | None = Field(default=None, alias="from")
    to: int | None = None

    model_config = ConfigDict(populate_by_name=True)
