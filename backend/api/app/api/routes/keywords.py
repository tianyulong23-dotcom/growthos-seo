from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.modules.keywords.schemas import (
    KeywordBatchStatusRequest,
    KeywordBatchStatusResponse,
    KeywordBuildRunResponse,
    KeywordCompetitorAnalysisRequest,
    KeywordCompetitorAnalysisRunResponse,
    KeywordCompetitorAnalysisRunListResponse,
    KeywordCompetitorListResponse,
    KeywordCompetitorOpportunityBatchRequest,
    KeywordCompetitorOpportunityBatchResponse,
    KeywordCompetitorOpportunityListResponse,
    KeywordCostSummaryResponse,
    KeywordExternalIssueListResponse,
    KeywordExternalIssueResponse,
    KeywordLibraryStatusResponse,
    KeywordListResponse,
    KeywordTagAssignmentRequest,
    KeywordTagAssignmentResponse,
)
from app.modules.keywords.service import (
    KeywordBuildAlreadyRunningError,
    KeywordCompetitorAnalysisAlreadyRunningError,
    KeywordCompetitorOpportunityUnavailableError,
    KeywordExternalIssueUnavailableError,
    KeywordGSCRequiredError,
    KeywordProjectNotFoundError,
    KeywordRetryUnavailableError,
    KeywordService,
    build_keyword_service,
)

router = APIRouter(
    prefix="/api/v1/projects/{project_id}/keywords",
    tags=["keywords"],
)


def get_keyword_service() -> KeywordService:
    return build_keyword_service()


@router.get("/status", response_model=KeywordLibraryStatusResponse)
async def get_keyword_status(
    project_id: str,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
) -> KeywordLibraryStatusResponse:
    try:
        return await service.status(project_id)
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.get("/costs", response_model=KeywordCostSummaryResponse)
async def get_keyword_costs(
    project_id: str,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
) -> KeywordCostSummaryResponse:
    try:
        return await service.cost_summary(project_id)
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.get("/operations/issues", response_model=KeywordExternalIssueListResponse)
async def list_keyword_external_issues(
    project_id: str,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
) -> KeywordExternalIssueListResponse:
    try:
        return await service.list_external_issues(project_id)
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.post(
    "/operations/issues/{request_id}/accept-empty",
    response_model=KeywordExternalIssueResponse,
)
async def accept_keyword_external_issue_as_empty(
    project_id: str,
    request_id: int,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
) -> KeywordExternalIssueResponse:
    try:
        return await service.accept_external_issue_as_empty(project_id, request_id)
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except KeywordExternalIssueUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="这个外部请求已经处理，或不允许按空结果继续",
        ) from exc


@router.get("", response_model=KeywordListResponse)
async def list_keywords(
    project_id: str,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 50,
    search: str | None = None,
    intent: str | None = None,
    source: str | None = None,
    seed_id: str | None = None,
    keyword_status: Literal["active", "archived"] = "active",
    metrics_status: Literal["pending", "fresh", "stale", "failed"] | None = None,
    min_volume: Annotated[int | None, Query(ge=0)] = None,
    max_difficulty: Annotated[int | None, Query(ge=0, le=100)] = None,
    sort: Literal[
        "keyword",
        "search_volume",
        "difficulty",
        "priority",
        "updated_at",
    ] = "priority",
    order: Literal["asc", "desc"] = "desc",
) -> KeywordListResponse:
    try:
        return await service.list_keywords(
            project_id,
            page=page,
            page_size=page_size,
            search=search,
            intent=intent,
            source=source,
            seed_id=seed_id,
            status=keyword_status,
            metrics_status=metrics_status,
            min_volume=min_volume,
            max_difficulty=max_difficulty,
            sort=sort,
            order=order,
        )
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.post(
    "/competitor-analysis",
    response_model=KeywordCompetitorAnalysisRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def start_keyword_competitor_analysis(
    project_id: str,
    request: KeywordCompetitorAnalysisRequest,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
) -> KeywordCompetitorAnalysisRunResponse:
    try:
        return await service.start_competitor_analysis(project_id, request)
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except KeywordCompetitorAnalysisAlreadyRunningError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="竞争分析正在进行中",
        ) from exc
    except KeywordGSCRequiredError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc


@router.get(
    "/competitor-analysis/status",
    response_model=KeywordCompetitorAnalysisRunResponse | None,
)
async def get_keyword_competitor_analysis_status(
    project_id: str,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
) -> KeywordCompetitorAnalysisRunResponse | None:
    try:
        return await service.competitor_analysis_status(project_id)
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.get(
    "/competitor-analysis/competitors",
    response_model=KeywordCompetitorListResponse,
)
async def list_keyword_competitors(
    project_id: str,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
    include_evidence: bool = False,
) -> KeywordCompetitorListResponse:
    try:
        return await service.list_competitors(project_id, include_evidence=include_evidence)
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.get(
    "/competitor-analysis/opportunities",
    response_model=KeywordCompetitorOpportunityListResponse,
)
async def list_keyword_competitor_opportunities(
    project_id: str,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 50,
    search: str = "",
    competitor_domain: str = "",
    intent: str = "",
    opportunity_status: Literal["new", "accepted", "dismissed", "all"] = "new",
    min_volume: Annotated[int | None, Query(ge=0)] = None,
    max_difficulty: Annotated[int | None, Query(ge=0, le=100)] = None,
    in_library: bool | None = None,
    sort: Literal[
        "keyword",
        "opportunity_score",
        "search_volume",
        "difficulty",
        "best_rank",
        "competitor_count",
        "updated_at",
    ] = "opportunity_score",
    order: Literal["asc", "desc"] = "desc",
) -> KeywordCompetitorOpportunityListResponse:
    try:
        return await service.list_competitor_opportunities(
            project_id,
            page=page,
            page_size=page_size,
            search=search,
            competitor_domain=competitor_domain,
            intent=intent,
            opportunity_status=opportunity_status,
            min_volume=min_volume,
            max_difficulty=max_difficulty,
            in_library=in_library,
            sort=sort,
            order=order,
        )
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.get(
    "/competitor-analysis/runs",
    response_model=KeywordCompetitorAnalysisRunListResponse,
)
async def list_keyword_competitor_analysis_runs(
    project_id: str,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
    limit: Annotated[int, Query(ge=1, le=20)] = 10,
) -> KeywordCompetitorAnalysisRunListResponse:
    try:
        return await service.competitor_analysis_runs(project_id, limit=limit)
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.patch(
    "/competitor-analysis/opportunities",
    response_model=KeywordCompetitorOpportunityBatchResponse,
)
async def update_keyword_competitor_opportunities(
    project_id: str,
    request: KeywordCompetitorOpportunityBatchRequest,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
) -> KeywordCompetitorOpportunityBatchResponse:
    try:
        return await service.batch_competitor_opportunities(project_id, request)
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except KeywordCompetitorOpportunityUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="机会缺口已失效，或关键词库尚未完成初始化",
        ) from exc


@router.post(
    "/retry",
    response_model=KeywordBuildRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def retry_failed_keyword_build(
    project_id: str,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
) -> KeywordBuildRunResponse:
    try:
        return await service.retry_failed_initial_build(project_id)
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except KeywordBuildAlreadyRunningError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="关键词任务正在进行中",
        ) from exc
    except KeywordRetryUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="没有可重试的首次建库任务",
        ) from exc


@router.patch("/status", response_model=KeywordBatchStatusResponse)
async def update_keyword_status(
    project_id: str,
    request: KeywordBatchStatusRequest,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
) -> KeywordBatchStatusResponse:
    try:
        return await service.batch_status(project_id, request)
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.post("/tags", response_model=KeywordTagAssignmentResponse)
async def assign_keyword_tags(
    project_id: str,
    request: KeywordTagAssignmentRequest,
    service: Annotated[KeywordService, Depends(get_keyword_service)],
) -> KeywordTagAssignmentResponse:
    try:
        return await service.assign_tags(project_id, request)
    except KeywordProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
