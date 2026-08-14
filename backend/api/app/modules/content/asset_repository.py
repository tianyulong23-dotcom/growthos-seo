from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.content.models import (
    Article,
    ArticleAssetBinding,
    AssetCleanupJob,
    AssetProcessingJob,
    AssetUploadPart,
    AssetUploadSession,
    AssetVariant,
    ContentAuditEvent,
    ContentAsset,
)


@dataclass(frozen=True)
class AssetAuditContext:
    actor_id: str
    effective_role: str
    request_id: str | None
    correlation_id: str | None
    policy_version: str = "content-assets.v1"


class AssetRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    async def find_upload_by_idempotency(
        self, project_id: str, user_id: str, idempotency_key: str
    ) -> tuple[ContentAsset, AssetUploadSession] | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(ContentAsset, AssetUploadSession)
                    .join(AssetUploadSession, AssetUploadSession.asset_id == ContentAsset.id)
                    .where(
                        AssetUploadSession.project_id == project_id,
                        AssetUploadSession.created_by == user_id,
                        AssetUploadSession.idempotency_key == idempotency_key,
                    )
                )
            ).one_or_none()
            return row if row is not None else None

    async def create_upload(
        self,
        *,
        asset: ContentAsset,
        upload: AssetUploadSession,
        audit: AssetAuditContext | None = None,
    ) -> None:
        async with self.sessions() as session, session.begin():
            session.add(asset)
            await session.flush()
            session.add(upload)
            self._add_audit_event(
                session,
                audit=audit,
                project_id=asset.project_id,
                action="asset.upload_initialized",
                target_id=asset.id,
                after_state={"status": asset.status, "source_type": asset.source_type},
            )

    async def get_asset(self, project_id: str, asset_id: str) -> ContentAsset | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(ContentAsset).where(
                    ContentAsset.id == asset_id,
                    ContentAsset.project_id == project_id,
                    ContentAsset.status != "deleted",
                )
            )

    async def list_ready_images(
        self, project_id: str, *, limit: int = 100
    ) -> list[ContentAsset]:
        async with self.sessions() as session:
            return list(
                await session.scalars(
                    select(ContentAsset)
                    .where(
                        ContentAsset.project_id == project_id,
                        ContentAsset.asset_type == "image",
                        ContentAsset.status == "ready",
                        ContentAsset.canonical_asset_id.is_(None),
                    )
                    .order_by(ContentAsset.updated_at.desc(), ContentAsset.id.desc())
                    .limit(max(1, min(limit, 500)))
                )
            )

    async def get_asset_with_variants(
        self, project_id: str, asset_id: str
    ) -> tuple[ContentAsset, list[AssetVariant]] | None:
        async with self.sessions() as session:
            asset = await session.scalar(
                select(ContentAsset).where(
                    ContentAsset.id == asset_id,
                    ContentAsset.project_id == project_id,
                    ContentAsset.status != "deleted",
                )
            )
            if asset is None:
                return None
            variants = list(
                await session.scalars(
                    select(AssetVariant)
                    .where(AssetVariant.asset_id == asset.id)
                    .order_by(AssetVariant.variant_type)
                )
            )
            return asset, variants

    async def get_upload(
        self, project_id: str, asset_id: str
    ) -> tuple[ContentAsset, AssetUploadSession, list[AssetUploadPart]] | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(ContentAsset, AssetUploadSession)
                    .join(AssetUploadSession, AssetUploadSession.asset_id == ContentAsset.id)
                    .where(
                        ContentAsset.id == asset_id,
                        ContentAsset.project_id == project_id,
                    )
                )
            ).one_or_none()
            if row is None:
                return None
            asset, upload = row
            parts = list(
                await session.scalars(
                    select(AssetUploadPart)
                    .where(AssetUploadPart.upload_session_id == upload.id)
                    .order_by(AssetUploadPart.part_number)
                )
            )
            return asset, upload, parts

    async def record_part(
        self,
        *,
        project_id: str,
        asset_id: str,
        part_number: int,
        etag: str,
        byte_size: int,
        checksum_sha256: str,
    ) -> tuple[ContentAsset, AssetUploadSession, AssetUploadPart]:
        async with self.sessions() as session, session.begin():
            row = (
                await session.execute(
                    select(ContentAsset, AssetUploadSession)
                    .join(AssetUploadSession, AssetUploadSession.asset_id == ContentAsset.id)
                    .where(
                        ContentAsset.id == asset_id,
                        ContentAsset.project_id == project_id,
                    )
                    .with_for_update()
                )
            ).one_or_none()
            if row is None:
                raise LookupError("asset_not_found")
            asset, upload = row
            existing = await session.scalar(
                select(AssetUploadPart).where(
                    AssetUploadPart.upload_session_id == upload.id,
                    AssetUploadPart.part_number == part_number,
                )
            )
            if existing is None:
                existing = AssetUploadPart(
                    id=str(uuid4()),
                    upload_session_id=upload.id,
                    part_number=part_number,
                    etag=etag,
                    byte_size=byte_size,
                    checksum_sha256=checksum_sha256,
                )
                session.add(existing)
                upload.uploaded_bytes += byte_size
            elif existing.checksum_sha256 != checksum_sha256:
                upload.uploaded_bytes += byte_size - existing.byte_size
                existing.etag = etag
                existing.byte_size = byte_size
                existing.checksum_sha256 = checksum_sha256
            upload.status = "uploading"
            asset.status = "uploading"
            return asset, upload, existing

    async def mark_upload_completing(self, project_id: str, asset_id: str) -> None:
        async with self.sessions() as session, session.begin():
            row = (
                await session.execute(
                    select(ContentAsset, AssetUploadSession)
                    .join(AssetUploadSession, AssetUploadSession.asset_id == ContentAsset.id)
                    .where(
                        ContentAsset.id == asset_id,
                        ContentAsset.project_id == project_id,
                    )
                    .with_for_update()
                )
            ).one_or_none()
            if row is None:
                raise LookupError("asset_not_found")
            asset, upload = row
            if upload.status == "completed":
                return
            upload.status = "completing"
            asset.status = "uploaded"

    async def queue_processing(
        self,
        *,
        project_id: str,
        asset_id: str,
        max_attempts: int,
        audit: AssetAuditContext | None = None,
    ) -> None:
        async with self.sessions() as session, session.begin():
            row = (
                await session.execute(
                    select(ContentAsset, AssetUploadSession)
                    .join(AssetUploadSession, AssetUploadSession.asset_id == ContentAsset.id)
                    .where(
                        ContentAsset.id == asset_id,
                        ContentAsset.project_id == project_id,
                    )
                    .with_for_update()
                )
            ).one_or_none()
            if row is None:
                raise LookupError("asset_not_found")
            asset, upload = row
            upload.status = "completed"
            upload.completed_at = datetime.now(UTC)
            asset.status = "processing"
            existing = await session.scalar(
                select(AssetProcessingJob).where(
                    AssetProcessingJob.asset_id == asset_id,
                    AssetProcessingJob.status.in_(("queued", "running")),
                )
            )
            if existing is None:
                session.add(
                    AssetProcessingJob(
                        id=str(uuid4()),
                        asset_id=asset_id,
                        status="queued",
                        max_attempts=max_attempts,
                    )
                )
            self._add_audit_event(
                session,
                audit=audit,
                project_id=asset.project_id,
                action="asset.upload_completed",
                target_id=asset.id,
                before_state={"status": "uploaded"},
                after_state={"status": asset.status},
            )

    async def cancel(
        self,
        project_id: str,
        asset_id: str,
        max_cleanup_attempts: int,
        audit: AssetAuditContext | None = None,
    ) -> tuple[str, str] | None:
        async with self.sessions() as session, session.begin():
            row = (
                await session.execute(
                    select(ContentAsset, AssetUploadSession)
                    .join(AssetUploadSession, AssetUploadSession.asset_id == ContentAsset.id)
                    .where(
                        ContentAsset.id == asset_id,
                        ContentAsset.project_id == project_id,
                    )
                    .with_for_update()
                )
            ).one_or_none()
            if row is None:
                return None
            asset, upload = row
            if upload.status in {"cancelled", "expired"}:
                return upload.storage_key, upload.multipart_upload_id
            if asset.status == "ready":
                raise ValueError("asset_already_ready")
            upload.status = "cancelled"
            asset.status = "pending_delete"
            asset.deleted_at = None
            now = datetime.now(UTC)
            jobs = list(
                await session.scalars(
                    select(AssetProcessingJob).where(
                        AssetProcessingJob.asset_id == asset.id,
                        AssetProcessingJob.status.in_(("queued", "running")),
                    )
                )
            )
            for job in jobs:
                job.status = "cancelled"
                job.finished_at = now
            existing_cleanup = await session.scalar(
                select(AssetCleanupJob).where(
                    AssetCleanupJob.asset_id == asset.id,
                    AssetCleanupJob.cleanup_type == "cancelled_upload",
                    AssetCleanupJob.status.in_(("queued", "running")),
                )
            )
            if existing_cleanup is None:
                session.add(
                    AssetCleanupJob(
                        id=str(uuid4()),
                        asset_id=asset.id,
                        cleanup_type="cancelled_upload",
                        object_keys=[upload.storage_key],
                        status="queued",
                        max_attempts=max_cleanup_attempts,
                        available_at=now,
                    )
                )
            self._add_audit_event(
                session,
                audit=audit,
                project_id=asset.project_id,
                action="asset.upload_cancelled",
                target_id=asset.id,
                before_state={"status": "uploading"},
                after_state={"status": asset.status},
            )
            return upload.storage_key, upload.multipart_upload_id

    async def retry_processing(
        self,
        project_id: str,
        asset_id: str,
        max_attempts: int,
        audit: AssetAuditContext | None = None,
    ) -> None:
        async with self.sessions() as session, session.begin():
            asset = await session.scalar(
                select(ContentAsset)
                .where(ContentAsset.id == asset_id, ContentAsset.project_id == project_id)
                .with_for_update()
            )
            if asset is None:
                raise LookupError("asset_not_found")
            if asset.status not in {"failed", "uploaded", "processing"}:
                raise ValueError("asset_not_retryable")
            job = await session.scalar(
                select(AssetProcessingJob)
                .where(AssetProcessingJob.asset_id == asset_id)
                .order_by(AssetProcessingJob.created_at.desc())
            )
            if job is not None and job.status in {"queued", "running"}:
                return
            asset.status = "processing"
            asset.failure_code = None
            asset.failure_detail = None
            session.add(
                AssetProcessingJob(
                    id=str(uuid4()),
                    asset_id=asset_id,
                    status="queued",
                    max_attempts=max_attempts,
                )
            )
            self._add_audit_event(
                session,
                audit=audit,
                project_id=asset.project_id,
                action="asset.processing_retried",
                target_id=asset.id,
                after_state={"status": asset.status},
            )

    async def create_import(
        self,
        *,
        asset: ContentAsset,
        job: AssetProcessingJob,
        audit: AssetAuditContext | None = None,
    ) -> None:
        async with self.sessions() as session, session.begin():
            session.add(asset)
            await session.flush()
            session.add(job)
            self._add_audit_event(
                session,
                audit=audit,
                project_id=asset.project_id,
                action="asset.import_initialized",
                target_id=asset.id,
                after_state={"status": asset.status, "source_type": asset.source_type},
            )

    async def find_import_by_idempotency(
        self, project_id: str, user_id: str, idempotency_key: str
    ) -> ContentAsset | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(ContentAsset).where(
                    ContentAsset.project_id == project_id,
                    ContentAsset.created_by == user_id,
                    ContentAsset.source_type == "import",
                    ContentAsset.idempotency_key == idempotency_key,
                )
            )

    async def find_ingested_by_idempotency(
        self,
        project_id: str,
        user_id: str,
        source_type: str,
        idempotency_key: str,
    ) -> ContentAsset | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(ContentAsset).where(
                    ContentAsset.project_id == project_id,
                    ContentAsset.created_by == user_id,
                    ContentAsset.source_type == source_type,
                    ContentAsset.idempotency_key == idempotency_key,
                )
            )

    async def list_assets(
        self,
        *,
        project_id: str,
        asset_type: str | None,
        status: str | None,
        query: str | None,
        cursor: tuple[datetime, str] | None,
        limit: int,
    ) -> tuple[list[ContentAsset], tuple[datetime, str] | None]:
        async with self.sessions() as session:
            statement = select(ContentAsset).where(
                ContentAsset.project_id == project_id,
                ContentAsset.status != "deleted",
                ContentAsset.canonical_asset_id.is_(None),
            )
            if asset_type:
                statement = statement.where(ContentAsset.asset_type == asset_type)
            if status:
                statement = statement.where(ContentAsset.status == status)
            if query:
                statement = statement.where(
                    ContentAsset.original_filename.ilike(f"%{query.replace('%', '')}%")
                )
            if cursor:
                created_at, asset_id = cursor
                statement = statement.where(
                    or_(
                        ContentAsset.created_at < created_at,
                        (
                            (ContentAsset.created_at == created_at)
                            & (ContentAsset.id < asset_id)
                        ),
                    )
                )
            rows = list(
                await session.scalars(
                    statement.order_by(
                        ContentAsset.created_at.desc(), ContentAsset.id.desc()
                    ).limit(limit + 1)
                )
            )
            next_cursor = (
                (rows[limit - 1].created_at, rows[limit - 1].id)
                if len(rows) > limit
                else None
            )
            return rows[:limit], next_cursor

    async def reference_counts(self, asset_ids: list[str]) -> dict[str, int]:
        if not asset_ids:
            return {}
        async with self.sessions() as session:
            canonical_id = func.coalesce(
                ContentAsset.canonical_asset_id, ContentAsset.id
            )
            rows = await session.execute(
                select(canonical_id, func.count())
                .select_from(ArticleAssetBinding)
                .join(ContentAsset, ContentAsset.id == ArticleAssetBinding.asset_id)
                .where(
                    canonical_id.in_(asset_ids),
                    ArticleAssetBinding.removed_at.is_(None),
                )
                .group_by(canonical_id)
            )
            return {str(asset_id): int(count) for asset_id, count in rows}

    async def update_metadata(
        self,
        *,
        project_id: str,
        asset_id: str,
        values: dict[str, str | None],
        user_id: str,
        audit: AssetAuditContext | None = None,
    ) -> ContentAsset:
        async with self.sessions() as session, session.begin():
            asset = await session.scalar(
                select(ContentAsset)
                .where(
                    ContentAsset.id == asset_id,
                    ContentAsset.project_id == project_id,
                    ContentAsset.status != "deleted",
                )
                .with_for_update()
            )
            if asset is None:
                raise LookupError("asset_not_found")
            if asset.canonical_asset_id:
                asset = await session.scalar(
                    select(ContentAsset)
                    .where(
                        ContentAsset.id == asset.canonical_asset_id,
                        ContentAsset.project_id == project_id,
                        ContentAsset.status != "deleted",
                    )
                    .with_for_update()
                )
                if asset is None:
                    raise LookupError("asset_not_found")
            if asset.status in {"pending_delete", "quarantined"}:
                raise ValueError("asset_metadata_not_editable")
            before = {key: getattr(asset, key) for key in values}
            for key, value in values.items():
                setattr(asset, key, value)
            asset.metadata_updated_by = user_id
            asset.updated_at = datetime.now(UTC)
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                action="asset.metadata_updated",
                target_id=asset.id,
                before_state=before,
                after_state={key: getattr(asset, key) for key in values},
            )
            return asset

    async def update_provider_metadata(
        self,
        *,
        project_id: str,
        asset_id: str,
        provider_metadata: dict[str, object],
        user_id: str,
    ) -> ContentAsset:
        async with self.sessions() as session, session.begin():
            asset = await session.scalar(
                select(ContentAsset)
                .where(
                    ContentAsset.id == asset_id,
                    ContentAsset.project_id == project_id,
                    ContentAsset.status != "deleted",
                )
                .with_for_update()
            )
            if asset is None:
                raise LookupError("asset_not_found")
            if asset.canonical_asset_id:
                asset = await session.scalar(
                    select(ContentAsset)
                    .where(
                        ContentAsset.id == asset.canonical_asset_id,
                        ContentAsset.project_id == project_id,
                        ContentAsset.status != "deleted",
                    )
                    .with_for_update()
                )
                if asset is None:
                    raise LookupError("asset_not_found")
            if asset.status in {"pending_delete", "quarantined"}:
                raise ValueError("asset_metadata_not_editable")
            asset.provider_metadata = {
                **dict(asset.provider_metadata or {}),
                **provider_metadata,
            }
            asset.metadata_updated_by = user_id
            asset.updated_at = datetime.now(UTC)
            return asset

    async def usage(
        self, project_id: str, asset_id: str
    ) -> tuple[ContentAsset, list[tuple[ArticleAssetBinding, Article]]] | None:
        async with self.sessions() as session:
            asset = await session.scalar(
                select(ContentAsset).where(
                    ContentAsset.id == asset_id,
                    ContentAsset.project_id == project_id,
                    ContentAsset.status != "deleted",
                )
            )
            if asset is None:
                return None
            canonical_id = asset.canonical_asset_id or asset.id
            if canonical_id != asset.id:
                asset = await session.scalar(
                    select(ContentAsset).where(
                        ContentAsset.id == canonical_id,
                        ContentAsset.project_id == project_id,
                        ContentAsset.status != "deleted",
                    )
                )
                if asset is None:
                    return None
            family_ids = select(ContentAsset.id).where(
                ContentAsset.project_id == project_id,
                ContentAsset.status != "deleted",
                or_(
                    ContentAsset.id == canonical_id,
                    ContentAsset.canonical_asset_id == canonical_id,
                ),
            )
            rows = list(
                (
                    await session.execute(
                        select(ArticleAssetBinding, Article)
                        .join(Article, Article.id == ArticleAssetBinding.article_id)
                        .where(
                            ArticleAssetBinding.asset_id.in_(family_ids),
                            ArticleAssetBinding.removed_at.is_(None),
                            Article.project_id == project_id,
                        )
                        .order_by(Article.updated_at.desc(), Article.id)
                    )
                ).all()
            )
            return asset, rows

    async def reference_count(self, asset_id: str) -> int:
        async with self.sessions() as session:
            return int(
                await session.scalar(
                    select(func.count())
                    .select_from(ArticleAssetBinding)
                    .where(
                        ArticleAssetBinding.asset_id == asset_id,
                        ArticleAssetBinding.removed_at.is_(None),
                    )
                )
                or 0
            )

    async def request_delete(
        self,
        *,
        project_id: str,
        asset_id: str,
        available_at: datetime,
        max_attempts: int,
        cleanup_type: str = "asset_retention_delete",
        audit: AssetAuditContext | None = None,
    ) -> list[str]:
        async with self.sessions() as session, session.begin():
            asset = await session.scalar(
                select(ContentAsset)
                .where(ContentAsset.id == asset_id, ContentAsset.project_id == project_id)
                .with_for_update()
            )
            if asset is None:
                raise LookupError("asset_not_found")
            canonical_id = asset.canonical_asset_id or asset.id
            family_assets = list(
                await session.scalars(
                    select(ContentAsset)
                    .where(
                        ContentAsset.project_id == project_id,
                        or_(
                            ContentAsset.id == canonical_id,
                            ContentAsset.canonical_asset_id == canonical_id,
                        ),
                    )
                    .with_for_update()
                )
            )
            canonical = next(
                (candidate for candidate in family_assets if candidate.id == canonical_id),
                None,
            )
            if canonical is None:
                raise LookupError("asset_not_found")
            family_ids = [candidate.id for candidate in family_assets]
            bindings = list(
                await session.scalars(
                    select(ArticleAssetBinding).where(
                        ArticleAssetBinding.asset_id.in_(family_ids),
                        ArticleAssetBinding.removed_at.is_(None),
                    )
                )
            )
            if bindings:
                return sorted({binding.article_id for binding in bindings})
            active_assets = [
                candidate for candidate in family_assets if candidate.status != "deleted"
            ]
            if not active_assets:
                return []
            variants_by_asset: dict[str, list[AssetVariant]] = {
                candidate.id: [] for candidate in active_assets
            }
            variants = list(
                await session.scalars(
                    select(AssetVariant).where(
                        AssetVariant.asset_id.in_(variants_by_asset)
                    )
                )
            )
            for variant in variants:
                variants_by_asset[variant.asset_id].append(variant)
            for candidate in active_assets:
                object_keys = sorted(
                    {
                        key
                        for key in (
                            candidate.storage_key,
                            *(
                                variant.storage_key
                                for variant in variants_by_asset[candidate.id]
                            ),
                        )
                        if key
                    }
                )
                previous_status = candidate.status
                candidate.status = "pending_delete"
                candidate.deleted_at = None
                existing = await session.scalar(
                    select(AssetCleanupJob).where(
                        AssetCleanupJob.asset_id == candidate.id,
                        AssetCleanupJob.cleanup_type == cleanup_type,
                        AssetCleanupJob.status.in_(("queued", "running")),
                    )
                )
                if existing is None:
                    session.add(
                        AssetCleanupJob(
                            id=str(uuid4()),
                            asset_id=candidate.id,
                            cleanup_type=cleanup_type,
                            object_keys=object_keys,
                            status="queued",
                            max_attempts=max_attempts,
                            available_at=available_at,
                        )
                    )
                self._add_audit_event(
                    session,
                    audit=audit,
                    project_id=candidate.project_id,
                    action="asset.delete_requested",
                    target_id=candidate.id,
                    before_state={"status": previous_status},
                    after_state={"status": candidate.status},
                )
            return []

    async def queue_object_cleanup(
        self,
        *,
        asset_id: str,
        object_keys: list[str],
        cleanup_type: str,
        max_attempts: int,
        available_at: datetime | None = None,
    ) -> None:
        keys = sorted({key for key in object_keys if key})
        if not keys:
            return
        async with self.sessions() as session, session.begin():
            session.add(
                AssetCleanupJob(
                    id=str(uuid4()),
                    asset_id=asset_id,
                    cleanup_type=cleanup_type,
                    object_keys=keys,
                    status="queued",
                    max_attempts=max_attempts,
                    available_at=available_at or datetime.now(UTC),
                )
            )

    async def claim_jobs(
        self, *, worker_id: str, limit: int, lease_seconds: int
    ) -> list[str]:
        now = datetime.now(UTC)
        async with self.sessions() as session, session.begin():
            jobs = list(
                await session.scalars(
                    select(AssetProcessingJob)
                    .where(
                        AssetProcessingJob.available_at <= now,
                        or_(
                            AssetProcessingJob.status == "queued",
                            (
                                (AssetProcessingJob.status == "running")
                                & (AssetProcessingJob.lease_expires_at < now)
                            ),
                        ),
                    )
                    .order_by(AssetProcessingJob.available_at, AssetProcessingJob.created_at)
                    .with_for_update(skip_locked=True)
                    .limit(limit)
                )
            )
            for job in jobs:
                job.status = "running"
                job.worker_id = worker_id
                job.lease_expires_at = now + timedelta(seconds=lease_seconds)
                job.attempt += 1
                job.started_at = job.started_at or now
            return [job.id for job in jobs]

    async def get_claimed_job(
        self, job_id: str, worker_id: str
    ) -> tuple[AssetProcessingJob, ContentAsset, AssetUploadSession | None] | None:
        async with self.sessions() as session:
            return (
                await session.execute(
                    select(AssetProcessingJob, ContentAsset, AssetUploadSession)
                    .join(ContentAsset, ContentAsset.id == AssetProcessingJob.asset_id)
                    .outerjoin(
                        AssetUploadSession,
                        AssetUploadSession.asset_id == ContentAsset.id,
                    )
                    .where(
                        AssetProcessingJob.id == job_id,
                        AssetProcessingJob.worker_id == worker_id,
                        AssetProcessingJob.status == "running",
                    )
                )
            ).one_or_none()

    async def complete_job(
        self,
        *,
        job_id: str,
        worker_id: str,
        detected_mime_type: str,
        content_hash: str,
        byte_size: int,
        width: int | None,
        height: int | None,
        duration_ms: int | None,
        storage_key: str,
        variants: list[AssetVariant],
        final_source_url: str | None,
        declared_mime_type: str | None,
        generated_object_keys: list[str],
        max_cleanup_attempts: int,
    ) -> str | None:
        async with self.sessions() as session, session.begin():
            job = await session.scalar(
                select(AssetProcessingJob)
                .where(
                    AssetProcessingJob.id == job_id,
                    AssetProcessingJob.worker_id == worker_id,
                    AssetProcessingJob.status == "running",
                )
                .with_for_update()
            )
            if job is None:
                raise LookupError("asset_processing_lease_lost")
            asset = await session.get(ContentAsset, job.asset_id, with_for_update=True)
            if asset is None:
                raise LookupError("asset_not_found")
            await session.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                {"key": f"{asset.project_id}:{content_hash}"},
            )
            duplicate = await session.scalar(
                select(ContentAsset).where(
                    ContentAsset.project_id == asset.project_id,
                    ContentAsset.content_hash == content_hash,
                    ContentAsset.id != asset.id,
                    ContentAsset.status == "ready",
                    ContentAsset.canonical_asset_id.is_(None),
                )
            )
            now = datetime.now(UTC)
            previous_storage_key = asset.storage_key
            if duplicate is not None:
                # Keep the duplicate as a ready alias until orphan cleanup wins.
                # This closes the narrow race where a client saves the upload ID
                # after processing completes but before it observes the canonical ID.
                asset.status = "ready"
                asset.canonical_asset_id = duplicate.id
                asset.deleted_at = None
                asset.detected_mime_type = detected_mime_type
                asset.final_source_url = final_source_url
                asset.mime_type = declared_mime_type or asset.mime_type
                asset.byte_size = byte_size
                asset.ready_at = now
                job.status = "completed"
                job.finished_at = now
                job.error_code = None
                job.error_detail = None
                cleanup_keys = sorted(
                    {
                        *generated_object_keys,
                        *([asset.storage_key] if asset.storage_key else []),
                    }
                )
                if cleanup_keys:
                    session.add(
                        AssetCleanupJob(
                            id=str(uuid4()),
                            asset_id=asset.id,
                            cleanup_type="canonical_duplicate",
                            object_keys=cleanup_keys,
                            status="queued",
                            max_attempts=max_cleanup_attempts,
                            available_at=now,
                        )
                    )
                self._add_audit_event(
                    session,
                    audit=AssetAuditContext(
                        actor_id=worker_id,
                        effective_role="asset_worker",
                        request_id=None,
                        correlation_id=job.id,
                    ),
                    project_id=asset.project_id,
                    action="asset.canonicalized",
                    target_id=asset.id,
                    before_state={"status": "processing"},
                    after_state={
                        "status": asset.status,
                        "canonical_asset_id": duplicate.id,
                    },
                )
                return duplicate.id
            asset.status = "ready"
            asset.detected_mime_type = detected_mime_type
            asset.final_source_url = final_source_url
            asset.mime_type = declared_mime_type or asset.mime_type
            asset.content_hash = content_hash
            asset.byte_size = byte_size
            asset.width = width
            asset.height = height
            asset.duration_ms = duration_ms
            asset.storage_key = storage_key
            asset.ready_at = now
            asset.failure_code = None
            asset.failure_detail = None
            for variant in variants:
                session.add(variant)
            obsolete_keys = sorted(
                {
                    key
                    for key in (previous_storage_key,)
                    if key and key != storage_key and key not in generated_object_keys
                }
            )
            if obsolete_keys:
                session.add(
                    AssetCleanupJob(
                        id=str(uuid4()),
                        asset_id=asset.id,
                        cleanup_type="replaced_source",
                        object_keys=obsolete_keys,
                        status="queued",
                        max_attempts=max_cleanup_attempts,
                        available_at=now,
                    )
                )
            job.status = "completed"
            job.finished_at = now
            job.error_code = None
            job.error_detail = None
            self._add_audit_event(
                session,
                audit=AssetAuditContext(
                    actor_id=worker_id,
                    effective_role="asset_worker",
                    request_id=None,
                    correlation_id=job.id,
                ),
                project_id=asset.project_id,
                action="asset.processing_completed",
                target_id=asset.id,
                before_state={"status": "processing"},
                after_state={
                    "status": asset.status,
                    "content_hash": content_hash,
                },
            )
            return None

    async def fail_job(
        self,
        *,
        job_id: str,
        worker_id: str,
        code: str,
        detail: str,
        quarantined: bool,
        retryable: bool,
    ) -> None:
        async with self.sessions() as session, session.begin():
            job = await session.scalar(
                select(AssetProcessingJob)
                .where(AssetProcessingJob.id == job_id, AssetProcessingJob.worker_id == worker_id)
                .with_for_update()
            )
            if job is None:
                return
            asset = await session.get(ContentAsset, job.asset_id, with_for_update=True)
            if asset is None:
                return
            now = datetime.now(UTC)
            job.error_code = code
            job.error_detail = detail
            job.lease_expires_at = None
            if retryable and job.attempt < job.max_attempts:
                job.status = "queued"
                job.available_at = now + timedelta(seconds=min(60, 2**job.attempt))
            else:
                job.status = "failed"
                job.finished_at = now
                asset.status = "quarantined" if quarantined else "failed"
                asset.failure_code = code
                asset.failure_detail = detail
                self._add_audit_event(
                    session,
                    audit=AssetAuditContext(
                        actor_id=worker_id,
                        effective_role="asset_worker",
                        request_id=None,
                        correlation_id=job.id,
                    ),
                    project_id=asset.project_id,
                    action=(
                        "asset.quarantined" if quarantined else "asset.processing_failed"
                    ),
                    target_id=asset.id,
                    after_state={"status": asset.status, "failure_code": code},
                )

    async def claim_cleanup_jobs(
        self, *, worker_id: str, limit: int, lease_seconds: int
    ) -> list[str]:
        now = datetime.now(UTC)
        async with self.sessions() as session, session.begin():
            jobs = list(
                await session.scalars(
                    select(AssetCleanupJob)
                    .where(
                        AssetCleanupJob.available_at <= now,
                        or_(
                            AssetCleanupJob.status == "queued",
                            (
                                (AssetCleanupJob.status == "running")
                                & (AssetCleanupJob.lease_expires_at < now)
                            ),
                        ),
                    )
                    .order_by(AssetCleanupJob.available_at, AssetCleanupJob.created_at)
                    .with_for_update(skip_locked=True)
                    .limit(limit)
                )
            )
            for job in jobs:
                job.status = "running"
                job.worker_id = worker_id
                job.lease_expires_at = now + timedelta(seconds=lease_seconds)
                job.attempt += 1
            return [job.id for job in jobs]

    async def get_claimed_cleanup_job(
        self, job_id: str, worker_id: str
    ) -> tuple[AssetCleanupJob, ContentAsset, int] | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(AssetCleanupJob, ContentAsset)
                    .join(ContentAsset, ContentAsset.id == AssetCleanupJob.asset_id)
                    .where(
                        AssetCleanupJob.id == job_id,
                        AssetCleanupJob.worker_id == worker_id,
                        AssetCleanupJob.status == "running",
                    )
                )
            ).one_or_none()
            if row is None:
                return None
            job, asset = row
            references = int(
                await session.scalar(
                    select(func.count())
                    .select_from(ArticleAssetBinding)
                    .where(
                        ArticleAssetBinding.asset_id == asset.id,
                        ArticleAssetBinding.removed_at.is_(None),
                    )
                )
                or 0
            )
            return job, asset, references

    async def complete_cleanup_job(
        self, *, job_id: str, worker_id: str, deletion_blocked: bool
    ) -> None:
        async with self.sessions() as session, session.begin():
            job = await session.scalar(
                select(AssetCleanupJob)
                .where(
                    AssetCleanupJob.id == job_id,
                    AssetCleanupJob.worker_id == worker_id,
                    AssetCleanupJob.status == "running",
                )
                .with_for_update()
            )
            if job is None:
                raise LookupError("asset_cleanup_lease_lost")
            asset = await session.get(ContentAsset, job.asset_id, with_for_update=True)
            if asset is None:
                raise LookupError("asset_not_found")
            if job.cleanup_type in {
                "asset_retention_delete",
                "canonical_duplicate",
                "cancelled_upload",
            }:
                deletion_blocked = deletion_blocked or bool(
                    await session.scalar(
                        select(func.count())
                        .select_from(ArticleAssetBinding)
                        .where(
                            ArticleAssetBinding.asset_id == asset.id,
                            ArticleAssetBinding.removed_at.is_(None),
                        )
                    )
                )
            now = datetime.now(UTC)
            job.status = "cancelled" if deletion_blocked else "completed"
            job.finished_at = now
            job.lease_expires_at = None
            if job.cleanup_type in {"asset_retention_delete", "cancelled_upload"}:
                if deletion_blocked:
                    if (
                        job.cleanup_type == "asset_retention_delete"
                        and asset.status == "pending_delete"
                    ):
                        asset.status = "ready"
                else:
                    asset.status = "deleted"
                    asset.deleted_at = now
            self._add_audit_event(
                session,
                audit=AssetAuditContext(
                    actor_id=worker_id,
                    effective_role="asset_worker",
                    request_id=None,
                    correlation_id=job.id,
                ),
                project_id=asset.project_id,
                action=("asset.cleanup_blocked" if deletion_blocked else "asset.cleanup_completed"),
                target_id=asset.id,
                after_state={"status": asset.status, "cleanup_type": job.cleanup_type},
            )

    async def fail_cleanup_job(
        self, *, job_id: str, worker_id: str, code: str, detail: str
    ) -> None:
        async with self.sessions() as session, session.begin():
            job = await session.scalar(
                select(AssetCleanupJob)
                .where(
                    AssetCleanupJob.id == job_id,
                    AssetCleanupJob.worker_id == worker_id,
                )
                .with_for_update()
            )
            if job is None:
                return
            now = datetime.now(UTC)
            job.error_code = code
            job.error_detail = detail
            job.lease_expires_at = None
            if job.attempt < job.max_attempts:
                job.status = "queued"
                job.available_at = now + timedelta(seconds=min(300, 2**job.attempt))
            else:
                job.status = "failed"
                job.finished_at = now

    async def record_rejection(
        self,
        *,
        project_id: str,
        target_id: str,
        action: str,
        reason: str,
        audit: AssetAuditContext,
    ) -> None:
        async with self.sessions() as session, session.begin():
            self._add_audit_event(
                session,
                audit=audit,
                project_id=project_id,
                action=action,
                target_id=target_id,
                reason=reason,
            )

    @staticmethod
    def _add_audit_event(
        session: AsyncSession,
        *,
        audit: AssetAuditContext | None,
        project_id: str,
        action: str,
        target_id: str,
        before_state: dict | None = None,
        after_state: dict | None = None,
        reason: str | None = None,
    ) -> None:
        if audit is None:
            return
        session.add(
            ContentAuditEvent(
                id=str(uuid4()),
                project_id=project_id,
                actor_id=audit.actor_id,
                effective_role=audit.effective_role,
                action=action,
                target_type="content_asset",
                target_id=target_id,
                before_state=before_state,
                after_state=after_state,
                reason=reason,
                policy_version=audit.policy_version,
                request_id=audit.request_id,
                correlation_id=audit.correlation_id,
            )
        )
