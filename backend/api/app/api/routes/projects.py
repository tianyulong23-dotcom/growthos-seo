from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from app.core.backlinks_gateway import (
    BacklinksGateway,
    PlatformContextResolutionError,
    PlatformContextResolver,
)
from app.core.config import Settings
from app.core.openapi_aggregation import MODULE_UNAVAILABLE_RESPONSE
from app.core.platform_request_context import (
    PlatformProject,
    ResolvedPlatformCollectionContext,
    ResolvedPlatformRequestContext,
)
from app.core.runtime import RuntimeDependencies
from app.modules.projects.service import (
    ProjectConflictError,
    ProjectMutationResult,
    ProjectProfileInput,
    ProjectProfilePatch,
    ProjectValidationError,
    WebsiteProjectRecord,
    WebsiteProjectService,
)

router = APIRouter(tags=["projects"])
_PLATFORM_OPENAPI = {"x-growthos-module": "platform"}
_PROJECT_RESPONSES = {503: MODULE_UNAVAILABLE_RESPONSE}


class WebsiteProjectProfileRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    domain: str = Field(min_length=1, max_length=253)
    country: str = Field(min_length=2, max_length=2)
    target_market: str = Field(min_length=1, max_length=120)
    language: str = Field(min_length=2, max_length=10)
    products: list[str] = Field(min_length=1, max_length=100)
    keywords: list[str] = Field(min_length=1, max_length=200)
    target_urls: list[str] = Field(min_length=1, max_length=200)
    target_audiences: list[str] = Field(min_length=1, max_length=100)
    partnership_goals: list[str] = Field(min_length=1, max_length=100)


class WebsiteProjectProfilePatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    domain: str | None = Field(default=None, min_length=1, max_length=253)
    country: str | None = Field(default=None, min_length=2, max_length=2)
    target_market: str | None = Field(default=None, min_length=1, max_length=120)
    language: str | None = Field(default=None, min_length=2, max_length=10)
    products: list[str] | None = Field(default=None, min_length=1, max_length=100)
    keywords: list[str] | None = Field(default=None, min_length=1, max_length=200)
    target_urls: list[str] | None = Field(default=None, min_length=1, max_length=200)
    target_audiences: list[str] | None = Field(default=None, min_length=1, max_length=100)
    partnership_goals: list[str] | None = Field(default=None, min_length=1, max_length=100)


class WebsiteProjectResponse(BaseModel):
    id: str
    website_project_key: str
    status: Literal["ACTIVE", "ARCHIVED"]
    archived_at: datetime | None
    name: str
    domain: str
    country: str
    target_market: str
    language: str
    health: int = Field(ge=0, le=100)
    context_version: int = Field(ge=1)
    profile_version_id: str
    promotion_target_version_id: str
    keywords: list[str]
    products: list[str]
    target_urls: list[str]
    target_audiences: list[str]
    partnership_goals: list[str]
    input_required: list[
        Literal[
            "keywords",
            "products",
            "target_urls",
            "target_audiences",
            "partnership_goals",
        ]
    ]
    created_at: datetime
    updated_at: datetime


class WebsiteProjectMutationResponse(BaseModel):
    project: WebsiteProjectResponse
    background_status: Literal[
        "recommendations_preparing",
        "background_retryable",
        "input_required",
        "projected",
    ]


def _project_response(project: WebsiteProjectRecord) -> WebsiteProjectResponse:
    return WebsiteProjectResponse(
        id=project.website_project_id,
        website_project_key=project.website_project_key,
        status=project.status,
        archived_at=project.archived_at,
        name=project.name,
        domain=project.domain,
        country=project.country,
        target_market=project.target_market,
        language=project.language,
        health=project.health,
        context_version=project.context_version,
        profile_version_id=project.profile_version_id,
        promotion_target_version_id=project.promotion_target_version_id,
        keywords=list(project.keywords),
        products=list(project.products),
        target_urls=list(project.target_urls),
        target_audiences=list(project.target_audiences),
        partnership_goals=list(project.partnership_goals),
        input_required=list(project.input_required),
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


async def _resolve(
    request: Request,
    website_project_key: str,
) -> ResolvedPlatformRequestContext:
    resolver: PlatformContextResolver = request.app.state.platform_context_resolver
    try:
        return await resolver.resolve(
            request=request,
            website_project_key=website_project_key,
        )
    except PlatformContextResolutionError as error:
        raise HTTPException(
            status_code=error.status,
            detail={"code": error.code, "message": error.detail},
        ) from error


async def _resolve_collection(
    request: Request,
) -> ResolvedPlatformCollectionContext:
    resolver: PlatformContextResolver = request.app.state.platform_context_resolver
    try:
        return await resolver.resolve_collection(request=request)
    except PlatformContextResolutionError as error:
        raise HTTPException(
            status_code=error.status,
            detail={"code": error.code, "message": error.detail},
        ) from error


def _project_context(
    base: ResolvedPlatformRequestContext | ResolvedPlatformCollectionContext,
    project: WebsiteProjectRecord,
) -> ResolvedPlatformRequestContext:
    return ResolvedPlatformRequestContext(
        actor=base.actor,
        tenant=base.tenant,
        project=PlatformProject(
            website_project_id=project.website_project_id,
            website_project_key=project.website_project_key,
        ),
        permissions=base.permissions,
        correlation_id=base.correlation_id,
    )


def _profile_input(body: WebsiteProjectProfileRequest) -> ProjectProfileInput:
    return ProjectProfileInput(
        name=body.name,
        domain=body.domain,
        country=body.country,
        target_market=body.target_market,
        language=body.language,
        products=tuple(body.products),
        keywords=tuple(body.keywords),
        target_urls=tuple(body.target_urls),
        target_audiences=tuple(body.target_audiences),
        partnership_goals=tuple(body.partnership_goals),
    )


def _profile_patch(
    body: WebsiteProjectProfilePatchRequest,
) -> ProjectProfilePatch:
    return ProjectProfilePatch(
        name=body.name,
        domain=body.domain,
        country=body.country,
        target_market=body.target_market,
        language=body.language,
        products=None if body.products is None else tuple(body.products),
        keywords=None if body.keywords is None else tuple(body.keywords),
        target_urls=None if body.target_urls is None else tuple(body.target_urls),
        target_audiences=(
            None if body.target_audiences is None else tuple(body.target_audiences)
        ),
        partnership_goals=(
            None if body.partnership_goals is None else tuple(body.partnership_goals)
        ),
    )


def _mutation_error(error: Exception) -> HTTPException:
    if isinstance(error, ProjectValidationError):
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": error.field, "message": str(error)},
        )
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=str(error),
    )


async def _require_business_consumers(request: Request) -> None:
    runtime: RuntimeDependencies = request.app.state.runtime_dependencies
    if await runtime.business_consumers_running():
        return
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "code": "BUSINESS_CONSUMERS_UNAVAILABLE",
            "message": (
                "Background processing is unavailable. "
                "No Website Project change was accepted."
            ),
        },
    )


async def _publish_projection(
    request: Request,
    resolved: ResolvedPlatformRequestContext | ResolvedPlatformCollectionContext,
    result: ProjectMutationResult,
) -> WebsiteProjectMutationResponse:
    gateway: BacklinksGateway = request.app.state.backlinks_gateway
    service: WebsiteProjectService = request.app.state.website_project_service
    delivery = await gateway.project_context_changed(
        resolved=_project_context(resolved, result.project),
        payload=result.projection_payload,
    )
    await service.mark_projection(
        organization_id=result.project.organization_id,
        project_id=result.project.website_project_id,
        outbox_event_id=result.outbox_event_id,
        published=delivery.published,
        error=delivery.error,
    )
    if result.project.input_required:
        background_status = "input_required"
    elif not delivery.published:
        background_status = "background_retryable"
    elif result.project.status == "ACTIVE":
        background_status = "recommendations_preparing"
    else:
        background_status = "projected"
    return WebsiteProjectMutationResponse(
        project=_project_response(result.project),
        background_status=background_status,
    )


def _service_scope(
    resolved: ResolvedPlatformRequestContext | ResolvedPlatformCollectionContext,
    settings: Settings,
) -> dict[str, str | tuple[str, ...] | None]:
    return {
        "organization_id": resolved.tenant.organization_id,
        "workspace_id": resolved.tenant.workspace_id,
        "legacy_project_id": settings.local_product_website_project_id or "",
        "legacy_project_key": settings.local_product_website_project_key or "",
        "authorized_project_ids": getattr(resolved, "authorized_project_ids", None),
    }


@router.get(
    "/api/v1/projects",
    response_model=list[WebsiteProjectResponse],
    operation_id="platformListWebsiteProjectsV1",
    openapi_extra=_PLATFORM_OPENAPI,
    responses=_PROJECT_RESPONSES,
)
async def list_website_projects(
    request: Request,
    include_archived: bool = Query(default=False),
) -> list[WebsiteProjectResponse]:
    settings: Settings = request.app.state.settings
    resolved = await _resolve_collection(request)
    service: WebsiteProjectService = request.app.state.website_project_service
    projects = await service.list_projects(
        **_service_scope(resolved, settings),
        include_archived=include_archived,
    )
    return [_project_response(project) for project in projects]


@router.post(
    "/api/v1/projects",
    response_model=WebsiteProjectMutationResponse,
    status_code=status.HTTP_201_CREATED,
    operation_id="platformCreateWebsiteProjectV1",
    openapi_extra=_PLATFORM_OPENAPI,
    responses=_PROJECT_RESPONSES,
)
async def create_website_project(
    request: Request,
    body: WebsiteProjectProfileRequest,
) -> WebsiteProjectMutationResponse:
    await _require_business_consumers(request)
    settings: Settings = request.app.state.settings
    resolved = await _resolve_collection(request)
    service: WebsiteProjectService = request.app.state.website_project_service
    try:
        result = await service.create_project(
            **_service_scope(resolved, settings),
            actor_id=resolved.actor.user_id,
            profile=_profile_input(body),
        )
    except (ProjectValidationError, ProjectConflictError) as error:
        raise _mutation_error(error) from error
    return await _publish_projection(request, resolved, result)


@router.get(
    "/api/v1/projects/{websiteProjectKey}",
    response_model=WebsiteProjectResponse,
    operation_id="platformGetWebsiteProjectV1",
    openapi_extra=_PLATFORM_OPENAPI,
    responses=_PROJECT_RESPONSES,
)
async def get_website_project(
    request: Request,
    websiteProjectKey: str,
) -> WebsiteProjectResponse:
    settings: Settings = request.app.state.settings
    resolved = await _resolve(request, websiteProjectKey)
    service: WebsiteProjectService = request.app.state.website_project_service
    project = await service.get_project(
        **_service_scope(resolved, settings),
        project_key=websiteProjectKey,
    )
    if project is None:
        raise HTTPException(status_code=404, detail="Website Project not found.")
    return _project_response(project)


@router.patch(
    "/api/v1/projects/{websiteProjectKey}",
    response_model=WebsiteProjectMutationResponse,
    operation_id="platformUpdateWebsiteProjectV1",
    openapi_extra=_PLATFORM_OPENAPI,
    responses=_PROJECT_RESPONSES,
)
async def update_website_project(
    request: Request,
    websiteProjectKey: str,
    body: WebsiteProjectProfilePatchRequest,
) -> WebsiteProjectMutationResponse:
    await _require_business_consumers(request)
    settings: Settings = request.app.state.settings
    resolved = await _resolve(request, websiteProjectKey)
    service: WebsiteProjectService = request.app.state.website_project_service
    try:
        result = await service.update_project(
            **_service_scope(resolved, settings),
            project_key=websiteProjectKey,
            actor_id=resolved.actor.user_id,
            patch=_profile_patch(body),
        )
    except (ProjectValidationError, ProjectConflictError) as error:
        raise _mutation_error(error) from error
    if result is None:
        raise HTTPException(status_code=404, detail="Website Project not found.")
    return await _publish_projection(request, resolved, result)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/archive",
    response_model=WebsiteProjectMutationResponse,
    operation_id="platformArchiveWebsiteProjectV1",
    openapi_extra=_PLATFORM_OPENAPI,
    responses=_PROJECT_RESPONSES,
)
async def archive_website_project(
    request: Request,
    websiteProjectKey: str,
) -> WebsiteProjectMutationResponse:
    settings: Settings = request.app.state.settings
    resolved = await _resolve(request, websiteProjectKey)
    service: WebsiteProjectService = request.app.state.website_project_service
    result = await service.archive_project(
        **_service_scope(resolved, settings),
        project_key=websiteProjectKey,
        actor_id=resolved.actor.user_id,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Website Project not found.")
    return await _publish_projection(request, resolved, result)


@router.post(
    "/api/v1/projects/{websiteProjectKey}/restore",
    response_model=WebsiteProjectMutationResponse,
    operation_id="platformRestoreWebsiteProjectV1",
    openapi_extra=_PLATFORM_OPENAPI,
    responses=_PROJECT_RESPONSES,
)
async def restore_website_project(
    request: Request,
    websiteProjectKey: str,
) -> WebsiteProjectMutationResponse:
    await _require_business_consumers(request)
    settings: Settings = request.app.state.settings
    resolved = await _resolve_collection(request)
    service: WebsiteProjectService = request.app.state.website_project_service
    project = await service.get_project(
        **_service_scope(resolved, settings),
        project_key=websiteProjectKey,
        include_archived=True,
    )
    if project is None or project.status != "ARCHIVED":
        raise HTTPException(status_code=404, detail="Archived Website Project not found.")
    result = await service.restore_project(
        **_service_scope(resolved, settings),
        project_key=websiteProjectKey,
        actor_id=resolved.actor.user_id,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Website Project not found.")
    return await _publish_projection(request, resolved, result)
