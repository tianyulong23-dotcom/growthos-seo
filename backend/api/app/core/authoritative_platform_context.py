from collections.abc import Callable
from datetime import UTC, datetime

from fastapi import Request

from app.core.backlinks_gateway import PlatformContextResolutionError
from app.core.platform_auth import (
    HmacPlatformAuthenticationAuthority,
    PlatformAuthenticationError,
)
from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.modules.projects.authority import WebsiteProjectAuthority


class AuthoritativePlatformContextResolver:
    def __init__(
        self,
        *,
        authentication: HmacPlatformAuthenticationAuthority,
        projects: WebsiteProjectAuthority,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._authentication = authentication
        self._projects = projects
        self._clock = clock or (lambda: datetime.now(UTC))

    async def resolve(
        self,
        *,
        request: Request,
        website_project_key: str,
        required_permission: str | None = None,
    ) -> ResolvedPlatformRequestContext:
        try:
            actor = self._authentication.authenticate(
                request.headers.get("authorization"),
                now=self._clock(),
            )
        except PlatformAuthenticationError as error:
            raise PlatformContextResolutionError(
                status=401,
                code=error.code,
                title="Platform authentication failed",
                detail=error.detail,
            ) from error

        project = await self._projects.get_by_key(website_project_key)
        if project is None:
            raise PlatformContextResolutionError(
                status=404,
                code="PLATFORM_PROJECT_NOT_FOUND",
                title="Platform project not found",
                detail="The requested Website Project does not exist.",
            )

        tenant_memberships = tuple(
            membership
            for membership in actor.memberships
            if membership.organization_id == project.organization_id
        )
        if not tenant_memberships:
            raise PlatformContextResolutionError(
                status=403,
                code="PLATFORM_TENANT_ACCESS_DENIED",
                title="Platform tenant access denied",
                detail="The authenticated actor is not a member of the project's organization.",
            )

        project_memberships = tuple(
            membership
            for membership in tenant_memberships
            if project.website_project_id in membership.project_ids
        )
        if len(project_memberships) != 1:
            raise PlatformContextResolutionError(
                status=403,
                code="PLATFORM_PROJECT_ACCESS_DENIED",
                title="Platform project access denied",
                detail="The authenticated membership does not grant access to this project.",
            )
        membership = project_memberships[0]
        required_permission = required_permission or (
            "backlinks:read" if request.method in {"GET", "HEAD"} else "backlinks:write"
        )
        if required_permission not in membership.permissions:
            raise PlatformContextResolutionError(
                status=403,
                code="PLATFORM_PERMISSION_DENIED",
                title="Platform permission denied",
                detail=f"The authenticated membership lacks {required_permission}.",
            )

        correlation_id = (
            request.headers.get("x-request-id", "").strip()
            or request.headers.get("x-correlation-id", "").strip()
        )
        if not correlation_id:
            raise PlatformContextResolutionError(
                status=400,
                code="PLATFORM_REQUEST_ID_REQUIRED",
                title="Platform request ID required",
                detail="A non-blank x-request-id or x-correlation-id header is required.",
            )

        return ResolvedPlatformRequestContext(
            actor=PlatformActor(
                user_id=actor.user_id,
                session_id=actor.session_id,
                roles=membership.roles,
            ),
            tenant=PlatformTenant(
                organization_id=membership.organization_id,
                workspace_id=membership.workspace_id,
            ),
            project=PlatformProject(
                website_project_id=project.website_project_id,
                website_project_key=project.website_project_key,
            ),
            permissions=membership.permissions,
            correlation_id=correlation_id,
        )
