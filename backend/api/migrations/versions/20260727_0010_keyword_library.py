"""Add automatic keyword library and expansion rounds.

Revision ID: 20260727_0010
Revises: 20260724_0009
Create Date: 2026-07-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260727_0010"
down_revision: str | Sequence[str] | None = "20260724_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def jsonb_column(name: str, default: str) -> sa.Column:
    return sa.Column(
        name,
        postgresql.JSONB(astext_type=sa.Text()),
        nullable=False,
        server_default=sa.text(default),
    )


def created_at_column() -> sa.Column:
    return sa.Column(
        "created_at",
        sa.DateTime(timezone=True),
        nullable=False,
        server_default=sa.func.now(),
    )


def updated_at_column() -> sa.Column:
    return sa.Column(
        "updated_at",
        sa.DateTime(timezone=True),
        nullable=False,
        server_default=sa.func.now(),
    )


def upgrade() -> None:
    op.create_table(
        "keyword_build_runs",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("round_number", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("stage", sa.Text(), nullable=False, server_default="queued"),
        sa.Column(
            "message",
            sa.Text(),
            nullable=False,
            server_default="正在准备关键词库",
        ),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("discovered_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("selected_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("keyword_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("pending_seed_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("result_version", sa.Integer(), nullable=False, server_default="0"),
        jsonb_column("profile_snapshot", "'{}'::jsonb"),
        jsonb_column("partial_failures", "'[]'::jsonb"),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column(
            "total_cost_usd",
            sa.Numeric(12, 6),
            nullable=False,
            server_default="0",
        ),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        created_at_column(),
        updated_at_column(),
        sa.CheckConstraint(
            "kind IN ('initial', 'expansion')",
            name="ck_keyword_build_runs_kind",
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'partial', 'completed', 'failed')",
            name="ck_keyword_build_runs_status",
        ),
        sa.CheckConstraint(
            "progress BETWEEN 0 AND 100",
            name="ck_keyword_build_runs_progress",
        ),
        sa.UniqueConstraint(
            "project_id",
            "round_number",
            name="uq_keyword_build_runs_project_round",
        ),
    )
    op.create_index(
        "ix_keyword_build_runs_organization_id",
        "keyword_build_runs",
        ["organization_id"],
    )
    op.create_index(
        "ix_keyword_build_runs_project_id",
        "keyword_build_runs",
        ["project_id"],
    )
    op.create_index(
        "ix_keyword_build_runs_project_created",
        "keyword_build_runs",
        ["project_id", "created_at"],
    )
    op.create_index(
        "uq_keyword_build_runs_active_project",
        "keyword_build_runs",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running')"),
    )

    op.create_table(
        "keyword_workflow_dispatches",
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("workflow_id", sa.Text(), nullable=False, unique=True),
        jsonb_column("task_payload", "'{}'::jsonb"),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error", sa.Text()),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("dispatched_at", sa.DateTime(timezone=True)),
        created_at_column(),
        updated_at_column(),
        sa.CheckConstraint(
            "status IN ('pending', 'dispatched')",
            name="ck_keyword_workflow_dispatches_status",
        ),
    )
    op.create_index(
        "ix_keyword_workflow_dispatches_pending",
        "keyword_workflow_dispatches",
        ["status", "next_attempt_at"],
    )

    op.create_table(
        "keyword_seeds",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "initial_run_id",
            sa.Text(),
            sa.ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("keyword", sa.Text(), nullable=False),
        sa.Column("normalized_keyword", sa.Text(), nullable=False),
        sa.Column("candidate_rank", sa.Integer(), nullable=False),
        sa.Column("candidate_score", sa.Float(), nullable=False),
        jsonb_column("candidate_details", "'{}'::jsonb"),
        sa.Column("decision", sa.Text(), nullable=False),
        sa.Column("ai_rank", sa.Integer()),
        sa.Column("business_topic", sa.Text()),
        sa.Column("reason_code", sa.Text()),
        sa.Column("reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("expansion_status", sa.Text(), nullable=False),
        sa.Column(
            "expansion_run_id",
            sa.Text(),
            sa.ForeignKey("keyword_build_runs.id", ondelete="SET NULL"),
        ),
        sa.Column("expansion_round_number", sa.Integer()),
        sa.Column("expanded_at", sa.DateTime(timezone=True)),
        created_at_column(),
        updated_at_column(),
        sa.CheckConstraint(
            "decision IN ('selected', 'rejected')",
            name="ck_keyword_seeds_decision",
        ),
        sa.CheckConstraint(
            "expansion_status IN "
            "('not_applicable', 'pending_expansion', 'processing', 'expanded', 'failed')",
            name="ck_keyword_seeds_expansion_status",
        ),
        sa.UniqueConstraint(
            "initial_run_id",
            "normalized_keyword",
            name="uq_keyword_seeds_initial_normalized",
        ),
    )
    op.create_index(
        "ix_keyword_seeds_organization_id",
        "keyword_seeds",
        ["organization_id"],
    )
    op.create_index(
        "ix_keyword_seeds_project_id",
        "keyword_seeds",
        ["project_id"],
    )
    op.create_index(
        "ix_keyword_seeds_project_pending",
        "keyword_seeds",
        ["project_id", "expansion_status", "ai_rank"],
    )

    op.create_table(
        "keyword_ideas",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "build_run_id",
            sa.Text(),
            sa.ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column(
            "source_seed_id",
            sa.Text(),
            sa.ForeignKey("keyword_seeds.id", ondelete="SET NULL"),
        ),
        sa.Column("source_seed_key", sa.Text(), nullable=False, server_default=""),
        sa.Column("keyword", sa.Text(), nullable=False),
        sa.Column("normalized_keyword", sa.Text(), nullable=False),
        sa.Column("provider_rank", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("search_volume", sa.Integer()),
        sa.Column("cpc", sa.Float()),
        sa.Column("competition", sa.Float()),
        sa.Column("keyword_difficulty", sa.Integer()),
        sa.Column("intent", sa.Text()),
        jsonb_column("monthly_searches", "'[]'::jsonb"),
        jsonb_column("raw_payload", "'{}'::jsonb"),
        jsonb_column("metrics_payload", "'{}'::jsonb"),
        sa.Column("business_relevance", sa.Float()),
        sa.Column("included", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("exclusion_reason", sa.Text()),
        created_at_column(),
        sa.CheckConstraint(
            "source IN ('site_seed', 'seed', 'google_ads', 'google_suggest', 'ai')",
            name="ck_keyword_ideas_source",
        ),
        sa.UniqueConstraint(
            "build_run_id",
            "source",
            "normalized_keyword",
            "source_seed_key",
            name="uq_keyword_ideas_run_source_keyword_seed",
        ),
    )
    op.create_index(
        "ix_keyword_ideas_organization_id",
        "keyword_ideas",
        ["organization_id"],
    )
    op.create_index("ix_keyword_ideas_project_id", "keyword_ideas", ["project_id"])
    op.create_index(
        "ix_keyword_ideas_project_run",
        "keyword_ideas",
        ["project_id", "build_run_id"],
    )
    op.create_index(
        "ix_keyword_ideas_run_included",
        "keyword_ideas",
        ["build_run_id", "included"],
    )

    op.create_table(
        "keywords",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("country", sa.Text(), nullable=False),
        sa.Column("language", sa.Text(), nullable=False),
        sa.Column("keyword", sa.Text(), nullable=False),
        sa.Column("normalized_keyword", sa.Text(), nullable=False),
        sa.Column(
            "primary_seed_id",
            sa.Text(),
            sa.ForeignKey("keyword_seeds.id", ondelete="SET NULL"),
        ),
        sa.Column("priority_score", sa.Float()),
        sa.Column("priority_confidence", sa.Float()),
        jsonb_column("priority_details", "'{}'::jsonb"),
        sa.Column("score_version", sa.Text()),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column(
            "metrics_status",
            sa.Text(),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "first_build_run_id",
            sa.Text(),
            sa.ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "last_build_run_id",
            sa.Text(),
            sa.ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        created_at_column(),
        updated_at_column(),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "status IN ('active', 'archived')",
            name="ck_keywords_status",
        ),
        sa.CheckConstraint(
            "metrics_status IN ('pending', 'fresh', 'stale', 'failed')",
            name="ck_keywords_metrics_status",
        ),
        sa.UniqueConstraint(
            "project_id",
            "country",
            "language",
            "normalized_keyword",
            name="uq_keywords_project_market_normalized",
        ),
    )
    op.create_index("ix_keywords_organization_id", "keywords", ["organization_id"])
    op.create_index("ix_keywords_project_id", "keywords", ["project_id"])
    op.create_index(
        "ix_keywords_project_created",
        "keywords",
        ["project_id", "created_at"],
    )
    op.create_index(
        "ix_keywords_project_priority",
        "keywords",
        ["project_id", "priority_score"],
    )

    op.create_table(
        "keyword_metrics",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "keyword_id",
            sa.Text(),
            sa.ForeignKey("keywords.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("search_volume", sa.Integer()),
        sa.Column("cpc", sa.Float()),
        sa.Column("competition", sa.Float()),
        sa.Column("competition_level", sa.Text()),
        sa.Column("keyword_difficulty", sa.Integer()),
        sa.Column("intent", sa.Text()),
        jsonb_column("monthly_searches", "'[]'::jsonb"),
        jsonb_column("raw_payload", "'{}'::jsonb"),
        sa.Column(
            "fetched_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "keyword_id",
            "provider",
            name="uq_keyword_metrics_keyword_provider",
        ),
    )
    op.create_index("ix_keyword_metrics_keyword_id", "keyword_metrics", ["keyword_id"])
    op.create_index(
        "ix_keyword_metrics_fetched_at",
        "keyword_metrics",
        ["fetched_at"],
    )

    op.create_table(
        "keyword_sources",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "keyword_id",
            sa.Text(),
            sa.ForeignKey("keywords.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column(
            "source_seed_id",
            sa.Text(),
            sa.ForeignKey("keyword_seeds.id", ondelete="SET NULL"),
        ),
        sa.Column("source_seed_key", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "first_build_run_id",
            sa.Text(),
            sa.ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        jsonb_column("metadata_json", "'{}'::jsonb"),
        created_at_column(),
        sa.UniqueConstraint(
            "keyword_id",
            "source",
            "source_seed_key",
            name="uq_keyword_sources_keyword_source_seed",
        ),
    )
    op.create_index("ix_keyword_sources_keyword_id", "keyword_sources", ["keyword_id"])

    op.create_table(
        "keyword_seed_relations",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "keyword_id",
            sa.Text(),
            sa.ForeignKey("keywords.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "seed_id",
            sa.Text(),
            sa.ForeignKey("keyword_seeds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("relation", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("basis", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "relation IN ('primary', 'related')",
            name="ck_keyword_seed_relations_relation",
        ),
        sa.UniqueConstraint(
            "keyword_id",
            "seed_id",
            name="uq_keyword_seed_relations_keyword_seed",
        ),
    )
    op.create_index(
        "ix_keyword_seed_relations_keyword_id",
        "keyword_seed_relations",
        ["keyword_id"],
    )
    op.create_index(
        "ix_keyword_seed_relations_seed_id",
        "keyword_seed_relations",
        ["seed_id"],
    )

    op.create_table(
        "keyword_tags",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("normalized_name", sa.Text(), nullable=False),
        sa.Column("color", sa.Text()),
        created_at_column(),
        sa.UniqueConstraint(
            "project_id",
            "normalized_name",
            name="uq_keyword_tags_project_normalized",
        ),
    )
    op.create_index("ix_keyword_tags_project_id", "keyword_tags", ["project_id"])

    op.create_table(
        "keyword_tag_assignments",
        sa.Column(
            "keyword_id",
            sa.Text(),
            sa.ForeignKey("keywords.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "tag_id",
            sa.Text(),
            sa.ForeignKey("keyword_tags.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        created_at_column(),
        sa.UniqueConstraint(
            "keyword_id",
            "tag_id",
            name="uq_keyword_tag_assignments_keyword_tag",
        ),
    )

    op.create_table(
        "keyword_external_requests",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "build_run_id",
            sa.Text(),
            sa.ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("request_key", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("cost_usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
        sa.Column("result_count", sa.Integer(), nullable=False, server_default="0"),
        jsonb_column("response_metadata", "'{}'::jsonb"),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "status IN ('running', 'completed', 'failed')",
            name="ck_keyword_external_requests_status",
        ),
        sa.UniqueConstraint(
            "request_key",
            name="uq_keyword_external_requests_request_key",
        ),
    )
    op.create_index(
        "ix_keyword_external_requests_project_id",
        "keyword_external_requests",
        ["project_id"],
    )
    op.create_index(
        "ix_keyword_external_requests_project_provider",
        "keyword_external_requests",
        ["project_id", "provider"],
    )

    # Existing projects receive the same automatic initial build as newly
    # created projects. The outbox lets deployment finish even if Temporal is
    # temporarily unavailable.
    op.execute(
        """
        INSERT INTO keyword_build_runs (
            id,
            organization_id,
            project_id,
            kind,
            round_number,
            status,
            stage,
            message
        )
        SELECT
            gen_random_uuid()::text,
            project.organization_id,
            project.id,
            'initial',
            1,
            'queued',
            'queued',
            '正在准备关键词库'
        FROM projects AS project
        WHERE NOT EXISTS (
            SELECT 1
            FROM keyword_build_runs AS existing
            WHERE existing.project_id = project.id
                AND existing.round_number = 1
        )
        """
    )
    op.execute(
        """
        INSERT INTO keyword_workflow_dispatches (
            run_id,
            workflow_id,
            task_payload,
            status
        )
        SELECT
            run.id,
            'keywords:build:' || run.id,
            jsonb_build_object(
                'organization_id', run.organization_id,
                'project_id', run.project_id,
                'run_id', run.id,
                'kind', run.kind,
                'round_number', run.round_number
            ),
            'pending'
        FROM keyword_build_runs AS run
        WHERE run.kind = 'initial'
            AND run.round_number = 1
            AND NOT EXISTS (
                SELECT 1
                FROM keyword_workflow_dispatches AS dispatch
                WHERE dispatch.run_id = run.id
            )
        """
    )


def downgrade() -> None:
    op.drop_index(
        "ix_keyword_external_requests_project_provider",
        table_name="keyword_external_requests",
    )
    op.drop_index(
        "ix_keyword_external_requests_project_id",
        table_name="keyword_external_requests",
    )
    op.drop_table("keyword_external_requests")
    op.drop_table("keyword_tag_assignments")
    op.drop_index("ix_keyword_tags_project_id", table_name="keyword_tags")
    op.drop_table("keyword_tags")
    op.drop_index(
        "ix_keyword_seed_relations_seed_id",
        table_name="keyword_seed_relations",
    )
    op.drop_index(
        "ix_keyword_seed_relations_keyword_id",
        table_name="keyword_seed_relations",
    )
    op.drop_table("keyword_seed_relations")
    op.drop_index("ix_keyword_sources_keyword_id", table_name="keyword_sources")
    op.drop_table("keyword_sources")
    op.drop_index("ix_keyword_metrics_fetched_at", table_name="keyword_metrics")
    op.drop_index("ix_keyword_metrics_keyword_id", table_name="keyword_metrics")
    op.drop_table("keyword_metrics")
    op.drop_index("ix_keywords_project_priority", table_name="keywords")
    op.drop_index("ix_keywords_project_created", table_name="keywords")
    op.drop_index("ix_keywords_project_id", table_name="keywords")
    op.drop_index("ix_keywords_organization_id", table_name="keywords")
    op.drop_table("keywords")
    op.drop_index("ix_keyword_ideas_run_included", table_name="keyword_ideas")
    op.drop_index("ix_keyword_ideas_project_run", table_name="keyword_ideas")
    op.drop_index("ix_keyword_ideas_project_id", table_name="keyword_ideas")
    op.drop_index("ix_keyword_ideas_organization_id", table_name="keyword_ideas")
    op.drop_table("keyword_ideas")
    op.drop_index("ix_keyword_seeds_project_pending", table_name="keyword_seeds")
    op.drop_index("ix_keyword_seeds_project_id", table_name="keyword_seeds")
    op.drop_index("ix_keyword_seeds_organization_id", table_name="keyword_seeds")
    op.drop_table("keyword_seeds")
    op.drop_index(
        "ix_keyword_workflow_dispatches_pending",
        table_name="keyword_workflow_dispatches",
    )
    op.drop_table("keyword_workflow_dispatches")
    op.drop_index(
        "uq_keyword_build_runs_active_project",
        table_name="keyword_build_runs",
    )
    op.drop_index(
        "ix_keyword_build_runs_project_created",
        table_name="keyword_build_runs",
    )
    op.drop_index("ix_keyword_build_runs_project_id", table_name="keyword_build_runs")
    op.drop_index(
        "ix_keyword_build_runs_organization_id",
        table_name="keyword_build_runs",
    )
    op.drop_table("keyword_build_runs")
