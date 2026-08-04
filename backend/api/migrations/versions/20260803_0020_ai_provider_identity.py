"""Add explicit AI provider identity.

Revision ID: 20260803_0020
Revises: 20260803_0019
Create Date: 2026-08-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260803_0020"
down_revision: str | Sequence[str] | None = "20260803_0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ai_provider_settings",
        sa.Column("provider", sa.Text(), nullable=False, server_default="openai"),
    )
    op.execute(
        """
        UPDATE ai_provider_settings
        SET provider = 'openrouter'
        WHERE lower(base_url) LIKE '%://openrouter.ai/%'
           OR lower(base_url) LIKE '%://openrouter.ai'
        """
    )
    op.execute(
        """
        UPDATE ai_provider_settings
        SET provider = 'anthropic'
        WHERE lower(base_url) LIKE '%://api.anthropic.com/%'
           OR lower(base_url) LIKE '%://api.anthropic.com'
        """
    )
    op.create_check_constraint(
        "ck_ai_provider_settings_provider",
        "ai_provider_settings",
        "provider IN ('openai','anthropic','openrouter')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_ai_provider_settings_provider",
        "ai_provider_settings",
        type_="check",
    )
    op.drop_column("ai_provider_settings", "provider")
