from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from app.core.backlinks_gateway import PlatformContextResolutionError, PlatformContextResolver
from app.core.platform_request_context import ResolvedPlatformRequestContext
from app.modules.content.asset_schemas import (
    AssetCollectionResponse,
    AssetDownloadAuthorizationRequest,
    AssetDownloadAuthorizationResponse,
    AssetImportRequest,
    AssetProblemResponse,
    AssetResponse,
    AssetStatus,
    AssetUpdateRequest,
    AssetUsageResponse,
    AssetUploadCompleteRequest,
    AssetUploadCreateRequest,
    AssetUploadCreateResponse,
    AssetUploadPartResponse,
)
from app.modules.content.asset_service import AssetError, AssetService, build_asset_service
from app.modules.content.asset_repository import AssetAuditContext


router = APIRouter(prefix="/api/v1/projects/{project_id}/assets", tags=["content-assets"])


def get_asset_service() -> AssetService:
    return build_asset_service()


def asset_audit_context(
    request: Request, context: ResolvedPlatformRequestContext
) -> AssetAuditContext:
    return AssetAuditContext(
        actor_id=context.actor.user_id,
        effective_role="|".join(sorted(context.actor.roles)),
        request_id=request.headers.get("x-request-id"),
        correlation_id=context.correlation_id,
    )


async def read_limited_body(request: Request, maximum_bytes: int) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared_length = int(content_length)
        except ValueError as exc:
            raise AssetError(
                "asset_content_length_invalid",
                "The Content-Length header is invalid.",
                status_code=400,
            ) from exc
        if declared_length < 0:
            raise AssetError(
                "asset_content_length_invalid",
                "The Content-Length header is invalid.",
                status_code=400,
            )
        if declared_length > maximum_bytes:
            raise AssetError(
                "asset_part_too_large",
                "The upload part exceeds the configured size.",
                status_code=413,
            )
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > maximum_bytes:
            raise AssetError(
                "asset_part_too_large",
                "The upload part exceeds the configured size.",
                status_code=413,
            )
    return bytes(body)


def asset_problem(request: Request, exc: AssetError) -> JSONResponse:
    error: dict[str, object] = {
        "code": exc.code,
        "message": exc.message,
        "retryable": exc.retryable,
        **exc.details,
    }
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {**error, "request_id": request.headers.get("x-request-id")}},
    )


async def resolve_asset_context(
    request: Request, project_id: str, *, permission: str
) -> ResolvedPlatformRequestContext | JSONResponse:
    resolver: PlatformContextResolver = request.app.state.platform_context_resolver
    try:
        return await resolver.resolve(
            request=request,
            website_project_key=project_id,
            required_permission=permission,
        )
    except PlatformContextResolutionError as exc:
        return JSONResponse(
            status_code=exc.status,
            content={
                "error": {
                    "code": exc.code,
                    "message": exc.detail,
                    "retryable": False,
                    "request_id": request.headers.get("x-request-id"),
                },
            },
        )


@router.post(
    "/uploads",
    response_model=AssetUploadCreateResponse,
    responses={400: {"model": AssetProblemResponse}, 409: {"model": AssetProblemResponse}},
)
async def create_asset_upload(
    project_id: str,
    payload: AssetUploadCreateRequest,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> AssetUploadCreateResponse | JSONResponse:
    context = await resolve_asset_context(
        request, project_id, permission="content:manage_assets"
    )
    if isinstance(context, JSONResponse):
        return context
    canonical_project_id = context.project.website_project_id
    try:
        return await service.create_upload(
            project_id=canonical_project_id,
            user_id=context.actor.user_id,
            idempotency_key=idempotency_key or "",
            request=payload,
            audit=asset_audit_context(request, context),
        )
    except AssetError as exc:
        return asset_problem(request, exc)


@router.put(
    "/{asset_id}/content",
    response_model=AssetUploadPartResponse,
    responses={422: {"model": AssetProblemResponse}},
)
async def upload_asset_part(
    project_id: str,
    asset_id: str,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
    part_number: Annotated[int, Query(ge=1)],
    content_sha256: Annotated[str | None, Header(alias="Content-SHA256")] = None,
) -> AssetUploadPartResponse | JSONResponse:
    context = await resolve_asset_context(
        request, project_id, permission="content:manage_assets"
    )
    if isinstance(context, JSONResponse):
        return context
    canonical_project_id = context.project.website_project_id
    try:
        return await service.upload_part(
            project_id=canonical_project_id,
            asset_id=asset_id,
            part_number=part_number,
            body=await read_limited_body(
                request, service.settings.asset_upload_part_size
            ),
            declared_sha256=content_sha256,
        )
    except AssetError as exc:
        return asset_problem(request, exc)


@router.post("/{asset_id}/complete", response_model=AssetResponse)
async def complete_asset_upload(
    project_id: str,
    asset_id: str,
    payload: AssetUploadCompleteRequest,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
) -> AssetResponse | JSONResponse:
    context = await resolve_asset_context(
        request, project_id, permission="content:manage_assets"
    )
    if isinstance(context, JSONResponse):
        return context
    canonical_project_id = context.project.website_project_id
    try:
        return await service.complete_upload(
            project_id=canonical_project_id,
            asset_id=asset_id,
            request=payload,
            audit=asset_audit_context(request, context),
        )
    except AssetError as exc:
        return asset_problem(request, exc)


@router.get("/{asset_id}", response_model=AssetResponse)
async def get_asset(
    project_id: str,
    asset_id: str,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
) -> AssetResponse | JSONResponse:
    context = await resolve_asset_context(request, project_id, permission="content:read")
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.get_asset(context.project.website_project_id, asset_id)
    except AssetError as exc:
        return asset_problem(request, exc)


@router.patch("/{asset_id}", response_model=AssetResponse)
async def update_asset_metadata(
    project_id: str,
    asset_id: str,
    payload: AssetUpdateRequest,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
) -> AssetResponse | JSONResponse:
    context = await resolve_asset_context(
        request, project_id, permission="content:manage_assets"
    )
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.update_metadata(
            project_id=context.project.website_project_id,
            asset_id=asset_id,
            user_id=context.actor.user_id,
            request=payload,
            audit=asset_audit_context(request, context),
        )
    except AssetError as exc:
        return asset_problem(request, exc)


@router.get("/{asset_id}/usage", response_model=AssetUsageResponse)
async def get_asset_usage(
    project_id: str,
    asset_id: str,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
) -> AssetUsageResponse | JSONResponse:
    context = await resolve_asset_context(request, project_id, permission="content:read")
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.usage(context.project.website_project_id, asset_id)
    except AssetError as exc:
        return asset_problem(request, exc)


@router.post("/{asset_id}/retry", response_model=AssetResponse)
async def retry_asset(
    project_id: str,
    asset_id: str,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
) -> AssetResponse | JSONResponse:
    context = await resolve_asset_context(
        request, project_id, permission="content:manage_assets"
    )
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.retry(
            context.project.website_project_id,
            asset_id,
            audit=asset_audit_context(request, context),
        )
    except AssetError as exc:
        return asset_problem(request, exc)


@router.post("/{asset_id}/cancel", response_model=AssetResponse)
async def cancel_asset(
    project_id: str,
    asset_id: str,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
) -> AssetResponse | JSONResponse:
    context = await resolve_asset_context(
        request, project_id, permission="content:manage_assets"
    )
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.cancel(
            context.project.website_project_id,
            asset_id,
            audit=asset_audit_context(request, context),
        )
    except AssetError as exc:
        return asset_problem(request, exc)


@router.post("/import", response_model=AssetResponse)
async def import_asset(
    project_id: str,
    payload: AssetImportRequest,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> AssetResponse | JSONResponse:
    context = await resolve_asset_context(
        request, project_id, permission="content:manage_assets"
    )
    if isinstance(context, JSONResponse):
        return context
    canonical_project_id = context.project.website_project_id
    try:
        return await service.import_url(
            project_id=canonical_project_id,
            user_id=context.actor.user_id,
            idempotency_key=idempotency_key or "",
            request=payload,
            audit=asset_audit_context(request, context),
        )
    except (AssetError, ValueError) as exc:
        problem = (
            exc
            if isinstance(exc, AssetError)
            else AssetError(str(exc), "The import request is invalid.")
        )
        return asset_problem(request, problem)


@router.get("", response_model=AssetCollectionResponse)
async def list_assets(
    project_id: str,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
    asset_type: Annotated[str | None, Query(pattern="^(image|video|audio|file)$")] = None,
    status: Annotated[AssetStatus | None, Query()] = None,
    query: Annotated[str | None, Query(max_length=200)] = None,
    cursor: Annotated[str | None, Query(max_length=100)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> AssetCollectionResponse | JSONResponse:
    context = await resolve_asset_context(request, project_id, permission="content:read")
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.list_assets(
            project_id=context.project.website_project_id,
            asset_type=asset_type,
            status=status,
            query=query,
            cursor=cursor,
            limit=limit,
        )
    except AssetError as exc:
        return asset_problem(request, exc)


@router.get("/{asset_id}/download")
async def download_asset(
    project_id: str,
    asset_id: str,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
) -> Response:
    context = await resolve_asset_context(request, project_id, permission="content:read")
    if isinstance(context, JSONResponse):
        return context
    try:
        return RedirectResponse(
            await service.download_url(context.project.website_project_id, asset_id),
            status_code=307,
        )
    except AssetError as exc:
        return asset_problem(request, exc)


@router.post(
    "/{asset_id}/download-authorizations",
    response_model=AssetDownloadAuthorizationResponse,
)
async def authorize_asset_download(
    project_id: str,
    asset_id: str,
    payload: AssetDownloadAuthorizationRequest,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
) -> AssetDownloadAuthorizationResponse | JSONResponse:
    context = await resolve_asset_context(request, project_id, permission="content:read")
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.authorize_download(
            context.project.website_project_id,
            asset_id,
            disposition=payload.disposition,
            variant_type=payload.variant_type,
        )
    except AssetError as exc:
        return asset_problem(request, exc)


@router.delete("/{asset_id}", status_code=204)
async def delete_asset(
    project_id: str,
    asset_id: str,
    request: Request,
    service: Annotated[AssetService, Depends(get_asset_service)],
) -> Response:
    context = await resolve_asset_context(
        request, project_id, permission="content:manage_assets"
    )
    if isinstance(context, JSONResponse):
        return context
    try:
        await service.delete(
            context.project.website_project_id,
            asset_id,
            audit=asset_audit_context(request, context),
        )
        return Response(status_code=204)
    except AssetError as exc:
        return asset_problem(request, exc)
