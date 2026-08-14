"""Add article documents and durable CMS publication attempts.

Revision ID: 20260807_0039
Revises: 20260807_0038
Create Date: 2026-08-07
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260807_0039"
down_revision: str | Sequence[str] | None = "20260807_0038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.add_column(
        "articles",
        sa.Column(
            "document_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column("article_runs", sa.Column("request_hash", sa.Text()))
    op.add_column(
        "article_versions",
        sa.Column(
            "content_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.create_table(
        "article_publications",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "article_id",
            sa.Text(),
            sa.ForeignKey("articles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("wordpress_post_id", sa.Integer()),
        sa.Column("wordpress_url", sa.Text()),
        sa.Column(
            "request_summary_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "response_summary_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_detail", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint(
            "status IN ('submitting','published','failed','uncertain')",
            name="ck_article_publications_status",
        ),
        sa.CheckConstraint("attempt > 0", name="ck_article_publications_attempt"),
        sa.UniqueConstraint(
            "organization_id",
            "project_id",
            "idempotency_key",
            name="uq_article_publications_idempotency",
        ),
    )
    op.create_index(
        "ix_article_publications_article_created",
        "article_publications",
        ["article_id", sa.text("created_at DESC")],
    )
    op.create_index(
        "uq_article_publications_active_article",
        "article_publications",
        ["article_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('submitting','uncertain')"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_article_publications_active_article",
        table_name="article_publications",
    )
    op.drop_index(
        "ix_article_publications_article_created",
        table_name="article_publications",
    )
    op.drop_table("article_publications")
    op.drop_column("article_versions", "content_json")
    op.drop_column("article_runs", "request_hash")
    op.drop_column("articles", "document_json")
