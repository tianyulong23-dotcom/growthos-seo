import logging
from enum import IntEnum
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse

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
from app.modules.settings.gsc import (
    GSCError,
    GSCNotConfiguredError,
    GSCNotConnectedError,
    GSCReconnectRequiredError,
    GSCService,
    GSCUpstreamError,
    GSCValidationError,
    build_gsc_service,
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
    GSCConnectionResponse,
    GSCPerformanceExportResponse,
    GSCPerformanceReportResponse,
    GSCPerformanceTableResponse,
    GSCOAuthStartRequest,
    GSCOAuthStartResponse,
    GSCSelectSiteRequest,
    GSCSiteListResponse,
)

router = APIRouter(tags=["settings"])
logger = logging.getLogger(__name__)


class GSCPerformancePageSize(IntEnum):
    rows_25 = 25
    rows_50 = 50
    rows_100 = 100


def get_google_ads_settings_service() -> GoogleAdsSettingsService:
    return build_google_ads_settings_service()


def get_dataforseo_settings_service() -> DataForSEOSettingsService:
    return build_dataforseo_settings_service()


def get_gsc_service() -> GSCService:
    return build_gsc_service()


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


def handle_gsc_error(exc: Exception) -> None:
    if isinstance(exc, GSCValidationError):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc))
    if isinstance(exc, (GSCNotConnectedError, GSCReconnectRequiredError)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    if isinstance(exc, GSCNotConfiguredError):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc))
    if isinstance(exc, GSCUpstreamError):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))
    if isinstance(exc, GSCError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    raise exc


@router.get(
    "/api/v1/projects/{project_id}/gsc/connection",
    response_model=GSCConnectionResponse,
)
async def get_gsc_connection(
    project_id: str,
    service: Annotated[GSCService, Depends(get_gsc_service)],
) -> GSCConnectionResponse:
    try:
        return await service.status(project_id)
    except Exception as exc:
        handle_gsc_error(exc)
        raise


@router.post(
    "/api/v1/projects/{project_id}/gsc/oauth/start",
    response_model=GSCOAuthStartResponse,
)
async def start_gsc_oauth(
    project_id: str,
    request: GSCOAuthStartRequest,
    service: Annotated[GSCService, Depends(get_gsc_service)],
) -> GSCOAuthStartResponse:
    try:
        return GSCOAuthStartResponse(
            authorization_url=await service.authorization_url(project_id, request.callback_url)
        )
    except Exception as exc:
        handle_gsc_error(exc)
        raise


@router.get("/api/v1/gsc/oauth/callback", include_in_schema=False)
async def gsc_oauth_callback(
    service: Annotated[GSCService, Depends(get_gsc_service)],
    state_value: Annotated[str, Query(alias="state", min_length=1)],
    code: Annotated[str | None, Query(min_length=1)] = None,
    error: str | None = None,
) -> RedirectResponse:
    try:
        callback_path = await service.handle_callback(code=code, state=state_value, error=error)
    except Exception as exc:
        try:
            callback_path = service.failed_callback_path(state_value)
        except GSCValidationError:
            handle_gsc_error(exc)
            raise
        logger.exception("Google Search Console OAuth callback failed")
    return RedirectResponse(
        service.settings.gsc_frontend_origin.rstrip("/") + callback_path,
        status_code=status.HTTP_303_SEE_OTHER,
    )


@router.get(
    "/api/v1/projects/{project_id}/gsc/sites",
    response_model=GSCSiteListResponse,
)
async def list_gsc_sites(
    project_id: str,
    service: Annotated[GSCService, Depends(get_gsc_service)],
) -> GSCSiteListResponse:
    try:
        return await service.list_sites(project_id)
    except Exception as exc:
        handle_gsc_error(exc)
        raise


@router.put(
    "/api/v1/projects/{project_id}/gsc/connection",
    response_model=GSCConnectionResponse,
)
async def select_gsc_site(
    project_id: str,
    request: GSCSelectSiteRequest,
    service: Annotated[GSCService, Depends(get_gsc_service)],
) -> GSCConnectionResponse:
    try:
        return await service.select_site(project_id, request.site_url)
    except Exception as exc:
        handle_gsc_error(exc)
        raise


@router.delete(
    "/api/v1/projects/{project_id}/gsc/connection",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def disconnect_gsc(
    project_id: str,
    service: Annotated[GSCService, Depends(get_gsc_service)],
) -> None:
    try:
        await service.disconnect(project_id)
    except Exception as exc:
        handle_gsc_error(exc)
        raise


@router.get(
    "/api/v1/projects/{project_id}/gsc/performance",
    response_model=GSCPerformanceReportResponse,
)
async def get_gsc_performance(
    project_id: str,
    service: Annotated[GSCService, Depends(get_gsc_service)],
    date_range: Literal["last_7_days", "last_28_days", "last_3_months"] = (
        "last_28_days"
    ),
    device: Literal["DESKTOP", "MOBILE", "TABLET"] | None = None,
    country: Annotated[
        str | None,
        Query(min_length=3, max_length=3, pattern=r"^[A-Za-z]{3}$"),
    ] = None,
) -> GSCPerformanceReportResponse:
    try:
        return await service.performance_report(
            project_id,
            date_range=date_range,
            device=device,
            country=country,
        )
    except Exception as exc:
        handle_gsc_error(exc)
        raise


@router.get(
    "/api/v1/projects/{project_id}/gsc/performance/table",
    response_model=GSCPerformanceTableResponse,
)
async def get_gsc_performance_table(
    project_id: str,
    service: Annotated[GSCService, Depends(get_gsc_service)],
    dimension: Literal["query", "page"],
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: GSCPerformancePageSize = GSCPerformancePageSize.rows_25,
    date_range: Literal["last_7_days", "last_28_days", "last_3_months"] = (
        "last_28_days"
    ),
    device: Literal["DESKTOP", "MOBILE", "TABLET"] | None = None,
    country: Annotated[
        str | None,
        Query(min_length=3, max_length=3, pattern=r"^[A-Za-z]{3}$"),
    ] = None,
) -> GSCPerformanceTableResponse:
    try:
        return await service.performance_table(
            project_id,
            dimension=dimension,
            page=page,
            page_size=int(page_size),
            date_range=date_range,
            device=device,
            country=country,
        )
    except Exception as exc:
        handle_gsc_error(exc)
        raise


@router.get(
    "/api/v1/projects/{project_id}/gsc/performance/export",
    response_model=GSCPerformanceExportResponse,
)
async def export_gsc_performance(
    project_id: str,
    service: Annotated[GSCService, Depends(get_gsc_service)],
    dimension: Literal["query", "page"],
    date_range: Literal["last_7_days", "last_28_days", "last_3_months"] = (
        "last_28_days"
    ),
    device: Literal["DESKTOP", "MOBILE", "TABLET"] | None = None,
    country: Annotated[
        str | None,
        Query(min_length=3, max_length=3, pattern=r"^[A-Za-z]{3}$"),
    ] = None,
) -> GSCPerformanceExportResponse:
    try:
        return await service.performance_export(
            project_id,
            dimension=dimension,
            date_range=date_range,
            device=device,
            country=country,
        )
    except Exception as exc:
        handle_gsc_error(exc)
        raise


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
