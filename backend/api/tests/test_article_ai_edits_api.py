import asyncio
from datetime import UTC, datetime

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.routes.ai_edits import get_ai_edit_service, router
from app.core.backlinks_gateway import PlatformContextResolutionError
from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.modules.content.ai_edit_repository import AIEditRepositoryError
from app.modules.content.ai_edit_schemas import AIEditCandidate, AIEditOperationResponse


class Resolver:
    def __init__(self, permissions: set[str]) -> None:
        self.permissions = permissions
        self.requested: list[str | None] = []

    async def resolve(self, *, request, website_project_key, required_permission=None):
        del request
        self.requested.append(required_permission)
        if required_permission not in self.permissions:
            raise PlatformContextResolutionError(
                status=403,
                code="permission_denied",
                title="Permission denied",
                detail="The required permission is missing.",
            )
        return ResolvedPlatformRequestContext(
            actor=PlatformActor("editor-p6", "session-p6", ("content_editor",)),
            tenant=PlatformTenant("org-p6", "workspace-p6"),
            project=PlatformProject(website_project_key, website_project_key),
            permissions=tuple(sorted(self.permissions)),
            correlation_id="correlation-p6",
        )


def operation(status: str = "queued") -> AIEditOperationResponse:
    now = datetime.now(UTC)
    return AIEditOperationResponse(
        id="operation-p6",
        article_id="article-p6",
        parent_operation_id=None,
        command="rewrite",
        scope="selection",
        status=status,
        base_review_version=1,
        document_hash="a" * 64,
        selection=None,
        prompt_version="article-ai-edit.v1",
        provider=None,
        model=None,
        candidate=AIEditCandidate(kind="text"),
        allowed_modes=["replace"],
        error_code=None,
        error_detail=None,
        input_tokens=0,
        output_tokens=0,
        latency_ms=None,
        stream_revision=0,
        created_at=now,
        started_at=None,
        completed_at=None,
        decided_at=None,
        accepted_mode=None,
        accepted_result=None,
    )


class Service:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def get(self, organization_id, project_id, article_id, operation_id):
        self.calls.append((organization_id, project_id, article_id, operation_id))
        if operation_id == "stale":
            raise AIEditRepositoryError("ai_edit_stale")
        return operation()


def build_api(permissions: set[str]) -> tuple[FastAPI, Service, Resolver]:
    app = FastAPI()
    app.include_router(router)
    service = Service()
    resolver = Resolver(permissions)
    app.state.platform_context_resolver = resolver
    app.dependency_overrides[get_ai_edit_service] = lambda: service
    return app, service, resolver


def test_all_authenticated_ai_routes_require_dedicated_ai_edit_permission() -> None:
    async def scenario() -> None:
        denied_app, denied_service, denied_resolver = build_api({"content:edit"})
        async with AsyncClient(
            transport=ASGITransport(app=denied_app), base_url="http://test"
        ) as client:
            response = await client.get(
                "/api/v1/projects/project-p6/articles/article-p6/ai-edits/operation-p6"
            )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "permission_denied"
        assert denied_service.calls == []
        assert denied_resolver.requested == ["content:ai_edit"]

        app, service, resolver = build_api({"content:ai_edit"})
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v1/projects/project-p6/articles/article-p6/ai-edits/operation-p6"
            )
        assert response.status_code == 200
        assert service.calls == [("org-p6", "project-p6", "article-p6", "operation-p6")]
        assert resolver.requested == ["content:ai_edit"]

    asyncio.run(scenario())


def test_ai_error_contract_separates_conflict_quota_and_validation() -> None:
    async def scenario() -> None:
        app, _, _ = build_api({"content:ai_edit"})
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            stale = await client.get(
                "/api/v1/projects/project-p6/articles/article-p6/ai-edits/stale"
            )
        assert stale.status_code == 409
        assert stale.json()["error"]["code"] == "ai_edit_stale"

    asyncio.run(scenario())
