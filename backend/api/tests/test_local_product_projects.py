import asyncio
from datetime import UTC, datetime

from httpx import ASGITransport, AsyncClient, MockTransport, Response
import pytest

from app.core.backlinks_gateway import BacklinksGateway
from app.core.config import get_settings
from app.core.platform_request_context import (
    PlatformActor,
    PlatformTenant,
    ResolvedPlatformCollectionContext,
)
from app.main import create_app
from app.modules.projects.service import (
    ProjectProfileInput,
    ProjectValidationError,
    WebsiteProjectRecord,
    normalize_profile,
)


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

    async def create_project(self, **kwargs) -> None:
        self.calls.append(kwargs)
        raise AssertionError("create_project must not run during maintenance")


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
        target_audiences=(),
        partnership_goals=(),
        input_required=(
            "products",
            "keywords",
            "target_urls",
            "target_audiences",
            "partnership_goals",
        ),
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


def test_rejects_project_creation_when_business_consumers_are_unavailable(
    monkeypatch,
) -> None:
    class RuntimeStub:
        async def business_consumers_running(self) -> bool:
            return False

    monkeypatch.setenv("BACKLINKS_RUNTIME_MODE", "LOCAL_PRODUCT")
    monkeypatch.setenv("LOCAL_PRODUCT_WEBSITE_PROJECT_KEY", "project-real")
    get_settings.cache_clear()
    service = StaticProjectService(())
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
    app.state.runtime_dependencies = RuntimeStub()

    async def create_project() -> Response:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://localhost",
        ) as client:
            return await client.post(
                "/api/v1/projects",
                headers={
                    "origin": "http://localhost:5173",
                    "x-request-id": "maintenance-project-create",
                },
                json={
                    "name": "Blocked Project",
                    "domain": "blocked.example",
                    "country": "US",
                    "target_market": "United States",
                    "language": "en",
                    "products": ["product"],
                    "keywords": ["keyword"],
                    "target_urls": ["https://blocked.example/"],
                    "target_audiences": ["site owners"],
                    "partnership_goals": ["editorial review"],
                },
            )

    response = asyncio.run(create_project())
    get_settings.cache_clear()

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "BUSINESS_CONSUMERS_UNAVAILABLE"
    assert service.calls == []


def test_normalizes_three_unrelated_complete_project_contexts() -> None:
    contexts = (
        ProjectProfileInput(
            name="Aurora Solar Operations",
            domain="aurora-solar-ops.co",
            country="US",
            target_market="United States commercial solar",
            language="en-US",
            products=("Solar workflow software",),
            keywords=("solar installer operations",),
            target_urls=("https://aurora-solar-ops.co/platform",),
            target_audiences=("Commercial solar installers",),
            partnership_goals=("Operations guide publication",),
        ),
        ProjectProfileInput(
            name="Nordic Veterinary Nutrition",
            domain="nordic-vet.se",
            country="SE",
            target_market="Sweden veterinary clinics",
            language="sv-SE",
            products=("Veterinary nutrition plans",),
            keywords=("veterinary nutrition",),
            target_urls=("https://nordic-vet.se/kliniker",),
            target_audiences=("Veterinary clinic owners",),
            partnership_goals=("Clinical education partnership",),
        ),
        ProjectProfileInput(
            name="Ledger Flow Accounting",
            domain="ledger-flow.de",
            country="DE",
            target_market="Germany accounting firms",
            language="de-DE",
            products=("Accounting workflow integration",),
            keywords=("buchhaltung workflow",),
            target_urls=("https://ledger-flow.de/integration",),
            target_audiences=("Independent accounting firms",),
            partnership_goals=("Integration guide collaboration",),
        ),
    )

    normalized = tuple(normalize_profile(context) for context in contexts)

    assert len({context.domain for context in normalized}) == 3
    assert len({context.target_market for context in normalized}) == 3
    assert len({context.language for context in normalized}) == 3
    assert all(context.products for context in normalized)
    assert all(context.keywords for context in normalized)
    assert all(context.target_urls for context in normalized)
    assert all(context.target_audiences for context in normalized)
    assert all(context.partnership_goals for context in normalized)


@pytest.mark.parametrize(
    "field",
    (
        "products",
        "keywords",
        "target_urls",
        "target_audiences",
        "partnership_goals",
    ),
)
def test_rejects_incomplete_project_context_before_persistence(field: str) -> None:
    values = {
        "products": ("Accounting workflow integration",),
        "keywords": ("accounting workflow",),
        "target_urls": ("https://ledger-flow.de/integration",),
        "target_audiences": ("Independent accounting firms",),
        "partnership_goals": ("Integration guide collaboration",),
    }
    values[field] = ()

    with pytest.raises(ProjectValidationError) as error:
        normalize_profile(
            ProjectProfileInput(
                name="Ledger Flow Accounting",
                domain="ledger-flow.de",
                country="DE",
                target_market="Germany accounting firms",
                language="de-DE",
                **values,
            )
        )

    assert error.value.field == field
