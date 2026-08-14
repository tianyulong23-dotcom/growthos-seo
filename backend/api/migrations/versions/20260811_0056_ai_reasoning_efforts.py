"""Add configurable AI reasoning efforts.

Revision ID: 20260811_0056
Revises: 20260811_0055
Create Date: 2026-08-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260811_0056"
down_revision: str | Sequence[str] | None = "20260811_0055"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


EFFORTS = "'low','medium','high'"


def upgrade() -> None:
    op.add_column(
        "ai_provider_settings",
        sa.Column(
            "reasoning_effort",
            sa.Text(),
            nullable=False,
            server_default="medium",
        ),
    )
    for column_name in (
        "business_reasoning_effort",
        "keyword_reasoning_effort",
        "content_reasoning_effort",
        "agent_reasoning_effort",
    ):
        op.add_column(
            "ai_provider_settings",
            sa.Column(column_name, sa.Text(), nullable=True),
        )
    op.create_check_constraint(
        "ck_ai_provider_settings_reasoning_effort",
        "ai_provider_settings",
        f"reasoning_effort IN ({EFFORTS})",
    )
    for task in ("business", "keyword", "content", "agent"):
        column_name = f"{task}_reasoning_effort"
        op.create_check_constraint(
            f"ck_ai_provider_settings_{column_name}",
            "ai_provider_settings",
            f"{column_name} IS NULL OR {column_name} IN ({EFFORTS})",
        )


def downgrade() -> None:
    for task in ("agent", "content", "keyword", "business"):
        column_name = f"{task}_reasoning_effort"
        op.drop_constraint(
            f"ck_ai_provider_settings_{column_name}",
            "ai_provider_settings",
            type_="check",
        )
    op.drop_constraint(
        "ck_ai_provider_settings_reasoning_effort",
        "ai_provider_settings",
        type_="check",
    )
    for column_name in (
        "agent_reasoning_effort",
        "content_reasoning_effort",
        "keyword_reasoning_effort",
        "business_reasoning_effort",
        "reasoning_effort",
    ):
        op.drop_column("ai_provider_settings", column_name)
