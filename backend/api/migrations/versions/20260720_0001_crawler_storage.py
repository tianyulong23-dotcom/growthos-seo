"""Add crawler PostgreSQL storage.

Revision ID: 20260720_0001
Revises:
Create Date: 2026-07-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260720_0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "crawl_runs",
        sa.Column("run_id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("task_type", sa.Text(), nullable=False),
        sa.Column("target_url", sa.Text()),
        sa.Column("country", sa.Text()),
        sa.Column("language", sa.Text()),
        sa.Column("status", sa.Text(), nullable=False, server_default="running"),
        sa.Column("stage", sa.Text()),
        sa.Column("message", sa.Text()),
        sa.Column("discovered", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("processed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("selected", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("page_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("backlink_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("result_ref", sa.Text()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
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
    )
    op.create_index("ix_crawl_runs_organization_id", "crawl_runs", ["organization_id"])
    op.create_index("ix_crawl_runs_project_id", "crawl_runs", ["project_id"])

    op.create_table(
        "pages",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("normalized_url", sa.Text(), nullable=False),
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
    )
    op.create_index("ix_pages_organization_id", "pages", ["organization_id"])
    op.create_index("ix_pages_project_id", "pages", ["project_id"])
    op.create_index(
        "uq_pages_project_normalized_url",
        "pages",
        ["organization_id", "project_id", "normalized_url"],
        unique=True,
    )

    op.create_table(
        "page_snapshots",
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "page_id",
            sa.BigInteger(),
            sa.ForeignKey("pages.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("requested_url", sa.Text(), nullable=False),
        sa.Column("final_url", sa.Text(), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=False),
        sa.Column("content_type", sa.Text()),
        sa.Column("title", sa.Text()),
        sa.Column("description", sa.Text()),
        sa.Column("canonical", sa.Text()),
        sa.Column("language", sa.Text()),
        sa.Column(
            "h1",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "headings",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "open_graph",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "structured_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("word_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rendered", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("score", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("depth", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("discovered_from", sa.Text()),
        sa.Column("raw_html_ref", sa.Text()),
        sa.Column("main_html_ref", sa.Text()),
        sa.Column("main_text_ref", sa.Text()),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "link_edges",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "source_page_id",
            sa.BigInteger(),
            sa.ForeignKey("pages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("target_url", sa.Text(), nullable=False),
        sa.Column("anchor_text", sa.Text()),
        sa.Column("rel", sa.Text()),
        sa.Column("in_navigation", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_link_edges_run_id", "link_edges", ["run_id"])
    op.create_index("ix_link_edges_source_page_id", "link_edges", ["source_page_id"])

    op.create_table(
        "backlink_checks",
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("url", sa.Text(), primary_key=True),
        sa.Column("final_url", sa.Text()),
        sa.Column("status_code", sa.Integer()),
        sa.Column(
            "found_links",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("error", sa.Text()),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("backlink_checks")
    op.drop_index("ix_link_edges_source_page_id", table_name="link_edges")
    op.drop_index("ix_link_edges_run_id", table_name="link_edges")
    op.drop_table("link_edges")
    op.drop_table("page_snapshots")
    op.drop_index("uq_pages_project_normalized_url", table_name="pages")
    op.drop_index("ix_pages_project_id", table_name="pages")
    op.drop_index("ix_pages_organization_id", table_name="pages")
    op.drop_table("pages")
    op.drop_index("ix_crawl_runs_project_id", table_name="crawl_runs")
    op.drop_index("ix_crawl_runs_organization_id", table_name="crawl_runs")
    op.drop_table("crawl_runs")
