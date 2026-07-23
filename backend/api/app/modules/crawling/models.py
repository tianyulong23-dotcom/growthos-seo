from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Identity, Index, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.db.base import Base


class CrawlRun(Base):
    __tablename__ = "crawl_runs"

    run_id: Mapped[str] = mapped_column(Text, primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    task_type: Mapped[str] = mapped_column(Text, nullable=False)
    target_url: Mapped[str | None] = mapped_column(Text)
    country: Mapped[str | None] = mapped_column(Text)
    language: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="running")
    stage: Mapped[str | None] = mapped_column(Text)
    message: Mapped[str | None] = mapped_column(Text)
    discovered: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    processed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    selected: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    page_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    backlink_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    result_ref: Mapped[str | None] = mapped_column(Text)
    config_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    summary: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    can_resume: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    resumed_from_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("crawl_runs.run_id", ondelete="SET NULL")
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    temporal_workflow_id: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
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


class Page(Base):
    __tablename__ = "pages"
    __table_args__ = (
        Index(
            "uq_pages_project_normalized_url",
            "organization_id",
            "project_id",
            "normalized_url",
            unique=True,
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    organization_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    normalized_url: Mapped[str] = mapped_column(Text, nullable=False)
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


class PageSnapshot(Base):
    __tablename__ = "page_snapshots"

    run_id: Mapped[str] = mapped_column(
        ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
        primary_key=True,
    )
    page_id: Mapped[int] = mapped_column(
        ForeignKey("pages.id", ondelete="CASCADE"),
        primary_key=True,
    )
    requested_url: Mapped[str] = mapped_column(Text, nullable=False)
    final_url: Mapped[str] = mapped_column(Text, nullable=False)
    status_code: Mapped[int] = mapped_column(Integer, nullable=False)
    content_type: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    canonical: Mapped[str | None] = mapped_column(Text)
    language: Mapped[str | None] = mapped_column(Text)
    h1: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    headings: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    open_graph: Mapped[dict[str, str]] = mapped_column(JSONB, nullable=False, default=dict)
    structured_data: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    h2: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    h3: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    meta_tags: Mapped[dict[str, str]] = mapped_column(JSONB, nullable=False, default=dict)
    twitter_tags: Mapped[dict[str, str]] = mapped_column(JSONB, nullable=False, default=dict)
    analytics: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    images: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    broken_images: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    hreflang: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    schema_org: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    redirects: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    linked_from: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    response_time_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    error_type: Mapped[str | None] = mapped_column(Text)
    charset: Mapped[str | None] = mapped_column(Text)
    viewport: Mapped[str | None] = mapped_column(Text)
    robots: Mapped[str | None] = mapped_column(Text)
    author: Mapped[str | None] = mapped_column(Text)
    keywords: Mapped[str | None] = mapped_column(Text)
    generator: Mapped[str | None] = mapped_column(Text)
    theme_color: Mapped[str | None] = mapped_column(Text)
    internal_links: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    external_links: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    word_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rendered: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    score: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    depth: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    discovered_from: Mapped[str | None] = mapped_column(Text)
    raw_html_ref: Mapped[str | None] = mapped_column(Text)
    main_html_ref: Mapped[str | None] = mapped_column(Text)
    main_text_ref: Mapped[str | None] = mapped_column(Text)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class LinkEdge(Base):
    __tablename__ = "link_edges"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source_page_id: Mapped[int] = mapped_column(
        ForeignKey("pages.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    target_url: Mapped[str] = mapped_column(Text, nullable=False)
    anchor_text: Mapped[str | None] = mapped_column(Text)
    rel: Mapped[str | None] = mapped_column(Text)
    in_navigation: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_internal: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    target_domain: Mapped[str | None] = mapped_column(Text)
    target_status: Mapped[int | None] = mapped_column(Integer)
    placement: Mapped[str] = mapped_column(Text, nullable=False, default="body")


class BacklinkCheck(Base):
    __tablename__ = "backlink_checks"

    run_id: Mapped[str] = mapped_column(
        ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
        primary_key=True,
    )
    url: Mapped[str] = mapped_column(Text, primary_key=True)
    final_url: Mapped[str | None] = mapped_column(Text)
    status_code: Mapped[int | None] = mapped_column(Integer)
    found_links: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    error: Mapped[str | None] = mapped_column(Text)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class AuditIssue(Base):
    __tablename__ = "audit_issues"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    page_id: Mapped[int | None] = mapped_column(
        ForeignKey("pages.id", ondelete="CASCADE"),
    )
    url: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(Text, nullable=False)
    code: Mapped[str] = mapped_column(Text, nullable=False)
    issue: Mapped[str] = mapped_column(Text, nullable=False)
    details: Mapped[str] = mapped_column(Text, nullable=False)
    related_url: Mapped[str | None] = mapped_column(Text)
    similarity: Mapped[float | None] = mapped_column(Float)
    detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class ExternalResource(Base):
    __tablename__ = "external_resources"
    __table_args__ = (
        Index(
            "uq_external_resources_run_url",
            "run_id",
            "url",
            unique=True,
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    url: Mapped[str] = mapped_column(Text, nullable=False)
    final_url: Mapped[str | None] = mapped_column(Text)
    status_code: Mapped[int | None] = mapped_column(Integer)
    content_type: Mapped[str | None] = mapped_column(Text)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    title: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    error_type: Mapped[str | None] = mapped_column(Text)
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class CrawlCheckpoint(Base):
    __tablename__ = "crawl_checkpoints"

    run_id: Mapped[str] = mapped_column(
        ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
        primary_key=True,
    )
    checkpoint: Mapped[dict] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class PageSpeedResult(Base):
    __tablename__ = "pagespeed_results"
    __table_args__ = (
        Index(
            "uq_pagespeed_run_url_strategy",
            "run_id",
            "url",
            "strategy",
            unique=True,
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("crawl_runs.run_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    url: Mapped[str] = mapped_column(Text, nullable=False)
    strategy: Mapped[str] = mapped_column(Text, nullable=False)
    performance_score: Mapped[int | None] = mapped_column(Integer)
    accessibility_score: Mapped[int | None] = mapped_column(Integer)
    best_practices_score: Mapped[int | None] = mapped_column(Integer)
    seo_score: Mapped[int | None] = mapped_column(Integer)
    metrics: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    analyzed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
