"""Allow confirmed business-profile keyword seeds.

Revision ID: 20260803_0021
Revises: 20260803_0020
Create Date: 2026-08-03
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260803_0021"
down_revision: str | Sequence[str] | None = "20260803_0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SOURCES = (
    "'site_seed', 'seed', 'google_ads', 'google_suggest', 'ai', "
    "'profile_seed', 'labs_site', 'google_ads_site', 'keyword_ideas', "
    "'keyword_ideas_broad', 'keyword_ideas_close'"
)
LEGACY_SOURCES = (
    "'site_seed', 'seed', 'google_ads', 'google_suggest', 'ai', "
    "'labs_site', 'google_ads_site', 'keyword_ideas', "
    "'keyword_ideas_broad', 'keyword_ideas_close'"
)


def upgrade() -> None:
    op.drop_constraint("ck_keyword_ideas_source", "keyword_ideas", type_="check")
    op.create_check_constraint(
        "ck_keyword_ideas_source",
        "keyword_ideas",
        f"source IN ({SOURCES})",
    )


def downgrade() -> None:
    op.drop_constraint("ck_keyword_ideas_source", "keyword_ideas", type_="check")
    op.create_check_constraint(
        "ck_keyword_ideas_source",
        "keyword_ideas",
        f"source IN ({LEGACY_SOURCES})",
    )
