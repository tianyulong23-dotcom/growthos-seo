from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response

from app.core.platform_request_context import (
    ResolvedPlatformCollectionContext,
    ResolvedPlatformRequestContext,
    issue_platform_request_context_v1,
    strip_untrusted_platform_context_headers,
)


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
    ) -> ResolvedPlatformRequestContext:
        del request, website_project_key
        raise self._error()

    @staticmethod
    def _error() -> PlatformContextResolutionError:
        return PlatformContextResolutionError(
            status=401,
            code="PLATFORM_AUTHENTICATION_REQUIRED",
            title="Platform authentication required",
            detail="The platform could not resolve an authenticated request context.",
        )


@dataclass(frozen=True)
class ProjectContextProjectionDelivery:
    published: bool
    error: str | None


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

    async def project_context_changed(
        self,
        *,
        resolved: ResolvedPlatformRequestContext,
        payload: dict[str, object],
    ) -> ProjectContextProjectionDelivery:
        try:
            signed_context = issue_platform_request_context_v1(
                resolved,
                signing_key=self._require_signing_key(),
                now=datetime.now(UTC),
            )
        except ValueError:
            return ProjectContextProjectionDelivery(
                published=False,
                error="Backlinks gateway signing configuration is unavailable.",
            )
        headers = {
            "content-type": "application/json",
            "x-correlation-id": resolved.correlation_id,
            **signed_context,
        }
        try:
            upstream = await self._client.post(
                (
                    f"{self._base_url}/internal/v1/projects/"
                    f"{resolved.project.website_project_key}/backlinks/"
                    "project-context-projection"
                ),
                headers=headers,
                json=payload,
            )
        except httpx.RequestError:
            return ProjectContextProjectionDelivery(
                published=False,
                error="The Backlinks service could not be reached.",
            )
        if 200 <= upstream.status_code < 300:
            return ProjectContextProjectionDelivery(published=True, error=None)
        return ProjectContextProjectionDelivery(
            published=False,
            error=f"Backlinks Core rejected the projection with HTTP {upstream.status_code}.",
        )

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
            or request.url.path.endswith("/contacts/candidates")
            or request.url.path.endswith("/opportunities")
        )
