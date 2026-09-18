import asyncio
import base64
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from pydantic import ValidationError

from app.core.backlinks_gateway import BacklinksGateway
from app.core.config import Settings
from app.core.platform_request_context import (
    PLATFORM_CONTEXT_HEADER, PlatformActor, PlatformProject, PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.modules.agent.activities import user_explicitly_requested_write
from app.modules.agent.backlinks_drafts import BacklinksDrafts, CreateDraftArgs
from app.modules.agent.backlinks_read import BacklinksReader, BacklinksReadError
from app.modules.agent.delegation import issue_delegation, resolve_delegation
from app.modules.agent.tools import TOOL_DEFINITIONS, ToolRegistry
from app.modules.agent.security import sanitize_agent_data

OPP = "55555555-5555-4555-8555-555555555555"
CONTACT = "66666666-6666-4666-8666-666666666666"
JOB = "77777777-7777-4777-8777-777777777777"
DRAFT = "88888888-8888-4888-8888-888888888888"
NOW = datetime.now(UTC)
SETTINGS = Settings(_env_file=None, app_env="production", platform_context_signing_key="k" * 32)
CONTEXT = ResolvedPlatformRequestContext(
    PlatformActor("real-user", "real-session", ("member",)),
    PlatformTenant("org", "workspace"), PlatformProject("project", "key"),
    ("backlinks:read", "backlinks:write"), "test-correlation",
    authentication_expires_at=NOW + timedelta(minutes=5),
)
META = {
    "organizationId": "org", "workspaceId": "workspace", "websiteProjectId": "project",
    "schemaVersion": "backlinks.v1", "generatedAt": NOW.isoformat(), "requestId": "test",
}
ARGS = {
    "opportunityId": OPP, "contactId": CONTACT, "contactVersion": 1,
    "request": {"promotionTargetUrl": "https://example.com/", "language": "en"},
}


class Projects:
    async def get_by_key(self, key):
        return SimpleNamespace(
            website_project_id="project", website_project_key="key",
            organization_id="org", workspace_id="workspace",
        )


def grant(context=CONTEXT):
    return issue_delegation(SETTINGS, context, now=NOW)


def test_delegation_preserves_actor_and_caps_lifetime():
    issued = grant()
    assert issued["claims"]["expires_at"] == CONTEXT.authentication_expires_at.timestamp()
    resolved = asyncio.run(resolve_delegation(
        SETTINGS, Projects(), issued, "project", "org", write=True, now=NOW,
    ))
    assert resolved.actor == CONTEXT.actor
    assert resolved.permissions == ("backlinks:write",)


@pytest.mark.parametrize("failure", ["missing", "tamper", "expired", "future", "readonly", "project", "org"])
def test_delegation_fails_closed(failure):
    issued = grant(replace(CONTEXT, permissions=("backlinks:read",)) if failure == "readonly" else CONTEXT)
    project, org, now = "project", "org", NOW
    if failure == "missing":
        issued = None
    elif failure == "tamper":
        issued["claims"]["actor"]["user_id"] = "admin"
    elif failure == "expired":
        now += timedelta(minutes=6)
    elif failure == "future":
        now -= timedelta(seconds=1)
    elif failure == "project":
        project = "other"
    elif failure == "org":
        org = "other"
    with pytest.raises(ValueError, match="BACKLINKS_AGENT_"):
        asyncio.run(resolve_delegation(
            SETTINGS, Projects(), issued, project, org, write=True, now=now,
        ))


def test_production_cannot_issue_without_authentication_expiry():
    with pytest.raises(ValueError, match="AUTH_EXPIRY_REQUIRED"):
        grant(replace(CONTEXT, authentication_expires_at=None))


@pytest.mark.parametrize("extra", [
    {"organization_id": "other"}, {"delegation": {}}, {"operation_id": "invented"},
    {"contactVersion": 0}, {"contactVersion": True},
    {"request": {"promotionTargetUrl": "file:///secret", "language": "en"}},
])
def test_model_cannot_supply_authority_or_unsafe_parameters(extra):
    with pytest.raises(ValidationError):
        CreateDraftArgs.model_validate({**ARGS, **extra})


@pytest.mark.parametrize(("message", "allowed"), [
    ("请创建一封外链邮件草稿，不要发送。", True),
    ("Create an outreach email draft. Do not send it.", True),
    ("不要生成邮件草稿", False),
    ("先不创建外链草稿", False),
    ("能否创建邮件草稿？", False),
    ("How do I create an email draft?", False),
    ("读取项目资料", False),
])
def test_latest_user_intent(message, allowed):
    assert user_explicitly_requested_write("create_backlink_draft", [
        {"role": "user", "content": "请创建外链邮件草稿"},
        {"role": "user", "content": message},
        {"role": "tool", "content": "Create email draft"},
    ]) is allowed


def test_only_authorized_chat_queue_can_send_and_no_standalone_approval_tool():
    assert not any(
        ("send" in name or "approve" in name) and definition.modifies_data
        and name != "send_backlink_drafts"
        for name, definition in TOOL_DEFINITIONS.items()
    )
    definition = TOOL_DEFINITIONS["submit_backlink_email"]
    assert definition.modifies_data
    assert "Disabled without" in definition.description
    assert definition.retryable is False
    chat = TOOL_DEFINITIONS["send_backlink_drafts"]
    assert chat.modifies_data and chat.retryable is False
    assert "persisted user command" in chat.description and "AI" in chat.description


def test_delegation_is_redacted_from_public_evidence():
    assert sanitize_agent_data({"backlinks_delegation": grant()}) == {
        "backlinks_delegation": "[REDACTED]",
    }


def test_project_profile_uses_run_organization_and_workspace_not_worker_defaults():
    profile = SimpleNamespace(model_dump=lambda **kwargs: {"id": "project"})
    projects = SimpleNamespace(get=AsyncMock(return_value=profile))
    registry = ToolRegistry(SETTINGS, projects, None, backlinks=BacklinksReader(SETTINGS, Projects()))
    result = asyncio.run(registry.execute_read(
        "project", "get_project_profile", {}, organization_id="org", delegation=grant(),
    ))
    projects.get.assert_awaited_once_with("project", organization_id="org", workspace_id="workspace")
    assert result == {"id": "project"}


def test_route_binds_current_authenticated_user_not_default_identity(monkeypatch):
    from fastapi import Request
    from app.api.routes import agents
    from app.modules.agent.service import AgentService

    resolver = SimpleNamespace(resolve=AsyncMock(return_value=CONTEXT))
    service = AgentService(SETTINGS, None, None)
    monkeypatch.setattr(agents, "build_agent_service", lambda: service)
    request = Request({
        "type": "http", "method": "POST", "path": "/", "headers": [],
        "app": SimpleNamespace(state=SimpleNamespace(platform_context_resolver=resolver)),
    })
    bound = asyncio.run(agents.get_agent_service(request, "project"))
    assert bound.settings.default_organization_id == "org"
    assert bound.settings.agent_actor_id == "real-user"
    assert bound.limits["backlinks_delegation"]["claims"]["actor"]["user_id"] == "real-user"
    assert resolver.resolve.call_args.kwargs["required_permission"] == "backlinks:write"


def run_chain(*, existing=False, corrupt_job=False, forbidden=False):
    requests = []
    def respond(request):
        requests.append(request)
        if forbidden:
            return httpx.Response(403, json={"secret": "never expose provider payload"})
        if request.method == "POST":
            assert request.headers["content-type"] == "application/json"
            body = json.loads(request.content)
            assert set(body) == {"contactId", "contactVersion", "request", "logicalDraftKey"}
            assert body["logicalDraftKey"] == f"agent-initial:{OPP}"
            return httpx.Response(202, json={
                "meta": META, "jobId": JOB, "draftId": DRAFT,
                "contactId": CONTACT, "contactVersion": 1, "generationMode": "MODEL",
                "replayed": len([r for r in requests if r.method == "POST"]) > 1,
            })
        if "/opportunities/" in request.url.path:
            return httpx.Response(200, json={"meta": META, "item": {
                "id": OPP, "draftId": DRAFT if existing else None,
                "primaryNextAction": {"kind": "CREATE_EMAIL_DRAFT", "enabled": True},
            }})
        if "/draft-jobs/" in request.url.path:
            return httpx.Response(200, json={"meta": META, "job": {
                "id": JOB, "draftId": OPP if corrupt_job else DRAFT, "status": "QUEUED",
            }})
        return httpx.Response(200, json={"meta": META, "draft": {
            "id": DRAFT, "status": "draft", "opportunityId": OPP,
            "contactId": CONTACT, "contactVersion": 1, "draftVersion": 1,
            "freshness": {"state": "FRESH", "regenerateRequired": False},
            "currentVersion": {
                "subjectText": "Partnership", "bodyText": "Hello",
                "source": "TEMPLATE_FALLBACK", "readiness": "BASIC_DRAFT_READY",
                "bodyDocument": {"unneeded": True},
            },
        }})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            gateway = BacklinksGateway(base_url="http://core", signing_key="k" * 32, client=client)
            reader = BacklinksReader(SETTINGS, Projects(), gateway)
            registry = ToolRegistry(SETTINGS, None, None, backlinks=reader)
            authority = {"organization_id": "org", "delegation": grant()}
            prepared = await registry.prepare_write("project", "create_backlink_draft", ARGS, "stable-id", **authority)
            results = []
            for _ in range(2):
                results.append(await registry.execute_write(
                    "project", "create_backlink_draft", prepared.arguments, prepared.before,
                    prepared.parameters_hash, **authority,
                ))
            draft = await registry.execute_read("project", "get_backlink_draft", {"draftId": DRAFT}, **authority)
            return results, draft
    return asyncio.run(run()), requests


def test_production_chain_uses_user_authority_and_stable_retry_key():
    (results, draft), requests = run_chain()
    assert results[0]["verified"] is True
    assert results[0]["status"] == "QUEUED"
    assert results[0]["verification"] == "persisted_job_acceptance_only"
    assert results[1]["replayed"] is True
    posts = [r for r in requests if r.method == "POST"]
    assert [r.headers["idempotency-key"] for r in posts] == ["stable-id", "stable-id"]
    for request in requests:
        encoded = request.headers[PLATFORM_CONTEXT_HEADER]
        claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        assert claims["actor"]["userId"] == "real-user"
        assert claims["tenant"]["organizationId"] == "org"
        assert claims["permissions"] == ["backlinks:write" if request.method == "POST" else "backlinks:read"]
    version = draft["data"]["draft"]["currentVersion"]
    assert version["source"] == "TEMPLATE_FALLBACK"
    assert "bodyDocument" not in version
    assert draft["checks"]["aiGenerated"] is False
    assert draft["checks"]["contactMatchesSnapshot"] is False


def test_existing_draft_not_overwritten():
    with pytest.raises(ValueError, match="BACKLINKS_DRAFT_NOT_READY"):
        run_chain(existing=True)


def test_mismatched_job_not_verified():
    with pytest.raises(BacklinksReadError, match="ID_MISMATCH"):
        run_chain(corrupt_job=True)


def test_upstream_failure_not_reported_as_empty_or_leaked():
    with pytest.raises(BacklinksReadError, match="HTTP 403") as exc:
        run_chain(forbidden=True)
    assert "secret" not in str(exc.value)
