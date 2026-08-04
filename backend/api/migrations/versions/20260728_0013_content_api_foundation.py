"""Add article content API foundation.

Revision ID: 20260728_0013
Revises: 20260728_0012
Create Date: 2026-07-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260728_0013"
down_revision: str | Sequence[str] | None = "20260728_0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    article_status = (
        "status IN ('queued','running','completed','completed_with_warnings','cancelled')"
    )

    op.create_table(
        "articles",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("primary_keyword", sa.Text(), nullable=False),
        sa.Column("title", sa.Text()),
        sa.Column("slug", sa.Text()),
        sa.Column("meta_title", sa.Text()),
        sa.Column("meta_description", sa.Text()),
        sa.Column(
            "outline_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column("markdown", sa.Text()),
        sa.Column("html", sa.Text()),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("current_run_id", sa.Text()),
        sa.Column("warning_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(article_status, name="ck_articles_status"),
    )
    op.create_index("ix_articles_organization_id", "articles", ["organization_id"])
    op.create_index(
        "ix_articles_organization_project_updated",
        "articles",
        ["organization_id", "project_id", sa.text("updated_at DESC")],
    )
    op.create_index(
        "ix_articles_project_status", "articles", ["project_id", "status"]
    )

    op.create_table(
        "article_runs",
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
        sa.Column("workflow_id", sa.Text(), nullable=False, unique=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("stage", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "project_snapshot_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "model_snapshot_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("soft_deadline_at", sa.DateTime(timezone=True)),
        sa.Column("hard_deadline_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column(
            "warnings_json", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
        sa.Column(
            "metrics_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(article_status, name="ck_article_runs_status"),
        sa.CheckConstraint(
            "progress >= 0 AND progress <= 100", name="ck_article_runs_progress"
        ),
    )
    op.create_index(
        "uq_article_runs_active_article",
        "article_runs",
        ["article_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued','running')"),
    )
    op.create_index(
        "ix_article_runs_project_created",
        "article_runs",
        ["project_id", sa.text("created_at DESC")],
    )

    op.create_table(
        "article_run_steps",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("article_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("step_key", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("input_ref", sa.Text()),
        sa.Column("output_ref", sa.Text()),
        sa.Column(
            "summary_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column("duration_ms", sa.Integer()),
        sa.Column("input_tokens", sa.Integer()),
        sa.Column("output_tokens", sa.Integer()),
        sa.Column("cost", sa.Numeric(18, 8)),
        sa.Column("cost_currency", sa.Text()),
        sa.Column("warning_code", sa.Text()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("run_id", "step_key", name="uq_article_run_steps_key"),
    )
    op.create_index("ix_article_run_steps_run_id", "article_run_steps", ["run_id"])

    op.create_table(
        "article_sources",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("article_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("normalized_url", sa.Text(), nullable=False),
        sa.Column("title", sa.Text()),
        sa.Column("domain", sa.Text()),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("retrieved_at", sa.DateTime(timezone=True)),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("content_ref", sa.Text()),
        sa.Column(
            "summary_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column(
            "claims_json", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
        sa.Column(
            "section_ids_json", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
        sa.Column(
            "metadata_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.UniqueConstraint(
            "run_id", "normalized_url", "source_type", name="uq_article_sources_url_type"
        ),
    )
    op.create_index("ix_article_sources_run_id", "article_sources", ["run_id"])

    op.create_table(
        "article_versions",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "article_id",
            sa.Text(),
            sa.ForeignKey("articles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("article_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("version_type", sa.Text(), nullable=False),
        sa.Column("content_ref", sa.Text()),
        sa.Column(
            "outline_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column(
            "quality_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint(
            "article_id", "version_number", name="uq_article_versions_number"
        ),
    )
    op.create_index("ix_article_versions_article_id", "article_versions", ["article_id"])

    op.create_table(
        "article_idempotency_keys",
        sa.Column("organization_id", sa.Text(), primary_key=True),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("idempotency_key", sa.Text(), primary_key=True),
        sa.Column("request_hash", sa.Text(), nullable=False),
        sa.Column(
            "article_id",
            sa.Text(),
            sa.ForeignKey("articles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("article_idempotency_keys")
    op.drop_index("ix_article_versions_article_id", table_name="article_versions")
    op.drop_table("article_versions")
    op.drop_index("ix_article_sources_run_id", table_name="article_sources")
    op.drop_table("article_sources")
    op.drop_index("ix_article_run_steps_run_id", table_name="article_run_steps")
    op.drop_table("article_run_steps")
    op.drop_index("ix_article_runs_project_created", table_name="article_runs")
    op.drop_index("uq_article_runs_active_article", table_name="article_runs")
    op.drop_table("article_runs")
    op.drop_index("ix_articles_project_status", table_name="articles")
    op.drop_index("ix_articles_organization_project_updated", table_name="articles")
    op.drop_index("ix_articles_organization_id", table_name="articles")
    op.drop_table("articles")
