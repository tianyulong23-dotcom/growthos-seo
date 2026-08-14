"""Add durable trusted Agent system triggers.

Revision ID: 20260813_0061
Revises: 20260812_0060
Create Date: 2026-08-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260813_0061"
down_revision: str | Sequence[str] | None = "20260812_0060"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_system_triggers",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("trigger", sa.Text(), nullable=False),
        sa.Column("trigger_version", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column(
            "trusted_write_tools_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "status", sa.Text(), nullable=False, server_default="pending"
        ),
        sa.Column("message_id", sa.Text()),
        sa.Column("run_id", sa.Text()),
        sa.Column("dispatched_at", sa.DateTime(timezone=True)),
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
        sa.CheckConstraint(
            "status IN ('pending','dispatched')",
            name="ck_agent_system_triggers_status",
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["message_id"], ["agent_messages.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["agent_runs.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "organization_id",
            "project_id",
            "trigger",
            "trigger_version",
            name="uq_agent_system_triggers_identity",
        ),
    )
    op.create_index(
        "ix_agent_system_triggers_pending",
        "agent_system_triggers",
        ["status", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_agent_system_triggers_pending",
        table_name="agent_system_triggers",
    )
    op.drop_table("agent_system_triggers")
