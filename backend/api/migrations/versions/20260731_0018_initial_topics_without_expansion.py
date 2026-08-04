"""Store initial keyword topics without expansion state.

Revision ID: 20260731_0018
Revises: 20260730_0017
Create Date: 2026-07-31
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260731_0018"
down_revision: str | Sequence[str] | None = "20260730_0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE keyword_seeds
        SET expansion_status = 'not_applicable',
            expansion_run_id = NULL,
            expansion_round_number = NULL,
            expanded_at = NULL,
            updated_at = now()
        WHERE decision = 'selected'
        """
    )
    op.execute(
        """
        UPDATE keyword_build_runs
        SET pending_seed_count = 0,
            selected_count = (
                SELECT count(*)
                FROM keyword_seeds AS seed
                WHERE seed.initial_run_id = keyword_build_runs.id
                    AND seed.decision = 'selected'
            ),
            updated_at = now()
        WHERE kind = 'initial'
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE keyword_seeds
        SET expansion_status = CASE
                WHEN ai_rank IS NOT NULL AND ai_rank <= 20
                    THEN 'expanded'
                ELSE 'pending_expansion'
            END,
            updated_at = now()
        WHERE decision = 'selected'
        """
    )
    op.execute(
        """
        UPDATE keyword_build_runs
        SET pending_seed_count = (
                SELECT count(*)
                FROM keyword_seeds AS seed
                WHERE seed.project_id = keyword_build_runs.project_id
                    AND seed.expansion_status = 'pending_expansion'
            ),
            selected_count = LEAST(selected_count, 20),
            updated_at = now()
        WHERE kind = 'initial'
        """
    )
