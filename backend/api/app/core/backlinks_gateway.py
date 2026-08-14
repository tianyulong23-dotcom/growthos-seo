import base64
import binascii
import hashlib
import hmac
import json
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Protocol

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response

from app.core.platform_request_context import (
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformCollectionContext,
    ResolvedPlatformRequestContext,
    issue_platform_request_context_v1,
    strip_untrusted_platform_context_headers,
)

_GMAIL_OAUTH_TICKET_VERSION = "GmailOAuthCallbackTicket.v1"
_GMAIL_OAUTH_TICKET_TTL = timedelta(minutes=10)


class PlatformContextResolver(Protocol):
    async def resolve_collection(
        self,
        *,
        request: Request,
    ) -> ResolvedPlatformCollectionContext: ...

    async def resolve(
        self,
        *,
        request: Request,
        website_project_key: str,
        required_permission: str | None = None,
    ) -> ResolvedPlatformRequestContext: ...


class PlatformContextResolutionError(RuntimeError):
    def __init__(
        self,
        *,
        status: int,
        code: str,
        title: str,
        detail: str,
    ) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.title = title
        self.detail = detail


class RejectingPlatformContextResolver:
    async def resolve_collection(
        self,
        *,
        request: Request,
    ) -> ResolvedPlatformCollectionContext:
        del request
        raise self._error()

    async def resolve(
        self,
        *,
        request: Request,
        website_project_key: str,
        required_permission: str | None = None,
    ) -> ResolvedPlatformRequestContext:
        del request, website_project_key, required_permission
        raise self._error()

    @staticmethod
    def _error() -> PlatformContextResolutionError:
        return PlatformContextResolutionError(
            status=401,
            code="PLATFORM_AUTHENTICATION_REQUIRED",
            title="Platform authentication required",
            detail="The platform could not resolve an authenticated request context.",
        )


def problem_response(
    *,
    status: int,
    problem_type: str,
    title: str,
    detail: str,
    code: str,
    request_id: str,
    retryable: bool,
) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        media_type="application/problem+json",
        content={
            "type": problem_type,
            "title": title,
            "status": status,
            "detail": detail,
            "code": code,
            "message": detail,
            "requestId": request_id,
            "retryable": retryable,
        },
    )


class BacklinksGateway:
    def __init__(
        self,
        *,
        base_url: str,
        signing_key: bytes | str | None,
        timeout_seconds: float = 5.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._signing_key = (
            signing_key.encode("utf-8") if isinstance(signing_key, str) else signing_key
        )
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            timeout=timeout_seconds,
            follow_redirects=False,
        )

    async def forward(
        self,
        request: Request,
        *,
        resolved: ResolvedPlatformRequestContext,
        website_project_key: str,
        query_params: Sequence[tuple[str, str]] | None = None,
    ) -> Response:
        if resolved.project.website_project_key != website_project_key:
            return problem_response(
                status=403,
                problem_type="urn:growthos:problem:platform:project-binding-failed",
                title="Platform project binding failed",
                detail="The resolved project does not match the requested project.",
                code="PLATFORM_PROJECT_BINDING_FAILED",
                request_id=resolved.correlation_id,
                retryable=False,
            )

        if self._requires_idempotency_key(request):
            idempotency_key = request.headers.get("idempotency-key", "").strip()
            if not idempotency_key:
                return problem_response(
                    status=400,
                    problem_type="urn:growthos:problem:platform:idempotency-required",
                    title="Idempotency key required",
                    detail="This command requires a non-blank idempotency-key header.",
                    code="PLATFORM_IDEMPOTENCY_REQUIRED",
                    request_id=resolved.correlation_id,
                    retryable=False,
                )

        try:
            signed_context = issue_platform_request_context_v1(
                resolved,
                signing_key=self._require_signing_key(),
                now=datetime.now(UTC),
            )
        except ValueError:
            return problem_response(
                status=503,
                problem_type="urn:growthos:problem:platform:backlinks-gateway-misconfigured",
                title="Backlinks gateway unavailable",
                detail="The Backlinks gateway signing configuration is unavailable.",
                code="BACKLINKS_GATEWAY_MISCONFIGURED",
                request_id=resolved.correlation_id,
                retryable=False,
            )

        browser_headers = strip_untrusted_platform_context_headers(dict(request.headers))
        forwarded_headers = {
            name: browser_headers[name]
            for name in ("accept", "content-type", "idempotency-key")
            if name in browser_headers
        }
        forwarded_headers["x-correlation-id"] = resolved.correlation_id
        forwarded_headers.update(signed_context)

        try:
            upstream = await self._client.request(
                request.method,
                f"{self._base_url}{request.url.path}",
                params=(
                    list(request.query_params.multi_items())
                    if query_params is None
                    else list(query_params)
                ),
                headers=forwarded_headers,
                content=await request.body(),
            )
        except httpx.RequestError:
            return problem_response(
                status=503,
                problem_type="urn:growthos:problem:platform:backlinks-unavailable",
                title="Backlinks service unavailable",
                detail="The Backlinks service could not be reached.",
                code="BACKLINKS_UNAVAILABLE",
                request_id=resolved.correlation_id,
                retryable=True,
            )

        return self._upstream_response(upstream)

    async def forward_collection(
        self,
        request: Request,
        *,
        resolved: ResolvedPlatformCollectionContext,
        query_params: Sequence[tuple[str, str]] | None = None,
    ) -> Response:
        try:
            signed_context = issue_platform_request_context_v1(
                resolved,
                signing_key=self._require_signing_key(),
                now=datetime.now(UTC),
            )
        except ValueError:
            return problem_response(
                status=503,
                problem_type="urn:growthos:problem:platform:backlinks-gateway-misconfigured",
                title="Backlinks gateway unavailable",
                detail="The Backlinks gateway signing configuration is unavailable.",
                code="BACKLINKS_GATEWAY_MISCONFIGURED",
                request_id=resolved.correlation_id,
                retryable=False,
            )

        browser_headers = strip_untrusted_platform_context_headers(dict(request.headers))
        forwarded_headers = {
            name: browser_headers[name]
            for name in ("accept", "content-type")
            if name in browser_headers
        }
        forwarded_headers["x-correlation-id"] = resolved.correlation_id
        forwarded_headers.update(signed_context)
        try:
            upstream = await self._client.request(
                request.method,
                f"{self._base_url}{request.url.path}",
                params=(
                    list(request.query_params.multi_items())
                    if query_params is None
                    else list(query_params)
                ),
                headers=forwarded_headers,
                content=await request.body(),
            )
        except httpx.RequestError:
            return problem_response(
                status=503,
                problem_type="urn:growthos:problem:platform:backlinks-unavailable",
                title="Backlinks service unavailable",
                detail="The Backlinks service could not be reached.",
                code="BACKLINKS_UNAVAILABLE",
                request_id=resolved.correlation_id,
                retryable=True,
            )
        return self._upstream_response(upstream)

    async def forward_gmail_push(self, request: Request) -> Response:
        browser_headers = strip_untrusted_platform_context_headers(dict(request.headers))
        forwarded_headers = {
            name: browser_headers[name]
            for name in ("accept", "authorization", "content-type")
            if name in browser_headers
        }
        request_id = request.headers.get("x-request-id", "unresolved")

        try:
            upstream = await self._client.request(
                request.method,
                f"{self._base_url}{request.url.path}",
                params=list(request.query_params.multi_items()),
                headers=forwarded_headers,
                content=await request.body(),
            )
        except httpx.RequestError:
            return problem_response(
                status=503,
                problem_type="urn:growthos:problem:platform:backlinks-unavailable",
                title="Backlinks service unavailable",
                detail="The Backlinks service could not be reached.",
                code="BACKLINKS_UNAVAILABLE",
                request_id=request_id,
                retryable=True,
            )

        return self._upstream_response(upstream)

    def issue_gmail_oauth_callback_ticket(
        self,
        resolved: ResolvedPlatformRequestContext,
        *,
        state: str,
        now: datetime | None = None,
    ) -> str:
        issued_at = now or datetime.now(UTC)
        payload = {
            "actor": {
                "roles": list(resolved.actor.roles),
                "sessionId": resolved.actor.session_id,
                "userId": resolved.actor.user_id,
            },
            "expiresAt": int((issued_at + _GMAIL_OAUTH_TICKET_TTL).timestamp()),
            "issuedAt": int(issued_at.timestamp()),
            "permissions": list(resolved.permissions),
            "project": {
                "websiteProjectId": resolved.project.website_project_id,
                "websiteProjectKey": resolved.project.website_project_key,
            },
            "stateHash": hashlib.sha256(state.encode("ascii")).hexdigest(),
            "tenant": {
                "organizationId": resolved.tenant.organization_id,
                "workspaceId": resolved.tenant.workspace_id,
            },
            "version": _GMAIL_OAUTH_TICKET_VERSION,
        }
        encoded = self._base64url(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        )
        signature = hmac.new(
            self._require_signing_key(),
            f"{_GMAIL_OAUTH_TICKET_VERSION}.{encoded}".encode("ascii"),
            hashlib.sha256,
        ).digest()
        return f"{encoded}.{self._base64url(signature)}"

    def resolve_gmail_oauth_callback_ticket(
        self,
        ticket: str,
        *,
        state: str,
        correlation_id: str,
        now: datetime | None = None,
    ) -> ResolvedPlatformRequestContext:
        try:
            encoded, supplied_signature = ticket.split(".", 1)
            expected_signature = hmac.new(
                self._require_signing_key(),
                f"{_GMAIL_OAUTH_TICKET_VERSION}.{encoded}".encode("ascii"),
                hashlib.sha256,
            ).digest()
            decoded_signature = self._decode_base64url(supplied_signature)
            if not hmac.compare_digest(decoded_signature, expected_signature):
                raise ValueError("invalid OAuth callback ticket signature")
            payload = json.loads(self._decode_base64url(encoded))
            current = now or datetime.now(UTC)
            issued_at = self._ticket_integer(payload, "issuedAt")
            expires_at = self._ticket_integer(payload, "expiresAt")
            if (
                issued_at > int(current.timestamp()) + 5
                or expires_at <= int(current.timestamp())
                or expires_at - issued_at != int(_GMAIL_OAUTH_TICKET_TTL.total_seconds())
            ):
                raise ValueError("expired OAuth callback ticket")
            if payload.get("version") != _GMAIL_OAUTH_TICKET_VERSION:
                raise ValueError("invalid OAuth callback ticket version")
            expected_state_hash = hashlib.sha256(state.encode("ascii")).hexdigest()
            if not hmac.compare_digest(
                self._ticket_string(payload, "stateHash"),
                expected_state_hash,
            ):
                raise ValueError("OAuth callback ticket state mismatch")
            actor = self._ticket_mapping(payload, "actor")
            tenant = self._ticket_mapping(payload, "tenant")
            project = self._ticket_mapping(payload, "project")
            return ResolvedPlatformRequestContext(
                actor=PlatformActor(
                    user_id=self._ticket_string(actor, "userId"),
                    session_id=self._ticket_string(actor, "sessionId"),
                    roles=self._ticket_strings(actor, "roles"),
                ),
                tenant=PlatformTenant(
                    organization_id=self._ticket_string(tenant, "organizationId"),
                    workspace_id=self._ticket_string(tenant, "workspaceId"),
                ),
                project=PlatformProject(
                    website_project_id=self._ticket_string(project, "websiteProjectId"),
                    website_project_key=self._ticket_string(project, "websiteProjectKey"),
                ),
                permissions=self._ticket_strings(payload, "permissions"),
                correlation_id=correlation_id,
            )
        except (
            binascii.Error,
            KeyError,
            TypeError,
            UnicodeDecodeError,
            ValueError,
            json.JSONDecodeError,
        ) as error:
            raise ValueError("OAuth callback ticket is invalid") from error

    @staticmethod
    def _upstream_response(upstream: httpx.Response) -> Response:
        response_headers = {
            name: value
            for name, value in upstream.headers.items()
            if name.lower()
            in {
                "content-type",
                "retry-after",
                "x-correlation-id",
                "x-request-id",
            }
        }
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            headers=response_headers,
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _require_signing_key(self) -> bytes:
        if self._signing_key is None:
            raise ValueError("platform context signing key is not configured")
        return self._signing_key

    @staticmethod
    def _base64url(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")

    @staticmethod
    def _decode_base64url(value: str) -> bytes:
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        if not value or any(character not in alphabet for character in value):
            raise ValueError("invalid base64url")
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        if BacklinksGateway._base64url(decoded) != value:
            raise ValueError("non-canonical base64url")
        return decoded

    @staticmethod
    def _ticket_mapping(payload: object, name: str) -> dict[str, object]:
        if not isinstance(payload, dict) or not isinstance(payload.get(name), dict):
            raise ValueError(f"invalid OAuth callback ticket {name}")
        return payload[name]

    @staticmethod
    def _ticket_string(payload: object, name: str) -> str:
        if not isinstance(payload, dict):
            raise ValueError(f"invalid OAuth callback ticket {name}")
        value = payload.get(name)
        if not isinstance(value, str) or not value or value != value.strip():
            raise ValueError(f"invalid OAuth callback ticket {name}")
        return value

    @staticmethod
    def _ticket_strings(payload: object, name: str) -> tuple[str, ...]:
        if not isinstance(payload, dict):
            raise ValueError(f"invalid OAuth callback ticket {name}")
        values = payload.get(name)
        if (
            not isinstance(values, list)
            or not values
            or any(not isinstance(value, str) or not value for value in values)
            or len(set(values)) != len(values)
        ):
            raise ValueError(f"invalid OAuth callback ticket {name}")
        return tuple(values)

    @staticmethod
    def _ticket_integer(payload: object, name: str) -> int:
        if not isinstance(payload, dict):
            raise ValueError(f"invalid OAuth callback ticket {name}")
        value = payload.get(name)
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError(f"invalid OAuth callback ticket {name}")
        return value

    @staticmethod
    def _requires_idempotency_key(request: Request) -> bool:
        if request.method == "PATCH":
            return request.url.path.endswith("/management")
        if request.method != "POST":
            return False
        return (
            request.url.path.endswith("/reject")
            or request.url.path.endswith("/placement-candidates")
            or request.url.path.endswith("/recommendation-refill-jobs")
            or request.url.path.endswith("/reverify")
            or request.url.path.endswith("/send-intents")
            or request.url.path.endswith("/transition")
        )
