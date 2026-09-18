from __future__ import annotations

import json
import hashlib
import math
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import delete, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.retry import retry_database_read
from app.modules.agent.backlinks_automation import BACKLINKS_READY_TRIGGER
from app.modules.agent.context_tokens import estimate_json_tokens
from app.modules.agent.models import (
    AgentAction,
    AgentConversation,
    AgentConversationEvent,
    AgentConversationSummary,
    AgentMessage,
    AgentProjectMemory,
    AgentResearchRecord,
    AgentRun,
    AgentRunStep,
    AgentSystemTrigger,
    AgentTimelineEvent,
    AgentToolExecution,
    AgentWorkflowDispatch,
)
from app.modules.agent.security import sanitize_agent_data, sanitize_text
from app.modules.onboarding.models import OnboardingRun
from app.modules.projects.models import Project

ACTIVE_RUN_STATUSES = {"queued", "running", "executing", "verifying"}
TERMINAL_RUN_STATUSES = {
    "completed", "cancelled", "failed", "limit_reached",
    "rejected", "expired",
}
MEMORY_SOURCE_PRIORITIES = {
    "inferred": 0,
    "platform_data": 1,
    "user_confirmed": 2,
}
PROJECT_MEMORY_CONTEXT_TOKENS = 2_000
RESEARCH_CONTEXT_TOKENS = 2_000
COMPLETION_EVIDENCE_EXECUTIONS = 40
COMPLETION_EVIDENCE_STEPS = 100
COMPLETION_RECORD_IDS = 50
COMPLETION_REPEATED_STATUSES = 40
ACTIVE_TOOL_EXECUTION_STATUSES = {"pending", "claimed", "executing", "verifying"}
LEASED_TOOL_EXECUTION_STATUSES = {"claimed", "executing", "verifying"}
INCOMPLETE_BUSINESS_STATUSES = {
    "blocked",
    "cancelled",
    "canceled",
    "error",
    "expired",
    "failed",
    "in_progress",
    "incomplete",
    "partial",
    "pending",
    "queued",
    "running",
}


class ToolExecutionLeaseLostError(RuntimeError):
    pass


def _holds_active_tool_lease(
    execution: AgentToolExecution | None,
    worker_id: str,
    *,
    now: datetime | None = None,
) -> bool:
    if execution is None:
        return False
    checked_at = now or datetime.now(UTC)
    return (
        execution.worker_id == worker_id
        and execution.status in LEASED_TOOL_EXECUTION_STATUSES
        and execution.lease_expires_at is not None
        and execution.lease_expires_at > checked_at
    )


def _execution_result_data(execution: AgentToolExecution) -> dict[str, Any]:
    result = execution.result_json
    if not isinstance(result, dict):
        return {}
    data = result.get("data")
    return data if isinstance(data, dict) else result


def _completion_fact(execution: AgentToolExecution) -> dict[str, Any] | None:
    data = _execution_result_data(execution)
    nested = data.get("completion")
    source = {**data, **nested} if isinstance(nested, dict) else data
    fact_keys = (
        "operation_id", "requested_count", "completed_count", "failed_count",
        "verified", "already_completed", "run_id", "status", "record_ids",
    )
    if not any(key in source for key in fact_keys):
        return None
    fact = {
        "tool_call_id": execution.tool_call_id,
        "round": execution.round_number,
        "call": execution.call_number,
        "tool": execution.tool_name,
        "arguments_hash": execution.parameters_hash,
        "execution_status": execution.status,
    }
    fact.update({key: source[key] for key in fact_keys if key in source})
    record_ids = fact.get("record_ids")
    if isinstance(record_ids, list) and len(record_ids) > COMPLETION_RECORD_IDS:
        fact["record_ids"] = record_ids[:COMPLETION_RECORD_IDS]
        fact["record_ids_count"] = len(record_ids)
        fact["record_ids_truncated"] = True
    return fact


def _completion_fact_is_incomplete(fact: dict[str, Any]) -> bool:
    if fact.get("execution_status") in ACTIVE_TOOL_EXECUTION_STATUSES | {"failed"}:
        return True
    business_status = fact.get("status")
    if (
        isinstance(business_status, str)
        and business_status.lower() in INCOMPLETE_BUSINESS_STATUSES
    ):
        return True
    if fact.get("verified") is False:
        return True
    requested = fact.get("requested_count")
    completed = fact.get("completed_count")
    failed = fact.get("failed_count")
    if isinstance(failed, (int, float)) and not isinstance(failed, bool) and failed > 0:
        return True
    return (
        isinstance(requested, (int, float))
        and not isinstance(requested, bool)
        and isinstance(completed, (int, float))
        and not isinstance(completed, bool)
        and completed < requested
    )


def _completion_tool_evidence(execution: AgentToolExecution) -> dict[str, Any]:
    result = execution.result_json if isinstance(execution.result_json, dict) else {}
    data = _execution_result_data(execution)
    model_views = (
        execution.model_result_json
        if isinstance(execution.model_result_json, dict)
        else {}
    )
    long_term = model_views.get("long_term")
    long_term_data = (
        long_term.get("data")
        if isinstance(long_term, dict) and isinstance(long_term.get("data"), dict)
        else {}
    )
    completion_keys = {
        "id", "run_id", "status", "verified", "already_completed", "operation_id",
        "requested_count", "completed_count", "failed_count", "record_ids", "completion",
        "total", "page", "page_size", "next_page", "url", "changes", "audit",
        "top_issues", "facts", "applied", "conclusion", "article_id", "article_ids",
        "articles", "primary_keyword", "title", "stage", "progress", "batch_id",
    }
    bounded_data = dict(long_term_data)
    bounded_data.update({key: data[key] for key in completion_keys if key in data})
    record_ids = bounded_data.get("record_ids")
    if isinstance(record_ids, list) and len(record_ids) > COMPLETION_RECORD_IDS:
        bounded_data["record_ids"] = record_ids[:COMPLETION_RECORD_IDS]
        bounded_data["record_ids_count"] = len(record_ids)
        bounded_data["record_ids_truncated"] = True
    return {
        "tool_call_id": execution.tool_call_id,
        "round": execution.round_number,
        "call": execution.call_number,
        "tool": execution.tool_name,
        "execution_status": execution.status,
        "ok": bool(result.get("ok", execution.status == "completed")),
        "summary": sanitize_text(str(result.get("summary", "")))[:1_000],
        "error_code": execution.error_code or result.get("error_code"),
        "data": bounded_data,
    }


def _completion_display_events(
    steps: list[AgentRunStep], executions: list[AgentToolExecution]
) -> list[dict[str, Any]]:
    execution_by_id = {item.tool_call_id: item for item in executions}
    referenced: set[str] = set()
    events: list[dict[str, Any]] = []
    for step in steps:
        if step.step_type != "model" or step.name != "chat.completions":
            continue
        output = dict(step.output_json) if isinstance(step.output_json, dict) else {}
        progress_text = sanitize_text(str(output.get("progress_text", ""))).strip()
        if progress_text:
            events.append({"type": "text", "text": progress_text})
        calls = output.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call in calls:
            if not isinstance(call, dict):
                continue
            tool_call_id = str(call.get("tool_call_id") or "")
            execution = execution_by_id.get(tool_call_id)
            if execution is None or tool_call_id in referenced:
                continue
            referenced.add(tool_call_id)
            events.append({
                "type": "tool",
                "tool_call_id": execution.tool_call_id,
                "tool": execution.tool_name,
                "execution_status": execution.status,
            })

    # A workflow can stop after registering a call but before its model step is
    # closed. Keep that durable call visible instead of losing it from history.
    for execution in executions:
        if execution.tool_call_id in referenced:
            continue
        events.append({
            "type": "tool",
            "tool_call_id": execution.tool_call_id,
            "tool": execution.tool_name,
            "execution_status": execution.status,
        })
    return events


def _message_path(
    messages: list[AgentMessage],
    leaf_id: str | None,
    *,
    allow_legacy_linear: bool = True,
) -> list[AgentMessage]:
    if not messages or leaf_id is None:
        return []
    by_id = {message.id: message for message in messages}
    if leaf_id not in by_id:
        return []
    if allow_legacy_linear and not any(
        message.parent_message_id for message in messages
    ):
        leaf = by_id[leaf_id]
        return [
            message for message in messages
            if (message.created_at, message.id) <= (leaf.created_at, leaf.id)
        ]
    path: list[AgentMessage] = []
    seen: set[str] = set()
    current = by_id.get(leaf_id)
    while current is not None:
        if current.id in seen:
            raise RuntimeError("message_branch_cycle")
        seen.add(current.id)
        path.append(current)
        current = by_id.get(current.parent_message_id)
    path.reverse()
    return path


def _materialize_legacy_message_chain(messages: list[AgentMessage]) -> None:
    if any(message.parent_message_id is not None for message in messages):
        return
    for previous, current in zip(messages, messages[1:], strict=False):
        current.parent_message_id = previous.id


def _conversation_title(messages: list[AgentMessage]) -> str:
    first_user = next((message for message in messages if message.role == "user"), None)
    return first_user.content[:80] if first_user else "新对话"


def _estimate_context_tokens(value: Any) -> int:
    return estimate_json_tokens(value)


DOWNSTREAM_BILLING_TOOLS = {
    "keyword_external_requests": "start_keyword_library",
    "content_plan_external_requests": "start_content_plan",
    "article_run_steps": "start_articles",
}


def _downstream_billing_entries(
    steps: list[Any],
) -> dict[tuple[str, str], dict[str, Any]]:
    entries: dict[tuple[str, str], dict[str, Any]] = {}
    for step in steps:
        output = step.output_json if isinstance(step.output_json, dict) else {}
        data = output.get("data")
        data = data if isinstance(data, dict) else output
        billing = data.get("billing")
        if not isinstance(billing, dict):
            continue
        source = str(billing.get("source") or "").strip()
        reference_id = str(billing.get("reference_id") or "").strip()
        reported_cost = billing.get("reported_cost_usd")
        if (
            not source
            or not reference_id
            or isinstance(reported_cost, bool)
            or not isinstance(reported_cost, (int, float))
        ):
            continue
        cost = float(reported_cost)
        if not math.isfinite(cost) or cost < 0:
            continue
        key = (source, reference_id)
        previous = entries.get(key, {})
        entries[key] = {
            "reported_cost_usd": max(
                float(previous.get("reported_cost_usd") or 0), cost
            ),
            "complete": bool(previous.get("complete"))
            or billing.get("complete") is True,
        }
    return entries


def _downstream_billing_cost(steps: list[Any]) -> float:
    return round(sum(
        float(entry["reported_cost_usd"])
        for entry in _downstream_billing_entries(steps).values()
    ), 8)


def _unsettled_reservation_cost(
    reservations: list[Any],
    billing_entries: dict[tuple[str, str], dict[str, Any]],
) -> float:
    settled_by_tool: dict[str, int] = {}
    for (source, _reference_id), entry in billing_entries.items():
        tool_name = DOWNSTREAM_BILLING_TOOLS.get(source)
        if tool_name and entry.get("complete") is True:
            settled_by_tool[tool_name] = settled_by_tool.get(tool_name, 0) + 1

    unsettled = 0.0
    for reservation in sorted(reservations, key=lambda item: item.sequence):
        input_json = (
            reservation.input_json
            if isinstance(reservation.input_json, dict)
            else {}
        )
        tool_name = str(input_json.get("tool_name") or "")
        if settled_by_tool.get(tool_name, 0) > 0:
            settled_by_tool[tool_name] -= 1
            continue
        reserve = input_json.get("reserve_usd")
        if isinstance(reserve, bool) or not isinstance(reserve, (int, float)):
            continue
        reserve_value = float(reserve)
        if math.isfinite(reserve_value):
            unsettled += max(reserve_value, 0.0)
    return round(unsettled, 8)


def _bounded_memory_context(
    facts: list[dict[str, Any]],
    max_tokens: int = PROJECT_MEMORY_CONTEXT_TOKENS,
) -> list[dict[str, Any]]:
    facts = _ensure_memory_fact_ids(facts)
    ranked_indices = sorted(
        range(len(facts)),
        key=lambda index: (
            MEMORY_SOURCE_PRIORITIES.get(str(facts[index].get("source")), 0),
            index,
        ),
        reverse=True,
    )
    selected: dict[int, dict[str, Any]] = {}
    for index in ranked_indices:
        candidate = [
            selected.get(item_index, facts[item_index])
            for item_index in sorted([*selected, index])
        ]
        if _estimate_context_tokens(candidate) <= max_tokens:
            selected[index] = dict(facts[index])
            continue

        fact = dict(facts[index])
        value = str(fact.get("value", ""))
        low, high = 1, len(value)
        fitted: dict[str, Any] | None = None
        while low <= high:
            midpoint = (low + high) // 2
            truncated = {
                **fact,
                "value": value[:midpoint] + " [context truncated]",
                "context_truncated": True,
            }
            truncated_candidate = [
                truncated if item_index == index else selected[item_index]
                for item_index in sorted([*selected, index])
            ]
            if _estimate_context_tokens(truncated_candidate) <= max_tokens:
                fitted = truncated
                low = midpoint + 1
            else:
                high = midpoint - 1
        if fitted is not None:
            selected[index] = fitted
    return [selected[index] for index in sorted(selected)]


def _memory_context_catalog(
    facts: list[dict[str, Any]],
    visible_facts: list[dict[str, Any]],
) -> dict[str, Any]:
    categories: dict[str, dict[str, int]] = {}
    visible_ids = {str(item.get("fact_id", "")) for item in visible_facts}
    for fact in _ensure_memory_fact_ids(facts):
        category = str(fact.get("category", ""))
        counts = categories.setdefault(category, {"total": 0, "visible": 0})
        counts["total"] += 1
        if str(fact.get("fact_id", "")) in visible_ids:
            counts["visible"] += 1
    return {
        "total_facts": len(facts),
        "visible_facts": len(visible_facts),
        "hidden_facts": max(0, len(facts) - len(visible_facts)),
        "categories": categories,
    }


def _bounded_context_items(
    items: list[dict[str, Any]],
    max_tokens: int,
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for item in items:
        candidate = [*selected, item]
        if _estimate_context_tokens(candidate) <= max_tokens:
            selected.append(item)
    return selected


def _safe_compactable_message_count(messages: list[AgentMessage], keep_at_least: int) -> int:
    minimum_keep = max(1, keep_at_least)
    if len(messages) <= minimum_keep:
        return 0
    candidate = len(messages) - minimum_keep
    while candidate > 0:
        if messages[candidate].role == "user" and messages[candidate - 1].role == "assistant":
            return candidate
        candidate -= 1
    return 0


def _token_bounded_compactable_message_count(
    messages: list[AgentMessage], max_recent_tokens: int
) -> int:
    if len(messages) < 3:
        return 0
    full_history = [
        {"role": item.role, "content": item.content}
        for item in messages
    ]
    if estimate_json_tokens(full_history) <= max_recent_tokens:
        return 0
    for candidate in range(2, len(messages)):
        if messages[candidate].role != "user" or messages[candidate - 1].role != "assistant":
            continue
        recent = [
            {"role": item.role, "content": item.content}
            for item in messages[candidate:]
        ]
        if estimate_json_tokens(recent) <= max_recent_tokens:
            return candidate
    return 0


def _memory_fact_id(fact: dict[str, Any]) -> str:
    identity = json.dumps(
        {
            "category": str(fact.get("category", "")),
            "value": str(fact.get("value", "")).strip().casefold(),
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return f"fact-{hashlib.sha256(identity).hexdigest()[:24]}"


def _new_memory_fact_id() -> str:
    return f"fact-{uuid4().hex}"


def _ensure_memory_fact_ids(facts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ensured: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for index, item in enumerate(facts):
        fact = dict(item)
        fact_id = str(fact.get("fact_id") or _memory_fact_id(fact))
        if fact_id in used_ids:
            collision_identity = json.dumps(
                {
                    "fact_id": fact_id,
                    "category": str(fact.get("category", "")),
                    "value": str(fact.get("value", "")).strip().casefold(),
                    "index": index,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
            fact_id = f"fact-{hashlib.sha256(collision_identity).hexdigest()[:24]}"
            while fact_id in used_ids:
                fact_id = _new_memory_fact_id()
        fact["fact_id"] = fact_id
        used_ids.add(fact_id)
        ensured.append(fact)
    return ensured


def _message_contains_fact(message: str, value: str) -> bool:
    normalized_message = "".join(message.casefold().split())
    normalized_value = "".join(value.casefold().split())
    return bool(normalized_value and normalized_value in normalized_message)


def _apply_memory_operations(
    existing_facts: list[dict[str, Any]],
    operations: list[dict[str, Any]],
    *,
    user_message_id: str,
    user_message: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    facts = _ensure_memory_fact_ids(existing_facts)
    applied: list[dict[str, Any]] = []
    for operation in operations:
        operation_name = str(operation.get("operation", ""))
        value = sanitize_text(str(operation.get("value", ""))).strip()[:2_000]
        if operation_name != "delete" and not value:
            raise ValueError("项目记忆内容不能为空")
        source = str(operation.get("source", "inferred"))
        if (
            operation_name != "delete"
            and source == "user_confirmed"
            and not _message_contains_fact(user_message, value)
        ):
            source = "inferred"

        if operation_name == "add":
            category = str(operation.get("category", ""))
            duplicate = next((
                item for item in facts
                if item.get("category") == category
                and str(item.get("value", "")).strip().casefold() == value.casefold()
            ), None)
            if duplicate is None:
                fact = {
                    "fact_id": _new_memory_fact_id(),
                    "category": category,
                    "value": value,
                    "source": source,
                }
                if source == "user_confirmed":
                    fact["source_message_id"] = user_message_id
                facts.append(fact)
                applied.append({"operation": "add", **fact})
                continue
            if (
                MEMORY_SOURCE_PRIORITIES.get(source, 0)
                > MEMORY_SOURCE_PRIORITIES.get(str(duplicate.get("source")), 0)
            ):
                duplicate["source"] = source
                if source == "user_confirmed":
                    duplicate["source_message_id"] = user_message_id
            applied.append({"operation": "unchanged", **duplicate})
            continue

        fact_id = str(operation.get("fact_id", ""))
        target = next((item for item in facts if item.get("fact_id") == fact_id), None)
        if target is None:
            raise LookupError("要修改的项目记忆不存在")
        if (
            MEMORY_SOURCE_PRIORITIES.get(source, 0)
            < MEMORY_SOURCE_PRIORITIES.get(str(target.get("source")), 0)
        ):
            raise ValueError("未经用户确认的信息不能覆盖用户已经确认的项目记忆")

        if operation_name == "delete":
            if source == "user_confirmed" and not _message_contains_fact(
                user_message, str(target.get("value", ""))
            ):
                raise ValueError("用户消息没有明确指出要删除的项目记忆")
            facts = [item for item in facts if item.get("fact_id") != fact_id]
            applied.append({"operation": "delete", "fact_id": fact_id})
            continue

        target["value"] = value
        target["source"] = source
        if source == "user_confirmed":
            target["source_message_id"] = user_message_id
        else:
            target.pop("source_message_id", None)
        applied.append({"operation": "update", **target})
    return facts, applied


class AgentRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    @staticmethod
    async def _active_messages(
        session: AsyncSession,
        conversation: AgentConversation,
        messages: list[AgentMessage],
    ) -> list[AgentMessage]:
        latest_branch_event = await session.scalar(
            select(AgentConversationEvent)
            .where(AgentConversationEvent.conversation_id == conversation.id)
            .order_by(
                AgentConversationEvent.created_at.desc(),
                AgentConversationEvent.id.desc(),
            )
            .limit(1)
        )
        if conversation.active_message_id is not None:
            return _message_path(
                messages,
                conversation.active_message_id,
                allow_legacy_linear=latest_branch_event is None,
            )
        if not messages:
            return []
        return (
            []
            if latest_branch_event is not None
            and latest_branch_event.event_type == "rewind"
            and latest_branch_event.new_leaf_id is None
            else messages
        )

    @retry_database_read
    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        async with self.sessions() as session:
            return await session.scalar(
                select(Project.id).where(
                    Project.id == project_id, Project.organization_id == organization_id
                )
            ) is not None

    async def create_conversation(
        self, organization_id: str, project_id: str, created_by: str
    ) -> AgentConversation:
        conversation = AgentConversation(
            id=str(uuid4()), organization_id=organization_id, project_id=project_id,
            created_by=created_by, title="新对话",
        )
        async with self.sessions() as session:
            session.add(conversation)
            await session.commit()
            await session.refresh(conversation)
        return conversation

    async def archive_conversation(
        self, organization_id: str, project_id: str, conversation_id: str
    ) -> AgentConversation | None:
        async with self.sessions() as session:
            conversation = await session.scalar(
                select(AgentConversation).where(
                    AgentConversation.id == conversation_id,
                    AgentConversation.organization_id == organization_id,
                    AgentConversation.project_id == project_id,
                ).with_for_update()
            )
            if conversation is None:
                return None
            active = await session.scalar(
                select(AgentRun.id).where(
                    AgentRun.conversation_id == conversation_id,
                    AgentRun.status.in_(ACTIVE_RUN_STATUSES),
                )
            )
            if active is not None:
                raise RuntimeError("active_run")
            conversation.archived_at = datetime.now(UTC)
            await session.commit()
            await session.refresh(conversation)
            return conversation

    @retry_database_read
    async def list_conversations(
        self, organization_id: str, project_id: str, page: int, page_size: int
    ) -> tuple[list[AgentConversation], int]:
        conditions = (
            AgentConversation.organization_id == organization_id,
            AgentConversation.project_id == project_id,
            AgentConversation.archived_at.is_(None),
        )
        async with self.sessions() as session:
            total = int(await session.scalar(select(func.count()).select_from(AgentConversation).where(*conditions)) or 0)
            rows = list((await session.scalars(
                select(AgentConversation).where(*conditions)
                .order_by(AgentConversation.updated_at.desc())
                .offset((page - 1) * page_size).limit(page_size)
            )).all())
        return rows, total

    @retry_database_read
    async def get_conversation(
        self, organization_id: str, project_id: str, conversation_id: str
    ) -> AgentConversation | None:
        async with self.sessions() as session:
            return await session.scalar(select(AgentConversation).where(
                AgentConversation.id == conversation_id,
                AgentConversation.organization_id == organization_id,
                AgentConversation.project_id == project_id,
            ))

    @retry_database_read
    async def conversation_messages(self, conversation_id: str, after_sequence: int = 0) -> list[AgentMessage]:
        async with self.sessions() as session:
            conversation = await session.get(AgentConversation, conversation_id)
            if conversation is None:
                return []
            rows = list((await session.scalars(
                select(AgentMessage)
                .where(AgentMessage.conversation_id == conversation_id)
                .order_by(AgentMessage.created_at, AgentMessage.id)
            )).all())
            active = await self._active_messages(session, conversation, rows)
        return active[after_sequence:]

    @retry_database_read
    async def timeline_events(
        self,
        organization_id: str,
        project_id: str,
        conversation_id: str,
    ) -> list[AgentTimelineEvent]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(AgentTimelineEvent)
                        .where(
                            AgentTimelineEvent.organization_id == organization_id,
                            AgentTimelineEvent.project_id == project_id,
                            or_(
                                AgentTimelineEvent.conversation_id.is_(None),
                                AgentTimelineEvent.conversation_id == conversation_id,
                            ),
                        )
                        .order_by(AgentTimelineEvent.sequence)
                    )
                ).all()
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
        async with self.sessions() as session:
            project = await session.scalar(
                select(Project)
                .where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                )
                .with_for_update()
            )
            if project is None:
                raise LookupError("project_not_found")
            if conversation_id is not None:
                conversation_exists = await session.scalar(
                    select(AgentConversation.id).where(
                        AgentConversation.id == conversation_id,
                        AgentConversation.organization_id == organization_id,
                        AgentConversation.project_id == project_id,
                    )
                )
                if conversation_exists is None:
                    raise LookupError("conversation_not_found")

            existing = await session.scalar(
                select(AgentTimelineEvent).where(
                    AgentTimelineEvent.organization_id == organization_id,
                    AgentTimelineEvent.project_id == project_id,
                    AgentTimelineEvent.event_key == event_key,
                )
            )
            normalized_title = sanitize_text(title.strip())[:500]
            normalized_content = sanitize_text((content or "").strip())[:20_000] or None
            normalized_action = sanitize_agent_data(action or {})
            normalized_metadata = sanitize_agent_data(metadata or {})
            if existing is not None:
                if (
                    existing.kind != kind
                    or existing.title != normalized_title
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
                existing.updated_at = datetime.now(UTC)
                await session.commit()
                await session.refresh(existing)
                return existing

            sequence = int(
                await session.scalar(
                    select(func.max(AgentTimelineEvent.sequence)).where(
                        AgentTimelineEvent.organization_id == organization_id,
                        AgentTimelineEvent.project_id == project_id,
                    )
                )
                or 0
            ) + 1
            event = AgentTimelineEvent(
                id=str(uuid4()),
                organization_id=organization_id,
                project_id=project_id,
                conversation_id=conversation_id,
                event_key=event_key,
                sequence=sequence,
                kind=kind,
                status=status,
                title=normalized_title,
                content=normalized_content,
                action_json=normalized_action,
                metadata_json=normalized_metadata,
            )
            session.add(event)
            await session.commit()
            await session.refresh(event)
            return event

    @retry_database_read
    async def conversation_event_for_request(
        self, conversation_id: str, client_request_id: str
    ) -> AgentConversationEvent | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(AgentConversationEvent).where(
                    AgentConversationEvent.conversation_id == conversation_id,
                    AgentConversationEvent.client_request_id == client_request_id,
                )
            )

    async def rewind_conversation(
        self,
        organization_id: str,
        project_id: str,
        conversation_id: str,
        message_id: str,
        client_request_id: str,
    ) -> None:
        async with self.sessions() as session:
            conversation = await session.scalar(
                select(AgentConversation).where(
                    AgentConversation.id == conversation_id,
                    AgentConversation.organization_id == organization_id,
                    AgentConversation.project_id == project_id,
                ).with_for_update()
            )
            if conversation is None:
                raise LookupError("conversation_not_found")
            existing_event = await session.scalar(
                select(AgentConversationEvent).where(
                    AgentConversationEvent.conversation_id == conversation_id,
                    AgentConversationEvent.client_request_id == client_request_id,
                )
            )
            if existing_event is not None:
                if (
                    existing_event.event_type == "rewind"
                    and existing_event.target_message_id == message_id
                ):
                    return
                raise RuntimeError("idempotency_conflict")
            existing_message = await session.scalar(
                select(AgentMessage.id).where(
                    AgentMessage.conversation_id == conversation_id,
                    AgentMessage.client_request_id == client_request_id,
                )
            )
            if existing_message is not None:
                raise RuntimeError("idempotency_conflict")
            messages = list((await session.scalars(
                select(AgentMessage).where(
                    AgentMessage.conversation_id == conversation_id
                ).order_by(AgentMessage.created_at, AgentMessage.id)
            )).all())
            has_branch_event = await session.scalar(
                select(AgentConversationEvent.id)
                .where(AgentConversationEvent.conversation_id == conversation_id)
                .limit(1)
            ) is not None
            if not has_branch_event:
                _materialize_legacy_message_chain(messages)
            active_messages = await self._active_messages(
                session, conversation, messages
            )
            target = next((
                item for item in active_messages
                if item.id == message_id and item.role == "user"
            ), None)
            if target is None:
                exists = any(
                    item.id == message_id and item.role == "user"
                    for item in messages
                )
                if exists:
                    raise RuntimeError("message_not_active")
                raise LookupError("message_not_found")
            active = await session.scalar(select(AgentRun.id).where(
                AgentRun.conversation_id == conversation_id,
                AgentRun.status.in_(ACTIVE_RUN_STATUSES),
            ))
            if active is not None:
                raise RuntimeError(f"active_run:{active}")
            target_index = active_messages.index(target)
            branch_parent_id = (
                target.parent_message_id
                or (
                    active_messages[target_index - 1].id
                    if target_index > 0
                    else None
                )
            )
            previous_leaf_id = conversation.active_message_id
            conversation.active_message_id = branch_parent_id
            remaining = active_messages[:target_index]
            session.add(AgentConversationEvent(
                id=str(uuid4()),
                conversation_id=conversation_id,
                event_type="rewind",
                target_message_id=target.id,
                previous_leaf_id=previous_leaf_id,
                new_leaf_id=branch_parent_id,
                client_request_id=client_request_id,
                metadata_json={"business_state_unchanged": True},
            ))
            await session.execute(
                delete(AgentConversationSummary).where(
                    AgentConversationSummary.conversation_id == conversation_id
                )
            )
            conversation.title = _conversation_title(remaining)
            conversation.updated_at = datetime.now(UTC)
            await session.commit()

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
        async with self.sessions() as session:
            conversation = await session.scalar(select(AgentConversation).where(
                AgentConversation.id == conversation_id,
                AgentConversation.organization_id == organization_id,
                AgentConversation.project_id == project_id,
            ).with_for_update())
            if conversation is None:
                raise LookupError("conversation_not_found")
            existing_event = await session.scalar(
                select(AgentConversationEvent.id).where(
                    AgentConversationEvent.conversation_id == conversation_id,
                    AgentConversationEvent.client_request_id == client_request_id,
                )
            )
            if existing_event is not None:
                raise RuntimeError("idempotency_conflict")
            existing = await session.scalar(select(AgentMessage).where(
                AgentMessage.conversation_id == conversation_id,
                AgentMessage.client_request_id == client_request_id,
            ))
            if existing is not None:
                normalized_content = sanitize_text(content.strip())[:20_000]
                normalized_metadata = sanitize_agent_data(
                    {"page_context": page_context} if page_context else {}
                )
                if (
                    existing.content != normalized_content
                    or dict(existing.metadata_json) != normalized_metadata
                ):
                    raise RuntimeError("idempotency_conflict")
                run = await session.scalar(select(AgentRun).where(AgentRun.user_message_id == existing.id))
                if run is None:
                    raise RuntimeError("duplicate message has no run")
                return existing, run
            active = await session.scalar(select(AgentRun.id).where(
                AgentRun.conversation_id == conversation_id,
                AgentRun.status.in_(ACTIVE_RUN_STATUSES),
            ))
            if active is not None:
                raise RuntimeError("active_run")
            message_id, run_id = str(uuid4()), str(uuid4())
            message = AgentMessage(
                id=message_id, conversation_id=conversation_id, run_id=run_id,
                parent_message_id=conversation.active_message_id,
                role="user", content=sanitize_text(content.strip())[:20_000],
                metadata_json=sanitize_agent_data(
                    {"page_context": page_context} if page_context else {}
                ),
                client_request_id=client_request_id,
            )
            run = AgentRun(
                id=run_id, conversation_id=conversation_id, user_message_id=message_id,
                workflow_id=f"agent:{run_id}", status="queued", limits_json=limits,
            )
            dispatch = AgentWorkflowDispatch(
                run_id=run_id,
                workflow_id=run.workflow_id,
                task_payload={"run_id": run_id, "limits": limits},
                status="pending",
            )
            session.add_all([message, run, dispatch])
            await session.flush()
            conversation.active_message_id = message.id
            if conversation.title == "新对话":
                conversation.title = content.strip()[:80]
            conversation.updated_at = datetime.now(UTC)
            try:
                await session.commit()
            except IntegrityError as exc:
                await session.rollback()
                raise RuntimeError("active_run") from exc
            await session.refresh(message)
            await session.refresh(run)
            return message, run

    async def enqueue_system_trigger(
        self,
        organization_id: str,
        project_id: str,
        trigger: str,
        trigger_version: str,
        content: str,
        trusted_write_tools: tuple[str, ...],
    ) -> AgentSystemTrigger:
        async with self.sessions() as session:
            onboarding = await session.scalar(
                select(OnboardingRun)
                .where(
                    OnboardingRun.organization_id == organization_id,
                    OnboardingRun.project_id == project_id,
                )
            )
            if onboarding is None or onboarding.agent_conversation_id is None:
                raise LookupError("onboarding_conversation_not_found")
            normalized_content = sanitize_text(content.strip())[:20_000]
            normalized_tools = list(
                dict.fromkeys(
                    sanitize_text(name.strip())[:200]
                    for name in trusted_write_tools
                    if name.strip()
                )
            )
            await session.execute(
                pg_insert(AgentSystemTrigger)
                .values(
                    id=str(uuid4()),
                    organization_id=organization_id,
                    project_id=project_id,
                    trigger=sanitize_text(trigger.strip())[:200],
                    trigger_version=sanitize_text(trigger_version.strip())[:200],
                    content=normalized_content,
                    trusted_write_tools_json=normalized_tools,
                    status="pending",
                )
                .on_conflict_do_nothing(
                    constraint="uq_agent_system_triggers_identity"
                )
            )
            record = await session.scalar(
                select(AgentSystemTrigger).where(
                    AgentSystemTrigger.organization_id == organization_id,
                    AgentSystemTrigger.project_id == project_id,
                    AgentSystemTrigger.trigger == trigger,
                    AgentSystemTrigger.trigger_version == trigger_version,
                )
            )
            if record is None:
                raise RuntimeError("system_trigger_not_persisted")
            if (
                record.content != normalized_content
                or list(record.trusted_write_tools_json) != normalized_tools
            ):
                raise RuntimeError("idempotency_conflict")
            await session.commit()
            await session.refresh(record)
            return record

    async def materialize_pending_system_triggers(
        self,
        limits: dict,
        limit: int = 20,
    ) -> list[AgentRun]:
        async with self.sessions() as session:
            triggers = list(
                (
                    await session.scalars(
                        select(AgentSystemTrigger)
                        .where(
                            AgentSystemTrigger.status == "pending",
                            AgentSystemTrigger.trigger != BACKLINKS_READY_TRIGGER,
                        )
                        .order_by(
                            AgentSystemTrigger.created_at,
                            AgentSystemTrigger.id,
                        )
                        .limit(max(1, min(limit, 100)))
                        .with_for_update(skip_locked=True)
                    )
                ).all()
            )
            materialized: list[AgentRun] = []
            busy_conversations: set[str] = set()
            now = datetime.now(UTC)
            for trigger in triggers:
                onboarding = await session.scalar(
                    select(OnboardingRun).where(
                        OnboardingRun.organization_id == trigger.organization_id,
                        OnboardingRun.project_id == trigger.project_id,
                    )
                )
                if onboarding is None or onboarding.agent_conversation_id is None:
                    continue
                conversation_id = onboarding.agent_conversation_id
                if conversation_id in busy_conversations:
                    continue
                conversation = await session.scalar(
                    select(AgentConversation)
                    .where(
                        AgentConversation.id == conversation_id,
                        AgentConversation.organization_id == trigger.organization_id,
                        AgentConversation.project_id == trigger.project_id,
                        AgentConversation.archived_at.is_(None),
                    )
                    .with_for_update()
                )
                if conversation is None:
                    continue
                active = await session.scalar(
                    select(AgentRun.id).where(
                        AgentRun.conversation_id == conversation.id,
                        AgentRun.status.in_(ACTIVE_RUN_STATUSES),
                    )
                )
                if active is not None:
                    busy_conversations.add(conversation.id)
                    continue

                message_id, run_id = str(uuid4()), str(uuid4())
                metadata = sanitize_agent_data(
                    {
                        "hidden_from_user": True,
                        "trusted_system_trigger": True,
                        "system_trigger": trigger.trigger,
                        "trusted_write_tools": list(
                            trigger.trusted_write_tools_json
                        ),
                    }
                )
                message = AgentMessage(
                    id=message_id,
                    conversation_id=conversation.id,
                    run_id=run_id,
                    parent_message_id=conversation.active_message_id,
                    role="user",
                    content=trigger.content,
                    metadata_json=metadata,
                    client_request_id=(
                        f"system:{trigger.trigger}:{trigger.trigger_version}"
                    )[:100],
                )
                run = AgentRun(
                    id=run_id,
                    conversation_id=conversation.id,
                    user_message_id=message_id,
                    workflow_id=f"agent:{run_id}",
                    status="queued",
                    limits_json=limits,
                )
                dispatch = AgentWorkflowDispatch(
                    run_id=run_id,
                    workflow_id=run.workflow_id,
                    task_payload={"run_id": run_id, "limits": limits},
                    status="pending",
                )
                session.add_all([message, run, dispatch])
                await session.flush()
                conversation.active_message_id = message.id
                conversation.updated_at = now
                trigger.status = "dispatched"
                trigger.message_id = message.id
                trigger.run_id = run.id
                trigger.dispatched_at = now
                trigger.updated_at = now
                busy_conversations.add(conversation.id)
                materialized.append(run)
            try:
                await session.commit()
            except IntegrityError as exc:
                await session.rollback()
                raise RuntimeError("system_trigger_materialization_conflict") from exc
            return materialized

    async def retry_system_trigger_run(
        self,
        organization_id: str,
        project_id: str,
        source_run_id: str,
        limits: dict,
    ) -> tuple[AgentMessage, AgentRun]:
        async with self.sessions() as session:
            source_run = await session.scalar(
                select(AgentRun)
                .join(
                    AgentConversation,
                    AgentConversation.id == AgentRun.conversation_id,
                )
                .where(
                    AgentRun.id == source_run_id,
                    AgentConversation.organization_id == organization_id,
                    AgentConversation.project_id == project_id,
                )
            )
            if source_run is None:
                raise LookupError("run_not_found")
            if source_run.status not in {"failed", "limit_reached"}:
                raise RuntimeError(f"run_not_retryable:{source_run.status}")
            source_message = await session.scalar(
                select(AgentMessage).where(
                    AgentMessage.id == source_run.user_message_id,
                    AgentMessage.conversation_id == source_run.conversation_id,
                )
            )
            if source_message is None:
                raise LookupError("message_not_found")
            source_metadata = dict(source_message.metadata_json)
            if (
                source_metadata.get("hidden_from_user") is not True
                or source_metadata.get("trusted_system_trigger") is not True
            ):
                raise RuntimeError("run_not_system_trigger")

            conversation = await session.scalar(
                select(AgentConversation)
                .where(
                    AgentConversation.id == source_run.conversation_id,
                    AgentConversation.organization_id == organization_id,
                    AgentConversation.project_id == project_id,
                    AgentConversation.archived_at.is_(None),
                )
                .with_for_update()
            )
            if conversation is None:
                raise LookupError("conversation_not_found")

            retry_request_id = f"system-retry:{source_run.id}"
            existing = await session.scalar(
                select(AgentMessage).where(
                    AgentMessage.conversation_id == source_run.conversation_id,
                    AgentMessage.client_request_id == retry_request_id,
                )
            )
            if existing is not None:
                existing_run = await session.scalar(
                    select(AgentRun).where(AgentRun.user_message_id == existing.id)
                )
                if existing_run is None:
                    raise RuntimeError("duplicate message has no run")
                return existing, existing_run

            active = await session.scalar(
                select(AgentRun.id).where(
                    AgentRun.conversation_id == conversation.id,
                    AgentRun.status.in_(ACTIVE_RUN_STATUSES),
                )
            )
            if active is not None:
                raise RuntimeError("active_run")

            message_id, run_id = str(uuid4()), str(uuid4())
            metadata = sanitize_agent_data({
                **source_metadata,
                "retry_of_run_id": source_run.id,
            })
            message = AgentMessage(
                id=message_id,
                conversation_id=conversation.id,
                run_id=run_id,
                parent_message_id=conversation.active_message_id,
                role="user",
                content=source_message.content,
                metadata_json=metadata,
                client_request_id=retry_request_id,
            )
            run = AgentRun(
                id=run_id,
                conversation_id=conversation.id,
                user_message_id=message_id,
                workflow_id=f"agent:{run_id}",
                status="queued",
                limits_json=limits,
            )
            dispatch = AgentWorkflowDispatch(
                run_id=run_id,
                workflow_id=run.workflow_id,
                task_payload={"run_id": run_id, "limits": limits},
                status="pending",
            )
            session.add_all([message, run, dispatch])
            await session.flush()
            conversation.active_message_id = message.id
            conversation.updated_at = datetime.now(UTC)
            try:
                await session.commit()
            except IntegrityError as exc:
                await session.rollback()
                raise RuntimeError("active_run") from exc
            await session.refresh(message)
            await session.refresh(run)
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
        async with self.sessions() as session:
            conversation = await session.scalar(
                select(AgentConversation).where(
                    AgentConversation.id == conversation_id,
                    AgentConversation.organization_id == organization_id,
                    AgentConversation.project_id == project_id,
                ).with_for_update()
            )
            if conversation is None:
                raise LookupError("conversation_not_found")
            existing_event = await session.scalar(
                select(AgentConversationEvent).where(
                    AgentConversationEvent.conversation_id == conversation_id,
                    AgentConversationEvent.client_request_id == client_request_id,
                )
            )
            if existing_event is not None:
                if existing_event.event_type != "edit" or not existing_event.new_leaf_id:
                    raise RuntimeError("idempotency_conflict")
                existing = await session.get(
                    AgentMessage, existing_event.new_leaf_id
                )
                if existing is None:
                    raise RuntimeError("edit event has no replacement message")
                normalized_content = sanitize_text(content.strip())[:20_000]
                if (
                    existing_event.target_message_id != message_id
                    or existing.content != normalized_content
                ):
                    raise RuntimeError("idempotency_conflict")
                run = await session.scalar(
                    select(AgentRun).where(AgentRun.user_message_id == existing.id)
                )
                if run is None:
                    raise RuntimeError("duplicate message has no run")
                return existing, run
            existing_message = await session.scalar(
                select(AgentMessage.id).where(
                    AgentMessage.conversation_id == conversation_id,
                    AgentMessage.client_request_id == client_request_id,
                )
            )
            if existing_message is not None:
                raise RuntimeError("idempotency_conflict")
            messages = list((await session.scalars(
                select(AgentMessage)
                .where(AgentMessage.conversation_id == conversation_id)
                .order_by(AgentMessage.created_at, AgentMessage.id)
            )).all())
            has_branch_event = await session.scalar(
                select(AgentConversationEvent.id)
                .where(AgentConversationEvent.conversation_id == conversation_id)
                .limit(1)
            ) is not None
            if not has_branch_event:
                _materialize_legacy_message_chain(messages)
            active_messages = await self._active_messages(
                session, conversation, messages
            )
            target = next((
                item for item in active_messages
                if item.id == message_id and item.role == "user"
            ), None)
            if target is None:
                exists = any(
                    item.id == message_id and item.role == "user"
                    for item in messages
                )
                if exists:
                    raise RuntimeError("message_not_active")
                raise LookupError("message_not_found")
            active = await session.scalar(select(AgentRun.id).where(
                AgentRun.conversation_id == conversation_id,
                AgentRun.status.in_(ACTIVE_RUN_STATUSES),
            ))
            if active is not None:
                raise RuntimeError(f"active_run:{active}")

            replacement_id, run_id = str(uuid4()), str(uuid4())
            target_index = active_messages.index(target)
            branch_parent_id = (
                target.parent_message_id
                or (
                    active_messages[target_index - 1].id
                    if target_index > 0
                    else None
                )
            )
            original_page_context = dict(target.metadata_json).get("page_context")
            replacement = AgentMessage(
                id=replacement_id,
                conversation_id=conversation_id,
                parent_message_id=branch_parent_id,
                run_id=run_id,
                role="user",
                content=sanitize_text(content.strip())[:20_000],
                metadata_json=sanitize_agent_data(
                    {"page_context": original_page_context}
                    if original_page_context else {}
                ),
                client_request_id=client_request_id,
            )
            run = AgentRun(
                id=run_id,
                conversation_id=conversation_id,
                user_message_id=replacement_id,
                workflow_id=f"agent:{run_id}",
                status="queued",
                limits_json=limits,
            )
            dispatch = AgentWorkflowDispatch(
                run_id=run_id,
                workflow_id=run.workflow_id,
                task_payload={"run_id": run_id, "limits": limits},
                status="pending",
            )
            previous_leaf_id = conversation.active_message_id
            session.add_all([replacement, run, dispatch])
            await session.flush()
            session.add(AgentConversationEvent(
                id=str(uuid4()),
                conversation_id=conversation_id,
                event_type="edit",
                target_message_id=target.id,
                previous_leaf_id=previous_leaf_id,
                new_leaf_id=replacement.id,
                client_request_id=client_request_id,
                metadata_json={
                    "replacement_message_id": replacement.id,
                    "page_context_preserved": bool(original_page_context),
                    "business_state_unchanged": True,
                },
            ))
            conversation.active_message_id = replacement.id
            replacement_path = [
                *active_messages[:target_index], replacement
            ]
            conversation.title = _conversation_title(replacement_path)
            conversation.updated_at = datetime.now(UTC)
            await session.execute(delete(AgentConversationSummary).where(
                AgentConversationSummary.conversation_id == conversation_id
            ))
            try:
                await session.commit()
            except IntegrityError as exc:
                await session.rollback()
                raise RuntimeError("active_run") from exc
            await session.refresh(replacement)
            await session.refresh(run)
            return replacement, run

    @retry_database_read
    async def get_run_scoped(
        self, organization_id: str, project_id: str, run_id: str
    ) -> AgentRun | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(AgentRun).join(AgentConversation).where(
                    AgentRun.id == run_id,
                    AgentConversation.organization_id == organization_id,
                    AgentConversation.project_id == project_id,
                )
            )

    @retry_database_read
    async def get_run(self, run_id: str) -> AgentRun | None:
        async with self.sessions() as session:
            return await session.get(AgentRun, run_id)

    @retry_database_read
    async def get_run_context(self, run_id: str) -> dict[str, Any]:
        async with self.sessions() as session:
            row = (await session.execute(
                select(AgentRun, AgentConversation, AgentMessage, Project)
                .join(AgentConversation, AgentConversation.id == AgentRun.conversation_id)
                .join(AgentMessage, AgentMessage.id == AgentRun.user_message_id)
                .join(Project, Project.id == AgentConversation.project_id)
                .where(AgentRun.id == run_id)
            )).one()
            run, conversation, message, project = row
            all_messages = list((await session.scalars(
                select(AgentMessage).where(
                    AgentMessage.conversation_id == conversation.id,
                ).order_by(AgentMessage.created_at, AgentMessage.id)
            )).all())
            has_branch_event = await session.scalar(
                select(AgentConversationEvent.id)
                .where(AgentConversationEvent.conversation_id == conversation.id)
                .limit(1)
            ) is not None
            history = _message_path(
                all_messages,
                message.id,
                allow_legacy_linear=not has_branch_event,
            )
            if message not in history:
                raise RuntimeError("run_message_not_on_branch")
            memory = await session.get(AgentProjectMemory, conversation.project_id)
            summary = await session.get(AgentConversationSummary, conversation.id)
            research = list((await session.scalars(
                select(AgentResearchRecord).where(
                    AgentResearchRecord.project_id == conversation.project_id,
                    AgentResearchRecord.created_at >= datetime.now(UTC) - timedelta(days=90),
                ).order_by(AgentResearchRecord.created_at.desc()).limit(20)
            )).all())
        recent_tokens = max(1_024, int(dict(run.limits_json).get("recent_tokens", 5_000)))
        through = summary.through_message_count if summary else 0
        unsummarized = history[through:]
        compactable_count = _token_bounded_compactable_message_count(
            unsummarized, recent_tokens
        )
        force_compactable_count = _safe_compactable_message_count(unsummarized, 2)
        compactable = unsummarized[:compactable_count]
        force_compactable = unsummarized[:force_compactable_count]
        all_memory_facts = _ensure_memory_fact_ids(
            list(memory.facts_json) if memory else []
        )
        visible_memory_facts = _bounded_memory_context(all_memory_facts)
        return {
            "run_id": run.id, "organization_id": conversation.organization_id,
            "project_id": conversation.project_id, "conversation_id": conversation.id,
            "active_message_id": conversation.active_message_id,
            "status": run.status, "created_at": run.created_at,
            "messages": [
                {"role": item.role, "content": item.content, "metadata": item.metadata_json}
                for item in unsummarized
            ],
            "compactable_messages": [
                {"role": item.role, "content": item.content} for item in compactable
            ],
            "compactable_through_count": through + compactable_count,
            "force_compactable_messages": [
                {"role": item.role, "content": item.content} for item in force_compactable
            ],
            "force_compactable_through_count": through + force_compactable_count,
            "conversation_summary": summary.content if summary else "",
            "project": {
                "id": project.id, "name": project.name, "domain": project.domain,
                "country": project.country, "language": project.language,
            },
            "project_memory": visible_memory_facts,
            "project_memory_catalog": _memory_context_catalog(
                all_memory_facts, visible_memory_facts
            ),
            "research_records": _bounded_context_items(
                [self._research_context(item) for item in research],
                RESEARCH_CONTEXT_TOKENS,
            ),
            "limits": dict(run.limits_json),
        }

    @retry_database_read
    async def search_project_memory(
        self,
        project_id: str,
        *,
        query: str = "",
        category: str | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> dict[str, Any]:
        async with self.sessions() as session:
            memory = await session.get(AgentProjectMemory, project_id)
        facts = _ensure_memory_fact_ids(list(memory.facts_json) if memory else [])
        normalized_query = "".join(query.casefold().split())
        matched = [
            fact for fact in facts
            if (category is None or fact.get("category") == category)
            and (
                not normalized_query
                or normalized_query in "".join(
                    str(fact.get("value", "")).casefold().split()
                )
            )
        ]
        ranked = sorted(
            enumerate(matched),
            key=lambda item: (
                MEMORY_SOURCE_PRIORITIES.get(str(item[1].get("source")), 0),
                item[0],
            ),
            reverse=True,
        )
        ordered = [fact for _, fact in ranked]
        start = (page - 1) * page_size
        return sanitize_agent_data({
            "items": ordered[start:start + page_size],
            "total": len(ordered),
            "page": page,
            "page_size": page_size,
            "next_page": page + 1 if start + page_size < len(ordered) else None,
        })

    @retry_database_read
    async def latest_run_for_conversation(self, conversation_id: str) -> AgentRun | None:
        async with self.sessions() as session:
            conversation = await session.get(AgentConversation, conversation_id)
            if conversation is None:
                return None
            messages = list((await session.scalars(
                select(AgentMessage)
                .where(AgentMessage.conversation_id == conversation_id)
                .order_by(AgentMessage.created_at, AgentMessage.id)
            )).all())
            active_messages = await self._active_messages(
                session, conversation, messages
            )
            user_message = next((
                item for item in reversed(active_messages)
                if item.role == "user" and item.run_id
            ), None)
            return await session.get(AgentRun, user_message.run_id) if user_message else None

    @retry_database_read
    async def action_for_run(self, run_id: str) -> AgentAction | None:
        async with self.sessions() as session:
            return await session.scalar(select(AgentAction).where(AgentAction.run_id == run_id))

    @retry_database_read
    async def get_action_scoped(
        self, organization_id: str, project_id: str, action_id: str
    ) -> AgentAction | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(AgentAction).join(AgentRun).join(AgentConversation).where(
                    AgentAction.id == action_id,
                    AgentConversation.organization_id == organization_id,
                    AgentConversation.project_id == project_id,
                )
            )

    async def decide_action(
        self, organization_id: str, project_id: str, action_id: str, decision: str,
        parameters_hash: str | None = None, decided_by: str = "local-user",
    ) -> AgentAction:
        async with self.sessions() as session:
            action = await session.scalar(
                select(AgentAction).join(AgentRun).join(AgentConversation).where(
                    AgentAction.id == action_id,
                    AgentConversation.organization_id == organization_id,
                    AgentConversation.project_id == project_id,
                ).with_for_update()
            )
            if action is None:
                raise LookupError("action_not_found")
            if action.status in {"approved", "rejected", "executing", "completed"}:
                return action
            run = await session.get(AgentRun, action.run_id)
            if run is None or run.status in TERMINAL_RUN_STATUSES:
                raise RuntimeError("run_terminal")
            if action.status != "pending" or action.expires_at <= datetime.now(UTC):
                if action.status == "pending":
                    action.status = "expired"
                    await session.commit()
                raise RuntimeError("action_expired")
            if parameters_hash is not None and action.parameters_hash != parameters_hash:
                raise RuntimeError("hash_conflict")
            action.status = decision
            action.decision_at = datetime.now(UTC)
            action.decided_by = decided_by
            await session.commit()
            await session.refresh(action)
            return action

    async def set_run_status(
        self, run_id: str, status: str, *, error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        async with self.sessions() as session:
            run = await session.get(AgentRun, run_id)
            if run is None:
                return
            if run.status in TERMINAL_RUN_STATUSES:
                return
            run.status = status
            run.error_code, run.error_message = error_code, error_message
            now = datetime.now(UTC)
            if status == "running" and run.started_at is None:
                run.started_at = now
            if status in TERMINAL_RUN_STATUSES:
                run.finished_at = now
            await session.commit()

    async def cancel_run(self, run_id: str) -> None:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            run = await session.scalar(
                select(AgentRun).where(AgentRun.id == run_id).with_for_update()
            )
            if run is None or run.status in TERMINAL_RUN_STATUSES:
                return
            dispatch = await session.scalar(
                select(AgentWorkflowDispatch)
                .where(AgentWorkflowDispatch.run_id == run_id)
                .with_for_update()
            )
            if dispatch is not None and dispatch.status == "pending":
                dispatch.status = "cancelled"
                dispatch.updated_at = now
            conversation = await session.scalar(
                select(AgentConversation)
                .where(AgentConversation.id == run.conversation_id)
                .with_for_update()
            )
            executions = list((await session.scalars(
                select(AgentToolExecution).where(
                    AgentToolExecution.run_id == run_id,
                    AgentToolExecution.status.in_({"claimed", "executing", "verifying", "completed"}),
                ).with_for_update()
            )).all())
            active_business_tasks = [
                {
                    "tool": item.tool_name,
                    "status": item.result_json.get("status"),
                    "run_id": item.result_json.get("run_id"),
                }
                for item in executions
                if item.status == "completed"
            ]
            in_flight_operations = [
                {"tool": item.tool_name, "status": item.status}
                for item in executions
                if item.status in {"claimed", "executing", "verifying"}
            ]
            for execution in executions:
                if execution.status in {"claimed", "executing", "verifying"}:
                    execution.lease_expires_at = now
            running_steps = list((await session.scalars(
                select(AgentRunStep).where(
                    AgentRunStep.run_id == run_id,
                    AgentRunStep.status == "running",
                ).with_for_update()
            )).all())
            for step in running_steps:
                step.status = "cancelled"
                step.error_code = "user_cancelled"
                step.error_message = "用户已停止本次任务"
                step.finished_at = now
            run.current_step += 1
            session.add(AgentRunStep(
                id=str(uuid4()), run_id=run.id, sequence=run.current_step,
                step_type="cancellation", name="user_cancelled",
                input_json={}, output_json={
                    "completed_operations": active_business_tasks,
                    "in_flight_operations": in_flight_operations,
                },
                status="cancelled", duration_ms=0, finished_at=now,
            ))
            if active_business_tasks:
                content = (
                    "已停止 Agent 继续执行。已有业务操作完成或提交，无法自动撤回，"
                    "请查看项目中的真实状态。"
                )
            elif in_flight_operations:
                content = (
                    "已停止 Agent 后续操作。当前操作可能已经提交，无法保证撤回，"
                    "请查看项目中的真实状态。"
                )
            else:
                content = "已停止本次任务，没有开始新的操作。"
            cancellation_message = AgentMessage(
                id=(message_id := str(uuid4())),
                conversation_id=run.conversation_id,
                parent_message_id=(conversation.active_message_id if conversation else None),
                run_id=run.id,
                role="assistant", content=content,
                metadata_json={
                    "cancelled": True,
                    "completed_operations": active_business_tasks,
                    "in_flight_operations": in_flight_operations,
                },
            )
            session.add(cancellation_message)
            await session.flush()
            if conversation is not None:
                conversation.active_message_id = message_id
                conversation.updated_at = now
            run.status = "cancelled"
            run.error_code = "user_cancelled"
            run.error_message = "用户已停止本次任务"
            run.finished_at = now
            await session.commit()

    async def add_step(
        self,
        run_id: str,
        step_type: str,
        name: str,
        input_json: dict,
        output_json: dict,
        duration_ms: int,
        *,
        status: str = "completed",
        error_code: str | None = None,
        error_message: str | None = None,
        usage: dict[str, Any] | None = None,
    ) -> None:
        step_id = await self.start_step(run_id, step_type, name, input_json)
        if step_id is None:
            return
        await self.finish_step(
            step_id,
            output_json,
            duration_ms,
            status=status,
            error_code=error_code,
            error_message=error_message,
            usage=usage,
        )

    async def start_step(
        self,
        run_id: str,
        step_type: str,
        name: str,
        input_json: dict,
    ) -> str | None:
        async with self.sessions() as session:
            run = await session.scalar(select(AgentRun).where(AgentRun.id == run_id).with_for_update())
            if run is None or run.status in TERMINAL_RUN_STATUSES:
                return None
            run.current_step += 1
            step_id = str(uuid4())
            session.add(AgentRunStep(
                id=step_id, run_id=run_id, sequence=run.current_step, step_type=step_type,
                name=name, input_json=sanitize_agent_data(input_json),
                output_json={}, status="running",
            ))
            await session.commit()
            return step_id

    async def finish_step(
        self,
        step_id: str,
        output_json: dict,
        duration_ms: int,
        *,
        status: str = "completed",
        error_code: str | None = None,
        error_message: str | None = None,
        usage: dict[str, Any] | None = None,
    ) -> None:
        async with self.sessions() as session:
            run_id = await session.scalar(
                select(AgentRunStep.run_id).where(AgentRunStep.id == step_id)
            )
            if run_id is None:
                return
            run = await session.scalar(
                select(AgentRun).where(AgentRun.id == run_id).with_for_update()
            )
            step = await session.scalar(
                select(AgentRunStep).where(AgentRunStep.id == step_id).with_for_update()
            )
            if (
                run is None
                or run.status in TERMINAL_RUN_STATUSES
                or step is None
                or step.status != "running"
            ):
                return
            step.output_json = sanitize_agent_data(output_json)
            step.status = status
            step.duration_ms = duration_ms
            step.error_code = error_code
            step.error_message = sanitize_text(error_message or "")[:1000] or None
            step.input_tokens = (usage or {}).get("input_tokens")
            step.output_tokens = (usage or {}).get("output_tokens")
            step.total_tokens = (usage or {}).get("total_tokens")
            step.cost = (usage or {}).get("cost")
            step.cost_currency = (usage or {}).get("cost_currency")
            step.finished_at = datetime.now(UTC)
            await session.commit()

    @retry_database_read
    async def run_steps(self, run_id: str) -> list[AgentRunStep]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(AgentRunStep)
                        .where(AgentRunStep.run_id == run_id)
                        .order_by(AgentRunStep.sequence)
                    )
                ).all()
            )

    @retry_database_read
    async def completion_evidence(self, run_id: str) -> dict[str, Any]:
        async with self.sessions() as session:
            row = (await session.execute(
                select(AgentRun, AgentConversation, Project)
                .join(AgentConversation, AgentConversation.id == AgentRun.conversation_id)
                .join(Project, Project.id == AgentConversation.project_id)
                .where(AgentRun.id == run_id)
            )).one()
            run, conversation, project = row
            all_steps = list((await session.scalars(
                select(AgentRunStep)
                .where(AgentRunStep.run_id == run_id)
                .order_by(AgentRunStep.sequence)
            )).all())
            executions = list((await session.scalars(
                select(AgentToolExecution)
                .where(AgentToolExecution.run_id == run_id)
                .order_by(
                    AgentToolExecution.round_number,
                    AgentToolExecution.call_number,
                    AgentToolExecution.tool_call_id,
                )
            )).all())

        steps = all_steps[-COMPLETION_EVIDENCE_STEPS:]
        failed_steps = [item for item in all_steps if item.status == "failed"]
        status_counts: dict[str, int] = {}
        error_counts: dict[str, int] = {}
        tool_rollup: dict[str, dict[str, Any]] = {}
        verified_true = 0
        verified_false = 0
        already_completed = 0
        for execution in executions:
            status_counts[execution.status] = status_counts.get(execution.status, 0) + 1
            if execution.error_code:
                error_counts[execution.error_code] = error_counts.get(execution.error_code, 0) + 1
            data = _execution_result_data(execution)
            if data.get("verified") is True:
                verified_true += 1
            elif data.get("verified") is False:
                verified_false += 1
            if data.get("already_completed") is True:
                already_completed += 1
            rollup = tool_rollup.setdefault(execution.tool_name, {
                "total": 0,
                "completed": 0,
                "failed": 0,
                "active": 0,
                "verified_true": 0,
                "verified_false": 0,
                "last_status": execution.status,
                "last_round": execution.round_number,
            })
            rollup["total"] += 1
            if execution.status == "completed":
                rollup["completed"] += 1
            elif execution.status == "failed":
                rollup["failed"] += 1
            elif execution.status in ACTIVE_TOOL_EXECUTION_STATUSES:
                rollup["active"] += 1
            if data.get("verified") is True:
                rollup["verified_true"] += 1
            elif data.get("verified") is False:
                rollup["verified_false"] += 1
            rollup["last_status"] = execution.status
            rollup["last_round"] = execution.round_number

        selected_executions = executions[-COMPLETION_EVIDENCE_EXECUTIONS:]
        selected_ids = {item.tool_call_id for item in selected_executions}
        omitted_status_counts: dict[str, int] = {}
        omitted_error_counts: dict[str, int] = {}
        for execution in executions:
            if execution.tool_call_id in selected_ids:
                continue
            omitted_status_counts[execution.status] = (
                omitted_status_counts.get(execution.status, 0) + 1
            )
            if execution.error_code:
                omitted_error_counts[execution.error_code] = (
                    omitted_error_counts.get(execution.error_code, 0) + 1
                )

        repeated_groups: dict[tuple[str, str], list[AgentToolExecution]] = {}
        for execution in executions:
            repeated_groups.setdefault(
                (execution.tool_name, execution.parameters_hash), []
            ).append(execution)
        notable_groups: list[dict[str, Any]] = []
        recovered_group_count = 0
        unresolved_group_count = 0
        for (tool_name, parameters_hash), group in repeated_groups.items():
            if len(group) < 2:
                continue
            last = group[-1]
            earlier_failed = any(item.status == "failed" for item in group[:-1])
            recovered = earlier_failed and last.status == "completed"
            unresolved = last.status != "completed" or (
                _execution_result_data(last).get("verified") is False
            )
            recovered_group_count += int(recovered)
            unresolved_group_count += int(unresolved)
            if recovered or unresolved:
                statuses = [item.status for item in group]
                bounded_statuses = statuses
                if len(statuses) > COMPLETION_REPEATED_STATUSES:
                    bounded_statuses = [
                        statuses[0],
                        *statuses[-(COMPLETION_REPEATED_STATUSES - 1):],
                    ]
                outcome = {
                    "tool": tool_name,
                    "arguments_hash": parameters_hash,
                    "attempts": len(group),
                    "statuses": bounded_statuses,
                    "last_round": last.round_number,
                    "final_status": last.status,
                    "final_verified": _execution_result_data(last).get("verified"),
                    "recovered_after_failure": recovered,
                }
                if len(bounded_statuses) < len(statuses):
                    outcome["statuses_omitted"] = len(statuses) - len(bounded_statuses)
                notable_groups.append(outcome)
        notable_groups = notable_groups[-COMPLETION_EVIDENCE_EXECUTIONS:]

        verification_results = [
            {
                "tool": item.tool_name,
                "status": item.status,
                "verified": _execution_result_data(item).get("verified"),
                "already_completed": _execution_result_data(item).get(
                    "already_completed", False
                ),
                "business_run_id": _execution_result_data(item).get("run_id"),
                "business_status": _execution_result_data(item).get("status"),
                "error_code": item.error_code,
            }
            for item in selected_executions
            if item.status in {"verifying", "completed", "failed"}
        ]
        unfinished = [
            {
                "tool": item.tool_name,
                "status": item.status,
                "error_code": item.error_code,
            }
            for item in executions
            if item.status in ACTIVE_TOOL_EXECUTION_STATUSES
        ]
        latest_fact_by_operation: dict[str, dict[str, Any]] = {}
        for item in executions:
            fact = _completion_fact(item)
            if fact is None:
                continue
            fact_key = str(
                fact.get("operation_id")
                or fact.get("run_id")
                or f"{item.tool_name}:{item.parameters_hash}"
            )
            latest_fact_by_operation[fact_key] = fact
        all_completion_facts = list(latest_fact_by_operation.values())
        incomplete_facts = [
            fact for fact in all_completion_facts if _completion_fact_is_incomplete(fact)
        ]
        selected_completion_facts: list[dict[str, Any]] = []
        selected_fact_ids: set[str] = set()
        for fact in [*reversed(incomplete_facts), *reversed(all_completion_facts)]:
            fact_id = str(fact["tool_call_id"])
            if fact_id in selected_fact_ids:
                continue
            selected_completion_facts.append(fact)
            selected_fact_ids.add(fact_id)
            if len(selected_completion_facts) >= COMPLETION_EVIDENCE_EXECUTIONS:
                break
        selected_completion_facts.reverse()
        return sanitize_agent_data({
            "run": {
                "status": run.status,
                "error_code": run.error_code,
                "current_step": run.current_step,
            },
            "run_steps": [
                {
                    "sequence": item.sequence,
                    "type": item.step_type,
                    "name": item.name,
                    "status": item.status,
                    "error_code": item.error_code,
                    "error_message": item.error_message,
                    "duration_ms": item.duration_ms,
                }
                for item in steps
            ],
            "retry_summary": {
                "failed_model_attempts": sum(
                    item.step_type == "model" for item in failed_steps
                ),
                "failed_tool_attempts": sum(
                    item.step_type == "tool" for item in failed_steps
                ),
                "failed_steps": len(failed_steps),
            },
            "execution_summary": {
                "total": len(executions),
                "by_status": status_counts,
                "error_codes": error_counts,
                "verified_true": verified_true,
                "verified_false": verified_false,
                "already_completed": already_completed,
                "by_tool": tool_rollup,
            },
            "evidence_selection": {
                "policy": "latest_details_with_complete_rollups_and_unresolved_facts_first",
                "included": len(selected_executions),
                "omitted": len(executions) - len(selected_executions),
                "omitted_by_status": omitted_status_counts,
                "omitted_error_codes": omitted_error_counts,
            },
            "repeated_call_outcomes": {
                "recovered_after_failure": recovered_group_count,
                "unresolved": unresolved_group_count,
                "notable_groups": notable_groups,
            },
            "tool_evidence": [
                _completion_tool_evidence(item) for item in selected_executions
            ],
            "display_events": _completion_display_events(all_steps, executions),
            "completion_fact_summary": {
                "distinct_operations": len(all_completion_facts),
                "incomplete_operations": len(incomplete_facts),
                "included": len(selected_completion_facts),
                "omitted": len(all_completion_facts) - len(selected_completion_facts),
            },
            "completion_facts": selected_completion_facts,
            "verification_results": verification_results,
            "project_state": {
                "id": project.id,
                "name": project.name,
                "domain": project.domain,
                "understanding_run_id": project.understanding_run_id,
                "audit_run_id": project.audit_run_id,
                "audit_health": project.audit_health,
            },
            "unfinished": unfinished,
            "project_id": conversation.project_id,
        })

    @retry_database_read
    async def run_usage(self, run_id: str) -> dict[str, int | float]:
        async with self.sessions() as session:
            rows = list((await session.scalars(
                select(AgentRunStep).where(AgentRunStep.run_id == run_id)
            )).all())
        direct_tool_cost = sum(
            float(item.cost or 0) for item in rows if item.step_type == "tool"
        )
        return {
            "model_calls": sum(item.name == "chat.completions" for item in rows),
            "tool_calls": sum(item.step_type == "tool" for item in rows),
            "total_tokens": sum(item.total_tokens or 0 for item in rows),
            "model_cost": sum(float(item.cost or 0) for item in rows if item.step_type == "model"),
            "tool_cost": round(direct_tool_cost + _downstream_billing_cost(rows), 8),
        }

    async def reserve_paid_tool_budget(
        self,
        run_id: str,
        tool_call_id: str,
        tool_name: str,
        reserve_usd: float,
        limit_usd: float,
    ) -> dict[str, Any]:
        reserve = max(float(reserve_usd), 0.0)
        limit = max(float(limit_usd), 0.0)
        async with self.sessions() as session:
            run = await session.scalar(
                select(AgentRun).where(AgentRun.id == run_id).with_for_update()
            )
            if run is None or run.status in TERMINAL_RUN_STATUSES:
                return {
                    "allowed": False,
                    "projected_cost": 0.0,
                    "limit": limit,
                }
            rows = list((await session.scalars(
                select(AgentRunStep).where(AgentRunStep.run_id == run_id)
            )).all())
            reservations = [
                item for item in rows
                if item.step_type == "budget"
                and item.name == "paid_tool_reservation"
            ]
            existing = next(
                (
                    item for item in reservations
                    if str(item.input_json.get("tool_call_id") or "") == tool_call_id
                ),
                None,
            )
            model_cost = sum(
                float(item.cost or 0)
                for item in rows
                if item.step_type == "model"
            )
            direct_tool_cost = sum(
                float(item.cost or 0)
                for item in rows
                if item.step_type == "tool"
            )
            billing_entries = _downstream_billing_entries(rows)
            known_tool_cost = direct_tool_cost + sum(
                float(entry["reported_cost_usd"])
                for entry in billing_entries.values()
            )
            unsettled_reservations = _unsettled_reservation_cost(
                reservations, billing_entries
            )
            projected_cost = (
                model_cost
                + known_tool_cost
                + unsettled_reservations
                + (0.0 if existing is not None else reserve)
            )
            allowed = existing is not None or projected_cost <= limit
            if allowed and existing is None:
                run.current_step += 1
                session.add(AgentRunStep(
                    id=str(uuid4()),
                    run_id=run_id,
                    sequence=run.current_step,
                    step_type="budget",
                    name="paid_tool_reservation",
                    input_json=sanitize_agent_data({
                        "tool_call_id": tool_call_id,
                        "tool_name": tool_name,
                        "reserve_usd": reserve,
                    }),
                    output_json={"allowed": True},
                    status="completed",
                    duration_ms=0,
                    finished_at=datetime.now(UTC),
                ))
                await session.commit()
            return {
                "allowed": allowed,
                "projected_cost": round(projected_cost, 8),
                "limit": limit,
            }

    async def save_conversation_summary(
        self,
        conversation_id: str,
        through_message_count: int,
        content: str,
        expected_active_message_id: str | None,
    ) -> bool:
        summary_content = sanitize_text(content)[:20_000]
        async with self.sessions() as session:
            conversation = await session.scalar(
                select(AgentConversation)
                .where(AgentConversation.id == conversation_id)
                .with_for_update()
            )
            if (
                conversation is None
                or conversation.active_message_id != expected_active_message_id
            ):
                return False
            statement = pg_insert(AgentConversationSummary).values(
                conversation_id=conversation_id,
                through_message_count=through_message_count,
                content=summary_content,
            )
            statement = statement.on_conflict_do_update(
                index_elements=[AgentConversationSummary.conversation_id],
                set_={
                    "through_message_count": statement.excluded.through_message_count,
                    "content": statement.excluded.content,
                    "updated_at": func.now(),
                },
                where=(
                    statement.excluded.through_message_count
                    > AgentConversationSummary.through_message_count
                ),
            )
            await session.execute(statement)
            await session.commit()
            return True

    async def save_context_updates(
        self,
        run_id: str,
        research: dict[str, Any] | None,
    ) -> None:
        if not research:
            return
        async with self.sessions() as session:
            row = (await session.execute(
                select(AgentRun, AgentConversation)
                .join(AgentConversation, AgentConversation.id == AgentRun.conversation_id)
                .where(AgentRun.id == run_id)
            )).one()
            _, conversation = row
            if research:
                tools = list(dict.fromkeys((await session.scalars(
                    select(AgentToolExecution.tool_name).where(
                        AgentToolExecution.run_id == run_id,
                        AgentToolExecution.status == "completed",
                    ).order_by(
                        AgentToolExecution.round_number,
                        AgentToolExecution.call_number,
                    )
                )).all()))
                statement = pg_insert(AgentResearchRecord).values(
                    id=str(uuid4()), project_id=conversation.project_id, run_id=run_id,
                    topic=sanitize_text(str(research.get("topic", "")))[:500],
                    input_scope_json=sanitize_agent_data(research.get("input_scope", {})),
                    conclusion=sanitize_text(str(research.get("conclusion", "")))[:2_000],
                    tools_json=tools,
                ).on_conflict_do_nothing(index_elements=["run_id"])
                await session.execute(statement)
            await session.commit()

    async def update_project_memory(
        self,
        run_id: str,
        operations: list[dict[str, Any]],
        *,
        tool_call_id: str | None = None,
        worker_id: str | None = None,
    ) -> dict[str, Any]:
        if (tool_call_id is None) != (worker_id is None):
            raise ValueError("工具调用编号和 Worker 编号必须同时提供")
        async with self.sessions() as session:
            row = (await session.execute(
                select(AgentRun, AgentConversation, AgentMessage)
                .join(AgentConversation, AgentConversation.id == AgentRun.conversation_id)
                .join(AgentMessage, AgentMessage.id == AgentRun.user_message_id)
                .where(AgentRun.id == run_id)
                .with_for_update(of=AgentRun)
            )).one()
            run, conversation, user_message = row
            execution = None
            if tool_call_id is not None:
                execution = await session.scalar(
                    select(AgentToolExecution).where(
                        AgentToolExecution.tool_call_id == tool_call_id
                    ).with_for_update()
                )
                if (
                    execution is None
                    or execution.run_id != run_id
                    or execution.tool_name != "update_project_memory"
                    or not _holds_active_tool_lease(execution, str(worker_id))
                ):
                    raise ToolExecutionLeaseLostError("工具执行权已经失效")
            await session.scalar(
                select(Project.id).where(
                    Project.id == conversation.project_id
                ).with_for_update()
            )
            memory = await session.scalar(
                select(AgentProjectMemory).where(
                    AgentProjectMemory.project_id == conversation.project_id
                ).with_for_update()
            )
            facts, applied = _apply_memory_operations(
                list(memory.facts_json) if memory else [],
                operations,
                user_message_id=run.user_message_id,
                user_message=user_message.content,
            )
            if memory is None:
                memory = AgentProjectMemory(
                    project_id=conversation.project_id,
                    organization_id=conversation.organization_id,
                    facts_json=facts,
                )
                session.add(memory)
            else:
                memory.facts_json = facts
            await session.flush()
            await session.refresh(memory, attribute_names=["facts_json"])
            verified_facts = _ensure_memory_fact_ids(list(memory.facts_json))
            result = sanitize_agent_data({
                "verified": verified_facts == facts,
                "applied": applied,
                "facts": _bounded_memory_context(verified_facts),
            })
            if not result["verified"]:
                raise RuntimeError("项目记忆保存后的校验失败")
            if execution is not None:
                full_result = sanitize_agent_data({
                    "tool_call_id": execution.model_tool_call_id,
                    "tool": "update_project_memory",
                    "arguments": dict(execution.arguments_json),
                    "ok": True,
                    "summary": (
                        f"项目记忆已保存并校验，共处理 {len(result.get('applied', []))} 项"
                    ),
                    "data": result,
                    "error_code": None,
                    "retryable": False,
                    "cost": 0.0,
                })
                compact_result = {
                    "tool_call_id": execution.model_tool_call_id,
                    "tool": "update_project_memory",
                    "ok": True,
                    "summary": full_result["summary"],
                    "data": {
                        "verified": bool(result.get("verified")),
                        "applied": list(result.get("applied", [])),
                    },
                    "error_code": None,
                    "retryable": False,
                    "cost": 0.0,
                }
                execution.status = "completed"
                execution.result_json = full_result
                execution.model_result_json = {
                    "once": full_result,
                    "long_term": compact_result,
                }
                execution.finished_at = datetime.now(UTC)
                execution.lease_expires_at = None
                if run.status not in TERMINAL_RUN_STATUSES:
                    run.status = "running"
            await session.commit()
        return result

    @staticmethod
    def _research_context(item: AgentResearchRecord) -> dict[str, Any]:
        age_days = max(0, (datetime.now(UTC) - item.created_at).days)
        return {
            "date": item.created_at.date().isoformat(),
            "age_days": age_days,
            "reuse_policy": (
                "reuse_before_refresh" if age_days <= 30 else "stale_offer_refresh"
            ),
            "topic": item.topic,
            "input_scope": dict(item.input_scope_json),
            "conclusion": item.conclusion,
            "tools": list(item.tools_json),
        }

    @retry_database_read
    async def has_step(self, run_id: str, step_type: str, name: str) -> bool:
        async with self.sessions() as session:
            return await session.scalar(
                select(AgentRunStep.id).where(
                    AgentRunStep.run_id == run_id,
                    AgentRunStep.step_type == step_type,
                    AgentRunStep.name == name,
                ).limit(1)
            ) is not None

    async def set_model_snapshot(self, run_id: str, snapshot: dict[str, Any]) -> None:
        async with self.sessions() as session:
            run = await session.get(AgentRun, run_id)
            if run is None or run.model_snapshot:
                return
            run.model_snapshot = snapshot
            await session.commit()

    async def create_action(self, run_id: str, tool_name: str, arguments: dict, before: dict, preview: dict, parameters_hash: str, expires_at: datetime) -> AgentAction:
        existing = await self.action_for_run(run_id)
        if existing is not None:
            return existing
        action_id = str(uuid4())
        action = AgentAction(
            id=action_id, run_id=run_id, tool_name=tool_name, status="pending",
            arguments_json=arguments, before_json=before, preview_json=preview,
            parameters_hash=parameters_hash, idempotency_key=f"agent:{action_id}:{tool_name}:v1",
            expires_at=expires_at,
        )
        async with self.sessions() as session:
            session.add(action)
            await session.commit()
            await session.refresh(action)
        return action

    async def update_action(self, action_id: str, status: str, result: dict | None = None) -> None:
        async with self.sessions() as session:
            action = await session.get(AgentAction, action_id)
            if action is None:
                return
            action.status = status
            if result is not None:
                action.result_json = result
            await session.commit()

    async def claim_tool_execution(
        self,
        *,
        run_id: str,
        tool_call_id: str,
        tool_name: str,
        idempotency_key: str,
        arguments: dict,
        before: dict,
        parameters_hash: str,
        worker_id: str,
        lease_seconds: int,
        model_tool_call_id: str | None = None,
        round_number: int = 0,
        call_number: int = 0,
    ) -> tuple[str, AgentToolExecution | None]:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            run = await session.scalar(
                select(AgentRun).where(AgentRun.id == run_id).with_for_update()
            )
            if run is None:
                return "missing", None
            if run.status in TERMINAL_RUN_STATUSES:
                return "cancelled" if run.status == "cancelled" else "terminal", None
            execution = await session.scalar(
                select(AgentToolExecution).where(
                    AgentToolExecution.idempotency_key == idempotency_key
                ).with_for_update()
            )
            if execution is not None and execution.status == "completed":
                return "completed", execution
            if (
                execution is not None
                and execution.status in {"claimed", "executing", "verifying"}
                and execution.lease_expires_at is not None
                and execution.lease_expires_at > now
                and execution.worker_id != worker_id
            ):
                return "busy", execution
            if execution is None:
                execution = AgentToolExecution(
                    tool_call_id=tool_call_id,
                    model_tool_call_id=model_tool_call_id or tool_call_id,
                    run_id=run_id,
                    round_number=round_number,
                    call_number=call_number,
                    tool_name=tool_name,
                    idempotency_key=idempotency_key,
                    arguments_json=sanitize_agent_data(arguments),
                    before_json=sanitize_agent_data(before),
                    parameters_hash=parameters_hash,
                )
                session.add(execution)
            execution.status = "executing"
            execution.worker_id = worker_id
            execution.lease_expires_at = now + timedelta(seconds=max(1, lease_seconds))
            execution.started_at = execution.started_at or now
            execution.error_code = None
            run.status = "executing"
            await session.commit()
            await session.refresh(execution)
            return "claimed", execution

    async def register_tool_calls(
        self,
        run_id: str,
        round_number: int,
        calls: list[dict[str, Any]],
        max_argument_bytes: int,
    ) -> list[dict[str, Any]]:
        total_bytes = sum(
            len(json.dumps(
                item.get("arguments", {}), ensure_ascii=False,
                sort_keys=True, separators=(",", ":"),
            ).encode())
            for item in calls
        )
        if total_bytes > max_argument_bytes:
            raise ValueError("本轮工具参数超过平台限制")

        refs: list[dict[str, Any]] = []
        async with self.sessions() as session:
            run = await session.scalar(
                select(AgentRun).where(AgentRun.id == run_id).with_for_update()
            )
            if run is None or run.status in TERMINAL_RUN_STATUSES:
                raise RuntimeError("run_is_terminal")
            for call_number, call in enumerate(calls, start=1):
                tool_name = str(call["tool"])
                model_call_id = str(
                    call.get("tool_call_id") or f"provider-tool-call-{call_number}"
                )[:200]
                internal_call_id = f"{run_id}:{round_number}:{call_number}"
                arguments = sanitize_agent_data(dict(call.get("arguments", {})))
                encoded = json.dumps(
                    arguments, ensure_ascii=False, sort_keys=True,
                    separators=(",", ":"),
                ).encode()
                parameters_hash = hashlib.sha256(encoded).hexdigest()
                execution = await session.get(AgentToolExecution, internal_call_id)
                if execution is None:
                    session.add(AgentToolExecution(
                        tool_call_id=internal_call_id,
                        model_tool_call_id=model_call_id,
                        run_id=run_id,
                        round_number=round_number,
                        call_number=call_number,
                        tool_name=tool_name,
                        idempotency_key=f"agent:{internal_call_id}:{tool_name}:v2",
                        status="pending",
                        arguments_json=arguments,
                        before_json={},
                        parameters_hash=parameters_hash,
                    ))
                elif (
                    execution.run_id != run_id
                    or execution.tool_name != tool_name
                    or execution.parameters_hash != parameters_hash
                ):
                    raise RuntimeError("工具调用记录与恢复数据不一致")
                refs.append({
                    "tool_call_id": internal_call_id,
                    "model_tool_call_id": model_call_id,
                    "tool": tool_name,
                    "arguments_hash": parameters_hash,
                })
            await session.commit()
        return refs

    @retry_database_read
    async def registered_tool_call_refs(
        self, run_id: str, round_number: int
    ) -> list[dict[str, Any]]:
        async with self.sessions() as session:
            executions = list((await session.scalars(
                select(AgentToolExecution).where(
                    AgentToolExecution.run_id == run_id,
                    AgentToolExecution.round_number == round_number,
                ).order_by(AgentToolExecution.call_number)
            )).all())
        return [
            {
                "tool_call_id": execution.tool_call_id,
                "model_tool_call_id": execution.model_tool_call_id,
                "tool": execution.tool_name,
                "arguments_hash": execution.parameters_hash,
            }
            for execution in executions
        ]

    async def finish_recovered_model_step(
        self,
        run_id: str,
        round_number: int,
        tool_calls: list[dict[str, Any]],
    ) -> int:
        now = datetime.now(UTC)
        finished = 0
        async with self.sessions() as session:
            steps = list((await session.scalars(
                select(AgentRunStep).where(
                    AgentRunStep.run_id == run_id,
                    AgentRunStep.step_type == "model",
                    AgentRunStep.name == "chat.completions",
                    AgentRunStep.status == "running",
                ).with_for_update()
            )).all())
            for step in steps:
                if int(dict(step.input_json).get("round", -1)) != round_number:
                    continue
                created_at = step.created_at
                if created_at.tzinfo is None:
                    created_at = created_at.replace(tzinfo=UTC)
                step.output_json = sanitize_agent_data({
                    "type": "tool_calls",
                    "tool_calls": tool_calls,
                    "recovered_from_persisted_calls": True,
                })
                step.status = "completed"
                step.duration_ms = max(
                    0, int((now - created_at).total_seconds() * 1_000)
                )
                step.finished_at = now
                finished += 1
            if finished:
                await session.commit()
        return finished

    @retry_database_read
    async def get_tool_execution(
        self, run_id: str, tool_call_id: str
    ) -> AgentToolExecution | None:
        async with self.sessions() as session:
            return await session.scalar(select(AgentToolExecution).where(
                AgentToolExecution.tool_call_id == tool_call_id,
                AgentToolExecution.run_id == run_id,
            ))

    async def claim_registered_tool(
        self,
        run_id: str,
        tool_call_id: str,
        worker_id: str,
        lease_seconds: int,
    ) -> tuple[str, AgentToolExecution | None]:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            run = await session.scalar(
                select(AgentRun).where(AgentRun.id == run_id).with_for_update()
            )
            if run is None:
                return "missing", None
            if run.status in TERMINAL_RUN_STATUSES:
                return "cancelled" if run.status == "cancelled" else "terminal", None
            execution = await session.scalar(
                select(AgentToolExecution).where(
                    AgentToolExecution.tool_call_id == tool_call_id,
                    AgentToolExecution.run_id == run_id,
                ).with_for_update()
            )
            if execution is None:
                return "missing", None
            if execution.status == "completed":
                return "completed", execution
            if (
                execution.status in {"claimed", "executing", "verifying"}
                and execution.lease_expires_at is not None
                and execution.lease_expires_at > now
                and execution.worker_id != worker_id
            ):
                return "busy", execution
            execution.status = "executing"
            execution.worker_id = worker_id
            execution.lease_expires_at = now + timedelta(seconds=max(1, lease_seconds))
            execution.started_at = execution.started_at or now
            execution.error_code = None
            run.status = "executing"
            await session.commit()
            await session.refresh(execution)
            return "claimed", execution

    async def save_tool_model_result(
        self, tool_call_id: str, model_result: dict[str, Any]
    ) -> None:
        async with self.sessions() as session:
            execution = await session.get(AgentToolExecution, tool_call_id)
            if execution is None or execution.status != "completed":
                return
            execution.model_result_json = sanitize_agent_data(model_result)
            await session.commit()

    async def renew_tool_lease(
        self,
        tool_call_id: str,
        worker_id: str,
        lease_seconds: int,
    ) -> bool:
        async with self.sessions() as session:
            execution = await session.scalar(
                select(AgentToolExecution).where(
                    AgentToolExecution.tool_call_id == tool_call_id
                ).with_for_update()
            )
            now = datetime.now(UTC)
            if not _holds_active_tool_lease(execution, worker_id, now=now):
                return False
            execution.lease_expires_at = now + timedelta(
                seconds=max(1, lease_seconds)
            )
            await session.commit()
            return True

    async def prepare_registered_tool(
        self,
        tool_call_id: str,
        worker_id: str,
        arguments: dict[str, Any],
        before: dict[str, Any],
        parameters_hash: str,
    ) -> None:
        async with self.sessions() as session:
            execution = await session.scalar(
                select(AgentToolExecution).where(
                    AgentToolExecution.tool_call_id == tool_call_id
                ).with_for_update()
            )
            if not _holds_active_tool_lease(execution, worker_id):
                raise ToolExecutionLeaseLostError("工具执行权已经失效")
            execution.arguments_json = sanitize_agent_data(arguments)
            execution.before_json = sanitize_agent_data(before)
            execution.parameters_hash = parameters_hash
            await session.commit()

    @retry_database_read
    async def tool_model_context(
        self, run_id: str, current_round: int
    ) -> dict[str, Any]:
        async with self.sessions() as session:
            run = await session.get(AgentRun, run_id)
            if run is None:
                raise LookupError("run_not_found")
            executions = list((await session.scalars(
                select(AgentToolExecution).where(
                    AgentToolExecution.run_id == run_id,
                    AgentToolExecution.round_number > run.tool_context_through_round,
                    AgentToolExecution.round_number < current_round,
                ).order_by(
                    AgentToolExecution.round_number,
                    AgentToolExecution.call_number,
                )
            )).all())
        previous_round = current_round - 1
        results = []
        for execution in executions:
            views = dict(execution.model_result_json)
            result = dict(
                views.get("once", {})
                if execution.round_number == previous_round
                else views.get("long_term", {})
            )
            if not result:
                result = {
                    "tool_call_id": execution.model_tool_call_id,
                    "tool": execution.tool_name,
                    "ok": False,
                    "summary": "工具调用在完成前中断，平台已记录为失败",
                    "data": {},
                    "error_code": "tool_execution_interrupted",
                    "retryable": True,
                }
            result["tool_batch_id"] = f"{run_id}:{execution.round_number}"
            result["result_ref"] = {"tool_call_id": execution.tool_call_id}
            result["arguments"] = (
                dict(execution.arguments_json)
                if execution.round_number == previous_round
                else {"sha256": execution.parameters_hash, "_compacted": True}
            )
            results.append(result)
        return {
            "summary": run.tool_context_summary,
            "through_round": run.tool_context_through_round,
            "results": results,
        }

    async def repair_interrupted_tool_calls(
        self, run_id: str, current_round: int
    ) -> int:
        now = datetime.now(UTC)
        repaired = 0
        async with self.sessions() as session:
            executions = list((await session.scalars(
                select(AgentToolExecution).where(
                    AgentToolExecution.run_id == run_id,
                    AgentToolExecution.round_number < current_round,
                    AgentToolExecution.status.in_(
                        {"pending", "claimed", "executing", "verifying"}
                    ),
                ).with_for_update()
            )).all())
            for execution in executions:
                if (
                    execution.status != "pending"
                    and execution.lease_expires_at is not None
                    and execution.lease_expires_at > now
                ):
                    continue
                output = sanitize_agent_data({
                    "tool_call_id": execution.model_tool_call_id,
                    "tool": execution.tool_name,
                    "arguments": dict(execution.arguments_json),
                    "ok": False,
                    "summary": "工具调用在完成前中断，平台已记录失败并允许 Agent 重新判断",
                    "data": {},
                    "error_code": "tool_execution_interrupted",
                    "retryable": True,
                    "cost": 0.0,
                })
                compact = {
                    key: output[key]
                    for key in (
                        "tool_call_id", "tool", "ok", "summary", "data",
                        "error_code", "retryable", "cost",
                    )
                }
                execution.status = "failed"
                execution.error_code = "tool_execution_interrupted"
                execution.result_json = output
                execution.model_result_json = {"once": output, "long_term": compact}
                execution.finished_at = now
                execution.lease_expires_at = None
                repaired += 1
            if repaired:
                run = await session.get(AgentRun, run_id)
                if run is not None and run.status not in TERMINAL_RUN_STATUSES:
                    run.status = "running"
                await session.commit()
        return repaired

    async def skip_registered_tool_calls(
        self, run_id: str, tool_call_ids: list[str], reason: str
    ) -> int:
        if not tool_call_ids:
            return 0
        now = datetime.now(UTC)
        skipped = 0
        async with self.sessions() as session:
            executions = list((await session.scalars(
                select(AgentToolExecution).where(
                    AgentToolExecution.run_id == run_id,
                    AgentToolExecution.tool_call_id.in_(tool_call_ids),
                ).with_for_update()
            )).all())
            for execution in executions:
                if execution.status != "pending":
                    continue
                output = sanitize_agent_data({
                    "tool_call_id": execution.model_tool_call_id,
                    "tool": execution.tool_name,
                    "arguments": dict(execution.arguments_json),
                    "ok": False,
                    "summary": reason,
                    "data": {},
                    "error_code": "tool_call_replanned",
                    "retryable": False,
                    "cost": 0.0,
                })
                compact = {
                    key: output[key]
                    for key in (
                        "tool_call_id", "tool", "ok", "summary", "data",
                        "error_code", "retryable", "cost",
                    )
                }
                execution.status = "failed"
                execution.error_code = "tool_call_replanned"
                execution.result_json = output
                execution.model_result_json = {"once": output, "long_term": compact}
                execution.finished_at = now
                skipped += 1
            if skipped:
                await session.commit()
        return skipped

    async def save_tool_context_summary(
        self, run_id: str, through_round: int, summary: str
    ) -> None:
        async with self.sessions() as session:
            run = await session.scalar(
                select(AgentRun).where(AgentRun.id == run_id).with_for_update()
            )
            if run is not None and through_round > run.tool_context_through_round:
                run.tool_context_summary = sanitize_text(summary)[:20_000]
                run.tool_context_through_round = through_round
                await session.commit()

    async def set_tool_verifying(self, tool_call_id: str, worker_id: str) -> None:
        async with self.sessions() as session:
            execution = await session.scalar(
                select(AgentToolExecution).where(
                    AgentToolExecution.tool_call_id == tool_call_id
                ).with_for_update()
            )
            if not _holds_active_tool_lease(execution, worker_id):
                raise ToolExecutionLeaseLostError("工具执行权已经失效")
            execution.status = "verifying"
            run = await session.get(AgentRun, execution.run_id)
            if run is not None and run.status not in TERMINAL_RUN_STATUSES:
                run.status = "verifying"
            await session.commit()

    async def complete_tool_execution(
        self, tool_call_id: str, worker_id: str, result: dict,
        model_result: dict | None = None,
    ) -> None:
        async with self.sessions() as session:
            execution = await session.scalar(
                select(AgentToolExecution).where(
                    AgentToolExecution.tool_call_id == tool_call_id
                ).with_for_update()
            )
            if not _holds_active_tool_lease(execution, worker_id):
                raise ToolExecutionLeaseLostError("工具执行权已经失效")
            execution.status = "completed"
            execution.result_json = sanitize_agent_data(result)
            execution.model_result_json = sanitize_agent_data(model_result or {})
            execution.finished_at = datetime.now(UTC)
            execution.lease_expires_at = None
            run = await session.get(AgentRun, execution.run_id)
            if run is not None and run.status not in TERMINAL_RUN_STATUSES:
                run.status = "running"
            await session.commit()

    async def fail_tool_execution(
        self, tool_call_id: str, worker_id: str, error_code: str,
        result: dict | None = None, model_result: dict | None = None,
    ) -> None:
        async with self.sessions() as session:
            execution = await session.scalar(
                select(AgentToolExecution).where(
                    AgentToolExecution.tool_call_id == tool_call_id
                ).with_for_update()
            )
            if not _holds_active_tool_lease(execution, worker_id):
                return
            if execution.status == "completed":
                return
            execution.status = "failed"
            execution.error_code = error_code
            if result is not None:
                execution.result_json = sanitize_agent_data(result)
            if model_result is not None:
                execution.model_result_json = sanitize_agent_data(model_result)
            execution.finished_at = datetime.now(UTC)
            execution.lease_expires_at = None
            run = await session.get(AgentRun, execution.run_id)
            if run is not None and run.status not in TERMINAL_RUN_STATUSES:
                run.status = "running"
            await session.commit()

    async def release_run_leases(self, run_id: str) -> None:
        async with self.sessions() as session:
            executions = list((await session.scalars(
                select(AgentToolExecution).where(
                    AgentToolExecution.run_id == run_id,
                    AgentToolExecution.status.in_({"claimed", "executing", "verifying"}),
                ).with_for_update()
            )).all())
            for execution in executions:
                execution.lease_expires_at = datetime.now(UTC)
            await session.commit()

    async def expire_action(self, action_id: str) -> AgentAction | None:
        async with self.sessions() as session:
            action = await session.scalar(
                select(AgentAction).where(AgentAction.id == action_id).with_for_update()
            )
            if (
                action is not None
                and action.status == "pending"
                and action.expires_at <= datetime.now(UTC)
            ):
                action.status = "expired"
                await session.commit()
                await session.refresh(action)
            return action

    async def append_assistant(self, run_id: str, content: str, metadata: dict | None = None) -> AgentMessage:
        async with self.sessions() as session:
            run = await session.scalar(
                select(AgentRun).where(AgentRun.id == run_id).with_for_update()
            )
            if run is None:
                raise LookupError("run_not_found")
            if run.status in {"cancelled", "failed", "expired"}:
                raise RuntimeError("run_is_terminal")
            conversation = await session.scalar(
                select(AgentConversation)
                .where(AgentConversation.id == run.conversation_id)
                .with_for_update()
            )
            message = AgentMessage(
                id=str(uuid4()), conversation_id=run.conversation_id,
                parent_message_id=(conversation.active_message_id if conversation else None),
                run_id=run_id,
                role="assistant", content=sanitize_text(content)[:8_000],
                metadata_json=sanitize_agent_data(metadata or {}),
            )
            session.add(message)
            await session.flush()
            if conversation is not None:
                conversation.active_message_id = message.id
                conversation.updated_at = datetime.now(UTC)
            await session.commit()
            await session.refresh(message)
            return message

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
        now = datetime.now(UTC)
        async with self.sessions() as session:
            run = await session.scalar(
                select(AgentRun).where(AgentRun.id == run_id).with_for_update()
            )
            if run is None or run.status in TERMINAL_RUN_STATUSES:
                return
            final_answer_chars = max(
                1, int(dict(run.limits_json).get("final_answer_chars", 8_000))
            )
            conversation = await session.scalar(
                select(AgentConversation)
                .where(AgentConversation.id == run.conversation_id)
                .with_for_update()
            )
            final_message_id = message_id or str(uuid4())
            final_message = AgentMessage(
                id=final_message_id,
                conversation_id=run.conversation_id, run_id=run.id,
                parent_message_id=(conversation.active_message_id if conversation else None),
                role="assistant", content=sanitize_text(content)[:final_answer_chars],
                metadata_json=sanitize_agent_data(metadata),
            )
            session.add(final_message)
            await session.flush()
            executions = list((await session.scalars(
                select(AgentToolExecution).where(
                    AgentToolExecution.run_id == run_id,
                    AgentToolExecution.status.in_({"claimed", "executing", "verifying"}),
                ).with_for_update()
            )).all())
            for execution in executions:
                execution.lease_expires_at = now
            if conversation is not None:
                conversation.active_message_id = final_message_id
                conversation.updated_at = now
            run.status = status
            run.error_code = error_code
            run.error_message = sanitize_text(error_message or "")[:1_000] or None
            run.finished_at = now
            await session.commit()

    @retry_database_read
    async def queued_runs(self, limit: int = 20) -> list[AgentRun]:
        async with self.sessions() as session:
            return list((await session.scalars(
                select(AgentRun).where(AgentRun.status == "queued").order_by(AgentRun.created_at).limit(limit)
            )).all())

    @retry_database_read
    async def list_pending_dispatches(self, limit: int = 20) -> list[AgentRun]:
        async with self.sessions() as session:
            return list((await session.scalars(
                select(AgentRun)
                .join(
                    AgentWorkflowDispatch,
                    AgentWorkflowDispatch.run_id == AgentRun.id,
                )
                .where(
                    AgentRun.status == "queued",
                    AgentWorkflowDispatch.status == "pending",
                    AgentWorkflowDispatch.next_attempt_at <= datetime.now(UTC),
                )
                .order_by(AgentWorkflowDispatch.created_at, AgentRun.id)
                .limit(max(1, min(limit, 100)))
            )).all())

    @asynccontextmanager
    async def pending_dispatch(
        self, run_id: str
    ) -> AsyncIterator[AgentRun | None]:
        async with self.sessions() as session:
            run = await session.scalar(
                select(AgentRun).where(AgentRun.id == run_id).with_for_update()
            )
            dispatch = await session.scalar(
                select(AgentWorkflowDispatch)
                .where(AgentWorkflowDispatch.run_id == run_id)
                .with_for_update()
            )
            if (
                run is None
                or run.status != "queued"
                or dispatch is None
                or dispatch.status != "pending"
                or dispatch.next_attempt_at > datetime.now(UTC)
            ):
                yield None
                return
            try:
                yield run
            except Exception:
                dispatch.attempts += 1
                dispatch.last_error = "Agent 服务暂时不可用，任务已保存并会自动重试"
                retry_delay = min(60, 2 ** min(dispatch.attempts, 6))
                dispatch.next_attempt_at = datetime.now(UTC) + timedelta(
                    seconds=retry_delay
                )
                dispatch.updated_at = datetime.now(UTC)
                await session.commit()
                raise
            else:
                now = datetime.now(UTC)
                dispatch.status = "dispatched"
                dispatch.last_error = None
                dispatch.dispatched_at = now
                dispatch.updated_at = now
                await session.commit()

    async def record_dispatch_failure(self, run_id: str, message: str) -> None:
        async with self.sessions() as session:
            dispatch = await session.scalar(
                select(AgentWorkflowDispatch)
                .where(AgentWorkflowDispatch.run_id == run_id)
                .with_for_update()
            )
            if dispatch is None or dispatch.status != "pending":
                return
            dispatch.attempts += 1
            dispatch.last_error = sanitize_text(message)[:1_000]
            retry_delay = min(60, 2 ** min(dispatch.attempts, 6))
            dispatch.next_attempt_at = datetime.now(UTC) + timedelta(
                seconds=retry_delay
            )
            dispatch.updated_at = datetime.now(UTC)
            await session.commit()

    @retry_database_read
    async def active_runs(self, limit: int = 100) -> list[AgentRun]:
        async with self.sessions() as session:
            return list((await session.scalars(
                select(AgentRun)
                .where(AgentRun.status.in_(ACTIVE_RUN_STATUSES))
                .order_by(AgentRun.created_at)
                .limit(limit)
            )).all())

    @retry_database_read
    async def operation_summary(
        self,
        organization_id: str,
        project_id: str | None,
        stuck_before: datetime,
        failed_since: datetime,
    ) -> dict[str, Any]:
        scope = [AgentConversation.organization_id == organization_id]
        if project_id is not None:
            scope.append(AgentConversation.project_id == project_id)
        async with self.sessions() as session:
            active_rows = (await session.execute(
                select(AgentRun.status, func.count())
                .join(AgentConversation)
                .where(*scope, AgentRun.status.in_(ACTIVE_RUN_STATUSES))
                .group_by(AgentRun.status)
            )).all()
            stuck = list((await session.scalars(
                select(AgentRun)
                .join(AgentConversation)
                .where(
                    *scope,
                    AgentRun.status.in_(ACTIVE_RUN_STATUSES),
                    AgentRun.updated_at < stuck_before,
                )
                .order_by(AgentRun.updated_at)
                .limit(50)
            )).all())
            failures = (await session.execute(
                select(AgentRun.error_code, func.count())
                .join(AgentConversation)
                .where(
                    *scope,
                    AgentRun.status.in_({"failed", "limit_reached"}),
                    AgentRun.finished_at >= failed_since,
                )
                .group_by(AgentRun.error_code)
            )).all()
        now = datetime.now(UTC)
        failure_codes = {
            str(code or "unknown"): int(count) for code, count in failures
        }
        return {
            "active_by_status": {str(status): int(count) for status, count in active_rows},
            "stuck_runs": [
                {
                    "run_id": item.id,
                    "status": item.status,
                    "stuck_seconds": max(
                        0, int((now - item.updated_at).total_seconds())
                    ),
                }
                for item in stuck
            ],
            "recent_failed": sum(failure_codes.values()),
            "recent_failure_codes": failure_codes,
        }
