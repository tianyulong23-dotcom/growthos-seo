from __future__ import annotations

import asyncio
import logging
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

from httpx import ASGITransport, AsyncClient

from app.api.routes.projects import get_project_service
from app.core.config import Settings
from app.main import app
from app.modules.crawling.models import CrawlRun
from app.modules.projects.schemas import (
    CreateProjectRequest,
    UpdateBusinessProfileRequest,
)
from app.modules.projects.object_storage import StoredSiteIcon
from app.modules.projects.service import (
    BusinessProfileRunRecord,
    ProjectDependencyRecord,
    ProjectNotFoundError,
    ProjectRecord,
    ProjectService,
    SQLAlchemyProjectRepository,
    SiteProfileNotReadyError,
    WorkflowDispatchRecord,
    _apply_business_profile_confirmation,
)


class FakeWorkflowLauncher:
    def __init__(
        self,
        error: Exception | None = None,
        cancel_error: Exception | None = None,
    ) -> None:
        self.error = error
        self.cancel_error = cancel_error
        self.task: dict[str, Any] | None = None
        self.workflow_id = ""
        self.cancelled_workflow_ids: list[str] = []

    async def start(self, task: dict[str, Any], workflow_id: str) -> None:
        self.task = task
        self.workflow_id = workflow_id
        if self.error is not None:
            raise self.error

    async def cancel(self, workflow_id: str) -> None:
        self.cancelled_workflow_ids.append(workflow_id)
        if self.cancel_error is not None:
            raise self.cancel_error


class FakeProjectRepository:
    def __init__(self) -> None:
        self.projects: list[ProjectRecord] = []
        self.runs: dict[str, CrawlRun] = {}
        self.dispatches: dict[str, WorkflowDispatchRecord] = {}
        self.dispatch_statuses: dict[str, str] = {}
        self.dispatch_errors: dict[str, str] = {}
        self.keyword_workflow_ids: list[str] = []
        self.keyword_workflow_error: Exception | None = None
        self.dependencies: list[ProjectDependencyRecord] = []

    async def create_with_understanding_run(
        self,
        project: ProjectRecord,
        run: CrawlRun,
        dispatch: WorkflowDispatchRecord,
    ) -> None:
        self.projects.append(project)
        self.runs[run.run_id] = run
        self.dispatches[dispatch.run_id] = dispatch
        self.dispatch_statuses[dispatch.run_id] = "pending"

    async def mark_dispatch_succeeded(self, run_id: str) -> None:
        return None

    async def record_dispatch_failure(self, run_id: str, message: str) -> None:
        return None

    async def list(
        self,
        organization_id: str,
        workspace_id: str = "local",
        lifecycle_status: str | None = None,
    ) -> list[ProjectRecord]:
        projects: list[ProjectRecord] = []
        for project in self.projects:
            if project.organization_id != organization_id:
                continue
            if project.workspace_id != workspace_id:
                continue
            if (
                lifecycle_status is not None
                and project.lifecycle_status != lifecycle_status
            ):
                continue
            run = self.runs.get(project.understanding_run_id or "")
            attempts = sorted(
                (
                    candidate
                    for candidate in self.runs.values()
                    if candidate.organization_id == organization_id
                    and candidate.project_id == project.id
                    and candidate.task_type == "site_understanding"
                ),
                key=lambda candidate: (candidate.created_at, candidate.run_id),
            )
            attempt = next(
                (
                    index
                    for index, candidate in enumerate(attempts, start=1)
                    if candidate.run_id == project.understanding_run_id
                ),
                1,
            )
            projects.append(
                replace(
                    project,
                    understanding_status=run.status if run else None,
                    understanding_stage=run.stage if run else None,
                    understanding_message=run.message if run else None,
                    understanding_attempt=attempt,
                    understanding_started_at=run.started_at if run else None,
                    understanding_finished_at=run.finished_at if run else None,
                )
            )
        return projects

    async def get(
        self,
        organization_id: str,
        project_id: str,
        workspace_id: str | None = None,
    ) -> ProjectRecord | None:
        workspace_id = workspace_id or "local"
        return next(
            (
                project
                for project in await self.list(
                    organization_id,
                    workspace_id,
                    lifecycle_status=None,
                )
                if project.id == project_id
            ),
            None,
        )

    async def start_understanding_run(
        self,
        organization_id: str,
        project_id: str,
        run: CrawlRun,
        dispatch: WorkflowDispatchRecord,
    ) -> ProjectRecord:
        for index, project in enumerate(self.projects):
            if project.id == project_id and project.organization_id == organization_id:
                updated = replace(
                    project,
                    country=run.country or project.country,
                    language=run.language or project.language,
                    understanding_run_id=run.run_id,
                    understanding_status=run.status,
                    understanding_stage=run.stage,
                    understanding_message=run.message,
                    understanding_discovered=0,
                    understanding_processed=0,
                )
                self.projects[index] = updated
                self.runs[run.run_id] = run
                self.dispatches[dispatch.run_id] = dispatch
                return updated
        raise ProjectNotFoundError

    async def update_business_profile(
        self,
        organization_id: str,
        project_id: str,
        updates: dict[str, Any],
    ) -> ProjectRecord:
        for index, project in enumerate(self.projects):
            if project.id == project_id and project.organization_id == organization_id:
                if project.site_profile is None:
                    raise SiteProfileNotReadyError
                current = dict(project.site_profile)
                was_confirmed = bool(current.get("confirmed_at"))
                business_changed = any(
                    current.get(key) != value for key, value in updates.items()
                )
                if was_confirmed and not business_changed:
                    return project
                updated = replace(
                    project,
                    site_profile={
                        **current,
                        **updates,
                        "confirmed_at": datetime.now(UTC).isoformat(),
                    },
                    context_version=project.context_version + 1,
                )
                self.projects[index] = updated
                return updated
        raise ProjectNotFoundError

    async def list_understanding_runs(
        self,
        organization_id: str,
        project_id: str,
        limit: int,
    ) -> list[BusinessProfileRunRecord]:
        runs = sorted(
            (
                run
                for run in self.runs.values()
                if run.organization_id == organization_id
                and run.project_id == project_id
                and run.task_type == "site_understanding"
            ),
            key=lambda run: (run.created_at, run.run_id),
        )
        records = [
            BusinessProfileRunRecord(
                run_id=run.run_id,
                attempt=attempt,
                status=run.status,
                stage=run.stage,
                message=run.message,
                discovered=run.discovered or 0,
                processed=run.processed or 0,
                started_at=run.started_at,
                finished_at=run.finished_at,
                created_at=run.created_at,
            )
            for attempt, run in enumerate(runs, start=1)
        ]
        return list(reversed(records))[:limit]

    async def active_keyword_workflow_ids(
        self,
        organization_id: str,
        project_id: str,
    ) -> list[str]:
        if self.keyword_workflow_error is not None:
            raise self.keyword_workflow_error
        return list(self.keyword_workflow_ids)

    async def set_lifecycle(
        self,
        organization_id: str,
        workspace_id: str,
        project_id: str,
        expected_lifecycle_version: int,
        lifecycle_status: str,
        archive_reason: str | None,
    ) -> ProjectRecord:
        for index, project in enumerate(self.projects):
            if (
                project.id == project_id
                and project.organization_id == organization_id
                and project.workspace_id == workspace_id
            ):
                if project.lifecycle_version != expected_lifecycle_version:
                    raise AssertionError("unexpected lifecycle version")
                updated = replace(
                    project,
                    lifecycle_status=lifecycle_status,
                    lifecycle_version=project.lifecycle_version + 1,
                    context_version=project.context_version + 1,
                    archived_at=(
                        datetime.now(UTC)
                        if lifecycle_status == "ARCHIVED"
                        else None
                    ),
                    archive_reason=(
                        archive_reason
                        if lifecycle_status == "ARCHIVED"
                        else None
                    ),
                )
                self.projects[index] = updated
                return updated
        raise ProjectNotFoundError

    async def retained_dependencies(
        self,
        organization_id: str,
        workspace_id: str,
        project_id: str,
    ) -> list[ProjectDependencyRecord]:
        del organization_id, workspace_id, project_id
        return list(self.dependencies)

    async def delete(
        self,
        organization_id: str,
        project_id: str,
    ) -> bool:
        original_count = len(self.projects)
        self.projects = [
            project
            for project in self.projects
            if not (project.id == project_id and project.organization_id == organization_id)
        ]
        return len(self.projects) != original_count


class FakeSiteIconReader:
    def __init__(self) -> None:
        self.icons: dict[tuple[str, str, str], StoredSiteIcon] = {}
        self.requests: list[tuple[str, str, str]] = []

    async def read_site_icon(
        self,
        organization_id: str,
        project_id: str,
        run_id: str,
    ) -> StoredSiteIcon | None:
        key = (organization_id, project_id, run_id)
        self.requests.append(key)
        return self.icons.get(key)


class FakeProjectObjectCleaner:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.project_calls: list[tuple[str, str]] = []

    async def delete_project_objects(
        self,
        organization_id: str,
        project_id: str,
    ) -> None:
        self.project_calls.append((organization_id, project_id))
        if self.error is not None:
            raise self.error


class FakeOnboardingService:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.reconciled_project_ids: list[str] = []

    def for_organization(self, organization_id: str) -> FakeOnboardingService:
        del organization_id
        return self

    async def reconcile_project(self, project_id: str) -> None:
        self.reconciled_project_ids.append(project_id)
        if self.error is not None:
            raise self.error


def build_service(
    *,
    launch_error: Exception | None = None,
    cancel_error: Exception | None = None,
    object_cleaner: FakeProjectObjectCleaner | None = None,
    onboarding_service: FakeOnboardingService | None = None,
) -> tuple[
    ProjectService,
    FakeWorkflowLauncher,
    FakeProjectRepository,
    FakeSiteIconReader,
]:
    launcher = FakeWorkflowLauncher(launch_error, cancel_error)
    repository = FakeProjectRepository()
    site_icon_reader = FakeSiteIconReader()
    return (
        ProjectService(
            settings=Settings(app_env="test", default_organization_id="test-org"),
            launcher=launcher,
            repository=repository,
            site_icon_reader=site_icon_reader,
            object_cleaner=object_cleaner,
            onboarding_service=onboarding_service,  # type: ignore[arg-type]
        ),
        launcher,
        repository,
        site_icon_reader,
    )


def test_create_project_starts_site_understanding() -> None:
    service, launcher, repository, _ = build_service()

    response = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="https://Example.com/",
                country="美国",
                language="英语",
            )
        )
    )

    assert response.domain == "example.com"
    assert response.country == "US"
    assert response.language == "en"
    assert response.understanding_status == "queued"
    assert response.understanding_run_id
    assert response.audit_status == "never_started"
    assert response.audit_run_id is None
    assert response.audit_health is None
    assert launcher.task is not None
    assert launcher.task["type"] == "site_understanding"
    assert launcher.task["country"] == "US"
    assert launcher.task["language"] == "en"
    assert launcher.task["max_pages"] == 5
    assert launcher.task["rendering"] == "auto"
    assert launcher.workflow_id == (
        f"crawler:site_understanding:{response.id}:{response.understanding_run_id}"
    )
    assert repository.runs[response.understanding_run_id].task_type == "site_understanding"
    assert response.understanding_attempt == 1
    assert response.understanding_started_at is None
    assert response.understanding_finished_at is None
    assert response.understanding_elapsed_seconds == 0


def test_create_project_normalizes_competitor_without_starting_keywords() -> None:
    service, _, repository, _ = build_service()

    response = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="https://www.Example.com/",
                country="美国",
                language="英语",
                competitor_domain="https://WWW.Competitor.com/",
            )
        )
    )

    assert response.competitor_domain == "competitor.com"
    [project] = repository.projects
    assert project.competitor_domain == "competitor.com"
    assert repository.keyword_workflow_ids == []


def test_sql_repository_flushes_project_before_keyword_run() -> None:
    service, _, repository, _ = build_service()
    asyncio.run(
        service.create(CreateProjectRequest(domain="example.com", country="US", language="en"))
    )
    project = repository.projects[0]
    run = repository.runs[project.understanding_run_id or ""]
    dispatch = repository.dispatches[run.run_id]

    class FlushOrderSession:
        def __init__(self) -> None:
            self.flush_count = 0
            self.committed = False
            self.content_plan_settings: list[object] = []
            self.agent_conversations: list[object] = []
            self.onboarding_runs: list[object] = []
            self.onboarding_steps: list[object] = []

        async def __aenter__(self) -> "FlushOrderSession":
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        def add(self, instance: object) -> None:
            if type(instance).__name__ == "ContentPlanSettings":
                self.content_plan_settings.append(instance)
            if type(instance).__name__ == "AgentConversation":
                self.agent_conversations.append(instance)
            if type(instance).__name__ == "OnboardingRun":
                self.onboarding_runs.append(instance)

        def add_all(self, instances: list[object]) -> None:
            self.onboarding_steps.extend(instances)

        async def flush(self) -> None:
            self.flush_count += 1

        async def commit(self) -> None:
            self.committed = True

        async def rollback(self) -> None:
            return None

    session = FlushOrderSession()
    sql_repository = SQLAlchemyProjectRepository(lambda: session)  # type: ignore[arg-type]

    asyncio.run(
        sql_repository.create_with_understanding_run(
            project,
            run,
            dispatch,
        )
    )

    assert session.flush_count == 2
    assert session.committed is True
    [content_plan_settings] = session.content_plan_settings
    assert content_plan_settings.project_id == project.id
    assert content_plan_settings.cadence == "weekly_2_3"
    assert content_plan_settings.timezone == "UTC"
    assert content_plan_settings.cadence_anchor_week.weekday() == 0
    [agent_conversation] = session.agent_conversations
    assert agent_conversation.project_id == project.id
    assert agent_conversation.created_by == "system"
    assert agent_conversation.title == "网站初始化"
    [onboarding_run] = session.onboarding_runs
    assert onboarding_run.project_id == project.id
    assert onboarding_run.agent_conversation_id == agent_conversation.id
    assert [step.step_key for step in session.onboarding_steps] == [
        "aris_welcome",
        "site_understanding",
        "business_confirmation",
        "technical_audit",
        "keyword_library",
        "content_plan",
        "first_article",
        "second_article",
    ]
    assert session.onboarding_steps[1].status == "running"
    assert session.onboarding_steps[4].status == "blocked"


def test_create_project_remains_queued_when_workflow_cannot_start() -> None:
    service, _, repository, _ = build_service(
        launch_error=RuntimeError("temporal unavailable")
    )

    response = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )

    assert response.understanding_status == "queued"
    assert response.understanding_stage == "queued"
    assert response.understanding_message == "网站业务识别任务已进入队列"
    assert repository.runs[response.understanding_run_id].finished_at is None


def test_project_response_reports_actual_understanding_elapsed_time() -> None:
    service, _, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )
    started_at = datetime(2026, 7, 23, 8, 0, tzinfo=UTC)
    run = repository.runs[created.understanding_run_id]
    run.status = "completed"
    run.stage = "completed"
    run.started_at = started_at
    run.finished_at = started_at + timedelta(seconds=12.34)

    response = asyncio.run(service.get(created.id))

    assert response is not None
    assert response.understanding_started_at == started_at
    assert response.understanding_finished_at == started_at + timedelta(seconds=12.34)
    assert response.understanding_elapsed_seconds == 12.34


def test_terminal_understanding_without_finished_time_does_not_keep_counting() -> None:
    service, _, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )
    run = repository.runs[created.understanding_run_id]
    run.status = "failed"
    run.stage = "failed"
    run.started_at = datetime(2026, 7, 23, 8, 0, tzinfo=UTC)
    run.finished_at = None

    response = asyncio.run(service.get(created.id))
    history = asyncio.run(service.list_business_profile_runs(created.id))

    assert response is not None
    assert response.understanding_elapsed_seconds == 0
    assert history[0].elapsed_seconds == 0


def test_partial_audit_status_is_exposed_as_completed() -> None:
    service, _, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )
    repository.projects[0] = replace(
        repository.projects[0],
        audit_run_id="partial-audit",
        audit_status="partial",
    )

    response = asyncio.run(service.get(created.id))

    assert response is not None
    assert response.audit_status == "completed"


def test_create_project_normalizes_www_to_the_registrable_site_host() -> None:
    service, launcher, _, _ = build_service()

    response = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="https://www.Example.com/",
                country="US",
                language="en",
            )
        )
    )

    assert response.domain == "example.com"
    assert launcher.task is not None
    assert launcher.task["target_url"] == "https://example.com"


def test_list_projects_hides_legacy_www_duplicate_and_keeps_richer_project() -> None:
    service, _, repository, _ = build_service()
    first = asyncio.run(
        service.create(CreateProjectRequest(domain="www.example.com", country="US", language="en"))
    )
    duplicate = replace(
        repository.projects[0],
        id="legacy-duplicate",
        domain="example.com",
        audit_run_id="audit-run",
        site_profile={
            "business_name": "Example",
            "business_type": "Software / SaaS",
            "business_summary": "Example software.",
            "confidence": 0.8,
        },
        site_profile_confidence=0.8,
    )
    repository.projects.append(duplicate)

    projects = asyncio.run(service.list())

    assert len(projects) == 1
    assert projects[0].id == "legacy-duplicate"
    assert projects[0].domain == "example.com"
    assert projects[0].id != first.id


def test_list_projects_accepts_legacy_null_profile_lists() -> None:
    service, _, repository, _ = build_service()
    created = asyncio.run(
        service.create(CreateProjectRequest(domain="example.com", country="US", language="en"))
    )
    repository.projects[0] = replace(
        repository.projects[0],
        understanding_status="completed",
        understanding_stage="completed",
        site_profile={
            "business_name": "Example",
            "business_type": "Software / SaaS",
            "business_summary": "Example software.",
            "content_topics": None,
            "conversion_actions": None,
            "confidence": 0.8,
        },
        site_profile_confidence=0.8,
    )

    [project] = asyncio.run(service.list())

    assert project.id == created.id
    assert project.site_profile is not None
    assert project.site_profile.content_topics == []
    assert project.site_profile.conversion_actions == []


def test_project_response_uses_identified_business_name() -> None:
    service, _, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="about.example.com",
                country="US",
                language="en",
            )
        )
    )
    repository.projects[0] = replace(
        repository.projects[0],
        understanding_status="completed",
        understanding_stage="completed",
        site_profile={
            "business_name": "Example, Inc.",
            "business_type": "Business website",
            "business_summary": "Example company information.",
            "confidence": 0.8,
        },
        site_profile_confidence=0.8,
    )

    response = asyncio.run(service.get(created.id))

    assert response is not None
    assert response.name == "Example"
    assert response.site_profile is not None
    assert response.site_profile.business_name == "Example"


def test_project_response_uses_persisted_context_when_crawl_profile_is_missing() -> None:
    service, _, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="ZA",
                language="en",
            )
        )
    )
    repository.projects[0] = replace(
        repository.projects[0],
        understanding_status="failed",
        understanding_stage="failed",
        site_profile=None,
        site_profile_confidence=None,
        outreach_products=("Streaming", "Movies"),
        outreach_keywords=("streaming service", "movie reviews"),
        outreach_target_urls=("https://example.com/",),
        outreach_target_audiences=("South African viewers",),
        outreach_partnership_goals=("Earn links from authoritative review sites",),
        outreach_input_required=(),
    )

    response = asyncio.run(service.get(created.id))

    assert response is not None
    assert response.site_profile is not None
    assert response.site_profile.extraction_method == "project_context"
    assert response.site_profile.products_services == ["Streaming", "Movies"]
    assert response.site_profile.content_topics == ["streaming service", "movie reviews"]
    assert response.site_profile.target_audiences == ["South African viewers"]
    assert response.site_profile.partnership_goals == [
        "Earn links from authoritative review sites"
    ]
    assert [page.url for page in response.site_profile.key_pages] == [
        "https://example.com/"
    ]
    assert response.site_profile.input_required == []
    assert response.site_profile.confidence == 1.0


def test_sql_repository_can_create_manual_profile_after_understanding_failure() -> None:
    source_run = SimpleNamespace(run_id="understanding-1", status="failed")

    class FakeSession:
        def __init__(self) -> None:
            self.added = None

        async def get(self, model: object, key: str) -> None:
            del model, key

        async def scalar(self, query: object) -> SimpleNamespace:
            del query
            return source_run

        def add(self, value: object) -> None:
            self.added = value

    session = FakeSession()
    project = SimpleNamespace(
        id="project-1",
        organization_id="test-org",
        understanding_run_id="understanding-1",
        initial_crawl_run_id="understanding-1",
        name="Example",
        domain="example.com",
        target_market="ZA",
        country="ZA",
        language="en",
    )

    profile = asyncio.run(
        SQLAlchemyProjectRepository._editable_site_profile(  # type: ignore[arg-type]
            session,
            project,
        )
    )

    assert session.added is profile
    assert profile.source_run_id == "understanding-1"
    assert profile.profile_json["extraction_method"] == "manual"
    assert profile.profile_json["key_pages"][0]["url"] == "https://example.com/"


def test_project_routes_create_list_and_get_projects() -> None:
    service, _, _, _ = build_service()
    app.dependency_overrides[get_project_service] = lambda: service

    async def request() -> tuple[int, list[dict[str, Any]], dict[str, Any]]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            created = await client.post(
                "/api/v1/projects",
                json={
                    "domain": "example.com",
                    "country": "US",
                    "language": "en",
                },
            )
            listed = await client.get("/api/v1/projects")
            loaded = await client.get(f"/api/v1/projects/{created.json()['id']}")
            return created.status_code, listed.json(), loaded.json()

    try:
        status_code, projects, loaded = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status_code == 201
    assert len(projects) == 1
    assert projects[0]["domain"] == "example.com"
    assert projects[0]["understanding_status"] == "queued"
    assert projects[0]["audit_status"] == "never_started"
    assert loaded["id"] == projects[0]["id"]


def test_delete_project_route_removes_project_and_cancels_active_workflow() -> None:
    cleaner = FakeProjectObjectCleaner()
    service, launcher, repository, _ = build_service(object_cleaner=cleaner)
    created = asyncio.run(
        service.create(CreateProjectRequest(domain="example.com", country="US", language="en"))
    )
    repository.keyword_workflow_ids = ["keywords:build:run-1"]
    app.dependency_overrides[get_project_service] = lambda: service

    async def request() -> tuple[int, int, int]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            deleted = await client.delete(f"/api/v1/projects/{created.id}")
            loaded = await client.get(f"/api/v1/projects/{created.id}")
            listed = await client.get("/api/v1/projects")
            return deleted.status_code, loaded.status_code, len(listed.json())

    try:
        delete_status, get_status, project_count = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert delete_status == 204
    assert get_status == 404
    assert project_count == 0
    assert launcher.cancelled_workflow_ids == [
        f"crawler:site_understanding:{created.id}:{created.understanding_run_id}",
        "keywords:build:run-1",
    ]
    assert cleaner.project_calls == [("test-org", created.id)]


def test_delete_project_route_forces_removal_when_external_cleanup_fails() -> None:
    cleaner = FakeProjectObjectCleaner(error=RuntimeError("storage unavailable"))
    service, launcher, repository, _ = build_service(
        cancel_error=RuntimeError("workflow unavailable"),
        object_cleaner=cleaner,
    )
    created = asyncio.run(
        service.create(CreateProjectRequest(domain="example.com", country="US", language="en"))
    )
    repository.keyword_workflow_error = RuntimeError("workflow lookup unavailable")
    app.dependency_overrides[get_project_service] = lambda: service

    async def request() -> tuple[int, int, int]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            deleted = await client.delete(f"/api/v1/projects/{created.id}")
            loaded = await client.get(f"/api/v1/projects/{created.id}")
            listed = await client.get("/api/v1/projects")
            return deleted.status_code, loaded.status_code, len(listed.json())

    try:
        delete_status, get_status, project_count = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert delete_status == 204
    assert get_status == 404
    assert project_count == 0
    assert launcher.cancelled_workflow_ids == [
        f"crawler:site_understanding:{created.id}:{created.understanding_run_id}"
    ]
    assert cleaner.project_calls == [("test-org", created.id)]


def test_archive_and_restore_project_preserve_the_project_record() -> None:
    service, _, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(domain="example.com", country="US", language="en")
        )
    )
    app.dependency_overrides[get_project_service] = lambda: service

    async def request() -> tuple[int, list[dict[str, Any]], list[dict[str, Any]], int]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            archived = await client.post(f"/api/v1/projects/{created.id}/archive")
            active = await client.get("/api/v1/projects")
            archived_list = await client.get(
                "/api/v1/projects",
                params={"lifecycle_status": "ARCHIVED"},
            )
            restored = await client.post(f"/api/v1/projects/{created.id}/restore")
            return (
                archived.status_code,
                active.json(),
                archived_list.json(),
                restored.json()["lifecycle_version"],
            )

    try:
        status_code, active, archived, restored_version = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status_code == 200
    assert active == []
    assert [project["id"] for project in archived] == [created.id]
    assert archived[0]["lifecycle_status"] == "ARCHIVED"
    assert restored_version == 3
    assert repository.projects[0].lifecycle_status == "ACTIVE"
    assert repository.projects[0].archived_at is None


def test_delete_project_route_rejects_retained_backlinks_history() -> None:
    service, launcher, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(domain="example.com", country="US", language="en")
        )
    )
    repository.dependencies = [
        ProjectDependencyRecord(
            owner_module="BACKLINKS",
            record_type="opportunity",
            record_id="opportunity-1",
        )
    ]
    app.dependency_overrides[get_project_service] = lambda: service

    async def request() -> tuple[int, int]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            deleted = await client.delete(f"/api/v1/projects/{created.id}")
            loaded = await client.get(f"/api/v1/projects/{created.id}")
            return deleted.status_code, loaded.status_code

    try:
        delete_status, get_status = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert delete_status == 409
    assert get_status == 200
    assert launcher.cancelled_workflow_ids == []


def test_update_business_profile_preserves_crawler_fields() -> None:
    service, _, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )
    original_profile = {
        "profile_version": 1,
        "extraction_method": "rules",
        "source_page_count": 3,
        "business_name": "Example",
        "business_type": "SaaS",
        "business_summary": "Original summary",
        "products_services": ["Original product"],
        "target_audiences": ["Original audience"],
        "value_propositions": ["Original value"],
        "key_pages": [],
        "evidence": [
            {
                "field": "business_name",
                "value": "Example",
                "source_url": "https://example.com",
            }
        ],
        "confidence": 0.8,
    }
    repository.projects[0] = replace(
        repository.projects[0],
        understanding_status="completed",
        understanding_stage="completed",
        site_profile=original_profile,
        site_profile_confidence=0.8,
    )

    updated = asyncio.run(
        service.update_business_profile(
            created.id,
            UpdateBusinessProfileRequest(
                business_name="Example Inc.",
                business_type="SaaS",
                business_summary="Updated summary",
                target_audiences=["Teams", "Teams", "  Agencies  "],
                products_services=["Analytics"],
                value_propositions=["Fast setup"],
                ai_content_rules="Use a concise tone.",
            ),
        )
    )

    assert updated.site_profile is not None
    assert updated.site_profile.business_name == "Example"
    assert repository.projects[0].site_profile is not None
    assert repository.projects[0].site_profile["business_name"] == "Example"
    assert updated.site_profile.target_audiences == ["Teams", "Agencies"]
    assert updated.site_profile.ai_content_rules == "Use a concise tone."
    assert updated.site_profile.confirmed_at is not None
    assert updated.site_profile.business_type == "SaaS"
    assert updated.site_profile.evidence[0].source_url == "https://example.com"


def test_update_business_profile_succeeds_when_onboarding_reconcile_is_deferred(
    caplog,
) -> None:
    onboarding = FakeOnboardingService(RuntimeError("onboarding temporarily unavailable"))
    service, _, repository, _ = build_service(onboarding_service=onboarding)
    created = asyncio.run(
        service.create(
            CreateProjectRequest(domain="example.com", country="US", language="en")
        )
    )
    onboarding.reconciled_project_ids.clear()
    repository.projects[0] = replace(
        repository.projects[0],
        understanding_status="completed",
        understanding_stage="completed",
        site_profile={
            "profile_version": 1,
            "business_name": "Example",
            "business_type": "SaaS",
            "business_summary": "Original summary",
            "confidence": 0.75,
        },
        site_profile_confidence=0.75,
    )
    caplog.set_level(logging.ERROR, logger="app.modules.projects.service")

    updated = asyncio.run(
        service.update_business_profile(
            created.id,
            UpdateBusinessProfileRequest(
                business_name="Example",
                business_type="SaaS",
                business_summary="Confirmed summary",
                target_audiences=["Teams"],
                products_services=["Analytics"],
                value_propositions=["Fast setup"],
                ai_content_rules="",
            ),
        )
    )

    assert updated.site_profile is not None
    assert updated.site_profile.business_summary == "Confirmed summary"
    assert updated.site_profile.confirmed_at is not None
    assert onboarding.reconciled_project_ids == [created.id]
    assert any(
        record.message == "Unable to reconcile onboarding after business profile update"
        and record.project_id == created.id
        for record in caplog.records
    )


def test_update_business_profile_route_persists_changes() -> None:
    service, _, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )
    repository.projects[0] = replace(
        repository.projects[0],
        understanding_status="completed",
        understanding_stage="completed",
        site_profile={
            "profile_version": 1,
            "business_name": "Example",
            "business_type": "SaaS",
            "business_summary": "",
            "confidence": 0.75,
        },
        site_profile_confidence=0.75,
    )
    app.dependency_overrides[get_project_service] = lambda: service

    async def request() -> tuple[int, dict[str, Any], dict[str, Any]]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            saved = await client.patch(
                f"/api/v1/projects/{created.id}/business-profile",
                json={
                    "business_name": "Example Inc.",
                    "business_type": "SaaS",
                    "business_summary": "Updated summary",
                    "target_audiences": ["Teams"],
                    "products_services": ["Analytics"],
                    "value_propositions": ["Fast setup"],
                    "ai_content_rules": "Use a concise tone.",
                },
            )
            loaded = await client.get(f"/api/v1/projects/{created.id}")
            return saved.status_code, saved.json(), loaded.json()

    try:
        status_code, saved, loaded = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status_code == 200
    assert saved["site_profile"]["business_name"] == "Example"
    assert loaded["site_profile"]["business_name"] == "Example"
    assert loaded["site_profile"]["confirmed_at"] is not None


def test_business_profile_confirmation_advances_context_once_and_replays() -> None:
    service, _, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )
    repository.projects[0] = replace(
        repository.projects[0],
        understanding_status="completed",
        understanding_stage="completed",
        site_profile={
            "profile_version": 1,
            "business_name": "Example",
            "business_type": "SaaS",
            "business_summary": "Original summary",
            "products_services": ["Analytics"],
            "confidence": 0.75,
        },
        site_profile_confidence=0.75,
    )
    request = UpdateBusinessProfileRequest(
        business_name="Example",
        business_type="SaaS",
        business_summary="Original summary",
        target_audiences=["Teams"],
        products_services=["Analytics"],
        value_propositions=["Fast setup"],
        ai_content_rules="",
    )

    confirmed = asyncio.run(service.update_business_profile(created.id, request))
    replayed = asyncio.run(service.update_business_profile(created.id, request))

    assert confirmed.context_version == created.context_version + 1
    assert replayed.context_version == confirmed.context_version
    assert replayed.site_profile is not None
    assert confirmed.site_profile is not None
    assert replayed.site_profile.confirmed_at == confirmed.site_profile.confirmed_at


def test_business_profile_confirmation_transition_is_idempotent() -> None:
    site_profile = SimpleNamespace(
        profile_json={
            "business_name": "Example",
            "business_type": "SaaS",
            "business_summary": "Original summary",
            "products_services": ["Analytics"],
        },
        user_overrides={},
    )
    updates = {
        "business_name": "Example",
        "business_type": "SaaS",
        "business_summary": "Original summary",
        "target_audiences": ["Teams"],
        "products_services": ["Analytics"],
        "value_propositions": ["Fast setup"],
        "ai_content_rules": "",
    }

    changed, confirmation_transition = _apply_business_profile_confirmation(
        site_profile,
        updates,
    )
    confirmed_at = site_profile.profile_json["confirmed_at"]
    replay_changed, replay_transition = _apply_business_profile_confirmation(
        site_profile,
        updates,
    )

    assert changed is True
    assert confirmation_transition is True
    assert replay_changed is False
    assert replay_transition is False
    assert site_profile.profile_json["confirmed_at"] == confirmed_at
    assert site_profile.user_overrides["confirmed_at"] == confirmed_at


def test_confirmed_profile_change_does_not_reenter_confirmation_transition() -> None:
    site_profile = SimpleNamespace(
        profile_json={
            "business_name": "Example",
            "business_type": "SaaS",
            "business_summary": "Original summary",
            "products_services": ["Analytics"],
            "confirmed_at": "2026-08-19T08:00:00+00:00",
        },
        user_overrides={},
    )

    changed, confirmation_transition = _apply_business_profile_confirmation(
        site_profile,
        {
            "business_name": "Example",
            "business_type": "SaaS",
            "business_summary": "Updated summary",
            "target_audiences": ["Teams"],
            "products_services": ["Analytics"],
            "value_propositions": ["Fast setup"],
            "ai_content_rules": "",
        },
    )

    assert changed is True
    assert confirmation_transition is False
    assert site_profile.profile_json["business_summary"] == "Updated summary"


def test_profile_confirmation_force_publishes_once_and_advances_context() -> None:
    class FakeMappingsResult:
        def __init__(self, row: dict[str, Any] | None) -> None:
            self.row = row

        def mappings(self) -> FakeMappingsResult:
            return self

        def first(self) -> dict[str, Any] | None:
            return self.row

    class FakeVersionSession:
        def __init__(self, current: dict[str, Any]) -> None:
            self.current = current
            self.executions: list[tuple[str, dict[str, Any]]] = []
            self.scalar_calls = 0
            self.flush_calls = 0

        async def execute(
            self,
            statement: object,
            parameters: dict[str, Any],
        ) -> FakeMappingsResult:
            sql = str(statement)
            self.executions.append((sql, parameters))
            if "SELECT id, version, name" in sql:
                return FakeMappingsResult(self.current)
            return FakeMappingsResult(None)

        async def scalar(
            self,
            statement: object,
            parameters: dict[str, Any],
        ) -> int:
            del statement, parameters
            self.scalar_calls += 1
            return 2

        async def flush(self) -> None:
            self.flush_calls += 1

    old_version_id = "profile-version-1"
    current = {
        "id": old_version_id,
        "version": 1,
        "name": "Example",
        "canonical_domain": "example.com",
        "country_code": "US",
        "target_market": "US",
        "locale": "en",
        "products": ["Analytics"],
        "input_required": [],
    }
    session = FakeVersionSession(current)
    repository = SQLAlchemyProjectRepository(lambda: session)  # type: ignore[arg-type]
    project = SimpleNamespace(
        id="project-1",
        organization_id="test-org",
        workspace_id="local",
        name="Example",
        domain="example.com",
        country="US",
        target_market="US",
        language="en",
        context_version=7,
        current_profile_version_id=old_version_id,
    )
    site_profile = SimpleNamespace(
        project_id=project.id,
        source_run_id="crawl-run-1",
        profile_json={
            "business_name": "Example",
            "products_services": ["Analytics"],
            "confirmed_at": "2026-08-19T08:00:00+00:00",
        },
        user_overrides={},
    )

    new_version_id = asyncio.run(
        repository._publish_website_profile_version(  # type: ignore[arg-type]
            session,
            project,
            site_profile,
            created_by="website-project-service",
            force_new=True,
        )
    )

    assert new_version_id != old_version_id
    assert project.current_profile_version_id == new_version_id
    assert project.context_version == 8
    assert session.scalar_calls == 1
    assert session.flush_calls == 1
    website_inserts = [
        parameters
        for sql, parameters in session.executions
        if "INSERT INTO platform.website_profile_versions" in sql
    ]
    assert len(website_inserts) == 1
    assert website_inserts[0]["id"] == new_version_id

    session.current = {
        **current,
        "id": new_version_id,
        "version": 2,
    }
    session.executions.clear()
    replayed_version_id = asyncio.run(
        repository._publish_website_profile_version(  # type: ignore[arg-type]
            session,
            project,
            site_profile,
            created_by="website-project-service",
        )
    )

    assert replayed_version_id == new_version_id
    assert project.context_version == 8
    assert session.scalar_calls == 1
    assert session.flush_calls == 1
    assert all(
        "INSERT INTO platform.website_profile_versions" not in sql
        for sql, _parameters in session.executions
    )


def test_update_business_profile_returns_conflict_before_understanding_finishes() -> None:
    service, _, _, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )
    app.dependency_overrides[get_project_service] = lambda: service

    async def request() -> tuple[int, str]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.patch(
                f"/api/v1/projects/{created.id}/business-profile",
                json={
                    "business_name": "Example",
                    "business_type": "SaaS",
                    "business_summary": "",
                    "target_audiences": [],
                    "products_services": [],
                    "value_propositions": [],
                    "ai_content_rules": "",
                },
            )
            return response.status_code, response.json()["detail"]

    try:
        status_code, detail = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status_code == 409
    assert detail == "网站业务识别尚未完成"


def test_refresh_business_profile_starts_new_understanding_without_audit() -> None:
    service, launcher, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )
    repository.runs[created.understanding_run_id].status = "completed"
    repository.runs[created.understanding_run_id].stage = "completed"
    previous_run_id = created.understanding_run_id

    refreshed = asyncio.run(service.refresh_business_profile(created.id))

    assert refreshed.understanding_run_id != previous_run_id
    assert refreshed.understanding_status == "queued"
    assert refreshed.audit_run_id is None
    assert refreshed.audit_status == "never_started"
    assert launcher.task is not None
    assert launcher.task["type"] == "site_understanding"
    assert launcher.task["rendering"] == "auto"
    assert launcher.workflow_id.endswith(refreshed.understanding_run_id)


def test_business_profile_run_history_is_newest_first_with_attempt_numbers() -> None:
    service, _, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )
    first_run = repository.runs[created.understanding_run_id]
    first_run.status = "completed"
    first_run.stage = "completed"
    first_run.started_at = datetime(2026, 7, 23, 8, 0, tzinfo=UTC)
    first_run.created_at = first_run.started_at
    first_run.finished_at = first_run.started_at + timedelta(seconds=10)

    refreshed = asyncio.run(service.refresh_business_profile(created.id))
    second_run = repository.runs[refreshed.understanding_run_id]
    second_run.status = "failed"
    second_run.stage = "failed"
    second_run.message = "目标网站拒绝访问"
    second_run.started_at = datetime(2026, 7, 23, 8, 5, tzinfo=UTC)
    second_run.created_at = second_run.started_at
    second_run.finished_at = second_run.started_at + timedelta(seconds=3)

    runs = asyncio.run(service.list_business_profile_runs(created.id))

    assert [run.attempt for run in runs] == [2, 1]
    assert [run.status for run in runs] == ["failed", "completed"]
    assert runs[0].message == "目标网站拒绝访问"
    assert runs[0].elapsed_seconds == 3
    assert runs[1].elapsed_seconds == 10


def test_favicon_uses_profile_source_run_while_refresh_is_queued() -> None:
    service, _, repository, icon_reader = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )
    first_run_id = created.understanding_run_id
    repository.runs[first_run_id].status = "completed"
    repository.runs[first_run_id].stage = "completed"
    repository.projects[0] = replace(
        repository.projects[0],
        site_profile={
            "business_name": "Example",
            "business_type": "Software",
            "business_summary": "Example software.",
            "favicon_url": f"/api/v1/projects/{created.id}/favicon?v={first_run_id}",
            "confidence": 0.9,
        },
        site_profile_confidence=0.9,
        site_profile_source_run_id=first_run_id,
    )
    icon_reader.icons[("test-org", created.id, first_run_id)] = StoredSiteIcon(
        body=b"icon-bytes",
        content_type="image/png",
    )
    refreshed = asyncio.run(service.refresh_business_profile(created.id))
    app.dependency_overrides[get_project_service] = lambda: service

    async def request() -> tuple[int, str, bytes]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(f"/api/v1/projects/{created.id}/favicon")
            return response.status_code, response.headers["content-type"], response.content

    try:
        status_code, content_type, body = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert refreshed.understanding_run_id != first_run_id
    assert status_code == 200
    assert content_type == "image/png"
    assert body == b"icon-bytes"
    assert icon_reader.requests == [("test-org", created.id, first_run_id)]


def test_favicon_route_returns_not_found_without_stored_profile_icon() -> None:
    service, _, _, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )
    app.dependency_overrides[get_project_service] = lambda: service

    async def request() -> int:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            return (await client.get(f"/api/v1/projects/{created.id}/favicon")).status_code

    try:
        status_code = asyncio.run(request())
    finally:
        app.dependency_overrides.clear()

    assert status_code == 404


def test_refresh_business_profile_normalizes_legacy_locale_labels() -> None:
    service, launcher, repository, _ = build_service()
    created = asyncio.run(
        service.create(
            CreateProjectRequest(
                domain="example.com",
                country="US",
                language="en",
            )
        )
    )
    repository.runs[created.understanding_run_id].status = "completed"
    repository.runs[created.understanding_run_id].stage = "completed"
    repository.projects[0] = replace(
        repository.projects[0],
        country="\u7f8e\u56fd",
        language="\u82f1\u8bed",
    )

    refreshed = asyncio.run(service.refresh_business_profile(created.id))

    assert launcher.task is not None
    assert launcher.task["country"] == "US"
    assert launcher.task["language"] == "en"
    run = repository.runs[refreshed.understanding_run_id]
    assert run.country == "US"
    assert run.language == "en"
