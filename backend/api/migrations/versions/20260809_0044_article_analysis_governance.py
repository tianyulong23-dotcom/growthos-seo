"""Add persisted article SEO and link analysis results.

Revision ID: 20260809_0044
Revises: 20260809_0043
Create Date: 2026-08-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260809_0044"
down_revision: str | Sequence[str] | None = "20260809_0043"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.create_table(
        "article_seo_analyses",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("article_id", sa.Text(), nullable=False),
        sa.Column("version_number", sa.Integer()),
        sa.Column("document_hash", sa.Text(), nullable=False),
        sa.Column("metadata_hash", sa.Text(), nullable=False),
        sa.Column("ruleset_version", sa.Text(), nullable=False),
        sa.Column("input_snapshot", jsonb, nullable=False),
        sa.Column("results", jsonb, nullable=False),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("max_score", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "status IN ('completed','failed')",
            name="ck_article_seo_analyses_status",
        ),
        sa.CheckConstraint("score >= 0", name="ck_article_seo_analyses_score"),
        sa.CheckConstraint("max_score > 0", name="ck_article_seo_analyses_max_score"),
        sa.ForeignKeyConstraint(["article_id"], ["articles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "article_id",
            "document_hash",
            "metadata_hash",
            "ruleset_version",
            name="uq_article_seo_analyses_input",
        ),
    )
    op.create_index(
        "ix_article_seo_analyses_latest",
        "article_seo_analyses",
        ["article_id", sa.text("created_at DESC")],
    )

    op.create_table(
        "article_link_analyses",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("article_id", sa.Text(), nullable=False),
        sa.Column("version_number", sa.Integer()),
        sa.Column("document_hash", sa.Text(), nullable=False),
        sa.Column("ruleset_version", sa.Text(), nullable=False),
        sa.Column("input_snapshot", jsonb, nullable=False),
        sa.Column("results", jsonb, nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "status IN ('queued','running','completed','failed')",
            name="ck_article_link_analyses_status",
        ),
        sa.ForeignKeyConstraint(["article_id"], ["articles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_article_link_analyses_latest",
        "article_link_analyses",
        ["article_id", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_article_link_analyses_latest", table_name="article_link_analyses")
    op.drop_table("article_link_analyses")
    op.drop_index("ix_article_seo_analyses_latest", table_name="article_seo_analyses")
    op.drop_table("article_seo_analyses")
