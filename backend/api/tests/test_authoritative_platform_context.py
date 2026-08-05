import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import Request

from app.core.authoritative_platform_context import (
    AuthoritativePlatformContextResolver,
    LocalProductPlatformContextResolver,
)
from app.core.backlinks_gateway import PlatformContextResolutionError
from app.core.platform_auth import (
    PLATFORM_ACCESS_TOKEN_AUDIENCE,
    PLATFORM_ACCESS_TOKEN_VERSION,
    HmacPlatformAuthenticationAuthority,
)
from app.modules.projects.authority import AuthoritativeWebsiteProject


AUTH_SIGNING_KEY = b"test-only-platform-auth-signing-key-32-bytes"
NOW = datetime(2026, 7, 24, 9, 0, tzinfo=UTC)


class StaticProjectAuthority:
    def __init__(self, projects: list[AuthoritativeWebsiteProject]) -> None:
        self.projects = {project.website_project_key: project for project in projects}

    async def get_by_key(
        self,
        website_project_key: str,
        organization_ids: tuple[str, ...],
    ) -> AuthoritativeWebsiteProject | None:
        del organization_ids
        return self.projects.get(website_project_key)


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def issue_access_token(
    *,
    memberships: list[dict[str, object]],
    issued_at: datetime = NOW,
    expires_at: datetime | None = None,
    signing_key: bytes = AUTH_SIGNING_KEY,
) -> str:
    payload = {
        "version": PLATFORM_ACCESS_TOKEN_VERSION,
        "issuer": "growthos-platform-auth",
        "audience": PLATFORM_ACCESS_TOKEN_AUDIENCE,
        "issuedAt": issued_at.isoformat().replace("+00:00", "Z"),
        "expiresAt": (expires_at or issued_at + timedelta(minutes=5))
        .isoformat()
        .replace("+00:00", "Z"),
        "actor": {
            "userId": "user-003",
            "sessionId": "session-003",
        },
        "memberships": memberships,
    }
    encoded_payload = _base64url(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    signature = hmac.new(
        signing_key,
        f"{PLATFORM_ACCESS_TOKEN_VERSION}.{encoded_payload}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{encoded_payload}.{_base64url(signature)}"


def request_for(
    token: str,
    *,
    method: str = "GET",
    request_id: str = "request-003",
    extra_headers: tuple[tuple[bytes, bytes], ...] = (),
) -> Request:
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": "/api/v1/projects/project-1/backlinks/context",
            "raw_path": b"/api/v1/projects/project-1/backlinks/context",
            "query_string": b"",
            "headers": [
                (b"authorization", f"Bearer {token}".encode("ascii")),
                (b"x-request-id", request_id.encode("ascii")),
                *extra_headers,
            ],
            "client": ("127.0.0.1", 50000),
            "server": ("gateway.test", 80),
        }
    )


def local_request_for(
    *,
    method: str = "GET",
    path: str = "/api/v1/projects/project-1/backlinks/context",
    client_host: str = "127.0.0.1",
    server_host: str = "localhost",
    origin: str | None = "http://localhost:5173",
    request_id: str | None = "local-request-003",
) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if origin is not None:
        headers.append((b"origin", origin.encode("ascii")))
    if request_id is not None:
        headers.append((b"x-request-id", request_id.encode("ascii")))
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": method,
            "scheme": "http",
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": headers,
            "client": (client_host, 50000),
            "server": (server_host, 7200),
        }
    )


def membership(
    *,
    organization_id: str = "org-1",
    workspace_id: str = "workspace-1",
    project_ids: tuple[str, ...] = ("project-1",),
    permissions: tuple[str, ...] = ("backlinks:read", "backlinks:write"),
) -> dict[str, object]:
    return {
        "organizationId": organization_id,
        "workspaceId": workspace_id,
        "roles": ["member"],
        "projectIds": list(project_ids),
        "permissions": list(permissions),
    }


def resolver_for(
    projects: list[AuthoritativeWebsiteProject],
) -> AuthoritativePlatformContextResolver:
    return AuthoritativePlatformContextResolver(
        authentication=HmacPlatformAuthenticationAuthority(
            issuer="growthos-platform-auth",
            signing_key=AUTH_SIGNING_KEY,
            max_token_ttl_seconds=600,
        ),
        projects=StaticProjectAuthority(projects),
        clock=lambda: NOW,
    )


def resolve(
    resolver: AuthoritativePlatformContextResolver,
    token: str,
    *,
    website_project_key: str = "project-1",
    method: str = "GET",
):
    import asyncio

    return asyncio.run(
        resolver.resolve(
            request=request_for(token, method=method),
            website_project_key=website_project_key,
        )
    )


def test_resolves_signed_actor_membership_project_and_permission() -> None:
    project = AuthoritativeWebsiteProject(
        website_project_id="project-1",
        website_project_key="project-1",
        organization_id="org-1",
    )

    resolved = resolve(
        resolver_for([project]),
        issue_access_token(memberships=[membership()]),
    )

    assert resolved.actor.user_id == "user-003"
    assert resolved.actor.session_id == "session-003"
    assert resolved.actor.roles == ("member",)
    assert resolved.tenant.organization_id == "org-1"
    assert resolved.tenant.workspace_id == "workspace-1"
    assert resolved.project.website_project_id == "project-1"
    assert resolved.project.website_project_key == "project-1"
    assert resolved.permissions == ("backlinks:read", "backlinks:write")
    assert resolved.correlation_id == "request-003"


def test_ignores_browser_supplied_internal_context_headers() -> None:
    project = AuthoritativeWebsiteProject(
        website_project_id="project-1",
        website_project_key="project-1",
        organization_id="org-1",
    )
    token = issue_access_token(memberships=[membership()])
    resolver = resolver_for([project])

    import asyncio

    resolved = asyncio.run(
        resolver.resolve(
            request=request_for(
                token,
                extra_headers=(
                    (b"x-growthos-platform-context", b"forged"),
                    (b"x-growthos-platform-context-signature", b"v1=forged"),
                ),
            ),
            website_project_key="project-1",
        )
    )

    assert resolved.actor.user_id == "user-003"
    assert resolved.tenant.workspace_id == "workspace-1"
    assert resolved.project.website_project_id == "project-1"


@pytest.mark.parametrize(
    ("token", "expected_code"),
    [
        (
            issue_access_token(memberships=[membership()])[:-1] + "A",
            "PLATFORM_ACCESS_TOKEN_INVALID",
        ),
        (
            issue_access_token(
                memberships=[membership()],
                issued_at=NOW - timedelta(minutes=10),
                expires_at=NOW - timedelta(minutes=5),
            ),
            "PLATFORM_ACCESS_TOKEN_EXPIRED",
        ),
    ],
)
def test_rejects_forged_and_expired_access_tokens(
    token: str,
    expected_code: str,
) -> None:
    resolver = resolver_for(
        [
            AuthoritativeWebsiteProject(
                website_project_id="project-1",
                website_project_key="project-1",
                organization_id="org-1",
            )
        ]
    )

    with pytest.raises(PlatformContextResolutionError) as error:
        resolve(resolver, token)

    assert error.value.status == 401
    assert error.value.code == expected_code


@pytest.mark.parametrize(
    ("membership_claim", "requested_project", "expected_code"),
    [
        (
            membership(organization_id="org-other"),
            "project-1",
            "PLATFORM_TENANT_ACCESS_DENIED",
        ),
        (
            membership(workspace_id="workspace-other", project_ids=("project-other",)),
            "project-1",
            "PLATFORM_PROJECT_ACCESS_DENIED",
        ),
        (
            membership(project_ids=("project-1",)),
            "project-2",
            "PLATFORM_PROJECT_ACCESS_DENIED",
        ),
    ],
)
def test_rejects_cross_tenant_workspace_and_project_access(
    membership_claim: dict[str, object],
    requested_project: str,
    expected_code: str,
) -> None:
    projects = [
        AuthoritativeWebsiteProject(
            website_project_id="project-1",
            website_project_key="project-1",
            organization_id="org-1",
        ),
        AuthoritativeWebsiteProject(
            website_project_id="project-2",
            website_project_key="project-2",
            organization_id="org-1",
        ),
    ]

    with pytest.raises(PlatformContextResolutionError) as error:
        resolve(
            resolver_for(projects),
            issue_access_token(memberships=[membership_claim]),
            website_project_key=requested_project,
        )

    assert error.value.status == 403
    assert error.value.code == expected_code


def test_rejects_ambiguous_cross_workspace_project_grants() -> None:
    project = AuthoritativeWebsiteProject(
        website_project_id="project-1",
        website_project_key="project-1",
        organization_id="org-1",
    )

    with pytest.raises(PlatformContextResolutionError) as error:
        resolve(
            resolver_for([project]),
            issue_access_token(
                memberships=[
                    membership(workspace_id="workspace-1"),
                    membership(workspace_id="workspace-2"),
                ]
            ),
        )

    assert error.value.status == 403
    assert error.value.code == "PLATFORM_PROJECT_ACCESS_DENIED"


def test_requires_method_specific_permission() -> None:
    project = AuthoritativeWebsiteProject(
        website_project_id="project-1",
        website_project_key="project-1",
        organization_id="org-1",
    )

    with pytest.raises(PlatformContextResolutionError) as error:
        resolve(
            resolver_for([project]),
            issue_access_token(memberships=[membership(permissions=("backlinks:read",))]),
            method="POST",
        )

    assert error.value.status == 403
    assert error.value.code == "PLATFORM_PERMISSION_DENIED"


def test_local_product_resolver_uses_fixed_authoritative_tenant() -> None:
    project = AuthoritativeWebsiteProject(
        website_project_id="project-1",
        website_project_key="project-1",
        organization_id="org-1",
    )
    resolver = LocalProductPlatformContextResolver(
        projects=StaticProjectAuthority([project]),
        organization_id="org-1",
        workspace_id="workspace-1",
        website_project_id="project-1",
        website_project_key="live001-canary",
        user_id="local-user",
        session_id="local-session",
        frontend_origin="http://localhost:5173",
    )

    import asyncio

    resolved = asyncio.run(
        resolver.resolve(
            request=local_request_for(),
            website_project_key="live001-canary",
        )
    )

    assert resolved.actor.user_id == "local-user"
    assert resolved.actor.session_id == "local-session"
    assert resolved.tenant.organization_id == "org-1"
    assert resolved.tenant.workspace_id == "workspace-1"
    assert resolved.project.website_project_id == "project-1"
    assert resolved.project.website_project_key == "live001-canary"
    assert resolved.correlation_id == "local-request-003"


@pytest.mark.parametrize(
    ("local_request", "project_key", "expected_code"),
    [
        (
            local_request_for(client_host="192.168.1.25"),
            "project-1",
            "LOCAL_PRODUCT_LOOPBACK_REQUIRED",
        ),
        (
            local_request_for(origin="http://localhost:5174"),
            "project-1",
            "LOCAL_PRODUCT_ORIGIN_DENIED",
        ),
        (
            local_request_for(),
            "project-other",
            "PLATFORM_PROJECT_NOT_FOUND",
        ),
    ],
)
def test_local_product_resolver_rejects_requests_outside_boundary(
    local_request: Request,
    project_key: str,
    expected_code: str,
) -> None:
    resolver = LocalProductPlatformContextResolver(
        projects=StaticProjectAuthority(
            [
                AuthoritativeWebsiteProject(
                    website_project_id="project-1",
                    website_project_key="project-1",
                    organization_id="org-1",
                )
            ]
        ),
        organization_id="org-1",
        workspace_id="workspace-1",
        website_project_id="project-1",
        website_project_key="project-1",
        user_id="local-user",
        session_id="local-session",
        frontend_origin="http://localhost:5173",
    )

    import asyncio

    with pytest.raises(PlatformContextResolutionError) as error:
        asyncio.run(
            resolver.resolve(
                request=local_request,
                website_project_key=project_key,
            )
        )

    assert error.value.status == (404 if expected_code == "PLATFORM_PROJECT_NOT_FOUND" else 403)
    assert error.value.code == expected_code


def test_local_product_resolver_accepts_active_project_in_same_workspace() -> None:
    resolver = LocalProductPlatformContextResolver(
        projects=StaticProjectAuthority(
            [
                AuthoritativeWebsiteProject(
                    website_project_id="project-2",
                    website_project_key="second-project",
                    organization_id="org-1",
                    workspace_id="workspace-1",
                )
            ]
        ),
        organization_id="org-1",
        workspace_id="workspace-1",
        website_project_id="project-1",
        website_project_key="elephtv",
        user_id="local-user",
        session_id="local-session",
        frontend_origin="http://localhost:5173",
    )

    import asyncio

    resolved = asyncio.run(
        resolver.resolve(
            request=local_request_for(),
            website_project_key="second-project",
        )
    )

    assert resolved.project.website_project_id == "project-2"
    assert resolved.project.website_project_key == "second-project"


def test_local_product_resolver_rejects_project_from_other_workspace() -> None:
    resolver = LocalProductPlatformContextResolver(
        projects=StaticProjectAuthority(
            [
                AuthoritativeWebsiteProject(
                    website_project_id="project-2",
                    website_project_key="second-project",
                    organization_id="org-1",
                    workspace_id="workspace-2",
                )
            ]
        ),
        organization_id="org-1",
        workspace_id="workspace-1",
        website_project_id="project-1",
        website_project_key="elephtv",
        user_id="local-user",
        session_id="local-session",
        frontend_origin="http://localhost:5173",
    )

    import asyncio

    with pytest.raises(PlatformContextResolutionError) as error:
        asyncio.run(
            resolver.resolve(
                request=local_request_for(),
                website_project_key="second-project",
            )
        )

    assert error.value.status == 404
    assert error.value.code == "PLATFORM_PROJECT_NOT_FOUND"


def test_local_product_resolver_generates_request_id_only_for_oauth_callback() -> None:
    resolver = LocalProductPlatformContextResolver(
        projects=StaticProjectAuthority(
            [
                AuthoritativeWebsiteProject(
                    website_project_id="project-1",
                    website_project_key="project-1",
                    organization_id="org-1",
                )
            ]
        ),
        organization_id="org-1",
        workspace_id="workspace-1",
        website_project_id="project-1",
        website_project_key="project-1",
        user_id="local-user",
        session_id="local-session",
        frontend_origin="http://localhost:5173",
    )

    import asyncio

    callback = asyncio.run(
        resolver.resolve(
            request=local_request_for(
                path=(
                    "/api/v1/projects/project-1/backlinks/"
                    "gmail-connections/callback"
                ),
                origin=None,
                request_id=None,
            ),
            website_project_key="project-1",
        )
    )
    assert callback.correlation_id.startswith("local-oauth-callback-")

    with pytest.raises(PlatformContextResolutionError) as error:
        asyncio.run(
            resolver.resolve(
                request=local_request_for(request_id=None),
                website_project_key="project-1",
            )
        )
    assert error.value.code == "PLATFORM_REQUEST_ID_REQUIRED"
