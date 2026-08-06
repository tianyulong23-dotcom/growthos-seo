"""Track competitor opportunity metric snapshots.

Revision ID: 20260806_0028
Revises: 20260806_0027
Create Date: 2026-08-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260806_0028"
down_revision: str | Sequence[str] | None = "20260806_0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "keyword_competitor_opportunities",
        sa.Column("competition_level", sa.Text()),
    )
    op.add_column(
        "keyword_competitor_opportunities",
        sa.Column("metrics_fetched_at", sa.DateTime(timezone=True)),
    )
    op.execute(
        """
        UPDATE keyword_competitor_opportunities AS opportunity
        SET competition_level = (
                SELECT COALESCE(
                    ranking.raw_payload #>>
                        '{keyword_data,keyword_info,competition_level}',
                    ranking.raw_payload #>> '{keyword_info,competition_level}'
                )
                FROM keyword_competitor_opportunity_rankings AS ranking
                WHERE ranking.opportunity_id = opportunity.id
                  AND COALESCE(
                      ranking.raw_payload #>>
                          '{keyword_data,keyword_info,competition_level}',
                      ranking.raw_payload #>> '{keyword_info,competition_level}'
                  ) IS NOT NULL
                ORDER BY ranking.created_at DESC, ranking.id DESC
                LIMIT 1
            ),
            metrics_fetched_at = COALESCE(
                (
                    SELECT max(ranking.created_at)
                    FROM keyword_competitor_opportunity_rankings AS ranking
                    WHERE ranking.opportunity_id = opportunity.id
                ),
                opportunity.created_at
            )
        """
    )
    op.alter_column(
        "keyword_competitor_opportunities",
        "metrics_fetched_at",
        nullable=False,
        server_default=sa.func.now(),
    )


def downgrade() -> None:
    op.drop_column("keyword_competitor_opportunities", "metrics_fetched_at")
    op.drop_column("keyword_competitor_opportunities", "competition_level")
