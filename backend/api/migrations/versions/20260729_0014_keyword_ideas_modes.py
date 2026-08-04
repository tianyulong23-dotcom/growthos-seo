"""Track broad and close Keyword Ideas results separately.

Revision ID: 20260729_0014
Revises: 20260728_0013
Create Date: 2026-07-29
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260729_k014"
down_revision: str | Sequence[str] | None = "20260728_k013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_keyword_ideas_source", "keyword_ideas", type_="check")
    op.create_check_constraint(
        "ck_keyword_ideas_source",
        "keyword_ideas",
        "source IN ("
        "'site_seed', 'seed', 'google_ads', 'google_suggest', 'ai', "
        "'labs_site', 'google_ads_site', 'keyword_ideas', "
        "'keyword_ideas_broad', 'keyword_ideas_close'"
        ")",
    )


def downgrade() -> None:
    op.drop_constraint("ck_keyword_ideas_source", "keyword_ideas", type_="check")
    op.execute(
        """
        DELETE FROM keyword_ideas AS variant
        WHERE variant.source IN ('keyword_ideas_broad', 'keyword_ideas_close')
          AND EXISTS (
              SELECT 1
              FROM keyword_ideas AS legacy
              WHERE legacy.source = 'keyword_ideas'
                AND legacy.build_run_id = variant.build_run_id
                AND legacy.normalized_keyword = variant.normalized_keyword
                AND legacy.source_seed_key = variant.source_seed_key
          )
        """
    )
    op.execute(
        """
        DELETE FROM keyword_ideas AS duplicate
        USING keyword_ideas AS keep
        WHERE duplicate.source IN ('keyword_ideas_broad', 'keyword_ideas_close')
          AND keep.source IN ('keyword_ideas_broad', 'keyword_ideas_close')
          AND duplicate.build_run_id = keep.build_run_id
          AND duplicate.normalized_keyword = keep.normalized_keyword
          AND duplicate.source_seed_key = keep.source_seed_key
          AND duplicate.id > keep.id
        """
    )
    op.execute(
        """
        UPDATE keyword_ideas
        SET source = 'keyword_ideas'
        WHERE source IN ('keyword_ideas_broad', 'keyword_ideas_close')
        """
    )
    op.create_check_constraint(
        "ck_keyword_ideas_source",
        "keyword_ideas",
        "source IN ("
        "'site_seed', 'seed', 'google_ads', 'google_suggest', 'ai', "
        "'labs_site', 'google_ads_site', 'keyword_ideas'"
        ")",
    )
