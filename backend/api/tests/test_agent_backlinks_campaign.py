import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4
import pytest
from pydantic import ValidationError

from test_agent_backlinks_drafts import ARGS, CONTEXT
from app.modules.agent import backlinks_campaign as module


def test_new_campaign_requires_request():
    with pytest.raises(ValidationError):
        module.StartCampaignArgs.model_validate({})


@pytest.mark.parametrize("explicit", [False, True])
def test_resume_uses_saved_policy_without_rewriting_explicit_arguments(monkeypatch, explicit):
    async def check():
        policy = {"draft_request": ARGS["request"], "recommendation_mode": "current",
                  "send_authorized": True, "policy_version": "backlinks-chat-campaign.v1"}
        starter = AsyncMock(return_value={"run_id": "original"})
        monkeypatch.setattr(module, "BacklinksContinuationStore",
                            lambda sessions: SimpleNamespace(start=starter))
        getter = AsyncMock(return_value={"policy": policy})
        monkeypatch.setattr(module, "BacklinksConsentStore",
                            lambda sessions: SimpleNamespace(get=getter))
        reader = SimpleNamespace(resolve_write_context=AsyncMock(return_value=CONTEXT))
        consent = str(uuid4())
        args = {"consent_id": consent}
        if explicit:
            args["recommendation_mode"] = "next_batch"
            args["request"] = ARGS["request"]
        result = await module.BacklinksCampaign(reader, None, {}).start("p", "o", None, args)
        getter.assert_awaited_once_with(CONTEXT, consent)
        expected = module.DraftRequest.model_validate(ARGS["request"]).model_dump(mode="json") if explicit else ARGS["request"]
        assert starter.await_args.args[2] == expected
        assert starter.await_args.kwargs["recommendation_mode"] == (
            "next_batch" if explicit else "current"
        )
        assert result["sending_allowed"] is True
        assert result["authorization_policy"] == policy
    asyncio.run(check())


def test_campaign_only_reuses_scoped_durable_start(monkeypatch):
    async def check():
        starter = AsyncMock(return_value={"run_id": "run"})
        monkeypatch.setattr(module, "BacklinksContinuationStore",
                            lambda sessions: SimpleNamespace(start=starter))
        reader = SimpleNamespace(resolve_write_context=AsyncMock(return_value=CONTEXT))
        monkeypatch.setattr(module, "BacklinksConsentStore", lambda sessions:
                            SimpleNamespace(get=AsyncMock(return_value={"policy": {}})))
        consent = str(uuid4())
        result = await module.BacklinksCampaign(reader, "sessions", {}).start(
            "project", "org", "delegation", {"consent_id": consent, "request": ARGS["request"]},
        )
        assert result["run_id"] == "run"
        assert result["verified"] is True
        assert result["sending_allowed"] is False
        assert [call.kwargs["write"] for call in reader.resolve_write_context.await_args_list] == [True, False]
        assert starter.await_args.args[1] == consent
        assert starter.await_args.kwargs == {"recommendation_mode": "next_batch"}
    asyncio.run(check())


def test_resume_reads_consent_with_separately_authorized_read_context(monkeypatch):
    async def check():
        write_context = replace(CONTEXT, permissions=("backlinks:write",))
        read_context = replace(CONTEXT, permissions=("backlinks:read",))
        starter = AsyncMock(return_value={"run_id": "original"})
        monkeypatch.setattr(module, "BacklinksContinuationStore",
                            lambda sessions: SimpleNamespace(start=starter))

        async def get(context, consent_id):
            if "backlinks:read" not in context.permissions:
                raise module.ConsentError("BACKLINKS_CONSENT_PERMISSION_DENIED")
            return {"policy": {"draft_request": ARGS["request"], "recommendation_mode": "current"}}

        monkeypatch.setattr(module, "BacklinksConsentStore",
                            lambda sessions: SimpleNamespace(get=get))
        reader = SimpleNamespace(resolve_write_context=AsyncMock(
            side_effect=[write_context, read_context],
        ))
        result = await module.BacklinksCampaign(reader, None, {}).start("p", "o", None, {
            "consent_id": str(uuid4()),
        })
        assert result["run_id"] == "original"
        assert starter.await_args.args[0] == write_context
    asyncio.run(check())


def test_resume_does_not_start_when_read_authority_is_denied(monkeypatch):
    async def check():
        starter = AsyncMock()
        monkeypatch.setattr(module, "BacklinksContinuationStore",
                            lambda sessions: SimpleNamespace(start=starter))
        reader = SimpleNamespace(resolve_write_context=AsyncMock(side_effect=[
            replace(CONTEXT, permissions=("backlinks:write",)),
            module.ConsentError("BACKLINKS_AGENT_PERMISSION_DENIED"),
        ]))
        with pytest.raises(module.ConsentError, match="PERMISSION_DENIED"):
            await module.BacklinksCampaign(reader, None, {}).start("p", "o", None, {
                "consent_id": str(uuid4()),
            })
        starter.assert_not_awaited()
    asyncio.run(check())


@pytest.mark.parametrize("required, supplied", [(True, False), (False, True)])
def test_resume_cannot_change_persisted_seo_requirement(monkeypatch, required, supplied):
    async def check():
        starter = AsyncMock()
        monkeypatch.setattr(module, "BacklinksContinuationStore",
                            lambda sessions: SimpleNamespace(start=starter))
        monkeypatch.setattr(module, "BacklinksConsentStore", lambda sessions:
                            SimpleNamespace(get=AsyncMock(return_value={"policy": {
                                "draft_request": ARGS["request"],
                                "require_seo_metrics": required,
                            }})))
        reader = SimpleNamespace(resolve_write_context=AsyncMock(return_value=CONTEXT))
        with pytest.raises(module.ConsentError, match="AUTHORIZATION_CHANGED"):
            await module.BacklinksCampaign(reader, None, {}).start("p", "o", None, {
                "consent_id": str(uuid4()), "require_seo_metrics": supplied,
            })
        starter.assert_not_awaited()
    asyncio.run(check())


def test_campaign_status_does_not_call_mail_a_batch_reply(monkeypatch):
    async def check():
        monkeypatch.setattr(module, "BacklinksConsentStore", lambda sessions:
                            SimpleNamespace(get=AsyncMock(return_value={
                                "policy": {"policy_version": "backlinks-drafts-only.v1"},
                            })))
        monkeypatch.setattr(module, "BacklinksContinuationStore", lambda sessions:
                            SimpleNamespace(get=AsyncMock(return_value={"status": "completed"})))
        monkeypatch.setattr(module, "BacklinksSendBatchStore", lambda *args, **kwargs:
                            SimpleNamespace(list=AsyncMock(return_value={"items": []})))
        reader = SimpleNamespace(settings=None, gateway=None,
            resolve_write_context=AsyncMock(return_value=CONTEXT),
            read=AsyncMock(side_effect=[
                {"data": {"connection": {"connectionId": "connection"}}},
                {"data": {"items": []}}, {"data": {"status": "DISABLED"}},
            ]))
        result = await module.BacklinksCampaign(reader, None, {}).status("p", "o", None, str(uuid4()))
        assert result["mail_monitoring"]["sync"]["data"]["status"] == "DISABLED"
        assert "not batch-only" in result["next"] and "not an empty inbox" in result["next"]
        assert reader.read.await_count == 3
    asyncio.run(check())
