"""Add durable article run failure state.

Revision ID: 20260807_0038
Revises: 20260807_0037
Create Date: 2026-08-07
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260807_0038"
down_revision: str | Sequence[str] | None = "20260807_0037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_articles_status", "articles", type_="check")
    op.create_check_constraint(
        "ck_articles_status",
        "articles",
        "status IN ('queued','running','completed','completed_with_warnings','failed','cancelled')",
    )
    op.drop_constraint("ck_article_runs_status", "article_runs", type_="check")
    op.create_check_constraint(
        "ck_article_runs_status",
        "article_runs",
        "status IN ('queued','running','completed','completed_with_warnings','failed','cancelled')",
    )
    op.add_column(
        "article_runs",
        sa.Column("trigger_type", sa.Text(), server_default="initial", nullable=False),
    )
    op.add_column("article_runs", sa.Column("parent_run_id", sa.Text(), nullable=True))
    op.add_column("article_runs", sa.Column("error_code", sa.Text(), nullable=True))
    op.add_column("article_runs", sa.Column("error_detail", sa.Text(), nullable=True))
    op.add_column("article_runs", sa.Column("failed_stage", sa.Text(), nullable=True))
    op.add_column("article_runs", sa.Column("retryable", sa.Boolean(), nullable=True))
    op.create_check_constraint(
        "ck_article_runs_trigger_type",
        "article_runs",
        "trigger_type IN ('initial','retry','regeneration')",
    )
    op.create_foreign_key(
        "fk_article_runs_parent_run_id",
        "article_runs",
        "article_runs",
        ["parent_run_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_article_runs_parent_run_id", "article_runs", ["parent_run_id"])


def downgrade() -> None:
    op.drop_index("ix_article_runs_parent_run_id", table_name="article_runs")
    op.drop_constraint("fk_article_runs_parent_run_id", "article_runs", type_="foreignkey")
    op.drop_constraint("ck_article_runs_trigger_type", "article_runs", type_="check")
    for column in (
        "retryable",
        "failed_stage",
        "error_detail",
        "error_code",
        "parent_run_id",
        "trigger_type",
    ):
        op.drop_column("article_runs", column)
    op.execute("UPDATE article_runs SET status = 'cancelled' WHERE status = 'failed'")
    op.execute("UPDATE articles SET status = 'cancelled' WHERE status = 'failed'")
    op.drop_constraint("ck_article_runs_status", "article_runs", type_="check")
    op.create_check_constraint(
        "ck_article_runs_status",
        "article_runs",
        "status IN ('queued','running','completed','completed_with_warnings','cancelled')",
    )
    op.drop_constraint("ck_articles_status", "articles", type_="check")
    op.create_check_constraint(
        "ck_articles_status",
        "articles",
        "status IN ('queued','running','completed','completed_with_warnings','cancelled')",
    )
