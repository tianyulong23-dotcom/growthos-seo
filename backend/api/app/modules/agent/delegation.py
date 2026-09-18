"""Short-lived, server-issued authority; never take claims from tool arguments."""
from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import asdict
from datetime import UTC, datetime, timedelta

from app.core.config import Settings
from app.core.platform_request_context import (
    PlatformActor, PlatformProject, PlatformTenant, ResolvedPlatformRequestContext,
)


def _signature(settings: Settings, claims: dict) -> str:
    key = settings.platform_context_signing_key
    if key is None or len(key.get_secret_value()) < 32:
        raise ValueError("BACKLINKS_AGENT_SIGNING_KEY_REQUIRED")
    data = json.dumps(claims, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(
        key.get_secret_value().encode(), b"agent-draft-delegation.v1:" + data,
        hashlib.sha256,
    ).hexdigest()


def issue_delegation(
    settings: Settings, context: ResolvedPlatformRequestContext,
    *, now: datetime | None = None,
) -> dict:
    now = now or datetime.now(UTC)
    expiry = now + timedelta(minutes=15)
    if context.authentication_expires_at is not None:
        expiry = min(expiry, context.authentication_expires_at)
    elif settings.app_env == "production" or not settings.platform_local_development_auth_enabled:
        raise ValueError("BACKLINKS_AGENT_AUTH_EXPIRY_REQUIRED")
    claims = {
        "actor": asdict(context.actor), "tenant": asdict(context.tenant),
        "project": asdict(context.project),
        "permissions": sorted(set(context.permissions) & {
            "backlinks:read", "backlinks:write", "projects:read", "projects:write",
            "content:read", "content:write",
        }),
        "issued_at": now.timestamp(), "expires_at": expiry.timestamp(),
        "correlation_id": context.correlation_id,
    }
    return {"claims": claims, "signature": _signature(settings, claims)}


async def resolve_delegation(
    settings: Settings, projects, grant: dict | None, project_id: str,
    organization_id: str, *, write: bool = False, now: datetime | None = None,
    required_permission: str | None = None,
) -> ResolvedPlatformRequestContext:
    if not isinstance(grant, dict) or not isinstance(grant.get("claims"), dict):
        raise ValueError("BACKLINKS_AGENT_DELEGATION_REQUIRED")
    claims = grant["claims"]
    if not hmac.compare_digest(str(grant.get("signature", "")), _signature(settings, claims)):
        raise ValueError("BACKLINKS_AGENT_DELEGATION_INVALID")
    timestamp = (now or datetime.now(UTC)).timestamp()
    if not claims["issued_at"] <= timestamp < claims["expires_at"]:
        raise ValueError("BACKLINKS_AGENT_DELEGATION_EXPIRED")
    permission = required_permission or ("backlinks:write" if write else "backlinks:read")
    if permission not in claims["permissions"]:
        raise ValueError("BACKLINKS_AGENT_PERMISSION_DENIED")
    project = await projects.get_by_key(claims["project"]["website_project_key"])
    if (
        project is None or project.website_project_id != project_id
        or claims["project"]["website_project_id"] != project_id
        or claims["tenant"]["organization_id"] != organization_id
        or project.organization_id != organization_id
        or project.workspace_id != claims["tenant"]["workspace_id"]
    ):
        raise ValueError("BACKLINKS_AGENT_SCOPE_MISMATCH")
    return ResolvedPlatformRequestContext(
        actor=PlatformActor(**{**claims["actor"], "roles": tuple(claims["actor"]["roles"])}),
        tenant=PlatformTenant(**claims["tenant"]),
        project=PlatformProject(**claims["project"]),
        permissions=(permission,), correlation_id=claims["correlation_id"],
    )
