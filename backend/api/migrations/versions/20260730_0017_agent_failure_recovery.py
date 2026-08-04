"""Persist Agent dispatch retries and align model retry policy.

Revision ID: 20260730_0017
Revises: 20260729_0016
Create Date: 2026-07-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260730_0017"
down_revision: str | Sequence[str] | None = "20260729_0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_ai_provider_settings_max_retries",
        "ai_provider_settings",
        type_="check",
    )
    op.alter_column(
        "ai_provider_settings",
        "max_retries",
        server_default=sa.text("4"),
    )
    op.create_check_constraint(
        "ck_ai_provider_settings_max_retries",
        "ai_provider_settings",
        "max_retries BETWEEN 0 AND 4",
    )

    op.create_table(
        "agent_workflow_dispatches",
        sa.Column("run_id", sa.Text(), nullable=False),
        sa.Column("workflow_id", sa.Text(), nullable=False),
        sa.Column(
            "task_payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column(
            "attempts",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["run_id"], ["agent_runs.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("run_id"),
        sa.UniqueConstraint("workflow_id"),
    )
    op.create_index(
        "ix_agent_workflow_dispatches_pending",
        "agent_workflow_dispatches",
        ["status", "next_attempt_at"],
        unique=False,
    )
    op.execute(
        """
        INSERT INTO agent_workflow_dispatches (
            run_id,
            workflow_id,
            task_payload,
            status,
            attempts,
            next_attempt_at
        )
        SELECT
            id,
            workflow_id,
            jsonb_build_object('run_id', id, 'limits', limits_json),
            'pending',
            0,
            now()
        FROM agent_runs
        WHERE status = 'queued'
        ON CONFLICT (run_id) DO NOTHING
        """
    )


def downgrade() -> None:
    op.drop_index(
        "ix_agent_workflow_dispatches_pending",
        table_name="agent_workflow_dispatches",
    )
    op.drop_table("agent_workflow_dispatches")

    op.drop_constraint(
        "ck_ai_provider_settings_max_retries",
        "ai_provider_settings",
        type_="check",
    )
    op.execute(
        "UPDATE ai_provider_settings SET max_retries = 2 WHERE max_retries > 2"
    )
    op.alter_column(
        "ai_provider_settings",
        "max_retries",
        server_default=sa.text("1"),
    )
    op.create_check_constraint(
        "ck_ai_provider_settings_max_retries",
        "ai_provider_settings",
        "max_retries BETWEEN 0 AND 2",
    )
