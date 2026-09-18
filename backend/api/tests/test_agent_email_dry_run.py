"""Synthetic HTTP evidence only: no model, database or Gmail calls."""

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest
from pydantic import ValidationError

from app.core.backlinks_gateway import BacklinksGateway
from app.modules.agent.activities import user_explicitly_requested_write
from app.modules.agent import activities
from app.modules.agent.backlinks_preflight import PreflightArgs
from app.modules.agent.backlinks_read import BacklinksReader, BacklinksReadError
from app.modules.agent.tools import TOOL_DEFINITIONS, ToolRegistry
from test_agent_backlinks_drafts import (
    ARGS, CONTACT, CONTEXT, DRAFT, JOB, META, OPP, SETTINGS, Projects, grant,
)
from test_agent_backlinks_read import send_intent, mail_message
from test_agent_activities import ProjectMemoryRepository

VERSION = "99999999-9999-4999-8999-999999999999"
ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
INTENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
PREFLIGHT = {
    "draftId": DRAFT, "approvedDraftVersionId": VERSION, "contactId": CONTACT,
    "contactVersion": 1, "gmailConnectionId": ACCOUNT,
    "messagePurpose": "INITIAL_OUTREACH", "followUpIndex": 0,
}
TOOL = "preflight_backlink_email"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    async def blocked(*args, **kwargs):
        raise AssertionError("Dry run must never open a network connection")
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked)


class Scenario:
    def __init__(self):
        self.calls = []
        self.generated = False
        self.approved = False
        self.intent = None
        self.preflight_error = None
        self.corrupt_scope = False
        self.draft_override = {}
        self.preflight_override = {}
        self.saved_reply = False

    def response(self, payload, status=200):
        meta = {**META, **({"organizationId": "other"} if self.corrupt_scope else {})}
        return httpx.Response(status, json={"meta": meta, **payload})

    def respond(self, request):
        path = request.url.path.split("/backlinks/")[1]
        self.calls.append((request.method, path, request.headers.get("idempotency-key")))
        if request.method == "POST" and path == f"opportunities/{OPP}/draft-jobs":
            replayed = self.generated
            self.generated = True
            return self.response({
                "jobId": JOB, "draftId": DRAFT, "contactId": CONTACT, "contactVersion": 1,
                "generationMode": "MODEL", "replayed": replayed,
            }, 202)
        if path == f"opportunities/{OPP}":
            return self.response({"item": {
                "id": OPP, "draftId": DRAFT if self.generated else None,
                "primaryNextAction": {"kind": "CREATE_EMAIL_DRAFT", "enabled": True},
            }})
        if path == f"draft-jobs/{JOB}":
            return self.response({"job": {"id": JOB, "draftId": DRAFT, "status": "SUCCEEDED"}})
        if path == f"drafts/{DRAFT}":
            return self.response({"draft": {
                "id": DRAFT, "opportunityId": OPP, "status": "approved" if self.approved else "draft",
                "draftVersion": 1, "approvedVersionId": VERSION if self.approved else None,
                "contactId": CONTACT, "contactVersion": 1,
                "inputSnapshot": {"contactId": CONTACT, "contactVersion": 1},
                "freshness": {"state": "FRESH", "regenerateRequired": False},
                "currentVersion": {
                    "id": VERSION, "subjectText": "Synthetic partnership", "bodyText": "Test only.",
                    "source": "MODEL", "readiness": "AI_DRAFT_READY",
                }, **self.draft_override,
            }})
        if path == f"drafts/{DRAFT}/send-preflight":
            assert request.method == "POST"
            assert json.loads(request.content) == {k: v for k, v in PREFLIGHT.items() if k != "draftId"}
            if self.preflight_error:
                return httpx.Response(self.preflight_error, json={"error": {"code": "BLOCKED"}})
            return self.response({
                "allowed": True, "deliveryState": "NOT_SENT", "checkedAt": META["generatedAt"],
                "readinessSnapshot": {"snapshotVersion": "a" * 64},
                "gmail": {"connectionId": ACCOUNT}, **self.preflight_override,
            })
        if path == "send-intents":
            return self.response({
                "items": [] if self.intent is None else [self.intent],
                "nextCursor": None, "hasMore": False,
            })
        if path == f"send-intents/{INTENT}" and self.intent is not None:
            return self.response({"sendIntent": self.intent})
        if path == "mail/messages":
            return self.response({
                "items": [mail_message()] if self.saved_reply else [],
                "nextCursor": None, "hasMore": False,
            })
        if path == f"mail/messages/{OPP}" and self.saved_reply:
            return self.response({"item": mail_message()})
        if path == f"mail/threads/{OPP}" and self.saved_reply:
            return self.response({"item": {
                "id": OPP, "latestMessageAt": META["generatedAt"],
                "messageCount": 1, "version": 1, "messages": [mail_message()],
            }})
        raise AssertionError(f"Unexpected or sending request: {request.method} {path}")

    def simulate_external_page_submission(self, status="READY"):
        # This is a fixture event, not an Agent tool or a real send command.
        assert self.approved
        assert any(path.endswith("/send-preflight") for _, path, _ in self.calls)
        self.intent = {
            **send_intent(),
            "sendIntentId": INTENT, "draftId": DRAFT, "opportunityId": OPP,
            "approvedDraftVersionId": VERSION, "status": status,
            "messagePurpose": "INITIAL_OUTREACH", "followUpIndex": 0,
        }


async def with_registry(scenario, run):
    async with httpx.AsyncClient(transport=httpx.MockTransport(scenario.respond)) as client:
        gateway = BacklinksGateway(base_url="http://synthetic-core", signing_key="k" * 32, client=client)
        registry = ToolRegistry(
            SETTINGS, None, None, backlinks=BacklinksReader(SETTINGS, Projects(), gateway),
        )
        return await run(registry, {"organization_id": "org", "delegation": grant()})


async def check(registry, authority, args=None):
    prepared = await registry.prepare_write("project", TOOL, args or PREFLIGHT, "preflight-1", **authority)
    return await registry.execute_write(
        "project", TOOL, prepared.arguments, prepared.before, prepared.parameters_hash, **authority,
    )


def test_synthetic_generation_verification_preflight_and_send_tracking():
    scenario = Scenario()

    async def run(registry, authority):
        prepared = await registry.prepare_write(
            "project", "create_backlink_draft", ARGS, "stable-draft-1", **authority,
        )
        created = await registry.execute_write(
            "project", "create_backlink_draft", prepared.arguments, prepared.before,
            prepared.parameters_hash, **authority,
        )
        assert created["verification"] == "persisted_job_acceptance_only"
        job = await registry.execute_read("project", "get_backlink_draft_job", {"jobId": JOB}, **authority)
        assert job["data"]["job"]["status"] == "SUCCEEDED"
        draft = await registry.execute_read("project", "get_backlink_draft", {"draftId": DRAFT}, **authority)
        assert all(draft["checks"].values())
        with pytest.raises(BacklinksReadError, match="REQUIRES_CURRENT_APPROVED_DRAFT"):
            await check(registry, authority)
        scenario.approved = True  # Existing human page approval, simulated.
        result = await check(registry, authority)
        assert result["verified"] is True and result["deliveryState"] == "NOT_SENT"
        scenario.simulate_external_page_submission()
        for status in ("READY", "DISPATCHING", "PROVIDER_ACCEPTED", "DELIVERY_UNKNOWN"):
            scenario.intent["status"] = status
            tracked = await registry.execute_read(
                "project", "get_backlink_send_intent", {"sendIntentId": INTENT}, **authority,
            )
            assert tracked["data"]["sendIntent"]["status"] == status
            assert "does not prove delivery" in tracked["interpretation"]
            assert "not resending" in tracked["interpretation"]
        mail = await registry.execute_read("project", "list_backlink_mail", {}, **authority)
        assert mail["data"]["items"] == []
        assert "does not prove there are no replies" in mail["interpretation"]
        scenario.saved_reply = True
        mail = await registry.execute_read("project", "list_backlink_mail", {}, **authority)
        matched = mail["data"]["items"][0]
        assert matched["matchedOpportunityId"] == OPP
        message = await registry.execute_read(
            "project", "get_backlink_mail_message", {"messageId": matched["id"]}, **authority,
        )
        thread = await registry.execute_read(
            "project", "get_backlink_mail_thread", {"threadId": matched["threadId"]}, **authority,
        )
        assert message["data"]["item"]["body"]["plainText"] == "Interested in your proposal."
        assert thread["data"]["item"]["messages"][0]["id"] == matched["id"]

    asyncio.run(with_registry(scenario, run))
    assert [path for method, path, _ in scenario.calls if method == "POST"] == [
        f"opportunities/{OPP}/draft-jobs", f"drafts/{DRAFT}/send-preflight",
    ]


@pytest.mark.parametrize("status", [403, 409, 429, 503])
def test_preflight_failure_never_becomes_success(status):
    scenario = Scenario()
    scenario.approved = True
    scenario.preflight_error = status
    with pytest.raises(BacklinksReadError, match=f"HTTP {status}") as error:
        asyncio.run(with_registry(scenario, check))
    assert error.value.retryable is (status in {429, 503})


@pytest.mark.parametrize("change", [
    {"approvedVersionId": None}, {"approvedVersionId": OPP},
    {"contactVersion": 2}, {"contactId": OPP},
    {"freshness": {"state": "STALE", "regenerateRequired": True}},
    {"currentVersion": {"id": OPP, "subjectText": "x", "bodyText": "x"}},
])
def test_stale_or_unapproved_draft_blocks_post(change):
    scenario = Scenario()
    scenario.approved = True
    scenario.draft_override = change
    with pytest.raises(BacklinksReadError, match="REQUIRES_CURRENT_APPROVED_DRAFT"):
        asyncio.run(with_registry(scenario, check))
    assert all(method == "GET" for method, _, _ in scenario.calls)


@pytest.mark.parametrize("change", [
    {"humanConfirmation": {"confirmed": True}}, {"organization_id": "other"},
    {"operation_id": "model-key"}, {"contactVersion": True},
    {"followUpIndex": 1}, {"messagePurpose": "FOLLOW_UP"},
    {"gmailConnectionId": "not-a-uuid"},
])
def test_model_cannot_invent_authority_or_invalid_parameters(change):
    with pytest.raises(ValidationError):
        PreflightArgs.model_validate({**PREFLIGHT, **change})


def test_permission_and_scope_fail_closed():
    async def no_write(registry, authority):
        authority["delegation"] = grant(replace(CONTEXT, permissions=("backlinks:read",)))
        await check(registry, authority)
    scenario = Scenario()
    with pytest.raises(ValueError):
        asyncio.run(with_registry(scenario, no_write))
    assert scenario.calls == []
    scenario.corrupt_scope = True
    with pytest.raises(BacklinksReadError, match="SCOPE_MISMATCH"):
        asyncio.run(with_registry(scenario, check))


@pytest.mark.parametrize("change", [
    {"allowed": False}, {"deliveryState": "SENT"}, {"readinessSnapshot": None},
    {"gmail": {"connectionId": OPP}},
])
def test_invalid_preflight_success_rejected(change):
    scenario = Scenario()
    scenario.approved = True
    scenario.preflight_override = change
    with pytest.raises(BacklinksReadError, match="INVALID_RESPONSE"):
        asyncio.run(with_registry(scenario, check))


def test_preflight_prepared_parameters_cannot_change():
    scenario = Scenario()
    async def run(registry, authority):
        prepared = await registry.prepare_write("project", TOOL, PREFLIGHT, "stable", **authority)
        await registry.execute_write(
            "project", TOOL, {**prepared.arguments, "contactVersion": 2},
            prepared.before, prepared.parameters_hash, **authority,
        )
    with pytest.raises(ValueError, match="PARAMETERS_CHANGED"):
        asyncio.run(with_registry(scenario, run))
    assert scenario.calls == []


@pytest.mark.parametrize(("message", "allowed"), [
    ("执行发送预检，不要发送", True), ("Run email preflight. Do not send.", True),
    ("不要进行发送预检", False), ("如何执行发送预检？", False),
    ("读取草稿", False), ("Do not run email preflight", False),
])
def test_preflight_intent_is_not_send_permission(message, allowed):
    assert user_explicitly_requested_write(TOOL, [{"role": "user", "content": message}]) is allowed
    for name in ("submit_backlink_email", "send_backlink_drafts"):
        assert not user_explicitly_requested_write(name, [{"role": "user", "content": message}])


def test_finite_preflight_list_partial_failure_retries_only_unfinished():
    scenarios = [Scenario(), Scenario(), Scenario()]
    for scenario in scenarios:
        scenario.approved = True
    scenarios[1].preflight_error = 503
    results = {}
    for index, scenario in enumerate(scenarios):
        try:
            results[index] = asyncio.run(with_registry(scenario, check))
        except BacklinksReadError:
            results[index] = None
    assert [key for key, value in results.items() if value] == [0, 2]
    scenarios[1].preflight_error = None
    for index, value in results.items():
        if value is None:
            results[index] = asyncio.run(with_registry(scenarios[index], check))
    assert all(result["deliveryState"] == "NOT_SENT" for result in results.values())
    assert [sum(method == "POST" for method, _, _ in s.calls) for s in scenarios] == [1, 2, 1]


def test_lost_submission_response_recovers_saved_intent_without_resubmission():
    scenario = Scenario()
    scenario.approved = True

    async def run(registry, authority):
        await check(registry, authority)
        scenario.simulate_external_page_submission("DELIVERY_UNKNOWN")
        # Simulate losing the page's response. Recover using persisted draft lineage.
        result = await registry.execute_read(
            "project", "list_backlink_send_intents", {"draftId": DRAFT}, **authority,
        )
        intent = result["data"]["items"][0]
        assert intent["sendIntentId"] == INTENT
        assert intent["status"] == "DELIVERY_UNKNOWN"
        assert "not resending" in result["interpretation"]
    asyncio.run(with_registry(scenario, run))
    assert all(not path.endswith("/send-intents") for method, path, _ in scenario.calls if method == "POST")


def test_activity_uses_server_delegation_and_replays_completed_result(monkeypatch):
    scenario = Scenario()
    scenario.approved = True

    class Repo(ProjectMemoryRepository):
        completed = None

        async def get_run_context(self, run_id):
            context = await super().get_run_context(run_id)
            return {
                **context, "project_id": "project", "organization_id": "org",
                "limits": {**context["limits"], "backlinks_delegation": grant()},
                "messages": [{"role": "user", "content": "执行发送预检，不要发送"}],
            }

        async def claim_registered_tool(self, *args):
            return ("completed" if self.completed else "claimed"), SimpleNamespace(
                tool_name=TOOL, arguments_json=PREFLIGHT, parameters_hash="",
                before_json={}, model_tool_call_id="preflight-provider-call",
                model_result_json=self.completed,
            )

        async def reserve_paid_tool_budget(self, *args):
            return {"allowed": True}

        async def set_tool_verifying(self, *args):
            self.events.append(("verified", None))

        async def complete_tool_execution(self, tool_id, worker_id, output, views):
            self.completed = views
            await super().complete_tool_execution(tool_id, worker_id, output, views)

        async def fail_tool_execution(self, *args):
            raise AssertionError(f"Unexpected activity failure: {args[2]}")

    repo = Repo()

    async def run(registry, authority):
        monkeypatch.setattr(activities, "repository", lambda: repo)
        monkeypatch.setattr(activities, "registry", lambda: registry)
        payload = {
            "run_id": "dry-run", "tool_call_id": "preflight-call",
            "project_id": "untrusted", "organization_id": "untrusted",
        }
        result = await activities.execute_tool(payload)
        assert result["ok"] is True
        assert result["data"]["deliveryState"] == "NOT_SENT"
        count = len(scenario.calls)
        assert await activities.execute_tool(payload) == result
        assert len(scenario.calls) == count
    asyncio.run(with_registry(scenario, run))
