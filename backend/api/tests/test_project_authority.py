import asyncio
from types import SimpleNamespace

from fastapi import Request

from app.api.routes import projects as project_routes
from app.modules.projects.authority import SQLAlchemyWebsiteProjectAuthority
from app.modules.projects.models import Project
from app.modules.projects.schemas import CreateProjectRequest


class FakeSession:
    def __init__(self, project: Project | None) -> None:
        self.project = project
        self.statement = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        del exc_type, exc, traceback

    async def scalar(self, statement):
        self.statement = statement
        return self.project


class FakeSessionFactory:
    def __init__(self, session: FakeSession) -> None:
        self.session = session

    def __call__(self) -> FakeSession:
        return self.session


def test_reads_coworker_project_master_data_without_creating_second_crud() -> None:
    project = Project(
        id="project-1",
        organization_id="org-1",
        name="Project One",
        domain="example.com",
        country="US",
        language="en",
        health=0,
    )
    session = FakeSession(project)
    authority = SQLAlchemyWebsiteProjectAuthority(FakeSessionFactory(session))

    resolved = asyncio.run(authority.get_by_key("project-1"))

    assert Project.__tablename__ == "projects"
    assert resolved is not None
    assert resolved.website_project_id == "project-1"
    assert resolved.website_project_key == "project-1"
    assert resolved.organization_id == "org-1"
    assert resolved.workspace_id == "local"
    assert "projects.id" in str(session.statement)
    assert "projects.project_key" in str(session.statement)


class RecordingPlatformContextResolver:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None]] = []

    async def resolve_collection(
        self,
        *,
        request: Request,
        required_permission: str = "backlinks:read",
    ):
        del request
        self.calls.append(("collection", required_permission, None))
        return SimpleNamespace(
            tenant=SimpleNamespace(
                organization_id="resolved-org",
                workspace_id="resolved-workspace",
            ),
            actor=SimpleNamespace(user_id="resolved-user"),
        )

    async def resolve(
        self,
        *,
        request: Request,
        website_project_key: str,
        required_permission: str | None = None,
    ):
        del request
        self.calls.append(("project", required_permission or "", website_project_key))
        return SimpleNamespace(
            tenant=SimpleNamespace(
                organization_id="resolved-org",
                workspace_id="resolved-workspace",
            ),
            actor=SimpleNamespace(user_id="resolved-user"),
        )


class RecordingProjectService:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None]] = []

    async def list(
        self,
        *,
        organization_id: str | None = None,
        workspace_id: str | None = None,
        lifecycle_status: str | None = "ACTIVE",
    ):
        self.calls.append(("list", organization_id or "", None))
        assert workspace_id == "resolved-workspace"
        assert lifecycle_status == "ACTIVE"
        return []

    async def get(
        self,
        project_id: str,
        *,
        organization_id: str | None = None,
        workspace_id: str | None = None,
    ):
        self.calls.append(("get", organization_id or "", project_id))
        assert workspace_id == "resolved-workspace"
        return SimpleNamespace(id=project_id)

    async def create(
        self,
        request: CreateProjectRequest,
        *,
        organization_id: str | None = None,
        workspace_id: str | None = None,
    ):
        self.calls.append(("create", organization_id or "", request.domain))
        assert workspace_id == "resolved-workspace"
        return SimpleNamespace(id="created-project")


def project_request(resolver: RecordingPlatformContextResolver, method: str) -> Request:
    application = SimpleNamespace(
        state=SimpleNamespace(platform_context_resolver=resolver),
    )
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": "/api/v1/projects",
            "raw_path": b"/api/v1/projects",
            "query_string": b"",
            "headers": [(b"x-request-id", b"project-authority-test")],
            "client": ("127.0.0.1", 50000),
            "server": ("api.test", 80),
            "app": application,
        }
    )


def test_project_routes_use_resolved_organization_and_project_permissions(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        project_routes,
        "get_settings",
        lambda: SimpleNamespace(
            app_env="production",
            platform_local_development_auth_enabled=False,
            default_organization_id="must-not-be-used",
        ),
    )
    resolver = RecordingPlatformContextResolver()
    service = RecordingProjectService()

    async def run_routes() -> None:
        await project_routes.list_projects(project_request(resolver, "GET"), service)
        await project_routes.get_project(
            "project-1",
            project_request(resolver, "GET"),
            service,
        )
        await project_routes.create_project(
            project_request(resolver, "POST"),
            CreateProjectRequest(domain="example.com", country="US", language="en"),
            service,
        )

    asyncio.run(run_routes())

    assert resolver.calls == [
        ("collection", "projects:read", None),
        ("project", "projects:read", "project-1"),
        ("collection", "projects:write", None),
    ]
    assert service.calls == [
        ("list", "resolved-org", None),
        ("get", "resolved-org", "project-1"),
        ("create", "resolved-org", "example.com"),
    ]
