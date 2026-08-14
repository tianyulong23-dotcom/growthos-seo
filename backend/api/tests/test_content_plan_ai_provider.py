from __future__ import annotations

import json
import socket
from errno import EHOSTUNREACH, ENETUNREACH
from typing import Any
from urllib.error import URLError
from urllib.request import Request

import pytest

from app.modules.agent.providers import ProviderConfig, ProviderError, ProviderResult
from app.modules.agent.providers import openai as openai_provider
from app.modules.agent.providers.openai import OpenAIProvider
from app.modules.agent.providers.usage import ProviderUsage
from app.modules.content_plan import providers as content_plan_providers
from app.modules.content_plan.domain import CandidateClassification, SeedCandidate
from app.modules.content_plan.providers import ContentPlanAIGateway
from app.modules.content_plan.service import BusinessContext, TopicClassificationInput
from app.modules.settings.service import AIProviderSettingsRecord


pytestmark = pytest.mark.anyio


@pytest.mark.parametrize(
    "error",
    [
        URLError(socket.gaierror(socket.EAI_NONAME, "name not known")),
        URLError(ConnectionRefusedError("connection refused")),
        URLError(OSError(ENETUNREACH, "network unreachable")),
        URLError(OSError(EHOSTUNREACH, "host unreachable")),
    ],
)
async def test_provider_marks_connection_setup_failure_as_not_submitted(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
) -> None:
    provider = OpenAIProvider(
        ProviderConfig(
            provider="openai",
            base_url="https://model.example/v1",
            api_key="secret",
            model="content-model",
            timeout_seconds=10,
            max_retries=0,
        )
    )
    monkeypatch.setattr(
        openai_provider,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(error),
    )

    with pytest.raises(ProviderError) as raised:
        provider._read_response(Request("https://model.example/v1/chat/completions"))

    assert raised.value.request_not_submitted is True


async def test_provider_keeps_response_timeout_outcome_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = OpenAIProvider(
        ProviderConfig(
            provider="openai",
            base_url="https://model.example/v1",
            api_key="secret",
            model="content-model",
            timeout_seconds=10,
            max_retries=0,
        )
    )
    monkeypatch.setattr(
        openai_provider,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(TimeoutError()),
    )

    with pytest.raises(ProviderError) as raised:
        provider._read_response(Request("https://model.example/v1/chat/completions"))

    assert raised.value.request_not_submitted is False


async def test_content_plan_ai_requires_top_level_items_array(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_request: dict[str, Any] = {}

    class SettingsService:
        async def effective_record_for_organization(
            self, _organization_id: str
        ) -> AIProviderSettingsRecord:
            return AIProviderSettingsRecord(
                base_url="https://model.example/v1",
                api_key="secret",
                model="content-model",
            )

    class Provider:
        async def complete(self, request):
            captured_request["response_format"] = request.response_format
            return ProviderResult(
                provider="openai",
                model="content-model",
                response_model="content-model",
                message={"content": '{"items":[]}'},
                usage=ProviderUsage(input_tokens=10, output_tokens=5),
                response_id="response-1",
            )

    monkeypatch.setattr(
        content_plan_providers,
        "build_provider",
        lambda _config: Provider(),
    )
    monkeypatch.setattr(
        content_plan_providers,
        "current_content_plan_organization",
        lambda: "organization-1",
    )

    result = await ContentPlanAIGateway(SettingsService())._complete(
        "organization-1",
        "Return one item.",
        {"candidate": "keyword"},
    )

    response_format = captured_request["response_format"]
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["schema"]["required"] == ["items"]
    assert response_format["json_schema"]["schema"]["properties"]["items"][
        "type"
    ] == "array"
    assert result.output == []


async def test_seed_decision_uses_short_refs_and_restores_internal_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_request: dict[str, Any] = {}

    class SettingsService:
        async def effective_record_for_organization(
            self, _organization_id: str
        ) -> AIProviderSettingsRecord:
            return AIProviderSettingsRecord(
                base_url="https://model.example/v1",
                api_key="secret",
                model="content-model",
            )

    class Provider:
        async def complete(self, request):
            captured_request["request"] = request
            return ProviderResult(
                provider="openai",
                model="content-model",
                response_model="content-model",
                message={
                    "content": (
                        '{"items":['
                        '{"keyword_id":"c1","action":"keep",'
                        '"same_topic_as":null,"reason":"distinct topic"},'
                        '{"keyword_id":"c2","action":"drop",'
                        '"same_topic_as":"r1","reason":"same topic"}'
                        "]}"
                    )
                },
                usage=ProviderUsage(input_tokens=10, output_tokens=5),
                response_id="response-1",
            )

    monkeypatch.setattr(
        content_plan_providers,
        "build_provider",
        lambda _config: Provider(),
    )
    monkeypatch.setattr(
        content_plan_providers,
        "current_content_plan_organization",
        lambda: "organization-1",
    )
    candidate_ids = [
        "candidate-e3b33698edc84182af5b6dc0683871ac",
        "candidate-3f341b49ce0740e0bc26b79e2c9a9dc8",
    ]
    retained_id = "candidate-85ec33a304014dc3a76d981efc95b85b"

    result = await ContentPlanAIGateway(SettingsService()).decide(
        [
            SeedCandidate(candidate_ids[0], "solar panel reviews", 1),
            SeedCandidate(candidate_ids[1], "best solar panels", 2),
        ],
        [SeedCandidate(retained_id, "solar panel guide", 0)],
        business_context=content_plan_providers.BusinessContext(
            business_name="Solar Reviews",
            business_type="solar publishing",
            business_summary="Independent solar information.",
            target_audiences=("homeowners",),
            products_services=("solar reviews",),
        ),
        country="US",
        language="en",
    )

    request = captured_request["request"]
    payload = json.loads(request.messages[2]["content"])
    assert [row["keyword_id"] for row in payload["candidates"]] == ["c1", "c2"]
    assert [row["keyword_id"] for row in payload["retained"]] == ["r1"]
    assert not any(candidate_id in request.messages[2]["content"] for candidate_id in candidate_ids)
    assert retained_id not in request.messages[2]["content"]

    response_format = request.response_format
    items_schema = response_format["json_schema"]["schema"]["properties"]["items"]
    decision_schema = items_schema["items"]
    assert response_format["json_schema"]["strict"] is True
    assert items_schema["minItems"] == items_schema["maxItems"] == 2
    assert decision_schema["properties"]["keyword_id"]["enum"] == ["c1", "c2"]
    assert decision_schema["properties"]["same_topic_as"]["anyOf"] == [
        {"type": "string", "enum": ["c1", "c2", "r1"]},
        {"type": "null"},
    ]
    assert result.output == [
        {
            "keyword_id": candidate_ids[0],
            "action": "keep",
            "same_topic_as": None,
            "reason": "distinct topic",
        },
        {
            "keyword_id": candidate_ids[1],
            "action": "drop",
            "same_topic_as": retained_id,
            "reason": "same topic",
        },
    ]


async def test_classification_schema_limits_output_to_every_candidate_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_request: dict[str, Any] = {}

    class SettingsService:
        async def effective_record_for_organization(
            self, _organization_id: str
        ) -> AIProviderSettingsRecord:
            return AIProviderSettingsRecord(
                base_url="https://model.example/v1",
                api_key="secret",
                model="content-model",
            )

    class Provider:
        async def complete(self, request):
            captured_request["request"] = request
            return ProviderResult(
                provider="openai",
                model="content-model",
                response_model="content-model",
                message={
                    "content": (
                        '{"items":['
                        '{"candidate_id":"candidate-a","relevance":"same_topic",'
                        '"keyword_type":"informational","primary_fit":"strong",'
                        '"secondary_candidate_ids":[],"reason_code":"answers_definition"},'
                        '{"candidate_id":"candidate-b","relevance":"unrelated",'
                        '"keyword_type":"unknown","primary_fit":"ineligible",'
                        '"secondary_candidate_ids":[],"reason_code":"unrelated_business"}'
                        "]}"
                    )
                },
                usage=ProviderUsage(input_tokens=10, output_tokens=5),
                response_id="response-1",
            )

    monkeypatch.setattr(
        content_plan_providers,
        "build_provider",
        lambda _config: Provider(),
    )
    monkeypatch.setattr(
        content_plan_providers,
        "current_content_plan_organization",
        lambda: "organization-1",
    )
    candidates = [
        CandidateClassification("candidate-a", "analytics tool", "seed"),
        CandidateClassification("candidate-b", "unrelated query", "related"),
    ]

    await ContentPlanAIGateway(SettingsService()).classify(
        "analytics tool",
        candidates,
        business_context=content_plan_providers.BusinessContext(
            business_name="Plausible",
            business_type="analytics",
            business_summary="Privacy-friendly analytics.",
            target_audiences=("website owners",),
            products_services=("web analytics",),
        ),
        country="US",
        language="en",
    )

    response_format = captured_request["request"].response_format
    schema = response_format["json_schema"]["schema"]
    items_schema = schema["properties"]["items"]
    decision_schema = items_schema["items"]
    assert response_format["json_schema"]["strict"] is True
    assert items_schema["minItems"] == items_schema["maxItems"] == 2
    assert decision_schema["properties"]["candidate_id"]["enum"] == [
        "candidate-a",
        "candidate-b",
    ]
    assert set(decision_schema["required"]) == set(decision_schema["properties"])
    assert decision_schema["additionalProperties"] is False


async def test_bulk_classification_uses_short_refs_and_extended_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class SettingsService:
        async def effective_record_for_organization(
            self, _organization_id: str
        ) -> AIProviderSettingsRecord:
            return AIProviderSettingsRecord(
                base_url="https://model.example/v1",
                api_key="secret",
                model="content-model",
                request_timeout_seconds=180,
            )

    class Provider:
        async def complete(self, request):
            captured["request"] = request
            return ProviderResult(
                provider="openai",
                model="content-model",
                response_model="content-model",
                message={
                    "content": json.dumps(
                        {
                            "items": [
                                {
                                    "topic_id": topic_id,
                                    "candidate_id": candidate_id,
                                    "relevance": "same_topic",
                                    "keyword_type": "informational",
                                    "primary_fit": "strong",
                                    "secondary_candidate_ids": (
                                        ["t1c2"] if candidate_id == "t1c1" else []
                                    ),
                                    "reason_code": "answers_definition",
                                }
                                for topic_id, candidate_id in (
                                    ("t1", "t1c1"),
                                    ("t1", "t1c2"),
                                    ("t2", "t2c1"),
                                    ("t2", "t2c2"),
                                )
                            ]
                        }
                    )
                },
                usage=ProviderUsage(input_tokens=100, output_tokens=50),
                response_id="bulk-response-1",
            )

    def build_provider(config):
        captured["config"] = config
        return Provider()

    monkeypatch.setattr(content_plan_providers, "build_provider", build_provider)
    monkeypatch.setattr(
        content_plan_providers,
        "current_content_plan_organization",
        lambda: "organization-1",
    )
    internal_ids = [f"candidate-{index}-long-internal-id" for index in range(1, 5)]
    topics = [
        TopicClassificationInput(
            topic_id="preparation-one-long-internal-id",
            seed_keyword="solar panels",
            candidates=(
                CandidateClassification(internal_ids[0], "solar panels", "seed"),
                CandidateClassification(internal_ids[1], "solar panel guide", "related"),
            ),
        ),
        TopicClassificationInput(
            topic_id="preparation-two-long-internal-id",
            seed_keyword="solar costs",
            candidates=(
                CandidateClassification(internal_ids[2], "solar costs", "seed"),
                CandidateClassification(internal_ids[3], "solar cost guide", "related"),
            ),
        ),
    ]

    result = await ContentPlanAIGateway(SettingsService()).classify_topics(
        topics,
        business_context=BusinessContext(
            business_name="Solar Reviews",
            business_type="solar publishing",
            business_summary="Independent solar information.",
            target_audiences=("homeowners",),
            products_services=("solar reviews",),
        ),
        country="US",
        language="en",
    )

    request = captured["request"]
    payload = json.loads(request.messages[2]["content"])
    assert [row["topic_id"] for row in payload["topics"]] == ["t1", "t2"]
    assert [
        candidate["candidate_id"]
        for topic in payload["topics"]
        for candidate in topic["candidates"]
    ] == ["t1c1", "t1c2", "t2c1", "t2c2"]
    assert not any(value in request.messages[2]["content"] for value in internal_ids)
    assert "preparation-one-long-internal-id" not in request.messages[2]["content"]
    assert captured["config"].timeout_seconds >= 360
    items_schema = request.response_format["json_schema"]["schema"]["properties"]["items"]
    assert items_schema["minItems"] == items_schema["maxItems"] == 4
    assert items_schema["items"]["properties"]["topic_id"]["enum"] == ["t1", "t2"]
    assert items_schema["items"]["properties"]["candidate_id"]["enum"] == [
        "t1c1",
        "t1c2",
        "t2c1",
        "t2c2",
    ]
    assert [row["topic_id"] for row in result.output] == [
        topics[0].topic_id,
        topics[0].topic_id,
        topics[1].topic_id,
        topics[1].topic_id,
    ]
    assert [row["candidate_id"] for row in result.output] == internal_ids
    assert result.output[0]["secondary_candidate_ids"] == [internal_ids[1]]
