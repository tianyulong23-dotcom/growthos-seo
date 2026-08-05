import asyncio

from app.modules.projects.authority import SQLAlchemyWebsiteProjectAuthority
from app.modules.projects.models import Project


class FakeSession:
    def __init__(self, project: Project | None) -> None:
        self.project = project
        self.statement = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        del exc_type, exc, traceback

    def begin(self):
        return self

    async def execute(self, statement, values) -> None:
        self.rls_statement = statement
        self.rls_values = values

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
        workspace_id="workspace-1",
        project_key="project-1",
        status="ACTIVE",
        name="Project One",
        domain="example.com",
        country="US",
        target_market="United States",
        language="en",
        health=0,
    )
    session = FakeSession(project)
    authority = SQLAlchemyWebsiteProjectAuthority(FakeSessionFactory(session))

    resolved = asyncio.run(authority.get_by_key("project-1", ("org-1",)))

    assert Project.__tablename__ == "projects"
    assert resolved is not None
    assert resolved.website_project_id == "project-1"
    assert resolved.website_project_key == "project-1"
    assert resolved.organization_id == "org-1"
    assert "projects.id" in str(session.statement)
    assert "app.current_organization_id" in str(session.rls_statement)
    assert session.rls_values == {
        "organization_id": "org-1",
    }
