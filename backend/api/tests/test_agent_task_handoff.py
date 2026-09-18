import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from app.modules.agent.activities import user_explicitly_requested_write
from app.modules.agent.model_gateway import compact_tool_result
from app.modules.agent.task_handoff import pending_references, task_references
from app.modules.agent import task_tools
from app.modules.agent.workflows import AgentWorkflow
from test_agent_workflow import LIMITS


def test_task_delegation_cannot_invent_content_write_permission():
    from dataclasses import replace
    from test_agent_backlinks_drafts import CONTEXT, NOW, SETTINGS, Projects
    from app.modules.agent.delegation import issue_delegation, resolve_delegation
    context = replace(CONTEXT, permissions=("projects:read", "content:read"))
    grant = issue_delegation(SETTINGS, context, now=NOW)
    resolved = asyncio.run(resolve_delegation(
        SETTINGS, Projects(), grant, "project", "org",
        required_permission="projects:read", now=NOW,
    ))
    assert resolved.permissions == ("projects:read",)
    with pytest.raises(ValueError, match="PERMISSION_DENIED"):
        asyncio.run(resolve_delegation(
            SETTINGS, Projects(), grant, "project", "org",
            required_permission="content:write", now=NOW,
        ))
    grant["claims"]["permissions"].append("content:write")
    with pytest.raises(ValueError, match="DELEGATION_INVALID"):
        asyncio.run(resolve_delegation(
            SETTINGS, Projects(), grant, "project", "org",
            required_permission="content:write", now=NOW,
        ))


def test_partial_draft_batch_preserves_verified_jobs_and_uppercase_waits():
    refs = task_references("create_backlink_drafts", {
        "verified": False, "results": [
            {"verified": True, "jobId": "job", "draftId": "draft", "status": "RETRY_SCHEDULED"},
            {"state": "UNVERIFIED", "jobId": "unknown"},
        ],
    })
    assert [ref["task_id"] for ref in refs] == ["job"]
    assert pending_references([{"ok": True, "data": {"background_tasks": refs}}]) == refs


def test_exact_article_cancel_rejects_replacement_run_before_mutating():
    from app.modules.content.repository import ContentRepository
    session = AsyncMock()
    session.scalar.return_value = SimpleNamespace(current_run_id="replacement", status="running")
    session.__aenter__.return_value = session
    repository = ContentRepository(lambda: session)
    with pytest.raises(ValueError, match="TASK_RUN_CHANGED"):
        asyncio.run(repository.cancel_article("org", "project", "article", expected_run_id="old"))
    session.commit.assert_not_awaited()
    assert session.scalar.await_count == 1


def test_only_verified_acceptance_has_background_reference():
    assert task_references("create_article", {"run_id": "r", "verified": False}) == []
    assert task_references("send_backlink_drafts", {"verified": True, "batch": None}) == []
    assert task_references("start_backlink_recommendations", {"verified": True, "state": "POOL_EXHAUSTED"}) == []
    refs = task_references("create_article", {
        "verified": True, "run_id": "r", "article_id": "a", "status": "queued",
    })
    output = {"tool": "create_article", "ok": True, "data": {"background_tasks": refs}}
    assert compact_tool_result(output)["data"]["background_tasks"] == refs
    assert pending_references([output]) == refs
    refs[0]["status"] = "failed"
    assert pending_references([output]) == []


@pytest.mark.parametrize("second_is_final", [True, False])
def test_background_receipt_releases_conversation_without_polling(second_is_final):
    worker = AgentWorkflow()
    calls = []
    decisions = iter([
        {"type": "tool_call", "tool": "create_article", "arguments": {}},
        ({"type": "final", "answer": "已提交，尚未完成", "message_id": "final", "evidence": []}
         if second_is_final else {"type": "tool_call", "tool": "get_article_generation_status", "arguments": {}}),
    ])
    refs = task_references("create_article", {"verified": True, "run_id": "r", "article_id": "a", "status": "queued"})

    async def call(name, payload, limits, **kwargs):
        calls.append((name, payload))
        if name == "agent_check_run":
            return {"allowed": True}
        if name == "agent_model_decide":
            if payload["round"] == 2:
                assert payload["final_only"] is True
            return next(decisions)
        if name == "agent_execute_tool":
            return {"tool": kwargs["tool"], "ok": True, "data": {"background_tasks": refs},
                    "summary": "accepted", "retryable": False, "cost": 0}
        return None

    worker._call = call
    asyncio.run(worker.run({"run_id": "command", "limits": {**LIMITS, "background_task_handoff": True}}))
    assert sum(name == "agent_execute_tool" for name, _ in calls) == 1
    assert sum(name == "agent_model_decide" for name, _ in calls) == 1
    assert calls[-1][0] == "agent_finish"
    assert calls[-1][1]["status"] == "completed"
    assert calls[-1][1]["background_tasks"] == refs


@pytest.mark.parametrize(("text", "allowed"), [
    ("停止文章任务 r1", True), ("Cancel task r1", True),
    ("不要取消任务", False), ("如何取消任务？", False), ("任务状态", False),
])
def test_cancel_requires_user_intent(text, allowed):
    assert user_explicitly_requested_write("cancel_project_task", [{"role": "user", "content": text}]) is allowed


def test_task_arguments_cannot_supply_authority():
    with pytest.raises(ValidationError):
        task_tools.TaskArgs.model_validate({"kind": "article", "task_id": "r", "organization_id": "other"})


def test_cancel_article_pins_exact_run_and_rereads(monkeypatch):
    registry = SimpleNamespace(content=SimpleNamespace(cancel_article=AsyncMock()),
                               _require_service=lambda *_: None)
    monkeypatch.setattr(task_tools, "task_context", AsyncMock())
    reader = AsyncMock(side_effect=[
        {"items": [{"status": "running", "related_id": "article"}]},
        {"items": [{"status": "cancelled", "related_id": "article"}]},
    ])
    monkeypatch.setattr(task_tools, "read_tasks", reader)
    result = asyncio.run(task_tools.cancel_task(
        registry, "project", "org", {}, {"kind": "article", "task_id": "exact-run"}, "command",
    ))
    registry.content.cancel_article.assert_awaited_once_with(
        "project", "article", organization_id="org", expected_run_id="exact-run",
    )
    assert result["task"]["status"] == "cancelled"


def test_cancel_unsupported_kind_cannot_change_status():
    with pytest.raises(ValueError, match="UNSUPPORTED"):
        asyncio.run(task_tools.cancel_task(
            None, "project", "org", {}, {"kind": "keywords", "task_id": "r"}, "command",
        ))
