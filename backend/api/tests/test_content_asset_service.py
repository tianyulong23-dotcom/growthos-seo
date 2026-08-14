import asyncio
import hashlib
import logging
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from app.core.config import Settings
from app.modules.content.asset_schemas import (
    AssetImportRequest,
    AssetUpdateRequest,
    AssetUploadCompleteRequest,
    AssetUploadCreateRequest,
    CompletedPart,
)
from app.modules.content.asset_service import (
    AssetError,
    AssetProcessingDispatcher,
    AssetService,
)
from app.modules.content.asset_service import _decode_asset_cursor, _encode_asset_cursor
from app.modules.content.asset_security import AssetSecurityError, ProcessedAsset
from app.modules.content.models import (
    AssetUploadPart,
    AssetUploadSession,
    AssetVariant,
    ContentAsset,
)
from app.modules.content.object_storage import AssetObjectHead, UploadedPart


class DispatcherStore:
    def __init__(self) -> None:
        self.deleted: list[str] = []
        self.fail_delete: set[str] = set()

    async def delete(self, key: str) -> None:
        if key in self.fail_delete:
            raise RuntimeError("delete failed")
        self.deleted.append(key)


class DispatcherProcessor:
    def __init__(self, outcome) -> None:
        self.outcome = outcome
        self.store = DispatcherStore()

    async def process(self, asset):
        del asset
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


class DispatcherRepository:
    def __init__(self, asset, upload=None) -> None:
        self.asset = asset
        self.upload = upload
        self.failed: list[dict] = []
        self.completed: list[dict] = []
        self.cleanup: list[dict] = []

    async def claim_jobs(self, **_values):
        return ["job-1"]

    async def claim_cleanup_jobs(self, **_values):
        return []

    async def get_claimed_job(self, job_id, worker_id):
        return (
            SimpleNamespace(id=job_id, worker_id=worker_id),
            self.asset,
            self.upload,
        )

    async def complete_job(self, **values):
        self.completed.append(values)

    async def fail_job(self, **values):
        self.failed.append(values)

    async def queue_object_cleanup(self, **values):
        self.cleanup.append(values)


class MemoryUploadStore:
    def __init__(self) -> None:
        self.parts: dict[int, bytes] = {}
        self.completed = False
        self.complete_calls = 0
        self.fail_complete_after_commit = False
        self.abort_calls: list[tuple[str, str]] = []
        self.download_calls: list[tuple[str, str, int, str]] = []

    async def create_multipart_upload(self, key: str, content_type: str) -> str:
        assert key.endswith("/incoming")
        assert content_type == "image/jpeg"
        return "s3-upload"

    async def upload_part(
        self, key: str, upload_id: str, part_number: int, body: bytes
    ) -> UploadedPart:
        assert upload_id == "s3-upload"
        self.parts[part_number] = body
        return UploadedPart(part_number, hashlib.md5(body).hexdigest(), len(body))  # noqa: S324

    async def head(self, key: str) -> AssetObjectHead:
        if not self.completed:
            from app.modules.content.object_storage import AssetObjectNotFoundError

            raise AssetObjectNotFoundError("missing")
        body = b"".join(self.parts[number] for number in sorted(self.parts))
        return AssetObjectHead(len(body), "image/jpeg", "etag")

    async def complete_multipart_upload(
        self, key: str, upload_id: str, parts: list[UploadedPart]
    ) -> AssetObjectHead:
        from app.modules.content.object_storage import AssetObjectError

        assert [part.part_number for part in parts] == sorted(self.parts)
        self.complete_calls += 1
        self.completed = True
        if self.fail_complete_after_commit:
            raise AssetObjectError("multipart already completed")
        return await self.head(key)

    async def abort_multipart_upload(self, key: str, upload_id: str) -> None:
        self.abort_calls.append((key, upload_id))

    async def presigned_download_url(
        self, key: str, filename: str, expires_seconds: int, disposition: str
    ) -> str:
        self.download_calls.append((key, filename, expires_seconds, disposition))
        return f"https://downloads.example/{key}?filename={filename}"


class MemoryAssetRepository:
    def __init__(self) -> None:
        self.asset: ContentAsset | None = None
        self.upload: AssetUploadSession | None = None
        self.parts: dict[int, AssetUploadPart] = {}
        self.variants: list[AssetVariant] = []
        self.queued = False

    async def find_upload_by_idempotency(self, project_id: str, user_id: str, key: str):
        if self.upload and self.upload.idempotency_key == key:
            return self.asset, self.upload
        return None

    async def create_upload(
        self, *, asset: ContentAsset, upload: AssetUploadSession, audit=None
    ) -> None:
        del audit
        asset.created_at = datetime.now(UTC)
        upload.created_at = datetime.now(UTC)
        self.asset = asset
        self.upload = upload

    async def get_upload(self, project_id: str, asset_id: str):
        if not self.asset or self.asset.id != asset_id or self.asset.project_id != project_id:
            return None
        return self.asset, self.upload, [self.parts[key] for key in sorted(self.parts)]

    async def record_part(self, **values):
        assert self.asset and self.upload
        number = values["part_number"]
        previous = self.parts.get(number)
        part = AssetUploadPart(
            id=f"part-{number}",
            upload_session_id=self.upload.id,
            part_number=number,
            etag=values["etag"],
            byte_size=values["byte_size"],
            checksum_sha256=values["checksum_sha256"],
        )
        if previous is None:
            self.upload.uploaded_bytes += part.byte_size
        elif previous.checksum_sha256 != part.checksum_sha256:
            self.upload.uploaded_bytes += part.byte_size - previous.byte_size
        self.parts[number] = part
        self.upload.status = "uploading"
        return self.asset, self.upload, part

    async def mark_upload_completing(self, project_id: str, asset_id: str) -> None:
        assert self.upload
        self.upload.status = "completing"

    async def queue_processing(self, **_: object) -> None:
        assert self.asset and self.upload
        self.asset.status = "processing"
        self.upload.status = "completed"
        self.queued = True

    async def get_asset_with_variants(self, project_id: str, asset_id: str):
        if self.asset and self.asset.id == asset_id and self.asset.project_id == project_id:
            return self.asset, self.variants
        return None

    async def get_asset(self, project_id: str, asset_id: str):
        if self.asset and self.asset.id == asset_id and self.asset.project_id == project_id:
            return self.asset
        return None

    async def reference_counts(self, asset_ids: list[str]):
        return {asset_id: 0 for asset_id in asset_ids}

    async def update_metadata(
        self, *, project_id, asset_id, values, user_id, audit=None
    ):
        del audit
        if not self.asset or self.asset.id != asset_id or self.asset.project_id != project_id:
            raise LookupError("asset_not_found")
        for key, value in values.items():
            setattr(self.asset, key, value)
        self.asset.metadata_updated_by = user_id
        self.asset.updated_at = datetime.now(UTC)
        return self.asset

    async def usage(self, project_id: str, asset_id: str):
        if not self.asset or self.asset.id != asset_id or self.asset.project_id != project_id:
            return None
        return self.asset, []


def build_service(expected_size: int) -> tuple[AssetService, MemoryAssetRepository, MemoryUploadStore]:
    settings = Settings(
        app_env="test",
        asset_upload_part_size=5 * 1024 * 1024,
        asset_image_max_bytes=20 * 1024 * 1024,
    )
    repository = MemoryAssetRepository()
    store = MemoryUploadStore()
    service = AssetService(repository=repository, store=store, settings=settings)  # type: ignore[arg-type]
    return service, repository, store


def upload_request(byte_size: int) -> AssetUploadCreateRequest:
    return AssetUploadCreateRequest(
        filename="photo.jpg",
        byte_size=byte_size,
        declared_mime_type="image/jpeg",
        asset_type="image",
    )


def test_upload_initialization_is_idempotent_and_detects_key_reuse() -> None:
    async def scenario() -> None:
        service, _, _ = build_service(10)
        first = await service.create_upload(
            project_id="project-a",
            user_id="user-a",
            idempotency_key="upload-1",
            request=upload_request(10),
        )
        repeated = await service.create_upload(
            project_id="project-a",
            user_id="user-a",
            idempotency_key="upload-1",
            request=upload_request(10),
        )
        assert repeated == first

        with pytest.raises(AssetError) as conflict:
            await service.create_upload(
                project_id="project-a",
                user_id="user-a",
                idempotency_key="upload-1",
                request=upload_request(11),
            )
        assert conflict.value.code == "asset_idempotency_conflict"
        assert conflict.value.status_code == 409

    asyncio.run(scenario())


def test_part_retransmission_replaces_bytes_without_double_counting() -> None:
    async def scenario() -> None:
        part_size = 5 * 1024 * 1024
        service, repository, _ = build_service(part_size)
        upload = await service.create_upload(
            project_id="project-a",
            user_id="user-a",
            idempotency_key="upload-2",
            request=upload_request(part_size),
        )
        first = b"a" * part_size
        replacement = b"b" * part_size
        await service.upload_part(
            project_id="project-a",
            asset_id=upload.asset_id,
            part_number=1,
            body=first,
            declared_sha256=hashlib.sha256(first).hexdigest(),
        )
        repeated = await service.upload_part(
            project_id="project-a",
            asset_id=upload.asset_id,
            part_number=1,
            body=replacement,
            declared_sha256=hashlib.sha256(replacement).hexdigest(),
        )
        assert repeated.uploaded_bytes == part_size
        assert repository.parts[1].checksum_sha256 == hashlib.sha256(replacement).hexdigest()

        with pytest.raises(AssetError) as checksum_error:
            await service.upload_part(
                project_id="project-a",
                asset_id=upload.asset_id,
                part_number=1,
                body=first,
                declared_sha256="0" * 64,
            )
        assert checksum_error.value.code == "asset_hash_mismatch"

    asyncio.run(scenario())


def test_complete_requires_exact_part_manifest_and_queues_real_processing() -> None:
    async def scenario() -> None:
        body = b"complete-file"
        service, repository, _ = build_service(len(body))
        created = await service.create_upload(
            project_id="project-a",
            user_id="user-a",
            idempotency_key="upload-3",
            request=upload_request(len(body)),
        )
        part = await service.upload_part(
            project_id="project-a",
            asset_id=created.asset_id,
            part_number=1,
            body=body,
            declared_sha256=hashlib.sha256(body).hexdigest(),
        )
        with pytest.raises(AssetError) as mismatch:
            await service.complete_upload(
                project_id="project-a",
                asset_id=created.asset_id,
                request=AssetUploadCompleteRequest(
                    parts=[CompletedPart(part_number=1, etag="wrong")]
                ),
            )
        assert mismatch.value.code == "asset_parts_mismatch"

        result = await service.complete_upload(
            project_id="project-a",
            asset_id=created.asset_id,
            request=AssetUploadCompleteRequest(
                parts=[CompletedPart(part_number=1, etag=part.etag)]
            ),
        )
        assert result.status == "processing"
        assert repository.queued is True

        with pytest.raises(AssetError) as isolated:
            await service.get_asset("project-b", created.asset_id)
        assert isolated.value.code == "asset_not_found"

    asyncio.run(scenario())


def test_all_asset_service_operations_hide_cross_project_asset_state() -> None:
    async def scenario() -> None:
        body = b"cross-project"
        service, repository, _ = build_service(len(body))
        created = await service.create_upload(
            project_id="project-a",
            user_id="user-a",
            idempotency_key="project-scope",
            request=upload_request(len(body)),
        )
        assert repository.asset is not None
        repository.asset.status = "failed"

        async def cancel(project_id, asset_id, *_args, **_kwargs):
            if project_id != "project-a" or asset_id != created.asset_id:
                return None
            return "incoming", "multipart"

        async def retry_processing(project_id, asset_id, *_args, **_kwargs):
            if project_id != "project-a" or asset_id != created.asset_id:
                raise LookupError("asset_not_found")

        async def request_delete(*, project_id, asset_id, **_kwargs):
            if project_id != "project-a" or asset_id != created.asset_id:
                raise LookupError("asset_not_found")
            return []

        async def list_assets(*, project_id, **_kwargs):
            rows = [repository.asset] if project_id == "project-a" else []
            return rows, None

        async def find_import_by_idempotency(project_id, user_id, key):
            del user_id, key
            return repository.asset if project_id == "project-a" else None

        async def create_import(*, asset, job, audit=None):
            del job, audit
            repository.asset = asset
            asset.created_at = datetime.now(UTC)

        repository.cancel = cancel  # type: ignore[attr-defined]
        repository.retry_processing = retry_processing  # type: ignore[attr-defined]
        repository.request_delete = request_delete  # type: ignore[attr-defined]
        repository.list_assets = list_assets  # type: ignore[attr-defined]
        repository.find_import_by_idempotency = find_import_by_idempotency  # type: ignore[attr-defined]
        repository.create_import = create_import  # type: ignore[attr-defined]

        async def assert_not_found(awaitable) -> None:
            with pytest.raises(AssetError) as error:
                await awaitable
            assert error.value.code == "asset_not_found"
            assert error.value.status_code == 404

        await assert_not_found(service.get_asset("project-b", created.asset_id))
        await assert_not_found(
            service.upload_part(
                project_id="project-b",
                asset_id=created.asset_id,
                part_number=1,
                body=body,
                declared_sha256=None,
            )
        )
        await assert_not_found(
            service.complete_upload(
                project_id="project-b",
                asset_id=created.asset_id,
                request=AssetUploadCompleteRequest(
                    parts=[CompletedPart(part_number=1, etag="hidden")]
                ),
            )
        )
        await assert_not_found(service.cancel("project-b", created.asset_id))
        await assert_not_found(service.retry("project-b", created.asset_id))
        await assert_not_found(service.delete("project-b", created.asset_id))
        await assert_not_found(service.download_url("project-b", created.asset_id))

        listed = await service.list_assets(
            project_id="project-b",
            asset_type=None,
            status=None,
            query=None,
            cursor=None,
            limit=30,
        )
        assert listed.items == []

        imported = await service.import_url(
            project_id="project-b",
            user_id="user-a",
            idempotency_key="project-scope",
            request=AssetImportRequest(
                source_url="https://public.example/photo.jpg",
                asset_type="image",
            ),
        )
        assert imported.asset_id != created.asset_id
        assert repository.asset is not None
        assert repository.asset.project_id == "project-b"

    asyncio.run(scenario())


def test_asset_response_redacts_source_url_credentials_query_and_fragment() -> None:
    asset = ContentAsset(
        id="ast-import",
        project_id="project-a",
        asset_type="image",
        status="processing",
        original_filename="photo.jpg",
        source_type="import",
        source_url="https://user:secret@origin.example/photo.jpg?token=one#private",
        final_source_url="https://other:secret@cdn.example/final.jpg?token=two#private",
        created_by="user-a",
        created_at=datetime.now(UTC),
    )

    response = AssetService._asset_response(asset, [])

    assert response.source_url == "https://origin.example/photo.jpg"
    assert response.final_source_url == "https://cdn.example/final.jpg"


def test_asset_metadata_update_is_project_scoped_and_keeps_defaults_separate() -> None:
    async def scenario() -> None:
        service, repository, _ = build_service(4)
        repository.asset = ContentAsset(
            id="ast-metadata",
            project_id="project-a",
            asset_type="image",
            status="ready",
            original_filename="original.jpg",
            source_type="upload",
            created_by="user-a",
            created_at=datetime.now(UTC),
        )

        updated = await service.update_metadata(
            project_id="project-a",
            asset_id="ast-metadata",
            user_id="editor-a",
            request=AssetUpdateRequest(
                title=" Campaign image ",
                default_alt_text=" A product on a desk ",
                caption=" Launch photography ",
                description=" Source selected by the content team. ",
            ),
        )

        assert updated.title == "Campaign image"
        assert updated.default_alt_text == "A product on a desk"
        assert updated.caption == "Launch photography"
        assert updated.description == "Source selected by the content team."
        assert repository.asset.metadata_updated_by == "editor-a"

        with pytest.raises(AssetError) as isolated:
            await service.update_metadata(
                project_id="project-b",
                asset_id="ast-metadata",
                user_id="editor-b",
                request=AssetUpdateRequest(title="Hidden overwrite"),
            )
        assert isolated.value.code == "asset_not_found"
        assert repository.asset.title == "Campaign image"

    asyncio.run(scenario())


def test_download_authorization_requires_ready_project_asset_and_preserves_disposition() -> None:
    async def scenario() -> None:
        service, repository, store = build_service(4)
        repository.asset = ContentAsset(
            id="ast-download",
            project_id="project-a",
            asset_type="image",
            status="ready",
            original_filename='proof "one".jpg',
            mime_type="image/jpeg",
            byte_size=4,
            storage_key="assets/project-a/ast-download/original",
            source_type="upload",
            created_by="user-a",
        )

        before = datetime.now(UTC)
        inline = await service.authorize_download(
            "project-a", "ast-download", disposition="inline"
        )
        await service.authorize_download(
            "project-a", "ast-download", disposition="attachment"
        )
        after = datetime.now(UTC)

        ttl = service.settings.asset_download_url_ttl_seconds
        assert inline.url.startswith("https://downloads.example/")
        assert before.timestamp() + ttl <= inline.expires_at.timestamp()
        assert inline.expires_at.timestamp() <= after.timestamp() + ttl
        assert store.download_calls == [
            (
                "assets/project-a/ast-download/original",
                'proof "one".jpg',
                ttl,
                "inline",
            ),
            (
                "assets/project-a/ast-download/original",
                'proof "one".jpg',
                ttl,
                "attachment",
            ),
        ]

        with pytest.raises(AssetError) as isolated:
            await service.authorize_download(
                "project-b", "ast-download", disposition="inline"
            )
        assert isolated.value.code == "asset_not_found"
        assert isolated.value.status_code == 404

        repository.asset.status = "processing"
        with pytest.raises(AssetError) as not_ready:
            await service.authorize_download(
                "project-a", "ast-download", disposition="inline"
            )
        assert not_ready.value.code == "asset_not_ready"
        assert not_ready.value.status_code == 409
        assert len(store.download_calls) == 2

    asyncio.run(scenario())


def test_download_authorization_resolves_only_ready_project_variant() -> None:
    async def scenario() -> None:
        service, repository, store = build_service(4)
        repository.asset = ContentAsset(
            id="ast-video",
            project_id="project-a",
            asset_type="video",
            status="ready",
            original_filename="launch.final.mov",
            mime_type="video/quicktime",
            byte_size=4,
            storage_key="assets/project-a/ast-video/original",
            source_type="upload",
            created_by="user-a",
        )
        repository.variants = [
            AssetVariant(
                id="variant-poster",
                asset_id="ast-video",
                variant_type="poster",
                transform_version=1,
                format="jpeg",
                storage_key="assets/project-a/ast-video/poster-v1.jpeg",
                content_hash="a" * 64,
                width=1280,
                height=720,
                byte_size=1024,
                status="ready",
            )
        ]

        result = await service.authorize_download(
            "project-a",
            "ast-video",
            disposition="inline",
            variant_type="poster",
        )

        assert result.url.startswith("https://downloads.example/")
        assert store.download_calls == [
            (
                "assets/project-a/ast-video/poster-v1.jpeg",
                "launch.final-poster.jpeg",
                service.settings.asset_download_url_ttl_seconds,
                "inline",
            )
        ]

        repository.variants[0].status = "processing"
        with pytest.raises(AssetError) as processing:
            await service.authorize_download(
                "project-a",
                "ast-video",
                disposition="attachment",
                variant_type="poster",
            )
        assert processing.value.code == "asset_variant_not_found"
        assert processing.value.status_code == 404

        repository.variants = []
        with pytest.raises(AssetError) as missing:
            await service.authorize_download(
                "project-a",
                "ast-video",
                disposition="inline",
                variant_type="poster",
            )
        assert missing.value.code == "asset_variant_not_found"
        assert missing.value.status_code == 404

        with pytest.raises(AssetError) as isolated:
            await service.authorize_download(
                "project-b",
                "ast-video",
                disposition="inline",
                variant_type="poster",
            )
        assert isolated.value.code == "asset_not_found"
        assert isolated.value.status_code == 404
        assert len(store.download_calls) == 1

    asyncio.run(scenario())


def test_complete_is_repeatable_after_provider_race_and_queue_recovery() -> None:
    async def scenario() -> None:
        body = b"repeatable-completion"
        service, repository, store = build_service(len(body))
        created = await service.create_upload(
            project_id="project-a",
            user_id="user-a",
            idempotency_key="upload-completion-race",
            request=upload_request(len(body)),
        )
        part = await service.upload_part(
            project_id="project-a",
            asset_id=created.asset_id,
            part_number=1,
            body=body,
            declared_sha256=hashlib.sha256(body).hexdigest(),
        )
        request = AssetUploadCompleteRequest(
            parts=[CompletedPart(part_number=1, etag=part.etag)]
        )

        store.fail_complete_after_commit = True
        first = await service.complete_upload(
            project_id="project-a", asset_id=created.asset_id, request=request
        )
        assert first.status == "processing"
        assert store.complete_calls == 1
        assert repository.queued is True

        repeated = await service.complete_upload(
            project_id="project-a", asset_id=created.asset_id, request=request
        )
        assert repeated == first
        assert store.complete_calls == 1

        repository.upload.status = "completing"  # type: ignore[union-attr]
        repository.asset.status = "uploaded"  # type: ignore[union-attr]
        repository.queued = False
        recovered = await service.complete_upload(
            project_id="project-a", asset_id=created.asset_id, request=request
        )
        assert recovered.status == "processing"
        assert repository.queued is True
        assert store.complete_calls == 1

    asyncio.run(scenario())


def test_asset_cursor_is_opaque_stable_and_rejects_tampering() -> None:
    created_at = datetime(2026, 8, 9, 10, 30, tzinfo=UTC)
    encoded = _encode_asset_cursor((created_at, "ast_002"))

    assert "2026" not in encoded
    assert _decode_asset_cursor(encoded) == (created_at, "ast_002")
    with pytest.raises(AssetError) as invalid:
        _decode_asset_cursor(encoded[:-2] + "!!")
    assert invalid.value.code == "asset_cursor_invalid"


def dispatcher_asset() -> ContentAsset:
    return ContentAsset(
        id="ast-dispatcher",
        project_id="project-a",
        asset_type="image",
        status="processing",
        original_filename="photo.jpg",
        mime_type="image/jpeg",
        byte_size=4,
        storage_key="assets/project-a/ast-dispatcher/incoming",
        source_type="upload",
        created_by="user-a",
    )


def processed_asset() -> ProcessedAsset:
    return ProcessedAsset(
        detected_mime_type="image/jpeg",
        content_hash=hashlib.sha256(b"body").hexdigest(),
        byte_size=4,
        width=1,
        height=1,
        duration_ms=None,
        storage_key="assets/project-a/ast-dispatcher/original",
        variants=[],
        generated_object_keys=(
            "assets/project-a/ast-dispatcher/original",
            "assets/project-a/ast-dispatcher/thumbnail-v1.webp",
        ),
    )


def test_dispatcher_quarantines_security_failures_and_cleans_partial_outputs(caplog) -> None:
    caplog.set_level(logging.WARNING, logger="app.modules.content.asset_service")

    async def scenario() -> None:
        error = AssetSecurityError(
            "asset_malware_rejected",
            "Malware was detected.",
            quarantined=True,
            generated_object_keys=("partial-a", "partial-b"),
        )
        repository = DispatcherRepository(dispatcher_asset())
        processor = DispatcherProcessor(error)
        dispatcher = AssetProcessingDispatcher(
            repository=repository,
            processor=processor,
            settings=Settings(app_env="test"),
            worker_id="asset-worker-test",
        )

        assert await dispatcher.run_once(limit=1) == 1
        assert processor.store.deleted == ["partial-a", "partial-b"]
        assert repository.failed == [
            {
                "job_id": "job-1",
                "worker_id": "asset-worker-test",
                "code": "asset_malware_rejected",
                "detail": "Malware was detected.",
                "quarantined": True,
                "retryable": False,
            }
        ]

    asyncio.run(scenario())
    record = next(
        item for item in caplog.records if item.message == "Content asset processing rejected"
    )
    assert record.asset_id == "ast-dispatcher"
    assert record.asset_processing_job_id == "job-1"
    assert record.asset_error_code == "asset_malware_rejected"
    assert record.asset_error_retryable is False
    assert record.asset_error_quarantined is True


def test_dispatcher_passes_complete_variant_manifest_and_queues_failed_cleanup(caplog) -> None:
    caplog.set_level(logging.ERROR, logger="app.modules.content.asset_service")

    async def scenario() -> None:
        result = processed_asset()
        repository = DispatcherRepository(dispatcher_asset())
        processor = DispatcherProcessor(result)
        processor.store.fail_delete.add(result.generated_object_keys[1])

        async def fail_complete(**values):
            repository.completed.append(values)
            raise RuntimeError("database unavailable")

        repository.complete_job = fail_complete  # type: ignore[method-assign]
        dispatcher = AssetProcessingDispatcher(
            repository=repository,
            processor=processor,
            settings=Settings(app_env="test"),
            worker_id="asset-worker-test",
        )

        await dispatcher.run_once(limit=1)

        assert repository.completed[0]["generated_object_keys"] == list(
            result.generated_object_keys
        )
        assert repository.completed[0]["variants"] == []
        assert processor.store.deleted == [result.generated_object_keys[0]]
        assert repository.cleanup == [
            {
                "asset_id": "ast-dispatcher",
                "object_keys": [result.generated_object_keys[1]],
                "cleanup_type": "database_commit_failed",
                "max_attempts": Settings(app_env="test").asset_cleanup_max_attempts,
            }
        ]
        assert repository.failed[0]["code"] == "asset_processing_failed"
        assert repository.failed[0]["retryable"] is True

    asyncio.run(scenario())
    record = next(
        item for item in caplog.records if item.message == "Unable to process content asset"
    )
    assert record.asset_id == "ast-dispatcher"
    assert record.asset_processing_job_id == "job-1"


class IngestStore:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.deleted: list[str] = []
        self.fail_delete = False

    async def write_bytes(self, key: str, body: bytes, content_type: str) -> None:
        self.objects[key] = (body, content_type)

    async def delete(self, key: str) -> None:
        if self.fail_delete:
            raise RuntimeError("cleanup unavailable")
        self.objects.pop(key, None)
        self.deleted.append(key)


class IngestRepository:
    def __init__(self) -> None:
        self.assets: dict[str, ContentAsset] = {}
        self.by_key: dict[tuple[str, str, str, str], str] = {}
        self.jobs = []
        self.fail_create: Exception | None = None

    async def find_ingested_by_idempotency(
        self, project_id: str, user_id: str, source_type: str, key: str
    ) -> ContentAsset | None:
        asset_id = self.by_key.get((project_id, user_id, source_type, key))
        return self.assets.get(asset_id) if asset_id else None

    async def create_import(self, *, asset, job, audit=None) -> None:
        del audit
        if self.fail_create is not None:
            raise self.fail_create
        now = datetime.now(UTC)
        asset.created_at = now
        asset.updated_at = now
        self.assets[asset.id] = asset
        self.by_key[
            (asset.project_id, asset.created_by, asset.source_type, asset.idempotency_key)
        ] = asset.id
        self.jobs.append(job)

    async def get_asset_with_variants(self, project_id: str, asset_id: str):
        asset = self.assets.get(asset_id)
        if asset is None or asset.project_id != project_id:
            return None
        return asset, []

    async def reference_counts(self, asset_ids: list[str]):
        return {asset_id: 0 for asset_id in asset_ids}


def build_ingest_service(
    *, maximum_bytes: int = 20 * 1024 * 1024
) -> tuple[AssetService, IngestRepository, IngestStore]:
    repository = IngestRepository()
    store = IngestStore()
    service = AssetService(
        repository=repository,  # type: ignore[arg-type]
        store=store,  # type: ignore[arg-type]
        settings=Settings(app_env="test", asset_image_max_bytes=maximum_bytes),
    )
    return service, repository, store


def test_ingest_bytes_stores_image_and_is_idempotent() -> None:
    async def scenario() -> None:
        service, repository, store = build_ingest_service()
        values = {
            "project_id": "project-a",
            "user_id": "system",
            "idempotency_key": "visual-1",
            "filename": "diagram.png",
            "mime_type": "image/png",
            "content": b"png-image-body",
            "source_type": "ai",
        }

        first = await service.ingest_bytes(**values)
        repeated = await service.ingest_bytes(**values)

        assert repeated.asset_id == first.asset_id
        assert first.status == "processing"
        assert first.source_type == "ai"
        assert len(repository.jobs) == 1
        assert len(store.objects) == 1
        stored_body, stored_mime = next(iter(store.objects.values()))
        assert stored_body == b"png-image-body"
        assert stored_mime == "image/png"

        with pytest.raises(AssetError) as conflict:
            await service.ingest_bytes(**{**values, "content": b"different-image"})
        assert conflict.value.code == "asset_idempotency_conflict"
        assert conflict.value.status_code == 409

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("filename", "mime_type", "content", "source_type", "expected_code"),
    [
        ("image.png", "image/png", b"", "ai", "asset_empty"),
        ("image.jpg", "image/png", b"body", "ai", "asset_mime_mismatch"),
        ("image.png", "image/png", b"body", "import", "asset_source_type_invalid"),
    ],
)
def test_ingest_bytes_rejects_invalid_internal_images(
    filename: str,
    mime_type: str,
    content: bytes,
    source_type: str,
    expected_code: str,
) -> None:
    service, _, _ = build_ingest_service()

    with pytest.raises(AssetError) as error:
        asyncio.run(
            service.ingest_bytes(
                project_id="project-a",
                user_id="system",
                idempotency_key="invalid-visual",
                filename=filename,
                mime_type=mime_type,
                content=content,
                source_type=source_type,
            )
        )

    assert error.value.code == expected_code


def test_ingest_bytes_rejects_images_over_configured_limit() -> None:
    service, _, _ = build_ingest_service(maximum_bytes=1024)

    with pytest.raises(AssetError) as error:
        asyncio.run(
            service.ingest_bytes(
                project_id="project-a",
                user_id="system",
                idempotency_key="large-visual",
                filename="large.webp",
                mime_type="image/webp",
                content=b"x" * 1025,
                source_type="generated",
            )
        )

    assert error.value.code == "asset_too_large"
    assert error.value.details == {"maximum_bytes": 1024}


def test_ingest_bytes_removes_object_when_database_write_fails() -> None:
    async def scenario() -> None:
        service, repository, store = build_ingest_service()
        repository.fail_create = RuntimeError("database unavailable")

        with pytest.raises(RuntimeError, match="database unavailable"):
            await service.ingest_bytes(
                project_id="project-a",
                user_id="system",
                idempotency_key="failed-visual",
                filename="failed.gif",
                mime_type="image/gif",
                content=b"gif-body",
                source_type="generated",
            )

        assert store.objects == {}
        assert len(store.deleted) == 1

    asyncio.run(scenario())


def test_ingest_cleanup_failure_does_not_hide_database_error(caplog) -> None:
    caplog.set_level(logging.WARNING, logger="app.modules.content.asset_service")

    async def scenario() -> None:
        service, repository, store = build_ingest_service()
        repository.fail_create = RuntimeError("database unavailable")
        store.fail_delete = True

        with pytest.raises(RuntimeError, match="database unavailable"):
            await service.ingest_bytes(
                project_id="project-a",
                user_id="system",
                idempotency_key="cleanup-failed-visual",
                filename="failed.jpeg",
                mime_type="image/jpeg",
                content=b"jpeg-body",
                source_type="generated",
            )

    asyncio.run(scenario())
    assert any(
        record.message == "Unable to remove failed ingested asset object"
        for record in caplog.records
    )
