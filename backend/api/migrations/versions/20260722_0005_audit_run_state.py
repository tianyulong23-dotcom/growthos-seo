"""Enforce one active technical audit per project.

Revision ID: 20260722_0005
Revises: 20260721_0004
Create Date: 2026-07-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260722_0005"
down_revision: str | Sequence[str] | None = "20260721_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "uq_crawl_runs_active_technical_audit",
        "crawl_runs",
        ["organization_id", "project_id"],
        unique=True,
        postgresql_where=sa.text(
            "task_type = 'technical_audit' "
            "AND archived_at IS NULL "
            "AND status IN ('queued', 'running', 'stopping')"
        ),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_crawl_runs_active_technical_audit",
        table_name="crawl_runs",
    )
