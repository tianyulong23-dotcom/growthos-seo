from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.error import URLError

import httpx
import pytest

from app.modules.agent.providers import ProviderConfig, ProviderError
from app.modules.agent.providers.openai import OpenAIProvider
from app.modules.content import dataforseo
from app.modules.content.dataforseo import (
    DataForSEOClient,
    DataForSEOEmptyResult,
    DataForSEOError,
    DataForSEOOutcomeUnknown,
    parse_serp_response,
)
from app.modules.content_plan.d4_service import ContentPlanD4Service, D4GroupError
from app.modules.content_plan.providers import ContentPlanDataForSEOGateway
from app.modules.content_plan.service import (
    AICallResult,
    ContentPlanD3Service,
    D3ProcessingError,
    ExpansionSeed,
)


pytestmark = pytest.mark.anyio


class ConnectErrorClient:
    async def post(self, url: str, *, json: list[dict[str, object]]):
        request = httpx.Request("POST", f"https://api.example/{url}")
        raise httpx.ConnectError("connection dropped", request=request)


class ResponseClient:
    def __init__(self, *, status_code: int = 200, tag: object = "tag-1") -> None:
        request = httpx.Request("POST", "https://api.example/related")
        payload = {
            "tasks": [
                {
                    "id": "provider-task-1",
                    "status_code": 20000,
                    "cost": 0.01,
                    "data": {} if tag is None else {"tag": tag},
                    "result": [{"items": []}],
                }
            ]
        }
        self.response = httpx.Response(
            status_code,
            request=request,
            json=payload,
        )

    async def post(self, _url: str, *, json: list[dict[str, object]]):
        del json
        return self.response


async def test_related_keywords_connection_error_has_unknown_outcome() -> None:
    gateway = ContentPlanDataForSEOGateway.__new__(ContentPlanDataForSEOGateway)

    result = await gateway._related_request(
        ConnectErrorClient(),
        ExpansionSeed(
            preparation_id="preparation-1",
            request_index=1,
            keyword="solar battery",
            tag="content-plan:batch-1:1",
        ),
        country="US",
        language="en",
    )

    assert result.status == "uncertain"
    assert result.error_code == "external_request_outcome_unknown"
    assert result.preparation_id == "preparation-1"


def _expansion_seed() -> ExpansionSeed:
    return ExpansionSeed(
        preparation_id="preparation-1",
        request_index=1,
        keyword="solar battery",
        tag="tag-1",
    )


async def test_related_keywords_requires_matching_response_tag() -> None:
    gateway = ContentPlanDataForSEOGateway.__new__(ContentPlanDataForSEOGateway)

    matched = await gateway._related_request(
        ResponseClient(), _expansion_seed(), country="US", language="en"
    )
    missing = await gateway._related_request(
        ResponseClient(tag=None), _expansion_seed(), country="US", language="en"
    )
    mismatched = await gateway._related_request(
        ResponseClient(tag="other-tag"),
        _expansion_seed(),
        country="US",
        language="en",
    )

    assert matched.status == "completed"
    assert matched.provider_request_id == "provider-task-1"
    assert missing.status == mismatched.status == "uncertain"
    assert missing.error_code == mismatched.error_code == "external_response_mismatch"


@pytest.mark.parametrize(
    ("status_code", "expected"),
    [
        (408, "retryable_failed"),
        (429, "retryable_failed"),
        (503, "retryable_failed"),
        (400, "failed"),
        (401, "failed"),
        (403, "failed"),
        (404, "failed"),
    ],
)
async def test_related_keywords_retries_only_temporary_http_failures(
    status_code: int, expected: str
) -> None:
    gateway = ContentPlanDataForSEOGateway.__new__(ContentPlanDataForSEOGateway)

    result = await gateway._related_request(
        ResponseClient(status_code=status_code),
        _expansion_seed(),
        country="US",
        language="en",
    )

    assert result.status == expected


def _serp_client() -> DataForSEOClient:
    return DataForSEOClient(
        login="login",
        password="password",
        base_url="https://api.example",
        cache=None,
        cache_ttl_seconds=3600,
        timeout_seconds=10,
    )


@pytest.mark.parametrize("error", [URLError("connection dropped"), TimeoutError()])
async def test_serp_transport_error_has_unknown_outcome(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
) -> None:
    def fail(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(dataforseo, "urlopen", fail)

    with pytest.raises(DataForSEOOutcomeUnknown) as exc_info:
        _serp_client()._request("solar battery", "US", "en", "desktop")

    assert str(exc_info.value) == "dataforseo_request_outcome_unknown"
    assert exc_info.value.__cause__ is error


async def test_serp_invalid_json_has_unknown_outcome(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class InvalidJsonResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args) -> None:
            return None

        def read(self) -> bytes:
            return b"not-json"

    monkeypatch.setattr(dataforseo, "urlopen", lambda *_args, **_kwargs: InvalidJsonResponse())

    with pytest.raises(DataForSEOOutcomeUnknown) as exc_info:
        _serp_client()._request("solar battery", "US", "en", "desktop")

    assert isinstance(exc_info.value.__cause__, json.JSONDecodeError)


def test_serp_provider_error_preserves_status_message_task_and_cost() -> None:
    response = {
        "status_code": 20000,
        "status_message": "Ok.",
        "tasks": [
            {
                "id": "task-failed-1",
                "status_code": 40103,
                "status_message": "Task execution failed.",
                "cost": 0.002,
                "result": None,
            }
        ],
    }

    with pytest.raises(DataForSEOError) as exc_info:
        parse_serp_response(response, "solar battery")

    assert exc_info.value.status_code == 40103
    assert exc_info.value.status_message == "Task execution failed."
    assert exc_info.value.task_id == "task-failed-1"
    assert exc_info.value.cost_usd == 0.002
    assert exc_info.value.retryable is False


async def test_standard_serp_submits_once_then_gets_result_by_task_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _serp_client()
    calls: list[tuple[str, str, object]] = []

    def request_json(method: str, endpoint: str, payload=None):
        calls.append((method, endpoint, payload))
        if method == "POST":
            return {
                "status_code": 20000,
                "tasks": [
                    {
                        "id": "standard-task-1",
                        "status_code": 20100,
                        "status_message": "Task Created.",
                        "cost": 0.002,
                        "data": {"tag": "ledger-tag-1"},
                    }
                ],
            }
        return {
            "status_code": 20000,
            "tasks": [
                {
                    "id": "standard-task-1",
                    "status_code": 20000,
                    "status_message": "Ok.",
                    "cost": 0,
                    "result": [{"items": []}],
                }
            ],
        }

    monkeypatch.setattr(client, "_request_json", request_json)

    receipt = await client.submit_serp_task(
        "solar battery", "US", "en", "desktop", tag="ledger-tag-1"
    )
    with pytest.raises(DataForSEOEmptyResult) as exc_info:
        await client.get_serp_task(receipt.task_id, "solar battery")
    result = exc_info.value.result

    assert receipt.task_id == "standard-task-1"
    assert receipt.tag == "ledger-tag-1"
    assert result.provider_request_id == "standard-task-1"
    assert [call[0] for call in calls] == ["POST", "GET"]
    assert calls[0][1] == "/v3/serp/google/organic/task_post"
    assert calls[1][1].endswith("/task_get/advanced/standard-task-1")


async def test_standard_serp_recovers_ready_task_by_tag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = _serp_client()
    monkeypatch.setattr(
        client,
        "_request_json",
        lambda method, endpoint, payload=None: {
            "status_code": 20000,
            "tasks": [
                {
                    "id": "ready-list",
                    "status_code": 20000,
                    "result": [
                        {"id": "other-task", "tag": "other-tag"},
                        {"id": "recovered-task", "tag": "ledger-tag-1"},
                    ],
                }
            ],
        },
    )

    recovered = await client.find_ready_serp_task("ledger-tag-1")

    assert recovered == "recovered-task"


class AILedgerRepository:
    def __init__(self) -> None:
        self.attempt_count = 0
        self.failures: list[dict[str, object]] = []
        self.completions: list[dict[str, object]] = []

    async def prepare_external_request(self, **_values):
        return SimpleNamespace(
            status="prepared",
            response_metadata_json={},
            error_code=None,
            error_detail=None,
        )

    async def claim_external_request(self, _request_key: str, **_values):
        self.attempt_count += 1
        return SimpleNamespace(attempt_count=self.attempt_count)

    async def fail_external_request(self, _request_key: str, **values):
        self.failures.append(values)
        return SimpleNamespace(**values)

    async def mark_stale_submitted_request_uncertain(self, _request_key: str):
        return None

    async def complete_external_request(self, _request_key: str, **values):
        self.completions.append(values)
        return SimpleNamespace(**values)


def _provider_error(
    status_code: int | None,
    *,
    request_not_submitted: bool = False,
) -> ProviderError:
    if status_code is None:
        return ProviderError(
            "connection outcome unknown",
            code="model_provider_timeout",
            retryable=True,
            request_not_submitted=request_not_submitted,
        )
    return ProviderError(
        f"HTTP {status_code}",
        code=(
            "model_provider_auth_failed"
            if status_code in {401, 403}
            else "model_provider_unavailable"
        ),
        retryable=status_code == 429 or status_code >= 500,
        status_code=status_code,
    )


def _d3_service(repository: AILedgerRepository) -> ContentPlanD3Service:
    return ContentPlanD3Service(
        repository,
        seed_gateway=SimpleNamespace(),
        expansion_gateway=SimpleNamespace(),
        classification_gateway=SimpleNamespace(),
        coverage_query=SimpleNamespace(),
    )


@pytest.mark.parametrize(
    (
        "status_code",
        "request_not_submitted",
        "attempts",
        "ledger_status",
        "error_code",
    ),
    [
        (429, False, 3, "retryable_failed", "ai_request_retry_exhausted"),
        (503, False, 3, "retryable_failed", "ai_request_retry_exhausted"),
        (401, False, 1, "failed", "model_provider_auth_failed"),
        (403, False, 1, "failed", "model_provider_auth_failed"),
        (None, True, 3, "retryable_failed", "ai_request_retry_exhausted"),
        (None, False, 1, "uncertain", "ai_request_outcome_unknown"),
    ],
)
async def test_d3_ai_ledger_retries_only_definite_temporary_http_failures(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int | None,
    request_not_submitted: bool,
    attempts: int,
    ledger_status: str,
    error_code: str,
) -> None:
    repository = AILedgerRepository()
    sleep = AsyncMock()
    monkeypatch.setattr("app.modules.content_plan.service.asyncio.sleep", sleep)

    async def invoke():
        raise _provider_error(
            status_code,
            request_not_submitted=request_not_submitted,
        )

    with pytest.raises(D3ProcessingError) as raised:
        await _d3_service(repository)._run_ai_request(
            batch=SimpleNamespace(id="batch-a"),
            preparation_id=None,
            request_key="ai:test:d3",
            endpoint="content_plan/test",
            prompt_version="test-v1",
            request_input={"value": "test"},
            round_number=0,
            structural_attempt=1,
            validation_error=None,
            invoke=invoke,
            encode_output=lambda output: list(output),
        )

    assert raised.value.code == error_code
    assert repository.attempt_count == attempts
    assert [row["status"] for row in repository.failures] == [ledger_status] * attempts
    assert sleep.await_count == max(0, attempts - 1)


async def test_d3_ai_ledger_recovers_after_temporary_connection_setup_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = AILedgerRepository()
    sleep = AsyncMock()
    monkeypatch.setattr("app.modules.content_plan.service.asyncio.sleep", sleep)

    async def invoke() -> AICallResult:
        if repository.attempt_count < 3:
            raise _provider_error(None, request_not_submitted=True)
        return AICallResult(
            output=[{"keyword": "solar battery"}],
            provider="openai",
            model="test-model",
            request_id="response-1",
            input_tokens=10,
            output_tokens=5,
            cost_usd=0,
        )

    output = await _d3_service(repository)._run_ai_request(
        batch=SimpleNamespace(id="batch-a"),
        preparation_id="preparation-a",
        request_key="ai:test:d3:recovery",
        endpoint="content_plan/test",
        prompt_version="test-v1",
        request_input={"value": "test"},
        round_number=0,
        structural_attempt=1,
        validation_error=None,
        invoke=invoke,
        encode_output=lambda result: list(result),
    )

    assert output == [{"keyword": "solar battery"}]
    assert repository.attempt_count == 3
    assert [row["status"] for row in repository.failures] == [
        "retryable_failed",
        "retryable_failed",
    ]
    assert len(repository.completions) == 1
    assert sleep.await_count == 2


class RaisingPreviewGateway:
    def __init__(self, error: ProviderError) -> None:
        self.error = error
        self.calls = 0

    async def preview(self, *_args, **_kwargs):
        self.calls += 1
        raise self.error


@pytest.mark.parametrize(
    (
        "status_code",
        "request_not_submitted",
        "attempts",
        "ledger_status",
        "error_code",
    ),
    [
        (429, False, 3, "retryable_failed", "preview_request_retry_exhausted"),
        (503, False, 3, "retryable_failed", "preview_request_retry_exhausted"),
        (401, False, 1, "failed", "model_provider_auth_failed"),
        (403, False, 1, "failed", "model_provider_auth_failed"),
        (None, True, 3, "retryable_failed", "preview_request_retry_exhausted"),
        (None, False, 1, "uncertain", "preview_request_outcome_unknown"),
    ],
)
async def test_d4_preview_ledger_retries_only_definite_temporary_http_failures(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int | None,
    request_not_submitted: bool,
    attempts: int,
    ledger_status: str,
    error_code: str,
) -> None:
    repository = AILedgerRepository()
    preview = RaisingPreviewGateway(
        _provider_error(
            status_code,
            request_not_submitted=request_not_submitted,
        )
    )
    sleep = AsyncMock()
    monkeypatch.setattr("app.modules.content_plan.d4_service.asyncio.sleep", sleep)
    service = ContentPlanD4Service(
        repository,
        serp_gateway=SimpleNamespace(),
        preview_gateway=preview,
    )

    with pytest.raises(D4GroupError) as raised:
        await service._run_preview_request(
            SimpleNamespace(id="batch-a", country="US", language="en"),
            SimpleNamespace(
                id="preparation-a",
                preparation_version=1,
                package_version=1,
            ),
            "solar battery",
            ["home solar battery"],
            {"organic": [], "paa": [], "related_searches": []},
            {"primary_keyword": "solar battery"},
            1,
            None,
        )

    assert raised.value.code == error_code
    assert repository.attempt_count == attempts
    assert preview.calls == attempts
    assert [row["status"] for row in repository.failures] == [ledger_status] * attempts
    assert sleep.await_count == max(0, attempts - 1)


async def test_provider_preserves_retryable_error_when_internal_retries_are_disabled() -> None:
    provider = OpenAIProvider(
        ProviderConfig(
            provider="openai",
            base_url="https://api.example/v1",
            api_key="secret",
            model="test-model",
            timeout_seconds=10,
            max_retries=0,
        )
    )
    error = _provider_error(503)

    async def operation():
        raise error

    with pytest.raises(ProviderError) as raised:
        await provider._retry(operation)

    assert raised.value is error
    assert raised.value.retryable is True
