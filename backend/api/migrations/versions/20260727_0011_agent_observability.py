"""Complete Agent runtime observability and actor records.

Revision ID: 20260727_0011
Revises: 20260727_0010
Create Date: 2026-07-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260727_0011"
down_revision: str | Sequence[str] | None = "20260727_0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_conversations",
        sa.Column("created_by", sa.Text(), nullable=False, server_default="local-user"),
    )
    op.add_column("agent_run_steps", sa.Column("error_code", sa.Text()))
    op.add_column("agent_run_steps", sa.Column("error_message", sa.Text()))
    op.add_column("agent_run_steps", sa.Column("input_tokens", sa.Integer()))
    op.add_column("agent_run_steps", sa.Column("output_tokens", sa.Integer()))
    op.add_column("agent_run_steps", sa.Column("total_tokens", sa.Integer()))
    op.add_column("agent_run_steps", sa.Column("cost", sa.Numeric(18, 8)))
    op.add_column("agent_run_steps", sa.Column("cost_currency", sa.Text()))
    op.add_column("agent_run_steps", sa.Column("finished_at", sa.DateTime(timezone=True)))
    op.add_column("agent_actions", sa.Column("decided_by", sa.Text()))


def downgrade() -> None:
    op.drop_column("agent_actions", "decided_by")
    op.drop_column("agent_run_steps", "finished_at")
    op.drop_column("agent_run_steps", "cost_currency")
    op.drop_column("agent_run_steps", "cost")
    op.drop_column("agent_run_steps", "total_tokens")
    op.drop_column("agent_run_steps", "output_tokens")
    op.drop_column("agent_run_steps", "input_tokens")
    op.drop_column("agent_run_steps", "error_message")
    op.drop_column("agent_run_steps", "error_code")
    op.drop_column("agent_conversations", "created_by")
