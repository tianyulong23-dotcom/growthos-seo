import base64
import hashlib
import hmac
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta


PLATFORM_CONTEXT_HEADER = "x-growthos-platform-context"
PLATFORM_CONTEXT_SIGNATURE_HEADER = "x-growthos-platform-context-signature"
PLATFORM_CONTEXT_VERSION = "PlatformRequestContext.v1"
PLATFORM_CONTEXT_ISSUER = "growthos-platform-gateway"
PLATFORM_CONTEXT_AUDIENCE = "growthos-backlinks-core"
DEFAULT_TTL_SECONDS = 30
MAX_TTL_SECONDS = 60
PERMISSION_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.-]*$")


@dataclass(frozen=True)
class PlatformActor:
    user_id: str
    session_id: str
    roles: tuple[str, ...]


@dataclass(frozen=True)
class PlatformTenant:
    organization_id: str
    workspace_id: str


@dataclass(frozen=True)
class PlatformProject:
    website_project_id: str
    website_project_key: str


@dataclass(frozen=True)
class ResolvedPlatformRequestContext:
    actor: PlatformActor
    tenant: PlatformTenant
    project: PlatformProject
    permissions: tuple[str, ...]
    correlation_id: str


@dataclass(frozen=True)
class ResolvedPlatformCollectionContext:
    actor: PlatformActor
    tenant: PlatformTenant
    permissions: tuple[str, ...]
    correlation_id: str
    authorized_project_ids: tuple[str, ...] | None


def strip_untrusted_platform_context_headers(
    headers: Mapping[str, str],
) -> dict[str, str]:
    blocked = {
        PLATFORM_CONTEXT_HEADER,
        PLATFORM_CONTEXT_SIGNATURE_HEADER,
    }
    return {key: value for key, value in headers.items() if key.lower() not in blocked}


def _require_identifier(field: str, value: str) -> str:
    if not value or value != value.strip() or len(value) > 200:
        raise ValueError(f"{field} must be a non-blank identifier")
    return value


def _normalize_values(
    field: str,
    values: tuple[str, ...],
    *,
    maximum: int,
) -> list[str]:
    if not values or len(values) > maximum:
        raise ValueError(f"{field} must contain between 1 and {maximum} values")
    normalized = sorted({_require_identifier(field, value) for value in values})
    if len(normalized) != len(values):
        raise ValueError(f"{field} must not contain duplicates")
    return normalized


def _format_timestamp(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def issue_platform_request_context_v1(
    resolved: ResolvedPlatformRequestContext | ResolvedPlatformCollectionContext,
    *,
    signing_key: bytes,
    now: datetime,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> dict[str, str]:
    if len(signing_key) < 32:
        raise ValueError("signing_key must contain at least 32 bytes")
    if ttl_seconds < 1 or ttl_seconds > MAX_TTL_SECONDS:
        raise ValueError(f"ttl_seconds must be between 1 and {MAX_TTL_SECONDS}")

    issued_at = _format_timestamp(now)
    expires_at = _format_timestamp(now + timedelta(seconds=ttl_seconds))
    permissions = _normalize_values("permissions", resolved.permissions, maximum=128)
    for permission in permissions:
        if not PERMISSION_PATTERN.fullmatch(permission):
            raise ValueError("permissions must use namespace:action syntax")

    payload = {
        "actor": {
            "roles": _normalize_values("actor.roles", resolved.actor.roles, maximum=32),
            "sessionId": _require_identifier("actor.sessionId", resolved.actor.session_id),
            "userId": _require_identifier("actor.userId", resolved.actor.user_id),
        },
        "audience": PLATFORM_CONTEXT_AUDIENCE,
        "correlationId": _require_identifier("correlationId", resolved.correlation_id),
        "expiresAt": expires_at,
        "issuedAt": issued_at,
        "issuer": PLATFORM_CONTEXT_ISSUER,
        "permissions": permissions,
        "project": (
            {
                "websiteProjectId": _require_identifier(
                    "project.websiteProjectId",
                    resolved.project.website_project_id,
                ),
                "websiteProjectKey": _require_identifier(
                    "project.websiteProjectKey",
                    resolved.project.website_project_key,
                ),
            }
            if isinstance(resolved, ResolvedPlatformRequestContext)
            else None
        ),
        "tenant": {
            "organizationId": _require_identifier(
                "tenant.organizationId",
                resolved.tenant.organization_id,
            ),
            "workspaceId": _require_identifier(
                "tenant.workspaceId",
                resolved.tenant.workspace_id,
            ),
        },
        "version": PLATFORM_CONTEXT_VERSION,
    }
    encoded_payload = _base64url(
        json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    )
    signature = hmac.new(
        signing_key,
        f"{PLATFORM_CONTEXT_VERSION}.{encoded_payload}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    return {
        PLATFORM_CONTEXT_HEADER: encoded_payload,
        PLATFORM_CONTEXT_SIGNATURE_HEADER: f"v1={_base64url(signature)}",
    }
