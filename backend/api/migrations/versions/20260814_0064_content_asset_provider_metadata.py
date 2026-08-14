"""Persist image provider provenance on content assets.

Revision ID: 20260814_0064
Revises: 20260813_0063
Create Date: 2026-08-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260814_0064"
down_revision: str | Sequence[str] | None = "20260813_0063"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "content_assets",
        sa.Column(
            "provider_metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("content_assets", "provider_metadata")
