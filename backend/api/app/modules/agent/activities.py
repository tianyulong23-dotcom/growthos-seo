from __future__ import annotations

import hashlib
import asyncio
import json
import re
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from temporalio import activity
from temporalio.exceptions import ApplicationError, is_cancelled_exception

from app.core.config import get_settings
from app.db.retry import is_transient_database_error
from app.db.session import session_factory
from app.modules.agent.context_tokens import (
    estimate_json_tokens,
    estimate_text_tokens,
    truncate_text_to_tokens,
)
from app.modules.agent.lease import (
    TOOL_HEARTBEAT_INTERVAL_SECONDS,
    tool_lease_renewal_interval_seconds,
)
from app.modules.agent.events import build_agent_event_store
from app.modules.agent.model_gateway import (
    AgentModelRequestError,
    AgentModelOutputError,
    ModelGateway,
    compact_tool_result,
    merge_usage,
)
from app.modules.agent.repository import AgentRepository, ToolExecutionLeaseLostError
from app.modules.agent.tools import (
    MEMORY_MODELS,
    READ_MODELS,
    TOOL_DEFINITIONS,
    WRITE_MODELS,
    ToolRegistry,
    action_hash,
)
from app.modules.audit.service import build_audit_service
from app.modules.projects.service import build_project_service
from app.modules.settings.service import (
    AIProviderNotConfiguredError,
    AISettingsEncryptionUnavailableError,
    AISettingsPlaintextMigrationRequiredError,
)


def repository() -> AgentRepository:
    return AgentRepository(session_factory)


async def start_recorded_step(
    repo: AgentRepository,
    run_id: str,
    step_type: str,
    name: str,
    input_json: dict[str, Any],
) -> str | None:
    start_step = getattr(repo, "start_step", None)
    if start_step is None:
        return None
    return await start_step(run_id, step_type, name, input_json)


async def finish_recorded_step(
    repo: AgentRepository,
    step_id: str | None,
    run_id: str,
    step_type: str,
    name: str,
    input_json: dict[str, Any],
    output_json: dict[str, Any],
    duration_ms: int,
    **kwargs: Any,
) -> None:
    if step_id is None:
        await repo.add_step(
            run_id, step_type, name, input_json, output_json, duration_ms, **kwargs
        )
        return
    await repo.finish_step(step_id, output_json, duration_ms, **kwargs)


def registry() -> ToolRegistry:
    return ToolRegistry(get_settings(), build_project_service(), build_audit_service())


def runtime_base_event(context: dict[str, Any], run_id: str) -> dict[str, Any]:
    return {
        "project_id": context["project_id"],
        "conversation_id": context["conversation_id"],
        "run_id": run_id,
    }


async def publish_runtime_event(
    context: dict[str, Any],
    run_id: str,
    event_type: str,
    payload: dict[str, Any] | None = None,
) -> None:
    if not context.get("project_id") or not context.get("conversation_id"):
        return
    await build_agent_event_store().publish(
        context["conversation_id"],
        event_type,
        {**runtime_base_event(context, run_id), **(payload or {})},
    )


async def close_runtime_message(
    context: dict[str, Any],
    run_id: str,
    payload: dict[str, Any],
) -> None:
    if not context.get("project_id") or not context.get("conversation_id"):
        return
    await build_agent_event_store().close_message(
        context["conversation_id"],
        {**runtime_base_event(context, run_id), **payload},
    )


def terminal_message_status(outcome: str) -> str:
    if outcome == "cancelled":
        return "cancelled"
    if outcome in {"error", "failed"}:
        return "error"
    if outcome == "limit_reached":
        return "limit_reached"
    return "completed"


async def close_active_message(
    context: dict[str, Any],
    run_id: str,
    *,
    outcome: str,
    round_number: int | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> None:
    event_store = build_agent_event_store()
    active = await event_store.active_message(
        context["conversation_id"],
        run_id,
        round_number=round_number,
    )
    if active is None:
        return
    status = terminal_message_status(outcome)
    await event_store.close_message(
        context["conversation_id"],
        {
            **runtime_base_event(context, run_id),
            **active,
            "status": status,
            "code": error_code,
            "message": error_message,
            "event_key": (
                f"{run_id}:message:{active['message_id']}:"
                f"{active['attempt']}:end:{status}"
            ),
        },
    )


def bounded_runtime_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    if encoded_size(arguments) <= 8_192:
        return arguments
    return compact_tool_arguments(arguments)


def error_details(exc: Exception) -> tuple[str, str, bool]:
    if isinstance(exc, AgentModelRequestError):
        return exc.error_code, str(exc), exc.retryable
    if isinstance(exc, AIProviderNotConfiguredError):
        return "model_provider_not_configured", "请先配置可用的 AI 模型", False
    if isinstance(
        exc,
        (AISettingsEncryptionUnavailableError, AISettingsPlaintextMigrationRequiredError),
    ):
        return (
            "model_provider_configuration_error",
            "AI 模型配置当前不可用，请检查服务器加密配置",
            False,
        )
    if isinstance(exc, AgentModelOutputError):
        return "invalid_model_output", "模型返回了无效内容，本次没有执行新的操作", False
    if isinstance(exc, ValueError):
        return "invalid_tool_arguments", "工具参数不完整、超过限制或不受支持", False
    if isinstance(exc, LookupError):
        return "agent_resource_not_found", "需要读取的数据不存在", False
    message = str(exc).strip()
    if "状态已经变化" in message:
        return "agent_state_conflict", "项目状态已经变化，请重新发起操作", False
    if "正在运行" in message or "active" in message.casefold():
        return "agent_operation_conflict", "当前项目已有同类任务正在运行", False
    return "agent_dependency_failed", "Agent 依赖服务暂时不可用", True


def worker_identity() -> str:
    try:
        info = activity.info()
        return (
            f"{info.workflow_id}:{info.workflow_run_id}:"
            f"{info.activity_id}:{info.attempt}"
        )
    except RuntimeError:
        return "direct-test-worker"


def temporal_activity_running() -> bool:
    try:
        activity.info()
        return True
    except RuntimeError:
        return False


def temporal_activity_attempt() -> int:
    try:
        return int(activity.info().attempt)
    except RuntimeError:
        return 1


def tool_execution_lease_lost_error() -> ApplicationError:
    return ApplicationError(
        "工具执行权已经转移，正在由新的 Worker 接管同一个工具调用",
        type="ToolExecutionLeaseLost",
        next_retry_delay=timedelta(seconds=2),
    )


async def run_with_tool_lease(
    operation: Any,
    repo: AgentRepository,
    tool_call_id: str,
    worker_id: str,
    lease_seconds: int,
) -> Any:
    if not temporal_activity_running():
        return await operation

    async def heartbeat_temporal() -> None:
        while True:
            activity.heartbeat({"tool_call_id": tool_call_id})
            await asyncio.sleep(TOOL_HEARTBEAT_INTERVAL_SECONDS)

    async def renew_database_lease() -> None:
        interval_seconds = tool_lease_renewal_interval_seconds(lease_seconds)
        while True:
            await asyncio.sleep(interval_seconds)
            try:
                renewed = await repo.renew_tool_lease(
                    tool_call_id, worker_id, lease_seconds
                )
            except Exception as exc:
                if is_transient_database_error(exc, read_only=True):
                    raise ApplicationError(
                        "数据库暂时断开，正在恢复同一个工具调用",
                        type="ToolLeaseDatabaseUnavailable",
                        next_retry_delay=timedelta(seconds=2),
                    ) from exc
                raise
            if not renewed:
                raise tool_execution_lease_lost_error()

    operation_task = asyncio.create_task(operation)
    heartbeat_task = asyncio.create_task(heartbeat_temporal())
    lease_task = asyncio.create_task(renew_database_lease())
    background_tasks = {heartbeat_task, lease_task}
    try:
        done, _ = await asyncio.wait(
            {operation_task, *background_tasks},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in background_tasks.intersection(done):
            error = task.exception()
            if error is not None:
                operation_task.cancel()
                await asyncio.gather(operation_task, return_exceptions=True)
                raise error
        return await operation_task
    finally:
        for task in {operation_task, *background_tasks}:
            if not task.done():
                task.cancel()
        await asyncio.gather(
            operation_task, *background_tasks, return_exceptions=True
        )


def project_context(context: dict[str, Any]) -> dict[str, Any]:
    return {
        "project": context["project"],
        "memory": context["project_memory"],
        "memory_catalog": context.get("project_memory_catalog", {
            "total_facts": len(context["project_memory"]),
            "visible_facts": len(context["project_memory"]),
            "hidden_facts": 0,
            "categories": {},
        }),
        "research_log": context["research_records"],
        "conversation_summary": (
            "UNVERIFIED HISTORY SUMMARY\n" + context["conversation_summary"]
            if context["conversation_summary"] else ""
        ),
    }


WRITE_INTENT_PATTERNS = {
    "update_business_profile": (
        r"(?:请|帮我|直接)?(?:修改|更新|调整|设置|改成|补充|删除).{0,24}(?:业务资料|网站资料|项目资料|业务名称|业务类型|业务简介|目标客户|目标受众|产品|服务|价值主张|内容规则)",
        r"(?:业务资料|网站资料|项目资料|业务名称|业务类型|业务简介|目标客户|目标受众|产品|服务|价值主张|内容规则).{0,24}(?:修改|更新|调整|设置|改成|补充|删除)",
    ),
    "refresh_business_profile": (
        r"(?:请|帮我|直接)?(?:重新识别|重新分析|刷新|更新).{0,16}(?:网站业务|业务资料|网站资料)",
        r"(?:网站业务|业务资料|网站资料).{0,16}(?:重新识别|重新分析|刷新)",
    ),
    "start_technical_audit": (
        r"(?:请|帮我|直接)?(?:启动|开始|发起|运行|执行|创建).{0,16}(?:技术审计|网站审计|站点审计|SEO审计|SEO审核|网站审核|扫描|爬取)",
        r"(?:技术审计|网站审计|站点审计|SEO审计|SEO审核|网站审核|扫描|爬取).{0,16}(?:启动|开始|发起|运行|执行|创建)",
    ),
}
NEGATED_WRITE_INTENT = re.compile(
    r"(?:不要|不用|无需|别|禁止|不允许|不能).{0,12}(?:修改|更新|调整|设置|改成|补充|删除|重新识别|重新分析|刷新|启动|开始|发起|运行|执行|创建)"
)


def user_explicitly_requested_write(name: str, messages: list[dict[str, Any]]) -> bool:
    user_message = next(
        (
            str(item.get("content", ""))
            for item in reversed(messages)
            if item.get("role") == "user"
        ),
        "",
    )
    normalized = re.sub(r"\s+", "", user_message)
    if not normalized or NEGATED_WRITE_INTENT.search(normalized):
        return False
    return any(
        re.search(pattern, normalized, flags=re.IGNORECASE)
        for pattern in WRITE_INTENT_PATTERNS.get(name, ())
    )


def context_trigger_tokens(limits: dict[str, Any]) -> int:
    hard_limit = context_input_tokens(limits)
    return min(hard_limit, max(1, int(limits.get("context_trigger_tokens", 20_000))))


def context_input_tokens(limits: dict[str, Any]) -> int:
    window = max(8_192, int(limits.get("context_window_tokens", 32_000)))
    return min(window - 1_024, max(4_096, int(limits.get("context_input_tokens", 24_000))))


def history_summary_batches(
    messages: list[dict[str, Any]], max_tokens: int
) -> list[list[dict[str, Any]]]:
    max_tokens = max(1, max_tokens)
    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for item in messages:
        role = item.get("role")
        content = str(item.get("content", ""))
        chunks: list[str] = []
        remaining = content
        content_budget = max(
            1,
            max_tokens - estimate_json_tokens({"role": role, "content": ""}),
        )
        while remaining:
            chunk = truncate_text_to_tokens(remaining, content_budget)
            if not chunk:
                chunk = remaining[0]
            chunks.append(chunk)
            remaining = remaining[len(chunk):]
        if not chunks:
            chunks = [""]
        for chunk in chunks:
            candidate = [*current, {"role": role, "content": chunk}]
            if current and estimate_json_tokens(candidate) > max_tokens:
                batches.append(current)
                current = []
            current.append({"role": role, "content": chunk})
    if current:
        batches.append(current)
    return batches


async def request_tokens(
    gateway: ModelGateway,
    messages: list[dict[str, Any]],
    tool_results: list[dict[str, Any]],
    request_options: dict[str, Any],
) -> int:
    return await gateway.decision_request_tokens(
        messages, tool_results, **request_options
    )


async def fit_tool_results_to_request(
    gateway: ModelGateway,
    messages: list[dict[str, Any]],
    raw_tool_results: list[dict[str, Any]],
    request_options: dict[str, Any],
    *,
    tool_token_limit: int,
    request_token_limit: int,
) -> tuple[list[dict[str, Any]], int]:
    target = max(256, tool_token_limit)
    while True:
        tool_results = bound_tool_result_batch(raw_tool_results, target)
        total = await request_tokens(gateway, messages, tool_results, request_options)
        if total <= request_token_limit:
            return tool_results, total
        if not raw_tool_results:
            raise AgentModelRequestError(
                "当前问题和必要上下文超过模型输入容量",
                error_code="model_context_overflow",
                retryable=False,
            )
        overflow = total - request_token_limit
        next_target = max(256, target - overflow - 256)
        if next_target >= target:
            next_target = target - 256
        if next_target < 256:
            raise AgentModelRequestError(
                "当前问题和必要工具结果超过模型输入容量",
                error_code="model_context_overflow",
                retryable=False,
            )
        target = next_target


async def compact_history(
    repo: AgentRepository,
    context: dict[str, Any],
    run_id: str,
    *,
    request_tokens: int,
    force: bool = False,
) -> bool:
    message_key = "force_compactable_messages" if force else "compactable_messages"
    through_key = (
        "force_compactable_through_count" if force else "compactable_through_count"
    )
    messages = context.get(message_key, context.get("compactable_messages", []))
    if not messages:
        return False
    limits = context["limits"]
    trigger_tokens = context_trigger_tokens(limits)
    if not force and request_tokens < trigger_tokens:
        return False
    source_tokens = estimate_json_tokens({
        "previous_summary": context["conversation_summary"],
        "messages": messages,
    })
    batches = history_summary_batches(
        messages, int(limits.get("compaction_batch_tokens", 12_000))
    )
    step_input = {
        "message_count": len(messages),
        "batch_count": len(batches),
        "source_tokens": source_tokens,
        "request_tokens": request_tokens,
        "trigger_tokens": trigger_tokens,
        "forced": force,
    }
    started = time.monotonic()
    step_id = await start_recorded_step(
        repo, run_id, "model", "history_compaction", step_input
    )
    try:
        gateway = ModelGateway()
        summary = context["conversation_summary"]
        usages: list[dict[str, int | float | str | None]] = []
        for batch in batches:
            result = await gateway.summarize(summary, batch)
            summary = truncate_text_to_tokens(
                result.decision.answer, int(limits.get("summary_tokens", 2_000))
            )
            usages.append(result.usage)
    except Exception as exc:
        code, message, retryable = error_details(exc)
        await finish_recorded_step(
            repo, step_id, run_id, "model", "history_compaction", step_input,
            {"error": "历史摘要暂时不可用，已保留原对话继续执行"},
            int((time.monotonic() - started) * 1000), status="failed",
            error_code=code, error_message=message,
        )
        return False
    through_count = context.get(through_key)
    if through_count is None:
        through_count = context.get("compactable_through_count", 0)
    saved = await repo.save_conversation_summary(
        context["conversation_id"],
        int(through_count),
        summary,
        context.get("active_message_id"),
    )
    if not saved:
        return False
    await finish_recorded_step(
        repo, step_id, run_id, "model", "history_compaction", step_input,
        {"summary_tokens": estimate_text_tokens(summary)},
        int((time.monotonic() - started) * 1000),
        usage=merge_usage(usages),
    )
    return True


def build_model_result_views(
    output: dict[str, Any], limits: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    once = bound_tool_output(
        output, int(limits.get("tool_result_bytes", 102_400))
    )
    long_term = compact_tool_result(output)
    long_term["retryable"] = bool(output.get("retryable"))
    long_term["cost"] = output.get("cost", 0.0)
    return {"once": once, "long_term": long_term}


def bound_tool_result_batch(
    results: list[dict[str, Any]], max_tokens: int
) -> list[dict[str, Any]]:
    if max_tokens < 256:
        raise ValueError("本轮工具结果 token 限制不能小于 256")
    bounded = [dict(item) for item in results]
    if estimate_json_tokens(bounded) <= max_tokens:
        return bounded

    bounded = [
        {
            **compact_tool_result(item),
            "retryable": bool(item.get("retryable")),
            "result_ref": item.get("result_ref"),
            "tool_batch_id": item.get("tool_batch_id"),
            "arguments": item.get("arguments", {}),
        }
        for item in results
    ]
    if estimate_json_tokens(bounded) <= max_tokens:
        return bounded

    for item in bounded:
        arguments = dict(item.get("arguments", {}))
        if arguments and not arguments.get("_compacted"):
            item["arguments"] = compact_tool_arguments(arguments)
        item["data"] = {
            key: item.get("data", {}).get(key)
            for key in (
                "id", "run_id", "status", "verified", "already_completed",
                "operation_id", "requested_count", "completed_count", "failed_count",
                "record_ids", "completion",
            )
            if isinstance(item.get("data"), dict) and key in item["data"]
        }
        item["summary"] = str(item.get("summary", ""))[:500]
    if estimate_json_tokens(bounded) <= max_tokens:
        return bounded
    raise ValueError("本轮工具结果过多，无法在不丢失失败信息的情况下提交给模型")


def _tool_result_round(result: dict[str, Any]) -> int:
    batch_id = str(result.get("tool_batch_id", ""))
    try:
        return int(batch_id.rsplit(":", 1)[1])
    except (IndexError, ValueError):
        return 0


async def compact_tool_history(
    repo: AgentRepository,
    run_id: str,
    current_round: int,
    tool_context: dict[str, Any],
    limits: dict[str, Any],
) -> None:
    await repo.repair_interrupted_tool_calls(run_id, current_round)
    older = [
        compact_tool_result(item)
        for item in tool_context["results"]
        if 0 < _tool_result_round(item) < current_round - 1
    ]
    source_tokens = estimate_json_tokens({
        "previous_summary": str(tool_context.get("summary", "")),
        "tool_results": older,
    })
    if not older or source_tokens < int(limits.get("tool_context_tokens", 6_000)):
        return

    through_round = max(_tool_result_round(item) for item in tool_context["results"] if _tool_result_round(item) < current_round - 1)
    step_input = {
        "through_round": through_round,
        "tool_result_count": len(older),
        "source_tokens": source_tokens,
    }
    started = time.monotonic()
    step_id = await start_recorded_step(
        repo, run_id, "model", "tool_history_compaction", step_input
    )
    try:
        result = await ModelGateway().summarize_tool_history(
            str(tool_context.get("summary", "")), older
        )
        summary = truncate_text_to_tokens(
            result.decision.answer, int(limits.get("tool_summary_tokens", 2_000))
        )
        await repo.save_tool_context_summary(run_id, through_round, summary)
    except Exception as exc:
        code, message, retryable = error_details(exc)
        await finish_recorded_step(
            repo, step_id, run_id, "model", "tool_history_compaction", step_input,
            {"error": "工具历史摘要暂时不可用，已保留原结果继续执行"},
            int((time.monotonic() - started) * 1000), status="failed",
            error_code=code, error_message=message,
        )
        return
    await finish_recorded_step(
        repo, step_id, run_id, "model", "tool_history_compaction", step_input,
        {"summary_tokens": estimate_text_tokens(summary), "through_round": through_round},
        int((time.monotonic() - started) * 1000), usage=result.usage,
    )


@activity.defn(name="agent_set_status")
async def set_status(payload: dict[str, Any]) -> None:
    repo = repository()
    await repo.set_run_status(
        payload["run_id"], payload["status"],
        error_code=payload.get("error_code"), error_message=payload.get("error_message"),
    )
    if payload["status"] == "running":
        context = await repo.get_run_context(payload["run_id"])
        await publish_runtime_event(
            context,
            payload["run_id"],
            "agent_start",
            {
                "status": "running",
                "event_key": f"{payload['run_id']}:agent:start",
            },
        )


@activity.defn(name="agent_finish_turn")
async def finish_turn(payload: dict[str, Any]) -> None:
    repo = repository()
    context = await repo.get_run_context(payload["run_id"])
    round_number = int(payload["round"])
    outcome = str(payload.get("outcome") or "tool_results")
    await close_active_message(
        context,
        payload["run_id"],
        outcome=outcome,
        round_number=round_number,
        error_code=payload.get("error_code"),
        error_message=payload.get("error_message"),
    )
    await publish_runtime_event(
        context,
        payload["run_id"],
        "turn_end",
        {
            "round": round_number,
            "outcome": outcome,
            "tool_result_count": int(payload.get("tool_result_count", 0)),
            "event_key": (
                f"{payload['run_id']}:turn:{round_number}:end:{outcome}"
            ),
        },
    )


@activity.defn(name="agent_check_run")
async def check_run(payload: dict[str, Any]) -> dict[str, Any]:
    repo = repository()
    context = await repo.get_run_context(payload["run_id"])
    if context["status"] == "cancelled":
        return {"allowed": False, "status": "cancelled", "reason": "任务已取消"}
    elapsed_seconds = max(
        0.0, (datetime.now(UTC) - context["created_at"]).total_seconds()
    )
    if elapsed_seconds >= int(context["limits"]["run_timeout_seconds"]):
        return {
            "allowed": False, "status": "limit_reached",
            "reason_code": "run_timeout", "reason": "本次任务已达到平台运行时长上限",
        }
    usage = await repo.run_usage(payload["run_id"])
    return {"allowed": True, "usage": usage}


@activity.defn(name="agent_model_decide")
async def model_decide(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    repo = repository()
    context = await repo.get_run_context(payload["run_id"])
    if context["status"] == "cancelled":
        return {"type": "cancelled"}
    round_number = int(payload["round"])
    await publish_runtime_event(
        context,
        payload["run_id"],
        "turn_start",
        {
            "round": round_number,
            "event_key": f"{payload['run_id']}:turn:{round_number}:start",
        },
    )
    registered = await repo.registered_tool_call_refs(
        payload["run_id"], round_number
    )
    if registered:
        await repo.finish_recovered_model_step(
            payload["run_id"], round_number, registered
        )
        message_id = str(uuid5(
            NAMESPACE_URL,
            f"seo-agent-decision:{payload['run_id']}:{round_number}:recovered",
        ))
        message_event = {
            "round": round_number,
            "message_id": message_id,
            "part_id": f"{message_id}:assistant",
            "phase": "decision",
            "attempt": 0,
        }
        await publish_runtime_event(
            context, payload["run_id"], "message_start", message_event
        )
        await close_runtime_message(
            context,
            payload["run_id"],
            {
                **message_event,
                "status": "recovered",
                "outcome": "tool_calls",
            },
        )
        return {"type": "tool_calls", "tool_calls": registered}
    try:
        gateway = ModelGateway()
        tool_context = await repo.tool_model_context(
            payload["run_id"], int(payload["round"])
        )
        await compact_tool_history(
            repo, payload["run_id"], int(payload["round"]), tool_context, context["limits"]
        )
        tool_context = await repo.tool_model_context(
            payload["run_id"], int(payload["round"])
        )
        raw_tool_results = tool_context["results"]
        model_project_context = project_context(context)
        if tool_context["summary"]:
            model_project_context["task_progress_summary"] = (
                "UNVERIFIED TOOL HISTORY SUMMARY\n" + tool_context["summary"]
            )
        request_options = {
            "project_context": model_project_context,
            "final_only": bool(payload.get("final_only")),
            "judge_feedback": payload.get("judge_feedback"),
            "execution_feedback": payload.get("execution_feedback"),
        }
        input_token_limit = context_input_tokens(context["limits"])
        tool_token_limit = int(context["limits"].get("tool_round_tokens", 8_000))
        tool_results = bound_tool_result_batch(raw_tool_results, tool_token_limit)
        request_token_count = await request_tokens(
            gateway, context["messages"], tool_results, request_options
        )
        if await compact_history(
            repo,
            context,
            payload["run_id"],
            request_tokens=request_token_count,
        ):
            context = await repo.get_run_context(payload["run_id"])
            model_project_context = project_context(context)
            if tool_context["summary"]:
                model_project_context["task_progress_summary"] = (
                    "UNVERIFIED TOOL HISTORY SUMMARY\n" + tool_context["summary"]
                )
            request_options["project_context"] = model_project_context
            tool_results, request_token_count = await fit_tool_results_to_request(
                gateway,
                context["messages"],
                raw_tool_results,
                request_options,
                tool_token_limit=tool_token_limit,
                request_token_limit=input_token_limit,
            )
        elif request_token_count > input_token_limit:
            if not await compact_history(
                repo,
                context,
                payload["run_id"],
                request_tokens=request_token_count,
                force=True,
            ):
                tool_results, request_token_count = await fit_tool_results_to_request(
                    gateway,
                    context["messages"],
                    raw_tool_results,
                    request_options,
                    tool_token_limit=tool_token_limit,
                    request_token_limit=input_token_limit,
                )
            else:
                context = await repo.get_run_context(payload["run_id"])
                request_options["project_context"] = project_context(context)
                if tool_context["summary"]:
                    request_options["project_context"]["task_progress_summary"] = (
                        "UNVERIFIED TOOL HISTORY SUMMARY\n" + tool_context["summary"]
                    )
                tool_results, request_token_count = await fit_tool_results_to_request(
                    gateway,
                    context["messages"],
                    raw_tool_results,
                    request_options,
                    tool_token_limit=tool_token_limit,
                    request_token_limit=input_token_limit,
                )
        step_input = {
            "round": payload["round"],
            "tool_result_count": len(tool_results),
            "final_only": bool(payload.get("final_only")),
            "has_judge_feedback": bool(payload.get("judge_feedback")),
            "has_execution_feedback": bool(payload.get("execution_feedback")),
            "request_tokens": request_token_count,
            "request_token_limit": input_token_limit,
        }
        step_id = await start_recorded_step(
            repo, payload["run_id"], "model", "chat.completions", step_input
        )
        try:
            update_sequences: dict[int, int] = {}

            async def publish_model_update(update: dict[str, Any]) -> None:
                attempt = int(update.get("attempt", 0))
                message_id = str(uuid5(
                    NAMESPACE_URL,
                    f"seo-agent-decision:{payload['run_id']}:{round_number}:{attempt}",
                ))
                message_event = {
                    "round": round_number,
                    "message_id": message_id,
                    "part_id": f"{message_id}:assistant",
                    "phase": "decision",
                    "attempt": attempt,
                }
                kind = str(update.get("kind", ""))
                if kind == "stream_start":
                    update_sequences[attempt] = 0
                    await publish_runtime_event(
                        context,
                        payload["run_id"],
                        "message_start",
                        {
                            **message_event,
                            "event_key": (
                                f"{payload['run_id']}:decision:{round_number}:"
                                f"{attempt}:start"
                            ),
                        },
                    )
                    return
                if kind == "stream_end":
                    await close_runtime_message(
                        context,
                        payload["run_id"],
                        {
                            **message_event,
                            "status": str(update.get("status", "completed")),
                            "event_key": (
                                f"{payload['run_id']}:decision:{round_number}:"
                                f"{attempt}:end:{update.get('status', 'completed')}"
                            ),
                        },
                    )
                    return
                update_sequences[attempt] = update_sequences.get(attempt, 0) + 1
                assistant_event = {
                    key: update[key]
                    for key in (
                        "kind", "delta", "index", "tool_call_id", "tool_name",
                        "id_delta", "name_delta", "arguments_delta",
                    )
                    if key in update
                }
                await publish_runtime_event(
                    context,
                    payload["run_id"],
                    "message_update",
                    {
                        **message_event,
                        "assistant_message_event": assistant_event,
                        "event_key": (
                            f"{payload['run_id']}:decision:{round_number}:"
                            f"{attempt}:update:{update_sequences[attempt]}"
                        ),
                    },
                )

            if hasattr(gateway, "decide_stream"):
                model_result = await gateway.decide_stream(
                    context["messages"],
                    tool_results,
                    publish_model_update,
                    **request_options,
                )
            else:
                model_result = await gateway.decide(
                    context["messages"], tool_results, **request_options
                )
        except AgentModelRequestError as exc:
            if exc.error_code != "model_context_overflow":
                raise
            history_compacted = await compact_history(
                repo,
                context,
                payload["run_id"],
                request_tokens=request_token_count,
                force=True,
            )
            if history_compacted:
                context = await repo.get_run_context(payload["run_id"])
                tool_context = await repo.tool_model_context(
                    payload["run_id"], int(payload["round"])
                )
                raw_tool_results = tool_context["results"]
                model_project_context = project_context(context)
                if tool_context["summary"]:
                    model_project_context["task_progress_summary"] = (
                        "UNVERIFIED TOOL HISTORY SUMMARY\n" + tool_context["summary"]
                    )
                request_options["project_context"] = model_project_context

            recovery_request_limit = min(
                request_token_count - 256,
                input_token_limit * 9 // 10,
            )
            tool_results_compacted = False
            if raw_tool_results and recovery_request_limit > 0:
                original_tool_tokens = estimate_json_tokens(tool_results)
                try:
                    reduced_tool_results, reduced_request_tokens = (
                        await fit_tool_results_to_request(
                            gateway,
                            context["messages"],
                            raw_tool_results,
                            request_options,
                            tool_token_limit=min(
                                tool_token_limit, original_tool_tokens
                            ),
                            request_token_limit=recovery_request_limit,
                        )
                    )
                except (AgentModelRequestError, ValueError):
                    pass
                else:
                    if estimate_json_tokens(reduced_tool_results) < original_tool_tokens:
                        tool_results = reduced_tool_results
                        request_token_count = reduced_request_tokens
                        tool_results_compacted = True

            if not history_compacted and not tool_results_compacted:
                raise
            if hasattr(gateway, "decide_stream"):
                model_result = await gateway.decide_stream(
                    context["messages"],
                    tool_results,
                    publish_model_update,
                    **request_options,
                )
            else:
                model_result = await gateway.decide(
                    context["messages"], tool_results, **request_options
                )
    except Exception as exc:
        code, message, retryable = error_details(exc)
        step_input = locals().get("step_input", {"round": payload["round"]})
        step_id = locals().get("step_id")
        await finish_recorded_step(
            repo, step_id, payload["run_id"], "model", "chat.completions", step_input,
            {"error": message}, int((time.monotonic() - started) * 1000),
            status="failed", error_code=code, error_message=message,
        )
        if isinstance(
            exc,
            (AgentModelRequestError, AIProviderNotConfiguredError, AgentModelOutputError),
        ):
            await publish_runtime_event(
                context,
                payload["run_id"],
                "turn_end",
                {
                    "round": round_number,
                    "outcome": "error",
                    "error_code": code,
                },
            )
            return {
                "type": "model_error",
                "error_code": code,
                "message": message,
                "retryable": retryable,
            }
        raise
    await repo.set_model_snapshot(payload["run_id"], {
        "provider": "openai-compatible",
        "base_url": model_result.base_url,
        "model": model_result.model,
    })
    output = model_result.decision.model_dump(mode="json")
    if output.get("type") == "tool_calls":
        refs = await repo.register_tool_calls(
            payload["run_id"], int(payload["round"]), output["tool_calls"],
            int(context["limits"].get("tool_arguments_bytes", 256_000)),
        )
        output = {"type": "tool_calls", "tool_calls": refs}
    await finish_recorded_step(
        repo, step_id, payload["run_id"], "model", "chat.completions", step_input,
        output, int((time.monotonic() - started) * 1000), usage=model_result.usage,
    )
    if output.get("type") == "final":
        await publish_runtime_event(
            context,
            payload["run_id"],
            "turn_end",
            {"round": round_number, "outcome": "final", "tool_result_count": 0},
        )
    return output


@activity.defn(name="agent_judge_final")
async def judge_final(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    repo = repository()
    context = await repo.get_run_context(payload["run_id"])
    if context["status"] == "cancelled":
        return {"status": "blocked", "reason": "任务已取消"}
    user_goal = next(
        (
            str(item.get("content", ""))
            for item in reversed(context["messages"])
            if item.get("role") == "user"
        ),
        "",
    )
    try:
        evidence = await repo.completion_evidence(payload["run_id"])
        tool_context = await repo.tool_model_context(payload["run_id"], 1_000_000)
        evidence["tool_history_summary"] = str(tool_context.get("summary") or "")
        evidence["tool_history_through_round"] = int(
            tool_context.get("through_round") or 0
        )
        if "tool_evidence" not in evidence:
            evidence["tool_evidence"] = [
                compact_tool_result(item) for item in tool_context["results"]
            ]
        step_input = {
            "tool_result_count": len(evidence["tool_evidence"]),
            "tool_execution_count": int(
                evidence.get("execution_summary", {}).get("total", 0)
            ),
            "run_step_count": len(evidence.get("run_steps", [])),
            "unfinished_count": len(evidence.get("unfinished", [])),
        }
        step_id = await start_recorded_step(
            repo, payload["run_id"], "model", "final_check", step_input
        )
        result = await ModelGateway().judge(
            user_goal,
            str(payload["answer"]),
            evidence,
        )
    except Exception as exc:
        code, message, retryable = error_details(exc)
        step_input = locals().get("step_input", {})
        step_id = locals().get("step_id")
        await finish_recorded_step(
            repo, step_id, payload["run_id"], "model", "final_check", step_input,
            {"error": message}, int((time.monotonic() - started) * 1000),
            status="failed", error_code=code, error_message=message,
        )
        if isinstance(
            exc,
            (AgentModelRequestError, AIProviderNotConfiguredError, AgentModelOutputError),
        ):
            return {
                "type": "model_error",
                "error_code": code,
                "message": message,
                "retryable": retryable,
            }
        raise
    output = result.decision.model_dump(mode="json")
    await finish_recorded_step(
        repo, step_id, payload["run_id"], "model", "final_check", step_input,
        output, int((time.monotonic() - started) * 1000), usage=result.usage,
    )
    return output


@activity.defn(name="agent_stream_final")
async def stream_final(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    repo = repository()
    context = await repo.get_run_context(payload["run_id"])
    answer = str(payload["answer"])
    message_id = str(uuid5(NAMESPACE_URL, f"seo-agent-final:{payload['run_id']}"))
    part_id = f"{message_id}:text"
    event_store = build_agent_event_store()
    base_event = {
        "project_id": context["project_id"],
        "conversation_id": context["conversation_id"],
        "run_id": payload["run_id"],
        "message_id": message_id,
        "part_id": part_id,
        "phase": "final",
        "attempt": 0,
    }
    if context["status"] == "cancelled":
        return {
            "answer": answer,
            "message_id": message_id,
            "streamed": False,
            "cancelled": True,
        }
    await event_store.publish(
        context["conversation_id"],
        "message_start",
        {**base_event, "event_key": f"{payload['run_id']}:final:start"},
    )
    step_input = {
        "source": "judge_approved_answer",
        "answer_chars": len(answer),
        "evidence_count": len(payload.get("evidence", [])),
    }
    step_id = await start_recorded_step(
        repo, payload["run_id"], "execution", "final_response", step_input
    )
    update_id = await event_store.publish(
        context["conversation_id"],
        "message_update",
        {
            **base_event,
            "event_key": f"{payload['run_id']}:final:update:1",
            "assistant_message_event": {"kind": "text_delta", "delta": answer},
        },
    )
    await event_store.close_message(
        context["conversation_id"],
        {
            **base_event,
            "event_key": f"{payload['run_id']}:final:end:completed",
            "status": "completed",
        },
    )
    await finish_recorded_step(
        repo,
        step_id,
        payload["run_id"],
        "execution",
        "final_response",
        step_input,
        {"answer_chars": len(answer), "streamed": update_id is not None},
        int((time.monotonic() - started) * 1000),
    )
    return {
        "answer": answer,
        "message_id": message_id,
        "streamed": update_id is not None,
    }


@activity.defn(name="agent_execute_tool")
async def execute_tool(payload: dict[str, Any]) -> dict[str, Any]:
    tool_call_id = str(payload["tool_call_id"])
    started = time.monotonic()
    repo = repository()
    context = await repo.get_run_context(payload["run_id"])
    worker_id = worker_identity()
    execution_attempt = temporal_activity_attempt()
    lease_seconds = int(context["limits"]["execution_lease_seconds"])
    claim, execution = await repo.claim_registered_tool(
        payload["run_id"], tool_call_id, worker_id,
        lease_seconds,
    )
    if claim == "completed" and execution is not None:
        views = dict(execution.model_result_json)
        await publish_runtime_event(
            context,
            payload["run_id"],
            "tool_execution_end",
            {
                "tool_call_id": tool_call_id,
                "tool_name": execution.tool_name,
                "attempt": execution_attempt,
                "is_error": False,
                "status": "recovered",
                "summary": str(
                    (views.get("long_term") or {}).get("summary", "工具执行已恢复")
                )[:500],
                "event_key": (
                    f"{payload['run_id']}:tool:{tool_call_id}:"
                    f"{execution_attempt}:end:recovered"
                ),
            },
        )
        return dict(views.get("long_term") or compact_tool_result(execution.result_json))
    if claim == "busy":
        raise ApplicationError(
            "相同工具调用仍由前一个 Worker 执行",
            type="ToolExecutionBusy",
            next_retry_delay=timedelta(seconds=2),
        )
    if claim != "claimed" or execution is None:
        return tool_error("unknown_tool", "run_not_executable", "任务已停止，未开始新的操作", False)
    name = execution.tool_name
    arguments = dict(execution.arguments_json)
    tool_event = {
        "tool_call_id": tool_call_id,
        "model_tool_call_id": execution.model_tool_call_id,
        "tool_name": name,
        "attempt": execution_attempt,
    }
    await publish_runtime_event(
        context,
        payload["run_id"],
        "tool_execution_start",
        {
            **tool_event,
            "args": bounded_runtime_arguments(arguments),
            "event_key": (
                f"{payload['run_id']}:tool:{tool_call_id}:"
                f"{execution_attempt}:start"
            ),
        },
    )
    await publish_runtime_event(
        context,
        payload["run_id"],
        "tool_execution_update",
        {
            **tool_event,
            "stage": "running",
            "event_key": (
                f"{payload['run_id']}:tool:{tool_call_id}:"
                f"{execution_attempt}:update:running"
            ),
        },
    )
    definition = TOOL_DEFINITIONS.get(name)
    if definition is None:
        output = tool_error(name, "tool_not_allowed", "这个工具不在平台允许清单中", False)
        output.update({
            "tool_call_id": execution.model_tool_call_id,
            "arguments": arguments,
        })
        model_views = build_model_result_views(output, context["limits"])
        await repo.fail_tool_execution(
            tool_call_id, worker_id, "tool_not_allowed", output, model_views
        )
        await repo.add_step(
            payload["run_id"], "tool", name,
            {"tool_call_id": tool_call_id}, output,
            int((time.monotonic() - started) * 1000), status="failed",
            error_code="tool_not_allowed", error_message=output["summary"],
        )
        await publish_runtime_event(
            context,
            payload["run_id"],
            "tool_execution_end",
            {
                **tool_event,
                "is_error": True,
                "status": "failed",
                "error_code": "tool_not_allowed",
                "retryable": False,
                "summary": output["summary"],
                "event_key": (
                    f"{payload['run_id']}:tool:{tool_call_id}:"
                    f"{execution_attempt}:end:tool_not_allowed"
                ),
            },
        )
        return dict(model_views["long_term"])
    if context["status"] == "cancelled":
        output = tool_error(name, "run_cancelled", "任务已取消", False)
        output.update({
            "tool_call_id": execution.model_tool_call_id,
            "arguments": arguments,
        })
        model_views = build_model_result_views(output, context["limits"])
        await repo.fail_tool_execution(
            tool_call_id, worker_id, "run_cancelled", output, model_views
        )
        await publish_runtime_event(
            context,
            payload["run_id"],
            "tool_execution_end",
            {
                **tool_event,
                "is_error": True,
                "status": "cancelled",
                "error_code": "run_cancelled",
                "retryable": False,
                "summary": output["summary"],
                "event_key": (
                    f"{payload['run_id']}:tool:{tool_call_id}:"
                    f"{execution_attempt}:end:cancelled"
                ),
            },
        )
        return dict(model_views["long_term"])
    if name in WRITE_MODELS and not user_explicitly_requested_write(
        name, context["messages"]
    ):
        rejected = await record_rejected_tool(
            repo, payload["run_id"], tool_call_id, execution.model_tool_call_id,
            worker_id, name, arguments, context["limits"], started,
            "write_not_explicitly_requested",
            "用户没有明确要求执行这个写操作，平台已阻止执行",
        )
        await publish_runtime_event(
            context,
            payload["run_id"],
            "tool_execution_end",
            {
                **tool_event,
                "is_error": True,
                "status": "rejected",
                "error_code": "write_not_explicitly_requested",
                "retryable": False,
                "summary": rejected["summary"],
                "event_key": (
                    f"{payload['run_id']}:tool:{tool_call_id}:"
                    f"{execution_attempt}:end:rejected"
                ),
            },
        )
        return rejected
    step_id = await start_recorded_step(
        repo, payload["run_id"], "tool", name,
        {"tool_call_id": tool_call_id, "parameters_hash": execution.parameters_hash},
    )
    async def run_operation() -> dict[str, Any]:
        if name == "search_project_memory":
            validated = READ_MODELS[name].model_validate(arguments)
            return await repo.search_project_memory(
                context["project_id"], **validated.model_dump(mode="json")
            )
        if name in READ_MODELS:
            return await registry().execute_read(context["project_id"], name, arguments)
        if name in MEMORY_MODELS:
            validated = MEMORY_MODELS[name].model_validate(arguments).model_dump(mode="json")
            await repo.prepare_registered_tool(
                tool_call_id, worker_id, validated, {}, action_hash(name, validated, {})
            )
            await publish_runtime_event(
                context,
                payload["run_id"],
                "tool_execution_update",
                {
                    **tool_event,
                    "stage": "writing",
                    "event_key": (
                        f"{payload['run_id']}:tool:{tool_call_id}:"
                        f"{execution_attempt}:update:writing"
                    ),
                },
            )
            return await repo.update_project_memory(
                payload["run_id"], validated["operations"],
                tool_call_id=tool_call_id, worker_id=worker_id,
            )
        if name in WRITE_MODELS:
            operation_id = str(uuid5(NAMESPACE_URL, f"agent:{tool_call_id}:{name}"))
            if (
                arguments.get("operation_id") == operation_id
                and action_hash(name, arguments, dict(execution.before_json))
                == execution.parameters_hash
            ):
                prepared_arguments = arguments
                prepared_before = dict(execution.before_json)
                prepared_hash = execution.parameters_hash
            else:
                prepared = await registry().prepare_write(
                    context["project_id"], name, arguments, operation_id
                )
                prepared_arguments = prepared.arguments
                prepared_before = prepared.before
                prepared_hash = prepared.parameters_hash
                await repo.prepare_registered_tool(
                    tool_call_id, worker_id, prepared_arguments, prepared_before,
                    prepared_hash,
                )
            await publish_runtime_event(
                context,
                payload["run_id"],
                "tool_execution_update",
                {
                    **tool_event,
                    "stage": "writing",
                    "event_key": (
                        f"{payload['run_id']}:tool:{tool_call_id}:"
                        f"{execution_attempt}:update:writing"
                    ),
                },
            )
            result = await registry().execute_write(
                context["project_id"], name, prepared_arguments,
                prepared_before, prepared_hash,
            )
            await repo.set_tool_verifying(tool_call_id, worker_id)
            await publish_runtime_event(
                context,
                payload["run_id"],
                "tool_execution_update",
                {
                    **tool_event,
                    "stage": "verifying",
                    "event_key": (
                        f"{payload['run_id']}:tool:{tool_call_id}:"
                        f"{execution_attempt}:update:verifying"
                    ),
                },
            )
            if not result.get("verified"):
                raise RuntimeError("操作可能已完成，但执行结果校验失败")
            return result
        raise ValueError("不允许调用这个工具")

    try:
        result = await run_with_tool_lease(
            run_operation(), repo, tool_call_id, worker_id, lease_seconds
        )
    except Exception as exc:
        if is_cancelled_exception(exc):
            raise
        if isinstance(exc, ToolExecutionLeaseLostError):
            raise tool_execution_lease_lost_error() from exc
        if isinstance(exc, ApplicationError) and exc.type in {
            "ToolLeaseDatabaseUnavailable",
            "ToolExecutionLeaseLost",
        }:
            raise
        code, message, retryable = error_details(exc)
        output = tool_error(name, code, message, retryable)
        output.update({
            "tool_call_id": execution.model_tool_call_id,
            "arguments": arguments,
        })
        model_views = build_model_result_views(output, context["limits"])
        await repo.fail_tool_execution(
            tool_call_id, worker_id, code, output, model_views
        )
        await finish_recorded_step(
            repo, step_id, payload["run_id"], "tool", name, arguments, output,
            int((time.monotonic() - started) * 1000), status="failed",
            error_code=code, error_message=message,
            usage={"cost": definition.estimated_cost, "cost_currency": "USD"},
        )
        await publish_runtime_event(
            context,
            payload["run_id"],
            "tool_execution_end",
            {
                **tool_event,
                "is_error": True,
                "status": "failed",
                "error_code": code,
                "retryable": retryable,
                "summary": message,
                "event_key": (
                    f"{payload['run_id']}:tool:{tool_call_id}:"
                    f"{execution_attempt}:end:{code}"
                ),
            },
        )
        return dict(model_views["long_term"])
    output = {
        "tool_call_id": execution.model_tool_call_id,
        "tool": name, "arguments": arguments,
        "ok": True, "summary": tool_summary(name, result),
        "data": result, "error_code": None, "retryable": False,
        "cost": definition.estimated_cost,
    }
    model_views = build_model_result_views(output, context["limits"])
    try:
        await repo.complete_tool_execution(
            tool_call_id, worker_id, output, model_views
        )
    except ToolExecutionLeaseLostError as exc:
        raise tool_execution_lease_lost_error() from exc
    await finish_recorded_step(
        repo, step_id, payload["run_id"], "tool", name,
        {"tool_call_id": tool_call_id}, model_views["long_term"],
        int((time.monotonic() - started) * 1000),
        usage={"cost": definition.estimated_cost, "cost_currency": "USD"},
    )
    await publish_runtime_event(
        context,
        payload["run_id"],
        "tool_execution_end",
        {
            **tool_event,
            "is_error": False,
            "status": "completed",
            "retryable": False,
            "summary": output["summary"],
            "event_key": (
                f"{payload['run_id']}:tool:{tool_call_id}:"
                f"{execution_attempt}:end:completed"
            ),
        },
    )
    return dict(model_views["long_term"])


@activity.defn(name="agent_skip_tool_calls")
async def skip_tool_calls(payload: dict[str, Any]) -> dict[str, int]:
    skipped = await repository().skip_registered_tool_calls(
        payload["run_id"],
        [str(item) for item in payload.get("tool_call_ids", [])],
        "前面的写操作改变了项目状态，本调用未执行，Agent 将按最新状态重新判断",
    )
    return {"skipped": skipped}


def bound_tool_result_data(
    tool_call_id: str,
    name: str,
    result: dict[str, Any],
    max_bytes: int,
) -> dict[str, Any]:
    if encoded_size(result) <= max_bytes:
        return result
    compacted = compact_tool_result({
        "tool_call_id": tool_call_id,
        "tool": name,
        "ok": True,
        "summary": tool_summary(name, result),
        "data": result,
    })
    bounded = {
        **dict(compacted.get("data", {})),
        "truncated": True,
        "message": "工具结果已压缩，可按 next_page 继续读取",
    }
    if encoded_size(bounded) <= max_bytes:
        return bounded

    facts = bounded.get("facts")
    if isinstance(facts, list):
        bounded["facts"] = [
            {
                **item,
                "value": str(item.get("value", ""))[:500],
                "context_truncated": True,
            }
            for item in facts
            if isinstance(item, dict)
        ]
        while bounded["facts"] and encoded_size(bounded) > max_bytes:
            bounded["facts"].pop()
        bounded["facts_truncated"] = len(bounded["facts"]) < len(facts)
    if encoded_size(bounded) <= max_bytes:
        return bounded

    minimal = {
        key: bounded[key]
        for key in (
            "id", "run_id", "status", "verified", "already_completed",
            "operation_id", "requested_count", "completed_count", "failed_count",
            "record_ids", "completion",
        )
        if key in bounded
    }
    minimal.update({
        "truncated": True,
        "message": "工具结果超过平台限制，已只保留执行状态",
    })
    if encoded_size(minimal) <= max_bytes:
        return minimal
    if max_bytes >= encoded_size({}):
        return {}
    raise ValueError("工具结果大小限制不能小于 2 bytes")


def encoded_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def compact_tool_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    encoded = json.dumps(
        arguments, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return {
        "_truncated": True,
        "original_bytes": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
    }


def bound_tool_output(output: dict[str, Any], max_bytes: int) -> dict[str, Any]:
    if max_bytes < 1_024:
        raise ValueError("工具消息大小限制不能小于 1024 bytes")
    if encoded_size(output) <= max_bytes:
        return output

    original_data = dict(output.get("data", {}))
    bounded = dict(output)
    for compact_arguments in (False, True):
        if compact_arguments:
            bounded["arguments"] = compact_tool_arguments(
                dict(output.get("arguments", {}))
            )
        else:
            bounded["arguments"] = dict(output.get("arguments", {}))
        bounded["data"] = {}
        data_budget = max_bytes - encoded_size(bounded) + encoded_size({})
        if data_budget < encoded_size({}):
            continue
        bounded["data"] = bound_tool_result_data(
            str(output.get("tool_call_id", "")),
            str(output.get("tool", "")),
            original_data,
            data_budget,
        )
        if encoded_size(bounded) <= max_bytes:
            return bounded

    minimal = {
        "tool_call_id": str(output.get("tool_call_id", ""))[:200],
        "tool": str(output.get("tool", ""))[:100],
        "arguments": compact_tool_arguments(dict(output.get("arguments", {}))),
        "ok": bool(output.get("ok")),
        "summary": "工具消息超过平台限制，已只保留执行状态",
        "data": {},
        "error_code": output.get("error_code"),
        "retryable": bool(output.get("retryable")),
        "cost": output.get("cost", 0.0),
    }
    if encoded_size(minimal) <= max_bytes:
        return minimal
    raise ValueError("工具消息大小限制不足以保存最简执行状态")


def tool_error(name: str, code: str, summary: str, retryable: bool) -> dict[str, Any]:
    return {
        "tool": name, "ok": False, "summary": summary, "data": {},
        "error_code": code, "retryable": retryable, "cost": 0.0,
    }


async def record_rejected_tool(
    repo: AgentRepository,
    run_id: str,
    tool_call_id: str,
    model_tool_call_id: str,
    worker_id: str,
    name: str,
    arguments: dict[str, Any],
    limits: dict[str, Any],
    started: float,
    code: str,
    message: str,
) -> dict[str, Any]:
    output = tool_error(name, code, message, False)
    output.update({
        "tool_call_id": model_tool_call_id,
        "arguments": arguments,
    })
    model_views = build_model_result_views(output, limits)
    await repo.fail_tool_execution(
        tool_call_id, worker_id, code, output, model_views
    )
    await repo.add_step(
        run_id, "tool", name, {"tool_call_id": tool_call_id},
        model_views["long_term"],
        int((time.monotonic() - started) * 1000), status="failed",
        error_code=code, error_message=message,
    )
    return dict(model_views["long_term"])


def tool_summary(name: str, result: dict[str, Any]) -> str:
    if name == "search_project_memory":
        return f"找到 {result.get('total', 0)} 条项目记忆"
    if name == "update_project_memory":
        return f"项目记忆已保存并校验，共处理 {len(result.get('applied', []))} 项"
    if name == "update_business_profile":
        return "业务资料已是目标值" if result.get("already_completed") else "业务资料已更新并校验"
    if name == "refresh_business_profile":
        return f"网站业务识别任务状态：{result.get('status', 'unknown')}"
    if name == "start_technical_audit":
        return f"技术审核任务状态：{result.get('status', 'unknown')}"
    return "数据读取完成"


@activity.defn(name="agent_finish")
async def finish(payload: dict[str, Any]) -> None:
    repo = repository()
    context = await repo.get_run_context(payload["run_id"])
    if context["status"] == "cancelled" and payload.get("status") != "cancelled":
        return
    await close_active_message(
        context,
        payload["run_id"],
        outcome=str(payload.get("status") or "completed"),
        error_code=payload.get("error_code"),
        error_message=payload.get("error_message"),
    )
    await repo.save_context_updates(
        payload["run_id"],
        payload.get("research")
        if payload.get("status", "completed") == "completed"
        else None,
    )
    await repo.finalize_run(
        payload["run_id"], payload["answer"],
        {
            "evidence": payload.get("evidence", []),
            "judge": payload.get("judge"),
        },
        payload.get("status", "completed"),
        payload.get("error_code"), payload.get("error_message"),
        payload.get("message_id"),
    )
    if payload.get("message_id"):
        await build_agent_event_store().publish(
            context["conversation_id"],
            "message_end",
            {
                "project_id": context["project_id"],
                "conversation_id": context["conversation_id"],
                "run_id": payload["run_id"],
                "message_id": payload["message_id"],
                "part_id": f"{payload['message_id']}:text",
                "phase": "final",
                "attempt": 0,
                "status": payload.get("status", "completed"),
                "outcome": "persisted",
                "event_key": f"{payload['run_id']}:final:end:persisted",
            },
        )
    await publish_runtime_event(
        context,
        payload["run_id"],
        "agent_end",
        {
            "status": payload.get("status", "completed"),
            "error_code": payload.get("error_code"),
            "event_key": (
                f"{payload['run_id']}:agent:end:"
                f"{payload.get('status', 'completed')}"
            ),
        },
    )


AGENT_ACTIVITIES = [
    set_status, finish_turn, check_run, model_decide, judge_final, stream_final,
    execute_tool, skip_tool_calls, finish,
]
