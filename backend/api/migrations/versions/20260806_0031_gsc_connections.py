"""Add project-scoped Google Search Console connections.

Revision ID: 20260806_0031
Revises: 20260806_0030
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260806_0031"
down_revision: str | Sequence[str] | None = "20260806_0030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "gsc_connections",
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("site_url", sa.Text()),
        sa.Column("google_account_id", sa.Text(), nullable=False),
        sa.Column("connected_account_email", sa.Text()),
        sa.Column("refresh_token_encrypted", sa.LargeBinary(), nullable=False),
        sa.Column("scopes", sa.Text(), nullable=False),
        sa.Column("requires_reconnect", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("project_id"),
    )
    op.create_index("ix_gsc_connections_organization_id", "gsc_connections", ["organization_id"])


def downgrade() -> None:
    op.drop_index("ix_gsc_connections_organization_id", table_name="gsc_connections")
    op.drop_table("gsc_connections")
