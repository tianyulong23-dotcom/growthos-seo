from collections.abc import Callable
from datetime import UTC, datetime
from ipaddress import ip_address
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
    def _required_permission(request: Request) -> str:
        return "backlinks:read" if request.method in {"GET", "HEAD"} else "backlinks:write"

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
    ) -> ResolvedPlatformCollectionContext:
        actor = self._authenticate(request)
        required_permission = self._required_permission(request)
        eligible = tuple(
            membership
            for membership in actor.memberships
            if required_permission in membership.permissions
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
            authorized_project_ids=tuple(
                sorted({project_id for item in scoped for project_id in item.project_ids})
            ),
        )

    async def resolve(
        self,
        *,
        request: Request,
        website_project_key: str,
    ) -> ResolvedPlatformRequestContext:
        actor = self._authenticate(request)

        project = await self._projects.get_by_key(
            website_project_key,
            tuple(membership.organization_id for membership in actor.memberships),
        )
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
            and (
                project.workspace_id is None
                or membership.workspace_id == project.workspace_id
            )
        )
        if len(project_memberships) != 1:
            raise PlatformContextResolutionError(
                status=403,
                code="PLATFORM_PROJECT_ACCESS_DENIED",
                title="Platform project access denied",
                detail="The authenticated membership does not grant access to this project.",
            )
        membership = project_memberships[0]
        required_permission = self._required_permission(request)
        if required_permission not in membership.permissions:
            raise PlatformContextResolutionError(
                status=403,
                code="PLATFORM_PERMISSION_DENIED",
                title="Platform permission denied",
                detail=f"The authenticated membership lacks {required_permission}.",
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
            correlation_id=self._correlation_id(request),
        )


class LocalProductPlatformContextResolver:
    def __init__(
        self,
        *,
        projects: WebsiteProjectAuthority,
        organization_id: str,
        workspace_id: str,
        website_project_id: str,
        website_project_key: str,
        user_id: str,
        session_id: str,
        frontend_origin: str,
    ) -> None:
        self._projects = projects
        self._organization_id = organization_id
        self._workspace_id = workspace_id
        self._website_project_id = website_project_id
        self._website_project_key = website_project_key
        self._user_id = user_id
        self._session_id = session_id
        self._frontend_origin = frontend_origin

    def _validate_boundary(self, request: Request) -> None:
        if not self._is_loopback(request.client.host if request.client else None):
            raise self._denied("LOCAL_PRODUCT_LOOPBACK_REQUIRED")
        if request.url.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise self._denied("LOCAL_PRODUCT_GATEWAY_REQUIRED")
        origin = request.headers.get("origin")
        if origin is not None and origin != self._frontend_origin:
            raise self._denied("LOCAL_PRODUCT_ORIGIN_DENIED")

    @staticmethod
    def _correlation_id(request: Request) -> str:
        correlation_id = (
            request.headers.get("x-request-id", "").strip()
            or request.headers.get("x-correlation-id", "").strip()
        )
        if correlation_id:
            return correlation_id
        callback_suffix = "/backlinks/gmail-connections/callback"
        if request.method == "GET" and request.url.path.endswith(callback_suffix):
            return f"local-oauth-callback-{uuid4()}"
        raise PlatformContextResolutionError(
            status=400,
            code="PLATFORM_REQUEST_ID_REQUIRED",
            title="Platform request ID required",
            detail="A non-blank x-request-id or x-correlation-id header is required.",
        )

    async def resolve_collection(
        self,
        *,
        request: Request,
    ) -> ResolvedPlatformCollectionContext:
        self._validate_boundary(request)
        return ResolvedPlatformCollectionContext(
            actor=PlatformActor(
                user_id=self._user_id,
                session_id=self._session_id,
                roles=("member",),
            ),
            tenant=PlatformTenant(
                organization_id=self._organization_id,
                workspace_id=self._workspace_id,
            ),
            permissions=("backlinks:read", "backlinks:write"),
            correlation_id=self._correlation_id(request),
            authorized_project_ids=None,
        )

    async def resolve(
        self,
        *,
        request: Request,
        website_project_key: str,
    ) -> ResolvedPlatformRequestContext:
        self._validate_boundary(request)

        lookup_key = (
            self._website_project_id
            if website_project_key == self._website_project_key
            else website_project_key
        )
        project = await self._projects.get_by_key(
            lookup_key,
            (self._organization_id,),
        )
        if (
            project is None
            or project.organization_id != self._organization_id
            or project.status != "ACTIVE"
            or (
                project.workspace_id != self._workspace_id
                and not (
                    project.website_project_id == self._website_project_id
                    and project.workspace_id is None
                )
            )
        ):
            raise PlatformContextResolutionError(
                status=404,
                code="PLATFORM_PROJECT_NOT_FOUND",
                title="Platform project not found",
                detail="The requested Website Project does not exist.",
            )

        return ResolvedPlatformRequestContext(
            actor=PlatformActor(
                user_id=self._user_id,
                session_id=self._session_id,
                roles=("member",),
            ),
            tenant=PlatformTenant(
                organization_id=self._organization_id,
                workspace_id=self._workspace_id,
            ),
            project=PlatformProject(
                website_project_id=project.website_project_id,
                website_project_key=(
                    self._website_project_key
                    if project.website_project_id == self._website_project_id
                    else project.website_project_key
                ),
            ),
            permissions=("backlinks:read", "backlinks:write"),
            correlation_id=self._correlation_id(request),
        )

    @staticmethod
    def _is_loopback(value: str | None) -> bool:
        if value is None:
            return False
        if value.lower() == "localhost":
            return True
        try:
            return ip_address(value).is_loopback
        except ValueError:
            return False

    @staticmethod
    def _denied(code: str) -> PlatformContextResolutionError:
        return PlatformContextResolutionError(
            status=403,
            code=code,
            title="Local product request denied",
            detail="The request is outside the controlled local product boundary.",
        )
