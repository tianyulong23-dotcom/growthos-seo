from __future__ import annotations

import html
import secrets
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.content.document import AssetRenderReference, document_to_html
from app.modules.content.models import (
    ArticlePreviewSnapshot,
    ArticlePublication,
    PublicationAssetCheckpoint,
    PublicationAssetMapping,
    PublicationTarget,
)
from app.modules.content.object_storage import S3AssetObjectStore
from app.modules.content.publication import LiveWordPressTransport, WordPressPublishError, WordPressTransport
from app.modules.content.publication_orchestrator import (
    _renderer_asset_role,
    get_wordpress_connection,
)
from app.modules.content.publication_repository import (
    PublicationIdempotencyConflictError,
    PublicationRepository,
    canonical_hash,
)
from app.modules.content.repository import ContentAuditContext, ContentRepository
from app.modules.content.schemas import (
    ArticlePreviewResponse,
    ArticlePublicationCollection,
    ArticlePublicationResponse,
    ArticlePublicationSnapshotResponse,
    CreateArticlePreviewRequest,
    CreateArticlePublicationRequest,
    PublicationAssetProgressResponse,
    PublicationTargetCollection,
    PublicationTargetResponse,
)
from app.modules.settings.service_connections import (
    LiveWordPressConnectionTester,
    SQLAlchemyServiceConnectionRepository,
    ServiceConnectionError,
    ServiceConnectionEncryptionUnavailableError,
    ServiceConnectionRepository,
    WordPressConnectionTester,
)


class PublicationService:
    def __init__(
        self,
        settings: Settings,
        repository: PublicationRepository,
        content_repository: ContentRepository,
        connections: ServiceConnectionRepository,
        store: S3AssetObjectStore,
        transport: WordPressTransport,
        connection_tester: WordPressConnectionTester | None = None,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.content_repository = content_repository
        self.connections = connections
        self.store = store
        self.transport = transport
        self.connection_tester = connection_tester

    async def list_targets(
        self, organization_id: str, project_id: str
    ) -> PublicationTargetCollection:
        await self._sync_wordpress_target(organization_id, project_id)
        targets = await self.repository.list_targets(organization_id, project_id)
        return PublicationTargetCollection(
            items=[publication_target_response(row) for row in targets]
        )

    async def create_preview(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        request: CreateArticlePreviewRequest,
        *,
        created_by: str,
        audit: ContentAuditContext,
    ) -> ArticlePreviewResponse:
        token = secrets.token_urlsafe(32)
        snapshot = await self.repository.create_preview(
            organization_id,
            project_id,
            article_id,
            source_type=request.source_type,
            version_number=request.version_number,
            autosave_id=request.autosave_id,
            target_id=request.target_id,
            created_by=created_by,
            audience=request.audience,
            token_hash=sha256(token.encode()).hexdigest(),
            expires_at=datetime.now(UTC) + timedelta(minutes=request.expires_in_minutes),
            audit=audit,
        )
        return preview_response(snapshot, token)

    async def revoke_preview(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        preview_id: str,
        *,
        revoked_by: str,
        audit: ContentAuditContext,
    ) -> None:
        await self.repository.revoke_preview(
            organization_id,
            project_id,
            article_id,
            preview_id,
            revoked_by=revoked_by,
            audit=audit,
        )

    async def render_preview(self, preview_id: str, token: str) -> str:
        snapshot, assets = await self.repository.resolve_preview(
            preview_id, sha256(token.encode()).hexdigest()
        )
        references: dict[tuple[str, str], AssetRenderReference] = {}
        for item in snapshot.asset_manifest:
            asset = assets[str(item["asset_id"])]
            if not asset.storage_key:
                raise ValueError("article_preview_asset_unavailable")
            url = await self.store.presigned_download_url(
                asset.storage_key,
                asset.original_filename,
                expires_seconds=max(
                    60,
                    min(3600, int((snapshot.expires_at - datetime.now(UTC)).total_seconds())),
                ),
                disposition="inline",
            )
            binding_role = str(item["binding_role"])
            reference = AssetRenderReference(
                url=url,
                mime_type=asset.detected_mime_type or asset.mime_type,
                filename=asset.original_filename,
                byte_size=asset.byte_size,
                width=asset.width,
                height=asset.height,
            )
            references[(asset.id, binding_role)] = reference
            references[(asset.id, _renderer_asset_role(binding_role))] = reference
        body = document_to_html(
            dict(snapshot.document_snapshot or {}), asset_references=references
        )
        metadata = dict(snapshot.metadata_snapshot or {})
        title = html.escape(str(metadata.get("title") or "文章预览"))
        version = (
            f"永久版本 {snapshot.source_version_number}"
            if snapshot.source_type == "version"
            else "未保存内容快照"
        )
        return _preview_document(title, html.escape(version), body)

    async def verify_preview(self, preview_id: str, token: str) -> None:
        await self.repository.resolve_preview(
            preview_id, sha256(token.encode()).hexdigest()
        )

    async def create_publication(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        request: CreateArticlePublicationRequest,
        idempotency_key: str,
        *,
        created_by: str,
        audit: ContentAuditContext,
        parent_publication_id: str | None = None,
    ) -> ArticlePublicationResponse:
        normalized_key = _idempotency_key(idempotency_key)
        schedule_at_utc = _schedule_at_utc(request)
        await self._sync_wordpress_target(organization_id, project_id)
        version = await self.content_repository.get_article_version(
            organization_id, project_id, article_id, request.version_number
        )
        if version is None:
            raise LookupError("approved_version_not_found")
        frozen = {
            "article_id": article_id,
            "version_number": request.version_number,
            "target_id": request.target_id,
            "document": dict(version.document_snapshot or {}),
            "metadata": dict(version.metadata_snapshot or {}),
        }
        request_payload = request.model_dump(mode="json")
        try:
            publication = await self.repository.create_publication(
                organization_id,
                project_id,
                article_id,
                version_number=request.version_number,
                target_id=request.target_id,
                mode=request.mode,
                schedule_at_utc=schedule_at_utc,
                source_timezone=request.source_timezone,
                idempotency_key=normalized_key,
                request_hash=canonical_hash(request_payload),
                payload_hash=canonical_hash(frozen),
                asset_manifest_hash=canonical_hash(list(version.asset_manifest or [])),
                created_by=created_by,
                audit=audit,
                parent_publication_id=parent_publication_id,
            )
        except PublicationIdempotencyConflictError as exc:
            raise ValueError("idempotency_key_conflict") from exc
        return await self.publication_response(publication)

    async def list_publications(
        self, organization_id: str, project_id: str, article_id: str
    ) -> ArticlePublicationCollection:
        rows = await self.repository.list_publications(
            organization_id, project_id, article_id
        )
        return ArticlePublicationCollection(
            items=[await self.publication_response(row) for row in rows]
        )

    async def get_publication(
        self, organization_id: str, project_id: str, publication_id: str
    ) -> ArticlePublicationResponse:
        row = await self.repository.get_publication(
            organization_id, project_id, publication_id
        )
        if row is None:
            raise LookupError("publication_not_found")
        return await self.publication_response(row)

    async def publication_snapshot(
        self, organization_id: str, project_id: str, publication_id: str
    ) -> ArticlePublicationSnapshotResponse:
        row = await self.repository.get_publication(
            organization_id, project_id, publication_id
        )
        if row is None:
            raise LookupError("publication_not_found")
        snapshot = dict(row.published_snapshot_json or {})
        if row.status != "published" or not snapshot:
            raise ValueError("publication_snapshot_unavailable")
        article_row = await self.content_repository.get_article(
            organization_id, project_id, row.article_id
        )
        if article_row is None:
            raise LookupError("article_not_found")
        article, _run = article_row
        current_version_number = article.current_version_number
        published_version_number = int(row.version_number or 0)
        diff = None
        if current_version_number != published_version_number:
            before, after, typed = await self.content_repository.compare_article_versions(
                organization_id,
                project_id,
                row.article_id,
                published_version_number,
                current_version_number,
            )
            # Imported lazily because the established content service owns the
            # complete typed plus line-diff response assembler.
            from app.modules.content.service import article_version_diff

            diff = article_version_diff(before, after, typed)
        return ArticlePublicationSnapshotResponse(
            publication_id=row.id,
            published_version_number=published_version_number,
            published_snapshot=snapshot,
            current_draft_version_number=current_version_number,
            current_draft_diff=diff,
        )

    async def cancel_publication(
        self,
        organization_id: str,
        project_id: str,
        publication_id: str,
        *,
        cancelled_by: str,
        reason: str,
        audit: ContentAuditContext,
    ) -> ArticlePublicationResponse:
        row = await self.repository.cancel_publication(
            organization_id,
            project_id,
            publication_id,
            cancelled_by=cancelled_by,
            reason=reason,
            audit=audit,
        )
        return await self.publication_response(row)

    async def retry_publication(
        self,
        organization_id: str,
        project_id: str,
        publication_id: str,
        idempotency_key: str,
        *,
        created_by: str,
        audit: ContentAuditContext,
    ) -> ArticlePublicationResponse:
        parent = await self.repository.get_publication(
            organization_id, project_id, publication_id
        )
        if parent is None:
            raise LookupError("publication_not_found")
        if parent.status != "failed":
            raise ValueError("article_publication_retry_not_allowed")
        return await self.create_publication(
            organization_id,
            project_id,
            parent.article_id,
            CreateArticlePublicationRequest(
                version_number=int(parent.version_number or 0),
                target_id=str(parent.target_id),
                mode="immediate",
                source_timezone=parent.source_timezone,
            ),
            idempotency_key,
            created_by=created_by,
            audit=audit,
            parent_publication_id=parent.id,
        )

    async def reconcile_publication(
        self,
        organization_id: str,
        project_id: str,
        publication_id: str,
        *,
        audit: ContentAuditContext,
    ) -> ArticlePublicationResponse:
        row = await self.repository.get_publication(
            organization_id, project_id, publication_id
        )
        if row is None:
            raise LookupError("publication_not_found")
        if row.status != "uncertain":
            raise ValueError("publication_reconcile_not_allowed")
        connection = await get_wordpress_connection(
            self.connections, self.settings, project_id
        )
        if connection is None or connection.verified_at is None:
            raise ValueError("wordpress_connection_not_verified")
        if self.connection_tester is not None:
            try:
                verification = await self.connection_tester.test(connection)
            except ServiceConnectionError as exc:
                raise ValueError("wordpress_capability_probe_failed") from exc
            await self.repository.set_target_capabilities(
                str(row.target_id), verification.capabilities
            )
            if verification.capabilities.get("post_reconcile") is not True:
                raise ValueError(
                    "publication_target_capability_missing:post_reconcile"
                )
        try:
            if row.remote_post_id is not None:
                remote = await self.transport.get_post(connection, row.remote_post_id)
            else:
                version = await self.content_repository.get_article_version(
                    organization_id,
                    project_id,
                    row.article_id,
                    int(row.version_number or 0),
                )
                slug = (version.metadata_snapshot or {}).get("slug") if version else None
                if not isinstance(slug, str) or not slug:
                    raise ValueError("publication_frozen_slug_missing")
                remote = await self.transport.find_post_by_slug(connection, slug)
        except WordPressPublishError as exc:
            raise ValueError(exc.code) from exc
        if remote is None:
            reconciled = await self.repository.mark_reconciled_failed(
                organization_id, project_id, publication_id, audit=audit
            )
        else:
            if remote.payload_hash != row.payload_hash:
                raise ValueError("publication_remote_payload_mismatch")
            reconciled = await self.repository.mark_reconciled_published(
                organization_id,
                project_id,
                publication_id,
                remote_post_id=remote.post_id,
                remote_url=remote.url,
                audit=audit,
            )
        return await self.publication_response(reconciled)

    async def publication_response(
        self, row: ArticlePublication
    ) -> ArticlePublicationResponse:
        checkpoint_rows = await self.repository.checkpoints(row.id)
        return ArticlePublicationResponse(
            id=row.id,
            article_id=row.article_id,
            version_number=int(row.version_number or 0),
            target_id=str(row.target_id or ""),
            parent_publication_id=row.parent_publication_id,
            operation=str((row.request_summary_json or {}).get("operation") or "create"),
            mode=row.mode,
            schedule_at_utc=row.schedule_at_utc,
            source_timezone=row.source_timezone,
            status=row.status,
            payload_hash=row.payload_hash,
            asset_manifest_hash=row.asset_manifest_hash,
            remote_post_id=row.remote_post_id,
            remote_url=row.remote_url,
            attempt_count=row.attempt_count,
            last_error_code=row.error_code,
            last_error_detail=row.error_detail,
            created_by=row.created_by,
            created_at=row.created_at,
            updated_at=row.updated_at,
            published_at=row.published_at,
            cancelled_at=row.cancelled_at,
            media=[publication_asset_response(checkpoint, mapping) for checkpoint, mapping in checkpoint_rows],
            allowed_actions=publication_allowed_actions(row.status),
        )

    async def _sync_wordpress_target(
        self, organization_id: str, project_id: str
    ) -> PublicationTarget | None:
        try:
            connection = await get_wordpress_connection(
                self.connections, self.settings, project_id
            )
        except ServiceConnectionEncryptionUnavailableError:
            connection = None
        existing = await self.repository.list_targets(organization_id, project_id)
        if connection is None:
            if existing:
                return await self.repository.set_target_status(
                    existing[0].id, status="disconnected"
                )
            return None
        return await self.repository.upsert_wordpress_target(
            organization_id,
            project_id,
            site_url=connection.site_url,
            verified=(
                connection.verified_at is not None and bool(connection.capabilities)
            ),
            capabilities=dict(connection.capabilities),
        )


def publication_target_response(row: PublicationTarget) -> PublicationTargetResponse:
    return PublicationTargetResponse(
        id=row.id,
        adapter_type=row.adapter_type,
        site_url=row.site_url,
        capabilities=dict(row.capabilities_json or {}),
        status=row.status,
        updated_at=row.updated_at,
    )


def preview_response(row: ArticlePreviewSnapshot, token: str) -> ArticlePreviewResponse:
    return ArticlePreviewResponse(
        id=row.id,
        article_id=row.article_id,
        source_type=row.source_type,
        source_version_number=row.source_version_number,
        autosave_id=row.autosave_id,
        target_id=row.target_id,
        preview_url=f"/api/v1/article-previews/{row.id}#token={token}",
        expires_at=row.expires_at,
        revoked_at=row.revoked_at,
    )


def publication_asset_response(
    checkpoint: PublicationAssetCheckpoint,
    mapping: PublicationAssetMapping | None,
) -> PublicationAssetProgressResponse:
    return PublicationAssetProgressResponse(
        asset_id=checkpoint.asset_id,
        node_id=checkpoint.node_id,
        item_id=checkpoint.item_id,
        binding_role=checkpoint.binding_role,
        variant_hash=checkpoint.variant_hash,
        status=checkpoint.status,
        remote_media_id=mapping.remote_media_id if mapping else None,
        remote_source_url=mapping.remote_source_url if mapping else None,
        error_code=checkpoint.error_code or (mapping.error_code if mapping else None),
    )


def publication_allowed_actions(status: str) -> list[str]:
    if status in {"queued", "scheduled"}:
        return ["cancel"]
    if status == "failed":
        return ["retry"]
    if status == "uncertain":
        return ["reconcile"]
    return []


def _idempotency_key(value: str) -> str:
    normalized = value.strip()
    if not normalized or len(normalized) > 200:
        raise ValueError("idempotency_key_invalid")
    return normalized


def _schedule_at_utc(request: CreateArticlePublicationRequest) -> datetime | None:
    try:
        timezone = ZoneInfo(request.source_timezone)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("publication_timezone_invalid") from exc
    if request.mode == "immediate":
        return None
    schedule = request.schedule_at
    if schedule is None or schedule.tzinfo is None or schedule.utcoffset() is None:
        raise ValueError("publication_schedule_timezone_required")
    local = schedule.astimezone(timezone)
    if local.utcoffset() != schedule.utcoffset():
        raise ValueError("publication_schedule_timezone_mismatch")
    utc = schedule.astimezone(UTC)
    if utc <= datetime.now(UTC):
        raise ValueError("publication_schedule_must_be_future")
    return utc


def _preview_document(title: str, version: str, body: str) -> str:
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>{title} - 平台预览</title>
  <style>
    body {{ margin: 0; color: #202124; background: #fff; font: 16px/1.75 system-ui, sans-serif; }}
    .preview-bar {{ position: sticky; top: 0; z-index: 2; padding: 10px 20px; border-bottom: 1px solid #ddd; background: #fff; font-size: 13px; color: #5f6368; }}
    main {{ width: min(760px, calc(100% - 32px)); margin: 36px auto 80px; }}
    h1 {{ font-size: 34px; line-height: 1.25; }} h2 {{ margin-top: 36px; font-size: 26px; }}
    img, video {{ max-width: 100%; height: auto; }} table {{ width: 100%; border-collapse: collapse; }}
    th, td {{ padding: 8px; border: 1px solid #ddd; }} pre {{ overflow: auto; padding: 16px; background: #f6f8fa; }}
  </style>
</head>
<body>
  <div class="preview-bar">平台预览 · {version} · 不代表 WordPress 主题最终效果</div>
  <main><h1>{title}</h1>{body}</main>
</body>
</html>"""


def build_publication_service() -> PublicationService:
    settings = get_settings()
    return PublicationService(
        settings,
        PublicationRepository(session_factory),
        ContentRepository(session_factory),
        SQLAlchemyServiceConnectionRepository(session_factory),
        S3AssetObjectStore(settings),
        LiveWordPressTransport(),
        LiveWordPressConnectionTester(),
    )
