"""Claim competitor analysis dispatches before launching workflows.

Revision ID: 20260806_0027
Revises: 20260806_0026
Create Date: 2026-08-04
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260806_0027"
down_revision: str | Sequence[str] | None = "20260806_0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_keyword_competitor_analysis_dispatches_status",
        "keyword_competitor_analysis_dispatches",
        type_="check",
    )
    op.create_check_constraint(
        "ck_keyword_competitor_analysis_dispatches_status",
        "keyword_competitor_analysis_dispatches",
        "status IN ('pending', 'dispatching', 'dispatched')",
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE keyword_competitor_analysis_dispatches
        SET status = 'pending'
        WHERE status = 'dispatching'
        """
    )
    op.drop_constraint(
        "ck_keyword_competitor_analysis_dispatches_status",
        "keyword_competitor_analysis_dispatches",
        type_="check",
    )
    op.create_check_constraint(
        "ck_keyword_competitor_analysis_dispatches_status",
        "keyword_competitor_analysis_dispatches",
        "status IN ('pending', 'dispatched')",
    )
