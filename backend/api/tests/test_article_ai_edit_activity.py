import asyncio
from types import SimpleNamespace

import pytest

from app.modules.agent.providers import ProviderError
from app.modules.content import activities
from app.modules.content.ai_edit_provider import AIEditProviderChunk, normalize_provider_error


def operation(*, status: str = "queued") -> SimpleNamespace:
    return SimpleNamespace(
        id="operation-p6",
        organization_id="org-p6",
        command="rewrite",
        input_payload_json={"selected_text": "Original"},
        model_config_json={
            "provider": "deterministic_fake",
            "model": "article-ai-edit-fixture-v1",
        },
        stream_revision=1,
        status=status,
    )


class Repository:
    def __init__(self, row: SimpleNamespace) -> None:
        self.row = row
        self.start_calls: list[dict] = []
        self.fail_calls: list[dict] = []
        self.complete_calls: list[dict] = []
        self.append_result = True

    async def get_for_worker(self, operation_id: str) -> SimpleNamespace:
        assert operation_id == self.row.id
        return self.row

    async def worker_start(self, operation_id: str, **kwargs):
        assert operation_id == self.row.id
        self.start_calls.append(kwargs)
        self.row.status = "streaming"
        return self.row

    async def append_chunk(self, operation_id: str, chunk: str) -> bool:
        assert operation_id == self.row.id
        assert chunk
        return self.append_result

    async def worker_complete(self, operation_id: str, **kwargs) -> bool:
        assert operation_id == self.row.id
        self.complete_calls.append(kwargs)
        self.row.status = "ready"
        return True

    async def worker_fail(self, operation_id: str, **kwargs) -> bool:
        assert operation_id == self.row.id
        self.fail_calls.append(kwargs)
        self.row.status = "failed"
        return True


class FailingProvider:
    name = "deterministic_fake"
    model = "article-ai-edit-fixture-v1"
    error: Exception

    def __init__(self, **kwargs) -> None:
        del kwargs

    async def stream(self, system: str, user: str):
        del system, user
        raise self.error
        yield AIEditProviderChunk()


def configure_activity(
    monkeypatch: pytest.MonkeyPatch,
    repository: Repository,
    *,
    attempt: int,
) -> None:
    monkeypatch.setattr(activities, "ai_edit_repository", lambda: repository)
    monkeypatch.setattr(
        activities,
        "get_settings",
        lambda: SimpleNamespace(article_ai_edit_provider_mode="deterministic_fake"),
    )
    monkeypatch.setattr(activities.activity, "info", lambda: SimpleNamespace(attempt=attempt))
    monkeypatch.setattr(activities.activity, "heartbeat", lambda details: details)


@pytest.mark.parametrize(
    ("provider_code", "expected_code", "expected_detail"),
    [
        (
            "model_provider_timeout",
            "ai_edit_provider_timeout",
            "AI provider timed out",
        ),
        (
            "model_provider_unavailable",
            "ai_edit_provider_unavailable",
            "AI provider is unavailable",
        ),
        (
            "model_provider_rate_limited",
            "ai_edit_provider_rate_limited",
            "AI provider rate limit reached",
        ),
    ],
)
def test_provider_errors_are_normalized_without_secret_detail(
    provider_code: str, expected_code: str, expected_detail: str
) -> None:
    error = ProviderError(
        "provider rejected api_key=super-secret",
        code=provider_code,
        retryable=True,
    )
    code, detail, retryable = normalize_provider_error(error)
    assert (code, detail, retryable) == (expected_code, expected_detail, True)
    assert "super-secret" not in detail
    assert "api_key" not in detail


def test_retryable_provider_error_is_retried_before_final_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = operation()
    repository = Repository(row)
    configure_activity(monkeypatch, repository, attempt=1)
    FailingProvider.error = ProviderError(
        "Bearer secret-provider-token",
        code="model_provider_timeout",
        retryable=True,
    )
    monkeypatch.setattr(activities, "DeterministicAIEditProvider", FailingProvider)

    with pytest.raises(ProviderError):
        asyncio.run(activities.article_ai_edit_execute({"operation_id": row.id}))

    assert repository.start_calls == [
        {
            "provider": "deterministic_fake",
            "model": "article-ai-edit-fixture-v1",
            "retry": False,
        }
    ]
    assert repository.fail_calls == []


def test_final_provider_attempt_persists_sanitized_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = operation(status="streaming")
    repository = Repository(row)
    configure_activity(monkeypatch, repository, attempt=3)
    FailingProvider.error = ProviderError(
        "Bearer secret-provider-token",
        code="model_provider_rate_limited",
        retryable=True,
    )
    monkeypatch.setattr(activities, "DeterministicAIEditProvider", FailingProvider)

    result = asyncio.run(activities.article_ai_edit_execute({"operation_id": row.id}))

    assert result == {"status": "failed"}
    assert repository.start_calls[0]["retry"] is True
    assert len(repository.fail_calls) == 1
    assert repository.fail_calls[0]["code"] == "ai_edit_provider_rate_limited"
    assert repository.fail_calls[0]["detail"] == "AI provider rate limit reached"
    assert "secret-provider-token" not in repr(repository.fail_calls)


def test_retry_attempt_restarts_stream_and_completes_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = operation(status="streaming")
    repository = Repository(row)
    configure_activity(monkeypatch, repository, attempt=2)

    result = asyncio.run(activities.article_ai_edit_execute({"operation_id": row.id}))

    assert result == {"status": "ready"}
    assert repository.start_calls[0]["retry"] is True
    assert len(repository.complete_calls) == 1
    assert repository.complete_calls[0]["candidate_text"] == "Original（AI 候选）"


def test_cancelled_operation_wins_over_late_stream_chunk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = operation()
    repository = Repository(row)
    repository.append_result = False
    configure_activity(monkeypatch, repository, attempt=1)

    async def get_cancelled(operation_id: str) -> SimpleNamespace:
        assert operation_id == row.id
        row.status = "cancelled"
        return row

    repository.get_for_worker = get_cancelled  # type: ignore[method-assign]
    result = asyncio.run(activities.article_ai_edit_execute({"operation_id": row.id}))

    assert result == {"status": "cancelled"}
    assert repository.complete_calls == []
    assert repository.fail_calls == []


def test_activity_rejects_payload_expansion_before_repository_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    accessed = False

    def repository():
        nonlocal accessed
        accessed = True
        return Repository(operation())

    monkeypatch.setattr(activities, "ai_edit_repository", repository)
    with pytest.raises(ValueError, match="only accepts operation_id"):
        asyncio.run(
            activities.article_ai_edit_execute(
                {"operation_id": "operation-p6", "api_key": "must-not-cross-workflow"}
            )
        )
    assert accessed is False
