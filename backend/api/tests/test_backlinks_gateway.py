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


class StaticResolver(PlatformContextResolver):
    def __init__(self, resolved: ResolvedPlatformRequestContext) -> None:
        self.resolved = resolved
        self.calls: list[str] = []
        self.collection_calls = 0

    async def resolve_collection(
        self,
        *,
        request: object,
    ) -> ResolvedPlatformCollectionContext:
        del request
        self.collection_calls += 1
        return ResolvedPlatformCollectionContext(
            actor=self.resolved.actor,
            tenant=self.resolved.tenant,
            permissions=self.resolved.permissions,
            correlation_id=self.resolved.correlation_id,
            authorized_project_ids=(self.resolved.project.website_project_id,),
        )

    async def resolve(
        self,
        *,
        request: object,
        website_project_key: str,
    ) -> ResolvedPlatformRequestContext:
        del request
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
    oauth_callback_frontend_origin: str | None = None,
) -> httpx.Response:
    async def run() -> httpx.Response:
        app = create_app(
            backlinks_gateway=gateway,
            platform_context_resolver=resolver,
        )
        app.state.oauth_callback_frontend_origin = oauth_callback_frontend_origin
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


def test_registers_exactly_sixty_two_runtime_routes_without_schema_duplication() -> None:
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

    route_keys = {(tuple(sorted(route.methods)), route.path) for route in runtime_routes}
    assert len(runtime_routes) == 62
    assert len(route_keys) == 62
    assert {
        (("GET",), "/api/v1/backlinks/gmail-connections/callback"),
        (
            ("GET",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/recommendation-inventory",
        ),
        (("GET",), "/api/v1/projects/{websiteProjectKey}/backlinks/metrics/dashboard"),
        (("GET",), "/api/v1/projects/{websiteProjectKey}/backlinks/reports"),
        (
            ("POST",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/reports/{reportKey}/revisions/"
            "{reportRevisionId}/exports",
        ),
        (
            ("GET",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/report-exports/{exportId}",
        ),
        (
            ("GET",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/report-exports/{exportId}/download",
        ),
        (("GET",), "/api/v1/projects/{websiteProjectKey}/backlinks/settings"),
        (("PUT",), "/api/v1/projects/{websiteProjectKey}/backlinks/settings"),
        (
            ("PUT",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/settings/kill-switches/{capability}",
        ),
        (
            ("GET",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities/{opportunityId}/contacts",
        ),
        (
            ("POST",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities/"
            "{opportunityId}/contacts/candidates",
        ),
        (
            ("GET",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities/"
            "{opportunityId}/draft-jobs/latest",
        ),
        (
            ("POST",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/opportunities",
        ),
        (
            ("POST",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/recommendations/"
            "{recommendationId}/contact-enrichment-jobs",
        ),
        (
            ("GET",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/contact-enrichment-jobs/{jobId}",
        ),
        (
            ("POST",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/contact-enrichment-jobs/{jobId}/retry",
        ),
        (
            ("POST",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/"
            "contact-enrichment-batches/current/retry-unpublished",
        ),
        (
            ("POST",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/recommendations/"
            "{recommendationId}/contacts/candidates",
        ),
        (
            ("PATCH",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/contacts/candidates/{candidateId}",
        ),
        (
            ("GET",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/"
            "{connectionId}/sync-status",
        ),
        (
            ("POST",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/gmail-connections/select",
        ),
        (
            ("POST",),
            "/api/v1/projects/{websiteProjectKey}/backlinks/replies/"
            "{inboundMessageId}/match/unbind",
        ),
    } <= route_keys
    assert all(route.include_in_schema is False for route in runtime_routes)
    assert list(app.openapi()["paths"]) == [
        "/health",
        "/api/v1/projects",
        "/api/v1/projects/{websiteProjectKey}",
        "/api/v1/projects/{websiteProjectKey}/archive",
        "/api/v1/projects/{websiteProjectKey}/restore",
    ]


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
            "/api/v1/projects/project-key/backlinks/opportunities"
            "?managementStatus=ARCHIVED&businessStage=JOINED"
            "&outcomeStatus=OPEN&fulfillmentStatus=NOT_EXPECTED"
            "&search=publisher&limit=5"
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
    assert forwarded.url.params["managementStatus"] == "ARCHIVED"
    assert forwarded.url.params["businessStage"] == "JOINED"
    assert forwarded.url.params["outcomeStatus"] == "OPEN"
    assert forwarded.url.params["fulfillmentStatus"] == "NOT_EXPECTED"
    assert forwarded.url.params["search"] == "publisher"
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
        "/api/v1/projects/project-key/backlinks/assessments/27b4bf0e-b48a-4ec5-a66b-f8956ff87fb6"
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
        path=("/api/v1/projects/project-key/backlinks/drafts/018f0000-0000-7000-8000-000000000011"),
    )

    assert response.status_code == 200
    assert response.json() == payload
    assert len(calls) == 1
    assert calls[0].url.path.endswith("/backlinks/drafts/018f0000-0000-7000-8000-000000000011")


def test_forwards_latest_draft_job_query_once() -> None:
    calls: list[httpx.Request] = []
    payload = {"job": None}

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
            "/api/v1/projects/project-key/backlinks/opportunities/"
            "018f0000-0000-7000-8000-000000000004/draft-jobs/latest"
            "?logicalDraftKey=initial-outreach%3Aopportunity%3Acontact"
        ),
    )

    assert response.status_code == 200
    assert response.json() == payload
    assert len(calls) == 1
    assert calls[0].url.path.endswith(
        "/opportunities/018f0000-0000-7000-8000-000000000004/draft-jobs/latest"
    )
    assert calls[0].url.params["logicalDraftKey"] == ("initial-outreach:opportunity:contact")


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
            "contactId": "018f0000-0000-7000-8000-000000000013",
            "contactVersion": 1,
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


def test_forwards_manual_contact_candidate_once_and_requires_idempotency() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(
            201,
            json={
                "candidateId": "018f0000-0000-7000-8000-000000000073",
                "status": "candidate",
            },
        )

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    path = (
        "/api/v1/projects/project-key/backlinks/opportunities/"
        "018f0000-0000-7000-8000-000000000078/contacts/candidates"
    )
    body = json.dumps(
        {
            "normalizedEmail": "editor@publisher.test",
            "contactRole": "editorial",
            "reason": "Manually verified for this Opportunity.",
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
            "idempotency-key": "contact-create-once",
        },
        content=body,
    )

    assert missing_key.status_code == 400
    assert missing_key.json()["code"] == "PLATFORM_IDEMPOTENCY_REQUIRED"
    assert response.status_code == 201
    assert response.json()["status"] == "candidate"
    assert len(calls) == 1
    assert calls[0].headers["idempotency-key"] == "contact-create-once"
    assert calls[0].content == body


def test_forwards_opportunity_creation_once_and_requires_idempotency() -> None:
    calls: list[httpx.Request] = []
    response_payload = {
        "opportunityId": "018f0000-0000-7000-8000-000000000078",
        "recommendationId": "018f0000-0000-7000-8000-000000000079",
        "websiteProjectId": "project-gateway",
        "targetSiteKey": "publisher.example.test",
        "targetHostAscii": "publisher.example.test",
        "joinSequence": 9,
        "version": 1,
        "businessStage": "JOINED",
        "contactCandidateId": "018f0000-0000-7000-8000-000000000080",
        "contactReviewRequired": False,
        "replayed": False,
        "meta": {
            "organizationId": "org-gateway",
            "workspaceId": "workspace-gateway",
            "websiteProjectId": "project-gateway",
            "requestId": "private-request",
            "schemaVersion": "backlinks.v1",
            "generatedAt": "2026-08-05T00:00:00.000Z",
        },
    }

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(201, json=response_payload)

    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(transport=MockTransport(handler)),
    )
    path = "/api/v1/projects/project-key/backlinks/opportunities"
    body = json.dumps(
        {
            "recommendationId": "018f0000-0000-7000-8000-000000000079",
            "contactCandidateId": "018f0000-0000-7000-8000-000000000080",
            "expectedVersion": 1,
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
            "idempotency-key": "opportunity-create-once",
        },
        content=body,
    )

    assert missing_key.status_code == 400
    assert missing_key.json()["code"] == "PLATFORM_IDEMPOTENCY_REQUIRED"
    assert response.status_code == 201
    assert response.json() == response_payload
    assert len(calls) == 1
    assert calls[0].headers["idempotency-key"] == "opportunity-create-once"
    assert calls[0].content == body


def test_forwards_send_intent_status_read_once() -> None:
    calls: list[httpx.Request] = []
    send_intent_id = "018f0000-0000-7000-8000-000000000114"

    def handler(request: httpx.Request) -> Response:
        calls.append(request)
        return Response(
            200,
            json={
                "sendIntent": {
                    "sendIntentId": send_intent_id,
                    "draftId": "018f0000-0000-7000-8000-000000000011",
                    "status": "PROVIDER_ACCEPTED",
                    "version": 3,
                    "requestedSendAt": "2026-08-03T01:00:00.000Z",
                    "updatedAt": "2026-08-03T01:00:02.000Z",
                    "attempt": {
                        "attemptId": "018f0000-0000-7000-8000-000000000115",
                        "attemptNo": 1,
                        "status": "PROVIDER_ACCEPTED",
                        "rfcMessageId": "<send-intent@example.com>",
                        "providerMessageId": "gmail-message-id",
                        "providerThreadId": "gmail-thread-id",
                        "errorCode": None,
                        "startedAt": "2026-08-03T01:00:01.000Z",
                        "completedAt": "2026-08-03T01:00:02.000Z",
                        "retryEligibleAt": None,
                    },
                }
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
        method="GET",
        path=(f"/api/v1/projects/project-key/backlinks/send-intents/{send_intent_id}"),
    )

    assert response.status_code == 200
    assert response.json()["sendIntent"]["status"] == "PROVIDER_ACCEPTED"
    assert len(calls) == 1
    assert calls[0].url.path.endswith(f"/backlinks/send-intents/{send_intent_id}")


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
    resolver = StaticResolver(RESOLVED)
    response = request_app(
        gateway,
        resolver,
        method="GET",
        path=(
            "/api/v1/backlinks/gmail-connections/callback"
            "?code=authorization-code&state=opaque-state"
        ),
    )

    assert response.status_code == 200
    assert len(calls) == 1
    forwarded = calls[0]
    assert forwarded.url.path == "/api/v1/backlinks/gmail-connections/callback"
    assert resolver.collection_calls == 1
    assert resolver.calls == []
    assert dict(forwarded.url.params) == {
        "code": "authorization-code",
        "state": "opaque-state",
    }


def test_strips_google_callback_metadata_before_forwarding() -> None:
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
            "/api/v1/backlinks/gmail-connections/callback"
            "?code=authorization-code&state=opaque-state"
            "&iss=https%3A%2F%2Faccounts.google.com"
            "&scope=openid%20email"
            "&authuser=0&prompt=consent"
        ),
    )

    assert response.status_code == 200
    assert len(calls) == 1
    assert dict(calls[0].url.params) == {
        "code": "authorization-code",
        "state": "opaque-state",
    }


def test_rejects_untrusted_google_callback_metadata() -> None:
    calls: list[httpx.Request] = []
    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(
            transport=MockTransport(lambda request: calls.append(request) or Response(200))
        ),
    )

    wrong_issuer = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path=(
            "/api/v1/backlinks/gmail-connections/callback"
            "?code=authorization-code&state=opaque-state"
            "&iss=https%3A%2F%2Fattacker.invalid"
        ),
    )
    unsupported = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path=(
            "/api/v1/backlinks/gmail-connections/callback"
            "?code=authorization-code&state=opaque-state&next=https%3A%2F%2Fattacker.invalid"
        ),
    )
    repeated = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path=(
            "/api/v1/backlinks/gmail-connections/callback"
            "?code=authorization-code&code=second-code&state=opaque-state"
        ),
    )

    assert wrong_issuer.status_code == 400
    assert unsupported.status_code == 400
    assert repeated.status_code == 400
    assert wrong_issuer.json()["code"] == "OAUTH_CALLBACK_INVALID"
    assert unsupported.json()["code"] == "OAUTH_CALLBACK_INVALID"
    assert repeated.json()["code"] == "OAUTH_CALLBACK_INVALID"
    assert calls == []


def test_local_product_gmail_callback_redirects_to_application_path() -> None:
    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(
            transport=MockTransport(
                lambda _: Response(
                    200,
                    json={
                        "connection": {"connectionId": "gmail-1"},
                        "returnPath": "/projects/project-key/backlinks/email",
                    },
                )
            )
        ),
    )

    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path=(
            "/api/v1/backlinks/gmail-connections/callback"
            "?code=authorization-code&state=opaque-state"
        ),
        oauth_callback_frontend_origin="http://localhost:5173",
    )

    assert response.status_code == 303
    assert response.headers["location"] == (
        "http://localhost:5173/projects/project-key/backlinks/email"
    )


def test_local_product_gmail_callback_does_not_trust_path_on_invalid_attempt() -> None:
    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(
            transport=MockTransport(
                lambda _: Response(
                    400,
                    json={
                        "code": "BACKLINK_INVALID_REQUEST",
                        "detail": "OAuth callback is invalid or unavailable.",
                    },
                )
            )
        ),
    )

    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path=(
            "/api/v1/projects/project-key/backlinks/gmail-connections/callback"
            "?code=authorization-code&state=opaque-state"
        ),
        oauth_callback_frontend_origin="http://localhost:5173",
    )

    assert response.status_code == 400
    assert response.json()["code"] == "BACKLINK_INVALID_REQUEST"
    assert "location" not in response.headers


def test_local_product_gmail_callback_rejects_external_return_path() -> None:
    gateway = BacklinksGateway(
        base_url="http://backlinks.internal",
        signing_key=SIGNING_KEY,
        client=AsyncClient(
            transport=MockTransport(
                lambda _: Response(
                    200,
                    json={
                        "connection": {"connectionId": "gmail-1"},
                        "returnPath": "//attacker.invalid",
                    },
                )
            )
        ),
    )

    response = request_app(
        gateway,
        StaticResolver(RESOLVED),
        method="GET",
        path=(
            "/api/v1/backlinks/gmail-connections/callback"
            "?code=authorization-code&state=opaque-state"
        ),
        oauth_callback_frontend_origin="http://localhost:5173",
    )

    assert response.status_code == 502
    assert response.json()["code"] == "OAUTH_RETURN_PATH_INVALID"


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
                    "placementId": "018f0000-0000-7000-8000-000000000158",
                    "placementVersion": 5,
                    "accepted": True,
                    "replayed": False,
                    "browserFallbackAllowed": False,
                    "monitorRun": {
                        "monitorRunId": "018f0000-0000-7000-8000-000000000159",
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

    placement_path = "/api/v1/projects/project-key/backlinks/placement-candidates"
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
