"""Task operations resolve existing domain records under signed user authority."""
from dataclasses import replace
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.modules.agent.delegation import resolve_delegation
from app.modules.tasks import ACTIVE_TASK_STATUSES, read_project_tasks


class TaskArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["article", "content_plan", "audit", "project", "keywords", "agent", "performance", "onboarding"]
    task_id: str = Field(min_length=1, max_length=200)


async def task_context(registry, project_id, organization_id, delegation, permission="projects:read"):
    registry._require_service(registry.backlinks, "project_tasks")
    context = await resolve_delegation(
        registry.settings, registry.backlinks.projects, delegation, project_id, organization_id,
        required_permission=permission,
    )
    # Claims have been verified above; never get permissions from tool arguments.
    return replace(context, permissions=tuple(delegation["claims"]["permissions"]))


async def read_tasks(registry, project_id, organization_id, delegation, arguments):
    from app.db.session import session_factory
    context = await task_context(registry, project_id, organization_id, delegation)
    page = await read_project_tasks(
        session_factory, context, kind=arguments.get("kind"), task_id=arguments.get("task_id"),
    )
    if arguments.get("task_id") and not page.items:
        raise LookupError("TASK_NOT_FOUND")
    return page.model_dump(mode="json")


async def cancel_task(registry, project_id, organization_id, delegation, arguments, current_run_id):
    kind, identifier = arguments["kind"], arguments["task_id"]
    permission = {"article": "content:write", "audit": "projects:write", "agent": "backlinks:write"}.get(kind)
    if permission is None:
        raise ValueError("TASK_CANCELLATION_UNSUPPORTED")
    await task_context(registry, project_id, organization_id, delegation, permission)
    page = await read_tasks(registry, project_id, organization_id, delegation, arguments)
    task = page["items"][0]
    if task["status"] not in ACTIVE_TASK_STATUSES:
        return {"task": task, "already_terminal": True}
    if kind == "article":
        registry._require_service(registry.content, "cancel_project_task")
        await registry.content.cancel_article(
            project_id, task["related_id"], organization_id=organization_id,
            expected_run_id=identifier,
        )
    elif kind == "audit":
        registry._require_service(registry.audits, "cancel_project_task")
        if registry.audits.organization_id != organization_id:
            raise ValueError("TASK_ORGANIZATION_UNSUPPORTED")
        await registry.audits.stop_run(project_id, identifier)
    else:
        if identifier == current_run_id:
            raise ValueError("TASK_CANNOT_CANCEL_CURRENT_COMMAND")
        from app.modules.agent.service import build_agent_service
        service = build_agent_service()
        # AgentService currently uses the default organization. Never cross that boundary.
        if service.settings.default_organization_id != organization_id:
            raise ValueError("TASK_ORGANIZATION_UNSUPPORTED")
        await service.cancel(project_id, identifier)
    updated = await read_tasks(registry, project_id, organization_id, delegation, arguments)
    return {"task": updated["items"][0], "cancellation_requested": True}
