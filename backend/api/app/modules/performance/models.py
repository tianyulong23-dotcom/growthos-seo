from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func
from sqlalchemy.sql import text

from app.db.base import Base


class PerformanceSyncRun(Base):
    __tablename__ = "performance_sync_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('running','completed','failed')",
            name="ck_performance_sync_runs_status",
        ),
        Index(
            "ix_performance_sync_runs_project_started",
            "project_id",
            "started_at",
        ),
        Index(
            "uq_performance_sync_runs_running_project",
            "organization_id",
            "project_id",
            unique=True,
            postgresql_where=text("status = 'running'"),
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(Text, nullable=False)
    data_through: Mapped[date | None] = mapped_column(Date)
    target_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ArticlePerformanceTarget(Base):
    __tablename__ = "article_performance_targets"
    __table_args__ = (
        UniqueConstraint("project_id", "normalized_url", name="uq_article_performance_target_url"),
        Index("ix_article_performance_targets_project", "project_id"),
    )

    article_id: Mapped[str] = mapped_column(
        ForeignKey("articles.id", ondelete="CASCADE"), primary_key=True
    )
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    publication_id: Mapped[str] = mapped_column(
        ForeignKey("article_publications.id", ondelete="CASCADE"), nullable=False
    )
    url: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_url: Mapped[str] = mapped_column(Text, nullable=False)
    aliases_json: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    publication_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class GSCSiteDaily(Base):
    __tablename__ = "gsc_site_daily"

    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    date: Mapped[date] = mapped_column(Date, primary_key=True)
    clicks: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    impressions: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    position: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ArticleGSCDaily(Base):
    __tablename__ = "article_gsc_daily"
    __table_args__ = (Index("ix_article_gsc_daily_date", "project_id", "date"),)

    article_id: Mapped[str] = mapped_column(
        ForeignKey("article_performance_targets.article_id", ondelete="CASCADE"),
        primary_key=True,
    )
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    date: Mapped[date] = mapped_column(Date, primary_key=True)
    clicks: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    impressions: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    position: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class PerformanceSignal(Base):
    __tablename__ = "performance_signals"
    __table_args__ = (
        CheckConstraint("status IN ('open','resolved')", name="ck_performance_signals_status"),
        Index(
            "uq_performance_signals_open",
            "article_id",
            "kind",
            unique=True,
            postgresql_where=text("status = 'open'"),
        ),
        Index("ix_performance_signals_project_status", "project_id", "status"),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    article_id: Mapped[str] = mapped_column(
        ForeignKey("article_performance_targets.article_id", ondelete="CASCADE"),
        nullable=False,
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")
    message: Mapped[str] = mapped_column(Text, nullable=False)
    detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
