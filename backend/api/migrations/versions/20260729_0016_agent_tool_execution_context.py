"""Persist Agent tool calls outside Temporal history.

Revision ID: 20260729_0016
Revises: 20260728_0015
Create Date: 2026-07-29
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260729_0016"
down_revision: str | Sequence[str] | None = "20260728_0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_runs",
        sa.Column(
            "tool_context_summary", sa.Text(), nullable=False,
            server_default=sa.text("''"),
        ),
    )
    op.add_column(
        "agent_runs",
        sa.Column(
            "tool_context_through_round", sa.Integer(), nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column(
        "agent_tool_executions",
        sa.Column("model_tool_call_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "agent_tool_executions",
        sa.Column("round_number", sa.Integer(), nullable=True),
    )
    op.add_column(
        "agent_tool_executions",
        sa.Column("call_number", sa.Integer(), nullable=True),
    )
    op.add_column(
        "agent_tool_executions",
        sa.Column(
            "model_result_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
    )
    op.execute(
        """
        WITH numbered AS (
            SELECT tool_call_id,
                   row_number() OVER (
                       PARTITION BY run_id ORDER BY created_at, tool_call_id
                   ) AS legacy_call_number
            FROM agent_tool_executions
            WHERE model_tool_call_id IS NULL
        )
        UPDATE agent_tool_executions AS execution
        SET model_tool_call_id = execution.tool_call_id,
            round_number = 0,
            call_number = numbered.legacy_call_number
        FROM numbered
        WHERE execution.tool_call_id = numbered.tool_call_id
        """
    )
    op.alter_column("agent_tool_executions", "model_tool_call_id", nullable=False)
    op.alter_column("agent_tool_executions", "round_number", nullable=False)
    op.alter_column("agent_tool_executions", "call_number", nullable=False)
    op.create_index(
        "ix_agent_tool_executions_run_round_call",
        "agent_tool_executions",
        ["run_id", "round_number", "call_number"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_agent_tool_executions_run_round_call",
        table_name="agent_tool_executions",
    )
    op.drop_column("agent_tool_executions", "model_result_json")
    op.drop_column("agent_tool_executions", "call_number")
    op.drop_column("agent_tool_executions", "round_number")
    op.drop_column("agent_tool_executions", "model_tool_call_id")
    op.drop_column("agent_runs", "tool_context_through_round")
    op.drop_column("agent_runs", "tool_context_summary")
