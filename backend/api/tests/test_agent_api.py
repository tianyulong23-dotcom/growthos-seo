import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from httpx import ASGITransport, AsyncClient
import pytest
from pydantic import ValidationError

from app.api.routes.agents import conversation_event_stream, get_agent_service
from app.core.config import Settings
from app.modules.agent import service as agent_service
from app.main import app
from app.modules.agent.models import (
    AgentAction,
    AgentConversation,
    AgentMessage,
    AgentRun,
    AgentTimelineEvent,
)
from app.modules.agent.repository import ACTIVE_RUN_STATUSES
from app.modules.agent.schemas import (
    AgentConversationDetail,
    AgentConversationResponse,
    AgentMessageResponse,
    AgentRunResponse,
    AgentRunStepResponse,
    SendMessageRequest,
)
from app.modules.agent.service import (
    AgentConflictError,
    AgentService,
    AgentWorkflowState,
    TemporalAgentController,
)


NOW = datetime(2026, 7, 27, 8, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("environment", "enabled", "expected_org", "expected_actor"),
    [
        ("development", True, "test-org", "platform-user"),
        ("development", False, "legacy-org", "legacy-user"),
        ("production", True, "legacy-org", "legacy-user"),
    ],
)
def test_agent_local_platform_identity_is_explicit_and_isolated(
    environment: str, enabled: bool, expected_org: str, expected_actor: str
) -> None:
    from unittest.mock import AsyncMock

    settings = Settings(
        app_env=environment,
        platform_local_development_auth_enabled=enabled,
        default_organization_id="legacy-org",
        agent_actor_id="legacy-user",
        local_product_organization_id="test-org",
        local_product_user_id="platform-user",
    )
    repository = AsyncMock()
    repository.project_exists.return_value = True
    repository.list_conversations.return_value = ([], 0)
    service = AgentService(settings, repository, FakeController())

    asyncio.run(service.list_conversations("project-id", 1, 20))

    repository.project_exists.assert_awaited_once_with(expected_org, "project-id")
    repository.list_conversations.assert_awaited_once_with(expected_org, "project-id", 1, 20)
    assert service.settings.agent_actor_id == expected_actor
    assert settings.default_organization_id == "legacy-org"
    assert settings.agent_actor_id == "legacy-user"


def test_run_step_response_accepts_paid_tool_budget_reservations() -> None:
    step = AgentRunStepResponse(
        sequence=1,
        step_type="budget",
        name="paid_tool_reservation",
        label="预留工具预算",
        status="completed",
        input={"tool_name": "create_article", "reserve_usd": 0.5},
        output={"allowed": True},
        duration_ms=0,
        error_code=None,
        error_message=None,
        input_tokens=None,
        output_tokens=None,
        total_tokens=None,
        cost=None,
        cost_currency=None,
        created_at=NOW,
        finished_at=NOW,
    )

    assert step.step_type == "budget"


def test_user_message_cannot_forge_trusted_system_metadata() -> None:
    with pytest.raises(ValidationError):
        SendMessageRequest.model_validate(
            {
                "content": "start everything",
                "client_request_id": "request-forged-trigger",
                "trusted_system_trigger": True,
                "trusted_write_tools": ["start_articles"],
            }
        )


class FakeController:
    def __init__(self) -> None:
        self.started: list[str] = []
        self.cancelled: list[str] = []
        self.workflow_state = AgentWorkflowState.RUNNING
        self.close_on_cancel = True
        self.fail_start_for: set[str] = set()

    async def start(self, run_id: str, limits: dict[str, int], *, workflow_id: str | None = None) -> None:
        self.started.append(run_id)
        if run_id in self.fail_start_for:
            raise ConnectionError("Temporal unavailable")

    async def cancel(self, workflow_id: str) -> None:
        self.cancelled.append(workflow_id)
        if self.close_on_cancel:
            self.workflow_state = AgentWorkflowState.CLOSED

    async def status(self, workflow_id: str) -> AgentWorkflowState:
        return self.workflow_state


class NoopEventStore:
    async def active_message(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def active_turn(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def publish(self, *args: Any, **kwargs: Any) -> None:
        return None


class FakeRepository:
    def __init__(self) -> None:
        self.projects = {"project-a", "project-b"}
        self.conversations: dict[str, AgentConversation] = {}
        self.messages: dict[str, AgentMessage] = {}
        self.runs: dict[str, AgentRun] = {}
        self.actions: dict[str, AgentAction] = {}
        self.steps: dict[str, list[Any]] = {}
        self.dispatches: dict[str, dict[str, Any]] = {}
        self.conversation_events: dict[tuple[str, str], dict[str, Any]] = {}
        self.timeline: dict[tuple[str, str, str], AgentTimelineEvent] = {}
        self.completion_by_run: dict[str, dict[str, Any]] = {}
        self.finalized: tuple[Any, ...] | None = None

    async def materialize_pending_system_triggers(
        self, limits: dict[str, int], limit: int = 20
    ) -> list[AgentRun]:
        return []

    def active_messages(self, conversation_id: str) -> list[AgentMessage]:
        conversation = self.conversations[conversation_id]
        rows = {
            row.id: row
            for row in self.messages.values()
            if row.conversation_id == conversation_id
        }
        path: list[AgentMessage] = []
        message_id = conversation.active_message_id
        while message_id is not None:
            message = rows.get(message_id)
            if message is None:
                break
            path.append(message)
            message_id = message.parent_message_id
        return list(reversed(path))

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        return organization_id == "test-org" and project_id in self.projects

    async def create_conversation(
        self, organization_id: str, project_id: str, created_by: str
    ) -> AgentConversation:
        row = AgentConversation(
            id=str(uuid4()), organization_id=organization_id, project_id=project_id,
            created_by=created_by, title="新对话", created_at=NOW, updated_at=NOW,
        )
        self.conversations[row.id] = row
        return row

    async def get_conversation(
        self, organization_id: str, project_id: str, conversation_id: str
    ) -> AgentConversation | None:
        row = self.conversations.get(conversation_id)
        if row and row.organization_id == organization_id and row.project_id == project_id:
            return row
        return None

    async def conversation_messages(
        self, conversation_id: str, after_sequence: int = 0
    ) -> list[AgentMessage]:
        return self.active_messages(conversation_id)[after_sequence:]

    async def timeline_events(
        self,
        organization_id: str,
        project_id: str,
        conversation_id: str,
    ) -> list[AgentTimelineEvent]:
        return sorted(
            (
                row
                for row in self.timeline.values()
                if row.organization_id == organization_id
                and row.project_id == project_id
                and row.conversation_id in {None, conversation_id}
            ),
            key=lambda row: row.sequence,
        )

    async def record_timeline_event(
        self,
        organization_id: str,
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
    ) -> AgentTimelineEvent:
        if not await self.project_exists(organization_id, project_id):
            raise LookupError("project_not_found")
        if conversation_id is not None and await self.get_conversation(
            organization_id, project_id, conversation_id
        ) is None:
            raise LookupError("conversation_not_found")
        key = (organization_id, project_id, event_key)
        existing = self.timeline.get(key)
        normalized_content = content.strip() if content and content.strip() else None
        normalized_action = dict(action or {})
        normalized_metadata = dict(metadata or {})
        if existing is not None:
            if (
                existing.kind != kind
                or existing.title != title.strip()
                or existing.conversation_id != conversation_id
            ):
                raise RuntimeError("idempotency_conflict")
            payload_changed = (
                existing.content != normalized_content
                or existing.action_json != normalized_action
                or existing.metadata_json != normalized_metadata
            )
            if existing.status != status:
                if (
                    existing.status not in {"running", "waiting"}
                    or status in {"running", "waiting"}
                ):
                    raise RuntimeError("invalid_status_transition")
                existing.status = status
            elif existing.status not in {"running", "waiting"}:
                if payload_changed:
                    raise RuntimeError("idempotency_conflict")
                return existing
            existing.content = normalized_content
            existing.action_json = normalized_action
            existing.metadata_json = normalized_metadata
            existing.updated_at = NOW + timedelta(seconds=existing.sequence)
            return existing
        sequence = 1 + max(
            (
                row.sequence
                for row in self.timeline.values()
                if row.organization_id == organization_id
                and row.project_id == project_id
            ),
            default=0,
        )
        row = AgentTimelineEvent(
            id=str(uuid4()),
            organization_id=organization_id,
            project_id=project_id,
            conversation_id=conversation_id,
            event_key=event_key,
            sequence=sequence,
            kind=kind,
            status=status,
            title=title.strip(),
            content=normalized_content,
            action_json=normalized_action,
            metadata_json=normalized_metadata,
            created_at=NOW + timedelta(seconds=sequence),
            updated_at=NOW + timedelta(seconds=sequence),
        )
        self.timeline[key] = row
        return row

    async def conversation_event_for_request(
        self, conversation_id: str, client_request_id: str
    ) -> dict[str, Any] | None:
        return self.conversation_events.get((conversation_id, client_request_id))

    async def rewind_conversation(
        self,
        organization_id: str,
        project_id: str,
        conversation_id: str,
        message_id: str,
        client_request_id: str,
    ) -> None:
        conversation = await self.get_conversation(
            organization_id, project_id, conversation_id
        )
        if conversation is None:
            raise LookupError("conversation_not_found")
        event_key = (conversation_id, client_request_id)
        existing_event = self.conversation_events.get(event_key)
        if existing_event is not None:
            if (
                existing_event["event_type"] == "rewind"
                and existing_event["target_message_id"] == message_id
            ):
                return
            raise RuntimeError("idempotency_conflict")
        if any(
            row.conversation_id == conversation_id
            and row.client_request_id == client_request_id
            for row in self.messages.values()
        ):
            raise RuntimeError("idempotency_conflict")
        target = next(
            (
                row
                for row in self.active_messages(conversation_id)
                if row.id == message_id and row.role == "user"
            ),
            None,
        )
        if target is None:
            if message_id in self.messages and self.messages[message_id].role == "user":
                raise RuntimeError("message_not_active")
            raise LookupError("message_not_found")
        if any(
            row.conversation_id == conversation_id and row.status in ACTIVE_RUN_STATUSES
            for row in self.runs.values()
        ):
            active = next(
                row for row in self.runs.values()
                if row.conversation_id == conversation_id
                and row.status in ACTIVE_RUN_STATUSES
            )
            raise RuntimeError(f"active_run:{active.id}")
        previous_leaf_id = conversation.active_message_id
        conversation.active_message_id = target.parent_message_id
        self.conversation_events[event_key] = {
            "event_type": "rewind",
            "target_message_id": target.id,
            "previous_leaf_id": previous_leaf_id,
            "new_leaf_id": target.parent_message_id,
            "business_state_unchanged": True,
        }

    async def create_message_run(
        self,
        organization_id: str,
        project_id: str,
        conversation_id: str,
        content: str,
        client_request_id: str,
        page_context: dict | None,
        limits: dict,
    ) -> tuple[AgentMessage, AgentRun]:
        conversation = await self.get_conversation(
            organization_id, project_id, conversation_id
        )
        if conversation is None:
            raise LookupError("conversation_not_found")
        event_key = (conversation_id, client_request_id)
        if event_key in self.conversation_events:
            raise RuntimeError("idempotency_conflict")
        existing = next(
            (
                row for row in self.messages.values()
                if row.conversation_id == conversation_id
                and row.client_request_id == client_request_id
            ),
            None,
        )
        if existing is not None:
            normalized_metadata = (
                {"page_context": page_context} if page_context else {}
            )
            if (
                existing.content != content.strip()
                or existing.metadata_json != normalized_metadata
            ):
                raise RuntimeError("idempotency_conflict")
            return existing, next(row for row in self.runs.values() if row.user_message_id == existing.id)
        if any(
            row.conversation_id == conversation_id and row.status in ACTIVE_RUN_STATUSES
            for row in self.runs.values()
        ):
            raise RuntimeError("active_run")
        message_id, run_id = str(uuid4()), str(uuid4())
        message = AgentMessage(
            id=message_id, conversation_id=conversation_id, run_id=run_id, role="user",
            parent_message_id=conversation.active_message_id,
            content=content, metadata_json={"page_context": page_context} if page_context else {},
            client_request_id=client_request_id, created_at=NOW,
        )
        run = AgentRun(
            id=run_id, conversation_id=conversation_id, user_message_id=message_id,
            workflow_id=f"agent:{run_id}", status="queued", current_step=0,
            model_snapshot={}, limits_json=limits, created_at=NOW, updated_at=NOW,
        )
        self.messages[message.id] = message
        self.runs[run.id] = run
        self.dispatches[run.id] = {
            "status": "pending",
            "attempts": 0,
            "next_attempt_at": NOW,
            "last_error": None,
        }
        conversation.active_message_id = message.id
        return message, run

    async def retry_system_trigger_run(
        self,
        organization_id: str,
        project_id: str,
        source_run_id: str,
        limits: dict,
    ) -> tuple[AgentMessage, AgentRun]:
        source_run = self.runs.get(source_run_id)
        conversation = (
            self.conversations.get(source_run.conversation_id)
            if source_run is not None
            else None
        )
        if (
            source_run is None
            or conversation is None
            or conversation.organization_id != organization_id
            or conversation.project_id != project_id
        ):
            raise LookupError("run_not_found")
        if source_run.status not in {"failed", "limit_reached"}:
            raise RuntimeError(f"run_not_retryable:{source_run.status}")
        source_message = self.messages[source_run.user_message_id]
        if (
            source_message.metadata_json.get("hidden_from_user") is not True
            or source_message.metadata_json.get("trusted_system_trigger") is not True
        ):
            raise RuntimeError("run_not_system_trigger")
        request_id = f"system-retry:{source_run.id}"
        existing = next(
            (
                row
                for row in self.messages.values()
                if row.conversation_id == conversation.id
                and row.client_request_id == request_id
            ),
            None,
        )
        if existing is not None:
            return existing, next(
                row for row in self.runs.values() if row.user_message_id == existing.id
            )
        if any(
            row.conversation_id == conversation.id
            and row.status in ACTIVE_RUN_STATUSES
            for row in self.runs.values()
        ):
            raise RuntimeError("active_run")
        message_id, run_id = str(uuid4()), str(uuid4())
        message = AgentMessage(
            id=message_id,
            conversation_id=conversation.id,
            run_id=run_id,
            parent_message_id=conversation.active_message_id,
            role="user",
            content=source_message.content,
            metadata_json={
                **source_message.metadata_json,
                "retry_of_run_id": source_run.id,
            },
            client_request_id=request_id,
            created_at=NOW,
        )
        run = AgentRun(
            id=run_id,
            conversation_id=conversation.id,
            user_message_id=message_id,
            workflow_id=f"agent:{run_id}",
            status="queued",
            current_step=0,
            model_snapshot={},
            limits_json=limits,
            created_at=NOW,
            updated_at=NOW,
        )
        self.messages[message.id] = message
        self.runs[run.id] = run
        self.dispatches[run.id] = {
            "status": "pending",
            "attempts": 0,
            "next_attempt_at": NOW,
            "last_error": None,
        }
        conversation.active_message_id = message.id
        return message, run

    async def edit_message_run(
        self,
        organization_id: str,
        project_id: str,
        conversation_id: str,
        message_id: str,
        content: str,
        client_request_id: str,
        limits: dict,
    ) -> tuple[AgentMessage, AgentRun]:
        conversation = await self.get_conversation(
            organization_id, project_id, conversation_id
        )
        if conversation is None:
            raise LookupError("conversation_not_found")
        event_key = (conversation_id, client_request_id)
        existing_event = self.conversation_events.get(event_key)
        if existing_event is not None:
            replacement = self.messages.get(existing_event.get("new_leaf_id"))
            if (
                existing_event["event_type"] != "edit"
                or existing_event["target_message_id"] != message_id
                or replacement is None
                or replacement.content != content.strip()
            ):
                raise RuntimeError("idempotency_conflict")
            run = next(
                row for row in self.runs.values()
                if row.user_message_id == replacement.id
            )
            return replacement, run
        if any(
            row.conversation_id == conversation_id
            and row.client_request_id == client_request_id
            for row in self.messages.values()
        ):
            raise RuntimeError("idempotency_conflict")
        target = next(
            (
                row
                for row in self.active_messages(conversation_id)
                if row.id == message_id and row.role == "user"
            ),
            None,
        )
        if target is None:
            if message_id in self.messages and self.messages[message_id].role == "user":
                raise RuntimeError("message_not_active")
            raise LookupError("message_not_found")
        if any(
            row.conversation_id == conversation_id and row.status in ACTIVE_RUN_STATUSES
            for row in self.runs.values()
        ):
            active = next(
                row for row in self.runs.values()
                if row.conversation_id == conversation_id
                and row.status in ACTIVE_RUN_STATUSES
            )
            raise RuntimeError(f"active_run:{active.id}")
        replacement_id, run_id = str(uuid4()), str(uuid4())
        replacement = AgentMessage(
            id=replacement_id,
            conversation_id=conversation_id,
            parent_message_id=target.parent_message_id,
            run_id=run_id,
            role="user",
            content=content.strip(),
            metadata_json=dict(target.metadata_json),
            client_request_id=client_request_id,
            created_at=NOW,
        )
        run = AgentRun(
            id=run_id,
            conversation_id=conversation_id,
            user_message_id=replacement_id,
            workflow_id=f"agent:{run_id}",
            status="queued",
            current_step=0,
            model_snapshot={},
            limits_json=limits,
            created_at=NOW,
            updated_at=NOW,
        )
        previous_leaf_id = conversation.active_message_id
        self.messages[replacement.id] = replacement
        self.runs[run.id] = run
        self.dispatches[run.id] = {
            "status": "pending",
            "attempts": 0,
            "next_attempt_at": NOW,
            "last_error": None,
        }
        conversation.active_message_id = replacement.id
        self.conversation_events[event_key] = {
            "event_type": "edit",
            "target_message_id": target.id,
            "previous_leaf_id": previous_leaf_id,
            "new_leaf_id": replacement.id,
            "business_state_unchanged": True,
        }
        return replacement, run

    async def latest_run_for_conversation(self, conversation_id: str) -> AgentRun | None:
        user_message = next(
            (
                row for row in reversed(self.active_messages(conversation_id))
                if row.role == "user" and row.run_id
            ),
            None,
        )
        return self.runs.get(user_message.run_id) if user_message else None

    async def action_for_run(self, run_id: str) -> AgentAction | None:
        return next((row for row in self.actions.values() if row.run_id == run_id), None)

    async def get_action_scoped(
        self, organization_id: str, project_id: str, action_id: str
    ) -> AgentAction | None:
        action = self.actions.get(action_id)
        run = self.runs.get(action.run_id) if action else None
        conversation = self.conversations.get(run.conversation_id) if run else None
        if (
            action and conversation and conversation.organization_id == organization_id
            and conversation.project_id == project_id
        ):
            return action
        return None

    async def run_steps(self, run_id: str) -> list[Any]:
        return self.steps.get(run_id, [])

    async def get_run_scoped(
        self, organization_id: str, project_id: str, run_id: str
    ) -> AgentRun | None:
        run = self.runs.get(run_id)
        conversation = self.conversations.get(run.conversation_id) if run else None
        if (
            run and conversation and conversation.organization_id == organization_id
            and conversation.project_id == project_id
        ):
            return run
        return None

    async def get_run(self, run_id: str) -> AgentRun | None:
        return self.runs.get(run_id)

    async def has_step(self, run_id: str, step_type: str, name: str) -> bool:
        return False

    async def add_step(self, run_id: str, *args: Any, **kwargs: Any) -> None:
        self.runs[run_id].current_step += 1

    async def set_run_status(
        self, run_id: str, status: str, **kwargs: Any
    ) -> None:
        self.runs[run_id].status = status

    async def cancel_run(self, run_id: str) -> None:
        run = self.runs[run_id]
        run.status = "cancelled"
        dispatch = self.dispatches.get(run_id)
        if dispatch is not None and dispatch["status"] == "pending":
            dispatch["status"] = "cancelled"
        conversation = self.conversations[run.conversation_id]
        message = AgentMessage(
            id=str(uuid4()),
            conversation_id=run.conversation_id,
            parent_message_id=conversation.active_message_id,
            run_id=run.id,
            role="assistant",
            content="已停止本次任务，没有开始新的操作。",
            metadata_json={"cancelled": True},
            created_at=NOW,
        )
        self.messages[message.id] = message
        conversation.active_message_id = message.id

    async def decide_action(
        self,
        organization_id: str,
        project_id: str,
        action_id: str,
        decision: str,
        parameters_hash: str | None = None,
        decided_by: str = "local-user",
    ) -> AgentAction:
        action = self.actions.get(action_id)
        run = self.runs.get(action.run_id) if action else None
        conversation = self.conversations.get(run.conversation_id) if run else None
        if not action or not conversation or conversation.project_id != project_id:
            raise LookupError("action_not_found")
        if parameters_hash and parameters_hash != action.parameters_hash:
            raise RuntimeError("hash_conflict")
        action.status = decision
        action.decided_by = decided_by
        action.decision_at = NOW
        return action

    async def queued_runs(self) -> list[AgentRun]:
        return []

    async def list_pending_dispatches(self, limit: int = 20) -> list[AgentRun]:
        return [
            self.runs[run_id]
            for run_id, dispatch in self.dispatches.items()
            if dispatch["status"] == "pending"
            and dispatch["next_attempt_at"] <= NOW
        ][:limit]

    @asynccontextmanager
    async def pending_dispatch(self, run_id: str):
        run = self.runs.get(run_id)
        dispatch = self.dispatches.get(run_id)
        if (
            run is None
            or run.status != "queued"
            or dispatch is None
            or dispatch["status"] != "pending"
            or dispatch["next_attempt_at"] > NOW
        ):
            yield None
            return
        try:
            yield run
        except Exception:
            dispatch["attempts"] += 1
            dispatch["last_error"] = (
                "Agent 服务暂时不可用，任务已保存并会自动重试"
            )
            dispatch["next_attempt_at"] = NOW + timedelta(
                seconds=min(60, 2 ** min(dispatch["attempts"], 6))
            )
            raise
        else:
            dispatch["status"] = "dispatched"
            dispatch["last_error"] = None

    async def record_dispatch_failure(self, run_id: str, message: str) -> None:
        dispatch = self.dispatches[run_id]
        if dispatch["status"] != "pending":
            return
        dispatch["attempts"] += 1
        dispatch["last_error"] = message
        dispatch["next_attempt_at"] = NOW + timedelta(
            seconds=min(60, 2 ** min(dispatch["attempts"], 6))
        )

    async def active_runs(self) -> list[AgentRun]:
        return [
            run for run in self.runs.values() if run.status in ACTIVE_RUN_STATUSES
        ]

    async def completion_evidence(self, run_id: str) -> dict[str, Any]:
        return self.completion_by_run.get(run_id, {})

    async def finalize_run(
        self,
        run_id: str,
        content: str,
        metadata: dict,
        status: str,
        error_code: str | None = None,
        error_message: str | None = None,
        message_id: str | None = None,
    ) -> None:
        self.finalized = (
            run_id,
            content,
            metadata,
            status,
            error_code,
            error_message,
            message_id,
        )
        run = self.runs[run_id]
        run.status = status
        run.error_code = error_code
        run.error_message = error_message


def build_service() -> tuple[AgentService, FakeRepository, FakeController]:
    repository = FakeRepository()
    controller = FakeController()
    service = AgentService(
        Settings(default_organization_id="test-org", agent_actor_id="test-user"),
        repository,
        controller,
    )
    return service, repository, controller


def test_agent_limits_include_model_output_token_cap() -> None:
    service, _, _ = build_service()

    assert service.limits["max_output_tokens"] == 4_000


@pytest.mark.parametrize("workflow_id", [None, "agent:run-1:resume:attempt-2"])
def test_temporal_agent_workflow_uses_extended_task_timeout(
    monkeypatch: pytest.MonkeyPatch, workflow_id,
) -> None:
    captured: dict[str, Any] = {}

    class FakeTemporalClient:
        async def start_workflow(self, *args: Any, **kwargs: Any) -> None:
            captured["args"] = args
            captured.update(kwargs)

    async def connect() -> FakeTemporalClient:
        return FakeTemporalClient()

    monkeypatch.setattr(agent_service, "connect_temporal", connect)
    service, _, _ = build_service()

    asyncio.run(TemporalAgentController("agent-ai").start(
        "run-1", service.limits, workflow_id=workflow_id,
    ))

    assert captured["id"] == (workflow_id or "agent:run-1")
    assert captured["task_queue"] == "agent-ai"
    assert captured["task_timeout"] == timedelta(seconds=30)


def test_timeline_events_are_idempotent_ordered_and_scoped() -> None:
    service, repository, _ = build_service()
    first = asyncio.run(service.create_conversation("project-a"))
    second = asyncio.run(service.create_conversation("project-a"))
    other_project = asyncio.run(service.create_conversation("project-b"))

    project_event = asyncio.run(service.record_timeline_event(
        "project-a",
        event_key="foundation:project",
        kind="message",
        status="completed",
        title="项目级事件",
    ))
    repeated = asyncio.run(service.record_timeline_event(
        "project-a",
        event_key="foundation:project",
        kind="message",
        status="completed",
        title="项目级事件",
    ))
    first_event = asyncio.run(service.record_timeline_event(
        "project-a",
        conversation_id=first.id,
        event_key="foundation:first",
        kind="task",
        status="running",
        title="第一个对话事件",
    ))
    second_event = asyncio.run(service.record_timeline_event(
        "project-a",
        conversation_id=second.id,
        event_key="foundation:second",
        kind="action",
        status="completed",
        title="第二个对话事件",
        action={"label": "查看", "href": "/projects/project-a"},
    ))
    other_event = asyncio.run(service.record_timeline_event(
        "project-b",
        conversation_id=other_project.id,
        event_key="foundation:other-project",
        kind="task",
        status="completed",
        title="其他项目事件",
    ))

    first_snapshot = asyncio.run(service.get_conversation("project-a", first.id))
    refreshed_snapshot = asyncio.run(service.get_conversation("project-a", first.id))
    second_snapshot = asyncio.run(service.get_conversation("project-a", second.id))

    assert repeated.id == project_event.id
    assert len(repository.timeline) == 4
    assert [project_event.sequence, first_event.sequence, second_event.sequence] == [1, 2, 3]
    assert other_event.sequence == 1
    assert [event.event_key for event in first_snapshot.timeline] == [
        "foundation:project",
        "foundation:first",
    ]
    assert refreshed_snapshot.timeline == first_snapshot.timeline
    assert [event.event_key for event in second_snapshot.timeline] == [
        "foundation:project",
        "foundation:second",
    ]


@pytest.mark.parametrize("terminal_status", ["completed", "failed"])
def test_running_timeline_event_converges_once_to_a_terminal_fact(
    terminal_status: str,
) -> None:
    service, _, _ = build_service()
    conversation = asyncio.run(service.create_conversation("project-a"))
    running = asyncio.run(service.record_timeline_event(
        "project-a",
        conversation_id=conversation.id,
        event_key=f"foundation:{terminal_status}",
        kind="task",
        status="running",
        title="通用任务",
        content="处理中",
        metadata={"attempt": 1},
    ))
    terminal = asyncio.run(service.record_timeline_event(
        "project-a",
        conversation_id=conversation.id,
        event_key=f"foundation:{terminal_status}",
        kind="task",
        status=terminal_status,
        title="通用任务",
        content="处理结束",
        metadata={"attempt": 1},
    ))
    repeated = asyncio.run(service.record_timeline_event(
        "project-a",
        conversation_id=conversation.id,
        event_key=f"foundation:{terminal_status}",
        kind="task",
        status=terminal_status,
        title="通用任务",
        content="处理结束",
        metadata={"attempt": 1},
    ))

    assert terminal.id == running.id == repeated.id
    assert terminal.sequence == running.sequence
    assert terminal.status == terminal_status
    assert terminal.content == "处理结束"

    with pytest.raises(AgentConflictError):
        asyncio.run(service.record_timeline_event(
            "project-a",
            conversation_id=conversation.id,
            event_key=f"foundation:{terminal_status}",
            kind="task",
            status=terminal_status,
            title="通用任务",
            content="改写终态事实",
            metadata={"attempt": 2},
        ))
    with pytest.raises(AgentConflictError):
        asyncio.run(service.record_timeline_event(
            "project-a",
            conversation_id=conversation.id,
            event_key=f"foundation:{terminal_status}",
            kind="task",
            status="cancelled" if terminal_status != "cancelled" else "failed",
            title="通用任务",
            content="处理结束",
            metadata={"attempt": 1},
        ))


def test_waiting_timeline_action_completes_and_clears_the_action() -> None:
    service, _, _ = build_service()
    conversation = asyncio.run(service.create_conversation("project-a"))
    waiting = asyncio.run(service.record_timeline_event(
        "project-a",
        conversation_id=conversation.id,
        event_key="onboarding:business-confirmation",
        kind="action",
        status="waiting",
        title="确认业务资料",
        content="请确认业务资料。",
        action={"label": "确认业务资料", "href": "/projects/project-a/settings/business"},
    ))
    completed = asyncio.run(service.record_timeline_event(
        "project-a",
        conversation_id=conversation.id,
        event_key="onboarding:business-confirmation",
        kind="action",
        status="completed",
        title="确认业务资料",
        content="业务资料已确认。",
        action={},
    ))

    assert completed.id == waiting.id
    assert completed.status == "completed"
    assert completed.action == {}


async def request_scenario() -> dict[str, Any]:
    service, repository, controller = build_service()
    app.dependency_overrides[get_agent_service] = lambda: service
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            created = await client.post("/api/v1/projects/project-a/agent/conversations")
            conversation_id = created.json()["id"]
            body = {"content": "检查最近审核", "client_request_id": "request-1"}
            first = await client.post(
                f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/messages",
                json=body,
            )
            repeated = await client.post(
                f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/messages",
                json=body,
            )
            run_id = first.json()["run_id"]
            cross_conversation = await client.get(
                f"/api/v1/projects/project-b/agent/conversations/{conversation_id}"
            )
            cross_run = await client.get(
                f"/api/v1/projects/project-b/agent/runs/{run_id}"
            )
            action = AgentAction(
                id=str(uuid4()), run_id=run_id, tool_name="update_business_profile",
                status="pending", arguments_json={"changes": {"business_name": "New"}},
                before_json={"business_name": "Old"}, preview_json={"title": "修改资料"},
                parameters_hash="a" * 64, idempotency_key="operation-1",
                expires_at=NOW + timedelta(hours=24), result_json={}, created_at=NOW,
                updated_at=NOW,
            )
            repository.actions[action.id] = action
            cross_action = await client.post(
                f"/api/v1/projects/project-b/agent/actions/{action.id}/approve",
                json={"parameters_hash": "a" * 64},
            )
            hash_conflict = await client.post(
                f"/api/v1/projects/project-a/agent/actions/{action.id}/approve",
                json={"parameters_hash": "b" * 64},
            )
            cancelled = await client.post(
                f"/api/v1/projects/project-a/agent/runs/{run_id}/cancel"
            )
            return {
                "created": created,
                "first": first,
                "repeated": repeated,
                "cross_conversation": cross_conversation,
                "cross_run": cross_run,
                "cross_action": cross_action,
                "hash_conflict": hash_conflict,
                "cancelled": cancelled,
                "repository": repository,
                "controller": controller,
            }
    finally:
        app.dependency_overrides.clear()


def test_agent_api_is_idempotent_scoped_and_cancellable() -> None:
    result = asyncio.run(request_scenario())

    assert result["created"].status_code == 201
    assert result["first"].status_code == 202
    assert result["repeated"].status_code == 202
    assert result["first"].json() == result["repeated"].json()
    assert len(result["repository"].runs) == 1
    assert result["cross_conversation"].status_code == 404
    assert result["cross_run"].status_code == 404
    assert result["cross_action"].status_code == 404
    assert result["hash_conflict"].status_code == 409
    assert "历史审批记录仅供查看" in result["hash_conflict"].json()["detail"]
    assert result["cancelled"].json()["status"] == "cancelled"
    assert len(result["controller"].cancelled) == 1


def test_edit_is_atomic_idempotent_scoped_and_keeps_page_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> dict[str, Any]:
        service, repository, controller = build_service()
        monkeypatch.setattr(
            agent_service, "build_agent_event_store", lambda: NoopEventStore()
        )
        app.dependency_overrides[get_agent_service] = lambda: service
        transport = ASGITransport(app=app)
        try:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                created = await client.post(
                    "/api/v1/projects/project-a/agent/conversations"
                )
                conversation_id = created.json()["id"]
                sent = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/messages",
                    json={
                        "content": "检查当前页面",
                        "client_request_id": "send-edit-1",
                        "page_context": {"module": "audit", "view": "issues"},
                    },
                )
                original_message_id = sent.json()["message_id"]
                edit_body = {
                    "message_id": original_message_id,
                    "content": "检查当前页面的严重问题",
                    "client_request_id": "edit-1",
                }
                edited = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/edit",
                    json=edit_body,
                )
                repeated = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/edit",
                    json=edit_body,
                )
                changed_reuse = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/edit",
                    json={**edit_body, "content": "复用编号但修改内容"},
                )
                cross_project = await client.post(
                    f"/api/v1/projects/project-b/agent/conversations/{conversation_id}/edit",
                    json={**edit_body, "client_request_id": "edit-cross-project"},
                )
                stale = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/edit",
                    json={
                        **edit_body,
                        "content": "第二个并发编辑",
                        "client_request_id": "edit-stale",
                    },
                )
                return {
                    "edited": edited,
                    "repeated": repeated,
                    "changed_reuse": changed_reuse,
                    "cross_project": cross_project,
                    "stale": stale,
                    "original_message_id": original_message_id,
                    "repository": repository,
                    "controller": controller,
                }
        finally:
            app.dependency_overrides.clear()

    result = asyncio.run(scenario())

    assert result["edited"].status_code == 202
    assert result["edited"].json() == result["repeated"].json()
    assert result["changed_reuse"].status_code == 409
    assert "请求编号" in result["changed_reuse"].json()["detail"]
    assert result["cross_project"].status_code == 404
    assert result["stale"].status_code == 409
    assert "已被编辑或撤销" in result["stale"].json()["detail"]
    assert len(result["repository"].runs) == 2
    replacement = result["repository"].messages[
        result["edited"].json()["message_id"]
    ]
    original = result["repository"].messages[result["original_message_id"]]
    assert replacement.parent_message_id == original.parent_message_id
    assert replacement.metadata_json["page_context"] == {
        "module": "audit",
        "view": "issues",
    }
    assert result["controller"].cancelled == [f"agent:{original.run_id}"]


def test_edit_does_not_switch_branch_until_workflow_is_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> dict[str, Any]:
        service, repository, controller = build_service()
        controller.close_on_cancel = False
        monkeypatch.setattr(agent_service, "STOP_WAIT_SECONDS", 0.0)
        monkeypatch.setattr(
            agent_service, "build_agent_event_store", lambda: NoopEventStore()
        )
        app.dependency_overrides[get_agent_service] = lambda: service
        transport = ASGITransport(app=app)
        try:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                created = await client.post(
                    "/api/v1/projects/project-a/agent/conversations"
                )
                conversation_id = created.json()["id"]
                sent = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/messages",
                    json={
                        "content": "检查网站",
                        "client_request_id": "send-timeout",
                    },
                )
                response = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/edit",
                    json={
                        "message_id": sent.json()["message_id"],
                        "content": "检查整个网站",
                        "client_request_id": "edit-timeout",
                    },
                )
                repeated = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/edit",
                    json={
                        "message_id": sent.json()["message_id"],
                        "content": "检查整个网站",
                        "client_request_id": "edit-timeout",
                    },
                )
                return {
                    "response": response,
                    "repeated": repeated,
                    "repository": repository,
                    "conversation_id": conversation_id,
                }
        finally:
            app.dependency_overrides.clear()

    result = asyncio.run(scenario())

    assert result["response"].status_code == 409
    assert "仍在停止" in result["response"].json()["detail"]
    assert result["repeated"].status_code == 409
    assert "仍在停止" in result["repeated"].json()["detail"]
    assert len(result["repository"].runs) == 1
    assert not result["repository"].conversation_events
    active = result["repository"].active_messages(result["conversation_id"])
    assert [message.role for message in active] == ["user", "assistant"]
    assert active[-1].metadata_json["cancelled"] is True


def test_rewind_does_not_switch_branch_until_workflow_is_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> dict[str, Any]:
        service, repository, controller = build_service()
        controller.close_on_cancel = False
        monkeypatch.setattr(agent_service, "STOP_WAIT_SECONDS", 0.0)
        monkeypatch.setattr(
            agent_service, "build_agent_event_store", lambda: NoopEventStore()
        )
        app.dependency_overrides[get_agent_service] = lambda: service
        transport = ASGITransport(app=app)
        try:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                created = await client.post(
                    "/api/v1/projects/project-a/agent/conversations"
                )
                conversation_id = created.json()["id"]
                sent = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/messages",
                    json={
                        "content": "检查网站",
                        "client_request_id": "send-rewind-timeout",
                    },
                )
                body = {
                    "message_id": sent.json()["message_id"],
                    "client_request_id": "rewind-timeout",
                }
                response = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/rewind",
                    json=body,
                )
                repeated = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/rewind",
                    json=body,
                )
                return {
                    "response": response,
                    "repeated": repeated,
                    "repository": repository,
                    "conversation_id": conversation_id,
                }
        finally:
            app.dependency_overrides.clear()

    result = asyncio.run(scenario())

    assert result["response"].status_code == 409
    assert "仍在停止" in result["response"].json()["detail"]
    assert result["repeated"].status_code == 409
    assert "仍在停止" in result["repeated"].json()["detail"]
    assert not result["repository"].conversation_events
    active = result["repository"].active_messages(result["conversation_id"])
    assert [message.role for message in active] == ["user", "assistant"]
    assert active[-1].metadata_json["cancelled"] is True


def test_rewind_switches_the_active_branch_without_deleting_history() -> None:
    async def scenario() -> dict[str, Any]:
        service, repository, _controller = build_service()
        app.dependency_overrides[get_agent_service] = lambda: service
        transport = ASGITransport(app=app)
        try:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                created = await client.post(
                    "/api/v1/projects/project-a/agent/conversations"
                )
                conversation_id = created.json()["id"]
                sent = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/messages",
                    json={
                        "content": "第一条消息",
                        "client_request_id": "send-rewind",
                    },
                )
                repository.runs[sent.json()["run_id"]].status = "completed"
                rewind_body = {
                    "message_id": sent.json()["message_id"],
                    "client_request_id": "rewind-1",
                }
                rewound = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/rewind",
                    json=rewind_body,
                )
                repeated = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/rewind",
                    json=rewind_body,
                )
                stale = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/rewind",
                    json={**rewind_body, "client_request_id": "rewind-stale"},
                )
                return {
                    "rewound": rewound,
                    "repeated": repeated,
                    "stale": stale,
                    "repository": repository,
                    "message_id": sent.json()["message_id"],
                    "run_id": sent.json()["run_id"],
                }
        finally:
            app.dependency_overrides.clear()

    result = asyncio.run(scenario())

    assert result["rewound"].status_code == 200
    assert result["rewound"].json()["messages"] == []
    assert result["repeated"].status_code == 200
    assert result["stale"].status_code == 409
    assert result["message_id"] in result["repository"].messages
    assert result["run_id"] in result["repository"].runs
    event = result["repository"].conversation_events[
        (result["repository"].runs[result["run_id"]].conversation_id, "rewind-1")
    ]
    assert event["business_state_unchanged"] is True


def test_request_ids_cannot_be_reused_for_a_different_operation() -> None:
    async def scenario() -> dict[str, Any]:
        service, repository, _controller = build_service()
        app.dependency_overrides[get_agent_service] = lambda: service
        transport = ASGITransport(app=app)
        try:
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                created = await client.post(
                    "/api/v1/projects/project-a/agent/conversations"
                )
                conversation_id = created.json()["id"]
                sent = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/messages",
                    json={"content": "原问题", "client_request_id": "shared-send"},
                )
                repository.runs[sent.json()["run_id"]].status = "completed"
                changed_send = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/messages",
                    json={"content": "不同问题", "client_request_id": "shared-send"},
                )
                edit_with_send_id = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/edit",
                    json={
                        "message_id": sent.json()["message_id"],
                        "content": "编辑后的问题",
                        "client_request_id": "shared-send",
                    },
                )
                rewound = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/rewind",
                    json={
                        "message_id": sent.json()["message_id"],
                        "client_request_id": "shared-rewind",
                    },
                )
                send_with_rewind_id = await client.post(
                    f"/api/v1/projects/project-a/agent/conversations/{conversation_id}/messages",
                    json={
                        "content": "撤销后的新问题",
                        "client_request_id": "shared-rewind",
                    },
                )
                return {
                    "changed_send": changed_send,
                    "edit_with_send_id": edit_with_send_id,
                    "rewound": rewound,
                    "send_with_rewind_id": send_with_rewind_id,
                }
        finally:
            app.dependency_overrides.clear()

    result = asyncio.run(scenario())

    assert result["changed_send"].status_code == 409
    assert result["edit_with_send_id"].status_code == 409
    assert result["rewound"].status_code == 200
    assert result["send_with_rewind_id"].status_code == 409
    assert "请求编号" in result["changed_send"].json()["detail"]
    assert "请求编号" in result["edit_with_send_id"].json()["detail"]
    assert "请求编号" in result["send_with_rewind_id"].json()["detail"]


def test_cancel_closes_active_message_turn_and_agent_in_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, repository, controller = build_service()
    conversation = asyncio.run(service.create_conversation("project-a"))
    response = asyncio.run(service.send_message(
        "project-a",
        conversation.id,
        SendMessageRequest(content="检查网站", client_request_id="request-cancel"),
    ))
    repository.runs[response.run_id].status = "running"

    class EventStore:
        def __init__(self) -> None:
            self.events: list[tuple[str, dict[str, Any]]] = []

        async def active_message(
            self, conversation_id: str, run_id: str
        ) -> dict[str, Any]:
            return {
                "round": 2,
                "message_id": "message-decision",
                "part_id": "message-decision:assistant",
                "phase": "decision",
                "attempt": 1,
            }

        async def active_turn(
            self, conversation_id: str, run_id: str
        ) -> int:
            return 2

        async def publish(
            self, conversation_id: str, event_type: str, payload: dict[str, Any]
        ) -> str:
            self.events.append((event_type, payload))
            return f"{len(self.events)}-0"

        async def close_message(
            self, conversation_id: str, payload: dict[str, Any]
        ) -> str:
            return await self.publish(conversation_id, "message_end", payload)

    store = EventStore()
    monkeypatch.setattr(agent_service, "build_agent_event_store", lambda: store)

    result = asyncio.run(service.cancel("project-a", response.run_id))

    assert result.status == "cancelled"
    assert [event[0] for event in store.events] == [
        "message_end", "turn_end", "agent_end",
    ]
    assert store.events[0][1]["status"] == "cancelled"
    assert store.events[0][1]["message_id"] == "message-decision"
    assert store.events[1][1]["round"] == 2
    assert store.events[2][1]["status"] == "cancelled"
    assert controller.cancelled == [f"agent:{response.run_id}"]


def test_cancel_keeps_database_state_when_temporal_cancel_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, repository, controller = build_service()
    conversation = asyncio.run(service.create_conversation("project-a"))
    response = asyncio.run(service.send_message(
        "project-a",
        conversation.id,
        SendMessageRequest(content="检查网站", client_request_id="request-failure"),
    ))
    repository.runs[response.run_id].status = "executing"

    class FailingEventStore:
        async def active_message(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def active_turn(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def publish(self, *args: Any, **kwargs: Any) -> None:
            return None

    async def fail_cancel(workflow_id: str) -> None:
        controller.cancelled.append(workflow_id)
        raise ConnectionError("Temporal unavailable")

    controller.cancel = fail_cancel  # type: ignore[method-assign]
    monkeypatch.setattr(
        agent_service, "build_agent_event_store", lambda: FailingEventStore()
    )

    result = asyncio.run(service.cancel("project-a", response.run_id))

    assert result.status == "cancelled"
    assert repository.runs[response.run_id].status == "cancelled"
    assert controller.cancelled == [f"agent:{response.run_id}"]


def test_closed_workflow_is_reconciled_to_a_visible_failure() -> None:
    service, repository, controller = build_service()
    conversation = asyncio.run(service.create_conversation("project-a"))
    response = asyncio.run(
        service.send_message(
            "project-a",
            conversation.id,
            SendMessageRequest(content="检查网站", client_request_id="request-closed"),
        )
    )
    repository.runs[response.run_id].status = "running"
    repository.completion_by_run[response.run_id] = {
        "tool_evidence": [
            {
                "tool": "get_project_profile",
                "execution_status": "completed",
                "summary": "internal project payload",
            },
            {
                "tool": "get_latest_audit",
                "execution_status": "failed",
                "summary": "database password leaked here",
            },
        ]
    }
    controller.workflow_state = AgentWorkflowState.CLOSED

    reconciled = asyncio.run(service.reconcile_active_runs())

    run = repository.runs[response.run_id]
    assert reconciled == 1
    assert run.status == "failed"
    assert run.error_code == "agent_workflow_closed"
    assert repository.finalized is not None
    content = repository.finalized[1]
    metadata = repository.finalized[2]
    assert "**已完成**" in content
    assert "- 项目资料已读取" in content
    assert "**停在**" in content
    assert "- 技术审核读取未完成" in content
    assert "**下一步**" in content
    assert "database password" not in content
    assert metadata == {
        "reconciled": True,
        "business_progress": [
            {
                "tool": "get_project_profile",
                "label": "项目资料已读取",
                "status": "completed",
            },
            {
                "tool": "get_latest_audit",
                "label": "技术审核读取未完成",
                "status": "failed",
            },
        ],
        "display_parts": [
            {
                "type": "tool",
                "tool": "get_project_profile",
                "label": "项目资料已读取",
                "status": "completed",
            },
            {
                "type": "tool",
                "tool": "get_latest_audit",
                "label": "技术审核读取未完成",
                "status": "failed",
            },
            {"type": "text", "text": content},
        ],
    }


def test_transient_closed_workflow_is_not_reconciled_when_second_check_is_running() -> None:
    service, repository, controller = build_service()
    conversation = asyncio.run(service.create_conversation("project-a"))
    response = asyncio.run(service.send_message(
        "project-a",
        conversation.id,
        SendMessageRequest(
            content="检查网站",
            client_request_id="request-transient-closed",
        ),
    ))
    repository.runs[response.run_id].status = "running"
    states = iter([AgentWorkflowState.CLOSED, AgentWorkflowState.RUNNING])

    async def status(_: str) -> AgentWorkflowState:
        return next(states)

    controller.status = status  # type: ignore[method-assign]

    reconciled = asyncio.run(service.reconcile_active_runs())

    assert reconciled == 0
    assert repository.runs[response.run_id].status == "running"
    assert repository.finalized is None


def test_unknown_workflow_state_is_not_reconciled() -> None:
    service, repository, controller = build_service()
    conversation = asyncio.run(service.create_conversation("project-a"))
    response = asyncio.run(service.send_message(
        "project-a",
        conversation.id,
        SendMessageRequest(
            content="检查网站",
            client_request_id="request-unknown-state",
        ),
    ))
    repository.runs[response.run_id].status = "running"
    controller.workflow_state = AgentWorkflowState.UNKNOWN

    reconciled = asyncio.run(service.reconcile_active_runs())

    assert reconciled == 0
    assert repository.runs[response.run_id].status == "running"
    assert repository.finalized is None


def test_closed_workflow_without_business_progress_uses_structured_fallback() -> None:
    service, repository, controller = build_service()
    conversation = asyncio.run(service.create_conversation("project-a"))
    response = asyncio.run(
        service.send_message(
            "project-a",
            conversation.id,
            SendMessageRequest(
                content="检查网站",
                client_request_id="request-closed-no-progress",
            ),
        )
    )
    repository.runs[response.run_id].status = "running"
    controller.workflow_state = AgentWorkflowState.CLOSED

    reconciled = asyncio.run(service.reconcile_active_runs())

    assert reconciled == 1
    assert repository.finalized is not None
    content = repository.finalized[1]
    metadata = repository.finalized[2]
    assert content.startswith("本次任务没有完成，尚未产生可确认的业务结果。")
    assert "**停在**" in content
    assert "回答整理中断" in content
    assert "Agent 工作流已经结束" not in content
    assert "数据库没有保存正常终态" not in content
    assert "**下一步**" in content
    assert metadata == {
        "reconciled": True,
        "display_parts": [{"type": "text", "text": content}],
    }


def test_failed_system_trigger_retry_preserves_permissions_and_is_idempotent() -> None:
    service, repository, controller = build_service()
    conversation = asyncio.run(service.create_conversation("project-a"))
    source_message, source_run = asyncio.run(repository.create_message_run(
        "test-org",
        "project-a",
        conversation.id,
        "Start the approved onboarding work.",
        "system:business-profile:profile-v1",
        None,
        service.limits,
    ))
    source_message.metadata_json = {
        "hidden_from_user": True,
        "trusted_system_trigger": True,
        "system_trigger": "business_profile_confirmed",
        "trusted_write_tools": [
            "start_technical_audit",
            "start_keyword_library",
        ],
    }
    source_run.status = "failed"

    first = asyncio.run(service.retry_system_trigger("project-a", source_run.id))
    repeated = asyncio.run(service.retry_system_trigger("project-a", source_run.id))

    assert first.run_id == repeated.run_id
    assert first.message_id == repeated.message_id
    assert first.run_id != source_run.id
    retried_message = repository.messages[first.message_id]
    assert retried_message.content == source_message.content
    assert retried_message.metadata_json == {
        **source_message.metadata_json,
        "retry_of_run_id": source_run.id,
    }
    assert retried_message.client_request_id == f"system-retry:{source_run.id}"
    assert controller.started == [first.run_id]
    assert len(repository.runs) == 2


def test_failed_user_message_cannot_use_system_trigger_retry() -> None:
    service, repository, _ = build_service()
    conversation = asyncio.run(service.create_conversation("project-a"))
    response = asyncio.run(service.send_message(
        "project-a",
        conversation.id,
        SendMessageRequest(
            content="检查网站",
            client_request_id="ordinary-failed-run",
        ),
    ))
    repository.runs[response.run_id].status = "failed"

    with pytest.raises(AgentConflictError, match="不是可重试的系统任务"):
        asyncio.run(service.retry_system_trigger("project-a", response.run_id))


def test_failed_immediate_dispatch_is_persisted_and_retried() -> None:
    service, repository, controller = build_service()
    conversation = asyncio.run(service.create_conversation("project-a"))
    controller.fail_start_for.add("pending")

    original_start = controller.start

    async def fail_first_start(run_id: str, limits: dict[str, int], *, workflow_id: str | None = None) -> None:
        controller.fail_start_for.add(run_id)
        await original_start(run_id, limits, workflow_id=workflow_id)

    controller.start = fail_first_start  # type: ignore[method-assign]
    with pytest.raises(Exception, match="Agent 服务暂时不可用"):
        asyncio.run(
            service.send_message(
                "project-a",
                conversation.id,
                SendMessageRequest(content="检查网站", client_request_id="dispatch-fail"),
            )
        )

    run_id = next(iter(repository.runs))
    dispatch = repository.dispatches[run_id]
    assert dispatch["status"] == "pending"
    assert dispatch["attempts"] == 1
    assert dispatch["last_error"]

    controller.start = original_start  # type: ignore[method-assign]
    controller.fail_start_for.clear()
    dispatch["next_attempt_at"] = NOW

    assert asyncio.run(service.dispatch_queued()) == 1
    assert dispatch["status"] == "dispatched"


def test_one_dispatch_failure_does_not_block_later_pending_runs() -> None:
    service, repository, controller = build_service()
    first_conversation = asyncio.run(service.create_conversation("project-a"))
    second_conversation = asyncio.run(service.create_conversation("project-b"))
    _, first_run = asyncio.run(repository.create_message_run(
        "test-org", "project-a", first_conversation.id, "first", "dispatch-1", None,
        service.limits,
    ))
    _, second_run = asyncio.run(repository.create_message_run(
        "test-org", "project-b", second_conversation.id, "second", "dispatch-2", None,
        service.limits,
    ))
    controller.fail_start_for.add(first_run.id)

    assert asyncio.run(service.dispatch_queued()) == 1
    assert repository.dispatches[first_run.id]["attempts"] == 1
    assert repository.dispatches[second_run.id]["status"] == "dispatched"


def test_cancelled_pending_dispatch_is_not_started_or_counted() -> None:
    service, repository, controller = build_service()
    conversation = asyncio.run(service.create_conversation("project-a"))
    _, run = asyncio.run(repository.create_message_run(
        "test-org", "project-a", conversation.id, "cancel me", "dispatch-cancel",
        None, service.limits,
    ))
    asyncio.run(repository.cancel_run(run.id))

    assert asyncio.run(service.dispatch_queued()) == 0
    assert controller.started == []
    assert repository.dispatches[run.id]["status"] == "cancelled"


def test_conversation_event_stream_emits_live_events_without_secrets() -> None:
    class ConnectedRequest:
        async def is_disconnected(self) -> bool:
            return False

    class EventService:
        async def get_conversation(
            self, project_id: str, conversation_id: str
        ) -> AgentConversationDetail:
            step = AgentRunStepResponse(
                sequence=1,
                step_type="tool",
                name="get_project_profile",
                label="读取项目资料",
                summary="api_key=secret-value",
                status="completed",
                input={"authorization": "Bearer private-token"},
                output={"accessToken": "secret-access-token"},
                duration_ms=12,
                error_code=None,
                error_message=None,
                input_tokens=None,
                output_tokens=None,
                total_tokens=None,
                cost=None,
                cost_currency=None,
                created_at=NOW,
                finished_at=NOW,
            )
            run = AgentRunResponse(
                id="run-event",
                conversation_id=conversation_id,
                status="cancelled",
                current_step=1,
                error_code="user_cancelled",
                error_message="Authorization: Bearer private-token",
                steps=[step],
                created_at=NOW,
                updated_at=NOW,
            )
            return AgentConversationDetail(
                conversation=AgentConversationResponse(
                    id=conversation_id,
                    project_id=project_id,
                    title="Live events",
                    created_at=NOW,
                    updated_at=NOW,
                ),
                messages=[
                    AgentMessageResponse(
                        id="message-user",
                        run_id="run-event",
                        role="user",
                        content="api_key=secret-value",
                        metadata={"accessToken": "secret-access-token"},
                        sequence=1,
                        created_at=NOW,
                    ),
                    AgentMessageResponse(
                        id="message-assistant",
                        run_id="run-event",
                        role="assistant",
                        content="Task stopped",
                        metadata={"authorization": "Bearer private-token"},
                        sequence=2,
                        created_at=NOW,
                    ),
                ],
                run=run,
                action=None,
            )

    async def collect_events() -> list[str]:
        stream = conversation_event_stream(
            ConnectedRequest(),  # type: ignore[arg-type]
            EventService(),  # type: ignore[arg-type]
            "project-a",
            "conversation-event",
        )
        events: list[str] = []
        try:
            async for event in stream:
                events.append(event)
                if len(events) == 6:
                    break
        finally:
            await stream.aclose()
        return events

    events = asyncio.run(collect_events())
    payload = "".join(events)

    assert [event.splitlines()[0] for event in events] == [
        "event: snapshot",
        "event: run_status",
        "event: step",
        "event: message",
        "event: message",
        "event: cancelled",
    ]
    assert "secret-value" not in payload
    assert "secret-access-token" not in payload
    assert "private-token" not in payload
    assert "[REDACTED]" in payload


class StreamRequest:
    def __init__(self, last_event_id: str = "") -> None:
        self.headers = {"last-event-id": last_event_id} if last_event_id else {}

    async def is_disconnected(self) -> bool:
        return False


def active_stream_detail(
    project_id: str = "project-a",
    conversation_id: str = "conversation-stream",
    status: str = "verifying",
) -> AgentConversationDetail:
    run = AgentRunResponse(
        id="run-stream",
        conversation_id=conversation_id,
        status=status,
        current_step=0,
        error_code=None,
        error_message=None,
        steps=[],
        created_at=NOW,
        updated_at=NOW,
    )
    return AgentConversationDetail(
        conversation=AgentConversationResponse(
            id=conversation_id,
            project_id=project_id,
            title="Streaming",
            created_at=NOW,
            updated_at=NOW,
        ),
        messages=[],
        run=run,
        action=None,
    )


class StaticStreamService:
    async def get_conversation(
        self, project_id: str, conversation_id: str
    ) -> AgentConversationDetail:
        return active_stream_detail(project_id, conversation_id)


def test_conversation_stream_replays_after_last_event_id_with_sse_id() -> None:
    class EventStore:
        def __init__(self) -> None:
            self.after_ids: list[str] = []

        async def read(
            self, conversation_id: str, after_id: str, **kwargs: Any
        ) -> list[dict[str, Any]]:
            self.after_ids.append(after_id)
            return [{
                "id": "9-0",
                "event": "message_update",
                "data": {
                    "type": "message_update",
                    "sequence": 9,
                    "project_id": "project-a",
                    "conversation_id": conversation_id,
                    "run_id": "run-stream",
                    "message_id": "message-final",
                    "part_id": "message-final:text",
                    "phase": "final",
                    "attempt": 0,
                    "assistant_message_event": {
                        "kind": "text_delta", "delta": "增量回答",
                    },
                },
            }]

    async def collect() -> tuple[list[str], EventStore]:
        store = EventStore()
        stream = conversation_event_stream(
            StreamRequest("7-0"),  # type: ignore[arg-type]
            StaticStreamService(),  # type: ignore[arg-type]
            "project-a",
            "conversation-stream",
            store,  # type: ignore[arg-type]
        )
        events: list[str] = []
        try:
            async for event in stream:
                events.append(event)
                if "event: message_update" in event:
                    break
        finally:
            await stream.aclose()
        return events, store

    events, store = asyncio.run(collect())

    assert store.after_ids == ["7-0"]
    assert events[-1].startswith("id: 9-0\nevent: message_update\n")
    assert "增量回答" in events[-1]


def test_conversation_stream_filters_other_projects_and_old_runs() -> None:
    class EventStore:
        def __init__(self) -> None:
            self.calls = 0

        async def read(
            self, conversation_id: str, after_id: str, **kwargs: Any
        ) -> list[dict[str, Any]]:
            self.calls += 1
            if self.calls == 1:
                return [
                    {
                        "id": "1-0",
                        "event": "message_update",
                        "data": {
                            "project_id": "project-b",
                            "conversation_id": conversation_id,
                            "run_id": "run-stream",
                        },
                    },
                    {
                        "id": "2-0",
                        "event": "message_update",
                        "data": {
                            "project_id": "project-a",
                            "conversation_id": conversation_id,
                            "run_id": "run-old",
                        },
                    },
                ]
            return [{
                "id": "3-0",
                "event": "message_update",
                "data": {
                    "type": "message_update",
                    "project_id": "project-a",
                    "conversation_id": conversation_id,
                    "run_id": "run-stream",
                    "message_id": "message-final",
                    "part_id": "message-final:text",
                    "phase": "final",
                    "attempt": 0,
                    "assistant_message_event": {
                        "kind": "text_delta", "delta": "当前任务",
                    },
                },
            }]

    async def collect() -> tuple[list[str], EventStore]:
        store = EventStore()
        stream = conversation_event_stream(
            StreamRequest(),  # type: ignore[arg-type]
            StaticStreamService(),  # type: ignore[arg-type]
            "project-a",
            "conversation-stream",
            store,  # type: ignore[arg-type]
        )
        events: list[str] = []
        try:
            async for event in stream:
                events.append(event)
                if "event: message_update" in event:
                    break
        finally:
            await stream.aclose()
        return events, store

    events, store = asyncio.run(collect())
    streamed = [event for event in events if "event: message_update" in event]

    assert store.calls == 2
    assert len(streamed) == 1
    assert streamed[0].startswith("id: 3-0\n")
    assert "当前任务" in streamed[0]


def test_conversation_stream_delivers_snapshot_and_redis_event_from_same_loop() -> None:
    class EventStore:
        async def read(
            self, conversation_id: str, after_id: str, **kwargs: Any
        ) -> list[dict[str, Any]]:
            return [{
                "id": "4-0",
                "event": "message_update",
                "data": {
                    "type": "message_update",
                    "project_id": "project-a",
                    "conversation_id": conversation_id,
                    "run_id": "run-stream",
                    "message_id": "message-final",
                    "part_id": "message-final:text",
                    "phase": "final",
                    "attempt": 0,
                    "assistant_message_event": {
                        "kind": "text_delta", "delta": "同轮增量",
                    },
                },
            }]

    async def collect() -> list[str]:
        stream = conversation_event_stream(
            StreamRequest(),  # type: ignore[arg-type]
            StaticStreamService(),  # type: ignore[arg-type]
            "project-a",
            "conversation-stream",
            EventStore(),  # type: ignore[arg-type]
        )
        events: list[str] = []
        try:
            async for event in stream:
                events.append(event)
                if "event: message_update" in event:
                    break
        finally:
            await stream.aclose()
        return events

    events = asyncio.run(collect())

    assert any("event: snapshot" in event for event in events)
    assert any("event: message_update" in event for event in events)
    assert "同轮增量" in events[-1]


def test_conversation_stream_falls_back_to_database_when_redis_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ChangingService:
        def __init__(self) -> None:
            self.calls = 0

        async def get_conversation(
            self, project_id: str, conversation_id: str
        ) -> AgentConversationDetail:
            self.calls += 1
            status = "completed" if self.calls >= 3 else "verifying"
            return active_stream_detail(project_id, conversation_id, status)

    class FailingEventStore:
        async def read(self, *args: Any, **kwargs: Any) -> None:
            return None

    async def no_sleep(seconds: float) -> None:
        return None

    monkeypatch.setattr("app.api.routes.agents.asyncio.sleep", no_sleep)

    async def collect() -> list[str]:
        stream = conversation_event_stream(
            StreamRequest(),  # type: ignore[arg-type]
            ChangingService(),  # type: ignore[arg-type]
            "project-a",
            "conversation-stream",
            FailingEventStore(),  # type: ignore[arg-type]
        )
        events: list[str] = []
        try:
            async for event in stream:
                events.append(event)
                if len([item for item in events if "event: snapshot" in item]) == 2:
                    break
        finally:
            await stream.aclose()
        return events

    events = asyncio.run(collect())

    assert len([event for event in events if "event: snapshot" in event]) == 2
    assert any('"status": "completed"' in event for event in events)
