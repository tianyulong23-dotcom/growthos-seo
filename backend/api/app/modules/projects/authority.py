from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from sqlalchemy import or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.projects.models import Project, SiteProfile


@dataclass(frozen=True)
class AuthoritativeWebsiteProject:
    website_project_id: str
    website_project_key: str
    organization_id: str
    workspace_id: str | None = None
    status: str = "ACTIVE"


@dataclass(frozen=True)
class WebsiteProjectDetails:
    website_project_id: str
    website_project_key: str
    organization_id: str
    workspace_id: str | None
    status: str
    archived_at: datetime | None
    name: str
    domain: str
    country: str
    target_market: str
    language: str
    health: int
    context_version: int
    current_profile_version_id: str | None
    current_promotion_target_version_id: str | None
    understanding_run_id: str | None
    audit_run_id: str | None
    audit_health: int | None
    created_at: datetime
    profile_json: dict | None
    profile_confidence: float | None


class WebsiteProjectAuthority(Protocol):
    async def get_by_key(
        self,
        website_project_key: str,
        organization_ids: tuple[str, ...],
    ) -> AuthoritativeWebsiteProject | None: ...


class WebsiteProjectReader(Protocol):
    async def get_details(
        self,
        website_project_id: str,
        organization_id: str,
    ) -> WebsiteProjectDetails | None: ...


class SQLAlchemyWebsiteProjectAuthority:
    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
    ) -> None:
        self._sessions = sessions

    async def get_by_key(
        self,
        website_project_key: str,
        organization_ids: tuple[str, ...],
    ) -> AuthoritativeWebsiteProject | None:
        for organization_id in dict.fromkeys(organization_ids):
            async with self._sessions() as session, session.begin():
                await session.execute(
                    text(
                        "SELECT set_config('app.current_organization_id', :organization_id, true), "
                        "set_config('app.current_project_id', '', true)"
                    ),
                    {
                        "organization_id": organization_id,
                    },
                )
                project = await session.scalar(
                    select(Project).where(
                        or_(
                            Project.id == website_project_key,
                            Project.project_key == website_project_key,
                        ),
                        Project.status == "ACTIVE",
                    )
                )
            if project is not None:
                return AuthoritativeWebsiteProject(
                    website_project_id=project.id,
                    website_project_key=project.project_key,
                    organization_id=project.organization_id,
                    workspace_id=project.workspace_id,
                    status=project.status,
                )
        return None

    async def get_details(
        self,
        website_project_id: str,
        organization_id: str,
    ) -> WebsiteProjectDetails | None:
        async with self._sessions() as session, session.begin():
            await session.execute(
                text(
                    "SELECT set_config('app.current_organization_id', :organization_id, true), "
                    "set_config('app.current_project_id', :project_id, true)"
                ),
                {
                    "organization_id": organization_id,
                    "project_id": website_project_id,
                },
            )
            row = (
                await session.execute(
                    select(Project, SiteProfile)
                    .outerjoin(SiteProfile, SiteProfile.project_id == Project.id)
                    .where(Project.id == website_project_id)
                )
            ).one_or_none()
        if row is None:
            return None
        project, profile = row
        return WebsiteProjectDetails(
            website_project_id=project.id,
            website_project_key=project.project_key,
            organization_id=project.organization_id,
            workspace_id=project.workspace_id,
            status=project.status,
            archived_at=project.archived_at,
            name=project.name,
            domain=project.domain,
            country=project.country,
            target_market=project.target_market,
            language=project.language,
            health=project.health,
            context_version=project.context_version,
            current_profile_version_id=project.current_profile_version_id,
            current_promotion_target_version_id=(
                project.current_promotion_target_version_id
            ),
            understanding_run_id=project.understanding_run_id,
            audit_run_id=project.audit_run_id,
            audit_health=project.audit_health,
            created_at=project.created_at,
            profile_json=profile.profile_json if profile is not None else None,
            profile_confidence=profile.confidence if profile is not None else None,
        )
