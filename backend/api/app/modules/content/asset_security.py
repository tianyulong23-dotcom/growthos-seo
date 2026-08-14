from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import socket
import struct
import tempfile
import warnings
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
from mutagen import File as MutagenFile
from PIL import Image, ImageOps, UnidentifiedImageError

from app.core.config import Settings
from app.modules.content.models import AssetVariant, ContentAsset
from app.modules.content.object_storage import S3AssetObjectStore


DANGEROUS_EXTENSIONS = {
    ".app",
    ".bat",
    ".cmd",
    ".com",
    ".dll",
    ".dmg",
    ".exe",
    ".hta",
    ".html",
    ".htm",
    ".iso",
    ".jar",
    ".js",
    ".mjs",
    ".msi",
    ".ps1",
    ".scr",
    ".svg",
    ".vbs",
}

SUPPORTED_FILE_TYPES: dict[str, tuple[str, frozenset[str]]] = {
    ".jpg": ("image", frozenset({"image/jpeg"})),
    ".jpeg": ("image", frozenset({"image/jpeg"})),
    ".png": ("image", frozenset({"image/png"})),
    ".gif": ("image", frozenset({"image/gif"})),
    ".webp": ("image", frozenset({"image/webp"})),
    ".mp3": ("audio", frozenset({"audio/mpeg"})),
    ".wav": ("audio", frozenset({"audio/wav"})),
    ".ogg": ("audio", frozenset({"audio/ogg"})),
    ".oga": ("audio", frozenset({"audio/ogg"})),
    ".m4a": ("audio", frozenset({"audio/mp4"})),
    ".mp4": ("video", frozenset({"video/mp4"})),
    ".mov": ("video", frozenset({"video/quicktime"})),
    ".webm": ("video", frozenset({"video/webm"})),
    ".pdf": ("file", frozenset({"application/pdf"})),
    ".docx": (
        "file",
        frozenset(
            {
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            }
        ),
    ),
    ".xlsx": (
        "file",
        frozenset(
            {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}
        ),
    ),
    ".pptx": (
        "file",
        frozenset(
            {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            }
        ),
    ),
    ".zip": ("file", frozenset({"application/zip"})),
}

DECLARED_MIME_ALIASES = {
    "audio/x-m4a": "audio/mp4",
    "audio/x-wav": "audio/wav",
    "application/x-zip-compressed": "application/zip",
}

OOXML_SIGNATURES = {
    "word/document.xml": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ),
    "xl/workbook.xml": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ),
    "ppt/presentation.xml": (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ),
}


class AssetSecurityError(RuntimeError):
    def __init__(
        self,
        code: str,
        detail: str,
        *,
        quarantined: bool = False,
        retryable: bool = False,
        generated_object_keys: tuple[str, ...] = (),
    ) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.quarantined = quarantined
        self.retryable = retryable
        self.generated_object_keys = generated_object_keys


@dataclass(frozen=True)
class ProcessedAsset:
    detected_mime_type: str
    content_hash: str
    byte_size: int
    width: int | None
    height: int | None
    duration_ms: int | None
    storage_key: str
    variants: list[AssetVariant]
    final_source_url: str | None = None
    declared_mime_type: str | None = None
    generated_object_keys: tuple[str, ...] = ()


@dataclass(frozen=True)
class RemoteBytes:
    final_url: str
    content_type: str
    content: bytes


@dataclass(frozen=True)
class RemoteProbe:
    final_url: str
    status_code: int
    redirect_chain: tuple[str, ...]


def maximum_asset_bytes(settings: Settings, asset_type: str) -> int:
    return {
        "image": settings.asset_image_max_bytes,
        "audio": settings.asset_audio_max_bytes,
        "video": settings.asset_video_max_bytes,
        "file": settings.asset_file_max_bytes,
    }[asset_type]


def validate_filename(filename: str) -> None:
    suffix = Path(filename).suffix.lower()
    if suffix in DANGEROUS_EXTENSIONS:
        raise AssetSecurityError("asset_type_not_allowed", "This file type is not allowed.")
    if suffix not in SUPPORTED_FILE_TYPES:
        raise AssetSecurityError("asset_type_not_allowed", "This file type is not supported.")


def detect_mime(path: str) -> str:
    with open(path, "rb") as source:
        prefix = source.read(32)
    signatures = (
        (b"\xff\xd8\xff", "image/jpeg"),
        (b"\x89PNG\r\n\x1a\n", "image/png"),
        (b"GIF87a", "image/gif"),
        (b"GIF89a", "image/gif"),
        (b"%PDF-", "application/pdf"),
        (b"ID3", "audio/mpeg"),
        (b"OggS", "audio/ogg"),
    )
    for signature, mime in signatures:
        if prefix.startswith(signature):
            return mime
    if prefix.startswith(b"RIFF") and prefix[8:12] == b"WEBP":
        return "image/webp"
    if prefix.startswith(b"RIFF") and prefix[8:12] == b"WAVE":
        return "audio/wav"
    if prefix.startswith(b"\x1aE\xdf\xa3"):
        return "video/webm"
    if prefix.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(path) as archive:
                names = set(archive.namelist())
        except (OSError, zipfile.BadZipFile) as exc:
            raise AssetSecurityError(
                "asset_mime_mismatch", "The ZIP container is invalid."
            ) from exc
        package_parts = {"[Content_Types].xml", "_rels/.rels"}
        for required_part, mime in OOXML_SIGNATURES.items():
            if required_part in names:
                if not package_parts.issubset(names):
                    raise AssetSecurityError(
                        "asset_mime_mismatch", "The Office document container is incomplete."
                    )
                return mime
        return "application/zip"
    if len(prefix) >= 12 and prefix[4:8] == b"ftyp":
        brands = {prefix[8:12], *(prefix[index : index + 4] for index in range(16, len(prefix), 4))}
        if b"qt  " in brands:
            return "video/quicktime"
        if brands & {b"M4A ", b"M4B ", b"M4P "}:
            return "audio/mp4"
        return "video/mp4"
    if len(prefix) >= 2 and prefix[0] == 0xFF and prefix[1] & 0xE0 == 0xE0:
        layer = (prefix[1] >> 1) & 0x03
        if layer != 0:
            return "audio/mpeg"
    raise AssetSecurityError("asset_mime_mismatch", "The file signature is not supported.")


def validate_mime(asset: ContentAsset, detected: str) -> None:
    suffix = Path(asset.original_filename).suffix.lower()
    expected = SUPPORTED_FILE_TYPES.get(suffix)
    if expected is None:
        raise AssetSecurityError("asset_type_not_allowed", "This file type is not supported.")
    expected_asset_type, expected_mimes = expected
    declared = (asset.mime_type or "").lower().split(";", 1)[0].strip()
    declared = DECLARED_MIME_ALIASES.get(declared, declared)
    if asset.asset_type != expected_asset_type:
        raise AssetSecurityError(
            "asset_mime_mismatch", "The filename extension does not match the asset type."
        )
    if declared not in expected_mimes:
        raise AssetSecurityError(
            "asset_mime_mismatch", "The declared MIME type does not match the filename."
        )
    if detected not in expected_mimes:
        raise AssetSecurityError(
            "asset_mime_mismatch", "The file content does not match its filename and MIME type."
        )


def validate_import_source(
    asset: ContentAsset, final_url: str, declared: str, detected: str
) -> None:
    url_filename = Path(urlsplit(final_url).path).name
    suffix = Path(url_filename).suffix.lower()
    if not suffix:
        return
    expected = SUPPORTED_FILE_TYPES.get(suffix)
    if expected is None:
        raise AssetSecurityError(
            "asset_mime_mismatch", "The final URL file type is not supported."
        )
    expected_asset_type, expected_mimes = expected
    normalized_declared = DECLARED_MIME_ALIASES.get(declared, declared)
    if (
        asset.asset_type != expected_asset_type
        or normalized_declared not in expected_mimes
        or detected not in expected_mimes
    ):
        raise AssetSecurityError(
            "asset_mime_mismatch",
            "The final URL extension, response MIME type, requested asset type, and file content do not match.",
        )


class ClamAVScanner:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def scan(self, path: str) -> None:
        if not self.settings.asset_clamav_host:
            if self.settings.app_env == "production" or not (
                self.settings.asset_allow_unscanned_nonproduction
            ):
                raise AssetSecurityError(
                    "asset_scanner_unavailable",
                    "Malware scanning is required but unavailable.",
                    retryable=True,
                )
            return
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(
                    self.settings.asset_clamav_host, self.settings.asset_clamav_port
                ),
                timeout=10,
            )
            writer.write(b"zINSTREAM\x00")
            with open(path, "rb") as source:
                while chunk := source.read(64 * 1024):
                    writer.write(struct.pack(">I", len(chunk)))
                    writer.write(chunk)
                    await writer.drain()
            writer.write(struct.pack(">I", 0))
            await writer.drain()
            result = await asyncio.wait_for(reader.read(4096), timeout=30)
            writer.close()
            await writer.wait_closed()
        except AssetSecurityError:
            raise
        except Exception as exc:
            raise AssetSecurityError(
                "asset_scanner_unavailable", "Malware scanner could not be reached.", retryable=True
            ) from exc
        if b"FOUND" in result:
            raise AssetSecurityError(
                "asset_malware_rejected", "Malware was detected.", quarantined=True
            )
        if b"OK" not in result:
            raise AssetSecurityError(
                "asset_scanner_unavailable", "Malware scan did not complete.", retryable=True
            )


class SecureUrlImporter:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self.client = client

    async def download(self, url: str, destination: str, maximum_bytes: int) -> tuple[str, str]:
        current = url
        owned_client = self.client is None
        client = self.client or httpx.AsyncClient(
            timeout=self.settings.asset_import_timeout_seconds,
            follow_redirects=False,
            headers={"User-Agent": "GrowthOS-Asset-Importer/1.0"},
        )
        try:
            for redirect_count in range(self.settings.asset_import_max_redirects + 1):
                before = await self._validated_addresses(current)
                async with client.stream("GET", current) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location or redirect_count >= self.settings.asset_import_max_redirects:
                            raise AssetSecurityError(
                                "asset_import_redirect_rejected", "Redirect limit exceeded."
                            )
                        current = urljoin(current, location)
                        continue
                    response.raise_for_status()
                    after = await self._validated_addresses(current)
                    stream = response.extensions.get("network_stream")
                    peer = stream.get_extra_info("server_addr") if stream is not None else None
                    peer_ip = peer[0] if isinstance(peer, tuple) and peer else None
                    if before != after or (peer_ip is not None and peer_ip not in before):
                        raise AssetSecurityError(
                            "asset_import_ssrf_blocked", "The source host changed during import."
                        )
                    received = 0
                    with open(destination, "wb") as target:
                        async for chunk in response.aiter_bytes():
                            received += len(chunk)
                            if received > maximum_bytes:
                                raise AssetSecurityError(
                                    "asset_too_large", "The remote file exceeds the size limit."
                                )
                            target.write(chunk)
                    if received == 0:
                        raise AssetSecurityError(
                            "asset_processing_failed", "The remote file was empty."
                        )
                    return current, response.headers.get(
                        "content-type", "application/octet-stream"
                    ).split(";", 1)[0]
            raise AssetSecurityError("asset_import_redirect_rejected", "Redirect limit exceeded.")
        except httpx.HTTPError as exc:
            raise AssetSecurityError(
                "asset_import_failed", "The remote file could not be downloaded.", retryable=True
            ) from exc
        finally:
            if owned_client:
                await client.aclose()

    async def fetch_bytes(self, url: str, maximum_bytes: int) -> RemoteBytes:
        current = url
        owned_client = self.client is None
        client = self.client or httpx.AsyncClient(
            timeout=self.settings.asset_import_timeout_seconds,
            follow_redirects=False,
            headers={"User-Agent": "GrowthOS-Safe-Fetcher/1.0"},
        )
        try:
            for redirect_count in range(self.settings.asset_import_max_redirects + 1):
                before = await self._validated_addresses(current)
                async with client.stream("GET", current) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location or redirect_count >= self.settings.asset_import_max_redirects:
                            raise AssetSecurityError(
                                "asset_import_redirect_rejected", "Redirect limit exceeded."
                            )
                        current = urljoin(current, location)
                        continue
                    response.raise_for_status()
                    await self._validate_connected_peer(current, before, response)
                    declared_length = response.headers.get("content-length")
                    if declared_length and int(declared_length) > maximum_bytes:
                        raise AssetSecurityError(
                            "asset_too_large", "The remote response exceeds the size limit."
                        )
                    chunks: list[bytes] = []
                    received = 0
                    async for chunk in response.aiter_bytes():
                        received += len(chunk)
                        if received > maximum_bytes:
                            raise AssetSecurityError(
                                "asset_too_large", "The remote response exceeds the size limit."
                            )
                        chunks.append(chunk)
                    if received == 0:
                        raise AssetSecurityError(
                            "asset_processing_failed", "The remote response was empty."
                        )
                    return RemoteBytes(
                        final_url=current,
                        content_type=response.headers.get(
                            "content-type", "application/octet-stream"
                        ).split(";", 1)[0].lower(),
                        content=b"".join(chunks),
                    )
            raise AssetSecurityError("asset_import_redirect_rejected", "Redirect limit exceeded.")
        except (ValueError, httpx.HTTPError) as exc:
            raise AssetSecurityError(
                "asset_import_failed", "The remote response could not be downloaded.", retryable=True
            ) from exc
        finally:
            if owned_client:
                await client.aclose()

    async def probe(self, url: str) -> RemoteProbe:
        current = url
        redirects: list[str] = []
        owned_client = self.client is None
        client = self.client or httpx.AsyncClient(
            timeout=self.settings.asset_import_timeout_seconds,
            follow_redirects=False,
            headers={"User-Agent": "GrowthOS-Link-Checker/1.0"},
        )
        try:
            for redirect_count in range(self.settings.asset_import_max_redirects + 1):
                before = await self._validated_addresses(current)
                async with client.stream("GET", current) as response:
                    await self._validate_connected_peer(current, before, response)
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location or redirect_count >= self.settings.asset_import_max_redirects:
                            raise AssetSecurityError(
                                "asset_import_redirect_rejected", "Redirect limit exceeded."
                            )
                        redirects.append(current)
                        current = urljoin(current, location)
                        continue
                    return RemoteProbe(current, response.status_code, tuple(redirects))
            raise AssetSecurityError("asset_import_redirect_rejected", "Redirect limit exceeded.")
        except httpx.TimeoutException as exc:
            raise AssetSecurityError(
                "asset_import_timeout", "The remote host timed out.", retryable=True
            ) from exc
        except httpx.HTTPError as exc:
            raise AssetSecurityError(
                "asset_import_failed", "The remote host could not be checked.", retryable=True
            ) from exc
        finally:
            if owned_client:
                await client.aclose()

    async def _validate_connected_peer(
        self, url: str, before: frozenset[str], response: httpx.Response
    ) -> None:
        after = await self._validated_addresses(url)
        stream = response.extensions.get("network_stream")
        peer = stream.get_extra_info("server_addr") if stream is not None else None
        peer_ip = peer[0] if isinstance(peer, tuple) and peer else None
        if before != after or (peer_ip is not None and peer_ip not in before):
            raise AssetSecurityError(
                "asset_import_ssrf_blocked", "The source host changed during import."
            )

    async def _validated_addresses(self, url: str) -> frozenset[str]:
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise AssetSecurityError(
                "asset_import_ssrf_blocked", "Only public HTTP and HTTPS URLs are allowed."
            )
        if parsed.username or parsed.password:
            raise AssetSecurityError(
                "asset_import_ssrf_blocked", "Credential-bearing URLs are not allowed."
            )
        host = parsed.hostname.rstrip(".").lower()
        if host == "localhost" or host.endswith(".localhost"):
            raise AssetSecurityError("asset_import_ssrf_blocked", "Local addresses are not allowed.")
        try:
            addresses = await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: socket.getaddrinfo(
                    host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM
                ),
            )
        except socket.gaierror as exc:
            raise AssetSecurityError(
                "asset_import_failed", "The source host could not be resolved.", retryable=True
            ) from exc
        resolved = frozenset(address[4][0] for address in addresses)
        if not resolved or any(not ipaddress.ip_address(value).is_global for value in resolved):
            raise AssetSecurityError(
                "asset_import_ssrf_blocked", "Private and special-use addresses are not allowed."
            )
        return resolved


class AssetProcessor:
    def __init__(self, settings: Settings, store: S3AssetObjectStore) -> None:
        self.settings = settings
        self.store = store
        self.scanner = ClamAVScanner(settings)
        self.importer = SecureUrlImporter(settings)

    async def process(self, asset: ContentAsset) -> ProcessedAsset:
        validate_filename(asset.original_filename)
        maximum = maximum_asset_bytes(self.settings, asset.asset_type)
        with tempfile.TemporaryDirectory(prefix="growthos-asset-") as directory:
            source_path = os.path.join(directory, "source")
            if asset.source_type == "import":
                final_url, declared = await self.importer.download(
                    asset.source_url or "", source_path, maximum
                )
                asset.final_source_url = final_url
                asset.mime_type = declared
                byte_size = os.path.getsize(source_path)
            else:
                if not asset.storage_key:
                    raise AssetSecurityError(
                        "asset_processing_failed", "The uploaded object is unavailable."
                    )
                byte_size = await self.store.download_file(
                    asset.storage_key, source_path, maximum
                )
            await self.scanner.scan(source_path)
            content_hash = await asyncio.to_thread(self._sha256, source_path)
            detected = await asyncio.to_thread(detect_mime, source_path)
            validate_mime(asset, detected)
            if asset.source_type == "import" and asset.final_source_url:
                validate_import_source(
                    asset,
                    asset.final_source_url,
                    asset.mime_type or "application/octet-stream",
                    detected,
                )
            if asset.asset_type == "image":
                processed = await self._process_image(
                    asset, source_path, detected, content_hash, byte_size
                )
                return ProcessedAsset(
                    **{
                        **processed.__dict__,
                        "final_source_url": asset.final_source_url,
                        "declared_mime_type": asset.mime_type,
                    }
                )
            if asset.asset_type == "video":
                processed = await self._process_video(
                    asset, source_path, detected, content_hash, byte_size, directory
                )
                return ProcessedAsset(
                    **{
                        **processed.__dict__,
                        "final_source_url": asset.final_source_url,
                        "declared_mime_type": asset.mime_type,
                    }
                )
            duration_ms = None
            if asset.asset_type in {"audio", "video"}:
                media = await asyncio.to_thread(MutagenFile, source_path)
                if media is None or getattr(media, "info", None) is None:
                    raise AssetSecurityError(
                        "asset_processing_failed", "Media metadata could not be read."
                    )
                duration_ms = round(float(media.info.length) * 1000)
            if asset.source_type == "import":
                storage_key = f"assets/{asset.project_id}/{asset.id}/original"
                await self.store.upload_file(storage_key, source_path, detected)
            else:
                storage_key = asset.storage_key or ""
            return ProcessedAsset(
                detected,
                content_hash,
                byte_size,
                None,
                None,
                duration_ms,
                storage_key,
                [],
                asset.final_source_url,
                asset.mime_type,
                (storage_key,) if asset.source_type == "import" else (),
            )

    async def _process_image(
        self,
        asset: ContentAsset,
        source_path: str,
        detected: str,
        content_hash: str,
        byte_size: int,
    ) -> ProcessedAsset:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                Image.MAX_IMAGE_PIXELS = self.settings.asset_image_max_pixels
                with Image.open(source_path) as opened:
                    opened.verify()
                with Image.open(source_path) as opened:
                    image = ImageOps.exif_transpose(opened)
                    image.load()
                    width, height = image.size
                    if width * height > self.settings.asset_image_max_pixels:
                        raise AssetSecurityError(
                            "asset_too_large", "The image pixel count exceeds the limit."
                        )
                    output_format = "PNG" if detected == "image/png" else "JPEG"
                    if output_format == "JPEG" and image.mode not in {"RGB", "L"}:
                        image = image.convert("RGB")
                    clean = BytesIO()
                    image.save(clean, output_format, quality=92, optimize=True)
                    clean_body = clean.getvalue()
                    webp = BytesIO()
                    image.save(webp, "WEBP", quality=86, method=6)
                    webp_body = webp.getvalue()
                    thumb_image = image.copy()
                    thumb_image.thumbnail((640, 640))
                    thumbnail = BytesIO()
                    thumb_image.save(thumbnail, "WEBP", quality=82, method=6)
                    thumbnail_body = thumbnail.getvalue()
        except AssetSecurityError:
            raise
        except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
            raise AssetSecurityError("asset_too_large", "The image pixel count is unsafe.") from exc
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise AssetSecurityError(
                "asset_processing_failed", "The image could not be decoded."
            ) from exc
        storage_key = f"assets/{asset.project_id}/{asset.id}/original"
        webp_key = f"assets/{asset.project_id}/{asset.id}/webp-v1.webp"
        thumb_key = f"assets/{asset.project_id}/{asset.id}/thumbnail-v1.webp"
        generated: list[str] = []
        try:
            await self.store.write_bytes(storage_key, clean_body, detected)
            generated.append(storage_key)
            await self.store.write_bytes(webp_key, webp_body, "image/webp")
            generated.append(webp_key)
            await self.store.write_bytes(thumb_key, thumbnail_body, "image/webp")
            generated.append(thumb_key)
        except Exception as exc:
            raise AssetSecurityError(
                "asset_storage_write_failed",
                "Processed image variants could not be stored.",
                retryable=True,
                generated_object_keys=tuple(generated),
            ) from exc
        variants = [
            AssetVariant(
                id=os.urandom(16).hex(),
                asset_id=asset.id,
                variant_type="original",
                transform_version=1,
                format="png" if detected == "image/png" else "jpeg",
                storage_key=storage_key,
                content_hash=hashlib.sha256(clean_body).hexdigest(),
                width=width,
                height=height,
                byte_size=len(clean_body),
                status="ready",
            ),
            AssetVariant(
                id=os.urandom(16).hex(),
                asset_id=asset.id,
                variant_type="webp",
                transform_version=1,
                format="webp",
                storage_key=webp_key,
                content_hash=hashlib.sha256(webp_body).hexdigest(),
                width=width,
                height=height,
                byte_size=len(webp_body),
                status="ready",
            ),
            AssetVariant(
                id=os.urandom(16).hex(),
                asset_id=asset.id,
                variant_type="thumbnail",
                transform_version=1,
                format="webp",
                storage_key=thumb_key,
                content_hash=hashlib.sha256(thumbnail_body).hexdigest(),
                width=thumb_image.width,
                height=thumb_image.height,
                byte_size=len(thumbnail_body),
                status="ready",
            ),
        ]
        return ProcessedAsset(
            detected,
            content_hash,
            byte_size,
            width,
            height,
            None,
            storage_key,
            variants,
            generated_object_keys=(storage_key, webp_key, thumb_key),
        )

    async def _process_video(
        self,
        asset: ContentAsset,
        source_path: str,
        detected: str,
        content_hash: str,
        byte_size: int,
        directory: str,
    ) -> ProcessedAsset:
        source_metadata = await self._probe_media(source_path)
        video_stream = next(
            (
                stream
                for stream in source_metadata.get("streams", [])
                if stream.get("codec_type") == "video"
            ),
            None,
        )
        if video_stream is None:
            raise AssetSecurityError(
                "asset_media_metadata_invalid", "The video stream could not be read."
            )
        duration = self._media_duration_seconds(source_metadata, video_stream)
        if duration <= 0:
            raise AssetSecurityError(
                "asset_media_metadata_invalid", "The video duration is invalid."
            )

        output_path = os.path.join(directory, "video-v1.mp4")
        poster_path = os.path.join(directory, "poster-v1.jpg")
        await self._run_media_command(
            self.settings.asset_ffmpeg_path,
            "-nostdin",
            "-y",
            "-i",
            source_path,
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            output_path,
        )
        await self._run_media_command(
            self.settings.asset_ffmpeg_path,
            "-nostdin",
            "-y",
            "-ss",
            f"{min(max(duration * 0.1, 0.0), 5.0):.3f}",
            "-i",
            output_path,
            "-frames:v",
            "1",
            "-vf",
            "scale='min(1280,iw)':-2",
            "-q:v",
            "2",
            poster_path,
        )
        output_metadata = await self._probe_media(output_path)
        output_stream = next(
            (
                stream
                for stream in output_metadata.get("streams", [])
                if stream.get("codec_type") == "video"
            ),
            None,
        )
        if output_stream is None or output_stream.get("codec_name") != "h264":
            raise AssetSecurityError(
                "asset_media_output_invalid", "The compatible video output is invalid."
            )
        width = int(output_stream.get("width") or 0)
        height = int(output_stream.get("height") or 0)
        if width <= 0 or height <= 0:
            raise AssetSecurityError(
                "asset_media_output_invalid", "The compatible video dimensions are invalid."
            )
        duration_ms = round(
            self._media_duration_seconds(output_metadata, output_stream) * 1000
        )
        with Image.open(poster_path) as poster:
            poster.load()
            poster_width, poster_height = poster.size

        video_key = f"assets/{asset.project_id}/{asset.id}/video-v1.mp4"
        poster_key = f"assets/{asset.project_id}/{asset.id}/poster-v1.jpg"
        generated: list[str] = []
        try:
            await self.store.upload_file(video_key, output_path, "video/mp4")
            generated.append(video_key)
            await self.store.upload_file(poster_key, poster_path, "image/jpeg")
            generated.append(poster_key)
        except Exception as exc:
            raise AssetSecurityError(
                "asset_storage_write_failed",
                "Processed video variants could not be stored.",
                retryable=True,
                generated_object_keys=tuple(generated),
            ) from exc
        video_hash = await asyncio.to_thread(self._sha256, output_path)
        poster_hash = await asyncio.to_thread(self._sha256, poster_path)
        output_size = os.path.getsize(output_path)
        poster_size = os.path.getsize(poster_path)
        variants = [
            AssetVariant(
                id=os.urandom(16).hex(),
                asset_id=asset.id,
                variant_type="video_mp4",
                transform_version=1,
                format="mp4",
                storage_key=video_key,
                content_hash=video_hash,
                width=width,
                height=height,
                byte_size=output_size,
                status="ready",
            ),
            AssetVariant(
                id=os.urandom(16).hex(),
                asset_id=asset.id,
                variant_type="poster",
                transform_version=1,
                format="jpeg",
                storage_key=poster_key,
                content_hash=poster_hash,
                width=poster_width,
                height=poster_height,
                byte_size=poster_size,
                status="ready",
            ),
        ]
        return ProcessedAsset(
            detected_mime_type=detected,
            content_hash=content_hash,
            byte_size=byte_size,
            width=width,
            height=height,
            duration_ms=duration_ms,
            storage_key=video_key,
            variants=variants,
            generated_object_keys=(video_key, poster_key),
        )

    async def _probe_media(self, path: str) -> dict:
        output = await self._run_media_command(
            self.settings.asset_ffprobe_path,
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            path,
            capture_stdout=True,
        )
        try:
            value = json.loads(output.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AssetSecurityError(
                "asset_media_metadata_invalid", "Media metadata could not be decoded."
            ) from exc
        if not isinstance(value, dict):
            raise AssetSecurityError(
                "asset_media_metadata_invalid", "Media metadata is invalid."
            )
        return value

    async def _run_media_command(
        self, executable: str, *arguments: str, capture_stdout: bool = False
    ) -> bytes:
        try:
            process = await asyncio.create_subprocess_exec(
                executable,
                *arguments,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=(asyncio.subprocess.PIPE if capture_stdout else asyncio.subprocess.DEVNULL),
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise AssetSecurityError(
                "asset_media_tool_unavailable",
                "The configured media processing tool is unavailable.",
                retryable=True,
            ) from exc
        try:
            stdout, _ = await asyncio.wait_for(
                process.communicate(),
                timeout=self.settings.asset_media_process_timeout_seconds,
            )
        except TimeoutError as exc:
            process.kill()
            await process.communicate()
            raise AssetSecurityError(
                "asset_media_processing_timeout",
                "Media processing exceeded the configured time limit.",
                retryable=True,
            ) from exc
        if process.returncode != 0:
            raise AssetSecurityError(
                "asset_media_processing_failed", "Media processing did not complete."
            )
        return stdout or b""

    @staticmethod
    def _media_duration_seconds(metadata: dict, stream: dict) -> float:
        raw = stream.get("duration") or metadata.get("format", {}).get("duration") or 0
        try:
            return float(raw)
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def _sha256(path: str) -> str:
        digest = hashlib.sha256()
        with open(path, "rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        return digest.hexdigest()
