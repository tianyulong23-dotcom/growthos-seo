from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class AgentConversation(Base):
    __tablename__ = "agent_conversations"
    __table_args__ = (
        Index(
            "ix_agent_conversations_project_updated",
            "organization_id",
            "project_id",
            text("updated_at DESC"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    created_by: Mapped[str] = mapped_column(Text, nullable=False, default="local-user")
    title: Mapped[str] = mapped_column(Text, nullable=False, default="新对话")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    active_message_id: Mapped[str | None] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="SET NULL", use_alter=True)
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AgentMessage(Base):
    __tablename__ = "agent_messages"
    __table_args__ = (
        UniqueConstraint(
            "conversation_id", "client_request_id", name="uq_agent_messages_client_request"
        ),
        Index("ix_agent_messages_conversation_created", "conversation_id", "created_at"),
        Index("ix_agent_messages_parent_message_id", "parent_message_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("agent_conversations.id", ondelete="CASCADE"), nullable=False
    )
    parent_message_id: Mapped[str | None] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="SET NULL")
    )
    run_id: Mapped[str | None] = mapped_column(Text)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    client_request_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AgentConversationEvent(Base):
    __tablename__ = "agent_conversation_events"
    __table_args__ = (
        UniqueConstraint(
            "conversation_id",
            "client_request_id",
            name="uq_agent_conversation_events_client_request",
        ),
        Index(
            "ix_agent_conversation_events_conversation_created",
            "conversation_id",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("agent_conversations.id", ondelete="CASCADE"), nullable=False
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    target_message_id: Mapped[str | None] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="SET NULL")
    )
    previous_leaf_id: Mapped[str | None] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="SET NULL")
    )
    new_leaf_id: Mapped[str | None] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="SET NULL")
    )
    client_request_id: Mapped[str | None] = mapped_column(Text)
    metadata_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AgentTimelineEvent(Base):
    __tablename__ = "agent_timeline_events"
    __table_args__ = (
        CheckConstraint(
            "kind IN ('message','task','action')",
            name="ck_agent_timeline_events_kind",
        ),
        CheckConstraint(
            "status IN ('running','waiting','completed','failed','cancelled')",
            name="ck_agent_timeline_events_status",
        ),
        CheckConstraint(
            "sequence > 0",
            name="ck_agent_timeline_events_sequence",
        ),
        CheckConstraint(
            "char_length(event_key) BETWEEN 1 AND 200",
            name="ck_agent_timeline_events_event_key",
        ),
        CheckConstraint(
            "char_length(title) BETWEEN 1 AND 500",
            name="ck_agent_timeline_events_title",
        ),
        CheckConstraint(
            "content IS NULL OR char_length(content) <= 20000",
            name="ck_agent_timeline_events_content",
        ),
        UniqueConstraint(
            "organization_id",
            "project_id",
            "event_key",
            name="uq_agent_timeline_events_project_key",
        ),
        UniqueConstraint(
            "organization_id",
            "project_id",
            "sequence",
            name="uq_agent_timeline_events_project_sequence",
        ),
        Index(
            "ix_agent_timeline_events_project_sequence",
            "organization_id",
            "project_id",
            "sequence",
        ),
        Index("ix_agent_timeline_events_conversation", "conversation_id"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("agent_conversations.id", ondelete="CASCADE")
    )
    event_key: Mapped[str] = mapped_column(Text, nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str | None] = mapped_column(Text)
    action_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    metadata_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AgentSystemTrigger(Base):
    __tablename__ = "agent_system_triggers"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','dispatched')",
            name="ck_agent_system_triggers_status",
        ),
        UniqueConstraint(
            "organization_id",
            "project_id",
            "trigger",
            "trigger_version",
            name="uq_agent_system_triggers_identity",
        ),
        Index(
            "ix_agent_system_triggers_pending",
            "status",
            "created_at",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    trigger: Mapped[str] = mapped_column(Text, nullable=False)
    trigger_version: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    trusted_write_tools_json: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list
    )
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="pending", server_default="pending"
    )
    message_id: Mapped[str | None] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="SET NULL")
    )
    run_id: Mapped[str | None] = mapped_column(
        ForeignKey("agent_runs.id", ondelete="SET NULL")
    )
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AgentRun(Base):
    __tablename__ = "agent_runs"
    __table_args__ = (
        Index(
            "uq_agent_runs_active_conversation",
            "conversation_id",
            unique=True,
            postgresql_where=text(
                "status IN ('queued','running','executing','verifying')"
            ),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("agent_conversations.id", ondelete="CASCADE"), nullable=False
    )
    user_message_id: Mapped[str] = mapped_column(
        ForeignKey("agent_messages.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    workflow_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="queued")
    current_step: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    model_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    limits_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    tool_context_summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    tool_context_through_round: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_code: Mapped[str | None] = mapped_column(Text)
    error_message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AgentWorkflowDispatch(Base):
    __tablename__ = "agent_workflow_dispatches"
    __table_args__ = (
        Index(
            "ix_agent_workflow_dispatches_pending",
            "status",
            "next_attempt_at",
        ),
    )

    run_id: Mapped[str] = mapped_column(
        ForeignKey("agent_runs.id", ondelete="CASCADE"), primary_key=True
    )
    workflow_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    task_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="pending", server_default="pending"
    )
    attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    last_error: Mapped[str | None] = mapped_column(Text)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AgentRunStep(Base):
    __tablename__ = "agent_run_steps"
    __table_args__ = (UniqueConstraint("run_id", "sequence", name="uq_agent_steps_sequence"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    step_type: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    input_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    output_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(Text)
    error_message: Mapped[str | None] = mapped_column(Text)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    total_tokens: Mapped[int | None] = mapped_column(Integer)
    cost: Mapped[float | None] = mapped_column(Numeric(18, 8))
    cost_currency: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AgentAction(Base):
    __tablename__ = "agent_actions"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    tool_name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    arguments_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    before_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    preview_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    parameters_hash: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    decided_by: Mapped[str | None] = mapped_column(Text)
    decision_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    result_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AgentToolExecution(Base):
    __tablename__ = "agent_tool_executions"
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uq_agent_tool_execution_idempotency"),
        Index("ix_agent_tool_executions_run_created", "run_id", "created_at"),
        Index(
            "ix_agent_tool_executions_run_round_call",
            "run_id",
            "round_number",
            "call_number",
            unique=True,
        ),
    )

    tool_call_id: Mapped[str] = mapped_column(Text, primary_key=True)
    model_tool_call_id: Mapped[str] = mapped_column(Text, nullable=False)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False
    )
    round_number: Mapped[int] = mapped_column(Integer, nullable=False)
    call_number: Mapped[int] = mapped_column(Integer, nullable=False)
    tool_name: Mapped[str] = mapped_column(Text, nullable=False)
    idempotency_key: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="claimed")
    arguments_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    before_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    parameters_hash: Mapped[str] = mapped_column(Text, nullable=False)
    worker_id: Mapped[str | None] = mapped_column(Text)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    model_result_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    error_code: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AgentProjectMemory(Base):
    __tablename__ = "agent_project_memories"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    organization_id: Mapped[str] = mapped_column(Text, nullable=False)
    facts_json: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class AgentResearchRecord(Base):
    __tablename__ = "agent_research_records"
    __table_args__ = (
        UniqueConstraint("run_id", name="uq_agent_research_record_run"),
        Index("ix_agent_research_project_created", "project_id", text("created_at DESC")),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    run_id: Mapped[str] = mapped_column(
        ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False
    )
    topic: Mapped[str] = mapped_column(Text, nullable=False)
    input_scope_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    conclusion: Mapped[str] = mapped_column(Text, nullable=False)
    tools_json: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class AgentConversationSummary(Base):
    __tablename__ = "agent_conversation_summaries"

    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("agent_conversations.id", ondelete="CASCADE"), primary_key=True
    )
    through_message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
