import asyncio
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.routes.publications import (
    get_publication_service,
    preview_router,
    router,
)
from app.core.backlinks_gateway import PlatformContextResolutionError
from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.modules.content.schemas import (
    ArticlePreviewResponse,
    ArticlePublicationCollection,
    ArticlePublicationResponse,
    ArticlePublicationSnapshotResponse,
    PublicationTargetCollection,
)


class Resolver:
    def __init__(self, permissions: set[str]) -> None:
        self.permissions = permissions
        self.requested: list[str | None] = []

    async def resolve(self, *, request, website_project_key, required_permission=None):
        del request
        self.requested.append(required_permission)
        if required_permission not in self.permissions:
            raise PlatformContextResolutionError(
                status=403,
                code="permission_denied",
                title="Permission denied",
                detail="The required permission is missing.",
            )
        return ResolvedPlatformRequestContext(
            actor=PlatformActor("publisher-p5", "session-p5", ("content_publisher",)),
            tenant=PlatformTenant("org-p5", "workspace-p5"),
            project=PlatformProject(website_project_key, website_project_key),
            permissions=tuple(sorted(self.permissions)),
            correlation_id="correlation-p5",
        )


def publication_response(status: str = "queued") -> ArticlePublicationResponse:
    now = datetime.now(UTC)
    return ArticlePublicationResponse(
        id="publication-p5",
        article_id="article-p5",
        version_number=4,
        target_id="target-p5",
        parent_publication_id=None,
        operation="create",
        mode="immediate",
        schedule_at_utc=None,
        source_timezone="UTC",
        status=status,
        payload_hash="a" * 64,
        asset_manifest_hash="b" * 64,
        remote_post_id=None,
        remote_url=None,
        attempt_count=0,
        last_error_code=None,
        last_error_detail=None,
        created_by="publisher-p5",
        created_at=now,
        updated_at=now,
        published_at=None,
        cancelled_at=None,
        media=[],
        allowed_actions=["cancel"] if status == "queued" else [],
    )


class Service:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.preview_error: Exception | None = None

    async def list_targets(self, organization_id, project_id):
        self.calls.append(("targets", organization_id, project_id))
        return PublicationTargetCollection(items=[])

    async def create_preview(self, organization_id, project_id, article_id, preview, **values):
        self.calls.append(("create_preview", organization_id, project_id, article_id, preview, values))
        return ArticlePreviewResponse(
            id="preview-p5",
            article_id=article_id,
            source_type=preview.source_type,
            source_version_number=preview.version_number,
            autosave_id=preview.autosave_id,
            target_id=preview.target_id,
            preview_url="/api/v1/article-previews/preview-p5#token=secret-fragment-token",
            expires_at=datetime.now(UTC) + timedelta(minutes=30),
            revoked_at=None,
        )

    async def revoke_preview(self, *args, **values):
        self.calls.append(("revoke_preview", args, values))

    async def verify_preview(self, preview_id, token):
        self.calls.append(("verify_preview", preview_id, token))
        if self.preview_error:
            raise self.preview_error

    async def render_preview(self, preview_id, token):
        self.calls.append(("render_preview", preview_id, token))
        if self.preview_error:
            raise self.preview_error
        return "<!doctype html><meta name='robots' content='noindex'><h1>Frozen preview</h1>"

    async def create_publication(self, organization_id, project_id, article_id, publication, key, **values):
        self.calls.append(("create_publication", organization_id, project_id, article_id, publication, key, values))
        if key == "conflict-key":
            raise ValueError("idempotency_key_conflict")
        return publication_response()

    async def list_publications(self, organization_id, project_id, article_id):
        self.calls.append(("list", organization_id, project_id, article_id))
        return ArticlePublicationCollection(items=[publication_response()])

    async def get_publication(self, organization_id, project_id, publication_id):
        self.calls.append(("get", organization_id, project_id, publication_id))
        if publication_id == "missing":
            raise LookupError("publication_not_found")
        return publication_response()

    async def publication_snapshot(self, organization_id, project_id, publication_id):
        self.calls.append(("snapshot", organization_id, project_id, publication_id))
        return ArticlePublicationSnapshotResponse(
            publication_id=publication_id,
            published_version_number=4,
            published_snapshot={"version_number": 4},
            current_draft_version_number=4,
            current_draft_diff=None,
        )

    async def cancel_publication(self, *args, **values):
        self.calls.append(("cancel", args, values))
        return publication_response("cancelled")

    async def retry_publication(self, *args, **values):
        self.calls.append(("retry", args, values))
        return publication_response()

    async def reconcile_publication(self, *args, **values):
        self.calls.append(("reconcile", args, values))
        return publication_response("published")


def build_api(permissions: set[str]) -> tuple[FastAPI, Service, Resolver]:
    app = FastAPI()
    app.include_router(router)
    app.include_router(preview_router)
    service = Service()
    resolver = Resolver(permissions)
    app.state.platform_context_resolver = resolver
    app.dependency_overrides[get_publication_service] = lambda: service
    return app, service, resolver


def test_publication_mutations_require_publish_permission_and_idempotency_key() -> None:
    async def scenario() -> None:
        denied_app, denied_service, denied_resolver = build_api({"content:read"})
        async with AsyncClient(transport=ASGITransport(app=denied_app), base_url="http://test") as client:
            denied = await client.post(
                "/api/v1/projects/project-p5/articles/article-p5/publications",
                headers={"Idempotency-Key": "denied-key", "x-request-id": "request-denied"},
                json={"version_number": 4, "target_id": "target-p5"},
            )
        assert denied.status_code == 403
        assert denied.json()["error"]["code"] == "permission_denied"
        assert denied_service.calls == []
        assert denied_resolver.requested == ["content:publish"]

        app, service, _ = build_api({"content:publish"})
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            missing = await client.post(
                "/api/v1/projects/project-p5/articles/article-p5/publications",
                json={"version_number": 4, "target_id": "target-p5"},
            )
            accepted = await client.post(
                "/api/v1/projects/project-p5/articles/article-p5/publications",
                headers={"Idempotency-Key": "publication-key"},
                json={"version_number": 4, "target_id": "target-p5"},
            )
            conflict = await client.post(
                "/api/v1/projects/project-p5/articles/article-p5/publications",
                headers={"Idempotency-Key": "conflict-key", "x-request-id": "request-conflict"},
                json={"version_number": 4, "target_id": "target-p5"},
            )
        assert missing.status_code == 422
        assert accepted.status_code == 202
        call = next(item for item in service.calls if item[0] == "create_publication")
        assert call[1:5] == ("org-p5", "project-p5", "article-p5", call[4])
        assert call[5] == "publication-key"
        assert conflict.status_code == 409
        assert conflict.json()["error"]["code"] == "idempotency_key_conflict"

    asyncio.run(scenario())


def test_reads_use_content_read_and_keep_project_scope() -> None:
    async def scenario() -> None:
        app, service, resolver = build_api({"content:read"})
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            listed = await client.get("/api/v1/projects/project-b/articles/article-p5/publications")
            detail = await client.get("/api/v1/projects/project-b/publications/publication-p5")
            missing = await client.get("/api/v1/projects/project-b/publications/missing")
        assert listed.status_code == detail.status_code == 200
        assert ("list", "org-p5", "project-b", "article-p5") in service.calls
        assert ("get", "org-p5", "project-b", "publication-p5") in service.calls
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "publication_not_found"
        assert resolver.requested == ["content:read", "content:read", "content:read"]

    asyncio.run(scenario())


def test_preview_session_uses_http_only_cookie_and_locked_down_headers() -> None:
    async def scenario() -> None:
        app, service, _ = build_api(set())
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            bootstrap = await client.get("/api/v1/article-previews/preview-p5")
            session = await client.post(
                "/api/v1/article-previews/preview-p5/session",
                json={"token": "preview-token-at-least-twenty-characters"},
            )
            rendered = await client.get("/api/v1/article-previews/preview-p5")
        assert "location.hash" in bootstrap.text
        assert "script-src 'nonce-" in bootstrap.headers["content-security-policy"]
        assert "connect-src 'self'" in bootstrap.headers["content-security-policy"]
        assert session.status_code == 204
        cookie = session.headers["set-cookie"]
        assert "HttpOnly" in cookie and "SameSite=strict" in cookie
        assert "Path=/api/v1/article-previews/preview-p5" in cookie
        assert "preview-token" not in session.text
        assert rendered.status_code == 200
        assert "Frozen preview" in rendered.text
        for response in (bootstrap, session, rendered):
            assert response.headers["cache-control"].startswith("no-store")
            assert response.headers["referrer-policy"] == "no-referrer"
            assert response.headers["x-robots-tag"].startswith("noindex")
        assert any(call[0] == "render_preview" for call in service.calls)

    asyncio.run(scenario())


def test_snapshot_cancel_retry_and_reconcile_keep_read_publish_permissions_separate() -> None:
    async def scenario() -> None:
        app, service, resolver = build_api({"content:read", "content:publish"})
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            snapshot = await client.get(
                "/api/v1/projects/project-p5/publications/publication-p5/snapshot"
            )
            cancelled = await client.post(
                "/api/v1/projects/project-p5/publications/publication-p5/cancel",
                json={"reason": "Schedule changed"},
            )
            retried = await client.post(
                "/api/v1/projects/project-p5/publications/publication-p5/retry",
                headers={"Idempotency-Key": "retry-key"},
                json={"expected_status": "failed"},
            )
            reconciled = await client.post(
                "/api/v1/projects/project-p5/publications/publication-p5/reconcile"
            )
        assert snapshot.status_code == cancelled.status_code == retried.status_code == 200
        assert reconciled.status_code == 200
        assert snapshot.json()["published_version_number"] == 4
        assert cancelled.json()["status"] == "cancelled"
        assert reconciled.json()["status"] == "published"
        assert resolver.requested == [
            "content:read",
            "content:publish",
            "content:publish",
            "content:publish",
        ]
        retry_call = next(call for call in service.calls if call[0] == "retry")
        assert retry_call[1][3] == "retry-key"

    asyncio.run(scenario())


def test_expired_or_revoked_preview_returns_gone_without_rendering() -> None:
    async def scenario() -> None:
        app, service, _ = build_api(set())
        service.preview_error = ValueError("article_preview_expired")
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/api/v1/article-previews/preview-p5/session",
                json={"token": "preview-token-at-least-twenty-characters"},
            )
        assert response.status_code == 410
        assert response.json()["detail"] == "article_preview_expired"

    asyncio.run(scenario())
