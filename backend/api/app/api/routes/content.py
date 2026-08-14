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
    ArticleAutosaveRequest,
    ArticleAutosaveResponse,
    ArticleAutosaveSnapshot,
    ArticleCollection,
    ArticleDetailResponse,
    ArticleDocumentCapabilities,
    ArticleResponse,
    ArticleRunResponse,
    ArticleSeoAnalysisRequest,
    ArticleSeoAnalysisResponse,
    ArticleLinkAnalysisRequest,
    ArticleLinkAnalysisResponse,
    ArticleStatus,
    ArticleVersionCollection,
    ArticleVersionDetail,
    ArticleVersionDiff,
    AddArticleReviewCommentRequest,
    AcquireArticleLockRequest,
    ArticleLockResponse,
    ArticleLockType,
    ArticleReviewCommentResponse,
    ArticleReviewSnapshotResponse,
    ArticleReviewTaskCollection,
    ArticleReviewTaskResponse,
    ArticleReviewTaskStatus,
    CancelArticleReviewRequest,
    ClaimArticleReviewRequest,
    ContentProblemResponse,
    CreateArticleRequest,
    DecideArticleReviewRequest,
    BookmarkResolveRequest,
    BookmarkResolveResponse,
    EmbedResolveRequest,
    EmbedResolveResponse,
    FactSourceCandidateCollection,
    ForceReleaseArticleLockRequest,
    InternalLinkCandidateCollection,
    PublishArticleRequest,
    PromoteArticleAutosaveRequest,
    ReleaseArticleLockRequest,
    RenewArticleLockRequest,
    RestoreArticleVersionRequest,
    ReviewArticleRequest,
    SubmitArticleReviewRequest,
    UpdateArticleDocumentRequest,
)
from app.modules.content.service import (
    ContentConfigurationError,
    ContentConflictError,
    ContentNotFoundError,
    ContentPermissionError,
    ContentService,
    build_content_service,
)
from app.modules.content.repository import ContentAuditContext
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
content_governance_router = APIRouter(
    prefix="/api/v1/projects/{project_id}", tags=["content"]
)
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
    details: dict[str, object] | None = None,
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
    if details:
        error.update(details)
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


def content_plan_batch_error(request: Request, exc: ContentPlanBatchError) -> JSONResponse:
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
        context = await resolver.resolve(
            request=request,
            website_project_key=project_id,
            required_permission=permission,
        )
        if permission not in context.permissions:
            return content_problem(
                request,
                status_code=403,
                code="PLATFORM_PERMISSION_DENIED",
            )
        return context
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


def content_audit_context(
    request: Request,
    context: ResolvedPlatformRequestContext,
) -> ContentAuditContext:
    return ContentAuditContext(
        actor_id=context.actor.user_id,
        effective_role="|".join(sorted(context.actor.roles)) or "unknown",
        request_id=request.headers.get("x-request-id"),
        correlation_id=context.correlation_id,
    )


def article_lock_permission(lock_type: str) -> str:
    if lock_type != "edit_lock":
        raise ValueError("article_lock_type_invalid")
    return "content:edit"


def d5_content_error(
    request: Request,
    exc: Exception,
    *,
    not_found_code: str,
) -> JSONResponse:
    if isinstance(exc, ContentNotFoundError):
        return content_problem(request, status_code=404, code=not_found_code)
    if isinstance(exc, ContentConflictError):
        return content_problem(
            request,
            status_code=409,
            code=str(exc),
            current_version=exc.current_version,
            details=exc.details,
        )
    if isinstance(exc, ContentConfigurationError):
        return content_problem(request, status_code=422, code=str(exc))
    if isinstance(exc, ContentPermissionError):
        return content_problem(request, status_code=403, code=str(exc))
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
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
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
        context = await resolve_content_context(request, project_id, permission="content:read")
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
        context = await resolve_content_context(request, project_id, permission="content:read")
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
        context = await resolve_content_context(request, project_id, permission="content:read")
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
        context = await resolve_content_context(request, project_id, permission="content:write")
        if isinstance(context, JSONResponse):
            return context
        return await service.cancel_article(
            context.project.website_project_id,
            article_id,
            organization_id=context.tenant.organization_id,
        )
    except ContentNotFoundError as exc:
        raise content_error(exc) from exc


async def followup_article_run(
    project_id: str,
    article_id: str,
    trigger_type: str,
    request: Request,
    idempotency_key: str,
    service: ContentService,
) -> ArticleResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:write")
        if isinstance(context, JSONResponse):
            return context
        return await service.create_followup_run(
            context.project.website_project_id,
            article_id,
            trigger_type,
            idempotency_key,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.post("/{article_id}/retry", response_model=ArticleResponse, status_code=202)
async def retry_article(
    project_id: str,
    article_id: str,
    request: Request,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleResponse:
    return await followup_article_run(
        project_id, article_id, "retry", request, idempotency_key, service
    )


@router.post("/{article_id}/regenerate", response_model=ArticleResponse, status_code=202)
async def regenerate_article(
    project_id: str,
    article_id: str,
    request: Request,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleResponse:
    return await followup_article_run(
        project_id, article_id, "regeneration", request, idempotency_key, service
    )


@router.patch("/{article_id}/review", response_model=ArticleResponse)
async def review_article(
    project_id: str,
    article_id: str,
    review: ReviewArticleRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleResponse:
    del project_id, article_id, review, service
    return content_problem(
        request,
        status_code=409,
        code="article_review_endpoint_migrated",
        message="请使用审核任务接口完成提交、领取和审核决定",
    )


@router.post(
    "/{article_id}/review-tasks",
    response_model=ArticleReviewTaskResponse,
    status_code=status.HTTP_201_CREATED,
)
async def submit_article_review(
    project_id: str,
    article_id: str,
    body: SubmitArticleReviewRequest,
    request: Request,
    idempotency_key: Annotated[
        str, Header(alias="Idempotency-Key", min_length=1, max_length=200)
    ],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleReviewTaskResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:submit_review"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.submit_article_review(
            context.project.website_project_id,
            article_id,
            body,
            idempotency_key,
            organization_id=context.tenant.organization_id,
            submitted_by=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (ContentNotFoundError, ContentConflictError, ContentPermissionError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.get(
    "/{article_id}/review-tasks",
    response_model=ArticleReviewTaskCollection,
)
async def list_article_review_tasks(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
    statuses: Annotated[list[ArticleReviewTaskStatus] | None, Query()] = None,
) -> ArticleReviewTaskCollection:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:read"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.list_article_review_tasks(
            context.project.website_project_id,
            organization_id=context.tenant.organization_id,
            article_id=article_id,
            statuses=set(statuses) if statuses else None,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@content_governance_router.get(
    "/review-tasks",
    response_model=ArticleReviewTaskCollection,
)
async def list_review_inbox(
    project_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
    statuses: Annotated[list[ArticleReviewTaskStatus] | None, Query()] = None,
) -> ArticleReviewTaskCollection:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:review"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.list_article_review_tasks(
            context.project.website_project_id,
            organization_id=context.tenant.organization_id,
            statuses=set(statuses) if statuses else {"pending", "in_review"},
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_review_task_not_found")


@content_governance_router.get(
    "/review-tasks/{task_id}",
    response_model=ArticleReviewTaskResponse,
)
async def get_article_review_task(
    project_id: str,
    task_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleReviewTaskResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:review"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.get_article_review_task(
            context.project.website_project_id,
            task_id,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_review_task_not_found")


@content_governance_router.post(
    "/review-tasks/{task_id}/claim",
    response_model=ArticleReviewTaskResponse,
)
async def claim_article_review_task(
    project_id: str,
    task_id: str,
    body: ClaimArticleReviewRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleReviewTaskResponse:
    del body
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:review"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.claim_article_review_task(
            context.project.website_project_id,
            task_id,
            organization_id=context.tenant.organization_id,
            reviewer_id=context.actor.user_id,
            reviewer_groups=set(context.actor.roles),
            audit=content_audit_context(request, context),
        )
    except (ContentNotFoundError, ContentConflictError, ContentPermissionError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_review_task_not_found")


@content_governance_router.post(
    "/review-tasks/{task_id}/comments",
    response_model=ArticleReviewCommentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_article_review_comment(
    project_id: str,
    task_id: str,
    body: AddArticleReviewCommentRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleReviewCommentResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:review"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.add_article_review_comment(
            context.project.website_project_id,
            task_id,
            body,
            organization_id=context.tenant.organization_id,
            author_id=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (ContentNotFoundError, ContentConflictError, ContentPermissionError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_review_task_not_found")


@content_governance_router.post(
    "/review-tasks/{task_id}/decision",
    response_model=ArticleReviewTaskResponse,
)
async def decide_article_review_task(
    project_id: str,
    task_id: str,
    body: DecideArticleReviewRequest,
    request: Request,
    idempotency_key: Annotated[
        str, Header(alias="Idempotency-Key", min_length=1, max_length=200)
    ],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleReviewTaskResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:review"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.decide_article_review_task(
            context.project.website_project_id,
            task_id,
            body,
            idempotency_key,
            organization_id=context.tenant.organization_id,
            reviewer_id=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (ContentNotFoundError, ContentConflictError, ContentPermissionError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_review_task_not_found")


@content_governance_router.post(
    "/review-tasks/{task_id}/cancel",
    response_model=ArticleReviewTaskResponse,
)
async def cancel_article_review_task(
    project_id: str,
    task_id: str,
    body: CancelArticleReviewRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleReviewTaskResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:read"
        )
        if isinstance(context, JSONResponse):
            return context
        if not {
            "content:submit_review",
            "content:review",
        }.intersection(context.permissions):
            return content_problem(
                request,
                status_code=403,
                code="PLATFORM_PERMISSION_DENIED",
            )
        return await service.cancel_article_review_task(
            context.project.website_project_id,
            task_id,
            body,
            organization_id=context.tenant.organization_id,
            cancelled_by=context.actor.user_id,
            can_review="content:review" in context.permissions,
            audit=content_audit_context(request, context),
        )
    except (ContentNotFoundError, ContentConflictError, ContentPermissionError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_review_task_not_found")


@content_governance_router.get(
    "/review-tasks/{task_id}/snapshot",
    response_model=ArticleReviewSnapshotResponse,
)
async def get_article_review_snapshot(
    project_id: str,
    task_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleReviewSnapshotResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:review"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.get_article_review_snapshot(
            context.project.website_project_id,
            task_id,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ContentPermissionError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_review_task_not_found")


@router.post(
    "/{article_id}/locks",
    response_model=ArticleLockResponse,
    status_code=status.HTTP_201_CREATED,
)
async def acquire_article_lock(
    project_id: str,
    article_id: str,
    body: AcquireArticleLockRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleLockResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission=article_lock_permission(body.lock_type)
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.acquire_article_lock(
            context.project.website_project_id,
            article_id,
            body,
            organization_id=context.tenant.organization_id,
            owner_id=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (ContentNotFoundError, ContentConflictError, ContentPermissionError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.get(
    "/{article_id}/locks/active",
    response_model=ArticleLockResponse | None,
)
async def get_active_article_lock(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
    lock_type: Annotated[ArticleLockType, Query()] = "edit_lock",
) -> ArticleLockResponse | None:
    try:
        context = await resolve_content_context(
            request, project_id, permission=article_lock_permission(lock_type)
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.get_active_article_lock(
            context.project.website_project_id,
            article_id,
            organization_id=context.tenant.organization_id,
            lock_type=lock_type,
        )
    except (ContentNotFoundError, ContentConflictError, ContentPermissionError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.post(
    "/{article_id}/locks/{lock_id}/renew",
    response_model=ArticleLockResponse,
)
async def renew_article_lock(
    project_id: str,
    article_id: str,
    lock_id: str,
    body: RenewArticleLockRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleLockResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission=article_lock_permission(body.lock_type)
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.renew_article_lock(
            context.project.website_project_id,
            article_id,
            lock_id,
            body,
            organization_id=context.tenant.organization_id,
            owner_id=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (ContentNotFoundError, ContentConflictError, ContentPermissionError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_lock_not_found")


@router.post(
    "/{article_id}/locks/{lock_id}/release",
    response_model=ArticleLockResponse,
)
async def release_article_lock(
    project_id: str,
    article_id: str,
    lock_id: str,
    body: ReleaseArticleLockRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleLockResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission=article_lock_permission(body.lock_type)
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.release_article_lock(
            context.project.website_project_id,
            article_id,
            lock_id,
            body,
            organization_id=context.tenant.organization_id,
            owner_id=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (ContentNotFoundError, ContentConflictError, ContentPermissionError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_lock_not_found")


@router.delete(
    "/{article_id}/locks/{lock_id}",
    response_model=ArticleLockResponse,
)
async def delete_article_lock(
    project_id: str,
    article_id: str,
    lock_id: str,
    body: ReleaseArticleLockRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleLockResponse:
    return await release_article_lock(
        project_id, article_id, lock_id, body, request, service
    )


@router.post(
    "/{article_id}/locks/{lock_id}/force-release",
    response_model=ArticleLockResponse,
)
async def force_release_article_lock(
    project_id: str,
    article_id: str,
    lock_id: str,
    body: ForceReleaseArticleLockRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleLockResponse:
    try:
        context = await resolve_content_context(
            request, project_id, permission="content:manage_locks"
        )
        if isinstance(context, JSONResponse):
            return context
        return await service.force_release_article_lock(
            context.project.website_project_id,
            article_id,
            lock_id,
            body,
            organization_id=context.tenant.organization_id,
            released_by=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (ContentNotFoundError, ContentConflictError, ContentPermissionError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_lock_not_found")


@router.put(
    "/{article_id}/document",
    response_model=ArticleDetailResponse,
    responses={409: {"model": ContentProblemResponse, "description": "保存基线冲突"}},
)
async def update_article_document(
    project_id: str,
    article_id: str,
    document: UpdateArticleDocumentRequest,
    request: Request,
    lock_token: Annotated[str, Header(alias="X-Article-Lock-Token", min_length=32, max_length=500)],
    lock_fence: Annotated[int, Header(alias="X-Article-Lock-Fence", gt=0)],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleDetailResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:edit")
        if isinstance(context, JSONResponse):
            return context
        return await service.update_article_document(
            context.project.website_project_id,
            article_id,
            document,
            organization_id=context.tenant.organization_id,
            edited_by=context.actor.user_id,
            can_manage_seo_advanced=(
                "content:manage_seo_advanced" in context.permissions
            ),
            lock_token=lock_token,
            lock_fence=lock_fence,
            audit=content_audit_context(request, context),
        )
    except (
        ContentNotFoundError,
        ContentConflictError,
        ContentPermissionError,
        ValueError,
    ) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.get(
    "/{article_id}/document-capabilities",
    response_model=ArticleDocumentCapabilities,
)
async def get_article_document_capabilities(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleDocumentCapabilities:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.article_document_capabilities(
            context.project.website_project_id,
            article_id,
            organization_id=context.tenant.organization_id,
            user_id=context.actor.user_id,
            can_manage_seo_advanced=(
                "content:manage_seo_advanced" in context.permissions
            ),
            can_manage_locks="content:manage_locks" in context.permissions,
            can_manage_assets="content:manage_assets" in context.permissions,
        )
    except (
        ContentNotFoundError,
        ContentConflictError,
        ContentPermissionError,
        ValueError,
    ) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.post(
    "/{article_id}/seo-analysis",
    response_model=ArticleSeoAnalysisResponse,
)
async def analyze_article_seo(
    project_id: str,
    article_id: str,
    body: ArticleSeoAnalysisRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleSeoAnalysisResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:ai_edit")
        if isinstance(context, JSONResponse):
            return context
        return await service.analyze_article_seo(
            context.project.website_project_id,
            article_id,
            body,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.get(
    "/{article_id}/seo-analysis/latest",
    response_model=ArticleSeoAnalysisResponse,
)
async def get_latest_article_seo_analysis(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleSeoAnalysisResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.latest_article_seo_analysis(
            context.project.website_project_id,
            article_id,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.post(
    "/{article_id}/link-analysis",
    response_model=ArticleLinkAnalysisResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def analyze_article_links(
    project_id: str,
    article_id: str,
    body: ArticleLinkAnalysisRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleLinkAnalysisResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:ai_edit")
        if isinstance(context, JSONResponse):
            return context
        return await service.queue_article_link_analysis(
            context.project.website_project_id,
            article_id,
            body,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.get(
    "/{article_id}/link-analysis/latest",
    response_model=ArticleLinkAnalysisResponse,
)
async def get_latest_article_link_analysis(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleLinkAnalysisResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.latest_article_link_analysis(
            context.project.website_project_id,
            article_id,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@content_governance_router.get(
    "/internal-link-candidates",
    response_model=InternalLinkCandidateCollection,
)
async def get_internal_link_candidates(
    project_id: str,
    article_id: Annotated[str, Query(min_length=1)],
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
    query: Annotated[str, Query(max_length=500)] = "",
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> InternalLinkCandidateCollection:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.internal_link_candidates(
            context.project.website_project_id,
            article_id,
            query,
            cursor=cursor,
            limit=limit,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.get(
    "/{article_id}/fact-source-candidates",
    response_model=FactSourceCandidateCollection,
)
async def get_fact_source_candidates(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> FactSourceCandidateCollection:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.fact_source_candidates(
            context.project.website_project_id,
            article_id,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.post(
    "/{article_id}/bookmarks/resolve",
    response_model=BookmarkResolveResponse,
)
@router.post(
    "/{article_id}/bookmarks/refresh",
    response_model=BookmarkResolveResponse,
)
async def resolve_article_bookmark(
    project_id: str,
    article_id: str,
    body: BookmarkResolveRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> BookmarkResolveResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:ai_edit")
        if isinstance(context, JSONResponse):
            return context
        return await service.resolve_article_bookmark(
            context.project.website_project_id,
            article_id,
            body,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.post(
    "/{article_id}/embeds/resolve",
    response_model=EmbedResolveResponse,
)
async def resolve_article_embed(
    project_id: str,
    article_id: str,
    body: EmbedResolveRequest,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> EmbedResolveResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:ai_edit")
        if isinstance(context, JSONResponse):
            return context
        return await service.resolve_article_embed(
            context.project.website_project_id,
            article_id,
            body,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.put(
    "/{article_id}/autosave",
    response_model=ArticleAutosaveResponse,
    responses={
        409: {
            "model": ContentProblemResponse,
            "description": "自动保存乱序、幂等或版本基线冲突",
        }
    },
)
async def save_article_autosave(
    project_id: str,
    article_id: str,
    autosave: ArticleAutosaveRequest,
    request: Request,
    lock_token: Annotated[str, Header(alias="X-Article-Lock-Token", min_length=32, max_length=500)],
    lock_fence: Annotated[int, Header(alias="X-Article-Lock-Fence", gt=0)],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleAutosaveResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:edit")
        if isinstance(context, JSONResponse):
            return context
        return await service.save_article_autosave(
            context.project.website_project_id,
            article_id,
            autosave,
            organization_id=context.tenant.organization_id,
            user_id=context.actor.user_id,
            can_manage_seo_advanced=(
                "content:manage_seo_advanced" in context.permissions
            ),
            lock_token=lock_token,
            lock_fence=lock_fence,
        )
    except (
        ContentNotFoundError,
        ContentConflictError,
        ContentPermissionError,
        ValueError,
    ) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.get(
    "/{article_id}/autosaves/latest",
    response_model=ArticleAutosaveSnapshot | None,
)
async def get_latest_article_autosave(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
    client_id: Annotated[str | None, Query(min_length=1, max_length=200)] = None,
) -> ArticleAutosaveSnapshot | None:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.latest_article_autosave(
            context.project.website_project_id,
            article_id,
            organization_id=context.tenant.organization_id,
            user_id=context.actor.user_id,
            client_id=client_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.post(
    "/{article_id}/autosaves/{autosave_id}/promote",
    response_model=ArticleDetailResponse,
    responses={409: {"model": ContentProblemResponse, "description": "提升基线冲突"}},
)
async def promote_article_autosave(
    project_id: str,
    article_id: str,
    autosave_id: str,
    promotion: PromoteArticleAutosaveRequest,
    request: Request,
    lock_token: Annotated[str, Header(alias="X-Article-Lock-Token", min_length=32, max_length=500)],
    lock_fence: Annotated[int, Header(alias="X-Article-Lock-Fence", gt=0)],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleDetailResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:edit")
        if isinstance(context, JSONResponse):
            return context
        return await service.promote_article_autosave(
            context.project.website_project_id,
            article_id,
            autosave_id,
            promotion,
            organization_id=context.tenant.organization_id,
            user_id=context.actor.user_id,
            can_manage_seo_advanced=(
                "content:manage_seo_advanced" in context.permissions
            ),
            lock_token=lock_token,
            lock_fence=lock_fence,
            audit=content_audit_context(request, context),
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="autosave_not_found")


@router.delete(
    "/{article_id}/autosaves/{autosave_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_article_autosave(
    project_id: str,
    article_id: str,
    autosave_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> Response:
    try:
        context = await resolve_content_context(request, project_id, permission="content:edit")
        if isinstance(context, JSONResponse):
            return context
        await service.delete_article_autosave(
            context.project.website_project_id,
            article_id,
            autosave_id,
            organization_id=context.tenant.organization_id,
            user_id=context.actor.user_id,
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="autosave_not_found")


@router.get("/{article_id}/versions", response_model=ArticleVersionCollection)
async def list_article_versions(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleVersionCollection:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.list_article_versions(
            context.project.website_project_id,
            article_id,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@router.get("/{article_id}/versions/compare", response_model=ArticleVersionDiff)
async def compare_article_versions(
    project_id: str,
    article_id: str,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
    from_version: Annotated[int, Query(ge=1)],
    to_version: Annotated[int, Query(ge=1)],
) -> ArticleVersionDiff:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.compare_article_versions(
            context.project.website_project_id,
            article_id,
            from_version,
            to_version,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_version_not_found")


@router.get("/{article_id}/versions/{version_number}", response_model=ArticleVersionDetail)
async def get_article_version(
    project_id: str,
    article_id: str,
    version_number: int,
    request: Request,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleVersionDetail:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
        if isinstance(context, JSONResponse):
            return context
        return await service.get_article_version(
            context.project.website_project_id,
            article_id,
            version_number,
            organization_id=context.tenant.organization_id,
        )
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        return d5_content_error(request, exc, not_found_code="article_version_not_found")


@router.post(
    "/{article_id}/versions/{version_number}/restore",
    response_model=ArticleDetailResponse,
)
async def restore_article_version(
    project_id: str,
    article_id: str,
    version_number: int,
    restore: RestoreArticleVersionRequest,
    request: Request,
    lock_token: Annotated[str, Header(alias="X-Article-Lock-Token", min_length=32, max_length=500)],
    lock_fence: Annotated[int, Header(alias="X-Article-Lock-Fence", gt=0)],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleDetailResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:edit")
        if isinstance(context, JSONResponse):
            return context
        return await service.restore_article_version(
            context.project.website_project_id,
            article_id,
            version_number,
            restore,
            organization_id=context.tenant.organization_id,
            restored_by=context.actor.user_id,
            can_manage_seo_advanced=(
                "content:manage_seo_advanced" in context.permissions
            ),
            lock_token=lock_token,
            lock_fence=lock_fence,
            audit=content_audit_context(request, context),
        )
    except (
        ContentNotFoundError,
        ContentConflictError,
        ContentPermissionError,
        ValueError,
    ) as exc:
        return d5_content_error(request, exc, not_found_code="article_version_not_found")


@router.post("/{article_id}/publish", response_model=ArticleResponse)
async def publish_article(
    project_id: str,
    article_id: str,
    publish: PublishArticleRequest,
    request: Request,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:publish")
        if isinstance(context, JSONResponse):
            return context
        return await service.publish_article(
            context.project.website_project_id,
            article_id,
            publish,
            idempotency_key,
            organization_id=context.tenant.organization_id,
            created_by=context.actor.user_id,
            audit=content_audit_context(request, context),
        )
    except (
        ContentNotFoundError,
        ContentConflictError,
        ContentConfigurationError,
        ValueError,
    ) as exc:
        return d5_content_error(request, exc, not_found_code="article_not_found")


@content_plan_router.post("/items/{item_id}/generate-now", response_model=ArticleResponse)
async def generate_plan_item_now(
    project_id: str,
    item_id: str,
    request: Request,
    expected_version: Annotated[int, Query(ge=1)],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:write")
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
    service: Annotated[ContentPlanBatchService, Depends(get_content_plan_batch_service)],
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)] = None,
) -> AutomaticBatchAcceptedResponse:
    context = await resolve_content_context(request, project_id, permission="content:write")
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


@content_plan_router.get("/batches", response_model=ContentPlanBatchCollectionResponse)
async def list_content_plan_batches(
    project_id: str,
    request: Request,
    service: Annotated[ContentPlanBatchService, Depends(get_content_plan_batch_service)],
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> ContentPlanBatchCollectionResponse:
    context = await resolve_content_context(request, project_id, permission="content:read")
    if isinstance(context, JSONResponse):
        return context
    return await service.list_batches(
        context.tenant.organization_id,
        context.project.website_project_id,
        limit=limit,
    )


@content_plan_router.get("/batches/{batch_id}", response_model=ContentPlanBatchResponse)
async def get_automatic_content_plan_batch(
    project_id: str,
    batch_id: str,
    request: Request,
    service: Annotated[ContentPlanBatchService, Depends(get_content_plan_batch_service)],
) -> ContentPlanBatchResponse:
    context = await resolve_content_context(request, project_id, permission="content:read")
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
    service: Annotated[ContentPlanBatchService, Depends(get_content_plan_batch_service)],
) -> BatchRetryAcceptedResponse:
    context = await resolve_content_context(request, project_id, permission="content:write")
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
    context = await resolve_content_context(request, project_id, permission="content:read")
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
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)] = None,
) -> ManualPlanAcceptedResponse:
    context = await resolve_content_context(request, project_id, permission="content:write")
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


@content_plan_router.get("/items/{item_id}", response_model=ContentPlanItemResponse)
async def get_content_plan_item(
    project_id: str,
    item_id: str,
    request: Request,
    service: Annotated[ContentPlanD6Service, Depends(get_content_plan_d6_service)],
) -> ContentPlanItemResponse:
    context = await resolve_content_context(request, project_id, permission="content:read")
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
    context = await resolve_content_context(request, project_id, permission="content:write")
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


@content_plan_router.post("/items/{item_id}/cancel", response_model=ContentPlanItemResponse)
async def cancel_content_plan_item(
    project_id: str,
    item_id: str,
    body: CancelContentPlanItemRequest,
    request: Request,
    service: Annotated[ContentPlanD6Service, Depends(get_content_plan_d6_service)],
) -> ContentPlanItemResponse:
    context = await resolve_content_context(request, project_id, permission="content:write")
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
    service: Annotated[ContentPlanSettingsService, Depends(get_content_plan_settings_service)],
) -> ContentPlanSettingsResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:read")
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
    service: Annotated[ContentPlanSettingsService, Depends(get_content_plan_settings_service)],
) -> ContentPlanSettingsResponse:
    try:
        context = await resolve_content_context(request, project_id, permission="content:write")
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
