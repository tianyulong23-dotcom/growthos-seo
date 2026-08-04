"""Rebuild the initial keyword workflow around DataForSEO.

Revision ID: 20260728_0012
Revises: 20260727_0011
Create Date: 2026-07-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260728_0012"
down_revision: str | Sequence[str] | None = "20260727_0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("projects", sa.Column("competitor_domain", sa.Text()))

    op.add_column(
        "keyword_build_runs",
        sa.Column("profile_source", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column(
        "keyword_build_runs",
        sa.Column("profile_version", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column("keyword_build_runs", sa.Column("competitor_domain", sa.Text()))
    op.add_column(
        "keyword_build_runs",
        sa.Column(
            "gap_status",
            sa.Text(),
            nullable=False,
            server_default="not_requested",
        ),
    )
    op.add_column(
        "keyword_build_runs",
        sa.Column("gap_message", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column(
        "keyword_build_runs",
        sa.Column("gap_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.execute(
        """
        UPDATE keyword_build_runs AS run
        SET competitor_domain = project.competitor_domain,
            gap_status = CASE
                WHEN project.competitor_domain IS NULL THEN 'not_requested'
                ELSE 'pending'
            END
        FROM projects AS project
        WHERE project.id = run.project_id
        """
    )

    op.drop_constraint(
        "ck_keyword_build_runs_status",
        "keyword_build_runs",
        type_="check",
    )
    op.create_check_constraint(
        "ck_keyword_build_runs_status",
        "keyword_build_runs",
        "status IN ('queued', 'running', 'partial', 'completed', 'failed', 'cancelled')",
    )

    op.drop_constraint(
        "ck_keyword_ideas_source",
        "keyword_ideas",
        type_="check",
    )
    op.create_check_constraint(
        "ck_keyword_ideas_source",
        "keyword_ideas",
        "source IN ("
        "'site_seed', 'seed', 'google_ads', 'google_suggest', 'ai', "
        "'labs_site', 'google_ads_site', 'keyword_ideas'"
        ")",
    )

    op.add_column("keywords", sa.Column("business_topic", sa.Text()))
    op.add_column("keywords", sa.Column("classification_confidence", sa.Float()))
    op.add_column(
        "keywords",
        sa.Column(
            "review_status",
            sa.Text(),
            nullable=False,
            server_default="approved",
        ),
    )
    op.create_check_constraint(
        "ck_keywords_review_status",
        "keywords",
        "review_status IN ('approved', 'needs_review')",
    )

    op.add_column(
        "keyword_external_requests",
        sa.Column("organization_id", sa.Text()),
    )
    op.execute(
        """
        UPDATE keyword_external_requests AS request
        SET organization_id = run.organization_id
        FROM keyword_build_runs AS run
        WHERE run.id = request.build_run_id
        """
    )
    op.alter_column(
        "keyword_external_requests",
        "organization_id",
        nullable=False,
    )
    op.create_index(
        "ix_keyword_external_requests_organization_id",
        "keyword_external_requests",
        ["organization_id"],
    )

    op.create_table(
        "keyword_competitor_gaps",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "build_run_id",
            sa.Text(),
            sa.ForeignKey("keyword_build_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("competitor_domain", sa.Text(), nullable=False),
        sa.Column("keyword", sa.Text(), nullable=False),
        sa.Column("normalized_keyword", sa.Text(), nullable=False),
        sa.Column("competitor_rank", sa.Integer()),
        sa.Column("search_volume", sa.Integer()),
        sa.Column("cpc", sa.Float()),
        sa.Column("competition", sa.Float()),
        sa.Column("keyword_difficulty", sa.Integer()),
        sa.Column("intent", sa.Text()),
        sa.Column(
            "monthly_searches",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("relevance", sa.Float()),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column(
            "raw_payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'active', 'needs_review')",
            name="ck_keyword_competitor_gaps_status",
        ),
        sa.UniqueConstraint(
            "build_run_id",
            "normalized_keyword",
            name="uq_keyword_competitor_gaps_run_keyword",
        ),
    )
    op.create_index(
        "ix_keyword_competitor_gaps_organization_id",
        "keyword_competitor_gaps",
        ["organization_id"],
    )
    op.create_index(
        "ix_keyword_competitor_gaps_project_id",
        "keyword_competitor_gaps",
        ["project_id"],
    )
    op.create_index(
        "ix_keyword_competitor_gaps_project_created",
        "keyword_competitor_gaps",
        ["project_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_keyword_competitor_gaps_project_created",
        table_name="keyword_competitor_gaps",
    )
    op.drop_index(
        "ix_keyword_competitor_gaps_project_id",
        table_name="keyword_competitor_gaps",
    )
    op.drop_index(
        "ix_keyword_competitor_gaps_organization_id",
        table_name="keyword_competitor_gaps",
    )
    op.drop_table("keyword_competitor_gaps")

    op.drop_index(
        "ix_keyword_external_requests_organization_id",
        table_name="keyword_external_requests",
    )
    op.drop_column("keyword_external_requests", "organization_id")

    op.drop_constraint("ck_keywords_review_status", "keywords", type_="check")
    op.drop_column("keywords", "review_status")
    op.drop_column("keywords", "classification_confidence")
    op.drop_column("keywords", "business_topic")

    op.drop_constraint("ck_keyword_ideas_source", "keyword_ideas", type_="check")
    op.create_check_constraint(
        "ck_keyword_ideas_source",
        "keyword_ideas",
        "source IN ('site_seed', 'seed', 'google_ads', 'google_suggest', 'ai')",
    )

    op.drop_constraint(
        "ck_keyword_build_runs_status",
        "keyword_build_runs",
        type_="check",
    )
    op.create_check_constraint(
        "ck_keyword_build_runs_status",
        "keyword_build_runs",
        "status IN ('queued', 'running', 'partial', 'completed', 'failed')",
    )
    op.drop_column("keyword_build_runs", "gap_count")
    op.drop_column("keyword_build_runs", "gap_message")
    op.drop_column("keyword_build_runs", "gap_status")
    op.drop_column("keyword_build_runs", "competitor_domain")
    op.drop_column("keyword_build_runs", "profile_version")
    op.drop_column("keyword_build_runs", "profile_source")

    op.drop_column("projects", "competitor_domain")
