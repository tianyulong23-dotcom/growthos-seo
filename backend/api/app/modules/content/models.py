from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, synonym
from sqlalchemy.sql import func

from app.db.base import Base


ARTICLE_STATUSES = (
    "queued",
    "running",
    "completed",
    "completed_with_warnings",
    "failed",
    "cancelled",
)

ARTICLE_PUBLICATION_STATUSES = ("publish_ready", "complete_draft")
ARTICLE_REVIEW_STATUSES = ("pending_review", "approved", "changes_requested")
ARTICLE_PUBLICATION_BLOCKED_REASONS = (
    "changes_requested",
    "awaiting_review",
    "quality_not_ready",
    "publishing_paused",
)
ARTICLE_VERSION_TYPES = (
    "outline",
    "draft",
    "revised",
    "final",
    "generated",
    "manual_edit",
    "auto_checkpoint",
    "review_submitted",
    "review_decision",
    "restored",
    "published",
)
CONTENT_ASSET_TYPES = ("image", "video", "audio", "file")
CONTENT_ASSET_STATUSES = (
    "pending",
    "uploading",
    "uploaded",
    "processing",
    "ready",
    "pending_delete",
    "failed",
    "quarantined",
    "deleted",
)
ASSET_UPLOAD_STATUSES = (
    "initiated",
    "uploading",
    "completing",
    "completed",
    "cancelled",
    "failed",
    "expired",
)
ASSET_PROCESSING_STATUSES = ("queued", "running", "completed", "failed", "cancelled")
ASSET_CLEANUP_STATUSES = ("queued", "running", "completed", "failed", "cancelled")
ARTICLE_ANALYSIS_STATUSES = ("completed", "failed")
ARTICLE_REVIEW_TASK_STATUSES = (
    "pending",
    "in_review",
    "approved",
    "needs_changes",
    "cancelled",
)
ARTICLE_LOCK_TYPES = ("edit_lock",)
AI_EDIT_STATUSES = (
    "queued",
    "streaming",
    "ready",
    "accepted",
    "rejected",
    "cancelled",
    "failed",
    "stale",
)


class Article(Base):
    __tablename__ = "articles"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued','running','completed','completed_with_warnings','failed','cancelled')",
            name="ck_articles_status",
        ),
        CheckConstraint(
            "publication_status IN ('publish_ready','complete_draft')",
            name="ck_articles_publication_status",
        ),
        CheckConstraint(
            "review_status IS NULL OR review_status IN "
            "('pending_review','approved','changes_requested')",
            name="ck_articles_review_status",
        ),
        CheckConstraint(
            "publication_blocked_reason IS NULL OR publication_blocked_reason IN "
            "('changes_requested','awaiting_review','quality_not_ready','publishing_paused')",
            name="ck_articles_publication_blocked_reason",
        ),
        CheckConstraint("review_version >= 0", name="ck_articles_review_version"),
        CheckConstraint(
            "indexing IN ('index/follow','noindex/follow','index/nofollow','noindex/nofollow')",
            name="ck_articles_indexing",
        ),
        Index(
            "ix_articles_organization_project_updated",
            "organization_id",
            "project_id",
            text("updated_at DESC"),
        ),
        Index("ix_articles_project_status", "project_id", "status"),
        UniqueConstraint("plan_item_id", name="uq_articles_plan_item"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    plan_item_id: Mapped[str | None] = mapped_column(
        ForeignKey("content_plan_items.id", ondelete="SET NULL")
    )
    primary_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    slug: Mapped[str | None] = mapped_column(Text)
    meta_title: Mapped[str | None] = mapped_column(Text)
    meta_description: Mapped[str | None] = mapped_column(Text)
    focus_keyword: Mapped[str | None] = mapped_column(Text)
    secondary_keywords_json: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    canonical_url: Mapped[str | None] = mapped_column(Text)
    indexing: Mapped[str] = mapped_column(
        Text, nullable=False, default="index/follow", server_default="index/follow"
    )
    seo_field_states_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    outline_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    document_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    document_schema_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=2, server_default="2"
    )
    current_content_hash: Mapped[str] = mapped_column(
        Text, nullable=False, default="", server_default=""
    )
    current_version_number: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    approved_version_number: Mapped[int | None] = mapped_column(Integer)
    markdown: Mapped[str | None] = mapped_column(Text)
    html: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="queued", server_default="queued"
    )
    publication_status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="complete_draft",
        server_default="complete_draft",
    )
    review_status: Mapped[str | None] = mapped_column(Text)
    review_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    review_note: Mapped[str | None] = mapped_column(Text)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_by: Mapped[str | None] = mapped_column(Text)
    publication_blocked_reason: Mapped[str | None] = mapped_column(Text)
    current_run_id: Mapped[str | None] = mapped_column(Text)
    warning_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class ArticleRun(Base):
    __tablename__ = "article_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued','running','completed','completed_with_warnings','failed','cancelled')",
            name="ck_article_runs_status",
        ),
        CheckConstraint("progress >= 0 AND progress <= 100", name="ck_article_runs_progress"),
        CheckConstraint(
            "plan_item_version IS NULL OR plan_item_version > 0",
            name="ck_article_runs_plan_item_version",
        ),
        CheckConstraint(
            "trigger_type IN ('initial','retry','regeneration')",
            name="ck_article_runs_trigger_type",
        ),
        UniqueConstraint(
            "run_idempotency_key", name="uq_article_runs_run_idempotency_key"
        ),
        Index(
            "uq_article_runs_active_article",
            "article_id",
            unique=True,
            postgresql_where=text("status IN ('queued','running')"),
        ),
        Index("ix_article_runs_project_created", "project_id", text("created_at DESC")),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False
    )
    organization_id: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    workflow_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    trigger_type: Mapped[str] = mapped_column(
        Text, nullable=False, default="initial", server_default="initial"
    )
    parent_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("article_runs.id", ondelete="SET NULL"), index=True
    )
    plan_item_version: Mapped[int | None] = mapped_column(Integer)
    run_idempotency_key: Mapped[str | None] = mapped_column(Text)
    request_hash: Mapped[str | None] = mapped_column(Text)
    plan_input_snapshot_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="queued", server_default="queued"
    )
    stage: Mapped[str] = mapped_column(
        Text, nullable=False, default="queued", server_default="queued"
    )
    progress: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    project_snapshot_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    model_snapshot_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    soft_deadline_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    hard_deadline_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    failed_stage: Mapped[str | None] = mapped_column(Text)
    retryable: Mapped[bool | None] = mapped_column(Boolean)
    warnings_json: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    metrics_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class ArticleRunStep(Base):
    __tablename__ = "article_run_steps"
    __table_args__ = (
        UniqueConstraint("run_id", "step_key", name="uq_article_run_steps_key"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("article_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    step_key: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    input_ref: Mapped[str | None] = mapped_column(Text)
    output_ref: Mapped[str | None] = mapped_column(Text)
    summary_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cost: Mapped[float | None] = mapped_column(Numeric(18, 8))
    reported_cost: Mapped[float | None] = mapped_column(Numeric(18, 8))
    estimated_cost: Mapped[float | None] = mapped_column(Numeric(18, 8))
    cost_currency: Mapped[str | None] = mapped_column(Text)
    estimation_basis_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    warning_code: Mapped[str | None] = mapped_column(Text)
    worker_id: Mapped[str | None] = mapped_column(Text)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ArticleSource(Base):
    __tablename__ = "article_sources"
    __table_args__ = (
        UniqueConstraint(
            "run_id", "normalized_url", "source_type", name="uq_article_sources_url_type"
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("article_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_type: Mapped[str] = mapped_column(Text, nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_url: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    domain: Mapped[str | None] = mapped_column(Text)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retrieved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(Text, nullable=False)
    content_ref: Mapped[str | None] = mapped_column(Text)
    summary_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    claims_json: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    section_ids_json: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    metadata_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )


class ArticleVersion(Base):
    __tablename__ = "article_versions"
    __table_args__ = (
        UniqueConstraint(
            "article_id", "version_number", name="uq_article_versions_number"
        ),
        CheckConstraint(
            "review_version IS NULL OR review_version > 0",
            name="ck_article_versions_review_version",
        ),
        Index(
            "ix_article_versions_article_created",
            "article_id",
            text("created_at DESC"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False, index=True
    )
    run_id: Mapped[str] = mapped_column(
        ForeignKey("article_runs.id", ondelete="CASCADE"), nullable=False
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    version_type: Mapped[str] = mapped_column(Text, nullable=False)
    review_version: Mapped[int | None] = mapped_column(Integer)
    content_ref: Mapped[str | None] = mapped_column(Text)
    outline_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    quality_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    content_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    schema_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=2, server_default="2"
    )
    document_snapshot: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    metadata_snapshot: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    asset_manifest: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    content_hash: Mapped[str] = mapped_column(
        Text, nullable=False, default="", server_default=""
    )
    parent_version_number: Mapped[int | None] = mapped_column(Integer)
    source_version_number: Mapped[int | None] = mapped_column(Integer)
    reason: Mapped[str | None] = mapped_column(Text)
    retention_protected: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    created_by: Mapped[str] = mapped_column(
        Text, nullable=False, default="system", server_default="system"
    )
    restored_from_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("article_versions.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ArticleSeoAnalysis(Base):
    __tablename__ = "article_seo_analyses"
    __table_args__ = (
        UniqueConstraint(
            "article_id",
            "document_hash",
            "metadata_hash",
            "ruleset_version",
            name="uq_article_seo_analyses_input",
        ),
        CheckConstraint(
            "status IN ('completed','failed')",
            name="ck_article_seo_analyses_status",
        ),
        CheckConstraint("score >= 0", name="ck_article_seo_analyses_score"),
        CheckConstraint("max_score > 0", name="ck_article_seo_analyses_max_score"),
        Index(
            "ix_article_seo_analyses_latest",
            "article_id",
            text("created_at DESC"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False
    )
    version_number: Mapped[int | None] = mapped_column(Integer)
    document_hash: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_hash: Mapped[str] = mapped_column(Text, nullable=False)
    ruleset_version: Mapped[str] = mapped_column(Text, nullable=False)
    input_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    results: Mapped[dict] = mapped_column(JSONB, nullable=False)
    score: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_score: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ArticleLinkAnalysis(Base):
    __tablename__ = "article_link_analyses"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued','running','completed','failed')",
            name="ck_article_link_analyses_status",
        ),
        Index(
            "ix_article_link_analyses_latest",
            "article_id",
            text("created_at DESC"),
        ),
        Index(
            "uq_article_link_analyses_active_input",
            "article_id",
            "document_hash",
            "ruleset_version",
            "options_hash",
            unique=True,
            postgresql_where=text("status IN ('queued','running')"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False
    )
    version_number: Mapped[int | None] = mapped_column(Integer)
    document_hash: Mapped[str] = mapped_column(Text, nullable=False)
    ruleset_version: Mapped[str] = mapped_column(Text, nullable=False)
    options_hash: Mapped[str] = mapped_column(Text, nullable=False)
    input_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    results: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_token: Mapped[str | None] = mapped_column(Text)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ArticleIdempotencyKey(Base):
    __tablename__ = "article_idempotency_keys"

    organization_id: Mapped[str] = mapped_column(Text, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    idempotency_key: Mapped[str] = mapped_column(Text, primary_key=True)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ArticleReviewDecision(Base):
    __tablename__ = "article_review_decisions"
    __table_args__ = (
        UniqueConstraint(
            "article_id",
            "review_version",
            name="uq_article_review_decisions_article_version",
        ),
        CheckConstraint(
            "decision IN ('approved','changes_requested')",
            name="ck_article_review_decisions_decision",
        ),
        CheckConstraint(
            "review_version > 0",
            name="ck_article_review_decisions_review_version",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False, index=True
    )
    article_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("article_runs.id", ondelete="SET NULL")
    )
    review_version: Mapped[int] = mapped_column(Integer, nullable=False)
    decision: Mapped[str] = mapped_column(Text, nullable=False)
    review_note: Mapped[str | None] = mapped_column(Text)
    reviewed_by: Mapped[str] = mapped_column(Text, nullable=False)
    reviewed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ArticleReviewPolicy(Base):
    __tablename__ = "article_review_policies"
    __table_args__ = (
        CheckConstraint("version > 0", name="ck_article_review_policies_version"),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    allow_self_review: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    updated_by: Mapped[str] = mapped_column(
        Text, nullable=False, default="system", server_default="system"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class ArticleReviewTask(Base):
    __tablename__ = "article_review_tasks"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','in_review','approved','needs_changes','cancelled')",
            name="ck_article_review_tasks_status",
        ),
        CheckConstraint("version_number > 0", name="ck_article_review_tasks_version"),
        UniqueConstraint(
            "organization_id",
            "project_id",
            "submission_idempotency_key",
            name="uq_article_review_tasks_submission_idempotency",
        ),
        Index(
            "uq_article_review_tasks_active_version",
            "article_id",
            "version_number",
            unique=True,
            postgresql_where=text("status IN ('pending','in_review')"),
        ),
        Index(
            "ix_article_review_tasks_inbox",
            "organization_id",
            "project_id",
            "status",
            text("submitted_at DESC"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_id: Mapped[str] = mapped_column(
        ForeignKey("article_versions.id", ondelete="RESTRICT"), nullable=False
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    assigned_to: Mapped[str | None] = mapped_column(Text)
    assigned_group: Mapped[str | None] = mapped_column(Text)
    submitted_by: Mapped[str] = mapped_column(Text, nullable=False)
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    claimed_by: Mapped[str | None] = mapped_column(Text)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_by: Mapped[str | None] = mapped_column(Text)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_comment: Mapped[str | None] = mapped_column(Text)
    policy_version: Mapped[str] = mapped_column(Text, nullable=False)
    submission_idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    submission_request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    decision_idempotency_key: Mapped[str | None] = mapped_column(Text)
    decision_request_hash: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class ArticleReviewComment(Base):
    __tablename__ = "article_review_comments"
    __table_args__ = (
        Index("ix_article_review_comments_task_created", "task_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    task_id: Mapped[str] = mapped_column(
        ForeignKey("article_review_tasks.id", ondelete="CASCADE"), nullable=False
    )
    author_id: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    node_id: Mapped[str | None] = mapped_column(Text)
    position_json: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ArticleLock(Base):
    __tablename__ = "article_locks"
    __table_args__ = (
        CheckConstraint(
            "lock_type IN ('edit_lock')",
            name="ck_article_locks_type",
        ),
        CheckConstraint("fence > 0", name="ck_article_locks_fence"),
        CheckConstraint("expires_at > acquired_at", name="ck_article_locks_expiry"),
        Index(
            "uq_article_locks_active_type",
            "article_id",
            "lock_type",
            unique=True,
            postgresql_where=text("released_at IS NULL"),
        ),
        Index("ix_article_locks_expiry", "expires_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False
    )
    organization_id: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    lock_type: Mapped[str] = mapped_column(Text, nullable=False)
    version_number: Mapped[int | None] = mapped_column(Integer)
    owner_id: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    fence: Mapped[int] = mapped_column(Integer, nullable=False)
    acquired_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    renewed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    released_by: Mapped[str | None] = mapped_column(Text)
    release_reason: Mapped[str | None] = mapped_column(Text)


class ArticleVersionDiffCache(Base):
    __tablename__ = "article_version_diff_cache"
    __table_args__ = (
        UniqueConstraint(
            "article_id",
            "from_version_number",
            "to_version_number",
            "algorithm_version",
            name="uq_article_version_diff_cache_key",
        ),
        Index("ix_article_version_diff_cache_article", "article_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False
    )
    from_version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    to_version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    from_content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    to_content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    algorithm_version: Mapped[str] = mapped_column(Text, nullable=False)
    result_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class PublicationTarget(Base):
    __tablename__ = "publication_targets"
    __table_args__ = (
        CheckConstraint(
            "adapter_type IN ('wordpress')",
            name="ck_publication_targets_adapter_type",
        ),
        CheckConstraint(
            "status IN ('verified','disconnected','disabled')",
            name="ck_publication_targets_status",
        ),
        UniqueConstraint(
            "project_id",
            "adapter_type",
            name="uq_publication_targets_project_adapter",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    adapter_type: Mapped[str] = mapped_column(Text, nullable=False)
    site_url: Mapped[str] = mapped_column(Text, nullable=False)
    capabilities_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    credential_reference: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class ArticlePreviewSnapshot(Base):
    __tablename__ = "article_preview_snapshots"
    __table_args__ = (
        CheckConstraint(
            "source_type IN ('version','autosave')",
            name="ck_article_preview_snapshots_source_type",
        ),
        CheckConstraint(
            "audience IN ('creator','organization')",
            name="ck_article_preview_snapshots_audience",
        ),
        CheckConstraint(
            "expires_at > created_at",
            name="ck_article_preview_snapshots_expiry",
        ),
        Index("ix_article_preview_snapshots_expiry", "expires_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False
    )
    organization_id: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    source_type: Mapped[str] = mapped_column(Text, nullable=False)
    source_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("article_versions.id", ondelete="RESTRICT")
    )
    source_version_number: Mapped[int | None] = mapped_column(Integer)
    autosave_id: Mapped[str | None] = mapped_column(
        ForeignKey("article_autosaves.id", ondelete="SET NULL")
    )
    document_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    metadata_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    asset_manifest: Mapped[list] = mapped_column(JSONB, nullable=False)
    target_id: Mapped[str | None] = mapped_column(
        ForeignKey("publication_targets.id", ondelete="SET NULL")
    )
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    audience: Mapped[str] = mapped_column(Text, nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_by: Mapped[str | None] = mapped_column(Text)


class ArticlePublication(Base):
    __tablename__ = "article_publications"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued','scheduled','submitting','published','failed','uncertain','cancelled')",
            name="ck_article_publications_status",
        ),
        CheckConstraint("attempt_count >= 0", name="ck_article_publications_attempt"),
        CheckConstraint(
            "mode IN ('immediate','scheduled')",
            name="ck_article_publications_mode",
        ),
        CheckConstraint(
            "(mode = 'scheduled' AND schedule_at_utc IS NOT NULL) OR "
            "(mode = 'immediate' AND schedule_at_utc IS NULL)",
            name="ck_article_publications_schedule",
        ),
        UniqueConstraint(
            "organization_id",
            "project_id",
            "idempotency_key",
            name="uq_article_publications_idempotency",
        ),
        Index(
            "ix_article_publications_article_created",
            "article_id",
            text("created_at DESC"),
        ),
        Index(
            "uq_article_publications_active_article",
            "article_id",
            unique=True,
            postgresql_where=text("status IN ('queued','scheduled','submitting','uncertain')"),
        ),
        Index(
            "ix_article_publications_dispatch",
            "status",
            "schedule_at_utc",
            "lease_expires_at",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False
    )
    organization_id: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    version_id: Mapped[str | None] = mapped_column(
        ForeignKey("article_versions.id", ondelete="RESTRICT")
    )
    version_number: Mapped[int | None] = mapped_column(Integer)
    target_id: Mapped[str | None] = mapped_column(
        ForeignKey("publication_targets.id", ondelete="RESTRICT")
    )
    parent_publication_id: Mapped[str | None] = mapped_column(
        ForeignKey("article_publications.id", ondelete="RESTRICT")
    )
    mode: Mapped[str] = mapped_column(
        Text, nullable=False, default="immediate", server_default="immediate"
    )
    schedule_at_utc: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_timezone: Mapped[str] = mapped_column(
        Text, nullable=False, default="UTC", server_default="UTC"
    )
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    payload_hash: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    asset_manifest_hash: Mapped[str] = mapped_column(
        Text, nullable=False, default="", server_default=""
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    attempt = synonym("attempt_count")
    remote_post_id: Mapped[int | None] = mapped_column(Integer)
    wordpress_post_id = synonym("remote_post_id")
    remote_url: Mapped[str | None] = mapped_column(Text)
    wordpress_url = synonym("remote_url")
    lease_owner: Mapped[str | None] = mapped_column(Text)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str] = mapped_column(
        Text, nullable=False, default="system", server_default="system"
    )
    request_summary_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    response_summary_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    checkpoint_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    published_snapshot_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_by: Mapped[str | None] = mapped_column(Text)
    cancellation_reason: Mapped[str | None] = mapped_column(Text)


class PublicationAssetMapping(Base):
    __tablename__ = "publication_asset_mappings"
    __table_args__ = (
        CheckConstraint(
            "status IN ('uploading','ready','stale','failed','uncertain')",
            name="ck_publication_asset_mappings_status",
        ),
        UniqueConstraint(
            "target_id",
            "asset_id",
            "variant_hash",
            name="uq_publication_asset_mappings_identity",
        ),
        Index("ix_publication_asset_mappings_asset", "asset_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    target_id: Mapped[str] = mapped_column(
        ForeignKey("publication_targets.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[str] = mapped_column(
        ForeignKey(
            "content_assets.id",
            deferrable=True,
            initially="DEFERRED",
        ),
        nullable=False,
    )
    variant_id: Mapped[str | None] = mapped_column(
        ForeignKey("asset_variants.id", ondelete="SET NULL")
    )
    variant_hash: Mapped[str] = mapped_column(Text, nullable=False)
    remote_media_id: Mapped[int | None] = mapped_column(Integer)
    remote_source_url: Mapped[str | None] = mapped_column(Text)
    remote_hash: Mapped[str | None] = mapped_column(Text)
    remote_slug: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    lease_owner: Mapped[str | None] = mapped_column(Text)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempt_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class PublicationAssetCheckpoint(Base):
    __tablename__ = "publication_asset_checkpoints"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','uploading','ready','failed','uncertain')",
            name="ck_publication_asset_checkpoints_status",
        ),
        UniqueConstraint(
            "publication_id",
            "node_id",
            "item_key",
            "binding_role",
            name="uq_publication_asset_checkpoints_binding",
        ),
        Index(
            "ix_publication_asset_checkpoints_publication",
            "publication_id",
            "status",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("article_publications.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[str] = mapped_column(
        ForeignKey(
            "content_assets.id",
            deferrable=True,
            initially="DEFERRED",
        ),
        nullable=False,
    )
    node_id: Mapped[str] = mapped_column(Text, nullable=False)
    item_id: Mapped[str | None] = mapped_column(Text)
    item_key: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    binding_role: Mapped[str] = mapped_column(Text, nullable=False)
    variant_hash: Mapped[str] = mapped_column(Text, nullable=False)
    mapping_id: Mapped[str | None] = mapped_column(
        ForeignKey("publication_asset_mappings.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    attempt_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    error_code: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class ArticleAutosave(Base):
    __tablename__ = "article_autosaves"
    __table_args__ = (
        UniqueConstraint(
            "article_id",
            "user_id",
            "client_id",
            "sequence",
            name="uq_article_autosaves_client_sequence",
        ),
        UniqueConstraint(
            "article_id",
            "user_id",
            "idempotency_key",
            name="uq_article_autosaves_idempotency",
        ),
        CheckConstraint("sequence > 0", name="ck_article_autosaves_sequence"),
        CheckConstraint(
            "base_version_number >= 0", name="ck_article_autosaves_base_version"
        ),
        Index(
            "ix_article_autosaves_latest",
            "article_id",
            "user_id",
            "client_id",
            text("sequence DESC"),
        ),
        Index("ix_article_autosaves_expiry", "expires_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(Text, nullable=False)
    client_id: Mapped[str] = mapped_column(Text, nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    base_version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    base_review_version: Mapped[int] = mapped_column(Integer, nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    document_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    metadata_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    promoted_version_number: Mapped[int | None] = mapped_column(Integer)


class ContentAsset(Base):
    __tablename__ = "content_assets"
    __table_args__ = (
        CheckConstraint(
            "asset_type IN ('image','video','audio','file')",
            name="ck_content_assets_type",
        ),
        CheckConstraint(
            "status IN ('pending','uploading','uploaded','processing','ready','pending_delete','failed','quarantined','deleted')",
            name="ck_content_assets_status",
        ),
        UniqueConstraint(
            "project_id", "content_hash", name="uq_content_assets_project_hash"
        ),
        UniqueConstraint(
            "project_id",
            "created_by",
            "source_type",
            "idempotency_key",
            name="uq_content_assets_source_idempotency",
        ),
        Index("ix_content_assets_project_created", "project_id", text("created_at DESC")),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    canonical_asset_id: Mapped[str | None] = mapped_column(
        ForeignKey("content_assets.id", ondelete="SET NULL")
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    asset_type: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    original_filename: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    default_alt_text: Mapped[str | None] = mapped_column(Text)
    caption: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    mime_type: Mapped[str | None] = mapped_column(Text)
    detected_mime_type: Mapped[str | None] = mapped_column(Text)
    byte_size: Mapped[int | None] = mapped_column(Integer)
    content_hash: Mapped[str | None] = mapped_column(Text)
    storage_key: Mapped[str | None] = mapped_column(Text)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    source_type: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(Text)
    request_hash: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(Text)
    final_source_url: Mapped[str | None] = mapped_column(Text)
    provider_metadata: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    failure_code: Mapped[str | None] = mapped_column(Text)
    failure_detail: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    metadata_updated_by: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AssetUploadSession(Base):
    __tablename__ = "asset_upload_sessions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('initiated','uploading','completing','completed','cancelled','failed','expired')",
            name="ck_asset_upload_sessions_status",
        ),
        CheckConstraint("expected_size > 0", name="ck_asset_upload_sessions_expected_size"),
        CheckConstraint("part_size > 0", name="ck_asset_upload_sessions_part_size"),
        CheckConstraint("uploaded_bytes >= 0", name="ck_asset_upload_sessions_uploaded_bytes"),
        UniqueConstraint(
            "project_id", "created_by", "idempotency_key", name="uq_asset_upload_sessions_idempotency"
        ),
        Index("ix_asset_upload_sessions_expiry", "expires_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    asset_id: Mapped[str] = mapped_column(
        ForeignKey("content_assets.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, default="initiated")
    multipart_upload_id: Mapped[str] = mapped_column(Text, nullable=False)
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    expected_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    expected_sha256: Mapped[str | None] = mapped_column(Text)
    part_size: Mapped[int] = mapped_column(Integer, nullable=False)
    uploaded_bytes: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=0, server_default="0"
    )
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    failure_code: Mapped[str | None] = mapped_column(Text)
    failure_detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AssetUploadPart(Base):
    __tablename__ = "asset_upload_parts"
    __table_args__ = (
        CheckConstraint("part_number > 0", name="ck_asset_upload_parts_number"),
        CheckConstraint("byte_size > 0", name="ck_asset_upload_parts_size"),
        UniqueConstraint("upload_session_id", "part_number", name="uq_asset_upload_parts_number"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    upload_session_id: Mapped[str] = mapped_column(
        ForeignKey("asset_upload_sessions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    part_number: Mapped[int] = mapped_column(Integer, nullable=False)
    etag: Mapped[str] = mapped_column(Text, nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    checksum_sha256: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AssetProcessingJob(Base):
    __tablename__ = "asset_processing_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued','running','completed','failed','cancelled')",
            name="ck_asset_processing_jobs_status",
        ),
        CheckConstraint("attempt >= 0", name="ck_asset_processing_jobs_attempt"),
        CheckConstraint("max_attempts > 0", name="ck_asset_processing_jobs_max_attempts"),
        Index(
            "uq_asset_processing_jobs_active",
            "asset_id",
            unique=True,
            postgresql_where=text("status IN ('queued','running')"),
        ),
        Index("ix_asset_processing_jobs_dispatch", "status", "available_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    asset_id: Mapped[str] = mapped_column(
        ForeignKey("content_assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, default="queued")
    job_type: Mapped[str] = mapped_column(Text, nullable=False, default="inspect_and_transform")
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=3, server_default="3")
    worker_id: Mapped[str | None] = mapped_column(Text)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AssetVariant(Base):
    __tablename__ = "asset_variants"
    __table_args__ = (
        UniqueConstraint(
            "asset_id",
            "variant_type",
            "transform_version",
            name="uq_asset_variants_transform",
        ),
        Index("ix_asset_variants_asset", "asset_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    asset_id: Mapped[str] = mapped_column(
        ForeignKey("content_assets.id", ondelete="CASCADE"), nullable=False
    )
    variant_type: Mapped[str] = mapped_column(Text, nullable=False)
    transform_version: Mapped[int] = mapped_column(Integer, nullable=False)
    format: Mapped[str] = mapped_column(Text, nullable=False)
    storage_key: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)


class AssetCleanupJob(Base):
    __tablename__ = "asset_cleanup_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued','running','completed','failed','cancelled')",
            name="ck_asset_cleanup_jobs_status",
        ),
        CheckConstraint("attempt >= 0", name="ck_asset_cleanup_jobs_attempt"),
        CheckConstraint("max_attempts > 0", name="ck_asset_cleanup_jobs_max_attempts"),
        Index("ix_asset_cleanup_jobs_dispatch", "status", "available_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    asset_id: Mapped[str] = mapped_column(
        ForeignKey("content_assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    cleanup_type: Mapped[str] = mapped_column(Text, nullable=False)
    object_keys: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, default="queued")
    attempt: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=5, server_default="5")
    worker_id: Mapped[str | None] = mapped_column(Text)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ContentAuditEvent(Base):
    __tablename__ = "content_audit_events"
    __table_args__ = (
        Index("ix_content_audit_events_project_created", "project_id", "created_at"),
        Index("ix_content_audit_events_target", "target_type", "target_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    # Audit identifiers deliberately outlive their source rows.
    project_id: Mapped[str] = mapped_column(Text, nullable=False)
    article_id: Mapped[str | None] = mapped_column(Text)
    actor_id: Mapped[str] = mapped_column(Text, nullable=False)
    effective_role: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    target_type: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[str] = mapped_column(Text, nullable=False)
    version_number: Mapped[int | None] = mapped_column(Integer)
    before_state: Mapped[dict | None] = mapped_column(JSONB)
    after_state: Mapped[dict | None] = mapped_column(JSONB)
    reason: Mapped[str | None] = mapped_column(Text)
    policy_version: Mapped[str] = mapped_column(Text, nullable=False)
    request_id: Mapped[str | None] = mapped_column(Text)
    correlation_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ArticleAIEditOperation(Base):
    __tablename__ = "article_ai_edit_operations"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued','streaming','ready','accepted','rejected','cancelled','failed','stale')",
            name="ck_article_ai_edit_operations_status",
        ),
        CheckConstraint(
            "candidate_kind IN ('text','metadata','slice')",
            name="ck_article_ai_edit_operations_candidate_kind",
        ),
        CheckConstraint(
            "scope IN ('selection','block','cursor','metadata')",
            name="ck_article_ai_edit_operations_scope",
        ),
        CheckConstraint(
            "accepted_mode IS NULL OR accepted_mode IN ('replace','insert_after','apply_metadata')",
            name="ck_article_ai_edit_operations_accepted_mode",
        ),
        UniqueConstraint(
            "article_id", "created_by", "idempotency_key",
            name="uq_article_ai_edit_operations_create_idempotency",
        ),
        Index(
            "ix_article_ai_edit_operations_project_status_created",
            "project_id", "status", "created_at",
        ),
        Index(
            "ix_article_ai_edit_operations_article_created",
            "article_id", text("created_at DESC"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False
    )
    parent_operation_id: Mapped[str | None] = mapped_column(
        ForeignKey("article_ai_edit_operations.id", ondelete="RESTRICT")
    )
    created_by: Mapped[str] = mapped_column(Text, nullable=False)
    accepted_by: Mapped[str | None] = mapped_column(Text)
    command: Mapped[str] = mapped_column(Text, nullable=False)
    scope: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    base_review_version: Mapped[int] = mapped_column(Integer, nullable=False)
    document_hash: Mapped[str] = mapped_column(Text, nullable=False)
    anchor_node_id: Mapped[str | None] = mapped_column(Text)
    selection_from: Mapped[int | None] = mapped_column(Integer)
    selection_to: Mapped[int | None] = mapped_column(Integer)
    selected_text_hash: Mapped[str | None] = mapped_column(Text)
    input_payload_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    prompt_version: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str | None] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(Text)
    model_config_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    input_hash: Mapped[str] = mapped_column(Text, nullable=False)
    output_hash: Mapped[str | None] = mapped_column(Text)
    candidate_text: Mapped[str | None] = mapped_column(Text)
    candidate_slice_json: Mapped[dict | None] = mapped_column(JSONB)
    candidate_metadata_json: Mapped[dict | None] = mapped_column(JSONB)
    candidate_kind: Mapped[str] = mapped_column(Text, nullable=False)
    allowed_modes_json: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    stream_token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    stream_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    stream_revision: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    accept_idempotency_key: Mapped[str | None] = mapped_column(Text)
    accept_request_hash: Mapped[str | None] = mapped_column(Text)
    accepted_mode: Mapped[str | None] = mapped_column(Text)
    accepted_result_json: Mapped[dict | None] = mapped_column(JSONB)
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ArticleAssetBinding(Base):
    __tablename__ = "article_asset_bindings"
    __table_args__ = (
        Index(
            "uq_article_asset_bindings_active",
            "article_id",
            text("COALESCE(version_number, 0)"),
            "node_id",
            text("COALESCE(item_id, '')"),
            "asset_id",
            "binding_role",
            unique=True,
            postgresql_where=text("removed_at IS NULL"),
        ),
        Index("ix_article_asset_bindings_asset", "asset_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), nullable=False
    )
    version_number: Mapped[int | None] = mapped_column(Integer)
    node_id: Mapped[str] = mapped_column(Text, nullable=False)
    item_id: Mapped[str | None] = mapped_column(Text)
    asset_id: Mapped[str] = mapped_column(
        ForeignKey("content_assets.id", ondelete="RESTRICT"), nullable=False
    )
    binding_role: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# Article.plan_item_id creates a metadata dependency even when callers import
# this module without loading the content-plan repository or Alembic environment.
from app.modules.content_plan import models as content_plan_models  # noqa: E402, F401
