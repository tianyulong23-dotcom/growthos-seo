from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any, Protocol

from temporalio.client import WorkflowExecutionStatus
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.service import RPCError, RPCStatusCode

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.agent.events import build_agent_event_store
from app.modules.agent.models import (
    AgentAction,
    AgentConversation,
    AgentMessage,
    AgentRun,
    AgentSystemTrigger,
    AgentTimelineEvent,
)
from app.modules.agent.progress import (
    business_progress_from_evidence,
    display_parts_from_evidence,
    failure_answer,
)
from app.modules.agent.repository import AgentRepository
from app.modules.agent.security import sanitize_agent_data, sanitize_text
from app.modules.agent.schemas import (
    AgentActionResponse,
    AgentConversationCollection,
    AgentConversationDetail,
    AgentConversationResponse,
    AgentOperationSummary,
    EditMessageRequest,
    AgentMessageResponse,
    AgentRunStepResponse,
    AgentRunResponse,
    AgentTimelineEventResponse,
    SendMessageRequest,
    SendMessageResponse,
)
from app.workflows.client import connect_temporal


STOP_WAIT_SECONDS = 5.0


class AgentNotFoundError(Exception):
    pass


class AgentConflictError(Exception):
    pass


class AgentWorkflowUnavailableError(Exception):
    pass


class AgentWorkflowState(StrEnum):
    RUNNING = "running"
    CLOSED = "closed"
    NOT_FOUND = "not_found"
    UNKNOWN = "unknown"


class WorkflowController(Protocol):
    async def start(self, run_id: str, limits: dict[str, Any]) -> None: ...
    async def cancel(self, workflow_id: str) -> None: ...
    async def status(self, workflow_id: str) -> AgentWorkflowState: ...


class TemporalAgentController:
    def __init__(self, task_queue: str) -> None:
        self.task_queue = task_queue

    async def start(self, run_id: str, limits: dict[str, Any]) -> None:
        client = await connect_temporal()
        cleanup_grace = max(
            int(limits["model_timeout_seconds"]),
            int(limits["write_tool_timeout_seconds"]),
        ) + 60
        try:
            await client.start_workflow(
                "AgentWorkflow", {"run_id": run_id, "limits": limits},
                id=f"agent:{run_id}", task_queue=self.task_queue,
                run_timeout=timedelta(
                    seconds=int(limits["run_timeout_seconds"]) + cleanup_grace
                ),
                task_timeout=timedelta(seconds=30),
            )
        except WorkflowAlreadyStartedError:
            return

    async def cancel(self, workflow_id: str) -> None:
        client = await connect_temporal()
        await client.get_workflow_handle(workflow_id).cancel()

    async def status(self, workflow_id: str) -> AgentWorkflowState:
        client = await connect_temporal()
        try:
            description = await client.get_workflow_handle(workflow_id).describe()
        except RPCError as exc:
            if exc.status == RPCStatusCode.NOT_FOUND:
                return AgentWorkflowState.NOT_FOUND
            raise
        if description.status == WorkflowExecutionStatus.RUNNING:
            return AgentWorkflowState.RUNNING
        if description.status in {
            WorkflowExecutionStatus.COMPLETED,
            WorkflowExecutionStatus.FAILED,
            WorkflowExecutionStatus.CANCELED,
            WorkflowExecutionStatus.TERMINATED,
            WorkflowExecutionStatus.CONTINUED_AS_NEW,
            WorkflowExecutionStatus.TIMED_OUT,
        }:
            return AgentWorkflowState.CLOSED
        return AgentWorkflowState.UNKNOWN

class AgentService:
    def __init__(self, settings: Settings, repository: AgentRepository, controller: WorkflowController) -> None:
        self.settings, self.repository, self.controller = settings, repository, controller

    @property
    def limits(self) -> dict[str, Any]:
        return {
            "model_rounds": self.settings.agent_max_model_rounds,
            "consecutive_failures": self.settings.agent_max_consecutive_failures,
            "model_cost": self.settings.agent_max_model_cost_usd,
            "paid_tool_cost": self.settings.agent_max_paid_cost_usd,
            "paid_tool_call_cost": self.settings.agent_paid_tool_reserve_usd,
            "tool_arguments_bytes": self.settings.agent_tool_arguments_bytes,
            "tool_result_bytes": self.settings.agent_tool_result_bytes,
            "tool_round_tokens": self.settings.agent_tool_round_tokens,
            "tool_context_tokens": self.settings.agent_tool_context_tokens,
            "tool_summary_tokens": self.settings.agent_tool_summary_tokens,
            "max_output_tokens": self.settings.agent_max_output_tokens,
            "final_answer_chars": self.settings.agent_final_answer_chars,
            "model_timeout_seconds": self.settings.agent_model_timeout_seconds,
            "read_tool_timeout_seconds": self.settings.agent_read_tool_timeout_seconds,
            "write_tool_timeout_seconds": self.settings.agent_write_tool_timeout_seconds,
            "run_timeout_seconds": self.settings.agent_run_timeout_seconds,
            "execution_lease_seconds": self.settings.agent_execution_lease_seconds,
            "context_window_tokens": self.settings.agent_context_window_tokens,
            "context_trigger_tokens": self.settings.agent_context_trigger_tokens,
            "context_input_tokens": self.settings.agent_context_input_tokens,
            "recent_tokens": self.settings.agent_context_recent_tokens,
            "compaction_batch_tokens": self.settings.agent_context_compaction_batch_tokens,
            "summary_tokens": self.settings.agent_context_summary_tokens,
        }

    async def create_conversation(self, project_id: str) -> AgentConversationResponse:
        await self._ensure_project(project_id)
        return conversation_response(await self.repository.create_conversation(
            self.settings.default_organization_id, project_id, self.settings.agent_actor_id
        ))

    async def archive_conversation(
        self, project_id: str, conversation_id: str
    ) -> AgentConversationResponse:
        try:
            conversation = await self.repository.archive_conversation(
                self.settings.default_organization_id, project_id, conversation_id
            )
        except RuntimeError as exc:
            raise AgentConflictError("当前对话还有任务正在运行") from exc
        if conversation is None:
            raise AgentNotFoundError
        return conversation_response(conversation)

    async def list_conversations(self, project_id: str, page: int, page_size: int) -> AgentConversationCollection:
        await self._ensure_project(project_id)
        rows, total = await self.repository.list_conversations(
            self.settings.default_organization_id, project_id, page, page_size
        )
        return AgentConversationCollection(
            items=[conversation_response(row) for row in rows], total=total,
            page=page, page_size=page_size,
        )

    async def get_conversation(self, project_id: str, conversation_id: str, after_sequence: int = 0) -> AgentConversationDetail:
        conversation = await self.repository.get_conversation(
            self.settings.default_organization_id, project_id, conversation_id
        )
        if conversation is None:
            raise AgentNotFoundError
        all_messages = await self.repository.conversation_messages(conversation_id)
        messages = [message_response(item, index + 1) for index, item in enumerate(all_messages) if index + 1 > after_sequence]
        timeline = await self.repository.timeline_events(
            self.settings.default_organization_id, project_id, conversation_id
        )
        run = await self.repository.latest_run_for_conversation(conversation_id)
        action = await self.repository.action_for_run(run.id) if run else None
        steps = await self.repository.run_steps(run.id) if run else []
        return AgentConversationDetail(
            conversation=conversation_response(conversation), messages=messages,
            timeline=[timeline_event_response(item) for item in timeline],
            run=run_response(run, action, all_messages, steps) if run else None,
            action=action_response(action) if action else None,
        )

    async def record_timeline_event(
        self,
        project_id: str,
        *,
        event_key: str,
        kind: str,
        status: str,
        title: str,
        content: str | None = None,
        conversation_id: str | None = None,
        action: dict | None = None,
        metadata: dict | None = None,
    ) -> AgentTimelineEventResponse:
        if kind not in {"message", "task", "action"}:
            raise ValueError("unsupported timeline event kind")
        if status not in {"running", "waiting", "completed", "failed", "cancelled"}:
            raise ValueError("unsupported timeline event status")
        if not event_key.strip() or len(event_key) > 200:
            raise ValueError("timeline event key must be between 1 and 200 characters")
        if not title.strip():
            raise ValueError("timeline event title is required")
        try:
            event = await self.repository.record_timeline_event(
                self.settings.default_organization_id,
                project_id,
                event_key=event_key.strip(),
                kind=kind,
                status=status,
                title=title,
                content=content,
                conversation_id=conversation_id,
                action=action,
                metadata=metadata,
            )
        except LookupError as exc:
            raise AgentNotFoundError from exc
        except RuntimeError as exc:
            raise AgentConflictError(str(exc)) from exc
        return timeline_event_response(event)

    async def send_message(self, project_id: str, conversation_id: str, request: SendMessageRequest) -> SendMessageResponse:
        try:
            message, run = await self.repository.create_message_run(
                self.settings.default_organization_id, project_id, conversation_id,
                request.content, request.client_request_id,
                request.page_context.model_dump(mode="json") if request.page_context else None,
                self.limits,
            )
        except LookupError as exc:
            raise AgentNotFoundError from exc
        except RuntimeError as exc:
            if str(exc) == "active_run":
                raise AgentConflictError("当前对话已有任务正在运行") from exc
            if str(exc) == "idempotency_conflict":
                raise AgentConflictError("这个请求编号已经用于另一项操作") from exc
            raise
        await self._start(run)
        return SendMessageResponse(message_id=message.id, run_id=run.id, status=run.status)

    async def trigger_system_turn(
        self,
        project_id: str,
        *,
        trigger: str,
        trigger_version: str,
        content: str,
        trusted_write_tools: tuple[str, ...],
    ) -> AgentSystemTrigger:
        try:
            return await self.repository.enqueue_system_trigger(
                self.settings.default_organization_id,
                project_id,
                trigger,
                trigger_version,
                content,
                trusted_write_tools,
            )
        except LookupError as exc:
            raise AgentNotFoundError from exc
        except RuntimeError as exc:
            if str(exc) == "idempotency_conflict":
                raise AgentConflictError("内部任务触发编号冲突") from exc
            raise

    async def rewind(
        self,
        project_id: str,
        conversation_id: str,
        message_id: str,
        client_request_id: str,
    ) -> AgentConversationDetail:
        conversation = await self.repository.get_conversation(
            self.settings.default_organization_id, project_id, conversation_id
        )
        if conversation is None:
            raise AgentNotFoundError
        await self._ensure_cancelled_workflow_closed(
            conversation_id, client_request_id
        )
        try:
            await self.repository.rewind_conversation(
                self.settings.default_organization_id,
                project_id,
                conversation_id,
                message_id,
                client_request_id,
            )
        except LookupError as exc:
            raise AgentNotFoundError from exc
        except RuntimeError as exc:
            if str(exc).startswith("active_run"):
                blocking_run_id = str(exc).partition(":")[2]
                active_run = (
                    await self.repository.get_run_scoped(
                        self.settings.default_organization_id,
                        project_id,
                        blocking_run_id,
                    )
                    if blocking_run_id
                    else await self.repository.latest_run_for_conversation(
                        conversation_id
                    )
                )
                if active_run is not None and active_run.status in {
                    "queued", "running", "executing", "verifying"
                }:
                    await self._stop_and_wait(project_id, active_run)
                try:
                    await self.repository.rewind_conversation(
                        self.settings.default_organization_id,
                        project_id,
                        conversation_id,
                        message_id,
                        client_request_id,
                    )
                except LookupError as retry_exc:
                    raise AgentNotFoundError from retry_exc
                except RuntimeError as retry_exc:
                    if str(retry_exc).startswith("active_run"):
                        raise AgentConflictError(
                            "当前任务仍在停止，请稍后重试"
                        ) from retry_exc
                    if str(retry_exc) == "message_not_active":
                        raise AgentConflictError(
                            "这条消息已被编辑或撤销，请刷新后重试"
                        ) from retry_exc
                    if str(retry_exc) == "idempotency_conflict":
                        raise AgentConflictError(
                            "这个请求编号已经用于另一项编辑或撤销操作"
                        ) from retry_exc
                    raise
            if str(exc) == "message_not_active":
                raise AgentConflictError("这条消息已被编辑或撤销，请刷新后重试") from exc
            if str(exc) == "idempotency_conflict":
                raise AgentConflictError("这个请求编号已经用于另一项编辑或撤销操作") from exc
            if not str(exc).startswith("active_run"):
                raise
        return await self.get_conversation(project_id, conversation_id)

    async def edit_message(
        self,
        project_id: str,
        conversation_id: str,
        request: EditMessageRequest,
    ) -> SendMessageResponse:
        conversation = await self.repository.get_conversation(
            self.settings.default_organization_id, project_id, conversation_id
        )
        if conversation is None:
            raise AgentNotFoundError
        await self._ensure_cancelled_workflow_closed(
            conversation_id, request.client_request_id
        )
        try:
            message, run = await self.repository.edit_message_run(
                self.settings.default_organization_id,
                project_id,
                conversation_id,
                request.message_id,
                request.content,
                request.client_request_id,
                self.limits,
            )
        except LookupError as exc:
            raise AgentNotFoundError from exc
        except RuntimeError as exc:
            if str(exc) == "message_not_active":
                raise AgentConflictError("这条消息已被编辑或撤销，请刷新后重试") from exc
            if str(exc) == "idempotency_conflict":
                raise AgentConflictError("这个请求编号已经用于另一项编辑或撤销操作") from exc
            if not str(exc).startswith("active_run"):
                raise
            blocking_run_id = str(exc).partition(":")[2]
            active_run = (
                await self.repository.get_run_scoped(
                    self.settings.default_organization_id,
                    project_id,
                    blocking_run_id,
                )
                if blocking_run_id
                else await self.repository.latest_run_for_conversation(conversation_id)
            )
            if active_run is not None and active_run.status in {
                "queued", "running", "executing", "verifying"
            }:
                await self._stop_and_wait(project_id, active_run)
            try:
                message, run = await self.repository.edit_message_run(
                    self.settings.default_organization_id,
                    project_id,
                    conversation_id,
                    request.message_id,
                    request.content,
                    request.client_request_id,
                    self.limits,
                )
            except LookupError as retry_exc:
                raise AgentNotFoundError from retry_exc
            except RuntimeError as retry_exc:
                if str(retry_exc).startswith("active_run"):
                    raise AgentConflictError(
                        "当前任务仍在停止，请稍后重试"
                    ) from retry_exc
                if str(retry_exc) == "message_not_active":
                    raise AgentConflictError(
                        "这条消息已被编辑或撤销，请刷新后重试"
                    ) from retry_exc
                if str(retry_exc) == "idempotency_conflict":
                    raise AgentConflictError(
                        "这个请求编号已经用于另一项编辑或撤销操作"
                    ) from retry_exc
                raise
        await self._start(run)
        return SendMessageResponse(
            message_id=message.id, run_id=run.id, status=run.status
        )

    async def operation_summary(self, project_id: str | None = None) -> AgentOperationSummary:
        if project_id is not None:
            await self._ensure_project(project_id)
        now = datetime.now(UTC)
        result = await self.repository.operation_summary(
            self.settings.default_organization_id,
            project_id,
            now - timedelta(seconds=self.settings.agent_stuck_run_seconds),
            now - timedelta(hours=1),
        )
        return AgentOperationSummary.model_validate(result)

    async def get_run(self, project_id: str, run_id: str) -> AgentRunResponse:
        run = await self.repository.get_run_scoped(self.settings.default_organization_id, project_id, run_id)
        if run is None:
            raise AgentNotFoundError
        if run.status in {"queued", "running", "executing", "verifying"}:
            try:
                await self._reconcile_run(run)
                run = await self.repository.get_run_scoped(
                    self.settings.default_organization_id, project_id, run_id
                ) or run
            except Exception:
                pass
        action = await self.repository.action_for_run(run.id)
        messages = await self.repository.conversation_messages(run.conversation_id)
        steps = await self.repository.run_steps(run.id)
        return run_response(run, action, messages, steps)

    async def retry_system_trigger(
        self,
        project_id: str,
        run_id: str,
    ) -> SendMessageResponse:
        try:
            message, run = await self.repository.retry_system_trigger_run(
                self.settings.default_organization_id,
                project_id,
                run_id,
                self.limits,
            )
        except LookupError as exc:
            raise AgentNotFoundError from exc
        except RuntimeError as exc:
            reason = str(exc)
            if reason == "active_run":
                raise AgentConflictError("当前对话已有任务正在运行") from exc
            if reason.startswith("run_not_retryable:"):
                raise AgentConflictError("只有失败的 Agent 任务可以重试") from exc
            if reason == "run_not_system_trigger":
                raise AgentConflictError("这个任务不是可重试的系统任务") from exc
            raise
        await self._start(run)
        return SendMessageResponse(
            message_id=message.id,
            run_id=run.id,
            status=run.status,
        )

    async def cancel(self, project_id: str, run_id: str) -> AgentRunResponse:
        run = await self.repository.get_run_scoped(self.settings.default_organization_id, project_id, run_id)
        if run is None:
            raise AgentNotFoundError
        if run.status in {
            "completed", "rejected", "cancelled", "failed", "expired", "limit_reached"
        }:
            return await self.get_run(project_id, run_id)
        await self.repository.cancel_run(run.id)
        event_store = build_agent_event_store()
        active_message = await event_store.active_message(
            run.conversation_id, run.id
        )
        active_turn = await event_store.active_turn(run.conversation_id, run.id)
        base_event = {
            "project_id": project_id,
            "conversation_id": run.conversation_id,
            "run_id": run.id,
        }
        if active_message is not None:
            await event_store.close_message(
                run.conversation_id,
                {
                    **base_event,
                    **active_message,
                    "status": "cancelled",
                    "code": "user_cancelled",
                    "message": "任务已取消",
                    "event_key": (
                        f"{run.id}:message:{active_message['message_id']}:"
                        f"{active_message['attempt']}:end:cancelled"
                    ),
                },
            )
        if active_turn is not None:
            await event_store.publish(
                run.conversation_id,
                "turn_end",
                {
                    **base_event,
                    "round": active_turn,
                    "outcome": "cancelled",
                    "tool_result_count": 0,
                    "event_key": f"{run.id}:turn:{active_turn}:end:cancelled",
                },
            )
        await event_store.publish(
            run.conversation_id,
            "agent_end",
            {
                **base_event,
                "status": "cancelled",
                "error_code": "user_cancelled",
                "event_key": f"{run.id}:agent:end:cancelled",
            },
        )
        try:
            await self.controller.cancel(run.workflow_id)
        except Exception:
            # The durable database state still prevents further approval/execution.
            pass
        return await self.get_run(project_id, run_id)

    async def approve(self, project_id: str, action_id: str, parameters_hash: str) -> AgentActionResponse:
        return await self._legacy_action_conflict(project_id, action_id)

    async def reject(self, project_id: str, action_id: str) -> AgentActionResponse:
        return await self._legacy_action_conflict(project_id, action_id)

    async def dispatch_queued(self) -> int:
        count = 0
        await self.repository.materialize_pending_system_triggers(self.limits)
        for run in await self.repository.list_pending_dispatches():
            try:
                if await self._start(run):
                    count += 1
            except AgentWorkflowUnavailableError:
                continue
        await self.reconcile_active_runs()
        return count

    async def reconcile_active_runs(self) -> int:
        reconciled = 0
        for run in await self.repository.active_runs():
            if await self._reconcile_run(run):
                reconciled += 1
        return reconciled

    async def _reconcile_run(self, run: AgentRun) -> bool:
        state = await self.controller.status(run.workflow_id)
        if state in {AgentWorkflowState.RUNNING, AgentWorkflowState.UNKNOWN}:
            return False
        if state == AgentWorkflowState.NOT_FOUND and run.status == "queued":
            return False
        confirmed_state = await self.controller.status(run.workflow_id)
        if confirmed_state in {
            AgentWorkflowState.RUNNING,
            AgentWorkflowState.UNKNOWN,
        }:
            return False
        if (
            confirmed_state == AgentWorkflowState.NOT_FOUND
            and run.status == "queued"
        ):
            return False
        reason = "Agent 工作流已经结束，但数据库没有保存正常终态。"
        try:
            completion = await self.repository.completion_evidence(run.id)
        except Exception:
            completion = {}
        progress = business_progress_from_evidence(completion)
        metadata: dict[str, Any] = {"reconciled": True}
        if progress:
            metadata["business_progress"] = progress
        answer = failure_answer(progress, reason)
        metadata["display_parts"] = display_parts_from_evidence(completion, answer)
        await self.repository.finalize_run(
            run.id,
            answer,
            metadata,
            "failed",
            "agent_workflow_closed",
            reason,
        )
        return True

    async def _legacy_action_conflict(
        self, project_id: str, action_id: str
    ) -> AgentActionResponse:
        action = await self.repository.get_action_scoped(
            self.settings.default_organization_id, project_id, action_id
        )
        if action is None:
            raise AgentNotFoundError
        raise AgentConflictError("历史审批记录仅供查看，新任务已改为平台直接执行")

    async def _start(self, run: AgentRun) -> bool:
        try:
            async with self.repository.pending_dispatch(run.id) as pending_run:
                if pending_run is None:
                    return False
                await self.controller.start(
                    pending_run.id, dict(pending_run.limits_json)
                )
                return True
        except Exception as exc:
            raise AgentWorkflowUnavailableError("Agent 服务暂时不可用，任务已保存并会自动重试") from exc

    async def _stop_and_wait(self, project_id: str, run: AgentRun) -> None:
        await self.cancel(project_id, run.id)
        deadline = asyncio.get_running_loop().time() + STOP_WAIT_SECONDS
        while True:
            try:
                state = await self.controller.status(run.workflow_id)
            except Exception as exc:
                raise AgentConflictError(
                    "无法确认当前任务已经停止，请稍后重试"
                ) from exc
            if state in {AgentWorkflowState.CLOSED, AgentWorkflowState.NOT_FOUND}:
                return
            if asyncio.get_running_loop().time() >= deadline:
                raise AgentConflictError("当前任务仍在停止，请稍后重试")
            await asyncio.sleep(0.1)

    async def _ensure_cancelled_workflow_closed(
        self, conversation_id: str, client_request_id: str
    ) -> None:
        existing_event = await self.repository.conversation_event_for_request(
            conversation_id, client_request_id
        )
        if existing_event is not None:
            return
        run = await self.repository.latest_run_for_conversation(conversation_id)
        if run is None or run.status != "cancelled":
            return
        try:
            state = await self.controller.status(run.workflow_id)
        except Exception as exc:
            raise AgentConflictError(
                "无法确认当前任务已经停止，请稍后重试"
            ) from exc
        if state == AgentWorkflowState.RUNNING:
            raise AgentConflictError("当前任务仍在停止，请稍后重试")

    async def _ensure_project(self, project_id: str) -> None:
        if not await self.repository.project_exists(self.settings.default_organization_id, project_id):
            raise AgentNotFoundError


def conversation_response(row: AgentConversation) -> AgentConversationResponse:
    return AgentConversationResponse(id=row.id, project_id=row.project_id, title=row.title, created_at=row.created_at, updated_at=row.updated_at)


def message_response(row: AgentMessage, sequence: int) -> AgentMessageResponse:
    return AgentMessageResponse(id=row.id, run_id=row.run_id, role=row.role, content=row.content, metadata=dict(row.metadata_json), sequence=sequence, created_at=row.created_at)


def timeline_event_response(row: AgentTimelineEvent) -> AgentTimelineEventResponse:
    return AgentTimelineEventResponse(
        id=row.id,
        event_key=row.event_key,
        conversation_id=row.conversation_id,
        sequence=row.sequence,
        kind=row.kind,
        status=row.status,
        title=row.title,
        content=row.content,
        action=dict(row.action_json),
        metadata=dict(row.metadata_json),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def action_response(row: AgentAction) -> AgentActionResponse:
    return AgentActionResponse(
        id=row.id, run_id=row.run_id, tool_name=row.tool_name, status=row.status,
        preview=dict(row.preview_json), parameters_hash=row.parameters_hash,
        expires_at=row.expires_at, result=dict(row.result_json),
    )


def run_response(
    row: AgentRun, action: AgentAction | None, messages: list[AgentMessage], steps: list
) -> AgentRunResponse:
    final = next((item for item in reversed(messages) if item.run_id == row.id and item.role == "assistant"), None)
    input_tokens = sum(item.input_tokens or 0 for item in steps)
    output_tokens = sum(item.output_tokens or 0 for item in steps)
    total_tokens = sum(item.total_tokens or 0 for item in steps)
    costs = [float(item.cost) for item in steps if item.cost is not None]
    currencies = {item.cost_currency for item in steps if item.cost_currency}
    return AgentRunResponse(
        id=row.id, conversation_id=row.conversation_id, status=row.status,
        current_step=row.current_step, error_code=row.error_code, error_message=row.error_message,
        action=action_response(action) if action else None,
        final_message_id=final.id if final else None,
        model_calls=sum(item.step_type == "model" for item in steps),
        tool_calls=sum(item.step_type == "tool" for item in steps),
        failed_steps=sum(item.status == "failed" for item in steps),
        input_tokens=input_tokens, output_tokens=output_tokens, total_tokens=total_tokens,
        cost=sum(costs) if costs else None,
        cost_currency=next(iter(currencies)) if len(currencies) == 1 else None,
        steps=[AgentRunStepResponse(
            sequence=item.sequence, step_type=item.step_type, name=item.name,
            label=step_label(item.name), summary=step_summary(item),
            status=item.status, duration_ms=item.duration_ms,
            input=sanitize_agent_data(dict(item.input_json)),
            output=sanitize_agent_data(dict(item.output_json)),
            error_code=item.error_code, error_message=item.error_message,
            input_tokens=item.input_tokens, output_tokens=item.output_tokens,
            total_tokens=item.total_tokens,
            cost=float(item.cost) if item.cost is not None else None,
            cost_currency=item.cost_currency, created_at=item.created_at,
            finished_at=item.finished_at,
        ) for item in steps],
        created_at=row.created_at, updated_at=row.updated_at,
    )


STEP_LABELS = {
    "chat.completions": "分析下一步",
    "history_compaction": "整理对话记录",
    "final_check": "检查任务是否完成",
    "final_response": "发送最终回答",
    "get_project_profile": "读取项目资料",
    "search_project_memory": "检索项目记忆",
    "get_latest_audit": "读取最近一次技术审核",
    "get_audit_status": "检查技术审核进度",
    "get_audit_issues": "读取技术审核问题",
    "get_audit_pages": "读取技术审核页面",
    "update_project_memory": "更新项目记忆",
    "update_business_profile": "更新业务资料",
    "refresh_business_profile": "重新识别网站业务",
    "start_technical_audit": "启动技术审核",
    "start_keyword_library": "建立关键词库",
    "get_keyword_library_status": "检查关键词库进度",
    "start_content_plan": "生成 30 篇内容计划",
    "get_content_plan_status": "检查内容计划进度",
    "start_articles": "启动文章生成",
    "get_article_generation_status": "检查文章生成进度",
    "create_article": "启动关键词文章生成",
    "list_keywords": "查询关键词库",
    "get_keyword_competitors": "读取关键词竞品",
    "get_keyword_opportunities": "读取关键词机会",
    "get_search_performance": "读取搜索表现",
    "get_article_performance": "读取文章表现",
}


def step_label(name: str) -> str:
    return STEP_LABELS.get(name, name.replace("_", " "))


def step_summary(item: Any) -> str | None:
    if item.error_message:
        return sanitize_text(item.error_message)[:500]
    output = sanitize_agent_data(dict(item.output_json))
    for key in ("summary", "reason", "answer", "message"):
        value = output.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:500]
    if item.status == "running":
        return "正在执行"
    return None


def build_agent_service() -> AgentService:
    settings = get_settings()
    return AgentService(settings, AgentRepository(session_factory), TemporalAgentController(settings.agent_task_queue))
