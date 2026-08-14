"""Add the content-plan data foundation.

Revision ID: 20260805_cp023
Revises: 20260804_0022
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260805_cp023"
down_revision: str | Sequence[str] | None = "20260804_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())

    op.create_table(
        "content_plan_batches",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("target_count", sa.Integer(), nullable=False, server_default="30"),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("stage", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("selected_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("valid_pack_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("supplement_round", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "candidate_snapshot_status", sa.Text(), nullable=False, server_default="pending"
        ),
        sa.Column(
            "candidate_snapshot_count", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column(
            "candidate_window_number", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column(
            "candidate_cursor_source_rank",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("country", sa.Text(), nullable=False),
        sa.Column("language", sa.Text(), nullable=False),
        sa.Column("timezone", sa.Text(), nullable=False),
        sa.Column("workflow_id", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column(
            "config_snapshot_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "decision_summary_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["platform.projects.id"], ondelete="CASCADE"
        ),
        sa.CheckConstraint(
            "source IN ('automatic','manual')", name="ck_content_plan_batches_source"
        ),
        sa.CheckConstraint(
            "status IN ('queued','selecting_seeds','expanding','building_packs',"
            "'supplementing','building_previews','creating_items','scheduling',"
            "'completed','needs_attention','cancelled')",
            name="ck_content_plan_batches_status",
        ),
        sa.CheckConstraint(
            "(source = 'automatic' AND target_count = 30) OR "
            "(source = 'manual' AND target_count = 1)",
            name="ck_content_plan_batches_source_target_count",
        ),
        sa.CheckConstraint(
            "candidate_snapshot_count >= 0",
            name="ck_content_plan_batches_candidate_snapshot_count",
        ),
        sa.CheckConstraint(
            "supplement_round BETWEEN 0 AND 2",
            name="ck_content_plan_batches_supplement_round",
        ),
        sa.UniqueConstraint(
            "organization_id",
            "project_id",
            "idempotency_key",
            name="uq_content_plan_batches_idempotency",
        ),
        sa.UniqueConstraint("workflow_id", name="uq_content_plan_batches_workflow_id"),
        schema="public",
    )
    op.create_index(
        "ix_content_plan_batches_organization_id",
        "content_plan_batches",
        ["organization_id"],
        schema="public",
    )
    op.create_index(
        "ix_content_plan_batches_project_id",
        "content_plan_batches",
        ["project_id"],
        schema="public",
    )
    op.create_index(
        "uq_content_plan_batches_active_automatic_project",
        "content_plan_batches",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text(
            "source = 'automatic' AND status NOT IN ('completed','cancelled')"
        ),
        schema="public",
    )
    op.create_index(
        "ix_content_plan_batches_project_created",
        "content_plan_batches",
        ["project_id", "created_at"],
        schema="public",
    )

    op.create_table(
        "content_plan_candidates",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("batch_id", sa.Text(), nullable=False),
        sa.Column("keyword_id", sa.Text()),
        sa.Column("keyword", sa.Text(), nullable=False),
        sa.Column("normalized_keyword", sa.Text(), nullable=False),
        sa.Column("candidate_window", sa.Integer()),
        sa.Column("source_rank", sa.Integer(), nullable=False),
        sa.Column("priority_score_snapshot", sa.Float(), nullable=False),
        sa.Column("coverage_status_snapshot", sa.Text(), nullable=False),
        sa.Column("decision", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("decision_reason", sa.Text()),
        sa.Column("representative_candidate_id", sa.Text()),
        sa.Column("ai_decision_version", sa.Text()),
        sa.Column("selected_plan_order", sa.Integer()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["batch_id"], ["public.content_plan_batches.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["keyword_id"], ["public.keywords.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["representative_candidate_id"],
            ["public.content_plan_candidates.id"],
            ondelete="SET NULL",
        ),
        sa.CheckConstraint(
            "source_rank > 0", name="ck_content_plan_candidates_source_rank"
        ),
        sa.CheckConstraint(
            "coverage_status_snapshot IN ('covered','uncovered','unknown')",
            name="ck_content_plan_candidates_coverage_status",
        ),
        sa.CheckConstraint(
            "decision IN ('kept','dropped','pending')",
            name="ck_content_plan_candidates_decision",
        ),
        sa.CheckConstraint(
            "selected_plan_order IS NULL OR selected_plan_order BETWEEN 1 AND 30",
            name="ck_content_plan_candidates_selected_order",
        ),
        sa.UniqueConstraint(
            "batch_id", "source_rank", name="uq_content_plan_candidates_batch_source_rank"
        ),
        sa.UniqueConstraint(
            "batch_id", "keyword_id", name="uq_content_plan_candidates_batch_keyword"
        ),
        schema="public",
    )
    op.create_index(
        "ix_content_plan_candidates_batch_id",
        "content_plan_candidates",
        ["batch_id"],
        schema="public",
    )
    op.create_index(
        "uq_content_plan_candidates_selected_order",
        "content_plan_candidates",
        ["batch_id", "selected_plan_order"],
        unique=True,
        postgresql_where=sa.text("selected_plan_order IS NOT NULL"),
        schema="public",
    )

    op.create_table(
        "content_plan_preparations",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("batch_id", sa.Text(), nullable=False),
        sa.Column("plan_item_id", sa.Text()),
        sa.Column("candidate_id", sa.Text()),
        sa.Column("plan_order", sa.Integer(), nullable=False),
        sa.Column("seed_keyword_id", sa.Text()),
        sa.Column("seed_keyword", sa.Text(), nullable=False),
        sa.Column("normalized_seed_keyword", sa.Text(), nullable=False),
        sa.Column("source_round", sa.Text(), nullable=False),
        sa.Column(
            "preparation_version", sa.Integer(), nullable=False, server_default="1"
        ),
        sa.Column("is_current", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("superseded_by_id", sa.Text()),
        sa.Column("package_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("state", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("selected_primary_candidate_id", sa.Text()),
        sa.Column("current_serp_snapshot_id", sa.Text()),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column("workflow_id", sa.Text(), nullable=False),
        sa.Column("last_completed_stage", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["batch_id"], ["public.content_plan_batches.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["candidate_id"], ["public.content_plan_candidates.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["seed_keyword_id"], ["public.keywords.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["superseded_by_id"],
            ["public.content_plan_preparations.id"],
            ondelete="SET NULL",
        ),
        sa.CheckConstraint(
            "plan_order > 0", name="ck_content_plan_preparations_plan_order"
        ),
        sa.CheckConstraint(
            "source_round IN ('initial','refill_1','refill_2','ai_fallback','manual','edit')",
            name="ck_content_plan_preparations_source_round",
        ),
        sa.CheckConstraint(
            "state IN ('pending','selected','expanding','expanded','expansion_failed',"
            "'classifying','classification_failed','coverage_check',"
            "'coverage_check_failed','invalid','pack_ready','serp_preview',"
            "'preview_ready','preview_failed','cancelled','superseded')",
            name="ck_content_plan_preparations_state",
        ),
        sa.CheckConstraint(
            "preparation_version > 0 AND package_version > 0",
            name="ck_content_plan_preparations_versions",
        ),
        sa.UniqueConstraint(
            "workflow_id", name="uq_content_plan_preparations_workflow_id"
        ),
        schema="public",
    )
    op.create_index(
        "ix_content_plan_preparations_batch_id",
        "content_plan_preparations",
        ["batch_id"],
        schema="public",
    )
    op.create_index(
        "uq_content_plan_preparations_batch_current_order",
        "content_plan_preparations",
        ["batch_id", "plan_order"],
        unique=True,
        postgresql_where=sa.text("is_current AND plan_item_id IS NULL"),
        schema="public",
    )
    op.create_index(
        "uq_content_plan_preparations_item_current",
        "content_plan_preparations",
        ["plan_item_id"],
        unique=True,
        postgresql_where=sa.text("is_current AND plan_item_id IS NOT NULL"),
        schema="public",
    )

    op.create_table(
        "content_plan_preparation_keywords",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("preparation_id", sa.Text(), nullable=False),
        sa.Column("candidate_id", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("raw_keyword", sa.Text(), nullable=False),
        sa.Column("normalized_keyword", sa.Text(), nullable=False),
        sa.Column("provider_position", sa.Integer()),
        sa.Column("search_volume", sa.Integer()),
        sa.Column("keyword_difficulty", sa.Integer()),
        sa.Column("provider_intent", sa.Text()),
        sa.Column("request_round", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "raw_item_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column("relevance", sa.Text(), nullable=False),
        sa.Column("keyword_type", sa.Text(), nullable=False),
        sa.Column("primary_fit", sa.Text(), nullable=False),
        sa.Column("reason_code", sa.Text()),
        sa.Column("classifier_version", sa.Text()),
        sa.Column("coverage_status", sa.Text(), nullable=False),
        sa.Column("coverage_relation_id", sa.Text()),
        sa.Column("covered_url", sa.Text()),
        sa.Column("coverage_checked_at", sa.DateTime(timezone=True)),
        sa.Column("selected_role", sa.Text(), nullable=False, server_default="excluded"),
        sa.Column("exclusion_reason", sa.Text()),
        sa.Column("package_position", sa.Integer()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["preparation_id"],
            ["public.content_plan_preparations.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "source IN ('seed','related','ai','user')",
            name="ck_content_plan_preparation_keywords_source",
        ),
        sa.CheckConstraint(
            "coverage_status IN ('covered','uncovered','unknown')",
            name="ck_content_plan_preparation_keywords_coverage",
        ),
        sa.CheckConstraint(
            "selected_role IN ('primary','secondary','excluded')",
            name="ck_content_plan_preparation_keywords_role",
        ),
        sa.CheckConstraint(
            "relevance IN ('same_topic','unrelated')",
            name="ck_content_plan_preparation_keywords_relevance",
        ),
        sa.CheckConstraint(
            "keyword_type IN ('informational','service','product','unknown')",
            name="ck_content_plan_preparation_keywords_type",
        ),
        sa.CheckConstraint(
            "primary_fit IN ('strong','acceptable','ineligible')",
            name="ck_content_plan_preparation_keywords_primary_fit",
        ),
        sa.CheckConstraint(
            "package_position IS NULL OR package_position > 0",
            name="ck_content_plan_preparation_keywords_position",
        ),
        sa.CheckConstraint(
            "selected_role <> 'primary' OR "
            "(keyword_type = 'informational' AND coverage_status = 'uncovered' "
            "AND primary_fit IN ('strong','acceptable'))",
            name="ck_content_plan_preparation_keywords_primary_eligible",
        ),
        sa.UniqueConstraint(
            "preparation_id",
            "candidate_id",
            name="uq_content_plan_preparation_keywords_candidate",
        ),
        sa.UniqueConstraint(
            "preparation_id",
            "id",
            name="uq_content_plan_preparation_keywords_preparation_id",
        ),
        schema="public",
    )
    op.create_index(
        "ix_content_plan_preparation_keywords_preparation_id",
        "content_plan_preparation_keywords",
        ["preparation_id"],
        schema="public",
    )
    op.create_index(
        "uq_content_plan_preparation_keywords_primary",
        "content_plan_preparation_keywords",
        ["preparation_id"],
        unique=True,
        postgresql_where=sa.text("selected_role = 'primary'"),
        schema="public",
    )
    op.create_index(
        "uq_content_plan_preparation_keywords_package_position",
        "content_plan_preparation_keywords",
        ["preparation_id", "package_position"],
        unique=True,
        postgresql_where=sa.text("package_position IS NOT NULL"),
        schema="public",
    )

    op.create_table(
        "content_plan_preparation_relations",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("preparation_id", sa.Text(), nullable=False),
        sa.Column("primary_candidate_id", sa.Text(), nullable=False),
        sa.Column("secondary_candidate_id", sa.Text(), nullable=False),
        sa.Column("relation", sa.Text(), nullable=False, server_default="same_article"),
        sa.Column("classifier_version", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["preparation_id", "primary_candidate_id"],
            [
                "public.content_plan_preparation_keywords.preparation_id",
                "public.content_plan_preparation_keywords.id",
            ],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["preparation_id", "secondary_candidate_id"],
            [
                "public.content_plan_preparation_keywords.preparation_id",
                "public.content_plan_preparation_keywords.id",
            ],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "primary_candidate_id <> secondary_candidate_id",
            name="ck_content_plan_preparation_relations_distinct",
        ),
        sa.CheckConstraint(
            "relation = 'same_article'",
            name="ck_content_plan_preparation_relations_relation",
        ),
        sa.UniqueConstraint(
            "preparation_id",
            "primary_candidate_id",
            "secondary_candidate_id",
            name="uq_content_plan_preparation_relations_pair",
        ),
        schema="public",
    )
    op.create_index(
        "ix_content_plan_preparation_relations_preparation_id",
        "content_plan_preparation_relations",
        ["preparation_id"],
        schema="public",
    )

    op.create_table(
        "content_plan_serp_snapshots",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("preparation_id", sa.Text(), nullable=False),
        sa.Column("snapshot_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("primary_keyword", sa.Text(), nullable=False),
        sa.Column("country", sa.Text(), nullable=False),
        sa.Column("language", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("provider_request_id", sa.Text()),
        sa.Column("request_key", sa.Text(), nullable=False),
        sa.Column("cache_hit", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column(
            "cost_usd", sa.Numeric(12, 6), nullable=False, server_default="0"
        ),
        sa.Column(
            "organic_summary_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "paa_json", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
        sa.Column(
            "related_searches_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("provisional_title", sa.Text()),
        sa.Column("provisional_direction", sa.Text()),
        sa.Column("generated_by", sa.Text(), nullable=False, server_default="system"),
        sa.Column("is_current", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["preparation_id"],
            ["public.content_plan_preparations.id"],
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "snapshot_version > 0", name="ck_content_plan_serp_snapshots_version"
        ),
        sa.CheckConstraint(
            "generated_by = 'system'",
            name="ck_content_plan_serp_snapshots_generated_by",
        ),
        sa.CheckConstraint(
            "NOT cache_hit OR cost_usd = 0",
            name="ck_content_plan_serp_snapshots_cache_cost",
        ),
        sa.UniqueConstraint(
            "preparation_id",
            "snapshot_version",
            name="uq_content_plan_serp_snapshots_version",
        ),
        sa.UniqueConstraint(
            "preparation_id",
            "id",
            name="uq_content_plan_serp_snapshots_preparation_id",
        ),
        schema="public",
    )
    op.create_index(
        "ix_content_plan_serp_snapshots_preparation_id",
        "content_plan_serp_snapshots",
        ["preparation_id"],
        schema="public",
    )
    op.create_index(
        "uq_content_plan_serp_snapshots_current",
        "content_plan_serp_snapshots",
        ["preparation_id"],
        unique=True,
        postgresql_where=sa.text("is_current"),
        schema="public",
    )

    op.create_table(
        "content_plan_items",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("batch_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("seed_keyword_id", sa.Text()),
        sa.Column("seed_keyword", sa.Text(), nullable=False),
        sa.Column("normalized_seed_keyword", sa.Text(), nullable=False),
        sa.Column("source_priority_score", sa.Float()),
        sa.Column("source_rank", sa.Integer()),
        sa.Column("plan_order", sa.Integer()),
        sa.Column("primary_keyword", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("writing_direction", sa.Text(), nullable=False),
        sa.Column(
            "title_user_edited", sa.Boolean(), nullable=False, server_default="false"
        ),
        sa.Column(
            "direction_user_edited", sa.Boolean(), nullable=False, server_default="false"
        ),
        sa.Column("current_preparation_id", sa.Text(), nullable=False),
        sa.Column("current_serp_snapshot_id", sa.Text(), nullable=False),
        sa.Column("pending_preparation_id", sa.Text()),
        sa.Column(
            "preparation_version", sa.Integer(), nullable=False, server_default="1"
        ),
        sa.Column("edit_state", sa.Text(), nullable=False, server_default="idle"),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("publish_local_date", sa.Date()),
        sa.Column("publish_local_time", sa.Time()),
        sa.Column("schedule_timezone", sa.Text()),
        sa.Column("publish_at", sa.DateTime(timezone=True)),
        sa.Column("generation_at", sa.DateTime(timezone=True)),
        sa.Column(
            "date_user_pinned", sa.Boolean(), nullable=False, server_default="false"
        ),
        sa.Column("schedule_attention_reason", sa.Text()),
        sa.Column("status", sa.Text(), nullable=False, server_default="unscheduled"),
        sa.Column("article_id", sa.Text()),
        sa.Column("trigger_lease_until", sa.DateTime(timezone=True)),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["batch_id"], ["public.content_plan_batches.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["platform.projects.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["seed_keyword_id"], ["public.keywords.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["current_preparation_id"],
            ["public.content_plan_preparations.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["current_serp_snapshot_id"],
            ["public.content_plan_serp_snapshots.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["pending_preparation_id"],
            ["public.content_plan_preparations.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["article_id"], ["public.articles.id"], ondelete="SET NULL"
        ),
        sa.CheckConstraint(
            "source IN ('automatic','manual')", name="ck_content_plan_items_source"
        ),
        sa.CheckConstraint(
            "edit_state IN ('idle','repreparing','reprepare_failed')",
            name="ck_content_plan_items_edit_state",
        ),
        sa.CheckConstraint(
            "status IN ('unscheduled','scheduled','triggering','generating','generated',"
            "'failed','cancelled')",
            name="ck_content_plan_items_status",
        ),
        sa.CheckConstraint(
            "schedule_attention_reason IS NULL OR "
            "schedule_attention_reason = 'expired_user_pinned_date'",
            name="ck_content_plan_items_attention_reason",
        ),
        sa.CheckConstraint(
            "preparation_version > 0 AND version > 0",
            name="ck_content_plan_items_versions",
        ),
        sa.UniqueConstraint(
            "current_preparation_id", name="uq_content_plan_items_current_preparation"
        ),
        sa.UniqueConstraint("article_id", name="uq_content_plan_items_article"),
        schema="public",
    )
    op.create_index(
        "ix_content_plan_items_batch_id",
        "content_plan_items",
        ["batch_id"],
        schema="public",
    )
    op.create_index(
        "ix_content_plan_items_project_id",
        "content_plan_items",
        ["project_id"],
        schema="public",
    )
    op.create_index(
        "uq_content_plan_items_batch_plan_order",
        "content_plan_items",
        ["batch_id", "plan_order"],
        unique=True,
        postgresql_where=sa.text("plan_order IS NOT NULL"),
        schema="public",
    )
    op.create_index(
        "uq_content_plan_items_active_publish_date",
        "content_plan_items",
        ["project_id", "publish_local_date"],
        unique=True,
        postgresql_where=sa.text(
            "status <> 'cancelled' AND publish_local_date IS NOT NULL"
        ),
        schema="public",
    )
    op.create_index(
        "uq_content_plan_items_active_seed",
        "content_plan_items",
        ["project_id", "normalized_seed_keyword"],
        unique=True,
        postgresql_where=sa.text("status <> 'cancelled'"),
        schema="public",
    )
    op.create_index(
        "ix_content_plan_items_project_generation",
        "content_plan_items",
        ["project_id", "generation_at"],
        schema="public",
    )

    op.create_table(
        "content_plan_item_keywords",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("plan_item_id", sa.Text(), nullable=False),
        sa.Column("preparation_keyword_id", sa.Text()),
        sa.Column("keyword_id", sa.Text()),
        sa.Column("keyword", sa.Text(), nullable=False),
        sa.Column("normalized_keyword", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("keyword_type", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("search_volume", sa.Integer()),
        sa.Column("keyword_difficulty", sa.Integer()),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["plan_item_id"], ["public.content_plan_items.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["preparation_keyword_id"],
            ["public.content_plan_preparation_keywords.id"],
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["keyword_id"], ["public.keywords.id"], ondelete="SET NULL"
        ),
        sa.CheckConstraint(
            "role IN ('primary','secondary')", name="ck_content_plan_item_keywords_role"
        ),
        sa.CheckConstraint(
            "keyword_type IN ('informational','service','product','unknown')",
            name="ck_content_plan_item_keywords_type",
        ),
        sa.CheckConstraint(
            "source IN ('seed','related','ai','user')",
            name="ck_content_plan_item_keywords_source",
        ),
        sa.CheckConstraint(
            "role <> 'primary' OR keyword_type = 'informational'",
            name="ck_content_plan_item_keywords_primary_type",
        ),
        sa.CheckConstraint(
            "position > 0", name="ck_content_plan_item_keywords_position"
        ),
        sa.UniqueConstraint(
            "plan_item_id",
            "normalized_keyword",
            name="uq_content_plan_item_keywords_normalized",
        ),
        sa.UniqueConstraint(
            "plan_item_id", "position", name="uq_content_plan_item_keywords_position"
        ),
        schema="public",
    )
    op.create_index(
        "ix_content_plan_item_keywords_plan_item_id",
        "content_plan_item_keywords",
        ["plan_item_id"],
        schema="public",
    )
    op.create_index(
        "uq_content_plan_item_keywords_primary",
        "content_plan_item_keywords",
        ["plan_item_id"],
        unique=True,
        postgresql_where=sa.text("role = 'primary'"),
        schema="public",
    )

    op.create_table(
        "content_plan_external_requests",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("batch_id", sa.Text(), nullable=False),
        sa.Column("preparation_id", sa.Text()),
        sa.Column("plan_item_id", sa.Text()),
        sa.Column("request_key", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("round", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.Text(), nullable=False, server_default="prepared"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "cost_usd", sa.Numeric(12, 6), nullable=False, server_default="0"
        ),
        sa.Column("result_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "provider_request_ids",
            jsonb,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "response_metadata_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column("claim_token", sa.Text()),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
        sa.Column("submitted_at", sa.DateTime(timezone=True)),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.ForeignKeyConstraint(
            ["batch_id"], ["public.content_plan_batches.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["preparation_id"],
            ["public.content_plan_preparations.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["plan_item_id"], ["public.content_plan_items.id"], ondelete="CASCADE"
        ),
        sa.UniqueConstraint(
            "request_key", name="uq_content_plan_external_requests_request_key"
        ),
        sa.CheckConstraint(
            "status IN ('prepared','submitted','completed','retryable_failed',"
            "'charged_failed','uncertain','failed')",
            name="ck_content_plan_external_requests_status",
        ),
        sa.CheckConstraint(
            '"round" >= 0', name="ck_content_plan_external_requests_round"
        ),
        schema="public",
    )
    op.create_index(
        "ix_content_plan_external_requests_batch_id",
        "content_plan_external_requests",
        ["batch_id"],
        schema="public",
    )
    op.create_index(
        "ix_content_plan_external_requests_lease",
        "content_plan_external_requests",
        ["status", "lease_expires_at"],
        schema="public",
    )
    op.create_index(
        "ix_content_plan_external_requests_batch_provider",
        "content_plan_external_requests",
        ["batch_id", "provider"],
        schema="public",
    )

    op.create_table(
        "content_plan_settings",
        sa.Column("project_id", sa.Text(), primary_key=True),
        sa.Column("cadence", sa.Text(), nullable=False, server_default="weekly_2_3"),
        sa.Column("paused", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("timezone", sa.Text(), nullable=False),
        sa.Column(
            "default_publish_local_time",
            sa.Time(),
            nullable=False,
            server_default="10:00:00",
        ),
        sa.Column("cadence_anchor_week", sa.Date()),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["platform.projects.id"], ondelete="CASCADE"
        ),
        sa.CheckConstraint(
            "cadence IN ('weekly_1','weekly_2_3','weekly_5','weekly_7')",
            name="ck_content_plan_settings_cadence",
        ),
        sa.CheckConstraint("version > 0", name="ck_content_plan_settings_version"),
        sa.CheckConstraint("timezone <> ''", name="ck_content_plan_settings_timezone"),
        sa.CheckConstraint(
            "(cadence = 'weekly_2_3' AND cadence_anchor_week IS NOT NULL "
            "AND EXTRACT(ISODOW FROM cadence_anchor_week) = 1) OR "
            "(cadence <> 'weekly_2_3' AND cadence_anchor_week IS NULL)",
            name="ck_content_plan_settings_anchor",
        ),
        schema="public",
    )

    op.add_column("articles", sa.Column("review_status", sa.Text()), schema="public")
    op.add_column(
        "articles",
        sa.Column("review_version", sa.Integer(), nullable=False, server_default="0"),
        schema="public",
    )
    op.add_column("articles", sa.Column("review_note", sa.Text()), schema="public")
    op.add_column(
        "articles", sa.Column("reviewed_at", sa.DateTime(timezone=True)), schema="public"
    )
    op.add_column("articles", sa.Column("reviewed_by", sa.Text()), schema="public")
    op.add_column(
        "articles", sa.Column("publication_blocked_reason", sa.Text()), schema="public"
    )
    op.create_check_constraint(
        "ck_articles_review_status",
        "articles",
        "review_status IS NULL OR review_status IN "
        "('pending_review','approved','changes_requested')",
        schema="public",
    )
    op.create_check_constraint(
        "ck_articles_publication_blocked_reason",
        "articles",
        "publication_blocked_reason IS NULL OR publication_blocked_reason IN "
        "('changes_requested','awaiting_review','quality_not_ready','publishing_paused')",
        schema="public",
    )
    op.create_check_constraint(
        "ck_articles_review_version",
        "articles",
        "review_version >= 0",
        schema="public",
    )

    op.create_table(
        "article_review_decisions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("article_id", sa.Text(), nullable=False),
        sa.Column("article_run_id", sa.Text()),
        sa.Column("review_version", sa.Integer(), nullable=False),
        sa.Column("decision", sa.Text(), nullable=False),
        sa.Column("review_note", sa.Text()),
        sa.Column("reviewed_by", sa.Text(), nullable=False),
        sa.Column(
            "reviewed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["article_id"], ["public.articles.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["article_run_id"], ["public.article_runs.id"], ondelete="SET NULL"
        ),
        sa.UniqueConstraint(
            "article_id",
            "review_version",
            name="uq_article_review_decisions_article_version",
        ),
        sa.CheckConstraint(
            "decision IN ('approved','changes_requested')",
            name="ck_article_review_decisions_decision",
        ),
        sa.CheckConstraint(
            "review_version > 0", name="ck_article_review_decisions_review_version"
        ),
        schema="public",
    )
    op.create_index(
        "ix_article_review_decisions_article_id",
        "article_review_decisions",
        ["article_id"],
        schema="public",
    )

    op.create_foreign_key(
        "fk_content_plan_preparations_plan_item",
        "content_plan_preparations",
        "content_plan_items",
        ["plan_item_id"],
        ["id"],
        source_schema="public",
        referent_schema="public",
        ondelete="SET NULL",
        deferrable=True,
        initially="DEFERRED",
    )
    op.create_foreign_key(
        "fk_content_plan_preparations_selected_primary",
        "content_plan_preparations",
        "content_plan_preparation_keywords",
        ["id", "selected_primary_candidate_id"],
        ["preparation_id", "id"],
        source_schema="public",
        referent_schema="public",
        deferrable=True,
        initially="DEFERRED",
    )
    op.create_foreign_key(
        "fk_content_plan_preparations_current_serp",
        "content_plan_preparations",
        "content_plan_serp_snapshots",
        ["id", "current_serp_snapshot_id"],
        ["preparation_id", "id"],
        source_schema="public",
        referent_schema="public",
        deferrable=True,
        initially="DEFERRED",
    )

    op.execute(
        """
        CREATE FUNCTION public.validate_content_plan_candidate_snapshot_state()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
            actual_count integer;
            minimum_rank integer;
            maximum_rank integer;
        BEGIN
            IF OLD.candidate_snapshot_status = 'completed'
               AND (NEW.candidate_snapshot_status <> 'completed'
                    OR NEW.candidate_snapshot_count <> OLD.candidate_snapshot_count) THEN
                RAISE EXCEPTION 'completed content plan candidate snapshot cannot be changed'
                    USING ERRCODE = '23514',
                    CONSTRAINT = 'ck_content_plan_candidate_snapshot_completed';
            END IF;

            IF OLD.candidate_snapshot_status <> 'completed'
               AND NEW.candidate_snapshot_status = 'completed' THEN
                SELECT count(*), min(source_rank), max(source_rank)
                INTO actual_count, minimum_rank, maximum_rank
                FROM public.content_plan_candidates
                WHERE batch_id = NEW.id;

                IF actual_count <> NEW.candidate_snapshot_count
                   OR (actual_count > 0 AND (
                       minimum_rank <> 1 OR maximum_rank <> actual_count
                   )) THEN
                    RAISE EXCEPTION 'content plan candidate snapshot ranks must be contiguous'
                        USING ERRCODE = '23514',
                        CONSTRAINT = 'ck_content_plan_candidates_contiguous_source_rank';
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER content_plan_candidate_snapshot_state
        BEFORE UPDATE OF candidate_snapshot_status, candidate_snapshot_count
        ON public.content_plan_batches
        FOR EACH ROW EXECUTE FUNCTION public.validate_content_plan_candidate_snapshot_state()
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.protect_content_plan_candidate_snapshot()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
            target_batch_id text;
            snapshot_status text;
        BEGIN
            IF TG_OP = 'UPDATE' AND OLD.batch_id IS DISTINCT FROM NEW.batch_id THEN
                RAISE EXCEPTION 'content plan candidate cannot move between batches'
                    USING ERRCODE = '23514',
                    CONSTRAINT = 'ck_content_plan_candidates_batch_immutable';
            END IF;
            target_batch_id := COALESCE(NEW.batch_id, OLD.batch_id);
            SELECT candidate_snapshot_status
            INTO snapshot_status
            FROM public.content_plan_batches
            WHERE id = target_batch_id
            FOR UPDATE;

            IF snapshot_status = 'completed' THEN
                RAISE EXCEPTION 'completed content plan candidate snapshot is immutable'
                    USING ERRCODE = '23514',
                    CONSTRAINT = 'ck_content_plan_candidates_snapshot_immutable';
            END IF;
            RETURN COALESCE(NEW, OLD);
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER content_plan_candidates_snapshot_immutable
        BEFORE INSERT OR DELETE OR UPDATE OF batch_id, source_rank, priority_score_snapshot
        ON public.content_plan_candidates
        FOR EACH ROW EXECUTE FUNCTION public.protect_content_plan_candidate_snapshot()
        """
    )

    op.execute(
        """
        CREATE FUNCTION public.assert_content_plan_item_keyword_package(item_id text)
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        DECLARE
            item_exists boolean;
            keyword_count integer;
            primary_count integer;
            secondary_count integer;
            minimum_position integer;
            maximum_position integer;
        BEGIN
            SELECT EXISTS (
                SELECT 1 FROM public.content_plan_items WHERE id = item_id
            ) INTO item_exists;
            IF NOT item_exists THEN
                RETURN;
            END IF;

            SELECT
                count(*),
                count(*) FILTER (WHERE role = 'primary'),
                count(*) FILTER (WHERE role = 'secondary'),
                min(position),
                max(position)
            INTO
                keyword_count,
                primary_count,
                secondary_count,
                minimum_position,
                maximum_position
            FROM public.content_plan_item_keywords
            WHERE plan_item_id = item_id;

            IF primary_count <> 1 THEN
                RAISE EXCEPTION 'content plan item % must have exactly one primary keyword',
                    item_id USING ERRCODE = '23514',
                    CONSTRAINT = 'ck_content_plan_item_keywords_exactly_one_primary';
            END IF;
            IF secondary_count > 8 THEN
                RAISE EXCEPTION 'content plan item % has more than eight secondary keywords',
                    item_id USING ERRCODE = '23514',
                    CONSTRAINT = 'ck_content_plan_item_keywords_secondary_limit';
            END IF;
            IF minimum_position <> 1 OR maximum_position <> keyword_count THEN
                RAISE EXCEPTION 'content plan item % keyword positions must be contiguous',
                    item_id USING ERRCODE = '23514',
                    CONSTRAINT = 'ck_content_plan_item_keywords_contiguous_positions';
            END IF;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.validate_content_plan_item_keyword_package()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF TG_TABLE_NAME = 'content_plan_items' THEN
                IF TG_OP <> 'DELETE' THEN
                    PERFORM public.assert_content_plan_item_keyword_package(NEW.id);
                END IF;
            ELSE
                IF TG_OP = 'INSERT' THEN
                    PERFORM public.assert_content_plan_item_keyword_package(NEW.plan_item_id);
                ELSIF TG_OP = 'DELETE' THEN
                    PERFORM public.assert_content_plan_item_keyword_package(OLD.plan_item_id);
                ELSE
                    PERFORM public.assert_content_plan_item_keyword_package(NEW.plan_item_id);
                    IF OLD.plan_item_id IS DISTINCT FROM NEW.plan_item_id THEN
                        PERFORM public.assert_content_plan_item_keyword_package(OLD.plan_item_id);
                    END IF;
                END IF;
            END IF;
            RETURN COALESCE(NEW, OLD);
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER content_plan_items_keyword_package
        AFTER INSERT OR UPDATE ON public.content_plan_items
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.validate_content_plan_item_keyword_package()
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER content_plan_item_keywords_package
        AFTER INSERT OR UPDATE OR DELETE ON public.content_plan_item_keywords
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.validate_content_plan_item_keyword_package()
        """
    )

    op.execute(
        """
        CREATE FUNCTION public.validate_content_plan_preparation_relation()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE
            secondary_relevance text;
        BEGIN
            IF TG_OP = 'DELETE' THEN
                RETURN OLD;
            END IF;
            SELECT relevance
            INTO secondary_relevance
            FROM public.content_plan_preparation_keywords
            WHERE preparation_id = NEW.preparation_id
              AND id = NEW.secondary_candidate_id;

            IF secondary_relevance IS DISTINCT FROM 'same_topic' THEN
                RAISE EXCEPTION 'content plan relation secondary keyword must be same_topic'
                    USING ERRCODE = '23514',
                    CONSTRAINT = 'ck_content_plan_preparation_relations_same_topic';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER content_plan_preparation_relations_same_topic
        AFTER INSERT OR UPDATE ON public.content_plan_preparation_relations
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.validate_content_plan_preparation_relation()
        """
    )
    op.execute(
        """
        CREATE FUNCTION public.validate_content_plan_relation_keyword_relevance()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
            IF NEW.relevance <> 'same_topic' AND EXISTS (
                SELECT 1
                FROM public.content_plan_preparation_relations
                WHERE preparation_id = NEW.preparation_id
                  AND secondary_candidate_id = NEW.id
            ) THEN
                RAISE EXCEPTION 'content plan relation secondary keyword must be same_topic'
                    USING ERRCODE = '23514',
                    CONSTRAINT = 'ck_content_plan_preparation_relations_same_topic';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )
    op.execute(
        """
        CREATE CONSTRAINT TRIGGER content_plan_relation_keyword_relevance
        AFTER UPDATE OF relevance ON public.content_plan_preparation_keywords
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION public.validate_content_plan_relation_keyword_relevance()
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER IF EXISTS content_plan_candidates_snapshot_immutable "
        "ON public.content_plan_candidates"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS content_plan_candidate_snapshot_state "
        "ON public.content_plan_batches"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS content_plan_relation_keyword_relevance "
        "ON public.content_plan_preparation_keywords"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS content_plan_preparation_relations_same_topic "
        "ON public.content_plan_preparation_relations"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS content_plan_item_keywords_package "
        "ON public.content_plan_item_keywords"
    )
    op.execute(
        "DROP TRIGGER IF EXISTS content_plan_items_keyword_package "
        "ON public.content_plan_items"
    )
    op.execute("DROP FUNCTION IF EXISTS public.validate_content_plan_relation_keyword_relevance()")
    op.execute("DROP FUNCTION IF EXISTS public.validate_content_plan_preparation_relation()")
    op.execute("DROP FUNCTION IF EXISTS public.validate_content_plan_item_keyword_package()")
    op.execute("DROP FUNCTION IF EXISTS public.assert_content_plan_item_keyword_package(text)")
    op.execute("DROP FUNCTION IF EXISTS public.protect_content_plan_candidate_snapshot()")
    op.execute("DROP FUNCTION IF EXISTS public.validate_content_plan_candidate_snapshot_state()")

    op.drop_constraint(
        "fk_content_plan_preparations_current_serp",
        "content_plan_preparations",
        type_="foreignkey",
        schema="public",
    )
    op.drop_constraint(
        "fk_content_plan_preparations_selected_primary",
        "content_plan_preparations",
        type_="foreignkey",
        schema="public",
    )
    op.drop_constraint(
        "fk_content_plan_preparations_plan_item",
        "content_plan_preparations",
        type_="foreignkey",
        schema="public",
    )

    op.drop_index(
        "ix_article_review_decisions_article_id",
        table_name="article_review_decisions",
        schema="public",
    )
    op.drop_table("article_review_decisions", schema="public")
    op.drop_constraint(
        "ck_articles_review_version", "articles", type_="check", schema="public"
    )
    op.drop_constraint(
        "ck_articles_publication_blocked_reason",
        "articles",
        type_="check",
        schema="public",
    )
    op.drop_constraint(
        "ck_articles_review_status", "articles", type_="check", schema="public"
    )
    op.drop_column("articles", "publication_blocked_reason", schema="public")
    op.drop_column("articles", "reviewed_by", schema="public")
    op.drop_column("articles", "reviewed_at", schema="public")
    op.drop_column("articles", "review_note", schema="public")
    op.drop_column("articles", "review_version", schema="public")
    op.drop_column("articles", "review_status", schema="public")

    op.drop_table("content_plan_settings", schema="public")
    op.drop_table("content_plan_external_requests", schema="public")
    op.drop_table("content_plan_item_keywords", schema="public")
    op.drop_table("content_plan_items", schema="public")
    op.drop_table("content_plan_serp_snapshots", schema="public")
    op.drop_table("content_plan_preparation_relations", schema="public")
    op.drop_table("content_plan_preparation_keywords", schema="public")
    op.drop_table("content_plan_preparations", schema="public")
    op.drop_table("content_plan_candidates", schema="public")
    op.drop_table("content_plan_batches", schema="public")
