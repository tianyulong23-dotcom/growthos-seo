import asyncio
import base64
import json
from dataclasses import replace

import httpx
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient, MockTransport, Response

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
    ) -> ResolvedPlatformCollectionContext:
        del request
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
) -> httpx.Response:
    async def run() -> httpx.Response:
        app = create_app(
            backlinks_gateway=gateway,
            platform_context_resolver=resolver,
        )
        app.state.oauth_callback_frontend_origin = oauth_frontend_origin
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://gateway.test",
        ) as client:
            return await client.request(
                method,
                path,
                headers=headers,
                content=content,
            )

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


def test_registers_exactly_seventy_three_private_runtime_routes() -> None:
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

    assert len(runtime_routes) == 73
    assert len({(tuple(sorted(route.methods)), route.path) for route in runtime_routes}) == 73
    assert all(route.include_in_schema is False for route in runtime_routes)
    assert all("/backlinks/" not in path for path in app.openapi()["paths"])


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


def test_forwards_gmail_callback_query_once() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(200, json={"connection": {"connectionId": "gmail-1"}})

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
            "/api/v1/projects/project-key/backlinks/gmail-connections/callback"
            "?code=authorization-code&state=opaque-state"
        ),
    )

    assert response.status_code == 200
    assert len(calls) == 1
    forwarded = calls[0]
    assert forwarded.url.path == (
        "/api/v1/projects/project-key/backlinks/gmail-connections/callback"
    )
    assert dict(forwarded.url.params) == {
        "code": "authorization-code",
        "state": "opaque-state",
    }


def test_forwards_stable_gmail_callback_without_project_binding() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(
            200,
            json={
                "connection": {"connectionId": "gmail-1"},
                "returnPath": "/projects/project-key/backlinks/email",
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
            "/api/v1/backlinks/gmail-connections/callback"
            "?code=authorization-code&state=opaque-state"
            "&iss=https%3A%2F%2Faccounts.google.com&scope=gmail.readonly"
        ),
        oauth_frontend_origin="http://127.0.0.1:5173/",
    )

    assert response.status_code == 303
    assert response.headers["location"] == (
        "http://127.0.0.1:5173/projects/project-key/backlinks/email"
    )
    assert resolver.calls == ["collection"]
    assert len(calls) == 1
    forwarded = calls[0]
    assert forwarded.url.path == "/api/v1/backlinks/gmail-connections/callback"
    assert dict(forwarded.url.params) == {
        "code": "authorization-code",
        "state": "opaque-state",
    }
    payload = decode_context(forwarded.headers[PLATFORM_CONTEXT_HEADER])
    assert payload["project"] is None


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


def test_rejects_invalid_gmail_callback_return_path_and_preserves_upstream_failure() -> None:
    responses = iter(
        (
            Response(200, json={"returnPath": "https://evil.example/callback"}),
            Response(503, json={"code": "GMAIL_PROVIDER_UNAVAILABLE"}),
        )
    )
    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(lambda _: next(responses))),
    )
    path = (
        "/api/v1/backlinks/gmail-connections/callback"
        "?code=authorization-code&state=opaque-state"
    )

    invalid_path = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path=path,
        oauth_frontend_origin="http://127.0.0.1:5173",
    )
    upstream_failure = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path=path,
        oauth_frontend_origin="http://127.0.0.1:5173",
    )

    assert invalid_path.status_code == 502
    assert invalid_path.json()["code"] == "OAUTH_RETURN_PATH_INVALID"
    assert upstream_failure.status_code == 503
    assert upstream_failure.json()["code"] == "GMAIL_PROVIDER_UNAVAILABLE"


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
