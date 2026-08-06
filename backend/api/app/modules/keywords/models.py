from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func, text

from app.db.base import Base


class KeywordBuildRun(Base):
    __tablename__ = "keyword_build_runs"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "round_number",
            name="uq_keyword_build_runs_project_round",
        ),
        CheckConstraint(
            "kind IN ('initial', 'expansion')",
            name="ck_keyword_build_runs_kind",
        ),
        CheckConstraint(
            "status IN ("
            "'queued', 'running', 'waiting', 'blocked', "
            "'partial', 'completed', 'failed', 'cancelled'"
            ")",
            name="ck_keyword_build_runs_status",
        ),
        CheckConstraint(
            "progress BETWEEN 0 AND 100",
            name="ck_keyword_build_runs_progress",
        ),
        Index(
            "uq_keyword_build_runs_active_project",
            "project_id",
            unique=True,
            postgresql_where=text("status IN ('queued', 'running', 'waiting', 'blocked')"),
        ),
        Index(
            "ix_keyword_build_runs_project_created",
            "project_id",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    round_number: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    stage: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    message: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default="正在准备关键词库",
    )
    progress: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    discovered_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="0",
    )
    selected_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="0",
    )
    keyword_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="0",
    )
    pending_seed_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="0",
    )
    result_version: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="0",
    )
    profile_snapshot: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    profile_source: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    profile_version: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    competitor_domain: Mapped[str | None] = mapped_column(Text)
    gap_status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default="not_requested",
    )
    gap_message: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    gap_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    partial_failures: Mapped[list] = mapped_column(
        JSONB,
        nullable=False,
        default=list,
        server_default=text("'[]'::jsonb"),
    )
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    recovery_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="0",
    )
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    total_cost_usd: Mapped[Decimal] = mapped_column(
        Numeric(12, 6),
        nullable=False,
        server_default="0",
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class KeywordWorkflowDispatch(Base):
    __tablename__ = "keyword_workflow_dispatches"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'dispatched')",
            name="ck_keyword_workflow_dispatches_status",
        ),
        Index(
            "ix_keyword_workflow_dispatches_pending",
            "status",
            "next_attempt_at",
        ),
    )

    run_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
        primary_key=True,
    )
    workflow_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    task_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class KeywordMetricRefreshJob(Base):
    __tablename__ = "keyword_metric_refresh_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'dispatched', 'running', 'waiting', 'completed', 'exhausted')",
            name="ck_keyword_metric_refresh_jobs_status",
        ),
        CheckConstraint(
            "attempt_count BETWEEN 0 AND 3",
            name="ck_keyword_metric_refresh_jobs_attempt_count",
        ),
        CheckConstraint(
            "orphan_replay_count BETWEEN 0 AND 3",
            name="ck_keyword_metric_refresh_jobs_orphan_replay_count",
        ),
        UniqueConstraint(
            "workflow_id",
            name="uq_keyword_metric_refresh_jobs_workflow_id",
        ),
        Index(
            "ix_keyword_metric_refresh_jobs_due",
            "status",
            "next_attempt_at",
        ),
        Index(
            "ix_keyword_metric_refresh_jobs_organization",
            "organization_id",
        ),
        Index(
            "ix_keyword_metric_refresh_jobs_project",
            "project_id",
        ),
    )

    run_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
        primary_key=True,
    )
    organization_id: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    workflow_id: Mapped[str] = mapped_column(Text, nullable=False)
    task_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    attempt_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="0",
    )
    orphan_replay_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="0",
    )
    last_error_code: Mapped[str | None] = mapped_column(Text)
    last_error_detail: Mapped[str | None] = mapped_column(Text)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class KeywordSeed(Base):
    __tablename__ = "keyword_seeds"
    __table_args__ = (
        UniqueConstraint(
            "initial_run_id",
            "normalized_keyword",
            name="uq_keyword_seeds_initial_normalized",
        ),
        CheckConstraint(
            "decision IN ('selected', 'rejected')",
            name="ck_keyword_seeds_decision",
        ),
        CheckConstraint(
            "expansion_status IN "
            "('not_applicable', 'pending_expansion', 'processing', 'expanded', 'failed')",
            name="ck_keyword_seeds_expansion_status",
        ),
        Index(
            "ix_keyword_seeds_project_pending",
            "project_id",
            "expansion_status",
            "ai_rank",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    initial_run_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    keyword: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    candidate_rank: Mapped[int] = mapped_column(Integer, nullable=False)
    candidate_score: Mapped[float | None] = mapped_column(Float)
    candidate_details: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    decision: Mapped[str] = mapped_column(Text, nullable=False)
    ai_rank: Mapped[int | None] = mapped_column(Integer)
    business_topic: Mapped[str | None] = mapped_column(Text)
    reason_code: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    expansion_status: Mapped[str] = mapped_column(Text, nullable=False)
    expansion_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("keyword_build_runs.id", ondelete="SET NULL")
    )
    expansion_round_number: Mapped[int | None] = mapped_column(Integer)
    expanded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class KeywordIdea(Base):
    __tablename__ = "keyword_ideas"
    __table_args__ = (
        UniqueConstraint(
            "build_run_id",
            "source",
            "normalized_keyword",
            "source_seed_key",
            name="uq_keyword_ideas_run_source_keyword_seed",
        ),
        CheckConstraint(
            "source IN ("
            "'site_seed', 'seed', 'google_ads', 'google_suggest', 'ai', "
            "'profile_seed', 'labs_site', 'google_ads_site', 'keyword_ideas', "
            "'keyword_ideas_broad', 'keyword_ideas_close'"
            ")",
            name="ck_keyword_ideas_source",
        ),
        Index(
            "ix_keyword_ideas_project_run",
            "project_id",
            "build_run_id",
        ),
        Index(
            "ix_keyword_ideas_run_included",
            "build_run_id",
            "included",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    build_run_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    source: Mapped[str] = mapped_column(Text, nullable=False)
    source_seed_id: Mapped[str | None] = mapped_column(
        ForeignKey("keyword_seeds.id", ondelete="SET NULL")
    )
    source_seed_key: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    keyword: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    provider_rank: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    search_volume: Mapped[int | None] = mapped_column(Integer)
    cpc: Mapped[float | None] = mapped_column(Float)
    competition: Mapped[float | None] = mapped_column(Float)
    competition_level: Mapped[str | None] = mapped_column(Text)
    keyword_difficulty: Mapped[int | None] = mapped_column(Integer)
    intent: Mapped[str | None] = mapped_column(Text)
    monthly_searches: Mapped[list] = mapped_column(
        JSONB,
        nullable=False,
        default=list,
        server_default=text("'[]'::jsonb"),
    )
    raw_payload: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    metrics_payload: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    business_relevance: Mapped[float | None] = mapped_column(Float)
    included: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    exclusion_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class Keyword(Base):
    __tablename__ = "keywords"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "country",
            "language",
            "normalized_keyword",
            name="uq_keywords_project_market_normalized",
        ),
        CheckConstraint(
            "status IN ('active', 'archived')",
            name="ck_keywords_status",
        ),
        CheckConstraint(
            "metrics_status IN ('pending', 'fresh', 'stale', 'failed')",
            name="ck_keywords_metrics_status",
        ),
        CheckConstraint(
            "review_status IN ('approved', 'needs_review')",
            name="ck_keywords_review_status",
        ),
        Index("ix_keywords_project_created", "project_id", "created_at"),
        Index("ix_keywords_project_priority", "project_id", "priority_score"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    country: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(Text, nullable=False)
    keyword: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    business_topic: Mapped[str | None] = mapped_column(Text)
    classification_confidence: Mapped[float | None] = mapped_column(Float)
    review_status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        server_default="approved",
    )
    primary_seed_id: Mapped[str | None] = mapped_column(
        ForeignKey("keyword_seeds.id", ondelete="SET NULL")
    )
    priority_score: Mapped[float | None] = mapped_column(Float)
    priority_confidence: Mapped[float | None] = mapped_column(Float)
    priority_details: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    score_version: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="active")
    metrics_status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    first_build_run_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    last_build_run_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class KeywordMetric(Base):
    __tablename__ = "keyword_metrics"
    __table_args__ = (
        UniqueConstraint(
            "keyword_id",
            "provider",
            name="uq_keyword_metrics_keyword_provider",
        ),
        Index("ix_keyword_metrics_fetched_at", "fetched_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    keyword_id: Mapped[str] = mapped_column(
        ForeignKey("keywords.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    search_volume: Mapped[int | None] = mapped_column(Integer)
    cpc: Mapped[float | None] = mapped_column(Float)
    competition: Mapped[float | None] = mapped_column(Float)
    competition_level: Mapped[str | None] = mapped_column(Text)
    keyword_difficulty: Mapped[int | None] = mapped_column(Integer)
    intent: Mapped[str | None] = mapped_column(Text)
    monthly_searches: Mapped[list] = mapped_column(
        JSONB,
        nullable=False,
        default=list,
        server_default=text("'[]'::jsonb"),
    )
    raw_payload: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class KeywordSource(Base):
    __tablename__ = "keyword_sources"
    __table_args__ = (
        UniqueConstraint(
            "keyword_id",
            "source",
            "source_seed_key",
            name="uq_keyword_sources_keyword_source_seed",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    keyword_id: Mapped[str] = mapped_column(
        ForeignKey("keywords.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source: Mapped[str] = mapped_column(Text, nullable=False)
    source_seed_id: Mapped[str | None] = mapped_column(
        ForeignKey("keyword_seeds.id", ondelete="SET NULL")
    )
    source_seed_key: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    first_build_run_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    metadata_json: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class KeywordSeedRelation(Base):
    __tablename__ = "keyword_seed_relations"
    __table_args__ = (
        UniqueConstraint(
            "keyword_id",
            "seed_id",
            name="uq_keyword_seed_relations_keyword_seed",
        ),
        CheckConstraint(
            "relation IN ('primary', 'related')",
            name="ck_keyword_seed_relations_relation",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    keyword_id: Mapped[str] = mapped_column(
        ForeignKey("keywords.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    seed_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_seeds.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    relation: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    basis: Mapped[str] = mapped_column(Text, nullable=False)


class KeywordTag(Base):
    __tablename__ = "keyword_tags"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "normalized_name",
            name="uq_keyword_tags_project_normalized",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_name: Mapped[str] = mapped_column(Text, nullable=False)
    color: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class KeywordTagAssignment(Base):
    __tablename__ = "keyword_tag_assignments"

    keyword_id: Mapped[str] = mapped_column(
        ForeignKey("keywords.id", ondelete="CASCADE"),
        primary_key=True,
    )
    tag_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_tags.id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class KeywordExternalRequest(Base):
    __tablename__ = "keyword_external_requests"
    __table_args__ = (
        UniqueConstraint(
            "request_key",
            name="uq_keyword_external_requests_request_key",
        ),
        CheckConstraint(
            "status IN ("
            "'prepared', 'submitted', 'completed', "
            "'retryable_failed', 'charged_failed', 'uncertain'"
            ")",
            name="ck_keyword_external_requests_status",
        ),
        Index(
            "ix_keyword_external_requests_project_provider",
            "project_id",
            "provider",
        ),
        Index(
            "ix_keyword_external_requests_cache_lookup",
            "organization_id",
            "provider",
            "endpoint",
            "request_hash",
            "status",
            "finished_at",
        ),
        Index(
            "ix_keyword_external_requests_lease",
            "status",
            "lease_expires_at",
        ),
        CheckConstraint(
            "num_nonnulls(build_run_id, competitor_analysis_run_id) = 1",
            name="ck_keyword_external_requests_single_owner",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    build_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("keyword_build_runs.id", ondelete="CASCADE")
    )
    competitor_analysis_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("keyword_competitor_analysis_runs.id", ondelete="CASCADE"),
        index=True,
    )
    request_key: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    attempt_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="1",
    )
    cost_usd: Mapped[Decimal] = mapped_column(
        Numeric(12, 6),
        nullable=False,
        server_default="0",
    )
    result_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="0",
    )
    response_metadata: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    claim_token: Mapped[str | None] = mapped_column(Text)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class KeywordWorkerHeartbeat(Base):
    __tablename__ = "keyword_worker_heartbeats"
    __table_args__ = (Index("ix_keyword_worker_heartbeats_last_seen", "last_seen_at"),)

    worker_id: Mapped[str] = mapped_column(Text, primary_key=True)
    task_queue: Mapped[str] = mapped_column(Text, nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    details: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )


class KeywordCompetitorGap(Base):
    __tablename__ = "keyword_competitor_gaps"
    __table_args__ = (
        UniqueConstraint(
            "build_run_id",
            "normalized_keyword",
            name="uq_keyword_competitor_gaps_run_keyword",
        ),
        CheckConstraint(
            "status IN ('pending', 'active', 'needs_review')",
            name="ck_keyword_competitor_gaps_status",
        ),
        Index(
            "ix_keyword_competitor_gaps_project_created",
            "project_id",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    build_run_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    competitor_domain: Mapped[str] = mapped_column(Text, nullable=False)
    keyword: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    competitor_rank: Mapped[int | None] = mapped_column(Integer)
    search_volume: Mapped[int | None] = mapped_column(Integer)
    cpc: Mapped[float | None] = mapped_column(Float)
    competition: Mapped[float | None] = mapped_column(Float)
    keyword_difficulty: Mapped[int | None] = mapped_column(Integer)
    intent: Mapped[str | None] = mapped_column(Text)
    monthly_searches: Mapped[list] = mapped_column(
        JSONB,
        nullable=False,
        default=list,
        server_default=text("'[]'::jsonb"),
    )
    relevance: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    raw_payload: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class KeywordCompetitorAnalysisRun(Base):
    __tablename__ = "keyword_competitor_analysis_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'running', 'partial', 'completed', 'failed')",
            name="ck_keyword_competitor_analysis_runs_status",
        ),
        CheckConstraint(
            "progress BETWEEN 0 AND 100",
            name="ck_keyword_competitor_analysis_runs_progress",
        ),
        CheckConstraint(
            "competitor_limit BETWEEN 1 AND 5",
            name="ck_keyword_competitor_analysis_runs_competitor_limit",
        ),
        CheckConstraint(
            "keyword_limit BETWEEN 1 AND 100",
            name="ck_keyword_competitor_analysis_runs_keyword_limit",
        ),
        CheckConstraint(
            "analysis_mode IN ('manual', 'auto')",
            name="ck_keyword_competitor_analysis_runs_mode",
        ),
        Index(
            "uq_keyword_competitor_analysis_runs_active_project",
            "project_id",
            unique=True,
            postgresql_where=text("status IN ('queued', 'running')"),
        ),
        Index(
            "ix_keyword_competitor_analysis_runs_project_created",
            "project_id",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    workflow_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    target_domain: Mapped[str] = mapped_column(Text, nullable=False)
    country: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(Text, nullable=False)
    analysis_mode: Mapped[str] = mapped_column(Text, nullable=False, server_default="auto")
    requested_competitor_domains: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    discovery_method: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="serp_competitors"
    )
    discovery_keywords: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    discovery_result_types: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    discovery_include_subdomains: Mapped[bool | None] = mapped_column(Boolean)
    discovery_sort: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="traffic_estimate"
    )
    discovery_limit: Mapped[int] = mapped_column(Integer, nullable=False, server_default="50")
    discovery_offset: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    gsc_query_evidence: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    query_metrics: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    serp_snapshots: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    cost_breakdown: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    landscape_summary: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    directional_result: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    market_summary: Mapped[str | None] = mapped_column(Text)
    local_market: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    stage: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    message: Mapped[str] = mapped_column(Text, nullable=False, server_default="正在准备竞争分析")
    progress: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    competitor_limit: Mapped[int] = mapped_column(Integer, nullable=False, server_default="5")
    keyword_limit: Mapped[int] = mapped_column(Integer, nullable=False, server_default="100")
    discovered_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    analyzed_competitor_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    completed_competitors: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    failed_competitors: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    raw_keyword_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    unique_keyword_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    discovery_cost_usd: Mapped[Decimal] = mapped_column(
        Numeric(12, 6), nullable=False, server_default="0"
    )
    total_cost_usd: Mapped[Decimal] = mapped_column(
        Numeric(12, 6), nullable=False, server_default="0"
    )
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    recovery_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default="0",
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class KeywordCompetitorAnalysisDispatch(Base):
    __tablename__ = "keyword_competitor_analysis_dispatches"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'dispatching', 'dispatched')",
            name="ck_keyword_competitor_analysis_dispatches_status",
        ),
        Index(
            "ix_keyword_competitor_analysis_dispatches_pending",
            "status",
            "next_attempt_at",
        ),
    )

    run_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_competitor_analysis_runs.id", ondelete="CASCADE"),
        primary_key=True,
    )
    workflow_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    task_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    last_error: Mapped[str | None] = mapped_column(Text)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class KeywordCompetitorSiteVerification(Base):
    __tablename__ = "keyword_competitor_site_verifications"
    __table_args__ = (
        Index(
            "ix_keyword_competitor_site_verifications_expiry",
            "organization_id",
            "country",
            "language",
            "checked_at",
        ),
    )

    organization_id: Mapped[str] = mapped_column(Text, primary_key=True)
    domain: Mapped[str] = mapped_column(Text, primary_key=True)
    country: Mapped[str] = mapped_column(Text, primary_key=True)
    language: Mapped[str] = mapped_column(Text, primary_key=True)
    crawler_facts: Mapped[dict] = mapped_column(JSONB, nullable=False)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class KeywordCompetitor(Base):
    __tablename__ = "keyword_competitors"
    __table_args__ = (
        UniqueConstraint("analysis_run_id", "domain", name="uq_keyword_competitors_run_domain"),
        CheckConstraint(
            "status IN ('pending', 'running', 'completed', 'failed', 'excluded')",
            name="ck_keyword_competitors_status",
        ),
        CheckConstraint(
            "domain_type IN ('direct_product_competitor', 'publisher_media', "
            "'marketplace_directory', 'community_forum', 'documentation_resource')",
            name="ck_keyword_competitors_domain_type",
        ),
        CheckConstraint(
            "site_check_status IN ('not_checked', 'verified', 'redirected_related', "
            "'redirected_unrelated', 'unverified_redirect', 'blocked', "
            "'temporarily_unavailable', 'permanently_unavailable', 'non_html', "
            "'unsafe_target', 'redirect_loop', 'platform_or_login')",
            name="ck_keyword_competitors_site_check_status",
        ),
        CheckConstraint(
            "site_relation IN ('related', 'unrelated', 'uncertain')",
            name="ck_keyword_competitors_site_relation",
        ),
        Index("ix_keyword_competitors_project_run", "project_id", "analysis_run_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    analysis_run_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_competitor_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    domain: Mapped[str] = mapped_column(Text, nullable=False)
    provider_rank: Mapped[int] = mapped_column(Integer, nullable=False)
    avg_position: Mapped[float | None] = mapped_column(Float)
    intersections: Mapped[int | None] = mapped_column(Integer)
    organic_keywords: Mapped[int | None] = mapped_column(Integer)
    organic_traffic: Mapped[float | None] = mapped_column(Float)
    selected_for_gap: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    site_check_status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="not_checked"
    )
    site_relation: Mapped[str] = mapped_column(Text, nullable=False, server_default="uncertain")
    site_verification: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    keywords_count: Mapped[int | None] = mapped_column(Integer)
    median_position: Mapped[float | None] = mapped_column(Float)
    rating: Mapped[float | None] = mapped_column(Float)
    etv: Mapped[float | None] = mapped_column(Float)
    visibility: Mapped[float | None] = mapped_column(Float)
    relevant_serp_items: Mapped[int | None] = mapped_column(Integer)
    keywords_positions: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    domain_type: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="documentation_resource"
    )
    is_seo_competitor: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("true")
    )
    is_business_competitor: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    classification_confidence: Mapped[float | None] = mapped_column(Float)
    why_they_matter: Mapped[str | None] = mapped_column(Text)
    serp_evidence: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    domain_overview: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    ranked_keywords_evidence: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    backlinks_evidence: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    keyword_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), nullable=False, server_default="0")
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    raw_payload: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class KeywordCompetitorOpportunity(Base):
    __tablename__ = "keyword_competitor_opportunities"
    __table_args__ = (
        UniqueConstraint(
            "analysis_run_id",
            "normalized_keyword",
            name="uq_keyword_competitor_opportunities_run_keyword",
        ),
        CheckConstraint(
            "status IN ('new', 'accepted', 'dismissed')",
            name="ck_keyword_competitor_opportunities_status",
        ),
        Index(
            "ix_keyword_competitor_opportunities_run_status_score",
            "analysis_run_id",
            "status",
            "opportunity_score",
        ),
        Index(
            "ix_keyword_competitor_opportunities_project_volume",
            "project_id",
            "search_volume",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    analysis_run_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_competitor_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    keyword: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    best_competitor_rank: Mapped[int | None] = mapped_column(Integer)
    competitor_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    opportunity_score: Mapped[float | None] = mapped_column(Float)
    search_volume: Mapped[int | None] = mapped_column(Integer)
    cpc: Mapped[float | None] = mapped_column(Float)
    competition: Mapped[float | None] = mapped_column(Float)
    competition_level: Mapped[str | None] = mapped_column(Text)
    keyword_difficulty: Mapped[int | None] = mapped_column(Integer)
    intent: Mapped[str | None] = mapped_column(Text)
    monthly_searches: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    metrics_fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="new")
    keyword_id: Mapped[str | None] = mapped_column(
        ForeignKey("keywords.id", ondelete="SET NULL"), index=True
    )
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class KeywordCompetitorOpportunityDecision(Base):
    __tablename__ = "keyword_competitor_opportunity_decisions"
    __table_args__ = (
        UniqueConstraint(
            "organization_id",
            "project_id",
            "country",
            "language",
            "normalized_keyword",
            name="uq_keyword_competitor_opportunity_decisions_market_keyword",
        ),
        CheckConstraint(
            "status IN ('new', 'accepted', 'dismissed')",
            name="ck_keyword_competitor_opportunity_decisions_status",
        ),
        Index(
            "ix_keyword_competitor_opportunity_decisions_keyword_id",
            "keyword_id",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    country: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="new")
    keyword_id: Mapped[str | None] = mapped_column(ForeignKey("keywords.id", ondelete="SET NULL"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class KeywordCompetitorOpportunityRanking(Base):
    __tablename__ = "keyword_competitor_opportunity_rankings"
    __table_args__ = (
        UniqueConstraint(
            "competitor_id",
            "opportunity_id",
            name="uq_keyword_comp_opportunity_rankings_pair",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    analysis_run_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_competitor_analysis_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    competitor_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_competitors.id", ondelete="CASCADE"), nullable=False, index=True
    )
    opportunity_id: Mapped[str] = mapped_column(
        ForeignKey("keyword_competitor_opportunities.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    competitor_rank: Mapped[int | None] = mapped_column(Integer)
    competitor_url: Mapped[str | None] = mapped_column(Text)
    raw_payload: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
