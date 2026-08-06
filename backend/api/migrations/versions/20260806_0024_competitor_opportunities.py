"""Store competitor opportunity gaps instead of shared keywords.

Revision ID: 20260806_0024
Revises: 20260806_0023
Create Date: 2026-08-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260806_0024"
down_revision: str | Sequence[str] | None = "20260806_0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.rename_table(
        "keyword_competitor_shared_keywords",
        "keyword_competitor_opportunities",
    )
    op.drop_column("keyword_competitor_opportunities", "own_rank")
    op.drop_column("keyword_competitor_opportunities", "own_url")
    op.execute(
        "ALTER TABLE keyword_competitor_opportunities "
        "RENAME CONSTRAINT uq_keyword_competitor_shared_keywords_competitor_keyword "
        "TO uq_keyword_competitor_opportunities_competitor_keyword"
    )
    for old_name, new_name in _INDEX_RENAMES:
        op.execute(f"ALTER INDEX {old_name} RENAME TO {new_name}")


def downgrade() -> None:
    op.add_column(
        "keyword_competitor_opportunities",
        sa.Column("own_url", sa.Text()),
    )
    op.add_column(
        "keyword_competitor_opportunities",
        sa.Column("own_rank", sa.Integer()),
    )
    for old_name, new_name in reversed(_INDEX_RENAMES):
        op.execute(f"ALTER INDEX {new_name} RENAME TO {old_name}")
    op.execute(
        "ALTER TABLE keyword_competitor_opportunities "
        "RENAME CONSTRAINT uq_keyword_competitor_opportunities_competitor_keyword "
        "TO uq_keyword_competitor_shared_keywords_competitor_keyword"
    )
    op.rename_table(
        "keyword_competitor_opportunities",
        "keyword_competitor_shared_keywords",
    )


_INDEX_RENAMES = (
    (
        "ix_keyword_competitor_shared_keywords_organization_id",
        "ix_keyword_competitor_opportunities_organization_id",
    ),
    (
        "ix_keyword_competitor_shared_keywords_project_id",
        "ix_keyword_competitor_opportunities_project_id",
    ),
    (
        "ix_keyword_competitor_shared_keywords_analysis_run_id",
        "ix_keyword_competitor_opportunities_analysis_run_id",
    ),
    (
        "ix_keyword_competitor_shared_keywords_competitor_id",
        "ix_keyword_competitor_opportunities_competitor_id",
    ),
    (
        "ix_keyword_competitor_shared_keywords_run_keyword",
        "ix_keyword_competitor_opportunities_run_keyword",
    ),
    (
        "ix_keyword_competitor_shared_keywords_project_volume",
        "ix_keyword_competitor_opportunities_project_volume",
    ),
)
