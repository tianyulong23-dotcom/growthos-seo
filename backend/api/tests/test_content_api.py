import asyncio
from copy import deepcopy
from datetime import UTC, datetime
from hashlib import sha256
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

from httpx import ASGITransport, AsyncClient

from app.api.routes.content import get_content_service
from app.core.backlinks_gateway import PlatformContextResolver
from app.core.config import Settings
from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.main import app
from app.modules.content.models import Article, ArticleRun, ArticleSource
from app.modules.content.repository import (
    ArticleIdempotencyConflictError,
    publication_status_for_artifact,
)
from app.modules.content.service import ContentService
from app.modules.content.service import ContentNotFoundError
from app.modules.settings.service import (
    AIProviderNotConfiguredError,
    AIProviderSettingsRecord,
)


NOW = datetime(2026, 7, 28, 8, 0, tzinfo=UTC)


class FakeContentRepository:
    def __init__(self) -> None:
        self.projects = {"project-a", "project-b"}
        self.articles: dict[str, Article] = {}
        self.runs: dict[str, ArticleRun] = {}
        self.idempotency: dict[tuple[str, str, str], tuple[str, str]] = {}
        self.sources: dict[str, list[ArticleSource]] = {}
        self.reviewed_by: list[str] = []

    async def claim_due_plan_items(self, *, now: datetime, limit: int = 20) -> list:
        del now, limit
        return []

    async def release_plan_trigger(
        self, plan_item_id: str, *, error_code: str, error_detail: str
    ) -> None:
        del plan_item_id, error_code, error_detail

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        return organization_id == "test-org" and project_id in self.projects

    async def create_article(
        self,
        organization_id: str,
        project_id: str,
        primary_keyword: str,
        idempotency_key: str,
        request_hash: str,
        model_snapshot: dict[str, Any] | None = None,
    ) -> tuple[Article, ArticleRun]:
        scope = (organization_id, project_id, idempotency_key)
        existing = self.idempotency.get(scope)
        if existing is not None:
            existing_hash, article_id = existing
            if existing_hash != request_hash:
                raise ArticleIdempotencyConflictError
            article = self.articles[article_id]
            return article, self.runs[article.current_run_id]

        article_id, run_id = str(uuid4()), str(uuid4())
        article = Article(
            id=article_id,
            organization_id=organization_id,
            project_id=project_id,
            primary_keyword=primary_keyword,
            title=None,
            slug=None,
            meta_title=None,
            meta_description=None,
            outline_json={},
            markdown=None,
            html=None,
            status="queued",
            publication_status="complete_draft",
            current_run_id=run_id,
            warning_count=0,
            created_at=NOW,
            updated_at=NOW,
        )
        run = ArticleRun(
            id=run_id,
            article_id=article_id,
            organization_id=organization_id,
            project_id=project_id,
            workflow_id=f"article-generation:{run_id}",
            status="queued",
            stage="queued",
            progress=0,
            project_snapshot_json={},
            model_snapshot_json=model_snapshot or {},
            started_at=None,
            soft_deadline_at=None,
            hard_deadline_at=None,
            finished_at=None,
            warnings_json=[],
            metrics_json={},
            created_at=NOW,
            updated_at=NOW,
        )
        self.articles[article_id] = article
        self.runs[run_id] = run
        self.idempotency[scope] = (request_hash, article_id)
        return article, run

    async def queued_runs(self, limit: int = 20) -> list[ArticleRun]:
        return [run for run in self.runs.values() if run.status == "queued"][:limit]

    async def list_articles(
        self,
        organization_id: str,
        project_id: str,
        page: int,
        page_size: int,
        article_status: str | None,
        search: str | None,
    ) -> tuple[list[tuple[Article, ArticleRun | None]], int]:
        rows = [
            article
            for article in self.articles.values()
            if article.organization_id == organization_id
            and article.project_id == project_id
            and (article_status is None or article.status == article_status)
            and (
                search is None
                or search.casefold() in article.primary_keyword.casefold()
                or search.casefold() in (article.title or "").casefold()
            )
        ]
        rows.sort(key=lambda item: item.updated_at, reverse=True)
        start = (page - 1) * page_size
        selected = rows[start : start + page_size]
        return [
            (article, self.runs.get(article.current_run_id or ""))
            for article in selected
        ], len(rows)

    async def get_article(
        self, organization_id: str, project_id: str, article_id: str
    ) -> tuple[Article, ArticleRun | None] | None:
        article = self.articles.get(article_id)
        if (
            article is None
            or article.organization_id != organization_id
            or article.project_id != project_id
        ):
            return None
        return article, self.runs.get(article.current_run_id or "")

    async def get_run(
        self, organization_id: str, project_id: str, article_id: str
    ) -> ArticleRun | None:
        result = await self.get_article(organization_id, project_id, article_id)
        return result[1] if result else None

    async def list_article_sources(self, run_id: str) -> list[ArticleSource]:
        return self.sources.get(run_id, [])

    async def cancel_article(
        self, organization_id: str, project_id: str, article_id: str
    ) -> tuple[Article, ArticleRun | None] | None:
        result = await self.get_article(organization_id, project_id, article_id)
        if result is None:
            return None
        article, run = result
        if article.status in {"queued", "running"}:
            article.status = "cancelled"
            article.updated_at = NOW
            if run is not None and run.status in {"queued", "running"}:
                run.status = "cancelled"
                run.stage = "cancelled"
                run.finished_at = NOW
                run.updated_at = NOW
        return article, run

    async def review_article(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        *,
        decision: str,
        review_note: str | None,
        expected_version: int,
        reviewed_by: str,
    ) -> tuple[Article, ArticleRun | None]:
        result = await self.get_article(organization_id, project_id, article_id)
        if result is None:
            raise LookupError("article_not_found")
        article, run = result
        if article.review_version != expected_version or article.reviewed_at is not None:
            raise ValueError("stale_review_version")
        if decision == "changes_requested" and not review_note:
            raise ValueError("review_note_required")
        article.review_status = decision
        article.review_note = review_note
        article.reviewed_by = reviewed_by
        article.reviewed_at = NOW
        self.reviewed_by.append(reviewed_by)
        return article, run


class FakeAISettings:
    def __init__(self, configured: bool = True) -> None:
        self.configured = configured

    async def effective_record(self) -> AIProviderSettingsRecord:
        if not self.configured:
            raise AIProviderNotConfiguredError("请先在设置中配置可用的 AI 模型")
        return AIProviderSettingsRecord(
            base_url="https://models.example/v1",
            api_key="secret-not-in-snapshot",
            model="writing-model",
            request_timeout_seconds=30,
            max_retries=1,
            updated_at=NOW,
        )


class FakeWorkflowController:
    def __init__(self, available: bool = True) -> None:
        self.available = available
        self.started: list[str] = []
        self.cancelled: list[str] = []

    async def start(self, run_id: str) -> None:
        if not self.available:
            raise RuntimeError("Temporal unavailable")
        self.started.append(run_id)

    async def cancel(self, workflow_id: str) -> None:
        self.cancelled.append(workflow_id)


class ContentResolver(PlatformContextResolver):
    def __init__(self) -> None:
        self.calls: list[tuple[str, str | None]] = []

    async def resolve(
        self,
        *,
        request: object,
        website_project_key: str,
        required_permission: str | None = None,
    ) -> ResolvedPlatformRequestContext:
        del request
        self.calls.append((website_project_key, required_permission))
        return ResolvedPlatformRequestContext(
            actor=PlatformActor(
                user_id="reviewer-from-token",
                session_id="content-session",
                roles=("member",),
            ),
            tenant=PlatformTenant(
                organization_id="test-org",
                workspace_id="content-workspace",
            ),
            project=PlatformProject(
                website_project_id=website_project_key,
                website_project_key=website_project_key,
            ),
            permissions=("content:read", "content:write"),
            correlation_id="content-request",
        )


def build_service(
    *, configured: bool = True, controller_available: bool = True
) -> tuple[ContentService, FakeContentRepository, FakeWorkflowController]:
    repository = FakeContentRepository()
    controller = FakeWorkflowController(controller_available)
    service = ContentService(
        Settings(default_organization_id="test-org"),
        repository,
        ai_settings=FakeAISettings(configured),
        controller=controller,
    )
    return service, repository, controller


async def request_scenario() -> dict[str, Any]:
    service, repository, controller = build_service()
    resolver = ContentResolver()
    previous_resolver = app.state.platform_context_resolver
    app.state.platform_context_resolver = resolver
    app.dependency_overrides[get_content_service] = lambda: service
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            headers = {"Idempotency-Key": "request-1"}
            first = await client.post(
                "/api/v1/projects/project-a/articles",
                headers=headers,
                json={"primary_keyword": "  solar battery payback  "},
            )
            repeated = await client.post(
                "/api/v1/projects/project-a/articles",
                headers=headers,
                json={"primary_keyword": "solar battery payback"},
            )
            conflict = await client.post(
                "/api/v1/projects/project-a/articles",
                headers=headers,
                json={"primary_keyword": "different keyword"},
            )
            article_id = first.json()["id"]
            article = repository.articles[article_id]
            run_id = article.current_run_id or ""
            external_url = "https://authority.example/payback"
            internal_url = "https://example.com/solar-financing"
            article.title = "Solar battery payback"
            article.slug = "solar-battery-payback"
            article.meta_title = "Solar battery payback guide"
            article.meta_description = "A practical payback guide."
            article.outline_json = {
                "sections": [
                    {
                        "section_id": "section-1",
                        "heading": "Payback factors",
                        "internal_urls": [internal_url],
                    }
                ]
            }
            article.markdown = (
                f"# Solar battery payback\n\n[Source]({external_url})\n\n"
                f"Review [solar financing]({internal_url}) before comparing payback."
            )
            article.html = "<h1>Solar battery payback</h1>"
            repository.sources[run_id] = [
                ArticleSource(
                    id="source-external",
                    run_id=run_id,
                    source_type="authority",
                    url=external_url,
                    normalized_url=external_url,
                    title="Payback facts",
                    domain="authority.example",
                    status="available",
                    claims_json=[{"claim_id": "claim-1"}],
                    section_ids_json=["section-1"],
                    summary_json={},
                    metadata_json={},
                ),
                ArticleSource(
                    id="source-internal",
                    run_id=run_id,
                    source_type="internal",
                    url=internal_url,
                    normalized_url=internal_url,
                    title="Solar financing",
                    domain="example.com",
                    status="available",
                    claims_json=[],
                    section_ids_json=[],
                    summary_json={},
                    metadata_json={},
                ),
                ArticleSource(
                    id="source-failed-audit",
                    run_id=run_id,
                    source_type="authority",
                    url="https://authority.example/rejected-claim",
                    normalized_url="https://authority.example/rejected-claim",
                    title="Rejected claim",
                    domain="authority.example",
                    status="failed",
                    claims_json=[{"claim_id": "rejected-claim"}],
                    section_ids_json=["section-1"],
                    summary_json={},
                    metadata_json={"verification_status": "not_found"},
                ),
            ]
            listed = await client.get(
                "/api/v1/projects/project-a/articles",
                params={"page": 1, "page_size": 25, "search": "BATTERY"},
            )
            detail = await client.get(
                f"/api/v1/projects/project-a/articles/{article_id}"
            )
            run = await client.get(
                f"/api/v1/projects/project-a/articles/{article_id}/run"
            )
            cross_project_detail = await client.get(
                f"/api/v1/projects/project-b/articles/{article_id}"
            )
            cross_project_run = await client.get(
                f"/api/v1/projects/project-b/articles/{article_id}/run"
            )
            cancelled = await client.post(
                f"/api/v1/projects/project-a/articles/{article_id}/cancel"
            )
            cancelled_again = await client.post(
                f"/api/v1/projects/project-a/articles/{article_id}/cancel"
            )
            missing_project = await client.post(
                "/api/v1/projects/project-missing/articles",
                headers={"Idempotency-Key": "request-2"},
                json={"primary_keyword": "valid keyword"},
            )
            return {
                "first": first,
                "repeated": repeated,
                "conflict": conflict,
                "listed": listed,
                "detail": detail,
                "run": run,
                "cross_project_detail": cross_project_detail,
                "cross_project_run": cross_project_run,
                "cancelled": cancelled,
                "cancelled_again": cancelled_again,
                "missing_project": missing_project,
                "repository": repository,
                "controller": controller,
                "resolver": resolver,
            }
    finally:
        app.dependency_overrides.clear()
        app.state.platform_context_resolver = previous_resolver


def test_content_api_is_idempotent_scoped_listed_and_cancellable() -> None:
    result = asyncio.run(request_scenario())

    assert result["first"].status_code == 202
    assert result["first"].json() == result["repeated"].json()
    assert result["first"].json()["primary_keyword"] == "solar battery payback"
    assert result["first"].json()["status"] == "queued"
    assert result["first"].json()["publication_status"] == "complete_draft"
    assert result["first"].json()["run"]["stage"] == "queued"
    assert result["first"].json()["run"]["progress"] == 0
    assert len(result["repository"].articles) == 1
    assert len(result["repository"].runs) == 1
    run = next(iter(result["repository"].runs.values()))
    assert run.model_snapshot_json == {
        "base_url": "https://models.example/v1",
        "provider": "openai",
        "model": "writing-model",
        "request_timeout_seconds": 30,
        "max_retries": 1,
        "updated_at": NOW.isoformat(),
    }
    assert "secret-not-in-snapshot" not in str(run.model_snapshot_json)

    assert result["conflict"].status_code == 409
    assert "幂等键" in result["conflict"].json()["detail"]
    assert result["listed"].status_code == 200
    assert result["listed"].json()["total"] == 1
    assert result["detail"].status_code == 200
    assert result["detail"].json()["markdown"].startswith("# Solar battery")
    assert result["detail"].json()["outline"]["sections"][0]["heading"] == (
        "Payback factors"
    )
    assert result["detail"].json()["external_sources"][0]["url"] == (
        "https://authority.example/payback"
    )
    assert result["detail"].json()["internal_links"][0]["url"] == (
        "https://example.com/solar-financing"
    )
    assert result["run"].status_code == 200
    assert result["cross_project_detail"].status_code == 404
    assert result["cross_project_run"].status_code == 404
    assert result["missing_project"].status_code == 404

    assert result["cancelled"].status_code == 200
    assert result["cancelled"].json()["status"] == "cancelled"
    assert result["cancelled"].json()["run"]["status"] == "cancelled"
    assert result["cancelled_again"].json() == result["cancelled"].json()
    assert result["controller"].cancelled == [run.workflow_id, run.workflow_id]
    assert ("project-a", "content:read") in result["resolver"].calls
    assert ("project-a", "content:write") in result["resolver"].calls


def test_article_detail_hides_failed_source_audit_records() -> None:
    result = asyncio.run(request_scenario())

    assert [
        item["url"] for item in result["detail"].json()["external_sources"]
    ] == ["https://authority.example/payback"]


def test_publication_status_is_independent_from_runtime_warnings() -> None:
    publishable = {
        "quality": {"passed": True, "evidence_issue_count": 0, "issues": []},
        "sections": [{"section_id": "section-1", "summary": "complete"}],
        "degraded_section_ids": [],
    }
    evidence_gap = deepcopy(publishable)
    evidence_gap["quality"] = {
        "passed": True,
        "evidence_issue_count": 1,
        "issues": [{"category": "evidence"}],
    }
    fallback = deepcopy(publishable)
    fallback["degraded_section_ids"] = ["section-1"]

    assert publication_status_for_artifact(publishable) == "publish_ready"
    assert publication_status_for_artifact(evidence_gap) == "complete_draft"
    assert publication_status_for_artifact(fallback) == "complete_draft"
    assert publication_status_for_artifact({"quality": {"passed": False}}) == (
        "complete_draft"
    )


async def validation_scenario() -> list[int]:
    service, _, _ = build_service()
    previous_resolver = app.state.platform_context_resolver
    app.state.platform_context_resolver = ContentResolver()
    app.dependency_overrides[get_content_service] = lambda: service
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            responses = [
                await client.post(
                    "/api/v1/projects/project-a/articles",
                    json={"primary_keyword": "valid"},
                ),
                await client.post(
                    "/api/v1/projects/project-a/articles",
                    headers={"Idempotency-Key": "blank-keyword"},
                    json={"primary_keyword": "   "},
                ),
                await client.post(
                    "/api/v1/projects/project-a/articles",
                    headers={"Idempotency-Key": "long-keyword"},
                    json={"primary_keyword": "x" * 201},
                ),
                await client.post(
                    "/api/v1/projects/project-a/articles",
                    headers={"Idempotency-Key": "extra-field"},
                    json={"primary_keyword": "valid", "organization_id": "other-org"},
                ),
            ]
            invalid_status = await client.get(
                "/api/v1/projects/project-a/articles", params={"status": "failed"}
            )
            return [response.status_code for response in responses] + [
                invalid_status.status_code
            ]
    finally:
        app.dependency_overrides.clear()
        app.state.platform_context_resolver = previous_resolver


def test_content_api_validates_the_only_user_input() -> None:
    assert asyncio.run(validation_scenario()) == [422, 422, 422, 422, 422]


def test_content_api_rejects_creation_without_writing_model() -> None:
    async def scenario() -> int:
        service, _, _ = build_service(configured=False)
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = ContentResolver()
        app.dependency_overrides[get_content_service] = lambda: service
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.post(
                    "/api/v1/projects/project-a/articles",
                    headers={"Idempotency-Key": "missing-model"},
                    json={"primary_keyword": "solar battery payback"},
                )
                return response.status_code
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    assert asyncio.run(scenario()) == 422


def test_temporal_outage_keeps_run_queued_for_background_dispatch() -> None:
    async def scenario() -> tuple[str, int]:
        service, repository, controller = build_service(controller_available=False)
        response = await service.create_article(
            "project-a",
            type("Request", (), {"primary_keyword": "solar battery payback"})(),
            "temporal-outage",
        )
        controller.available = True
        dispatched = await service.dispatch_queued()
        run = repository.runs[response.run.id]
        return run.status, dispatched

    assert asyncio.run(scenario()) == ("queued", 1)


def test_due_plan_temporal_failure_retries_the_same_article_and_run() -> None:
    class PlanDispatchRepository(FakeContentRepository):
        def __init__(self) -> None:
            super().__init__()
            self.item = SimpleNamespace(
                id="plan-item-1",
                project_id="project-a",
                version=1,
                status="scheduled",
                article_id=None,
                trigger_lease_until=None,
                error_code=None,
                error_detail=None,
            )
            self.create_calls = 0
            self.release_calls = 0

        async def claim_due_plan_items(self, *, now: datetime, limit: int = 20) -> list:
            del now, limit
            if self.item.article_id is not None:
                return []
            self.item.status = "triggering"
            return [(self.item, "test-org")]

        async def create_article_from_plan(self, *_: Any, **__: Any) -> tuple[Article, ArticleRun]:
            self.create_calls += 1
            article, run = await self.create_article(
                "test-org",
                "project-a",
                "content planning",
                "content-plan:plan-item-1:article",
                "plan-item-1",
                {},
            )
            article.plan_item_id = self.item.id
            self.item.article_id = article.id
            self.item.status = "generating"
            return article, run

        async def release_plan_trigger(
            self, plan_item_id: str, *, error_code: str, error_detail: str
        ) -> None:
            del error_code, error_detail
            assert plan_item_id == self.item.id
            self.release_calls += 1
            if self.item.article_id is None:
                self.item.status = "scheduled"

    async def scenario() -> tuple[int, int, int, int, int]:
        repository = PlanDispatchRepository()
        controller = FakeWorkflowController(available=False)
        service = ContentService(
            Settings(default_organization_id="test-org"),
            repository,  # type: ignore[arg-type]
            ai_settings=FakeAISettings(),
            controller=controller,
        )

        first = await service.dispatch_queued()
        controller.available = True
        second = await service.dispatch_queued()

        return (
            first,
            second,
            repository.create_calls,
            len(repository.articles),
            len(repository.runs),
        )

    assert asyncio.run(scenario()) == (0, 1, 1, 1, 1)


def test_due_plan_failure_before_article_creation_restores_schedule() -> None:
    class FailingPlanRepository(FakeContentRepository):
        def __init__(self) -> None:
            super().__init__()
            self.item = SimpleNamespace(
                id="plan-item-before-create",
                project_id="project-a",
                version=1,
                status="triggering",
                article_id=None,
                trigger_lease_until=NOW,
                error_code=None,
                error_detail=None,
            )

        async def claim_due_plan_items(self, *, now: datetime, limit: int = 20) -> list:
            del now, limit
            return [(self.item, "test-org")]

        async def create_article_from_plan(self, *_: Any, **__: Any) -> tuple[Article, ArticleRun]:
            raise RuntimeError("database unavailable before article creation")

        async def release_plan_trigger(
            self, plan_item_id: str, *, error_code: str, error_detail: str
        ) -> None:
            assert plan_item_id == self.item.id
            self.item.status = "scheduled"
            self.item.trigger_lease_until = None
            self.item.error_code = error_code
            self.item.error_detail = error_detail

    async def scenario() -> tuple[int, str, Any, str, str]:
        repository = FailingPlanRepository()
        service = ContentService(
            Settings(default_organization_id="test-org"),
            repository,  # type: ignore[arg-type]
            ai_settings=FakeAISettings(),
            controller=FakeWorkflowController(),
        )
        dispatched = await service.dispatch_queued()
        return (
            dispatched,
            repository.item.status,
            repository.item.trigger_lease_until,
            repository.item.error_code,
            repository.item.error_detail,
        )

    assert asyncio.run(scenario()) == (
        0,
        "scheduled",
        None,
        "plan_trigger_failed",
        "database unavailable before article creation",
    )


def test_request_hash_is_based_on_the_normalized_keyword() -> None:
    service, _, _ = build_service()

    assert service.request_hash("solar battery payback") == sha256(
        b'{"primary_keyword":"solar battery payback"}'
    ).hexdigest()


def test_article_cannot_be_read_from_another_organization() -> None:
    async def scenario() -> None:
        service, repository, controller = build_service()
        created = await service.create_article(
            "project-a",
            type("Request", (), {"primary_keyword": "solar battery payback"})(),
            "cross-organization",
        )
        other_organization = ContentService(
            Settings(default_organization_id="other-org"),
            repository,
            ai_settings=FakeAISettings(),
            controller=controller,
        )

        try:
            await other_organization.get_article("project-a", created.id)
        except ContentNotFoundError:
            pass
        else:
            raise AssertionError("cross-organization article read was allowed")

    asyncio.run(scenario())


def test_plan_generation_not_found_does_not_start_workflow() -> None:
    class MissingPlanRepository(FakeContentRepository):
        def __init__(self) -> None:
            super().__init__()
            self.plan_create_calls = 0

        async def create_article_from_plan(
            self, *_: Any, **__: Any
        ) -> tuple[Article, ArticleRun]:
            self.plan_create_calls += 1
            raise LookupError("content_plan_item_not_found")

    async def scenario() -> tuple[int, int, int, int]:
        repository = MissingPlanRepository()
        controller = FakeWorkflowController()
        service = ContentService(
            Settings(default_organization_id="test-org"),
            repository,  # type: ignore[arg-type]
            ai_settings=FakeAISettings(),
            controller=controller,
        )

        try:
            await service.generate_plan_item_now(
                "project-b",
                "plan-item-from-project-a",
                expected_version=1,
            )
        except ContentNotFoundError:
            pass
        else:
            raise AssertionError("cross-project plan generation was allowed")

        return (
            repository.plan_create_calls,
            len(repository.articles),
            len(repository.runs),
            len(controller.started),
        )

    assert asyncio.run(scenario()) == (1, 0, 0, 0)


def test_review_uses_authenticated_actor_and_rejects_forged_reviewer() -> None:
    async def scenario() -> tuple[int, int, dict, int, dict, list[str]]:
        service, repository, _controller = build_service()
        created = await service.create_article(
            "project-a",
            type("Request", (), {"primary_keyword": "content workflow"})(),
            "review-contract",
        )
        article = repository.articles[created.id]
        run = repository.runs[article.current_run_id or ""]
        article.status = "completed"
        article.review_status = "pending_review"
        article.review_version = 1
        run.status = "completed"
        app.dependency_overrides[get_content_service] = lambda: service
        previous_resolver = app.state.platform_context_resolver
        app.state.platform_context_resolver = ContentResolver()
        try:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                forged = await client.patch(
                    f"/api/v1/projects/project-a/articles/{article.id}/review",
                    json={
                        "review_status": "approved",
                        "review_version": 1,
                        "reviewed_by": "forged-user",
                    },
                )
                missing_note = await client.patch(
                    f"/api/v1/projects/project-a/articles/{article.id}/review",
                    json={
                        "review_status": "changes_requested",
                        "review_note": "",
                        "review_version": 1,
                    },
                )
                first = await client.patch(
                    f"/api/v1/projects/project-a/articles/{article.id}/review",
                    json={"review_status": "approved", "review_version": 1},
                )
                stale = await client.patch(
                    f"/api/v1/projects/project-a/articles/{article.id}/review",
                    json={
                        "review_status": "changes_requested",
                        "review_note": "Revise this draft",
                        "review_version": 1,
                    },
                )
                return (
                    forged.status_code,
                    missing_note.status_code,
                    missing_note.json(),
                    first.status_code,
                    stale.status_code,
                    stale.json(),
                    repository.reviewed_by,
                )
        finally:
            app.dependency_overrides.clear()
            app.state.platform_context_resolver = previous_resolver

    forged_status, missing_note_status, missing_note, first_status, stale_status, stale, reviewed_by = asyncio.run(scenario())
    assert forged_status == 422
    assert missing_note_status == 422
    assert missing_note["error"] == {
        "code": "review_note_required",
        "message": "review_note_required",
        "retryable": False,
    }
    assert first_status == 200
    assert stale_status == 409
    assert stale["error"] == {
        "code": "stale_review_version",
        "message": "stale_review_version",
        "retryable": False,
    }
    assert reviewed_by == ["reviewer-from-token"]
