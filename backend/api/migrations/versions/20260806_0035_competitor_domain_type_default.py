"""Align the competitor domain type default with its allowed values.

Revision ID: 20260806_0035
Revises: 20260806_0034
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260806_0035"
down_revision: str | Sequence[str] | None = "20260806_0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "keyword_competitors",
        "domain_type",
        existing_type=sa.Text(),
        server_default="documentation_resource",
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "keyword_competitors",
        "domain_type",
        existing_type=sa.Text(),
        server_default=None,
        existing_nullable=False,
    )
