"""Merge integrated module migration heads.

Revision ID: 20260804_0022
Revises: 20260724_0007, 20260803_0020, 20260803_0021
"""

from collections.abc import Sequence


revision: str = "20260804_0022"
down_revision: str | Sequence[str] | None = (
    "20260724_0007",
    "20260803_0020",
    "20260803_0021",
)
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
