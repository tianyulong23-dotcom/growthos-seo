"""Persist verified WordPress publication capabilities.

Revision ID: 20260811_0054
Revises: 20260811_0053
Create Date: 2026-08-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260811_0054"
down_revision: str | Sequence[str] | None = "20260811_0053"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "wordpress_project_connections",
        sa.Column(
            "capabilities_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.execute(
        "UPDATE publication_targets "
        "SET capabilities_json = '{}'::jsonb, status = 'disconnected', updated_at = now() "
        "WHERE adapter_type = 'wordpress'"
    )


def downgrade() -> None:
    op.drop_column("wordpress_project_connections", "capabilities_json")
