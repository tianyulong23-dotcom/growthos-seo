import asyncio
from datetime import UTC, datetime

from httpx import ASGITransport, AsyncClient, MockTransport, Response

from app.core.backlinks_gateway import BacklinksGateway
from app.core.config import get_settings
from app.core.platform_request_context import (
    PlatformActor,
    PlatformTenant,
    ResolvedPlatformCollectionContext,
)
from app.main import create_app
from app.modules.projects.service import WebsiteProjectRecord


class StaticResolver:
    async def resolve_collection(
        self,
        *,
        request: object,
    ) -> ResolvedPlatformCollectionContext:
        del request
        return ResolvedPlatformCollectionContext(
            actor=PlatformActor(
                user_id="local-user",
                session_id="local-session",
                roles=("member",),
            ),
            tenant=PlatformTenant(
                organization_id="org-real",
                workspace_id="workspace-real",
            ),
            permissions=("backlinks:read", "backlinks:write"),
            correlation_id="request-projects",
            authorized_project_ids=None,
        )


class StaticProjectService:
    def __init__(self, projects: tuple[WebsiteProjectRecord, ...]) -> None:
        self.projects = projects
        self.calls: list[dict[str, object]] = []

    async def list_projects(self, **kwargs) -> tuple[WebsiteProjectRecord, ...]:
        self.calls.append(kwargs)
        return self.projects


def project_record(
    *,
    project_id: str,
    project_key: str,
    name: str,
    domain: str,
) -> WebsiteProjectRecord:
    now = datetime(2026, 8, 5, 1, 0, tzinfo=UTC)
    return WebsiteProjectRecord(
        website_project_id=project_id,
        website_project_key=project_key,
        organization_id="org-real",
        workspace_id="workspace-real",
        status="ACTIVE",
        archived_at=None,
        name=name,
        domain=domain,
        country="US",
        target_market="United States",
        language="en",
        health=0,
        context_version=1,
        profile_version_id=f"{project_id}-profile",
        promotion_target_version_id=f"{project_id}-promotion",
        products=(),
        keywords=(),
        target_urls=(),
        input_required=("products", "keywords", "target_urls"),
        created_at=now,
        updated_at=now,
    )


def test_lists_all_authorized_active_projects_without_environment_filter(
    monkeypatch,
) -> None:
    monkeypatch.setenv("BACKLINKS_RUNTIME_MODE", "LOCAL_PRODUCT")
    monkeypatch.setenv("LOCAL_PRODUCT_WEBSITE_PROJECT_KEY", "elephtv")
    get_settings.cache_clear()
    service = StaticProjectService(
        (
            project_record(
                project_id="project-elephtv",
                project_key="elephtv",
                name="ElephTV",
                domain="elephtv.com",
            ),
            project_record(
                project_id="project-second",
                project_key="second-real-site",
                name="Second Real Site",
                domain="second-real-site.com",
            ),
        )
    )
    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=b"test-only-platform-context-key-32-bytes",
        client=AsyncClient(transport=MockTransport(lambda _: Response(200))),
    )
    app = create_app(
        backlinks_gateway=gateway,
        platform_context_resolver=StaticResolver(),
        website_project_service=service,
    )

    async def request_projects() -> Response:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://localhost",
        ) as client:
            return await client.get(
                "/api/v1/projects",
                headers={
                    "origin": "http://localhost:5173",
                    "x-request-id": "request-projects",
                },
            )

    response = asyncio.run(request_projects())
    get_settings.cache_clear()

    assert response.status_code == 200
    assert [project["website_project_key"] for project in response.json()] == [
        "elephtv",
        "second-real-site",
    ]
    assert service.calls == [
        {
            "organization_id": "org-real",
            "workspace_id": "workspace-real",
            "legacy_project_id": "",
            "legacy_project_key": "elephtv",
            "authorized_project_ids": None,
            "include_archived": False,
        }
    ]
