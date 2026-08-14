import asyncio
import json
from typing import Annotated, AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse

from app.modules.agent.schemas import (
    AgentActionResponse, AgentConversationCollection, AgentConversationDetail,
    AgentConversationResponse, AgentRunResponse, ApproveActionRequest,
    AgentOperationSummary, EditMessageRequest, RewindConversationRequest, SendMessageRequest,
    SendMessageResponse,
)
from app.modules.agent.events import AgentEventStore, build_agent_event_store
from app.modules.agent.security import sanitize_agent_data
from app.modules.agent.service import (
    AgentConflictError, AgentNotFoundError, AgentService,
    AgentWorkflowUnavailableError, build_agent_service,
)

router = APIRouter(prefix="/api/v1/projects/{project_id}/agent", tags=["agent"])


def get_agent_service() -> AgentService:
    return build_agent_service()


def agent_error(exc: Exception) -> HTTPException:
    if isinstance(exc, AgentNotFoundError):
        return HTTPException(status_code=404, detail="项目、对话或 Agent 任务不存在")
    if isinstance(exc, AgentConflictError):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, AgentWorkflowUnavailableError):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=500, detail="Agent 请求失败")


@router.post("/conversations", response_model=AgentConversationResponse, status_code=status.HTTP_201_CREATED)
async def create_conversation(project_id: str, service: Annotated[AgentService, Depends(get_agent_service)]) -> AgentConversationResponse:
    try:
        return await service.create_conversation(project_id)
    except AgentNotFoundError as exc:
        raise agent_error(exc) from exc


@router.get("/conversations", response_model=AgentConversationCollection)
async def list_conversations(
    project_id: str, service: Annotated[AgentService, Depends(get_agent_service)],
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> AgentConversationCollection:
    try:
        return await service.list_conversations(project_id, page, page_size)
    except AgentNotFoundError as exc:
        raise agent_error(exc) from exc


@router.get("/conversations/{conversation_id}", response_model=AgentConversationDetail)
async def get_conversation(
    project_id: str, conversation_id: str,
    service: Annotated[AgentService, Depends(get_agent_service)],
    after_sequence: Annotated[int, Query(ge=0)] = 0,
) -> AgentConversationDetail:
    try:
        return await service.get_conversation(project_id, conversation_id, after_sequence)
    except AgentNotFoundError as exc:
        raise agent_error(exc) from exc


@router.post("/conversations/{conversation_id}/archive", response_model=AgentConversationResponse)
async def archive_conversation(
    project_id: str, conversation_id: str,
    service: Annotated[AgentService, Depends(get_agent_service)],
) -> AgentConversationResponse:
    try:
        return await service.archive_conversation(project_id, conversation_id)
    except (AgentNotFoundError, AgentConflictError) as exc:
        raise agent_error(exc) from exc


@router.post("/conversations/{conversation_id}/messages", response_model=SendMessageResponse, status_code=status.HTTP_202_ACCEPTED)
async def send_message(project_id: str, conversation_id: str, request: SendMessageRequest, service: Annotated[AgentService, Depends(get_agent_service)]) -> SendMessageResponse:
    try:
        return await service.send_message(project_id, conversation_id, request)
    except (AgentNotFoundError, AgentConflictError, AgentWorkflowUnavailableError) as exc:
        raise agent_error(exc) from exc


@router.post(
    "/conversations/{conversation_id}/rewind",
    response_model=AgentConversationDetail,
)
async def rewind_conversation(
    project_id: str,
    conversation_id: str,
    request: RewindConversationRequest,
    service: Annotated[AgentService, Depends(get_agent_service)],
) -> AgentConversationDetail:
    try:
        return await service.rewind(
            project_id,
            conversation_id,
            request.message_id,
            request.client_request_id,
        )
    except (AgentNotFoundError, AgentConflictError) as exc:
        raise agent_error(exc) from exc


@router.post(
    "/conversations/{conversation_id}/edit",
    response_model=SendMessageResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def edit_message(
    project_id: str,
    conversation_id: str,
    request: EditMessageRequest,
    service: Annotated[AgentService, Depends(get_agent_service)],
) -> SendMessageResponse:
    try:
        return await service.edit_message(project_id, conversation_id, request)
    except (
        AgentNotFoundError,
        AgentConflictError,
        AgentWorkflowUnavailableError,
    ) as exc:
        raise agent_error(exc) from exc


def sse_event(name: str, payload: dict, event_id: str | None = None) -> str:
    sanitized = sanitize_agent_data(payload)
    prefix = f"id: {event_id}\n" if event_id else ""
    return (
        f"{prefix}event: {name}\n"
        f"data: {json.dumps(sanitized, ensure_ascii=False)}\n\n"
    )


async def conversation_event_stream(
    request: Request,
    service: AgentService,
    project_id: str,
    conversation_id: str,
    event_store: AgentEventStore | None = None,
) -> AsyncIterator[str]:
    event_store = event_store or build_agent_event_store()
    headers = getattr(request, "headers", {})
    last_event_id = str(headers.get("last-event-id", "0-0") or "0-0")
    redis_available = True
    previous_status = ""
    previous_step = -1
    previous_sequence = 0
    previous_timeline_version: tuple[tuple[str, str, str], ...] = ()
    heartbeat = 0
    while not await request.is_disconnected():
        detail = await service.get_conversation(project_id, conversation_id)
        payload = detail.model_dump(mode="json")
        current_status = detail.run.status if detail.run else ""
        current_step = detail.run.current_step if detail.run else 0
        current_sequence = max((item.sequence for item in detail.messages), default=0)
        current_timeline_version = tuple(
            (item.id, item.status, item.updated_at.isoformat())
            for item in detail.timeline
        )
        changed = (
            current_status != previous_status
            or current_step != previous_step
            or current_sequence != previous_sequence
            or current_timeline_version != previous_timeline_version
        )
        if changed:
            yield sse_event("snapshot", payload)
            if current_status != previous_status and detail.run:
                yield sse_event("run_status", detail.run.model_dump(mode="json"))
            if current_step > previous_step and detail.run:
                for step in detail.run.steps:
                    if step.sequence > previous_step:
                        yield sse_event("step", step.model_dump(mode="json"))
            for message in detail.messages:
                if message.sequence > previous_sequence:
                    yield sse_event("message", message.model_dump(mode="json"))
            if current_status == "cancelled" and previous_status != "cancelled":
                yield sse_event("cancelled", {"run_id": detail.run.id})
            if current_status in {"failed", "limit_reached"} and detail.run:
                yield sse_event("error", {
                    "run_id": detail.run.id,
                    "code": detail.run.error_code,
                    "message": detail.run.error_message,
                })
            previous_status = current_status
            previous_step = current_step
            previous_sequence = current_sequence
            previous_timeline_version = current_timeline_version
            heartbeat = 0
        active_run_id = detail.run.id if detail.run else None
        if redis_available:
            events = await event_store.read(
                conversation_id,
                last_event_id,
                block_ms=0 if changed else 750,
            )
            if events is None:
                redis_available = False
            else:
                for event in events:
                    last_event_id = event["id"]
                    data = event["data"]
                    if data.get("project_id") != project_id:
                        continue
                    if data.get("conversation_id") != conversation_id:
                        continue
                    if active_run_id and data.get("run_id") != active_run_id:
                        continue
                    yield sse_event(event["event"], data, event["id"])
                if events:
                    heartbeat = 0
                    continue
        if not changed:
            heartbeat += 1
            if heartbeat >= 20:
                yield ": heartbeat\n\n"
                heartbeat = 0
            await asyncio.sleep(0.75 if not redis_available else 0)


@router.get("/conversations/{conversation_id}/events")
async def stream_conversation(
    project_id: str,
    conversation_id: str,
    request: Request,
    service: Annotated[AgentService, Depends(get_agent_service)],
) -> StreamingResponse:
    try:
        await service.get_conversation(project_id, conversation_id)
    except AgentNotFoundError as exc:
        raise agent_error(exc) from exc
    return StreamingResponse(
        conversation_event_stream(request, service, project_id, conversation_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/runs/{run_id}", response_model=AgentRunResponse)
async def get_run(project_id: str, run_id: str, service: Annotated[AgentService, Depends(get_agent_service)]) -> AgentRunResponse:
    try:
        return await service.get_run(project_id, run_id)
    except AgentNotFoundError as exc:
        raise agent_error(exc) from exc


@router.post(
    "/runs/{run_id}/retry",
    response_model=SendMessageResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def retry_system_trigger_run(
    project_id: str,
    run_id: str,
    service: Annotated[AgentService, Depends(get_agent_service)],
) -> SendMessageResponse:
    try:
        return await service.retry_system_trigger(project_id, run_id)
    except (
        AgentNotFoundError,
        AgentConflictError,
        AgentWorkflowUnavailableError,
    ) as exc:
        raise agent_error(exc) from exc


@router.post("/runs/{run_id}/cancel", response_model=AgentRunResponse)
async def cancel_run(project_id: str, run_id: str, service: Annotated[AgentService, Depends(get_agent_service)]) -> AgentRunResponse:
    try:
        return await service.cancel(project_id, run_id)
    except AgentNotFoundError as exc:
        raise agent_error(exc) from exc


@router.get("/operations", response_model=AgentOperationSummary)
async def agent_operations(
    project_id: str,
    service: Annotated[AgentService, Depends(get_agent_service)],
) -> AgentOperationSummary:
    try:
        return await service.operation_summary(project_id)
    except AgentNotFoundError as exc:
        raise agent_error(exc) from exc


@router.post("/actions/{action_id}/approve", response_model=AgentActionResponse)
async def approve_action(project_id: str, action_id: str, request: ApproveActionRequest, service: Annotated[AgentService, Depends(get_agent_service)]) -> AgentActionResponse:
    try:
        return await service.approve(project_id, action_id, request.parameters_hash)
    except (AgentNotFoundError, AgentConflictError) as exc:
        raise agent_error(exc) from exc


@router.post("/actions/{action_id}/reject", response_model=AgentActionResponse)
async def reject_action(project_id: str, action_id: str, service: Annotated[AgentService, Depends(get_agent_service)]) -> AgentActionResponse:
    try:
        return await service.reject(project_id, action_id)
    except (AgentNotFoundError, AgentConflictError) as exc:
        raise agent_error(exc) from exc
