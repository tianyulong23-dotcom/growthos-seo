from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.projects.models import Project


@dataclass(frozen=True)
class AuthoritativeWebsiteProject:
    website_project_id: str
    website_project_key: str
    organization_id: str
    workspace_id: str
    status: str = "ACTIVE"


class WebsiteProjectAuthority(Protocol):
    async def get_by_key(
        self,
        website_project_key: str,
    ) -> AuthoritativeWebsiteProject | None: ...


class SQLAlchemyWebsiteProjectAuthority:
    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
    ) -> None:
        self._sessions = sessions

    async def get_by_key(
        self,
        website_project_key: str,
    ) -> AuthoritativeWebsiteProject | None:
        async with self._sessions() as session:
            project = await session.scalar(
                select(Project).where(
                    (Project.id == website_project_key)
                    | (Project.project_key == website_project_key)
                )
            )
        if project is None:
            return None
        return AuthoritativeWebsiteProject(
            website_project_id=project.id,
            website_project_key=project.project_key or project.id,
            organization_id=project.organization_id,
            workspace_id=project.workspace_id or "local",
            status=project.status,
        )
