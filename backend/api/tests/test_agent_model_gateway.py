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
from app.modules.agent.providers.base import ProviderConfig, ProviderRequest
from app.modules.agent.providers.events import ProviderStreamEvent
from app.modules.agent.providers import openai as openai_provider
from app.modules.agent.providers.openai import OpenAIProvider
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


def test_model_settings_use_run_organization_without_default_fallback(monkeypatch) -> None:
    from unittest.mock import AsyncMock

    service = AsyncMock()
    service.effective_record_for_organization.return_value = FakeSettingsService().record
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", lambda: service)

    record = asyncio.run(ModelGateway(organization_id="run-org")._effective_record())

    assert record.model == "test-model"
    service.effective_record_for_organization.assert_awaited_once_with("run-org")
    service.effective_record.assert_not_awaited()


class FakeHTTPResponse:
    def __init__(self, body: bytes = b"", lines: list[bytes] | None = None) -> None:
        self.body = body
        self.lines = iter(lines or [])

    def __enter__(self) -> "FakeHTTPResponse":
        return self

    def __exit__(self, *_args: Any) -> None:
        return None

    def read(self, _limit: int = -1) -> bytes:
        return self.body

    def readline(self) -> bytes:
        return next(self.lines, b"")


def responses_provider() -> OpenAIProvider:
    return OpenAIProvider(ProviderConfig(
        provider="openai",
        base_url="https://models.example/v1",
        api_key="secret",
        model="test-model",
        timeout_seconds=10,
        max_retries=0,
        reasoning_effort="medium",
        api_protocol="responses",
    ))


def test_responses_provider_serializes_input_tools_and_format() -> None:
    provider = responses_provider()
    payload = provider.serialize(ProviderRequest(
        messages=[
            {"role": "system", "content": "Be precise."},
            {"role": "user", "content": "Start the work."},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": {
                        "name": "start_keyword_library",
                        "arguments": '{"limit":30}',
                    },
                }],
            },
            {"role": "tool", "tool_call_id": "call-1", "content": "started"},
        ],
        tools=[{
            "type": "function",
            "function": {
                "name": "start_keyword_library",
                "description": "Start keywords",
                "parameters": {
                    "type": "object",
                    "properties": {"limit": {"type": "integer"}},
                },
                "strict": True,
            },
        }],
        tool_choice="auto",
        parallel_tool_calls=True,
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "decision",
                "strict": True,
                "schema": {"type": "object"},
            },
        },
        max_output_tokens=4000,
    ), stream=True)

    assert payload == {
        "model": "test-model",
        "input": [
            {"role": "system", "content": "Be precise."},
            {"role": "user", "content": "Start the work."},
            {
                "type": "function_call",
                "call_id": "call-1",
                "name": "start_keyword_library",
                "arguments": '{"limit":30}',
            },
            {
                "type": "function_call_output",
                "call_id": "call-1",
                "output": "started",
            },
        ],
        "reasoning": {"effort": "medium"},
        "text": {
            "format": {
                "type": "json_schema",
                "name": "decision",
                "strict": True,
                "schema": {"type": "object"},
            }
        },
        "tools": [{
            "type": "function",
            "name": "start_keyword_library",
            "description": "Start keywords",
            "parameters": {
                "type": "object",
                "properties": {"limit": {"type": "integer"}},
            },
            "strict": True,
        }],
        "tool_choice": "auto",
        "parallel_tool_calls": True,
        "max_output_tokens": 4000,
        "stream": True,
    }


def test_responses_provider_completes_text_and_parallel_tool_calls(
    monkeypatch: Any,
) -> None:
    captured: dict[str, Any] = {}
    response = {
        "id": "resp-1",
        "model": "test-model-2026-08-13",
        "status": "completed",
        "output": [
            {
                "type": "message",
                "content": [{"type": "output_text", "text": "任务已开始。"}],
            },
            {
                "type": "function_call",
                "call_id": "call-audit",
                "name": "start_technical_audit",
                "arguments": '{"max_pages":100}',
            },
            {
                "type": "function_call",
                "call_id": "call-keywords",
                "name": "start_keyword_library",
                "arguments": "{}",
            },
        ],
        "usage": {
            "input_tokens": 120,
            "output_tokens": 30,
            "total_tokens": 150,
            "input_tokens_details": {"cached_tokens": 20},
            "output_tokens_details": {"reasoning_tokens": 10},
        },
    }

    def urlopen(request: Any, timeout: int) -> FakeHTTPResponse:
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        captured["payload"] = json.loads(request.data)
        return FakeHTTPResponse(json.dumps(response).encode())

    monkeypatch.setattr(openai_provider, "urlopen", urlopen)
    result = asyncio.run(responses_provider().complete(ProviderRequest(
        messages=[{"role": "user", "content": "开始"}],
        tools=[],
    )))

    assert captured["url"] == "https://models.example/v1/responses"
    assert captured["timeout"] == 10
    assert "input" in captured["payload"]
    assert "messages" not in captured["payload"]
    assert result.response_id == "resp-1"
    assert result.response_model == "test-model-2026-08-13"
    assert result.message == {
        "role": "assistant",
        "content": "任务已开始。",
        "tool_calls": [
            {
                "id": "call-audit",
                "type": "function",
                "function": {
                    "name": "start_technical_audit",
                    "arguments": '{"max_pages":100}',
                },
            },
            {
                "id": "call-keywords",
                "type": "function",
                "function": {"name": "start_keyword_library", "arguments": "{}"},
            },
        ],
    }
    assert result.usage.as_dict() == {
        "input_tokens": 120,
        "output_tokens": 30,
        "total_tokens": 150,
        "cached_input_tokens": 20,
        "cache_write_tokens": None,
        "reasoning_tokens": 10,
        "cost": None,
        "cost_currency": None,
    }


def test_responses_provider_streams_text_and_parallel_tool_calls(
    monkeypatch: Any,
) -> None:
    events = [
        {"type": "response.output_text.delta", "delta": "审核和关键词库"},
        {"type": "response.output_text.delta", "delta": "已开始。"},
        {
            "type": "response.output_item.added",
            "output_index": 1,
            "item": {
                "type": "function_call",
                "call_id": "call-audit",
                "name": "start_technical_audit",
                "arguments": "",
            },
        },
        {
            "type": "response.output_item.added",
            "output_index": 2,
            "item": {
                "type": "function_call",
                "call_id": "call-keywords",
                "name": "start_keyword_library",
                "arguments": "",
            },
        },
        {
            "type": "response.function_call_arguments.delta",
            "output_index": 1,
            "delta": '{"max_pages":',
        },
        {
            "type": "response.function_call_arguments.delta",
            "output_index": 2,
            "delta": "{}",
        },
        {
            "type": "response.function_call_arguments.delta",
            "output_index": 1,
            "delta": "100}",
        },
        {
            "type": "response.completed",
            "response": {
                "id": "resp-stream-1",
                "status": "completed",
                "usage": {
                    "input_tokens": 80,
                    "output_tokens": 20,
                    "total_tokens": 100,
                },
            },
        },
    ]
    lines = [
        f"data: {json.dumps(event)}\n\n".encode()
        for event in events
    ]
    captured: dict[str, Any] = {}

    def urlopen(request: Any, timeout: int) -> FakeHTTPResponse:
        captured["url"] = request.full_url
        captured["payload"] = json.loads(request.data)
        return FakeHTTPResponse(lines=lines)

    monkeypatch.setattr(openai_provider, "urlopen", urlopen)

    async def collect() -> list[ProviderStreamEvent]:
        return [event async for event in responses_provider().stream(
            ProviderRequest(messages=[{"role": "user", "content": "开始"}])
        )]

    streamed = asyncio.run(collect())
    assert captured["url"] == "https://models.example/v1/responses"
    assert captured["payload"]["stream"] is True
    assert [event.kind for event in streamed] == [
        "start",
        "text_start",
        "text_delta",
        "text_delta",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_delta",
        "toolcall_delta",
        "toolcall_delta",
        "text_end",
        "toolcall_end",
        "toolcall_end",
        "done",
    ]
    calls: dict[int, dict[str, str]] = {}
    for event in streamed:
        if event.kind != "toolcall_delta" or event.index is None:
            continue
        call = calls.setdefault(event.index, {"id": "", "name": "", "arguments": ""})
        call["id"] += event.id_delta
        call["name"] += event.name_delta
        call["arguments"] += event.arguments_delta
    assert calls == {
        1: {
            "id": "call-audit",
            "name": "start_technical_audit",
            "arguments": '{"max_pages":100}',
        },
        2: {
            "id": "call-keywords",
            "name": "start_keyword_library",
            "arguments": "{}",
        },
    }
    assert streamed[-1].response_id == "resp-stream-1"
    assert streamed[-1].stop_reason == "completed"
    assert streamed[-1].usage == {
        "input_tokens": 80,
        "output_tokens": 20,
        "total_tokens": 100,
        "cached_input_tokens": None,
        "cache_write_tokens": None,
        "reasoning_tokens": None,
        "cost": None,
        "cost_currency": None,
    }


def test_tool_catalog_never_exposes_trusted_server_context() -> None:
    catalog = tool_catalog()

    assert "project_id" not in catalog
    assert "organization_id" not in catalog
    assert "api_key" not in catalog
    assert "start_technical_audit" in catalog


def test_trusted_internal_event_is_sent_to_the_model_as_system_context() -> None:
    messages, _tools = ModelGateway.build_decision_request(
        [
            {"role": "user", "content": "ordinary request"},
            {
                "role": "user",
                "content": "start the approved work",
                "metadata": {
                    "trusted_system_trigger": True,
                    "system_trigger": "business_profile_confirmed",
                    "trusted_write_tools": [
                        "start_technical_audit",
                        "start_keyword_library",
                    ],
                },
            },
        ],
        [],
    )

    assert messages[1] == {"role": "user", "content": "ordinary request"}
    assert messages[2]["role"] == "system"
    assert "trigger=business_profile_confirmed" in messages[2]["content"]
    assert (
        'authorized_write_tools=["start_technical_audit","start_keyword_library"]'
        in messages[2]["content"]
    )
    assert "operation=\nstart the approved work" in messages[2]["content"]


def test_system_prompt_requires_plain_markdown_final_answers() -> None:
    final_instruction = SYSTEM_PROMPT.split("When the task is finished", 1)[1]

    assert "answer directly in plain prose and Markdown" in final_instruction
    assert "Do not wrap the answer in\nJSON" in final_instruction
    assert "exactly one JSON object" not in final_instruction


def test_system_prompt_defines_aris_identity_and_working_style() -> None:
    assert "You are Aris, the SEO lead inside this product" in SYSTEM_PROMPT
    assert "business that needs to grow" in SYSTEM_PROMPT
    assert "Talk like a calm, perceptive operating partner" in SYSTEM_PROMPT
    assert "warm like a partner" in SYSTEM_PROMPT
    assert "Introduce yourself as Aris" in SYSTEM_PROMPT
    assert "routine praise" in SYSTEM_PROMPT
    assert "say so plainly, explain why" in SYSTEM_PROMPT
    assert "distinguish what is confirmed" in SYSTEM_PROMPT


def test_system_prompt_requires_compact_markdown_answer_structure() -> None:
    prompt = " ".join(SYSTEM_PROMPT.split())

    assert "Write in plain prose and Markdown" in prompt
    assert "The first sentence must give the conclusion" in prompt
    assert "Start the details after a blank line" in prompt
    assert "two or more parallel facts" in prompt
    assert "one or two sentences" in prompt
    assert "Do not force structure onto a one-line answer" in prompt


def test_system_prompt_keeps_aris_cost_and_progress_claims_grounded() -> None:
    prompt = " ".join(SYSTEM_PROMPT.split())

    assert "check the supplied project data and research_log" in prompt
    assert "Reuse current evidence when it fully answers the same question" in prompt
    assert "if it may be stale, say so and offer a refresh" in prompt
    assert "do not fan out redundant calls" in prompt
    assert "Prefer doing available work" in prompt
    assert "If a tool returns no data or a task fails" in prompt
    assert "supported by supplied runtime data" in prompt
    assert "Never invent task progress" in prompt
    assert "completion times" in prompt


def test_system_prompt_defines_new_project_initiative_at_sam_granularity() -> None:
    prompt = " ".join(SYSTEM_PROMPT.split())

    assert "call get_project_profile before asking for business facts" in prompt
    assert "form a concise initial understanding" in prompt
    assert "separating confirmed facts from inferred assumptions" in prompt
    assert "Ask at most one question" in prompt
    assert "materially changes the next strategy decision" in prompt


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


def test_system_prompt_requests_parallel_initial_discovery_writes() -> None:
    prompt = " ".join(SYSTEM_PROMPT.split())

    assert "explicitly compatible writes in parallel" in prompt
    assert (
        "when start_technical_audit and start_keyword_library are both authorized "
        "and both still need to start, return both calls in the same response"
    ) in prompt
    assert "Do not batch calls when a later call needs a result" in prompt


def test_system_prompt_uses_project_level_article_status_discovery() -> None:
    prompt = " ".join(SYSTEM_PROMPT.split())

    assert "article generation status" in prompt
    assert "get_article_generation_status" in prompt
    assert "keyword or title" in prompt
    assert "with that text in search" in prompt
    assert "initial or most recent generated articles" in prompt


def test_system_prompt_separates_direct_and_planned_article_generation() -> None:
    prompt = " ".join(SYSTEM_PROMPT.split())

    assert "call create_article directly" in prompt
    assert "do not create a temporary content plan" in prompt
    assert "Call start_articles only" in prompt
    assert "already synchronized data" in prompt


def test_system_prompt_does_not_treat_read_requests_as_write_permission() -> None:
    assert "latest request explicitly asks" in SYSTEM_PROMPT
    assert "Reading, checking, analysing" in SYSTEM_PROMPT


def test_email_read_prompt_reports_paused_sync_and_send_blockers() -> None:
    prompt = " ".join(SYSTEM_PROMPT.split())

    assert "killSwitchOpen=true means the sync gate permits execution" in prompt
    assert "killSwitchOpen=false as sync blocked" in prompt
    assert "WAITING_FOR_ACCEPTED_SEND means waiting for an accepted send" in prompt
    assert "Connection readiness does not establish send readiness" in prompt
    assert "readiness.send.ready=false and its blockers explicitly" in prompt


def test_email_read_prompt_reuses_latest_evidence_without_verification_loop() -> None:
    prompt = " ".join(SYSTEM_PROMPT.split())

    assert "latest returned evidence and timestamp, not an older tool result" in prompt
    assert "do not repeat identical reads" in prompt
    assert "unless the user requests a refresh" in prompt
    assert "a relevant mutation occurred, or evidence is missing" in prompt
    assert "answer without another verification loop" in prompt


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
            "choices": [{"message": {"content": "完成"}}],
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
    assert captured["options"]["response_format"] is None
    assert captured["options"]["tools"][0]["type"] == "function"
    assert "parameters" in captured["options"]["tools"][0]["function"]


def test_gateway_applies_output_token_limit_to_count_and_completion(
    monkeypatch: Any,
) -> None:
    captured: dict[str, Any] = {}
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)

    class Provider:
        async def count_tokens(self, request: Any) -> Any:
            captured["count_max_output_tokens"] = request.max_output_tokens
            return type("Count", (), {"tokens": 42})()

        async def stream(self, request: Any) -> Any:
            captured["stream_max_output_tokens"] = request.max_output_tokens
            yield ProviderStreamEvent(kind="text_delta", delta="完成")
            yield ProviderStreamEvent(kind="done")

    monkeypatch.setattr(gateway, "_provider", lambda _record: Provider())

    def request(*_args: Any, **options: Any) -> dict[str, Any]:
        captured["complete_max_output_tokens"] = options.get("max_output_tokens")
        return {"choices": [{"message": {"content": "完成"}}]}

    monkeypatch.setattr(gateway, "_request", request)

    count = asyncio.run(gateway.decision_request_tokens(
        [{"role": "user", "content": "检查"}], [], max_output_tokens=4_000
    ))
    asyncio.run(gateway.decide(
        [{"role": "user", "content": "检查"}], [], max_output_tokens=4_000
    ))
    asyncio.run(gateway.decide_stream(
        [{"role": "user", "content": "检查"}], [],
        lambda _update: asyncio.sleep(0),
        max_output_tokens=4_000,
    ))

    assert count == 42
    assert captured == {
        "count_max_output_tokens": 4_000,
        "complete_max_output_tokens": 4_000,
        "stream_max_output_tokens": 4_000,
    }


def test_gateway_uses_agent_model_override(monkeypatch: Any) -> None:
    captured: dict[str, str] = {}
    gateway = ModelGateway()
    service = FakeSettingsService()
    service.record = AIProviderSettingsRecord(
        base_url="https://models.example/v1",
        api_key="secret",
        model="default-model",
        agent_model="agent-model",
        request_timeout_seconds=10,
        max_retries=0,
    )
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", lambda: service)

    def request(
        _base_url: str,
        _api_key: str,
        model: str,
        _timeout: int,
        _messages: list[dict[str, Any]],
        **_options: Any,
    ) -> dict[str, Any]:
        captured["model"] = model
        return {"choices": [{"message": {"content": "完成"}}]}

    monkeypatch.setattr(gateway, "_request", request)

    result = asyncio.run(gateway.decide([{"role": "user", "content": "检查"}], []))

    assert captured["model"] == "agent-model"
    assert result.model == "agent-model"


def test_gateway_caps_provider_timeout_and_retries_for_activity_budget(
    monkeypatch: Any,
) -> None:
    captured: dict[str, int] = {}
    gateway = ModelGateway(request_timeout_seconds=105, max_retries=0)
    service = FakeSettingsService()
    service.record = AIProviderSettingsRecord(
        **{
            **service.record.__dict__,
            "request_timeout_seconds": 180,
            "max_retries": 2,
        }
    )
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", lambda: service)

    def request(
        _base_url: str,
        _api_key: str,
        _model: str,
        timeout: int,
        _messages: list[dict[str, Any]],
        **_options: Any,
    ) -> dict[str, Any]:
        captured["timeout"] = timeout
        return {"choices": [{"message": {"content": "完成"}}]}

    monkeypatch.setattr(gateway, "_request", request)

    result = asyncio.run(gateway.decide([{"role": "user", "content": "检查"}], []))

    assert result.decision.type == "final"
    assert captured["timeout"] == 105


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
        return {"choices": [{"message": {"content": "完成"}}]}

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


def test_gateway_accepts_plain_markdown_in_one_model_call(monkeypatch: Any) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)
    requests: list[dict[str, Any]] = []

    def request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        requests.append({"messages": args[-1], "options": kwargs})
        return {
            "choices": [{"message": {"content": "项目名称是示例。\n\n资料来自当前项目。"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 9, "total_tokens": 19},
        }

    monkeypatch.setattr(gateway, "_request", request)
    result = asyncio.run(gateway.decide([{"role": "user", "content": "项目叫什么？"}], []))

    assert result.decision.type == "final"
    assert result.decision.answer == "项目名称是示例。\n\n资料来自当前项目。"
    assert result.usage["input_tokens"] == 10
    assert result.usage["output_tokens"] == 9
    assert result.usage["total_tokens"] == 19
    assert len(requests) == 1
    assert requests[0]["options"]["response_format"] is None


def test_gateway_rejects_empty_final_answer_without_a_second_call(monkeypatch: Any) -> None:
    gateway = ModelGateway()
    monkeypatch.setattr(model_gateway, "build_ai_settings_service", FakeSettingsService)
    calls = 0

    def request(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return {"choices": [{"message": {"content": ""}}]}

    monkeypatch.setattr(gateway, "_request", request)

    with pytest.raises(AgentModelOutputError):
        asyncio.run(gateway.decide([{"role": "user", "content": "执行操作"}], []))
    assert calls == 1


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


def test_article_status_compaction_keeps_titles_and_generation_progress() -> None:
    compacted = compact_tool_result({
        "tool": "get_article_generation_status",
        "ok": True,
        "summary": "读取完成",
        "data": {
            "articles": [
                {
                    "article_id": "article-1",
                    "title": "First article",
                    "run_id": "run-1",
                    "status": "completed_with_warnings",
                    "stage": "completed",
                    "progress": 100,
                    "warnings": ["review_recommended"],
                    "error_code": None,
                    "error_detail": None,
                    "ignored": "x" * 2_000,
                },
                {
                    "article_id": "article-2",
                    "title": "Second article",
                    "run_id": "run-2",
                    "status": "completed",
                    "stage": "completed",
                    "progress": 100,
                    "warnings": [],
                    "error_code": None,
                    "error_detail": None,
                },
            ]
        },
    })

    assert compacted["data"]["articles"] == [
        {
            "article_id": "article-1",
            "title": "First article",
            "run_id": "run-1",
            "status": "completed_with_warnings",
            "stage": "completed",
            "progress": 100,
            "warnings": ["review_recommended"],
            "error_code": None,
            "error_detail": None,
        },
        {
            "article_id": "article-2",
            "title": "Second article",
            "run_id": "run-2",
            "status": "completed",
            "stage": "completed",
            "progress": 100,
            "warnings": [],
            "error_code": None,
            "error_detail": None,
        },
    ]


def test_keyword_library_status_compaction_keeps_completion_and_counts() -> None:
    compacted = compact_tool_result({
        "tool": "get_keyword_library_status",
        "ok": True,
        "summary": "读取完成",
        "data": {
            "run": {
                "run_id": "keyword-run-1",
                "kind": "initial",
                "round_number": 1,
                "status": "completed",
                "stage": "completed",
                "message": "关键词库已完成",
                "progress": 100,
                "discovered_count": 512,
                "selected_count": 440,
                "keyword_count": 440,
                "result_version": 2,
                "profile_source": "project_profile",
                "gap_status": "completed",
                "gap_message": "覆盖分析已完成",
                "gap_count": 12,
                "partial_failures": [],
                "error_code": None,
                "recovery_count": 0,
                "elapsed_seconds": 123.4,
            },
            "total_keywords": 440,
            "active_keywords": 440,
            "pending_metrics_count": 0,
            "result_version": 2,
        },
    })

    data = compacted["data"]
    assert data["total_keywords"] == 440
    assert data["active_keywords"] == 440
    assert data["pending_metrics_count"] == 0
    assert data["result_version"] == 2
    assert data["run"] == {
        "run_id": "keyword-run-1",
        "kind": "initial",
        "round_number": 1,
        "status": "completed",
        "stage": "completed",
        "message": "关键词库已完成",
        "progress": 100,
        "discovered_count": 512,
        "selected_count": 440,
        "keyword_count": 440,
        "result_version": 2,
        "profile_source": "project_profile",
        "gap_status": "completed",
        "gap_message": "覆盖分析已完成",
        "gap_count": 12,
        "partial_failures": [],
        "error_code": None,
        "recovery_count": 0,
        "elapsed_seconds": 123.4,
    }


def test_content_plan_status_compaction_keeps_completion_and_counts() -> None:
    compacted = compact_tool_result({
        "tool": "get_content_plan_status",
        "ok": True,
        "summary": "读取完成",
        "data": {
            "batch_id": "content-plan-batch-1",
            "project_id": "project-1",
            "source": "automatic",
            "target_count": 30,
            "status": "completed",
            "stage": "completed",
            "candidate_snapshot_count": 440,
            "selected_count": 30,
            "valid_pack_count": 30,
            "preparation_count": 30,
            "preview_ready_count": 30,
            "plan_item_count": 30,
            "external_request_count": 30,
            "total_cost_usd": 0.42,
            "retryable": False,
            "error_code": None,
            "error_detail": None,
            "created_at": "2026-08-13T09:00:00Z",
            "updated_at": "2026-08-13T09:10:00Z",
            "finished_at": "2026-08-13T09:10:00Z",
        },
    })

    assert compacted["data"] == {
        "batch_id": "content-plan-batch-1",
        "project_id": "project-1",
        "source": "automatic",
        "target_count": 30,
        "status": "completed",
        "stage": "completed",
        "candidate_snapshot_count": 440,
        "selected_count": 30,
        "valid_pack_count": 30,
        "preparation_count": 30,
        "preview_ready_count": 30,
        "plan_item_count": 30,
        "external_request_count": 30,
        "total_cost_usd": 0.42,
        "retryable": False,
        "error_code": None,
        "error_detail": None,
        "created_at": "2026-08-13T09:00:00Z",
        "updated_at": "2026-08-13T09:10:00Z",
        "finished_at": "2026-08-13T09:10:00Z",
    }


def test_project_profile_compaction_keeps_bounded_understanding_evidence() -> None:
    compacted = compact_tool_result({
        "tool_call_id": "call-1",
        "tool": "get_project_profile",
        "ok": True,
        "summary": "读取完成",
        "data": {
            "understanding_status": "running",
            "understanding_stage": "profile_generation",
            "understanding_message": "正在识别核心业务" + "x" * 2_000,
            "understanding_progress": 72,
            "site_profile": {
                "business_name": "Example",
                "confidence": 0.87,
                "evidence": [
                    {
                        "field": f"field-{index}",
                        "value": "v" * 800,
                        "source_url": f"https://example.com/{index}" + "u" * 1_200,
                        "quote": "q" * 1_500,
                        "ignored": "not-for-model",
                    }
                    for index in range(20)
                ],
            },
        },
    })

    data = compacted["data"]
    assert data["understanding_status"] == "running"
    assert data["understanding_stage"] == "profile_generation"
    assert data["understanding_progress"] == 72
    assert len(data["understanding_message"]) == 1_000
    assert data["site_profile"]["confidence"] == 0.87
    assert len(data["site_profile"]["evidence"]) == 12
    assert set(data["site_profile"]["evidence"][0]) == {
        "field", "value", "source_url", "quote",
    }
    assert len(data["site_profile"]["evidence"][0]["value"]) == 500
    assert len(data["site_profile"]["evidence"][0]["source_url"]) == 1_000
    assert len(data["site_profile"]["evidence"][0]["quote"]) == 1_000


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


def test_keyword_and_competitor_results_keep_decision_fields() -> None:
    keyword = compact_tool_result({
        "tool": "list_keywords",
        "ok": True,
        "data": {
            "total": 1,
            "page": 1,
            "page_size": 10,
            "items": [{
                "id": "keyword-1",
                "keyword": "AI SEO",
                "intent": "commercial",
                "search_volume": 900,
                "keyword_difficulty": 31,
                "priority_score": 88.5,
                "sources": ["gsc", "competitor_gap"],
                "metrics_status": "fresh",
                "priority_details": {"large": "omitted"},
            }],
        },
    })
    competitor = compact_tool_result({
        "tool": "get_keyword_competitors",
        "ok": True,
        "data": {"items": [{
            "id": "competitor-1",
            "domain": "example.com",
            "domain_type": "direct_product_competitor",
            "is_seo_competitor": True,
            "is_business_competitor": True,
            "why_they_matter": "Overlaps on product-led queries",
            "visibility": 14.2,
            "organic_keywords": 800,
            "organic_traffic": 1200,
            "status": "completed",
            "serp_evidence": [{"large": "omitted"}],
        }]},
    })

    assert keyword["data"]["items"][0]["priority_score"] == 88.5
    assert "priority_details" not in keyword["data"]["items"][0]
    assert competitor["data"]["items"][0]["domain"] == "example.com"
    assert "serp_evidence" not in competitor["data"]["items"][0]


def test_performance_and_direct_article_results_keep_actionable_data() -> None:
    overview = compact_tool_result({
        "tool": "get_search_performance",
        "ok": True,
        "data": {
            "gsc_connected": True,
            "date_range": 28,
            "range_start": "2026-07-16",
            "range_end": "2026-08-12",
            "metrics": {"clicks": 120, "impressions": 4000},
            "change": {"clicks": 0.2},
            "sync": {"status": "completed", "data_through": "2026-08-12"},
            "growing_articles": [{
                "article_id": "article-1",
                "title": "AI SEO",
                "primary_keyword": "AI SEO",
                "metrics": {"clicks": 40},
                "change": {"clicks": 0.5},
                "document": {"large": "omitted"},
            }],
        },
    })
    created = compact_tool_result({
        "tool": "create_article",
        "ok": True,
        "data": {
            "article_id": "article-1",
            "run_id": "run-1",
            "primary_keyword": "AI SEO",
            "title": None,
            "status": "queued",
            "stage": "queued",
            "progress": 0,
            "internal": "omitted",
        },
    })

    assert overview["data"]["gsc_connected"] is True
    assert overview["data"]["growing_articles"][0]["metrics"]["clicks"] == 40
    assert "document" not in overview["data"]["growing_articles"][0]
    assert created["data"] == {
        "article_id": "article-1",
        "run_id": "run-1",
        "primary_keyword": "AI SEO",
        "title": None,
        "status": "queued",
        "stage": "queued",
        "progress": 0,
    }


def test_streaming_sanitizer_redacts_secret_split_across_provider_chunks() -> None:
    secret = "secret-value"
    sanitizer = StreamingTextSanitizer((secret,))

    output = sanitizer.feed("result api_key=sec")
    output += sanitizer.feed("ret-value finished " + "x" * 100)
    output += sanitizer.flush()

    assert secret not in output
    assert "[REDACTED]" in output


def test_streaming_sanitizer_emits_ordinary_short_text_immediately() -> None:
    sanitizer = StreamingTextSanitizer(("super-secret-key",))

    assert sanitizer.feed("结论明确。") == "结论明确。"
    assert sanitizer.flush() == ""


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
        return ({"content": "完成"}, {})

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


def test_decision_stream_emits_plain_markdown_in_one_model_attempt(
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
        content = "结论明确。\n\n- 第一项\n- 第二项"
        await on_update({"kind": "text_delta", "delta": "结论明确。\n\n"})
        await on_update({"kind": "text_delta", "delta": "- 第一项\n- 第二项"})
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
    assert result.decision.answer == "结论明确。\n\n- 第一项\n- 第二项"
    assert attempts == 1
    assert [
        (update["attempt"], update["status"])
        for update in updates if update["kind"] == "stream_end"
    ] == [(0, "completed")]
    assert [
        update["attempt"] for update in updates if update["kind"] == "stream_start"
    ] == [0]
    assert "".join(
        update["delta"] for update in updates if update["kind"] == "text_delta"
    ) == result.decision.answer


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
                    "content": "密钥是 super-secret-key",
                }
            }]
        }

    monkeypatch.setattr(gateway, "_request_with_connection_retries", request)

    result = asyncio.run(gateway.decide([], []))

    assert result.decision.type == "final"
    assert result.decision.answer == "密钥是 [REDACTED]"
