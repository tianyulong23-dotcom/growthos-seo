"""Add content-plan article trigger fields.

Revision ID: 20260806_cp025
Revises: 20260806_cp024
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260806_cp025"
down_revision: str | Sequence[str] | None = "20260806_cp024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.add_column("articles", sa.Column("plan_item_id", sa.Text()), schema="public")
    op.create_foreign_key(
        "fk_articles_plan_item_id_content_plan_items",
        "articles",
        "content_plan_items",
        ["plan_item_id"],
        ["id"],
        source_schema="public",
        referent_schema="public",
        ondelete="SET NULL",
    )
    op.create_unique_constraint(
        "uq_articles_plan_item", "articles", ["plan_item_id"], schema="public"
    )

    op.add_column(
        "article_runs", sa.Column("plan_item_version", sa.Integer()), schema="public"
    )
    op.add_column(
        "article_runs", sa.Column("run_idempotency_key", sa.Text()), schema="public"
    )
    op.add_column(
        "article_runs",
        sa.Column(
            "plan_input_snapshot_json",
            jsonb,
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        schema="public",
    )
    op.create_check_constraint(
        "ck_article_runs_plan_item_version",
        "article_runs",
        "plan_item_version IS NULL OR plan_item_version > 0",
        schema="public",
    )
    op.create_unique_constraint(
        "uq_article_runs_run_idempotency_key",
        "article_runs",
        ["run_idempotency_key"],
        schema="public",
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_article_runs_run_idempotency_key",
        "article_runs",
        type_="unique",
        schema="public",
    )
    op.drop_constraint(
        "ck_article_runs_plan_item_version",
        "article_runs",
        type_="check",
        schema="public",
    )
    op.drop_column("article_runs", "plan_input_snapshot_json", schema="public")
    op.drop_column("article_runs", "run_idempotency_key", schema="public")
    op.drop_column("article_runs", "plan_item_version", schema="public")

    op.drop_constraint(
        "uq_articles_plan_item", "articles", type_="unique", schema="public"
    )
    op.drop_constraint(
        "fk_articles_plan_item_id_content_plan_items",
        "articles",
        type_="foreignkey",
        schema="public",
    )
    op.drop_column("articles", "plan_item_id", schema="public")
