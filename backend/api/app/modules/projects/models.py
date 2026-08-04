from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func, text

from app.db.base import Base


class Project(Base):
    __tablename__ = "projects"
    __table_args__ = (
        UniqueConstraint(
            "organization_id",
            "domain",
            name="uq_projects_organization_domain",
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    domain: Mapped[str] = mapped_column(Text, nullable=False)
    country: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(Text, nullable=False)
    competitor_domain: Mapped[str | None] = mapped_column(Text)
    health: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    initial_crawl_run_id: Mapped[str | None] = mapped_column(Text)
    understanding_run_id: Mapped[str | None] = mapped_column(Text)
    audit_run_id: Mapped[str | None] = mapped_column(Text)
    audit_health: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class SiteProfile(Base):
    __tablename__ = "site_profiles"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
    )
    source_run_id: Mapped[str] = mapped_column(
        ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    profile_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    user_overrides: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class SiteProfileVersion(Base):
    __tablename__ = "site_profile_versions"

    source_run_id: Mapped[str] = mapped_column(
        ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
        primary_key=True,
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    profile_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class WorkflowDispatch(Base):
    __tablename__ = "workflow_dispatches"
    __table_args__ = (
        Index(
            "ix_workflow_dispatches_pending",
            "status",
            "next_attempt_at",
        ),
    )

    run_id: Mapped[str] = mapped_column(
        ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
        primary_key=True,
    )
    workflow_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    task_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="pending",
        server_default="pending",
    )
    attempts: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
    )
    last_error: Mapped[str | None] = mapped_column(Text)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
