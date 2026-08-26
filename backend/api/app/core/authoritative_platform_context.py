from collections.abc import Callable
from datetime import UTC, datetime
from uuid import uuid4

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
    ResolvedPlatformCollectionContext,
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

    def _authenticate(self, request: Request):
        try:
            return self._authentication.authenticate(
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

    @staticmethod
    def _correlation_id(request: Request) -> str:
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
        return correlation_id

    async def resolve_collection(
        self,
        *,
        request: Request,
        required_permission: str = "backlinks:read",
    ) -> ResolvedPlatformCollectionContext:
        actor = self._authenticate(request)
        eligible = tuple(
            membership
            for membership in actor.memberships
            if required_permission in membership.permissions
        )
        if not eligible:
            raise PlatformContextResolutionError(
                status=403,
                code="PLATFORM_PERMISSION_DENIED",
                title="Platform permission denied",
                detail=f"The authenticated actor lacks {required_permission}.",
            )
        tenant_scopes = {
            (membership.organization_id, membership.workspace_id)
            for membership in eligible
        }
        if len(tenant_scopes) != 1:
            raise PlatformContextResolutionError(
                status=403,
                code="PLATFORM_WORKSPACE_SCOPE_REQUIRED",
                title="Platform workspace scope required",
                detail=(
                    "The authenticated request must resolve to exactly one "
                    "Organization and Workspace."
                ),
            )
        organization_id, workspace_id = next(iter(tenant_scopes))
        scoped = tuple(
            membership
            for membership in eligible
            if membership.organization_id == organization_id
            and membership.workspace_id == workspace_id
        )
        return ResolvedPlatformCollectionContext(
            actor=PlatformActor(
                user_id=actor.user_id,
                session_id=actor.session_id,
                roles=tuple(sorted({role for item in scoped for role in item.roles})),
            ),
            tenant=PlatformTenant(
                organization_id=organization_id,
                workspace_id=workspace_id,
            ),
            permissions=tuple(
                sorted({permission for item in scoped for permission in item.permissions})
            ),
            correlation_id=self._correlation_id(request),
        )

    async def resolve(
        self,
        *,
        request: Request,
        website_project_key: str,
        required_permission: str | None = None,
    ) -> ResolvedPlatformRequestContext:
        actor = self._authenticate(request)

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
            and membership.workspace_id == project.workspace_id
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


class LocalDevelopmentPlatformContextResolver:
    _permissions = (
        "backlinks:read",
        "backlinks:write",
        "content:ai_edit",
        "content:edit",
        "content:manage_assets",
        "content:manage_locks",
        "content:manage_seo_advanced",
        "content:publish",
        "content:read",
        "content:review",
        "content:submit_review",
        "content:write",
        "projects:read",
        "projects:write",
    )

    def __init__(
        self,
        *,
        projects: WebsiteProjectAuthority,
        organization_id: str,
        workspace_id: str,
        user_id: str,
    ) -> None:
        self._projects = projects
        self._organization_id = organization_id
        self._workspace_id = workspace_id
        self._user_id = user_id

    async def resolve_collection(
        self,
        *,
        request: Request,
        required_permission: str = "backlinks:read",
    ) -> ResolvedPlatformCollectionContext:
        if required_permission not in self._permissions:
            raise PlatformContextResolutionError(
                status=403,
                code="PLATFORM_PERMISSION_DENIED",
                title="Platform permission denied",
                detail=f"The local actor lacks {required_permission}.",
            )
        correlation_id = (
            request.headers.get("x-request-id", "").strip()
            or request.headers.get("x-correlation-id", "").strip()
            or f"local-oauth-callback-{uuid4().hex}"
        )
        return ResolvedPlatformCollectionContext(
            actor=PlatformActor(
                user_id=self._user_id,
                session_id="local-development",
                roles=("owner",),
            ),
            tenant=PlatformTenant(
                organization_id=self._organization_id,
                workspace_id=self._workspace_id,
            ),
            permissions=self._permissions,
            correlation_id=correlation_id,
        )

    async def resolve(
        self,
        *,
        request: Request,
        website_project_key: str,
        required_permission: str | None = None,
    ) -> ResolvedPlatformRequestContext:
        project = await self._projects.get_by_key(website_project_key)
        if project is None:
            raise PlatformContextResolutionError(
                status=404,
                code="PLATFORM_PROJECT_NOT_FOUND",
                title="Platform project not found",
                detail="The requested Website Project does not exist.",
            )
        if (
            project.organization_id != self._organization_id
            or project.workspace_id != self._workspace_id
        ):
            raise PlatformContextResolutionError(
                status=409,
                code="PLATFORM_LOCAL_PROJECT_TENANT_MISMATCH",
                title="Local project tenant mismatch",
                detail=(
                    "The requested Website Project is not assigned to the configured "
                    "local organization and workspace."
                ),
            )

        required_permission = required_permission or (
            "backlinks:read" if request.method in {"GET", "HEAD"} else "backlinks:write"
        )
        if required_permission not in self._permissions:
            raise PlatformContextResolutionError(
                status=403,
                code="PLATFORM_PERMISSION_DENIED",
                title="Platform permission denied",
                detail=f"The local actor lacks {required_permission}.",
            )

        correlation_id = (
            request.headers.get("x-request-id", "").strip()
            or request.headers.get("x-correlation-id", "").strip()
            or f"local-{uuid4().hex}"
        )
        return ResolvedPlatformRequestContext(
            actor=PlatformActor(
                user_id=self._user_id,
                session_id="local-development",
                roles=("owner",),
            ),
            tenant=PlatformTenant(
                organization_id=self._organization_id,
                workspace_id=self._workspace_id,
            ),
            project=PlatformProject(
                website_project_id=project.website_project_id,
                website_project_key=project.website_project_key,
            ),
            permissions=self._permissions,
            correlation_id=correlation_id,
        )
