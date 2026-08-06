"""Harden competitor analysis recovery and opportunity decisions.

Revision ID: 20260806_0026
Revises: 20260806_0025
Create Date: 2026-08-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260806_0026"
down_revision: str | Sequence[str] | None = "20260806_0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column("recovery_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "keyword_competitor_analysis_dispatches",
        sa.Column("last_checked_at", sa.DateTime(timezone=True)),
    )
    op.create_table(
        "keyword_competitor_opportunity_decisions",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("country", sa.Text(), nullable=False),
        sa.Column("language", sa.Text(), nullable=False),
        sa.Column("normalized_keyword", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="new"),
        sa.Column(
            "keyword_id",
            sa.Text(),
            sa.ForeignKey("keywords.id", ondelete="SET NULL"),
        ),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
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
        sa.UniqueConstraint(
            "organization_id",
            "project_id",
            "country",
            "language",
            "normalized_keyword",
            name="uq_keyword_competitor_opportunity_decisions_market_keyword",
        ),
        sa.CheckConstraint(
            "status IN ('new', 'accepted', 'dismissed')",
            name="ck_keyword_competitor_opportunity_decisions_status",
        ),
    )
    op.create_index(
        "ix_keyword_competitor_opportunity_decisions_organization_id",
        "keyword_competitor_opportunity_decisions",
        ["organization_id"],
    )
    op.create_index(
        "ix_keyword_competitor_opportunity_decisions_project_id",
        "keyword_competitor_opportunity_decisions",
        ["project_id"],
    )
    op.create_index(
        "ix_keyword_competitor_opportunity_decisions_keyword_id",
        "keyword_competitor_opportunity_decisions",
        ["keyword_id"],
    )
    op.execute(
        """
        INSERT INTO keyword_competitor_opportunity_decisions (
            id, organization_id, project_id, country, language,
            normalized_keyword, status, keyword_id, decided_at,
            created_at, updated_at
        )
        SELECT DISTINCT ON (
            opportunity.organization_id, opportunity.project_id,
            run.country, run.language, opportunity.normalized_keyword
        )
            md5(
                opportunity.organization_id || ':' || opportunity.project_id || ':' ||
                run.country || ':' || run.language || ':' || opportunity.normalized_keyword
            ),
            opportunity.organization_id, opportunity.project_id,
            run.country, run.language, opportunity.normalized_keyword,
            opportunity.status, opportunity.keyword_id, opportunity.decided_at,
            opportunity.created_at, opportunity.updated_at
        FROM keyword_competitor_opportunities AS opportunity
        JOIN keyword_competitor_analysis_runs AS run
          ON run.id = opportunity.analysis_run_id
        ORDER BY opportunity.organization_id, opportunity.project_id,
                 run.country, run.language, opportunity.normalized_keyword,
                 run.created_at DESC, opportunity.updated_at DESC,
                 opportunity.id DESC
        """
    )


def downgrade() -> None:
    op.drop_table("keyword_competitor_opportunity_decisions")
    op.drop_column("keyword_competitor_analysis_dispatches", "last_checked_at")
    op.drop_column("keyword_competitor_analysis_runs", "recovery_count")
