"""Persist OpenSEO competitive-landscape evidence.

Revision ID: 20260806_0032
Revises: 20260806_0031
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260806_0032"
down_revision: str | Sequence[str] | None = "20260806_0031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def json_column(name: str, default: str):
    return sa.Column(
        name,
        postgresql.JSONB(),
        nullable=False,
        server_default=sa.text(f"'{default}'::jsonb"),
    )


def upgrade() -> None:
    op.add_column("keyword_competitor_analysis_runs", json_column("gsc_query_evidence", "[]"))
    op.add_column("keyword_competitor_analysis_runs", json_column("query_metrics", "[]"))
    op.add_column("keyword_competitor_analysis_runs", json_column("serp_snapshots", "[]"))
    op.add_column("keyword_competitor_analysis_runs", json_column("cost_breakdown", "{}"))
    op.add_column("keyword_competitor_analysis_runs", json_column("landscape_summary", "{}"))
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column("directional_result", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("keyword_competitor_analysis_runs", sa.Column("market_summary", sa.Text()))

    op.add_column(
        "keyword_competitors",
        sa.Column("domain_type", sa.Text(), nullable=False, server_default="documentation_resource"),
    )
    op.add_column(
        "keyword_competitors",
        sa.Column("is_seo_competitor", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        "keyword_competitors",
        sa.Column("is_business_competitor", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column("keyword_competitors", sa.Column("classification_confidence", sa.Float()))
    op.add_column("keyword_competitors", sa.Column("why_they_matter", sa.Text()))
    op.add_column("keyword_competitors", json_column("serp_evidence", "[]"))
    op.add_column("keyword_competitors", json_column("domain_overview", "{}"))
    op.add_column("keyword_competitors", json_column("ranked_keywords_evidence", "[]"))
    op.add_column("keyword_competitors", json_column("backlinks_evidence", "{}"))


def downgrade() -> None:
    for column in (
        "backlinks_evidence",
        "ranked_keywords_evidence",
        "domain_overview",
        "serp_evidence",
        "why_they_matter",
        "classification_confidence",
        "is_business_competitor",
        "is_seo_competitor",
        "domain_type",
    ):
        op.drop_column("keyword_competitors", column)
    for column in (
        "market_summary",
        "directional_result",
        "cost_breakdown",
        "landscape_summary",
        "serp_snapshots",
        "query_metrics",
        "gsc_query_evidence",
    ):
        op.drop_column("keyword_competitor_analysis_runs", column)
