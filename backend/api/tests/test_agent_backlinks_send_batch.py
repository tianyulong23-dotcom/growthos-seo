"""Rollback-only PostgreSQL and mocked Core. No provider or real business writes."""

import asyncio
import json
import runpy
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import FastAPI
from pydantic import ValidationError
from test_agent_backlinks_continuation import identifier, start, with_database
from test_agent_backlinks_drafts import CONTEXT, META, SETTINGS
from test_agent_backlinks_send import ACCOUNT, confirmed_command

from app.api.routes import agent_backlinks_consent as routes
from app.core.backlinks_gateway import BacklinksGateway
from app.modules.agent.backlinks_consent import BacklinksConsentStore, ConsentError
from app.modules.agent.backlinks_send_batch import (
    BacklinksSendBatchStore,
    SendBatchConfirmation,
    SendBatchPreviewRequest,
)
from app.modules.agent.models import (
    AgentBacklinksConsent,
    AgentBacklinksContinuation,
    AgentBacklinksSendBatch,
    AgentRun,
    AgentWorkflowDispatch,
)
from app.modules.projects.models import Project


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    async def blocked(*args, **kwargs):
        raise AssertionError("Real HTTP is forbidden")
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked)


class Core:
    def __init__(self):
        self.calls, self.sent = [], {}
        self.approved, self.drop_response, self.duplicate = True, False, False
        self.status, self.used = "READY", 0
        self.change_readback = False

    def respond(self, request):
        self.calls.append(request)
        path = request.url.path.split("/backlinks/")[1]
        assert "/approve" not in path
        if path == "send-batch-preflight":
            data = {"items": [{
                "draftId": item["draftId"], "allowed": True, "deliveryState": "NOT_SENT",
                "readinessSnapshot": {
                    **confirmed_command().readiness_snapshot,
                    "expiresAt": (datetime.now(UTC) + timedelta(hours=24)).isoformat(),
                    "conditions": [{"code": "QUOTA", "revision": f"{self.used + i}/20"}],
                },
                "gmail": {"connectionId": ACCOUNT, "primaryEmail": "sender@example.test"},
            } for i, item in enumerate(json.loads(request.content)["items"])]}
        elif path.endswith("/contacts"):
            id = path.split("/")[1]
            data = {"items": [{
                "id": id, "status": "active", "guessed": False, "confirmedAt": META["generatedAt"],
                "version": 1, "normalizedEmail": f"{'same' if self.duplicate else id}@example.test",
            }]}
        elif path.endswith("/send-intents"):
            id = path.split("/")[1]
            body = json.loads(request.content)
            assert body["humanConfirmation"]["confirmed"] is True
            # Core's z.string().datetime() requires UTC Z, not a numeric offset.
            assert body["humanConfirmation"]["confirmedAt"].endswith("Z")
            datetime.fromisoformat(body["humanConfirmation"]["confirmedAt"])
            assert body["readinessSnapshot"]["conditions"][0]["revision"] == f"{self.used}/20"
            self.used += 1
            receipt = {
                "sendIntentId": id, "sendSnapshotId": identifier("snapshot:" + id), "draftId": id,
                "approvedDraftVersionId": identifier("version:" + id), "contactId": id,
                "contactVersion": 1, "status": "READY", "version": 1,
                "requestedSendAt": META["generatedAt"],
            }
            self.sent[id] = receipt
            if self.drop_response:
                raise httpx.ReadTimeout("Lost response")
            return httpx.Response(201, json={**receipt, "meta": META})
        elif path.startswith("send-intents/"):
            data = {"sendIntent": {
                **self.sent[path.split("/")[1]], "status": self.status,
                **({"draftId": identifier("wrong")} if self.change_readback else {}),
            }}
        elif path.startswith("opportunities/"):
            data = {"item": {"id": path.split("/")[1], "targetHostAscii": "example.test"}}
        else:
            id = path.split("/")[1]
            data = {"draft": {
                "id": id, "opportunityId": id, "contactId": id, "contactVersion": 1,
                "approvedVersionId": identifier("version:" + id) if self.approved else None,
                "inputSnapshot": {"contactId": id, "contactVersion": 1,
                                  "request": {"language": "en"}},
                "freshness": {"state": "FRESH", "regenerateRequired": False},
                "currentVersion": {"id": identifier("version:" + id),
                                   "subjectText": "Subject", "bodyText": "Body"},
            }}
        return httpx.Response(200, json={**data, "meta": META})


async def harness(check):
    async def run(sessions):
        async with sessions() as session, session.begin():
            connection = await session.connection()
            def migrate(conn):
                migration = runpy.run_path(str(
                    Path(__file__).resolve().parents[1] / "migrations" / "versions"
                    / "20260914_0069_agent_backlinks_send_batches.py",
                ))
                with Operations.context(MigrationContext.configure(conn)):
                    migration["upgrade"]()
                    runpy.run_path(str(
                        Path(__file__).resolve().parents[1] / "migrations" / "versions"
                        / "20260915_0070_agent_backlinks_quality_reviews.py",
                    ))["upgrade"]()
            await connection.run_sync(migrate)
        _, grant, run = await start(sessions)
        async with sessions() as session, session.begin():
            record = await session.get(AgentBacklinksContinuation, run["run_id"])
            record.checkpoint_json = {"stage": "done", "results": [
                {"state": "VERIFIED_DRAFT", "draftId": identifier(i)} for i in range(2)
            ]}
        core = Core()
        async with httpx.AsyncClient(transport=httpx.MockTransport(core.respond)) as client:
            gateway = BacklinksGateway(base_url="http://core.test", signing_key="k" * 32, client=client)
            store = BacklinksSendBatchStore(sessions, SETTINGS, gateway=gateway)
            request = SendBatchPreviewRequest(
                request_id=uuid4(), draft_ids=[identifier(0), identifier(1)], gmail_connection_id=ACCOUNT,
            )
            await check(store, grant["id"], core, request)
    await with_database(run)


async def confirm(store, consent, request):
    preview = await store.preview(CONTEXT, consent, request)
    body = SendBatchConfirmation(confirmed=True, manifest_hash=preview["manifest_hash"])
    return await store.confirm(CONTEXT, consent, preview["id"], body, {}), body


@pytest.mark.parametrize("confirm_before_deadline", [True, False])
def test_preview_deadline_is_not_the_serial_execution_deadline(confirm_before_deadline):
    async def check(store, consent, core, request):
        async with store.sessions() as session, session.begin():
            grant = await session.get(AgentBacklinksConsent, consent)
            grant.expires_at = datetime.now(UTC) + timedelta(hours=2)
        preview = await store.preview(CONTEXT, consent, request)
        assert preview["expires_at"] - preview["confirmation_expires_at"] > timedelta(hours=1)
        body = SendBatchConfirmation(confirmed=True, manifest_hash=preview["manifest_hash"])
        if confirm_before_deadline:
            batch = await store.confirm(CONTEXT, consent, preview["id"], body, {})
        async with store.sessions() as session, session.begin():
            record = await session.get(AgentBacklinksSendBatch, preview["id"])
            record.created_at -= timedelta(minutes=6)
        if confirm_before_deadline:
            assert not (await store.tick(batch["run_id"]))["done"]
            assert (await store.list(CONTEXT, consent))["items"][0]["state"] != "paused"
        else:
            with pytest.raises(ConsentError, match="BACKLINKS_SEND_PREVIEW_EXPIRED"):
                await store.confirm(CONTEXT, consent, preview["id"], body, {})
        assert len(core.sent) == (1 if confirm_before_deadline else 0)
    asyncio.run(harness(check))


def test_two_confirmed_drafts_submit_once_then_monitor_without_claiming_delivery():
    async def check(store, consent, core, request):
        preview = await store.preview(CONTEXT, consent, request)
        assert preview["expires_at"] >= preview["confirmation_expires_at"]
        assert preview["state"] == "preview" and not core.sent and preview["run_id"] is None
        again = await store.preview(CONTEXT, consent, request)
        assert again["id"] == preview["id"] and len(core.calls) == 5
        batch, body = await confirm(store, consent, request)
        replay = await store.confirm(CONTEXT, consent, batch["id"], body, {})
        assert replay["run_id"] == batch["run_id"]
        async with store.sessions() as session:
            dispatch = await session.get(AgentWorkflowDispatch, batch["run_id"])
            assert dispatch.task_payload["limits"]["backlinks_send_batch"] is True
        assert not core.sent
        assert not (await store.tick(batch["run_id"]))["done"]
        assert not (await store.tick(batch["run_id"]))["done"]
        assert len(core.sent) == 1
        assert not (await store.tick(batch["run_id"]))["done"]
        core.status = "FAILED_RETRYABLE"
        assert not (await store.tick(batch["run_id"]))["done"]
        assert len(core.sent) == 1
        core.status = "PROVIDER_ACCEPTED"
        assert not (await store.tick(batch["run_id"]))["done"]
        assert len(core.sent) == 2
        assert (await store.tick(batch["run_id"]))["done"]
        saved = (await store.list(CONTEXT, consent))["items"][0]
        assert saved["state"] == "completed"
        assert [item["state"] for item in saved["items"]] == ["PROVIDER_ACCEPTED"] * 2
        assert (await store.tick(batch["run_id"]))["done"] and len(core.sent) == 2
    asyncio.run(harness(check))


@pytest.mark.parametrize("change", ["user", "organization", "workspace", "project", "permission"])
def test_cross_scope_cannot_list_or_confirm(change):
    async def check(store, consent, core, request):
        preview = await store.preview(CONTEXT, consent, request)
        other = CONTEXT
        if change == "user":
            other = replace(CONTEXT, actor=replace(CONTEXT.actor, user_id="other"))
        elif change in {"organization", "workspace"}:
            other = replace(CONTEXT, tenant=replace(CONTEXT.tenant, **{change + "_id": "other"}))
        elif change == "project":
            other = replace(CONTEXT, project=replace(CONTEXT.project, website_project_id="other"))
        else:
            other = replace(CONTEXT, permissions=())
        with pytest.raises(ConsentError):
            await store.list(other, consent)
        with pytest.raises(ConsentError):
            await store.confirm(other, consent, preview["id"],
                                SendBatchConfirmation(confirmed=True, manifest_hash=preview["manifest_hash"]), {})
        assert not core.sent
    asyncio.run(harness(check))


@pytest.mark.parametrize("stop", ["revoke", "consent", "expire", "archive", "cancel"])
def test_stop_before_second_submission_does_not_retract_first(stop):
    async def check(store, consent, core, request):
        batch, _ = await confirm(store, consent, request)
        await store.tick(batch["run_id"])
        if stop == "revoke":
            await store.revoke(CONTEXT, consent, batch["id"])
        elif stop == "consent":
            await BacklinksConsentStore(store.sessions).revoke(CONTEXT, consent)
        else:
            async with store.sessions() as session, session.begin():
                if stop == "expire":
                    record = await session.get(AgentBacklinksSendBatch, batch["id"])
                    record.expires_at = datetime.now(UTC) - timedelta(seconds=1)
                elif stop == "archive":
                    (await session.get(Project, "project")).status = "ARCHIVED"
                else:
                    (await session.get(AgentRun, batch["run_id"])).status = "cancelled"
        assert (await store.tick(batch["run_id"]))["done"]
        assert len(core.sent) == 1
        if stop == "cancel":
            assert (await store.list(CONTEXT, consent))["items"][0]["state"] == "cancelled"
    asyncio.run(harness(check))


def test_persisted_pause_never_resumes_after_finalize_interruption():
    async def check(store, consent, core, request):
        batch, _ = await confirm(store, consent, request)
        async with store.sessions() as session, session.begin():
            record = await session.get(AgentBacklinksSendBatch, batch["id"])
            record.state, record.reason = "paused", "BACKLINKS_SEND_INVALID_EVIDENCE"
        assert (await store.tick(batch["run_id"]))["done"]
        assert len(core.sent) == 0
        async with store.sessions() as session:
            assert (await session.get(AgentRun, batch["run_id"])).status == "failed"
    asyncio.run(harness(check))


def test_lost_submission_response_never_resubmits_or_advances_second():
    async def check(store, consent, core, request):
        batch, _ = await confirm(store, consent, request)
        core.drop_response = True
        assert (await store.tick(batch["run_id"]))["done"]
        result = (await store.list(CONTEXT, consent))["items"][0]
        assert result["state"] == "paused" and result["items"][0]["state"] == "SUBMITTING"
        assert result["reason"] == "BACKLINKS_SEND_SUBMISSION_UNVERIFIED"
        await store.tick(batch["run_id"])
        assert len(core.sent) == 1 and core.used == 1
    asyncio.run(harness(check))


@pytest.mark.parametrize("invalid", ["approval", "duplicate_recipient", "foreign_draft", "request_conflict",
                                   "hash", "false_confirmation", "expiry"])
def test_invalid_preview_or_confirmation_cannot_send(invalid):
    async def check(store, consent, core, request):
        if invalid == "approval":
            core.approved = False
        elif invalid == "duplicate_recipient":
            core.duplicate = True
        elif invalid == "foreign_draft":
            request = request.model_copy(update={"draft_ids": [uuid4()]})
        if invalid in {"approval", "duplicate_recipient", "foreign_draft"}:
            with pytest.raises(ConsentError):
                await store.preview(CONTEXT, consent, request)
        else:
            preview = await store.preview(CONTEXT, consent, request)
            if invalid == "request_conflict":
                with pytest.raises(ConsentError, match="REQUEST_CONFLICT"):
                    await store.preview(CONTEXT, consent, request.model_copy(update={"gmail_connection_id": uuid4()}))
            else:
                if invalid == "expiry":
                    async with store.sessions() as session, session.begin():
                        record = await session.get(AgentBacklinksSendBatch, preview["id"])
                        record.expires_at = datetime.now(UTC) - timedelta(seconds=1)
                    preview = (await store.list(CONTEXT, consent))["items"][0]
                with pytest.raises(ConsentError):
                    await store.confirm(CONTEXT, consent, preview["id"], SendBatchConfirmation(
                        confirmed=invalid != "false_confirmation",
                        manifest_hash="0" * 64 if invalid == "hash" else preview["manifest_hash"],
                    ), {})
        assert not core.sent
    asyncio.run(harness(check))


@pytest.mark.parametrize("status", ["FAILED_FINAL", "CANCELLED", "REJECTED", "DELIVERY_UNKNOWN", "mismatch"])
def test_monitor_failure_never_claims_all_sent(status):
    async def check(store, consent, core, request):
        batch, _ = await confirm(store, consent, request)
        await store.tick(batch["run_id"])
        await store.tick(batch["run_id"])
        core.status = "PROVIDER_ACCEPTED" if status == "mismatch" else status
        core.change_readback = status == "mismatch"
        assert (await store.tick(batch["run_id"]))["done"]
        saved = (await store.list(CONTEXT, consent))["items"][0]
        assert saved["state"] != "completed"
        assert len(core.sent) == 1
    asyncio.run(harness(check))


def test_crash_pending_checkpoint_and_active_lease_are_safe():
    async def check(store, consent, core, request):
        batch, _ = await confirm(store, consent, request)
        async with store.sessions() as session, session.begin():
            record = await session.get(AgentBacklinksSendBatch, batch["id"])
            record.lease_id, record.lease_expires_at = "old", datetime.now(UTC) + timedelta(minutes=1)
        assert not (await store.tick(batch["run_id"]))["done"]
        async with store.sessions() as session, session.begin():
            record = await session.get(AgentBacklinksSendBatch, batch["id"])
            record.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
            items = json.loads(json.dumps(record.items_json))
            items[0]["state"] = "SUBMITTING"
            record.items_json = items
        assert (await store.tick(batch["run_id"]))["done"] and not core.sent
    asyncio.run(harness(check))


def test_strict_preview_rejects_authority_and_duplicates():
    base = {"request_id": str(uuid4()), "draft_ids": [identifier(0)], "gmail_connection_id": ACCOUNT}
    for overrides in ({"confirmed": True}, {"draft_ids": [identifier(0)] * 2},
                      {"draft_ids": []}, {"draft_ids": [identifier(i) for i in range(21)]}):
        with pytest.raises(ValidationError):
            SendBatchPreviewRequest.model_validate({**base, **overrides})
    with pytest.raises(ValidationError):
        SendBatchConfirmation(confirmed="true", manifest_hash="a" * 64)


@pytest.mark.parametrize("method,suffix,body,expected,permission", [
    ("GET", "", None, 200, "backlinks:read"),
    ("POST", "/preview", {"request_id": str(uuid4()), "draft_ids": [identifier(0)],
                         "gmail_connection_id": ACCOUNT}, 200, "backlinks:write"),
    ("POST", f"/{identifier('batch')}/confirm", {"confirmed": True, "manifest_hash": "a" * 64},
     202, "backlinks:write"),
    ("POST", f"/{identifier('batch')}/confirm", {"confirmed": "true", "manifest_hash": "a" * 64},
     422, "backlinks:write"),
    ("POST", f"/{identifier('batch')}/revoke", None, 200, "backlinks:write"),
])
def test_routes_use_authenticated_context(monkeypatch, method, suffix, body, expected, permission):
    async def check():
        store = SimpleNamespace(**{name: AsyncMock(return_value={"items": []})
                                   for name in ("list", "preview", "confirm", "revoke")})
        resolver = SimpleNamespace(resolve=AsyncMock(return_value=CONTEXT))
        app = FastAPI()
        app.state.platform_context_resolver = resolver
        app.include_router(routes.router, prefix="/api/v1/projects/{project_id}/agent")
        app.dependency_overrides[routes.send_batch_store] = lambda: store
        monkeypatch.setattr(routes, "build_agent_service", lambda: SimpleNamespace(limits={}))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.request(method, f"/api/v1/projects/key/agent/automation/consents/{uuid4()}/send-batches{suffix}", json=body)
        assert response.status_code == expected, response.text
        assert resolver.resolve.call_args.kwargs["required_permission"] == permission
    asyncio.run(check())


def test_workflow_uses_existing_dispatch_without_model(monkeypatch):
    from app.modules.agent import workflows
    execute = AsyncMock(side_effect=[{"done": False, "wait_seconds": 1}, {"done": True}])
    monkeypatch.setattr(workflows.workflow, "execute_activity", execute)
    monkeypatch.setattr(workflows.workflow, "sleep", AsyncMock())
    asyncio.run(workflows.AgentWorkflow().run({"run_id": "run", "limits": {"backlinks_send_batch": True}}))
    assert all(call.args[0] == "agent_backlinks_send_batch" for call in execute.await_args_list)
