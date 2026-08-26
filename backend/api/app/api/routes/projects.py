from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status

from app.core.backlinks_gateway import (
    PlatformContextResolutionError,
    PlatformContextResolver,
)
from app.core.config import get_settings
from app.modules.onboarding.schemas import OnboardingRunResponse
from app.modules.onboarding.service import (
    OnboardingNotFoundError,
    OnboardingService,
    OnboardingStepConflictError,
    build_onboarding_service,
)
from app.modules.projects.readiness import (
    ProjectOutreachReadinessService,
    build_project_outreach_readiness_service,
)
from app.modules.projects.schemas import (
    BusinessProfileRunResponse,
    ConfirmPromotionTargetRequest,
    CreateProjectRequest,
    ProjectOutreachReadinessResponse,
    ProjectResponse,
    PromotionTargetVersionResponse,
    PublishPromotionTargetRequest,
    UpdateBusinessProfileRequest,
)
from app.modules.projects.service import (
    ProjectAlreadyExistsError,
    ProjectContextConflictError,
    ProjectDeleteError,
    ProjectNotFoundError,
    ProjectService,
    PromotionTargetReferenceError,
    SiteIconNotFoundError,
    SiteProfileNotReadyError,
    SiteUnderstandingAlreadyRunningError,
    build_project_service,
)

router = APIRouter(prefix="/api/v1/projects", tags=["projects"])


def get_project_service() -> ProjectService:
    return build_project_service()


def get_onboarding_service() -> OnboardingService:
    return build_onboarding_service()


def get_project_outreach_readiness_service() -> ProjectOutreachReadinessService:
    return build_project_outreach_readiness_service()


def _use_default_nonproduction_organization() -> bool:
    settings = get_settings()
    return settings.app_env != "production" and not settings.platform_local_development_auth_enabled


def _platform_context_error(error: PlatformContextResolutionError) -> HTTPException:
    return HTTPException(
        status_code=error.status,
        detail={
            "code": error.code,
            "message": error.detail,
        },
    )


async def resolve_collection_organization(
    request: Request,
    *,
    required_permission: str,
) -> tuple[str | None, str]:
    if _use_default_nonproduction_organization():
        return None, "local"
    resolver: PlatformContextResolver = request.app.state.platform_context_resolver
    try:
        context = await resolver.resolve_collection(
            request=request,
            required_permission=required_permission,
        )
    except PlatformContextResolutionError as error:
        raise _platform_context_error(error) from error
    return context.tenant.organization_id, context.tenant.workspace_id


async def resolve_project_organization(
    request: Request,
    project_id: str,
    *,
    required_permission: str,
) -> tuple[str | None, str]:
    organization_id, workspace_id, _actor_id = await resolve_project_authority(
        request,
        project_id,
        required_permission=required_permission,
    )
    return organization_id, workspace_id


async def resolve_project_authority(
    request: Request,
    project_id: str,
    *,
    required_permission: str,
) -> tuple[str | None, str, str]:
    if _use_default_nonproduction_organization():
        return None, "local", get_settings().agent_actor_id
    resolver: PlatformContextResolver = request.app.state.platform_context_resolver
    try:
        context = await resolver.resolve(
            request=request,
            website_project_key=project_id,
            required_permission=required_permission,
        )
    except PlatformContextResolutionError as error:
        raise _platform_context_error(error) from error
    return (
        context.tenant.organization_id,
        context.tenant.workspace_id,
        context.actor.user_id,
    )


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    request: Request,
    service: Annotated[ProjectService, Depends(get_project_service)],
    lifecycle_status: Annotated[
        Literal["ACTIVE", "ARCHIVED"] | None,
        Query(),
    ] = "ACTIVE",
) -> list[ProjectResponse]:
    organization_id, workspace_id = await resolve_collection_organization(
        request,
        required_permission="projects:read",
    )
    return await service.list(
        organization_id=organization_id,
        workspace_id=workspace_id,
        lifecycle_status=lifecycle_status,
    )


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    request: Request,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> ProjectResponse:
    organization_id, workspace_id = await resolve_project_organization(
        request,
        project_id,
        required_permission="projects:read",
    )
    project = await service.get(
        project_id,
        organization_id=organization_id,
        workspace_id=workspace_id,
    )
    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        )
    return project


@router.get(
    "/{project_id}/outreach-readiness",
    response_model=ProjectOutreachReadinessResponse,
)
async def get_project_outreach_readiness(
    project_id: str,
    request: Request,
    service: Annotated[
        ProjectOutreachReadinessService,
        Depends(get_project_outreach_readiness_service),
    ],
) -> ProjectOutreachReadinessResponse:
    organization_id, workspace_id = await resolve_project_organization(
        request,
        project_id,
        required_permission="projects:read",
    )
    try:
        return await service.get(
            project_id,
            organization_id=organization_id,
            workspace_id=workspace_id,
        )
    except ProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.post(
    "/{project_id}/promotion-target",
    response_model=PromotionTargetVersionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def publish_project_promotion_target(
    project_id: str,
    request: Request,
    payload: PublishPromotionTargetRequest,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> PromotionTargetVersionResponse:
    organization_id, workspace_id, actor_id = await resolve_project_authority(
        request,
        project_id,
        required_permission="projects:write",
    )
    try:
        return await service.publish_promotion_target(
            project_id,
            payload,
            organization_id=organization_id,
            workspace_id=workspace_id,
            created_by=actor_id,
        )
    except ProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except ProjectContextConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except PromotionTargetReferenceError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc


@router.post(
    "/{project_id}/promotion-target/confirm",
    response_model=PromotionTargetVersionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def confirm_project_promotion_target(
    project_id: str,
    request: Request,
    payload: ConfirmPromotionTargetRequest,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> PromotionTargetVersionResponse:
    organization_id, workspace_id, actor_id = await resolve_project_authority(
        request,
        project_id,
        required_permission="projects:write",
    )
    try:
        return await service.confirm_promotion_target(
            project_id,
            payload,
            organization_id=organization_id,
            workspace_id=workspace_id,
            created_by=actor_id,
        )
    except ProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except ProjectContextConflictError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc
    except PromotionTargetReferenceError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc


@router.get("/{project_id}/onboarding", response_model=OnboardingRunResponse)
async def get_project_onboarding(
    project_id: str,
    request: Request,
    service: Annotated[OnboardingService, Depends(get_onboarding_service)],
) -> OnboardingRunResponse:
    organization_id, _workspace_id = await resolve_project_organization(
        request,
        project_id,
        required_permission="projects:read",
    )
    try:
        scoped_service = (
            service
            if organization_id is None
            else service.for_organization(organization_id)
        )
        return await scoped_service.get(project_id)
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
    request: Request,
    service: Annotated[OnboardingService, Depends(get_onboarding_service)],
) -> OnboardingRunResponse:
    organization_id, _workspace_id = await resolve_project_organization(
        request,
        project_id,
        required_permission="projects:write",
    )
    try:
        scoped_service = (
            service
            if organization_id is None
            else service.for_organization(organization_id)
        )
        return await scoped_service.retry_step(
            project_id,
            step_key,
        )
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
    request: Request,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> None:
    organization_id, workspace_id = await resolve_project_organization(
        request,
        project_id,
        required_permission="projects:write",
    )
    try:
        await service.delete(
            project_id,
            organization_id=organization_id,
            workspace_id=workspace_id,
        )
    except ProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except ProjectDeleteError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc


@router.post("/{project_id}/archive", response_model=ProjectResponse)
async def archive_project(
    project_id: str,
    request: Request,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> ProjectResponse:
    organization_id, workspace_id = await resolve_project_organization(
        request,
        project_id,
        required_permission="projects:write",
    )
    try:
        return await service.archive(
            project_id,
            organization_id=organization_id,
            workspace_id=workspace_id,
        )
    except ProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except ProjectDeleteError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc


@router.post("/{project_id}/restore", response_model=ProjectResponse)
async def restore_project(
    project_id: str,
    request: Request,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> ProjectResponse:
    organization_id, workspace_id = await resolve_project_organization(
        request,
        project_id,
        required_permission="projects:write",
    )
    try:
        return await service.restore(
            project_id,
            organization_id=organization_id,
            workspace_id=workspace_id,
        )
    except ProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc
    except ProjectDeleteError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(exc),
        ) from exc


@router.patch("/{project_id}/business-profile", response_model=ProjectResponse)
async def update_business_profile(
    project_id: str,
    request: Request,
    payload: UpdateBusinessProfileRequest,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> ProjectResponse:
    organization_id, _workspace_id = await resolve_project_organization(
        request,
        project_id,
        required_permission="projects:write",
    )
    try:
        return await service.update_business_profile(
            project_id,
            payload,
            organization_id=organization_id,
        )
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
    request: Request,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> list[BusinessProfileRunResponse]:
    organization_id, _workspace_id = await resolve_project_organization(
        request,
        project_id,
        required_permission="projects:read",
    )
    try:
        return await service.list_business_profile_runs(
            project_id,
            organization_id=organization_id,
        )
    except ProjectNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="项目不存在",
        ) from exc


@router.get("/{project_id}/favicon")
async def get_project_favicon(
    project_id: str,
    request: Request,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> Response:
    organization_id, _workspace_id = await resolve_project_organization(
        request,
        project_id,
        required_permission="projects:read",
    )
    try:
        icon = await service.get_site_icon(
            project_id,
            organization_id=organization_id,
        )
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
    request: Request,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> ProjectResponse:
    organization_id, _workspace_id = await resolve_project_organization(
        request,
        project_id,
        required_permission="projects:write",
    )
    try:
        return await service.refresh_business_profile(
            project_id,
            organization_id=organization_id,
        )
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
    request: Request,
    payload: CreateProjectRequest,
    service: Annotated[ProjectService, Depends(get_project_service)],
) -> ProjectResponse:
    organization_id, workspace_id = await resolve_collection_organization(
        request,
        required_permission="projects:write",
    )
    try:
        return await service.create(
            payload,
            organization_id=organization_id,
            workspace_id=workspace_id,
        )
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
