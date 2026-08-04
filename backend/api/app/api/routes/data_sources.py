from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.modules.settings.data_sources import (
    DataForSEOSettingsService,
    DataSourceConnectionError,
    DataSourceEncryptionUnavailableError,
    DataSourceNotConfiguredError,
    DataSourceProjectNotFoundError,
    GoogleAdsSettingsService,
    build_dataforseo_settings_service,
    build_google_ads_settings_service,
)
from app.modules.settings.schemas import (
    DataForSEOSettingsResponse,
    GoogleAdsSettingsResponse,
    TestDataForSEOSettingsRequest,
    TestDataForSEOSettingsResponse,
    TestGoogleAdsSettingsRequest,
    TestGoogleAdsSettingsResponse,
    UpdateDataForSEOSettingsRequest,
    UpdateGoogleAdsSettingsRequest,
)

router = APIRouter(tags=["settings"])


def get_google_ads_settings_service() -> GoogleAdsSettingsService:
    return build_google_ads_settings_service()


def get_dataforseo_settings_service() -> DataForSEOSettingsService:
    return build_dataforseo_settings_service()


def handle_data_source_error(exc: Exception) -> None:
    if isinstance(exc, DataSourceProjectNotFoundError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    if isinstance(exc, DataSourceNotConfiguredError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    if isinstance(exc, DataSourceEncryptionUnavailableError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="服务器尚未配置设置加密密钥",
        ) from exc
    if isinstance(exc, DataSourceConnectionError):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    raise exc


@router.get(
    "/api/v1/projects/{project_id}/google-ads-settings",
    response_model=GoogleAdsSettingsResponse,
)
async def get_google_ads_settings(
    project_id: str,
    service: Annotated[
        GoogleAdsSettingsService,
        Depends(get_google_ads_settings_service),
    ],
) -> GoogleAdsSettingsResponse:
    try:
        return await service.get(project_id)
    except Exception as exc:
        handle_data_source_error(exc)
        raise


@router.put(
    "/api/v1/projects/{project_id}/google-ads-settings",
    response_model=GoogleAdsSettingsResponse,
)
async def update_google_ads_settings(
    project_id: str,
    request: UpdateGoogleAdsSettingsRequest,
    service: Annotated[
        GoogleAdsSettingsService,
        Depends(get_google_ads_settings_service),
    ],
) -> GoogleAdsSettingsResponse:
    try:
        return await service.update(project_id, request)
    except Exception as exc:
        handle_data_source_error(exc)
        raise


@router.post(
    "/api/v1/projects/{project_id}/google-ads-settings/test",
    response_model=TestGoogleAdsSettingsResponse,
)
async def test_google_ads_settings(
    project_id: str,
    request: TestGoogleAdsSettingsRequest,
    service: Annotated[
        GoogleAdsSettingsService,
        Depends(get_google_ads_settings_service),
    ],
) -> TestGoogleAdsSettingsResponse:
    try:
        return await service.test_connection(project_id, request)
    except Exception as exc:
        handle_data_source_error(exc)
        raise


@router.get(
    "/api/v1/projects/{project_id}/dataforseo-settings",
    response_model=DataForSEOSettingsResponse,
)
async def get_dataforseo_settings(
    project_id: str,
    service: Annotated[
        DataForSEOSettingsService,
        Depends(get_dataforseo_settings_service),
    ],
) -> DataForSEOSettingsResponse:
    try:
        return await service.get(project_id)
    except Exception as exc:
        handle_data_source_error(exc)
        raise


@router.put(
    "/api/v1/projects/{project_id}/dataforseo-settings",
    response_model=DataForSEOSettingsResponse,
)
async def update_dataforseo_settings(
    project_id: str,
    request: UpdateDataForSEOSettingsRequest,
    service: Annotated[
        DataForSEOSettingsService,
        Depends(get_dataforseo_settings_service),
    ],
) -> DataForSEOSettingsResponse:
    try:
        return await service.update(project_id, request)
    except Exception as exc:
        handle_data_source_error(exc)
        raise


@router.post(
    "/api/v1/projects/{project_id}/dataforseo-settings/test",
    response_model=TestDataForSEOSettingsResponse,
)
async def test_dataforseo_settings(
    project_id: str,
    request: TestDataForSEOSettingsRequest,
    service: Annotated[
        DataForSEOSettingsService,
        Depends(get_dataforseo_settings_service),
    ],
) -> TestDataForSEOSettingsResponse:
    try:
        return await service.test_connection(project_id, request)
    except Exception as exc:
        handle_data_source_error(exc)
        raise
