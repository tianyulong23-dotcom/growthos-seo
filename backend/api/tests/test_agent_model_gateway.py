import asyncio
import io
import json
import math
import socket
from typing import Any
from urllib.error import HTTPError, URLError

import pytest

from app.modules.agent import model_gateway
from app.modules.agent.model_gateway import (
    REPLAN_FEEDBACK,
    SYSTEM_PROMPT,
    TASK_CONTINUATION,
    AgentModelOutputError,
    AgentModelRequestError,
    ModelGateway,
    StreamingTextSanitizer,
    compact_tool_result,
    estimate_request_tokens,
    tool_catalog,
)
from app.modules.settings.service import AIProviderSettingsRecord


class FakeSettingsService:
    def __init__(self, api_key: str = "super-secret-key") -> None:
        self.record = AIProviderSettingsRecord(
            base_url="https://models.example/v1",
            api_key=api_key,
            model="test-model",
            request_timeout_seconds=10,
            max_retries=0,
        )

    async def effective_record(self) -> AIProviderSettingsRecord:
        return self.record


def test_tool_catalog_never_exposes_trusted_server_context() -> None:
    catalog = tool_catalog()

    assert "project_id" not in catalog
    assert "organization_id" not in catalog
    assert "api_key" not in catalog
    assert "start_technical_audit" in catalog


def test_system_prompt_describes_complete_final_response_schema() -> None:
    assert '"label":"证据名称","url":"https://..."' in SYSTEM_PROMPT
    assert '"topic":"研究主题"' in SYSTEM_PROMPT
    assert '"input_scope":{}' in SYSTEM_PROMPT
    assert '"conclusion":"一句话结论"' in SYSTEM_PROMPT
    final_schema = SYSTEM_PROMPT.split("When the task is finished", 1)[1].split(
        "For final responses", 1
    )[0]
    assert "memory_updates" not in final_schema


def test_system_prompt_defines_project_memory_replacement_and_research_reuse() -> None:
    assert "Project memory is changed only through update_project_memory" in SYSTEM_PROMPT
    assert "use the fact_id shown in project memory" in SYSTEM_PROMPT
    assert "never match or rewrite a fact\nby its displayed text" in SYSTEM_PROMPT
    assert "Never update or delete a user_confirmed fact" in SYSTEM_PROMPT
    assert "latest user message explicitly contains" in SYSTEM_PROMPT
    assert "Use platform_data only for facts\ndirectly returned by platform tools" in SYSTEM_PROMPT
    assert "use inferred for model conclusions" in SYSTEM_PROMPT
    assert "verified facts as the saved state" in SYSTEM_PROMPT
    assert "curated project profile, not a transcript" in SYSTEM_PROMPT
    assert "search_project_memory" in SYSTEM_PROMPT
    assert "update the old fact instead of adding a conflicting second" in SYSTEM_PROMPT
    assert "This memory tool is not a business write and needs no separate approval" in SYSTEM_PROMPT
    assert "present in the latest\nuser message or returned by a platform tool" in SYSTEM_PROMPT
    assert "call get_project_profile" in SYSTEM_PROMPT
    assert "reuse_before_refresh" in SYSTEM_PROMPT
    assert "last 90 days" in SYSTEM_PROMPT


def test_system_prompt_requires_available_multi_tool_work_to_finish() -> None:
    assert "continue calling them across" in SYSTEM_PROMPT
    assert "Do not stop early" in SYSTEM_PROMPT
    assert "available follow-up tool" in SYSTEM_PROMPT
    assert "Never ask the user for data" in SYSTEM_PROMPT
    assert "get_latest_audit already returns" in SYSTEM_PROMPT
    assert "only when the user needs more issues" in SYSTEM_PROMPT


def test_system_prompt_does_not_treat_read_requests_as_write_permission() -> None:
    assert "latest request explicitly asks" in SYSTEM_PROMPT
    assert "Reading, checking, analysing" in SYSTEM_PROMPT


def test_gateway_records_usage_without_putting_key_in_messages(monkeypatch: Any) -> None:
    captured: dict[str, Any] = {}
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(
        base_url: str,
        api_key: str,
        model: str,
        timeout: int,
        messages: list[dict[str, Any]],
        **options: Any,
    ) -> dict[str, Any]:
        captured.update(
            base_url=base_url, api_key=api_key, model=model, timeout=timeout,
            messages=messages, options=options,
        )
        return {
            "choices": [{"message": {"content": '{"type":"final","answer":"完成"}'}}],
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 4,
                "total_tokens": 16,
                "cost": 0.0012,
                "currency": "USD",
            },
        }

    monkeypatch.setattr(gateway, "_request", request)
    result = asyncio.run(gateway.decide([{"role": "user", "content": "检查审核"}], []))

    assert result.decision.type == "final"
    assert result.usage == {
        "input_tokens": 12,
        "output_tokens": 4,
        "total_tokens": 16,
        "cost": 0.0012,
        "cost_currency": "USD",
    }
    assert captured["api_key"] == "super-secret-key"
    assert "super-secret-key" not in json.dumps(captured["messages"], ensure_ascii=False)
    assert captured["options"]["tool_choice"] == "auto"
    assert captured["options"]["parallel_tool_calls"] is True
    assert captured["options"]["tools"][0]["type"] == "function"
    assert "parameters" in captured["options"]["tools"][0]["function"]


@pytest.mark.parametrize("status_code", [429, 500, 502, 503, 504])
def test_gateway_retries_only_retryable_http_statuses(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
) -> None:
    gateway = ModelGateway()
    service = FakeSettingsService()
    service.record = AIProviderSettingsRecord(
        **{**service.record.__dict__, "max_retries": 2}
    )
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", lambda: service)
    calls = 0

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise AgentModelRequestError(
                f"HTTP {status_code}",
                error_code="model_provider_unavailable",
                retryable=True,
                status_code=status_code,
            )
        return {"choices": [{"message": {"content": '{"type":"final","answer":"完成"}'}}]}

    monkeypatch.setattr(gateway, "_request", request)
    monkeypatch.setattr(model_gateway.random, "uniform", lambda *_: 0.0)
    result = asyncio.run(gateway.decide([{"role": "user", "content": "检查"}], []))

    assert result.decision.type == "final"
    assert calls == 3


def test_gateway_uses_browser_use_backoff_and_exposes_exhaustion_as_final(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = ModelGateway()
    service = FakeSettingsService()
    service.record = AIProviderSettingsRecord(
        **{**service.record.__dict__, "max_retries": 4}
    )
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", lambda: service)
    calls = 0
    sleeps: list[float] = []

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        raise AgentModelRequestError(
            "temporary outage",
            error_code="model_provider_unavailable",
            retryable=True,
            status_code=503,
        )

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(gateway, "_request", request)
    monkeypatch.setattr(model_gateway.asyncio, "sleep", sleep)
    monkeypatch.setattr(model_gateway.random, "uniform", lambda *_: 0.0)

    with pytest.raises(AgentModelRequestError) as raised:
        asyncio.run(gateway.decide([{"role": "user", "content": "检查"}], []))

    assert calls == 5
    assert sleeps == [1.0, 2.0, 4.0, 8.0]
    assert raised.value.retryable is False


@pytest.mark.parametrize("status_code", [400, 401, 403, 404, 413])
def test_gateway_does_not_retry_permanent_http_errors(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
) -> None:
    gateway = ModelGateway()
    service = FakeSettingsService()
    service.record = AIProviderSettingsRecord(
        **{**service.record.__dict__, "max_retries": 2}
    )
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", lambda: service)
    calls = 0

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        raise AgentModelRequestError(
            f"HTTP {status_code}",
            error_code="model_provider_request_rejected",
            retryable=False,
            status_code=status_code,
        )

    monkeypatch.setattr(gateway, "_request", request)

    with pytest.raises(AgentModelRequestError) as raised:
        asyncio.run(gateway.decide([{"role": "user", "content": "检查"}], []))
    assert raised.value.retryable is False
    assert calls == 1


@pytest.mark.parametrize(
    "raised_error",
    [socket.timeout("timed out"), URLError("offline")],
)
def test_raw_model_request_classifies_network_failures_as_retryable(
    monkeypatch: pytest.MonkeyPatch,
    raised_error: Exception,
) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "urlopen", lambda *args, **kwargs: (_ for _ in ()).throw(raised_error))

    with pytest.raises(AgentModelRequestError) as raised:
        gateway._request("https://models.example/v1", "secret", "model", 10, [])
    assert raised.value.retryable is True


@pytest.mark.parametrize("status_code", [400, 401, 403, 404, 413, 429, 500, 502, 503, 504])
def test_raw_model_request_classifies_http_statuses(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
) -> None:
    gateway = ModelGateway()
    error = HTTPError("https://models.example", status_code, "failed", {}, None)
    monkeypatch.setattr(model_gateway, "urlopen", lambda *args, **kwargs: (_ for _ in ()).throw(error))

    with pytest.raises(AgentModelRequestError) as raised:
        gateway._request("https://models.example/v1", "secret", "model", 10, [])
    assert raised.value.retryable is (status_code in {429, 500, 502, 503, 504})


@pytest.mark.parametrize(
    ("status_code", "body"),
    [
        (400, b'{"error":{"code":"context_length_exceeded"}}'),
        (413, b'{"error":{"message":"maximum context length exceeded"}}'),
        (422, b'{"detail":"prompt is too long"}'),
    ],
)
def test_raw_model_request_classifies_context_overflow_from_error_body(
    monkeypatch: pytest.MonkeyPatch, status_code: int, body: bytes
) -> None:
    gateway = ModelGateway()
    error = HTTPError(
        "https://models.example", status_code, "failed", {}, io.BytesIO(body)
    )
    monkeypatch.setattr(
        model_gateway, "urlopen", lambda *args, **kwargs: (_ for _ in ()).throw(error)
    )

    with pytest.raises(AgentModelRequestError) as raised:
        gateway._request("https://models.example/v1", "secret", "model", 10, [])

    assert raised.value.error_code == "model_context_overflow"
    assert raised.value.retryable is False


def test_plain_413_does_not_claim_context_overflow(monkeypatch: pytest.MonkeyPatch) -> None:
    gateway = ModelGateway()
    error = HTTPError(
        "https://models.example", 413, "failed", {}, io.BytesIO(b"request body too large")
    )
    monkeypatch.setattr(
        model_gateway, "urlopen", lambda *args, **kwargs: (_ for _ in ()).throw(error)
    )

    with pytest.raises(AgentModelRequestError) as raised:
        gateway._request("https://models.example/v1", "secret", "model", 10, [])

    assert raised.value.error_code == "model_provider_request_rejected"


def test_request_budget_covers_project_context_feedback_and_tool_schema() -> None:
    gateway = ModelGateway()
    base_messages, base_tools = gateway.build_decision_request(
        [{"role": "user", "content": "short request"}], []
    )
    full_messages, full_tools = gateway.build_decision_request(
        [{"role": "user", "content": "short request"}],
        [],
        project_context={"memory": [{"value": "x" * 20_000}]},
        judge_feedback={"reason": "y" * 2_000},
        execution_feedback={"reason": "z" * 2_000},
    )

    assert base_tools is not None
    assert full_tools is not None
    assert estimate_request_tokens(full_messages, full_tools) > estimate_request_tokens(
        base_messages, base_tools
    ) + 5_000


def test_request_budget_counts_json_structure_conservatively() -> None:
    messages = [{"role": "user", "content": "a"}]
    tools = [{
        "type": "function",
        "function": {
            "name": "x",
            "description": "x",
            "parameters": {
                "type": "object",
                "properties": {str(index): {"type": "string"} for index in range(100)},
            },
        },
    }]
    serialized = json.dumps(
        {
            "messages": messages,
            "response_format": {"type": "json_object"},
            "tools": tools,
            "tool_choice": "auto",
            "parallel_tool_calls": True,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )

    assert estimate_request_tokens(messages, tools) > math.ceil(len(serialized) / 4)


def test_request_budget_is_language_independent_at_the_token_boundary() -> None:
    english = [{"role": "user", "content": "search visibility " * 1_000}]
    chinese = [{"role": "user", "content": "搜索可见性" * 1_000}]
    mixed = [{"role": "user", "content": "SEO 搜索 visibilité видимость " * 500}]

    english_tokens = estimate_request_tokens(english, None)
    chinese_tokens = estimate_request_tokens(chinese, None)
    mixed_tokens = estimate_request_tokens(mixed, None)
    shared_trigger = 1_000

    assert english_tokens > shared_trigger
    assert chinese_tokens > shared_trigger
    assert mixed_tokens > shared_trigger
    assert chinese_tokens > math.ceil(len(chinese[0]["content"]) / 4)
    assert mixed_tokens > math.ceil(len(mixed[0]["content"]) / 4)


def test_gateway_uses_native_tool_calls_and_validates_arguments(monkeypatch: Any) -> None:
    captured: dict[str, Any] = {}
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        captured["messages"] = args[-1]
        captured["options"] = kwargs
        return {
            "choices": [{
                "message": {
                    "content": None,
                    "tool_calls": [{
                        "id": "provider-call-1",
                        "type": "function",
                        "function": {
                            "name": "get_audit_issues",
                            "arguments": '{"run_id":"audit-1","page":2}',
                        },
                    }],
                }
            }]
        }

    monkeypatch.setattr(gateway, "_request", request)
    result = asyncio.run(gateway.decide([{"role": "user", "content": "继续查"}], []))

    assert result.decision.type == "tool_calls"
    assert result.decision.tool_calls[0].tool_call_id == "provider-call-1"
    assert result.decision.tool_calls[0].tool == "get_audit_issues"
    assert result.decision.tool_calls[0].arguments == {
        "run_id": "audit-1", "severity": None, "page": 2, "page_size": 20,
    }
    assert captured["options"]["parallel_tool_calls"] is True


def test_gateway_ignores_assistant_text_when_native_tool_calls_are_present(
    monkeypatch: Any,
) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "choices": [{"message": {
                "content": "I will check that now.",
                "tool_calls": [{
                    "id": "provider-call-1",
                    "type": "function",
                    "function": {
                        "name": "get_project_profile",
                        "arguments": "{}",
                    },
                }],
            }}]
        }

    monkeypatch.setattr(gateway, "_request", request)
    result = asyncio.run(gateway.decide([{
        "role": "user", "content": "客户改为大型企业，然后检查资料"
    }], []))

    assert result.decision.type == "tool_calls"
    assert result.decision.tool_calls[0].tool == "get_project_profile"


def test_gateway_parses_project_memory_as_a_native_tool_call(monkeypatch: Any) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)
    operations = [{
        "operation": "add",
        "category": "target_customers",
        "value": "大型企业",
        "source": "user_confirmed",
    }]

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "choices": [{"message": {
                "content": None,
                "tool_calls": [{
                    "id": "memory-call-1",
                    "type": "function",
                    "function": {
                        "name": "update_project_memory",
                        "arguments": json.dumps(
                            {"operations": operations}, ensure_ascii=False
                        ),
                    },
                }],
            }}]
        }

    monkeypatch.setattr(gateway, "_request", request)
    result = asyncio.run(gateway.decide([{
        "role": "user", "content": "目标客户是大型企业"
    }], []))

    assert result.decision.type == "tool_calls"
    call = result.decision.tool_calls[0]
    assert call.tool_call_id == "memory-call-1"
    assert call.tool == "update_project_memory"
    assert call.arguments == {"operations": operations}


def test_gateway_accepts_multiple_native_tool_calls(monkeypatch: Any) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "choices": [{
                "message": {
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "provider-call-1",
                            "type": "function",
                            "function": {
                                "name": "get_project_profile",
                                "arguments": "{}",
                            },
                        },
                        {
                            "id": "provider-call-2",
                            "type": "function",
                            "function": {
                                "name": "get_latest_audit",
                                "arguments": "{}",
                            },
                        },
                    ],
                }
            }]
        }

    monkeypatch.setattr(gateway, "_request", request)
    result = asyncio.run(gateway.decide([{"role": "user", "content": "检查项目"}], []))

    assert result.decision.type == "tool_calls"
    assert [call.tool for call in result.decision.tool_calls] == [
        "get_project_profile",
        "get_latest_audit",
    ]
    assert [call.tool_call_id for call in result.decision.tool_calls] == [
        "provider-call-1",
        "provider-call-2",
    ]


def test_gateway_returns_tool_history_with_standard_roles(monkeypatch: Any) -> None:
    captured: dict[str, Any] = {}
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        captured["messages"] = args[-1]
        return {"choices": [{"message": {"content": '{"type":"final","answer":"完成"}'}}]}

    monkeypatch.setattr(gateway, "_request", request)
    asyncio.run(gateway.decide(
        [{"role": "user", "content": "列出最新审计问题"}],
        [{
            "tool_call_id": "provider-call-1",
            "tool": "get_latest_audit",
            "arguments": {},
            "ok": True,
            "summary": "读取完成",
            "data": {"run_id": "run-1"},
        }],
    ))

    assistant = next(item for item in captured["messages"] if item.get("tool_calls"))
    tool = next(item for item in captured["messages"] if item["role"] == "tool")
    assert assistant["tool_calls"][0]["id"] == "provider-call-1"
    assert assistant["tool_calls"][0]["function"]["name"] == "get_latest_audit"
    assert tool["tool_call_id"] == "provider-call-1"
    assert json.loads(tool["content"])["data"]["run_id"] == "run-1"


def test_gateway_groups_one_tool_batch_into_standard_assistant_message(
    monkeypatch: Any,
) -> None:
    captured: dict[str, Any] = {}
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        captured["messages"] = args[-1]
        return {"choices": [{"message": {"content": '{"type":"final","answer":"完成"}'}}]}

    monkeypatch.setattr(gateway, "_request", request)
    asyncio.run(gateway.decide(
        [{"role": "user", "content": "检查项目和审核"}],
        [
            {
                "tool_batch_id": "run-1:1",
                "tool_call_id": "provider-call-1",
                "tool": "get_project_profile",
                "arguments": {},
                "ok": True,
                "summary": "读取完成",
                "data": {"id": "project-1"},
            },
            {
                "tool_batch_id": "run-1:1",
                "tool_call_id": "provider-call-2",
                "tool": "get_latest_audit",
                "arguments": {},
                "ok": True,
                "summary": "读取完成",
                "data": {"run_id": "audit-1"},
            },
        ],
    ))

    assistants = [item for item in captured["messages"] if item.get("tool_calls")]
    tools = [item for item in captured["messages"] if item["role"] == "tool"]
    assert len(assistants) == 1
    assert [call["id"] for call in assistants[0]["tool_calls"]] == [
        "provider-call-1",
        "provider-call-2",
    ]
    assert [item["tool_call_id"] for item in tools] == [
        "provider-call-1",
        "provider-call-2",
    ]


def test_gateway_places_trusted_continuation_after_tool_results(monkeypatch: Any) -> None:
    captured: dict[str, Any] = {}
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        captured["messages"] = args[-1]
        return {"choices": [{"message": {"content": '{"type":"final","answer":"完成"}'}}]}

    monkeypatch.setattr(gateway, "_request", request)
    asyncio.run(
        gateway.decide(
            [{"role": "user", "content": "列出最新审计问题"}],
            [{"tool": "get_latest_audit", "ok": True, "data": {"run_id": "run-1"}}],
        )
    )

    assert captured["messages"][-2]["role"] == "tool"
    assert captured["messages"][-1] == {"role": "system", "content": TASK_CONTINUATION}
    assert "call get_audit_issues" in TASK_CONTINUATION
    assert "only when the returned issue details" in TASK_CONTINUATION


def test_gateway_places_execution_feedback_after_tool_results(monkeypatch: Any) -> None:
    captured: dict[str, Any] = {}
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        captured["messages"] = args[-1]
        return {"choices": [{"message": {"content": '{"type":"final","answer":"完成"}'}}]}

    monkeypatch.setattr(gateway, "_request", request)
    feedback = {
        "type": "state_changed",
        "tool": "update_business_profile",
        "skipped_tool_calls": 1,
    }
    asyncio.run(gateway.decide(
        [{"role": "user", "content": "修改后重新读取"}],
        [{"tool": "update_business_profile", "ok": True, "data": {}}],
        execution_feedback=feedback,
    ))

    assert captured["messages"][-2] == {
        "role": "system", "content": TASK_CONTINUATION,
    }
    assert captured["messages"][-1] == {
        "role": "system",
        "content": REPLAN_FEEDBACK + "\n" + json.dumps(
            feedback, ensure_ascii=False, separators=(",", ":")
        ),
    }


def test_gateway_corrects_invalid_protocol_once(monkeypatch: Any) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)
    requests: list[list[dict[str, str]]] = []

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        messages = args[-1]
        requests.append(messages)
        if len(requests) == 1:
            return {
                "choices": [{
                    "message": {
                        "content": json.dumps({
                            "type": "final",
                            "answer": "项目名称是示例",
                            "evidence": [{
                                "source": "platform_data",
                                "field": "project.name",
                                "value": "示例",
                            }],
                        }, ensure_ascii=False),
                    }
                }],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            }
        return {
            "choices": [{
                "message": {
                    "content": '{"type":"final","answer":"项目名称是示例"}'
                }
            }],
            "usage": {"prompt_tokens": 20, "completion_tokens": 4, "total_tokens": 24},
        }

    monkeypatch.setattr(gateway, "_request", request)
    result = asyncio.run(gateway.decide([{"role": "user", "content": "项目叫什么？"}], []))

    assert result.decision.type == "final"
    assert result.usage["input_tokens"] == 30
    assert result.usage["output_tokens"] == 9
    assert result.usage["total_tokens"] == 39
    assert len(requests) == 2
    assert "FORMAT CORRECTION" in requests[1][-1]["content"]
    assert requests[1][-2]["role"] == "assistant"


def test_gateway_rejects_invalid_json_after_one_correction(monkeypatch: Any) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)
    calls = 0

    def request(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return {"choices": [{"message": {"content": "not-json"}}]}

    monkeypatch.setattr(gateway, "_request", request)

    with pytest.raises(AgentModelOutputError):
        asyncio.run(gateway.decide([{"role": "user", "content": "执行操作"}], []))
    assert calls == 2


def test_gateway_summarizes_tool_history_as_unverified_context(
    monkeypatch: Any,
) -> None:
    captured: dict[str, Any] = {}
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        captured["messages"] = args[-1]
        return {
            "choices": [{"message": {"content": '{"summary":"第一轮读取失败，第二轮已完成"}'}}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 8, "total_tokens": 28},
        }

    monkeypatch.setattr(gateway, "_request", request)
    result = asyncio.run(gateway.summarize_tool_history(
        "旧摘要",
        [{
            "tool": "get_latest_audit",
            "ok": False,
            "summary": "读取失败",
            "error_code": "agent_dependency_failed",
        }],
    ))

    assert result.decision.answer == "第一轮读取失败，第二轮已完成"
    assert result.usage["total_tokens"] == 28
    assert "Do not turn failed or interrupted work into success" in captured["messages"][0]["content"]
    source = json.loads(captured["messages"][1]["content"])
    assert source["previous_summary"] == "旧摘要"
    assert source["tool_results"][0]["error_code"] == "agent_dependency_failed"


def test_gateway_history_summary_prompt_preserves_in_progress_navigation(
    monkeypatch: Any,
) -> None:
    captured: dict[str, Any] = {}
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        captured["messages"] = args[-1]
        return {"choices": [{"message": {"content": '{"summary":"IN-PROGRESS"}'}}]}

    monkeypatch.setattr(gateway, "_request", request)
    asyncio.run(gateway.summarize("", [{"role": "user", "content": "continue"}]))

    prompt = captured["messages"][0]["content"]
    assert "IN-PROGRESS" in prompt
    assert "next steps" in prompt
    assert "URLs" in prompt
    assert "file paths" in prompt
    assert "Never infer completion" in prompt


@pytest.mark.parametrize("content", ["not-json", "{}", '{"summary":""}'])
def test_gateway_rejects_invalid_tool_history_summary(
    monkeypatch: Any, content: str
) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)
    monkeypatch.setattr(
        gateway,
        "_request",
        lambda *args, **kwargs: {"choices": [{"message": {"content": content}}]},
    )

    with pytest.raises(AgentModelOutputError, match="无效的工具历史摘要"):
        asyncio.run(gateway.summarize_tool_history("", []))


def test_gateway_redacts_real_secret_values_before_model_input(monkeypatch: Any) -> None:
    captured: dict[str, Any] = {}
    secret = "sk-live-very-sensitive-value"
    gateway = ModelGateway()
    monkeypatch.setattr(
        model_gateway, "build_ai_settings_service", lambda: FakeSettingsService(secret)
    )

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        captured["messages"] = args[-1]
        return {"choices": [{"message": {"content": '{"type":"final","answer":"已处理"}'}}]}

    monkeypatch.setattr(gateway, "_request", request)
    asyncio.run(gateway.decide(
        [{"role": "user", "content": f"不要暴露 {secret}"}],
        [{
            "tool_call_id": "call-1", "tool": "get_project_profile", "arguments": {},
            "ok": True, "summary": "完成", "data": {"note": secret},
        }],
        project_context={"memory": [{"value": secret}]},
    ))

    encoded = json.dumps(captured["messages"], ensure_ascii=False)
    assert secret not in encoded
    assert "[REDACTED]" in encoded


def test_tool_arguments_are_not_duplicated_in_tool_result_content() -> None:
    messages: list[dict[str, Any]] = []
    result = {
        "tool_call_id": "call-1",
        "tool": "start_technical_audit",
        "arguments": {"_truncated": True, "original_bytes": 900_000},
        "ok": True,
        "summary": "任务已启动",
        "data": {"run_id": "audit-1", "status": "queued"},
    }

    ModelGateway._append_tool_history(messages, [result], secrets=())

    assistant_arguments = json.loads(
        messages[0]["tool_calls"][0]["function"]["arguments"]
    )
    tool_content = json.loads(messages[1]["content"])
    assert assistant_arguments == result["arguments"]
    assert "arguments" not in tool_content


def test_old_tool_results_are_compacted_but_keep_navigation() -> None:
    result = {
        "tool": "get_audit_pages",
        "ok": True,
        "summary": "读取完成",
        "data": {
            "run_id": "audit-1",
            "page": 2,
            "page_size": 20,
            "total": 100,
            "items": [{"url": f"https://example.com/{index}", "body": "x" * 2000} for index in range(20)],
        },
    }

    compacted = compact_tool_result(result)

    assert compacted["tool"] == "get_audit_pages"
    assert compacted["data"]["run_id"] == "audit-1"
    assert compacted["data"]["page"] == 2
    assert compacted["data"]["next_page"] == 3
    assert compacted["data"]["items"][0]["url"] == "https://example.com/0"
    assert "body" not in compacted["data"]["items"][0]


def test_compacted_memory_result_keeps_verified_facts() -> None:
    result = compact_tool_result({
        "tool_call_id": "memory-call-1",
        "tool": "update_project_memory",
        "ok": True,
        "summary": "项目记忆已保存并校验，共处理 1 项",
        "data": {
            "verified": True,
            "applied": [{"operation": "update", "fact_id": "fact-1"}],
            "facts": [{
                "fact_id": "fact-1",
                "category": "target_customers",
                "value": "大型企业",
                "source": "user_confirmed",
            }],
        },
    })

    assert result["data"]["verified"] is True
    assert result["data"]["facts"][0]["fact_id"] == "fact-1"
    assert result["data"]["applied"] == [{
        "operation": "update", "fact_id": "fact-1",
    }]


def test_compacted_memory_search_keeps_fact_identity_and_value() -> None:
    result = compact_tool_result({
        "tool_call_id": "memory-search-1",
        "tool": "search_project_memory",
        "ok": True,
        "summary": "找到 1 条项目记忆",
        "data": {
            "items": [{
                "fact_id": "fact-1",
                "category": "target_customers",
                "value": "跨境电商卖家",
                "source": "user_confirmed",
            }],
            "total": 1,
            "page": 1,
            "page_size": 5,
            "next_page": None,
        },
    })

    assert result["data"]["items"] == [{
        "fact_id": "fact-1",
        "category": "target_customers",
        "value": "跨境电商卖家",
        "source": "user_confirmed",
    }]


def test_latest_audit_compaction_keeps_bounded_top_issue_evidence() -> None:
    result = {
        "tool": "get_latest_audit",
        "ok": True,
        "summary": "读取完成",
        "data": {
            "audit": {"run_id": "audit-1", "health_score": 86},
            "top_issues": {
                "total": 12,
                "page": 1,
                "page_size": 10,
                "items": [{
                    "id": f"issue-{index}",
                    "code": f"code-{index}",
                    "title": f"Issue {index}",
                    "severity": "error",
                    "affected_count": index + 3,
                    "urls": [f"https://example.com/{index}/{url}" for url in range(8)],
                    "details": "x" * 2_000,
                } for index in range(12)],
            },
        },
    }

    compacted = compact_tool_result(result)

    assert compacted["data"]["audit"]["health_score"] == 86
    assert compacted["data"]["top_issues"]["total"] == 12
    assert len(compacted["data"]["top_issues"]["items"]) == 10
    assert compacted["data"]["top_issues"]["items"][0] == {
        "id": "issue-0",
        "code": "code-0",
        "title": "Issue 0",
        "severity": "error",
        "affected_count": 3,
        "urls": [f"https://example.com/0/{url}" for url in range(5)],
    }


def test_judge_receives_latest_audit_top_issue_counts(monkeypatch: Any) -> None:
    captured: dict[str, Any] = {}
    request_payload: dict[str, Any] = {}
    responses = iter([
        {"status": "completed", "reason": "证据完整"},
        {
            "status": "completed",
            "reason": "证据完整",
            "criteria": [{
                "requirement": "列出最严重的三个问题和影响页数",
                "status": "completed",
                "evidence": "工具返回三个问题及影响页数 5、4、3",
            }],
            "remaining_work": [],
        },
    ])
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        captured["messages"] = args[-1]
        if not request_payload:
            request_payload.update(json.loads(args[-1][1]["content"]))
        return {
            "choices": [{"message": {"content": json.dumps(
                next(responses), ensure_ascii=False
            )}}]
        }

    monkeypatch.setattr(gateway, "_request", request)
    asyncio.run(gateway.judge(
        "列出最严重的三个问题和影响页数",
        "三个问题分别影响 5、4、3 页",
        {"tool_evidence": [{
                "tool": "get_latest_audit",
                "ok": True,
                "data": {
                    "audit": {"health_score": 86},
                    "top_issues": {"items": [
                        {"title": "A", "severity": "error", "affected_count": 5},
                        {"title": "B", "severity": "error", "affected_count": 4},
                        {"title": "C", "severity": "warning", "affected_count": 3},
                    ]},
                },
            }],
            "retry_summary": {"failed_tool_attempts": 1},
            "verification_results": [{"tool": "get_latest_audit", "verified": True}],
            "project_state": {"audit_health": 86},
            "unfinished": [],
        },
    ))

    evidence = request_payload["execution_evidence"]
    issues = evidence["tool_evidence"][0]["data"]["top_issues"]["items"]
    assert [item["affected_count"] for item in issues] == [5, 4, 3]
    assert evidence["retry_summary"]["failed_tool_attempts"] == 1
    assert evidence["verification_results"][0]["verified"] is True
    assert evidence["project_state"]["audit_health"] == 86
    assert "internally inconsistent" in captured["messages"][-1]["content"]


def test_judge_redacts_secrets_from_complete_execution_evidence(
    monkeypatch: Any,
) -> None:
    captured: dict[str, Any] = {}
    secret = "sk-judge-sensitive-value"
    gateway = ModelGateway()
    monkeypatch.setattr(
        model_gateway, "build_ai_settings_service", lambda: FakeSettingsService(secret)
    )

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        captured["messages"] = args[-1]
        return {
            "choices": [{"message": {"content": json.dumps({
                "status": "blocked",
                "reason": "存在未完成操作",
                "criteria": [{
                    "requirement": "检查任务",
                    "status": "blocked",
                    "evidence": "任务仍有未完成操作",
                }],
                "remaining_work": ["完成剩余操作"],
            }, ensure_ascii=False)}}]
        }

    monkeypatch.setattr(gateway, "_request", request)
    asyncio.run(gateway.judge(
        "检查任务",
        f"结果包含 {secret}",
        {
            "run_steps": [{"name": "tool", "authorization": f"Bearer {secret}"}],
            "tool_evidence": [{"data": {"apiKey": secret}}],
            "unfinished": [{"error": secret}],
        },
    ))

    encoded = json.dumps(captured["messages"], ensure_ascii=False)
    assert secret not in encoded
    assert "[REDACTED]" in encoded


def test_judge_rejects_completed_status_with_unfinished_criterion(
    monkeypatch: Any,
) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "choices": [{"message": {"content": json.dumps({
                "status": "completed",
                "reason": "任务完成",
                "criteria": [{
                    "requirement": "保存100个关键词",
                    "status": "partial",
                    "evidence": "只保存60个",
                }],
                "remaining_work": [],
            }, ensure_ascii=False)}}]
        }

    monkeypatch.setattr(gateway, "_request", request)

    with pytest.raises(AgentModelOutputError, match="无效的最终检查结果"):
        asyncio.run(gateway.judge(
            "保存100个关键词",
            "已经保存100个关键词",
            {"completion_facts": [{
                "requested_count": 100,
                "completed_count": 60,
                "failed_count": 40,
                "verified": True,
            }]},
        ))


def test_judge_prompt_distinguishes_started_async_work_from_finished_work(
    monkeypatch: Any,
) -> None:
    captured: dict[str, Any] = {}
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        captured["messages"] = args[-1]
        return {
            "choices": [{"message": {"content": json.dumps({
                "status": "partial",
                "reason": "审计已经启动，但结果尚未产出",
                "criteria": [{
                    "requirement": "完成审计并分析结果",
                    "status": "partial",
                    "evidence": "审计状态仍为 queued",
                }],
                "remaining_work": ["等待审计完成并读取结果"],
            }, ensure_ascii=False)}}]
        }

    monkeypatch.setattr(gateway, "_request", request)
    result = asyncio.run(gateway.judge(
        "完成网站审计并分析结果",
        "审计已完成",
        {"completion_facts": [{
            "operation_id": "audit-1",
            "verified": True,
            "status": "queued",
        }]},
    ))

    prompt = captured["messages"][0]["content"]
    assert "proves that an asynchronous operation started" in prompt
    assert "only asks to start the operation" in prompt
    assert "must not satisfy a criterion that asks to finish" in prompt
    assert result.decision.status == "partial"


def test_compact_tool_result_preserves_business_completion_facts() -> None:
    compacted = compact_tool_result({
        "tool_call_id": "call-1",
        "tool": "save_keywords",
        "ok": True,
        "summary": "保存完成",
        "data": {
            "operation_id": "operation-1",
            "requested_count": 100,
            "completed_count": 60,
            "failed_count": 40,
            "verified": True,
            "record_ids": ["keyword-1", "keyword-2"],
        },
    })

    assert compacted["data"] == {
        "operation_id": "operation-1",
        "requested_count": 100,
        "completed_count": 60,
        "failed_count": 40,
        "verified": True,
        "record_ids": ["keyword-1", "keyword-2"],
    }


def test_streaming_sanitizer_redacts_secret_split_across_provider_chunks() -> None:
    secret = "secret-value"
    sanitizer = StreamingTextSanitizer((secret,))

    output = sanitizer.feed("result api_key=sec")
    output += sanitizer.feed("ret-value finished " + "x" * 100)
    output += sanitizer.flush()

    assert secret not in output
    assert "[REDACTED]" in output


def test_decision_stream_rebuilds_interleaved_split_tool_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(
        model_gateway, "build_ai_settings_service", FakeSettingsService
    )
    updates: list[dict[str, Any]] = []

    async def request(
        record: Any,
        messages: list[dict[str, Any]],
        on_update: Any,
        **kwargs: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        for update in [
            {
                "kind": "toolcall_delta", "index": 1,
                "id_delta": "call-", "name_delta": "get_latest_",
                "arguments_delta": "{",
            },
            {
                "kind": "toolcall_delta", "index": 0,
                "id_delta": "profile-", "name_delta": "get_project_",
                "arguments_delta": "{",
            },
            {
                "kind": "toolcall_delta", "index": 1,
                "id_delta": "audit", "name_delta": "audit",
                "arguments_delta": "}",
            },
            {
                "kind": "toolcall_delta", "index": 0,
                "id_delta": "call", "name_delta": "profile",
                "arguments_delta": "}",
            },
        ]:
            await on_update(update)
        return ({
            "content": None,
            "tool_calls": [
                {
                    "id": "profile-call", "type": "function",
                    "function": {"name": "get_project_profile", "arguments": "{}"},
                },
                {
                    "id": "call-audit", "type": "function",
                    "function": {"name": "get_latest_audit", "arguments": "{}"},
                },
            ],
        }, {})

    monkeypatch.setattr(
        gateway, "_stream_decision_with_connection_retries", request
    )

    async def collect(update: dict[str, Any]) -> None:
        updates.append(update)

    result = asyncio.run(gateway.decide_stream(
        [{"role": "user", "content": "检查项目和审核"}], [], collect
    ))

    assert [call.tool_call_id for call in result.decision.tool_calls] == [
        "profile-call", "call-audit",
    ]
    assert [call.tool for call in result.decision.tool_calls] == [
        "get_project_profile", "get_latest_audit",
    ]
    starts = [update for update in updates if update["kind"] == "toolcall_start"]
    ends = [update for update in updates if update["kind"] == "toolcall_end"]
    assert [update["index"] for update in starts] == [1, 0]
    assert {update["index"]: update["tool_call_id"] for update in ends} == {
        0: "profile-call", 1: "call-audit",
    }


def test_decision_stream_redacts_secret_split_across_tool_argument_chunks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "super-secret-key"
    gateway = ModelGateway()
    monkeypatch.setattr(
        model_gateway, "build_ai_settings_service", FakeSettingsService
    )
    updates: list[dict[str, Any]] = []

    async def request(
        record: Any,
        messages: list[dict[str, Any]],
        on_update: Any,
        **kwargs: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        await on_update({
            "kind": "toolcall_delta", "index": 0,
            "id_delta": "call-1", "name_delta": "get_project_profile",
            "arguments_delta": '{"note":"super-',
        })
        await on_update({
            "kind": "toolcall_delta", "index": 0,
            "id_delta": "", "name_delta": "",
            "arguments_delta": 'secret-key","padding":"' + "x" * 100 + '"}',
        })
        return ({
            "content": None,
            "tool_calls": [{
                "id": "call-1", "type": "function",
                "function": {"name": "get_project_profile", "arguments": "{}"},
            }],
        }, {})

    monkeypatch.setattr(
        gateway, "_stream_decision_with_connection_retries", request
    )

    async def collect(update: dict[str, Any]) -> None:
        updates.append(update)

    asyncio.run(gateway.decide_stream(
        [{"role": "user", "content": "检查项目"}], [], collect
    ))

    serialized = json.dumps(updates, ensure_ascii=False)
    assert secret not in serialized
    assert "[REDACTED]" in serialized


def test_decision_stream_retries_temporary_failure_before_visible_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = ModelGateway()
    service = FakeSettingsService()
    service.record = AIProviderSettingsRecord(
        **{**service.record.__dict__, "max_retries": 1}
    )
    attempts = 0
    sleeps: list[float] = []
    monkeypatch.setattr(
        model_gateway, "build_ai_settings_service", lambda: service
    )
    monkeypatch.setattr(model_gateway.random, "uniform", lambda *_: 0.0)

    async def request(*args: Any, **kwargs: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise AgentModelRequestError(
                "temporary outage",
                error_code="model_provider_unavailable",
                retryable=True,
            )
        return ({"content": '{"type":"final","answer":"完成"}'}, {})

    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(gateway, "_stream_decision_request_async", request)
    monkeypatch.setattr(model_gateway.asyncio, "sleep", sleep)

    async def collect(update: dict[str, Any]) -> None:
        return None

    result = asyncio.run(gateway.decide_stream(
        [{"role": "user", "content": "检查"}], [], collect
    ))

    assert result.decision.type == "final"
    assert attempts == 2
    assert sleeps == [1.0]


def test_decision_stream_does_not_retry_temporary_failure_after_visible_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = ModelGateway()
    service = FakeSettingsService()
    service.record = AIProviderSettingsRecord(
        **{**service.record.__dict__, "max_retries": 2}
    )
    attempts = 0
    updates: list[dict[str, Any]] = []
    monkeypatch.setattr(
        model_gateway, "build_ai_settings_service", lambda: service
    )

    async def request(
        *args: Any, **kwargs: Any
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        nonlocal attempts
        attempts += 1
        on_update = args[5]
        await on_update({"kind": "text_delta", "delta": "partial " + "x" * 100})
        raise AgentModelRequestError(
            "stream interrupted",
            error_code="model_provider_unavailable",
            retryable=True,
        )

    monkeypatch.setattr(gateway, "_stream_decision_request_async", request)

    async def collect(update: dict[str, Any]) -> None:
        updates.append(update)

    with pytest.raises(AgentModelRequestError):
        asyncio.run(gateway.decide_stream(
            [{"role": "user", "content": "检查"}], [], collect
        ))

    assert attempts == 1
    assert any(update["kind"] == "text_delta" for update in updates)
    assert updates[-1] == {"kind": "stream_end", "attempt": 0, "status": "error"}


def test_decision_stream_protocol_correction_uses_second_message_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(
        model_gateway, "build_ai_settings_service", FakeSettingsService
    )
    attempts = 0
    updates: list[dict[str, Any]] = []

    async def request(
        record: Any,
        messages: list[dict[str, Any]],
        on_update: Any,
        **kwargs: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        nonlocal attempts
        attempts += 1
        content = (
            '{"type":"final","answer":"完成","evidence":[{"bad":true}]}'
            if attempts == 1
            else '{"type":"final","answer":"完成"}'
        )
        await on_update({"kind": "text_delta", "delta": content})
        return ({"content": content}, {})

    monkeypatch.setattr(
        gateway, "_stream_decision_with_connection_retries", request
    )

    async def collect(update: dict[str, Any]) -> None:
        updates.append(update)

    result = asyncio.run(gateway.decide_stream(
        [{"role": "user", "content": "检查"}], [], collect
    ))

    assert result.decision.type == "final"
    assert attempts == 2
    assert [
        (update["attempt"], update["status"])
        for update in updates if update["kind"] == "stream_end"
    ] == [(0, "invalid"), (1, "completed")]
    assert [
        update["attempt"] for update in updates if update["kind"] == "stream_start"
    ] == [0, 1]


@pytest.mark.parametrize(
    "bad_call",
    [
        {"id": "call-1", "type": "function"},
        {"id": "call-1", "type": "function", "function": None},
    ],
)
def test_decision_stream_wraps_early_type_errors_as_model_output_errors(
    monkeypatch: pytest.MonkeyPatch,
    bad_call: dict[str, Any],
) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(
        model_gateway, "build_ai_settings_service", FakeSettingsService
    )

    async def request(
        record: Any,
        messages: list[dict[str, Any]],
        on_update: Any,
        **kwargs: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        return ({
            "content": None,
            "tool_calls": [bad_call],
        }, {})

    monkeypatch.setattr(
        gateway, "_stream_decision_with_connection_retries", request
    )

    with pytest.raises(AgentModelOutputError):
        asyncio.run(gateway.decide_stream(
            [{"role": "user", "content": "检查"}], [],
            lambda update: asyncio.sleep(0),
        ))


def test_decide_redacts_provider_secret_from_final_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = ModelGateway()
    service = FakeSettingsService(api_key="super-secret-key")
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", lambda: service)

    async def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "choices": [{
                "message": {
                    "content": json.dumps({
                        "type": "final",
                        "answer": "密钥是 super-secret-key",
                        "evidence": [],
                    }, ensure_ascii=False),
                }
            }]
        }

    monkeypatch.setattr(gateway, "_request_with_connection_retries", request)

    result = asyncio.run(gateway.decide([], []))

    assert result.decision.type == "final"
    assert result.decision.answer == "密钥是 [REDACTED]"
