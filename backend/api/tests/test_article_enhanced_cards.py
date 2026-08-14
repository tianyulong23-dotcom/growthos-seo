import asyncio

import pytest

from app.modules.content.asset_security import AssetSecurityError, RemoteBytes
from app.modules.content.document import (
    ArticleDocumentError,
    document_to_html,
    normalize_document,
)
from app.modules.content.enhanced_cards import (
    BOOKMARK_MAX_BYTES,
    resolve_bookmark,
    resolve_embed,
)


class BookmarkImporter:
    def __init__(self, response: RemoteBytes | Exception) -> None:
        self.response = response
        self.maximum_bytes: int | None = None

    async def fetch_bytes(self, url: str, maximum_bytes: int) -> RemoteBytes:
        self.maximum_bytes = maximum_bytes
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def test_bookmark_uses_safe_fetch_limit_and_metadata_fallback_order() -> None:
    source = b"""
        <html><head>
        <title>Document title</title>
        <meta property="og:title" content="Open Graph title">
        <meta name="twitter:title" content="Twitter title">
        <meta property="og:description" content="Open Graph description">
        <meta name="twitter:description" content="Twitter description">
        <meta property="og:site_name" content="Publisher">
        <meta property="og:image" content="/cover.jpg">
        <link rel="icon" href="/icon.png">
        </head></html>
    """
    importer = BookmarkImporter(
        RemoteBytes("https://final.example/path", "text/html", source)
    )
    result = asyncio.run(resolve_bookmark("https://source.example", importer))

    assert importer.maximum_bytes == BOOKMARK_MAX_BYTES == 2 * 1024 * 1024
    assert result["kind"] == "bookmark"
    assert result["title"] == "Open Graph title"
    assert result["description"] == "Open Graph description"
    assert result["publisher"] == "Publisher"
    assert result["icon_url"] == "https://final.example/icon.png"
    assert result["image_url"] == "https://final.example/cover.jpg"


def test_bookmark_non_html_and_safe_fetch_failures_degrade_to_links() -> None:
    non_html = asyncio.run(
        resolve_bookmark(
            "https://example.com/file.pdf",
            BookmarkImporter(
                RemoteBytes(
                    "https://example.com/file.pdf",
                    "application/pdf",
                    b"%PDF-",
                )
            ),
        )
    )
    blocked = asyncio.run(
        resolve_bookmark(
            "http://127.0.0.1/admin",
            BookmarkImporter(
                AssetSecurityError("asset_import_ssrf_blocked", "private address")
            ),
        )
    )
    timeout = asyncio.run(
        resolve_bookmark(
            "https://slow.example",
            BookmarkImporter(
                AssetSecurityError(
                    "asset_import_timeout", "timeout", retryable=True
                )
            ),
        )
    )
    assert non_html["kind"] == "link"
    assert non_html["error_code"] == "bookmark_not_html"
    assert blocked["kind"] == "link"
    assert blocked["error_code"] == "asset_import_ssrf_blocked"
    assert blocked["retryable"] is False
    assert timeout["kind"] == "link"
    assert timeout["error_code"] == "asset_import_timeout"
    assert timeout["retryable"] is True


@pytest.mark.parametrize(
    ("url", "provider", "embed_id"),
    [
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ"),
        ("https://m.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ"),
        ("https://youtu.be/dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ"),
        ("https://vimeo.com/123456789", "vimeo", "123456789"),
        ("https://player.vimeo.com/video/123456789", "vimeo", "123456789"),
        ("https://open.spotify.com/track/abcDEF123", "spotify", "track/abcDEF123"),
    ],
)
def test_embed_provider_fixtures(url: str, provider: str, embed_id: str) -> None:
    result = resolve_embed(url)
    assert result["kind"] == "embed"
    assert result["provider"] == provider
    assert result["embed_id"] == embed_id
    assert result["embed_url"].startswith("https://")


def test_unsupported_embed_degrades_to_a_normal_link() -> None:
    result = resolve_embed("https://video.example/watch/123")
    assert result == {
        "kind": "link",
        "source_url": "https://video.example/watch/123",
        "provider": None,
        "embed_id": None,
        "embed_url": None,
        "error_code": "embed_provider_unsupported",
    }


def embed_document(**overrides) -> dict:
    attrs = {
        "node_id": "embed-1",
        "provider": "youtube",
        "source_url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "embed_id": "dQw4w9WgXcQ",
        **overrides,
    }
    return {
        "type": "doc",
        "schema_version": 2,
        "content": [{"type": "embed", "attrs": attrs}],
    }


def test_document_schema_rejects_arbitrary_embed_provider_domain_and_html() -> None:
    with pytest.raises(ArticleDocumentError, match="embed_provider_invalid"):
        normalize_document(embed_document(provider="custom"))
    with pytest.raises(ArticleDocumentError, match="embed_domain_invalid"):
        normalize_document(
            embed_document(source_url="https://attacker.example/watch?v=dQw4w9WgXcQ")
        )
    with pytest.raises(ArticleDocumentError, match="unsupported_fields"):
        normalize_document(embed_document(html="<script>alert(1)</script>"))


@pytest.mark.parametrize(
    ("provider", "source_url"),
    [
        ("youtube", "https://m.youtube.com/watch?v=dQw4w9WgXcQ"),
        ("vimeo", "https://player.vimeo.com/video/123456789"),
    ],
)
def test_resolver_supported_domains_round_trip_through_document_schema(
    provider: str, source_url: str
) -> None:
    resolved = resolve_embed(source_url)
    assert resolved["kind"] == "embed"
    normalized = normalize_document(
        embed_document(
            provider=provider,
            source_url=source_url,
            embed_id=resolved["embed_id"],
        )
    )
    assert normalized["content"][0]["attrs"]["source_url"] == source_url


def test_renderer_generates_only_the_provider_iframe_from_structured_fields() -> None:
    normalized = normalize_document(embed_document())
    html = document_to_html(normalized)
    assert 'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"' in html
    assert "<script" not in html
    assert "youtube.com/watch" not in html
    assert html.count("<iframe") == 1
