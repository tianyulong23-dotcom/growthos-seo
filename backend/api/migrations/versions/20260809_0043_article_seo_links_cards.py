"""Add versioned article SEO metadata.

Revision ID: 20260809_0043
Revises: 20260809_0042
Create Date: 2026-08-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260809_0043"
down_revision: str | Sequence[str] | None = "20260809_0042"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.add_column("articles", sa.Column("focus_keyword", sa.Text()))
    op.add_column(
        "articles",
        sa.Column(
            "secondary_keywords_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column("articles", sa.Column("canonical_url", sa.Text()))
    op.add_column(
        "articles",
        sa.Column("indexing", sa.Text(), nullable=False, server_default="index"),
    )
    op.add_column(
        "articles",
        sa.Column(
            "seo_field_states_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.create_check_constraint(
        "ck_articles_indexing", "articles", "indexing IN ('index','noindex')"
    )
    op.execute("UPDATE articles SET focus_keyword = primary_keyword WHERE focus_keyword IS NULL")


def downgrade() -> None:
    op.drop_constraint("ck_articles_indexing", "articles", type_="check")
    op.drop_column("articles", "seo_field_states_json")
    op.drop_column("articles", "indexing")
    op.drop_column("articles", "canonical_url")
    op.drop_column("articles", "secondary_keywords_json")
    op.drop_column("articles", "focus_keyword")
