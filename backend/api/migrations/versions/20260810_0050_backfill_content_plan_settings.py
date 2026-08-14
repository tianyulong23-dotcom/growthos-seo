"""Backfill default content plan settings for website projects.

Revision ID: 20260810_0050
Revises: 20260810_0049
Create Date: 2026-08-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260810_0050"
down_revision: str | Sequence[str] | None = "20260810_0049"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        sa.text(
            """
            INSERT INTO public.content_plan_settings (
                project_id,
                cadence,
                paused,
                timezone,
                default_publish_local_time,
                cadence_anchor_week,
                version
            )
            SELECT
                projects.id,
                'weekly_2_3',
                false,
                'UTC',
                TIME '10:00:00',
                date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,
                1
            FROM platform.projects AS projects
            WHERE NOT EXISTS (
                SELECT 1
                FROM public.content_plan_settings AS settings
                WHERE settings.project_id = projects.id
            )
            """
        )
    )


def downgrade() -> None:
    # The backfilled rows may have been edited after upgrade and cannot be
    # distinguished safely from user-created settings.
    pass
