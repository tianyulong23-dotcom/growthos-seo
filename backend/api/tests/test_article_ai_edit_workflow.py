import asyncio
from datetime import timedelta
from typing import Any

import pytest

from app.modules.content import workflows
from app.modules.content.workflows import AI_EDIT_RETRY, ArticleAIEditWorkflow


def test_ai_edit_workflow_uses_bounded_retry_timeout_and_heartbeat(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict[str, str], dict[str, Any]]] = []

    async def execute_activity(name: str, payload: dict[str, str], **kwargs: Any) -> None:
        calls.append((name, payload, kwargs))

    monkeypatch.setattr(workflows.workflow, "execute_activity", execute_activity)
    asyncio.run(ArticleAIEditWorkflow().run({"operation_id": "operation-p6"}))

    assert calls == [
        (
            "article_ai_edit_execute",
            {"operation_id": "operation-p6"},
            {
                "start_to_close_timeout": timedelta(minutes=5),
                "heartbeat_timeout": timedelta(seconds=30),
                "retry_policy": AI_EDIT_RETRY,
            },
        )
    ]
    assert AI_EDIT_RETRY.maximum_attempts == 3
    assert AI_EDIT_RETRY.initial_interval == timedelta(seconds=1)
    assert AI_EDIT_RETRY.maximum_interval == timedelta(seconds=5)


def test_ai_edit_workflow_rejects_payload_expansion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called = False

    async def execute_activity(*args: Any, **kwargs: Any) -> None:
        nonlocal called
        del args, kwargs
        called = True

    monkeypatch.setattr(workflows.workflow, "execute_activity", execute_activity)
    with pytest.raises(ValueError, match="only accepts operation_id"):
        asyncio.run(
            ArticleAIEditWorkflow().run(
                {"operation_id": "operation-p6", "api_key": "must-not-cross-workflow"}
            )
        )
    assert called is False
