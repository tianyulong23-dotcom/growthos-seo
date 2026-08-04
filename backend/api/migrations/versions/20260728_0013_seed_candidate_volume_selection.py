"""Stop assigning synthetic scores to seed candidates.

Revision ID: 20260728_0013
Revises: 20260728_0012
Create Date: 2026-07-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260728_0013"
down_revision: str | Sequence[str] | None = "20260728_0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "keyword_seeds",
        "candidate_score",
        existing_type=sa.Float(),
        nullable=True,
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE keyword_seeds
        SET candidate_score = 0
        WHERE candidate_score IS NULL
        """
    )
    op.alter_column(
        "keyword_seeds",
        "candidate_score",
        existing_type=sa.Float(),
        nullable=False,
    )
