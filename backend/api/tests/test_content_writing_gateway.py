import asyncio
import json
from typing import Any

import pytest

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


def test_generate_sends_exact_output_schema(monkeypatch: pytest.MonkeyPatch) -> None:
    gateway = WritingGateway()
    captured: list[dict[str, str]] = []

    async def configured_record() -> AIProviderSettingsRecord:
        return record()

    async def request_with_retries(
        _record: AIProviderSettingsRecord,
        messages: list[dict[str, str]],
        **_: Any,
    ) -> dict[str, Any]:
        captured.extend(messages)
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

    schema_message = next(
        item["content"] for item in captured if item["content"].startswith("Required output JSON Schema:")
    )
    schema = json.loads(schema_message.split("\n", 1)[1])
    assert schema == ArticlePlan.model_json_schema()
    assert result.value.sections[0].section_id == "intro"


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
