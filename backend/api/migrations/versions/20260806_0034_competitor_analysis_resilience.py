"""Harden competitor discovery caching and local-market evidence.

Revision ID: 20260806_0034
Revises: 20260806_0033
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260806_0034"
down_revision: str | Sequence[str] | None = "20260806_0033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


SITE_CHECK_STATUSES = (
    "not_checked",
    "verified",
    "redirected_related",
    "redirected_unrelated",
    "unverified_redirect",
    "blocked",
    "temporarily_unavailable",
    "permanently_unavailable",
    "non_html",
    "unsafe_target",
    "redirect_loop",
    "platform_or_login",
)

DOMAIN_TYPES = (
    "direct_product_competitor",
    "publisher_media",
    "marketplace_directory",
    "community_forum",
    "documentation_resource",
)


def quoted(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.add_column(
        "keyword_competitor_analysis_runs",
        sa.Column(
            "local_market",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )

    op.execute(
        "UPDATE keyword_competitors SET domain_type = 'documentation_resource' "
        f"WHERE domain_type NOT IN ({quoted(DOMAIN_TYPES)})"
    )
    op.create_check_constraint(
        "ck_keyword_competitors_domain_type",
        "keyword_competitors",
        f"domain_type IN ({quoted(DOMAIN_TYPES)})",
    )
    op.create_check_constraint(
        "ck_keyword_competitors_site_check_status",
        "keyword_competitors",
        f"site_check_status IN ({quoted(SITE_CHECK_STATUSES)})",
    )
    op.create_check_constraint(
        "ck_keyword_competitors_site_relation",
        "keyword_competitors",
        "site_relation IN ('related', 'unrelated', 'uncertain')",
    )

    op.create_table(
        "keyword_competitor_site_verifications",
        sa.Column("organization_id", sa.Text(), primary_key=True),
        sa.Column("domain", sa.Text(), primary_key=True),
        sa.Column("country", sa.Text(), primary_key=True),
        sa.Column("language", sa.Text(), primary_key=True),
        sa.Column("crawler_facts", postgresql.JSONB(), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_keyword_competitor_site_verifications_expiry",
        "keyword_competitor_site_verifications",
        ["organization_id", "country", "language", "checked_at"],
    )
    op.drop_index(
        "ix_keyword_competitors_site_verification_cache",
        table_name="keyword_competitors",
    )


def downgrade() -> None:
    op.create_index(
        "ix_keyword_competitors_site_verification_cache",
        "keyword_competitors",
        ["organization_id", "domain", "updated_at"],
    )
    op.drop_index(
        "ix_keyword_competitor_site_verifications_expiry",
        table_name="keyword_competitor_site_verifications",
    )
    op.drop_table("keyword_competitor_site_verifications")
    op.drop_constraint(
        "ck_keyword_competitors_site_relation",
        "keyword_competitors",
        type_="check",
    )
    op.drop_constraint(
        "ck_keyword_competitors_site_check_status",
        "keyword_competitors",
        type_="check",
    )
    op.drop_constraint(
        "ck_keyword_competitors_domain_type",
        "keyword_competitors",
        type_="check",
    )
    op.drop_column("keyword_competitor_analysis_runs", "local_market")
