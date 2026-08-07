from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.modules.settings.schemas import (
    GSCServiceAccountConnectionResponse,
    TestGSCServiceAccountConnectionRequest,
    TestGSCServiceAccountConnectionResponse,
    TestWordPressConnectionRequest,
    TestWordPressConnectionResponse,
    UpdateGSCServiceAccountConnectionRequest,
    UpdateWordPressConnectionRequest,
    WordPressConnectionResponse,
)
from app.modules.settings.service_connections import (
    ProjectServiceConnectionService,
    ServiceConnectionEncryptionUnavailableError,
    ServiceConnectionError,
    ServiceConnectionNotConfiguredError,
    ServiceConnectionProjectNotFoundError,
    build_project_service_connection_service,
)

router = APIRouter(
    prefix="/api/v1/projects/{project_id}/service-connections",
    tags=["settings"],
)


def get_service_connection_service() -> ProjectServiceConnectionService:
    return build_project_service_connection_service()


def handle_service_connection_error(exc: Exception) -> None:
    if isinstance(exc, ServiceConnectionProjectNotFoundError):
        raise HTTPException(status_code=404, detail="项目不存在") from exc
    if isinstance(exc, ServiceConnectionNotConfiguredError):
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if isinstance(exc, ServiceConnectionEncryptionUnavailableError):
        raise HTTPException(
            status_code=503,
            detail="服务器尚未配置服务连接加密密钥",
        ) from exc
    if isinstance(exc, ServiceConnectionError):
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    raise exc


@router.get("/gsc", response_model=GSCServiceAccountConnectionResponse)
async def get_gsc_connection(
    project_id: str,
    service: Annotated[
        ProjectServiceConnectionService,
        Depends(get_service_connection_service),
    ],
) -> GSCServiceAccountConnectionResponse:
    try:
        return await service.get_gsc(project_id)
    except Exception as exc:
        handle_service_connection_error(exc)
        raise


@router.put("/gsc", response_model=GSCServiceAccountConnectionResponse)
async def update_gsc_connection(
    project_id: str,
    request: UpdateGSCServiceAccountConnectionRequest,
    service: Annotated[
        ProjectServiceConnectionService,
        Depends(get_service_connection_service),
    ],
) -> GSCServiceAccountConnectionResponse:
    try:
        return await service.update_gsc(project_id, request)
    except Exception as exc:
        handle_service_connection_error(exc)
        raise


@router.post("/gsc/test", response_model=TestGSCServiceAccountConnectionResponse)
async def test_gsc_connection(
    project_id: str,
    request: TestGSCServiceAccountConnectionRequest,
    service: Annotated[
        ProjectServiceConnectionService,
        Depends(get_service_connection_service),
    ],
) -> TestGSCServiceAccountConnectionResponse:
    try:
        return await service.test_gsc(project_id, request)
    except Exception as exc:
        handle_service_connection_error(exc)
        raise


@router.delete("/gsc", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect_gsc_connection(
    project_id: str,
    service: Annotated[
        ProjectServiceConnectionService,
        Depends(get_service_connection_service),
    ],
) -> Response:
    try:
        await service.disconnect_gsc(project_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except Exception as exc:
        handle_service_connection_error(exc)
        raise


@router.get("/wordpress", response_model=WordPressConnectionResponse)
async def get_wordpress_connection(
    project_id: str,
    service: Annotated[
        ProjectServiceConnectionService,
        Depends(get_service_connection_service),
    ],
) -> WordPressConnectionResponse:
    try:
        return await service.get_wordpress(project_id)
    except Exception as exc:
        handle_service_connection_error(exc)
        raise


@router.put("/wordpress", response_model=WordPressConnectionResponse)
async def update_wordpress_connection(
    project_id: str,
    request: UpdateWordPressConnectionRequest,
    service: Annotated[
        ProjectServiceConnectionService,
        Depends(get_service_connection_service),
    ],
) -> WordPressConnectionResponse:
    try:
        return await service.update_wordpress(project_id, request)
    except Exception as exc:
        handle_service_connection_error(exc)
        raise


@router.post("/wordpress/test", response_model=TestWordPressConnectionResponse)
async def test_wordpress_connection(
    project_id: str,
    request: TestWordPressConnectionRequest,
    service: Annotated[
        ProjectServiceConnectionService,
        Depends(get_service_connection_service),
    ],
) -> TestWordPressConnectionResponse:
    try:
        return await service.test_wordpress(project_id, request)
    except Exception as exc:
        handle_service_connection_error(exc)
        raise


@router.delete("/wordpress", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect_wordpress_connection(
    project_id: str,
    service: Annotated[
        ProjectServiceConnectionService,
        Depends(get_service_connection_service),
    ],
) -> Response:
    try:
        await service.disconnect_wordpress(project_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except Exception as exc:
        handle_service_connection_error(exc)
        raise
