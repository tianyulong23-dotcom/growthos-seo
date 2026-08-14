"""Add article version governance and restoration audit fields.

Revision ID: 20260808_0040
Revises: 20260807_0039
Create Date: 2026-08-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260808_0040"
down_revision: str | Sequence[str] | None = "20260807_0039"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("article_versions", sa.Column("review_version", sa.Integer()))
    op.add_column(
        "article_versions",
        sa.Column(
            "created_by",
            sa.Text(),
            nullable=False,
            server_default="system",
        ),
    )
    op.add_column(
        "article_versions",
        sa.Column("restored_from_version_id", sa.Text()),
    )
    op.create_check_constraint(
        "ck_article_versions_review_version",
        "article_versions",
        "review_version IS NULL OR review_version > 0",
    )
    op.create_foreign_key(
        "fk_article_versions_restored_from_version_id",
        "article_versions",
        "article_versions",
        ["restored_from_version_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_article_versions_article_created",
        "article_versions",
        ["article_id", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_article_versions_article_created",
        table_name="article_versions",
    )
    op.drop_constraint(
        "fk_article_versions_restored_from_version_id",
        "article_versions",
        type_="foreignkey",
    )
    op.drop_constraint(
        "ck_article_versions_review_version",
        "article_versions",
        type_="check",
    )
    op.drop_column("article_versions", "restored_from_version_id")
    op.drop_column("article_versions", "created_by")
    op.drop_column("article_versions", "review_version")
