import asyncio
import json
from dataclasses import dataclass, replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from app.api.routes import mail_reply as routes
from app.core.platform_request_context import (
    PlatformActor, PlatformTenant, PlatformProject, ResolvedPlatformRequestContext,
)
from app.modules.agent import mail_reply as assistant

MESSAGE = "00000000-0000-4000-8000-000000000001"
ACCOUNT = "00000000-0000-4000-8000-000000000002"
RESOLVED = ResolvedPlatformRequestContext(
    actor=PlatformActor("user", "session", ("member",)),
    tenant=PlatformTenant("org", "workspace"),
    project=PlatformProject("project", "project-key"),
    permissions=("backlinks:read", "backlinks:write"), correlation_id="request",
)
MAIL = {
    "id": MESSAGE, "subject": "Re: Cooperation", "fromAddress": "bruno@publisher.test",
    "direction": "INBOUND", "version": 2, "matchedOpportunityId": "opportunity",
    "body": {"plainText": "Olá, o preço é R$ 500 por artigo.", "sanitizedHtml": None},
}
CONTEXT = {
    "message": MAIL, "thread": {"messages": [MAIL]},
    "recipient": "bruno@publisher.test", "subject": "Re: Cooperation",
    "gmailConnectionId": ACCOUNT, "existingReply": None,
}
OUTPUT = {
    "detected_language": "pt", "summary": "报价 R$ 500/篇。", "key_points": ["R$ 500"],
    "questions": [], "warnings": [], "body": "Obrigado. O link é permanente?",
}
PAYLOAD = {
    "expectedVersion": 2, "gmailConnectionId": ACCOUNT, "recipient": "bruno@publisher.test",
    "subject": "Re: Cooperation", "body": OUTPUT["body"],
}
URL = f"/api/v1/projects/project-key/backlinks/mail/messages/{MESSAGE}"


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    app.state.platform_context_resolver = SimpleNamespace(resolve=AsyncMock(return_value=RESOLVED))
    app.state.backlinks_gateway = SimpleNamespace(forward=AsyncMock(return_value=JSONResponse(CONTEXT)))
    monkeypatch.setattr(routes, "signing_key", lambda: "test-key-not-a-credential")
    monkeypatch.setattr(routes, "assist_reply", AsyncMock(return_value=assistant.ReplyUnderstanding(**OUTPUT)))
    with TestClient(app) as value:
        yield value


def test_manual_is_default_and_generation_does_not_send(client):
    result = client.post(URL + "/reply-assistant", json={"action": "draft", "reply_language": "pt"})
    assert result.status_code == 200
    assert result.json()["generationToken"] is None
    assert result.json()["model"] == "gpt-5.5"
    gateway = client.app.state.backlinks_gateway.forward
    assert gateway.call_count == 1
    assert gateway.call_args.kwargs["upstream_path"].endswith("/reply-context")


def test_one_reply_consent_binds_body_account_session_and_message(client):
    result = client.post(URL + "/reply-assistant", json={"action": "draft", "authorize_one_reply": True})
    token = result.json()["generationToken"]
    assert token
    for field, value in [("body", "changed"), ("recipient", "other@publisher.test"),
                         ("gmailConnectionId", MESSAGE), ("expectedVersion", 3)]:
        response = client.post(URL + "/reply-send", json={
            **PAYLOAD, field: value, "confirmed": True,
            "confirmationMode": "ONE_REPLY", "generationToken": token,
        })
        assert response.status_code == 409
    response = client.post(URL + "/reply-send", json={
        **PAYLOAD, "confirmed": True, "confirmationMode": "ONE_REPLY", "generationToken": token,
    })
    assert response.status_code == 200
    forwarded = client.app.state.backlinks_gateway.forward.call_args.args[0]
    body = asyncio.run(forwarded.body())
    assert json.loads(body)["confirmationMode"] == "ONE_REPLY"
    assert "generationToken" not in json.loads(body)


def test_warnings_never_authorize(client, monkeypatch):
    monkeypatch.setattr(routes, "assist_reply", AsyncMock(return_value=assistant.ReplyUnderstanding(
        **{**OUTPUT, "warnings": ["付款条款待核对"]},
    )))
    assert client.post(URL + "/reply-assistant", json={
        "action": "draft", "authorize_one_reply": True,
    }).json()["generationToken"] is None


@pytest.mark.parametrize("data,action", [
    ({**CONTEXT, "message": {**MAIL, "matchedOpportunityId": None}}, "draft"),
    ({**CONTEXT, "existingReply": {"draftId": "saved"}}, "draft"),
    (CONTEXT, "summarize"),
])
def test_unmatched_saved_or_summary_only_never_authorize(client, data, action):
    client.app.state.backlinks_gateway.forward.return_value = JSONResponse(data)
    result = client.post(URL + "/reply-assistant", json={
        "action": action, "authorize_one_reply": True,
    })
    assert result.status_code == 200
    assert result.json()["generationToken"] is None
    assert client.app.state.backlinks_gateway.forward.call_count == 1


def test_manual_send_requires_confirmation_and_write_role(client):
    assert client.post(URL + "/reply-send", json={**PAYLOAD, "confirmed": False}).status_code == 422
    client.app.state.platform_context_resolver.resolve.return_value = replace(
        RESOLVED, actor=replace(RESOLVED.actor, roles=("viewer",)),
    )
    assert client.post(URL + "/reply-send", json={**PAYLOAD, "confirmed": True}).status_code == 403
    assert client.post(URL + "/reply-assistant", json={"action": "draft"}).status_code == 403
    assert client.app.state.backlinks_gateway.forward.call_count == 0


def test_gateway_and_model_failures_do_not_send(client, monkeypatch):
    client.app.state.backlinks_gateway.forward.return_value = JSONResponse({"detail": "not found"}, status_code=404)
    assert client.post(URL + "/reply-assistant", json={"action": "draft"}).status_code == 404
    routes.assist_reply.assert_not_called()
    client.app.state.backlinks_gateway.forward.return_value = JSONResponse(CONTEXT)
    monkeypatch.setattr(routes, "assist_reply", AsyncMock(side_effect=RuntimeError("private provider error")))
    response = client.post(URL + "/reply-assistant", json={"action": "draft", "authorize_one_reply": True})
    assert response.status_code == 503
    assert "private" not in response.text


def test_signed_consent_expires_and_cannot_cross_sessions():
    fingerprint = assistant.reply_fingerprint(RESOLVED, MESSAGE, PAYLOAD)
    token = assistant.issue_one_reply_token("key", fingerprint, now=1000)
    assert assistant.verify_one_reply_token("key", fingerprint, token, now=1001)
    assert not assistant.verify_one_reply_token("key", fingerprint, token, now=1601)
    other = replace(RESOLVED, actor=replace(RESOLVED.actor, session_id="other"))
    assert not assistant.verify_one_reply_token("key", assistant.reply_fingerprint(other, MESSAGE, PAYLOAD), token, now=1001)
    assert not assistant.verify_one_reply_token("key", fingerprint, None, now=1001)


def test_model_is_explicit_gpt55_and_portuguese_evidence_is_preserved(monkeypatch):
    @dataclass
    class Record:
        model: str = "different-default"
        api_key: str = "secret-test"
    gateway = SimpleNamespace(
        _effective_record=AsyncMock(return_value=Record()),
        _request_with_connection_retries=AsyncMock(return_value={
            "choices": [{"message": {"content": json.dumps(OUTPUT)}}],
        }),
    )
    monkeypatch.setattr(assistant, "ModelGateway", lambda **kwargs: gateway)
    result = asyncio.run(assistant.assist_reply(CONTEXT, assistant.ReplyAssistInput(action="draft"), "org"))
    call = gateway._request_with_connection_retries.call_args
    assert call.args[0].model == "gpt-5.5"
    assert "R$ 500" in call.args[1][1]["content"]
    assert "untrusted DATA" in call.args[1][0]["content"]
    assert result.body == OUTPUT["body"]


def test_selected_mail_is_never_truncated_or_replaced_with_later_messages():
    request = assistant.ReplyAssistInput(action="summarize")
    evidence = assistant.assistant_evidence({
        **CONTEXT, "thread": {"messages": [MAIL, {**MAIL, "id": "later"}]},
    }, request)
    assert evidence["conversation"] == []
    with pytest.raises(ValueError, match="TOO_LARGE"):
        assistant.assistant_evidence({
            **CONTEXT, "message": {**MAIL, "body": {"plainText": "x" * 100_001}},
        }, request)
