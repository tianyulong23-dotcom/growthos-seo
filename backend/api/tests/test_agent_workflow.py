import asyncio
from typing import Any

import pytest
from temporalio.exceptions import ActivityError, CancelledError

from app.modules.agent import workflows as agent_workflows
from app.modules.agent.tools import EmptyArgs, TOOL_DEFINITIONS, ToolDefinition
from app.modules.agent.workflows import (
    AgentLoopDetector,
    AgentWorkflow,
    _bound_tool_history_result,
    _encoded_size,
)


LIMITS = {
    "model_rounds": 8,
    "tool_calls": 8,
    "consecutive_failures": 3,
    "model_timeout_seconds": 120,
    "read_tool_timeout_seconds": 60,
    "write_tool_timeout_seconds": 180,
}


def test_workflow_bounds_large_arguments_even_when_activity_fails() -> None:
    result = {
        "tool_call_id": "call-1",
        "tool": "start_technical_audit",
        "arguments": {"allowed_paths": ["/" + "x" * 2_000] * 100},
        "ok": False,
        "summary": "Agent 依赖服务暂时不可用",
        "data": {},
        "error_code": "agent_dependency_failed",
        "retryable": True,
        "cost": 0.0,
    }

    bounded = _bound_tool_history_result(result, 102_400)

    assert _encoded_size(result) > 102_400
    assert _encoded_size(bounded) <= 102_400
    assert bounded["arguments"]["_truncated"] is True


def test_three_consecutive_model_failures_finish_the_run() -> None:
    workflow = AgentWorkflow()
    calls: list[tuple[str, dict[str, Any]]] = []

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        calls.append((name, payload))
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            raise RuntimeError("provider unavailable")
        return None

    workflow._call = call  # type: ignore[method-assign]
    async def sleep(_: float) -> None:
        return None
    workflow._sleep = sleep  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert sum(name == "agent_model_decide" for name, _ in calls) == 3
    assert calls[-1][0] == "agent_finish"
    assert calls[-1][1]["status"] == "failed"
    assert calls[-1][1]["error_code"] == "agent_consecutive_failures"


def test_handled_model_error_stops_without_another_model_round() -> None:
    workflow = AgentWorkflow()
    calls: list[tuple[str, dict[str, Any]]] = []

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        calls.append((name, payload))
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            return {
                "type": "model_error",
                "error_code": "model_provider_auth_failed",
                "message": "模型 API 密钥无效或没有权限",
                "retryable": False,
            }
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert sum(name == "agent_model_decide" for name, _ in calls) == 1
    assert calls[-1][0] == "agent_finish"
    assert calls[-1][1]["error_code"] == "model_provider_auth_failed"


def test_handled_final_judge_error_stops_without_repeating_judge() -> None:
    workflow = AgentWorkflow()
    calls: list[tuple[str, dict[str, Any]]] = []

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        calls.append((name, payload))
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            return {"type": "final", "answer": "检查已经完成", "evidence": []}
        if name == "agent_judge_final":
            return {
                "type": "model_error",
                "error_code": "model_provider_auth_failed",
                "message": "模型 API 密钥无效或没有权限",
                "retryable": False,
            }
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert sum(name == "agent_model_decide" for name, _ in calls) == 1
    assert sum(name == "agent_judge_final" for name, _ in calls) == 1
    assert calls[-1][0] == "agent_finish"
    assert calls[-1][1]["status"] == "failed"
    assert calls[-1][1]["error_code"] == "model_provider_auth_failed"


def test_write_tool_executes_directly_without_approval() -> None:
    workflow = AgentWorkflow()
    calls: list[tuple[str, dict[str, Any]]] = []
    decisions = iter([
        {
            "type": "tool_call",
            "tool": "update_business_profile",
            "arguments": {"changes": {"business_name": "New"}},
        },
        {
            "type": "final",
            "answer": "业务资料已更新。",
            "evidence": [],
            "research": None,
        },
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        calls.append((name, payload))
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            return next(decisions)
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标已完成"}
        if name == "agent_stream_final":
            return {
                "answer": payload["answer"],
                "message_id": "final-message-1",
                "streamed": True,
            }
        if name == "agent_execute_tool":
            return {
                "tool": payload["tool"], "ok": True, "summary": "已完成",
                "data": {}, "error_code": None, "retryable": False, "cost": 0.0,
            }
        return None

    workflow._call = call  # type: ignore[method-assign]
    async def sleep(_: float) -> None:
        return None
    workflow._sleep = sleep  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    names = [name for name, _ in calls]
    assert "agent_execute_tool" in names
    assert "agent_prepare_action" not in names
    assert "agent_action_decision" not in names
    assert "agent_execute_action" not in names
    assert calls[-1][1]["status"] == "completed"


def test_retry_reuses_the_same_tool_call_id() -> None:
    workflow = AgentWorkflow()
    tool_call_ids: list[str] = []
    decisions = iter([
        {"type": "tool_call", "tool": "get_latest_audit", "arguments": {}},
        {"type": "final", "answer": "完成", "evidence": []},
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            return next(decisions)
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标已完成"}
        if name == "agent_execute_tool":
            tool_call_ids.append(payload["tool_call_id"])
            return {
                "tool": kwargs["tool"], "ok": len(tool_call_ids) == 2,
                "summary": "temporary", "data": {},
                "error_code": "temporary", "retryable": len(tool_call_ids) == 1,
                "cost": 0.0,
            }
        return None

    workflow._call = call  # type: ignore[method-assign]
    async def sleep(_: float) -> None:
        return None
    workflow._sleep = sleep  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert tool_call_ids == ["run-1:1:1", "run-1:1:1"]


def test_read_tools_in_one_model_response_execute_in_parallel() -> None:
    workflow = AgentWorkflow()
    active = 0
    max_active = 0
    started = 0
    both_started = asyncio.Event()
    execution_payloads: list[dict[str, Any]] = []
    decisions = iter([
        {
            "type": "tool_calls",
            "tool_calls": [
                {
                    "tool_call_id": "provider-call-1",
                    "tool": "get_project_profile",
                    "arguments": {},
                },
                {
                    "tool_call_id": "provider-call-2",
                    "tool": "get_latest_audit",
                    "arguments": {},
                },
            ],
        },
        {"type": "final", "answer": "完成", "evidence": []},
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        nonlocal active, max_active, started
        if name == "agent_check_run":
            return {"allowed": True, "usage": {"tool_calls": 0}}
        if name == "agent_model_decide":
            return next(decisions)
        if name == "agent_execute_tool":
            execution_payloads.append(payload)
            active += 1
            started += 1
            max_active = max(max_active, active)
            if started == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), timeout=1)
            active -= 1
            return {
                "tool": kwargs["tool"], "ok": True, "summary": "读取完成",
                "data": {}, "error_code": None, "retryable": False, "cost": 0.0,
            }
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标已完成"}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert max_active == 2
    assert execution_payloads == [
        {"run_id": "run-1", "tool_call_id": "run-1:1:1"},
        {"run_id": "run-1", "tool_call_id": "run-1:1:2"},
    ]


def test_parallel_read_failure_does_not_discard_other_read_result() -> None:
    workflow = AgentWorkflow()
    executed: list[tuple[str, bool]] = []
    decisions = iter([
        {
            "type": "tool_calls",
            "tool_calls": [
                {"tool": "get_project_profile", "arguments": {}},
                {"tool": "get_latest_audit", "arguments": {}},
            ],
        },
        {"type": "final", "answer": "完成", "evidence": []},
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {"allowed": True, "usage": {"tool_calls": 0}}
        if name == "agent_model_decide":
            return next(decisions)
        if name == "agent_execute_tool":
            tool = str(kwargs["tool"])
            succeeded = tool == "get_latest_audit"
            executed.append((tool, succeeded))
            return {
                "tool": tool, "ok": succeeded,
                "summary": "读取完成" if succeeded else "读取失败",
                "data": {"audit": None} if succeeded else {},
                "error_code": None if succeeded else "invalid_tool_arguments",
                "retryable": False, "cost": 0.0,
            }
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标已完成"}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert executed == [
        ("get_project_profile", False),
        ("get_latest_audit", True),
    ]


def test_write_tools_stay_serial_and_keep_model_order() -> None:
    calls = [
        {"tool": "get_project_profile", "arguments": {}},
        {"tool": "get_latest_audit", "arguments": {}},
        {
            "tool": "update_business_profile",
            "arguments": {"changes": {"business_name": "New"}},
        },
        {"tool": "get_project_profile", "arguments": {}},
    ]

    groups = AgentWorkflow._execution_groups(calls)

    assert [[call["tool"] for _, call in group] for group in groups] == [
        ["get_project_profile", "get_latest_audit"],
        ["update_business_profile"],
        ["get_project_profile"],
    ]


def test_scheduling_uses_tool_metadata_instead_of_tool_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(
        TOOL_DEFINITIONS,
        "metadata_write",
        ToolDefinition(
            "metadata_write",
            "test-only state change",
            EmptyArgs,
            modifies_data=True,
            invalidates_remaining_calls=True,
        ),
    )
    calls = [
        {"tool": "get_project_profile", "arguments": {}},
        {"tool": "metadata_write", "arguments": {}},
        {"tool": "get_latest_audit", "arguments": {}},
    ]

    scheduled, skipped = AgentWorkflow._calls_until_replan(calls)
    groups = AgentWorkflow._execution_groups(scheduled)

    assert [call["tool"] for call in scheduled] == [
        "get_project_profile",
        "metadata_write",
    ]
    assert [call["tool"] for call in skipped] == ["get_latest_audit"]
    assert [[call["tool"] for _, call in group] for group in groups] == [
        ["get_project_profile"],
        ["metadata_write"],
    ]


def test_tool_timeout_uses_modifies_data_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setitem(
        TOOL_DEFINITIONS,
        "metadata_write",
        ToolDefinition(
            "metadata_write",
            "test-only state change",
            EmptyArgs,
            modifies_data=True,
        ),
    )
    captured: dict[str, Any] = {}

    async def execute_activity(name: str, payload: dict[str, Any], **kwargs: Any) -> None:
        captured.update(kwargs)

    monkeypatch.setattr(agent_workflows.workflow, "execute_activity", execute_activity)

    asyncio.run(AgentWorkflow()._call(
        "agent_execute_tool",
        {"run_id": "run-1"},
        LIMITS,
        tool="metadata_write",
    ))

    assert captured["start_to_close_timeout"].total_seconds() == 180
    assert captured["schedule_to_close_timeout"].total_seconds() == 360
    assert captured["heartbeat_timeout"].total_seconds() == 10
    assert captured["retry_policy"].maximum_attempts == 0


def test_state_changing_tool_discards_later_calls_and_replans() -> None:
    workflow = AgentWorkflow()
    executed: list[str] = []
    model_payloads: list[dict[str, Any]] = []
    decisions = iter([
        {
            "type": "tool_calls",
            "tool_calls": [
                {
                    "tool_call_id": "provider-write-1",
                    "tool": "update_business_profile",
                    "arguments": {"changes": {"business_name": "New"}},
                },
                {
                    "tool_call_id": "provider-read-1",
                    "tool": "get_project_profile",
                    "arguments": {},
                },
            ],
        },
        {"type": "final", "answer": "已更新。", "evidence": []},
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {"allowed": True, "usage": {"tool_calls": len(executed)}}
        if name == "agent_model_decide":
            model_payloads.append(payload)
            return next(decisions)
        if name == "agent_execute_tool":
            executed.append(str(kwargs["tool"]))
            return {
                "tool": kwargs["tool"], "ok": True, "summary": "修改完成",
                "data": {"verified": True}, "error_code": None,
                "retryable": False, "cost": 0.0,
            }
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标已完成"}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert executed == ["update_business_profile"]
    assert model_payloads[1]["execution_feedback"] == {
        "type": "state_changed",
        "tool": "update_business_profile",
        "skipped_tool_calls": 1,
        "reason": (
            "状态变更工具执行后，本批剩余工具未执行；"
            "请根据执行结果和当前项目状态重新判断"
        ),
    }


def test_failed_state_changing_tool_still_discards_stale_later_calls() -> None:
    workflow = AgentWorkflow()
    executed: list[str] = []
    model_payloads: list[dict[str, Any]] = []
    decisions = iter([
        {
            "type": "tool_calls",
            "tool_calls": [
                {
                    "tool_call_id": "provider-write-1",
                    "tool": "update_business_profile",
                    "arguments": {"changes": {"business_name": "New"}},
                },
                {
                    "tool_call_id": "provider-read-1",
                    "tool": "get_project_profile",
                    "arguments": {},
                },
            ],
        },
        {"type": "final", "answer": "修改失败，未继续使用旧状态。", "evidence": []},
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {"allowed": True, "usage": {"tool_calls": len(executed)}}
        if name == "agent_model_decide":
            model_payloads.append(payload)
            return next(decisions)
        if name == "agent_execute_tool":
            executed.append(str(kwargs["tool"]))
            return {
                "tool": kwargs["tool"], "ok": False, "summary": "状态冲突",
                "data": {}, "error_code": "agent_state_conflict",
                "retryable": False, "cost": 0.0,
            }
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "已如实说明失败"}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert executed == ["update_business_profile"]
    assert model_payloads[1]["execution_feedback"]["type"] == "state_changed"
    assert model_payloads[1]["execution_feedback"]["skipped_tool_calls"] == 1


def test_identical_tool_results_trigger_replan_feedback() -> None:
    workflow = AgentWorkflow()
    model_payloads: list[dict[str, Any]] = []
    decisions = iter([
        {"type": "tool_call", "tool": "get_latest_audit", "arguments": {}},
        {"type": "tool_call", "tool": "get_latest_audit", "arguments": {}},
        {"type": "final", "answer": "没有可用审核。", "evidence": []},
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {"allowed": True, "usage": {"tool_calls": 0}}
        if name == "agent_model_decide":
            model_payloads.append(payload)
            return next(decisions)
        if name == "agent_execute_tool":
            return {
                "tool": kwargs["tool"], "ok": True, "summary": "暂无审核",
                "data": {"run_id": None}, "error_code": None,
                "retryable": False, "cost": 0.0,
            }
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标已完成"}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert model_payloads[0]["execution_feedback"] is None
    assert model_payloads[1]["execution_feedback"] is None
    assert model_payloads[2]["execution_feedback"] == {
        "type": "no_progress",
        "repeated_rounds": 2,
        "reason": (
            "连续多轮调用没有得到新的业务结果；"
            "请更换工具、参数或基于已有证据结束，不要原样重复"
        ),
    }


def tool_result(tool: str, data: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "tool": tool,
        "arguments": arguments,
        "ok": True,
        "summary": "读取完成",
        "data": data,
        "error_code": None,
    }


def test_loop_detector_treats_status_transition_as_progress() -> None:
    detector = AgentLoopDetector()

    assert detector.record([
        tool_result("get_audit_status", {"run_id": "audit-1", "status": "running"}, {"run_id": "audit-1"})
    ]) is None
    assert detector.record([
        tool_result("get_audit_status", {"run_id": "audit-1", "status": "completed"}, {"run_id": "audit-1"})
    ]) is None


def test_loop_detector_treats_new_page_items_as_progress() -> None:
    detector = AgentLoopDetector()

    assert detector.record([
        tool_result(
            "get_audit_pages",
            {"items": [{"url": "https://example.com/a"}], "total": 2, "page": 1},
            {"run_id": "audit-1", "page": 1},
        )
    ]) is None
    assert detector.record([
        tool_result(
            "get_audit_pages",
            {"items": [{"url": "https://example.com/b"}], "total": 2, "page": 2},
            {"run_id": "audit-1", "page": 2},
        )
    ]) is None


def test_loop_detector_warns_when_different_pages_add_no_evidence() -> None:
    detector = AgentLoopDetector()

    assert detector.record([
        tool_result(
            "get_audit_pages", {"items": [], "total": 0, "page": 2},
            {"run_id": "audit-1", "page": 2},
        )
    ]) is None
    feedback = detector.record([
        tool_result(
            "get_audit_pages", {"items": [], "total": 0, "page": 3},
            {"run_id": "audit-1", "page": 3},
        )
    ])

    assert feedback is not None
    assert feedback["type"] == "no_progress"


def test_loop_detector_allows_one_unchanged_status_poll() -> None:
    detector = AgentLoopDetector()
    result = tool_result(
        "get_audit_status", {"run_id": "audit-1", "status": "running"},
        {"run_id": "audit-1"},
    )

    assert detector.record([result]) is None
    assert detector.record([result]) is None
    assert detector.record([result])["type"] == "no_progress"


def test_loop_detector_warns_on_alternating_actions_without_new_evidence() -> None:
    detector = AgentLoopDetector()
    audit = tool_result(
        "get_latest_audit", {"run_id": "audit-1", "status": "running"}, {},
    )
    status = tool_result(
        "get_audit_status", {"run_id": "audit-1", "status": "running"},
        {"run_id": "audit-1"},
    )

    assert detector.record([audit]) is None
    assert detector.record([status]) is None
    feedback = detector.record([audit])

    assert feedback is not None
    assert feedback["type"] == "no_progress"


def test_loop_detector_allows_alternating_actions_with_new_evidence() -> None:
    detector = AgentLoopDetector()

    assert detector.record([tool_result(
        "get_latest_audit", {"run_id": "audit-1", "status": "running"}, {},
    )]) is None
    assert detector.record([tool_result(
        "get_audit_status", {"run_id": "audit-1", "status": "running"},
        {"run_id": "audit-1"},
    )]) is None
    assert detector.record([tool_result(
        "get_latest_audit", {"run_id": "audit-1", "status": "completed"}, {},
    )]) is None


def test_identical_non_retryable_failure_is_not_executed_again() -> None:
    workflow = AgentWorkflow()
    executed: list[dict[str, Any]] = []
    model_payloads: list[dict[str, Any]] = []
    decisions = iter([
        {
            "type": "tool_call", "tool": "get_audit_status",
            "arguments": {"run_id": "missing"},
        },
        {
            "type": "tool_call", "tool": "get_audit_status",
            "arguments": {"run_id": "missing"},
        },
        {"type": "final", "answer": "未找到该审核。", "evidence": []},
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {"allowed": True, "usage": {"tool_calls": len(executed)}}
        if name == "agent_model_decide":
            model_payloads.append(payload)
            return next(decisions)
        if name == "agent_execute_tool":
            executed.append(payload)
            return {
                "tool": kwargs["tool"], "ok": False, "summary": "审核不存在",
                "data": {}, "error_code": "audit_not_found",
                "retryable": False, "cost": 0.0,
            }
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "已如实说明"}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert len(executed) == 1
    assert executed == [{"run_id": "run-1", "tool_call_id": "run-1:1:1"}]


def test_non_retryable_failure_with_changed_arguments_is_executed() -> None:
    workflow = AgentWorkflow()
    executed: list[dict[str, Any]] = []
    decisions = iter([
        {
            "type": "tool_call", "tool": "get_audit_status",
            "arguments": {"run_id": "missing-1"},
        },
        {
            "type": "tool_call", "tool": "get_audit_status",
            "arguments": {"run_id": "missing-2"},
        },
        {"type": "final", "answer": "两个审核都不存在。", "evidence": []},
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {"allowed": True, "usage": {"tool_calls": len(executed)}}
        if name == "agent_model_decide":
            return next(decisions)
        if name == "agent_execute_tool":
            executed.append(payload)
            return {
                "tool": kwargs["tool"], "ok": False, "summary": "审核不存在",
                "data": {}, "error_code": "audit_not_found",
                "retryable": False, "cost": 0.0,
            }
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "已如实说明"}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert [item["tool_call_id"] for item in executed] == [
        "run-1:1:1", "run-1:2:1",
    ]


def test_final_only_remains_enabled_on_last_round() -> None:
    workflow = AgentWorkflow()
    model_payloads: list[dict[str, Any]] = []
    decisions = iter([
        {"type": "tool_call", "tool": "get_latest_audit", "arguments": {}},
        {"type": "final", "answer": "完成", "evidence": []},
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {
                "allowed": True,
                "usage": {"model_calls": 6, "tool_calls": 0},
            }
        if name == "agent_model_decide":
            model_payloads.append(payload)
            return next(decisions)
        if name == "agent_execute_tool":
            return {
                "tool": kwargs["tool"], "ok": True, "summary": "完成",
                "data": {}, "error_code": None, "retryable": False, "cost": 0.0,
            }
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标已完成"}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({
        "run_id": "run-1",
        "limits": {**LIMITS, "model_rounds": 8},
    }))

    assert model_payloads[0]["execution_feedback"] is None
    assert model_payloads[1]["execution_feedback"] is None

    final_workflow = AgentWorkflow()
    final_payloads: list[dict[str, Any]] = []

    async def final_call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {
                "allowed": True,
                "usage": {"model_calls": 6, "tool_calls": 0},
            }
        if name == "agent_model_decide":
            final_payloads.append(payload)
            return {"type": "final", "answer": "如实收尾", "evidence": []}
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标已完成"}
        return None

    final_workflow._call = final_call  # type: ignore[method-assign]
    asyncio.run(final_workflow.run({
        "run_id": "run-2",
        "limits": {**LIMITS, "model_rounds": 1},
    }))

    assert final_payloads[0]["final_only"] is True
    assert final_payloads[0]["execution_feedback"] is None


def test_tool_batch_is_not_stopped_by_a_separate_call_count_limit() -> None:
    workflow = AgentWorkflow()
    executed: list[str] = []
    finishes: list[dict[str, Any]] = []
    decisions = iter([
        {
            "type": "tool_calls",
            "tool_calls": [
                {"tool": "get_project_profile", "arguments": {}},
                {"tool": "get_latest_audit", "arguments": {}},
            ],
        },
        {"type": "final", "answer": "完成", "evidence": []},
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {"allowed": True, "usage": {"tool_calls": 1}}
        if name == "agent_model_decide":
            return next(decisions)
        if name == "agent_execute_tool":
            executed.append(str(kwargs["tool"]))
            return {
                "tool": kwargs["tool"], "ok": True, "summary": "完成",
                "data": {}, "error_code": None, "retryable": False, "cost": 0.0,
            }
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标已完成"}
        if name == "agent_stream_final":
            return {
                "answer": payload["answer"],
                "message_id": "final-message-1",
                "streamed": True,
            }
        if name == "agent_finish":
            finishes.append(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({
        "run_id": "run-1",
        "limits": {**LIMITS, "tool_calls": 2},
    }))

    assert executed == ["get_project_profile", "get_latest_audit"]
    assert finishes[0]["status"] == "completed"


def test_retry_waits_with_backoff_and_checks_stop_again() -> None:
    workflow = AgentWorkflow()
    checks = 0
    tool_calls = 0
    sleeps: list[float] = []
    finished: list[dict[str, Any]] = []

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        nonlocal checks, tool_calls
        if name == "agent_check_run":
            checks += 1
            return (
                {"allowed": False, "status": "cancelled", "reason": "任务已取消"}
                if checks >= 4
                else {"allowed": True}
            )
        if name == "agent_model_decide":
            return {"type": "tool_call", "tool": "get_latest_audit", "arguments": {}}
        if name == "agent_execute_tool":
            tool_calls += 1
            return {
                "tool": kwargs["tool"], "ok": False, "summary": "temporary", "data": {},
                "error_code": "temporary", "retryable": True, "cost": 0.0,
            }
        if name == "agent_finish":
            finished.append(payload)
        return None

    async def sleep(seconds: float) -> None:
        sleeps.append(seconds)

    workflow._call = call  # type: ignore[method-assign]
    workflow._sleep = sleep  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert tool_calls == 1
    assert sleeps == [1.0]
    assert finished == []


def test_last_execution_round_forces_final_response_without_new_tool() -> None:
    workflow = AgentWorkflow()
    model_payloads: list[dict[str, Any]] = []

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            model_payloads.append(payload)
            if payload["round"] == 1:
                return {"type": "tool_call", "tool": "get_latest_audit", "arguments": {}}
            return {"type": "final", "answer": "已完成", "evidence": []}
        if name == "agent_execute_tool":
            return {
                "tool": kwargs["tool"], "ok": True, "summary": "完成", "data": {},
                "error_code": None, "retryable": False, "cost": 0.0,
            }
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标已完成"}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": {**LIMITS, "model_rounds": 2}}))

    assert model_payloads[0].get("final_only") is False
    assert model_payloads[1]["final_only"] is True


def test_last_allowed_model_response_is_checked_and_finished() -> None:
    workflow = AgentWorkflow()
    checks: list[dict[str, Any]] = []
    finishes: list[dict[str, Any]] = []

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            checks.append(payload)
            if len(checks) == 1 or payload.get("ignore_model_rounds"):
                return {"allowed": True}
            return {
                "allowed": False,
                "status": "limit_reached",
                "reason_code": "model_rounds",
                "reason": "model rounds reached",
            }
        if name == "agent_model_decide":
            return {"type": "final", "answer": "done", "evidence": []}
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "goal completed"}
        if name == "agent_stream_final":
            return {
                "answer": payload["answer"],
                "message_id": "final-message-1",
                "streamed": True,
            }
        if name == "agent_finish":
            finishes.append(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(
        workflow.run({"run_id": "run-1", "limits": {**LIMITS, "model_rounds": 1}})
    )

    assert len(finishes) == 1
    assert finishes[0]["status"] == "completed"
    assert all(check.get("ignore_model_rounds") for check in checks[1:])


def test_project_memory_runs_as_a_state_changing_tool_and_replans() -> None:
    workflow = AgentWorkflow()
    calls: list[tuple[str, dict[str, Any]]] = []
    model_payloads: list[dict[str, Any]] = []
    executed: list[str] = []
    decisions = iter([
        {
            "type": "tool_calls",
            "tool_calls": [
                {
                    "tool_call_id": "memory-call-1",
                    "tool": "update_project_memory",
                    "arguments": {"operations": [{
                        "operation": "add",
                        "category": "target_customers",
                        "value": "大型企业",
                        "source": "user_confirmed",
                    }]},
                },
                {
                    "tool_call_id": "read-call-1",
                    "tool": "get_project_profile",
                    "arguments": {},
                },
            ],
        },
        {"type": "final", "answer": "已记住。", "evidence": []},
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        calls.append((name, payload))
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            model_payloads.append(payload)
            return next(decisions)
        if name == "agent_execute_tool":
            executed.append(str(kwargs["tool"]))
            return {
                "tool_call_id": payload["tool_call_id"],
                "tool": kwargs["tool"],
                "ok": True,
                "summary": "项目记忆已保存并校验，共处理 1 项",
                "data": {
                    "verified": True,
                    "facts": [{
                        "fact_id": "fact-1",
                        "category": "target_customers",
                        "value": "大型企业",
                        "source": "user_confirmed",
                    }],
                },
                "error_code": None,
                "retryable": False,
                "cost": 0.0,
            }
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标已完成"}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert executed == ["update_project_memory"]
    assert model_payloads[1]["execution_feedback"] == {
        "type": "state_changed",
        "tool": "update_project_memory",
        "skipped_tool_calls": 1,
        "reason": (
            "状态变更工具执行后，本批剩余工具未执行；"
            "请根据执行结果和当前项目状态重新判断"
        ),
    }
    assert "tool_results" not in model_payloads[1]


def test_project_memory_tool_failure_is_returned_to_the_next_model_round() -> None:
    workflow = AgentWorkflow()
    model_payloads: list[dict[str, Any]] = []
    decisions = iter([
        {
            "type": "tool_calls",
            "tool_calls": [{
                "tool_call_id": "memory-call-1",
                "tool": "update_project_memory",
                "arguments": {"operations": [{
                    "operation": "delete",
                    "fact_id": "fact-missing",
                    "source": "user_confirmed",
                }]},
            }],
        },
        {"type": "final", "answer": "没有删除，指定记忆不存在。", "evidence": []},
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            model_payloads.append(payload)
            return next(decisions)
        if name == "agent_execute_tool":
            return {
                "tool_call_id": payload["tool_call_id"],
                "tool": kwargs["tool"],
                "ok": False,
                "summary": "要修改的项目记忆不存在",
                "data": {},
                "error_code": "not_found",
                "retryable": False,
                "cost": 0.0,
            }
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标已完成"}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert "tool_results" not in model_payloads[1]


@pytest.mark.parametrize("judge_status", ["partial", "failed", "blocked"])
def test_last_round_judge_prevents_false_completed_status(judge_status: str) -> None:
    workflow = AgentWorkflow()
    finishes: list[dict[str, Any]] = []

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            return {"type": "final", "answer": "全部完成", "evidence": []}
        if name == "agent_judge_final":
            return {"status": judge_status, "reason": "缺少成功证据"}
        if name == "agent_finish":
            finishes.append(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert finishes[-1]["status"] == "failed"
    assert finishes[-1]["error_code"] == f"agent_final_check_{judge_status}"
    assert finishes[-1]["judge"]["status"] == judge_status


def test_failed_judge_feedback_can_trigger_more_tools_and_then_complete() -> None:
    workflow = AgentWorkflow()
    model_payloads: list[dict[str, Any]] = []
    finishes: list[dict[str, Any]] = []
    decisions = iter([
        {"type": "final", "answer": "健康分是 86。", "evidence": []},
        {"type": "tool_call", "tool": "get_latest_audit", "arguments": {}},
        {
            "type": "final",
            "answer": "健康分是 86，三个问题分别影响 5、4、3 页。",
            "evidence": [],
        },
    ])
    judge_results = iter([
        {
            "status": "partial",
            "reason": "缺少三个问题的影响页数",
            "criteria": [{
                "requirement": "列出三个问题的影响页数",
                "status": "partial",
                "evidence": "当前只返回健康分",
            }],
            "remaining_work": ["读取并回答三个问题的影响页数"],
        },
        {
            "status": "completed",
            "reason": "目标已完整回答",
            "criteria": [{
                "requirement": "列出三个问题的影响页数",
                "status": "completed",
                "evidence": "已返回5、4、3页",
            }],
            "remaining_work": [],
        },
    ])

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            model_payloads.append(payload)
            return next(decisions)
        if name == "agent_judge_final":
            return next(judge_results)
        if name == "agent_stream_final":
            return {
                "answer": payload["answer"],
                "message_id": "final-message-1",
                "streamed": True,
            }
        if name == "agent_execute_tool":
            return {
                "tool": kwargs["tool"], "ok": True, "summary": "读取完成",
                "data": {"top_issues": {"items": []}}, "error_code": None,
                "retryable": False, "cost": 0.0,
            }
        if name == "agent_finish":
            finishes.append(payload)
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert model_payloads[0]["judge_feedback"] is None
    assert model_payloads[1]["judge_feedback"] == {
        "status": "partial",
        "reason": "缺少三个问题的影响页数",
        "criteria": [{
            "requirement": "列出三个问题的影响页数",
            "status": "partial",
            "evidence": "当前只返回健康分",
        }],
        "remaining_work": ["读取并回答三个问题的影响页数"],
        "previous_answer": "健康分是 86。",
    }
    assert model_payloads[2]["judge_feedback"] == model_payloads[1]["judge_feedback"]
    assert finishes[-1]["status"] == "completed"
    assert finishes[-1]["judge"]["status"] == "completed"


def test_model_returned_tool_is_not_executed_after_cancellation() -> None:
    workflow = AgentWorkflow()
    checks = 0
    calls: list[str] = []

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        nonlocal checks
        calls.append(name)
        if name == "agent_check_run":
            checks += 1
            return (
                {"allowed": True}
                if checks == 1
                else {"allowed": False, "status": "cancelled", "reason": "任务已取消"}
            )
        if name == "agent_model_decide":
            return {"type": "tool_call", "tool": "get_latest_audit", "arguments": {}}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert "agent_execute_tool" not in calls


def test_temporal_cancellation_never_becomes_a_failure_or_next_step(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workflow = AgentWorkflow()
    calls: list[str] = []

    async def execute_activity(name: str, payload: dict[str, Any], **kwargs: Any) -> Any:
        calls.append(name)
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            error = ActivityError(
                "activity cancelled", scheduled_event_id=1, started_event_id=2,
                identity="worker", activity_type=name, activity_id="1",
                retry_state=None,
            )
            error.__cause__ = CancelledError("cancelled")
            raise error
        return None

    monkeypatch.setattr(agent_workflows.workflow, "execute_activity", execute_activity)
    with pytest.raises(CancelledError):
        asyncio.run(workflow.run({"run_id": "run-1", "limits": LIMITS}))

    assert calls == ["agent_set_status", "agent_check_run", "agent_model_decide"]


def test_completed_answer_is_bounded_judged_delivered_and_persisted_unchanged() -> None:
    workflow = AgentWorkflow()
    calls: list[tuple[str, dict[str, Any]]] = []

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        calls.append((name, payload))
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            return {"type": "final", "answer": "123456", "evidence": []}
        if name == "agent_judge_final":
            return {"status": "completed", "reason": "目标完成"}
        if name == "agent_stream_final":
            return {
                "answer": payload["answer"],
                "message_id": "message-final",
                "streamed": True,
            }
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({
        "run_id": "run-1",
        "limits": {**LIMITS, "final_answer_chars": 4},
    }))

    names = [name for name, _ in calls]
    judge_index = names.index("agent_judge_final")
    stream_index = names.index("agent_stream_final")
    finish_index = names.index("agent_finish")
    assert judge_index < stream_index < finish_index
    assert calls[judge_index][1]["answer"] == "1234"
    assert calls[stream_index][1]["answer"] == "1234"
    assert calls[finish_index][1]["answer"] == "1234"
    assert calls[finish_index][1]["message_id"] == "message-final"


def test_failed_judge_never_starts_final_response_stream() -> None:
    workflow = AgentWorkflow()
    calls: list[str] = []

    async def call(
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        **kwargs: Any,
    ) -> Any:
        calls.append(name)
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            return {"type": "final", "answer": "草稿", "evidence": []}
        if name == "agent_judge_final":
            return {"status": "failed", "reason": "缺少证据"}
        return None

    workflow._call = call  # type: ignore[method-assign]
    asyncio.run(workflow.run({
        "run_id": "run-1", "limits": {**LIMITS, "model_rounds": 1},
    }))

    assert "agent_stream_final" not in calls
    assert calls[-1] == "agent_finish"


def test_stream_activity_uses_configured_model_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workflow = AgentWorkflow()
    captured: dict[str, Any] = {}

    async def execute_activity(name: str, payload: dict[str, Any], **kwargs: Any) -> Any:
        captured.update(kwargs)
        return {}

    monkeypatch.setattr(agent_workflows.workflow, "execute_activity", execute_activity)
    asyncio.run(workflow._call(
        "agent_stream_final", {"run_id": "run-1"},
        {**LIMITS, "model_timeout_seconds": 123},
    ))

    assert captured["start_to_close_timeout"].total_seconds() == 123
