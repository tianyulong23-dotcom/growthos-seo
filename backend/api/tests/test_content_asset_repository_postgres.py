import asyncio
import io
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from PIL import Image
from sqlalchemy import delete, func, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.content.asset_repository import AssetAuditContext, AssetRepository
from app.modules.content.asset_schemas import (
    AssetImportRequest,
    AssetUpdateRequest,
    AssetUploadCreateRequest,
)
from app.modules.content.asset_security import AssetProcessor, ProcessedAsset
from app.modules.content.asset_service import (
    AssetProcessingDispatcher,
    AssetService,
)
from app.core.config import Settings
from app.modules.content.models import (
    Article,
    ArticleAssetBinding,
    AssetCleanupJob,
    AssetProcessingJob,
    AssetUploadSession,
    AssetVariant,
    ContentAsset,
    ContentAuditEvent,
)
from app.modules.content.object_storage import AssetObjectHead, UploadedPart
from app.modules.projects.models import Project


class ConcurrentAssetStore:
    def __init__(self) -> None:
        self.created: list[tuple[str, str]] = []
        self.aborted: list[tuple[str, str]] = []
        self.parts: dict[tuple[str, int], bytes] = {}
        self.completed: set[str] = set()

    async def create_multipart_upload(self, key: str, content_type: str) -> str:
        upload_id = f"multipart-{uuid4().hex}"
        self.created.append((key, upload_id))
        await asyncio.sleep(0)
        return upload_id

    async def abort_multipart_upload(self, key: str, upload_id: str) -> None:
        self.aborted.append((key, upload_id))

    async def upload_part(
        self, key: str, upload_id: str, part_number: int, body: bytes
    ) -> UploadedPart:
        del upload_id
        self.parts[(key, part_number)] = body
        return UploadedPart(part_number, f"etag-{part_number}", len(body))

    async def head(self, key: str) -> AssetObjectHead:
        from app.modules.content.object_storage import AssetObjectNotFoundError

        if key not in self.completed:
            raise AssetObjectNotFoundError("missing")
        size = sum(
            len(body) for (stored_key, _), body in self.parts.items() if stored_key == key
        )
        return AssetObjectHead(size, "image/jpeg", "complete-etag")

    async def complete_multipart_upload(
        self, key: str, upload_id: str, parts: list[UploadedPart]
    ) -> AssetObjectHead:
        del upload_id
        assert [part.part_number for part in parts] == sorted(
            number for stored_key, number in self.parts if stored_key == key
        )
        self.completed.add(key)
        await asyncio.sleep(0)
        return await self.head(key)


class ProcessedImageAssetStore:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.writes: dict[str, tuple[bytes, str]] = {}

    async def download_file(self, key: str, path: str, max_bytes: int) -> int:
        assert key.endswith("/incoming")
        assert len(self.body) <= max_bytes
        Path(path).write_bytes(self.body)
        return len(self.body)

    async def write_bytes(self, key: str, body: bytes, content_type: str) -> None:
        self.writes[key] = (body, content_type)

    async def delete(self, key: str) -> None:
        self.writes.pop(key, None)


class FailingCleanupStore:
    async def delete(self, key: str) -> None:
        raise RuntimeError(f"cannot delete {key}")


class CompletedImportProcessor:
    def __init__(self, result: ProcessedAsset) -> None:
        self.result = result
        self.store = FailingCleanupStore()

    async def process(self, asset: ContentAsset) -> ProcessedAsset:
        del asset
        return self.result


class CommitFailingAssetRepository(AssetRepository):
    async def complete_job(self, **_values):
        raise RuntimeError("database commit failed")


def asset_test_database_url() -> str:
    value = os.getenv("CONTENT_WORKFLOW_TEST_DATABASE_URL", "")
    if not value:
        pytest.skip("CONTENT_WORKFLOW_TEST_DATABASE_URL is not configured")
    if make_url(value).database != "seo_content_stage2_test":
        pytest.fail("Asset integration tests may only use seo_content_stage2_test")
    return value


def create_asset_test_engine():
    return create_async_engine(
        asset_test_database_url(),
        pool_pre_ping=True,
        connect_args={
            "server_settings": {
                "search_path": "public, platform, crawling, audit",
            }
        },
    )


def project(project_id: str) -> Project:
    return Project(
        id=project_id,
        organization_id="asset-test-org",
        name="Asset repository test",
        domain=f"{project_id}.example.test",
        country="US",
        language="en",
    )


def asset(
    asset_id: str,
    project_id: str,
    *,
    status: str = "ready",
    content_hash: str | None = None,
    storage_key: str | None = None,
    created_at: datetime | None = None,
) -> ContentAsset:
    return ContentAsset(
        id=asset_id,
        project_id=project_id,
        asset_type="image",
        status=status,
        original_filename=f"{asset_id}.jpg",
        mime_type="image/jpeg",
        detected_mime_type="image/jpeg" if status == "ready" else None,
        byte_size=128,
        content_hash=content_hash,
        storage_key=storage_key or f"assets/{project_id}/{asset_id}/original",
        source_type="upload",
        created_by="asset-test-user",
        created_at=created_at or datetime.now(UTC),
        ready_at=datetime.now(UTC) if status == "ready" else None,
    )


def processing_job(asset_id: str, *, max_attempts: int = 3) -> AssetProcessingJob:
    return AssetProcessingJob(
        id=f"job-{uuid4().hex}",
        asset_id=asset_id,
        status="queued",
        max_attempts=max_attempts,
    )


def audit_context(request_id: str = "request-asset-test") -> AssetAuditContext:
    return AssetAuditContext(
        actor_id="user-asset-test",
        effective_role="content_editor|site_owner",
        request_id=request_id,
        correlation_id="correlation-asset-test",
    )


async def add_project(
    sessions: async_sessionmaker[AsyncSession], project_id: str
) -> None:
    async with sessions() as session, session.begin():
        session.add(project(project_id))


async def reset_asset_test_projects(
    sessions: async_sessionmaker[AsyncSession],
) -> None:
    async with sessions() as session, session.begin():
        await session.execute(
            delete(Project).where(Project.organization_id == "asset-test-org")
        )


async def add_article(
    sessions: async_sessionmaker[AsyncSession], project_id: str, article_id: str
) -> None:
    async with sessions() as session, session.begin():
        session.add(
            Article(
                id=article_id,
                organization_id="asset-test-org",
                project_id=project_id,
                primary_keyword="asset repository integration",
                status="completed",
            )
        )


def test_asset_cursor_is_stable_for_equal_timestamps_and_project_scoped() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        project_a, project_b = f"prj-{uuid4().hex}", f"prj-{uuid4().hex}"
        asset_prefix = uuid4().hex
        asset_ids = [f"ast-{asset_prefix}-{suffix}" for suffix in ("004", "003", "002", "001")]
        other_asset_id = f"ast-{uuid4().hex}"
        timestamp = datetime(2026, 8, 9, 12, 0, tzinfo=UTC)
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_a)
            await add_project(sessions, project_b)
            async with sessions() as session, session.begin():
                session.add_all(
                    [asset(asset_id, project_a, created_at=timestamp) for asset_id in asset_ids]
                    + [asset(other_asset_id, project_b, created_at=timestamp)]
                )

            first, cursor = await repository.list_assets(
                project_id=project_a,
                asset_type=None,
                status=None,
                query=None,
                cursor=None,
                limit=2,
            )
            assert [row.id for row in first] == asset_ids[:2]
            assert cursor == (timestamp, asset_ids[1])

            second, next_cursor = await repository.list_assets(
                project_id=project_a,
                asset_type=None,
                status=None,
                query=None,
                cursor=cursor,
                limit=2,
            )
            assert [row.id for row in second] == asset_ids[2:]
            assert next_cursor is None
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_processing_and_cleanup_leases_are_reclaimed_after_expiry() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        project_id = f"prj-{uuid4().hex}"
        asset_id = f"ast-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            async with sessions() as session, session.begin():
                row = asset(asset_id, project_id, status="processing")
                session.add(row)
                await session.flush()
                session.add(processing_job(asset_id))

            first = await repository.claim_jobs(
                worker_id="worker-a", limit=1, lease_seconds=30
            )
            assert len(first) == 1
            assert await repository.claim_jobs(
                worker_id="worker-b", limit=1, lease_seconds=30
            ) == []
            async with sessions() as session, session.begin():
                await session.execute(
                    update(AssetProcessingJob)
                    .where(AssetProcessingJob.id == first[0])
                    .values(lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
                )
            reclaimed = await repository.claim_jobs(
                worker_id="worker-b", limit=1, lease_seconds=30
            )
            assert reclaimed == first
            async with sessions() as session:
                claimed = await session.get(AssetProcessingJob, first[0])
                assert claimed is not None
                assert claimed.worker_id == "worker-b"
                assert claimed.attempt == 2

            cleanup = AssetCleanupJob(
                id=f"cleanup-{uuid4().hex}",
                asset_id=asset_id,
                cleanup_type="database_commit_failed",
                object_keys=["asset/generated"],
                status="queued",
                max_attempts=4,
            )
            async with sessions() as session, session.begin():
                session.add(cleanup)
            first_cleanup = await repository.claim_cleanup_jobs(
                worker_id="cleanup-a", limit=1, lease_seconds=30
            )
            async with sessions() as session, session.begin():
                await session.execute(
                    update(AssetCleanupJob)
                    .where(AssetCleanupJob.id == first_cleanup[0])
                    .values(lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
                )
            reclaimed_cleanup = await repository.claim_cleanup_jobs(
                worker_id="cleanup-b", limit=1, lease_seconds=30
            )
            assert reclaimed_cleanup == first_cleanup
            async with sessions() as session:
                claimed_cleanup = await session.get(AssetCleanupJob, first_cleanup[0])
                assert claimed_cleanup is not None
                assert claimed_cleanup.worker_id == "cleanup-b"
                assert claimed_cleanup.attempt == 2
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_upload_and_import_idempotency_are_serialized_under_concurrency() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        store = ConcurrentAssetStore()
        service = AssetService(
            repository=repository,
            store=store,  # type: ignore[arg-type]
            settings=Settings(app_env="test"),
        )
        project_id = f"prj-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            upload_request = AssetUploadCreateRequest(
                filename="concurrent.jpg",
                byte_size=128,
                declared_mime_type="image/jpeg",
                asset_type="image",
            )
            uploads = await asyncio.gather(
                *[
                    service.create_upload(
                        project_id=project_id,
                        user_id="user-concurrent",
                        idempotency_key="same-upload-key",
                        request=upload_request,
                        audit=audit_context(f"upload-request-{index}"),
                    )
                    for index in range(2)
                ]
            )
            assert uploads[0].asset_id == uploads[1].asset_id
            assert uploads[0].upload_id == uploads[1].upload_id
            assert len(store.created) == 2
            assert len(store.aborted) == 1

            import_request = AssetImportRequest(
                source_url="https://assets.example.test/document.pdf",
                asset_type="file",
                filename="document.pdf",
            )
            imports = await asyncio.gather(
                *[
                    service.import_url(
                        project_id=project_id,
                        user_id="user-concurrent",
                        idempotency_key="same-import-key",
                        request=import_request,
                        audit=audit_context(f"import-request-{index}"),
                    )
                    for index in range(2)
                ]
            )
            assert imports[0].asset_id == imports[1].asset_id
            async with sessions() as session:
                assert (
                    await session.scalar(
                        select(func.count())
                        .select_from(ContentAsset)
                        .where(ContentAsset.project_id == project_id)
                    )
                ) == 2
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_all_asset_repository_operations_are_project_scoped() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        project_a, project_b = f"prj-{uuid4().hex}", f"prj-{uuid4().hex}"
        asset_id = f"ast-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_a)
            await add_project(sessions, project_b)
            await repository.create_upload(
                asset=asset(asset_id, project_a, status="uploading"),
                upload=AssetUploadSession(
                    id=f"upl-{uuid4().hex}",
                    asset_id=asset_id,
                    project_id=project_a,
                    status="uploading",
                    multipart_upload_id=f"multipart-{uuid4().hex}",
                    storage_key=f"assets/{project_a}/{asset_id}/incoming",
                    expected_size=4,
                    part_size=4,
                    uploaded_bytes=0,
                    idempotency_key="project-scope-upload",
                    request_hash="d" * 64,
                    created_by="project-scope-user",
                    expires_at=datetime.now(UTC) + timedelta(hours=1),
                ),
            )

            assert await repository.get_asset(project_b, asset_id) is None
            assert await repository.get_asset_with_variants(project_b, asset_id) is None
            assert await repository.get_upload(project_b, asset_id) is None
            assert (
                await repository.find_upload_by_idempotency(
                    project_b, "project-scope-user", "project-scope-upload"
                )
                is None
            )
            with pytest.raises(LookupError, match="asset_not_found"):
                await repository.record_part(
                    project_id=project_b,
                    asset_id=asset_id,
                    part_number=1,
                    etag="etag-1",
                    byte_size=4,
                    checksum_sha256="e" * 64,
                )
            with pytest.raises(LookupError, match="asset_not_found"):
                await repository.mark_upload_completing(project_b, asset_id)
            with pytest.raises(LookupError, match="asset_not_found"):
                await repository.queue_processing(
                    project_id=project_b,
                    asset_id=asset_id,
                    max_attempts=3,
                )
            assert await repository.cancel(project_b, asset_id, 3) is None
            with pytest.raises(LookupError, match="asset_not_found"):
                await repository.retry_processing(project_b, asset_id, 3)
            with pytest.raises(LookupError, match="asset_not_found"):
                await repository.request_delete(
                    project_id=project_b,
                    asset_id=asset_id,
                    available_at=datetime.now(UTC),
                    max_attempts=3,
                )
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_concurrent_upload_completion_creates_one_active_processing_job() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        store = ConcurrentAssetStore()
        service = AssetService(
            repository=repository,
            store=store,  # type: ignore[arg-type]
            settings=Settings(app_env="test", asset_upload_part_size=5 * 1024 * 1024),
        )
        project_id = f"prj-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            body = b"jpeg"
            created = await service.create_upload(
                project_id=project_id,
                user_id="complete-user",
                idempotency_key="concurrent-complete",
                request=AssetUploadCreateRequest(
                    filename="complete.jpg",
                    byte_size=len(body),
                    declared_mime_type="image/jpeg",
                    asset_type="image",
                ),
            )
            part = await service.upload_part(
                project_id=project_id,
                asset_id=created.asset_id,
                part_number=1,
                body=body,
                declared_sha256=None,
            )
            from app.modules.content.asset_schemas import (
                AssetUploadCompleteRequest,
                CompletedPart,
            )

            request = AssetUploadCompleteRequest(
                parts=[CompletedPart(part_number=1, etag=part.etag)]
            )
            results = await asyncio.gather(
                *[
                    service.complete_upload(
                        project_id=project_id,
                        asset_id=created.asset_id,
                        request=request,
                    )
                    for _ in range(2)
                ]
            )
            assert [result.status for result in results] == ["processing", "processing"]
            async with sessions() as session:
                active_jobs = int(
                    await session.scalar(
                        select(func.count())
                        .select_from(AssetProcessingJob)
                        .where(
                            AssetProcessingJob.asset_id == created.asset_id,
                            AssetProcessingJob.status.in_(("queued", "running")),
                        )
                    )
                    or 0
                )
                assert active_jobs == 1
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_delete_checks_current_and_immutable_version_bindings() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        project_id = f"prj-{uuid4().hex}"
        article_id = f"art-{uuid4().hex}"
        current_asset_id = f"ast-{uuid4().hex}"
        version_asset_id = f"ast-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            await add_article(sessions, project_id, article_id)
            async with sessions() as session, session.begin():
                session.add_all(
                    [asset(current_asset_id, project_id), asset(version_asset_id, project_id)]
                )
                await session.flush()
                session.add_all(
                    [
                        ArticleAssetBinding(
                            id=f"binding-{uuid4().hex}",
                            article_id=article_id,
                            version_number=None,
                            node_id="image-current",
                            asset_id=current_asset_id,
                            binding_role="image",
                        ),
                        ArticleAssetBinding(
                            id=f"binding-{uuid4().hex}",
                            article_id=article_id,
                            version_number=3,
                            node_id="image-version",
                            asset_id=version_asset_id,
                            binding_role="image",
                        ),
                    ]
                )

            for asset_id in (current_asset_id, version_asset_id):
                references = await repository.request_delete(
                    project_id=project_id,
                    asset_id=asset_id,
                    available_at=datetime.now(UTC),
                    max_attempts=5,
                    audit=audit_context(),
                )
                assert references == [article_id]
                async with sessions() as session:
                    unchanged = await session.get(ContentAsset, asset_id)
                    assert unchanged is not None and unchanged.status == "ready"
                    jobs = list(
                        await session.scalars(
                            select(AssetCleanupJob).where(
                                AssetCleanupJob.asset_id == asset_id
                            )
                        )
                    )
                    assert jobs == []
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_metadata_and_usage_are_persisted_audited_and_project_scoped() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        service = AssetService(
            repository=repository,
            store=ConcurrentAssetStore(),  # type: ignore[arg-type]
            settings=Settings(app_env="test"),
        )
        project_a, project_b = f"prj-{uuid4().hex}", f"prj-{uuid4().hex}"
        article_id = f"art-{uuid4().hex}"
        asset_id = f"ast-{uuid4().hex}"
        other_asset_id = f"ast-{uuid4().hex}"
        removed_at = datetime.now(UTC)
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_a)
            await add_project(sessions, project_b)
            await add_article(sessions, project_a, article_id)
            async with sessions() as session, session.begin():
                session.add_all(
                    [asset(asset_id, project_a), asset(other_asset_id, project_b)]
                )
                await session.flush()
                session.add_all(
                    [
                        ArticleAssetBinding(
                            id=f"binding-{uuid4().hex}",
                            article_id=article_id,
                            version_number=None,
                            node_id="image-current",
                            asset_id=asset_id,
                            binding_role="image",
                        ),
                        ArticleAssetBinding(
                            id=f"binding-{uuid4().hex}",
                            article_id=article_id,
                            version_number=4,
                            node_id="gallery-version",
                            item_id="gallery-item-2",
                            asset_id=asset_id,
                            binding_role="gallery_item",
                        ),
                        ArticleAssetBinding(
                            id=f"binding-{uuid4().hex}",
                            article_id=article_id,
                            version_number=2,
                            node_id="removed-poster",
                            asset_id=asset_id,
                            binding_role="poster",
                            removed_at=removed_at,
                        ),
                    ]
                )

            metadata_audit = audit_context("request-metadata-update")
            updated = await service.update_metadata(
                project_id=project_a,
                asset_id=asset_id,
                user_id="metadata-editor",
                request=AssetUpdateRequest(
                    title="Launch image",
                    default_alt_text="A launch team reviewing the product",
                    caption="Launch review",
                    description="Primary launch article image.",
                ),
                audit=metadata_audit,
            )
            assert updated.title == "Launch image"
            assert updated.default_alt_text == "A launch team reviewing the product"
            assert updated.caption == "Launch review"
            assert updated.description == "Primary launch article image."
            assert updated.active_reference_count == 2

            with pytest.raises(LookupError, match="asset_not_found"):
                await repository.update_metadata(
                    project_id=project_b,
                    asset_id=asset_id,
                    values={"title": "Cross-project overwrite"},
                    user_id="metadata-editor",
                    audit=metadata_audit,
                )

            counts = await repository.reference_counts([asset_id, other_asset_id])
            assert counts == {asset_id: 2}

            usage = await service.usage(project_a, asset_id)
            assert usage.active_reference_count == 2
            assert usage.article_count == 1
            assert len(usage.items) == 1
            item = usage.items[0]
            assert item.article_id == article_id
            assert item.current_reference_count == 1
            assert item.version_reference_count == 1
            assert item.binding_roles == ["gallery_item", "image"]
            assert item.node_ids == ["gallery-version", "image-current"]
            assert item.version_numbers == [4]
            assert await repository.usage(project_b, asset_id) is None

            references = await repository.request_delete(
                project_id=project_a,
                asset_id=asset_id,
                available_at=datetime.now(UTC),
                max_attempts=5,
                audit=audit_context("request-delete-referenced"),
            )
            assert references == [article_id]

            async with sessions() as session:
                persisted = await session.get(ContentAsset, asset_id)
                assert persisted is not None
                assert persisted.title == "Launch image"
                assert persisted.default_alt_text == (
                    "A launch team reviewing the product"
                )
                assert persisted.caption == "Launch review"
                assert persisted.description == "Primary launch article image."
                assert persisted.metadata_updated_by == "metadata-editor"
                assert persisted.status == "ready"
                assert (
                    await session.scalar(
                        select(func.count())
                        .select_from(AssetCleanupJob)
                        .where(AssetCleanupJob.asset_id == asset_id)
                    )
                ) == 0
                event = await session.scalar(
                    select(ContentAuditEvent).where(
                        ContentAuditEvent.target_id == asset_id,
                        ContentAuditEvent.action == "asset.metadata_updated",
                    )
                )
                assert event is not None
                assert event.before_state == {
                    "title": None,
                    "default_alt_text": None,
                    "caption": None,
                    "description": None,
                }
                assert event.after_state == {
                    "title": "Launch image",
                    "default_alt_text": "A launch team reviewing the product",
                    "caption": "Launch review",
                    "description": "Primary launch article image.",
                }
                assert event.actor_id == "user-asset-test"
                assert event.effective_role == "content_editor|site_owner"
                assert event.request_id == "request-metadata-update"
                assert event.correlation_id == "correlation-asset-test"
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_retention_cleanup_waits_and_blocked_delete_restores_only_ready_asset() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        project_id = f"prj-{uuid4().hex}"
        asset_id = f"ast-{uuid4().hex}"
        article_id = f"art-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            await add_article(sessions, project_id, article_id)
            async with sessions() as session, session.begin():
                session.add(asset(asset_id, project_id))
                await session.flush()
                session.add(
                    ArticleAssetBinding(
                        id=f"binding-{uuid4().hex}",
                        article_id=article_id,
                        version_number=1,
                        node_id="stale-version-reference",
                        asset_id=asset_id,
                        binding_role="image",
                    )
                )
            available_at = datetime.now(UTC) + timedelta(hours=1)
            async with sessions() as session, session.begin():
                stored_asset = await session.get(ContentAsset, asset_id)
                assert stored_asset is not None
                stored_asset.status = "pending_delete"
                session.add(
                    AssetCleanupJob(
                        id=f"cleanup-{uuid4().hex}",
                        asset_id=asset_id,
                        cleanup_type="asset_retention_delete",
                        object_keys=[stored_asset.storage_key],
                        status="queued",
                        max_attempts=7,
                        available_at=available_at,
                    )
                )
            assert await repository.claim_cleanup_jobs(
                worker_id="cleanup-worker", limit=10, lease_seconds=30
            ) == []

            async with sessions() as session, session.begin():
                cleanup = await session.scalar(
                    select(AssetCleanupJob).where(AssetCleanupJob.asset_id == asset_id)
                )
                assert cleanup is not None and cleanup.max_attempts == 7
                cleanup.available_at = datetime.now(UTC) - timedelta(seconds=1)

            claimed = await repository.claim_cleanup_jobs(
                worker_id="cleanup-worker", limit=10, lease_seconds=30
            )
            assert len(claimed) == 1
            row = await repository.get_claimed_cleanup_job(
                claimed[0], "cleanup-worker"
            )
            assert row is not None and row[2] == 1
            await repository.complete_cleanup_job(
                job_id=claimed[0],
                worker_id="cleanup-worker",
                deletion_blocked=False,
            )
            async with sessions() as session:
                restored = await session.get(ContentAsset, asset_id)
                cleanup = await session.get(AssetCleanupJob, claimed[0])
                assert restored is not None and restored.status == "ready"
                assert cleanup is not None and cleanup.status == "cancelled"
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_processing_and_cleanup_retries_back_off_and_stop_at_max_attempts() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        project_id = f"prj-{uuid4().hex}"
        asset_id = f"ast-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            async with sessions() as session, session.begin():
                row = asset(asset_id, project_id, status="processing")
                session.add(row)
                await session.flush()
                session.add(processing_job(asset_id, max_attempts=2))

            processing_id = (
                await repository.claim_jobs(
                    worker_id="processing-retry", limit=1, lease_seconds=30
                )
            )[0]
            before_failure = datetime.now(UTC)
            await repository.fail_job(
                job_id=processing_id,
                worker_id="processing-retry",
                code="asset_scanner_unavailable",
                detail="scanner unavailable",
                quarantined=False,
                retryable=True,
            )
            async with sessions() as session, session.begin():
                job = await session.get(AssetProcessingJob, processing_id)
                assert job is not None and job.status == "queued"
                assert job.available_at >= before_failure + timedelta(seconds=2)
                job.available_at = datetime.now(UTC) - timedelta(seconds=1)

            assert await repository.claim_jobs(
                worker_id="processing-retry", limit=1, lease_seconds=30
            ) == [processing_id]
            await repository.fail_job(
                job_id=processing_id,
                worker_id="processing-retry",
                code="asset_scanner_unavailable",
                detail="scanner unavailable",
                quarantined=False,
                retryable=True,
            )
            async with sessions() as session:
                job = await session.get(AssetProcessingJob, processing_id)
                failed_asset = await session.get(ContentAsset, asset_id)
                assert job is not None and job.status == "failed" and job.attempt == 2
                assert failed_asset is not None and failed_asset.status == "failed"

            cleanup_id = f"cleanup-{uuid4().hex}"
            async with sessions() as session, session.begin():
                session.add(
                    AssetCleanupJob(
                        id=cleanup_id,
                        asset_id=asset_id,
                        cleanup_type="database_commit_failed",
                        object_keys=["generated/orphan"],
                        status="queued",
                        max_attempts=2,
                    )
                )
            assert await repository.claim_cleanup_jobs(
                worker_id="cleanup-retry", limit=1, lease_seconds=30
            ) == [cleanup_id]
            cleanup_before_failure = datetime.now(UTC)
            await repository.fail_cleanup_job(
                job_id=cleanup_id,
                worker_id="cleanup-retry",
                code="asset_cleanup_failed",
                detail="storage unavailable",
            )
            async with sessions() as session, session.begin():
                cleanup = await session.get(AssetCleanupJob, cleanup_id)
                assert cleanup is not None and cleanup.status == "queued"
                assert cleanup.available_at >= cleanup_before_failure + timedelta(seconds=2)
                cleanup.available_at = datetime.now(UTC) - timedelta(seconds=1)
            assert await repository.claim_cleanup_jobs(
                worker_id="cleanup-retry", limit=1, lease_seconds=30
            ) == [cleanup_id]
            await repository.fail_cleanup_job(
                job_id=cleanup_id,
                worker_id="cleanup-retry",
                code="asset_cleanup_failed",
                detail="storage unavailable",
            )
            async with sessions() as session:
                cleanup = await session.get(AssetCleanupJob, cleanup_id)
                assert cleanup is not None and cleanup.status == "failed"
                assert cleanup.attempt == 2 and cleanup.finished_at is not None
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_cancel_cleanup_deletes_asset_and_all_reads_become_not_found() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        project_id = f"prj-{uuid4().hex}"
        asset_id = f"ast-{uuid4().hex}"
        upload_id = f"upl-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            await repository.create_upload(
                asset=asset(asset_id, project_id, status="uploading"),
                upload=AssetUploadSession(
                    id=upload_id,
                    asset_id=asset_id,
                    project_id=project_id,
                    status="uploading",
                    multipart_upload_id=f"multipart-{uuid4().hex}",
                    storage_key=f"assets/{project_id}/{asset_id}/incoming",
                    expected_size=128,
                    part_size=5 * 1024 * 1024,
                    uploaded_bytes=0,
                    idempotency_key=f"cancel-{uuid4().hex}",
                    request_hash="c" * 64,
                    created_by="user-cancel",
                    expires_at=datetime.now(UTC) + timedelta(hours=1),
                ),
                audit=audit_context(),
            )
            cancelled = await repository.cancel(
                project_id,
                asset_id,
                max_cleanup_attempts=4,
                audit=audit_context(),
            )
            assert cancelled is not None
            cleanup_id = (
                await repository.claim_cleanup_jobs(
                    worker_id="cleanup-cancel", limit=1, lease_seconds=30
                )
            )[0]
            await repository.complete_cleanup_job(
                job_id=cleanup_id,
                worker_id="cleanup-cancel",
                deletion_blocked=False,
            )
            assert await repository.get_asset(project_id, asset_id) is None
            assert await repository.get_asset_with_variants(project_id, asset_id) is None
            async with sessions() as session:
                deleted_asset = await session.get(ContentAsset, asset_id)
                assert deleted_asset is not None and deleted_asset.status == "deleted"
                assert deleted_asset.deleted_at is not None
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_binding_trigger_rejects_pending_delete_and_cross_project_assets() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        project_a, project_b = f"prj-{uuid4().hex}", f"prj-{uuid4().hex}"
        article_id = f"art-{uuid4().hex}"
        pending_id = f"ast-{uuid4().hex}"
        cross_project_id = f"ast-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_a)
            await add_project(sessions, project_b)
            await add_article(sessions, project_a, article_id)
            async with sessions() as session, session.begin():
                session.add_all(
                    [
                        asset(pending_id, project_a, status="pending_delete"),
                        asset(cross_project_id, project_b),
                    ]
                )

            for target_id, error_code in (
                (pending_id, "article_asset_binding_asset_not_ready"),
                (cross_project_id, "article_asset_binding_cross_project"),
            ):
                async with sessions() as session:
                    with pytest.raises(DBAPIError, match=error_code):
                        async with session.begin():
                            session.add(
                                ArticleAssetBinding(
                                    id=f"binding-{uuid4().hex}",
                                    article_id=article_id,
                                    version_number=None,
                                    node_id=f"node-{uuid4().hex}",
                                    asset_id=target_id,
                                    binding_role="image",
                                )
                            )
                await session.rollback()
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_project_scoped_hash_deduplication_is_serialized_and_audited() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        project_a, project_b = f"prj-{uuid4().hex}", f"prj-{uuid4().hex}"
        canonical_id = f"ast-{uuid4().hex}"
        duplicate_id = f"ast-{uuid4().hex}"
        other_project_id = f"ast-{uuid4().hex}"
        metadata_request_id = f"request-alias-metadata-update-{uuid4().hex}"
        content_hash = "a" * 64
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_a)
            await add_project(sessions, project_b)
            async with sessions() as session, session.begin():
                rows = [
                    asset(canonical_id, project_a, status="processing"),
                    asset(duplicate_id, project_a, status="processing"),
                    asset(other_project_id, project_b, status="processing"),
                ]
                jobs = [processing_job(row.id) for row in rows]
                session.add_all(rows)
                await session.flush()
                session.add_all(jobs)

            claimed_a = await repository.claim_jobs(
                worker_id="worker-a", limit=2, lease_seconds=60
            )
            claimed_b = await repository.claim_jobs(
                worker_id="worker-b", limit=1, lease_seconds=60
            )
            assert len(claimed_a) == 2 and len(claimed_b) == 1
            async with sessions() as session:
                claimed_jobs = {
                    row.id: row.asset_id
                    for row in await session.scalars(
                        select(AssetProcessingJob).where(
                            AssetProcessingJob.id.in_([*claimed_a, *claimed_b])
                        )
                    )
                }

            async def complete(job_id: str, worker_id: str, asset_id: str):
                variant = AssetVariant(
                    id=f"variant-{uuid4().hex}",
                    asset_id=asset_id,
                    variant_type="original",
                    transform_version=1,
                    format="jpeg",
                    storage_key=f"generated/{asset_id}/original",
                    content_hash=content_hash,
                    width=640,
                    height=480,
                    byte_size=128,
                    status="ready",
                )
                return await repository.complete_job(
                    job_id=job_id,
                    worker_id=worker_id,
                    detected_mime_type="image/jpeg",
                    content_hash=content_hash,
                    byte_size=128,
                    width=640,
                    height=480,
                    duration_ms=None,
                    storage_key=f"generated/{asset_id}/original",
                    variants=[variant],
                    final_source_url=None,
                    declared_mime_type="image/jpeg",
                    generated_object_keys=[variant.storage_key],
                    max_cleanup_attempts=9,
                )

            same_project_results = await asyncio.gather(
                *[
                    complete(job_id, "worker-a", claimed_jobs[job_id])
                    for job_id in claimed_a
                ]
            )
            assert same_project_results.count(None) == 1
            canonical_result = next(value for value in same_project_results if value)
            assert canonical_result in {canonical_id, duplicate_id}
            await complete(
                claimed_b[0], "worker-b", claimed_jobs[claimed_b[0]]
            )

            async with sessions() as session:
                project_a_assets = list(
                    await session.scalars(
                        select(ContentAsset).where(ContentAsset.project_id == project_a)
                    )
                )
                assert [row.status for row in project_a_assets].count("ready") == 2
                aliases = [row for row in project_a_assets if row.canonical_asset_id]
                assert len(aliases) == 1
                duplicate = aliases[0]
                ready = next(
                    row
                    for row in project_a_assets
                    if row.status == "ready" and row.canonical_asset_id is None
                )
                assert duplicate.status == "ready"
                assert duplicate.canonical_asset_id == ready.id
                cleanup = await session.scalar(
                    select(AssetCleanupJob).where(
                        AssetCleanupJob.asset_id == duplicate.id,
                        AssetCleanupJob.cleanup_type == "canonical_duplicate",
                    )
                )
                assert cleanup is not None and cleanup.max_attempts == 9
                cross_project = await session.get(ContentAsset, other_project_id)
                assert cross_project is not None and cross_project.status == "ready"
                assert cross_project.content_hash == content_hash
                actions = set(
                    await session.scalars(
                        select(ContentAuditEvent.action).where(
                            ContentAuditEvent.target_id.in_(
                                [canonical_id, duplicate_id, other_project_id]
                            )
                        )
                    )
                )
                assert "asset.processing_completed" in actions
                assert "asset.canonicalized" in actions

                alias_id = duplicate.id
                ready_id = ready.id

            service = AssetService(
                repository=repository,
                store=ConcurrentAssetStore(),  # type: ignore[arg-type]
                settings=Settings(app_env="test"),
            )
            listed = await service.list_assets(
                project_id=project_a,
                asset_type=None,
                status=None,
                query=None,
                cursor=None,
                limit=30,
            )
            assert [item.asset_id for item in listed.items] == [ready_id]

            updated = await service.update_metadata(
                project_id=project_a,
                asset_id=alias_id,
                user_id="metadata-editor",
                request=AssetUpdateRequest(
                    title="Canonical launch image",
                    default_alt_text="A launch image shared by duplicate uploads",
                ),
                audit=audit_context(metadata_request_id),
            )
            assert updated.asset_id == ready_id
            assert updated.title == "Canonical launch image"

            resolved = await service.get_asset(project_a, alias_id)
            assert resolved.asset_id == ready_id
            assert resolved.title == "Canonical launch image"

            async with sessions() as session:
                alias = await session.get(ContentAsset, alias_id)
                canonical = await session.get(ContentAsset, ready_id)
                assert alias is not None and alias.title is None
                assert canonical is not None
                assert canonical.title == "Canonical launch image"
                event = await session.scalar(
                    select(ContentAuditEvent).where(
                        ContentAuditEvent.action == "asset.metadata_updated",
                        ContentAuditEvent.project_id == project_a,
                        ContentAuditEvent.request_id == metadata_request_id,
                    )
                )
                assert event is not None and event.target_id == ready_id
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_real_image_processor_variants_complete_in_postgres() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        project_id = f"prj-{uuid4().hex}"
        asset_id = f"ast-{uuid4().hex}"
        body = io.BytesIO()
        Image.new("RGB", (1889, 1573), color=(36, 105, 152)).save(body, format="PNG")
        store = ProcessedImageAssetStore(body.getvalue())
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            async with sessions() as session, session.begin():
                session.add(
                    ContentAsset(
                        id=asset_id,
                        project_id=project_id,
                        asset_type="image",
                        status="processing",
                        original_filename="acceptance-image.png",
                        mime_type="image/png",
                        byte_size=len(body.getvalue()),
                        storage_key=f"assets/{project_id}/{asset_id}/incoming",
                        source_type="upload",
                        created_by="asset-test-user",
                    )
                )
                await session.flush()
                session.add(processing_job(asset_id, max_attempts=1))

            dispatcher = AssetProcessingDispatcher(
                repository=repository,
                processor=AssetProcessor(Settings(app_env="test"), store),  # type: ignore[arg-type]
                settings=Settings(app_env="test"),
                worker_id="real-image-worker",
            )
            assert await dispatcher.run_once(limit=1) >= 1

            async with sessions() as session:
                persisted = await session.get(ContentAsset, asset_id)
                variants = list(
                    await session.scalars(
                        select(AssetVariant)
                        .where(AssetVariant.asset_id == asset_id)
                        .order_by(AssetVariant.variant_type)
                    )
                )
                job = await session.scalar(
                    select(AssetProcessingJob).where(
                        AssetProcessingJob.asset_id == asset_id
                    )
                )
                assert persisted is not None
                assert persisted.status == "ready"
                assert persisted.detected_mime_type == "image/png"
                assert (persisted.width, persisted.height) == (1889, 1573)
                assert persisted.content_hash is not None
                assert [variant.variant_type for variant in variants] == [
                    "original",
                    "thumbnail",
                    "webp",
                ]
                assert job is not None and job.status == "completed"
                assert set(store.writes) == {
                    f"assets/{project_id}/{asset_id}/original",
                    f"assets/{project_id}/{asset_id}/thumbnail-v1.webp",
                    f"assets/{project_id}/{asset_id}/webp-v1.webp",
                }
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_import_completion_persists_final_url_redacts_response_and_clears_retry_error() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        service = AssetService(
            repository=repository,
            store=ConcurrentAssetStore(),  # type: ignore[arg-type]
            settings=Settings(app_env="test"),
        )
        project_id = f"prj-{uuid4().hex}"
        asset_id = f"ast-{uuid4().hex}"
        source_url = "https://source-user:secret@origin.example/file.jpg?token=one#private"
        final_url = "https://cdn-user:secret@cdn.example/final.jpg?token=two#private"
        job_id = f"job-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            async with sessions() as session, session.begin():
                imported = asset(asset_id, project_id, status="processing")
                imported.source_type = "import"
                imported.source_url = source_url
                imported.storage_key = None
                session.add(imported)
                await session.flush()
                session.add(
                    AssetProcessingJob(
                        id=job_id,
                        asset_id=asset_id,
                        status="running",
                        worker_id="import-worker",
                        attempt=1,
                        max_attempts=3,
                        error_code="asset_processing_failed",
                        error_detail="Previous retry failed.",
                    )
                )

            await repository.complete_job(
                job_id=job_id,
                worker_id="import-worker",
                detected_mime_type="image/jpeg",
                content_hash="7" * 64,
                byte_size=128,
                width=640,
                height=480,
                duration_ms=None,
                storage_key=f"assets/{project_id}/{asset_id}/original",
                variants=[],
                final_source_url=final_url,
                declared_mime_type="image/jpeg",
                generated_object_keys=[],
                max_cleanup_attempts=3,
            )

            async with sessions() as session:
                persisted = await session.get(ContentAsset, asset_id)
                completed_job = await session.get(AssetProcessingJob, job_id)
                assert persisted is not None
                assert persisted.source_url == source_url
                assert persisted.final_source_url == final_url
                assert completed_job is not None
                assert completed_job.status == "completed"
                assert completed_job.error_code is None
                assert completed_job.error_detail is None

            response = await service.get_asset(project_id, asset_id)
            assert response.source_url == "https://origin.example/file.jpg"
            assert response.final_source_url == "https://cdn.example/final.jpg"
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_database_commit_failure_persists_cleanup_for_generated_objects() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = CommitFailingAssetRepository(sessions)
        project_id = f"prj-{uuid4().hex}"
        asset_id = f"ast-{uuid4().hex}"
        generated_key = f"assets/{project_id}/{asset_id}/generated"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            async with sessions() as session, session.begin():
                session.add(asset(asset_id, project_id, status="processing"))
                await session.flush()
                session.add(processing_job(asset_id, max_attempts=1))

            dispatcher = AssetProcessingDispatcher(
                repository=repository,
                processor=CompletedImportProcessor(
                    ProcessedAsset(
                        detected_mime_type="image/jpeg",
                        content_hash="8" * 64,
                        byte_size=128,
                        width=640,
                        height=480,
                        duration_ms=None,
                        storage_key=generated_key,
                        variants=[],
                        generated_object_keys=(generated_key,),
                    )
                ),  # type: ignore[arg-type]
                settings=Settings(app_env="test", asset_cleanup_max_attempts=7),
                worker_id="commit-failure-worker",
            )
            assert await dispatcher.run_once(limit=1) == 2

            async with sessions() as session:
                cleanup = await session.scalar(
                    select(AssetCleanupJob).where(
                        AssetCleanupJob.asset_id == asset_id,
                        AssetCleanupJob.cleanup_type == "database_commit_failed",
                    )
                )
                failed_asset = await session.get(ContentAsset, asset_id)
                assert cleanup is not None
                assert cleanup.object_keys == [generated_key]
                assert cleanup.max_attempts == 7
                assert cleanup.status == "queued"
                assert cleanup.attempt == 1
                assert cleanup.error_code == "asset_cleanup_failed"
                assert failed_asset is not None and failed_asset.status == "failed"
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_canonical_alias_binding_blocks_cleanup_without_pending_delete_limbo() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        project_id = f"prj-{uuid4().hex}"
        article_id = f"art-{uuid4().hex}"
        canonical_id = f"ast-{uuid4().hex}"
        alias_id = f"ast-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            await add_article(sessions, project_id, article_id)
            async with sessions() as session, session.begin():
                canonical = asset(canonical_id, project_id, content_hash="f" * 64)
                alias = asset(alias_id, project_id)
                alias.canonical_asset_id = canonical_id
                session.add_all([canonical, alias])
                await session.flush()
                session.add_all(
                    [
                        ArticleAssetBinding(
                            id=f"binding-{uuid4().hex}",
                            article_id=article_id,
                            version_number=None,
                            node_id="image-alias",
                            asset_id=alias_id,
                            binding_role="image",
                        ),
                        AssetCleanupJob(
                            id=f"cleanup-{uuid4().hex}",
                            asset_id=alias_id,
                            cleanup_type="canonical_duplicate",
                            object_keys=[f"generated/{alias_id}/original"],
                            status="queued",
                            max_attempts=3,
                        ),
                    ]
                )

            cleanup_id = (
                await repository.claim_cleanup_jobs(
                    worker_id="canonical-cleanup", limit=1, lease_seconds=30
                )
            )[0]
            row = await repository.get_claimed_cleanup_job(
                cleanup_id, "canonical-cleanup"
            )
            assert row is not None and row[2] == 1
            await repository.complete_cleanup_job(
                job_id=cleanup_id,
                worker_id="canonical-cleanup",
                deletion_blocked=False,
            )
            async with sessions() as session:
                alias = await session.get(ContentAsset, alias_id)
                cleanup = await session.get(AssetCleanupJob, cleanup_id)
                assert alias is not None
                assert alias.status == "ready"
                assert alias.canonical_asset_id == canonical_id
                assert cleanup is not None and cleanup.status == "cancelled"
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_canonical_alias_usage_and_delete_resolve_the_whole_asset_family() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        service = AssetService(
            repository=repository,
            store=ConcurrentAssetStore(),  # type: ignore[arg-type]
            settings=Settings(app_env="test"),
        )
        project_id = f"prj-{uuid4().hex}"
        article_id = f"art-{uuid4().hex}"
        canonical_id = f"ast-{uuid4().hex}"
        alias_id = f"ast-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            await add_article(sessions, project_id, article_id)
            async with sessions() as session, session.begin():
                canonical = asset(canonical_id, project_id, content_hash="e" * 64)
                alias = asset(alias_id, project_id)
                alias.canonical_asset_id = canonical_id
                session.add_all([canonical, alias])
                await session.flush()
                session.add(
                    ArticleAssetBinding(
                        id=f"binding-{uuid4().hex}",
                        article_id=article_id,
                        version_number=7,
                        node_id="gallery-canonical",
                        item_id="gallery-item-canonical",
                        asset_id=canonical_id,
                        binding_role="gallery_item",
                    )
                )

            usage = await service.usage(project_id, alias_id)
            assert usage.asset_id == canonical_id
            assert usage.active_reference_count == 1
            assert usage.article_count == 1
            assert usage.items[0].article_id == article_id
            assert usage.items[0].binding_roles == ["gallery_item"]
            assert usage.items[0].node_ids == ["gallery-canonical"]
            assert usage.items[0].version_numbers == [7]
            assert await repository.reference_counts([canonical_id]) == {
                canonical_id: 1
            }

            references = await repository.request_delete(
                project_id=project_id,
                asset_id=alias_id,
                available_at=datetime.now(UTC),
                max_attempts=5,
                audit=audit_context("request-delete-through-alias"),
            )
            assert references == [article_id]
            async with sessions() as session:
                canonical = await session.get(ContentAsset, canonical_id)
                alias = await session.get(ContentAsset, alias_id)
                assert canonical is not None and canonical.status == "ready"
                assert alias is not None and alias.status == "ready"
                assert list(
                    await session.scalars(
                        select(AssetCleanupJob).where(
                            AssetCleanupJob.asset_id.in_([canonical_id, alias_id]),
                            AssetCleanupJob.cleanup_type == "asset_retention_delete",
                        )
                    )
                ) == []
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_unbound_canonical_alias_remains_resolvable_after_object_cleanup() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        project_id = f"prj-{uuid4().hex}"
        canonical_id = f"ast-{uuid4().hex}"
        alias_id = f"ast-{uuid4().hex}"
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            async with sessions() as session, session.begin():
                canonical = asset(canonical_id, project_id, content_hash="f" * 64)
                alias = asset(alias_id, project_id)
                alias.canonical_asset_id = canonical_id
                session.add_all([canonical, alias])
                await session.flush()
                session.add(
                    AssetCleanupJob(
                        id=f"cleanup-{uuid4().hex}",
                        asset_id=alias_id,
                        cleanup_type="canonical_duplicate",
                        object_keys=[f"generated/{alias_id}/original"],
                        status="queued",
                        max_attempts=3,
                    )
                )

            cleanup_id = (
                await repository.claim_cleanup_jobs(
                    worker_id="canonical-cleanup", limit=1, lease_seconds=30
                )
            )[0]
            await repository.complete_cleanup_job(
                job_id=cleanup_id,
                worker_id="canonical-cleanup",
                deletion_blocked=False,
            )
            async with sessions() as session:
                alias = await session.get(ContentAsset, alias_id)
                cleanup = await session.get(AssetCleanupJob, cleanup_id)
                assert alias is not None
                assert alias.status == "ready"
                assert alias.canonical_asset_id == canonical_id
                assert alias.deleted_at is None
                assert cleanup is not None and cleanup.status == "completed"
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_audit_events_are_append_only_and_outlive_source_rows() -> None:
    async def scenario() -> None:
        engine = create_asset_test_engine()
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repository = AssetRepository(sessions)
        project_id = f"prj-{uuid4().hex}"
        asset_id = f"ast-{uuid4().hex}"
        upload_id = f"upl-{uuid4().hex}"
        now = datetime.now(UTC)
        try:
            await reset_asset_test_projects(sessions)
            await add_project(sessions, project_id)
            await repository.create_upload(
                asset=asset(asset_id, project_id, status="uploading"),
                upload=AssetUploadSession(
                    id=upload_id,
                    asset_id=asset_id,
                    project_id=project_id,
                    status="initiated",
                    multipart_upload_id="multipart-audit-test",
                    storage_key=f"assets/{project_id}/{asset_id}/incoming",
                    expected_size=128,
                    part_size=5 * 1024 * 1024,
                    idempotency_key=f"idempotency-{uuid4().hex}",
                    request_hash="b" * 64,
                    created_by="user-asset-test",
                    expires_at=now + timedelta(hours=1),
                ),
                audit=audit_context("request-audit-preserved"),
            )
            async with sessions() as session:
                event = await session.scalar(
                    select(ContentAuditEvent).where(
                        ContentAuditEvent.target_id == asset_id
                    )
                )
                assert event is not None
                assert event.actor_id == "user-asset-test"
                assert event.effective_role == "content_editor|site_owner"
                assert event.request_id == "request-audit-preserved"
                assert event.correlation_id == "correlation-asset-test"
                event_id = event.id

            async with sessions() as session:
                with pytest.raises(DBAPIError, match="append-only"):
                    async with session.begin():
                        await session.execute(
                            update(ContentAuditEvent)
                            .where(ContentAuditEvent.id == event_id)
                            .values(reason="mutated")
                        )
                await session.rollback()
                with pytest.raises(DBAPIError, match="append-only"):
                    async with session.begin():
                        await session.execute(
                            delete(ContentAuditEvent).where(
                                ContentAuditEvent.id == event_id
                            )
                        )
                await session.rollback()

            async with sessions() as session, session.begin():
                await session.execute(delete(Project).where(Project.id == project_id))
            async with sessions() as session:
                preserved = await session.get(ContentAuditEvent, event_id)
                assert preserved is not None
                assert preserved.project_id == project_id
                assert preserved.target_id == asset_id
        finally:
            await engine.dispose()

    asyncio.run(scenario())
