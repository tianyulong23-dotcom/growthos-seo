"""Cross-language durable response spool, protocol version 1.

No cloud credentials or network upload are needed in the capture process.
The separately supervised Core archive uploader owns delivery and retries.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _write(path: Path, value: Any) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=True, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())


def _sync_directory(directory: Path) -> None:
    if os.name == "nt":
        return
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Capture:
    def __init__(self, directory: Path, base: dict[str, Any], max_bytes: int) -> None:
        self.directory = directory
        self.base = base
        self.max_bytes = max_bytes

    def finish(self, body: bytes, status: int | None) -> None:
        """Do not turn capture failures into repeated paid provider requests."""
        try:
            if len(body) > self.max_bytes:
                raise ValueError("ARCHIVE_RESPONSE_TOO_LARGE")
            event = {
                **self.base,
                "receivedAt": _now(),
                "httpStatus": status,
                "responseBodyBase64": base64.b64encode(body).decode("ascii"),
                "responseSha256": hashlib.sha256(body).hexdigest(),
                "outcome": "transport_error" if status is None else "response",
            }
            event_id = self.base["eventId"]
            temporary = self.directory / f"{event_id}.writing"
            _write(temporary, event)
            os.replace(temporary, self.directory / f"{event_id}.event.json")
            _sync_directory(self.directory)
            (self.directory / f"{event_id}.pending").unlink(missing_ok=True)
        except Exception:
            logger.error("ARCHIVE_CAPTURE_GAP eventId=%s", self.base["eventId"])


def begin_capture(
    component: str, url: str, method: str, request_body: str | None = None
) -> Capture | None:
    enabled = os.environ.get("PROVIDER_ARCHIVE_ENABLED", "false")
    if enabled == "false":
        return None
    if enabled != "true":
        raise ValueError("ARCHIVE_INVALID_ENABLED")
    endpoint = urlsplit(url).path
    if endpoint.startswith("/v3/appendix/"):
        return None
    if not re.fullmatch(r"/v3/[a-zA-Z0-9/_-]+", endpoint) or method not in {"GET", "POST"}:
        raise ValueError("ARCHIVE_UNSUPPORTED_REQUEST")
    directory = Path(os.environ.get("PROVIDER_ARCHIVE_SPOOL_DIR", ""))
    deployment_id = os.environ.get("PROVIDER_ARCHIVE_DEPLOYMENT_ID", "")
    if not directory.is_absolute():
        raise ValueError("ARCHIVE_ABSOLUTE_SPOOL_REQUIRED")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}", deployment_id):
        raise ValueError("ARCHIVE_DEPLOYMENT_REQUIRED")
    max_bytes = int(os.environ.get("PROVIDER_ARCHIVE_MAX_RESPONSE_BYTES", 32 * 1024 * 1024))
    max_pending = int(os.environ.get("PROVIDER_ARCHIVE_MAX_PENDING", 100_000))
    if min(max_bytes, max_pending) <= 0:
        raise ValueError("ARCHIVE_INVALID_NUMBER")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if sum(p.name.endswith((".pending", ".event.json")) for p in directory.iterdir()) >= max_pending:
        raise ValueError("ARCHIVE_SPOOL_CAPACITY")
    base = {
        "schemaVersion": 1,
        "eventId": str(uuid.uuid4()),
        "deploymentId": deployment_id,
        "component": component,
        "endpoint": endpoint,
        "method": method,
        "requestBody": request_body,
        "startedAt": _now(),
    }
    _write(directory / f"{base['eventId']}.pending", base)
    _sync_directory(directory)
    return Capture(directory, base, max_bytes)
