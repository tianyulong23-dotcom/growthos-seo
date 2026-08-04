"""Add configurable AI request timeout and retry policy.

Revision ID: 20260723_0008
Revises: 20260723_0007
Create Date: 2026-07-23
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260723_0008"
down_revision: str | Sequence[str] | None = "20260723_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ai_provider_settings",
        sa.Column(
            "request_timeout_seconds",
            sa.Integer(),
            nullable=False,
            server_default="90",
        ),
    )
    op.add_column(
        "ai_provider_settings",
        sa.Column(
            "max_retries",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
    )
    op.create_check_constraint(
        "ck_ai_provider_settings_request_timeout_seconds",
        "ai_provider_settings",
        "request_timeout_seconds BETWEEN 10 AND 180",
    )
    op.create_check_constraint(
        "ck_ai_provider_settings_max_retries",
        "ai_provider_settings",
        "max_retries BETWEEN 0 AND 2",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_ai_provider_settings_max_retries",
        "ai_provider_settings",
        type_="check",
    )
    op.drop_constraint(
        "ck_ai_provider_settings_request_timeout_seconds",
        "ai_provider_settings",
        type_="check",
    )
    op.drop_column("ai_provider_settings", "max_retries")
    op.drop_column("ai_provider_settings", "request_timeout_seconds")
