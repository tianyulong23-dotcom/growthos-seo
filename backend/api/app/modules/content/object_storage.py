from __future__ import annotations

import asyncio
import gzip
import json
import os
from dataclasses import dataclass
from io import BytesIO
from typing import Any, BinaryIO
from urllib.parse import unquote, urlsplit

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.core.config import Settings


class StoredTextError(Exception):
    code = "object_read_failed"


class StoredTextNotFoundError(StoredTextError):
    code = "object_not_found"


class StoredTextCorruptError(StoredTextError):
    code = "object_corrupt"


class StoredTextTooLargeError(StoredTextError):
    code = "object_too_large"


class ObjectWriteError(Exception):
    code = "object_write_failed"


class AssetObjectError(Exception):
    code = "asset_object_failed"


class AssetObjectNotFoundError(AssetObjectError):
    code = "asset_object_not_found"


class AssetObjectTooLargeError(AssetObjectError):
    code = "asset_too_large"


@dataclass(frozen=True)
class StoredText:
    text: str
    byte_count: int


@dataclass(frozen=True)
class AssetObjectHead:
    byte_size: int
    content_type: str | None
    etag: str | None


@dataclass(frozen=True)
class UploadedPart:
    part_number: int
    etag: str
    byte_size: int


class S3TextReader:
    def __init__(self, settings: Settings, max_bytes: int | None = None) -> None:
        self.settings = settings
        self.max_bytes = max_bytes or settings.article_source_text_max_bytes

    async def read_text(self, reference: str) -> StoredText:
        bucket, key = self._parse_reference(reference)
        return await asyncio.to_thread(self._read_object, bucket, key)

    @staticmethod
    def _parse_reference(reference: str) -> tuple[str, str]:
        parsed = urlsplit(reference)
        if parsed.scheme != "s3" or not parsed.netloc or not parsed.path.strip("/"):
            raise StoredTextError("invalid object reference")
        return parsed.netloc, unquote(parsed.path.lstrip("/"))

    def _read_object(self, bucket: str, key: str) -> StoredText:
        options: dict = {
            "service_name": "s3",
            "region_name": self.settings.s3_region,
            "config": Config(
                s3={
                    "addressing_style": (
                        "path" if self.settings.s3_use_path_style else "auto"
                    )
                }
            ),
        }
        if self.settings.s3_endpoint_url:
            options["endpoint_url"] = self.settings.s3_endpoint_url
        if self.settings.s3_access_key_id and self.settings.s3_secret_access_key:
            options["aws_access_key_id"] = self.settings.s3_access_key_id
            options["aws_secret_access_key"] = self.settings.s3_secret_access_key
        client = boto3.client(**options)
        try:
            response = client.get_object(Bucket=bucket, Key=key)
            is_gzip = key.lower().endswith(".gz") or response.get("ContentEncoding") == "gzip"
            body = response["Body"]
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in {"NoSuchKey", "NoSuchObject", "404"}:
                raise StoredTextNotFoundError("object not found") from exc
            raise StoredTextError("object read failed") from exc
        except Exception as exc:
            raise StoredTextError("object read failed") from exc

        try:
            decoded = (
                self._decompress_limited(body)
                if is_gzip
                else body.read(self.max_bytes + 1)
            )
            if len(decoded) > self.max_bytes:
                raise StoredTextTooLargeError("object exceeds text limit")
            return StoredText(decoded.decode("utf-8"), len(decoded))
        except StoredTextError:
            raise
        except (gzip.BadGzipFile, EOFError, UnicodeDecodeError, OSError) as exc:
            raise StoredTextCorruptError("object is corrupt") from exc

    def _decompress_limited(self, body: Any) -> bytes:
        try:
            with gzip.GzipFile(fileobj=body) as compressed:
                decoded = compressed.read(self.max_bytes + 1)
        except (gzip.BadGzipFile, EOFError, OSError) as exc:
            raise StoredTextCorruptError("object is corrupt") from exc
        if len(decoded) > self.max_bytes:
            raise StoredTextTooLargeError("object exceeds text limit")
        return decoded


class S3JSONWriter:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def write_json(self, key: str, value: dict[str, Any]) -> str:
        return await asyncio.to_thread(self._write_object, key, value)

    def _write_object(self, key: str, value: dict[str, Any]) -> str:
        client = boto3.client(**_s3_options(self.settings))
        body = gzip.compress(
            json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        )
        try:
            client.put_object(
                Bucket=self.settings.s3_bucket,
                Key=key,
                Body=body,
                ContentType="application/json",
                ContentEncoding="gzip",
            )
        except Exception as exc:
            raise ObjectWriteError("object write failed") from exc
        return f"s3://{self.settings.s3_bucket}/{key}"


class S3ArtifactStore:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.reader = S3TextReader(settings)
        self.json_writer = S3JSONWriter(settings)

    async def write_json(self, key: str, value: dict[str, Any]) -> str:
        return await self.json_writer.write_json(key, value)

    async def read_json(self, reference: str) -> dict[str, Any]:
        stored = await self.reader.read_text(reference)
        try:
            value = json.loads(stored.text)
        except json.JSONDecodeError as exc:
            raise StoredTextCorruptError("object is not valid JSON") from exc
        if not isinstance(value, dict):
            raise StoredTextCorruptError("JSON artifact must be an object")
        return value

    async def write_text(self, key: str, value: str) -> str:
        return await asyncio.to_thread(self._write_text_object, key, value)

    async def read_text(self, reference: str) -> str:
        return (await self.reader.read_text(reference)).text

    def _write_text_object(self, key: str, value: str) -> str:
        client = boto3.client(**_s3_options(self.settings))
        try:
            client.put_object(
                Bucket=self.settings.s3_bucket,
                Key=key,
                Body=value.encode("utf-8"),
                ContentType="text/markdown; charset=utf-8",
            )
        except Exception as exc:
            raise ObjectWriteError("object write failed") from exc
        return f"s3://{self.settings.s3_bucket}/{key}"


class S3AssetObjectStore:
    """Binary object operations used by resumable content-asset uploads."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def create_multipart_upload(self, key: str, content_type: str) -> str:
        return await asyncio.to_thread(self._create_multipart_upload, key, content_type)

    async def upload_part(
        self,
        key: str,
        upload_id: str,
        part_number: int,
        body: bytes,
    ) -> UploadedPart:
        return await asyncio.to_thread(
            self._upload_part, key, upload_id, part_number, body
        )

    async def complete_multipart_upload(
        self,
        key: str,
        upload_id: str,
        parts: list[UploadedPart],
    ) -> AssetObjectHead:
        return await asyncio.to_thread(
            self._complete_multipart_upload, key, upload_id, parts
        )

    async def abort_multipart_upload(self, key: str, upload_id: str) -> None:
        await asyncio.to_thread(self._abort_multipart_upload, key, upload_id)

    async def head(self, key: str) -> AssetObjectHead:
        return await asyncio.to_thread(self._head, key)

    async def read_bytes(self, key: str, max_bytes: int) -> bytes:
        return await asyncio.to_thread(self._read_bytes, key, max_bytes)

    async def write_bytes(self, key: str, body: bytes, content_type: str) -> None:
        await asyncio.to_thread(self._write_bytes, key, body, content_type)

    async def upload_file(self, key: str, path: str, content_type: str) -> None:
        await asyncio.to_thread(self._upload_file, key, path, content_type)

    async def download_file(self, key: str, path: str, max_bytes: int) -> int:
        return await asyncio.to_thread(self._download_file, key, path, max_bytes)

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self._delete, key)

    async def presigned_download_url(
        self,
        key: str,
        filename: str,
        expires_seconds: int = 300,
        disposition: str = "attachment",
    ) -> str:
        return await asyncio.to_thread(
            self._presigned_download_url,
            key,
            filename,
            expires_seconds,
            disposition,
        )

    def _client(self):
        return boto3.client(**_s3_options(self.settings))

    def _create_multipart_upload(self, key: str, content_type: str) -> str:
        try:
            response = self._client().create_multipart_upload(
                Bucket=self.settings.s3_bucket,
                Key=key,
                ContentType=content_type,
            )
            return str(response["UploadId"])
        except Exception as exc:
            raise AssetObjectError("unable to initialize multipart upload") from exc

    def _upload_part(
        self,
        key: str,
        upload_id: str,
        part_number: int,
        body: bytes,
    ) -> UploadedPart:
        try:
            response = self._client().upload_part(
                Bucket=self.settings.s3_bucket,
                Key=key,
                UploadId=upload_id,
                PartNumber=part_number,
                Body=body,
            )
            etag = str(response["ETag"]).strip('"')
            return UploadedPart(part_number=part_number, etag=etag, byte_size=len(body))
        except Exception as exc:
            raise AssetObjectError("unable to upload object part") from exc

    def _complete_multipart_upload(
        self,
        key: str,
        upload_id: str,
        parts: list[UploadedPart],
    ) -> AssetObjectHead:
        if not parts or [part.part_number for part in parts] != sorted(
            {part.part_number for part in parts}
        ):
            raise AssetObjectError("multipart parts must be unique and ordered")
        try:
            self._client().complete_multipart_upload(
                Bucket=self.settings.s3_bucket,
                Key=key,
                UploadId=upload_id,
                MultipartUpload={
                    "Parts": [
                        {"ETag": part.etag, "PartNumber": part.part_number}
                        for part in parts
                    ]
                },
            )
            return self._head(key)
        except AssetObjectError:
            raise
        except Exception as exc:
            raise AssetObjectError("unable to complete multipart upload") from exc

    def _abort_multipart_upload(self, key: str, upload_id: str) -> None:
        try:
            self._client().abort_multipart_upload(
                Bucket=self.settings.s3_bucket,
                Key=key,
                UploadId=upload_id,
            )
        except Exception as exc:
            raise AssetObjectError("unable to abort multipart upload") from exc

    def _head(self, key: str) -> AssetObjectHead:
        try:
            response = self._client().head_object(
                Bucket=self.settings.s3_bucket,
                Key=key,
            )
            return AssetObjectHead(
                byte_size=int(response["ContentLength"]),
                content_type=response.get("ContentType"),
                etag=(str(response["ETag"]).strip('"') if response.get("ETag") else None),
            )
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in {"NoSuchKey", "NoSuchObject", "404"}:
                raise AssetObjectNotFoundError("asset object not found") from exc
            raise AssetObjectError("unable to inspect asset object") from exc
        except Exception as exc:
            raise AssetObjectError("unable to inspect asset object") from exc

    def _read_bytes(self, key: str, max_bytes: int) -> bytes:
        try:
            response = self._client().get_object(
                Bucket=self.settings.s3_bucket,
                Key=key,
            )
            body: BinaryIO = response["Body"]
            value = body.read(max_bytes + 1)
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in {"NoSuchKey", "NoSuchObject", "404"}:
                raise AssetObjectNotFoundError("asset object not found") from exc
            raise AssetObjectError("unable to read asset object") from exc
        except Exception as exc:
            raise AssetObjectError("unable to read asset object") from exc
        if len(value) > max_bytes:
            raise AssetObjectTooLargeError("asset object exceeds configured limit")
        return value

    def _write_bytes(self, key: str, body: bytes, content_type: str) -> None:
        try:
            self._client().put_object(
                Bucket=self.settings.s3_bucket,
                Key=key,
                Body=BytesIO(body),
                ContentType=content_type,
            )
        except Exception as exc:
            raise AssetObjectError("unable to write asset object") from exc

    def _upload_file(self, key: str, path: str, content_type: str) -> None:
        try:
            with open(path, "rb") as source:
                self._client().upload_fileobj(
                    source,
                    self.settings.s3_bucket,
                    key,
                    ExtraArgs={"ContentType": content_type},
                )
        except Exception as exc:
            raise AssetObjectError("unable to upload asset file") from exc

    def _download_file(self, key: str, path: str, max_bytes: int) -> int:
        head = self._head(key)
        if head.byte_size > max_bytes:
            raise AssetObjectTooLargeError("asset object exceeds configured limit")
        try:
            with open(path, "wb") as destination:
                self._client().download_fileobj(
                    self.settings.s3_bucket,
                    key,
                    destination,
                )
            byte_size = os.path.getsize(path)
        except Exception as exc:
            raise AssetObjectError("unable to download asset file") from exc
        if byte_size > max_bytes:
            try:
                os.remove(path)
            except OSError:
                pass
            raise AssetObjectTooLargeError("asset object exceeds configured limit")
        return byte_size

    def _delete(self, key: str) -> None:
        try:
            self._client().delete_object(Bucket=self.settings.s3_bucket, Key=key)
        except Exception as exc:
            raise AssetObjectError("unable to delete asset object") from exc

    def _presigned_download_url(
        self,
        key: str,
        filename: str,
        expires_seconds: int,
        disposition: str,
    ) -> str:
        safe_name = filename.replace("\r", "").replace("\n", "").replace('"', "'")
        content_disposition = (
            "inline" if disposition == "inline" else f'attachment; filename="{safe_name}"'
        )
        try:
            return str(
                self._client().generate_presigned_url(
                    "get_object",
                    Params={
                        "Bucket": self.settings.s3_bucket,
                        "Key": key,
                        "ResponseContentDisposition": content_disposition,
                    },
                    ExpiresIn=expires_seconds,
                )
            )
        except Exception as exc:
            raise AssetObjectError("unable to sign asset download") from exc


def _s3_options(settings: Settings) -> dict[str, Any]:
    options: dict[str, Any] = {
        "service_name": "s3",
        "region_name": settings.s3_region,
        "config": Config(
            s3={"addressing_style": "path" if settings.s3_use_path_style else "auto"}
        ),
    }
    if settings.s3_endpoint_url:
        options["endpoint_url"] = settings.s3_endpoint_url
    if settings.s3_access_key_id and settings.s3_secret_access_key:
        options["aws_access_key_id"] = settings.s3_access_key_id
        options["aws_secret_access_key"] = settings.s3_secret_access_key
    return options
