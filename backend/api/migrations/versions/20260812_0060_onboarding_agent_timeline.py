"""Connect onboarding runs to Agent timeline conversations.

Revision ID: 20260812_0060
Revises: 20260812_0059
Create Date: 2026-08-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260812_0060"
down_revision: str | Sequence[str] | None = "20260812_0059"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "onboarding_runs",
        sa.Column("agent_conversation_id", sa.Text()),
    )
    op.create_foreign_key(
        "fk_onboarding_runs_agent_conversation_id",
        "onboarding_runs",
        "agent_conversations",
        ["agent_conversation_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_onboarding_runs_agent_conversation_id",
        "onboarding_runs",
        ["agent_conversation_id"],
    )
    op.execute(
        "ALTER TABLE agent_timeline_events "
        "DROP CONSTRAINT IF EXISTS ck_agent_timeline_events_status"
    )
    op.create_check_constraint(
        "ck_agent_timeline_events_status",
        "agent_timeline_events",
        "status IN ('running','waiting','completed','failed','cancelled')",
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE agent_timeline_events "
        "DROP CONSTRAINT IF EXISTS ck_agent_timeline_events_status"
    )
    op.create_check_constraint(
        "ck_agent_timeline_events_status",
        "agent_timeline_events",
        "status IN ('running','completed','failed','cancelled')",
    )
    op.drop_index(
        "ix_onboarding_runs_agent_conversation_id",
        table_name="onboarding_runs",
    )
    op.drop_constraint(
        "fk_onboarding_runs_agent_conversation_id",
        "onboarding_runs",
        type_="foreignkey",
    )
    op.drop_column("onboarding_runs", "agent_conversation_id")
