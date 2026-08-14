"""Harden article link-analysis leases and expand indexing directives.

Revision ID: 20260809_0045
Revises: 20260809_0044
Create Date: 2026-08-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260809_0045"
down_revision: str | Sequence[str] | None = "20260809_0044"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("article_link_analyses", sa.Column("lease_token", sa.Text()))
    op.add_column(
        "article_link_analyses",
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_check_constraint(
        "ck_article_link_analyses_attempt",
        "article_link_analyses",
        "attempt >= 0",
    )

    op.drop_constraint("ck_articles_indexing", "articles", type_="check")
    op.execute(
        "UPDATE articles SET indexing = CASE indexing "
        "WHEN 'index' THEN 'index/follow' "
        "WHEN 'noindex' THEN 'noindex/follow' ELSE indexing END"
    )
    op.alter_column("articles", "indexing", server_default="index/follow")
    op.create_check_constraint(
        "ck_articles_indexing",
        "articles",
        "indexing IN ('index/follow','noindex/follow','index/nofollow','noindex/nofollow')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_articles_indexing", "articles", type_="check")
    op.execute(
        "UPDATE articles SET indexing = CASE "
        "WHEN indexing LIKE 'noindex/%' THEN 'noindex' ELSE 'index' END"
    )
    op.alter_column("articles", "indexing", server_default="index")
    op.create_check_constraint(
        "ck_articles_indexing", "articles", "indexing IN ('index','noindex')"
    )

    op.drop_constraint(
        "ck_article_link_analyses_attempt", "article_link_analyses", type_="check"
    )
    op.drop_column("article_link_analyses", "attempt")
    op.drop_column("article_link_analyses", "lease_token")
