from enum import IntEnum
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status

from app.core.backlinks_gateway import (
    BacklinksGateway,
    PlatformContextResolutionError,
    PlatformContextResolver,
    problem_response,
)
from app.modules.performance.schemas import (
    PerformanceArticleCollection,
    PerformanceArticleDetail,
    PerformanceBacklinksResponse,
    PerformanceBacklinkView,
    PerformanceOverview,
    PerformanceSort,
    PerformanceSyncResponse,
    SortOrder,
)
from app.modules.performance.domain import PerformanceStatus
from app.modules.performance.service import (
    PerformanceConflictError,
    PerformanceNotFoundError,
    PerformanceService,
    build_performance_service,
)
from app.modules.settings.gsc import (
    GSCNotConfiguredError,
    GSCNotConnectedError,
    GSCReconnectRequiredError,
    GSCUpstreamError,
)


router = APIRouter(prefix="/api/v1/projects/{project_id}/performance", tags=["performance"])


class PerformanceRange(IntEnum):
    DAYS_7 = 7
    DAYS_28 = 28
    DAYS_90 = 90


def get_performance_service() -> PerformanceService:
    return build_performance_service()


def performance_error(exc: Exception) -> HTTPException:
    if isinstance(exc, PerformanceNotFoundError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(
        exc,
        (
            PerformanceConflictError,
            GSCNotConfiguredError,
            GSCNotConnectedError,
            GSCReconnectRequiredError,
        ),
    ):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, GSCUpstreamError):
        return HTTPException(status_code=503, detail="Search Console 暂时不可用")
    return HTTPException(status_code=500, detail="效果数据请求失败")


@router.get(
    "/backlinks",
    response_model=PerformanceBacklinksResponse,
    operation_id="get_project_backlink_performance_v1",
)
async def get_performance_backlinks(
    request: Request,
    project_id: str,
    view: PerformanceBacklinkView = "all",
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    cursor: str | None = None,
) -> Response:
    resolver: PlatformContextResolver = request.app.state.platform_context_resolver
    gateway: BacklinksGateway = request.app.state.backlinks_gateway
    try:
        resolved = await resolver.resolve(
            request=request,
            website_project_key=project_id,
            required_permission="backlinks:read",
        )
    except PlatformContextResolutionError as error:
        return problem_response(
            status=error.status,
            problem_type=(
                "urn:growthos:problem:platform:"
                f"{error.code.lower().replace('_', '-')}"
            ),
            title=error.title,
            detail=error.detail,
            code=error.code,
            request_id=request.headers.get("x-request-id", "unresolved"),
            retryable=False,
        )
    query_params = [("view", view), ("limit", str(limit))]
    if cursor is not None:
        query_params.append(("cursor", cursor))
    return await gateway.forward(
        request,
        resolved=resolved,
        website_project_key=project_id,
        query_params=query_params,
        upstream_path=(
            f"/api/v1/projects/{quote(project_id, safe='')}/backlinks/links"
        ),
    )


@router.get("/overview", response_model=PerformanceOverview)
async def get_performance_overview(
    project_id: str,
    service: Annotated[PerformanceService, Depends(get_performance_service)],
    days: PerformanceRange = PerformanceRange.DAYS_28,
) -> PerformanceOverview:
    try:
        return await service.overview(project_id, int(days))
    except Exception as exc:
        raise performance_error(exc) from exc


@router.get("/articles", response_model=PerformanceArticleCollection)
async def get_performance_articles(
    project_id: str,
    service: Annotated[PerformanceService, Depends(get_performance_service)],
    days: PerformanceRange = PerformanceRange.DAYS_28,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 25,
    article_status: Annotated[PerformanceStatus | None, Query(alias="status")] = None,
    sort: PerformanceSort = "clicks",
    order: SortOrder = "desc",
) -> PerformanceArticleCollection:
    try:
        return await service.articles(
            project_id,
            int(days),
            page=page,
            page_size=page_size,
            status=article_status,
            sort=sort,
            order=order,
        )
    except Exception as exc:
        raise performance_error(exc) from exc


@router.get("/articles/{article_id}", response_model=PerformanceArticleDetail)
async def get_performance_article(
    project_id: str,
    article_id: str,
    service: Annotated[PerformanceService, Depends(get_performance_service)],
    days: PerformanceRange = PerformanceRange.DAYS_28,
) -> PerformanceArticleDetail:
    try:
        return await service.article_detail(project_id, article_id, int(days))
    except Exception as exc:
        raise performance_error(exc) from exc


@router.post("/sync", response_model=PerformanceSyncResponse)
async def sync_performance(
    project_id: str,
    service: Annotated[PerformanceService, Depends(get_performance_service)],
) -> PerformanceSyncResponse:
    try:
        return await service.sync(project_id)
    except Exception as exc:
        raise performance_error(exc) from exc


@router.post("/signals/{signal_id}/resolve", status_code=status.HTTP_204_NO_CONTENT)
async def resolve_performance_signal(
    project_id: str,
    signal_id: str,
    service: Annotated[PerformanceService, Depends(get_performance_service)],
) -> Response:
    try:
        await service.resolve_signal(project_id, signal_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except Exception as exc:
        raise performance_error(exc) from exc
