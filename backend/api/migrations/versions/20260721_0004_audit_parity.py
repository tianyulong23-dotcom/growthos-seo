"""Add LibreCrawl-compatible technical audit storage.

Revision ID: 20260721_0004
Revises: 20260721_0003
Create Date: 2026-07-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260721_0004"
down_revision: str | Sequence[str] | None = "20260721_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "crawl_runs",
        sa.Column(
            "config_snapshot",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "crawl_runs",
        sa.Column(
            "summary",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.add_column(
        "crawl_runs",
        sa.Column("can_resume", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("crawl_runs", sa.Column("resumed_from_run_id", sa.Text()))
    op.add_column("crawl_runs", sa.Column("archived_at", sa.DateTime(timezone=True)))
    op.add_column("crawl_runs", sa.Column("temporal_workflow_id", sa.Text()))
    op.create_foreign_key(
        "fk_crawl_runs_resumed_from",
        "crawl_runs",
        "crawl_runs",
        ["resumed_from_run_id"],
        ["run_id"],
        ondelete="SET NULL",
    )

    for column in (
        sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("response_time_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text()),
        sa.Column("error_type", sa.Text()),
        sa.Column("charset", sa.Text()),
        sa.Column("viewport", sa.Text()),
        sa.Column("robots", sa.Text()),
        sa.Column("author", sa.Text()),
        sa.Column("keywords", sa.Text()),
        sa.Column("generator", sa.Text()),
        sa.Column("theme_color", sa.Text()),
        sa.Column("internal_links", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("external_links", sa.Integer(), nullable=False, server_default="0"),
    ):
        op.add_column("page_snapshots", column)

    for name, default in (
        ("h2", "'[]'::jsonb"),
        ("h3", "'[]'::jsonb"),
        ("meta_tags", "'{}'::jsonb"),
        ("twitter_tags", "'{}'::jsonb"),
        ("analytics", "'{}'::jsonb"),
        ("images", "'[]'::jsonb"),
        ("broken_images", "'[]'::jsonb"),
        ("hreflang", "'[]'::jsonb"),
        ("schema_org", "'[]'::jsonb"),
        ("redirects", "'[]'::jsonb"),
        ("linked_from", "'[]'::jsonb"),
    ):
        op.add_column(
            "page_snapshots",
            sa.Column(
                name,
                postgresql.JSONB(astext_type=sa.Text()),
                nullable=False,
                server_default=sa.text(default),
            ),
        )

    op.add_column(
        "link_edges",
        sa.Column("is_internal", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("link_edges", sa.Column("target_domain", sa.Text()))
    op.add_column("link_edges", sa.Column("target_status", sa.Integer()))
    op.add_column(
        "link_edges",
        sa.Column("placement", sa.Text(), nullable=False, server_default="body"),
    )

    op.create_table(
        "audit_issues",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "page_id",
            sa.BigInteger(),
            sa.ForeignKey("pages.id", ondelete="CASCADE"),
        ),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("severity", sa.Text(), nullable=False),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("issue", sa.Text(), nullable=False),
        sa.Column("details", sa.Text(), nullable=False),
        sa.Column("related_url", sa.Text()),
        sa.Column("similarity", sa.Float()),
        sa.Column(
            "detected_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_audit_issues_run_id", "audit_issues", ["run_id"])
    op.create_index(
        "ix_audit_issues_run_severity",
        "audit_issues",
        ["run_id", "severity"],
    )
    op.create_index(
        "ix_audit_issues_run_category",
        "audit_issues",
        ["run_id", "category"],
    )
    op.create_index(
        "ix_audit_issues_run_code",
        "audit_issues",
        ["run_id", "code"],
    )

    op.create_table(
        "crawl_checkpoints",
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "checkpoint",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    op.create_table(
        "pagespeed_results",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column(
            "run_id",
            sa.Text(),
            sa.ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("strategy", sa.Text(), nullable=False),
        sa.Column("performance_score", sa.Integer()),
        sa.Column("accessibility_score", sa.Integer()),
        sa.Column("best_practices_score", sa.Integer()),
        sa.Column("seo_score", sa.Integer()),
        sa.Column(
            "metrics",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("error", sa.Text()),
        sa.Column(
            "analyzed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "run_id",
            "url",
            "strategy",
            name="uq_pagespeed_run_url_strategy",
        ),
    )
    op.create_index("ix_pagespeed_results_run_id", "pagespeed_results", ["run_id"])


def downgrade() -> None:
    op.drop_index("ix_pagespeed_results_run_id", table_name="pagespeed_results")
    op.drop_table("pagespeed_results")
    op.drop_table("crawl_checkpoints")
    op.drop_index("ix_audit_issues_run_code", table_name="audit_issues")
    op.drop_index("ix_audit_issues_run_category", table_name="audit_issues")
    op.drop_index("ix_audit_issues_run_severity", table_name="audit_issues")
    op.drop_index("ix_audit_issues_run_id", table_name="audit_issues")
    op.drop_table("audit_issues")

    op.drop_column("link_edges", "placement")
    op.drop_column("link_edges", "target_status")
    op.drop_column("link_edges", "target_domain")
    op.drop_column("link_edges", "is_internal")

    for name in (
        "linked_from",
        "redirects",
        "schema_org",
        "hreflang",
        "broken_images",
        "images",
        "analytics",
        "twitter_tags",
        "meta_tags",
        "h3",
        "h2",
        "external_links",
        "internal_links",
        "theme_color",
        "generator",
        "keywords",
        "author",
        "robots",
        "viewport",
        "charset",
        "error_type",
        "error",
        "response_time_ms",
        "size_bytes",
    ):
        op.drop_column("page_snapshots", name)

    op.drop_constraint("fk_crawl_runs_resumed_from", "crawl_runs", type_="foreignkey")
    op.drop_column("crawl_runs", "temporal_workflow_id")
    op.drop_column("crawl_runs", "archived_at")
    op.drop_column("crawl_runs", "resumed_from_run_id")
    op.drop_column("crawl_runs", "can_resume")
    op.drop_column("crawl_runs", "summary")
    op.drop_column("crawl_runs", "config_snapshot")
