import asyncio
import io
import json
import shutil
import socket
import subprocess
import sys
import zipfile
from pathlib import Path

import httpx
import pytest
from PIL import Image

from app.core.config import Settings
from app.modules.content.asset_security import (
    AssetProcessor,
    AssetSecurityError,
    SecureUrlImporter,
    detect_mime,
    validate_filename,
    validate_import_source,
    validate_mime,
)
from app.modules.content.models import ContentAsset


class MemoryAssetStore:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.writes: dict[str, tuple[bytes, str]] = {}
        self.deleted: list[str] = []

    async def download_file(self, key: str, path: str, max_bytes: int) -> int:
        assert key == "incoming/image"
        assert len(self.body) <= max_bytes
        Path(path).write_bytes(self.body)
        return len(self.body)

    async def write_bytes(self, key: str, body: bytes, content_type: str) -> None:
        self.writes[key] = (body, content_type)

    async def delete(self, key: str) -> None:
        self.deleted.append(key)


class MediaAssetStore:
    def __init__(self, body: bytes, *, fail_upload_number: int | None = None) -> None:
        self.body = body
        self.uploads: dict[str, tuple[bytes, str]] = {}
        self.upload_count = 0
        self.fail_upload_number = fail_upload_number

    async def download_file(self, key: str, path: str, max_bytes: int) -> int:
        assert key == "incoming/video"
        assert len(self.body) <= max_bytes
        Path(path).write_bytes(self.body)
        return len(self.body)

    async def upload_file(self, key: str, path: str, content_type: str) -> None:
        self.upload_count += 1
        if self.upload_count == self.fail_upload_number:
            raise RuntimeError("object write failed")
        self.uploads[key] = (Path(path).read_bytes(), content_type)


def video_asset(*, filename: str, declared_mime_type: str) -> ContentAsset:
    return ContentAsset(
        id=f"ast-{Path(filename).suffix[1:]}",
        project_id="project-a",
        asset_type="video",
        status="processing",
        original_filename=filename,
        mime_type=declared_mime_type,
        byte_size=100,
        storage_key="incoming/video",
        source_type="upload",
        created_by="user-a",
    )


def ffmpeg_tools() -> tuple[str, str]:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("ffmpeg and ffprobe are required for the media integration gate")
    return ffmpeg, ffprobe


def generate_video(path: Path, container: str) -> None:
    ffmpeg, _ = ffmpeg_tools()
    codecs = {
        "mp4": ("libx264", "aac"),
        "mov": ("mpeg4", "aac"),
        "webm": ("libvpx-vp9", "libopus"),
    }
    video_codec, audio_codec = codecs[container]
    subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x180:rate=24:duration=1.2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:duration=1.2",
            "-shortest",
            "-c:v",
            video_codec,
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            audio_codec,
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def probe_bytes(tmp_path: Path, body: bytes) -> dict:
    _, ffprobe = ffmpeg_tools()
    output = tmp_path / "probe.mp4"
    output.write_bytes(body)
    completed = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(output),
        ],
        check=True,
        capture_output=True,
    )
    return json.loads(completed.stdout)


def image_asset() -> ContentAsset:
    return ContentAsset(
        id="ast-image",
        project_id="project-a",
        asset_type="image",
        status="processing",
        original_filename="photo.jpg",
        mime_type="image/jpeg",
        byte_size=100,
        storage_key="incoming/image",
        source_type="upload",
        created_by="user-a",
    )


def typed_asset(
    *, filename: str, asset_type: str, declared_mime_type: str
) -> ContentAsset:
    return ContentAsset(
        id=f"ast-{asset_type}",
        project_id="project-a",
        asset_type=asset_type,
        status="processing",
        original_filename=filename,
        mime_type=declared_mime_type,
        byte_size=100,
        storage_key="incoming/image",
        source_type="upload",
        created_by="user-a",
    )


def zip_container(*names: str) -> bytes:
    body = io.BytesIO()
    with zipfile.ZipFile(body, "w") as archive:
        for name in names:
            archive.writestr(name, b"content")
    return body.getvalue()


def jpeg_with_exif() -> bytes:
    image = Image.new("RGB", (1200, 800), color=(20, 80, 140))
    exif = Image.Exif()
    exif[0x010F] = "private-camera"
    body = io.BytesIO()
    image.save(body, "JPEG", exif=exif)
    return body.getvalue()


def test_rejects_dangerous_extensions_and_mime_spoofing(tmp_path: Path) -> None:
    with pytest.raises(AssetSecurityError, match="not allowed") as extension_error:
        validate_filename("payload.svg")
    assert extension_error.value.code == "asset_type_not_allowed"

    executable = tmp_path / "photo.jpg"
    executable.write_bytes(b"MZ" + (b"\x00" * 30))
    with pytest.raises(AssetSecurityError) as signature_error:
        detect_mime(str(executable))
    assert signature_error.value.code == "asset_mime_mismatch"

    png = tmp_path / "photo.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + (b"\x00" * 24))
    asset = image_asset()
    with pytest.raises(AssetSecurityError) as mime_error:
        validate_mime(asset, detect_mime(str(png)))
    assert mime_error.value.code == "asset_mime_mismatch"


@pytest.mark.parametrize(
    ("filename", "declared_mime", "body", "detected_mime"),
    [
        ("voice.mp3", "audio/mpeg", b"\xff\xfb\x90\x64" + b"\x00" * 28, "audio/mpeg"),
        ("voice.wav", "audio/x-wav", b"RIFF\x20\x00\x00\x00WAVE" + b"\x00" * 20, "audio/wav"),
        ("voice.ogg", "audio/ogg", b"OggS" + b"\x00" * 28, "audio/ogg"),
        ("voice.m4a", "audio/x-m4a", b"\x00\x00\x00\x20ftypM4A " + b"\x00" * 20, "audio/mp4"),
        ("movie.mp4", "video/mp4", b"\x00\x00\x00\x20ftypisom" + b"\x00" * 20, "video/mp4"),
        ("movie.mov", "video/quicktime", b"\x00\x00\x00\x20ftypqt  " + b"\x00" * 20, "video/quicktime"),
        ("movie.webm", "video/webm", b"\x1aE\xdf\xa3" + b"\x00" * 28, "video/webm"),
        ("document.pdf", "application/pdf", b"%PDF-1.7" + b"\x00" * 24, "application/pdf"),
    ],
)
def test_detects_supported_media_and_validates_three_way_contract(
    tmp_path: Path,
    filename: str,
    declared_mime: str,
    body: bytes,
    detected_mime: str,
) -> None:
    source = tmp_path / filename
    source.write_bytes(body)
    detected = detect_mime(str(source))
    assert detected == detected_mime
    validate_mime(
        typed_asset(
            filename=filename,
            asset_type="audio" if filename.endswith((".mp3", ".wav", ".ogg", ".m4a")) else (
                "video" if filename.endswith((".mp4", ".mov", ".webm")) else "file"
            ),
            declared_mime_type=declared_mime,
        ),
        detected,
    )


@pytest.mark.parametrize(
    ("filename", "declared_mime", "required_part", "detected_mime"),
    [
        (
            "document.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "word/document.xml",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
        (
            "workbook.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "xl/workbook.xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        (
            "slides.pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "ppt/presentation.xml",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
    ],
)
def test_ooxml_requires_real_package_entries(
    tmp_path: Path,
    filename: str,
    declared_mime: str,
    required_part: str,
    detected_mime: str,
) -> None:
    source = tmp_path / filename
    source.write_bytes(zip_container("[Content_Types].xml", "_rels/.rels", required_part))
    detected = detect_mime(str(source))
    assert detected == detected_mime
    validate_mime(
        typed_asset(
            filename=filename,
            asset_type="file",
            declared_mime_type=declared_mime,
        ),
        detected,
    )


def test_zip_cannot_impersonate_ooxml_and_extension_must_match_type(
    tmp_path: Path,
) -> None:
    disguised = tmp_path / "disguised.docx"
    disguised.write_bytes(zip_container("notes.txt"))
    detected = detect_mime(str(disguised))
    assert detected == "application/zip"
    with pytest.raises(AssetSecurityError) as ooxml_error:
        validate_mime(
            typed_asset(
                filename="disguised.docx",
                asset_type="file",
                declared_mime_type=(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                ),
            ),
            detected,
        )
    assert ooxml_error.value.code == "asset_mime_mismatch"

    with pytest.raises(AssetSecurityError) as type_error:
        validate_mime(
            typed_asset(
                filename="movie.mp4",
                asset_type="audio",
                declared_mime_type="video/mp4",
            ),
            "video/mp4",
        )
    assert type_error.value.code == "asset_mime_mismatch"


def test_image_processing_removes_exif_and_generates_real_variants() -> None:
    async def scenario() -> None:
        source = jpeg_with_exif()
        store = MemoryAssetStore(source)
        processor = AssetProcessor(
            Settings(app_env="test", asset_allow_unscanned_nonproduction=True), store  # type: ignore[arg-type]
        )

        result = await processor.process(image_asset())

        assert result.width == 1200
        assert result.height == 800
        assert [variant.variant_type for variant in result.variants] == [
            "original",
            "webp",
            "thumbnail",
        ]
        assert store.deleted == []
        assert result.generated_object_keys == (
            "assets/project-a/ast-image/original",
            "assets/project-a/ast-image/webp-v1.webp",
            "assets/project-a/ast-image/thumbnail-v1.webp",
        )
        clean_original = store.writes["assets/project-a/ast-image/original"][0]
        with Image.open(io.BytesIO(clean_original)) as cleaned:
            assert cleaned.getexif().get(0x010F) is None
        webp = store.writes["assets/project-a/ast-image/webp-v1.webp"][0]
        thumbnail = store.writes["assets/project-a/ast-image/thumbnail-v1.webp"][0]
        with Image.open(io.BytesIO(webp)) as converted:
            assert converted.size == (1200, 800)
        with Image.open(io.BytesIO(thumbnail)) as thumb:
            assert max(thumb.size) == 640

    asyncio.run(scenario())


def test_image_pixel_bomb_is_rejected() -> None:
    async def scenario() -> None:
        image = Image.new("RGB", (1001, 1001), color="white")
        body = io.BytesIO()
        image.save(body, "JPEG")
        store = MemoryAssetStore(body.getvalue())
        processor = AssetProcessor(
            Settings(
                app_env="test",
                asset_image_max_pixels=1_000_000,
                asset_allow_unscanned_nonproduction=True,
            ),
            store,  # type: ignore[arg-type]
        )

        with pytest.raises(AssetSecurityError) as error:
            await processor.process(image_asset())
        assert error.value.code == "asset_too_large"
        assert store.writes == {}

    asyncio.run(scenario())


def test_production_cannot_mark_unscanned_asset_ready() -> None:
    async def scenario() -> None:
        processor = AssetProcessor(Settings(app_env="production"), MemoryAssetStore(jpeg_with_exif()))  # type: ignore[arg-type]
        with pytest.raises(AssetSecurityError) as error:
            await processor.process(image_asset())
        assert error.value.code == "asset_scanner_unavailable"
        assert error.value.retryable is True

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("container", "filename", "declared_mime_type"),
    [
        ("mp4", "movie.mp4", "video/mp4"),
        ("mov", "movie.mov", "video/quicktime"),
        ("webm", "movie.webm", "video/webm"),
    ],
)
def test_video_processing_produces_compatible_faststart_mp4_and_jpeg_poster(
    tmp_path: Path,
    container: str,
    filename: str,
    declared_mime_type: str,
) -> None:
    async def scenario() -> None:
        source = tmp_path / filename
        generate_video(source, container)
        store = MediaAssetStore(source.read_bytes())
        ffmpeg, ffprobe = ffmpeg_tools()
        processor = AssetProcessor(
            Settings(
                app_env="test",
                asset_allow_unscanned_nonproduction=True,
                asset_ffmpeg_path=ffmpeg,
                asset_ffprobe_path=ffprobe,
            ),
            store,  # type: ignore[arg-type]
        )

        result = await processor.process(
            video_asset(filename=filename, declared_mime_type=declared_mime_type)
        )

        assert result.width == 320
        assert result.height == 180
        assert 900 <= (result.duration_ms or 0) <= 1_500
        assert [variant.variant_type for variant in result.variants] == [
            "video_mp4",
            "poster",
        ]
        video_body, video_type = store.uploads[result.storage_key]
        assert video_type == "video/mp4"
        metadata = probe_bytes(tmp_path, video_body)
        video_stream = next(
            stream for stream in metadata["streams"] if stream["codec_type"] == "video"
        )
        audio_stream = next(
            stream for stream in metadata["streams"] if stream["codec_type"] == "audio"
        )
        assert metadata["format"]["format_name"].startswith("mov,mp4")
        assert video_stream["codec_name"] == "h264"
        assert video_stream["pix_fmt"] == "yuv420p"
        assert audio_stream["codec_name"] == "aac"
        assert video_body.find(b"moov") < video_body.find(b"mdat")
        poster_key = next(key for key in store.uploads if key.endswith("poster-v1.jpg"))
        poster_body, poster_type = store.uploads[poster_key]
        assert poster_type == "image/jpeg"
        with Image.open(io.BytesIO(poster_body)) as poster:
            poster.load()
            assert poster.format == "JPEG"
            assert poster.size == (320, 180)

    asyncio.run(scenario())


def test_media_command_has_stable_unavailable_failure_and_timeout_codes(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        processor = AssetProcessor(
            Settings(
                app_env="test",
                asset_allow_unscanned_nonproduction=True,
                asset_ffmpeg_path=str(tmp_path / "missing-ffmpeg"),
            ),
            MediaAssetStore(b""),  # type: ignore[arg-type]
        )
        with pytest.raises(AssetSecurityError) as unavailable:
            await processor._run_media_command(processor.settings.asset_ffmpeg_path)
        assert unavailable.value.code == "asset_media_tool_unavailable"
        assert unavailable.value.retryable is True

        with pytest.raises(AssetSecurityError) as failed:
            await processor._run_media_command(
                sys.executable, "-c", "import sys; sys.exit(7)"
            )
        assert failed.value.code == "asset_media_processing_failed"

        processor.settings.asset_media_process_timeout_seconds = 0.05
        with pytest.raises(AssetSecurityError) as timed_out:
            await processor._run_media_command(
                sys.executable, "-c", "import time; time.sleep(1)"
            )
        assert timed_out.value.code == "asset_media_processing_timeout"
        assert timed_out.value.retryable is True

    asyncio.run(scenario())


def test_video_second_object_failure_reports_first_generated_object(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        source = tmp_path / "movie.mp4"
        generate_video(source, "mp4")
        store = MediaAssetStore(source.read_bytes(), fail_upload_number=2)
        ffmpeg, ffprobe = ffmpeg_tools()
        processor = AssetProcessor(
            Settings(
                app_env="test",
                asset_allow_unscanned_nonproduction=True,
                asset_ffmpeg_path=ffmpeg,
                asset_ffprobe_path=ffprobe,
            ),
            store,  # type: ignore[arg-type]
        )

        with pytest.raises(AssetSecurityError) as error:
            await processor.process(
                video_asset(filename="movie.mp4", declared_mime_type="video/mp4")
            )
        assert error.value.code == "asset_storage_write_failed"
        assert error.value.generated_object_keys == (
            "assets/project-a/ast-mp4/video-v1.mp4",
        )

    asyncio.run(scenario())


def test_url_import_blocks_private_and_metadata_addresses(monkeypatch: pytest.MonkeyPatch) -> None:
    def private_address(*_args: object, **_kwargs: object):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 80))]

    monkeypatch.setattr(socket, "getaddrinfo", private_address)
    importer = SecureUrlImporter(Settings(app_env="test"))

    with pytest.raises(AssetSecurityError) as error:
        asyncio.run(importer._validated_addresses("http://metadata.example/latest"))
    assert error.value.code == "asset_import_ssrf_blocked"


def test_url_import_revalidates_redirect_target(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "public.example"
        return httpx.Response(302, headers={"location": "http://127.0.0.1/private"})

    importer = SecureUrlImporter(
        Settings(app_env="test"),
        httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False),
    )

    async def validate(url: str) -> frozenset[str]:
        if "127.0.0.1" in url:
            raise AssetSecurityError("asset_import_ssrf_blocked", "private")
        return frozenset({"93.184.216.34"})

    monkeypatch.setattr(importer, "_validated_addresses", validate)
    with pytest.raises(AssetSecurityError) as error:
        asyncio.run(
            importer.download(
                "https://public.example/image.jpg",
                str(tmp_path / "download"),
                1024,
            )
        )
    assert error.value.code == "asset_import_ssrf_blocked"
    asyncio.run(importer.client.aclose())  # type: ignore[union-attr]


def test_url_import_returns_final_redirect_url_and_declared_content_type(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if request.url.path == "/start.jpg":
            return httpx.Response(302, headers={"location": "/final.jpg?secret=token"})
        return httpx.Response(
            200,
            headers={"content-type": "image/jpeg; charset=binary"},
            content=b"\xff\xd8\xff" + b"\x00" * 20,
        )

    async def scenario() -> None:
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), follow_redirects=False
        )
        importer = SecureUrlImporter(Settings(app_env="test"), client)
        checked: list[str] = []

        async def validate(url: str) -> frozenset[str]:
            checked.append(url)
            return frozenset({"93.184.216.34"})

        monkeypatch.setattr(importer, "_validated_addresses", validate)
        final_url, content_type = await importer.download(
            "https://public.example/start.jpg",
            str(tmp_path / "redirected"),
            1024,
        )
        assert final_url == "https://public.example/final.jpg?secret=token"
        assert content_type == "image/jpeg"
        assert requests == [
            "https://public.example/start.jpg",
            "https://public.example/final.jpg?secret=token",
        ]
        assert checked == [
            "https://public.example/start.jpg",
            "https://public.example/final.jpg?secret=token",
            "https://public.example/final.jpg?secret=token",
        ]
        await client.aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("final_url", "declared", "detected", "asset_type"),
    [
        ("https://cdn.example/photo.png", "image/jpeg", "image/jpeg", "image"),
        ("https://cdn.example/photo.jpg", "image/png", "image/jpeg", "image"),
        ("https://cdn.example/photo.jpg", "image/jpeg", "image/png", "image"),
        ("https://cdn.example/photo.jpg", "image/jpeg", "image/jpeg", "file"),
    ],
)
def test_url_import_rejects_final_extension_content_type_magic_and_asset_type_mismatch(
    final_url: str,
    declared: str,
    detected: str,
    asset_type: str,
) -> None:
    asset = typed_asset(
        filename="photo.jpg",
        asset_type=asset_type,
        declared_mime_type=declared,
    )

    with pytest.raises(AssetSecurityError) as error:
        validate_import_source(asset, final_url, declared, detected)

    assert error.value.code == "asset_mime_mismatch"


def test_url_import_accepts_extensionless_final_url_when_response_and_magic_match() -> None:
    validate_import_source(
        typed_asset(
            filename="photo.jpg",
            asset_type="image",
            declared_mime_type="image/jpeg",
        ),
        "https://cdn.example/download?id=opaque",
        "image/jpeg",
        "image/jpeg",
    )


def test_url_import_redirect_limit_has_stable_error_code(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def scenario() -> None:
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    302,
                    headers={"location": f"/redirect-{request.url.path.count('redirect') + 1}.jpg"},
                )
            ),
            follow_redirects=False,
        )
        importer = SecureUrlImporter(
            Settings(app_env="test", asset_import_max_redirects=2), client
        )

        async def validate(_: str) -> frozenset[str]:
            return frozenset({"93.184.216.34"})

        monkeypatch.setattr(importer, "_validated_addresses", validate)
        with pytest.raises(AssetSecurityError) as error:
            await importer.download(
                "https://public.example/redirect-0.jpg",
                str(tmp_path / "redirect-limit"),
                1024,
            )
        assert error.value.code == "asset_import_redirect_rejected"
        await client.aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("status_code", "content", "expected_code"),
    [
        (200, b"", "asset_processing_failed"),
        (503, b"unavailable", "asset_import_failed"),
    ],
)
def test_url_import_empty_and_network_failures_use_stable_codes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    status_code: int,
    content: bytes,
    expected_code: str,
) -> None:
    async def scenario() -> None:
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(status_code, content=content)
            )
        )
        importer = SecureUrlImporter(Settings(app_env="test"), client)

        async def validate(_: str) -> frozenset[str]:
            return frozenset({"93.184.216.34"})

        monkeypatch.setattr(importer, "_validated_addresses", validate)
        with pytest.raises(AssetSecurityError) as error:
            await importer.download(
                "https://public.example/image.jpg", str(tmp_path / "empty"), 1024
            )
        assert error.value.code == expected_code
        await client.aclose()

    asyncio.run(scenario())


def test_url_import_blocks_dns_rebinding_and_oversized_response(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def dns_rebinding() -> None:
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"image"))
        )
        importer = SecureUrlImporter(Settings(app_env="test"), client)
        answers = iter(
            [frozenset({"93.184.216.34"}), frozenset({"93.184.216.35"})]
        )

        async def validate(_: str) -> frozenset[str]:
            return next(answers)

        monkeypatch.setattr(importer, "_validated_addresses", validate)
        with pytest.raises(AssetSecurityError) as error:
            await importer.download(
                "https://public.example/image.jpg", str(tmp_path / "rebind"), 1024
            )
        assert error.value.code == "asset_import_ssrf_blocked"
        await client.aclose()

    async def oversized() -> None:
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"12345"))
        )
        importer = SecureUrlImporter(Settings(app_env="test"), client)

        async def validate(_: str) -> frozenset[str]:
            return frozenset({"93.184.216.34"})

        monkeypatch.setattr(importer, "_validated_addresses", validate)
        with pytest.raises(AssetSecurityError) as error:
            await importer.download(
                "https://public.example/image.jpg", str(tmp_path / "large"), 4
            )
        assert error.value.code == "asset_too_large"
        await client.aclose()

    asyncio.run(dns_rebinding())
    asyncio.run(oversized())
