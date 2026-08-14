"""Add article performance monitoring.

Revision ID: 20260813_0063
Revises: 20260813_0062
Create Date: 2026-08-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260813_0063"
down_revision: str | Sequence[str] | None = "20260813_0062"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "performance_sync_runs",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("data_through", sa.Date(), nullable=True),
        sa.Column("target_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('running','completed','failed')",
            name="ck_performance_sync_runs_status",
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_performance_sync_runs_organization_id", "performance_sync_runs", ["organization_id"])
    op.create_index("ix_performance_sync_runs_project_started", "performance_sync_runs", ["project_id", "started_at"])
    op.create_index(
        "uq_performance_sync_runs_running_project",
        "performance_sync_runs",
        ["organization_id", "project_id"],
        unique=True,
        postgresql_where=sa.text("status = 'running'"),
    )

    op.create_table(
        "article_performance_targets",
        sa.Column("article_id", sa.Text(), nullable=False),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("publication_id", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("normalized_url", sa.Text(), nullable=False),
        sa.Column("aliases_json", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_published_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("publication_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["article_id"], ["articles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["publication_id"], ["article_publications.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("article_id"),
        sa.UniqueConstraint("project_id", "normalized_url", name="uq_article_performance_target_url"),
    )
    op.create_index("ix_article_performance_targets_organization_id", "article_performance_targets", ["organization_id"])
    op.create_index("ix_article_performance_targets_project", "article_performance_targets", ["project_id"])

    op.create_table(
        "gsc_site_daily",
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("clicks", sa.Float(), nullable=False, server_default="0"),
        sa.Column("impressions", sa.Float(), nullable=False, server_default="0"),
        sa.Column("position", sa.Float(), nullable=False, server_default="0"),
        sa.Column("synced_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id", "date"),
    )

    op.create_table(
        "article_gsc_daily",
        sa.Column("article_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("clicks", sa.Float(), nullable=False, server_default="0"),
        sa.Column("impressions", sa.Float(), nullable=False, server_default="0"),
        sa.Column("position", sa.Float(), nullable=False, server_default="0"),
        sa.Column("synced_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["article_id"], ["article_performance_targets.article_id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("article_id", "date"),
    )
    op.create_index("ix_article_gsc_daily_date", "article_gsc_daily", ["project_id", "date"])

    op.create_table(
        "performance_signals",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("article_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="open"),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("detected_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('open','resolved')", name="ck_performance_signals_status"),
        sa.ForeignKeyConstraint(["article_id"], ["article_performance_targets.article_id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_performance_signals_organization_id", "performance_signals", ["organization_id"])
    op.create_index("ix_performance_signals_project_status", "performance_signals", ["project_id", "status"])
    op.create_index(
        "uq_performance_signals_open",
        "performance_signals",
        ["article_id", "kind"],
        unique=True,
        postgresql_where=sa.text("status = 'open'"),
    )


def downgrade() -> None:
    op.drop_table("performance_signals")
    op.drop_table("article_gsc_daily")
    op.drop_table("gsc_site_daily")
    op.drop_table("article_performance_targets")
    op.drop_table("performance_sync_runs")
