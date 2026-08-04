from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel

from app.modules.keywords.schemas import KeywordOperationalHealthResponse
from app.modules.keywords.service import KeywordService, build_keyword_service

router = APIRouter(tags=["system"])


class HealthResponse(BaseModel):
    status: Literal["ok"]


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok")


def get_keyword_health_service() -> KeywordService:
    return build_keyword_service()


@router.get(
    "/health/keywords",
    response_model=KeywordOperationalHealthResponse,
)
async def keyword_health(
    service: Annotated[KeywordService, Depends(get_keyword_health_service)],
) -> KeywordOperationalHealthResponse:
    return await service.operational_health()


@router.get(
    "/health/keywords/readiness",
    response_model=KeywordOperationalHealthResponse,
)
async def keyword_readiness(
    response: Response,
    service: Annotated[KeywordService, Depends(get_keyword_health_service)],
) -> KeywordOperationalHealthResponse:
    snapshot = await service.operational_health()
    unavailable = (
        not snapshot.worker_healthy
        or snapshot.stale_prepared_requests > 0
        or snapshot.uncertain_requests > 0
        or snapshot.charged_failed_requests > 0
    )
    if unavailable:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return snapshot
