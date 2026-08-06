"""Add independent multi-competitor keyword analysis.

Revision ID: 20260806_0023
Revises: 20260804_0022
Create Date: 2026-08-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260806_0023"
down_revision: str | Sequence[str] | None = "20260804_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "keyword_competitor_analysis_runs",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("workflow_id", sa.Text(), nullable=False, unique=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("stage", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("message", sa.Text(), nullable=False, server_default="正在准备竞争分析"),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("competitor_limit", sa.Integer(), nullable=False, server_default="5"),
        sa.Column("keyword_limit", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("discovered_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completed_competitors", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failed_competitors", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("raw_keyword_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("unique_keyword_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("discovery_cost_usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
        sa.Column("total_cost_usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'partial', 'completed', 'failed')",
            name="ck_keyword_competitor_analysis_runs_status",
        ),
        sa.CheckConstraint(
            "progress BETWEEN 0 AND 100",
            name="ck_keyword_competitor_analysis_runs_progress",
        ),
        sa.CheckConstraint(
            "competitor_limit BETWEEN 1 AND 5",
            name="ck_keyword_competitor_analysis_runs_competitor_limit",
        ),
        sa.CheckConstraint(
            "keyword_limit BETWEEN 1 AND 100",
            name="ck_keyword_competitor_analysis_runs_keyword_limit",
        ),
    )
    op.create_index(
        "ix_keyword_competitor_analysis_runs_organization_id",
        "keyword_competitor_analysis_runs",
        ["organization_id"],
    )
    op.create_index(
        "ix_keyword_competitor_analysis_runs_project_id",
        "keyword_competitor_analysis_runs",
        ["project_id"],
    )
    op.create_index(
        "ix_keyword_competitor_analysis_runs_project_created",
        "keyword_competitor_analysis_runs",
        ["project_id", "created_at"],
    )
    op.create_index(
        "uq_keyword_competitor_analysis_runs_active_project",
        "keyword_competitor_analysis_runs",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued', 'running')"),
    )

    op.create_table(
        "keyword_competitor_analysis_dispatches",
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("keyword_competitor_analysis_runs.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("workflow_id", sa.Text(), nullable=False, unique=True),
        sa.Column("task_payload", postgresql.JSONB(), nullable=False),
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
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'dispatched')",
            name="ck_keyword_competitor_analysis_dispatches_status",
        ),
    )
    op.create_index(
        "ix_keyword_competitor_analysis_dispatches_pending",
        "keyword_competitor_analysis_dispatches",
        ["status", "next_attempt_at"],
    )

    op.create_table(
        "keyword_competitors",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "analysis_run_id",
            sa.Text(),
            sa.ForeignKey("keyword_competitor_analysis_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("domain", sa.Text(), nullable=False),
        sa.Column("provider_rank", sa.Integer(), nullable=False),
        sa.Column("avg_position", sa.Float()),
        sa.Column("intersections", sa.Integer()),
        sa.Column("organic_keywords", sa.Integer()),
        sa.Column("organic_traffic", sa.Float()),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("keyword_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Numeric(12, 6), nullable=False, server_default="0"),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column(
            "raw_payload", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("analysis_run_id", "domain", name="uq_keyword_competitors_run_domain"),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'completed', 'failed', 'excluded')",
            name="ck_keyword_competitors_status",
        ),
    )
    op.create_index(
        "ix_keyword_competitors_organization_id", "keyword_competitors", ["organization_id"]
    )
    op.create_index("ix_keyword_competitors_project_id", "keyword_competitors", ["project_id"])
    op.create_index(
        "ix_keyword_competitors_analysis_run_id", "keyword_competitors", ["analysis_run_id"]
    )
    op.create_index(
        "ix_keyword_competitors_project_run",
        "keyword_competitors",
        ["project_id", "analysis_run_id"],
    )

    op.create_table(
        "keyword_competitor_shared_keywords",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "analysis_run_id",
            sa.Text(),
            sa.ForeignKey("keyword_competitor_analysis_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "competitor_id",
            sa.Text(),
            sa.ForeignKey("keyword_competitors.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("keyword", sa.Text(), nullable=False),
        sa.Column("normalized_keyword", sa.Text(), nullable=False),
        sa.Column("competitor_rank", sa.Integer()),
        sa.Column("own_rank", sa.Integer()),
        sa.Column("competitor_url", sa.Text()),
        sa.Column("own_url", sa.Text()),
        sa.Column("search_volume", sa.Integer()),
        sa.Column("cpc", sa.Float()),
        sa.Column("competition", sa.Float()),
        sa.Column("keyword_difficulty", sa.Integer()),
        sa.Column("intent", sa.Text()),
        sa.Column(
            "monthly_searches",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "raw_payload", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint(
            "competitor_id",
            "normalized_keyword",
            name="uq_keyword_competitor_shared_keywords_competitor_keyword",
        ),
    )
    op.create_index(
        "ix_keyword_competitor_shared_keywords_organization_id",
        "keyword_competitor_shared_keywords",
        ["organization_id"],
    )
    op.create_index(
        "ix_keyword_competitor_shared_keywords_project_id",
        "keyword_competitor_shared_keywords",
        ["project_id"],
    )
    op.create_index(
        "ix_keyword_competitor_shared_keywords_analysis_run_id",
        "keyword_competitor_shared_keywords",
        ["analysis_run_id"],
    )
    op.create_index(
        "ix_keyword_competitor_shared_keywords_competitor_id",
        "keyword_competitor_shared_keywords",
        ["competitor_id"],
    )
    op.create_index(
        "ix_keyword_competitor_shared_keywords_run_keyword",
        "keyword_competitor_shared_keywords",
        ["analysis_run_id", "normalized_keyword"],
    )
    op.create_index(
        "ix_keyword_competitor_shared_keywords_project_volume",
        "keyword_competitor_shared_keywords",
        ["project_id", "search_volume"],
    )


def downgrade() -> None:
    op.drop_table("keyword_competitor_shared_keywords")
    op.drop_table("keyword_competitors")
    op.drop_table("keyword_competitor_analysis_dispatches")
    op.drop_table("keyword_competitor_analysis_runs")
