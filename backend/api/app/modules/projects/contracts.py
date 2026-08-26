from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class ProjectLifecycleContract(BaseModel):
    project_id: str = Field(min_length=1)
    lifecycle_version: int = Field(ge=1)
    status: Literal["ACTIVE", "ARCHIVED"]
    archived_at: datetime | None = None
    archive_reason: str | None = None

    @model_validator(mode="after")
    def validate_archive_state(self) -> "ProjectLifecycleContract":
        if self.status == "ARCHIVED" and (
            self.archived_at is None or not (self.archive_reason or "").strip()
        ):
            raise ValueError("Archived projects require archived_at and archive_reason.")
        if self.status == "ACTIVE" and (
            self.archived_at is not None or self.archive_reason is not None
        ):
            raise ValueError("Active projects cannot expose archived state.")
        return self


class ProjectDependencyContract(BaseModel):
    project_id: str = Field(min_length=1)
    owner_module: Literal[
        "BACKLINKS",
        "GMAIL",
        "REPLY",
        "PLACEMENT",
        "LINKS",
        "MONITORING",
        "REPORT",
    ]
    record_type: str = Field(min_length=1)
    record_id: str = Field(min_length=1)
    retention_required: Literal[True] = True


class ProjectArchiveRestoreContract(BaseModel):
    project_id: str = Field(min_length=1)
    expected_lifecycle_version: int = Field(ge=1)
    operation: Literal["ARCHIVE", "RESTORE"]
    preserve_dependencies: Literal[True] = True


class ProjectDeleteAssessmentContract(BaseModel):
    project_id: str = Field(min_length=1)
    dependencies: list[ProjectDependencyContract] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_dependency_scope(self) -> "ProjectDeleteAssessmentContract":
        if any(dependency.project_id != self.project_id for dependency in self.dependencies):
            raise ValueError("Delete dependencies must belong to the assessed project.")
        return self

    def assert_destructive_delete_allowed(self) -> None:
        if self.dependencies:
            raise ValueError("Destructive delete would orphan retained project dependencies.")


class ProjectOutreachProfileContract(BaseModel):
    organization_id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    profile_version_id: str = Field(min_length=1)
    promotion_target_version_id: str = Field(min_length=1)
    keywords_and_topics: list[str] = Field(default_factory=list)
    products_and_services: list[str] = Field(min_length=1)
    target_urls: list[str] = Field(default_factory=list)
    target_audiences: list[str] = Field(default_factory=list)
    partnership_goals: list[str] = Field(default_factory=list)
    market: str = Field(min_length=1)
    location: str = Field(min_length=1)
    language: str = Field(min_length=1)
    authorized_discovery_sources: list[str] = Field(min_length=1)
    immutable_fingerprint: str = Field(min_length=1)

    @field_validator(
        "organization_id",
        "project_id",
        "profile_version_id",
        "promotion_target_version_id",
        "market",
        "location",
        "language",
        "immutable_fingerprint",
    )
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        return value.strip()

    @field_validator(
        "products_and_services",
        "authorized_discovery_sources",
    )
    @classmethod
    def normalize_required_lists(cls, values: list[str]) -> list[str]:
        normalized = list(dict.fromkeys(value.strip() for value in values if value.strip()))
        if not normalized:
            raise ValueError("At least one normalized value is required.")
        return normalized

    @field_validator(
        "keywords_and_topics",
        "target_urls",
        "target_audiences",
        "partnership_goals",
    )
    @classmethod
    def normalize_optional_lists(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(value.strip() for value in values if value.strip()))

    @model_validator(mode="after")
    def validate_minimum_promotion_evidence(self) -> "ProjectOutreachProfileContract":
        if not self.keywords_and_topics and not self.target_urls:
            raise ValueError(
                "A promotion topic or published target URL is required."
            )
        return self


class SharedSeoEvidenceSnapshotContract(BaseModel):
    organization_id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    evidence_type: str = Field(min_length=1)
    source_module: Literal[
        "site-profile",
        "keywords",
        "competitor-serp",
        "content",
        "gsc",
    ]
    source_record_id: str = Field(min_length=1)
    source_version: str = Field(min_length=1)
    provider: str = Field(min_length=1)
    endpoint: str = Field(min_length=1)
    normalized_parameters: dict[str, object]
    request_fingerprint: str = Field(min_length=1)
    market: str = Field(min_length=1)
    location: str = Field(min_length=1)
    language: str = Field(min_length=1)
    fetched_at: datetime
    expires_at: datetime
    provider_request_id: str = Field(min_length=1)
    provider_task_id: str | None = None
    cost_micros: int | None = Field(default=None, ge=0)
    artifact_ref: str = Field(min_length=1)
    status: Literal["ready", "expired", "failed"]

    @model_validator(mode="after")
    def validate_freshness_window(self) -> "SharedSeoEvidenceSnapshotContract":
        if self.expires_at <= self.fetched_at:
            raise ValueError("Evidence expiry must be later than fetched_at.")
        return self


class GenerationInputPinsContract(BaseModel):
    organization_id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    project_context_version: int = Field(ge=1)
    site_profile_version_id: str = Field(min_length=1)
    outreach_profile_version_id: str = Field(min_length=1)
    promotion_target_version_id: str = Field(min_length=1)
    keyword_evidence_snapshot_ids: list[str] = Field(default_factory=list)
    shared_evidence_snapshot_ids: list[str] = Field(default_factory=list)
    market: str = Field(min_length=1)
    qualification_contract_version: str = Field(min_length=1)


def assert_generation_input_pins_match(
    expected: GenerationInputPinsContract,
    actual: GenerationInputPinsContract,
) -> None:
    if expected != actual:
        raise ValueError("Generation input pins are bound to different project facts.")
