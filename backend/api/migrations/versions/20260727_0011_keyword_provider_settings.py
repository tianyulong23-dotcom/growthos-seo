"""Add encrypted keyword provider settings.

Revision ID: 20260727_0011
Revises: 20260727_0010
Create Date: 2026-07-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260727_k011"
down_revision: str | Sequence[str] | None = "20260727_k010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def timestamp_columns() -> tuple[sa.Column, sa.Column]:
    return (
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


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    google_created_at, google_updated_at = timestamp_columns()
    op.create_table(
        "google_ads_provider_settings",
        sa.Column("organization_id", sa.Text(), primary_key=True),
        sa.Column("developer_token_encrypted", sa.LargeBinary(), nullable=False),
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("client_secret_encrypted", sa.LargeBinary(), nullable=False),
        sa.Column("refresh_token_encrypted", sa.LargeBinary(), nullable=False),
        sa.Column("customer_id", sa.Text(), nullable=False),
        sa.Column("login_customer_id", sa.Text()),
        google_created_at,
        google_updated_at,
    )

    dataforseo_created_at, dataforseo_updated_at = timestamp_columns()
    op.create_table(
        "dataforseo_provider_settings",
        sa.Column("organization_id", sa.Text(), primary_key=True),
        sa.Column("login", sa.Text(), nullable=False),
        sa.Column("password_encrypted", sa.LargeBinary(), nullable=False),
        dataforseo_created_at,
        dataforseo_updated_at,
    )


def downgrade() -> None:
    op.drop_table("dataforseo_provider_settings")
    op.drop_table("google_ads_provider_settings")
