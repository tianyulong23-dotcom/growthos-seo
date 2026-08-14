from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
import re
import secrets
import socket
from dataclasses import dataclass
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from app.modules.settings.service_connections import WordPressConnectionRecord


MAX_RESPONSE_BYTES = 1024 * 1024
PUBLISH_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class WordPressPublishResult:
    post_id: int
    url: str
    status: str
    payload_hash: str | None = None


@dataclass(frozen=True)
class WordPressMediaResult:
    media_id: int
    source_url: str
    slug: str


class WordPressPublishError(Exception):
    def __init__(self, code: str, detail: str, *, uncertain: bool = False) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.uncertain = uncertain


class WordPressTransport(Protocol):
    async def publish(
        self,
        connection: WordPressConnectionRecord,
        payload: dict[str, object],
        *,
        post_id: int | None,
    ) -> WordPressPublishResult: ...

    async def get_post(
        self, connection: WordPressConnectionRecord, post_id: int
    ) -> WordPressPublishResult | None: ...

    async def find_post_by_slug(
        self, connection: WordPressConnectionRecord, slug: str
    ) -> WordPressPublishResult | None: ...

    async def upload_media(
        self,
        connection: WordPressConnectionRecord,
        *,
        body: bytes,
        filename: str,
        mime_type: str,
        slug: str,
        title: str,
        alt_text: str,
        caption: str,
    ) -> WordPressMediaResult: ...

    async def get_media(
        self, connection: WordPressConnectionRecord, media_id: int
    ) -> WordPressMediaResult | None: ...

    async def find_media_by_slug(
        self, connection: WordPressConnectionRecord, slug: str
    ) -> WordPressMediaResult | None: ...


class LiveWordPressTransport:
    async def publish(
        self,
        connection: WordPressConnectionRecord,
        payload: dict[str, object],
        *,
        post_id: int | None,
    ) -> WordPressPublishResult:
        return await asyncio.to_thread(
            self._publish_sync, connection, payload, post_id=post_id
        )

    async def get_post(
        self, connection: WordPressConnectionRecord, post_id: int
    ) -> WordPressPublishResult | None:
        return await asyncio.to_thread(self._get_post_sync, connection, post_id)

    async def find_post_by_slug(
        self, connection: WordPressConnectionRecord, slug: str
    ) -> WordPressPublishResult | None:
        return await asyncio.to_thread(self._find_post_by_slug_sync, connection, slug)

    async def upload_media(
        self,
        connection: WordPressConnectionRecord,
        *,
        body: bytes,
        filename: str,
        mime_type: str,
        slug: str,
        title: str,
        alt_text: str,
        caption: str,
    ) -> WordPressMediaResult:
        return await asyncio.to_thread(
            self._upload_media_sync,
            connection,
            body=body,
            filename=filename,
            mime_type=mime_type,
            slug=slug,
            title=title,
            alt_text=alt_text,
            caption=caption,
        )

    async def get_media(
        self, connection: WordPressConnectionRecord, media_id: int
    ) -> WordPressMediaResult | None:
        return await asyncio.to_thread(self._get_media_sync, connection, media_id)

    async def find_media_by_slug(
        self, connection: WordPressConnectionRecord, slug: str
    ) -> WordPressMediaResult | None:
        return await asyncio.to_thread(self._find_media_by_slug_sync, connection, slug)

    def _publish_sync(
        self,
        connection: WordPressConnectionRecord,
        payload: dict[str, object],
        *,
        post_id: int | None,
    ) -> WordPressPublishResult:
        endpoint = self._endpoint(connection, "posts")
        if post_id is not None:
            endpoint += f"/{post_id}"
        response = self._json_request(
            connection,
            endpoint,
            method="POST",
            payload=payload,
            network_error_code="wordpress_publish_uncertain",
            uncertain=True,
        )
        return _parse_post(response)

    def _get_post_sync(
        self, connection: WordPressConnectionRecord, post_id: int
    ) -> WordPressPublishResult | None:
        response = self._json_request(
            connection,
            f'{self._endpoint(connection, "posts")}/{post_id}?context=edit',
            method="GET",
            missing_ok=True,
            network_error_code="wordpress_reconcile_unavailable",
        )
        return _parse_post(response) if response is not None else None

    def _find_post_by_slug_sync(
        self, connection: WordPressConnectionRecord, slug: str
    ) -> WordPressPublishResult | None:
        query = urlencode({"slug": slug, "status": "any", "context": "edit", "per_page": 2})
        response = self._json_request(
            connection,
            f'{self._endpoint(connection, "posts")}?{query}',
            method="GET",
            network_error_code="wordpress_reconcile_unavailable",
        )
        if not isinstance(response, list) or not response:
            return None
        if len(response) != 1:
            raise WordPressPublishError(
                "wordpress_reconcile_ambiguous", "Multiple WordPress posts use the frozen slug"
            )
        return _parse_post(response[0])

    def _upload_media_sync(
        self,
        connection: WordPressConnectionRecord,
        *,
        body: bytes,
        filename: str,
        mime_type: str,
        slug: str,
        title: str,
        alt_text: str,
        caption: str,
    ) -> WordPressMediaResult:
        boundary = f"growthos-{secrets.token_hex(16)}"
        multipart = bytearray()
        fields = {
            "slug": slug,
            "title": title,
            "alt_text": alt_text,
            "caption": caption,
        }
        for name, value in fields.items():
            multipart.extend(f"--{boundary}\r\n".encode())
            multipart.extend(
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
            )
            multipart.extend(value.encode("utf-8"))
            multipart.extend(b"\r\n")
        safe_filename = filename.replace('"', "").replace("\r", "").replace("\n", "")
        multipart.extend(f"--{boundary}\r\n".encode())
        multipart.extend(
            f'Content-Disposition: form-data; name="file"; filename="{safe_filename}"\r\n'.encode()
        )
        multipart.extend(f"Content-Type: {mime_type}\r\n\r\n".encode())
        multipart.extend(body)
        multipart.extend(f"\r\n--{boundary}--\r\n".encode())
        response = self._request(
            connection,
            self._endpoint(connection, "media"),
            method="POST",
            body=bytes(multipart),
            content_type=f"multipart/form-data; boundary={boundary}",
            network_error_code="wordpress_media_upload_uncertain",
            uncertain=True,
        )
        return _parse_media(response)

    def _get_media_sync(
        self, connection: WordPressConnectionRecord, media_id: int
    ) -> WordPressMediaResult | None:
        response = self._json_request(
            connection,
            f'{self._endpoint(connection, "media")}/{media_id}?context=edit',
            method="GET",
            missing_ok=True,
            network_error_code="wordpress_media_lookup_unavailable",
        )
        return _parse_media(response) if response is not None else None

    def _find_media_by_slug_sync(
        self, connection: WordPressConnectionRecord, slug: str
    ) -> WordPressMediaResult | None:
        query = urlencode({"slug": slug, "context": "edit", "per_page": 2})
        response = self._json_request(
            connection,
            f'{self._endpoint(connection, "media")}?{query}',
            method="GET",
            network_error_code="wordpress_media_lookup_unavailable",
        )
        if not isinstance(response, list) or not response:
            return None
        if len(response) != 1:
            raise WordPressPublishError(
                "wordpress_media_reconcile_ambiguous",
                "Multiple WordPress media items use the frozen upload slug",
            )
        return _parse_media(response[0])

    def _endpoint(self, connection: WordPressConnectionRecord, resource: str) -> str:
        _ensure_public_site(connection.site_url)
        return f"{connection.site_url.rstrip('/')}/wp-json/wp/v2/{resource}"

    def _json_request(
        self,
        connection: WordPressConnectionRecord,
        endpoint: str,
        *,
        method: str,
        payload: dict[str, object] | None = None,
        missing_ok: bool = False,
        network_error_code: str,
        uncertain: bool = False,
    ) -> object | None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload else None
        return self._request(
            connection,
            endpoint,
            method=method,
            body=body,
            content_type="application/json; charset=utf-8" if body is not None else None,
            missing_ok=missing_ok,
            network_error_code=network_error_code,
            uncertain=uncertain,
        )

    def _request(
        self,
        connection: WordPressConnectionRecord,
        endpoint: str,
        *,
        method: str,
        body: bytes | None,
        content_type: str | None,
        network_error_code: str,
        missing_ok: bool = False,
        uncertain: bool = False,
    ) -> object | None:
        credentials = base64.b64encode(
            f"{connection.username}:{connection.application_password}".encode()
        ).decode()
        headers = {"Authorization": f"Basic {credentials}", "Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        request = Request(endpoint, data=body, headers=headers, method=method)
        try:
            with build_opener(_NoRedirectHandler()).open(
                request, timeout=PUBLISH_TIMEOUT_SECONDS
            ) as response:
                response_body = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            if missing_ok and exc.code == 404:
                return None
            if exc.code in {301, 302, 303, 307, 308}:
                raise WordPressPublishError(
                    "wordpress_redirect_rejected", "WordPress REST endpoint redirected"
                ) from exc
            raise WordPressPublishError(
                "wordpress_request_rejected", f"WordPress returned HTTP {exc.code}"
            ) from exc
        except (TimeoutError, socket.timeout, URLError, OSError) as exc:
            raise WordPressPublishError(
                network_error_code,
                "WordPress request result is unknown after a network failure"
                if uncertain
                else "WordPress could not be reached",
                uncertain=uncertain,
            ) from exc
        if len(response_body) > MAX_RESPONSE_BYTES:
            raise WordPressPublishError(
                "wordpress_response_too_large", "WordPress response exceeded the limit"
            )
        try:
            return json.loads(response_body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WordPressPublishError(
                "wordpress_response_invalid", "WordPress returned invalid JSON"
            ) from exc


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def _parse_post(value: object) -> WordPressPublishResult:
    remote_id = value.get("id") if isinstance(value, dict) else None
    url = value.get("link") if isinstance(value, dict) else None
    status = value.get("status") if isinstance(value, dict) else None
    if not isinstance(remote_id, int) or not _public_http_url(url):
        raise WordPressPublishError(
            "wordpress_response_invalid", "WordPress response omitted the post identity"
        )
    content = value.get("content") if isinstance(value, dict) else None
    raw_content = None
    if isinstance(content, dict):
        raw_content = content.get("raw") or content.get("rendered")
    marker = (
        re.search(r"<!--\s*growthos-publication:[^:]+:([a-f0-9]{64})\s*-->", raw_content)
        if isinstance(raw_content, str)
        else None
    )
    return WordPressPublishResult(
        remote_id,
        str(url),
        str(status or "publish"),
        marker.group(1) if marker else None,
    )


def _parse_media(value: object) -> WordPressMediaResult:
    remote_id = value.get("id") if isinstance(value, dict) else None
    source_url = value.get("source_url") if isinstance(value, dict) else None
    slug = value.get("slug") if isinstance(value, dict) else None
    if not isinstance(remote_id, int) or not _public_http_url(source_url) or not isinstance(slug, str):
        raise WordPressPublishError(
            "wordpress_response_invalid", "WordPress response omitted the media identity"
        )
    return WordPressMediaResult(remote_id, str(source_url), slug)


def _public_http_url(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname)


def _ensure_public_site(site_url: str) -> None:
    parsed = urlsplit(site_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise WordPressPublishError("wordpress_url_invalid", "WordPress URL is invalid")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror as exc:
        raise WordPressPublishError(
            "wordpress_host_unresolved", "WordPress host cannot be resolved"
        ) from exc
    if not addresses or any(
        not ipaddress.ip_address(address[4][0]).is_global for address in addresses
    ):
        raise WordPressPublishError(
            "wordpress_private_host_rejected",
            "WordPress host must resolve only to public addresses",
        )
