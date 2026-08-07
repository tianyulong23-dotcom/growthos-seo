from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.modules.settings.schemas import (
    AIProviderSettingsResponse,
    TestAIProviderSettingsRequest,
    TestAIProviderSettingsResponse,
    UpdateAIProviderSettingsRequest,
)
from app.modules.settings.service import (
    AIProviderConnectionError,
    AIProviderNotConfiguredError,
    AISettingsEncryptionUnavailableError,
    AISettingsPlaintextMigrationRequiredError,
    AISettingsProjectNotFoundError,
    AISettingsService,
    build_ai_settings_service,
)

router = APIRouter(tags=["settings"])


def get_ai_settings_service() -> AISettingsService:
    return build_ai_settings_service()


def handle_settings_error(exc: Exception) -> None:
    if isinstance(exc, AISettingsProjectNotFoundError):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    if isinstance(exc, AIProviderNotConfiguredError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    if isinstance(exc, AISettingsEncryptionUnavailableError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="服务器尚未配置 AI 设置加密密钥",
        ) from exc
    if isinstance(exc, AISettingsPlaintextMigrationRequiredError):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="现有 AI 设置仍为开发期明文，请重新填写 API 密钥并保存为加密配置",
        ) from exc
    if isinstance(exc, AIProviderConnectionError):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    raise exc


@router.get(
    "/api/v1/projects/{project_id}/ai-settings",
    response_model=AIProviderSettingsResponse,
)
async def get_ai_settings(
    project_id: str,
    service: Annotated[AISettingsService, Depends(get_ai_settings_service)],
) -> AIProviderSettingsResponse:
    try:
        return await service.get(project_id)
    except Exception as exc:
        handle_settings_error(exc)
        raise


@router.put(
    "/api/v1/projects/{project_id}/ai-settings",
    response_model=AIProviderSettingsResponse,
)
async def update_ai_settings(
    project_id: str,
    request: UpdateAIProviderSettingsRequest,
    service: Annotated[AISettingsService, Depends(get_ai_settings_service)],
) -> AIProviderSettingsResponse:
    try:
        return await service.update(project_id, request)
    except Exception as exc:
        handle_settings_error(exc)
        raise


@router.post(
    "/api/v1/projects/{project_id}/ai-settings/test",
    response_model=TestAIProviderSettingsResponse,
)
async def test_ai_settings(
    project_id: str,
    request: TestAIProviderSettingsRequest,
    service: Annotated[AISettingsService, Depends(get_ai_settings_service)],
) -> TestAIProviderSettingsResponse:
    try:
        return await service.test_connection(project_id, request)
    except Exception as exc:
        handle_settings_error(exc)
        raise


@router.get("/api/v1/platform/settings/ai", response_model=AIProviderSettingsResponse)
async def get_platform_ai_settings(
    service: Annotated[AISettingsService, Depends(get_ai_settings_service)],
) -> AIProviderSettingsResponse:
    try:
        return await service.get_platform()
    except Exception as exc:
        handle_settings_error(exc)
        raise


@router.put("/api/v1/platform/settings/ai", response_model=AIProviderSettingsResponse)
async def update_platform_ai_settings(
    request: UpdateAIProviderSettingsRequest,
    service: Annotated[AISettingsService, Depends(get_ai_settings_service)],
) -> AIProviderSettingsResponse:
    try:
        return await service.update_platform(request)
    except Exception as exc:
        handle_settings_error(exc)
        raise


@router.post(
    "/api/v1/platform/settings/ai/test",
    response_model=TestAIProviderSettingsResponse,
)
async def test_platform_ai_settings(
    request: TestAIProviderSettingsRequest,
    service: Annotated[AISettingsService, Depends(get_ai_settings_service)],
) -> TestAIProviderSettingsResponse:
    try:
        return await service.test_platform_connection(request)
    except Exception as exc:
        handle_settings_error(exc)
        raise
