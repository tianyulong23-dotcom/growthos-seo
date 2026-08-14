"""Add durable project Agent timeline events.

Revision ID: 20260812_0058
Revises: 20260812_0057
Create Date: 2026-08-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260812_0058"
down_revision: str | Sequence[str] | None = "20260812_0057"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_timeline_events",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("organization_id", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("conversation_id", sa.Text()),
        sa.Column("event_key", sa.Text(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("content", sa.Text()),
        sa.Column(
            "action_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "metadata_json",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
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
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["conversation_id"], ["agent_conversations.id"], ondelete="CASCADE"
        ),
        sa.CheckConstraint(
            "kind IN ('message','task','action')",
            name="ck_agent_timeline_events_kind",
        ),
        sa.CheckConstraint(
            "status IN ('running','completed','failed','cancelled')",
            name="ck_agent_timeline_events_status",
        ),
        sa.CheckConstraint(
            "sequence > 0",
            name="ck_agent_timeline_events_sequence",
        ),
        sa.CheckConstraint(
            "char_length(event_key) BETWEEN 1 AND 200",
            name="ck_agent_timeline_events_event_key",
        ),
        sa.CheckConstraint(
            "char_length(title) BETWEEN 1 AND 500",
            name="ck_agent_timeline_events_title",
        ),
        sa.CheckConstraint(
            "content IS NULL OR char_length(content) <= 20000",
            name="ck_agent_timeline_events_content",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "organization_id",
            "project_id",
            "event_key",
            name="uq_agent_timeline_events_project_key",
        ),
        sa.UniqueConstraint(
            "organization_id",
            "project_id",
            "sequence",
            name="uq_agent_timeline_events_project_sequence",
        ),
    )
    op.create_index(
        "ix_agent_timeline_events_project_sequence",
        "agent_timeline_events",
        ["organization_id", "project_id", "sequence"],
    )
    op.create_index(
        "ix_agent_timeline_events_conversation",
        "agent_timeline_events",
        ["conversation_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_agent_timeline_events_conversation",
        table_name="agent_timeline_events",
    )
    op.drop_index(
        "ix_agent_timeline_events_project_sequence",
        table_name="agent_timeline_events",
    )
    op.drop_table("agent_timeline_events")
