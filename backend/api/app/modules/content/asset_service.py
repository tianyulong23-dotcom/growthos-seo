from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import math
import re
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.content.asset_repository import AssetAuditContext, AssetRepository
from app.modules.content.asset_schemas import (
    AssetCollectionResponse,
    AssetDownloadAuthorizationResponse,
    AssetImportRequest,
    AssetResponse,
    AssetUpdateRequest,
    AssetUsageItem,
    AssetUsageResponse,
    AssetUploadCompleteRequest,
    AssetUploadCreateRequest,
    AssetUploadCreateResponse,
    AssetUploadPartResponse,
    AssetVariantResponse,
)
from app.modules.content.asset_security import (
    AssetProcessor,
    AssetSecurityError,
    maximum_asset_bytes,
    validate_filename,
)
from app.modules.content.models import AssetProcessingJob, AssetUploadSession, ContentAsset
from app.modules.content.object_storage import (
    AssetObjectError,
    S3AssetObjectStore,
    UploadedPart,
)


logger = logging.getLogger(__name__)


class AssetError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 422,
        retryable: bool = False,
        details: dict[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retryable = retryable
        self.details = details or {}


def _request_hash(value: dict[str, object]) -> str:
    body = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _safe_source_url(value: str | None) -> str | None:
    if not value:
        return None
    parsed = urlsplit(value)
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path[:256], "", ""))


def _encode_asset_cursor(value: tuple[datetime, str]) -> str:
    created_at, asset_id = value
    payload = json.dumps(
        {"v": 1, "created_at": created_at.isoformat(), "asset_id": asset_id},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")


def _decode_asset_cursor(value: str) -> tuple[datetime, str]:
    try:
        padding = "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(value + padding))
        if payload.get("v") != 1 or not isinstance(payload.get("asset_id"), str):
            raise ValueError
        created_at = datetime.fromisoformat(payload["created_at"])
        if created_at.tzinfo is None or not payload["asset_id"]:
            raise ValueError
        return created_at, payload["asset_id"]
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise AssetError("asset_cursor_invalid", "The asset cursor is invalid.") from exc


class AssetService:
    def __init__(
        self,
        *,
        repository: AssetRepository,
        store: S3AssetObjectStore,
        settings: Settings,
    ) -> None:
        self.repository = repository
        self.store = store
        self.settings = settings

    async def create_upload(
        self,
        *,
        project_id: str,
        user_id: str,
        idempotency_key: str,
        request: AssetUploadCreateRequest,
        audit: AssetAuditContext | None = None,
    ) -> AssetUploadCreateResponse:
        try:
            self._require_idempotency_key(idempotency_key)
            validate_filename(request.filename)
        except (AssetError, AssetSecurityError) as exc:
            error = self._normalize_error(exc)
            await self._record_rejection(
                project_id=project_id,
                target_id=self._request_target("upload", idempotency_key),
                action="asset.upload_rejected",
                error=error,
                audit=audit,
            )
            raise error from exc
        maximum = maximum_asset_bytes(self.settings, request.asset_type)
        if request.byte_size > maximum:
            raise AssetError(
                "asset_too_large",
                "The file exceeds the configured size limit.",
                details={"maximum_bytes": maximum},
            )
        request_hash = _request_hash(request.model_dump(mode="json"))
        existing = await self.repository.find_upload_by_idempotency(
            project_id, user_id, idempotency_key
        )
        if existing is not None:
            asset, upload = existing
            if upload.request_hash != request_hash:
                raise AssetError(
                    "asset_idempotency_conflict",
                    "The idempotency key was already used for a different upload.",
                    status_code=409,
                )
            return self._upload_response(asset, upload, maximum)

        asset_id = f"ast_{uuid4().hex}"
        upload_id = f"upl_{uuid4().hex}"
        storage_key = f"assets/{project_id}/{asset_id}/incoming"
        try:
            multipart_upload_id = await self.store.create_multipart_upload(
                storage_key, request.declared_mime_type
            )
        except AssetObjectError as exc:
            raise AssetError(
                "asset_upload_unavailable",
                "The upload could not be initialized.",
                status_code=503,
                retryable=True,
            ) from exc
        now = datetime.now(UTC)
        asset = ContentAsset(
            id=asset_id,
            project_id=project_id,
            asset_type=request.asset_type,
            status="uploading",
            original_filename=request.filename,
            mime_type=request.declared_mime_type.lower().split(";", 1)[0],
            byte_size=request.byte_size,
            storage_key=storage_key,
            source_type=request.source_type,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            created_by=user_id,
        )
        upload = AssetUploadSession(
            id=upload_id,
            asset_id=asset_id,
            project_id=project_id,
            status="initiated",
            multipart_upload_id=multipart_upload_id,
            storage_key=storage_key,
            expected_size=request.byte_size,
            expected_sha256=request.sha256.lower() if request.sha256 else None,
            part_size=self.settings.asset_upload_part_size,
            uploaded_bytes=0,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            created_by=user_id,
            expires_at=now
            + timedelta(seconds=self.settings.asset_upload_session_ttl_seconds),
        )
        try:
            await self.repository.create_upload(asset=asset, upload=upload, audit=audit)
        except Exception:
            await self.store.abort_multipart_upload(storage_key, multipart_upload_id)
            existing = await self.repository.find_upload_by_idempotency(
                project_id, user_id, idempotency_key
            )
            if existing is None or existing[1].request_hash != request_hash:
                raise
            asset, upload = existing
        return self._upload_response(asset, upload, maximum)

    async def upload_part(
        self,
        *,
        project_id: str,
        asset_id: str,
        part_number: int,
        body: bytes,
        declared_sha256: str | None,
    ) -> AssetUploadPartResponse:
        upload_row = await self.repository.get_upload(project_id, asset_id)
        if upload_row is None:
            raise AssetError("asset_not_found", "The asset was not found.", status_code=404)
        asset, upload, _ = upload_row
        if upload.expires_at <= datetime.now(UTC):
            raise AssetError("asset_upload_expired", "The upload session has expired.", status_code=409)
        if upload.status not in {"initiated", "uploading"}:
            raise AssetError(
                "asset_upload_not_active", "The upload is not active.", status_code=409
            )
        maximum_part = math.ceil(upload.expected_size / upload.part_size)
        if part_number < 1 or part_number > maximum_part:
            raise AssetError("asset_part_invalid", "The upload part number is invalid.")
        expected_part_size = (
            upload.expected_size - ((part_number - 1) * upload.part_size)
            if part_number == maximum_part
            else upload.part_size
        )
        if len(body) != expected_part_size:
            raise AssetError(
                "asset_part_size_mismatch",
                "The upload part size does not match the session contract.",
                details={"expected_bytes": expected_part_size},
            )
        checksum = hashlib.sha256(body).hexdigest()
        if declared_sha256 and checksum != declared_sha256.lower():
            raise AssetError("asset_hash_mismatch", "The upload part checksum does not match.")
        try:
            stored = await self.store.upload_part(
                upload.storage_key, upload.multipart_upload_id, part_number, body
            )
        except AssetObjectError as exc:
            raise AssetError(
                "asset_upload_unavailable",
                "The upload part could not be stored.",
                status_code=503,
                retryable=True,
            ) from exc
        _, updated, part = await self.repository.record_part(
            project_id=project_id,
            asset_id=asset_id,
            part_number=part_number,
            etag=stored.etag,
            byte_size=len(body),
            checksum_sha256=checksum,
        )
        return AssetUploadPartResponse(
            asset_id=asset.id,
            upload_id=upload.id,
            part_number=part.part_number,
            etag=part.etag,
            byte_size=part.byte_size,
            uploaded_bytes=updated.uploaded_bytes,
            status=updated.status,
        )

    async def complete_upload(
        self,
        *,
        project_id: str,
        asset_id: str,
        request: AssetUploadCompleteRequest,
        audit: AssetAuditContext | None = None,
    ) -> AssetResponse:
        row = await self.repository.get_upload(project_id, asset_id)
        if row is None:
            raise AssetError("asset_not_found", "The asset was not found.", status_code=404)
        asset, upload, saved_parts = row
        if upload.status == "completed":
            return await self.get_asset(project_id, asset_id)
        if upload.status not in {"initiated", "uploading", "completing"}:
            raise AssetError(
                "asset_upload_not_completable",
                "The upload cannot be completed in its current state.",
                status_code=409,
            )
        expected = [(part.part_number, part.etag) for part in saved_parts]
        supplied = [(part.part_number, part.etag.strip('"')) for part in request.parts]
        if supplied != expected or len({number for number, _ in supplied}) != len(supplied):
            raise AssetError(
                "asset_parts_mismatch", "The completed part manifest does not match the upload."
            )
        if sum(part.byte_size for part in saved_parts) != upload.expected_size:
            raise AssetError(
                "asset_size_mismatch", "The uploaded byte total does not match the expected size."
            )
        if request.sha256 and upload.expected_sha256 and (
            request.sha256.lower() != upload.expected_sha256
        ):
            raise AssetError("asset_hash_mismatch", "The upload checksum does not match.")
        await self.repository.mark_upload_completing(project_id, asset_id)
        try:
            head = await self.store.head(upload.storage_key)
        except AssetObjectError:
            head = None
        if head is None:
            try:
                head = await self.store.complete_multipart_upload(
                    upload.storage_key,
                    upload.multipart_upload_id,
                    [
                        UploadedPart(part.part_number, part.etag, part.byte_size)
                        for part in saved_parts
                    ],
                )
            except AssetObjectError as exc:
                # A concurrent completion may have committed the object before
                # this request receives the provider's stale upload error.
                try:
                    head = await self.store.head(upload.storage_key)
                except AssetObjectError:
                    raise AssetError(
                        "asset_upload_unavailable",
                        "The multipart upload could not be completed.",
                        status_code=503,
                        retryable=True,
                    ) from exc
        if head.byte_size != upload.expected_size:
            raise AssetError("asset_size_mismatch", "The stored object size does not match.")
        await self.repository.queue_processing(
            project_id=project_id,
            asset_id=asset_id,
            max_attempts=self.settings.asset_processing_max_attempts,
            audit=audit,
        )
        return await self.get_asset(project_id, asset_id)

    async def get_asset(self, project_id: str, asset_id: str) -> AssetResponse:
        row = await self.repository.get_asset_with_variants(project_id, asset_id)
        if row is None:
            raise AssetError("asset_not_found", "The asset was not found.", status_code=404)
        asset, variants = row
        if asset.canonical_asset_id:
            canonical = await self.repository.get_asset_with_variants(
                project_id, asset.canonical_asset_id
            )
            if canonical is not None:
                counts = await self.repository.reference_counts([canonical[0].id])
                return self._asset_response(
                    *canonical,
                    canonical_asset_id=asset.canonical_asset_id,
                    active_reference_count=counts.get(canonical[0].id, 0),
                )
        counts = await self.repository.reference_counts([asset.id])
        return self._asset_response(
            asset, variants, active_reference_count=counts.get(asset.id, 0)
        )

    async def update_metadata(
        self,
        *,
        project_id: str,
        asset_id: str,
        user_id: str,
        request: AssetUpdateRequest,
        audit: AssetAuditContext | None = None,
    ) -> AssetResponse:
        try:
            asset = await self.repository.update_metadata(
                project_id=project_id,
                asset_id=asset_id,
                values=request.model_dump(
                    include=request.model_fields_set,
                    exclude_unset=True,
                ),
                user_id=user_id,
                audit=audit,
            )
        except LookupError as exc:
            raise AssetError(
                "asset_not_found", "The asset was not found.", status_code=404
            ) from exc
        except ValueError as exc:
            raise AssetError(
                str(exc),
                "The asset metadata cannot be edited in its current state.",
                status_code=409,
            ) from exc
        row = await self.repository.get_asset_with_variants(project_id, asset.id)
        if row is None:
            raise AssetError("asset_not_found", "The asset was not found.", status_code=404)
        counts = await self.repository.reference_counts([asset.id])
        return self._asset_response(
            *row, active_reference_count=counts.get(asset.id, 0)
        )

    async def update_provider_metadata(
        self,
        *,
        project_id: str,
        asset_id: str,
        user_id: str,
        provider_metadata: dict[str, object],
    ) -> AssetResponse:
        try:
            asset = await self.repository.update_provider_metadata(
                project_id=project_id,
                asset_id=asset_id,
                provider_metadata=provider_metadata,
                user_id=user_id,
            )
        except LookupError as exc:
            raise AssetError(
                "asset_not_found", "The asset was not found.", status_code=404
            ) from exc
        except ValueError as exc:
            raise AssetError(
                str(exc),
                "The asset metadata cannot be edited in its current state.",
                status_code=409,
            ) from exc
        row = await self.repository.get_asset_with_variants(project_id, asset.id)
        if row is None:
            raise AssetError("asset_not_found", "The asset was not found.", status_code=404)
        counts = await self.repository.reference_counts([asset.id])
        return self._asset_response(
            *row, active_reference_count=counts.get(asset.id, 0)
        )

    async def usage(self, project_id: str, asset_id: str) -> AssetUsageResponse:
        row = await self.repository.usage(project_id, asset_id)
        if row is None:
            raise AssetError("asset_not_found", "The asset was not found.", status_code=404)
        asset, bindings = row
        articles: dict[str, dict[str, object]] = {}
        for binding, article in bindings:
            item = articles.setdefault(
                article.id,
                {
                    "article_id": article.id,
                    "article_title": article.title,
                    "article_status": article.status,
                    "current_reference_count": 0,
                    "version_reference_count": 0,
                    "binding_roles": set(),
                    "node_ids": set(),
                    "version_numbers": set(),
                },
            )
            count_key = (
                "current_reference_count"
                if binding.version_number is None
                else "version_reference_count"
            )
            item[count_key] = int(item[count_key]) + 1
            item["binding_roles"].add(binding.binding_role)  # type: ignore[union-attr]
            item["node_ids"].add(binding.node_id)  # type: ignore[union-attr]
            if binding.version_number is not None:
                item["version_numbers"].add(binding.version_number)  # type: ignore[union-attr]
        items = [
            AssetUsageItem(
                article_id=str(item["article_id"]),
                article_title=item["article_title"],
                article_status=str(item["article_status"]),
                current_reference_count=int(item["current_reference_count"]),
                version_reference_count=int(item["version_reference_count"]),
                binding_roles=sorted(item["binding_roles"]),
                node_ids=sorted(item["node_ids"]),
                version_numbers=sorted(item["version_numbers"]),
            )
            for item in articles.values()
        ]
        return AssetUsageResponse(
            asset_id=asset.id,
            active_reference_count=len(bindings),
            article_count=len(items),
            items=items,
        )

    async def cancel(
        self,
        project_id: str,
        asset_id: str,
        audit: AssetAuditContext | None = None,
    ) -> AssetResponse:
        try:
            upload = await self.repository.cancel(
                project_id,
                asset_id,
                self.settings.asset_cleanup_max_attempts,
                audit=audit,
            )
        except ValueError as exc:
            error = AssetError(
                str(exc), "A ready asset cannot be cancelled.", status_code=409
            )
            await self._record_rejection(
                project_id=project_id,
                target_id=asset_id,
                action="asset.cancel_rejected",
                error=error,
                audit=audit,
            )
            raise error from exc
        if upload is None:
            raise AssetError("asset_not_found", "The asset was not found.", status_code=404)
        key, multipart_id = upload
        try:
            await self.store.abort_multipart_upload(key, multipart_id)
        except AssetObjectError:
            pass
        return await self.get_asset(project_id, asset_id)

    async def retry(
        self,
        project_id: str,
        asset_id: str,
        audit: AssetAuditContext | None = None,
    ) -> AssetResponse:
        try:
            await self.repository.retry_processing(
                project_id,
                asset_id,
                self.settings.asset_processing_max_attempts,
                audit=audit,
            )
        except LookupError as exc:
            raise AssetError("asset_not_found", "The asset was not found.", status_code=404) from exc
        except ValueError as exc:
            error = AssetError(str(exc), "The asset cannot be retried.", status_code=409)
            await self._record_rejection(
                project_id=project_id,
                target_id=asset_id,
                action="asset.retry_rejected",
                error=error,
                audit=audit,
            )
            raise error from exc
        return await self.get_asset(project_id, asset_id)

    async def import_url(
        self,
        *,
        project_id: str,
        user_id: str,
        idempotency_key: str,
        request: AssetImportRequest,
        audit: AssetAuditContext | None = None,
    ) -> AssetResponse:
        try:
            self._require_idempotency_key(idempotency_key)
            parsed = urlsplit(request.source_url)
            filename = request.filename or parsed.path.rsplit("/", 1)[-1] or "imported-asset"
            validate_filename(filename)
        except (AssetError, AssetSecurityError) as exc:
            error = self._normalize_error(exc)
            await self._record_rejection(
                project_id=project_id,
                target_id=self._request_target("import", idempotency_key),
                action="asset.import_rejected",
                error=error,
                audit=audit,
            )
            raise error from exc
        request_hash = _request_hash(request.model_dump(mode="json"))
        existing = await self.repository.find_import_by_idempotency(
            project_id, user_id, idempotency_key
        )
        if existing is not None:
            if existing.request_hash != request_hash:
                raise AssetError(
                    "asset_idempotency_conflict",
                    "The idempotency key was already used for a different import.",
                    status_code=409,
                )
            return await self.get_asset(project_id, existing.id)
        asset_id = f"ast_{uuid4().hex}"
        asset = ContentAsset(
            id=asset_id,
            project_id=project_id,
            asset_type=request.asset_type,
            status="processing",
            original_filename=filename[:255],
            mime_type=None,
            source_type="import",
            source_url=request.source_url,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            created_by=user_id,
        )
        job = AssetProcessingJob(
            id=str(uuid4()),
            asset_id=asset_id,
            status="queued",
            max_attempts=self.settings.asset_processing_max_attempts,
        )
        try:
            await self.repository.create_import(asset=asset, job=job, audit=audit)
        except Exception:
            existing = await self.repository.find_import_by_idempotency(
                project_id, user_id, idempotency_key
            )
            if existing is None or existing.request_hash != request_hash:
                raise
            return await self.get_asset(project_id, existing.id)
        return self._asset_response(asset, [])

    async def ingest_bytes(
        self,
        *,
        project_id: str,
        user_id: str,
        idempotency_key: str,
        filename: str,
        mime_type: str,
        content: bytes,
        source_type: str = "generated",
        audit: AssetAuditContext | None = None,
    ) -> AssetResponse:
        try:
            self._require_idempotency_key(idempotency_key)
            validate_filename(filename)
        except (AssetError, AssetSecurityError) as exc:
            raise self._normalize_error(exc) from exc
        if not content:
            raise AssetError("asset_empty", "The image is empty.")
        declared_mime = mime_type.lower().split(";", 1)[0].strip()
        extension_mimes = {
            ".jpg": {"image/jpeg"},
            ".jpeg": {"image/jpeg"},
            ".png": {"image/png"},
            ".gif": {"image/gif"},
            ".webp": {"image/webp"},
        }
        suffix = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if declared_mime not in extension_mimes.get(suffix, set()):
            raise AssetError(
                "asset_mime_mismatch",
                "The declared MIME type does not match the image filename.",
            )
        maximum = maximum_asset_bytes(self.settings, "image")
        if len(content) > maximum:
            raise AssetError(
                "asset_too_large",
                "The file exceeds the configured size limit.",
                details={"maximum_bytes": maximum},
            )
        if source_type in {"upload", "paste", "import"} or not source_type.strip():
            raise AssetError("asset_source_type_invalid", "The image source type is invalid.")
        request_hash = _request_hash(
            {
                "filename": filename,
                "mime_type": declared_mime,
                "byte_size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "source_type": source_type,
            }
        )
        existing = await self.repository.find_ingested_by_idempotency(
            project_id, user_id, source_type, idempotency_key
        )
        if existing is not None:
            if existing.request_hash != request_hash:
                raise AssetError(
                    "asset_idempotency_conflict",
                    "The idempotency key was already used for a different image.",
                    status_code=409,
                )
            return await self.get_asset(project_id, existing.id)

        asset_id = f"ast_{uuid4().hex}"
        storage_key = f"assets/{project_id}/{asset_id}/incoming"
        asset = ContentAsset(
            id=asset_id,
            project_id=project_id,
            asset_type="image",
            status="processing",
            original_filename=filename[:255],
            mime_type=declared_mime,
            byte_size=len(content),
            storage_key=storage_key,
            source_type=source_type,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            created_by=user_id,
        )
        job = AssetProcessingJob(
            id=str(uuid4()),
            asset_id=asset_id,
            status="queued",
            max_attempts=self.settings.asset_processing_max_attempts,
        )
        try:
            await self.store.write_bytes(storage_key, content, declared_mime)
        except AssetObjectError as exc:
            raise AssetError(
                "asset_upload_unavailable",
                "The image could not be stored.",
                status_code=503,
                retryable=True,
            ) from exc
        try:
            await self.repository.create_import(asset=asset, job=job, audit=audit)
        except Exception:
            existing = await self.repository.find_ingested_by_idempotency(
                project_id, user_id, source_type, idempotency_key
            )
            if existing is not None and existing.request_hash == request_hash:
                try:
                    await self.store.delete(storage_key)
                except Exception:
                    logger.warning(
                        "Unable to remove duplicate ingested asset object",
                        extra={"asset_storage_key": storage_key},
                    )
                return await self.get_asset(project_id, existing.id)
            try:
                await self.store.delete(storage_key)
            except Exception:
                logger.warning(
                    "Unable to remove failed ingested asset object",
                    extra={"asset_storage_key": storage_key},
                )
            raise
        return self._asset_response(asset, [])

    async def list_assets(
        self,
        *,
        project_id: str,
        asset_type: str | None,
        status: str | None,
        query: str | None,
        cursor: str | None,
        limit: int,
    ) -> AssetCollectionResponse:
        parsed_cursor = _decode_asset_cursor(cursor) if cursor else None
        rows, next_cursor = await self.repository.list_assets(
            project_id=project_id,
            asset_type=asset_type,
            status=status,
            query=query,
            cursor=parsed_cursor,
            limit=limit,
        )
        counts = await self.repository.reference_counts([asset.id for asset in rows])
        return AssetCollectionResponse(
            items=[
                self._asset_response(
                    asset,
                    [],
                    active_reference_count=counts.get(asset.id, 0),
                )
                for asset in rows
            ],
            next_cursor=_encode_asset_cursor(next_cursor) if next_cursor else None,
        )

    async def delete(
        self,
        project_id: str,
        asset_id: str,
        audit: AssetAuditContext | None = None,
    ) -> None:
        try:
            references = await self.repository.request_delete(
                project_id=project_id,
                asset_id=asset_id,
                available_at=datetime.now(UTC)
                + timedelta(seconds=self.settings.asset_cleanup_retention_seconds),
                max_attempts=self.settings.asset_cleanup_max_attempts,
                audit=audit,
            )
        except LookupError as exc:
            raise AssetError("asset_not_found", "The asset was not found.", status_code=404) from exc
        if references:
            error = AssetError(
                "asset_still_referenced",
                "The asset is still referenced by article content.",
                status_code=409,
                details={"article_ids": references},
            )
            await self._record_rejection(
                project_id=project_id,
                target_id=asset_id,
                action="asset.delete_rejected",
                error=error,
                audit=audit,
            )
            raise error

    async def download_url(self, project_id: str, asset_id: str) -> str:
        authorization = await self.authorize_download(
            project_id, asset_id, disposition="attachment"
        )
        return authorization.url

    async def authorize_download(
        self,
        project_id: str,
        asset_id: str,
        *,
        disposition: str,
        variant_type: str | None = None,
    ) -> AssetDownloadAuthorizationResponse:
        row = await self.repository.get_asset_with_variants(project_id, asset_id)
        if row is None:
            raise AssetError("asset_not_found", "The asset was not found.", status_code=404)
        asset, variants = row
        if asset.status != "ready" or not asset.storage_key:
            raise AssetError("asset_not_ready", "The asset is not ready.", status_code=409)
        storage_key = asset.storage_key
        filename = asset.original_filename
        if variant_type is not None:
            variant = next(
                (
                    item
                    for item in variants
                    if item.variant_type == variant_type and item.status == "ready"
                ),
                None,
            )
            if variant is None:
                raise AssetError(
                    "asset_variant_not_found",
                    "The requested asset variant is not available.",
                    status_code=404,
                )
            storage_key = variant.storage_key
            stem = asset.original_filename.rsplit(".", 1)[0] or "asset"
            filename = f"{stem}-{variant.variant_type}.{variant.format}"
        expires_seconds = self.settings.asset_download_url_ttl_seconds
        url = await self.store.presigned_download_url(
            storage_key,
            filename,
            expires_seconds,
            disposition,
        )
        return AssetDownloadAuthorizationResponse(
            url=url,
            expires_at=datetime.now(UTC) + timedelta(seconds=expires_seconds),
        )

    @staticmethod
    def _require_idempotency_key(value: str) -> None:
        if not value or len(value) > 200 or not re.fullmatch(r"[A-Za-z0-9._:-]+", value):
            raise AssetError(
                "asset_idempotency_key_required",
                "A valid Idempotency-Key header is required.",
                status_code=400,
            )

    @staticmethod
    def _normalize_error(exc: AssetError | AssetSecurityError) -> AssetError:
        if isinstance(exc, AssetError):
            return exc
        return AssetError(
            exc.code,
            exc.detail,
            status_code=422,
            retryable=exc.retryable,
        )

    @staticmethod
    def _request_target(kind: str, idempotency_key: str) -> str:
        digest = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()[:20]
        return f"{kind}:{digest}"

    async def _record_rejection(
        self,
        *,
        project_id: str,
        target_id: str,
        action: str,
        error: AssetError,
        audit: AssetAuditContext | None,
    ) -> None:
        if audit is None:
            return
        await self.repository.record_rejection(
            project_id=project_id,
            target_id=target_id,
            action=action,
            reason=error.code,
            audit=audit,
        )

    @staticmethod
    def _upload_response(
        asset: ContentAsset, upload: AssetUploadSession, maximum: int
    ) -> AssetUploadCreateResponse:
        return AssetUploadCreateResponse(
            asset_id=asset.id,
            upload_id=upload.id,
            status=upload.status,
            part_size=upload.part_size,
            maximum_bytes=maximum,
            expires_at=upload.expires_at,
        )

    @staticmethod
    def _asset_response(
        asset: ContentAsset,
        variants: list,
        *,
        canonical_asset_id: str | None = None,
        active_reference_count: int = 0,
    ) -> AssetResponse:
        actions = []
        if asset.status in {"failed", "uploaded", "processing"}:
            actions.append("retry")
        if asset.status in {"pending", "uploading", "uploaded", "processing", "failed"}:
            actions.append("cancel")
        if asset.status == "ready":
            actions.extend(("download", "delete", "insert"))
        if asset.status not in {"pending_delete", "quarantined", "deleted"}:
            actions.append("edit_metadata")
        return AssetResponse(
            asset_id=asset.id,
            canonical_asset_id=canonical_asset_id or asset.canonical_asset_id,
            asset_type=asset.asset_type,
            status=asset.status,
            original_filename=asset.original_filename,
            title=asset.title,
            default_alt_text=asset.default_alt_text,
            caption=asset.caption,
            description=asset.description,
            mime_type=asset.mime_type,
            detected_mime_type=asset.detected_mime_type,
            byte_size=asset.byte_size,
            content_hash=asset.content_hash,
            width=asset.width,
            height=asset.height,
            duration_ms=asset.duration_ms,
            source_type=asset.source_type,
            source_url=_safe_source_url(asset.source_url),
            final_source_url=_safe_source_url(asset.final_source_url),
            provider_metadata=dict(asset.provider_metadata or {}),
            failure_code=asset.failure_code,
            failure_detail=asset.failure_detail,
            created_at=asset.created_at,
            updated_at=asset.updated_at or asset.created_at,
            ready_at=asset.ready_at,
            active_reference_count=active_reference_count,
            variants=[
                AssetVariantResponse(
                    variant_type=variant.variant_type,
                    format=variant.format,
                    width=variant.width,
                    height=variant.height,
                    byte_size=variant.byte_size,
                    status=variant.status,
                )
                for variant in variants
            ],
            actions=actions,
        )


class AssetProcessingDispatcher:
    def __init__(
        self,
        *,
        repository: AssetRepository,
        processor: AssetProcessor,
        settings: Settings,
        worker_id: str | None = None,
    ) -> None:
        self.repository = repository
        self.processor = processor
        self.settings = settings
        self.worker_id = worker_id or f"asset-worker-{uuid4().hex}"

    async def run_once(self, limit: int = 4) -> int:
        job_ids = await self.repository.claim_jobs(
            worker_id=self.worker_id,
            limit=limit,
            lease_seconds=self.settings.asset_processing_lease_seconds,
        )
        for job_id in job_ids:
            await self._run_job(job_id)
        cleanup_job_ids = await self.repository.claim_cleanup_jobs(
            worker_id=self.worker_id,
            limit=limit,
            lease_seconds=self.settings.asset_processing_lease_seconds,
        )
        for job_id in cleanup_job_ids:
            await self._run_cleanup_job(job_id)
        return len(job_ids) + len(cleanup_job_ids)

    async def run_forever(self) -> None:
        while True:
            try:
                claimed = await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                claimed = 0
            await asyncio.sleep(
                0 if claimed else self.settings.asset_processing_poll_seconds
            )

    async def _run_job(self, job_id: str) -> None:
        row = await self.repository.get_claimed_job(job_id, self.worker_id)
        if row is None:
            return
        job, asset, upload = row
        try:
            result = await self.processor.process(asset)
            if upload is not None and upload.expected_sha256 and (
                upload.expected_sha256 != result.content_hash
            ):
                await self._remove_generated_objects(
                    asset.id, list(result.generated_object_keys), "hash_mismatch"
                )
                raise AssetSecurityError(
                    "asset_hash_mismatch", "The completed upload checksum does not match."
                )
            try:
                await self.repository.complete_job(
                    job_id=job.id,
                    worker_id=self.worker_id,
                    detected_mime_type=result.detected_mime_type,
                    content_hash=result.content_hash,
                    byte_size=result.byte_size,
                    width=result.width,
                    height=result.height,
                    duration_ms=result.duration_ms,
                    storage_key=result.storage_key,
                    variants=result.variants,
                    final_source_url=result.final_source_url,
                    declared_mime_type=result.declared_mime_type,
                    generated_object_keys=list(result.generated_object_keys),
                    max_cleanup_attempts=self.settings.asset_cleanup_max_attempts,
                )
            except Exception:
                await self._remove_generated_objects(
                    asset.id, list(result.generated_object_keys), "database_commit_failed"
                )
                raise
        except AssetSecurityError as exc:
            logger.warning(
                "Content asset processing rejected",
                extra={
                    "asset_id": asset.id,
                    "asset_processing_job_id": job.id,
                    "asset_error_code": exc.code,
                    "asset_error_retryable": exc.retryable,
                    "asset_error_quarantined": exc.quarantined,
                },
            )
            await self._remove_generated_objects(
                asset.id,
                list(exc.generated_object_keys),
                "processing_failure",
            )
            await self.repository.fail_job(
                job_id=job.id,
                worker_id=self.worker_id,
                code=exc.code,
                detail=exc.detail,
                quarantined=exc.quarantined,
                retryable=exc.retryable,
            )
        except Exception:
            logger.exception(
                "Unable to process content asset",
                extra={"asset_id": asset.id, "asset_processing_job_id": job.id},
            )
            await self.repository.fail_job(
                job_id=job.id,
                worker_id=self.worker_id,
                code="asset_processing_failed",
                detail="The asset could not be processed.",
                quarantined=False,
                retryable=True,
            )

    async def _run_cleanup_job(self, job_id: str) -> None:
        row = await self.repository.get_claimed_cleanup_job(job_id, self.worker_id)
        if row is None:
            return
        job, _, references = row
        reference_sensitive = job.cleanup_type in {
            "asset_retention_delete",
            "canonical_duplicate",
            "cancelled_upload",
        }
        if reference_sensitive and references:
            await self.repository.complete_cleanup_job(
                job_id=job.id,
                worker_id=self.worker_id,
                deletion_blocked=True,
            )
            return
        try:
            for key in job.object_keys:
                await self.processor.store.delete(key)
            await self.repository.complete_cleanup_job(
                job_id=job.id,
                worker_id=self.worker_id,
                deletion_blocked=False,
            )
        except Exception:
            await self.repository.fail_cleanup_job(
                job_id=job.id,
                worker_id=self.worker_id,
                code="asset_cleanup_failed",
                detail="Stored asset objects could not be removed.",
            )

    async def _remove_generated_objects(
        self, asset_id: str, keys: list[str], cleanup_type: str
    ) -> None:
        remaining: list[str] = []
        for key in sorted(set(keys)):
            try:
                await self.processor.store.delete(key)
            except Exception:
                remaining.append(key)
        if remaining:
            await self.repository.queue_object_cleanup(
                asset_id=asset_id,
                object_keys=remaining,
                cleanup_type=cleanup_type,
                max_attempts=self.settings.asset_cleanup_max_attempts,
            )


def build_asset_service(settings: Settings | None = None) -> AssetService:
    resolved = settings or get_settings()
    return AssetService(
        repository=AssetRepository(session_factory),
        store=S3AssetObjectStore(resolved),
        settings=resolved,
    )


def build_asset_dispatcher(settings: Settings | None = None) -> AssetProcessingDispatcher:
    resolved = settings or get_settings()
    store = S3AssetObjectStore(resolved)
    repository = AssetRepository(session_factory)
    return AssetProcessingDispatcher(
        repository=repository,
        processor=AssetProcessor(resolved, store),
        settings=resolved,
    )
