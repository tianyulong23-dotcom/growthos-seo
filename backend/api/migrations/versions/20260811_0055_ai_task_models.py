"""Add task-specific AI model overrides.

Revision ID: 20260811_0055
Revises: 20260811_0054
Create Date: 2026-08-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260811_0055"
down_revision: str | Sequence[str] | None = "20260811_0054"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for column_name in (
        "business_model",
        "keyword_model",
        "content_model",
        "agent_model",
    ):
        op.add_column(
            "ai_provider_settings",
            sa.Column(column_name, sa.Text(), nullable=True),
        )


def downgrade() -> None:
    for column_name in (
        "agent_model",
        "content_model",
        "keyword_model",
        "business_model",
    ):
        op.drop_column("ai_provider_settings", column_name)
