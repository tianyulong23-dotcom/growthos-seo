from datetime import datetime

from sqlalchemy import (
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
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


ARTICLE_STATUSES = (
    "queued",
    "running",
    "completed",
    "completed_with_warnings",
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


class Article(Base):
    __tablename__ = "articles"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued','running','completed','completed_with_warnings','cancelled')",
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
    outline_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
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
            "status IN ('queued','running','completed','completed_with_warnings','cancelled')",
            name="ck_article_runs_status",
        ),
        CheckConstraint("progress >= 0 AND progress <= 100", name="ck_article_runs_progress"),
        CheckConstraint(
            "plan_item_version IS NULL OR plan_item_version > 0",
            name="ck_article_runs_plan_item_version",
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
    plan_item_version: Mapped[int | None] = mapped_column(Integer)
    run_idempotency_key: Mapped[str | None] = mapped_column(Text)
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
    content_ref: Mapped[str | None] = mapped_column(Text)
    outline_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    quality_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


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


# Article.plan_item_id creates a metadata dependency even when callers import
# this module without loading the content-plan repository or Alembic environment.
from app.modules.content_plan import models as content_plan_models  # noqa: E402, F401
