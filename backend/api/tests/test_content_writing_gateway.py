import asyncio
import json
from typing import Any

import pytest
from pydantic import ValidationError

from app.modules.content import writing_gateway
from app.modules.content.writing_gateway import (
    ArticlePlan,
    OutlineSection,
    WritingGateway,
    WritingRequestError,
    merge_usage,
    parse_usage,
)
from app.modules.settings.service import AIProviderSettingsRecord


def valid_plan() -> dict[str, Any]:
    return {
        "title": "Test title",
        "search_intent": "Learn the topic",
        "article_type": "How-To",
        "meta_title": "Test title",
        "meta_description": "A complete description of the test article.",
        "slug": "test-title",
        "total_word_target": 100,
        "gap_to_section_mapping": {},
        "claims": [],
        "sections": [
            OutlineSection(
                section_id="intro",
                heading="Introduction",
                objective="Introduce the topic",
                word_target=100,
            ).model_dump(mode="json")
        ],
    }


def record(*, max_retries: int = 2) -> AIProviderSettingsRecord:
    return AIProviderSettingsRecord(
        base_url="https://model.example/v1",
        api_key="secret",
        model="test-model",
        request_timeout_seconds=30,
        max_retries=max_retries,
    )


def test_responses_writing_request_uses_text_format_and_normalizes_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = WritingGateway()
    configured = AIProviderSettingsRecord(
        base_url="https://model.example/v1",
        api_key="secret",
        model="test-model",
        api_protocol="responses",
        request_timeout_seconds=30,
        max_retries=0,
    )
    captured: dict[str, Any] = {}

    class FakeResponse:
        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def read(self, _limit: int) -> bytes:
            return json.dumps({
                "id": "response-1",
                "model": "test-model",
                "status": "completed",
                "output": [{
                    "type": "message",
                    "content": [{
                        "type": "output_text",
                        "text": json.dumps(valid_plan()),
                    }],
                }],
                "usage": {"input_tokens": 10, "output_tokens": 20},
            }).encode()

    def fake_urlopen(request: Any, timeout: int) -> FakeResponse:
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data)
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(writing_gateway, "urlopen", fake_urlopen)
    response = gateway._request(
        configured,
        [{"role": "user", "content": "input"}],
        response_format={
            "type": "json_schema",
            "json_schema": {
                "name": "plan_article",
                "strict": False,
                "schema": ArticlePlan.model_json_schema(),
            },
        },
    )

    assert captured["url"] == "https://model.example/v1/responses"
    assert captured["body"]["input"] == [{"role": "user", "content": "input"}]
    assert captured["body"]["text"]["format"]["type"] == "json_schema"
    assert captured["body"]["text"]["format"]["name"] == "plan_article"
    assert response["choices"][0]["message"]["content"] == json.dumps(valid_plan())
    assert response["usage"] == {"input_tokens": 10, "output_tokens": 20}


def test_configured_record_uses_content_model_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSettingsService:
        async def effective_record(self) -> AIProviderSettingsRecord:
            return AIProviderSettingsRecord(
                base_url="https://model.example/v1",
                api_key="secret",
                model="default-model",
                content_model="content-model",
            )

    monkeypatch.setattr(
        writing_gateway,
        "build_ai_settings_service",
        FakeSettingsService,
    )

    configured = asyncio.run(WritingGateway().configured_record())

    assert configured.model == "content-model"


def test_generate_sends_exact_output_schema(monkeypatch: pytest.MonkeyPatch) -> None:
    gateway = WritingGateway()
    captured: list[dict[str, str]] = []
    captured_response_format: dict[str, Any] = {}

    async def configured_record() -> AIProviderSettingsRecord:
        return record()

    async def request_with_retries(
        _record: AIProviderSettingsRecord,
        messages: list[dict[str, str]],
        *,
        response_format: dict[str, Any] | None = None,
        **_: Any,
    ) -> dict[str, Any]:
        captured.extend(messages)
        captured_response_format.update(response_format or {})
        return {
            "id": "response-1",
            "choices": [{"message": {"content": json.dumps(valid_plan())}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20},
        }

    monkeypatch.setattr(gateway, "configured_record", configured_record)
    monkeypatch.setattr(gateway, "_request_with_retries", request_with_retries)

    result = asyncio.run(
        gateway.generate("plan_article", {"research_pack": {}}, ArticlePlan)
    )

    assert captured == [{"role": "user", "content": '{"research_pack":{}}'}]
    assert captured_response_format["type"] == "json_schema"
    assert captured_response_format["json_schema"]["schema"] == (
        ArticlePlan.model_json_schema()
    )
    assert "Required output JSON Schema" not in captured[0]["content"]
    assert "Input JSON" not in captured[0]["content"]
    assert result.value.sections[0].section_id == "intro"


def test_evidence_claim_schema_does_not_require_support_status() -> None:
    schema = writing_gateway.EvidenceClaim.model_json_schema()

    assert "supported" not in schema["properties"]
    claim = writing_gateway.EvidenceClaim.model_validate(
        {
            "claim_id": "claim-1",
            "claim": "A useful fact",
            "source_url": "https://example.com/source",
            "supported": False,
        }
    )
    assert claim.claim == "A useful fact"


def test_article_plan_accepts_a_gap_mapped_to_multiple_sections() -> None:
    payload = valid_plan()
    payload["gap_to_section_mapping"] = {
        "No clear practical next step": ["how-to-choose", "conclusion"]
    }

    plan = ArticlePlan.model_validate(payload)

    assert plan.gap_to_section_mapping == {
        "No clear practical next step": ["how-to-choose", "conclusion"]
    }


def test_article_plan_defaults_to_no_critical_research_gaps() -> None:
    plan = ArticlePlan.model_validate(valid_plan())

    assert plan.critical_research_gaps == []


def test_article_plan_caps_critical_research_gaps_at_four() -> None:
    payload = valid_plan()
    payload["critical_research_gaps"] = [
        {
            "missing_information": f"Missing information {index}",
            "why_it_blocks_core_answer": "The core answer depends on it.",
            "research_query": f"Research complete topic {index}",
        }
        for index in range(5)
    ]

    with pytest.raises(ValidationError):
        ArticlePlan.model_validate(payload)


def test_invalid_output_retry_adds_no_prompt_or_previous_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = WritingGateway()
    captured: list[list[dict[str, str]]] = []

    async def configured_record() -> AIProviderSettingsRecord:
        return record()

    async def request_with_retries(
        _record: AIProviderSettingsRecord,
        messages: list[dict[str, str]],
        **_: Any,
    ) -> dict[str, Any]:
        captured.append([dict(item) for item in messages])
        content = "not-json" if len(captured) == 1 else json.dumps(valid_plan())
        return {
            "id": f"response-{len(captured)}",
            "choices": [{"message": {"content": content}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20},
        }

    monkeypatch.setattr(gateway, "configured_record", configured_record)
    monkeypatch.setattr(gateway, "_request_with_retries", request_with_retries)

    result = asyncio.run(
        gateway.generate("plan_article", {"research_pack": {}}, ArticlePlan)
    )

    assert len(captured) == 2
    assert captured[1] == captured[0]
    assert all(item["role"] == "user" for item in captured[1])
    assert result.value.title == "Test title"


def test_provider_reported_cost_is_not_treated_as_an_estimate() -> None:
    usage = parse_usage(
        {
            "usage": {
                "prompt_tokens": 1_000,
                "completion_tokens": 500,
                "total_cost": 0.0125,
                "currency": "USD",
            }
        }
    )

    assert usage == {
        "input_tokens": 1_000,
        "output_tokens": 500,
        "unreported_input_tokens": 0,
        "unreported_output_tokens": 0,
        "reported_cost": 0.0125,
        "estimated_cost": None,
        "cost_currency": "USD",
        "estimation_basis": {},
    }


def test_merge_usage_keeps_unreported_tokens_separate_from_reported_cost() -> None:
    merged = merge_usage(
        [
            parse_usage(
                {
                    "usage": {
                        "prompt_tokens": 1_000,
                        "completion_tokens": 500,
                        "cost": 0.01,
                        "cost_currency": "USD",
                    }
                }
            ),
            parse_usage(
                {
                    "usage": {
                        "prompt_tokens": 2_000,
                        "completion_tokens": 1_000,
                    }
                }
            ),
        ]
    )

    assert merged["input_tokens"] == 3_000
    assert merged["output_tokens"] == 1_500
    assert merged["reported_cost"] == 0.01
    assert merged["estimated_cost"] is None
    assert merged["unreported_input_tokens"] == 2_000
    assert merged["unreported_output_tokens"] == 1_000


def test_timeout_is_retried_only_once(monkeypatch: pytest.MonkeyPatch) -> None:
    gateway = WritingGateway()
    calls = 0

    def request(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        raise WritingRequestError("writing_provider_timeout", retryable=True)

    monkeypatch.setattr(gateway, "_request", request)

    with pytest.raises(WritingRequestError) as caught:
        asyncio.run(gateway._request_with_retries(record(max_retries=4), []))

    assert caught.value.code == "writing_provider_timeout"
    assert caught.value.attempts == 2
    assert calls == 2


def test_non_retryable_request_error_is_not_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = WritingGateway()
    calls = 0

    def request(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        raise WritingRequestError("writing_provider_auth_error", retryable=False)

    monkeypatch.setattr(gateway, "_request", request)

    with pytest.raises(WritingRequestError) as caught:
        asyncio.run(gateway._request_with_retries(record(), []))

    assert caught.value.attempts == 1
    assert calls == 1


def test_run_circuit_opens_after_two_failed_generation_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway = WritingGateway()
    calls = 0

    async def configured_record() -> AIProviderSettingsRecord:
        return record()

    async def request_with_retries(*_: Any, **__: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        raise WritingRequestError(
            "writing_provider_network_error", retryable=True, attempts=3
        )

    monkeypatch.setattr(gateway, "configured_record", configured_record)
    monkeypatch.setattr(gateway, "_request_with_retries", request_with_retries)

    for _ in range(2):
        with pytest.raises(WritingRequestError):
            asyncio.run(
                gateway.generate("plan_article", {"research_pack": {}}, ArticlePlan)
            )

    with pytest.raises(WritingRequestError) as caught:
        asyncio.run(gateway.generate("plan_article", {"research_pack": {}}, ArticlePlan))

    assert caught.value.code == "writing_provider_circuit_open"
    assert caught.value.attempts == 0
    assert calls == 2
