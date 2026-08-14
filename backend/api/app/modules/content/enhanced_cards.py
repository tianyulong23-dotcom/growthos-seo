from __future__ import annotations

import re
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit

from app.modules.content.asset_security import AssetSecurityError, SecureUrlImporter


BOOKMARK_MAX_BYTES = 2 * 1024 * 1024


class _MetadataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.metadata: dict[str, str] = {}
        self.title_parts: list[str] = []
        self.in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.lower(): value or "" for key, value in attrs}
        if tag.lower() == "title":
            self.in_title = True
        if tag.lower() == "meta":
            key = (values.get("property") or values.get("name") or "").lower()
            content = values.get("content", "").strip()
            if key and content:
                self.metadata.setdefault(key, content)
        if tag.lower() == "link":
            rel = values.get("rel", "").lower().split()
            href = values.get("href", "").strip()
            if href and any(item in {"icon", "shortcut", "apple-touch-icon"} for item in rel):
                self.metadata.setdefault("icon", href)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)


async def resolve_bookmark(
    url: str, importer: SecureUrlImporter
) -> dict[str, Any]:
    try:
        response = await importer.fetch_bytes(url, BOOKMARK_MAX_BYTES)
        if response.content_type not in {"text/html", "application/xhtml+xml"}:
            return _bookmark_fallback(url, response.final_url, "bookmark_not_html")
        charset = "utf-8"
        prefix = response.content[:4096].decode("ascii", errors="ignore")
        match = re.search(r"charset\s*=\s*['\"]?([A-Za-z0-9._-]+)", prefix, re.I)
        if match:
            charset = match.group(1)
        try:
            source = response.content.decode(charset, errors="replace")
        except LookupError:
            source = response.content.decode("utf-8", errors="replace")
        parser = _MetadataParser()
        parser.feed(source)
        values = parser.metadata
        title = _first(values, "og:title", "twitter:title") or " ".join(parser.title_parts)
        description = _first(values, "og:description", "twitter:description", "description")
        publisher = _first(values, "og:site_name", "application-name") or (
            urlsplit(response.final_url).hostname or ""
        )
        icon = values.get("icon") or "/favicon.ico"
        image = _first(values, "og:image:secure_url", "og:image", "twitter:image")
        return {
            "kind": "bookmark",
            "source_url": url,
            "final_url": response.final_url,
            "title": _clean(title, 500) or response.final_url,
            "description": _clean(description, 5000),
            "publisher": _clean(publisher, 500),
            "icon_url": _public_asset_url(response.final_url, icon),
            "image_url": _public_asset_url(response.final_url, image),
            "fetched_at": datetime.now(UTC),
            "error_code": None,
            "retryable": False,
        }
    except AssetSecurityError as exc:
        return {
            **_bookmark_fallback(url, url, exc.code),
            "retryable": exc.retryable,
        }


def resolve_embed(url: str) -> dict[str, Any]:
    source_url = url.strip()
    parsed = urlsplit(source_url)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    provider: str | None = None
    embed_id: str | None = None
    if hostname in {"youtube.com", "www.youtube.com", "m.youtube.com"}:
        provider = "youtube"
        if parsed.path == "/watch":
            embed_id = parse_qs(parsed.query).get("v", [None])[0]
        elif parsed.path.startswith(("/embed/", "/shorts/", "/live/")):
            embed_id = parsed.path.split("/", 2)[2]
    elif hostname == "youtu.be":
        provider, embed_id = "youtube", parsed.path.strip("/").split("/", 1)[0]
    elif hostname in {"vimeo.com", "www.vimeo.com", "player.vimeo.com"}:
        provider = "vimeo"
        parts = [part for part in parsed.path.split("/") if part]
        embed_id = next((part for part in reversed(parts) if part.isdigit()), None)
    elif hostname == "open.spotify.com":
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) >= 2 and parts[0] in {"track", "album", "episode", "show", "playlist"}:
            provider = "spotify"
            embed_id = f"{parts[0]}/{parts[1]}"
    if not provider or not embed_id or not re.fullmatch(r"[A-Za-z0-9_/-]{3,200}", embed_id):
        return {
            "kind": "link",
            "source_url": source_url,
            "provider": None,
            "embed_id": None,
            "embed_url": None,
            "error_code": "embed_provider_unsupported",
        }
    embed_url = {
        "youtube": f"https://www.youtube-nocookie.com/embed/{embed_id}",
        "vimeo": f"https://player.vimeo.com/video/{embed_id}",
        "spotify": f"https://open.spotify.com/embed/{embed_id}",
    }[provider]
    return {
        "kind": "embed",
        "source_url": source_url,
        "provider": provider,
        "embed_id": embed_id,
        "embed_url": embed_url,
        "error_code": None,
    }


def _first(values: dict[str, str], *keys: str) -> str | None:
    return next((values[key] for key in keys if values.get(key)), None)


def _clean(value: str | None, maximum: int) -> str | None:
    normalized = re.sub(r"\s+", " ", value or "").strip()
    return normalized[:maximum] or None


def _public_asset_url(base: str, value: str | None) -> str | None:
    if not value:
        return None
    result = urljoin(base, value)
    parsed = urlsplit(result)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    return result


def _bookmark_fallback(source_url: str, final_url: str, code: str) -> dict[str, Any]:
    return {
        "kind": "link",
        "source_url": source_url,
        "final_url": final_url,
        "title": None,
        "description": None,
        "publisher": None,
        "icon_url": None,
        "image_url": None,
        "fetched_at": None,
        "error_code": code,
        "retryable": False,
    }
