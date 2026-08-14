from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request, status
from fastapi.responses import JSONResponse, StreamingResponse

from app.api.routes.content import (
    content_audit_context,
    content_problem,
    resolve_content_context,
)
from app.modules.content.ai_edit import AIEditValidationError
from app.modules.content.ai_edit_repository import AIEditRepositoryError
from app.modules.content.ai_edit_schemas import (
    AcceptAIEditRequest,
    AcceptAIEditResponse,
    AIEditOperationResponse,
    CreateAIEditRequest,
    CreateAIEditResponse,
    RejectAIEditRequest,
    RetryAIEditRequest,
)
from app.modules.content.ai_edit_service import AIEditService, build_ai_edit_service


router = APIRouter(
    prefix="/api/v1/projects/{project_id}/articles/{article_id}/ai-edits",
    tags=["content"],
)


def get_ai_edit_service() -> AIEditService:
    return build_ai_edit_service()


def ai_edit_error(request: Request, exc: Exception) -> JSONResponse:
    code = str(exc)
    retryable = isinstance(exc, AIEditRepositoryError) and exc.retryable
    if code in {"article_not_found", "ai_edit_not_found"}:
        status_code = 404
    elif code in {
        "ai_edit_stream_token_invalid",
        "ai_edit_stream_token_expired",
    }:
        status_code = 403
    elif code in {
        "ai_edit_concurrency_limit",
        "ai_edit_rate_limit",
        "ai_edit_quota_exhausted",
    }:
        status_code = 429
    elif code in {
        "ai_edit_provider_not_configured",
        "ai_edit_dispatch_failed",
    }:
        status_code = 503
    elif code in {
        "ai_edit_accept_idempotency_conflict",
        "ai_edit_document_stale",
        "ai_edit_idempotency_conflict",
        "ai_edit_not_acceptable",
        "ai_edit_not_rejectable",
        "ai_edit_not_retryable",
        "ai_edit_review_version_stale",
        "ai_edit_selection_stale",
        "ai_edit_stale",
    }:
        status_code = 409
    else:
        status_code = 422
    return content_problem(
        request,
        status_code=status_code,
        code=code,
        retryable=retryable,
    )


async def _edit_context(request: Request, project_id: str):
    return await resolve_content_context(request, project_id, permission="content:ai_edit")


@router.post(
    "",
    response_model=CreateAIEditResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_ai_edit(
    project_id: str,
    article_id: str,
    body: CreateAIEditRequest,
    request: Request,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
    service: Annotated[AIEditService, Depends(get_ai_edit_service)],
):
    context = await _edit_context(request, project_id)
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.create(
            context.tenant.organization_id,
            context.project.website_project_id,
            article_id,
            body,
            idempotency_key=idempotency_key,
            actor_id=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (AIEditRepositoryError, AIEditValidationError) as exc:
        return ai_edit_error(request, exc)


@router.get("/{operation_id}", response_model=AIEditOperationResponse)
async def get_ai_edit(
    project_id: str,
    article_id: str,
    operation_id: str,
    request: Request,
    service: Annotated[AIEditService, Depends(get_ai_edit_service)],
):
    context = await _edit_context(request, project_id)
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.get(
            context.tenant.organization_id,
            context.project.website_project_id,
            article_id,
            operation_id,
        )
    except (AIEditRepositoryError, AIEditValidationError) as exc:
        return ai_edit_error(request, exc)


@router.get("/{operation_id}/stream")
async def stream_ai_edit(
    project_id: str,
    article_id: str,
    operation_id: str,
    request: Request,
    token: Annotated[str, Query(min_length=32, max_length=200)],
    service: Annotated[AIEditService, Depends(get_ai_edit_service)],
):
    try:
        initial = await service.get_stream(project_id, article_id, operation_id, token)
    except (AIEditRepositoryError, AIEditValidationError) as exc:
        return ai_edit_error(request, exc)

    async def events() -> AsyncIterator[str]:
        current = initial
        last_revision = -1
        while True:
            if await request.is_disconnected():
                return
            if current.stream_revision != last_revision:
                last_revision = current.stream_revision
                yield (
                    "event: operation\n"
                    f"id: {last_revision}\n"
                    f"data: {current.model_dump_json(by_alias=True)}\n\n"
                )
            if current.status not in {"queued", "streaming"}:
                return
            await asyncio.sleep(0.25)
            try:
                current = await service.get_stream(project_id, article_id, operation_id, token)
            except AIEditRepositoryError as exc:
                yield (f'event: error\ndata: {{"code":"{exc.code}"}}\n\n')
                return

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{operation_id}/cancel", response_model=AIEditOperationResponse)
async def cancel_ai_edit(
    project_id: str,
    article_id: str,
    operation_id: str,
    request: Request,
    service: Annotated[AIEditService, Depends(get_ai_edit_service)],
):
    context = await _edit_context(request, project_id)
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.cancel(
            context.tenant.organization_id,
            context.project.website_project_id,
            article_id,
            operation_id,
            audit=content_audit_context(request, context),
        )
    except (AIEditRepositoryError, AIEditValidationError) as exc:
        return ai_edit_error(request, exc)


@router.post("/{operation_id}/reject", response_model=AIEditOperationResponse)
async def reject_ai_edit(
    project_id: str,
    article_id: str,
    operation_id: str,
    body: RejectAIEditRequest,
    request: Request,
    service: Annotated[AIEditService, Depends(get_ai_edit_service)],
):
    context = await _edit_context(request, project_id)
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.reject(
            context.tenant.organization_id,
            context.project.website_project_id,
            article_id,
            operation_id,
            reason=body.reason,
            audit=content_audit_context(request, context),
        )
    except (AIEditRepositoryError, AIEditValidationError) as exc:
        return ai_edit_error(request, exc)


@router.post("/{operation_id}/accept", response_model=AcceptAIEditResponse)
async def accept_ai_edit(
    project_id: str,
    article_id: str,
    operation_id: str,
    body: AcceptAIEditRequest,
    request: Request,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
    service: Annotated[AIEditService, Depends(get_ai_edit_service)],
):
    context = await _edit_context(request, project_id)
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.accept(
            context.tenant.organization_id,
            context.project.website_project_id,
            article_id,
            operation_id,
            body,
            idempotency_key=idempotency_key,
            actor_id=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (AIEditRepositoryError, AIEditValidationError) as exc:
        return ai_edit_error(request, exc)


@router.post("/{operation_id}/retry", response_model=CreateAIEditResponse)
async def retry_ai_edit(
    project_id: str,
    article_id: str,
    operation_id: str,
    body: RetryAIEditRequest,
    request: Request,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
    service: Annotated[AIEditService, Depends(get_ai_edit_service)],
):
    context = await _edit_context(request, project_id)
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.retry(
            context.tenant.organization_id,
            context.project.website_project_id,
            article_id,
            operation_id,
            body,
            idempotency_key=idempotency_key,
            actor_id=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (AIEditRepositoryError, AIEditValidationError) as exc:
        return ai_edit_error(request, exc)
