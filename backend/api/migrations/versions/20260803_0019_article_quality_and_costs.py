"""Separate article publication quality and provider cost provenance.

Revision ID: 20260803_0019
Revises: 20260801_0018
Create Date: 2026-08-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260803_0019"
down_revision: str | Sequence[str] | None = "20260801_0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "articles",
        sa.Column(
            "publication_status",
            sa.Text(),
            nullable=False,
            server_default="complete_draft",
        ),
    )
    op.create_check_constraint(
        "ck_articles_publication_status",
        "articles",
        "publication_status IN ('publish_ready','complete_draft')",
    )

    op.add_column(
        "article_run_steps",
        sa.Column("reported_cost", sa.Numeric(18, 8), nullable=True),
    )
    op.add_column(
        "article_run_steps",
        sa.Column("estimated_cost", sa.Numeric(18, 8), nullable=True),
    )
    op.add_column(
        "article_run_steps",
        sa.Column(
            "estimation_basis_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )


def downgrade() -> None:
    op.drop_column("article_run_steps", "estimation_basis_json")
    op.drop_column("article_run_steps", "estimated_cost")
    op.drop_column("article_run_steps", "reported_cost")
    op.drop_constraint(
        "ck_articles_publication_status", "articles", type_="check"
    )
    op.drop_column("articles", "publication_status")
