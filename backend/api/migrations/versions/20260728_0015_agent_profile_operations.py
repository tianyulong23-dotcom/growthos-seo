"""Add durable idempotency records for Agent profile updates.

Revision ID: 20260728_0015
Revises: 20260728_0014
Create Date: 2026-07-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260728_0015"
down_revision: str | Sequence[str] | None = "20260728_0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "site_profile_operations",
        sa.Column("operation_id", sa.Text(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("operation_type", sa.Text(), nullable=False),
        sa.Column("parameters_hash", sa.Text(), nullable=False),
        sa.Column(
            "result_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_site_profile_operations_project_id",
        "site_profile_operations",
        ["project_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_site_profile_operations_project_id",
        table_name="site_profile_operations",
    )
    op.drop_table("site_profile_operations")
