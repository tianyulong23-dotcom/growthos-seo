"""Add content-plan SERP feature audit fields.

Revision ID: 20260806_cp024
Revises: 20260805_cp023
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260806_cp024"
down_revision: str | Sequence[str] | None = "20260805_cp023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.add_column(
        "content_plan_serp_snapshots",
        sa.Column(
            "serp_features_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        schema="public",
    )
    op.add_column(
        "content_plan_serp_snapshots",
        sa.Column("featured_snippet_json", jsonb),
        schema="public",
    )


def downgrade() -> None:
    op.drop_column(
        "content_plan_serp_snapshots", "featured_snippet_json", schema="public"
    )
    op.drop_column(
        "content_plan_serp_snapshots", "serp_features_json", schema="public"
    )
