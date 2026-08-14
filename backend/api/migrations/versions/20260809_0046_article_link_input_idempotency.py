"""Make article link-analysis inputs concurrency-safe.

Revision ID: 20260809_0046
Revises: 20260809_0045
Create Date: 2026-08-09
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260809_0046"
down_revision: str | Sequence[str] | None = "20260809_0045"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("article_link_analyses", sa.Column("options_hash", sa.Text()))
    op.execute(
        "UPDATE article_link_analyses SET options_hash = CASE "
        "WHEN COALESCE((input_snapshot ->> 'check_external')::boolean, true) "
        "THEN 'check_external=1' ELSE 'check_external=0' END"
    )
    op.alter_column("article_link_analyses", "options_hash", nullable=False)
    op.execute(
        "WITH ranked AS ("
        "SELECT id, row_number() OVER ("
        "PARTITION BY article_id, document_hash, ruleset_version, options_hash "
        "ORDER BY created_at DESC, id DESC"
        ") AS row_number FROM article_link_analyses "
        "WHERE status IN ('queued','running')"
        ") UPDATE article_link_analyses AS analysis "
        "SET status = 'failed', error_code = 'link_analysis_superseded', "
        "error_detail = 'Superseded while enforcing input idempotency.', "
        "completed_at = COALESCE(analysis.completed_at, now()), "
        "lease_until = NULL, lease_token = NULL "
        "FROM ranked WHERE analysis.id = ranked.id AND ranked.row_number > 1"
    )
    op.create_index(
        "uq_article_link_analyses_active_input",
        "article_link_analyses",
        ["article_id", "document_hash", "ruleset_version", "options_hash"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued','running')"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_article_link_analyses_active_input",
        table_name="article_link_analyses",
    )
    op.drop_column("article_link_analyses", "options_hash")
