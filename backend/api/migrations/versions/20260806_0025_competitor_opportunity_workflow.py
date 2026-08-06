"""Complete the competitor opportunity workflow.

Revision ID: 20260806_0025
Revises: 20260806_0024
Create Date: 2026-08-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260806_0025"
down_revision: str | Sequence[str] | None = "20260806_0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("keyword_competitor_analysis_runs", sa.Column("target_domain", sa.Text()))
    op.add_column("keyword_competitor_analysis_runs", sa.Column("country", sa.Text()))
    op.add_column("keyword_competitor_analysis_runs", sa.Column("language", sa.Text()))
    op.execute(
        """
        UPDATE keyword_competitor_analysis_runs AS run
        SET target_domain = project.domain,
            country = project.country,
            language = project.language
        FROM projects AS project
        WHERE project.id = run.project_id
        """
    )
    op.alter_column("keyword_competitor_analysis_runs", "target_domain", nullable=False)
    op.alter_column("keyword_competitor_analysis_runs", "country", nullable=False)
    op.alter_column("keyword_competitor_analysis_runs", "language", nullable=False)

    op.alter_column("keyword_external_requests", "build_run_id", nullable=True)
    op.add_column(
        "keyword_external_requests",
        sa.Column(
            "competitor_analysis_run_id",
            sa.Text(),
            sa.ForeignKey("keyword_competitor_analysis_runs.id", ondelete="CASCADE"),
        ),
    )
    op.create_check_constraint(
        "ck_keyword_external_requests_single_owner",
        "keyword_external_requests",
        "num_nonnulls(build_run_id, competitor_analysis_run_id) = 1",
    )
    op.create_index(
        "ix_keyword_external_requests_competitor_analysis_run_id",
        "keyword_external_requests",
        ["competitor_analysis_run_id"],
    )

    op.rename_table(
        "keyword_competitor_opportunities",
        "keyword_competitor_opportunity_rankings",
    )
    op.drop_index("ix_keyword_competitor_opportunities_run_keyword")
    op.drop_index("ix_keyword_competitor_opportunities_project_volume")
    for old_name, new_name in _RANKING_INDEX_RENAMES:
        op.execute(f"ALTER INDEX {old_name} RENAME TO {new_name}")

    op.create_table(
        "keyword_competitor_opportunities",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "analysis_run_id",
            sa.Text(),
            sa.ForeignKey("keyword_competitor_analysis_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("keyword", sa.Text(), nullable=False),
        sa.Column("normalized_keyword", sa.Text(), nullable=False),
        sa.Column("best_competitor_rank", sa.Integer()),
        sa.Column("competitor_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("opportunity_score", sa.Float()),
        sa.Column("search_volume", sa.Integer()),
        sa.Column("cpc", sa.Float()),
        sa.Column("competition", sa.Float()),
        sa.Column("keyword_difficulty", sa.Integer()),
        sa.Column("intent", sa.Text()),
        sa.Column(
            "monthly_searches",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default="new",
        ),
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
            "analysis_run_id",
            "normalized_keyword",
            name="uq_keyword_competitor_opportunities_run_keyword",
        ),
        sa.CheckConstraint(
            "status IN ('new', 'accepted', 'dismissed')",
            name="ck_keyword_competitor_opportunities_status",
        ),
    )
    op.create_index(
        "ix_keyword_competitor_opportunities_organization_id",
        "keyword_competitor_opportunities",
        ["organization_id"],
    )
    op.create_index(
        "ix_keyword_competitor_opportunities_project_id",
        "keyword_competitor_opportunities",
        ["project_id"],
    )
    op.create_index(
        "ix_keyword_competitor_opportunities_analysis_run_id",
        "keyword_competitor_opportunities",
        ["analysis_run_id"],
    )
    op.create_index(
        "ix_keyword_competitor_opportunities_keyword_id",
        "keyword_competitor_opportunities",
        ["keyword_id"],
    )
    op.create_index(
        "ix_keyword_competitor_opportunities_run_status_score",
        "keyword_competitor_opportunities",
        ["analysis_run_id", "status", "opportunity_score"],
    )
    op.create_index(
        "ix_keyword_competitor_opportunities_project_volume",
        "keyword_competitor_opportunities",
        ["project_id", "search_volume"],
    )

    op.execute(
        """
        INSERT INTO keyword_competitor_opportunities (
            id, organization_id, project_id, analysis_run_id,
            keyword, normalized_keyword, search_volume, cpc, competition,
            keyword_difficulty, intent, monthly_searches, created_at, updated_at
        )
        SELECT DISTINCT ON (analysis_run_id, normalized_keyword)
            'opportunity-' || md5(analysis_run_id || ':' || normalized_keyword),
            organization_id, project_id, analysis_run_id,
            keyword, normalized_keyword, search_volume, cpc, competition,
            keyword_difficulty, intent, monthly_searches, created_at, created_at
        FROM keyword_competitor_opportunity_rankings
        ORDER BY analysis_run_id, normalized_keyword,
                 search_volume DESC NULLS LAST, created_at
        """
    )
    op.add_column(
        "keyword_competitor_opportunity_rankings",
        sa.Column("opportunity_id", sa.Text()),
    )
    op.execute(
        """
        UPDATE keyword_competitor_opportunity_rankings AS ranking
        SET opportunity_id = opportunity.id
        FROM keyword_competitor_opportunities AS opportunity
        WHERE opportunity.analysis_run_id = ranking.analysis_run_id
          AND opportunity.normalized_keyword = ranking.normalized_keyword
        """
    )
    op.alter_column(
        "keyword_competitor_opportunity_rankings",
        "opportunity_id",
        nullable=False,
    )
    op.create_foreign_key(
        "fk_keyword_competitor_opportunity_rankings_opportunity_id",
        "keyword_competitor_opportunity_rankings",
        "keyword_competitor_opportunities",
        ["opportunity_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.drop_constraint(
        "uq_keyword_competitor_opportunities_competitor_keyword",
        "keyword_competitor_opportunity_rankings",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_keyword_comp_opportunity_rankings_pair",
        "keyword_competitor_opportunity_rankings",
        ["competitor_id", "opportunity_id"],
    )
    op.create_index(
        "ix_keyword_competitor_opportunity_rankings_opportunity_id",
        "keyword_competitor_opportunity_rankings",
        ["opportunity_id"],
    )
    for column in (
        "keyword",
        "normalized_keyword",
        "search_volume",
        "cpc",
        "competition",
        "keyword_difficulty",
        "intent",
        "monthly_searches",
    ):
        op.drop_column("keyword_competitor_opportunity_rankings", column)
    _refresh_opportunity_rollups()


def downgrade() -> None:
    for column, type_ in (
        ("keyword", sa.Text()),
        ("normalized_keyword", sa.Text()),
        ("search_volume", sa.Integer()),
        ("cpc", sa.Float()),
        ("competition", sa.Float()),
        ("keyword_difficulty", sa.Integer()),
        ("intent", sa.Text()),
        ("monthly_searches", postgresql.JSONB()),
    ):
        op.add_column(
            "keyword_competitor_opportunity_rankings",
            sa.Column(column, type_),
        )
    op.execute(
        """
        UPDATE keyword_competitor_opportunity_rankings AS ranking
        SET keyword = opportunity.keyword,
            normalized_keyword = opportunity.normalized_keyword,
            search_volume = opportunity.search_volume,
            cpc = opportunity.cpc,
            competition = opportunity.competition,
            keyword_difficulty = opportunity.keyword_difficulty,
            intent = opportunity.intent,
            monthly_searches = opportunity.monthly_searches
        FROM keyword_competitor_opportunities AS opportunity
        WHERE opportunity.id = ranking.opportunity_id
        """
    )
    op.alter_column("keyword_competitor_opportunity_rankings", "keyword", nullable=False)
    op.alter_column("keyword_competitor_opportunity_rankings", "normalized_keyword", nullable=False)
    op.alter_column("keyword_competitor_opportunity_rankings", "monthly_searches", nullable=False)
    op.drop_index("ix_keyword_competitor_opportunity_rankings_opportunity_id")
    op.drop_constraint(
        "uq_keyword_comp_opportunity_rankings_pair",
        "keyword_competitor_opportunity_rankings",
        type_="unique",
    )
    op.drop_constraint(
        "fk_keyword_competitor_opportunity_rankings_opportunity_id",
        "keyword_competitor_opportunity_rankings",
        type_="foreignkey",
    )
    op.drop_column("keyword_competitor_opportunity_rankings", "opportunity_id")
    op.create_unique_constraint(
        "uq_keyword_competitor_opportunities_competitor_keyword",
        "keyword_competitor_opportunity_rankings",
        ["competitor_id", "normalized_keyword"],
    )
    op.drop_table("keyword_competitor_opportunities")
    for old_name, new_name in reversed(_RANKING_INDEX_RENAMES):
        op.execute(f"ALTER INDEX {new_name} RENAME TO {old_name}")
    op.rename_table(
        "keyword_competitor_opportunity_rankings",
        "keyword_competitor_opportunities",
    )
    op.create_index(
        "ix_keyword_competitor_opportunities_run_keyword",
        "keyword_competitor_opportunities",
        ["analysis_run_id", "normalized_keyword"],
    )
    op.create_index(
        "ix_keyword_competitor_opportunities_project_volume",
        "keyword_competitor_opportunities",
        ["project_id", "search_volume"],
    )

    op.drop_index("ix_keyword_external_requests_competitor_analysis_run_id")
    op.drop_constraint(
        "ck_keyword_external_requests_single_owner",
        "keyword_external_requests",
        type_="check",
    )
    op.execute("DELETE FROM keyword_external_requests WHERE competitor_analysis_run_id IS NOT NULL")
    op.drop_column("keyword_external_requests", "competitor_analysis_run_id")
    op.alter_column("keyword_external_requests", "build_run_id", nullable=False)
    op.drop_column("keyword_competitor_analysis_runs", "language")
    op.drop_column("keyword_competitor_analysis_runs", "country")
    op.drop_column("keyword_competitor_analysis_runs", "target_domain")


def _refresh_opportunity_rollups() -> None:
    op.execute(
        """
        WITH rollup AS (
            SELECT opportunity_id,
                   min(competitor_rank) AS best_rank,
                   count(*)::int AS competitor_count
            FROM keyword_competitor_opportunity_rankings
            GROUP BY opportunity_id
        )
        UPDATE keyword_competitor_opportunities AS opportunity
        SET best_competitor_rank = rollup.best_rank,
            competitor_count = rollup.competitor_count,
            opportunity_score = LEAST(
                100,
                round((
                    CASE
                        WHEN COALESCE(opportunity.search_volume, 0) <= 0 THEN 0
                        ELSE LEAST(45, ln(opportunity.search_volume + 1) / ln(100001) * 45)
                    END
                    + CASE
                        WHEN opportunity.keyword_difficulty IS NULL THEN 15
                        ELSE (100 - opportunity.keyword_difficulty) / 100.0 * 30
                    END
                    + LEAST(rollup.competitor_count, 5) / 5.0 * 15
                    + CASE
                        WHEN rollup.best_rank IS NULL THEN 0
                        ELSE (101 - LEAST(rollup.best_rank, 100)) / 100.0 * 10
                    END
                )::numeric, 2)
            )
        FROM rollup
        WHERE opportunity.id = rollup.opportunity_id
        """
    )


_RANKING_INDEX_RENAMES = (
    (
        "ix_keyword_competitor_opportunities_organization_id",
        "ix_keyword_competitor_opportunity_rankings_organization_id",
    ),
    (
        "ix_keyword_competitor_opportunities_project_id",
        "ix_keyword_competitor_opportunity_rankings_project_id",
    ),
    (
        "ix_keyword_competitor_opportunities_analysis_run_id",
        "ix_keyword_competitor_opportunity_rankings_analysis_run_id",
    ),
    (
        "ix_keyword_competitor_opportunities_competitor_id",
        "ix_keyword_competitor_opportunity_rankings_competitor_id",
    ),
)
