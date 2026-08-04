"""Add durable Agent runtime tables.

Revision ID: 20260727_0010
Revises: 20260724_0009
Create Date: 2026-07-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260727_0010"
down_revision: str | Sequence[str] | None = "20260724_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    jsonb = postgresql.JSONB(astext_type=sa.Text())
    op.create_table(
        "agent_conversations",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.Text(), nullable=False, server_default="新对话"),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_agent_conversations_project_updated", "agent_conversations", ["organization_id", "project_id", sa.text("updated_at DESC")])
    op.create_table(
        "agent_messages",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("conversation_id", sa.Text(), sa.ForeignKey("agent_conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("run_id", sa.Text()),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("metadata_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("client_request_id", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("conversation_id", "client_request_id", name="uq_agent_messages_client_request"),
    )
    op.create_index("ix_agent_messages_conversation_created", "agent_messages", ["conversation_id", "created_at"])
    op.create_table(
        "agent_runs",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("conversation_id", sa.Text(), sa.ForeignKey("agent_conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_message_id", sa.Text(), sa.ForeignKey("agent_messages.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("workflow_id", sa.Text(), nullable=False, unique=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("current_step", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("model_snapshot", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("limits_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("error_code", sa.Text()), sa.Column("error_message", sa.Text()),
        sa.Column("started_at", sa.DateTime(timezone=True)), sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("uq_agent_runs_active_conversation", "agent_runs", ["conversation_id"], unique=True, postgresql_where=sa.text("status IN ('queued','running','waiting_approval','executing','verifying')"))
    op.create_table(
        "agent_run_steps",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("run_id", sa.Text(), sa.ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False), sa.Column("step_type", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False), sa.Column("input_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("output_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")), sa.Column("status", sa.Text(), nullable=False),
        sa.Column("duration_ms", sa.Integer()), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("run_id", "sequence", name="uq_agent_steps_sequence"),
    )
    op.create_index("ix_agent_run_steps_run_id", "agent_run_steps", ["run_id"])
    op.create_table(
        "agent_actions",
        sa.Column("id", sa.Text(), primary_key=True), sa.Column("run_id", sa.Text(), sa.ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("tool_name", sa.Text(), nullable=False), sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("arguments_json", jsonb, nullable=False), sa.Column("before_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("preview_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")), sa.Column("parameters_hash", sa.Text(), nullable=False),
        sa.Column("idempotency_key", sa.Text(), nullable=False, unique=True), sa.Column("decision_at", sa.DateTime(timezone=True)),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False), sa.Column("result_json", jsonb, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("agent_actions")
    op.drop_index("ix_agent_run_steps_run_id", table_name="agent_run_steps")
    op.drop_table("agent_run_steps")
    op.drop_index("uq_agent_runs_active_conversation", table_name="agent_runs")
    op.drop_table("agent_runs")
    op.drop_index("ix_agent_messages_conversation_created", table_name="agent_messages")
    op.drop_table("agent_messages")
    op.drop_index("ix_agent_conversations_project_updated", table_name="agent_conversations")
    op.drop_table("agent_conversations")
