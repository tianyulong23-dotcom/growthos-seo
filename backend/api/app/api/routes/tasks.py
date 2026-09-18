from fastapi import APIRouter, HTTPException, Request, Response

from app.core.backlinks_gateway import PlatformContextResolutionError
from app.db.session import session_factory
from app.modules.tasks import ProjectTasksResponse, read_project_tasks
from app.modules.tasks import ProjectTask

router = APIRouter(prefix="/api/v1/projects/{project_id}/tasks", tags=["tasks"])


@router.get("", response_model=ProjectTasksResponse)
async def list_project_tasks(
    project_id: str, request: Request, response: Response,
) -> ProjectTasksResponse:
    try:
        context = await request.app.state.platform_context_resolver.resolve(
            request=request, website_project_key=project_id,
            required_permission="projects:read",
        )
    except PlatformContextResolutionError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc
    response.headers["Cache-Control"] = "no-store"
    return await read_project_tasks(session_factory, context)


@router.get("/{kind}/{task_id}", response_model=ProjectTask)
async def get_project_task(
    project_id: str, kind: str, task_id: str, request: Request, response: Response,
) -> ProjectTask:
    try:
        context = await request.app.state.platform_context_resolver.resolve(
            request=request, website_project_key=project_id, required_permission="projects:read",
        )
    except PlatformContextResolutionError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc
    response.headers["Cache-Control"] = "no-store"
    page = await read_project_tasks(session_factory, context, kind=kind, task_id=task_id)
    if not page.items:
        raise HTTPException(status_code=404, detail="TASK_NOT_FOUND")
    return page.items[0]
