"""Separate site understanding from technical audit.

Revision ID: 20260721_0003
Revises: 20260721_0002
Create Date: 2026-07-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260721_0003"
down_revision: str | Sequence[str] | None = "20260721_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("understanding_run_id", sa.Text()))
    op.add_column("projects", sa.Column("audit_run_id", sa.Text()))
    op.add_column("projects", sa.Column("audit_health", sa.Integer()))
    op.execute(
        """
        UPDATE projects
        SET understanding_run_id = initial_crawl_run_id
        WHERE understanding_run_id IS NULL
        """
    )
    op.execute(
        """
        UPDATE crawl_runs
        SET task_type = 'site_understanding'
        WHERE task_type = 'project_initialization'
        """
    )

    op.create_table(
        "site_profiles",
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "source_run_id",
            sa.Text(),
            sa.ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "profile_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("confidence", sa.Float(), nullable=False),
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
    )


def downgrade() -> None:
    op.drop_table("site_profiles")
    op.execute(
        """
        UPDATE crawl_runs
        SET task_type = 'project_initialization'
        WHERE task_type = 'site_understanding'
        """
    )
    op.drop_column("projects", "audit_health")
    op.drop_column("projects", "audit_run_id")
    op.drop_column("projects", "understanding_run_id")
