"""Merge settings and keyword migration heads.

Revision ID: 20260807_0036
Revises: 20260805_0023, 20260806_0035
Create Date: 2026-08-07
"""

from collections.abc import Sequence


revision: str = "20260807_0036"
down_revision: str | Sequence[str] | None = (
    "20260805_0023",
    "20260806_0035",
)
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
