import os
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from fastapi.responses import FileResponse, StreamingResponse
from starlette.background import BackgroundTask

from app.modules.audit.models import (
    AuditActivityCollection,
    AuditExternalResourceCollection,
    AuditExportDataset,
    AuditExportFormat,
    AuditIssueCollection,
    AuditLinkCollection,
    AuditPageCollection,
    AuditPageSpeedCollection,
    AuditRunCollection,
    AuditRunResponse,
    AuditStatusCodeCollection,
    AuditVisualizationResponse,
    CreateAuditRunRequest,
    RecalculateAuditIssuesRequest,
)
from app.modules.audit.service import (
    AuditLaunchError,
    AuditProjectNotFoundError,
    AuditRunNotFoundError,
    AuditService,
    AuditStateError,
    build_audit_service,
)

router = APIRouter(
    prefix="/api/v1/projects/{project_id}/audit-runs",
    tags=["audits"],
)

ProjectID = Annotated[
    str,
    Path(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._-]+$"),
]
UUIDPath = Annotated[UUID, Path()]
PageNumber = Annotated[int, Query(ge=1)]
PageSize = Annotated[int, Query(ge=1, le=1000)]


def get_audit_service() -> AuditService:
    return build_audit_service()


def audit_error(exc: Exception) -> HTTPException:
    if isinstance(exc, (AuditProjectNotFoundError, AuditRunNotFoundError)):
        return HTTPException(status_code=404, detail="项目或审计任务不存在")
    if isinstance(exc, AuditStateError):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, AuditLaunchError):
        return HTTPException(status_code=503, detail="技术审计服务暂时不可用")
    if isinstance(exc, ValueError):
        return HTTPException(status_code=422, detail=str(exc))
    return HTTPException(status_code=500, detail="技术审计请求失败")


@router.post("", response_model=AuditRunResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_audit_run(
    project_id: ProjectID,
    request: CreateAuditRunRequest,
    service: Annotated[AuditService, Depends(get_audit_service)],
) -> AuditRunResponse:
    try:
        return await service.create_run(project_id, request)
    except (
        ValueError,
        AuditProjectNotFoundError,
        AuditStateError,
        AuditLaunchError,
    ) as exc:
        raise audit_error(exc) from exc


@router.get("", response_model=AuditRunCollection)
async def list_audit_runs(
    project_id: ProjectID,
    service: Annotated[AuditService, Depends(get_audit_service)],
    include_archived: bool = False,
    page: PageNumber = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 25,
    search: str = "",
    run_status: Annotated[
        str | None,
        Query(alias="status", pattern="^(queued|running|paused|stopping|stopped|recalculating|completed|failed)$"),
    ] = None,
) -> AuditRunCollection:
    try:
        return await service.list_runs(
            project_id,
            include_archived,
            page,
            page_size,
            search,
            run_status,
        )
    except (ValueError, AuditProjectNotFoundError) as exc:
        raise audit_error(exc) from exc


@router.get("/{run_id}", response_model=AuditRunResponse)
async def get_audit_run(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
) -> AuditRunResponse:
    try:
        return await service.get_run(project_id, str(run_id))
    except AuditRunNotFoundError as exc:
        raise audit_error(exc) from exc


@router.post(
    "/{run_id}/recalculate-issues",
    response_model=AuditRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def recalculate_audit_issues(
    project_id: ProjectID,
    run_id: UUIDPath,
    request: RecalculateAuditIssuesRequest,
    service: Annotated[AuditService, Depends(get_audit_service)],
) -> AuditRunResponse:
    try:
        return await service.recalculate_issues(project_id, str(run_id), request)
    except (
        AuditProjectNotFoundError,
        AuditRunNotFoundError,
        AuditStateError,
        AuditLaunchError,
    ) as exc:
        raise audit_error(exc) from exc


@router.get("/{run_id}/activity", response_model=AuditActivityCollection)
async def get_audit_activity(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
    cursor: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
) -> AuditActivityCollection:
    try:
        return await service.activity(project_id, str(run_id), cursor, limit)
    except AuditRunNotFoundError as exc:
        raise audit_error(exc) from exc


@router.post("/{run_id}/pause", response_model=AuditRunResponse)
async def pause_audit_run(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
) -> AuditRunResponse:
    try:
        return await service.pause_run(project_id, str(run_id))
    except (
        AuditProjectNotFoundError,
        AuditRunNotFoundError,
        AuditStateError,
        AuditLaunchError,
    ) as exc:
        raise audit_error(exc) from exc


@router.post("/{run_id}/resume", response_model=AuditRunResponse)
async def resume_audit_run(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
) -> AuditRunResponse:
    try:
        return await service.resume_run(project_id, str(run_id))
    except (
        AuditProjectNotFoundError,
        AuditRunNotFoundError,
        AuditStateError,
        AuditLaunchError,
    ) as exc:
        raise audit_error(exc) from exc


@router.post("/{run_id}/stop", response_model=AuditRunResponse)
async def stop_audit_run(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
) -> AuditRunResponse:
    try:
        return await service.stop_run(project_id, str(run_id))
    except (AuditRunNotFoundError, AuditStateError, AuditLaunchError) as exc:
        raise audit_error(exc) from exc


@router.post("/{run_id}/archive", response_model=AuditRunResponse)
async def archive_audit_run(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
) -> AuditRunResponse:
    try:
        return await service.archive_run(project_id, str(run_id))
    except (
        AuditProjectNotFoundError,
        AuditRunNotFoundError,
        AuditStateError,
        AuditLaunchError,
    ) as exc:
        raise audit_error(exc) from exc


@router.delete("/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_audit_run(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
) -> Response:
    try:
        await service.delete_run(project_id, str(run_id))
    except (
        AuditProjectNotFoundError,
        AuditRunNotFoundError,
        AuditStateError,
        AuditLaunchError,
    ) as exc:
        raise audit_error(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{run_id}/issues", response_model=AuditIssueCollection)
async def get_audit_issues(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
    page: PageNumber = 1,
    page_size: PageSize = 100,
    severity: Annotated[str | None, Query(pattern="^(error|warning|notice)$")] = None,
    search: str = "",
) -> AuditIssueCollection:
    try:
        return await service.issues(project_id, str(run_id), page, page_size, severity, search)
    except AuditRunNotFoundError as exc:
        raise audit_error(exc) from exc


@router.get("/{run_id}/pages", response_model=AuditPageCollection)
async def get_audit_pages(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
    page: PageNumber = 1,
    page_size: PageSize = 100,
    search: str = "",
    status_code: int | None = None,
    status_family: Annotated[
        str | None,
        Query(pattern="^(2xx|3xx|4xx|5xx|unknown)$"),
    ] = None,
) -> AuditPageCollection:
    try:
        return await service.pages(
            project_id,
            str(run_id),
            page,
            page_size,
            search,
            status_code,
            status_family,
        )
    except AuditRunNotFoundError as exc:
        raise audit_error(exc) from exc


@router.get("/{run_id}/links", response_model=AuditLinkCollection)
async def get_audit_links(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
    page: PageNumber = 1,
    page_size: PageSize = 100,
    search: str = "",
    internal: bool | None = None,
    status_family: Annotated[
        str | None,
        Query(pattern="^(2xx|3xx|4xx|5xx|unknown)$"),
    ] = None,
) -> AuditLinkCollection:
    try:
        return await service.links(
            project_id,
            str(run_id),
            page,
            page_size,
            search,
            internal,
            status_family,
        )
    except AuditRunNotFoundError as exc:
        raise audit_error(exc) from exc


@router.get("/{run_id}/resources", response_model=AuditExternalResourceCollection)
async def get_audit_external_resources(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
    page: PageNumber = 1,
    page_size: PageSize = 100,
    search: str = "",
    status_family: Annotated[
        str | None,
        Query(pattern="^(2xx|3xx|4xx|5xx|unknown)$"),
    ] = None,
) -> AuditExternalResourceCollection:
    try:
        return await service.resources(
            project_id,
            str(run_id),
            page,
            page_size,
            search,
            status_family,
        )
    except AuditRunNotFoundError as exc:
        raise audit_error(exc) from exc


@router.get("/{run_id}/status-codes", response_model=AuditStatusCodeCollection)
async def get_audit_status_codes(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
) -> AuditStatusCodeCollection:
    try:
        return await service.status_codes(project_id, str(run_id))
    except AuditRunNotFoundError as exc:
        raise audit_error(exc) from exc


@router.get("/{run_id}/visualization", response_model=AuditVisualizationResponse)
async def get_audit_visualization(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
) -> AuditVisualizationResponse:
    try:
        return await service.visualization(project_id, str(run_id))
    except AuditRunNotFoundError as exc:
        raise audit_error(exc) from exc


@router.get("/{run_id}/pagespeed", response_model=AuditPageSpeedCollection)
async def get_audit_pagespeed(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
) -> AuditPageSpeedCollection:
    try:
        return await service.pagespeed(project_id, str(run_id))
    except AuditRunNotFoundError as exc:
        raise audit_error(exc) from exc


@router.get("/{run_id}/export")
async def export_audit(
    project_id: ProjectID,
    run_id: UUIDPath,
    service: Annotated[AuditService, Depends(get_audit_service)],
    dataset: AuditExportDataset = "issues",
    format: AuditExportFormat = "csv",
) -> Response:
    try:
        result = await service.export(
            project_id,
            str(run_id),
            dataset,
            format,
        )
    except AuditRunNotFoundError as exc:
        raise audit_error(exc) from exc
    if result.path is not None:
        return FileResponse(
            result.path,
            media_type=result.media_type,
            filename=result.filename,
            background=BackgroundTask(os.unlink, result.path),
        )
    return StreamingResponse(
        result.stream,
        media_type=result.media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{result.filename}"',
        },
    )
