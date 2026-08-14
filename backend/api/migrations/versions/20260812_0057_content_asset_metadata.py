"""Add manageable content asset metadata.

Revision ID: 20260812_0057
Revises: 20260811_0056
Create Date: 2026-08-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260812_0057"
down_revision: str | Sequence[str] | None = "20260811_0056"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("content_assets", sa.Column("title", sa.Text()))
    op.add_column("content_assets", sa.Column("default_alt_text", sa.Text()))
    op.add_column("content_assets", sa.Column("caption", sa.Text()))
    op.add_column("content_assets", sa.Column("description", sa.Text()))
    op.add_column("content_assets", sa.Column("metadata_updated_by", sa.Text()))
    op.add_column(
        "content_assets",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_column("content_assets", "updated_at")
    op.drop_column("content_assets", "metadata_updated_by")
    op.drop_column("content_assets", "description")
    op.drop_column("content_assets", "caption")
    op.drop_column("content_assets", "default_alt_text")
    op.drop_column("content_assets", "title")
