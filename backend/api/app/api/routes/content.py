from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse

from app.core.backlinks_gateway import (
    PlatformContextResolutionError,
    PlatformContextResolver,
)
from app.core.platform_request_context import ResolvedPlatformRequestContext

from app.modules.content.schemas import (
    ArticleCollection,
    ArticleDetailResponse,
    ArticleResponse,
    ArticleRunResponse,
    ArticleStatus,
    CreateArticleRequest,
    ReviewArticleRequest,
)
from app.modules.content.service import (
    ContentConflictError,
    ContentNotFoundError,
    ContentService,
    build_content_service,
)
from app.modules.content_plan.schemas import (
    AutomaticBatchAcceptedResponse,
    BatchRetryAcceptedResponse,
    CancelContentPlanItemRequest,
    ContentPlanBatchCollectionResponse,
    ContentPlanBatchResponse,
    ContentPlanItemCollectionResponse,
    ContentPlanItemResponse,
    ContentPlanSettingsResponse,
    CreateManualPlanItemRequest,
    ManualPlanAcceptedResponse,
    PlanItemEditAcceptedResponse,
    UpdateContentPlanItemRequest,
    UpdateContentPlanSettingsRequest,
)
from app.modules.content_plan.batch_service import (
    ContentPlanBatchError,
    ContentPlanBatchService,
    build_content_plan_batch_service,
)
from app.modules.content_plan.d6_service import (
    ContentPlanD6Service,
    ContentPlanWorkflowError,
    build_content_plan_d6_service,
)
from app.modules.content_plan.settings_service import (
    ContentPlanSettingsConflictError,
    ContentPlanSettingsNotFoundError,
    ContentPlanSettingsService,
    build_content_plan_settings_service,
)


router = APIRouter(prefix="/api/v1/projects/{project_id}/articles", tags=["content"])
content_plan_router = APIRouter(
    prefix="/api/v1/projects/{project_id}/content-plan", tags=["content-plan"]
)


def get_content_service() -> ContentService:
    return build_content_service()


def get_content_plan_settings_service() -> ContentPlanSettingsService:
    return build_content_plan_settings_service()


def get_content_plan_d6_service() -> ContentPlanD6Service:
    return build_content_plan_d6_service()


def get_content_plan_batch_service() -> ContentPlanBatchService:
    return build_content_plan_batch_service()


def content_error(exc: Exception) -> HTTPException:
    if isinstance(exc, ContentNotFoundError):
        return HTTPException(status_code=404, detail="项目或文章任务不存在")
    if isinstance(exc, ContentConflictError):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=422, detail=str(exc))
    return HTTPException(status_code=500, detail="文章任务请求失败")


def content_problem(
    request: Request,
    *,
    status_code: int,
    code: str,
    message: str | None = None,
    retryable: bool = False,
    conflict_id: str | None = None,
    current_version: int | None = None,
) -> JSONResponse:
    error: dict[str, object] = {
        "code": code,
        "message": message or code,
        "retryable": retryable,
    }
    if conflict_id is not None:
        error["conflict_id"] = conflict_id
    if current_version is not None:
        error["current_version"] = current_version
    return JSONResponse(
        status_code=status_code,
        content={
            "error": error,
            "request_id": request.headers.get("x-request-id"),
        },
    )


def content_plan_d6_error(request: Request, exc: ContentPlanWorkflowError) -> JSONResponse:
    status_code = 503 if exc.retryable else 422
    if exc.code in {
        "content_plan_item_not_found",
        "content_plan_preparation_not_found",
        "project_not_found",
    }:
        status_code = 404
    elif exc.code in {
        "idempotency_key_conflict",
        "plan_keyword_conflict",
        "primary_keyword_covered",
        "schedule_date_conflict",
        "stale_version",
        "plan_not_editable",
        "preparation_superseded",
    }:
        status_code = 409
    return content_problem(
        request,
        status_code=status_code,
        code=exc.code,
        message=exc.message,
        retryable=exc.retryable,
        conflict_id=exc.conflict_id,
        current_version=exc.current_version,
    )


def content_plan_batch_error(
    request: Request, exc: ContentPlanBatchError
) -> JSONResponse:
    status_code = 503 if exc.retryable else 422
    if exc.code in {
        "content_plan_batch_not_found",
        "project_or_content_plan_settings_not_found",
    }:
        status_code = 404
    elif exc.code in {
        "active_automatic_batch_exists",
        "content_plan_batch_not_retryable",
        "idempotency_key_conflict",
    }:
        status_code = 409
    return content_problem(
        request,
        status_code=status_code,
        code=exc.code,
        message=exc.message,
        retryable=exc.retryable,
        conflict_id=exc.conflict_id,
    )


async def resolve_content_context(
    request: Request,
    project_id: str,
    *,
    permission: str,
) -> ResolvedPlatformRequestContext | JSONResponse:
    resolver: PlatformContextResolver = request.app.state.platform_context_resolver
    try:
        return await resolver.resolve(
            request=request,
            website_project_key=project_id,
            required_permission=permission,
        )
    except PlatformContextResolutionError as exc:
        return content_problem(
            request,
            status_code=exc.status,
            code=exc.code,
            message=exc.detail,
        )


def content_plan_settings_error(request: Request, exc: Exception) -> JSONResponse:
    if isinstance(exc, ContentPlanSettingsNotFoundError):
        return content_problem(request, status_code=404, code=str(exc))
    if isinstance(exc, ContentPlanSettingsConflictError):
        return content_problem(request, status_code=409, code=str(exc))
    if isinstance(exc, ValueError):
        return content_problem(request, status_code=422, code=str(exc))
    return content_problem(
        request,
        status_code=500,
        code="content_plan_settings_failed",
        retryable=True,
    )


def d5_content_error(
    request: Request,
    exc: Exception,
    *,
    not_found_code: str,
) -> JSONResponse:
    if isinstance(exc, ContentNotFoundError):
        return content_problem(request, status_code=404, code=not_found_code)
    if isinstance(exc, ContentConflictError):
        return content_problem(request, status_code=409, code=str(exc))
    if isinstance(exc, ValueError):
        return content_problem(request, status_code=422, code=str(exc))
    return content_problem(
        request,
        status_code=500,
        code="content_workflow_failed",
        retryable=True,
    )


@router.post("", response_model=ArticleResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_article(
    project_id: str,
    request: CreateArticleRequest,
    http_request: Request,
    idempotency_key: Annotated[
        str, Header(alias="Idempotency-Key", min_length=1, max_length=200)
    ],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleResponse:
    try:
        context = await resolve_content_context(
            http_request, project_id, permission="content:write"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.create_article(
            context.project.website_project_id,
            request,
            idempotency_key,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        raise content_error(exc) from exc


@router.get("", response_model=ArticleCollection)
async def list_articles(
    project_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 25,
    article_status: Annotated[ArticleStatus | None, Query(alias="status")] = None,
    search: Annotated[str | None, Query(max_length=200)] = None,
) -> ArticleCollection:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:read"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.list_articles(
            context.project.website_project_id,
            page,
            page_size,
            article_status,
            search,
            organization_id=context.tenant.organization_id,
        )
    except ContentNotFoundError as exc:
        raise content_error(exc) from exc


@router.get("/{article_id}", response_model=ArticleDetailResponse)
async def get_article(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleDetailResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:read"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.get_article(
            context.project.website_project_id,
            article_id,
            organization_id=context.tenant.organization_id,
        )
    except ContentNotFoundError as exc:
        raise content_error(exc) from exc


@router.get("/{article_id}/run", response_model=ArticleRunResponse)
async def get_article_run(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleRunResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:read"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.get_run(
            context.project.website_project_id,
            article_id,
            organization_id=context.tenant.organization_id,
        )
    except ContentNotFoundError as exc:
        raise content_error(exc) from exc


@router.post("/{article_id}/cancel", response_model=ArticleResponse)
async def cancel_article(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:write"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.cancel_article(
            context.project.website_project_id,
            article_id,
            organization_id=context.tenant.organization_id,
        )
    except ContentNotFoundError as exc:
        raise content_error(exc) from exc


@router.patch("/{article_id}/review", response_model=ArticleResponse)
async def review_article(
    project_id: str,
    article_id: str,
    review: ReviewArticleRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:write"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.review_article(
            context.project.website_project_id,
            article_id,
            review,
            organization_id=context.tenant.organization_id,
            reviewed_by=context.actor.user_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(
            request,
            exc,
            not_found_code="article_not_found",
        )


@content_plan_router.post("/items/{item_id}/generate-now", response_model=ArticleResponse)
async def generate_plan_item_now(
    project_id: str,
    item_id: str,
    request: Request,
    expected_version: Annotated[int, Query(ge=1)],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:write"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.generate_plan_item_now(
            context.project.website_project_id,
            item_id,
            expected_version=expected_version,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(
            request,
            exc,
            not_found_code="content_plan_item_not_found",
        )


@content_plan_router.post(
    "/batches",
    response_model=AutomaticBatchAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_automatic_content_plan_batch(
    project_id: str,
    request: Request,
    service: Annotated[
        ContentPlanBatchService, Depends(get_content_plan_batch_service)
    ],
    idempotency_key: Annotated[
        str | None, Header(alias="Idempotency-Key", max_length=200)
    ] = None,
) -> AutomaticBatchAcceptedResponse:
    context = await resolve_content_context(
        request, project_id, permission="content:write"
    )
    if isinstance(context, JSONResponse):
        return context
    if await request.body():
        return content_problem(
            request,
            status_code=422,
            code="request_body_not_allowed",
        )
    if idempotency_key is None or not idempotency_key.strip():
        return content_problem(
            request,
            status_code=422,
            code="idempotency_key_required",
        )
    try:
        return await service.create_automatic(
            context.tenant.organization_id,
            context.project.website_project_id,
            idempotency_key=idempotency_key.strip(),
        )
    except ContentPlanBatchError as exc:
        return content_plan_batch_error(request, exc)


@content_plan_router.get(
    "/batches", response_model=ContentPlanBatchCollectionResponse
)
async def list_content_plan_batches(
    project_id: str,
    request: Request,
    service: Annotated[
        ContentPlanBatchService, Depends(get_content_plan_batch_service)
    ],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> ContentPlanBatchCollectionResponse:
    context = await resolve_content_context(
        request, project_id, permission="content:read"
    )
    if isinstance(context, JSONResponse):
        return context
    return await service.list_batches(
        context.tenant.organization_id,
        context.project.website_project_id,
        limit=limit,
    )


@content_plan_router.get(
    "/batches/{batch_id}", response_model=ContentPlanBatchResponse
)
async def get_automatic_content_plan_batch(
    project_id: str,
    batch_id: str,
    request: Request,
    service: Annotated[
        ContentPlanBatchService, Depends(get_content_plan_batch_service)
    ],
) -> ContentPlanBatchResponse:
    context = await resolve_content_context(
        request, project_id, permission="content:read"
    )
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.get_batch(
            context.tenant.organization_id,
            context.project.website_project_id,
            batch_id,
        )
    except ContentPlanBatchError as exc:
        return content_plan_batch_error(request, exc)


@content_plan_router.post(
    "/batches/{batch_id}/retry",
    response_model=BatchRetryAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def retry_automatic_content_plan_batch(
    project_id: str,
    batch_id: str,
    request: Request,
    service: Annotated[
        ContentPlanBatchService, Depends(get_content_plan_batch_service)
    ],
) -> BatchRetryAcceptedResponse:
    context = await resolve_content_context(
        request, project_id, permission="content:write"
    )
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.retry_batch(
            context.tenant.organization_id,
            context.project.website_project_id,
            batch_id,
        )
    except ContentPlanBatchError as exc:
        return content_plan_batch_error(request, exc)


@content_plan_router.get("/items", response_model=ContentPlanItemCollectionResponse)
async def list_content_plan_items(
    project_id: str,
    request: Request,
    service: Annotated[ContentPlanD6Service, Depends(get_content_plan_d6_service)],
    start_date: Annotated[date | None, Query()] = None,
    end_date: Annotated[date | None, Query()] = None,
    item_statuses: Annotated[list[str] | None, Query(alias="status")] = None,
) -> ContentPlanItemCollectionResponse:
    context = await resolve_content_context(
        request, project_id, permission="content:read"
    )
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.list_items(
            context.tenant.organization_id,
            context.project.website_project_id,
            start_date=start_date,
            end_date=end_date,
            statuses=tuple(item_statuses or ()),
        )
    except ContentPlanWorkflowError as exc:
        return content_plan_d6_error(request, exc)


@content_plan_router.post(
    "/items",
    response_model=ManualPlanAcceptedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_manual_content_plan_item(
    project_id: str,
    body: CreateManualPlanItemRequest,
    request: Request,
    service: Annotated[ContentPlanD6Service, Depends(get_content_plan_d6_service)],
    idempotency_key: Annotated[
        str | None, Header(alias="Idempotency-Key", max_length=200)
    ] = None,
) -> ManualPlanAcceptedResponse:
    context = await resolve_content_context(
        request, project_id, permission="content:write"
    )
    if isinstance(context, JSONResponse):
        return context
    if idempotency_key is None or not idempotency_key.strip():
        return content_problem(
            request,
            status_code=422,
            code="idempotency_key_required",
        )
    try:
        return await service.create_manual(
            context.tenant.organization_id,
            context.project.website_project_id,
            body,
            idempotency_key=idempotency_key.strip(),
        )
    except ContentPlanWorkflowError as exc:
        return content_plan_d6_error(request, exc)


@content_plan_router.get(
    "/items/{item_id}", response_model=ContentPlanItemResponse
)
async def get_content_plan_item(
    project_id: str,
    item_id: str,
    request: Request,
    service: Annotated[ContentPlanD6Service, Depends(get_content_plan_d6_service)],
) -> ContentPlanItemResponse:
    context = await resolve_content_context(
        request, project_id, permission="content:read"
    )
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.get_item(
            context.tenant.organization_id,
            context.project.website_project_id,
            item_id,
        )
    except ContentPlanWorkflowError as exc:
        return content_plan_d6_error(request, exc)


@content_plan_router.patch(
    "/items/{item_id}",
    response_model=ContentPlanItemResponse | PlanItemEditAcceptedResponse,
)
async def update_content_plan_item(
    project_id: str,
    item_id: str,
    body: UpdateContentPlanItemRequest,
    request: Request,
    response: Response,
    service: Annotated[ContentPlanD6Service, Depends(get_content_plan_d6_service)],
) -> ContentPlanItemResponse | PlanItemEditAcceptedResponse:
    context = await resolve_content_context(
        request, project_id, permission="content:write"
    )
    if isinstance(context, JSONResponse):
        return context
    try:
        result = await service.update_item(
            context.tenant.organization_id,
            context.project.website_project_id,
            item_id,
            body,
        )
        if isinstance(result, PlanItemEditAcceptedResponse):
            response.status_code = status.HTTP_202_ACCEPTED
        return result
    except ContentPlanWorkflowError as exc:
        return content_plan_d6_error(request, exc)


@content_plan_router.post(
    "/items/{item_id}/cancel", response_model=ContentPlanItemResponse
)
async def cancel_content_plan_item(
    project_id: str,
    item_id: str,
    body: CancelContentPlanItemRequest,
    request: Request,
    service: Annotated[ContentPlanD6Service, Depends(get_content_plan_d6_service)],
) -> ContentPlanItemResponse:
    context = await resolve_content_context(
        request, project_id, permission="content:write"
    )
    if isinstance(context, JSONResponse):
        return context
    try:
        return await service.cancel_item(
            context.tenant.organization_id,
            context.project.website_project_id,
            item_id,
            expected_version=body.version,
        )
    except ContentPlanWorkflowError as exc:
        return content_plan_d6_error(request, exc)


@content_plan_router.get("/settings", response_model=ContentPlanSettingsResponse)
async def get_content_plan_settings(
    project_id: str,
    request: Request,
    service: Annotated[
        ContentPlanSettingsService, Depends(get_content_plan_settings_service)
    ],
) -> ContentPlanSettingsResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:read"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.get_settings(
            context.tenant.organization_id,
            context.project.website_project_id,
        )
    except (ContentPlanSettingsNotFoundError, ValueError) as exc:
        return content_plan_settings_error(request, exc)


@content_plan_router.patch("/settings", response_model=ContentPlanSettingsResponse)
async def update_content_plan_settings(
    project_id: str,
    body: UpdateContentPlanSettingsRequest,
    request: Request,
    service: Annotated[
        ContentPlanSettingsService, Depends(get_content_plan_settings_service)
    ],
) -> ContentPlanSettingsResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:write"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.update_settings(
            context.tenant.organization_id,
            context.project.website_project_id,
            body,
        )
    except (
        ContentPlanSettingsNotFoundError,
        ContentPlanSettingsConflictError,
        ValueError,
    ) as exc:
        return content_plan_settings_error(request, exc)
