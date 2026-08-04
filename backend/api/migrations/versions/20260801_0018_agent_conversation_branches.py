"""Keep Agent conversation edits as append-only branches.

Revision ID: 20260801_0018
Revises: 20260730_0017
Create Date: 2026-08-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260801_0018"
down_revision: str | Sequence[str] | None = "20260730_0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "agent_messages",
        sa.Column("parent_message_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "agent_conversations",
        sa.Column("active_message_id", sa.Text(), nullable=True),
    )

    op.execute(
        """
        WITH ordered AS (
            SELECT
                id,
                lag(id) OVER (
                    PARTITION BY conversation_id
                    ORDER BY created_at, id
                ) AS parent_id
            FROM agent_messages
        )
        UPDATE agent_messages AS message
        SET parent_message_id = ordered.parent_id
        FROM ordered
        WHERE message.id = ordered.id
        """
    )
    op.execute(
        """
        UPDATE agent_conversations AS conversation
        SET active_message_id = (
            SELECT message.id
            FROM agent_messages AS message
            WHERE message.conversation_id = conversation.id
            ORDER BY message.created_at DESC, message.id DESC
            LIMIT 1
        )
        WHERE EXISTS (
            SELECT 1
            FROM agent_messages AS message
            WHERE message.conversation_id = conversation.id
        )
        """
    )

    op.create_foreign_key(
        "fk_agent_messages_parent_message_id",
        "agent_messages",
        "agent_messages",
        ["parent_message_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_agent_conversations_active_message_id",
        "agent_conversations",
        "agent_messages",
        ["active_message_id"],
        ["id"],
        ondelete="SET NULL",
        use_alter=True,
    )
    op.create_index(
        "ix_agent_messages_parent_message_id",
        "agent_messages",
        ["parent_message_id"],
        unique=False,
    )

    op.create_table(
        "agent_conversation_events",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("conversation_id", sa.Text(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("target_message_id", sa.Text(), nullable=True),
        sa.Column("previous_leaf_id", sa.Text(), nullable=True),
        sa.Column("new_leaf_id", sa.Text(), nullable=True),
        sa.Column("client_request_id", sa.Text(), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["conversation_id"], ["agent_conversations.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["target_message_id"], ["agent_messages.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["previous_leaf_id"], ["agent_messages.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["new_leaf_id"], ["agent_messages.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "conversation_id",
            "client_request_id",
            name="uq_agent_conversation_events_client_request",
        ),
    )
    op.create_index(
        "ix_agent_conversation_events_conversation_created",
        "agent_conversation_events",
        ["conversation_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_agent_conversation_events_conversation_created",
        table_name="agent_conversation_events",
    )
    op.drop_table("agent_conversation_events")
    op.drop_index("ix_agent_messages_parent_message_id", table_name="agent_messages")
    op.drop_constraint(
        "fk_agent_conversations_active_message_id",
        "agent_conversations",
        type_="foreignkey",
    )
    op.drop_constraint(
        "fk_agent_messages_parent_message_id",
        "agent_messages",
        type_="foreignkey",
    )
    op.drop_column("agent_conversations", "active_message_id")
    op.drop_column("agent_messages", "parent_message_id")
