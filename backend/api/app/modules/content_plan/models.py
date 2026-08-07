from datetime import date, datetime, time
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    Text,
    Time,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func, text

from app.db.base import Base
from app.modules.content import models as content_models  # noqa: F401
from app.modules.keywords import models as keyword_models  # noqa: F401
from app.modules.projects import models as project_models  # noqa: F401


class ContentPlanBatch(Base):
    __tablename__ = "content_plan_batches"
    __table_args__ = (
        CheckConstraint(
            "source IN ('automatic','manual')", name="ck_content_plan_batches_source"
        ),
        CheckConstraint(
            "status IN ('queued','selecting_seeds','expanding','building_packs',"
            "'supplementing','building_previews','creating_items','scheduling',"
            "'completed','needs_attention','cancelled')",
            name="ck_content_plan_batches_status",
        ),
        CheckConstraint(
            "(source = 'automatic' AND target_count = 30) OR "
            "(source = 'manual' AND target_count = 1)",
            name="ck_content_plan_batches_source_target_count",
        ),
        CheckConstraint(
            "candidate_snapshot_count >= 0",
            name="ck_content_plan_batches_candidate_snapshot_count",
        ),
        CheckConstraint(
            "supplement_round BETWEEN 0 AND 2",
            name="ck_content_plan_batches_supplement_round",
        ),
        UniqueConstraint(
            "organization_id",
            "project_id",
            "idempotency_key",
            name="uq_content_plan_batches_idempotency",
        ),
        UniqueConstraint("workflow_id", name="uq_content_plan_batches_workflow_id"),
        Index(
            "uq_content_plan_batches_active_automatic_project",
            "project_id",
            unique=True,
            postgresql_where=text(
                "source = 'automatic' AND status NOT IN ('completed','cancelled')"
            ),
        ),
        Index("ix_content_plan_batches_project_created", "project_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source: Mapped[str] = mapped_column(Text, nullable=False)
    target_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="30")
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    stage: Mapped[str] = mapped_column(Text, nullable=False, server_default="queued")
    selected_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    valid_pack_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    supplement_round: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    candidate_snapshot_status: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="pending"
    )
    candidate_snapshot_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    candidate_window_number: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    candidate_cursor_source_rank: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    country: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(Text, nullable=False)
    timezone: Mapped[str] = mapped_column(Text, nullable=False)
    workflow_id: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    config_snapshot_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    decision_summary_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class ContentPlanCandidate(Base):
    __tablename__ = "content_plan_candidates"
    __table_args__ = (
        CheckConstraint("source_rank > 0", name="ck_content_plan_candidates_source_rank"),
        CheckConstraint(
            "coverage_status_snapshot IN ('covered','uncovered','unknown')",
            name="ck_content_plan_candidates_coverage_status",
        ),
        CheckConstraint(
            "decision IN ('kept','dropped','pending')",
            name="ck_content_plan_candidates_decision",
        ),
        CheckConstraint(
            "selected_plan_order IS NULL OR selected_plan_order BETWEEN 1 AND 30",
            name="ck_content_plan_candidates_selected_order",
        ),
        UniqueConstraint(
            "batch_id", "source_rank", name="uq_content_plan_candidates_batch_source_rank"
        ),
        UniqueConstraint(
            "batch_id", "keyword_id", name="uq_content_plan_candidates_batch_keyword"
        ),
        Index(
            "uq_content_plan_candidates_selected_order",
            "batch_id",
            "selected_plan_order",
            unique=True,
            postgresql_where=text("selected_plan_order IS NOT NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    batch_id: Mapped[str] = mapped_column(
        ForeignKey("content_plan_batches.id", ondelete="CASCADE"), nullable=False, index=True
    )
    keyword_id: Mapped[str | None] = mapped_column(
        ForeignKey("keywords.id", ondelete="SET NULL")
    )
    keyword: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    candidate_window: Mapped[int | None] = mapped_column(Integer)
    source_rank: Mapped[int] = mapped_column(Integer, nullable=False)
    priority_score_snapshot: Mapped[float] = mapped_column(Float, nullable=False)
    coverage_status_snapshot: Mapped[str] = mapped_column(Text, nullable=False)
    decision: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    decision_reason: Mapped[str | None] = mapped_column(Text)
    representative_candidate_id: Mapped[str | None] = mapped_column(
        ForeignKey("content_plan_candidates.id", ondelete="SET NULL")
    )
    ai_decision_version: Mapped[str | None] = mapped_column(Text)
    selected_plan_order: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class ContentPlanPreparation(Base):
    __tablename__ = "content_plan_preparations"
    __table_args__ = (
        ForeignKeyConstraint(
            ["plan_item_id"],
            ["content_plan_items.id"],
            name="fk_content_plan_preparations_plan_item",
            ondelete="SET NULL",
            use_alter=True,
            deferrable=True,
            initially="DEFERRED",
        ),
        ForeignKeyConstraint(
            ["id", "selected_primary_candidate_id"],
            [
                "content_plan_preparation_keywords.preparation_id",
                "content_plan_preparation_keywords.id",
            ],
            name="fk_content_plan_preparations_selected_primary",
            use_alter=True,
            deferrable=True,
            initially="DEFERRED",
        ),
        ForeignKeyConstraint(
            ["id", "current_serp_snapshot_id"],
            [
                "content_plan_serp_snapshots.preparation_id",
                "content_plan_serp_snapshots.id",
            ],
            name="fk_content_plan_preparations_current_serp",
            use_alter=True,
            deferrable=True,
            initially="DEFERRED",
        ),
        CheckConstraint("plan_order > 0", name="ck_content_plan_preparations_plan_order"),
        CheckConstraint(
            "source_round IN ('initial','refill_1','refill_2','ai_fallback','manual','edit')",
            name="ck_content_plan_preparations_source_round",
        ),
        CheckConstraint(
            "state IN ('pending','selected','expanding','expanded','expansion_failed',"
            "'classifying','classification_failed','coverage_check',"
            "'coverage_check_failed','invalid','pack_ready','serp_preview',"
            "'preview_ready','preview_failed','cancelled','superseded')",
            name="ck_content_plan_preparations_state",
        ),
        CheckConstraint(
            "preparation_version > 0 AND package_version > 0",
            name="ck_content_plan_preparations_versions",
        ),
        UniqueConstraint("workflow_id", name="uq_content_plan_preparations_workflow_id"),
        Index(
            "uq_content_plan_preparations_batch_current_order",
            "batch_id",
            "plan_order",
            unique=True,
            postgresql_where=text("is_current AND plan_item_id IS NULL"),
        ),
        Index(
            "uq_content_plan_preparations_item_current",
            "plan_item_id",
            unique=True,
            postgresql_where=text("is_current AND plan_item_id IS NOT NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    batch_id: Mapped[str] = mapped_column(
        ForeignKey("content_plan_batches.id", ondelete="CASCADE"), nullable=False, index=True
    )
    plan_item_id: Mapped[str | None] = mapped_column(Text)
    candidate_id: Mapped[str | None] = mapped_column(
        ForeignKey("content_plan_candidates.id", ondelete="SET NULL")
    )
    plan_order: Mapped[int] = mapped_column(Integer, nullable=False)
    seed_keyword_id: Mapped[str | None] = mapped_column(
        ForeignKey("keywords.id", ondelete="SET NULL")
    )
    seed_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_seed_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    source_round: Mapped[str] = mapped_column(Text, nullable=False)
    preparation_version: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="1"
    )
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    superseded_by_id: Mapped[str | None] = mapped_column(
        ForeignKey("content_plan_preparations.id", ondelete="SET NULL")
    )
    package_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    state: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    selected_primary_candidate_id: Mapped[str | None] = mapped_column(Text)
    current_serp_snapshot_id: Mapped[str | None] = mapped_column(Text)
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    workflow_id: Mapped[str] = mapped_column(Text, nullable=False)
    last_completed_stage: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class ContentPlanPreparationKeyword(Base):
    __tablename__ = "content_plan_preparation_keywords"
    __table_args__ = (
        CheckConstraint(
            "source IN ('seed','related','ai','user')",
            name="ck_content_plan_preparation_keywords_source",
        ),
        CheckConstraint(
            "coverage_status IN ('covered','uncovered','unknown')",
            name="ck_content_plan_preparation_keywords_coverage",
        ),
        CheckConstraint(
            "selected_role IN ('primary','secondary','excluded')",
            name="ck_content_plan_preparation_keywords_role",
        ),
        CheckConstraint(
            "relevance IN ('same_topic','unrelated')",
            name="ck_content_plan_preparation_keywords_relevance",
        ),
        CheckConstraint(
            "keyword_type IN ('informational','service','product','unknown')",
            name="ck_content_plan_preparation_keywords_type",
        ),
        CheckConstraint(
            "primary_fit IN ('strong','acceptable','ineligible')",
            name="ck_content_plan_preparation_keywords_primary_fit",
        ),
        CheckConstraint(
            "package_position IS NULL OR package_position > 0",
            name="ck_content_plan_preparation_keywords_position",
        ),
        CheckConstraint(
            "selected_role <> 'primary' OR "
            "(keyword_type = 'informational' AND coverage_status = 'uncovered' "
            "AND primary_fit IN ('strong','acceptable'))",
            name="ck_content_plan_preparation_keywords_primary_eligible",
        ),
        UniqueConstraint(
            "preparation_id",
            "candidate_id",
            name="uq_content_plan_preparation_keywords_candidate",
        ),
        UniqueConstraint(
            "preparation_id",
            "id",
            name="uq_content_plan_preparation_keywords_preparation_id",
        ),
        Index(
            "uq_content_plan_preparation_keywords_primary",
            "preparation_id",
            unique=True,
            postgresql_where=text("selected_role = 'primary'"),
        ),
        Index(
            "uq_content_plan_preparation_keywords_package_position",
            "preparation_id",
            "package_position",
            unique=True,
            postgresql_where=text("package_position IS NOT NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    preparation_id: Mapped[str] = mapped_column(
        ForeignKey("content_plan_preparations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    candidate_id: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    raw_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    provider_position: Mapped[int | None] = mapped_column(Integer)
    search_volume: Mapped[int | None] = mapped_column(Integer)
    keyword_difficulty: Mapped[int | None] = mapped_column(Integer)
    provider_intent: Mapped[str | None] = mapped_column(Text)
    request_round: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    raw_item_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    relevance: Mapped[str] = mapped_column(Text, nullable=False)
    keyword_type: Mapped[str] = mapped_column(Text, nullable=False)
    primary_fit: Mapped[str] = mapped_column(Text, nullable=False)
    reason_code: Mapped[str | None] = mapped_column(Text)
    classifier_version: Mapped[str | None] = mapped_column(Text)
    coverage_status: Mapped[str] = mapped_column(Text, nullable=False)
    coverage_relation_id: Mapped[str | None] = mapped_column(Text)
    covered_url: Mapped[str | None] = mapped_column(Text)
    coverage_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    selected_role: Mapped[str] = mapped_column(Text, nullable=False, server_default="excluded")
    exclusion_reason: Mapped[str | None] = mapped_column(Text)
    package_position: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ContentPlanPreparationRelation(Base):
    __tablename__ = "content_plan_preparation_relations"
    __table_args__ = (
        ForeignKeyConstraint(
            ["preparation_id", "primary_candidate_id"],
            [
                "content_plan_preparation_keywords.preparation_id",
                "content_plan_preparation_keywords.id",
            ],
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["preparation_id", "secondary_candidate_id"],
            [
                "content_plan_preparation_keywords.preparation_id",
                "content_plan_preparation_keywords.id",
            ],
            ondelete="CASCADE",
        ),
        CheckConstraint(
            "primary_candidate_id <> secondary_candidate_id",
            name="ck_content_plan_preparation_relations_distinct",
        ),
        CheckConstraint(
            "relation = 'same_article'", name="ck_content_plan_preparation_relations_relation"
        ),
        UniqueConstraint(
            "preparation_id",
            "primary_candidate_id",
            "secondary_candidate_id",
            name="uq_content_plan_preparation_relations_pair",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    preparation_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    primary_candidate_id: Mapped[str] = mapped_column(Text, nullable=False)
    secondary_candidate_id: Mapped[str] = mapped_column(Text, nullable=False)
    relation: Mapped[str] = mapped_column(Text, nullable=False, server_default="same_article")
    classifier_version: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ContentPlanSerpSnapshot(Base):
    __tablename__ = "content_plan_serp_snapshots"
    __table_args__ = (
        CheckConstraint("snapshot_version > 0", name="ck_content_plan_serp_snapshots_version"),
        CheckConstraint(
            "generated_by = 'system'", name="ck_content_plan_serp_snapshots_generated_by"
        ),
        CheckConstraint(
            "NOT cache_hit OR cost_usd = 0", name="ck_content_plan_serp_snapshots_cache_cost"
        ),
        UniqueConstraint(
            "preparation_id",
            "snapshot_version",
            name="uq_content_plan_serp_snapshots_version",
        ),
        UniqueConstraint(
            "preparation_id",
            "id",
            name="uq_content_plan_serp_snapshots_preparation_id",
        ),
        Index(
            "uq_content_plan_serp_snapshots_current",
            "preparation_id",
            unique=True,
            postgresql_where=text("is_current"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    preparation_id: Mapped[str] = mapped_column(
        ForeignKey("content_plan_preparations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    snapshot_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    primary_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    country: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    provider_request_id: Mapped[str | None] = mapped_column(Text)
    request_key: Mapped[str] = mapped_column(Text, nullable=False)
    cache_hit: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    cost_usd: Mapped[Decimal] = mapped_column(
        Numeric(12, 6), nullable=False, server_default="0"
    )
    organic_summary_json: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    paa_json: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    related_searches_json: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    serp_features_json: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    featured_snippet_json: Mapped[dict | None] = mapped_column(JSONB)
    provisional_title: Mapped[str | None] = mapped_column(Text)
    provisional_direction: Mapped[str | None] = mapped_column(Text)
    generated_by: Mapped[str] = mapped_column(Text, nullable=False, server_default="system")
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ContentPlanItem(Base):
    __tablename__ = "content_plan_items"
    __table_args__ = (
        CheckConstraint(
            "source IN ('automatic','manual')", name="ck_content_plan_items_source"
        ),
        CheckConstraint(
            "edit_state IN ('idle','repreparing','reprepare_failed')",
            name="ck_content_plan_items_edit_state",
        ),
        CheckConstraint(
            "status IN ('unscheduled','scheduled','triggering','generating','generated',"
            "'failed','cancelled')",
            name="ck_content_plan_items_status",
        ),
        CheckConstraint(
            "schedule_attention_reason IS NULL OR "
            "schedule_attention_reason = 'expired_user_pinned_date'",
            name="ck_content_plan_items_attention_reason",
        ),
        CheckConstraint(
            "preparation_version > 0 AND version > 0", name="ck_content_plan_items_versions"
        ),
        UniqueConstraint(
            "current_preparation_id", name="uq_content_plan_items_current_preparation"
        ),
        UniqueConstraint("article_id", name="uq_content_plan_items_article"),
        Index(
            "uq_content_plan_items_batch_plan_order",
            "batch_id",
            "plan_order",
            unique=True,
            postgresql_where=text("plan_order IS NOT NULL"),
        ),
        Index(
            "uq_content_plan_items_active_publish_date",
            "project_id",
            "publish_local_date",
            unique=True,
            postgresql_where=text(
                "status <> 'cancelled' AND publish_local_date IS NOT NULL"
            ),
        ),
        Index(
            "uq_content_plan_items_active_seed",
            "project_id",
            "normalized_seed_keyword",
            unique=True,
            postgresql_where=text("status <> 'cancelled'"),
        ),
        Index("ix_content_plan_items_project_generation", "project_id", "generation_at"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    batch_id: Mapped[str] = mapped_column(
        ForeignKey("content_plan_batches.id", ondelete="CASCADE"), nullable=False, index=True
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source: Mapped[str] = mapped_column(Text, nullable=False)
    seed_keyword_id: Mapped[str | None] = mapped_column(
        ForeignKey("keywords.id", ondelete="SET NULL")
    )
    seed_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_seed_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    source_priority_score: Mapped[float | None] = mapped_column(Float)
    source_rank: Mapped[int | None] = mapped_column(Integer)
    plan_order: Mapped[int | None] = mapped_column(Integer)
    primary_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    writing_direction: Mapped[str] = mapped_column(Text, nullable=False)
    title_user_edited: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    direction_user_edited: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )
    current_preparation_id: Mapped[str] = mapped_column(
        ForeignKey("content_plan_preparations.id", ondelete="RESTRICT"), nullable=False
    )
    current_serp_snapshot_id: Mapped[str] = mapped_column(
        ForeignKey("content_plan_serp_snapshots.id", ondelete="RESTRICT"), nullable=False
    )
    pending_preparation_id: Mapped[str | None] = mapped_column(
        ForeignKey("content_plan_preparations.id", ondelete="SET NULL")
    )
    preparation_version: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="1"
    )
    edit_state: Mapped[str] = mapped_column(Text, nullable=False, server_default="idle")
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    publish_local_date: Mapped[date | None] = mapped_column(Date)
    publish_local_time: Mapped[time | None] = mapped_column(Time)
    schedule_timezone: Mapped[str | None] = mapped_column(Text)
    publish_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    generation_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    date_user_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    schedule_attention_reason: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="unscheduled")
    article_id: Mapped[str | None] = mapped_column(
        ForeignKey("articles.id", ondelete="SET NULL")
    )
    trigger_lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class ContentPlanItemKeyword(Base):
    __tablename__ = "content_plan_item_keywords"
    __table_args__ = (
        CheckConstraint(
            "role IN ('primary','secondary')", name="ck_content_plan_item_keywords_role"
        ),
        CheckConstraint(
            "keyword_type IN ('informational','service','product','unknown')",
            name="ck_content_plan_item_keywords_type",
        ),
        CheckConstraint(
            "source IN ('seed','related','ai','user')",
            name="ck_content_plan_item_keywords_source",
        ),
        CheckConstraint(
            "role <> 'primary' OR keyword_type = 'informational'",
            name="ck_content_plan_item_keywords_primary_type",
        ),
        CheckConstraint("position > 0", name="ck_content_plan_item_keywords_position"),
        UniqueConstraint(
            "plan_item_id",
            "normalized_keyword",
            name="uq_content_plan_item_keywords_normalized",
        ),
        UniqueConstraint(
            "plan_item_id", "position", name="uq_content_plan_item_keywords_position"
        ),
        Index(
            "uq_content_plan_item_keywords_primary",
            "plan_item_id",
            unique=True,
            postgresql_where=text("role = 'primary'"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    plan_item_id: Mapped[str] = mapped_column(
        ForeignKey("content_plan_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    preparation_keyword_id: Mapped[str | None] = mapped_column(
        ForeignKey("content_plan_preparation_keywords.id", ondelete="SET NULL")
    )
    keyword_id: Mapped[str | None] = mapped_column(
        ForeignKey("keywords.id", ondelete="SET NULL")
    )
    keyword: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_keyword: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    keyword_type: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    search_volume: Mapped[int | None] = mapped_column(Integer)
    keyword_difficulty: Mapped[int | None] = mapped_column(Integer)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ContentPlanExternalRequest(Base):
    __tablename__ = "content_plan_external_requests"
    __table_args__ = (
        UniqueConstraint(
            "request_key", name="uq_content_plan_external_requests_request_key"
        ),
        CheckConstraint(
            "status IN ('prepared','submitted','completed','retryable_failed',"
            "'charged_failed','uncertain','failed')",
            name="ck_content_plan_external_requests_status",
        ),
        CheckConstraint("round >= 0", name="ck_content_plan_external_requests_round"),
        Index(
            "ix_content_plan_external_requests_lease", "status", "lease_expires_at"
        ),
        Index(
            "ix_content_plan_external_requests_batch_provider", "batch_id", "provider"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_id: Mapped[str] = mapped_column(
        ForeignKey("content_plan_batches.id", ondelete="CASCADE"), nullable=False, index=True
    )
    preparation_id: Mapped[str | None] = mapped_column(
        ForeignKey("content_plan_preparations.id", ondelete="CASCADE")
    )
    plan_item_id: Mapped[str | None] = mapped_column(
        ForeignKey("content_plan_items.id", ondelete="CASCADE")
    )
    request_key: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    round_number: Mapped[int] = mapped_column("round", Integer, nullable=False, server_default="0")
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="prepared")
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    cost_usd: Mapped[Decimal] = mapped_column(
        Numeric(12, 6), nullable=False, server_default="0"
    )
    result_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    provider_request_ids: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    response_metadata_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    error_code: Mapped[str | None] = mapped_column(Text)
    error_detail: Mapped[str | None] = mapped_column(Text)
    claim_token: Mapped[str | None] = mapped_column(Text)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ContentPlanSettings(Base):
    __tablename__ = "content_plan_settings"
    __table_args__ = (
        CheckConstraint(
            "cadence IN ('weekly_1','weekly_2_3','weekly_5','weekly_7')",
            name="ck_content_plan_settings_cadence",
        ),
        CheckConstraint("version > 0", name="ck_content_plan_settings_version"),
        CheckConstraint("timezone <> ''", name="ck_content_plan_settings_timezone"),
        CheckConstraint(
            "(cadence = 'weekly_2_3' AND cadence_anchor_week IS NOT NULL "
            "AND EXTRACT(ISODOW FROM cadence_anchor_week) = 1) OR "
            "(cadence <> 'weekly_2_3' AND cadence_anchor_week IS NULL)",
            name="ck_content_plan_settings_anchor",
        ),
    )

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    cadence: Mapped[str] = mapped_column(Text, nullable=False, server_default="weekly_2_3")
    paused: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    timezone: Mapped[str] = mapped_column(Text, nullable=False)
    default_publish_local_time: Mapped[time] = mapped_column(
        Time, nullable=False, server_default="10:00:00"
    )
    cadence_anchor_week: Mapped[date | None] = mapped_column(Date)
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
