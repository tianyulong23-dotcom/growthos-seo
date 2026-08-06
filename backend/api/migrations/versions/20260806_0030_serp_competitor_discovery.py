"""Use OpenSEO-style business-keyword SERP competitor discovery.

Revision ID: 20260806_0030
Revises: 20260806_0029
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260806_0030"
down_revision: str | Sequence[str] | None = "20260806_0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column("discovery_method", sa.Text(), nullable=False, server_default="serp_competitors"),
    )
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column(
            "discovery_keywords",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column(
            "discovery_result_types",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column("discovery_include_subdomains", sa.Boolean()),
    )
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column("discovery_sort", sa.Text(), nullable=False, server_default="traffic_estimate"),
    )
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column("discovery_limit", sa.Integer(), nullable=False, server_default="50"),
    )
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column("discovery_offset", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column("analyzed_competitor_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.execute(
        "UPDATE keyword_competitor_analysis_runs "
        "SET discovery_method = 'manual' WHERE analysis_mode = 'manual'"
    )

    op.add_column(
        "keyword_competitors",
        sa.Column("selected_for_gap", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.execute(
        "UPDATE keyword_competitors SET selected_for_gap = false WHERE status = 'excluded'"
    )
    op.add_column("keyword_competitors", sa.Column("keywords_count", sa.Integer()))
    op.add_column("keyword_competitors", sa.Column("median_position", sa.Float()))
    op.add_column("keyword_competitors", sa.Column("rating", sa.Float()))
    op.add_column("keyword_competitors", sa.Column("etv", sa.Float()))
    op.add_column("keyword_competitors", sa.Column("visibility", sa.Float()))
    op.add_column("keyword_competitors", sa.Column("relevant_serp_items", sa.Integer()))
    op.add_column(
        "keyword_competitors",
        sa.Column(
            "keywords_positions",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.execute(
        "UPDATE keyword_competitor_analysis_runs AS run "
        "SET analyzed_competitor_count = counts.selected_count "
        "FROM ("
        "SELECT analysis_run_id, count(*) FILTER (WHERE selected_for_gap)::int AS selected_count "
        "FROM keyword_competitors GROUP BY analysis_run_id"
        ") AS counts WHERE counts.analysis_run_id = run.id"
    )


def downgrade() -> None:
    op.drop_column("keyword_competitors", "keywords_positions")
    op.drop_column("keyword_competitors", "relevant_serp_items")
    op.drop_column("keyword_competitors", "visibility")
    op.drop_column("keyword_competitors", "etv")
    op.drop_column("keyword_competitors", "rating")
    op.drop_column("keyword_competitors", "median_position")
    op.drop_column("keyword_competitors", "keywords_count")
    op.drop_column("keyword_competitors", "selected_for_gap")

    op.drop_column("keyword_competitor_analysis_runs", "analyzed_competitor_count")
    op.drop_column("keyword_competitor_analysis_runs", "discovery_offset")
    op.drop_column("keyword_competitor_analysis_runs", "discovery_limit")
    op.drop_column("keyword_competitor_analysis_runs", "discovery_sort")
    op.drop_column("keyword_competitor_analysis_runs", "discovery_include_subdomains")
    op.drop_column("keyword_competitor_analysis_runs", "discovery_result_types")
    op.drop_column("keyword_competitor_analysis_runs", "discovery_keywords")
    op.drop_column("keyword_competitor_analysis_runs", "discovery_method")
