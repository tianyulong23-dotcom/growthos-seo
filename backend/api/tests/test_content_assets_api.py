import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.routes.assets import get_asset_service, router
from app.core.backlinks_gateway import PlatformContextResolutionError
from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.modules.content.asset_schemas import (
    AssetCollectionResponse,
    AssetDownloadAuthorizationResponse,
    AssetUsageResponse,
    AssetUploadCreateResponse,
)
from app.modules.content.asset_service import AssetError


class AssetApiResolver:
    def __init__(
        self, permissions: set[str], *, canonical_project_id: str | None = None
    ) -> None:
        self.permissions = permissions
        self.canonical_project_id = canonical_project_id
        self.requested_permissions: list[str | None] = []

    async def resolve(self, *, request, website_project_key: str, required_permission=None):
        del request
        self.requested_permissions.append(required_permission)
        if required_permission not in self.permissions:
            raise PlatformContextResolutionError(
                status=403,
                code="permission_denied",
                title="Permission denied",
                detail="The required permission is missing.",
            )
        return ResolvedPlatformRequestContext(
            actor=PlatformActor(
                user_id="user-assets-api",
                session_id="session-assets-api",
                roles=("site_owner", "content_editor"),
            ),
            tenant=PlatformTenant(
                organization_id="org-assets-api", workspace_id="workspace-assets-api"
            ),
            project=PlatformProject(
                website_project_id=self.canonical_project_id or website_project_key,
                website_project_key=website_project_key,
            ),
            permissions=tuple(sorted(self.permissions)),
            correlation_id="correlation-assets-api",
        )


class AssetApiService:
    def __init__(self) -> None:
        self.settings = SimpleNamespace(asset_upload_part_size=4)
        self.create_calls: list[dict] = []
        self.upload_calls: list[dict] = []
        self.list_calls: list[dict] = []
        self.authorize_calls: list[dict] = []
        self.update_calls: list[dict] = []
        self.usage_calls: list[tuple[str, str]] = []
        self.project_calls: list[tuple[str, str]] = []

    @staticmethod
    def _not_found():
        raise AssetError(
            "asset_not_found",
            "The asset was not found.",
            status_code=404,
        )

    async def create_upload(self, **values):
        self.project_calls.append(("create_upload", values["project_id"]))
        self.create_calls.append(values)
        if not values["idempotency_key"] or " " in values["idempotency_key"]:
            raise AssetError(
                "asset_idempotency_key_required",
                "A valid Idempotency-Key header is required.",
                status_code=400,
            )
        return AssetUploadCreateResponse(
            asset_id="ast-api",
            upload_id="upl-api",
            status="initiated",
            part_size=4,
            maximum_bytes=1024,
            expires_at="2026-08-10T00:00:00Z",
        )

    async def upload_part(self, **values):
        self.project_calls.append(("upload_part", values["project_id"]))
        self.upload_calls.append(values)
        raise AssetError(
            "asset_hash_mismatch",
            "The upload part checksum does not match.",
        )

    async def list_assets(self, **values):
        self.project_calls.append(("list_assets", values["project_id"]))
        self.list_calls.append(values)
        return AssetCollectionResponse(items=[])

    async def complete_upload(self, **values):
        self.project_calls.append(("complete_upload", values["project_id"]))
        self._not_found()

    async def get_asset(self, project_id, *_values):
        self.project_calls.append(("get_asset", project_id))
        self._not_found()

    async def update_metadata(self, **values):
        self.project_calls.append(("update_metadata", values["project_id"]))
        self.update_calls.append(values)
        self._not_found()

    async def usage(self, project_id, asset_id):
        self.project_calls.append(("usage", project_id))
        self.usage_calls.append((project_id, asset_id))
        if asset_id == "asset-missing":
            self._not_found()
        return AssetUsageResponse(
            asset_id=asset_id,
            active_reference_count=0,
            article_count=0,
            items=[],
        )

    async def retry(self, project_id, *_values, **_kwargs):
        self.project_calls.append(("retry", project_id))
        self._not_found()

    async def cancel(self, project_id, *_values, **_kwargs):
        self.project_calls.append(("cancel", project_id))
        self._not_found()

    async def import_url(self, **values):
        self.project_calls.append(("import_url", values["project_id"]))
        self._not_found()

    async def download_url(self, project_id, *_values):
        self.project_calls.append(("download_url", project_id))
        self._not_found()

    async def authorize_download(
        self, project_id, asset_id, *, disposition, variant_type=None
    ):
        self.project_calls.append(("authorize_download", project_id))
        self.authorize_calls.append(
            {
                "project_id": project_id,
                "asset_id": asset_id,
                "disposition": disposition,
                "variant_type": variant_type,
            }
        )
        if asset_id == "asset-missing":
            self._not_found()
        if asset_id == "asset-processing":
            raise AssetError(
                "asset_not_ready",
                "The asset is not ready.",
                status_code=409,
            )
        return AssetDownloadAuthorizationResponse(
            url=f"https://objects.example/{asset_id}?signed=redacted",
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
        )

    async def delete(self, project_id, *_values, **_kwargs):
        self.project_calls.append(("delete", project_id))
        self._not_found()


def build_asset_api(
    permissions: set[str],
    *,
    canonical_project_id: str | None = None,
) -> tuple[FastAPI, AssetApiService, AssetApiResolver]:
    application = FastAPI()
    application.include_router(router)
    service = AssetApiService()
    resolver = AssetApiResolver(
        permissions, canonical_project_id=canonical_project_id
    )
    application.state.platform_context_resolver = resolver
    application.dependency_overrides[get_asset_service] = lambda: service
    return application, service, resolver


def test_asset_upload_requires_manage_permission_and_stable_idempotency_error() -> None:
    async def scenario() -> None:
        denied_app, denied_service, denied_resolver = build_asset_api({"content:read"})
        async with AsyncClient(
            transport=ASGITransport(app=denied_app), base_url="http://test"
        ) as client:
            denied = await client.post(
                "/api/v1/projects/project-a/assets/uploads",
                headers={"x-request-id": "request-denied"},
                json={
                    "filename": "photo.jpg",
                    "byte_size": 128,
                    "declared_mime_type": "image/jpeg",
                    "asset_type": "image",
                },
            )
        assert denied.status_code == 403
        assert denied.json() == {
            "error": {
                "code": "permission_denied",
                "message": "The required permission is missing.",
                "retryable": False,
                "request_id": "request-denied",
            }
        }
        assert denied_service.create_calls == []
        assert denied_resolver.requested_permissions == ["content:manage_assets"]

        app, service, _ = build_asset_api({"content:manage_assets"})
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            missing = await client.post(
                "/api/v1/projects/project-a/assets/uploads",
                headers={"x-request-id": "request-missing-key"},
                json={
                    "filename": "photo.jpg",
                    "byte_size": 128,
                    "declared_mime_type": "image/jpeg",
                    "asset_type": "image",
                },
            )
            invalid = await client.post(
                "/api/v1/projects/project-a/assets/uploads",
                headers={
                    "x-request-id": "request-invalid-key",
                    "Idempotency-Key": "invalid key",
                },
                json={
                    "filename": "photo.jpg",
                    "byte_size": 128,
                    "declared_mime_type": "image/jpeg",
                    "asset_type": "image",
                },
            )
            accepted = await client.post(
                "/api/v1/projects/project-a/assets/uploads",
                headers={
                    "x-request-id": "request-accepted",
                    "Idempotency-Key": "valid-key",
                },
                json={
                    "filename": "photo.jpg",
                    "byte_size": 128,
                    "declared_mime_type": "image/jpeg",
                    "asset_type": "image",
                },
            )
        for response, request_id in (
            (missing, "request-missing-key"),
            (invalid, "request-invalid-key"),
        ):
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "asset_idempotency_key_required"
            assert response.json()["error"]["request_id"] == request_id
            assert "request_id" not in response.json()
        assert accepted.status_code == 200
        audit = service.create_calls[-1]["audit"]
        assert audit.actor_id == "user-assets-api"
        assert audit.effective_role == "content_editor|site_owner"
        assert audit.request_id == "request-accepted"
        assert audit.correlation_id == "correlation-assets-api"

    asyncio.run(scenario())


def test_asset_part_body_is_bounded_even_without_content_length() -> None:
    async def scenario() -> None:
        app, service, _ = build_asset_api({"content:manage_assets"})

        async def oversized_stream():
            yield b"123"
            yield b"45"

        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            oversized = await client.put(
                "/api/v1/projects/project-a/assets/ast-a/content?part_number=1",
                headers={"x-request-id": "request-stream-limit"},
                content=oversized_stream(),
            )
            negative = await client.put(
                "/api/v1/projects/project-a/assets/ast-a/content?part_number=1",
                headers={
                    "x-request-id": "request-negative-length",
                    "Content-Length": "-1",
                },
                content=b"",
            )
            invalid = await client.put(
                "/api/v1/projects/project-a/assets/ast-a/content?part_number=1",
                headers={
                    "x-request-id": "request-invalid-length",
                    "Content-Length": "not-a-number",
                },
                content=b"",
            )
            declared_too_large = await client.put(
                "/api/v1/projects/project-a/assets/ast-a/content?part_number=1",
                headers={
                    "x-request-id": "request-declared-limit",
                    "Content-Length": "5",
                },
                content=b"12345",
            )
            product_error = await client.put(
                "/api/v1/projects/project-a/assets/ast-a/content?part_number=1",
                headers={"x-request-id": "request-hash"},
                content=b"1234",
            )
        assert oversized.status_code == 413
        assert oversized.json()["error"]["code"] == "asset_part_too_large"
        assert negative.status_code == 400
        assert negative.json()["error"]["code"] == "asset_content_length_invalid"
        assert invalid.status_code == 400
        assert invalid.json()["error"]["code"] == "asset_content_length_invalid"
        assert declared_too_large.status_code == 413
        assert declared_too_large.json()["error"]["code"] == "asset_part_too_large"
        assert product_error.status_code == 422
        assert product_error.json()["error"] == {
            "code": "asset_hash_mismatch",
            "message": "The upload part checksum does not match.",
            "retryable": False,
            "request_id": "request-hash",
        }
        assert len(service.upload_calls) == 1

    asyncio.run(scenario())


def test_asset_list_requires_read_permission_and_rejects_unknown_status() -> None:
    async def scenario() -> None:
        app, service, resolver = build_asset_api({"content:read"})
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            accepted = await client.get(
                "/api/v1/projects/project-a/assets?status=ready"
            )
            invalid = await client.get(
                "/api/v1/projects/project-a/assets?status=made_up"
            )
        assert accepted.status_code == 200
        assert service.list_calls[-1]["status"] == "ready"
        assert resolver.requested_permissions == ["content:read"]
        assert invalid.status_code == 422
        assert len(service.list_calls) == 1

    asyncio.run(scenario())


def test_asset_metadata_requires_manage_permission_and_usage_requires_read() -> None:
    async def scenario() -> None:
        app, service, resolver = build_asset_api(
            {"content:read", "content:manage_assets"}
        )
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            empty = await client.patch(
                "/api/v1/projects/project-a/assets/asset-a", json={}
            )
            missing = await client.patch(
                "/api/v1/projects/project-a/assets/asset-a",
                headers={"x-request-id": "request-update"},
                json={"title": "Asset title", "default_alt_text": "Useful alt"},
            )
            usage = await client.get(
                "/api/v1/projects/project-a/assets/asset-a/usage"
            )

        assert empty.status_code == 422
        assert missing.status_code == 404
        assert service.update_calls[-1]["user_id"] == "user-assets-api"
        assert service.update_calls[-1]["request"].title == "Asset title"
        assert usage.status_code == 200
        assert usage.json()["article_count"] == 0
        assert resolver.requested_permissions == [
            "content:manage_assets",
            "content:read",
        ]

    asyncio.run(scenario())


def test_cross_project_asset_actions_share_not_found_semantics() -> None:
    async def scenario() -> None:
        app, service, resolver = build_asset_api(
            {"content:read", "content:manage_assets"}
        )
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            responses = [
                await client.get(
                    "/api/v1/projects/project-b/assets/asset-from-project-a",
                    headers={"x-request-id": "request-get"},
                ),
                await client.patch(
                    "/api/v1/projects/project-b/assets/asset-from-project-a",
                    headers={"x-request-id": "request-update"},
                    json={"title": "Hidden"},
                ),
                await client.get(
                    "/api/v1/projects/project-b/assets/asset-missing/usage",
                    headers={"x-request-id": "request-usage"},
                ),
                await client.post(
                    "/api/v1/projects/project-b/assets/asset-from-project-a/complete",
                    headers={"x-request-id": "request-complete"},
                    json={"parts": [{"part_number": 1, "etag": "etag-1"}]},
                ),
                await client.post(
                    "/api/v1/projects/project-b/assets/asset-from-project-a/retry",
                    headers={"x-request-id": "request-retry"},
                ),
                await client.post(
                    "/api/v1/projects/project-b/assets/asset-from-project-a/cancel",
                    headers={"x-request-id": "request-cancel"},
                ),
                await client.get(
                    "/api/v1/projects/project-b/assets/asset-from-project-a/download",
                    headers={"x-request-id": "request-download"},
                    follow_redirects=False,
                ),
                await client.post(
                    "/api/v1/projects/project-b/assets/asset-missing/download-authorizations",
                    headers={"x-request-id": "request-authorize"},
                    json={"disposition": "inline"},
                ),
                await client.delete(
                    "/api/v1/projects/project-b/assets/asset-from-project-a",
                    headers={"x-request-id": "request-delete"},
                ),
            ]
            listed = await client.get("/api/v1/projects/project-b/assets")

        for response, action in zip(
            responses,
            (
                "get",
                "update",
                "usage",
                "complete",
                "retry",
                "cancel",
                "download",
                "authorize",
                "delete",
            ),
            strict=True,
        ):
            assert response.status_code == 404
            assert response.json() == {
                "error": {
                    "code": "asset_not_found",
                    "message": "The asset was not found.",
                    "retryable": False,
                    "request_id": f"request-{action}",
                }
            }
        assert listed.status_code == 200
        assert listed.json() == {"items": [], "next_cursor": None}
        assert service.list_calls[-1]["project_id"] == "project-b"
        assert resolver.requested_permissions == [
            "content:read",
            "content:manage_assets",
            "content:read",
            "content:manage_assets",
            "content:manage_assets",
            "content:manage_assets",
            "content:read",
            "content:read",
            "content:manage_assets",
            "content:read",
        ]

    asyncio.run(scenario())


def test_asset_download_authorization_requires_read_and_returns_expiry() -> None:
    async def scenario() -> None:
        denied_app, denied_service, denied_resolver = build_asset_api(
            {"content:manage_assets"}
        )
        async with AsyncClient(
            transport=ASGITransport(app=denied_app), base_url="http://test"
        ) as client:
            denied = await client.post(
                "/api/v1/projects/project-a/assets/asset-ready/download-authorizations",
                headers={
                    "x-request-id": "request-authorize-denied",
                    "Authorization": "Bearer must-not-be-reflected",
                },
                json={"disposition": "inline"},
            )
        assert denied.status_code == 403
        assert denied_service.authorize_calls == []
        assert denied_resolver.requested_permissions == ["content:read"]
        assert "must-not-be-reflected" not in denied.text

        app, service, resolver = build_asset_api({"content:read"})
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            inline = await client.post(
                "/api/v1/projects/project-a/assets/asset-ready/download-authorizations",
                headers={"x-request-id": "request-authorize-inline"},
                json={"disposition": "inline"},
            )
            attachment = await client.post(
                "/api/v1/projects/project-a/assets/asset-ready/download-authorizations",
                headers={"x-request-id": "request-authorize-attachment"},
                json={"disposition": "attachment"},
            )
            poster = await client.post(
                "/api/v1/projects/project-a/assets/asset-ready/download-authorizations",
                headers={"x-request-id": "request-authorize-poster"},
                json={"disposition": "inline", "variant_type": "poster"},
            )
            not_ready = await client.post(
                "/api/v1/projects/project-a/assets/asset-processing/download-authorizations",
                headers={"x-request-id": "request-authorize-processing"},
                json={"disposition": "inline"},
            )

        assert inline.status_code == 200
        assert inline.json()["url"].startswith("https://objects.example/")
        assert datetime.fromisoformat(inline.json()["expires_at"]) > datetime.now(UTC)
        assert attachment.status_code == 200
        assert poster.status_code == 200
        assert not_ready.status_code == 409
        assert not_ready.json()["error"]["code"] == "asset_not_ready"
        assert service.authorize_calls == [
            {
                "project_id": "project-a",
                "asset_id": "asset-ready",
                "disposition": "inline",
                "variant_type": None,
            },
            {
                "project_id": "project-a",
                "asset_id": "asset-ready",
                "disposition": "attachment",
                "variant_type": None,
            },
            {
                "project_id": "project-a",
                "asset_id": "asset-ready",
                "disposition": "inline",
                "variant_type": "poster",
            },
            {
                "project_id": "project-a",
                "asset_id": "asset-processing",
                "disposition": "inline",
                "variant_type": None,
            },
        ]
        assert resolver.requested_permissions == [
            "content:read",
            "content:read",
            "content:read",
            "content:read",
        ]

    asyncio.run(scenario())


def test_asset_routes_use_the_resolved_canonical_project_id() -> None:
    async def scenario() -> None:
        app, service, _ = build_asset_api(
            {"content:read", "content:manage_assets"},
            canonical_project_id="canonical-project-id",
        )
        base = "/api/v1/projects/public-project-key/assets"
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            await client.post(
                f"{base}/uploads",
                headers={"Idempotency-Key": "canonical-create"},
                json={
                    "filename": "photo.jpg",
                    "byte_size": 4,
                    "declared_mime_type": "image/jpeg",
                    "asset_type": "image",
                },
            )
            await client.put(f"{base}/asset-1/content?part_number=1", content=b"1234")
            await client.post(
                f"{base}/asset-1/complete",
                json={"parts": [{"part_number": 1, "etag": "etag-1"}]},
            )
            await client.get(f"{base}/asset-1")
            await client.patch(f"{base}/asset-1", json={"title": "Title"})
            await client.get(f"{base}/asset-1/usage")
            await client.post(f"{base}/asset-1/retry")
            await client.post(f"{base}/asset-1/cancel")
            await client.post(
                f"{base}/import",
                headers={"Idempotency-Key": "canonical-import"},
                json={"source_url": "https://example.com/photo.jpg", "asset_type": "image"},
            )
            await client.get(base)
            await client.get(f"{base}/asset-1/download", follow_redirects=False)
            await client.post(
                f"{base}/asset-1/download-authorizations",
                json={"disposition": "inline"},
            )
            await client.delete(f"{base}/asset-1")

        assert service.project_calls == [
            ("create_upload", "canonical-project-id"),
            ("upload_part", "canonical-project-id"),
            ("complete_upload", "canonical-project-id"),
            ("get_asset", "canonical-project-id"),
            ("update_metadata", "canonical-project-id"),
            ("usage", "canonical-project-id"),
            ("retry", "canonical-project-id"),
            ("cancel", "canonical-project-id"),
            ("import_url", "canonical-project-id"),
            ("list_assets", "canonical-project-id"),
            ("download_url", "canonical-project-id"),
            ("authorize_download", "canonical-project-id"),
            ("delete", "canonical-project-id"),
        ]

    asyncio.run(scenario())
