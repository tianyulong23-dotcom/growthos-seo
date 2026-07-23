import asyncio
import csv
import hashlib
import io
import json
import logging
import os
import re
import tempfile
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from types import SimpleNamespace
from typing import Any, Protocol
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4
from xml.etree.ElementTree import Element, SubElement, tostring

from openpyxl import Workbook
from sqlalchemy import and_, case, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from temporalio.client import Client, WorkflowExecutionStatus
from temporalio.service import RPCError, RPCStatusCode

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.workflows.worker import WorkerLauncher, get_crawler_worker_launcher
from app.modules.audit.models import (
    AuditActivityCollection,
    AuditActivityItem,
    AuditExternalResourceCollection,
    AuditExternalResourceResponse,
    AuditExportDataset,
    AuditExportFormat,
    AuditIssueCollection,
    AuditIssueResponse,
    AuditLinkCollection,
    AuditLinkResponse,
    AuditPageCollection,
    AuditPageResponse,
    AuditPageSpeedCollection,
    AuditPageSpeedResultResponse,
    AuditPageSpeedState,
    AuditRunCollection,
    AuditRunResponse,
    AuditStatusCodeCollection,
    AuditStatusCodeResponse,
    AuditSummary,
    AuditVisualizationEdge,
    AuditVisualizationNode,
    AuditVisualizationResponse,
    CreateAuditRunRequest,
    RecalculateAuditIssuesRequest,
)
from app.modules.audit.object_storage import (
    AuditObjectCleaner,
    NoopAuditObjectCleaner,
    S3AuditObjectCleaner,
)
from app.modules.crawling.models import (
    AuditIssue,
    CrawlCheckpoint,
    CrawlRun,
    ExternalResource,
    LinkEdge,
    Page,
    PageSnapshot,
    PageSpeedResult,
)
from app.modules.projects.models import Project
from app.workflows.client import connect_temporal

logger = logging.getLogger(__name__)

SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9._-]+$")
EXPORT_BATCH_SIZE = 1000
VISUALIZATION_NODE_LIMIT = 500
VISUALIZATION_EDGE_LIMIT = 5000
ACTIVE_AUDIT_STATUSES = {"queued", "running", "stopping", "recalculating"}
RESUMABLE_AUDIT_STATUSES = {"paused", "stopped", "failed"}


class AuditRunNotFoundError(Exception):
    pass


class AuditProjectNotFoundError(Exception):
    pass


class AuditLaunchError(Exception):
    pass


class AuditStateError(Exception):
    pass


class WorkflowState(StrEnum):
    RUNNING = "running"
    CLOSED = "closed"
    NOT_FOUND = "not_found"


class WorkflowController(Protocol):
    async def start(self, task: dict[str, Any], workflow_id: str) -> None: ...

    async def start_recalculation(
        self,
        task: dict[str, Any],
        workflow_id: str,
    ) -> None: ...

    async def cancel(self, workflow_id: str) -> None: ...

    async def signal(self, workflow_id: str, signal_name: str) -> None: ...

    async def signal_and_wait(
        self,
        workflow_id: str,
        signal_name: str,
        timeout_seconds: float,
    ) -> None: ...

    async def status(self, workflow_id: str) -> WorkflowState: ...


class TemporalWorkflowController:
    def __init__(
        self,
        task_queue: str,
        worker_launcher: WorkerLauncher | None = None,
    ) -> None:
        self.task_queue = task_queue
        self.worker_launcher = worker_launcher

    async def _client(self) -> Client:
        return await connect_temporal()

    async def start(self, task: dict[str, Any], workflow_id: str) -> None:
        if self.worker_launcher is not None:
            await self.worker_launcher.ensure_started()
        client = await self._client()
        await client.start_workflow(
            "CrawlWorkflow",
            task,
            id=workflow_id,
            task_queue=self.task_queue,
        )

    async def start_recalculation(
        self,
        task: dict[str, Any],
        workflow_id: str,
    ) -> None:
        if self.worker_launcher is not None:
            await self.worker_launcher.ensure_started()
        client = await self._client()
        await client.start_workflow(
            "RecalculateIssuesWorkflow",
            task,
            id=workflow_id,
            task_queue=self.task_queue,
        )

    async def cancel(self, workflow_id: str) -> None:
        client = await self._client()
        await client.get_workflow_handle(workflow_id).cancel()

    async def signal(self, workflow_id: str, signal_name: str) -> None:
        client = await self._client()
        await client.get_workflow_handle(workflow_id).signal(signal_name)

    async def signal_and_wait(
        self,
        workflow_id: str,
        signal_name: str,
        timeout_seconds: float,
    ) -> None:
        client = await self._client()
        handle = client.get_workflow_handle(workflow_id)
        await handle.signal(signal_name)
        await asyncio.wait_for(handle.result(), timeout=timeout_seconds)

    async def status(self, workflow_id: str) -> WorkflowState:
        client = await self._client()
        try:
            description = await client.get_workflow_handle(workflow_id).describe()
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                return WorkflowState.NOT_FOUND
            raise
        return (
            WorkflowState.RUNNING
            if description.status == WorkflowExecutionStatus.RUNNING
            else WorkflowState.CLOSED
        )


@dataclass(frozen=True)
class AuditProjectRecord:
    id: str
    organization_id: str
    domain: str
    country: str
    language: str
    audit_run_id: str | None


@dataclass(frozen=True)
class AuditExportResult:
    filename: str
    media_type: str
    stream: AsyncIterator[bytes] | None = None
    path: str | None = None


class SQLAlchemyAuditRunRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    async def get_project(
        self,
        organization_id: str,
        project_id: str,
    ) -> AuditProjectRecord | None:
        async with self.sessions() as session:
            project = await session.scalar(
                select(Project).where(
                    Project.organization_id == organization_id,
                    Project.id == project_id,
                )
            )
            if project is None:
                return None
            return AuditProjectRecord(
                id=project.id,
                organization_id=project.organization_id,
                domain=project.domain,
                country=project.country,
                language=project.language,
                audit_run_id=project.audit_run_id,
            )

    async def create_for_project(
        self,
        project: AuditProjectRecord,
        run: CrawlRun,
    ) -> bool:
        async with self.sessions() as session:
            locked_project = await session.scalar(
                select(Project)
                .where(
                    Project.organization_id == project.organization_id,
                    Project.id == project.id,
                )
                .with_for_update()
            )
            if locked_project is None:
                return False
            active_run_id = await session.scalar(
                select(CrawlRun.run_id)
                .where(
                    CrawlRun.organization_id == project.organization_id,
                    CrawlRun.project_id == project.id,
                    CrawlRun.task_type == "technical_audit",
                    CrawlRun.archived_at.is_(None),
                    CrawlRun.status.in_(ACTIVE_AUDIT_STATUSES),
                )
                .limit(1)
            )
            if active_run_id is not None:
                return False
            session.add(run)
            locked_project.audit_run_id = run.run_id
            locked_project.audit_health = None
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                return False
            return True

    async def get_run(
        self,
        organization_id: str,
        project_id: str,
        run_id: str,
    ) -> CrawlRun | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(CrawlRun).where(
                    CrawlRun.organization_id == organization_id,
                    CrawlRun.project_id == project_id,
                    CrawlRun.run_id == run_id,
                    CrawlRun.task_type == "technical_audit",
                )
            )

    async def list_runs(
        self,
        organization_id: str,
        project_id: str,
        include_archived: bool,
        page: int,
        page_size: int,
        search: str,
        status: str | None,
    ) -> tuple[list[CrawlRun], int]:
        async with self.sessions() as session:
            conditions = [
                CrawlRun.organization_id == organization_id,
                CrawlRun.project_id == project_id,
                CrawlRun.task_type == "technical_audit",
            ]
            if not include_archived:
                conditions.append(CrawlRun.archived_at.is_(None))
            if status:
                statuses = {"completed", "partial"} if status == "completed" else {status}
                conditions.append(CrawlRun.status.in_(statuses))
            if search:
                pattern = f"%{search.strip()}%"
                conditions.append(
                    or_(
                        CrawlRun.run_id.ilike(pattern),
                        CrawlRun.stage.ilike(pattern),
                        CrawlRun.message.ilike(pattern),
                    )
                )
            total = await session.scalar(
                select(func.count()).select_from(CrawlRun).where(*conditions)
            )
            runs = await session.scalars(
                select(CrawlRun)
                .where(*conditions)
                .order_by(CrawlRun.created_at.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
            return list(runs.all()), int(total or 0)

    async def list_active_runs(self) -> list[CrawlRun]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(CrawlRun).where(
                            CrawlRun.task_type == "technical_audit",
                            CrawlRun.status.in_(ACTIVE_AUDIT_STATUSES),
                        )
                    )
                ).all()
            )

    async def update_run_if_status(
        self,
        run_id: str,
        expected_statuses: set[str],
        *,
        expected_workflow_id: str | None = None,
        **values: Any,
    ) -> bool:
        async with self.sessions() as session:
            statement = update(CrawlRun).where(
                CrawlRun.run_id == run_id,
                CrawlRun.status.in_(expected_statuses),
            )
            if expected_workflow_id is not None:
                statement = statement.where(CrawlRun.temporal_workflow_id == expected_workflow_id)
            try:
                result = await session.execute(statement.values(**values))
                await session.commit()
            except IntegrityError:
                await session.rollback()
                return False
            return result.rowcount == 1

    async def resume_run(
        self,
        project: AuditProjectRecord,
        run_id: str,
        expected_statuses: set[str],
        **values: Any,
    ) -> bool:
        async with self.sessions() as session:
            locked_project = await session.scalar(
                select(Project)
                .where(
                    Project.organization_id == project.organization_id,
                    Project.id == project.id,
                )
                .with_for_update()
            )
            if locked_project is None:
                return False
            active_run_id = await session.scalar(
                select(CrawlRun.run_id)
                .where(
                    CrawlRun.organization_id == project.organization_id,
                    CrawlRun.project_id == project.id,
                    CrawlRun.task_type == "technical_audit",
                    CrawlRun.run_id != run_id,
                    CrawlRun.archived_at.is_(None),
                    CrawlRun.status.in_(ACTIVE_AUDIT_STATUSES),
                )
                .limit(1)
            )
            if active_run_id is not None:
                return False
            result = await session.execute(
                update(CrawlRun)
                .where(
                    CrawlRun.organization_id == project.organization_id,
                    CrawlRun.project_id == project.id,
                    CrawlRun.run_id == run_id,
                    CrawlRun.task_type == "technical_audit",
                    CrawlRun.archived_at.is_(None),
                    CrawlRun.status.in_(expected_statuses),
                )
                .values(**values)
            )
            if result.rowcount != 1:
                await session.rollback()
                return False
            locked_project.audit_run_id = run_id
            locked_project.audit_health = None
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                return False
            return True

    async def has_checkpoint(self, run_id: str) -> bool:
        async with self.sessions() as session:
            return bool(
                await session.scalar(
                    select(func.count())
                    .select_from(CrawlCheckpoint)
                    .where(CrawlCheckpoint.run_id == run_id)
                )
            )

    async def load_checkpoint(self, run_id: str) -> dict | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(CrawlCheckpoint.checkpoint).where(CrawlCheckpoint.run_id == run_id)
            )

    async def update_project_health(
        self,
        organization_id: str,
        project_id: str,
        run_id: str,
        health: int,
    ) -> None:
        async with self.sessions() as session:
            await session.execute(
                update(Project)
                .where(
                    Project.organization_id == organization_id,
                    Project.id == project_id,
                    Project.audit_run_id == run_id,
                )
                .values(audit_health=health)
            )
            await session.commit()

    async def archive_run(
        self,
        project: AuditProjectRecord,
        run_id: str,
        archived_at: datetime,
    ) -> bool:
        async with self.sessions() as session:
            locked_project = await session.scalar(
                select(Project)
                .where(
                    Project.organization_id == project.organization_id,
                    Project.id == project.id,
                )
                .with_for_update()
            )
            run = await session.scalar(
                select(CrawlRun)
                .where(
                    CrawlRun.organization_id == project.organization_id,
                    CrawlRun.project_id == project.id,
                    CrawlRun.run_id == run_id,
                    CrawlRun.task_type == "technical_audit",
                )
                .with_for_update()
            )
            if (
                locked_project is None
                or run is None
                or normalized_run_status(run.status) in ACTIVE_AUDIT_STATUSES
            ):
                return False
            run.archived_at = archived_at
            if locked_project.audit_run_id == run_id:
                replacement = await session.scalar(
                    select(CrawlRun)
                    .where(
                        CrawlRun.organization_id == project.organization_id,
                        CrawlRun.project_id == project.id,
                        CrawlRun.task_type == "technical_audit",
                        CrawlRun.run_id != run_id,
                        CrawlRun.archived_at.is_(None),
                    )
                    .order_by(CrawlRun.created_at.desc())
                    .limit(1)
                )
                locked_project.audit_run_id = (
                    replacement.run_id if replacement is not None else None
                )
                locked_project.audit_health = (
                    int((replacement.summary or {}).get("health_score", 0))
                    if replacement is not None
                    else None
                )
            await session.commit()
            return True

    async def delete_run(self, project: AuditProjectRecord, run_id: str) -> bool:
        async with self.sessions() as session:
            locked_project = await session.scalar(
                select(Project)
                .where(
                    Project.organization_id == project.organization_id,
                    Project.id == project.id,
                )
                .with_for_update()
            )
            run = await session.scalar(
                select(CrawlRun)
                .where(
                    CrawlRun.organization_id == project.organization_id,
                    CrawlRun.project_id == project.id,
                    CrawlRun.run_id == run_id,
                    CrawlRun.task_type == "technical_audit",
                )
                .with_for_update()
            )
            if (
                locked_project is None
                or run is None
                or normalized_run_status(run.status) in ACTIVE_AUDIT_STATUSES
            ):
                return False
            if locked_project.audit_run_id == run_id:
                replacement = await session.scalar(
                    select(CrawlRun)
                    .where(
                        CrawlRun.organization_id == project.organization_id,
                        CrawlRun.project_id == project.id,
                        CrawlRun.task_type == "technical_audit",
                        CrawlRun.run_id != run_id,
                        CrawlRun.archived_at.is_(None),
                    )
                    .order_by(CrawlRun.created_at.desc())
                    .limit(1)
                )
                locked_project.audit_run_id = (
                    replacement.run_id if replacement is not None else None
                )
                locked_project.audit_health = (
                    int((replacement.summary or {}).get("health_score", 0))
                    if replacement is not None
                    else None
                )
            await session.delete(run)
            await session.commit()
            return True

    async def list_issues(self, run_id: str) -> list[AuditIssue]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(AuditIssue)
                        .where(AuditIssue.run_id == run_id)
                        .order_by(
                            AuditIssue.severity,
                            AuditIssue.category,
                            AuditIssue.code,
                            AuditIssue.url,
                        )
                    )
                ).all()
            )

    async def list_issues_batch(
        self,
        run_id: str,
        page: int,
        page_size: int,
    ) -> list[AuditIssue]:
        async with self.sessions() as session:
            rows = await session.scalars(
                select(AuditIssue)
                .where(AuditIssue.run_id == run_id)
                .order_by(
                    case(
                        (AuditIssue.severity == "error", 0),
                        (AuditIssue.severity == "warning", 1),
                        else_=2,
                    ),
                    AuditIssue.category,
                    AuditIssue.code,
                    AuditIssue.issue,
                    AuditIssue.details,
                    AuditIssue.url,
                )
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
            return list(rows.all())

    async def list_pages(
        self,
        run_id: str,
        page: int,
        page_size: int,
        search: str,
        status_code: int | None,
        status_family: str | None,
    ) -> tuple[list[tuple[PageSnapshot, int]], int]:
        async with self.sessions() as session:
            issue_counts = (
                select(
                    AuditIssue.page_id.label("page_id"),
                    func.count(AuditIssue.id).label("issue_count"),
                )
                .where(AuditIssue.run_id == run_id)
                .group_by(AuditIssue.page_id)
                .subquery()
            )
            conditions = [PageSnapshot.run_id == run_id]
            if search:
                pattern = f"%{search.strip()}%"
                conditions.append(
                    or_(
                        PageSnapshot.final_url.ilike(pattern),
                        PageSnapshot.title.ilike(pattern),
                    )
                )
            if status_code is not None:
                conditions.append(PageSnapshot.status_code == status_code)
            if status_family == "unknown":
                conditions.append(PageSnapshot.status_code == 0)
            elif status_family is not None:
                lower_bound = int(status_family[0]) * 100
                conditions.append(
                    and_(
                        PageSnapshot.status_code >= lower_bound,
                        PageSnapshot.status_code < lower_bound + 100,
                    )
                )
            total = await session.scalar(
                select(func.count()).select_from(PageSnapshot).where(*conditions)
            )
            rows = (
                await session.execute(
                    select(PageSnapshot, func.coalesce(issue_counts.c.issue_count, 0))
                    .outerjoin(issue_counts, issue_counts.c.page_id == PageSnapshot.page_id)
                    .where(*conditions)
                    .order_by(PageSnapshot.depth, PageSnapshot.final_url)
                    .offset((page - 1) * page_size)
                    .limit(page_size)
                )
            ).all()
            return [(snapshot, int(count)) for snapshot, count in rows], int(total or 0)

    async def list_links(
        self,
        run_id: str,
        page: int,
        page_size: int,
        search: str,
        internal: bool | None,
        status_family: str | None,
    ) -> tuple[list[tuple[LinkEdge, str]], int]:
        async with self.sessions() as session:
            conditions = [LinkEdge.run_id == run_id]
            if search:
                pattern = f"%{search.strip()}%"
                conditions.append(
                    or_(
                        Page.normalized_url.ilike(pattern),
                        LinkEdge.target_url.ilike(pattern),
                        LinkEdge.anchor_text.ilike(pattern),
                    )
                )
            if internal is not None:
                conditions.append(LinkEdge.is_internal == internal)
            if status_family == "unknown":
                conditions.append(
                    or_(
                        LinkEdge.target_status.is_(None),
                        LinkEdge.target_status == 0,
                    )
                )
            elif status_family is not None:
                lower_bound = int(status_family[0]) * 100
                conditions.append(
                    and_(
                        LinkEdge.target_status >= lower_bound,
                        LinkEdge.target_status < lower_bound + 100,
                    )
                )
            total = await session.scalar(
                select(func.count())
                .select_from(LinkEdge)
                .join(Page, Page.id == LinkEdge.source_page_id)
                .where(*conditions)
            )
            rows = (
                await session.execute(
                    select(LinkEdge, Page.normalized_url)
                    .join(Page, Page.id == LinkEdge.source_page_id)
                    .where(*conditions)
                    .order_by(Page.normalized_url, LinkEdge.target_url)
                    .offset((page - 1) * page_size)
                    .limit(page_size)
                )
            ).all()
            return [(edge, source_url) for edge, source_url in rows], int(total or 0)

    async def list_external_resources(
        self,
        run_id: str,
        page: int,
        page_size: int,
        search: str,
        status_family: str | None,
    ) -> tuple[list[ExternalResource], int]:
        async with self.sessions() as session:
            conditions = [ExternalResource.run_id == run_id]
            if search:
                pattern = f"%{search.strip()}%"
                conditions.append(
                    or_(
                        ExternalResource.url.ilike(pattern),
                        ExternalResource.final_url.ilike(pattern),
                        ExternalResource.title.ilike(pattern),
                        ExternalResource.content_type.ilike(pattern),
                    )
                )
            if status_family == "unknown":
                conditions.append(
                    or_(
                        ExternalResource.status_code.is_(None),
                        ExternalResource.status_code == 0,
                    )
                )
            elif status_family is not None:
                lower_bound = int(status_family[0]) * 100
                conditions.append(
                    and_(
                        ExternalResource.status_code >= lower_bound,
                        ExternalResource.status_code < lower_bound + 100,
                    )
                )
            total = await session.scalar(
                select(func.count()).select_from(ExternalResource).where(*conditions)
            )
            rows = await session.scalars(
                select(ExternalResource)
                .where(*conditions)
                .order_by(ExternalResource.url)
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
            return list(rows.all()), int(total or 0)

    async def status_codes(self, run_id: str) -> list[tuple[int, str, int]]:
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(
                        PageSnapshot.status_code,
                        PageSnapshot.error_type,
                        func.count().label("count"),
                    )
                    .where(PageSnapshot.run_id == run_id)
                    .group_by(PageSnapshot.status_code, PageSnapshot.error_type)
                    .order_by(
                        PageSnapshot.status_code,
                        PageSnapshot.error_type,
                    )
                )
            ).all()
            return [
                (int(status_code or 0), error_type or "", int(count))
                for status_code, error_type, count in rows
            ]

    async def visualization(
        self,
        run_id: str,
    ) -> tuple[
        list[tuple[PageSnapshot, int]],
        list[tuple[LinkEdge, str]],
        int,
        int,
    ]:
        async with self.sessions() as session:
            issue_counts = (
                select(
                    AuditIssue.page_id.label("page_id"),
                    func.count(AuditIssue.id).label("issue_count"),
                )
                .where(AuditIssue.run_id == run_id)
                .group_by(AuditIssue.page_id)
                .subquery()
            )
            total_nodes = int(
                await session.scalar(
                    select(func.count())
                    .select_from(PageSnapshot)
                    .where(PageSnapshot.run_id == run_id)
                )
                or 0
            )
            page_rows = (
                await session.execute(
                    select(PageSnapshot, func.coalesce(issue_counts.c.issue_count, 0))
                    .outerjoin(issue_counts, issue_counts.c.page_id == PageSnapshot.page_id)
                    .where(PageSnapshot.run_id == run_id)
                    .order_by(
                        PageSnapshot.depth,
                        func.coalesce(issue_counts.c.issue_count, 0).desc(),
                        PageSnapshot.final_url,
                    )
                    .limit(VISUALIZATION_NODE_LIMIT)
                )
            ).all()
            pages = [(snapshot, int(count)) for snapshot, count in page_rows]
            page_ids = [snapshot.page_id for snapshot, _ in pages]

            total_edges = int(
                await session.scalar(
                    select(func.count())
                    .select_from(LinkEdge)
                    .where(
                        LinkEdge.run_id == run_id,
                        LinkEdge.is_internal.is_(True),
                    )
                )
                or 0
            )
            if not page_ids:
                return pages, [], total_nodes, total_edges
            link_rows = (
                await session.execute(
                    select(LinkEdge, Page.normalized_url)
                    .join(Page, Page.id == LinkEdge.source_page_id)
                    .where(
                        LinkEdge.run_id == run_id,
                        LinkEdge.is_internal.is_(True),
                        LinkEdge.source_page_id.in_(page_ids),
                    )
                    .order_by(Page.normalized_url, LinkEdge.target_url)
                    .limit(VISUALIZATION_EDGE_LIMIT)
                )
            ).all()
            links = [(edge, source_url) for edge, source_url in link_rows]
            return pages, links, total_nodes, total_edges

    async def list_pagespeed(self, run_id: str) -> list[PageSpeedResult]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(PageSpeedResult)
                        .where(PageSpeedResult.run_id == run_id)
                        .order_by(PageSpeedResult.url, PageSpeedResult.strategy)
                    )
                ).all()
            )


class AuditService:
    def __init__(
        self,
        settings: Settings,
        controller: WorkflowController,
        repository: Any,
        object_cleaner: AuditObjectCleaner | None = None,
    ) -> None:
        self.settings = settings
        self.controller = controller
        self.repository = repository
        self.object_cleaner = object_cleaner or NoopAuditObjectCleaner()

    async def create_run(
        self,
        project_id: str,
        request: CreateAuditRunRequest,
    ) -> AuditRunResponse:
        self._validate_project_id(project_id)
        project = await self._project(project_id)
        run_id = str(uuid4())
        workflow_id = f"crawler:technical_audit:{run_id}"
        target_url = normalize_target_url(project.domain)
        task = build_task(self.settings, project, run_id, target_url, request)
        now = datetime.now(UTC)
        run = CrawlRun(
            run_id=run_id,
            organization_id=project.organization_id,
            project_id=project.id,
            task_type="technical_audit",
            target_url=target_url,
            country=project.country,
            language=project.language,
            status="queued",
            stage="queued",
            message="技术审计任务已进入队列",
            config_snapshot=task,
            temporal_workflow_id=workflow_id,
            can_resume=False,
            created_at=now,
        )
        created = await self.repository.create_for_project(project, run)
        if not created:
            raise AuditStateError("这个项目已有正在运行的审计")
        try:
            await self.controller.start(task, workflow_id)
        except Exception as exc:
            await self.repository.update_run_if_status(
                run_id,
                {"queued"},
                expected_workflow_id=workflow_id,
                status="failed",
                stage="failed",
                message="无法连接技术审计任务服务",
                can_resume=False,
                finished_at=datetime.now(UTC),
            )
            raise AuditLaunchError from exc
        return run_response(run, page_speed_count=0)

    async def list_runs(
        self,
        project_id: str,
        include_archived: bool = False,
        page: int = 1,
        page_size: int = 25,
        search: str = "",
        status: str | None = None,
    ) -> AuditRunCollection:
        self._validate_project_id(project_id)
        await self._project(project_id)
        runs, total = await self.repository.list_runs(
            self.settings.default_organization_id,
            project_id,
            include_archived,
            page,
            page_size,
            search,
            status,
        )
        if await self._reconcile_visible_runs(runs):
            runs, total = await self.repository.list_runs(
                self.settings.default_organization_id,
                project_id,
                include_archived,
                page,
                page_size,
                search,
                status,
            )
        return AuditRunCollection(
            items=[run_response(run) for run in runs],
            total=total,
            page=page,
            page_size=page_size,
        )

    async def get_run(self, project_id: str, run_id: str) -> AuditRunResponse:
        run = await self._run(project_id, run_id)
        if await self._reconcile_visible_runs([run]):
            run = await self._run(project_id, run_id)
        page_speed_count = len(await self.repository.list_pagespeed(run_id))
        response = run_response(run, page_speed_count)
        if response.summary is not None:
            await self.repository.update_project_health(
                run.organization_id,
                run.project_id,
                run.run_id,
                response.summary.health_score,
            )
        return response

    async def activity(
        self,
        project_id: str,
        run_id: str,
        cursor: int,
        limit: int,
    ) -> AuditActivityCollection:
        await self._run(project_id, run_id)
        checkpoint = await self.repository.load_checkpoint(run_id)
        pages = checkpoint.get("pages", []) if isinstance(checkpoint, dict) else []
        if not isinstance(pages, list):
            pages = []
        start = min(cursor, len(pages))
        end = min(start + limit, len(pages))
        items = [
            checkpoint_activity_item(sequence=index + 1, value=value)
            for index, value in enumerate(pages[start:end], start=start)
            if isinstance(value, dict)
        ]
        return AuditActivityCollection(items=items, next_cursor=end)

    async def reconcile_active_runs(self) -> int:
        reconciled = 0
        for run in await self.repository.list_active_runs():
            if await self._reconcile_active_run(run):
                reconciled += 1
        return reconciled

    async def _reconcile_visible_runs(self, runs: list[CrawlRun]) -> bool:
        reconciled = False
        for run in runs:
            if normalized_run_status(run.status) not in ACTIVE_AUDIT_STATUSES:
                continue
            try:
                reconciled = await self._reconcile_active_run(run) or reconciled
            except Exception:
                logger.warning(
                    "Unable to reconcile audit workflow while reading run",
                    exc_info=True,
                    extra={"run_id": run.run_id},
                )
        return reconciled

    async def _reconcile_active_run(self, run: CrawlRun) -> bool:
        if run.temporal_workflow_id:
            workflow_state = await self.controller.status(run.temporal_workflow_id)
            if workflow_state == WorkflowState.RUNNING:
                return False
        if normalized_run_status(run.status) == "recalculating":
            return await self.repository.update_run_if_status(
                run.run_id,
                {"recalculating"},
                expected_workflow_id=run.temporal_workflow_id,
                status="completed",
                stage="completed",
                message="Issue recalculation stopped; previous results were preserved",
                temporal_workflow_id=None,
            )
        can_resume = await self.repository.has_checkpoint(run.run_id)
        message = (
            "审计工作流已结束，可从检查点恢复"
            if can_resume
            else "审计工作流已结束，且没有可恢复检查点"
        )
        return await self.repository.update_run_if_status(
            run.run_id,
            ACTIVE_AUDIT_STATUSES,
            expected_workflow_id=run.temporal_workflow_id,
            status="failed",
            stage="failed",
            message=message,
            can_resume=can_resume,
            finished_at=datetime.now(UTC),
        )

    async def recalculate_issues(
        self,
        project_id: str,
        run_id: str,
        request: RecalculateAuditIssuesRequest,
    ) -> AuditRunResponse:
        project = await self._project(project_id)
        run = await self._run(project_id, run_id)
        if run.archived_at is not None:
            raise AuditStateError("Archived audits cannot be recalculated")
        if normalized_run_status(run.status) not in {"completed", "partial"}:
            raise AuditStateError("Only completed audits can recalculate issues")

        previous_status = run.status
        previous_stage = run.stage
        previous_message = run.message
        previous_workflow_id = run.temporal_workflow_id
        previous_can_resume = bool(run.can_resume)
        task = dict(run.config_snapshot or {})
        task.update(
            {
                "organization_id": run.organization_id,
                "project_id": run.project_id,
                "run_id": run.run_id,
                "type": "technical_audit",
                "target_url": run.target_url or normalize_target_url(project.domain),
                "country": run.country or project.country,
                "language": run.language or project.language,
                "issue_exclusion_patterns": request.issue_exclusion_patterns,
            }
        )
        workflow_id = f"crawler:technical_audit:{run_id}:recalculate:{uuid4()}"
        claimed = await self.repository.resume_run(
            project,
            run_id,
            {"completed", "partial"},
            status="recalculating",
            stage="recalculating_issues",
            message="Recalculating issues from saved pages",
            temporal_workflow_id=workflow_id,
            can_resume=False,
        )
        if not claimed:
            raise AuditStateError(
                "Audit status changed or another audit is currently active"
            )
        try:
            await self.controller.start_recalculation(task, workflow_id)
        except Exception as exc:
            await self.repository.update_run_if_status(
                run_id,
                {"recalculating"},
                expected_workflow_id=workflow_id,
                status=previous_status,
                stage=previous_stage,
                message=previous_message,
                temporal_workflow_id=previous_workflow_id,
                can_resume=previous_can_resume,
            )
            raise AuditLaunchError from exc
        return await self.get_run(project_id, run_id)

    async def pause_run(self, project_id: str, run_id: str) -> AuditRunResponse:
        run = await self._run(project_id, run_id)
        if normalized_run_status(run.status) not in {"queued", "running"}:
            raise AuditStateError("只有正在运行的审计可以暂停")
        if not run.temporal_workflow_id:
            raise AuditStateError("审计任务缺少工作流标识，无法暂停")
        try:
            await self._wait_for_checkpoint(run_id)
            await self.controller.signal_and_wait(
                run.temporal_workflow_id,
                "pause",
                self.settings.audit_control_timeout_seconds,
            )
        except AuditStateError:
            raise
        except Exception as exc:
            raise AuditLaunchError from exc
        if not await self.repository.has_checkpoint(run_id):
            raise AuditStateError("爬虫没有保存可恢复检查点，请重新运行审计")
        updated = await self.repository.update_run_if_status(
            run_id,
            {"queued", "running"},
            status="paused",
            stage="paused",
            message="审计已暂停，可从检查点继续",
            can_resume=True,
        )
        if not updated:
            raise AuditStateError("审计状态已变化，请刷新后重试")
        return await self.get_run(project_id, run_id)

    async def stop_run(self, project_id: str, run_id: str) -> AuditRunResponse:
        run = await self._run(project_id, run_id)
        current_status = normalized_run_status(run.status)
        if current_status not in {"queued", "running", "paused"}:
            raise AuditStateError("当前审计不能停止")
        if current_status == "paused":
            updated = await self.repository.update_run_if_status(
                run_id,
                {"paused"},
                status="stopped",
                stage="stopped",
                message="审计已停止",
                can_resume=True,
                finished_at=datetime.now(UTC),
            )
            if not updated:
                raise AuditStateError("审计状态已变化，请刷新后重试")
            return await self.get_run(project_id, run_id)

        if not run.temporal_workflow_id:
            raise AuditStateError("审计任务缺少工作流标识，无法停止")
        claimed = await self.repository.update_run_if_status(
            run_id,
            {"queued", "running"},
            status="stopping",
            stage="stopping",
            message="正在停止审计",
            can_resume=False,
        )
        if not claimed:
            raise AuditStateError("审计状态已变化，请刷新后重试")
        try:
            await self._wait_for_checkpoint(run_id)
            await self.controller.signal_and_wait(
                run.temporal_workflow_id,
                "stop",
                self.settings.audit_control_timeout_seconds,
            )
            if not await self.repository.has_checkpoint(run_id):
                raise AuditStateError("爬虫没有保存可恢复检查点，请重新运行审计")
        except AuditStateError:
            await self._restore_failed_stop(run)
            raise
        except Exception as exc:
            await self._restore_failed_stop(run)
            raise AuditLaunchError from exc
        stopped = await self.repository.update_run_if_status(
            run_id,
            {"stopping"},
            status="stopped",
            stage="stopped",
            message="审计已停止",
            can_resume=True,
            finished_at=datetime.now(UTC),
        )
        if not stopped:
            raise AuditStateError("审计状态已变化，请刷新后重试")
        return await self.get_run(project_id, run_id)

    async def _wait_for_checkpoint(self, run_id: str) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.settings.audit_control_timeout_seconds
        while not await self.repository.has_checkpoint(run_id):
            if loop.time() >= deadline:
                raise AuditStateError("爬虫尚未保存可恢复检查点，请稍后重试")
            await asyncio.sleep(self.settings.audit_checkpoint_poll_interval_seconds)

    async def _restore_failed_stop(self, run: CrawlRun) -> None:
        await self.repository.update_run_if_status(
            run.run_id,
            {"stopping"},
            status=run.status,
            stage=run.stage,
            message=run.message,
            can_resume=bool(run.can_resume),
            finished_at=run.finished_at,
        )

    async def resume_run(self, project_id: str, run_id: str) -> AuditRunResponse:
        project = await self._project(project_id)
        run = await self._run(project_id, run_id)
        if normalized_run_status(run.status) not in RESUMABLE_AUDIT_STATUSES:
            raise AuditStateError("当前审计不能恢复")
        if not run.can_resume:
            raise AuditStateError("这个审计没有可用检查点")
        if not await self.repository.has_checkpoint(run_id):
            raise AuditStateError("这个审计没有可用检查点")
        task = dict(run.config_snapshot or {})
        task["run_id"] = run_id
        workflow_id = f"crawler:technical_audit:{run_id}:resume:{uuid4()}"
        resumed = await self.repository.resume_run(
            project,
            run_id,
            RESUMABLE_AUDIT_STATUSES,
            status="queued",
            stage="queued",
            message="审计恢复任务已进入队列",
            temporal_workflow_id=workflow_id,
            can_resume=False,
            finished_at=None,
        )
        if not resumed:
            raise AuditStateError("审计状态已变化，或项目已有正在运行的审计")
        try:
            await self.controller.start(task, workflow_id)
        except Exception as exc:
            await self.repository.update_run_if_status(
                run_id,
                {"queued"},
                expected_workflow_id=workflow_id,
                status="failed",
                stage="failed",
                message="无法恢复技术审计任务",
                can_resume=True,
            )
            raise AuditLaunchError from exc
        return await self.get_run(project_id, run_id)

    async def archive_run(self, project_id: str, run_id: str) -> AuditRunResponse:
        project = await self._project(project_id)
        run = await self._run(project_id, run_id)
        if normalized_run_status(run.status) in ACTIVE_AUDIT_STATUSES:
            raise AuditStateError("运行中的审计不能归档")
        archived = await self.repository.archive_run(
            project,
            run_id,
            datetime.now(UTC),
        )
        if not archived:
            raise AuditStateError("审计状态已变化，请刷新后重试")
        return await self.get_run(project_id, run_id)

    async def delete_run(self, project_id: str, run_id: str) -> None:
        project = await self._project(project_id)
        run = await self._run(project_id, run_id)
        if normalized_run_status(run.status) in ACTIVE_AUDIT_STATUSES:
            raise AuditStateError("运行中的审计不能删除")
        try:
            await self.object_cleaner.delete_run_objects(
                run.organization_id,
                run.project_id,
                run.run_id,
            )
        except Exception as exc:
            raise AuditLaunchError("无法清理审计对象文件") from exc
        deleted = await self.repository.delete_run(project, run_id)
        if not deleted:
            raise AuditStateError("审计状态已变化，请刷新后重试")

    async def issues(
        self,
        project_id: str,
        run_id: str,
        page: int,
        page_size: int,
        severity: str | None,
        search: str,
    ) -> AuditIssueCollection:
        run = await self._run(project_id, run_id)
        issues = await self.repository.list_issues(run_id)
        if not issues:
            checkpoint = await self._active_checkpoint(run)
            issues = checkpoint_issues(checkpoint)
        groups: dict[tuple[str, str, str, str, str], list[AuditIssue]] = {}
        for issue in issues:
            if severity and normalize_severity(issue.severity) != severity:
                continue
            haystack = (
                f"{issue.code} {issue.category} {issue.issue} {issue.details} {issue.url}".lower()
            )
            if search and search.lower() not in haystack:
                continue
            key = (
                issue.code,
                normalize_severity(issue.severity),
                issue.category,
                issue.issue,
                issue.details,
            )
            groups.setdefault(key, []).append(issue)
        items = [
            AuditIssueResponse(
                id=(
                    f"{code}:{severity_value}:"
                    f"{hashlib.sha256(chr(31).join((code, severity_value, category, title, details)).encode()).hexdigest()[:16]}"
                ),
                title=title,
                code=code,
                severity=severity_value,
                category=category,
                affected_count=len({item.url for item in values}),
                description=details,
                recommendation=issue_recommendation(code),
                urls=sorted({item.url for item in values}),
                raw={
                    "related_urls": sorted(
                        {item.related_url for item in values if item.related_url}
                    ),
                    "max_similarity": max(
                        (item.similarity or 0 for item in values),
                        default=0,
                    ),
                },
            )
            for (code, severity_value, category, title, details), values in groups.items()
        ]
        severity_order = {"error": 0, "warning": 1, "notice": 2}
        items.sort(key=lambda item: (severity_order[item.severity], item.category, item.title))
        total = len(items)
        start = (page - 1) * page_size
        return AuditIssueCollection(
            items=items[start : start + page_size],
            total=total,
            page=page,
            page_size=page_size,
        )

    async def pages(
        self,
        project_id: str,
        run_id: str,
        page: int,
        page_size: int,
        search: str,
        status_code: int | None,
        status_family: str | None,
    ) -> AuditPageCollection:
        run = await self._run(project_id, run_id)
        rows, total = await self.repository.list_pages(
            run_id,
            page,
            page_size,
            search,
            status_code,
            status_family,
        )
        if total == 0:
            checkpoint = await self._active_checkpoint(run)
            checkpoint_items = checkpoint_page_responses(
                checkpoint,
                search,
                status_code,
                status_family,
            )
            if checkpoint_items:
                total = len(checkpoint_items)
                start = (page - 1) * page_size
                return AuditPageCollection(
                    items=checkpoint_items[start : start + page_size],
                    total=total,
                    page=page,
                    page_size=page_size,
                )
        return AuditPageCollection(
            items=[page_response(snapshot, issue_count) for snapshot, issue_count in rows],
            total=total,
            page=page,
            page_size=page_size,
        )

    async def links(
        self,
        project_id: str,
        run_id: str,
        page: int,
        page_size: int,
        search: str,
        internal: bool | None,
        status_family: str | None,
    ) -> AuditLinkCollection:
        run = await self._run(project_id, run_id)
        rows, total = await self.repository.list_links(
            run_id,
            page,
            page_size,
            search,
            internal,
            status_family,
        )
        if total == 0:
            checkpoint = await self._active_checkpoint(run)
            checkpoint_items = checkpoint_link_responses(
                checkpoint,
                search,
                internal,
                status_family,
            )
            if checkpoint_items:
                total = len(checkpoint_items)
                start = (page - 1) * page_size
                return AuditLinkCollection(
                    items=checkpoint_items[start : start + page_size],
                    total=total,
                    page=page,
                    page_size=page_size,
                )
        return AuditLinkCollection(
            items=[link_response(edge, source) for edge, source in rows],
            total=total,
            page=page,
            page_size=page_size,
        )

    async def resources(
        self,
        project_id: str,
        run_id: str,
        page: int,
        page_size: int,
        search: str,
        status_family: str | None,
    ) -> AuditExternalResourceCollection:
        run = await self._run(project_id, run_id)
        rows, total = await self.repository.list_external_resources(
            run_id,
            page,
            page_size,
            search,
            status_family,
        )
        if total == 0:
            checkpoint = await self._active_checkpoint(run)
            checkpoint_items = checkpoint_external_resource_responses(
                checkpoint,
                search,
                status_family,
            )
            if checkpoint_items:
                total = len(checkpoint_items)
                start = (page - 1) * page_size
                return AuditExternalResourceCollection(
                    items=checkpoint_items[start : start + page_size],
                    total=total,
                    page=page,
                    page_size=page_size,
                )
        return AuditExternalResourceCollection(
            items=[external_resource_response(item) for item in rows],
            total=total,
            page=page,
            page_size=page_size,
        )

    async def status_codes(
        self,
        project_id: str,
        run_id: str,
    ) -> AuditStatusCodeCollection:
        run = await self._run(project_id, run_id)
        rows = await self.repository.status_codes(run_id)
        if not rows:
            checkpoint = await self._active_checkpoint(run)
            rows = checkpoint_status_codes(checkpoint)
        rows.sort(key=lambda row: (row[0] == 0, row[0], row[1]))
        total = sum(count for _, _, count in rows)
        return AuditStatusCodeCollection(
            items=[
                AuditStatusCodeResponse(
                    status_code=status_code,
                    status=status_code_label(status_code, error_type),
                    count=count,
                    percentage=round((count / total) * 100, 1) if total else 0,
                    error_type=error_type,
                )
                for status_code, error_type, count in rows
            ],
            total=total,
        )

    async def visualization(
        self,
        project_id: str,
        run_id: str,
    ) -> AuditVisualizationResponse:
        run = await self._run(project_id, run_id)
        pages, links, total_nodes, total_edges = await self.repository.visualization(run_id)
        if not pages:
            checkpoint = await self._active_checkpoint(run)
            return checkpoint_visualization(checkpoint)
        node_by_url: dict[str, str] = {}
        nodes: list[AuditVisualizationNode] = []
        for snapshot, issue_count in pages:
            node_id = str(snapshot.page_id)
            node_by_url[normalize_graph_url(snapshot.final_url)] = node_id
            nodes.append(
                AuditVisualizationNode(
                    id=node_id,
                    label=snapshot.title or snapshot.final_url,
                    url=snapshot.final_url,
                    group=page_group(snapshot),
                    depth=snapshot.depth,
                    issue_count=issue_count,
                    raw={"status_code": snapshot.status_code},
                )
            )
        edges: list[AuditVisualizationEdge] = []
        for edge, source_url in links:
            source = node_by_url.get(normalize_graph_url(source_url))
            target = node_by_url.get(normalize_graph_url(edge.target_url))
            if not source or not target:
                continue
            edges.append(
                AuditVisualizationEdge(
                    id=str(edge.id),
                    source=source,
                    target=target,
                    label=edge.placement,
                    raw={"anchor_text": edge.anchor_text or ""},
                )
            )
        return AuditVisualizationResponse(
            nodes=nodes,
            edges=edges,
            total_nodes=total_nodes,
            total_edges=total_edges,
            truncated=total_nodes > len(nodes) or total_edges > len(links),
        )

    async def _active_checkpoint(self, run: CrawlRun) -> dict[str, Any] | None:
        if normalized_run_status(run.status) not in ACTIVE_AUDIT_STATUSES:
            return None
        checkpoint = await self.repository.load_checkpoint(run.run_id)
        return checkpoint if isinstance(checkpoint, dict) else None

    async def pagespeed(
        self,
        project_id: str,
        run_id: str,
    ) -> AuditPageSpeedCollection:
        await self._run(project_id, run_id)
        results = await self.repository.list_pagespeed(run_id)
        return AuditPageSpeedCollection(
            items=[
                AuditPageSpeedResultResponse(
                    id=str(item.id),
                    url=item.url,
                    strategy=item.strategy,
                    performance_score=item.performance_score,
                    accessibility_score=item.accessibility_score,
                    best_practices_score=item.best_practices_score,
                    seo_score=item.seo_score,
                    metrics=item.metrics or {},
                    error=item.error or "",
                    analyzed_at=item.analyzed_at,
                )
                for item in results
            ],
            total=len(results),
        )

    async def export(
        self,
        project_id: str,
        run_id: str,
        dataset: AuditExportDataset,
        format_value: AuditExportFormat,
    ) -> AuditExportResult:
        await self._run(project_id, run_id)
        rows = self._export_rows(run_id, dataset)
        filename = f"audit-{run_id}-{dataset}.{format_value}"
        if format_value == "xlsx":
            return AuditExportResult(
                filename=filename,
                media_type=("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
                path=await write_xlsx_export(rows),
            )
        return AuditExportResult(
            filename=filename,
            media_type=export_media_type(format_value),
            stream=stream_export(rows, format_value),
        )

    async def _export_rows(
        self,
        run_id: str,
        dataset: AuditExportDataset,
    ) -> AsyncIterator[dict[str, Any]]:
        if dataset == "issues":
            async for row in self._issue_export_rows(run_id):
                yield row
            return

        page = 1
        while True:
            if dataset == "pages":
                rows, total = await self.repository.list_pages(
                    run_id,
                    page,
                    EXPORT_BATCH_SIZE,
                    "",
                    None,
                    None,
                )
                export_rows = [
                    page_response(snapshot, issue_count).model_dump(mode="json")
                    for snapshot, issue_count in rows
                ]
            else:
                rows, total = await self.repository.list_links(
                    run_id,
                    page,
                    EXPORT_BATCH_SIZE,
                    "",
                    None,
                    None,
                )
                export_rows = [
                    link_response(edge, source).model_dump(mode="json") for edge, source in rows
                ]
            for row in export_rows:
                yield row
            if not rows or page * EXPORT_BATCH_SIZE >= total:
                return
            page += 1

    async def _issue_export_rows(
        self,
        run_id: str,
    ) -> AsyncIterator[dict[str, Any]]:
        current_key: tuple[str, str, str, str, str] | None = None
        urls: set[str] = set()
        related_urls: set[str] = set()
        max_similarity = 0.0
        page = 1

        while True:
            issues = await self.repository.list_issues_batch(
                run_id,
                page,
                EXPORT_BATCH_SIZE,
            )
            for issue in issues:
                key = (
                    issue.code,
                    normalize_severity(issue.severity),
                    issue.category,
                    issue.issue,
                    issue.details,
                )
                if current_key is not None and key != current_key:
                    yield issue_export_row(
                        current_key,
                        urls,
                        related_urls,
                        max_similarity,
                    )
                    urls = set()
                    related_urls = set()
                    max_similarity = 0.0
                current_key = key
                urls.add(issue.url)
                if issue.related_url:
                    related_urls.add(issue.related_url)
                max_similarity = max(max_similarity, issue.similarity or 0)
            if len(issues) < EXPORT_BATCH_SIZE:
                break
            page += 1

        if current_key is not None:
            yield issue_export_row(
                current_key,
                urls,
                related_urls,
                max_similarity,
            )

    async def _project(self, project_id: str) -> AuditProjectRecord:
        project = await self.repository.get_project(
            self.settings.default_organization_id,
            project_id,
        )
        if project is None:
            raise AuditProjectNotFoundError
        return project

    async def _run(self, project_id: str, run_id: str) -> CrawlRun:
        run = await self.repository.get_run(
            self.settings.default_organization_id,
            project_id,
            run_id,
        )
        if run is None:
            raise AuditRunNotFoundError
        return run

    @staticmethod
    def _validate_project_id(project_id: str) -> None:
        if not SAFE_IDENTIFIER.fullmatch(project_id):
            raise ValueError("project_id contains unsupported characters")


def build_task(
    settings: Settings,
    project: AuditProjectRecord,
    run_id: str,
    target_url: str,
    request: CreateAuditRunRequest,
) -> dict[str, Any]:
    task: dict[str, Any] = {
        "organization_id": settings.default_organization_id,
        "project_id": project.id,
        "run_id": run_id,
        "type": "technical_audit",
        "target_url": target_url,
        "country": project.country,
        "language": project.language,
        "max_pages": request.max_pages,
        "scope": request.scope.value,
        "rendering": request.rendering.value,
        "allowed_paths": request.allowed_paths,
        "excluded_paths": request.excluded_paths,
        "ignored_parameters": request.ignored_parameters,
        "issue_exclusion_patterns": request.issue_exclusion_patterns,
        "enable_duplication_check": request.enable_duplication_check,
        "duplication_threshold": request.duplication_threshold,
        "enable_pagespeed": request.enable_pagespeed,
    }
    if request.directory:
        task["directory"] = request.directory
    return task


def run_response(run: CrawlRun, page_speed_count: int | None = None) -> AuditRunResponse:
    status = normalized_audit_run_status(run.status)
    summary = (
        AuditSummary.model_validate(run.summary or {})
        if status in {"completed", "recalculating"} and run.summary
        else None
    )
    config = run.config_snapshot or {}
    discovered = run.discovered or 0
    processed = run.processed or 0
    selected = run.selected or 0
    page_speed_enabled = bool(config.get("enable_pagespeed"))
    if not page_speed_enabled:
        page_speed = AuditPageSpeedState(
            configured=False,
            status="disabled",
            message="本次审计未启用 PageSpeed",
        )
    elif page_speed_count is None and status not in {"completed", "failed"}:
        page_speed = AuditPageSpeedState(
            configured=True,
            status="running" if status == "running" else "pending",
            message="PageSpeed 将在页面抓取后执行",
        )
    elif (page_speed_count or 0) > 0:
        page_speed = AuditPageSpeedState(
            configured=True,
            status="completed",
            message=f"已完成 {page_speed_count} 条 PageSpeed 分析",
        )
    else:
        page_speed = AuditPageSpeedState(
            configured=True,
            status="failed" if status == "failed" else "pending",
            message="尚无 PageSpeed 分析结果",
        )
    return AuditRunResponse(
        run_id=run.run_id,
        project_id=run.project_id,
        status=status,
        stage=run.stage or status,
        message=run.message or default_status_message(status),
        progress=progress_percentage(
            run.stage or "",
            discovered,
            processed,
            status,
            config.get("max_pages"),
        ),
        discovered=discovered,
        processed=processed,
        selected=selected,
        created_at=run.created_at,
        completed_at=run.finished_at,
        can_resume=bool(run.can_resume),
        archived_at=run.archived_at,
        summary=summary,
        pagespeed=page_speed,
        issue_exclusion_patterns=list(config.get("issue_exclusion_patterns") or []),
    )


def checkpoint_activity_item(sequence: int, value: dict[str, Any]) -> AuditActivityItem:
    fetched_at = value.get("fetched_at")
    return AuditActivityItem(
        sequence=sequence,
        url=str(value.get("url") or ""),
        final_url=str(value.get("final_url") or value.get("url") or ""),
        status_code=optional_int(value.get("status_code")),
        title=str(value.get("title") or ""),
        error=str(value.get("error") or ""),
        error_type=str(value.get("error_type") or ""),
        depth=optional_int(value.get("depth")),
        rendered=bool(value.get("rendered")),
        response_time_ms=optional_int(value.get("response_time_ms")),
        fetched_at=parse_datetime(fetched_at),
    )


def checkpoint_values(checkpoint: dict[str, Any] | None, key: str) -> list[dict[str, Any]]:
    if not isinstance(checkpoint, dict):
        return []
    values = checkpoint.get(key)
    if not isinstance(values, list):
        return []
    return [value for value in values if isinstance(value, dict)]


def checkpoint_issues(checkpoint: dict[str, Any] | None) -> list[Any]:
    return [
        SimpleNamespace(
            id=index + 1,
            page_id=None,
            url=str(value.get("url") or ""),
            severity=str(value.get("type") or "notice"),
            category=str(value.get("category") or ""),
            code=str(value.get("code") or ""),
            issue=str(value.get("issue") or ""),
            details=str(value.get("details") or ""),
            related_url=str(value.get("related_url") or "") or None,
            similarity=float(value.get("similarity") or 0),
        )
        for index, value in enumerate(checkpoint_values(checkpoint, "issues"))
    ]


def checkpoint_page_responses(
    checkpoint: dict[str, Any] | None,
    search: str,
    status_code: int | None,
    status_family: str | None,
) -> list[AuditPageResponse]:
    issue_counts: dict[str, int] = {}
    for issue in checkpoint_values(checkpoint, "issues"):
        issue_url = str(issue.get("url") or "")
        issue_counts[issue_url] = issue_counts.get(issue_url, 0) + 1

    items: list[AuditPageResponse] = []
    search_value = search.strip().lower()
    for index, value in enumerate(checkpoint_values(checkpoint, "pages")):
        item_status = optional_int(value.get("status_code"))
        if status_code is not None and item_status != status_code:
            continue
        if not status_matches_family(item_status, status_family):
            continue
        requested_url = str(value.get("url") or "")
        final_url = str(value.get("final_url") or requested_url)
        title = str(value.get("title") or "")
        if search_value and search_value not in f"{final_url} {title}".lower():
            continue
        robots = str(value.get("robots") or "")
        item_id = checkpoint_item_id("page", final_url or requested_url, index)
        items.append(
            AuditPageResponse(
                id=item_id,
                url=requested_url,
                final_url=final_url,
                status_code=item_status,
                title=title,
                description=str(value.get("description") or ""),
                content_type=str(value.get("content_type") or ""),
                indexable=(
                    None
                    if item_status in {None, 0}
                    else "noindex" not in robots.lower()
                ),
                word_count=optional_int(value.get("word_count")),
                response_time_ms=optional_int(value.get("response_time_ms")),
                rendered=bool(value.get("rendered")),
                issues_count=issue_counts.get(requested_url, 0)
                + (
                    issue_counts.get(final_url, 0)
                    if final_url != requested_url
                    else 0
                ),
                depth=optional_int(value.get("depth")),
                canonical=str(value.get("canonical") or ""),
                h1=dict_list(value.get("h1")),
                h2=dict_list(value.get("h2")),
                h3=dict_list(value.get("h3")),
                headings=dict_list(value.get("headings")),
                meta_tags=string_dict(value.get("meta_tags")),
                size_bytes=optional_int(value.get("size_bytes")) or 0,
                language=str(value.get("language") or ""),
                charset=str(value.get("charset") or ""),
                viewport=str(value.get("viewport") or ""),
                robots=robots,
                author=str(value.get("author") or ""),
                keywords=str(value.get("keywords") or ""),
                generator=str(value.get("generator") or ""),
                theme_color=str(value.get("theme_color") or ""),
                open_graph=string_dict(value.get("open_graph")),
                twitter_tags=string_dict(value.get("twitter_tags")),
                structured_data=object_list(value.get("structured_data")),
                schema_org=object_list(value.get("schema_microdata")),
                analytics=object_dict(value.get("analytics")),
                images=object_list(value.get("images")),
                broken_images=object_list(value.get("broken_images")),
                internal_links=optional_int(value.get("internal_links")) or 0,
                external_links=optional_int(value.get("external_links")) or 0,
                hreflang=object_list(value.get("hreflang")),
                redirects=object_list(value.get("redirects")),
                linked_from=dict_list(value.get("linked_from")),
                discovered_from=str(value.get("discovered_from") or ""),
                error=str(value.get("error") or ""),
                error_type=str(value.get("error_type") or ""),
                raw=value,
            )
        )
    items.sort(key=lambda item: (item.depth or 0, item.final_url))
    return items


def checkpoint_link_responses(
    checkpoint: dict[str, Any] | None,
    search: str,
    internal: bool | None,
    status_family: str | None,
) -> list[AuditLinkResponse]:
    items: list[AuditLinkResponse] = []
    search_value = search.strip().lower()
    sequence = 0
    for page in checkpoint_values(checkpoint, "pages"):
        source_url = str(page.get("final_url") or page.get("url") or "")
        links = page.get("links")
        if not isinstance(links, list):
            continue
        for value in links:
            if not isinstance(value, dict):
                continue
            is_internal = bool(value.get("is_internal"))
            if internal is not None and is_internal != internal:
                continue
            target_url = str(value.get("url") or "")
            anchor_text = str(value.get("text") or "")
            if search_value and search_value not in (
                f"{source_url} {target_url} {anchor_text}".lower()
            ):
                continue
            target_status = optional_int(value.get("target_status"))
            if not status_matches_family(target_status, status_family):
                continue
            rel = str(value.get("rel") or "")
            rel_values = {item.lower() for item in rel.split()}
            items.append(
                AuditLinkResponse(
                    id=checkpoint_item_id(
                        "link",
                        f"{source_url}\x1f{target_url}",
                        sequence,
                    ),
                    source_url=source_url,
                    target_url=target_url,
                    anchor_text=anchor_text,
                    status_code=target_status,
                    kind=str(value.get("placement") or "body"),
                    internal=is_internal,
                    follow="nofollow" not in rel_values,
                    error=(
                        f"HTTP {target_status}"
                        if target_status is not None and target_status >= 400
                        else ""
                    ),
                    placement=str(value.get("placement") or "body"),
                    target_domain=str(value.get("target_domain") or ""),
                    rel=rel,
                    in_navigation=bool(value.get("in_navigation")),
                    raw=value,
                )
            )
            sequence += 1
    items.sort(key=lambda item: (item.source_url, item.target_url))
    return items


def checkpoint_external_resource_responses(
    checkpoint: dict[str, Any] | None,
    search: str,
    status_family: str | None,
) -> list[AuditExternalResourceResponse]:
    search_value = search.strip().lower()
    items: list[AuditExternalResourceResponse] = []
    for index, value in enumerate(checkpoint_values(checkpoint, "external_resources")):
        status_code = optional_int(value.get("status_code"))
        if not status_matches_family(status_code, status_family):
            continue
        url = str(value.get("url") or "")
        final_url = str(value.get("final_url") or url)
        title = str(value.get("title") or "")
        content_type = str(value.get("content_type") or "")
        if search_value and search_value not in (
            f"{url} {final_url} {title} {content_type}".lower()
        ):
            continue
        items.append(
            AuditExternalResourceResponse(
                id=checkpoint_item_id("resource", url, index),
                url=url,
                final_url=final_url,
                status_code=status_code,
                content_type=content_type,
                size_bytes=optional_int(value.get("size_bytes")) or 0,
                title=title,
                error=str(value.get("error") or ""),
                error_type=str(value.get("error_type") or ""),
                checked_at=parse_datetime(value.get("checked_at")),
                raw=value,
            )
        )
    items.sort(key=lambda item: item.url)
    return items


def checkpoint_status_codes(
    checkpoint: dict[str, Any] | None,
) -> list[tuple[int, str, int]]:
    counts: dict[tuple[int, str], int] = {}
    for value in checkpoint_values(checkpoint, "pages"):
        status_code = optional_int(value.get("status_code")) or 0
        error_type = str(value.get("error_type") or "")
        key = (status_code, error_type)
        counts[key] = counts.get(key, 0) + 1
    return [
        (status_code, error_type, count)
        for (status_code, error_type), count in counts.items()
    ]


def checkpoint_visualization(
    checkpoint: dict[str, Any] | None,
) -> AuditVisualizationResponse:
    all_pages = checkpoint_page_responses(checkpoint, "", None, None)
    pages = sorted(
        all_pages,
        key=lambda page: (
            page.depth if page.depth is not None else 2**31 - 1,
            -page.issues_count,
            page.final_url,
        ),
    )[:VISUALIZATION_NODE_LIMIT]
    node_by_url: dict[str, str] = {}
    nodes: list[AuditVisualizationNode] = []
    for page in pages:
        node_by_url[normalize_graph_url(page.final_url)] = page.id
        nodes.append(
            AuditVisualizationNode(
                id=page.id,
                label=page.title or page.final_url,
                url=page.final_url,
                group=checkpoint_page_group(page),
                depth=page.depth,
                issue_count=page.issues_count,
                raw={"status_code": page.status_code},
            )
        )
    all_links = checkpoint_link_responses(checkpoint, "", True, None)
    edges: list[AuditVisualizationEdge] = []
    renderable_edge_count = 0
    for link in all_links:
        source = node_by_url.get(normalize_graph_url(link.source_url))
        target = node_by_url.get(normalize_graph_url(link.target_url))
        if not source or not target:
            continue
        renderable_edge_count += 1
        if len(edges) < VISUALIZATION_EDGE_LIMIT:
            edges.append(
                AuditVisualizationEdge(
                    id=link.id,
                    source=source,
                    target=target,
                    label=link.placement,
                    raw={"anchor_text": link.anchor_text},
                )
            )
    return AuditVisualizationResponse(
        nodes=nodes,
        edges=edges,
        total_nodes=len(all_pages),
        total_edges=len(all_links),
        truncated=(
            len(all_pages) > len(nodes)
            or renderable_edge_count > len(edges)
        ),
    )


def external_resource_response(item: ExternalResource) -> AuditExternalResourceResponse:
    return AuditExternalResourceResponse(
        id=str(item.id),
        url=item.url,
        final_url=item.final_url or item.url,
        status_code=item.status_code,
        content_type=item.content_type or "",
        size_bytes=item.size_bytes or 0,
        title=item.title or "",
        error=item.error or "",
        error_type=item.error_type or "",
        checked_at=item.checked_at,
        raw={},
    )


def checkpoint_item_id(kind: str, value: str, index: int) -> str:
    digest = hashlib.sha256(f"{kind}\x1f{value}\x1f{index}".encode()).hexdigest()[:16]
    return f"checkpoint:{kind}:{digest}"


def status_matches_family(status_code: int | None, status_family: str | None) -> bool:
    if status_family is None:
        return True
    if status_family == "unknown":
        return status_code in {None, 0}
    if status_code is None:
        return False
    lower_bound = int(status_family[0]) * 100
    return lower_bound <= status_code < lower_bound + 100


def dict_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value]


def object_list(value: Any) -> list[dict]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def string_dict(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(key): str(item) for key, item in value.items()}


def object_dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def checkpoint_page_group(page: AuditPageResponse) -> str:
    if page.status_code in {None, 0} or (page.status_code or 0) >= 400:
        return "error"
    if page.depth == 0:
        return "homepage"
    return "page"


def optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None


def parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def page_response(snapshot: PageSnapshot, issue_count: int) -> AuditPageResponse:
    robots = (snapshot.robots or "").lower()
    indexable = None if snapshot.status_code == 0 else "noindex" not in robots
    return AuditPageResponse(
        id=str(snapshot.page_id),
        url=snapshot.requested_url,
        final_url=snapshot.final_url,
        status_code=snapshot.status_code,
        title=snapshot.title or "",
        description=snapshot.description or "",
        content_type=snapshot.content_type or "",
        indexable=indexable,
        word_count=snapshot.word_count,
        response_time_ms=snapshot.response_time_ms,
        rendered=snapshot.rendered,
        issues_count=issue_count,
        depth=snapshot.depth,
        canonical=snapshot.canonical or "",
        h1=snapshot.h1 or [],
        h2=snapshot.h2 or [],
        h3=snapshot.h3 or [],
        headings=snapshot.headings or [],
        meta_tags=snapshot.meta_tags or {},
        size_bytes=snapshot.size_bytes or 0,
        language=snapshot.language or "",
        charset=snapshot.charset or "",
        viewport=snapshot.viewport or "",
        robots=snapshot.robots or "",
        author=snapshot.author or "",
        keywords=snapshot.keywords or "",
        generator=snapshot.generator or "",
        theme_color=snapshot.theme_color or "",
        open_graph=snapshot.open_graph or {},
        twitter_tags=snapshot.twitter_tags or {},
        structured_data=snapshot.structured_data or [],
        schema_org=snapshot.schema_org or [],
        analytics=snapshot.analytics or {},
        images=snapshot.images or [],
        broken_images=snapshot.broken_images or [],
        internal_links=snapshot.internal_links or 0,
        external_links=snapshot.external_links or 0,
        hreflang=snapshot.hreflang or [],
        redirects=snapshot.redirects or [],
        linked_from=snapshot.linked_from or [],
        discovered_from=snapshot.discovered_from or "",
        error=snapshot.error or "",
        error_type=snapshot.error_type or "",
        raw={
            "h1": snapshot.h1,
            "h2": snapshot.h2,
            "h3": snapshot.h3,
            "meta_tags": snapshot.meta_tags,
            "open_graph": snapshot.open_graph,
            "twitter_tags": snapshot.twitter_tags,
            "analytics": snapshot.analytics,
            "images": snapshot.images,
            "broken_images": snapshot.broken_images,
            "hreflang": snapshot.hreflang,
            "schema_org": snapshot.schema_org,
            "redirects": snapshot.redirects,
            "linked_from": snapshot.linked_from,
            "charset": snapshot.charset,
            "viewport": snapshot.viewport,
            "error": snapshot.error,
            "error_type": snapshot.error_type,
        },
    )


def link_response(edge: LinkEdge, source_url: str) -> AuditLinkResponse:
    rel_values = {value.lower() for value in (edge.rel or "").split()}
    return AuditLinkResponse(
        id=str(edge.id),
        source_url=source_url,
        target_url=edge.target_url,
        anchor_text=edge.anchor_text or "",
        status_code=edge.target_status,
        kind=edge.placement,
        internal=edge.is_internal,
        follow="nofollow" not in rel_values,
        error=(
            f"HTTP {edge.target_status}"
            if edge.target_status is not None and edge.target_status >= 400
            else ""
        ),
        placement=edge.placement or "body",
        target_domain=edge.target_domain or "",
        rel=edge.rel or "",
        in_navigation=bool(edge.in_navigation),
        raw={"rel": edge.rel or "", "target_domain": edge.target_domain or ""},
    )


def status_code_label(status_code: int, error_type: str) -> str:
    if 200 <= status_code < 300:
        return "成功"
    if 300 <= status_code < 400:
        return "重定向"
    if 400 <= status_code < 500:
        return "客户端错误"
    if status_code >= 500:
        return "服务器错误"
    return {
        "dns_not_found": "DNS 无法解析",
        "connection_refused": "连接被拒绝",
        "timeout": "请求超时",
        "ssl_error": "SSL/TLS 错误",
        "connection_error": "连接错误",
        "file_too_large": "文件过大，已跳过",
    }.get(error_type, "无响应")


def normalize_target_url(value: str) -> str:
    candidate = value.strip()
    if "://" not in candidate:
        candidate = f"https://{candidate}"
    parsed = urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("domain must be a valid HTTP or HTTPS hostname")
    if parsed.username or parsed.password:
        raise ValueError("domain must not contain credentials")
    if parsed.port not in {None, 80, 443}:
        raise ValueError("domain uses an unsupported port")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("domain must not contain a path, query, or fragment")
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    netloc = host if parsed.port is None else f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, "", "", ""))


def normalized_run_status(value: str) -> str:
    if value in {
        "queued",
        "paused",
        "stopping",
        "stopped",
        "recalculating",
        "partial",
        "completed",
        "failed",
    }:
        return value
    return "running"


def normalized_audit_run_status(value: str) -> str:
    status = normalized_run_status(value)
    return "completed" if status == "partial" else status


def normalize_severity(value: str) -> str:
    if value == "error":
        return "error"
    if value == "warning":
        return "warning"
    return "notice"


def progress_percentage(
    stage: str,
    discovered: int,
    processed: int,
    status: str,
    max_pages: int | None = None,
) -> int:
    if status in {"completed", "partial"}:
        return 100
    if status == "recalculating" or stage == "recalculating_issues":
        return 99
    target_pages = max(discovered, 1)
    if isinstance(max_pages, int) and max_pages > 0:
        target_pages = min(target_pages, max_pages)
    crawl_progress = min(
        94,
        20 + round(70 * min(processed, target_pages) / target_pages),
    )
    if status == "failed":
        return min(99, max(0, round(100 * processed / max(discovered, 1))))
    stage_progress = {
        "analyzing_site": 5,
        "discovering_pages": 15,
        "selecting_pages": 91,
        "checking_links": 92,
        "generating_profile": 96,
        "pagespeed": 97,
        "completed": 99,
    }.get(stage)
    if stage_progress is not None:
        return stage_progress
    if stage == "extracting_pages" or status in {"paused", "stopping", "stopped"}:
        return crawl_progress
    return 0


def default_status_message(status: str) -> str:
    return {
        "queued": "技术审计任务已进入队列",
        "running": "正在扫描网站页面",
        "paused": "审计已暂停",
        "stopping": "正在停止审计",
        "stopped": "审计已停止",
        "completed": "技术审计已完成",
        "failed": "技术审计失败",
    }[status]


def issue_recommendation(code: str) -> str:
    recommendations = {
        "missing_title": "为页面添加唯一、准确的 title。",
        "duplicate_title": "让每个页面使用能区分页面主题的 title。",
        "missing_meta_description": "添加能概括页面内容的 meta description。",
        "duplicate_description": "为重复页面编写不同的 meta description。",
        "missing_h1": "为页面添加一个描述主主题的 H1。",
        "broken_image": "修复图片地址、重定向或服务器响应。",
        "duplicate_content": "合并重复页面，或使用 canonical 明确主版本。",
        "slow_response": "检查服务器、缓存、数据库和第三方请求耗时。",
        "large_page": "压缩 HTML 和资源，移除不必要内容。",
    }
    return recommendations.get(code, "根据问题详情修改页面后重新运行审计。")


def page_group(snapshot: PageSnapshot) -> str:
    if snapshot.status_code >= 400 or snapshot.status_code == 0:
        return "error"
    if snapshot.depth == 0:
        return "homepage"
    return "page"


def normalize_graph_url(value: str) -> str:
    return value.rstrip("/") or value


def issue_export_row(
    key: tuple[str, str, str, str, str],
    urls: set[str],
    related_urls: set[str],
    max_similarity: float,
) -> dict[str, Any]:
    code, severity, category, title, details = key
    digest_source = chr(31).join((code, severity, category, title, details))
    return AuditIssueResponse(
        id=f"{code}:{severity}:{hashlib.sha256(digest_source.encode()).hexdigest()[:16]}",
        title=title,
        code=code,
        severity=severity,
        category=category,
        affected_count=len(urls),
        description=details,
        recommendation=issue_recommendation(code),
        urls=sorted(urls),
        raw={
            "related_urls": sorted(related_urls),
            "max_similarity": max_similarity,
        },
    ).model_dump(mode="json")


def export_media_type(format_value: AuditExportFormat) -> str:
    return {
        "csv": "text/csv; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "xml": "application/xml",
    }[format_value]


def export_cell(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


async def stream_export(
    rows: AsyncIterator[dict[str, Any]],
    format_value: AuditExportFormat,
) -> AsyncIterator[bytes]:
    if format_value == "json":
        yield b"[\n"
        first = True
        async for row in rows:
            if not first:
                yield b",\n"
            yield json.dumps(row, ensure_ascii=False, indent=2).encode("utf-8")
            first = False
        yield b"\n]"
        return

    if format_value == "xml":
        yield b"<?xml version='1.0' encoding='utf-8'?>\n<audit>"
        async for row in rows:
            item = Element("item")
            for key, value in row.items():
                child = SubElement(item, key)
                child.text = str(export_cell(value))
            yield tostring(item, encoding="utf-8")
        yield b"</audit>"
        return

    output = io.StringIO()
    output.write("\ufeff")
    writer: csv.DictWriter | None = None
    buffered_rows = 0
    async for row in rows:
        if writer is None:
            writer = csv.DictWriter(output, fieldnames=list(row))
            writer.writeheader()
        writer.writerow({key: export_cell(value) for key, value in row.items()})
        buffered_rows += 1
        if buffered_rows >= 100:
            yield output.getvalue().encode("utf-8")
            output.seek(0)
            output.truncate(0)
            buffered_rows = 0
    if writer is None:
        output.write("\r\n")
    if output.tell():
        yield output.getvalue().encode("utf-8")


async def write_xlsx_export(rows: AsyncIterator[dict[str, Any]]) -> str:
    temp_file = tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False)
    path = temp_file.name
    temp_file.close()
    try:
        workbook = Workbook(write_only=True)
        worksheet = workbook.create_sheet("Audit")
        fieldnames: list[str] = []
        async for row in rows:
            if not fieldnames:
                fieldnames = list(row)
                worksheet.append(fieldnames)
            worksheet.append([export_cell(row.get(key)) for key in fieldnames])
        workbook.save(path)
        return path
    except Exception:
        if os.path.exists(path):
            os.unlink(path)
        raise


def build_audit_service() -> AuditService:
    settings = get_settings()
    return AuditService(
        settings=settings,
        controller=TemporalWorkflowController(
            settings.crawler_task_queue,
            get_crawler_worker_launcher(),
        ),
        repository=SQLAlchemyAuditRunRepository(session_factory),
        object_cleaner=S3AuditObjectCleaner(settings),
    )
