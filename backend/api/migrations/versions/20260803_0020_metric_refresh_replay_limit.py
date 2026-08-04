"""Bound orphaned keyword metric workflow replays.

Revision ID: 20260803_0020
Revises: 20260803_0019
Create Date: 2026-08-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260803_k020"
down_revision: str | Sequence[str] | None = "20260803_k019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "keyword_metric_refresh_jobs",
        sa.Column(
            "orphan_replay_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.create_check_constraint(
        "ck_keyword_metric_refresh_jobs_orphan_replay_count",
        "keyword_metric_refresh_jobs",
        "orphan_replay_count BETWEEN 0 AND 3",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_keyword_metric_refresh_jobs_orphan_replay_count",
        "keyword_metric_refresh_jobs",
        type_="check",
    )
    op.drop_column("keyword_metric_refresh_jobs", "orphan_replay_count")
