from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.modules.onboarding.schemas import OnboardingRunResponse
from app.modules.onboarding.service import (
    OnboardingNotFoundError,
    OnboardingService,
    OnboardingStepConflictError,
    build_onboarding_service,
)
from app.modules.projects.schemas import (
    BusinessProfileRunResponse,
    CreateProjectRequest,
    ProjectResponse,
    UpdateBusinessProfileRequest,
)
from app.modules.projects.service import (
    ProjectAlreadyExistsError,
    ProjectDeleteError,
    ProjectNotFoundError,
    ProjectService,
    SiteIconNotFoundError,
    SiteUnderstandingAlreadyRunningError,
    SiteProfileNotReadyError,
    build_project_service,
)

router = APIRouter(prefix="/api/v1/projects", tags=["projects"])


def get_project_service() -> ProjectService:
    return build_project_service()


def get_onboarding_service() -> OnboardingService:
    return build_onboarding_service()


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> list[ProjectResponse]:
    return await service.list()


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> ProjectResponse:
    project = await service.get(project_id)
    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        )
    return project


@router.get("/{project_id}/onboarding", response_model=OnboardingRunResponse)
async def get_project_onboarding(
    project_id: str,
    service: Annotated[OnboardingService, Depends(get_onboarding_service)],
) -> OnboardingRunResponse:
    try:
        return await service.get(project_id)
    except OnboardingNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.post(
    "/{project_id}/onboarding/steps/{step_key}/retry",
    response_model=OnboardingRunResponse,
)
async def retry_project_onboarding_step(
    project_id: str,
    step_key: str,
    service: Annotated[OnboardingService, Depends(get_onboarding_service)],
) -> OnboardingRunResponse:
    try:
        return await service.retry_step(project_id, step_key)
    except OnboardingNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except (OnboardingStepConflictError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="当前任务不能重试",
        ) from exc


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: str,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> None:
    try:
        await service.delete(project_id)
    except ProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except ProjectDeleteError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc


@router.patch("/{project_id}/business-profile", response_model=ProjectResponse)
async def update_business_profile(
    project_id: str,
    request: UpdateBusinessProfileRequest,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> ProjectResponse:
    try:
        return await service.update_business_profile(project_id, request)
    except ProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except SiteProfileNotReadyError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="网站业务识别尚未完成",
        ) from exc


@router.get(
    "/{project_id}/business-profile/runs",
    response_model=list[BusinessProfileRunResponse],
)
async def list_business_profile_runs(
    project_id: str,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> list[BusinessProfileRunResponse]:
    try:
        return await service.list_business_profile_runs(project_id)
    except ProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.get("/{project_id}/favicon")
async def get_project_favicon(
    project_id: str,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> Response:
    try:
        icon = await service.get_site_icon(project_id)
    except (ProjectNotFoundError, SiteIconNotFoundError) as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="网站图标不存在",
        ) from exc
    return Response(
        content=icon.body,
        media_type=icon.content_type,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.post(
    "/{project_id}/business-profile/refresh",
    response_model=ProjectResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def refresh_business_profile(
    project_id: str,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> ProjectResponse:
    try:
        return await service.refresh_business_profile(project_id)
    except ProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except SiteUnderstandingAlreadyRunningError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="网站业务识别正在进行中",
        ) from exc


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    request: CreateProjectRequest,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> ProjectResponse:
    try:
        return await service.create(request)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    except ProjectAlreadyExistsError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="这个域名已经创建过项目",
        ) from exc
