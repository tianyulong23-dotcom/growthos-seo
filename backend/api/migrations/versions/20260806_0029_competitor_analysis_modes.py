"""Add manual and automatic competitor analysis modes.

Revision ID: 20260806_0029
Revises: 20260806_0028
Create Date: 2026-08-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260806_0029"
down_revision: str | Sequence[str] | None = "20260806_0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column("analysis_mode", sa.Text(), nullable=False, server_default="auto"),
    )
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column(
            "requested_competitor_domains",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.create_check_constraint(
        "ck_keyword_competitor_analysis_runs_mode",
        "keyword_competitor_analysis_runs",
        "analysis_mode IN ('manual', 'auto')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_keyword_competitor_analysis_runs_mode",
        "keyword_competitor_analysis_runs",
        type_="check",
    )
    op.drop_column("keyword_competitor_analysis_runs", "requested_competitor_domains")
    op.drop_column("keyword_competitor_analysis_runs", "analysis_mode")
