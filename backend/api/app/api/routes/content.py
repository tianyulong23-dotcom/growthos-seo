from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status

from app.modules.content.schemas import (
    ArticleCollection,
    ArticleDetailResponse,
    ArticleResponse,
    ArticleRunResponse,
    ArticleStatus,
    CreateArticleRequest,
)
from app.modules.content.service import (
    ContentConflictError,
    ContentNotFoundError,
    ContentService,
    build_content_service,
)


router = APIRouter(prefix="/api/v1/projects/{project_id}/articles", tags=["content"])


def get_content_service() -> ContentService:
    return build_content_service()


def content_error(exc: Exception) -> HTTPException:
    if isinstance(exc, ContentNotFoundError):
        return HTTPException(status_code=404, detail="项目或文章任务不存在")
    if isinstance(exc, ContentConflictError):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=422, detail=str(exc))
    return HTTPException(status_code=500, detail="文章任务请求失败")


@router.post("", response_model=ArticleResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_article(
    project_id: str,
    request: CreateArticleRequest,
    idempotency_key: Annotated[
        str, Header(alias="Idempotency-Key", min_length=1, max_length=200)
    ],
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleResponse:
    try:
        return await service.create_article(project_id, request, idempotency_key)
    except (ContentNotFoundError, ContentConflictError, ValueError) as exc:
        raise content_error(exc) from exc


@router.get("", response_model=ArticleCollection)
async def list_articles(
    project_id: str,
    service: Annotated[ContentService, Depends(get_content_service)],
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 25,
    article_status: Annotated[ArticleStatus | None, Query(alias="status")] = None,
    search: Annotated[str | None, Query(max_length=200)] = None,
) -> ArticleCollection:
    try:
        return await service.list_articles(
            project_id, page, page_size, article_status, search
        )
    except ContentNotFoundError as exc:
        raise content_error(exc) from exc


@router.get("/{article_id}", response_model=ArticleDetailResponse)
async def get_article(
    project_id: str,
    article_id: str,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleDetailResponse:
    try:
        return await service.get_article(project_id, article_id)
    except ContentNotFoundError as exc:
        raise content_error(exc) from exc


@router.get("/{article_id}/run", response_model=ArticleRunResponse)
async def get_article_run(
    project_id: str,
    article_id: str,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleRunResponse:
    try:
        return await service.get_run(project_id, article_id)
    except ContentNotFoundError as exc:
        raise content_error(exc) from exc


@router.post("/{article_id}/cancel", response_model=ArticleResponse)
async def cancel_article(
    project_id: str,
    article_id: str,
    service: Annotated[ContentService, Depends(get_content_service)],
) -> ArticleResponse:
    try:
        return await service.cancel_article(project_id, article_id)
    except ContentNotFoundError as exc:
        raise content_error(exc) from exc
