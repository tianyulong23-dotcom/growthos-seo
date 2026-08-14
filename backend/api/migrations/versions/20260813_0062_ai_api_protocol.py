"""Add an explicit AI API protocol.

Revision ID: 20260813_0062
Revises: 20260813_0061
Create Date: 2026-08-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260813_0062"
down_revision: str | Sequence[str] | None = "20260813_0061"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ai_provider_settings",
        sa.Column(
            "api_protocol",
            sa.Text(),
            nullable=False,
            server_default="chat_completions",
        ),
    )
    op.create_check_constraint(
        "ck_ai_provider_settings_api_protocol",
        "ai_provider_settings",
        "api_protocol IN ('chat_completions','responses')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_ai_provider_settings_api_protocol",
        "ai_provider_settings",
        type_="check",
    )
    op.drop_column("ai_provider_settings", "api_protocol")
