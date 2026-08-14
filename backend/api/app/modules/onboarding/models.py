from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class OnboardingRun(Base):
    __tablename__ = "onboarding_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('running','waiting_for_confirmation','completed')",
            name="ck_onboarding_runs_status",
        ),
        UniqueConstraint("project_id", name="uq_onboarding_runs_project"),
        Index(
            "ix_onboarding_runs_active",
            "status",
            "updated_at",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    agent_conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("agent_conversations.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, default="running")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    business_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class OnboardingStep(Base):
    __tablename__ = "onboarding_steps"
    __table_args__ = (
        CheckConstraint(
            "status IN ('blocked','ready','running','completed','failed','skipped')",
            name="ck_onboarding_steps_status",
        ),
        CheckConstraint("attempts >= 0", name="ck_onboarding_steps_attempts"),
        UniqueConstraint("run_id", "step_key", name="uq_onboarding_steps_run_key"),
        Index("ix_onboarding_steps_run_position", "run_id", "position"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("onboarding_runs.id", ondelete="CASCADE"), nullable=False
    )
    step_key: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    external_run_id: Mapped[str | None] = mapped_column(Text)
    last_error_code: Mapped[str | None] = mapped_column(Text)
    last_error_message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
