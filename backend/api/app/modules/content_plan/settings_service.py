from __future__ import annotations

from datetime import UTC, datetime
from typing import Protocol

from app.db.session import session_factory
from app.modules.content_plan.models import ContentPlanSettings
from app.modules.content_plan.repository import ContentPlanRepository
from app.modules.content_plan.schemas import (
    ContentPlanSettingsResponse,
    UpdateContentPlanSettingsRequest,
)


class ContentPlanSettingsNotFoundError(Exception):
    pass


class ContentPlanSettingsConflictError(Exception):
    pass


class ContentPlanSettingsRepository(Protocol):
    async def project_exists(self, organization_id: str, project_id: str) -> bool: ...

    async def get_settings(self, project_id: str) -> ContentPlanSettings | None: ...

    async def update_settings(
        self,
        project_id: str,
        *,
        expected_version: int,
        now: datetime,
        cadence: str | None = None,
        paused: bool | None = None,
        timezone_name: str | None = None,
    ) -> ContentPlanSettings: ...


class ContentPlanSettingsService:
    def __init__(self, repository: ContentPlanSettingsRepository) -> None:
        self.repository = repository

    async def get_settings(
        self, organization_id: str, project_id: str
    ) -> ContentPlanSettingsResponse:
        await self._ensure_project(organization_id, project_id)
        settings = await self.repository.get_settings(project_id)
        if settings is None:
            raise ContentPlanSettingsNotFoundError("content_plan_settings_not_found")
        return ContentPlanSettingsResponse.model_validate(settings)

    async def update_settings(
        self,
        organization_id: str,
        project_id: str,
        request: UpdateContentPlanSettingsRequest,
    ) -> ContentPlanSettingsResponse:
        await self._ensure_project(organization_id, project_id)
        try:
            settings = await self.repository.update_settings(
                project_id,
                expected_version=request.version,
                now=datetime.now(UTC),
                cadence=request.cadence,
                paused=request.paused,
                timezone_name=request.timezone,
            )
        except ValueError as exc:
            if str(exc) == "stale_settings_version":
                raise ContentPlanSettingsConflictError(str(exc)) from exc
            if "IANA timezone" in str(exc):
                raise ValueError("timezone_required") from exc
            raise
        return ContentPlanSettingsResponse.model_validate(settings)

    async def _ensure_project(self, organization_id: str, project_id: str) -> None:
        if not await self.repository.project_exists(organization_id, project_id):
            raise ContentPlanSettingsNotFoundError("project_not_found")


def build_content_plan_settings_service() -> ContentPlanSettingsService:
    return ContentPlanSettingsService(ContentPlanRepository(session_factory))
