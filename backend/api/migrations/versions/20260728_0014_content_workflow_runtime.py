"""Add content workflow execution leases.

Revision ID: 20260728_0014
Revises: 20260728_0013
Create Date: 2026-07-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260728_0014"
down_revision: str | Sequence[str] | None = "20260728_0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("article_run_steps", sa.Column("worker_id", sa.Text()))
    op.add_column(
        "article_run_steps",
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
    )


def downgrade() -> None:
    op.drop_column("article_run_steps", "lease_expires_at")
    op.drop_column("article_run_steps", "worker_id")
