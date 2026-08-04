"""Index keyword request cache and unresolved outcome lookups.

Revision ID: 20260730_0017
Revises: 20260730_0016
Create Date: 2026-07-30
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260730_0017"
down_revision: str | Sequence[str] | None = "20260730_0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_index(
        "ix_keyword_external_requests_cache_lookup",
        "keyword_external_requests",
        [
            "organization_id",
            "provider",
            "endpoint",
            "request_hash",
            "status",
            "finished_at",
        ],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_keyword_external_requests_cache_lookup",
        table_name="keyword_external_requests",
    )
