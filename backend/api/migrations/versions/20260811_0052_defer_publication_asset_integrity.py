"""Defer publication asset integrity checks until transaction commit.

Revision ID: 20260811_0052
Revises: 20260811_0051
Create Date: 2026-08-11
"""

from collections.abc import Sequence

from alembic import op


revision: str = "20260811_0052"
down_revision: str | Sequence[str] | None = "20260811_0051"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


ASSET_FOREIGN_KEYS = (
    ("publication_asset_mappings", "publication_asset_mappings_asset_id_fkey"),
    ("publication_asset_checkpoints", "publication_asset_checkpoints_asset_id_fkey"),
)


def upgrade() -> None:
    for table_name, constraint_name in ASSET_FOREIGN_KEYS:
        op.drop_constraint(constraint_name, table_name, type_="foreignkey")
        op.create_foreign_key(
            constraint_name,
            table_name,
            "content_assets",
            ["asset_id"],
            ["id"],
            deferrable=True,
            initially="DEFERRED",
        )


def downgrade() -> None:
    for table_name, constraint_name in ASSET_FOREIGN_KEYS:
        op.drop_constraint(constraint_name, table_name, type_="foreignkey")
        op.create_foreign_key(
            constraint_name,
            table_name,
            "content_assets",
            ["asset_id"],
            ["id"],
            ondelete="RESTRICT",
        )
