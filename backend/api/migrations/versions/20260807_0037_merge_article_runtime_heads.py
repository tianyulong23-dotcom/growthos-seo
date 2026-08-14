"""Merge article runtime migration heads.

Revision ID: 20260807_0037
Revises: 20260807_cp026, 20260807_0036
Create Date: 2026-08-07
"""

from collections.abc import Sequence


revision: str = "20260807_0037"
down_revision: str | Sequence[str] | None = (
    "20260807_cp026",
    "20260807_0036",
)
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
