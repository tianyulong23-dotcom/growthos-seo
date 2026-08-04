from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import CancelledError, is_cancelled_exception

with workflow.unsafe.imports_passed_through():
    from app.modules.agent.lease import TOOL_HEARTBEAT_TIMEOUT_SECONDS
    from app.modules.agent.security import sanitize_text
    from app.modules.agent.tools import TOOL_DEFINITIONS


CONTROL_ACTIVITY_RETRY = RetryPolicy(maximum_attempts=2)
MODEL_ACTIVITY_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=5),
    maximum_attempts=2,
)
TOOL_ACTIVITY_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=5),
    maximum_attempts=0,
)
MAX_TOOL_ATTEMPTS = 2
LOOP_HISTORY_SIZE = 20


def _encoded_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def _compact_tool_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    encoded = json.dumps(
        arguments, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    return {
        "_truncated": True,
        "original_bytes": len(encoded),
        "sha256": hashlib.sha256(encoded).hexdigest(),
    }


def _bound_tool_history_result(
    result: dict[str, Any], max_bytes: int
) -> dict[str, Any]:
    if _encoded_size(result) <= max_bytes:
        return result
    bounded = dict(result)
    bounded["arguments"] = _compact_tool_arguments(dict(result.get("arguments", {})))
    if _encoded_size(bounded) <= max_bytes:
        return bounded

    data = result.get("data")
    compact_data = {
        key: data[key]
        for key in (
            "id", "run_id", "status", "verified", "already_completed",
            "operation_id", "requested_count", "completed_count", "failed_count",
            "record_ids", "completion",
        )
        if isinstance(data, dict) and key in data
    }
    compact_data.update({
        "truncated": True,
        "message": "工具结果超过平台限制，已只保留执行状态",
    })
    bounded["summary"] = str(result.get("summary", ""))[:1_000]
    bounded["data"] = compact_data
    if _encoded_size(bounded) <= max_bytes:
        return bounded

    bounded["summary"] = "工具消息超过平台限制，已只保留执行状态"
    bounded["data"] = {}
    if _encoded_size(bounded) <= max_bytes:
        return bounded
    raise ValueError("工具消息大小限制不足以保存最简执行状态")


def _modifies_data(tool: str) -> bool:
    definition = TOOL_DEFINITIONS.get(tool)
    return bool(definition and definition.modifies_data)


def _invalidates_remaining_calls(tool: str) -> bool:
    definition = TOOL_DEFINITIONS.get(tool)
    return bool(definition and definition.invalidates_remaining_calls)


class AgentLoopDetector:
    def __init__(self, history_size: int = LOOP_HISTORY_SIZE) -> None:
        self.history_size = history_size
        self._history: list[tuple[str, str]] = []

    def reset(self) -> None:
        self._history.clear()

    def record(self, results: list[dict[str, Any]]) -> dict[str, Any] | None:
        if not results:
            return None
        action = self._fingerprint([
            {
                "tool": result.get("tool"),
                "arguments": self._normalize(
                    result.get("arguments", {}),
                    omitted_keys={"page", "page_size"},
                ),
            }
            for result in results
        ])
        evidence = self._fingerprint([
            {
                "ok": bool(result.get("ok")),
                "error_code": result.get("error_code"),
                "data": self._normalize(
                    result.get("data", {}),
                    omitted_keys={
                        "page", "page_size", "next_page",
                        "created_at", "updated_at", "started_at", "finished_at",
                    },
                ),
            }
            for result in results
        ])
        pair = (action, evidence)
        same_evidence_as_previous = bool(
            self._history and self._history[-1][1] == evidence
        )
        occurrences = sum(previous == pair for previous in self._history) + 1
        self._history.append(pair)
        self._history = self._history[-self.history_size :]

        status_poll = all(result.get("tool") == "get_audit_status" for result in results)
        threshold = 3 if status_poll else 2
        if not same_evidence_as_previous or occurrences < threshold:
            return None
        return {
            "type": "no_progress",
            "repeated_rounds": occurrences,
            "reason": (
                "连续多轮调用没有得到新的业务结果；"
                "请更换工具、参数或基于已有证据结束，不要原样重复"
            ),
        }

    @classmethod
    def _normalize(
        cls,
        value: Any,
        *,
        omitted_keys: set[str],
    ) -> Any:
        if isinstance(value, dict):
            return {
                str(key): cls._normalize(item, omitted_keys=omitted_keys)
                for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
                if str(key) not in omitted_keys
            }
        if isinstance(value, list):
            return [cls._normalize(item, omitted_keys=omitted_keys) for item in value]
        return value

    @staticmethod
    def _fingerprint(value: Any) -> str:
        encoded = json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        ).encode()
        return hashlib.sha256(encoded).hexdigest()


@workflow.defn(name="AgentWorkflow")
class AgentWorkflow:
    @workflow.run
    async def run(self, payload: dict[str, Any]) -> None:
        run_id = str(payload["run_id"])
        limits = dict(payload["limits"])
        judge_feedback: dict[str, Any] | None = None
        execution_feedback: dict[str, Any] | None = None
        loop_detector = AgentLoopDetector()
        non_retryable_failures: dict[str, dict[str, Any]] = {}
        consecutive_failures = 0
        max_failures = int(limits.get("consecutive_failures", 3))
        open_turn: int | None = None

        await self._call(
            "agent_set_status",
            {"run_id": run_id, "status": "running"},
            limits,
        )
        try:
            for round_number in range(1, int(limits["model_rounds"]) + 1):
                check = await self._check(run_id, limits)
                if not check["allowed"]:
                    await self._finish_stopped(run_id, check, limits)
                    return

                try:
                    open_turn = round_number
                    decision = await self._call(
                        "agent_model_decide",
                        {
                            "run_id": run_id,
                            "round": round_number,
                            "final_only": round_number == int(limits["model_rounds"]),
                            "judge_feedback": judge_feedback,
                            "execution_feedback": execution_feedback,
                        },
                        limits,
                    )
                except CancelledError:
                    raise
                except Exception:
                    await self._finish_turn(run_id, round_number, "error", limits)
                    open_turn = None
                    consecutive_failures += 1
                    if consecutive_failures >= max_failures:
                        await self._finish_failures(run_id, limits)
                        return
                    await self._sleep(self._backoff_seconds(consecutive_failures))
                    check = await self._check(run_id, limits)
                    if not check["allowed"]:
                        await self._finish_stopped(run_id, check, limits)
                        return
                    continue

                if decision.get("type") == "cancelled":
                    open_turn = None
                    return
                if decision.get("type") == "model_error":
                    open_turn = None
                    await self._finish_model_error(run_id, decision, limits)
                    return
                if decision.get("type") == "limit_reached":
                    await self._finish_turn(
                        run_id, round_number, "limit_reached", limits,
                    )
                    open_turn = None
                    await self._finish_stopped(
                        run_id,
                        {
                            "status": "limit_reached",
                            "reason": decision.get(
                                "reason", "本次任务已达到平台运行上限"
                            ),
                        },
                        limits,
                    )
                    return

                check = await self._check(
                    run_id,
                    limits,
                    ignore_model_rounds=True,
                )
                if not check["allowed"]:
                    await self._finish_turn(
                        run_id,
                        round_number,
                        str(check.get("status") or "stopped"),
                        limits,
                    )
                    open_turn = None
                    await self._finish_stopped(run_id, check, limits)
                    return

                if decision["type"] == "final":
                    open_turn = None
                    final_answer = sanitize_text(str(decision["answer"]))[
                        :max(1, int(limits.get("final_answer_chars", 8_000)))
                    ]
                    try:
                        judge = await self._call(
                            "agent_judge_final",
                            {
                                "run_id": run_id,
                                "answer": final_answer,
                            },
                            limits,
                        )
                    except CancelledError:
                        raise
                    except Exception:
                        await self._call(
                            "agent_finish",
                            {
                                "run_id": run_id,
                                "answer": final_answer,
                                "evidence": decision.get("evidence", []),
                                "status": "failed",
                                "error_code": "agent_final_check_failed",
                                "error_message": "最终结果检查失败，不能确认任务已完成",
                            },
                            limits,
                        )
                        return
                    if judge.get("type") == "model_error":
                        await self._call(
                            "agent_finish",
                            {
                                "run_id": run_id,
                                "answer": final_answer,
                                "evidence": decision.get("evidence", []),
                                "status": "failed",
                                "error_code": judge.get(
                                    "error_code", "agent_final_check_failed"
                                ),
                                "error_message": judge.get(
                                    "message", "最终结果检查失败，不能确认任务已完成"
                                ),
                            },
                            limits,
                        )
                        return
                    check = await self._check(
                        run_id,
                        limits,
                        ignore_model_rounds=True,
                    )
                    if not check["allowed"]:
                        await self._finish_stopped(run_id, check, limits)
                        return
                    completed = judge.get("status") == "completed"
                    if not completed and round_number < int(limits["model_rounds"]):
                        judge_feedback = {
                            "status": judge.get("status", "failed"),
                            "reason": judge.get("reason", "最终结果未通过检查"),
                            "criteria": list(judge.get("criteria", [])),
                            "remaining_work": list(judge.get("remaining_work", [])),
                            "previous_answer": final_answer,
                        }
                        continue
                    final_message_id = None
                    if completed:
                        streamed = await self._call(
                            "agent_stream_final",
                            {
                                "run_id": run_id,
                                "answer": final_answer,
                                "evidence": decision.get("evidence", []),
                            },
                            limits,
                        )
                        if streamed.get("cancelled"):
                            return
                        final_message_id = streamed["message_id"]
                    await self._call(
                        "agent_finish",
                        {
                            "run_id": run_id,
                            "answer": final_answer,
                            "message_id": final_message_id,
                            "evidence": decision.get("evidence", []),
                            "research": decision.get("research"),
                            "judge": judge,
                            "status": "completed" if completed else "failed",
                            "error_code": (
                                None if completed
                                else f"agent_final_check_{judge.get('status', 'failed')}"
                            ),
                            "error_message": None if completed else judge.get("reason"),
                        },
                        limits,
                    )
                    return

                calls = self._tool_calls(decision)
                execution_feedback = None
                if round_number == int(limits["model_rounds"]):
                    await self._finish_turn(
                        run_id, round_number, "limit_reached", limits,
                    )
                    open_turn = None
                    await self._finish_stopped(
                        run_id,
                        {
                            "status": "limit_reached",
                            "reason_code": "model_rounds",
                            "reason": "最后一轮未按要求收尾",
                        },
                        limits,
                    )
                    return
                scheduled_calls, skipped_calls = self._calls_until_replan(calls)
                batch_id = f"{run_id}:{round_number}"
                round_results: list[dict[str, Any]] = []
                for group in self._execution_groups(scheduled_calls):
                    if len(group) == 1 or _modifies_data(str(group[0][1]["tool"])):
                        results = [
                            await self._execute_tool_call(
                                run_id, round_number, group[0][0], group[0][1], limits,
                                non_retryable_failures,
                            )
                        ]
                    else:
                        results = list(await asyncio.gather(*(
                            self._execute_tool_call(
                                run_id, round_number, index, call, limits,
                                non_retryable_failures,
                            )
                            for index, call in group
                        )))
                    stop_check = next(
                        (result["_stop_check"] for result in results if "_stop_check" in result),
                        None,
                    )
                    completed_results = [
                        result for result in results if "_stop_check" not in result
                    ]
                    for result in completed_results:
                        round_results.append({**result, "tool_batch_id": batch_id})
                    if stop_check is not None:
                        await self._finish_turn(
                            run_id,
                            round_number,
                            str(stop_check.get("status") or "stopped"),
                            limits,
                            tool_result_count=len(round_results),
                        )
                        open_turn = None
                        await self._finish_stopped(run_id, stop_check, limits)
                        return
                    for result in completed_results:
                        if result["ok"]:
                            consecutive_failures = 0
                        else:
                            consecutive_failures += 1
                            if consecutive_failures >= max_failures:
                                await self._finish_turn(
                                    run_id,
                                    round_number,
                                    "error",
                                    limits,
                                    tool_result_count=len(round_results),
                                )
                                open_turn = None
                                await self._finish_failures(run_id, limits)
                                return

                await self._finish_turn(
                    run_id,
                    round_number,
                    "tool_results",
                    limits,
                    tool_result_count=len(round_results),
                )
                open_turn = None

                if skipped_calls:
                    changed_tool = next(
                        call["tool"] for call in scheduled_calls
                        if _invalidates_remaining_calls(str(call["tool"]))
                    )
                    await self._call(
                        "agent_skip_tool_calls",
                        {
                            "run_id": run_id,
                            "tool_call_ids": [
                                str(call["tool_call_id"]) for call in skipped_calls
                            ],
                        },
                        limits,
                    )
                    execution_feedback = {
                        "type": "state_changed",
                        "tool": changed_tool,
                        "skipped_tool_calls": len(skipped_calls),
                        "reason": (
                            "状态变更工具执行后，本批剩余工具未执行；"
                            "请根据执行结果和当前项目状态重新判断"
                        ),
                    }
                    loop_detector.reset()
                else:
                    execution_feedback = loop_detector.record(round_results)

            await self._finish_stopped(
                run_id,
                {
                    "status": "limit_reached",
                    "reason": "本次任务已达到平台设置的模型轮数上限",
                },
                limits,
            )
        except CancelledError:
            # The API writes the durable cancellation result before cancelling Temporal.
            raise
        except Exception:
            if open_turn is not None:
                await self._finish_turn(run_id, open_turn, "error", limits)
            await self._call(
                "agent_finish",
                {
                    "run_id": run_id,
                    "answer": "Agent 运行失败，本次任务已停止。请稍后重试。",
                    "evidence": [],
                    "status": "failed",
                    "error_code": "agent_run_failed",
                    "error_message": "Agent 运行失败，本次任务已停止。",
                },
                limits,
            )

    async def _check(
        self,
        run_id: str,
        limits: dict[str, Any],
        *,
        ignore_model_rounds: bool = False,
    ) -> dict[str, Any]:
        return await self._call(
            "agent_check_run",
            {
                "run_id": run_id,
                "ignore_model_rounds": ignore_model_rounds,
            },
            limits,
        )

    async def _sleep(self, seconds: float) -> None:
        await workflow.sleep(timedelta(seconds=seconds))

    async def _finish_turn(
        self,
        run_id: str,
        round_number: int,
        outcome: str,
        limits: dict[str, Any],
        *,
        tool_result_count: int = 0,
    ) -> None:
        await self._call(
            "agent_finish_turn",
            {
                "run_id": run_id,
                "round": round_number,
                "outcome": outcome,
                "tool_result_count": tool_result_count,
            },
            limits,
        )

    @staticmethod
    def _tool_calls(decision: dict[str, Any]) -> list[dict[str, Any]]:
        if decision.get("type") == "tool_calls":
            return [dict(call) for call in decision.get("tool_calls", [])]
        return [{
            "tool_call_id": decision.get("tool_call_id"),
            "tool": decision["tool"],
            "arguments": decision.get("arguments", {}),
            "_legacy_single_call": True,
        }]

    @staticmethod
    def _execution_groups(
        calls: list[dict[str, Any]],
    ) -> list[list[tuple[int, dict[str, Any]]]]:
        groups: list[list[tuple[int, dict[str, Any]]]] = []
        read_group: list[tuple[int, dict[str, Any]]] = []
        for index, call in enumerate(calls, start=1):
            if _modifies_data(str(call["tool"])):
                if read_group:
                    groups.append(read_group)
                    read_group = []
                groups.append([(index, call)])
            else:
                read_group.append((index, call))
        if read_group:
            groups.append(read_group)
        return groups

    @staticmethod
    def _calls_until_replan(
        calls: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        for index, call in enumerate(calls):
            if _invalidates_remaining_calls(str(call["tool"])):
                return calls[: index + 1], calls[index + 1 :]
        return calls, []

    async def _execute_tool_call(
        self,
        run_id: str,
        round_number: int,
        call_number: int,
        call: dict[str, Any],
        limits: dict[str, Any],
        non_retryable_failures: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        tool = str(call["tool"])
        persisted_reference = bool(call.get("arguments_hash"))
        internal_call_id = str(call["tool_call_id"]) if persisted_reference else (
            f"{run_id}:{round_number}:{call_number}"
        )
        raw_arguments = dict(call.get("arguments", {}))
        arguments_hash = str(call.get("arguments_hash", ""))
        if not arguments_hash:
            arguments_hash = AgentLoopDetector._fingerprint(
                AgentLoopDetector._normalize(raw_arguments, omitted_keys=set())
            )
        arguments_ref = {
            "sha256": arguments_hash,
            "_stored_in_database": True,
        }
        failure_key = f"{tool}:{arguments_hash}"
        cached_failure = non_retryable_failures.get(failure_key)
        if cached_failure is not None:
            if persisted_reference:
                await self._call(
                    "agent_skip_tool_calls",
                    {"run_id": run_id, "tool_call_ids": [internal_call_id]},
                    limits,
                )
            return {
                **cached_failure,
                "tool_call_id": str(
                    call.get("model_tool_call_id") or internal_call_id
                ),
                "arguments": arguments_ref,
                "summary": (
                    f"{cached_failure.get('summary', '工具调用失败')}；"
                    "相同工具和参数已返回不可重试错误，本次不会再次执行"
                ),
                "duplicate_blocked": True,
            }
        result: dict[str, Any] | None = None
        for attempt in range(MAX_TOOL_ATTEMPTS):
            check = await self._check(run_id, limits)
            if not check["allowed"]:
                return {"_stop_check": check}
            try:
                result = await self._call(
                    "agent_execute_tool",
                    {
                        "run_id": run_id,
                        "tool_call_id": internal_call_id,
                    },
                    limits,
                    tool=tool,
                )
            except CancelledError:
                raise
            except Exception:
                result = {
                    "tool": tool,
                    "ok": False,
                    "summary": "Agent 依赖服务暂时不可用",
                    "data": {},
                    "error_code": "agent_dependency_failed",
                    "retryable": True,
                    "cost": 0.0,
                }
            if result["ok"] or not result.get("retryable", False):
                break
            await self._sleep(self._backoff_seconds(attempt + 1))
            check = await self._check(run_id, limits)
            if not check["allowed"]:
                return {"_stop_check": check}

        assert result is not None
        completed_result = {
            **result,
            "tool_call_id": str(
                call.get("model_tool_call_id")
                or result.get("tool_call_id")
                or internal_call_id
            ),
            "tool": result.get("tool", tool),
            "arguments": arguments_ref,
        }
        completed_result = _bound_tool_history_result(
            completed_result, int(limits.get("tool_result_bytes", 102_400))
        )
        if not result["ok"] and not result.get("retryable", False):
            non_retryable_failures[failure_key] = completed_result
        return completed_result

    @staticmethod
    def _backoff_seconds(attempt: int) -> float:
        return float(min(2 ** max(0, attempt - 1), 8))

    async def _finish_stopped(
        self,
        run_id: str,
        check: dict[str, Any],
        limits: dict[str, Any],
    ) -> None:
        if check.get("status") == "cancelled":
            return
        reason = str(check.get("reason") or "本次任务已达到平台运行上限")
        await self._call(
            "agent_finish",
            {
                "run_id": run_id,
                "answer": f"{reason}，已停止继续执行。已完成的结果会保留。",
                "evidence": [],
                "status": "limit_reached",
                "error_code": str(check.get("reason_code") or "agent_limit_reached"),
                "error_message": reason,
            },
            limits,
        )

    async def _finish_failures(
        self,
        run_id: str,
        limits: dict[str, Any],
    ) -> None:
        await self._call(
            "agent_finish",
            {
                "run_id": run_id,
                "answer": "模型或工具连续失败，本次任务已停止。已完成的操作不会撤回。",
                "evidence": [],
                "status": "failed",
                "error_code": "agent_consecutive_failures",
                "error_message": "模型或工具连续失败，本次任务已停止。",
            },
            limits,
        )

    async def _finish_model_error(
        self,
        run_id: str,
        failure: dict[str, Any],
        limits: dict[str, Any],
    ) -> None:
        message = str(failure.get("message") or "模型服务暂时不可用")
        await self._call(
            "agent_finish",
            {
                "run_id": run_id,
                "answer": f"{message}，本次任务没有继续执行。已完成的结果会保留。",
                "evidence": [],
                "status": "failed",
                "error_code": str(
                    failure.get("error_code") or "model_provider_unavailable"
                ),
                "error_message": message,
            },
            limits,
        )

    async def _call(
        self,
        name: str,
        payload: dict[str, Any],
        limits: dict[str, Any],
        *,
        tool: str | None = None,
    ) -> Any:
        timeout_seconds = int(limits.get("model_timeout_seconds", 120))
        if name == "agent_execute_tool":
            modifies_data = _modifies_data(str(tool))
            timeout_seconds = int(
                limits.get(
                    "write_tool_timeout_seconds"
                    if modifies_data
                    else "read_tool_timeout_seconds",
                    180 if modifies_data else 60,
                )
            )
        elif name not in {
            "agent_model_decide",
            "agent_judge_final",
            "agent_stream_final",
        }:
            timeout_seconds = 30
        retry_policy = CONTROL_ACTIVITY_RETRY
        if name in {"agent_model_decide", "agent_judge_final", "agent_stream_final"}:
            retry_policy = MODEL_ACTIVITY_RETRY
        elif name == "agent_execute_tool":
            retry_policy = TOOL_ACTIVITY_RETRY
        try:
            activity_options: dict[str, Any] = {
                "start_to_close_timeout": timedelta(seconds=max(1, timeout_seconds)),
                "retry_policy": retry_policy,
            }
            if name == "agent_execute_tool":
                activity_options.update({
                    "schedule_to_close_timeout": timedelta(
                        seconds=max(1, timeout_seconds * 2)
                    ),
                    "heartbeat_timeout": timedelta(
                        seconds=TOOL_HEARTBEAT_TIMEOUT_SECONDS
                    ),
                })
            return await workflow.execute_activity(
                name,
                payload,
                **activity_options,
            )
        except Exception as exc:
            if is_cancelled_exception(exc):
                raise CancelledError() from exc
            raise
