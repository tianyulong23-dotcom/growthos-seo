from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any
from uuid import uuid4

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.content.document import extract_asset_manifest
from app.modules.content.models import (
    Article,
    ArticleAutosave,
    ArticlePreviewSnapshot,
    ArticlePublication,
    ArticleReviewDecision,
    ArticleReviewTask,
    ArticleRun,
    ArticleVersion,
    ContentAsset,
    ContentAuditEvent,
    PublicationAssetCheckpoint,
    PublicationAssetMapping,
    PublicationTarget,
)
from app.modules.content.repository import ContentAuditContext


class PublicationIdempotencyConflictError(Exception):
    pass


class PublicationDeferredError(Exception):
    """Leave the publication leased for recovery after transient contention."""

    pass


@dataclass(frozen=True)
class PublicationExecutionContext:
    publication: ArticlePublication
    article: Article
    version: ArticleVersion
    target: PublicationTarget
    checkpoints: list[PublicationAssetCheckpoint]
    assets: dict[str, ContentAsset]


def canonical_hash(value: object) -> str:
    return sha256(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            default=str,
        ).encode("utf-8")
    ).hexdigest()


class PublicationRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    @staticmethod
    def _audit(
        session: AsyncSession,
        *,
        audit: ContentAuditContext,
        project_id: str,
        article_id: str | None,
        action: str,
        target_type: str,
        target_id: str,
        before: dict[str, Any],
        after: dict[str, Any],
        reason: str,
        version_number: int | None = None,
    ) -> None:
        session.add(
            ContentAuditEvent(
                id=str(uuid4()),
                project_id=project_id,
                article_id=article_id,
                actor_id=audit.actor_id,
                effective_role=audit.effective_role,
                action=action,
                target_type=target_type,
                target_id=target_id,
                version_number=version_number,
                before_state=before,
                after_state=after,
                policy_version=audit.policy_version,
                request_id=audit.request_id,
                correlation_id=audit.correlation_id,
                reason=reason,
            )
        )

    async def upsert_wordpress_target(
        self,
        organization_id: str,
        project_id: str,
        *,
        site_url: str,
        verified: bool,
        capabilities: dict[str, bool],
    ) -> PublicationTarget:
        async with self.sessions() as session:
            target = await session.scalar(
                select(PublicationTarget)
                .where(
                    PublicationTarget.organization_id == organization_id,
                    PublicationTarget.project_id == project_id,
                    PublicationTarget.adapter_type == "wordpress",
                )
                .with_for_update()
            )
            status = "verified" if verified else "disconnected"
            if target is None:
                target = PublicationTarget(
                    id=str(uuid4()),
                    organization_id=organization_id,
                    project_id=project_id,
                    adapter_type="wordpress",
                    site_url=site_url.rstrip("/"),
                    capabilities_json=dict(capabilities),
                    credential_reference=f"wordpress-project:{project_id}",
                    status=status,
                )
                session.add(target)
            else:
                target.site_url = site_url.rstrip("/")
                target.status = status
                target.capabilities_json = dict(capabilities)
            await session.commit()
            await session.refresh(target)
            return target

    async def list_targets(
        self, organization_id: str, project_id: str
    ) -> list[PublicationTarget]:
        async with self.sessions() as session:
            return list(
                await session.scalars(
                    select(PublicationTarget)
                    .where(
                        PublicationTarget.organization_id == organization_id,
                        PublicationTarget.project_id == project_id,
                    )
                    .order_by(PublicationTarget.created_at)
                )
            )

    async def create_preview(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        *,
        source_type: str,
        version_number: int | None,
        autosave_id: str | None,
        target_id: str | None,
        created_by: str,
        audience: str,
        token_hash: str,
        expires_at: datetime,
        audit: ContentAuditContext,
    ) -> ArticlePreviewSnapshot:
        async with self.sessions() as session:
            article = await session.scalar(
                select(Article).where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
            )
            if article is None:
                raise LookupError("article_not_found")
            if target_id is not None:
                target = await session.scalar(
                    select(PublicationTarget.id).where(
                        PublicationTarget.id == target_id,
                        PublicationTarget.organization_id == organization_id,
                        PublicationTarget.project_id == project_id,
                        PublicationTarget.status == "verified",
                    )
                )
                if target is None:
                    raise LookupError("publication_target_not_found")

            source_version_id = None
            source_version_number = None
            if source_type == "version":
                source = await session.scalar(
                    select(ArticleVersion).where(
                        ArticleVersion.article_id == article_id,
                        ArticleVersion.version_number == version_number,
                    )
                )
                if source is None:
                    raise LookupError("article_version_not_found")
                source_version_id = source.id
                source_version_number = source.version_number
                document = dict(source.document_snapshot or {})
                metadata = dict(source.metadata_snapshot or {})
                manifest = list(source.asset_manifest or [])
            else:
                autosave = await session.scalar(
                    select(ArticleAutosave).where(
                        ArticleAutosave.id == autosave_id,
                        ArticleAutosave.article_id == article_id,
                    )
                )
                if autosave is None or autosave.expires_at <= datetime.now(UTC):
                    raise LookupError("article_autosave_not_found")
                if audience == "creator" and autosave.user_id != created_by:
                    raise LookupError("article_autosave_not_found")
                document = dict(autosave.document_snapshot or {})
                metadata = dict(autosave.metadata_snapshot or {})
                manifest = extract_asset_manifest(document)

            await self._validate_assets(session, project_id, manifest)
            snapshot = ArticlePreviewSnapshot(
                id=str(uuid4()),
                article_id=article_id,
                organization_id=organization_id,
                project_id=project_id,
                source_type=source_type,
                source_version_id=source_version_id,
                source_version_number=source_version_number,
                autosave_id=autosave_id,
                document_snapshot=document,
                metadata_snapshot=metadata,
                asset_manifest=manifest,
                target_id=target_id,
                created_by=created_by,
                audience=audience,
                token_hash=token_hash,
                expires_at=expires_at,
            )
            session.add(snapshot)
            self._audit(
                session,
                audit=audit,
                project_id=project_id,
                article_id=article_id,
                action="article.preview_created",
                target_type="article_preview_snapshot",
                target_id=snapshot.id,
                before={},
                after={
                    "source_type": source_type,
                    "source_version_number": source_version_number,
                    "autosave_id": autosave_id,
                    "target_id": target_id,
                    "audience": audience,
                    "expires_at": expires_at.isoformat(),
                },
                reason="preview_requested",
                version_number=source_version_number,
            )
            await session.commit()
            await session.refresh(snapshot)
            return snapshot

    async def revoke_preview(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        preview_id: str,
        *,
        revoked_by: str,
        audit: ContentAuditContext,
    ) -> ArticlePreviewSnapshot:
        async with self.sessions() as session:
            snapshot = await session.scalar(
                select(ArticlePreviewSnapshot)
                .where(
                    ArticlePreviewSnapshot.id == preview_id,
                    ArticlePreviewSnapshot.article_id == article_id,
                    ArticlePreviewSnapshot.organization_id == organization_id,
                    ArticlePreviewSnapshot.project_id == project_id,
                )
                .with_for_update()
            )
            if snapshot is None:
                raise LookupError("article_preview_not_found")
            if snapshot.revoked_at is None:
                snapshot.revoked_at = datetime.now(UTC)
                snapshot.revoked_by = revoked_by
                self._audit(
                    session,
                    audit=audit,
                    project_id=project_id,
                    article_id=article_id,
                    action="article.preview_revoked",
                    target_type="article_preview_snapshot",
                    target_id=snapshot.id,
                    before={"revoked_at": None},
                    after={"revoked_at": snapshot.revoked_at.isoformat()},
                    reason="preview_revoked",
                    version_number=snapshot.source_version_number,
                )
            await session.commit()
            await session.refresh(snapshot)
            return snapshot

    async def resolve_preview(
        self, preview_id: str, token_hash: str
    ) -> tuple[ArticlePreviewSnapshot, dict[str, ContentAsset]]:
        async with self.sessions() as session:
            snapshot = await session.scalar(
                select(ArticlePreviewSnapshot).where(
                    ArticlePreviewSnapshot.id == preview_id,
                    ArticlePreviewSnapshot.token_hash == token_hash,
                )
            )
            if snapshot is None:
                raise LookupError("article_preview_not_found")
            if snapshot.revoked_at is not None or snapshot.expires_at <= datetime.now(UTC):
                raise ValueError("article_preview_expired")
            asset_ids = {str(item["asset_id"]) for item in snapshot.asset_manifest}
            assets = {
                row.id: row
                for row in await session.scalars(
                    select(ContentAsset).where(ContentAsset.id.in_(asset_ids))
                )
            } if asset_ids else {}
            if set(assets) != asset_ids or any(row.status != "ready" for row in assets.values()):
                raise ValueError("article_preview_asset_unavailable")
            return snapshot, assets

    async def create_publication(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        *,
        version_number: int,
        target_id: str,
        mode: str,
        schedule_at_utc: datetime | None,
        source_timezone: str,
        idempotency_key: str,
        request_hash: str,
        payload_hash: str,
        asset_manifest_hash: str,
        created_by: str,
        audit: ContentAuditContext,
        parent_publication_id: str | None = None,
    ) -> ArticlePublication:
        try:
            async with self.sessions() as session:
                article = await session.scalar(
                    select(Article)
                    .where(
                        Article.id == article_id,
                        Article.organization_id == organization_id,
                        Article.project_id == project_id,
                    )
                    .with_for_update()
                )
                if article is None:
                    raise LookupError("article_not_found")
                existing = await session.scalar(
                    select(ArticlePublication).where(
                        ArticlePublication.organization_id == organization_id,
                        ArticlePublication.project_id == project_id,
                        ArticlePublication.idempotency_key == idempotency_key,
                    )
                )
                if existing is not None:
                    if existing.request_hash != request_hash:
                        raise PublicationIdempotencyConflictError
                    return existing
                target = await session.scalar(
                    select(PublicationTarget).where(
                        PublicationTarget.id == target_id,
                        PublicationTarget.organization_id == organization_id,
                        PublicationTarget.project_id == project_id,
                        PublicationTarget.status == "verified",
                    )
                )
                if target is None:
                    raise LookupError("publication_target_not_found")
                if article.approved_version_number != version_number:
                    raise ValueError(
                        f"approved_version_mismatch:{article.approved_version_number or 0}"
                    )
                version = await session.scalar(
                    select(ArticleVersion).where(
                        ArticleVersion.article_id == article_id,
                        ArticleVersion.version_number == version_number,
                    )
                )
                if version is None:
                    raise LookupError("approved_version_not_found")
                await self._validate_publication_gate(session, article, version)
                blocked = await session.scalar(
                    select(ArticlePublication.id).where(
                        ArticlePublication.article_id == article_id,
                        ArticlePublication.status.in_(
                            {"queued", "scheduled", "submitting", "uncertain"}
                        ),
                    )
                )
                if blocked is not None:
                    raise ValueError("article_publication_active")
                if parent_publication_id is not None:
                    parent = await session.scalar(
                        select(ArticlePublication).where(
                            ArticlePublication.id == parent_publication_id,
                            ArticlePublication.article_id == article_id,
                            ArticlePublication.status == "failed",
                        )
                    )
                    if parent is None:
                        raise ValueError("article_publication_retry_not_allowed")
                previous = await session.scalar(
                    select(ArticlePublication)
                    .where(
                        ArticlePublication.article_id == article_id,
                        ArticlePublication.target_id == target_id,
                        ArticlePublication.status == "published",
                    )
                    .order_by(ArticlePublication.published_at.desc())
                    .limit(1)
                )
                operation = "update" if previous else "create"
                self._validate_target_capabilities(target, version, operation)
                status = "scheduled" if mode == "scheduled" else "queued"
                publication = ArticlePublication(
                    id=str(uuid4()),
                    article_id=article_id,
                    organization_id=organization_id,
                    project_id=project_id,
                    version_id=version.id,
                    version_number=version_number,
                    target_id=target_id,
                    parent_publication_id=parent_publication_id,
                    mode=mode,
                    schedule_at_utc=schedule_at_utc,
                    source_timezone=source_timezone,
                    idempotency_key=idempotency_key,
                    request_hash=request_hash,
                    payload_hash=payload_hash,
                    asset_manifest_hash=asset_manifest_hash,
                    status=status,
                    attempt_count=0,
                    remote_post_id=previous.remote_post_id if previous else None,
                    remote_url=previous.remote_url if previous else None,
                    created_by=created_by,
                    request_summary_json={
                        "operation": operation,
                        "approved_version_number": version_number,
                        "target_adapter": target.adapter_type,
                        "target_site_url": target.site_url,
                    },
                )
                session.add(publication)
                await session.flush()
                for item in version.asset_manifest or []:
                    asset = await session.get(ContentAsset, str(item["asset_id"]))
                    if asset is None or not asset.content_hash:
                        raise ValueError("publication_asset_source_missing")
                    session.add(
                        PublicationAssetCheckpoint(
                            id=str(uuid4()),
                            publication_id=publication.id,
                            asset_id=asset.id,
                            node_id=str(item["node_id"]),
                            item_id=item.get("item_id"),
                            item_key=str(item.get("item_id") or ""),
                            binding_role=str(item["binding_role"]),
                            variant_hash=asset.content_hash,
                            status="pending",
                        )
                    )
                self._audit(
                    session,
                    audit=audit,
                    project_id=project_id,
                    article_id=article_id,
                    action=(
                        "article.publication_scheduled"
                        if mode == "scheduled"
                        else "article.publication_queued"
                    ),
                    target_type="article_publication",
                    target_id=publication.id,
                    before={},
                    after={
                        "status": status,
                        "version_number": version_number,
                        "target_id": target_id,
                        "schedule_at_utc": (
                            schedule_at_utc.isoformat() if schedule_at_utc else None
                        ),
                        "source_timezone": source_timezone,
                    },
                    reason="publication_requested",
                    version_number=version_number,
                )
                await session.commit()
                await session.refresh(publication)
                return publication
        except IntegrityError:
            async with self.sessions() as session:
                existing = await session.scalar(
                    select(ArticlePublication).where(
                        ArticlePublication.organization_id == organization_id,
                        ArticlePublication.project_id == project_id,
                        ArticlePublication.idempotency_key == idempotency_key,
                    )
                )
                if existing is not None and existing.request_hash == request_hash:
                    return existing
            raise

    @staticmethod
    def _validate_target_capabilities(
        target: PublicationTarget,
        version: ArticleVersion,
        operation: str,
    ) -> None:
        capabilities = dict(target.capabilities_json or {})
        required = {
            "post_update_by_remote_id" if operation == "update" else "post_create",
            "post_reconcile",
        }
        if version.asset_manifest:
            required.update({"media_upload", "media_lookup"})
        missing = sorted(
            capability for capability in required if capabilities.get(capability) is not True
        )
        if missing:
            raise ValueError(f"publication_target_capability_missing:{missing[0]}")

    @staticmethod
    async def _validate_publication_gate(
        session: AsyncSession, article: Article, version: ArticleVersion
    ) -> None:
        from app.modules.content_plan.models import ContentPlanSettings

        snapshot = {**dict(version.content_json or {}), **dict(version.metadata_snapshot or {})}
        if snapshot.get("publication_status") != "publish_ready":
            raise ValueError("quality_not_ready")
        if not snapshot.get("title") or not snapshot.get("slug") or not snapshot.get("meta_description"):
            raise ValueError("publication_metadata_incomplete")
        approval_task = await session.scalar(
            select(ArticleReviewTask.id).where(
                ArticleReviewTask.article_id == article.id,
                ArticleReviewTask.version_number == version.version_number,
                ArticleReviewTask.status == "approved",
            )
        )
        legacy_approval = None
        if approval_task is None and version.review_version is not None:
            legacy_approval = await session.scalar(
                select(ArticleReviewDecision.id).where(
                    ArticleReviewDecision.article_id == article.id,
                    ArticleReviewDecision.review_version == version.review_version,
                    ArticleReviewDecision.decision == "approved",
                )
            )
        if approval_task is None and legacy_approval is None:
            raise ValueError("approved_version_not_reviewed")
        run = await session.get(ArticleRun, version.run_id)
        if run is None or run.status not in {"completed", "completed_with_warnings"}:
            raise ValueError("article_not_publishable")
        settings = await session.get(ContentPlanSettings, article.project_id)
        if settings is not None and settings.paused:
            raise ValueError("publishing_paused")
        await PublicationRepository._validate_assets(
            session, article.project_id, list(version.asset_manifest or [])
        )
        if extract_asset_manifest(dict(version.document_snapshot or {})) != list(
            version.asset_manifest or []
        ):
            raise ValueError("asset_manifest_mismatch")

    @staticmethod
    async def _validate_assets(
        session: AsyncSession, project_id: str, manifest: list[dict[str, Any]]
    ) -> None:
        asset_ids = {str(item["asset_id"]) for item in manifest}
        if not asset_ids:
            return
        assets = {
            row.id: row
            for row in await session.scalars(
                select(ContentAsset).where(ContentAsset.id.in_(asset_ids))
            )
        }
        if set(assets) != asset_ids:
            raise ValueError("asset_not_found")
        for asset in assets.values():
            if asset.project_id != project_id:
                raise ValueError("asset_cross_project")
            if asset.status != "ready":
                raise ValueError("asset_not_ready")
            if not asset.storage_key or not asset.content_hash or not asset.mime_type:
                raise ValueError("publication_asset_source_missing")

    async def list_publications(
        self, organization_id: str, project_id: str, article_id: str
    ) -> list[ArticlePublication]:
        async with self.sessions() as session:
            article = await session.scalar(
                select(Article.id).where(
                    Article.id == article_id,
                    Article.organization_id == organization_id,
                    Article.project_id == project_id,
                )
            )
            if article is None:
                raise LookupError("article_not_found")
            return list(
                await session.scalars(
                    select(ArticlePublication)
                    .where(ArticlePublication.article_id == article_id)
                    .order_by(ArticlePublication.created_at.desc())
                )
            )

    async def get_publication(
        self, organization_id: str, project_id: str, publication_id: str
    ) -> ArticlePublication | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(ArticlePublication).where(
                    ArticlePublication.id == publication_id,
                    ArticlePublication.organization_id == organization_id,
                    ArticlePublication.project_id == project_id,
                )
            )

    async def set_target_status(
        self, target_id: str, *, status: str
    ) -> PublicationTarget:
        async with self.sessions() as session:
            target = await session.scalar(
                select(PublicationTarget)
                .where(PublicationTarget.id == target_id)
                .with_for_update()
            )
            if target is None:
                raise LookupError("publication_target_not_found")
            target.status = status
            await session.commit()
            await session.refresh(target)
            return target

    async def set_target_capabilities(
        self, target_id: str, capabilities: dict[str, bool]
    ) -> PublicationTarget:
        async with self.sessions() as session:
            target = await session.scalar(
                select(PublicationTarget)
                .where(PublicationTarget.id == target_id)
                .with_for_update()
            )
            if target is None:
                raise LookupError("publication_target_not_found")
            target.capabilities_json = dict(capabilities)
            await session.commit()
            await session.refresh(target)
            return target

    async def checkpoints(
        self, publication_id: str
    ) -> list[tuple[PublicationAssetCheckpoint, PublicationAssetMapping | None]]:
        async with self.sessions() as session:
            rows = await session.execute(
                select(PublicationAssetCheckpoint, PublicationAssetMapping)
                .outerjoin(
                    PublicationAssetMapping,
                    PublicationAssetMapping.id == PublicationAssetCheckpoint.mapping_id,
                )
                .where(PublicationAssetCheckpoint.publication_id == publication_id)
                .order_by(PublicationAssetCheckpoint.created_at)
            )
            return list(rows.tuples())

    async def claim_due(
        self, worker_id: str, *, lease_seconds: int, limit: int = 5
    ) -> list[str]:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            rows = list(
                await session.scalars(
                    select(ArticlePublication)
                    .where(
                        or_(
                            ArticlePublication.status == "queued",
                            and_(
                                ArticlePublication.status == "scheduled",
                                ArticlePublication.schedule_at_utc <= now,
                            ),
                            and_(
                                ArticlePublication.status == "submitting",
                                ArticlePublication.lease_expires_at < now,
                            ),
                        )
                    )
                    .order_by(
                        func.coalesce(
                            ArticlePublication.schedule_at_utc,
                            ArticlePublication.created_at,
                        )
                    )
                    .with_for_update(skip_locked=True)
                    .limit(limit)
                )
            )
            claimed: list[str] = []
            for row in rows:
                row.status = "submitting"
                row.lease_owner = worker_id
                row.lease_expires_at = now + timedelta(seconds=lease_seconds)
                row.attempt_count += 1
                claimed.append(row.id)
            await session.commit()
            return claimed

    async def renew_publication_lease(
        self, publication_id: str, worker_id: str, *, lease_seconds: int
    ) -> None:
        async with self.sessions() as session:
            row = await session.scalar(
                select(ArticlePublication)
                .where(
                    ArticlePublication.id == publication_id,
                    ArticlePublication.status == "submitting",
                    ArticlePublication.lease_owner == worker_id,
                )
                .with_for_update()
            )
            if row is None:
                raise LookupError("publication_lease_lost")
            row.lease_expires_at = datetime.now(UTC) + timedelta(seconds=lease_seconds)
            await session.commit()

    async def execution_context(
        self, publication_id: str, worker_id: str
    ) -> PublicationExecutionContext:
        async with self.sessions() as session:
            publication = await session.scalar(
                select(ArticlePublication).where(
                    ArticlePublication.id == publication_id,
                    ArticlePublication.status == "submitting",
                    ArticlePublication.lease_owner == worker_id,
                )
            )
            if publication is None:
                raise LookupError("publication_lease_lost")
            article = await session.get(Article, publication.article_id)
            version = await session.get(ArticleVersion, publication.version_id)
            target = await session.get(PublicationTarget, publication.target_id)
            if article is None or version is None or target is None:
                raise LookupError("publication_context_missing")
            checkpoints = list(
                await session.scalars(
                    select(PublicationAssetCheckpoint)
                    .where(PublicationAssetCheckpoint.publication_id == publication_id)
                    .order_by(PublicationAssetCheckpoint.created_at)
                )
            )
            asset_ids = {row.asset_id for row in checkpoints}
            assets = {
                row.id: row
                for row in await session.scalars(
                    select(ContentAsset).where(ContentAsset.id.in_(asset_ids))
                )
            } if asset_ids else {}
            return PublicationExecutionContext(
                publication=publication,
                article=article,
                version=version,
                target=target,
                checkpoints=checkpoints,
                assets=assets,
            )

    async def recheck_gate(self, publication_id: str, worker_id: str) -> None:
        async with self.sessions() as session:
            publication = await session.scalar(
                select(ArticlePublication)
                .where(
                    ArticlePublication.id == publication_id,
                    ArticlePublication.status == "submitting",
                    ArticlePublication.lease_owner == worker_id,
                )
                .with_for_update()
            )
            if publication is None:
                raise LookupError("publication_lease_lost")
            article = await session.get(Article, publication.article_id)
            version = await session.get(ArticleVersion, publication.version_id)
            target = await session.get(PublicationTarget, publication.target_id)
            if article is None or version is None or target is None:
                raise ValueError("publication_context_missing")
            if article.approved_version_number != publication.version_number:
                raise ValueError("publication_approval_revoked")
            if target.status != "verified":
                raise ValueError("publication_target_unavailable")
            operation = str(
                (publication.request_summary_json or {}).get("operation") or "create"
            )
            self._validate_target_capabilities(target, version, operation)
            await self._validate_publication_gate(session, article, version)

    async def claim_mapping(
        self,
        *,
        target_id: str,
        asset_id: str,
        variant_hash: str,
        remote_slug: str,
        worker_id: str,
        lease_seconds: int,
    ) -> tuple[PublicationAssetMapping, bool]:
        for contention_attempt in range(2):
            now = datetime.now(UTC)
            try:
                async with self.sessions() as session:
                    mapping = await session.scalar(
                        select(PublicationAssetMapping)
                        .where(
                            PublicationAssetMapping.target_id == target_id,
                            PublicationAssetMapping.asset_id == asset_id,
                            PublicationAssetMapping.variant_hash == variant_hash,
                        )
                        .with_for_update()
                    )
                    if mapping is not None:
                        if mapping.status in {"ready", "uncertain"}:
                            return mapping, False
                        if (
                            mapping.status == "uploading"
                            and mapping.lease_expires_at is not None
                            and mapping.lease_expires_at > now
                            and mapping.lease_owner != worker_id
                        ):
                            raise ValueError("publication_asset_mapping_busy")
                        mapping.attempt_count += 1
                    else:
                        mapping = PublicationAssetMapping(
                            id=str(uuid4()),
                            target_id=target_id,
                            asset_id=asset_id,
                            variant_hash=variant_hash,
                            remote_slug=remote_slug,
                            status="uploading",
                            attempt_count=1,
                        )
                        session.add(mapping)
                    mapping.status = "uploading"
                    mapping.lease_owner = worker_id
                    mapping.lease_expires_at = now + timedelta(seconds=lease_seconds)
                    mapping.error_code = None
                    mapping.error_detail = None
                    await session.commit()
                    await session.refresh(mapping)
                    return mapping, True
            except IntegrityError:
                if contention_attempt == 1:
                    raise ValueError("publication_asset_mapping_busy")
        raise ValueError("publication_asset_mapping_busy")

    async def start_checkpoint(self, checkpoint_id: str) -> None:
        async with self.sessions() as session:
            row = await session.scalar(
                select(PublicationAssetCheckpoint)
                .where(PublicationAssetCheckpoint.id == checkpoint_id)
                .with_for_update()
            )
            if row is None:
                raise LookupError("publication_checkpoint_not_found")
            row.status = "uploading"
            row.error_code = None
            await session.commit()

    async def complete_mapping(
        self,
        mapping_id: str,
        *,
        worker_id: str,
        remote_media_id: int,
        remote_source_url: str,
        remote_hash: str,
    ) -> PublicationAssetMapping:
        async with self.sessions() as session:
            mapping = await session.scalar(
                select(PublicationAssetMapping)
                .where(PublicationAssetMapping.id == mapping_id)
                .with_for_update()
            )
            if mapping is None:
                raise LookupError("publication_asset_mapping_not_found")
            if mapping.status == "uploading" and mapping.lease_owner != worker_id:
                raise ValueError("publication_asset_mapping_lease_lost")
            if mapping.status not in {"uploading", "uncertain"}:
                raise ValueError("publication_asset_mapping_not_completable")
            mapping.status = "ready"
            mapping.remote_media_id = remote_media_id
            mapping.remote_source_url = remote_source_url
            mapping.remote_hash = remote_hash
            mapping.last_verified_at = datetime.now(UTC)
            mapping.lease_owner = None
            mapping.lease_expires_at = None
            mapping.error_code = None
            mapping.error_detail = None
            await session.commit()
            await session.refresh(mapping)
            return mapping

    async def mark_mapping(
        self,
        mapping_id: str,
        *,
        worker_id: str,
        status: str,
        error_code: str,
        error_detail: str,
    ) -> PublicationAssetMapping:
        async with self.sessions() as session:
            mapping = await session.scalar(
                select(PublicationAssetMapping)
                .where(PublicationAssetMapping.id == mapping_id)
                .with_for_update()
            )
            if mapping is None:
                raise LookupError("publication_asset_mapping_not_found")
            if mapping.status == "uploading" and mapping.lease_owner != worker_id:
                raise ValueError("publication_asset_mapping_lease_lost")
            mapping.status = status
            mapping.error_code = error_code[:100]
            mapping.error_detail = error_detail[:2000]
            mapping.lease_owner = None
            mapping.lease_expires_at = None
            await session.commit()
            await session.refresh(mapping)
            return mapping

    async def complete_checkpoint(
        self, checkpoint_id: str, mapping_id: str
    ) -> None:
        async with self.sessions() as session:
            row = await session.scalar(
                select(PublicationAssetCheckpoint)
                .where(PublicationAssetCheckpoint.id == checkpoint_id)
                .with_for_update()
            )
            if row is None:
                raise LookupError("publication_checkpoint_not_found")
            row.status = "ready"
            row.mapping_id = mapping_id
            row.error_code = None
            row.attempt_count += 1
            await session.commit()

    async def complete_checkpoints_for_mapping(self, mapping_id: str) -> None:
        async with self.sessions() as session:
            rows = list(
                await session.scalars(
                    select(PublicationAssetCheckpoint)
                    .where(PublicationAssetCheckpoint.mapping_id == mapping_id)
                    .with_for_update()
                )
            )
            for row in rows:
                row.status = "ready"
                row.error_code = None
            await session.commit()

    async def fail_checkpoint(
        self, checkpoint_id: str, *, uncertain: bool, error_code: str
    ) -> None:
        async with self.sessions() as session:
            row = await session.scalar(
                select(PublicationAssetCheckpoint)
                .where(PublicationAssetCheckpoint.id == checkpoint_id)
                .with_for_update()
            )
            if row is not None:
                row.status = "uncertain" if uncertain else "failed"
                row.error_code = error_code[:100]
                row.attempt_count += 1
                await session.commit()

    async def finish_publication(
        self,
        publication_id: str,
        *,
        worker_id: str,
        remote_post_id: int,
        remote_url: str,
        response_summary: dict[str, Any],
        published_snapshot: dict[str, Any],
        audit: ContentAuditContext,
    ) -> ArticlePublication:
        async with self.sessions() as session:
            row = await session.scalar(
                select(ArticlePublication)
                .where(ArticlePublication.id == publication_id)
                .with_for_update()
            )
            if row is None:
                raise LookupError("publication_not_found")
            if row.status == "published":
                return row
            if row.status != "submitting" or row.lease_owner != worker_id:
                raise ValueError("publication_lease_lost")
            row.status = "published"
            row.remote_post_id = remote_post_id
            row.remote_url = remote_url
            row.response_summary_json = response_summary
            row.published_snapshot_json = published_snapshot
            row.error_code = None
            row.error_detail = None
            row.published_at = datetime.now(UTC)
            row.lease_owner = None
            row.lease_expires_at = None
            self._audit(
                session,
                audit=audit,
                project_id=row.project_id,
                article_id=row.article_id,
                action="article.publication_published",
                target_type="article_publication",
                target_id=row.id,
                before={"status": "submitting"},
                after={
                    "status": "published",
                    "remote_post_id": remote_post_id,
                    "remote_url": remote_url,
                },
                reason="remote_publish_confirmed",
                version_number=row.version_number,
            )
            await session.commit()
            await session.refresh(row)
            return row

    async def stage_remote_submission(
        self,
        publication_id: str,
        *,
        worker_id: str,
        published_snapshot: dict[str, Any],
    ) -> None:
        async with self.sessions() as session:
            row = await session.scalar(
                select(ArticlePublication)
                .where(ArticlePublication.id == publication_id)
                .with_for_update()
            )
            if row is None:
                raise LookupError("publication_not_found")
            if row.status != "submitting" or row.lease_owner != worker_id:
                raise ValueError("publication_lease_lost")
            row.checkpoint_json = {
                **dict(row.checkpoint_json or {}),
                "remote_submission_stage": "pending",
                "published_snapshot": published_snapshot,
            }
            await session.commit()

    async def fail_publication(
        self,
        publication_id: str,
        *,
        worker_id: str,
        error_code: str,
        error_detail: str,
        uncertain: bool,
    ) -> ArticlePublication:
        async with self.sessions() as session:
            row = await session.scalar(
                select(ArticlePublication)
                .where(ArticlePublication.id == publication_id)
                .with_for_update()
            )
            if row is None:
                raise LookupError("publication_not_found")
            if row.status != "submitting":
                return row
            if row.lease_owner != worker_id:
                raise ValueError("publication_lease_lost")
            row.status = "uncertain" if uncertain else "failed"
            row.error_code = error_code[:100]
            row.error_detail = error_detail[:2000]
            row.lease_owner = None
            row.lease_expires_at = None
            await session.commit()
            await session.refresh(row)
            return row

    async def cancel_publication(
        self,
        organization_id: str,
        project_id: str,
        publication_id: str,
        *,
        cancelled_by: str,
        reason: str,
        audit: ContentAuditContext,
    ) -> ArticlePublication:
        async with self.sessions() as session:
            row = await session.scalar(
                select(ArticlePublication)
                .where(
                    ArticlePublication.id == publication_id,
                    ArticlePublication.organization_id == organization_id,
                    ArticlePublication.project_id == project_id,
                )
                .with_for_update()
            )
            if row is None:
                raise LookupError("publication_not_found")
            if row.status == "cancelled":
                return row
            if row.status not in {"queued", "scheduled"}:
                raise ValueError("publication_cancel_too_late")
            prior = row.status
            row.status = "cancelled"
            row.cancelled_at = datetime.now(UTC)
            row.cancelled_by = cancelled_by
            row.cancellation_reason = reason
            self._audit(
                session,
                audit=audit,
                project_id=project_id,
                article_id=row.article_id,
                action="article.publication_cancelled",
                target_type="article_publication",
                target_id=row.id,
                before={"status": prior},
                after={"status": "cancelled"},
                reason=reason,
                version_number=row.version_number,
            )
            await session.commit()
            await session.refresh(row)
            return row

    async def mark_reconciled_published(
        self,
        organization_id: str,
        project_id: str,
        publication_id: str,
        *,
        remote_post_id: int,
        remote_url: str,
        audit: ContentAuditContext,
    ) -> ArticlePublication:
        async with self.sessions() as session:
            row = await session.scalar(
                select(ArticlePublication)
                .where(
                    ArticlePublication.id == publication_id,
                    ArticlePublication.organization_id == organization_id,
                    ArticlePublication.project_id == project_id,
                )
                .with_for_update()
            )
            if row is None:
                raise LookupError("publication_not_found")
            if row.status != "uncertain":
                raise ValueError("publication_reconcile_not_allowed")
            row.status = "published"
            row.remote_post_id = remote_post_id
            row.remote_url = remote_url
            row.error_code = None
            row.error_detail = None
            row.published_at = datetime.now(UTC)
            staged_snapshot = (row.checkpoint_json or {}).get("published_snapshot")
            if isinstance(staged_snapshot, dict):
                row.published_snapshot_json = staged_snapshot
            self._audit(
                session,
                audit=audit,
                project_id=project_id,
                article_id=row.article_id,
                action="article.publication_reconciled",
                target_type="article_publication",
                target_id=row.id,
                before={"status": "uncertain"},
                after={"status": "published", "remote_post_id": remote_post_id},
                reason="remote_state_confirmed",
                version_number=row.version_number,
            )
            await session.commit()
            await session.refresh(row)
            return row

    async def mark_reconciled_failed(
        self,
        organization_id: str,
        project_id: str,
        publication_id: str,
        *,
        audit: ContentAuditContext,
    ) -> ArticlePublication:
        async with self.sessions() as session:
            row = await session.scalar(
                select(ArticlePublication)
                .where(
                    ArticlePublication.id == publication_id,
                    ArticlePublication.organization_id == organization_id,
                    ArticlePublication.project_id == project_id,
                )
                .with_for_update()
            )
            if row is None:
                raise LookupError("publication_not_found")
            if row.status != "uncertain":
                raise ValueError("publication_reconcile_not_allowed")
            row.status = "failed"
            row.error_code = "publication_remote_result_not_found"
            row.error_detail = "Remote reconciliation found no matching post"
            self._audit(
                session,
                audit=audit,
                project_id=project_id,
                article_id=row.article_id,
                action="article.publication_reconciled",
                target_type="article_publication",
                target_id=row.id,
                before={"status": "uncertain"},
                after={"status": "failed"},
                reason="remote_state_confirmed_absent",
                version_number=row.version_number,
            )
            await session.commit()
            await session.refresh(row)
            return row
