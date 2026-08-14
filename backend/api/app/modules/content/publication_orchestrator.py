from __future__ import annotations

import asyncio
import inspect
import logging
import re
from hashlib import sha256
from pathlib import PurePath
from uuid import uuid4

from app.core.config import Settings, get_settings
from app.modules.content.document import AssetRenderReference, document_to_html
from app.modules.content.models import ContentAsset, PublicationAssetMapping
from app.modules.content.object_storage import S3AssetObjectStore
from app.modules.content.publication import (
    WordPressPublishError,
    WordPressTransport,
)
from app.modules.content.publication_repository import (
    PublicationDeferredError,
    PublicationExecutionContext,
    PublicationRepository,
)
from app.modules.content.repository import ContentAuditContext, normalize_article_indexing
from app.modules.settings.service_connections import (
    LiveWordPressConnectionTester,
    SQLAlchemyServiceConnectionRepository,
    ServiceConnectionError,
    ServiceConnectionEncryptionUnavailableError,
    ServiceConnectionRepository,
    WordPressConnectionRecord,
    WordPressConnectionTester,
)


logger = logging.getLogger(__name__)


async def get_wordpress_connection(
    repository: ServiceConnectionRepository,
    settings: Settings,
    project_id: str,
) -> WordPressConnectionRecord | None:
    method = repository.get_wordpress
    parameters = inspect.signature(method).parameters
    encryption_key = (settings.ai_settings_encryption_key or "").strip() or None
    if len(parameters) >= 3:
        return await method(
            project_id,
            encryption_key,
            settings.ai_settings_allow_plaintext,
        )
    # Compatibility for the established two-argument test adapters.
    return await method(project_id, encryption_key)  # type: ignore[call-arg]


def publication_audit(publication_id: str) -> ContentAuditContext:
    return ContentAuditContext(
        actor_id="publication-worker",
        effective_role="system",
        request_id=None,
        correlation_id=publication_id,
        policy_version="article-publication-policy.v1",
    )


class PublicationOrchestrator:
    def __init__(
        self,
        settings: Settings,
        repository: PublicationRepository,
        connections: ServiceConnectionRepository,
        transport: WordPressTransport,
        store: S3AssetObjectStore,
        *,
        worker_id: str | None = None,
        lease_seconds: int = 180,
        connection_tester: WordPressConnectionTester | None = None,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.connections = connections
        self.transport = transport
        self.store = store
        self.worker_id = worker_id or f"publication-worker:{uuid4()}"
        self.lease_seconds = lease_seconds
        self.connection_tester = connection_tester

    async def dispatch_once(self, *, limit: int = 5) -> int:
        claimed = await self.repository.claim_due(
            self.worker_id,
            lease_seconds=self.lease_seconds,
            limit=limit,
        )
        for publication_id in claimed:
            await self.execute(publication_id)
        return len(claimed)

    async def run_forever(self, poll_seconds: float = 2) -> None:
        while True:
            try:
                await self.dispatch_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Unable to dispatch article publications")
            await asyncio.sleep(max(poll_seconds, 0.2))

    async def execute(self, publication_id: str) -> None:
        try:
            context = await self.repository.execution_context(
                publication_id, self.worker_id
            )
            connection = await get_wordpress_connection(
                self.connections, self.settings, context.publication.project_id
            )
            if connection is None or connection.verified_at is None:
                await self.repository.set_target_status(
                    context.target.id, status="disconnected"
                )
                raise WordPressPublishError(
                    "wordpress_connection_not_verified",
                    "WordPress connection is not verified",
                )

            checkpoint = dict(context.publication.checkpoint_json or {})
            pending_remote_submission = (
                checkpoint.get("remote_submission_stage") == "pending"
            )
            if self.connection_tester is not None:
                try:
                    verification = await self.connection_tester.test(connection)
                except ServiceConnectionError as exc:
                    raise WordPressPublishError(
                        "wordpress_capability_probe_failed",
                        str(exc),
                        uncertain=pending_remote_submission,
                    ) from exc
                await self.repository.set_target_capabilities(
                    context.target.id, verification.capabilities
                )
                if (
                    pending_remote_submission
                    and verification.capabilities.get("post_reconcile") is not True
                ):
                    raise WordPressPublishError(
                        "publication_target_capability_missing:post_reconcile",
                        "WordPress post lookup permission is unavailable",
                        uncertain=True,
                    )

            if await self._recover_pending_remote_submission(
                publication_id, context, connection
            ):
                return

            await self.repository.recheck_gate(publication_id, self.worker_id)

            references: dict[tuple[str, str], AssetRenderReference] = {}
            for checkpoint in context.checkpoints:
                await self.repository.renew_publication_lease(
                    publication_id, self.worker_id, lease_seconds=self.lease_seconds
                )
                asset = context.assets.get(checkpoint.asset_id)
                if asset is None:
                    raise WordPressPublishError(
                        "publication_asset_source_missing",
                        "A frozen publication asset is missing",
                    )
                mapping = await self._sync_asset(
                    context.target.id,
                    checkpoint.id,
                    checkpoint.binding_role,
                    asset,
                    checkpoint.variant_hash,
                    connection,
                    document=dict(context.version.document_snapshot or {}),
                    node_id=checkpoint.node_id,
                    item_id=checkpoint.item_id,
                )
                reference = AssetRenderReference(
                    url=str(mapping.remote_source_url),
                    mime_type=asset.detected_mime_type or asset.mime_type,
                    filename=asset.original_filename,
                    byte_size=asset.byte_size,
                    width=asset.width,
                    height=asset.height,
                )
                references[(asset.id, checkpoint.binding_role)] = reference
                references[(asset.id, _renderer_asset_role(checkpoint.binding_role))] = reference

            await self.repository.renew_publication_lease(
                publication_id, self.worker_id, lease_seconds=self.lease_seconds
            )
            snapshot = {
                **dict(context.version.content_json or {}),
                **dict(context.version.metadata_snapshot or {}),
            }
            html = document_to_html(
                dict(context.version.document_snapshot or {}),
                asset_references=references,
            )
            marker = (
                f"<!-- growthos-publication:{publication_id}:"
                f"{context.publication.payload_hash} -->"
            )
            payload: dict[str, object] = {
                "title": snapshot.get("title") or context.article.primary_keyword,
                "content": f"{marker}\n{html}",
                "status": "publish",
                "meta": {
                    "growthos_meta_title": snapshot.get("meta_title"),
                    "growthos_meta_description": snapshot.get("meta_description"),
                    "growthos_focus_keyword": snapshot.get("focus_keyword"),
                    "growthos_secondary_keywords": list(
                        snapshot.get("secondary_keywords") or []
                    ),
                    "growthos_canonical_url": snapshot.get("canonical_url"),
                    "growthos_indexing": normalize_article_indexing(
                        snapshot.get("indexing") or "index/follow"
                    ),
                    "growthos_seo_field_states": dict(
                        snapshot.get("field_states") or {}
                    ),
                },
            }
            if snapshot.get("slug"):
                payload["slug"] = snapshot["slug"]
            if snapshot.get("meta_description"):
                payload["excerpt"] = snapshot["meta_description"]
            published_snapshot = {
                "version_number": context.publication.version_number,
                "document": dict(context.version.document_snapshot or {}),
                "metadata": dict(context.version.metadata_snapshot or {}),
                "html": html,
                "assets": {
                    f"{checkpoint.asset_id}:{checkpoint.binding_role}": references[
                        (checkpoint.asset_id, checkpoint.binding_role)
                    ].url
                    for checkpoint in context.checkpoints
                },
            }
            await self.repository.stage_remote_submission(
                publication_id,
                worker_id=self.worker_id,
                published_snapshot=published_snapshot,
            )
            result = await self.transport.publish(
                connection,
                payload,
                post_id=context.publication.remote_post_id,
            )
            await self.repository.finish_publication(
                publication_id,
                worker_id=self.worker_id,
                remote_post_id=result.post_id,
                remote_url=result.url,
                response_summary={"status": result.status},
                published_snapshot=published_snapshot,
                audit=publication_audit(publication_id),
            )
        except ServiceConnectionEncryptionUnavailableError:
            await self.repository.fail_publication(
                publication_id,
                worker_id=self.worker_id,
                error_code="service_connection_encryption_unavailable",
                error_detail="WordPress credentials cannot be decrypted",
                uncertain=False,
            )
        except PublicationDeferredError:
            # The active lease is intentionally left in place. A later worker can
            # recover it without creating a second remote side effect.
            return
        except WordPressPublishError as exc:
            await self.repository.fail_publication(
                publication_id,
                worker_id=self.worker_id,
                error_code=exc.code,
                error_detail=exc.detail,
                uncertain=exc.uncertain,
            )
        except (LookupError, ValueError) as exc:
            await self.repository.fail_publication(
                publication_id,
                worker_id=self.worker_id,
                error_code=str(exc).split(":", 1)[0],
                error_detail=str(exc),
                uncertain=False,
            )
        except Exception as exc:
            await self.repository.fail_publication(
                publication_id,
                worker_id=self.worker_id,
                error_code="wordpress_publish_uncertain",
                error_detail=str(exc),
                uncertain=True,
            )

    async def _recover_pending_remote_submission(
        self,
        publication_id: str,
        context: PublicationExecutionContext,
        connection: WordPressConnectionRecord,
    ) -> bool:
        publication = context.publication
        checkpoint = dict(publication.checkpoint_json or {})
        if checkpoint.get("remote_submission_stage") != "pending":
            return False

        published_snapshot = checkpoint.get("published_snapshot")
        if not isinstance(published_snapshot, dict):
            raise WordPressPublishError(
                "publication_remote_checkpoint_invalid",
                "The pending WordPress submission checkpoint is incomplete",
                uncertain=True,
            )
        try:
            if publication.remote_post_id is not None:
                remote = await self.transport.get_post(
                    connection, publication.remote_post_id
                )
            else:
                metadata = dict(context.version.metadata_snapshot or {})
                slug = metadata.get("slug")
                if not isinstance(slug, str) or not slug:
                    raise WordPressPublishError(
                        "publication_frozen_slug_missing",
                        "The pending WordPress submission has no frozen slug",
                        uncertain=True,
                    )
                remote = await self.transport.find_post_by_slug(connection, slug)
        except WordPressPublishError as exc:
            raise WordPressPublishError(
                exc.code,
                exc.detail,
                uncertain=True,
            ) from exc

        if remote is None:
            raise WordPressPublishError(
                "publication_remote_result_not_found",
                "The prior WordPress submission cannot be confirmed safely",
                uncertain=True,
            )
        if remote.payload_hash != publication.payload_hash:
            raise WordPressPublishError(
                "publication_remote_payload_mismatch",
                "The WordPress post does not match the frozen publication payload",
                uncertain=True,
            )
        await self.repository.finish_publication(
            publication_id,
            worker_id=self.worker_id,
            remote_post_id=remote.post_id,
            remote_url=remote.url,
            response_summary={"status": remote.status, "recovered": True},
            published_snapshot=published_snapshot,
            audit=publication_audit(publication_id),
        )
        return True

    async def _sync_asset(
        self,
        target_id: str,
        checkpoint_id: str,
        binding_role: str,
        asset: ContentAsset,
        variant_hash: str,
        connection: WordPressConnectionRecord,
        *,
        document: dict[str, object],
        node_id: str,
        item_id: str | None,
    ) -> PublicationAssetMapping:
        remote_slug = _remote_media_slug(target_id, asset.id, variant_hash)
        try:
            mapping, claimed = await self.repository.claim_mapping(
                target_id=target_id,
                asset_id=asset.id,
                variant_hash=variant_hash,
                remote_slug=remote_slug,
                worker_id=self.worker_id,
                lease_seconds=self.lease_seconds,
            )
        except ValueError as exc:
            if str(exc) == "publication_asset_mapping_busy":
                raise PublicationDeferredError from exc
            raise
        if not claimed and mapping.status == "ready":
            remote = (
                await self.transport.get_media(connection, mapping.remote_media_id)
                if mapping.remote_media_id is not None
                else None
            )
            if remote is not None:
                await self.repository.complete_checkpoint(checkpoint_id, mapping.id)
                return mapping
            await self.repository.mark_mapping(
                mapping.id,
                worker_id=self.worker_id,
                status="stale",
                error_code="wordpress_media_missing",
                error_detail="Previously mapped media no longer exists",
            )
            mapping, claimed = await self.repository.claim_mapping(
                target_id=target_id,
                asset_id=asset.id,
                variant_hash=variant_hash,
                remote_slug=remote_slug,
                worker_id=self.worker_id,
                lease_seconds=self.lease_seconds,
            )
        elif not claimed and mapping.status == "uncertain":
            remote = await self.transport.find_media_by_slug(
                connection, mapping.remote_slug
            )
            if remote is not None:
                mapping = await self.repository.complete_mapping(
                    mapping.id,
                    worker_id=self.worker_id,
                    remote_media_id=remote.media_id,
                    remote_source_url=remote.source_url,
                    remote_hash=variant_hash,
                )
                await self.repository.complete_checkpoint(checkpoint_id, mapping.id)
                return mapping
            await self.repository.mark_mapping(
                mapping.id,
                worker_id=self.worker_id,
                status="failed",
                error_code="wordpress_media_result_not_found",
                error_detail="Remote reconciliation found no matching media",
            )
            mapping, claimed = await self.repository.claim_mapping(
                target_id=target_id,
                asset_id=asset.id,
                variant_hash=variant_hash,
                remote_slug=remote_slug,
                worker_id=self.worker_id,
                lease_seconds=self.lease_seconds,
            )
        if not claimed:
            raise PublicationDeferredError

        await self.repository.start_checkpoint(checkpoint_id)
        try:
            if not asset.storage_key or not asset.byte_size:
                raise WordPressPublishError(
                    "publication_asset_source_missing",
                    "The original asset object is unavailable",
                )
            body = await self.store.read_bytes(asset.storage_key, asset.byte_size + 1)
            if len(body) != asset.byte_size or sha256(body).hexdigest() != variant_hash:
                raise WordPressPublishError(
                    "publication_asset_hash_mismatch",
                    "The stored asset no longer matches the frozen hash",
                )
            title, alt_text, caption = _asset_metadata(
                document,
                node_id=node_id,
                item_id=item_id,
                binding_role=binding_role,
                fallback=PurePath(asset.original_filename).stem,
            )
            result = await self.transport.upload_media(
                connection,
                body=body,
                filename=PurePath(asset.original_filename).name,
                mime_type=str(asset.detected_mime_type or asset.mime_type),
                slug=remote_slug,
                title=title,
                alt_text=alt_text,
                caption=caption,
            )
            mapping = await self.repository.complete_mapping(
                mapping.id,
                worker_id=self.worker_id,
                remote_media_id=result.media_id,
                remote_source_url=result.source_url,
                remote_hash=variant_hash,
            )
            await self.repository.complete_checkpoint(checkpoint_id, mapping.id)
            return mapping
        except WordPressPublishError as exc:
            await self.repository.mark_mapping(
                mapping.id,
                worker_id=self.worker_id,
                status="uncertain" if exc.uncertain else "failed",
                error_code=exc.code,
                error_detail=exc.detail,
            )
            await self.repository.fail_checkpoint(
                checkpoint_id, uncertain=exc.uncertain, error_code=exc.code
            )
            raise


def _remote_media_slug(target_id: str, asset_id: str, variant_hash: str) -> str:
    raw = f"growthos-{target_id[:8]}-{asset_id[:8]}-{variant_hash[:20]}".lower()
    return re.sub(r"[^a-z0-9-]+", "-", raw).strip("-")


def _renderer_asset_role(binding_role: str) -> str:
    return "download" if binding_role == "file" else "original"


def _asset_metadata(
    document: dict[str, object],
    *,
    node_id: str,
    item_id: str | None,
    binding_role: str,
    fallback: str,
) -> tuple[str, str, str]:
    def find(node: object) -> dict[str, object] | None:
        if not isinstance(node, dict):
            return None
        attrs = node.get("attrs")
        if isinstance(attrs, dict) and attrs.get("node_id") == node_id:
            return attrs
        content = node.get("content")
        if isinstance(content, list):
            for child in content:
                match = find(child)
                if match is not None:
                    return match
        return None

    attrs = find(document) or {}
    source = attrs
    if binding_role == "gallery_item" and item_id:
        items = attrs.get("items")
        if isinstance(items, list):
            source = next(
                (
                    item
                    for item in items
                    if isinstance(item, dict) and item.get("item_id") == item_id
                ),
                attrs,
            )
    title = str(source.get("title") or attrs.get("title") or fallback).strip()
    decorative = bool(source.get("decorative"))
    alt = "" if decorative else str(source.get("alt") or title).strip()
    caption = str(source.get("caption") or attrs.get("caption") or "").strip()
    return title[:200], alt[:2000], caption[:5000]


def build_publication_orchestrator() -> PublicationOrchestrator:
    from app.db.session import session_factory
    from app.modules.content.publication import LiveWordPressTransport

    settings = get_settings()
    return PublicationOrchestrator(
        settings,
        PublicationRepository(session_factory),
        SQLAlchemyServiceConnectionRepository(session_factory),
        LiveWordPressTransport(),
        S3AssetObjectStore(settings),
        lease_seconds=settings.publication_execution_lease_seconds,
        connection_tester=LiveWordPressConnectionTester(),
    )
