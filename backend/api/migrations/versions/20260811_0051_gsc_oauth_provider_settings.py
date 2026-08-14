"""Add platform Google Search Console OAuth settings.

Revision ID: 20260811_0051
Revises: 20260810_0050
Create Date: 2026-08-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260811_0051"
down_revision: str | Sequence[str] | None = "20260810_0050"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "gsc_oauth_provider_settings",
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("client_secret_encrypted", sa.LargeBinary(), nullable=False),
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
        sa.PrimaryKeyConstraint("organization_id"),
    )


def downgrade() -> None:
    op.drop_table("gsc_oauth_provider_settings")
