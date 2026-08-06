"""Persist competitor candidate website verification evidence.

Revision ID: 20260806_0033
Revises: 20260806_0032
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260806_0033"
down_revision: str | Sequence[str] | None = "20260806_0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "keyword_competitors",
        sa.Column("site_check_status", sa.Text(), nullable=False, server_default="not_checked"),
    )
    op.add_column(
        "keyword_competitors",
        sa.Column("site_relation", sa.Text(), nullable=False, server_default="uncertain"),
    )
    op.add_column(
        "keyword_competitors",
        sa.Column(
            "site_verification",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.create_index(
        "ix_keyword_competitors_site_verification_cache",
        "keyword_competitors",
        ["organization_id", "domain", "updated_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_keyword_competitors_site_verification_cache",
        table_name="keyword_competitors",
    )
    op.drop_column("keyword_competitors", "site_verification")
    op.drop_column("keyword_competitors", "site_relation")
    op.drop_column("keyword_competitors", "site_check_status")
