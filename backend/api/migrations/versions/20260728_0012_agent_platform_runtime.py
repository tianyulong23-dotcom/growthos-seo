"""Add direct Agent execution, project memory, and recovery state.

Revision ID: 20260728_0012
Revises: 20260727_0011
Create Date: 2026-07-28
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260728_0012"
down_revision: str | Sequence[str] | None = "20260727_0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.drop_index("uq_agent_runs_active_conversation", table_name="agent_runs")
    op.create_index(
        "uq_agent_runs_active_conversation",
        "agent_runs",
        ["conversation_id"],
        unique=True,
        postgresql_where=sa.text("status IN ('queued','running','executing','verifying')"),
    )
    op.create_table(
        "agent_tool_executions",
        sa.Column("tool_call_id", sa.Text(), primary_key=True),
        sa.Column("run_id", sa.Text(), sa.ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tool_name", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="claimed"),
        sa.Column("arguments_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("before_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("parameters_hash", sa.Text(), nullable=False),
        sa.Column("worker_id", sa.Text()),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
        sa.Column("result_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("error_code", sa.Text()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("idempotency_key", name="uq_agent_tool_execution_idempotency"),
    )
    op.create_index(
        "ix_agent_tool_executions_run_created",
        "agent_tool_executions",
        ["run_id", "created_at"],
    )
    op.create_table(
        "agent_project_memories",
        sa.Column("project_id", sa.Text(), sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("facts_json", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_table(
        "agent_research_records",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("project_id", sa.Text(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("run_id", sa.Text(), sa.ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("topic", sa.Text(), nullable=False),
        sa.Column("input_scope_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("conclusion", sa.Text(), nullable=False),
        sa.Column("tools_json", jsonb, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("run_id", name="uq_agent_research_record_run"),
    )
    op.create_index(
        "ix_agent_research_project_created",
        "agent_research_records",
        ["project_id", sa.text("created_at DESC")],
    )
    op.create_table(
        "agent_conversation_summaries",
        sa.Column("conversation_id", sa.Text(), sa.ForeignKey("agent_conversations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("through_message_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("agent_conversation_summaries")
    op.drop_index("ix_agent_research_project_created", table_name="agent_research_records")
    op.drop_table("agent_research_records")
    op.drop_table("agent_project_memories")
    op.drop_index("ix_agent_tool_executions_run_created", table_name="agent_tool_executions")
    op.drop_table("agent_tool_executions")
    op.drop_index("uq_agent_runs_active_conversation", table_name="agent_runs")
    op.create_index(
        "uq_agent_runs_active_conversation",
        "agent_runs",
        ["conversation_id"],
        unique=True,
        postgresql_where=sa.text(
            "status IN ('queued','running','waiting_approval','executing','verifying')"
        ),
    )
