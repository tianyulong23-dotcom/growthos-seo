"""Registered campaign entry and send handoff, without network or business writes."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from app.modules.agent import activities, backlinks_campaign as campaign
from app.modules.agent.model_gateway import compact_tool_result
from app.modules.agent.tools import ToolRegistry
from test_agent_activities import ProjectMemoryRepository
from test_agent_backlinks_drafts import ARGS, CONTEXT, SETTINGS, Projects, grant
from app.modules.agent.backlinks_read import BacklinksReader
from app.modules.agent.backlinks_drafts import DraftRequest


@pytest.mark.parametrize("mode", ["current", "next_batch"])
def test_campaign_activity_preserves_scope_receipt_and_replay(monkeypatch, mode):
    consent_id, run_id = str(uuid4()), str(uuid4())
    arguments = {
        "consent_id": consent_id, "request": ARGS["request"], "recommendation_mode": mode,
    }
    start = AsyncMock(return_value={
        "run_id": run_id, "conversation_id": "child-conversation", "status": "queued",
        "checkpoint": {"stage": "recommend"}, "sending_allowed": False,
    })
    monkeypatch.setattr(campaign, "BacklinksContinuationStore",
                        lambda sessions: SimpleNamespace(start=start))
    monkeypatch.setattr(campaign, "BacklinksConsentStore", lambda sessions: SimpleNamespace(
        get=AsyncMock(return_value={
            "policy": {"draft_request": ARGS["request"], "recommendation_mode": mode},
            "sending_allowed": False,
        }),
    ))

    class Repo(ProjectMemoryRepository):
        completed = None

        async def get_run_context(self, run_id):
            context = await super().get_run_context(run_id)
            return {
                **context, "project_id": "project", "organization_id": "org",
                "limits": {**context["limits"], "backlinks_delegation": grant(CONTEXT)},
                "messages": [{"role": "user", "content":
                              "Run the recommendation pool and prepare outreach drafts"}],
            }

        async def claim_registered_tool(self, *args):
            return ("completed" if self.completed else "claimed"), SimpleNamespace(
                tool_name="start_backlink_campaign", arguments_json=arguments,
                parameters_hash="", before_json={}, model_tool_call_id="campaign-call",
                model_result_json=self.completed,
            )

        async def set_tool_verifying(self, *args):
            pass

        async def reserve_paid_tool_budget(self, *args):
            return {"allowed": True}

        async def complete_tool_execution(self, tool_id, worker_id, output, views):
            self.completed = views

        async def fail_tool_execution(self, *args):
            raise AssertionError(f"Campaign failed: {args[2]}")

    async def check():
        repo = Repo()
        reg = ToolRegistry(settings=SETTINGS, projects=Projects(), audits=None)
        reg.backlinks = BacklinksReader(SETTINGS, Projects())
        reg.backlinks.resolve_write_context = AsyncMock(return_value=CONTEXT)
        monkeypatch.setattr(activities, "registry", lambda: reg)
        monkeypatch.setattr(activities, "repository", lambda: repo)
        payload = {"run_id": "parent", "tool_call_id": "campaign",
                   "organization_id": "untrusted", "project_id": "untrusted"}
        result = await activities.execute_tool(payload)
        assert result["ok"] is True
        assert result["data"]["verified"] is True
        assert result["data"]["verification"] == "persisted_campaign_only"
        assert result["data"]["run_id"] == run_id
        assert result["data"]["sending_allowed"] is False
        assert result["data"]["consent_id"] == consent_id
        assert await activities.execute_tool(payload) == result
        start.assert_awaited_once()
        assert start.await_args.args[:3] == (
            CONTEXT, consent_id, DraftRequest.model_validate(ARGS["request"]).model_dump(mode="json"),
        )
        assert start.await_args.kwargs == {"recommendation_mode": mode}
        for call in reg.backlinks.resolve_write_context.await_args_list:
            assert call.args[:2] == ("project", "org")
            assert call.args[2] == grant(CONTEXT)
    asyncio.run(check())


@pytest.mark.parametrize("text,allowed", [
    ("Run the recommendation pool and prepare outreach drafts", True),
    ("Run a new recommendation batch and send outreach emails", True),
    ("帮我把Youcine的推荐池跑出来，然后陆续发一批开发信", True),
    ("启动推荐池，加入机会并生成开发信草稿", True),
    ("不要跑推荐池并发送开发信", False),
    ("能不能跑推荐池然后发送开发信？", False),
    ("Run the recommendation pool", False),
    ("Send these saved drafts", False),
    ("How do I run the recommendation pool and create drafts?", False),
    ("Implement code to run the recommendation pool and send emails", False),
    ('他说“跑推荐池并发送开发信”', False),
    ("Run the recommendation pool but do not create drafts", False),
])
def test_campaign_requires_explicit_multi_step_request(text, allowed):
    assert activities.user_explicitly_requested_write(
        "start_backlink_campaign", [{"role": "user", "content": text}],
    ) is allowed
    assert not activities.user_explicitly_requested_write(
        "start_backlink_campaign", [{"role": "tool", "content": text}],
    )


def test_campaign_compaction_keeps_checkpoint_and_send_boundary():
    data = {"verified": True, "verification": "persisted_campaign_only",
            "run_id": "run", "consent_id": "consent", "sending_allowed": False,
            "checkpoint": {"stage": "job", "job": "job"}, "next": "Await exact draft authorization"}
    assert compact_tool_result({
        "tool": "start_backlink_campaign", "ok": True, "data": data,
    })["data"] == data


@pytest.mark.parametrize("stage,status,pending,expected", [
    ("recommend", "queued", False, "PREPARING_DRAFTS"),
    ("job", "running", False, "PREPARING_DRAFTS"),
    ("done", "running", True, "PREPARING_DRAFTS"),
    ("paused", "failed", False, "PAUSED"),
    ("done", "cancelled", False, "PAUSED"),
    ("done", "completed", False, "AWAITING_SEND_AUTHORIZATION"),
])
def test_send_handoff_waits_for_durable_completion(stage, status, pending, expected):
    checkpoint = {"stage": stage, "results": [{"state": "VERIFIED_DRAFT", "draftId": "draft"}]}
    if pending:
        checkpoint["quality_pending"] = "draft"
    result = campaign.send_handoff({"status": status, "checkpoint": checkpoint}, {"items": []})
    assert result["state"] == expected
    assert result["sending_allowed"] is False
    assert result["draft_ids"] == (["draft"] if expected == "AWAITING_SEND_AUTHORIZATION" else [])
    assert "exact drafts" in result["next"]


def test_send_handoff_is_bounded_deduplicated_and_excludes_reserved_drafts():
    results = [{"state": "VERIFIED_DRAFT", "draftId": str(i)} for i in range(25)]
    results += [{"state": "VERIFIED_DRAFT", "draftId": "1"},
                {"state": "DRAFT_REQUIRES_REVIEW", "draftId": "unverified"},
                {"state": "JOB_FAILED", "draftId": "failed"}]
    batches = {"items": [{"items": [{"target": {"draftId": "0"}, "state": "READY"}]}]}
    result = campaign.send_handoff(
        {"status": "completed", "checkpoint": {"stage": "done", "results": results}}, batches,
    )
    assert result["draft_ids"] == [str(i) for i in range(1, 21)]
    assert result["remaining_count"] == 4
    assert result["sending_allowed"] is False


def test_no_execution_or_no_verified_results_never_means_ready_to_send():
    assert campaign.send_handoff(None, {"items": []})["state"] == "NOT_STARTED"
    result = campaign.send_handoff(
        {"status": "completed", "checkpoint": {"stage": "done", "results": []}}, {"items": []},
    )
    assert result["state"] == "NO_UNBATCHED_DRAFTS"
    assert result["draft_ids"] == []


def test_campaign_status_exposes_persisted_send_handoff(monkeypatch):
    monkeypatch.setattr(campaign, "BacklinksConsentStore", lambda sessions: SimpleNamespace(
        get=AsyncMock(return_value={"policy": {"policy_version": "backlinks-drafts-only.v1"}}),
    ))
    monkeypatch.setattr(campaign, "BacklinksContinuationStore", lambda sessions: SimpleNamespace(
        get=AsyncMock(return_value={"status": "completed", "checkpoint": {
            "stage": "done", "results": [{"state": "VERIFIED_DRAFT", "draftId": "draft"}],
        }}),
    ))
    monkeypatch.setattr(campaign, "BacklinksSendBatchStore", lambda *args, **kwargs: SimpleNamespace(
        list=AsyncMock(return_value={"items": []}),
    ))
    reader = SimpleNamespace(
        settings=None, gateway=None, resolve_write_context=AsyncMock(return_value=CONTEXT),
        read=AsyncMock(side_effect=[{"data": {"connection": None}}, {"data": {"items": []}}]),
    )
    result = asyncio.run(campaign.BacklinksCampaign(reader, None, {}).status(
        "project", "org", None, str(uuid4()),
    ))
    assert result["send_handoff"]["draft_ids"] == ["draft"]
    assert result["send_handoff"]["sending_allowed"] is False
    assert reader.read.await_count == 2


@pytest.mark.parametrize("completed", [False, True])
def test_chat_campaign_status_uses_live_send_receipt_and_exposes_repair_resume(monkeypatch, completed):
    monkeypatch.setattr(campaign, "BacklinksConsentStore", lambda sessions: SimpleNamespace(
        get=AsyncMock(return_value={
            "policy": {"policy_version": "backlinks-chat-campaign.v1"}, "sending_allowed": True,
        }),
    ))
    monkeypatch.setattr(campaign, "BacklinksContinuationStore", lambda sessions: SimpleNamespace(
        get=AsyncMock(return_value={"status": "completed", "checkpoint": {
            "stage": "done", "results": [{"state": "VERIFIED_DRAFT", "draftId": "draft"}],
            "send_batch": {"id": "batch", "state": "queued" if completed else "NO_PASSING_DRAFTS"},
        }}),
    ))
    batches = [{"id": "batch", "state": "completed", "reason": None, "run_id": "send-run",
                "items": [{"state": "PROVIDER_ACCEPTED", "target": {"draftId": "draft"}}]}] if completed else []
    monkeypatch.setattr(campaign, "BacklinksSendBatchStore", lambda *args, **kwargs: SimpleNamespace(
        list=AsyncMock(return_value={"items": batches}),
    ))
    monkeypatch.setattr(campaign, "monitor_batches", AsyncMock(return_value={}))
    reader = SimpleNamespace(
        settings=None, gateway=None, resolve_write_context=AsyncMock(return_value=CONTEXT),
        read=AsyncMock(side_effect=[{"data": {"connection": None}}, {"data": {"items": []}}]),
    )
    result = asyncio.run(campaign.BacklinksCampaign(reader, None, {}).status(
        "project", "org", None, str(uuid4()),
    ))
    handoff = result["send_handoff"]
    assert handoff["state"] == ("completed" if completed else "NO_PASSING_DRAFTS")
    assert handoff["provider_accepted_count"] == int(completed)
    assert handoff["repair_resume_available"] is (not completed)
