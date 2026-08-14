"""Persist Website Project audiences and partnership goals.

Revision ID: 20260813_0010
Revises: 20260806_0009
Create Date: 2026-08-13 00:00:00
"""

from collections.abc import Sequence

from alembic import op


revision: str = "20260813_0010"
down_revision: str | Sequence[str] | None = "20260806_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE platform.promotion_target_versions
          ADD COLUMN target_audiences jsonb NOT NULL DEFAULT '[]'::jsonb,
          ADD COLUMN partnership_goals jsonb NOT NULL DEFAULT '[]'::jsonb,
          ADD CONSTRAINT promotion_target_versions_target_audiences_array_ck
            CHECK (jsonb_typeof(target_audiences) = 'array'),
          ADD CONSTRAINT promotion_target_versions_partnership_goals_array_ck
            CHECK (jsonb_typeof(partnership_goals) = 'array')
        """
    )


def downgrade() -> None:
    raise RuntimeError(
        "Forward-only migration: Website Project audience facts cannot be removed safely."
    )
