from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from typing import Any, Protocol
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from sqlalchemy import column, delete, func, select, table, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from app.core.config import Settings, get_settings
from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.db.session import session_factory
from app.modules.agent.models import AgentConversation
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
from app.modules.content.models import Article, ArticlePublication
from app.modules.content_plan.models import ContentPlanSettings
from app.modules.crawling.models import CrawlRun, Page
from app.modules.keywords.models import (
    Keyword,
    KeywordBuildRun,
    KeywordCompetitorAnalysisDispatch,
    KeywordCompetitorAnalysisRun,
    KeywordWorkflowDispatch,
)
from app.modules.onboarding.service import OnboardingService, build_onboarding_records
from app.modules.projects.backlinks_projection import ProjectContextProjector
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
    ConfirmPromotionTargetRequest,
    CreateProjectRequest,
    ProjectResponse,
    PromotionTargetVersionResponse,
    PublishPromotionTargetRequest,
    UpdateBusinessProfileRequest,
)
from app.workflows.worker import get_crawler_worker_launcher

logger = logging.getLogger(__name__)

FORCED_DELETE_CLEANUP_TIMEOUT_SECONDS = 5.0
PROMOTION_TARGET_REFERENCE_LIMIT = 100
PROMOTION_TARGET_TOPIC_LIMIT = 100

website_profile_versions = table(
    "website_profile_versions",
    column("id"),
    column("products"),
    column("input_required"),
    schema="platform",
)
promotion_target_versions = table(
    "promotion_target_versions",
    column("id"),
    column("keywords"),
    column("target_urls"),
    column("target_audiences"),
    column("partnership_goals"),
    column("input_required"),
    schema="platform",
)


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


class ProjectContextConflictError(Exception):
    pass


class PromotionTargetReferenceError(Exception):
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
    workspace_id: str = "local"
    lifecycle_status: str = "ACTIVE"
    lifecycle_version: int = 1
    archived_at: datetime | None = None
    archive_reason: str | None = None
    context_version: int = 1
    outreach_products: tuple[str, ...] = ()
    outreach_keywords: tuple[str, ...] = ()
    outreach_target_urls: tuple[str, ...] = ()
    outreach_target_audiences: tuple[str, ...] = ()
    outreach_partnership_goals: tuple[str, ...] = ()
    outreach_input_required: tuple[str, ...] | None = None


@dataclass(frozen=True)
class ProjectDependencyRecord:
    owner_module: str
    record_type: str
    record_id: str


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
    ) -> None: ...

    async def list(
        self,
        organization_id: str,
        workspace_id: str,
        lifecycle_status: str | None = None,
    ) -> list[ProjectRecord]: ...

    async def get(
        self,
        organization_id: str,
        project_id: str,
        workspace_id: str | None = None,
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

    async def publish_promotion_target(
        self,
        organization_id: str,
        workspace_id: str,
        project_id: str,
        request: PublishPromotionTargetRequest,
        created_by: str,
    ) -> PromotionTargetVersionResponse: ...

    async def confirm_promotion_target(
        self,
        organization_id: str,
        workspace_id: str,
        project_id: str,
        request: ConfirmPromotionTargetRequest,
        created_by: str,
    ) -> PromotionTargetVersionResponse: ...

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

    async def set_lifecycle(
        self,
        organization_id: str,
        workspace_id: str,
        project_id: str,
        expected_lifecycle_version: int,
        lifecycle_status: str,
        archive_reason: str | None,
    ) -> ProjectRecord: ...

    async def retained_dependencies(
        self,
        organization_id: str,
        workspace_id: str,
        project_id: str,
    ) -> list[ProjectDependencyRecord]: ...

    async def delete(
        self,
        organization_id: str,
        project_id: str,
    ) -> bool: ...


class SQLAlchemyProjectRepository:
    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        projector: ProjectContextProjector | None = None,
    ) -> None:
        self.sessions = sessions
        self.projector = projector

    async def create_with_understanding_run(
        self,
        project: ProjectRecord,
        run: CrawlRun,
        dispatch: WorkflowDispatchRecord,
    ) -> None:
        async with self.sessions() as session:
            session.add(
                Project(
                    id=project.id,
                    organization_id=project.organization_id,
                    workspace_id=project.workspace_id,
                    project_key=project.id,
                    status=project.lifecycle_status,
                    lifecycle_version=project.lifecycle_version,
                    name=project.name,
                    domain=project.domain,
                    country=project.country,
                    target_market=project.country,
                    language=project.language,
                    competitor_domain=project.competitor_domain,
                    health=0,
                    context_version=project.context_version,
                    initial_crawl_run_id=project.understanding_run_id,
                    understanding_run_id=project.understanding_run_id,
                    audit_run_id=project.audit_run_id,
                    audit_health=project.audit_health,
                    created_at=project.created_at,
                )
            )
            session.add(run)
            try:
                # Persist the project before project-scoped settings and
                # orchestration rows that reference it.
                await session.flush()
            except IntegrityError as exc:
                await session.rollback()
                if is_project_domain_conflict(exc):
                    raise ProjectAlreadyExistsError from exc
                raise

            session.add(
                ContentPlanSettings(
                    project_id=project.id,
                    cadence="weekly_2_3",
                    paused=False,
                    timezone="UTC",
                    default_publish_local_time=time(10),
                    cadence_anchor_week=(
                        project.created_at.date()
                        - timedelta(days=project.created_at.weekday())
                    ),
                    version=1,
                )
            )
            session.add(
                WorkflowDispatch(
                    run_id=dispatch.run_id,
                    workflow_id=dispatch.workflow_id,
                    task_payload=dispatch.task_payload,
                    status="pending",
                )
            )
            agent_conversation = AgentConversation(
                id=str(uuid4()),
                organization_id=project.organization_id,
                project_id=project.id,
                created_by="system",
                title="网站初始化",
                created_at=project.created_at,
                updated_at=project.created_at,
            )
            session.add(agent_conversation)
            onboarding_run, onboarding_steps = build_onboarding_records(
                project.organization_id,
                project.id,
                project.created_at,
                run.run_id,
                agent_conversation.id,
            )
            session.add(onboarding_run)
            session.add_all(onboarding_steps)
            try:
                await session.flush()
                await session.commit()
            except IntegrityError as exc:
                await session.rollback()
                if is_project_domain_conflict(exc):
                    raise ProjectAlreadyExistsError from exc
                raise

    async def list(
        self,
        organization_id: str,
        workspace_id: str,
        lifecycle_status: str | None = None,
    ) -> list[ProjectRecord]:
        async with self.sessions() as session:
            query = project_query(organization_id, workspace_id)
            if lifecycle_status is not None:
                query = query.where(Project.status == lifecycle_status)
            rows = (await session.execute(query)).all()
            return [project_record_from_row(row) for row in rows]

    async def get(
        self,
        organization_id: str,
        project_id: str,
        workspace_id: str | None = None,
    ) -> ProjectRecord | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    project_query(organization_id, workspace_id).where(
                        Project.id == project_id
                    )
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
        async with self.sessions() as session, session.begin():
            project = await session.scalar(
                select(Project).where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                ).with_for_update()
            )
            if project is None:
                raise ProjectNotFoundError

            site_profile = await self._editable_site_profile(session, project)
            changed, confirmation_transition = _apply_business_profile_confirmation(
                site_profile,
                updates,
            )
            if changed:
                await session.flush()
                await self._publish_website_profile_version(
                    session,
                    project,
                    site_profile,
                    created_by="website-project-service",
                    force_new=confirmation_transition,
                )
                await self._project_if_enabled(
                    session,
                    project,
                    actor_id="website-project-service",
                )
            workspace_id = project.workspace_id

        updated = await self.get(organization_id, project_id, workspace_id)
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
        async with self.sessions() as session, session.begin():
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
                site_profile = await self._editable_site_profile(session, project)
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
                profile_json = {
                    **dict(site_profile.profile_json or {}),
                    **dict(site_profile.user_overrides or {}),
                }
                if any(profile_json.get(key) != value for key, value in expected_before.items()):
                    raise RuntimeError("项目状态已经变化，请重新发起操作")
                changed, confirmation_transition = (
                    _apply_business_profile_confirmation(site_profile, updates)
                )
                session.add(SiteProfileOperation(
                    operation_id=operation_id,
                    project_id=project_id,
                    operation_type="update_business_profile",
                    parameters_hash=parameters_hash,
                    result_json={"changes": updates},
                ))
                await session.flush()
                if changed:
                    await self._publish_website_profile_version(
                        session,
                        project,
                        site_profile,
                        created_by="website-project-service",
                        force_new=confirmation_transition,
                    )
                    await self._project_if_enabled(
                        session,
                        project,
                        actor_id="website-project-service",
                    )
            workspace_id = project.workspace_id

        updated = await self.get(organization_id, project_id, workspace_id)
        if updated is None:
            raise ProjectNotFoundError
        return updated, already_completed

    async def _publish_website_profile_version(
        self,
        session: AsyncSession,
        project: Project,
        site_profile: SiteProfile,
        *,
        created_by: str,
        force_new: bool = False,
    ) -> str:
        profile = {
            **dict(site_profile.profile_json or {}),
            **dict(site_profile.user_overrides or {}),
        }
        products = _normalized_items(profile.get("products_services"))
        if not _profile_is_confirmed(profile):
            input_required = ["PROJECTS:confirm_site_profile"]
        else:
            input_required = [] if products else ["PROJECTS:complete_site_profile"]
        values = {
            "name": str(profile.get("business_name") or project.name).strip(),
            "canonical_domain": normalize_domain(project.domain),
            "country_code": str(project.country).strip().upper(),
            "target_market": str(project.target_market or project.country).strip(),
            "locale": str(project.language).strip(),
            "products": products,
            "input_required": input_required,
        }
        current = None
        if project.current_profile_version_id:
            current = (
                await session.execute(
                    text(
                        """
                        SELECT id, version, name, canonical_domain, country_code,
                               target_market, locale, products, input_required
                          FROM platform.website_profile_versions
                         WHERE id = :version_id
                           AND organization_id = :organization_id
                           AND workspace_id = :workspace_id
                           AND project_id = :project_id
                        """
                    ),
                    {
                        "version_id": project.current_profile_version_id,
                        "organization_id": project.organization_id,
                        "workspace_id": project.workspace_id,
                        "project_id": project.id,
                    },
                )
            ).mappings().first()
        if not force_new and current is not None and all(
            current[key] == value for key, value in values.items()
        ):
            return str(current["id"])

        next_version = int(
            await session.scalar(
                text(
                    """
                    SELECT COALESCE(max(version), 0) + 1
                      FROM platform.website_profile_versions
                     WHERE organization_id = :organization_id
                       AND workspace_id = :workspace_id
                       AND project_id = :project_id
                    """
                ),
                {
                    "organization_id": project.organization_id,
                    "workspace_id": project.workspace_id,
                    "project_id": project.id,
                },
            )
            or 1
        )
        version_id = str(uuid4())
        project.context_version += 1
        await session.execute(
            text(
                """
                INSERT INTO platform.website_profile_versions (
                  id, organization_id, workspace_id, project_id, version,
                  name, canonical_domain, country_code, target_market, locale,
                  products, input_required, created_by
                ) VALUES (
                  :id, :organization_id, :workspace_id, :project_id, :version,
                  :name, :canonical_domain, :country_code, :target_market, :locale,
                  CAST(:products AS jsonb), CAST(:input_required AS jsonb), :created_by
                )
                """
            ),
            {
                "id": version_id,
                "organization_id": project.organization_id,
                "workspace_id": project.workspace_id,
                "project_id": project.id,
                "version": next_version,
                **{key: value for key, value in values.items() if key not in {
                    "products",
                    "input_required",
                }},
                "products": json.dumps(products, ensure_ascii=False),
                "input_required": json.dumps(input_required),
                "created_by": created_by,
            },
        )
        project.current_profile_version_id = version_id
        await self._record_project_audit_event(
            session,
            project,
            event_type="WEBSITE_PROFILE_VERSION_PUBLISHED",
            actor_id=created_by,
            payload={
                "profileVersionId": version_id,
                "version": next_version,
                "sourceLineage": {
                    "siteProfileProjectId": site_profile.project_id,
                    "sourceRunId": site_profile.source_run_id,
                },
            },
        )
        await session.flush()
        return version_id

    async def publish_promotion_target(
        self,
        organization_id: str,
        workspace_id: str,
        project_id: str,
        request: PublishPromotionTargetRequest,
        created_by: str,
    ) -> PromotionTargetVersionResponse:
        async with self.sessions() as session, session.begin():
            project = await session.scalar(
                select(Project).where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                    Project.workspace_id == workspace_id,
                ).with_for_update()
            )
            if project is None:
                raise ProjectNotFoundError
            return await self._publish_promotion_target_in_session(
                session,
                project,
                request,
                created_by=created_by,
            )

    async def confirm_promotion_target(
        self,
        organization_id: str,
        workspace_id: str,
        project_id: str,
        request: ConfirmPromotionTargetRequest,
        created_by: str,
    ) -> PromotionTargetVersionResponse:
        async with self.sessions() as session, session.begin():
            project = await session.scalar(
                select(Project).where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                    Project.workspace_id == workspace_id,
                ).with_for_update()
            )
            if project is None:
                raise ProjectNotFoundError
            return await self._write_promotion_target_in_session(
                session,
                project,
                keywords=request.confirmed_topics,
                target_urls=_confirmed_promotion_target_urls(
                    request.confirmed_target_urls,
                    project.domain,
                ),
                source_keyword_ids=[],
                source_published_target_ids=[],
                expected_project_context_version=(
                    request.expected_project_context_version
                ),
                expected_site_profile_version_id=(
                    request.expected_site_profile_version_id
                ),
                created_by=created_by,
                authority="user_confirmed",
            )

    async def refresh_promotion_target_from_authority(
        self,
        session: AsyncSession,
        *,
        organization_id: str,
        project_id: str,
        created_by: str,
    ) -> PromotionTargetVersionResponse | None:
        project = await session.scalar(
            select(Project).where(
                Project.id == project_id,
                Project.organization_id == organization_id,
            ).with_for_update()
        )
        if project is None:
            raise ProjectNotFoundError

        keyword_ids = list(
            (
                await session.scalars(
                    select(Keyword.id)
                    .where(
                        Keyword.organization_id == organization_id,
                        Keyword.project_id == project_id,
                        func.lower(Keyword.country) == project.country.lower(),
                        func.lower(Keyword.language) == project.language.lower(),
                        Keyword.status == "active",
                        Keyword.review_status == "approved",
                    )
                    .order_by(
                        Keyword.priority_score.desc().nullslast(),
                        Keyword.created_at.asc(),
                        Keyword.id.asc(),
                    )
                    .limit(PROMOTION_TARGET_REFERENCE_LIMIT)
                )
            ).all()
        )[:PROMOTION_TARGET_REFERENCE_LIMIT]
        publication_ids = list(
            (
                await session.scalars(
                    select(ArticlePublication.id)
                    .join(Article, Article.id == ArticlePublication.article_id)
                    .where(
                        ArticlePublication.organization_id == organization_id,
                        ArticlePublication.project_id == project_id,
                        ArticlePublication.status == "published",
                        ArticlePublication.remote_url.is_not(None),
                        Article.organization_id == organization_id,
                        Article.project_id == project_id,
                    )
                    .order_by(
                        ArticlePublication.published_at.desc().nullslast(),
                        ArticlePublication.created_at.desc(),
                        ArticlePublication.id.asc(),
                    )
                    .limit(PROMOTION_TARGET_REFERENCE_LIMIT)
                )
            ).all()
        )[:PROMOTION_TARGET_REFERENCE_LIMIT]
        if not keyword_ids and not publication_ids:
            await self._project_if_enabled(
                session,
                project,
                actor_id=created_by,
            )
            return None

        return await self._publish_promotion_target_in_session(
            session,
            project,
            PublishPromotionTargetRequest(
                approved_keyword_ids=keyword_ids,
                published_target_ids=publication_ids,
                expected_project_context_version=project.context_version,
                expected_site_profile_version_id=project.current_profile_version_id,
            ),
            created_by=created_by,
        )

    async def _publish_promotion_target_in_session(
        self,
        session: AsyncSession,
        project: Project,
        request: PublishPromotionTargetRequest,
        *,
        created_by: str,
    ) -> PromotionTargetVersionResponse:
        keyword_rows = await self._approved_keyword_references(
            session,
            project,
            request.approved_keyword_ids,
        )
        publication_rows = await self._published_target_references(
            session,
            project,
            request.published_target_ids,
        )
        source_keyword_ids = sorted(row.id for row in keyword_rows)
        source_published_target_ids = sorted(
            publication.id for publication, _article in publication_rows
        )
        keywords = _promotion_target_keywords(
            keyword_rows,
            publication_rows,
        )
        target_urls = _normalized_items(
            [
                publication.remote_url
                for publication, _article in publication_rows
                if publication.remote_url
            ]
        )
        return await self._write_promotion_target_in_session(
            session,
            project,
            keywords=keywords,
            target_urls=target_urls,
            source_keyword_ids=source_keyword_ids,
            source_published_target_ids=source_published_target_ids,
            expected_project_context_version=(
                request.expected_project_context_version
            ),
            expected_site_profile_version_id=(
                request.expected_site_profile_version_id
            ),
            created_by=created_by,
            authority="reference",
        )

    async def _write_promotion_target_in_session(
        self,
        session: AsyncSession,
        project: Project,
        *,
        keywords: list[str],
        target_urls: list[str],
        source_keyword_ids: list[str],
        source_published_target_ids: list[str],
        expected_project_context_version: int,
        expected_site_profile_version_id: str | None,
        created_by: str,
        authority: str,
    ) -> PromotionTargetVersionResponse:
        keywords = _normalized_items(keywords)[:PROMOTION_TARGET_TOPIC_LIMIT]
        target_urls = _normalized_items(target_urls)[:PROMOTION_TARGET_REFERENCE_LIMIT]
        current = await self._current_promotion_target(session, project)
        if current is not None:
            lineage = await self._promotion_target_lineage(
                session,
                project,
                str(current["id"]),
            )
            if (
                _normalized_items(current["keywords"]) == keywords
                and _normalized_items(current["target_urls"]) == target_urls
                and lineage.get("approvedKeywordIds") == source_keyword_ids
                and lineage.get("publishedTargetIds")
                == source_published_target_ids
                and (lineage.get("authority") or "reference") == authority
            ):
                return _promotion_target_response(
                    current,
                    project_id=project.id,
                    source_keyword_ids=source_keyword_ids,
                    source_published_target_ids=source_published_target_ids,
                    source_site_profile_version_id=(
                        project.current_profile_version_id
                    ),
                )

        if project.context_version != expected_project_context_version:
            raise ProjectContextConflictError(
                "项目上下文版本已变化，请使用最新版本重新发布"
            )
        if project.current_profile_version_id != expected_site_profile_version_id:
            raise ProjectContextConflictError(
                "SiteProfile 版本已变化，请使用最新版本重新发布"
            )

        next_version = int(
            await session.scalar(
                text(
                    """
                    SELECT COALESCE(max(version), 0) + 1
                      FROM platform.promotion_target_versions
                     WHERE organization_id = :organization_id
                       AND workspace_id = :workspace_id
                       AND project_id = :project_id
                    """
                ),
                {
                    "organization_id": project.organization_id,
                    "workspace_id": project.workspace_id,
                    "project_id": project.id,
                },
            )
            or 1
        )
        version_id = str(uuid4())
        project.context_version += 1
        await session.execute(
            text(
                """
                INSERT INTO platform.promotion_target_versions (
                  id, organization_id, workspace_id, project_id, version,
                  keywords, target_urls, target_audiences, partnership_goals,
                  input_required, created_by
                ) VALUES (
                  :id, :organization_id, :workspace_id, :project_id, :version,
                  CAST(:keywords AS jsonb), CAST(:target_urls AS jsonb),
                  '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, :created_by
                )
                """
            ),
            {
                "id": version_id,
                "organization_id": project.organization_id,
                "workspace_id": project.workspace_id,
                "project_id": project.id,
                "version": next_version,
                "keywords": json.dumps(keywords, ensure_ascii=False),
                "target_urls": json.dumps(target_urls, ensure_ascii=False),
                "created_by": created_by,
            },
        )
        project.current_promotion_target_version_id = version_id
        await self._record_project_audit_event(
            session,
            project,
            event_type="PROMOTION_TARGET_VERSION_PUBLISHED",
            actor_id=created_by,
            payload={
                "promotionTargetVersionId": version_id,
                "version": next_version,
                "sourceLineage": {
                    "approvedKeywordIds": source_keyword_ids,
                    "publishedTargetIds": source_published_target_ids,
                    "authority": authority,
                },
                "validationContext": {
                    "projectContextVersion": expected_project_context_version,
                    "siteProfileVersionId": expected_site_profile_version_id,
                },
            },
        )
        await session.flush()
        await self._project_if_enabled(
            session,
            project,
            actor_id=created_by,
        )
        current = await self._current_promotion_target(session, project)
        assert current is not None
        return _promotion_target_response(
            current,
            project_id=project.id,
            source_keyword_ids=source_keyword_ids,
            source_published_target_ids=source_published_target_ids,
            source_site_profile_version_id=project.current_profile_version_id,
        )

    @staticmethod
    async def _approved_keyword_references(
        session: AsyncSession,
        project: Project,
        reference_ids: list[str],
    ) -> list[Keyword]:
        if not reference_ids:
            return []
        rows = list(
            (
                await session.scalars(
                    select(Keyword).where(Keyword.id.in_(reference_ids))
                )
            ).all()
        )
        by_id = {row.id: row for row in rows}
        missing = sorted(set(reference_ids) - set(by_id))
        if missing:
            raise PromotionTargetReferenceError(
                f"关键词引用不存在: {', '.join(missing)}"
            )
        selected = [by_id[reference_id] for reference_id in reference_ids]
        for row in selected:
            if (
                row.organization_id != project.organization_id
                or row.project_id != project.id
            ):
                raise PromotionTargetReferenceError(
                    f"关键词 {row.id} 不属于当前项目"
                )
            if row.status != "active" or row.review_status != "approved":
                raise PromotionTargetReferenceError(
                    f"关键词 {row.id} 尚未批准或已归档"
                )
            if (
                row.country.lower() != project.country.lower()
                or row.language.lower() != project.language.lower()
            ):
                raise PromotionTargetReferenceError(
                    f"关键词 {row.id} 的国家或语言与项目不一致"
                )
        return sorted(selected, key=_promotion_keyword_sort_key)

    @staticmethod
    async def _published_target_references(
        session: AsyncSession,
        project: Project,
        reference_ids: list[str],
    ) -> list[tuple[ArticlePublication, Article]]:
        if not reference_ids:
            return []
        rows = (
            await session.execute(
                select(ArticlePublication, Article)
                .join(Article, Article.id == ArticlePublication.article_id)
                .where(ArticlePublication.id.in_(reference_ids))
            )
        ).all()
        by_id = {
            publication.id: (publication, article)
            for publication, article in rows
        }
        missing = sorted(set(reference_ids) - set(by_id))
        if missing:
            raise PromotionTargetReferenceError(
                f"发布目标引用不存在: {', '.join(missing)}"
            )
        selected = [by_id[reference_id] for reference_id in reference_ids]
        for publication, article in selected:
            if (
                publication.organization_id != project.organization_id
                or publication.project_id != project.id
                or article.organization_id != project.organization_id
                or article.project_id != project.id
            ):
                raise PromotionTargetReferenceError(
                    f"发布目标 {publication.id} 不属于当前项目"
                )
            if publication.status != "published" or not publication.remote_url:
                raise PromotionTargetReferenceError(
                    f"发布目标 {publication.id} 尚未发布"
                )
            parsed = urlsplit(publication.remote_url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                raise PromotionTargetReferenceError(
                    f"发布目标 {publication.id} 缺少有效公开 URL"
                )
        return sorted(selected, key=_promotion_publication_sort_key)

    @staticmethod
    async def _current_promotion_target(
        session: AsyncSession,
        project: Project,
    ) -> Any | None:
        if not project.current_promotion_target_version_id:
            return None
        return (
            await session.execute(
                text(
                    """
                    SELECT id, version, keywords, target_urls, target_audiences,
                           partnership_goals, input_required, created_at
                      FROM platform.promotion_target_versions
                     WHERE id = :version_id
                       AND organization_id = :organization_id
                       AND workspace_id = :workspace_id
                       AND project_id = :project_id
                    """
                ),
                {
                    "version_id": project.current_promotion_target_version_id,
                    "organization_id": project.organization_id,
                    "workspace_id": project.workspace_id,
                    "project_id": project.id,
                },
            )
        ).mappings().first()

    @staticmethod
    async def _promotion_target_lineage(
        session: AsyncSession,
        project: Project,
        version_id: str,
    ) -> dict[str, Any]:
        payload = await session.scalar(
            text(
                """
                SELECT payload
                  FROM platform.project_audit_events
                 WHERE organization_id = :organization_id
                   AND workspace_id = :workspace_id
                   AND project_id = :project_id
                   AND event_type = 'PROMOTION_TARGET_VERSION_PUBLISHED'
                   AND payload ->> 'promotionTargetVersionId' = :version_id
                 ORDER BY created_at DESC
                 LIMIT 1
                """
            ),
            {
                "organization_id": project.organization_id,
                "workspace_id": project.workspace_id,
                "project_id": project.id,
                "version_id": version_id,
            },
        )
        if not isinstance(payload, dict):
            return {}
        lineage = payload.get("sourceLineage")
        return dict(lineage) if isinstance(lineage, dict) else {}

    @staticmethod
    async def _record_project_audit_event(
        session: AsyncSession,
        project: Project,
        *,
        event_type: str,
        actor_id: str,
        payload: dict[str, Any],
    ) -> None:
        await session.execute(
            text(
                """
                INSERT INTO platform.project_audit_events (
                  id, organization_id, workspace_id, project_id, event_type,
                  context_version, payload, actor_id
                ) VALUES (
                  :id, :organization_id, :workspace_id, :project_id, :event_type,
                  :context_version, CAST(:payload AS jsonb), :actor_id
                )
                """
            ),
            {
                "id": str(uuid4()),
                "organization_id": project.organization_id,
                "workspace_id": project.workspace_id,
                "project_id": project.id,
                "event_type": event_type,
                "context_version": project.context_version,
                "payload": json.dumps(payload, ensure_ascii=False),
                "actor_id": actor_id,
            },
        )

    async def _project_if_enabled(
        self,
        session: AsyncSession,
        project: Project,
        *,
        actor_id: str,
    ) -> None:
        if self.projector is None:
            return
        await self.projector.ensure_projected(
            ResolvedPlatformRequestContext(
                actor=PlatformActor(
                    user_id=actor_id,
                    session_id=f"website-project-lifecycle:{project.id}",
                    roles=("system",),
                ),
                tenant=PlatformTenant(
                    organization_id=project.organization_id,
                    workspace_id=project.workspace_id,
                ),
                project=PlatformProject(
                    website_project_id=project.id,
                    website_project_key=project.project_key,
                ),
                permissions=("backlinks:read", "backlinks:write"),
                correlation_id=f"website-project-lifecycle:{project.id}",
            ),
            session=session,
        )

    @staticmethod
    async def _editable_site_profile(
        session: AsyncSession,
        project: Project,
    ) -> SiteProfile:
        site_profile = await session.get(SiteProfile, project.id)
        if site_profile is not None:
            return site_profile

        source_run_id = project.understanding_run_id or project.initial_crawl_run_id
        source_run = (
            await session.scalar(
                select(CrawlRun).where(
                    CrawlRun.run_id == source_run_id,
                    CrawlRun.organization_id == project.organization_id,
                    CrawlRun.project_id == project.id,
                    CrawlRun.task_type == "site_understanding",
                )
            )
            if source_run_id
            else None
        )
        if source_run is None or normalized_run_status(source_run.status) in {
            "queued",
            "running",
        }:
            raise SiteProfileNotReadyError

        site_profile = SiteProfile(
            project_id=project.id,
            source_run_id=source_run.run_id,
            profile_json={
                "profile_version": 1,
                "extraction_method": "manual",
                "source_page_count": 0,
                "favicon_url": "",
                "business_name": project.name,
                "business_type": "",
                "business_summary": "",
                "products_services": [],
                "target_audiences": [],
                "value_propositions": [],
                "use_cases": [],
                "target_markets": [project.target_market or project.country],
                "languages": [project.language],
                "content_topics": [],
                "conversion_actions": [],
                "key_pages": [
                    {
                        "url": f"https://{project.domain}/",
                        "title": project.name,
                        "description": "",
                    }
                ],
                "partnership_goals": [],
                "evidence": [],
                "ai_content_rules": "",
            },
            user_overrides={},
            confidence=1.0,
        )
        session.add(site_profile)
        return site_profile

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
            competitor_workflow_ids = await session.scalars(
                select(KeywordCompetitorAnalysisDispatch.workflow_id)
                .join(
                    KeywordCompetitorAnalysisRun,
                    KeywordCompetitorAnalysisRun.id == KeywordCompetitorAnalysisDispatch.run_id,
                )
                .where(
                    KeywordCompetitorAnalysisRun.organization_id == organization_id,
                    KeywordCompetitorAnalysisRun.project_id == project_id,
                    KeywordCompetitorAnalysisRun.status.in_(("queued", "running")),
                    KeywordCompetitorAnalysisDispatch.status == "dispatched",
                )
            )
            return [*workflow_ids.all(), *competitor_workflow_ids.all()]

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

    async def set_lifecycle(
        self,
        organization_id: str,
        workspace_id: str,
        project_id: str,
        expected_lifecycle_version: int,
        lifecycle_status: str,
        archive_reason: str | None,
    ) -> ProjectRecord:
        async with self.sessions() as session:
            project = await session.scalar(
                select(Project)
                .where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                    Project.workspace_id == workspace_id,
                )
                .with_for_update()
            )
            if project is None:
                raise ProjectNotFoundError
            if project.lifecycle_version != expected_lifecycle_version:
                raise ProjectDeleteError("项目生命周期已变化，请刷新后重试")
            if project.status == lifecycle_status:
                row = (
                    await session.execute(
                        project_query(organization_id, workspace_id).where(
                            Project.id == project_id
                        )
                    )
                ).first()
                if row is None:
                    raise ProjectNotFoundError
                return project_record_from_row(row)

            project.status = lifecycle_status
            project.lifecycle_version += 1
            project.context_version += 1
            project.archived_at = (
                datetime.now(UTC) if lifecycle_status == "ARCHIVED" else None
            )
            project.archive_reason = (
                archive_reason if lifecycle_status == "ARCHIVED" else None
            )
            await session.commit()

        updated = await self.get(
            organization_id,
            project_id,
            workspace_id,
        )
        if updated is None:
            raise ProjectNotFoundError
        return updated

    async def retained_dependencies(
        self,
        organization_id: str,
        workspace_id: str,
        project_id: str,
    ) -> list[ProjectDependencyRecord]:
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    text(
                        """
                        SELECT owner_module, record_type, record_id
                          FROM backlinks.backlink_list_project_retained_dependencies(
                            :organization_id,
                            :workspace_id,
                            :project_id
                          )
                        """
                    ),
                    {
                        "organization_id": organization_id,
                        "workspace_id": workspace_id,
                        "project_id": project_id,
                    },
                )
            ).all()
        return [
            ProjectDependencyRecord(
                owner_module=str(row.owner_module),
                record_type=str(row.record_type),
                record_id=str(row.record_id),
            )
            for row in rows
        ]


class ProjectService:
    def __init__(
        self,
        settings: Settings,
        launcher: WorkflowLauncher,
        repository: ProjectRepository,
        site_icon_reader: SiteIconReader,
        object_cleaner: AuditObjectCleaner | None = None,
        onboarding_service: OnboardingService | None = None,
    ) -> None:
        self.settings = settings
        self.launcher = launcher
        self.repository = repository
        self.site_icon_reader = site_icon_reader
        self.object_cleaner = object_cleaner or NoopAuditObjectCleaner()
        self.onboarding_service = onboarding_service

    def _organization_id(self, organization_id: str | None) -> str:
        return organization_id or self.settings.default_organization_id

    @staticmethod
    def _workspace_id(workspace_id: str | None) -> str:
        return workspace_id or "local"

    async def create(
        self,
        request: CreateProjectRequest,
        *,
        organization_id: str | None = None,
        workspace_id: str | None = None,
    ) -> ProjectResponse:
        organization_id = self._organization_id(organization_id)
        workspace_id = self._workspace_id(workspace_id)
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
            organization_id=organization_id,
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
            workspace_id=workspace_id,
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
        await self.repository.create_with_understanding_run(
            project,
            run,
            dispatch,
        )
        await self._reconcile_onboarding_after_profile_update(
            project.id,
            organization_id,
        )
        await self._dispatch(dispatch)
        current = await self.repository.get(
            project.organization_id,
            project.id,
            project.workspace_id,
        )
        return build_project_response(current or project)

    async def list(
        self,
        *,
        organization_id: str | None = None,
        workspace_id: str | None = None,
        lifecycle_status: str | None = "ACTIVE",
    ) -> list[ProjectResponse]:
        projects = await self.repository.list(
            self._organization_id(organization_id),
            self._workspace_id(workspace_id),
            lifecycle_status,
        )
        return [build_project_response(project) for project in deduplicate_projects(projects)]

    async def get(
        self,
        project_id: str,
        *,
        organization_id: str | None = None,
        workspace_id: str | None = None,
    ) -> ProjectResponse | None:
        project = await self.repository.get(
            self._organization_id(organization_id),
            project_id,
            self._workspace_id(workspace_id),
        )
        return build_project_response(project) if project is not None else None

    async def publish_promotion_target(
        self,
        project_id: str,
        request: PublishPromotionTargetRequest,
        *,
        organization_id: str | None = None,
        workspace_id: str | None = None,
        created_by: str,
    ) -> PromotionTargetVersionResponse:
        return await self.repository.publish_promotion_target(
            self._organization_id(organization_id),
            self._workspace_id(workspace_id),
            project_id,
            request,
            created_by,
        )

    async def confirm_promotion_target(
        self,
        project_id: str,
        request: ConfirmPromotionTargetRequest,
        *,
        organization_id: str | None = None,
        workspace_id: str | None = None,
        created_by: str,
    ) -> PromotionTargetVersionResponse:
        return await self.repository.confirm_promotion_target(
            self._organization_id(organization_id),
            self._workspace_id(workspace_id),
            project_id,
            request,
            created_by,
        )

    async def archive(
        self,
        project_id: str,
        *,
        organization_id: str | None = None,
        workspace_id: str | None = None,
        archive_reason: str = "USER_REQUESTED",
    ) -> ProjectResponse:
        organization_id = self._organization_id(organization_id)
        workspace_id = self._workspace_id(workspace_id)
        project = await self.repository.get(
            organization_id,
            project_id,
            workspace_id,
        )
        if project is None:
            raise ProjectNotFoundError
        updated = await self.repository.set_lifecycle(
            organization_id,
            workspace_id,
            project_id,
            project.lifecycle_version,
            "ARCHIVED",
            archive_reason,
        )
        return build_project_response(updated)

    async def restore(
        self,
        project_id: str,
        *,
        organization_id: str | None = None,
        workspace_id: str | None = None,
    ) -> ProjectResponse:
        organization_id = self._organization_id(organization_id)
        workspace_id = self._workspace_id(workspace_id)
        project = await self.repository.get(
            organization_id,
            project_id,
            workspace_id,
        )
        if project is None:
            raise ProjectNotFoundError
        updated = await self.repository.set_lifecycle(
            organization_id,
            workspace_id,
            project_id,
            project.lifecycle_version,
            "ACTIVE",
            None,
        )
        return build_project_response(updated)

    async def update_business_profile(
        self,
        project_id: str,
        request: UpdateBusinessProfileRequest,
        *,
        organization_id: str | None = None,
    ) -> ProjectResponse:
        organization_id = self._organization_id(organization_id)
        updates = request.model_dump()
        updates["business_name"] = (
            project_display_name(request.business_name) or request.business_name
        )
        project = await self.repository.update_business_profile(
            organization_id,
            project_id,
            updates,
        )
        await self._reconcile_onboarding_after_profile_update(project_id, organization_id)
        return build_project_response(project)

    async def update_business_profile_once(
        self,
        project_id: str,
        request: UpdateBusinessProfileRequest,
        operation_id: str,
        parameters_hash: str,
        expected_before: dict[str, Any],
        *,
        organization_id: str | None = None,
    ) -> tuple[ProjectResponse, bool]:
        organization_id = self._organization_id(organization_id)
        updates = request.model_dump()
        updates["business_name"] = (
            project_display_name(request.business_name) or request.business_name
        )
        project, already_completed = await self.repository.update_business_profile_once(
            organization_id,
            project_id,
            updates,
            operation_id,
            parameters_hash,
            expected_before,
        )
        await self._reconcile_onboarding_after_profile_update(project_id, organization_id)
        return build_project_response(project), already_completed

    async def _reconcile_onboarding_after_profile_update(
        self,
        project_id: str,
        organization_id: str,
    ) -> None:
        if self.onboarding_service is None:
            return
        try:
            await self.onboarding_service.for_organization(organization_id).reconcile_project(
                project_id
            )
        except Exception:
            logger.exception(
                "Unable to reconcile onboarding after business profile update",
                extra={"project_id": project_id},
            )

    async def list_business_profile_runs(
        self,
        project_id: str,
        limit: int = 10,
        *,
        organization_id: str | None = None,
    ) -> list[BusinessProfileRunResponse]:
        organization_id = self._organization_id(organization_id)
        project = await self.repository.get(
            organization_id,
            project_id,
        )
        if project is None:
            raise ProjectNotFoundError
        runs = await self.repository.list_understanding_runs(
            organization_id,
            project_id,
            max(1, min(limit, 50)),
        )
        return [build_business_profile_run_response(run) for run in runs]

    async def get_business_profile_run(
        self,
        project_id: str,
        run_id: str,
        *,
        organization_id: str | None = None,
    ) -> BusinessProfileRunResponse | None:
        run = await self.repository.get_understanding_run(
            self._organization_id(organization_id),
            project_id,
            run_id,
        )
        return build_business_profile_run_response(run) if run is not None else None

    async def get_site_icon(
        self,
        project_id: str,
        *,
        organization_id: str | None = None,
    ) -> StoredSiteIcon:
        organization_id = self._organization_id(organization_id)
        project = await self.repository.get(
            organization_id,
            project_id,
        )
        if project is None:
            raise ProjectNotFoundError
        if not project.site_profile_source_run_id:
            raise SiteIconNotFoundError
        icon = await self.site_icon_reader.read_site_icon(
            organization_id,
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
        *,
        organization_id: str | None = None,
    ) -> ProjectResponse:
        organization_id = self._organization_id(organization_id)
        project = await self.repository.get(
            organization_id,
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

    async def delete(
        self,
        project_id: str,
        *,
        organization_id: str | None = None,
        workspace_id: str | None = None,
    ) -> None:
        organization_id = self._organization_id(organization_id)
        workspace_id = self._workspace_id(workspace_id)
        project = await self.repository.get(
            organization_id,
            project_id,
            workspace_id,
        )
        if project is None:
            raise ProjectNotFoundError

        try:
            dependencies = await self.repository.retained_dependencies(
                organization_id,
                workspace_id,
                project_id,
            )
        except Exception as exc:
            raise ProjectDeleteError(
                "无法确认项目保留依赖；请归档项目而不是删除"
            ) from exc
        if dependencies:
            owners = ", ".join(
                sorted({dependency.owner_module for dependency in dependencies})
            )
            raise ProjectDeleteError(
                f"项目仍有需保留的历史记录（{owners}）；请归档项目"
            )

        try:
            keyword_workflow_ids = await asyncio.wait_for(
                self.repository.active_keyword_workflow_ids(
                    project.organization_id,
                    project.id,
                ),
                timeout=FORCED_DELETE_CLEANUP_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            logger.exception(
                "project workflow lookup failed; continuing forced deletion",
                extra={"project_id": project.id},
                exc_info=exc,
            )
            keyword_workflow_ids = []
        workflow_ids = [*active_project_workflow_ids(project), *keyword_workflow_ids]

        deleted = await self.repository.delete(
            organization_id,
            project_id,
        )
        if not deleted:
            raise ProjectNotFoundError

        async def cancel_workflow(workflow_id: str) -> None:
            try:
                await asyncio.wait_for(
                    self.launcher.cancel(workflow_id),
                    timeout=FORCED_DELETE_CLEANUP_TIMEOUT_SECONDS,
                )
            except Exception as exc:
                logger.exception(
                    "project workflow cancellation failed after forced deletion",
                    extra={"project_id": project.id, "workflow_id": workflow_id},
                    exc_info=exc,
                )

        async def clean_project_objects() -> None:
            try:
                await asyncio.wait_for(
                    self.object_cleaner.delete_project_objects(
                        project.organization_id,
                        project.id,
                    ),
                    timeout=FORCED_DELETE_CLEANUP_TIMEOUT_SECONDS,
                )
            except Exception as exc:
                logger.exception(
                    "project object cleanup failed after forced deletion",
                    extra={"project_id": project.id},
                    exc_info=exc,
                )

        await asyncio.gather(
            *(cancel_workflow(workflow_id) for workflow_id in dict.fromkeys(workflow_ids)),
            clean_project_objects(),
        )


def _normalized_items(values: object) -> list[str]:
    if not isinstance(values, (list, tuple)):
        return []
    return list(
        dict.fromkeys(
            value.strip()
            for value in values
            if isinstance(value, str) and value.strip()
        )
    )


def _datetime_sort_value(value: datetime | None) -> float:
    if value is None:
        return 0.0
    normalized = value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    return normalized.timestamp()


def _promotion_keyword_sort_key(row: Keyword) -> tuple[int, float, float, str]:
    priority = row.priority_score
    return (
        1 if priority is None else 0,
        -(float(priority) if priority is not None else 0.0),
        _datetime_sort_value(row.created_at),
        str(row.id),
    )


def _promotion_publication_sort_key(
    row: tuple[ArticlePublication, Article],
) -> tuple[float, float, str]:
    publication, _article = row
    return (
        -_datetime_sort_value(publication.published_at),
        -_datetime_sort_value(publication.created_at),
        str(publication.id),
    )


def _promotion_target_keywords(
    keyword_rows: list[Keyword],
    publication_rows: list[tuple[ArticlePublication, Article]],
) -> list[str]:
    content_topics = [
        value
        for _publication, article in sorted(
            publication_rows,
            key=_promotion_publication_sort_key,
        )
        for value in (article.primary_keyword, article.title)
        if value
    ]
    approved_topics = [
        value
        for row in sorted(keyword_rows, key=_promotion_keyword_sort_key)
        for value in (row.keyword, row.business_topic)
        if value
    ]
    return _normalized_items([*content_topics, *approved_topics])[
        :PROMOTION_TARGET_TOPIC_LIMIT
    ]


def _promotion_target_response(
    row: Any,
    *,
    project_id: str,
    source_keyword_ids: list[str],
    source_published_target_ids: list[str],
    source_site_profile_version_id: str | None,
) -> PromotionTargetVersionResponse:
    return PromotionTargetVersionResponse(
        id=str(row["id"]),
        project_id=project_id,
        version=int(row["version"]),
        keywords=_normalized_items(row["keywords"]),
        target_urls=_normalized_items(row["target_urls"]),
        target_audiences=_normalized_items(row["target_audiences"]),
        partnership_goals=_normalized_items(row["partnership_goals"]),
        input_required=_normalized_items(row["input_required"]),
        source_keyword_ids=source_keyword_ids,
        source_published_target_ids=source_published_target_ids,
        source_site_profile_version_id=source_site_profile_version_id,
        created_at=row["created_at"],
    )


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


def _confirmed_promotion_target_urls(
    values: list[str],
    project_domain: str,
) -> list[str]:
    canonical_project_domain = normalize_domain(project_domain)
    normalized: list[str] = []
    for value in values:
        try:
            parsed = urlsplit(value.strip())
            hostname = parsed.hostname
        except ValueError as exc:
            raise PromotionTargetReferenceError("推广目标页地址无效") from exc
        if parsed.scheme.lower() not in {"http", "https"} or not hostname:
            raise PromotionTargetReferenceError(
                "推广目标页必须是完整的 http 或 https 地址"
            )
        if parsed.username or parsed.password:
            raise PromotionTargetReferenceError("推广目标页不能包含用户名或密码")
        try:
            port = parsed.port
        except ValueError as exc:
            raise PromotionTargetReferenceError("推广目标页端口无效") from exc
        if port not in {None, 80, 443}:
            raise PromotionTargetReferenceError("推广目标页不能使用自定义端口")

        hostname = hostname.lower().rstrip(".")
        canonical_hostname = hostname.removeprefix("www.")
        if (
            canonical_hostname != canonical_project_domain
            and not canonical_hostname.endswith(f".{canonical_project_domain}")
        ):
            raise PromotionTargetReferenceError(
                "推广目标页必须属于当前项目域名或其子域名"
            )

        normalized.append(
            urlunsplit(
                (
                    parsed.scheme.lower(),
                    hostname,
                    parsed.path or "/",
                    parsed.query,
                    "",
                )
            )
        )
    return _normalized_items(normalized)


def _profile_is_confirmed(profile: dict[str, Any]) -> bool:
    confirmed_at = profile.get("confirmed_at")
    return isinstance(confirmed_at, str) and bool(confirmed_at.strip())


def _apply_business_profile_confirmation(
    site_profile: SiteProfile,
    updates: dict[str, Any],
) -> tuple[bool, bool]:
    current = {
        **dict(site_profile.profile_json or {}),
        **dict(site_profile.user_overrides or {}),
    }
    was_confirmed = _profile_is_confirmed(current)
    business_changed = any(current.get(key) != value for key, value in updates.items())
    if was_confirmed and not business_changed:
        return False, False

    confirmed_updates = {
        **updates,
        "confirmed_at": datetime.now(UTC).isoformat(),
    }
    profile_json = dict(site_profile.profile_json or {})
    profile_json.update(confirmed_updates)
    site_profile.profile_json = profile_json
    user_overrides = dict(site_profile.user_overrides or {})
    user_overrides.update(confirmed_updates)
    site_profile.user_overrides = user_overrides
    return True, not was_confirmed


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
    if project.outreach_input_required is not None:
        if profile is None:
            profile = {
                "profile_version": 1,
                "extraction_method": "project_context",
                "source_page_count": 0,
                "favicon_url": "",
                "business_name": project.name,
                "business_type": "",
                "business_summary": "",
                "value_propositions": [],
                "use_cases": [],
                "target_markets": [project.country],
                "languages": [project.language],
                "conversion_actions": [],
                "evidence": [],
                "ai_content_rules": "",
                "confidence": 1.0,
            }
        profile["products_services"] = list(project.outreach_products)
        profile["content_topics"] = list(project.outreach_keywords)
        profile["target_audiences"] = list(project.outreach_target_audiences)
        profile["partnership_goals"] = list(project.outreach_partnership_goals)
        profile["input_required"] = list(project.outreach_input_required)
        profile["key_pages"] = [
            {
                "url": url,
                "title": project.name,
                "description": "",
            }
            for url in project.outreach_target_urls
        ]
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
        workspace_id=project.workspace_id,
        lifecycle_status=project.lifecycle_status,
        lifecycle_version=project.lifecycle_version,
        archived_at=project.archived_at,
        archive_reason=project.archive_reason,
        context_version=project.context_version,
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


def project_query(
    organization_id: str,
    workspace_id: str | None = None,
):
    understanding_run = understanding_runs_query(organization_id).subquery()
    audit_run = aliased(CrawlRun)
    query = (
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
            website_profile_versions.c.products,
            website_profile_versions.c.input_required,
            promotion_target_versions.c.keywords,
            promotion_target_versions.c.target_urls,
            promotion_target_versions.c.target_audiences,
            promotion_target_versions.c.partnership_goals,
            promotion_target_versions.c.input_required,
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
        .outerjoin(
            website_profile_versions,
            website_profile_versions.c.id == Project.current_profile_version_id,
        )
        .outerjoin(
            promotion_target_versions,
            promotion_target_versions.c.id == Project.current_promotion_target_version_id,
        )
        .where(Project.organization_id == organization_id)
        .order_by(Project.created_at.desc())
    )
    if workspace_id is not None:
        query = query.where(Project.workspace_id == workspace_id)
    return query


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
        outreach_products,
        website_input_required,
        outreach_keywords,
        outreach_target_urls,
        outreach_target_audiences,
        outreach_partnership_goals,
        promotion_input_required,
    ) = row
    outreach_context_available = (
        website_input_required is not None or promotion_input_required is not None
    )
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
        workspace_id=project.workspace_id or "local",
        lifecycle_status=project.status,
        lifecycle_version=project.lifecycle_version,
        archived_at=project.archived_at,
        archive_reason=project.archive_reason,
        context_version=project.context_version,
        outreach_products=tuple(outreach_products or ()),
        outreach_keywords=tuple(outreach_keywords or ()),
        outreach_target_urls=tuple(outreach_target_urls or ()),
        outreach_target_audiences=tuple(outreach_target_audiences or ()),
        outreach_partnership_goals=tuple(outreach_partnership_goals or ()),
        outreach_input_required=(
            tuple(website_input_required or ()) + tuple(promotion_input_required or ())
            if outreach_context_available
            else None
        ),
    )


async def refresh_project_promotion_target_from_authority(
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    *,
    organization_id: str,
    project_id: str,
    created_by: str,
) -> PromotionTargetVersionResponse | None:
    settings = get_settings()
    projector = (
        ProjectContextProjector(sessions)
        if settings.backlinks_project_projection_enabled
        else None
    )
    repository = SQLAlchemyProjectRepository(sessions, projector=projector)
    return await repository.refresh_promotion_target_from_authority(
        session,
        organization_id=organization_id,
        project_id=project_id,
        created_by=created_by,
    )


def build_project_service() -> ProjectService:
    from app.modules.onboarding.service import build_onboarding_service

    settings = get_settings()
    projector = (
        ProjectContextProjector(session_factory)
        if settings.backlinks_project_projection_enabled
        else None
    )
    return ProjectService(
        settings=settings,
        launcher=TemporalWorkflowController(
            settings.crawler_task_queue,
            get_crawler_worker_launcher(),
        ),
        repository=SQLAlchemyProjectRepository(
            session_factory,
            projector=projector,
        ),
        site_icon_reader=S3SiteIconReader(settings),
        object_cleaner=S3AuditObjectCleaner(settings),
        onboarding_service=build_onboarding_service(),
    )
