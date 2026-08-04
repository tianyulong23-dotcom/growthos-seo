from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from urllib.parse import urlsplit
from uuid import uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.audit.object_storage import (
    AuditObjectCleaner,
    NoopAuditObjectCleaner,
    S3AuditObjectCleaner,
)
from app.modules.audit.service import (
    TemporalWorkflowController,
    normalized_audit_run_status,
    normalized_run_status,
    progress_percentage,
)
from app.modules.crawling.models import CrawlRun, Page
from app.modules.keywords.models import KeywordBuildRun, KeywordWorkflowDispatch
from app.modules.keywords.service import (
    KeywordBootstrapRecord,
    build_initial_keyword_bootstrap,
    keyword_dispatch_from_bootstrap,
    keyword_run_from_bootstrap,
)
from app.modules.projects.models import (
    Project,
    SiteProfile,
    SiteProfileOperation,
    WorkflowDispatch,
)
from app.modules.projects.object_storage import (
    S3SiteIconReader,
    SiteIconReader,
    StoredSiteIcon,
)
from app.modules.projects.schemas import (
    BusinessProfileRunResponse,
    CreateProjectRequest,
    ProjectResponse,
    UpdateBusinessProfileRequest,
)
from app.workflows.worker import get_crawler_worker_launcher

logger = logging.getLogger(__name__)


class ProjectAlreadyExistsError(Exception):
    pass


class ProjectLaunchError(Exception):
    pass


class ProjectNotFoundError(Exception):
    pass


class ProjectDeleteError(Exception):
    pass


class SiteProfileNotReadyError(Exception):
    pass


class SiteUnderstandingAlreadyRunningError(Exception):
    pass


class SiteIconNotFoundError(Exception):
    pass


COUNTRY_ALIASES = {
    "美国": "US",
    "英国": "GB",
    "中国": "CN",
}

LANGUAGE_ALIASES = {
    "英语": "en",
    "简体中文": "zh-Hans",
    "繁体中文": "zh-Hant",
}


class WorkflowLauncher(Protocol):
    async def start(self, task: dict[str, Any], workflow_id: str) -> None: ...

    async def cancel(self, workflow_id: str) -> None: ...


@dataclass(frozen=True)
class ProjectRecord:
    id: str
    organization_id: str
    name: str
    domain: str
    country: str
    language: str
    competitor_domain: str | None
    understanding_run_id: str | None
    understanding_status: str | None
    understanding_stage: str | None
    understanding_message: str | None
    understanding_discovered: int
    understanding_processed: int
    understanding_attempt: int
    understanding_started_at: datetime | None
    understanding_finished_at: datetime | None
    audit_run_id: str | None
    audit_status: str | None
    audit_workflow_id: str | None
    audit_health: int | None
    site_profile: dict[str, Any] | None
    site_profile_user_overrides: dict[str, Any]
    site_profile_confidence: float | None
    site_profile_source_run_id: str | None
    created_at: datetime


@dataclass(frozen=True)
class BusinessProfileRunRecord:
    run_id: str
    attempt: int
    status: str
    stage: str | None
    message: str | None
    discovered: int
    processed: int
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime


@dataclass(frozen=True)
class WorkflowDispatchRecord:
    run_id: str
    workflow_id: str
    task_payload: dict[str, Any]


class ProjectRepository(Protocol):
    async def create_with_understanding_run(
        self,
        project: ProjectRecord,
        run: CrawlRun,
        dispatch: WorkflowDispatchRecord,
        keyword_bootstrap: KeywordBootstrapRecord,
    ) -> None: ...

    async def list(self, organization_id: str) -> list[ProjectRecord]: ...

    async def get(
        self,
        organization_id: str,
        project_id: str,
    ) -> ProjectRecord | None: ...

    async def start_understanding_run(
        self,
        organization_id: str,
        project_id: str,
        run: CrawlRun,
        dispatch: WorkflowDispatchRecord,
    ) -> ProjectRecord: ...

    async def list_pending_dispatches(
        self,
        limit: int,
    ) -> list[WorkflowDispatchRecord]: ...

    async def mark_dispatch_succeeded(self, run_id: str) -> None: ...

    async def record_dispatch_failure(self, run_id: str, message: str) -> None: ...

    async def update_business_profile(
        self,
        organization_id: str,
        project_id: str,
        updates: dict[str, Any],
    ) -> ProjectRecord: ...

    async def update_business_profile_once(
        self,
        organization_id: str,
        project_id: str,
        updates: dict[str, Any],
        operation_id: str,
        parameters_hash: str,
        expected_before: dict[str, Any],
    ) -> tuple[ProjectRecord, bool]: ...

    async def list_understanding_runs(
        self,
        organization_id: str,
        project_id: str,
        limit: int,
    ) -> list[BusinessProfileRunRecord]: ...

    async def get_understanding_run(
        self,
        organization_id: str,
        project_id: str,
        run_id: str,
    ) -> BusinessProfileRunRecord | None: ...

    async def active_keyword_workflow_ids(
        self,
        organization_id: str,
        project_id: str,
    ) -> list[str]: ...

    async def delete(
        self,
        organization_id: str,
        project_id: str,
    ) -> bool: ...


class SQLAlchemyProjectRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    async def create_with_understanding_run(
        self,
        project: ProjectRecord,
        run: CrawlRun,
        dispatch: WorkflowDispatchRecord,
        keyword_bootstrap: KeywordBootstrapRecord,
    ) -> None:
        async with self.sessions() as session:
            session.add(
                Project(
                    id=project.id,
                    organization_id=project.organization_id,
                    name=project.name,
                    domain=project.domain,
                    country=project.country,
                    language=project.language,
                    competitor_domain=project.competitor_domain,
                    health=0,
                    initial_crawl_run_id=project.understanding_run_id,
                    understanding_run_id=project.understanding_run_id,
                    audit_run_id=project.audit_run_id,
                    audit_health=project.audit_health,
                    created_at=project.created_at,
                )
            )
            session.add(run)
            try:
                # Persist parent rows before the keyword outbox rows that
                # reference them. These models do not declare ORM relationships,
                # so SQLAlchemy cannot infer the required flush order.
                await session.flush()
            except IntegrityError as exc:
                await session.rollback()
                if is_project_domain_conflict(exc):
                    raise ProjectAlreadyExistsError from exc
                raise

            session.add(
                WorkflowDispatch(
                    run_id=dispatch.run_id,
                    workflow_id=dispatch.workflow_id,
                    task_payload=dispatch.task_payload,
                    status="pending",
                )
            )
            session.add(keyword_run_from_bootstrap(keyword_bootstrap))
            session.add(keyword_dispatch_from_bootstrap(keyword_bootstrap))
            try:
                await session.commit()
            except IntegrityError as exc:
                await session.rollback()
                if is_project_domain_conflict(exc):
                    raise ProjectAlreadyExistsError from exc
                raise

    async def list(self, organization_id: str) -> list[ProjectRecord]:
        async with self.sessions() as session:
            rows = (await session.execute(project_query(organization_id))).all()
            return [project_record_from_row(row) for row in rows]

    async def get(
        self,
        organization_id: str,
        project_id: str,
    ) -> ProjectRecord | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    project_query(organization_id).where(Project.id == project_id)
                )
            ).first()
            return project_record_from_row(row) if row is not None else None

    async def start_understanding_run(
        self,
        organization_id: str,
        project_id: str,
        run: CrawlRun,
        dispatch: WorkflowDispatchRecord,
    ) -> ProjectRecord:
        async with self.sessions() as session:
            project = await session.scalar(
                select(Project)
                .where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                )
                .with_for_update()
            )
            if project is None:
                raise ProjectNotFoundError
            existing_same_run = False
            if project.understanding_run_id:
                current_run = await session.scalar(
                    select(CrawlRun).where(
                        CrawlRun.run_id == project.understanding_run_id,
                        CrawlRun.organization_id == organization_id,
                        CrawlRun.project_id == project_id,
                    )
                )
                existing_same_run = (
                    current_run is not None
                    and current_run.run_id == run.run_id
                    and current_run.task_type == "site_understanding"
                )
                if not existing_same_run and current_run is not None and (
                    current_run.status in {"queued", "running"}
                ):
                    raise SiteUnderstandingAlreadyRunningError
            if not existing_same_run:
                session.add(run)
                session.add(
                    WorkflowDispatch(
                        run_id=dispatch.run_id,
                        workflow_id=dispatch.workflow_id,
                        task_payload=dispatch.task_payload,
                        status="pending",
                    )
                )
                project.understanding_run_id = run.run_id
                project.country = run.country or project.country
                project.language = run.language or project.language
                await session.commit()

        updated = await self.get(organization_id, project_id)
        if updated is None:
            raise ProjectNotFoundError
        return updated

    async def list_pending_dispatches(
        self,
        limit: int,
    ) -> list[WorkflowDispatchRecord]:
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(
                        WorkflowDispatch.run_id,
                        WorkflowDispatch.workflow_id,
                        WorkflowDispatch.task_payload,
                    )
                    .join(CrawlRun, CrawlRun.run_id == WorkflowDispatch.run_id)
                    .where(
                        WorkflowDispatch.status == "pending",
                        WorkflowDispatch.next_attempt_at <= datetime.now(UTC),
                        CrawlRun.task_type == "site_understanding",
                    )
                    .order_by(WorkflowDispatch.created_at, WorkflowDispatch.run_id)
                    .limit(max(1, min(limit, 100)))
                )
            ).all()
        return [
            WorkflowDispatchRecord(
                run_id=row.run_id,
                workflow_id=row.workflow_id,
                task_payload=dict(row.task_payload),
            )
            for row in rows
        ]

    async def mark_dispatch_succeeded(self, run_id: str) -> None:
        async with self.sessions() as session:
            dispatch = await session.get(WorkflowDispatch, run_id)
            if dispatch is None:
                return
            dispatch.status = "dispatched"
            dispatch.last_error = None
            dispatch.dispatched_at = datetime.now(UTC)
            dispatch.updated_at = datetime.now(UTC)
            await session.commit()

    async def record_dispatch_failure(self, run_id: str, message: str) -> None:
        async with self.sessions() as session:
            dispatch = await session.scalar(
                select(WorkflowDispatch).where(WorkflowDispatch.run_id == run_id).with_for_update()
            )
            if dispatch is None or dispatch.status != "pending":
                return
            dispatch.attempts += 1
            dispatch.last_error = message
            retry_delay = min(60, 2 ** min(dispatch.attempts, 6))
            dispatch.next_attempt_at = datetime.now(UTC) + timedelta(seconds=retry_delay)
            dispatch.updated_at = datetime.now(UTC)
            run = await session.get(CrawlRun, run_id)
            if run is not None and run.status == "queued":
                run.message = "任务已保存，等待网站识别服务恢复后自动重试"
                run.updated_at = datetime.now(UTC)
            await session.commit()

    async def update_business_profile(
        self,
        organization_id: str,
        project_id: str,
        updates: dict[str, Any],
    ) -> ProjectRecord:
        async with self.sessions() as session:
            project = await session.scalar(
                select(Project).where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                )
            )
            if project is None:
                raise ProjectNotFoundError

            site_profile = await session.get(SiteProfile, project_id)
            if site_profile is None:
                raise SiteProfileNotReadyError

            profile_json = dict(site_profile.profile_json)
            profile_json.update(updates)
            site_profile.profile_json = profile_json
            user_overrides = dict(site_profile.user_overrides or {})
            user_overrides.update(updates)
            site_profile.user_overrides = user_overrides
            await session.commit()

        updated = await self.get(organization_id, project_id)
        if updated is None:
            raise ProjectNotFoundError
        return updated

    async def update_business_profile_once(
        self,
        organization_id: str,
        project_id: str,
        updates: dict[str, Any],
        operation_id: str,
        parameters_hash: str,
        expected_before: dict[str, Any],
    ) -> tuple[ProjectRecord, bool]:
        already_completed = False
        async with self.sessions() as session:
            project = await session.scalar(
                select(Project).where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                ).with_for_update()
            )
            if project is None:
                raise ProjectNotFoundError
            site_profile = await session.scalar(
                select(SiteProfile).where(SiteProfile.project_id == project_id).with_for_update()
            )
            if site_profile is None:
                raise SiteProfileNotReadyError
            operation = await session.get(SiteProfileOperation, operation_id)
            if operation is not None:
                if (
                    operation.project_id != project_id
                    or operation.operation_type != "update_business_profile"
                    or operation.parameters_hash != parameters_hash
                ):
                    raise RuntimeError("操作编号与原始参数不一致")
                already_completed = True
            else:
                profile_json = dict(site_profile.profile_json)
                if any(profile_json.get(key) != value for key, value in expected_before.items()):
                    raise RuntimeError("项目状态已经变化，请重新发起操作")
                profile_json.update(updates)
                site_profile.profile_json = profile_json
                user_overrides = dict(site_profile.user_overrides or {})
                user_overrides.update(updates)
                site_profile.user_overrides = user_overrides
                session.add(SiteProfileOperation(
                    operation_id=operation_id,
                    project_id=project_id,
                    operation_type="update_business_profile",
                    parameters_hash=parameters_hash,
                    result_json={"changes": updates},
                ))
            await session.commit()

        updated = await self.get(organization_id, project_id)
        if updated is None:
            raise ProjectNotFoundError
        return updated, already_completed

    async def list_understanding_runs(
        self,
        organization_id: str,
        project_id: str,
        limit: int,
    ) -> list[BusinessProfileRunRecord]:
        runs = understanding_runs_query(organization_id).subquery()
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(runs)
                    .where(runs.c.project_id == project_id)
                    .order_by(runs.c.attempt.desc())
                    .limit(limit)
                )
            ).all()
        return [
            BusinessProfileRunRecord(
                run_id=row.run_id,
                attempt=row.attempt,
                status=row.status,
                stage=row.stage,
                message=row.message,
                discovered=row.discovered or 0,
                processed=row.processed or 0,
                started_at=row.started_at,
                finished_at=row.finished_at,
                created_at=row.created_at,
            )
            for row in rows
        ]

    async def get_understanding_run(
        self,
        organization_id: str,
        project_id: str,
        run_id: str,
    ) -> BusinessProfileRunRecord | None:
        runs = understanding_runs_query(organization_id).subquery()
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(runs).where(
                        runs.c.project_id == project_id,
                        runs.c.run_id == run_id,
                    )
                )
            ).first()
        if row is None:
            return None
        return BusinessProfileRunRecord(
            run_id=row.run_id,
            attempt=row.attempt,
            status=row.status,
            stage=row.stage,
            message=row.message,
            discovered=row.discovered or 0,
            processed=row.processed or 0,
            started_at=row.started_at,
            finished_at=row.finished_at,
            created_at=row.created_at,
        )

    async def active_keyword_workflow_ids(
        self,
        organization_id: str,
        project_id: str,
    ) -> list[str]:
        async with self.sessions() as session:
            workflow_ids = await session.scalars(
                select(KeywordWorkflowDispatch.workflow_id)
                .join(
                    KeywordBuildRun,
                    KeywordBuildRun.id == KeywordWorkflowDispatch.run_id,
                )
                .where(
                    KeywordBuildRun.organization_id == organization_id,
                    KeywordBuildRun.project_id == project_id,
                    KeywordBuildRun.status.in_(("queued", "running", "waiting")),
                    KeywordWorkflowDispatch.status == "dispatched",
                )
            )
            return list(workflow_ids.all())

    async def delete(
        self,
        organization_id: str,
        project_id: str,
    ) -> bool:
        async with self.sessions() as session:
            project = await session.scalar(
                select(Project)
                .where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                )
                .with_for_update()
            )
            if project is None:
                return False

            await session.execute(
                delete(CrawlRun).where(
                    CrawlRun.organization_id == organization_id,
                    CrawlRun.project_id == project_id,
                )
            )
            await session.execute(
                delete(Page).where(
                    Page.organization_id == organization_id,
                    Page.project_id == project_id,
                )
            )
            await session.delete(project)
            await session.commit()
            return True


class ProjectService:
    def __init__(
        self,
        settings: Settings,
        launcher: WorkflowLauncher,
        repository: ProjectRepository,
        site_icon_reader: SiteIconReader,
        object_cleaner: AuditObjectCleaner | None = None,
    ) -> None:
        self.settings = settings
        self.launcher = launcher
        self.repository = repository
        self.site_icon_reader = site_icon_reader
        self.object_cleaner = object_cleaner or NoopAuditObjectCleaner()

    async def create(self, request: CreateProjectRequest) -> ProjectResponse:
        domain = normalize_domain(request.domain)
        country = normalize_country(request.country)
        language = normalize_language(request.language)
        competitor_domain = (
            normalize_domain(request.competitor_domain) if request.competitor_domain else None
        )
        if competitor_domain == domain:
            raise ValueError("竞争对手不能与当前网站相同")
        project_id = str(uuid4())
        run_id = str(uuid4())
        created_at = datetime.now(UTC)
        project = ProjectRecord(
            id=project_id,
            organization_id=self.settings.default_organization_id,
            name=project_name_from_domain(domain),
            domain=domain,
            country=country,
            language=language,
            competitor_domain=competitor_domain,
            understanding_run_id=run_id,
            understanding_status="queued",
            understanding_stage="queued",
            understanding_message="网站业务识别任务已进入队列",
            understanding_discovered=0,
            understanding_processed=0,
            understanding_attempt=1,
            understanding_started_at=None,
            understanding_finished_at=None,
            audit_run_id=None,
            audit_status=None,
            audit_workflow_id=None,
            audit_health=None,
            site_profile=None,
            site_profile_user_overrides={},
            site_profile_confidence=None,
            site_profile_source_run_id=None,
            created_at=created_at,
        )
        run = CrawlRun(
            run_id=run_id,
            organization_id=project.organization_id,
            project_id=project.id,
            task_type="site_understanding",
            target_url=f"https://{domain}",
            country=project.country,
            language=project.language,
            status="queued",
            stage="queued",
            message="网站业务识别任务已进入队列",
            created_at=created_at,
        )
        task = build_site_understanding_task(project, run_id)
        dispatch = WorkflowDispatchRecord(
            run_id=run_id,
            workflow_id=f"crawler:site_understanding:{project.id}:{run_id}",
            task_payload=task,
        )
        keyword_bootstrap = build_initial_keyword_bootstrap(
            organization_id=project.organization_id,
            project_id=project.id,
            created_at=created_at,
        )
        await self.repository.create_with_understanding_run(
            project,
            run,
            dispatch,
            keyword_bootstrap,
        )
        await self._dispatch(dispatch)
        current = await self.repository.get(project.organization_id, project.id)
        return build_project_response(current or project)

    async def list(self) -> list[ProjectResponse]:
        projects = await self.repository.list(self.settings.default_organization_id)
        return [build_project_response(project) for project in deduplicate_projects(projects)]

    async def get(self, project_id: str) -> ProjectResponse | None:
        project = await self.repository.get(
            self.settings.default_organization_id,
            project_id,
        )
        return build_project_response(project) if project is not None else None

    async def update_business_profile(
        self,
        project_id: str,
        request: UpdateBusinessProfileRequest,
    ) -> ProjectResponse:
        updates = request.model_dump()
        updates["business_name"] = (
            project_display_name(request.business_name) or request.business_name
        )
        updates["confirmed_at"] = datetime.now(UTC).isoformat()
        project = await self.repository.update_business_profile(
            self.settings.default_organization_id,
            project_id,
            updates,
        )
        return build_project_response(project)

    async def update_business_profile_once(
        self,
        project_id: str,
        request: UpdateBusinessProfileRequest,
        operation_id: str,
        parameters_hash: str,
        expected_before: dict[str, Any],
    ) -> tuple[ProjectResponse, bool]:
        updates = request.model_dump()
        updates["business_name"] = (
            project_display_name(request.business_name) or request.business_name
        )
        updates["confirmed_at"] = datetime.now(UTC).isoformat()
        project, already_completed = await self.repository.update_business_profile_once(
            self.settings.default_organization_id,
            project_id,
            updates,
            operation_id,
            parameters_hash,
            expected_before,
        )
        return build_project_response(project), already_completed

    async def list_business_profile_runs(
        self,
        project_id: str,
        limit: int = 10,
    ) -> list[BusinessProfileRunResponse]:
        project = await self.repository.get(
            self.settings.default_organization_id,
            project_id,
        )
        if project is None:
            raise ProjectNotFoundError
        runs = await self.repository.list_understanding_runs(
            self.settings.default_organization_id,
            project_id,
            max(1, min(limit, 50)),
        )
        return [build_business_profile_run_response(run) for run in runs]

    async def get_business_profile_run(
        self,
        project_id: str,
        run_id: str,
    ) -> BusinessProfileRunResponse | None:
        run = await self.repository.get_understanding_run(
            self.settings.default_organization_id,
            project_id,
            run_id,
        )
        return build_business_profile_run_response(run) if run is not None else None

    async def get_site_icon(self, project_id: str) -> StoredSiteIcon:
        project = await self.repository.get(
            self.settings.default_organization_id,
            project_id,
        )
        if project is None:
            raise ProjectNotFoundError
        if not project.site_profile_source_run_id:
            raise SiteIconNotFoundError
        icon = await self.site_icon_reader.read_site_icon(
            self.settings.default_organization_id,
            project_id,
            project.site_profile_source_run_id,
        )
        if icon is None:
            raise SiteIconNotFoundError
        return icon

    async def refresh_business_profile(
        self,
        project_id: str,
        operation_id: str | None = None,
    ) -> ProjectResponse:
        project = await self.repository.get(
            self.settings.default_organization_id,
            project_id,
        )
        if project is None:
            raise ProjectNotFoundError

        run_id = operation_id or str(uuid4())
        created_at = datetime.now(UTC)
        country = normalize_country(project.country)
        language = normalize_language(project.language)
        run = CrawlRun(
            run_id=run_id,
            organization_id=project.organization_id,
            project_id=project.id,
            task_type="site_understanding",
            target_url=f"https://{project.domain}",
            country=country,
            language=language,
            status="queued",
            stage="queued",
            message="网站业务重新识别任务已进入队列",
            created_at=created_at,
        )
        task = build_site_understanding_task(project, run_id)
        dispatch = WorkflowDispatchRecord(
            run_id=run_id,
            workflow_id=f"crawler:site_understanding:{project.id}:{run_id}",
            task_payload=task,
        )
        project = await self.repository.start_understanding_run(
            project.organization_id,
            project.id,
            run,
            dispatch,
        )
        await self._dispatch(dispatch)
        current = await self.repository.get(project.organization_id, project.id)
        return build_project_response(current or project)

    async def dispatch_pending_workflows(self, limit: int = 20) -> int:
        dispatched = 0
        for dispatch in await self.repository.list_pending_dispatches(limit):
            if await self._dispatch(dispatch):
                dispatched += 1
        return dispatched

    async def _dispatch(self, dispatch: WorkflowDispatchRecord) -> bool:
        try:
            await self.launcher.start(
                dispatch.task_payload,
                workflow_id=dispatch.workflow_id,
            )
        except Exception as exc:
            logger.warning(
                "Unable to dispatch site understanding workflow",
                extra={"run_id": dispatch.run_id},
                exc_info=exc,
            )
            await self.repository.record_dispatch_failure(
                dispatch.run_id,
                "网站识别任务服务暂时不可用",
            )
            return False
        await self.repository.mark_dispatch_succeeded(dispatch.run_id)
        return True

    async def delete(self, project_id: str) -> None:
        project = await self.repository.get(
            self.settings.default_organization_id,
            project_id,
        )
        if project is None:
            raise ProjectNotFoundError

        keyword_workflow_ids = await self.repository.active_keyword_workflow_ids(
            project.organization_id,
            project.id,
        )
        workflow_ids = [*active_project_workflow_ids(project), *keyword_workflow_ids]
        for workflow_id in dict.fromkeys(workflow_ids):
            try:
                await self.launcher.cancel(workflow_id)
            except Exception as exc:
                logger.exception(
                    "project workflow cancellation failed; keeping project",
                    extra={"project_id": project.id, "workflow_id": workflow_id},
                    exc_info=exc,
                )
                raise ProjectDeleteError("无法停止项目正在运行的任务") from exc

        try:
            await self.object_cleaner.delete_project_objects(
                project.organization_id,
                project.id,
            )
        except Exception as exc:
            logger.exception(
                "project object cleanup failed; keeping project",
                extra={"project_id": project.id},
                exc_info=exc,
            )
            raise ProjectDeleteError("项目抓取数据清理失败") from exc

        deleted = await self.repository.delete(
            self.settings.default_organization_id,
            project_id,
        )
        if not deleted:
            raise ProjectNotFoundError


def normalize_domain(value: str) -> str:
    candidate = value.strip().lower()
    if "://" not in candidate:
        candidate = f"https://{candidate}"
    parsed = urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("请输入有效域名，例如 example.com")
    if parsed.username or parsed.password:
        raise ValueError("域名不能包含用户名或密码")
    if parsed.port not in {None, 80, 443}:
        raise ValueError("域名不能使用自定义端口")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("这里只能填写域名，不能包含路径或参数")
    return parsed.hostname.lower().rstrip(".").removeprefix("www.")


def is_project_domain_conflict(exc: IntegrityError) -> bool:
    original = exc.orig
    candidates = (
        original,
        getattr(original, "__cause__", None),
        getattr(original, "__context__", None),
    )
    return any(
        getattr(candidate, "constraint_name", None) == "uq_projects_organization_domain"
        for candidate in candidates
        if candidate is not None
    ) or "uq_projects_organization_domain" in str(original)


def project_name_from_domain(domain: str) -> str:
    base_name = domain.removeprefix("www.").split(".")[0]
    parts = [part for part in base_name.replace("_", "-").split("-") if part]
    return " ".join(part[:1].upper() + part[1:] for part in parts) or domain


def project_display_name(business_name: str) -> str:
    return re.sub(
        r"(?:\s*,\s*|\s+)inc\.?\s*$",
        "",
        business_name.strip(),
        flags=re.IGNORECASE,
    ).strip()


def normalize_country(value: str) -> str:
    normalized = value.strip()
    return COUNTRY_ALIASES.get(normalized, normalized.upper())


def normalize_language(value: str) -> str:
    normalized = value.strip()
    return LANGUAGE_ALIASES.get(normalized, normalized)


def deduplicate_projects(projects: list[ProjectRecord]) -> list[ProjectRecord]:
    selected: dict[str, ProjectRecord] = {}
    order: list[str] = []
    for project in projects:
        canonical_domain = normalize_domain(project.domain)
        current = selected.get(canonical_domain)
        if current is None:
            selected[canonical_domain] = project
            order.append(canonical_domain)
            continue
        if project_value_score(project) > project_value_score(current):
            selected[canonical_domain] = project
    return [selected[domain] for domain in order]


def project_value_score(project: ProjectRecord) -> tuple[int, int, int, datetime]:
    return (
        int(project.site_profile is not None),
        int(project.audit_run_id is not None),
        int(project.understanding_status in {"completed", "partial"}),
        project.created_at,
    )


def active_project_workflow_ids(project: ProjectRecord) -> list[str]:
    workflow_ids: list[str] = []
    if project.understanding_run_id and project.understanding_status in {"queued", "running"}:
        workflow_ids.append(
            f"crawler:site_understanding:{project.id}:{project.understanding_run_id}"
        )
    if project.audit_run_id and project.audit_status in {
        "queued",
        "running",
        "paused",
        "stopping",
    }:
        workflow_ids.append(
            project.audit_workflow_id or f"crawler:technical_audit:{project.audit_run_id}"
        )
    return workflow_ids


def build_site_understanding_task(
    project: ProjectRecord,
    run_id: str,
) -> dict[str, Any]:
    return {
        "organization_id": project.organization_id,
        "project_id": project.id,
        "run_id": run_id,
        "type": "site_understanding",
        "target_url": f"https://{project.domain}",
        "country": normalize_country(project.country),
        "language": normalize_language(project.language),
        "max_pages": 5,
        "scope": "domain",
        "rendering": "auto",
        "ignored_parameters": [
            "utm_*",
            "gclid",
            "fbclid",
            "msclkid",
            "yclid",
        ],
    }


def build_project_response(project: ProjectRecord) -> ProjectResponse:
    understanding_status = (
        normalized_run_status(project.understanding_status)
        if project.understanding_status is not None
        else None
    )
    audit_status = (
        normalized_audit_run_status(project.audit_status)
        if project.audit_run_id is not None and project.audit_status is not None
        else "never_started"
    )
    profile = dict(project.site_profile) if project.site_profile is not None else None
    if profile is not None:
        profile["confidence"] = project.site_profile_confidence or profile.get(
            "confidence",
            0,
        )
        user_overridden_fields = sorted(
            key for key in project.site_profile_user_overrides if key != "confirmed_at"
        )
        profile["user_overridden_fields"] = user_overridden_fields
        evidence = profile.get("evidence")
        if isinstance(evidence, list):
            overridden = set(user_overridden_fields)
            profile["evidence"] = [
                item
                for item in evidence
                if not isinstance(item, dict) or item.get("field") not in overridden
            ]
    identified_name = profile.get("business_name", "") if profile is not None else ""
    display_name = project_display_name(identified_name) if isinstance(identified_name, str) else ""
    response_name = display_name or project.name
    if profile is not None:
        profile["business_name"] = response_name
    return ProjectResponse(
        id=project.id,
        name=response_name,
        domain=normalize_domain(project.domain),
        country=project.country,
        language=project.language,
        competitor_domain=project.competitor_domain,
        understanding_run_id=project.understanding_run_id,
        understanding_status=understanding_status,
        understanding_stage=project.understanding_stage,
        understanding_message=project.understanding_message or "",
        understanding_progress=progress_percentage(
            project.understanding_stage or "",
            project.understanding_discovered,
            project.understanding_processed,
            understanding_status or "queued",
        ),
        understanding_attempt=max(project.understanding_attempt, 1),
        understanding_started_at=project.understanding_started_at,
        understanding_finished_at=project.understanding_finished_at,
        understanding_elapsed_seconds=elapsed_seconds(
            project.understanding_started_at,
            project.understanding_finished_at,
            understanding_status in {"queued", "running"},
        ),
        audit_run_id=project.audit_run_id,
        audit_status=audit_status,
        audit_health=project.audit_health,
        site_profile=profile,
        created_at=project.created_at,
    )


def build_business_profile_run_response(
    run: BusinessProfileRunRecord,
) -> BusinessProfileRunResponse:
    status = normalized_run_status(run.status)
    if status not in {"queued", "running", "partial", "completed", "failed"}:
        status = "running"
    return BusinessProfileRunResponse(
        run_id=run.run_id,
        attempt=run.attempt,
        status=status,
        stage=run.stage,
        message=run.message or "",
        progress=progress_percentage(
            run.stage or "",
            run.discovered,
            run.processed,
            status,
        ),
        started_at=run.started_at,
        finished_at=run.finished_at,
        elapsed_seconds=elapsed_seconds(
            run.started_at,
            run.finished_at,
            status in {"queued", "running"},
        ),
        created_at=run.created_at,
    )


def elapsed_seconds(
    started_at: datetime | None,
    finished_at: datetime | None,
    active: bool,
) -> float:
    if started_at is None:
        return 0
    if finished_at is None and not active:
        return 0
    end = finished_at or datetime.now(UTC)
    return max(0, round((end - started_at).total_seconds(), 2))


def understanding_runs_query(organization_id: str):
    return select(
        CrawlRun.run_id,
        CrawlRun.project_id,
        CrawlRun.status,
        CrawlRun.stage,
        CrawlRun.message,
        CrawlRun.discovered,
        CrawlRun.processed,
        CrawlRun.started_at,
        CrawlRun.finished_at,
        CrawlRun.created_at,
        func.row_number()
        .over(
            partition_by=CrawlRun.project_id,
            order_by=(CrawlRun.created_at.asc(), CrawlRun.run_id.asc()),
        )
        .label("attempt"),
    ).where(
        CrawlRun.organization_id == organization_id,
        CrawlRun.task_type == "site_understanding",
    )


def project_query(organization_id: str):
    understanding_run = understanding_runs_query(organization_id).subquery()
    audit_run = aliased(CrawlRun)
    return (
        select(
            Project,
            understanding_run.c.status,
            understanding_run.c.stage,
            understanding_run.c.message,
            understanding_run.c.discovered,
            understanding_run.c.processed,
            understanding_run.c.attempt,
            understanding_run.c.started_at,
            understanding_run.c.finished_at,
            audit_run.status,
            audit_run.temporal_workflow_id,
            SiteProfile.profile_json,
            SiteProfile.user_overrides,
            SiteProfile.confidence,
            SiteProfile.source_run_id,
        )
        .outerjoin(
            understanding_run,
            understanding_run.c.run_id == Project.understanding_run_id,
        )
        .outerjoin(
            audit_run,
            audit_run.run_id == Project.audit_run_id,
        )
        .outerjoin(SiteProfile, SiteProfile.project_id == Project.id)
        .where(Project.organization_id == organization_id)
        .order_by(Project.created_at.desc())
    )


def project_record_from_row(row: Any) -> ProjectRecord:
    (
        project,
        understanding_status,
        understanding_stage,
        understanding_message,
        understanding_discovered,
        understanding_processed,
        understanding_attempt,
        understanding_started_at,
        understanding_finished_at,
        audit_status,
        audit_workflow_id,
        site_profile,
        site_profile_user_overrides,
        site_profile_confidence,
        site_profile_source_run_id,
    ) = row
    return ProjectRecord(
        id=project.id,
        organization_id=project.organization_id,
        name=project.name,
        domain=project.domain,
        country=project.country,
        language=project.language,
        competitor_domain=project.competitor_domain,
        understanding_run_id=project.understanding_run_id,
        understanding_status=understanding_status,
        understanding_stage=understanding_stage,
        understanding_message=understanding_message,
        understanding_discovered=understanding_discovered or 0,
        understanding_processed=understanding_processed or 0,
        understanding_attempt=understanding_attempt or 1,
        understanding_started_at=understanding_started_at,
        understanding_finished_at=understanding_finished_at,
        audit_run_id=project.audit_run_id,
        audit_status=audit_status,
        audit_workflow_id=audit_workflow_id,
        audit_health=project.audit_health,
        site_profile=site_profile,
        site_profile_user_overrides=site_profile_user_overrides or {},
        site_profile_confidence=site_profile_confidence,
        site_profile_source_run_id=site_profile_source_run_id,
        created_at=project.created_at,
    )


def build_project_service() -> ProjectService:
    settings = get_settings()
    return ProjectService(
        settings=settings,
        launcher=TemporalWorkflowController(
            settings.crawler_task_queue,
            get_crawler_worker_launcher(),
        ),
        repository=SQLAlchemyProjectRepository(session_factory),
        site_icon_reader=S3SiteIconReader(settings),
        object_cleaner=S3AuditObjectCleaner(settings),
    )
