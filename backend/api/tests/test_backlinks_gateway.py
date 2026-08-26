import asyncio
import base64
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from urllib.parse import urlparse

import httpx
import pytest
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient, MockTransport, Response
from starlette.requests import ClientDisconnect
from starlette.requests import Request as StarletteRequest

from app.core.backlinks_gateway import (
    BacklinksGateway,
    PlatformContextResolver,
    RejectingPlatformContextResolver,
)
from app.core.platform_request_context import (
    PLATFORM_CONTEXT_HEADER,
    PLATFORM_CONTEXT_SIGNATURE_HEADER,
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformCollectionContext,
    ResolvedPlatformRequestContext,
)
from app.main import create_app

SIGNING_KEY = b"test-only-platform-context-key-32-bytes"
OAUTH_STATE = "oauth-state-abcdefghijklmnopqrstuvwxyz123456"
RESOLVED = ResolvedPlatformRequestContext(
    actor=PlatformActor(
        user_id="user-gateway",
        session_id="session-gateway",
        roles=("member",),
    ),
    tenant=PlatformTenant(
        organization_id="org-gateway",
        workspace_id="workspace-gateway",
    ),
    project=PlatformProject(
        website_project_id="project-gateway",
        website_project_key="project-key",
    ),
    permissions=("backlinks:read", "backlinks:write"),
    correlation_id="correlation-gateway",
)
COLLECTION_RESOLVED = ResolvedPlatformCollectionContext(
    actor=RESOLVED.actor,
    tenant=RESOLVED.tenant,
    permissions=RESOLVED.permissions,
    correlation_id=RESOLVED.correlation_id,
)


class StaticResolver(PlatformContextResolver):
    def __init__(self, resolved: ResolvedPlatformRequestContext) -> None:
        self.resolved = resolved
        self.calls: list[str] = []

    async def resolve_collection(
        self,
        *,
        request: object,
        required_permission: str = "backlinks:read",
    ) -> ResolvedPlatformCollectionContext:
        del request, required_permission
        self.calls.append("collection")
        return COLLECTION_RESOLVED

    async def resolve(
        self,
        *,
        request: object,
        website_project_key: str,
        required_permission: str | None = None,
    ) -> ResolvedPlatformRequestContext:
        del request, required_permission
        self.calls.append(website_project_key)
        return self.resolved


def decode_context(value: str) -> dict[str, object]:
    padding = "=" * (-len(value) % 4)
    return json.loads(base64.urlsafe_b64decode(f"{value}{padding}"))


def request_app(
    gateway: BacklinksGateway,
    resolver: PlatformContextResolver,
    *,
    method: str,
    path: str,
    headers: dict[str, str] | None = None,
    content: bytes | None = None,
    oauth_frontend_origin: str | None = None,
    oauth_callback_url: str | None = None,
    base_url: str = "http://gateway.test",
) -> httpx.Response:
    async def run() -> httpx.Response:
        app = create_app(
            backlinks_gateway=gateway,
            platform_context_resolver=resolver,
        )
        app.state.oauth_callback_frontend_origin = oauth_frontend_origin
        app.state.oauth_callback_url = oauth_callback_url
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url=base_url,
        ) as client:
            return await client.request(
                method,
                path,
                headers=headers,
                content=content,
            )

    return asyncio.run(run())


def gmail_oauth_flow(
    gateway: BacklinksGateway,
    resolver: PlatformContextResolver,
    *,
    callback_path: str,
    oauth_frontend_origin: str | None = None,
    oauth_callback_url: str | None = None,
) -> tuple[httpx.Response, httpx.Response]:
    async def run() -> tuple[httpx.Response, httpx.Response]:
        frontend_origin = oauth_frontend_origin or "http://localhost:5173"
        callback_url = oauth_callback_url or (
            f"{urlparse(frontend_origin).scheme}://"
            f"{urlparse(frontend_origin).hostname}:7200"
            "/api/v1/backlinks/gmail-connections/callback"
        )
        callback_origin = urlparse(callback_url)
        app = create_app(
            backlinks_gateway=gateway,
            platform_context_resolver=resolver,
        )
        app.state.oauth_callback_frontend_origin = frontend_origin
        app.state.oauth_callback_url = callback_url
        app.state.oauth_callback_cookie_secure = False
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url=f"{callback_origin.scheme}://{callback_origin.netloc}",
        ) as client:
            connect = await client.post(
                "/api/v1/projects/project-key/backlinks/gmail-connections/connect",
                headers={"x-request-id": "oauth-connect"},
                json={"returnPath": "/projects/project-key/backlinks/email"},
            )
            callback = await client.get(
                callback_path,
                headers={"x-request-id": "oauth-callback"},
            )
            return connect, callback

    return asyncio.run(run())


def runtime_api_routes(router: object) -> list[APIRoute]:
    routes: list[APIRoute] = []
    for route in getattr(router, "routes", []):
        if isinstance(route, APIRoute):
            routes.append(route)
            continue
        included = getattr(route, "original_router", None)
        if included is not None:
            routes.extend(runtime_api_routes(included))
    return routes


def test_registers_exactly_seventy_seven_private_runtime_routes() -> None:
    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(lambda _: Response(200))),
    )
    app = create_app(
        backlinks_gateway=gateway,
        platform_context_resolver=StaticResolver(RESOLVED),
    )
    runtime_routes = [
        route
        for route in runtime_api_routes(app)
        if isinstance(route, APIRoute) and "/backlinks/" in route.path
    ]

    assert len(runtime_routes) == 77
    assert len({(tuple(sorted(route.methods)), route.path) for route in runtime_routes}) == 77
    assert all(route.include_in_schema is False for route in runtime_routes)
    assert all("/backlinks/" not in path for path in app.openapi()["paths"])


def test_forwards_current_pool_contact_enrichment_batch() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(202, json={"accepted": 3})

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=(
            "/api/v1/projects/project-key/backlinks/"
            "contact-enrichment-batches/current/run"
        ),
    )

    assert response.status_code == 202
    assert response.json() == {"accepted": 3}
    assert len(calls) == 1
    assert calls[0].url.path == (
        "/api/v1/projects/project-key/backlinks/"
        "contact-enrichment-batches/current/run"
    )


def test_forwards_gmail_push_without_platform_resolution_and_preserves_provider_auth() -> None:
    calls: list[httpx.Request] = []
    body = json.dumps(
        {
            "message": {
                "data": base64.b64encode(
                    json.dumps(
                        {
                            "emailAddress": "owner@example.test",
                            "historyId": "99141",
                        }
                    ).encode()
                ).decode(),
                "messageId": "1410000000001",
            },
            "subscription": "projects/growthos/subscriptions/backlinks-gmail-push",
        }
    ).encode()

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(
            202,
            json={"accepted": True, "duplicate": False},
            headers={"x-request-id": "provider-request"},
        )

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=None,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    response = request_app(
        gateway,
        RejectingPlatformContextResolver(),
        method="POST",
        path="/api/v1/backlinks/mail/gmail-push",
        headers={
            "authorization": "Bearer provider-oidc",
            "content-type": "application/json",
            PLATFORM_CONTEXT_HEADER: "forged",
            PLATFORM_CONTEXT_SIGNATURE_HEADER: "v1=forged",
        },
        content=body,
    )

    assert response.status_code == 202
    assert response.json() == {"accepted": True, "duplicate": False}
    assert len(calls) == 1
    forwarded = calls[0]
    assert forwarded.headers["authorization"] == "Bearer provider-oidc"
    assert PLATFORM_CONTEXT_HEADER not in forwarded.headers
    assert PLATFORM_CONTEXT_SIGNATURE_HEADER not in forwarded.headers
    assert forwarded.content == body


def test_strips_forged_context_binds_project_and_forwards_query_once() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(
            200,
            json={"items": [], "meta": {"requestId": "private-request"}},
            headers={
                "content-type": "application/json",
                "x-request-id": "private-request",
            },
        )

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    resolver = StaticResolver(RESOLVED)
    response = request_app(
        gateway,
        resolver,
        method="GET",
        path=(
            "/api/v1/projects/project-key/backlinks/opportunities?managementStatus=ACTIVE&limit=5"
        ),
        headers={
            PLATFORM_CONTEXT_HEADER: "forged",
            PLATFORM_CONTEXT_SIGNATURE_HEADER: "v1=forged",
            "authorization": "Bearer browser-token",
        },
    )

    assert response.status_code == 200
    assert response.json()["items"] == []
    assert resolver.calls == ["project-key"]
    assert len(calls) == 1
    forwarded = calls[0]
    assert forwarded.url.path.endswith("/backlinks/opportunities")
    assert forwarded.url.params["limit"] == "5"
    assert forwarded.url.params["managementStatus"] == "ACTIVE"
    assert "authorization" not in forwarded.headers
    assert forwarded.headers[PLATFORM_CONTEXT_HEADER] != "forged"
    assert forwarded.headers[PLATFORM_CONTEXT_SIGNATURE_HEADER] != "v1=forged"
    payload = decode_context(forwarded.headers[PLATFORM_CONTEXT_HEADER])
    assert payload["tenant"] == {
        "organizationId": "org-gateway",
        "workspaceId": "workspace-gateway",
    }
    assert payload["project"] == {
        "websiteProjectId": "project-gateway",
        "websiteProjectKey": "project-key",
    }


def test_get_forward_does_not_read_disconnected_request_body() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(200, json={"items": []})

    async def disconnected_receive() -> dict[str, object]:
        raise ClientDisconnect()

    async def run() -> httpx.Response:
        request = StarletteRequest(
            {
                "type": "http",
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/api/v1/projects/project-key/backlinks/opportunities",
                "raw_path": b"/api/v1/projects/project-key/backlinks/opportunities",
                "query_string": b"",
                "headers": [],
                "client": ("127.0.0.1", 12345),
                "server": ("gateway.test", 80),
                "root_path": "",
            },
            receive=disconnected_receive,
        )
        gateway = BacklinksGateway(
            base_url="http://backlinks.internal",
            signing_key=SIGNING_KEY,
            client=AsyncClient(transport=MockTransport(handler)),
        )
        return await gateway.forward(
            request,
            resolved=RESOLVED,
            website_project_key="project-key",
        )

    response = asyncio.run(run())

    assert response.status_code == 200
    assert len(calls) == 1
    assert calls[0].content == b""


def test_server_selected_upstream_path_is_strict_and_forwards_query_once() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(200, json={"items": []})

    request = StarletteRequest(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": "/api/v1/projects/project-key/performance/backlinks",
            "raw_path": b"/api/v1/projects/project-key/performance/backlinks",
            "query_string": b"view=all",
            "headers": [],
            "client": ("127.0.0.1", 12345),
            "server": ("gateway.test", 80),
            "root_path": "",
        }
    )
    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )

    response = asyncio.run(
        gateway.forward(
            request,
            resolved=RESOLVED,
            website_project_key="project-key",
            upstream_path="/api/v1/projects/project-key/backlinks/links",
            query_params=[("view", "suspected_lost"), ("limit", "10")],
        )
    )

    assert response.status_code == 200
    assert len(calls) == 1
    assert calls[0].url.path == (
        "/api/v1/projects/project-key/backlinks/links"
    )
    assert calls[0].url.query == b"view=suspected_lost&limit=10"

    for invalid_path in (
        "api/v1/projects/project-key/backlinks/links",
        "//other-host/backlinks",
        "/backlinks/links?view=all",
        "/backlinks/links#fragment",
        "/backlinks\\links",
    ):
        with pytest.raises(ValueError):
            asyncio.run(
                gateway.forward(
                    request,
                    resolved=RESOLVED,
                    website_project_key="project-key",
                    upstream_path=invalid_path,
                )
            )
    assert len(calls) == 1


def test_publishes_project_context_to_exact_internal_route_with_signed_context() -> None:
    calls: list[httpx.Request] = []
    projection = {
        "snapshotId": "a8646413-5769-4ee0-850a-87a977a38b39",
        "snapshotVersion": 4,
        "projectStatus": "ACTIVE",
        "canonicalDomain": "example.test",
        "locale": "en",
        "countryCode": "ZA",
        "targetMarket": "ZA",
        "products": ["Streaming"],
        "keywords": ["streaming service in za"],
        "targetUrls": ["https://example.test/"],
        "targetAudiences": ["Streaming viewers"],
        "partnershipGoals": ["Earn editorial backlinks"],
        "inputComplete": True,
        "profileVersionId": "c04d6d43-28f4-482e-965b-3e77216bb3d6",
        "promotionTargetVersionId": "e9aee5d3-94bd-488f-9604-b856ca6b35b9",
        "jobId": "e7ec49da-23e6-4d4d-8208-2e7ae04c0bfa",
        "outboxEventId": "d3288e52-fe7d-4cf0-a42a-711083ce7570",
    }

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(202, json={"accepted": True})

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )

    response = asyncio.run(
        gateway.publish_project_context(
            resolved=RESOLVED,
            website_project_key="project-key",
            payload=projection,
        )
    )

    assert response.status_code == 202
    assert len(calls) == 1
    published = calls[0]
    assert published.method == "POST"
    assert published.url.path == (
        "/internal/v1/projects/project-key/backlinks/project-context-projection"
    )
    assert json.loads(published.content) == projection
    assert published.headers["x-correlation-id"] == "correlation-gateway"
    signed = decode_context(published.headers[PLATFORM_CONTEXT_HEADER])
    assert signed["tenant"] == {
        "organizationId": "org-gateway",
        "workspaceId": "workspace-gateway",
    }
    assert signed["project"] == {
        "websiteProjectId": "project-gateway",
        "websiteProjectKey": "project-key",
    }
    assert published.headers[PLATFORM_CONTEXT_SIGNATURE_HEADER].startswith("v1=")


def test_forwards_assessment_query_once() -> None:
    calls: list[httpx.Request] = []
    payload = {
        "run": {
            "id": "7c935e5c-f915-4fe4-b47b-98cc283611b7",
            "opportunityId": "27b4bf0e-b48a-4ec5-a66b-f8956ff87fb6",
            "status": "SUCCEEDED",
            "attemptCount": 1,
            "sourceReleaseIds": ["release-2026-07-27"],
            "startedAt": "2026-07-27T00:00:00.000Z",
            "finishedAt": "2026-07-27T00:01:00.000Z",
            "errorCode": None,
        },
        "result": {
            "snapshotId": "a8646413-5769-4ee0-850a-87a977a38b39",
            "snapshotVersion": 1,
            "isCurrent": True,
            "availability": "available",
            "stale": False,
            "sourceReleaseIds": ["release-2026-07-27"],
            "generatedAt": "2026-07-27T00:01:00.000Z",
            "payload": {},
        },
    }

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(200, json=payload)

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path=(
            "/api/v1/projects/project-key/backlinks/assessments/"
            "27b4bf0e-b48a-4ec5-a66b-f8956ff87fb6"
        ),
    )

    assert response.status_code == 200
    assert response.json() == payload
    assert len(calls) == 1
    assert calls[0].url.path == (
        "/api/v1/projects/project-key/backlinks/assessments/"
        "27b4bf0e-b48a-4ec5-a66b-f8956ff87fb6"
    )


def test_forwards_draft_query_once() -> None:
    calls: list[httpx.Request] = []
    payload = {
        "draft": {
            "id": "018f0000-0000-7000-8000-000000000011",
            "status": "draft",
            "draftVersion": 2,
        }
    }

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(200, json=payload)

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path=(
            "/api/v1/projects/project-key/backlinks/drafts/"
            "018f0000-0000-7000-8000-000000000011"
        ),
    )

    assert response.status_code == 200
    assert response.json() == payload
    assert len(calls) == 1
    assert calls[0].url.path.endswith(
        "/backlinks/drafts/018f0000-0000-7000-8000-000000000011"
    )


def test_forwards_send_intent_list_query_once() -> None:
    calls: list[httpx.Request] = []
    payload = {
        "items": [
            {
                "sendIntentId": "018f0000-0000-7000-8000-000000000114",
                "status": "FAILED_FINAL",
            }
        ],
        "nextCursor": None,
    }

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(200, json=payload)

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path=(
            "/api/v1/projects/project-key/backlinks/send-intents"
            "?draftId=018f0000-0000-7000-8000-000000000011&limit=1"
        ),
    )

    assert response.status_code == 200
    assert response.json() == payload
    assert len(calls) == 1
    assert calls[0].url.path.endswith("/backlinks/send-intents")
    assert dict(calls[0].url.params) == {
        "draftId": "018f0000-0000-7000-8000-000000000011",
        "limit": "1",
    }


def test_forwards_send_intent_once_and_requires_idempotency() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(
            201,
            json={
                "sendIntentId": "018f0000-0000-7000-8000-000000000114",
                "status": "READY",
            },
        )

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    path = (
        "/api/v1/projects/project-key/backlinks/drafts/"
        "018f0000-0000-7000-8000-000000000011/send-intents"
    )
    body = json.dumps(
        {
            "approvedDraftVersionId": "018f0000-0000-7000-8000-000000000012",
            "gmailConnectionId": "018f0000-0000-7000-8000-000000000020",
            "messagePurpose": "INITIAL_OUTREACH",
            "followUpIndex": 0,
        }
    ).encode()

    missing_key = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=path,
        headers={"content-type": "application/json"},
        content=body,
    )
    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=path,
        headers={
            "content-type": "application/json",
            "idempotency-key": "send-intent-once",
        },
        content=body,
    )

    assert missing_key.status_code == 400
    assert missing_key.json()["code"] == "PLATFORM_IDEMPOTENCY_REQUIRED"
    assert response.status_code == 201
    assert response.json()["status"] == "READY"
    assert len(calls) == 1
    assert calls[0].headers["idempotency-key"] == "send-intent-once"
    assert calls[0].content == body


def test_legacy_gmail_callback_uses_ticket_and_forwards_query_once() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        if request.method == "POST":
            return Response(
                200,
                json={
                    "authorizationUrl": (
                        f"https://accounts.google.com/o/oauth2/v2/auth?state={OAUTH_STATE}"
                    )
                },
            )
        return Response(
            200,
            json={
                "connection": {"connectionId": "gmail-1"},
                "returnPath": "/projects/project-key/backlinks/email",
                "meta": {"websiteProjectId": "project-gateway"},
            },
        )

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    resolver = StaticResolver(RESOLVED)
    connect, response = gmail_oauth_flow(
        gateway,
        resolver,
        callback_path=(
            "/api/v1/projects/project-key/backlinks/gmail-connections/callback"
            f"?code=authorization-code&state={OAUTH_STATE}"
        ),
    )

    assert connect.status_code == 200
    connect_cookie = connect.headers["set-cookie"].lower()
    assert "httponly" in connect_cookie
    assert "samesite=lax" in connect_cookie
    assert "path=/api/v1" in connect_cookie
    assert "max-age=600" in connect_cookie
    assert response.status_code == 303
    assert response.headers["location"] == (
        "http://localhost:5173/projects/project-key/backlinks/email"
    )
    assert "max-age=0" in response.headers["set-cookie"].lower()
    assert resolver.calls == ["project-key"]
    assert len(calls) == 2
    forwarded = calls[1]
    assert forwarded.url.path == (
        "/api/v1/projects/project-key/backlinks/gmail-connections/callback"
    )
    assert dict(forwarded.url.params) == {
        "code": "authorization-code",
        "state": OAUTH_STATE,
    }
    payload = decode_context(forwarded.headers[PLATFORM_CONTEXT_HEADER])
    assert payload["project"] == {
        "websiteProjectId": "project-gateway",
        "websiteProjectKey": "project-key",
    }


def test_stable_gmail_callback_restores_project_without_browser_auth() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        if request.method == "POST":
            return Response(
                200,
                json={
                    "authorizationUrl": (
                        "https://accounts.google.com/o/oauth2/v2/auth"
                        f"?client_id=test&state={OAUTH_STATE}"
                    )
                },
            )
        return Response(
            200,
            json={
                "connection": {"connectionId": "gmail-1"},
                "returnPath": "/projects/project-key/backlinks/email",
                "meta": {"websiteProjectId": "project-gateway"},
            },
        )

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    resolver = StaticResolver(RESOLVED)
    connect, response = gmail_oauth_flow(
        gateway,
        resolver,
        callback_path=(
            "/api/v1/backlinks/gmail-connections/callback"
            f"?code=authorization-code&state={OAUTH_STATE}"
            "&iss=https%3A%2F%2Faccounts.google.com&scope=gmail.readonly"
        ),
        oauth_frontend_origin="http://127.0.0.1:5173/",
    )

    assert connect.status_code == 200
    assert response.status_code == 303
    assert response.headers["location"] == (
        "http://127.0.0.1:5173/projects/project-key/backlinks/email"
    )
    assert resolver.calls == ["project-key"]
    assert len(calls) == 2
    forwarded = calls[1]
    assert forwarded.url.path == "/api/v1/backlinks/gmail-connections/callback"
    assert dict(forwarded.url.params) == {
        "code": "authorization-code",
        "state": OAUTH_STATE,
    }
    payload = decode_context(forwarded.headers[PLATFORM_CONTEXT_HEADER])
    assert payload["project"] == {
        "websiteProjectId": "project-gateway",
        "websiteProjectKey": "project-key",
    }


def test_gmail_callback_rejects_tampered_ticket_and_state_mismatch() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(
            200,
            json={
                "authorizationUrl": (
                    f"https://accounts.google.com/o/oauth2/v2/auth?state={OAUTH_STATE}"
                )
            },
        )

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )

    async def run() -> tuple[httpx.Response, httpx.Response]:
        app = create_app(
            backlinks_gateway=gateway,
            platform_context_resolver=StaticResolver(RESOLVED),
        )
        app.state.oauth_callback_frontend_origin = "http://localhost:5173"
        app.state.oauth_callback_url = (
            "http://localhost:7200/api/v1/backlinks/gmail-connections/callback"
        )
        app.state.oauth_callback_cookie_secure = False
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://localhost:7200",
        ) as client:
            await client.post("/api/v1/projects/project-key/backlinks/gmail-connections/connect")
            cookie_name = next(
                name for name in client.cookies if name.startswith("backlinks_gmail_oauth_")
            )
            client.cookies.set(cookie_name, f"{client.cookies[cookie_name]}tampered")
            tampered = await client.get(
                "/api/v1/backlinks/gmail-connections/callback"
                f"?code=authorization-code&state={OAUTH_STATE}"
            )
            mismatch = await client.get(
                "/api/v1/backlinks/gmail-connections/callback"
                f"?code=authorization-code&state={OAUTH_STATE}x"
            )
            return tampered, mismatch

    tampered, mismatch = asyncio.run(run())

    assert tampered.status_code == 303
    assert tampered.headers["location"] == (
        "http://localhost:5173/?gmailOAuth=invalid_or_expired"
    )
    assert mismatch.status_code == 303
    assert mismatch.headers["location"] == (
        "http://localhost:5173/?gmailOAuth=invalid_or_expired"
    )
    assert len(calls) == 1


def test_gmail_access_denied_redirects_without_calling_core_callback() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(
            200,
            json={
                "authorizationUrl": (
                    f"https://accounts.google.com/o/oauth2/v2/auth?state={OAUTH_STATE}"
                )
            },
        )

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    _, response = gmail_oauth_flow(
        gateway,
        StaticResolver(RESOLVED),
        callback_path=(
            f"/api/v1/backlinks/gmail-connections/callback?error=access_denied&state={OAUTH_STATE}"
        ),
        oauth_frontend_origin="http://127.0.0.1:5173",
    )

    assert response.status_code == 303
    assert response.headers["location"] == (
        "http://127.0.0.1:5173/projects/project-key/backlinks/email?gmailOAuth=access_denied"
    )
    assert "max-age=0" in response.headers["set-cookie"].lower()
    assert len(calls) == 1


def test_gmail_connect_rejects_proxy_host_without_browser_origin() -> None:
    calls: list[httpx.Request] = []

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(
            transport=MockTransport(
                lambda request: calls.append(request) or Response(200)
            )
        ),
    )

    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path="/api/v1/projects/project-key/backlinks/gmail-connections/connect",
        oauth_frontend_origin="http://localhost:5173",
        oauth_callback_url=(
            "http://localhost:7200/api/v1/backlinks/gmail-connections/callback"
        ),
        base_url="http://127.0.0.1:5173",
    )

    assert response.status_code == 409
    assert response.json() == {
        "type": "urn:growthos:problem:platform:oauth-origin-mismatch",
        "title": "OAuth origin mismatch",
        "status": 409,
        "detail": "Gmail authorization must start from the configured public hostname.",
        "code": "OAUTH_ORIGIN_MISMATCH",
        "message": "Gmail authorization must start from the configured public hostname.",
        "requestId": "unresolved",
        "retryable": True,
        "canonicalFrontendOrigin": "http://localhost:5173",
    }
    assert calls == []


def test_gmail_connect_accepts_canonical_browser_origin_through_proxy() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(
            200,
            json={
                "authorizationUrl": (
                    f"https://accounts.google.com/o/oauth2/v2/auth?state={OAUTH_STATE}"
                )
            },
        )

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )

    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path="/api/v1/projects/project-key/backlinks/gmail-connections/connect",
        headers={"origin": "http://localhost:5173"},
        oauth_frontend_origin="http://localhost:5173",
        oauth_callback_url=(
            "http://localhost:7200/api/v1/backlinks/gmail-connections/callback"
        ),
        base_url="http://127.0.0.1:7200",
    )

    assert response.status_code == 200
    assert response.json()["authorizationUrl"].startswith(
        "https://accounts.google.com/"
    )
    assert "backlinks_gmail_oauth_" in response.headers["set-cookie"]
    assert len(calls) == 1


@pytest.mark.parametrize(
    ("oauth_frontend_origin", "oauth_callback_url"),
    [
        (
            None,
            "http://localhost:7200/api/v1/backlinks/gmail-connections/callback",
        ),
        ("http://localhost:5173", None),
    ],
)
def test_gmail_connect_rejects_missing_public_oauth_configuration_before_creating_state(
    oauth_frontend_origin: str | None,
    oauth_callback_url: str | None,
) -> None:
    calls: list[httpx.Request] = []

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(
            transport=MockTransport(
                lambda request: calls.append(request) or Response(200)
            )
        ),
    )

    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path="/api/v1/projects/project-key/backlinks/gmail-connections/connect",
        oauth_frontend_origin=oauth_frontend_origin,
        oauth_callback_url=oauth_callback_url,
        base_url="http://localhost:7200",
    )

    assert response.status_code == 503
    assert response.json() == {
        "type": "urn:growthos:problem:platform:oauth-configuration-invalid",
        "title": "OAuth configuration invalid",
        "status": 503,
        "detail": (
            "Gmail authorization is unavailable because its public callback "
            "configuration is incomplete."
        ),
        "code": "OAUTH_CONFIGURATION_INVALID",
        "message": (
            "Gmail authorization is unavailable because its public callback "
            "configuration is incomplete."
        ),
        "requestId": "unresolved",
        "retryable": False,
    }
    assert calls == []


def test_missing_gmail_callback_ticket_redirects_to_recovery_page() -> None:
    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(lambda _: Response(200))),
    )

    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path=(
            "/api/v1/backlinks/gmail-connections/callback"
            f"?code=authorization-code&state={OAUTH_STATE}"
        ),
        oauth_frontend_origin="http://localhost:5173",
    )

    assert response.status_code == 303
    assert response.headers["location"] == (
        "http://localhost:5173/?gmailOAuth=invalid_or_expired"
    )


def test_rejects_untrusted_gmail_callback_parameters() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(200)

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )

    for query in (
        "code=one&state=two&next=https%3A%2F%2Fevil.example",
        "code=one&code=two&state=three",
        "code=one&state=two&iss=https%3A%2F%2Fevil.example",
    ):
        response = request_app(
            gateway,
            StaticResolver(RESOLVED),
            method="GET",
            path=f"/api/v1/backlinks/gmail-connections/callback?{query}",
        )
        assert response.status_code == 400
        assert response.json()["code"] == "OAUTH_CALLBACK_INVALID"

    assert calls == []


@pytest.mark.parametrize(
    "callback_payload",
    [
        {
            "returnPath": "https://evil.example/callback",
            "meta": {"websiteProjectId": "project-gateway"},
        },
        {
            "returnPath": "/projects/other-project/backlinks/email",
            "meta": {"websiteProjectId": "other-project-id"},
        },
        {
            "returnPath": "/projects/project-key/backlinks/email",
            "meta": {"websiteProjectId": "other-project-id"},
        },
    ],
)
def test_rejects_invalid_gmail_callback_project_context(
    callback_payload: dict[str, object],
) -> None:
    def handler(request: httpx.Request) -> Response:
        if request.method == "POST":
            return Response(
                200,
                json={
                    "authorizationUrl": (
                        f"https://accounts.google.com/o/oauth2/v2/auth?state={OAUTH_STATE}"
                    )
                },
            )
        return Response(200, json=callback_payload)

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    path = (
        f"/api/v1/backlinks/gmail-connections/callback?code=authorization-code&state={OAUTH_STATE}"
    )

    _, response = gmail_oauth_flow(
        gateway,
        StaticResolver(RESOLVED),
        callback_path=path,
        oauth_frontend_origin="http://127.0.0.1:5173",
    )

    assert response.status_code == 502
    assert response.json()["code"] == "OAUTH_PROJECT_CONTEXT_MISMATCH"
    assert "max-age=0" in response.headers["set-cookie"].lower()


def test_redirects_retryable_gmail_callback_failure_to_recovery_ui() -> None:
    callbacks = iter(
        [
            Response(
                503,
                json={
                    "code": "GMAIL_OAUTH_PROVIDER_UNAVAILABLE",
                    "requestId": "core-request",
                    "retryable": True,
                },
            ),
        ]
    )

    def handler(request: httpx.Request) -> Response:
        if request.method == "POST":
            return Response(
                200,
                json={
                    "authorizationUrl": (
                        f"https://accounts.google.com/o/oauth2/v2/auth?state={OAUTH_STATE}"
                    )
                },
            )
        return next(callbacks)

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    path = (
        f"/api/v1/backlinks/gmail-connections/callback?code=authorization-code&state={OAUTH_STATE}"
    )

    _, upstream_failure = gmail_oauth_flow(
        gateway,
        StaticResolver(RESOLVED),
        callback_path=path,
        oauth_frontend_origin="http://127.0.0.1:5173",
    )

    assert upstream_failure.status_code == 303
    assert upstream_failure.headers["location"] == (
        "http://127.0.0.1:5173/projects/project-key/backlinks/email"
        "?gmailOAuth=provider_unavailable"
    )
    assert "max-age=0" in upstream_failure.headers["set-cookie"].lower()


def test_gmail_oauth_callback_ticket_round_trip_and_expiry() -> None:
    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(lambda _: Response(200))),
    )
    issued_at = datetime(2026, 8, 14, 8, 0, tzinfo=UTC)
    ticket = gateway.issue_gmail_oauth_callback_ticket(
        RESOLVED,
        state=OAUTH_STATE,
        now=issued_at,
    )

    resolved = gateway.resolve_gmail_oauth_callback_ticket(
        ticket,
        state=OAUTH_STATE,
        correlation_id="oauth-callback",
        now=issued_at + timedelta(minutes=9),
    )
    assert resolved == replace(RESOLVED, correlation_id="oauth-callback")

    for state, now in (
        (f"{OAUTH_STATE}x", issued_at + timedelta(minutes=9)),
        (OAUTH_STATE, issued_at + timedelta(minutes=10)),
    ):
        try:
            gateway.resolve_gmail_oauth_callback_ticket(
                ticket,
                state=state,
                correlation_id="oauth-callback",
                now=now,
            )
        except ValueError:
            pass
        else:
            raise AssertionError("invalid OAuth callback ticket was accepted")


def test_preserves_public_assessment_availability_contract() -> None:
    payload = {
        "items": [
            {
                "id": "recommendation-1",
                "assessment": {
                    "outcome": "insufficient_data",
                    "score": 72,
                    "availability": "partial",
                    "freshness": "stale",
                    "scoreModelVersion": "legacy-score.v1",
                    "ruleVersion": "legacy-rules.v1",
                    "generatedAt": "2026-07-18T01:05:00.000Z",
                    "readOnly": True,
                    "sourceReleaseIds": ["legacy-score:recommendation-1"],
                    "unavailableFields": ["technical_health"],
                    "staleFields": ["technical_health"],
                    "components": [
                        {
                            "id": "technical_health",
                            "availability": "unavailable",
                            "sourceType": "legacy_snapshot",
                            "sourceReleaseId": "legacy-score:recommendation-1",
                            "confidence": 0,
                            "observedAt": "2026-07-18T01:05:00.000Z",
                            "stale": True,
                            "evidenceRefs": ["legacy-assessment:recommendation-1"],
                            "unavailableReason": "not_supported",
                            "normalizedValue": None,
                            "weight": 5,
                            "points": None,
                            "derivationRuleVersion": None,
                        }
                    ],
                },
            }
        ]
    }

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(lambda _: Response(200, json=payload))),
    )
    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path="/api/v1/projects/project-key/backlinks/recommendations",
    )

    assert response.status_code == 200
    assert response.json() == payload
    assert '"value":0' not in response.text


def test_rejects_untrusted_or_cross_project_context_before_forwarding() -> None:
    calls = 0

    def handler(_: httpx.Request) -> Response:
        nonlocal calls
        calls += 1
        return Response(200)

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    forged = request_app(
        gateway,
        RejectingPlatformContextResolver(),
        method="GET",
        path="/api/v1/projects/project-key/backlinks/context",
        headers={
            PLATFORM_CONTEXT_HEADER: "forged",
            PLATFORM_CONTEXT_SIGNATURE_HEADER: "v1=forged",
        },
    )
    mismatched = request_app(
        gateway,
        StaticResolver(
            replace(
                RESOLVED,
                project=replace(RESOLVED.project, website_project_key="other-project"),
            )
        ),
        method="GET",
        path="/api/v1/projects/project-key/backlinks/context",
    )

    assert forged.status_code == 401
    assert forged.json()["code"] == "PLATFORM_AUTHENTICATION_REQUIRED"
    assert mismatched.status_code == 403
    assert mismatched.json()["code"] == "PLATFORM_PROJECT_BINDING_FAILED"
    assert calls == 0


def test_forwards_idempotent_command_once_and_never_retries_transport_failure() -> None:
    calls: list[httpx.Request] = []

    def success_handler(request: httpx.Request) -> Response:
        calls.append(request)
        if request.url.path.endswith("/reverify"):
            return Response(
                202,
                json={
                    "placementId":
                        "018f0000-0000-7000-8000-000000000158",
                    "placementVersion": 5,
                    "accepted": True,
                    "replayed": False,
                    "browserFallbackAllowed": False,
                    "monitorRun": {
                        "monitorRunId":
                            "018f0000-0000-7000-8000-000000000159",
                        "status": "scheduled",
                        "scheduledFor": "2026-07-29T10:00:00.000Z",
                    },
                },
            )
        return Response(
            200,
            json={
                "recommendationId": "018f0000-0000-7000-8000-000000000002",
                "status": "rejected",
            },
        )

    path = (
        "/api/v1/projects/project-key/backlinks/recommendations/"
        "018f0000-0000-7000-8000-000000000002/reject"
    )
    body = json.dumps(
        {
            "expectedVersion": 1,
            "rejectionType": "permanently_rejected",
            "reasonCode": "not_relevant",
            "cooldownUntil": None,
        }
    ).encode()
    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(success_handler)),
    )
    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=path,
        headers={
            "content-type": "application/json",
            "idempotency-key": "reject-once",
        },
        content=body,
    )

    assert response.status_code == 200
    assert len(calls) == 1
    assert calls[0].headers["idempotency-key"] == "reject-once"
    assert calls[0].content == body

    transition_path = (
        "/api/v1/projects/project-key/backlinks/opportunities/"
        "018f0000-0000-7000-8000-000000000078/transition"
    )
    transition_body = json.dumps(
        {
            "expectedVersion": 1,
            "toBusinessStage": "CONTACT_PREPARING",
            "reason": "Prepare contact.",
        }
    ).encode()
    transition = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=transition_path,
        headers={
            "content-type": "application/json",
            "idempotency-key": "transition-once",
        },
        content=transition_body,
    )
    assert transition.status_code == 200
    assert len(calls) == 2
    assert calls[1].headers["idempotency-key"] == "transition-once"
    assert calls[1].content == transition_body

    management_path = transition_path.removesuffix("/transition") + "/management"
    management_body = json.dumps(
        {
            "expectedVersion": 2,
            "managementStatus": "PAUSED",
            "reason": "Pause outreach.",
        }
    ).encode()
    management = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="PATCH",
        path=management_path,
        headers={
            "content-type": "application/json",
            "idempotency-key": "management-once",
        },
        content=management_body,
    )
    assert management.status_code == 200
    assert len(calls) == 3
    assert calls[2].headers["idempotency-key"] == "management-once"
    assert calls[2].content == management_body

    placement_path = (
        "/api/v1/projects/project-key/backlinks/placement-candidates"
    )
    placement_body = json.dumps(
        {
            "sourceType": "manual",
            "sourcePageUrl": "https://publisher.example.test/article",
            "targetUrl": "https://owner.example.test/guide",
            "evidence": {
                "contractVersion": "placement.discovery.v1",
                "schemaVersion": 1,
                "evidenceId": "evidence-1",
                "observedAt": "2026-07-29T00:00:00.000Z",
                "sourceRef": "test",
                "payload": {},
            },
        }
    ).encode()
    placement = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=placement_path,
        headers={
            "content-type": "application/json",
            "idempotency-key": "placement-once",
        },
        content=placement_body,
    )
    assert placement.status_code == 200
    assert len(calls) == 4
    assert calls[3].headers["idempotency-key"] == "placement-once"
    assert calls[3].content == placement_body

    reverify_path = (
        "/api/v1/projects/project-key/backlinks/links/placements/"
        "018f0000-0000-7000-8000-000000000158/reverify"
    )
    reverify_body = json.dumps({"expectedVersion": 4}).encode()
    reverify = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=reverify_path,
        headers={
            "content-type": "application/json",
            "idempotency-key": "placement-reverify-once",
        },
        content=reverify_body,
    )
    assert reverify.status_code == 202
    assert len(calls) == 5
    assert calls[4].headers["idempotency-key"] == "placement-reverify-once"
    assert calls[4].content == reverify_body

    cancel_refill_path = (
        "/api/v1/projects/project-key/backlinks/recommendation-refill-jobs/"
        "018f0000-0000-7000-8000-000000000155/cancel"
    )
    cancel_refill_body = json.dumps(
        {
            "expectedVersion": 1,
            "reasonCode": "read_side_effect_cleanup",
        }
    ).encode()
    cancel_refill = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=cancel_refill_path,
        headers={
            "content-type": "application/json",
            "idempotency-key": "cancel-read-side-effect-once",
        },
        content=cancel_refill_body,
    )
    assert cancel_refill.status_code == 200
    assert len(calls) == 6
    assert calls[5].headers["idempotency-key"] == (
        "cancel-read-side-effect-once"
    )
    assert calls[5].content == cancel_refill_body

    close_duplicate_path = (
        "/api/v1/projects/project-key/backlinks/recommendation-refill-jobs/"
        "018f0000-0000-7000-8000-000000000156/close-duplicate"
    )
    close_duplicate_body = json.dumps(
        {
            "expectedVersion": 61,
            "canonicalJobId": "018f0000-0000-7000-8000-000000000157",
            "reasonCode": "duplicate_recovery_owner",
        }
    ).encode()
    close_duplicate = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=close_duplicate_path,
        headers={
            "content-type": "application/json",
            "idempotency-key": "close-duplicate-once",
        },
        content=close_duplicate_body,
    )
    assert close_duplicate.status_code == 200
    assert len(calls) == 7
    assert calls[6].headers["idempotency-key"] == "close-duplicate-once"
    assert calls[6].content == close_duplicate_body

    failure_calls = 0

    def failure_handler(request: httpx.Request) -> Response:
        nonlocal failure_calls
        failure_calls += 1
        raise httpx.ConnectError("backlinks stopped", request=request)

    unavailable_gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(failure_handler)),
    )
    missing_key = request_app(
        unavailable_gateway,
        StaticResolver(RESOLVED),
        method="PATCH",
        path=management_path,
        headers={"content-type": "application/json"},
        content=management_body,
    )
    missing_placement_key = request_app(
        unavailable_gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=placement_path,
        headers={"content-type": "application/json"},
        content=placement_body,
    )
    missing_reverify_key = request_app(
        unavailable_gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=reverify_path,
        headers={"content-type": "application/json"},
        content=reverify_body,
    )
    missing_close_duplicate_key = request_app(
        unavailable_gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=close_duplicate_path,
        headers={"content-type": "application/json"},
        content=close_duplicate_body,
    )
    unavailable = request_app(
        unavailable_gateway,
        StaticResolver(RESOLVED),
        method="POST",
        path=transition_path,
        headers={
            "content-type": "application/json",
            "idempotency-key": "reject-unavailable",
        },
        content=body,
    )

    assert missing_key.status_code == 400
    assert missing_key.json()["code"] == "PLATFORM_IDEMPOTENCY_REQUIRED"
    assert missing_placement_key.status_code == 400
    assert missing_placement_key.json()["code"] == "PLATFORM_IDEMPOTENCY_REQUIRED"
    assert missing_reverify_key.status_code == 400
    assert missing_reverify_key.json()["code"] == "PLATFORM_IDEMPOTENCY_REQUIRED"
    assert missing_close_duplicate_key.status_code == 400
    assert (
        missing_close_duplicate_key.json()["code"]
        == "PLATFORM_IDEMPOTENCY_REQUIRED"
    )
    assert unavailable.status_code == 503
    assert unavailable.headers["content-type"].startswith("application/problem+json")
    assert unavailable.json() == {
        "type": "urn:growthos:problem:platform:backlinks-unavailable",
        "title": "Backlinks service unavailable",
        "status": 503,
        "detail": "The Backlinks service could not be reached.",
        "code": "BACKLINKS_UNAVAILABLE",
        "message": "The Backlinks service could not be reached.",
        "requestId": "correlation-gateway",
        "retryable": True,
    }
    assert failure_calls == 1
