from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


ArticleStatus = Literal[
    "queued", "running", "completed", "completed_with_warnings", "failed", "cancelled"
]
ArticlePublicationStatus = Literal["publish_ready", "complete_draft"]
ArticleReviewStatus = Literal["pending_review", "approved", "changes_requested"]
ArticleLockType = Literal["edit_lock"]
ArticleIndexing = Literal[
    "index/follow",
    "noindex/follow",
    "index/nofollow",
    "noindex/nofollow",
]
ArticleSeoFieldState = Literal["generated", "confirmed", "modified", "stale"]
ARTICLE_SEO_FIELD_KEYS = (
    "title",
    "slug",
    "focus_keyword",
    "secondary_keywords",
    "meta_title",
    "meta_description",
    "canonical_url",
    "indexing",
)


class CreateArticleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    primary_keyword: str = Field(min_length=1, max_length=200)
    secondary_keywords: list[str] = Field(default_factory=list, max_length=8)
    article_type: str | None = Field(default=None, max_length=100)
    title: str | None = Field(default=None, max_length=300)
    writing_direction: str | None = Field(default=None, max_length=2000)
    language: str | None = Field(default=None, min_length=2, max_length=20)

    @field_validator(
        "primary_keyword", "article_type", "title", "writing_direction", "language", mode="before"
    )
    @classmethod
    def normalize_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("secondary_keywords", mode="before")
    @classmethod
    def normalize_secondary_keywords(cls, value: object) -> object:
        if not isinstance(value, list):
            return value
        return list(
            dict.fromkeys(item.strip() for item in value if isinstance(item, str) and item.strip())
        )


class UpdateArticleDocumentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document: dict
    metadata: "ArticleMetadataSnapshot | None" = None
    content_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    base_review_version: int | None = Field(default=None, ge=1)
    base_version_number: int | None = Field(default=None, ge=0)
    review_version: int | None = Field(default=None, ge=1)
    autosave_id: str | None = Field(default=None, min_length=1, max_length=200)
    reason: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def require_review_baseline(self) -> "UpdateArticleDocumentRequest":
        if self.base_review_version is None and self.review_version is None:
            raise ValueError("base_review_version is required")
        if (
            self.base_review_version is not None
            and self.review_version is not None
            and self.base_review_version != self.review_version
        ):
            raise ValueError("review baseline fields must match")
        return self

    @property
    def expected_review_version(self) -> int:
        value = self.base_review_version or self.review_version
        assert value is not None
        return value


class ArticleMetadataSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, max_length=300)
    slug: str | None = Field(default=None, max_length=500)
    meta_title: str | None = Field(default=None, max_length=300)
    meta_description: str | None = Field(default=None, max_length=2_000)
    focus_keyword: str | None = Field(default=None, max_length=200)
    secondary_keywords: list[str] = Field(default_factory=list, max_length=20)
    canonical_url: str | None = Field(default=None, max_length=2_048)
    indexing: ArticleIndexing = "index/follow"
    field_states: dict[str, ArticleSeoFieldState] = Field(default_factory=dict)
    publication_status: ArticlePublicationStatus = "complete_draft"

    @field_validator(
        "title",
        "slug",
        "meta_title",
        "meta_description",
        "focus_keyword",
        "canonical_url",
        mode="before",
    )
    @classmethod
    def normalize_optional_text(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        normalized = value.strip()
        return normalized or None

    @field_validator("indexing", mode="before")
    @classmethod
    def normalize_legacy_indexing(cls, value: object) -> object:
        return {"index": "index/follow", "noindex": "noindex/follow"}.get(
            value, value
        )

    @field_validator("secondary_keywords", mode="before")
    @classmethod
    def normalize_secondary_keywords(cls, value: object) -> object:
        if not isinstance(value, list):
            return value
        return list(
            dict.fromkeys(item.strip() for item in value if isinstance(item, str) and item.strip())
        )

    @field_validator("canonical_url")
    @classmethod
    def validate_canonical_url(cls, value: str | None) -> str | None:
        if value is not None:
            parsed = urlsplit(value)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
            ):
                raise ValueError("canonical_url must be an absolute HTTP(S) URL")
        return value

    @field_validator("field_states")
    @classmethod
    def validate_field_states(
        cls, value: dict[str, ArticleSeoFieldState]
    ) -> dict[str, ArticleSeoFieldState]:
        unsupported = set(value) - set(ARTICLE_SEO_FIELD_KEYS)
        if unsupported:
            raise ValueError("field_states contains unsupported SEO fields")
        return {key: value.get(key, "generated") for key in ARTICLE_SEO_FIELD_KEYS}


class ArticleDocumentCapabilities(BaseModel):
    schema_version: int
    writable: bool
    recovery_scope: str
    nodes: list[str]
    marks: list[str]
    heading_levels: list[int]
    asset_types: list[str]
    media_upload_enabled: bool
    can_manage_seo_advanced: bool = False
    can_manage_locks: bool = False
    limits: dict[str, int]


class ArticleSeoAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    metadata_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    changed_fields: list[str] = Field(default_factory=list, max_length=20)
    ruleset_version: str | None = Field(default=None, min_length=1, max_length=100)

    @field_validator("changed_fields")
    @classmethod
    def validate_changed_fields(cls, value: list[str]) -> list[str]:
        allowed = {"document", *ARTICLE_SEO_FIELD_KEYS, "publication_status"}
        normalized = list(dict.fromkeys(value))
        if set(normalized) - allowed:
            raise ValueError("changed_fields contains unsupported fields")
        return normalized


class ArticleSeoRuleEvidence(BaseModel):
    field: str | None = None
    node_id: str | None = None
    start: int | None = None
    end: int | None = None
    keyword: str | None = None
    text: str | None = None
    href: str | None = None


class ArticleSeoRuleResult(BaseModel):
    rule_id: str
    rule_version: str
    group: str
    dependencies: list[str]
    applicable: bool
    status: Literal["passed", "failed", "not_applicable"]
    severity: Literal["suggestion"]
    score: int
    max_score: int
    message: str
    evidence: list[ArticleSeoRuleEvidence]
    action: Literal["focus_field", "focus_evidence"]
    reused: bool = False


class ArticleSeoAnalysisGroup(BaseModel):
    id: str
    label: str
    results: list[ArticleSeoRuleResult]


class ArticleSeoAnalysisResponse(BaseModel):
    analysis_id: str | None
    article_version: int | None
    document_hash: str
    metadata_hash: str
    ruleset_version: str
    score: int
    max_score: int
    is_stale: bool
    status: Literal["completed", "failed", "unavailable"]
    error_code: str | None = None
    error_detail: str | None = None
    analyzed_at: datetime | None
    groups: list[ArticleSeoAnalysisGroup]


class ArticleLinkAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    check_external: bool = True


class ArticleLinkIssue(BaseModel):
    rule_id: str
    rule_version: str
    severity: Literal["error", "warning"]
    message: str
    action: Literal["edit_link", "focus_link", "confirm_link", "retry_check"]


class ArticleLinkResult(BaseModel):
    link_id: str
    node_id: str
    node_type: Literal["text", "bookmark", "button"]
    start: int
    end: int
    anchor_text: str
    href: str
    final_url: str
    link_kind: Literal["internal", "external"]
    target: str | None
    rel: str | None
    title: str | None
    status: Literal["passed", "warning", "error"]
    http_status: Literal["not_checked", "ok", "redirect", "broken", "server_error", "unknown"]
    status_code: int | None
    redirect_chain: list[str]
    check_error_code: str | None
    evidence: list[ArticleLinkIssue]
    checked_at: datetime


class ArticleLinkAnalysisSummary(BaseModel):
    total: int = 0
    internal: int = 0
    external: int = 0
    errors: int = 0
    warnings: int = 0


class ArticleLinkAnalysisResponse(BaseModel):
    analysis_id: str | None
    article_version: int | None
    document_hash: str
    ruleset_version: str
    status: Literal["queued", "running", "completed", "failed", "unavailable"]
    pending_analysis_id: str | None = None
    is_stale: bool
    error_code: str | None = None
    error_detail: str | None = None
    created_at: datetime | None
    completed_at: datetime | None
    checked_at: datetime | None
    summary: ArticleLinkAnalysisSummary
    links: list[ArticleLinkResult]


class InternalLinkCandidate(BaseModel):
    title: str
    url: str
    suggested_anchor: str
    target_section: str | None
    duplicate_status: Literal["new", "already_linked"]
    candidate_kind: Literal["business_page", "published_article", "navigation"]
    selection_reason: str


class InternalLinkCandidateCollection(BaseModel):
    items: list[InternalLinkCandidate]
    next_cursor: str | None


class FactSourceCandidate(BaseModel):
    source_id: str
    source_type: str
    title: str | None
    url: str
    domain: str | None
    status: str
    claims: list[dict]
    section_ids: list[str]
    domain_risk: Literal["normal", "competitor"]


class FactSourceCandidateCollection(BaseModel):
    items: list[FactSourceCandidate]


class BookmarkResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=1, max_length=2_048)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = urlsplit(value.strip())
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            raise ValueError("bookmark_url_invalid")
        return value.strip()


class BookmarkResolveResponse(BaseModel):
    kind: Literal["bookmark", "link"]
    source_url: str
    final_url: str
    title: str | None = None
    description: str | None = None
    publisher: str | None = None
    icon_url: str | None = None
    image_url: str | None = None
    fetched_at: datetime | None = None
    error_code: str | None = None
    retryable: bool = False


class EmbedResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=1, max_length=2_048)


class EmbedResolveResponse(BaseModel):
    kind: Literal["embed", "link"]
    source_url: str
    provider: Literal["youtube", "vimeo", "spotify"] | None = None
    embed_id: str | None = None
    embed_url: str | None = None
    error_code: str | None = None


class ArticleAutosaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_id: str = Field(min_length=1, max_length=200)
    sequence: int = Field(gt=0)
    base_version_number: int = Field(ge=0)
    base_review_version: int = Field(ge=1)
    document: dict
    metadata: ArticleMetadataSnapshot
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    idempotency_key: str = Field(min_length=1, max_length=200)


class ArticleAutosaveSnapshot(BaseModel):
    id: str
    article_id: str
    client_id: str
    sequence: int
    base_version_number: int
    base_review_version: int
    schema_version: int
    document: dict
    metadata: ArticleMetadataSnapshot
    content_hash: str
    created_at: datetime
    expires_at: datetime
    promoted_version_number: int | None


class ArticleAutosaveResponse(ArticleAutosaveSnapshot):
    accepted_sequence: int
    server_time: datetime


class PromoteArticleAutosaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_version_number: int = Field(ge=0)
    base_review_version: int = Field(ge=1)
    reason: str | None = Field(default=None, max_length=500)


class ContentRecoverableAutosave(BaseModel):
    id: str
    client_id: str
    sequence: int
    content_hash: str
    created_at: datetime


class ContentProblemError(BaseModel):
    code: str
    message: str
    retryable: bool
    conflict_id: str | None = None
    current_version: int | None = None
    server_review_version: int | None = None
    server_version_number: int | None = None
    client_review_version: int | None = None
    client_version_number: int | None = None
    accepted_sequence: int | None = None
    recoverable_autosave: ContentRecoverableAutosave | None = None


class ContentProblemResponse(BaseModel):
    error: ContentProblemError
    request_id: str | None


class PublishArticleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version_number: int = Field(ge=1)


class CreateArticlePreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_type: Literal["version", "autosave"]
    version_number: int | None = Field(default=None, ge=1)
    autosave_id: str | None = Field(default=None, min_length=1, max_length=200)
    target_id: str | None = Field(default=None, min_length=1, max_length=200)
    audience: Literal["creator", "organization"] = "creator"
    expires_in_minutes: int = Field(default=30, ge=15, le=60)

    @model_validator(mode="after")
    def validate_source(self) -> "CreateArticlePreviewRequest":
        if self.source_type == "version" and (
            self.version_number is None or self.autosave_id is not None
        ):
            raise ValueError("preview_version_source_invalid")
        if self.source_type == "autosave" and (
            self.autosave_id is None or self.version_number is not None
        ):
            raise ValueError("preview_autosave_source_invalid")
        return self


class ArticlePreviewResponse(BaseModel):
    id: str
    article_id: str
    source_type: Literal["version", "autosave"]
    source_version_number: int | None
    autosave_id: str | None
    target_id: str | None
    preview_url: str
    expires_at: datetime
    revoked_at: datetime | None


class ArticlePreviewSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=20, max_length=500)


class PublicationTargetResponse(BaseModel):
    id: str
    adapter_type: Literal["wordpress"]
    site_url: str
    capabilities: dict[str, object]
    status: Literal["verified", "disconnected", "disabled"]
    updated_at: datetime


class PublicationTargetCollection(BaseModel):
    items: list[PublicationTargetResponse]


class CreateArticlePublicationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version_number: int = Field(ge=1)
    target_id: str = Field(min_length=1, max_length=200)
    mode: Literal["immediate", "scheduled"] = "immediate"
    schedule_at: datetime | None = None
    source_timezone: str = Field(default="UTC", min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_schedule(self) -> "CreateArticlePublicationRequest":
        if self.mode == "scheduled" and self.schedule_at is None:
            raise ValueError("publication_schedule_required")
        if self.mode == "immediate" and self.schedule_at is not None:
            raise ValueError("publication_schedule_not_allowed")
        return self


class CancelArticlePublicationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=500)

    @field_validator("reason", mode="before")
    @classmethod
    def normalize_reason(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class RetryArticlePublicationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_status: Literal["failed"] = "failed"


class PublicationAssetProgressResponse(BaseModel):
    asset_id: str
    node_id: str
    item_id: str | None
    binding_role: str
    variant_hash: str
    status: Literal["pending", "uploading", "ready", "failed", "uncertain"]
    remote_media_id: int | None
    remote_source_url: str | None
    error_code: str | None


class ArticlePublicationResponse(BaseModel):
    id: str
    article_id: str
    version_number: int
    target_id: str
    parent_publication_id: str | None
    operation: Literal["create", "update"]
    mode: Literal["immediate", "scheduled"]
    schedule_at_utc: datetime | None
    source_timezone: str
    status: Literal[
        "queued", "scheduled", "submitting", "published", "failed", "uncertain", "cancelled"
    ]
    payload_hash: str
    asset_manifest_hash: str
    remote_post_id: int | None
    remote_url: str | None
    attempt_count: int
    last_error_code: str | None
    last_error_detail: str | None
    created_by: str
    created_at: datetime
    updated_at: datetime
    published_at: datetime | None
    cancelled_at: datetime | None
    media: list[PublicationAssetProgressResponse]
    allowed_actions: list[Literal["cancel", "retry", "reconcile"]]


class ArticlePublicationCollection(BaseModel):
    items: list[ArticlePublicationResponse]


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
    error_code: str | None
    error_detail: str | None
    failed_stage: str | None
    retryable: bool | None
    trigger_type: str
    parent_run_id: str | None
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
    focus_keyword: str | None
    secondary_keywords: list[str] = Field(default_factory=list)
    canonical_url: str | None
    indexing: ArticleIndexing
    field_states: dict[str, ArticleSeoFieldState] = Field(default_factory=dict)
    status: ArticleStatus
    publication_status: ArticlePublicationStatus
    review_status: ArticleReviewStatus | None
    review_version: int
    document_schema_version: int
    current_content_hash: str
    current_version_number: int
    approved_version_number: int | None
    publication_blocked_reason: str | None
    wordpress_post_id: int | None = None
    wordpress_url: str | None = None
    cms_publication_status: Literal[
        "queued", "scheduled", "submitting", "published", "failed", "uncertain", "cancelled"
    ] | None = None
    cms_publication_error: str | None = None
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
    document: dict = Field(default_factory=dict)
    markdown: str | None
    html: str | None
    external_sources: list[ArticleSourceResponse] = Field(default_factory=list)
    internal_links: list[ArticleSourceResponse] = Field(default_factory=list)


class ArticleVersionSummary(BaseModel):
    id: str
    run_id: str
    version_number: int
    version_type: str
    review_version: int | None
    created_by: str
    restored_from_version_id: str | None
    restorable: bool
    created_at: datetime


class ArticleVersionCollection(BaseModel):
    items: list[ArticleVersionSummary]


class ArticleVersionDetail(ArticleVersionSummary):
    title: str | None
    slug: str | None
    meta_title: str | None
    meta_description: str | None
    focus_keyword: str | None
    secondary_keywords: list[str] = Field(default_factory=list)
    canonical_url: str | None
    indexing: ArticleIndexing | None
    field_states: dict[str, ArticleSeoFieldState] = Field(default_factory=dict)
    publication_status: ArticlePublicationStatus | None
    outline: dict = Field(default_factory=dict)
    quality: dict = Field(default_factory=dict)
    document: dict = Field(default_factory=dict)
    markdown: str | None
    html: str | None


class RestoreArticleVersionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    review_version: int = Field(ge=1)


class ArticleVersionDiffLine(BaseModel):
    kind: Literal["context", "added", "removed"]
    content: str
    old_line_number: int | None
    new_line_number: int | None


class ArticleVersionMetadataChange(BaseModel):
    field: str
    before: object | None
    after: object | None


class ArticleVersionValueChange(BaseModel):
    path: str
    before: object | None
    after: object | None


class ArticleVersionBlockChange(BaseModel):
    change_id: str
    kind: Literal["added", "removed", "moved", "updated"]
    node_id: str
    node_type: str
    before_index: int | None
    after_index: int | None
    before: dict | None
    after: dict | None
    attribute_changes: list[ArticleVersionValueChange] = Field(default_factory=list)


class ArticleVersionInlineChange(BaseModel):
    change_id: str
    node_id: str
    kind: Literal["added", "removed", "updated", "marks_changed"]
    before_text: str
    after_text: str
    before_range: list[int] | None
    after_range: list[int] | None
    before_marks: list[dict] = Field(default_factory=list)
    after_marks: list[dict] = Field(default_factory=list)


class ArticleVersionMediaChange(BaseModel):
    change_id: str
    node_id: str
    node_type: str
    kind: Literal["reordered", "item_changed", "asset_replaced", "attributes_changed"]
    path: str
    before: object | None
    after: object | None


class ArticleVersionTableChange(BaseModel):
    change_id: str
    node_id: str
    row: int
    column: int
    kind: Literal["cell_changed"]
    before: dict | None
    after: dict | None


class ArticleVersionDiffSummary(BaseModel):
    blocks_added: int
    blocks_removed: int
    blocks_moved: int
    blocks_updated: int
    inline_changes: int
    media_changes: int
    table_changes: int
    metadata_changes: int


class ArticleVersionDiff(BaseModel):
    from_version: ArticleVersionSummary
    to_version: ArticleVersionSummary
    algorithm_version: str
    summary: ArticleVersionDiffSummary
    block_changes: list[ArticleVersionBlockChange]
    inline_changes: list[ArticleVersionInlineChange]
    media_changes: list[ArticleVersionMediaChange]
    table_changes: list[ArticleVersionTableChange]
    added_lines: int
    removed_lines: int
    truncated: bool
    metadata_changes: list[ArticleVersionMetadataChange]
    lines: list[ArticleVersionDiffLine]


class ArticlePublicationSnapshotResponse(BaseModel):
    publication_id: str
    published_version_number: int
    published_snapshot: dict[str, object]
    current_draft_version_number: int
    current_draft_diff: ArticleVersionDiff | None


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


ArticleReviewTaskStatus = Literal[
    "pending", "in_review", "approved", "needs_changes", "cancelled"
]


class SubmitArticleReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version_number: int = Field(ge=1)
    assigned_to: str | None = Field(default=None, min_length=1, max_length=200)
    assigned_group: str | None = Field(default=None, min_length=1, max_length=200)


class ClaimArticleReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_status: Literal["pending"] = "pending"


class DecideArticleReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["approved", "needs_changes"]
    comment: str | None = Field(default=None, max_length=2_000)

    @field_validator("comment", mode="before")
    @classmethod
    def strip_comment(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def require_changes_comment(self) -> "DecideArticleReviewRequest":
        if self.decision == "needs_changes" and not self.comment:
            raise ValueError("review_comment_required")
        return self


class AddArticleReviewCommentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: str = Field(min_length=1, max_length=2_000)
    node_id: str | None = Field(default=None, min_length=1, max_length=200)
    position: dict | None = None

    @field_validator("body", mode="before")
    @classmethod
    def strip_body(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class CancelArticleReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=500)

    @field_validator("reason", mode="before")
    @classmethod
    def strip_reason(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class ArticleReviewCommentResponse(BaseModel):
    id: str
    task_id: str
    author_id: str
    body: str
    node_id: str | None
    position: dict | None
    created_at: datetime


class ArticleReviewTaskResponse(BaseModel):
    id: str
    article_id: str
    project_id: str
    version_number: int
    status: ArticleReviewTaskStatus
    assigned_to: str | None
    assigned_group: str | None
    submitted_by: str
    submitted_at: datetime
    claimed_by: str | None
    claimed_at: datetime | None
    decided_by: str | None
    decided_at: datetime | None
    decision_comment: str | None
    policy_version: str
    comments: list[ArticleReviewCommentResponse] = Field(default_factory=list)


class ArticleReviewTaskCollection(BaseModel):
    items: list[ArticleReviewTaskResponse]


class ArticleReviewSnapshotResponse(BaseModel):
    task: ArticleReviewTaskResponse
    version: ArticleVersionDetail
    baseline_version_number: int | None
    diff: ArticleVersionDiff | None
    current_draft_version_number: int
    approved_version_number: int | None


class AcquireArticleLockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lock_type: ArticleLockType = "edit_lock"
    version_number: int | None = Field(default=None, ge=1)
    reason: str = Field(default="editing", min_length=1, max_length=500)
    lease_seconds: int = Field(default=90, ge=30, le=300)


class RenewArticleLockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lock_type: ArticleLockType = "edit_lock"
    token: str = Field(min_length=32, max_length=500)
    fence: int = Field(gt=0)
    lease_seconds: int = Field(default=90, ge=30, le=300)


class ReleaseArticleLockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lock_type: ArticleLockType = "edit_lock"
    token: str = Field(min_length=32, max_length=500)
    fence: int = Field(gt=0)
    reason: str = Field(default="released", min_length=1, max_length=500)


class ForceReleaseArticleLockRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=500)


class ArticleLockResponse(BaseModel):
    id: str
    article_id: str
    lock_type: ArticleLockType
    version_number: int | None
    owner_id: str
    reason: str
    fence: int
    acquired_at: datetime
    renewed_at: datetime
    expires_at: datetime
    released_at: datetime | None
    token: str | None = None
