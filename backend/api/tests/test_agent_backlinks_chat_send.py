"""Real isolated storage and fake Core only; never opens a provider connection."""
import asyncio
import json
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy import select

from app.modules.agent.activities import user_explicitly_requested_write
from app.modules.agent import activities
from app.modules.agent.backlinks_chat_send import BacklinksChatSend, ChatSendArgs
from app.modules.agent.backlinks_consent import BacklinksConsentStore, ConsentError
from app.modules.agent.backlinks_continuation_store import BacklinksContinuationStore
from app.modules.agent.backlinks_read import BacklinksReader, BacklinksReadError
from app.modules.agent.backlinks_send_batch import SendBatchPreviewRequest
from app.modules.agent.models import AgentBacklinksConsent, AgentMessage, AgentRun
from app.modules.agent.tools import ToolRegistry
from test_agent_backlinks_drafts import CONTEXT, META, SETTINGS, Projects, grant
from test_agent_backlinks_send import ACCOUNT
from test_agent_backlinks_send_batch import Core, harness, identifier
from test_agent_activities import ProjectMemoryRepository

ARGS = {
    "gmail_connection_id": ACCOUNT,
    "items": [{
        "draft_id": identifier(i), "version_id": identifier("version:" + identifier(i)),
        "expected_version": 2, "contact_id": identifier(i), "contact_version": 1,
    } for i in range(2)],
}


@pytest.fixture(autouse=True)
def fake_approval_core(monkeypatch):
    from app.modules.agent import backlinks_quality
    monkeypatch.setattr(backlinks_quality.BacklinksQuality, "project_evidence", AsyncMock(
        return_value={"domain": "project.test", "profile": {"description": "Test project"}},
    ))
    async def review(evidence, organization_id):
        return backlinks_quality.QualityOutput(items=[
            backlinks_quality.QualityVerdict(
                draft_id=item["draft_id"], reasons=["Evidence matches"],
                checks=backlinks_quality.QualityChecks(**{
                    key: True for key in backlinks_quality.QualityChecks.model_fields
                }),
            ) for item in evidence
        ]), {"model": "fake"}
    monkeypatch.setattr(backlinks_quality, "model_review", review)
    original = Core.respond

    async def no_network(*args, **kwargs):
        raise AssertionError("Real network forbidden")
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", no_network)

    def respond(self, request):
        if not hasattr(self, "approvals"):
            self.approvals = set()
        path = request.url.path.split("/backlinks/")[1]
        draft_id = path.split("/")[1] if "/" in path else None
        if path.endswith("/approve"):
            self.calls.append(request)
            assert json.loads(request.content) == {"expectedVersion": 2}
            self.approvals.add(draft_id)
            if getattr(self, "lost_approval", False):
                self.lost_approval = False
                raise httpx.ReadTimeout("Approval response lost")
            return httpx.Response(200, json={
                "versionId": identifier("version:" + draft_id), "meta": META,
            })
        self.approved = draft_id in self.approvals
        response = original(self, request)
        data = json.loads(response.content)
        if "draft" in data:
            data["draft"]["draftVersion"] = 3 if self.approved else 2
            data["draft"].update(getattr(self, "draft_override", {}))
            return httpx.Response(200, json=data)
        if path == "send-batch-preflight" and getattr(self, "blocked_preflight", False):
            data["items"][0]["allowed"] = False
            return httpx.Response(200, json=data)
        return response
    monkeypatch.setattr(Core, "respond", respond)


async def service_for(store, text="把这批草稿发出去，不要同时发送多个，一个个处理"):
    async with store.sessions() as session, session.begin():
        run = await session.scalar(select(AgentRun))
        message = await session.get(AgentMessage, run.user_message_id)
        message.content, message.metadata_json = text, {}
        run_id = run.id
    reader = BacklinksReader(SETTINGS, Projects(), store.gateway)
    return BacklinksChatSend(reader, store.sessions, {}), run_id


async def submit(service, run_id, args=None):
    return await service.submit("project", "org", grant(), run_id, args or ARGS)


@pytest.mark.parametrize("case", ["partial", "blocked", "failure", "changed_after_review"])
def test_only_quality_passed_exact_versions_are_approved_and_queued(monkeypatch, case):
    from app.modules.agent import backlinks_quality
    async def check(store, consent, core, request):
        async def review(evidence, organization_id):
            if case == "failure":
                raise RuntimeError("Model unavailable")
            if case == "changed_after_review":
                core.draft_override = {"currentVersion": {
                    "id": identifier("changed"), "subjectText": "Changed", "bodyText": "Changed",
                }}
            return backlinks_quality.QualityOutput.model_validate({"items": [{
                "draft_id": item["draft_id"], "reasons": ["Checked"],
                "checks": {key: case != "blocked" and not (
                    case == "partial" and item["draft_id"] == ARGS["items"][1]["draft_id"]
                    and key == "project_accuracy"
                ) for key in backlinks_quality.QualityChecks.model_fields},
            } for item in evidence]}), {"model": "fake"}
        monkeypatch.setattr(backlinks_quality, "model_review", review)
        service, run_id = await service_for(store)
        if case == "changed_after_review":
            with pytest.raises(ConsentError):
                await submit(service, run_id)
            assert not core.approvals
        else:
            result = await submit(service, run_id)
            if case == "partial":
                assert len(result["batch"]["items"]) == 1
                assert core.approvals == {ARGS["items"][0]["draft_id"]}
            else:
                assert result["batch"] is None and not core.approvals
        assert not core.sent
    asyncio.run(harness(check))


@pytest.mark.parametrize("text,allowed", [
    ("把这批草稿发出去", True),
    ("请给42matters、Barnard Media和365 Digital发送开发信", True),
    ("发送这一批邮件，不要同时发送多个，一个个处理", True),
    ("Send these saved outreach drafts", True),
    ("看看这批草稿", False),
    ("生成一批开发信，先别发送", False),
    ("不要发送这批草稿", False),
    ("可以发送这些邮件吗？", False),
    ("如果我说发送邮件，会怎么样", False),
    ("他说把这批草稿发出去", False),
    ("帮我修改代码，让agent发送邮件", False),
    ('请分析"发送开发信"这句话', False),
    ("测试发送邮件", False),
])
def test_explicit_current_user_command(text, allowed):
    assert user_explicitly_requested_write(
        "send_backlink_drafts",
        [{"role": "assistant", "content": "发送邮件"}, {"role": "user", "content": text}],
    ) is allowed


def test_chat_approves_and_queues_once_then_uses_existing_serial_ticks():
    async def check(store, consent, core, request):
        service, run_id = await service_for(store)
        result = await submit(service, run_id)
        assert result["verified"] and result["batch"]["state"] == "queued"
        assert not core.sent and len(core.approvals) == 2
        assert all(i["preview"]["recipient"] for i in result["batch"]["items"])
        count = len(core.calls)
        replay = await submit(service, run_id)
        assert replay["batch"]["id"] == result["batch"]["id"] and len(core.calls) == count
        async with store.sessions() as session:
            authority = await session.get(AgentBacklinksConsent, result["consent_id"])
            assert authority.policy_json["source_run_id"] == run_id
        assert not (await store.tick(result["batch"]["run_id"]))["done"]
        assert len(core.sent) == 1
        await store.tick(result["batch"]["run_id"])
        assert len(core.sent) == 1
        core.status = "PROVIDER_ACCEPTED"
        await store.tick(result["batch"]["run_id"])
        assert len(core.sent) == 2
        await store.tick(result["batch"]["run_id"])
        saved = (await store.list(CONTEXT, result["consent_id"]))["items"][0]
        assert saved["state"] == "completed"
    asyncio.run(harness(check))


@pytest.mark.parametrize("change", ["version", "freshness", "contact", "duplicate", "gmail"])
def test_failed_evidence_never_dispatches(change):
    async def check(store, consent, core, request):
        service, run_id = await service_for(store)
        args = deepcopy(ARGS)
        if change == "version":
            args["items"][1]["version_id"] = identifier("wrong")
        elif change == "freshness":
            core.draft_override = {"freshness": {"state": "STALE", "regenerateRequired": True}}
        elif change == "contact":
            args["items"][0]["contact_version"] = 9
        elif change == "duplicate":
            core.duplicate = True
        else:
            core.blocked_preflight = True
        if change == "freshness":
            result = await submit(service, run_id, args)
            assert result["batch"] is None
            assert all(item["state"] == "BLOCKED" for item in result["quality_review"]["items"])
        else:
            with pytest.raises(ConsentError):
                await submit(service, run_id, args)
        assert not core.sent
        async with store.sessions() as session:
            assert len((await session.scalars(select(AgentRun))).all()) == 1
        if change in {"version", "freshness"}:
            assert not core.approvals
    asyncio.run(harness(check))


@pytest.mark.parametrize("change", ["message", "role", "cancel", "permission", "user", "no_run"])
def test_authority_cannot_come_from_model_or_old_message(change):
    async def check(store, consent, core, request):
        service, run_id = await service_for(store)
        if change in {"message", "role", "cancel"}:
            async with store.sessions() as session, session.begin():
                run = await session.get(AgentRun, run_id)
                message = await session.get(AgentMessage, run.user_message_id)
                if change == "message":
                    message.content = "只检查，不要发送"
                elif change == "role":
                    message.role = "assistant"
                else:
                    run.status = "cancelled"
        elif change in {"permission", "user"}:
            context = replace(CONTEXT, permissions=()) if change == "permission" else replace(
                CONTEXT, actor=replace(CONTEXT.actor, user_id="other"),
            )
            if change == "permission":
                service.reader.resolve_write_context = AsyncMock(side_effect=ValueError("denied"))
            else:
                service.reader.resolve_write_context = AsyncMock(return_value=context)
        else:
            run_id = None
        with pytest.raises(ValueError):
            await submit(service, run_id)
        assert not core.calls
    asyncio.run(harness(check))


def test_lost_approval_response_reuses_exact_request_without_reapproving():
    async def check(store, consent, core, request):
        service, run_id = await service_for(store)
        core.lost_approval = True
        with pytest.raises(BacklinksReadError, match="HTTP 503"):
            await submit(service, run_id)
        result = await submit(service, run_id)
        assert result["batch"]["state"] == "queued" and not core.sent
        assert len([r for r in core.calls if r.url.path.endswith("/approve")]) == 2
        altered = deepcopy(ARGS)
        altered["items"].reverse()
        with pytest.raises(ConsentError, match="REQUEST_CHANGED"):
            await submit(service, run_id, altered)
    asyncio.run(harness(check))


def test_activity_routes_chat_send_and_campaign_read_with_server_scope(monkeypatch):
    async def check(store, consent, core, request):
        service, run_id = await service_for(store)
        monkeypatch.setattr("app.db.session.session_factory", store.sessions)
        monkeypatch.setattr("app.modules.agent.service.build_agent_service",
                            lambda: SimpleNamespace(limits={}))
        registry = ToolRegistry(SETTINGS, None, None, backlinks=service.reader)

        class Repo(ProjectMemoryRepository):
            completed = None
            tool_name = "send_backlink_drafts"
            tool_args = ARGS

            async def get_run_context(self, identifier):
                context = await super().get_run_context(identifier)
                return {**context, "project_id": "project", "organization_id": "org",
                        "limits": {**context["limits"], "backlinks_delegation": grant()},
                        "messages": [{"role": "user", "content": "把这批草稿发出去"}]}

            async def claim_registered_tool(self, *args):
                return ("completed" if self.completed else "claimed"), SimpleNamespace(
                    tool_name=self.tool_name, arguments_json=self.tool_args, parameters_hash="",
                    before_json={}, model_tool_call_id="provider-call", model_result_json=self.completed,
                )

            async def reserve_paid_tool_budget(self, *args):
                return {"allowed": True}

            async def set_tool_verifying(self, *args):
                pass

            async def complete_tool_execution(self, tool_id, worker_id, output, views):
                self.completed = views
                await super().complete_tool_execution(tool_id, worker_id, output, views)

            async def fail_tool_execution(self, *args):
                raise AssertionError(f"Unexpected failure: {args[2]}")

        repo = Repo()
        monkeypatch.setattr(activities, "repository", lambda: repo)
        monkeypatch.setattr(activities, "registry", lambda: registry)
        payload = {"run_id": run_id, "tool_call_id": "chat-send",
                   "project_id": "untrusted", "organization_id": "untrusted"}
        result = await activities.execute_tool(payload)
        assert result["ok"] and result["data"]["batch"]["state"] == "queued"
        assert await activities.execute_tool(payload) == result
        assert not core.sent
        repo.completed = None
        repo.tool_name = "get_backlink_campaign"
        repo.tool_args = {"consent_id": result["data"]["consent_id"]}
        service.reader.read = AsyncMock(side_effect=[
            {"data": {"connection": None}}, {"data": {"items": []}},
        ])
        status = await activities.execute_tool({**payload, "tool_call_id": "chat-status"})
        assert status["ok"] and status["data"]["execution"] is None
        assert status["data"]["send_batches"]["items"][0]["state"] == "queued"
    asyncio.run(harness(check))


def test_chat_consent_cannot_start_generation_or_another_send_batch():
    async def check(store, consent, core, request):
        service, run_id = await service_for(store)
        result = await submit(service, run_id)
        with pytest.raises(ConsentError, match="POLICY_MISMATCH"):
            await BacklinksContinuationStore(store.sessions).start(
                CONTEXT, result["consent_id"], {}, {},
            )
        with pytest.raises(ConsentError, match="REQUEST_CHANGED"):
            await store.preview(CONTEXT, result["consent_id"], request)
        await BacklinksConsentStore(store.sessions).revoke(CONTEXT, result["consent_id"])
        await store.tick(result["batch"]["run_id"])
        assert not core.sent
    asyncio.run(harness(check))


@pytest.mark.parametrize("field", ["run_id", "confirmed", "humanConfirmation", "consent_id"])
def test_tool_schema_rejects_model_authority(field):
    with pytest.raises(ValidationError):
        ChatSendArgs.model_validate({**ARGS, field: True})


def test_registry_checks_trusted_run_on_prepare_and_execution(monkeypatch):
    async def check(store, consent, core, request):
        service, run_id = await service_for(store)
        monkeypatch.setattr("app.db.session.session_factory", store.sessions)
        monkeypatch.setattr("app.modules.agent.service.build_agent_service", lambda: type("Service", (), {"limits": {}})())
        registry = ToolRegistry(SETTINGS, None, None, backlinks=service.reader)
        kwargs = {"organization_id": "org", "delegation": grant(), "run_id": run_id}
        prepared = await registry.prepare_write("project", "send_backlink_drafts", ARGS, "op", **kwargs)
        assert not core.calls
        with pytest.raises(ValueError, match="PARAMETERS_CHANGED"):
            await registry.execute_write(
                "project", "send_backlink_drafts", prepared.arguments,
                prepared.before, prepared.parameters_hash, **{**kwargs, "run_id": "wrong"},
            )
        result = await registry.execute_write(
            "project", "send_backlink_drafts", prepared.arguments,
            prepared.before, prepared.parameters_hash, **kwargs,
        )
        assert result["batch"]["state"] == "queued" and not core.sent
    asyncio.run(harness(check))
