"""Store fetched external resources for technical audits.

Revision ID: 20260722_0006
Revises: 20260722_0005
Create Date: 2026-07-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260722_0006"
down_revision: str | Sequence[str] | None = "20260722_0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "external_resources",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("final_url", sa.Text()),
        sa.Column("status_code", sa.Integer()),
        sa.Column("content_type", sa.Text()),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("title", sa.Text()),
        sa.Column("error", sa.Text()),
        sa.Column("error_type", sa.Text()),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("run_id", "url", name="uq_external_resources_run_url"),
    )
    op.create_index("ix_external_resources_run_id", "external_resources", ["run_id"])


def downgrade() -> None:
    op.drop_index("ix_external_resources_run_id", table_name="external_resources")
    op.drop_table("external_resources")
