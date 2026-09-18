"""Rollback-only repair -> approval -> queue acceptance; no real providers."""
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from app.modules.agent import backlinks_quality, backlinks_quality_repair
from app.modules.agent.activities import tool_summary
from app.modules.agent.backlinks_consent import ConsentError
from app.modules.agent.backlinks_quality import BacklinksQuality, QualityChecks, QualityOutput
from app.modules.agent.backlinks_quality_repair import BacklinksQualityRepair, RepairedEmail
from test_agent_backlinks_chat_send import ARGS, service_for, submit
from test_agent_backlinks_drafts import CONTEXT, META
from test_agent_backlinks_send_batch import Core, harness, identifier, no_network


@pytest.fixture(autouse=True)
def editable(monkeypatch):
    monkeypatch.setattr(BacklinksQuality, "project_evidence", AsyncMock(return_value={
        "domain": "project.test", "profile": {"description": "An Android streaming app"},
    }))
    original = Core.respond

    def respond(core, request):
        if not hasattr(core, "versions"):
            core.versions, core.approvals, core.edits = {}, set(), []
        path = request.url.path.split("/backlinks/")[1]
        draft_id = path.split("/")[1] if "/" in path else ""
        if path.endswith("/versions"):
            core.calls.append(request)
            body = json.loads(request.content)
            current = core.versions.get(draft_id, {"draftVersion": 2})
            assert body["expectedVersion"] == current["draftVersion"]
            number = current["draftVersion"] + 1
            core.versions[draft_id] = {
                "draftVersion": number,
                "currentVersion": {"id": identifier(f"{draft_id}:repair:{number}"),
                                   "subjectText": body["subjectText"],
                                   "bodyText": "\n\n".join(
                                       p["content"][0]["text"] for p in body["bodyDocument"]["content"]
                                   )},
            }
            core.edits.append(draft_id)
            if getattr(core, "lost_write", False):
                core.lost_write = False
                raise httpx.ReadTimeout("Response lost after save")
            return httpx.Response(201, json={
                "draftId": draft_id, "versionId": core.versions[draft_id]["currentVersion"]["id"],
                "draftVersion": number, "status": "draft", "meta": META,
            })
        if path.endswith("/approve"):
            core.calls.append(request)
            core.approvals.add(draft_id)
            return httpx.Response(200, json={"meta": META, "versionId":
                core.versions.get(draft_id, {}).get("currentVersion", {}).get(
                    "id", identifier("version:" + draft_id),
                )})
        core.approved = draft_id in core.approvals
        response = original(core, request)
        data = json.loads(response.content)
        if "draft" in data:
            draft = data["draft"]
            draft.update({"status": "draft", "draftVersion": 2})
            draft.update(core.versions.get(draft_id, {}))
            draft["approvedVersionId"] = draft["currentVersion"]["id"] if core.approved else None
            if core.approved:
                draft["draftVersion"] += 1
                draft["status"] = "approved"
            return httpx.Response(200, json=data)
        return response
    monkeypatch.setattr(Core, "respond", respond)


def reviewer(*, failed="factual_support", always=False):
    async def review(evidence, org):
        return QualityOutput.model_validate({"items": [{
            "draft_id": item["draft_id"], "reasons": ["Unsupported claim"],
            "checks": {key: not (key == failed and (always or item["body"] == "Body"))
                       for key in QualityChecks.model_fields},
        } for item in evidence]}), {"model": "fixture"}
    return AsyncMock(side_effect=review)


def install_repair(monkeypatch, repair):
    async def batch(data, org):
        items = []
        for entry in data:
            email, _ = await repair(entry["evidence"], entry["review_reasons"], org)
            items.append({**email.model_dump(), "draft_id": entry["evidence"]["draft_id"]})
        return {"items": items}, {}
    monkeypatch.setattr(backlinks_quality_repair, "model_repair_batch", batch)


@pytest.mark.parametrize("failed", ["factual_support", "english_only", "website_accuracy", "project_accuracy"])
def test_missing_site_evidence_or_language_is_repaired_without_crawl_then_exact_version_queued(monkeypatch, failed):
    review = reviewer(failed=failed)
    repair = AsyncMock(return_value=(RepairedEmail(
        subject="Cooperation inquiry", body="Hello,\n\nWould you be open to discussing cooperation?",
    ), {}))
    monkeypatch.setattr(backlinks_quality, "model_review", review)
    install_repair(monkeypatch, repair)

    async def check(store, consent, core, request):
        service, run_id = await service_for(store)
        result = await submit(service, run_id)
        assert result["batch"]["state"] == "queued"
        assert len(core.edits) == 2 and len(core.approvals) == 2
        for item in result["batch"]["items"]:
            target = item["target"]
            assert target["approvedDraftVersionId"] == core.versions[target["draftId"]]["currentVersion"]["id"]
        assert repair.await_count == 2 and review.await_count == 2
        assert not core.sent
        assert all("/crawl" not in str(call.url) for call in core.calls)
        again = await submit(service, run_id)
        assert again["batch"]["id"] == result["batch"]["id"]
        assert len(core.edits) == 2 and repair.await_count == 2
    asyncio.run(harness(check))


def test_two_round_limit_and_one_bad_draft_does_not_block_other(monkeypatch):
    review = reviewer(always=True)

    async def mixed(evidence, org):
        output, meta = await review(evidence, org)
        for item in output.items:
            if item.draft_id == identifier(1):
                item.checks.factual_support = True
        return output, meta
    counter = 0

    async def repair(*args):
        nonlocal counter
        counter += 1
        return RepairedEmail(subject="Cooperation", body=f"Repaired attempt {counter}"), {}
    monkeypatch.setattr(backlinks_quality, "model_review", mixed)
    install_repair(monkeypatch, repair)

    async def check(store, consent, core, request):
        service, run_id = await service_for(store)
        result = await submit(service, run_id)
        assert core.edits == [identifier(0)] * 2 and counter == 2
        assert core.approvals == {identifier(1)}
        assert len(result["batch"]["items"]) == 1 and not core.sent
        assert result["quality_review"]["items"][0]["state"] == "BLOCKED"
    asyncio.run(harness(check))


def test_recipient_mismatch_is_never_rewritten(monkeypatch):
    monkeypatch.setattr(backlinks_quality, "model_review", reviewer(failed="recipient_match", always=True))
    repair = AsyncMock(side_effect=AssertionError("Recipient mismatch must not be repaired"))
    install_repair(monkeypatch, repair)

    async def check(store, consent, core, request):
        service, run_id = await service_for(store)
        result = await submit(service, run_id)
        assert result["batch"] is None and not core.edits and not core.approvals
        repair.assert_not_awaited()
        assert "未创建发送队列" in tool_summary("send_backlink_drafts", result)
    asyncio.run(harness(check))


@pytest.mark.parametrize("budget", ["2", "0.15"])
def test_completed_campaign_repairs_original_draft_with_per_call_budget(monkeypatch, budget):
    from decimal import Decimal
    from sqlalchemy import select
    from app.modules.agent.backlinks_continuation import initial_checkpoint
    from app.modules.agent.backlinks_continuation_store import BacklinksContinuationStore
    from app.modules.agent.models import AgentBacklinksConsent, AgentBacklinksContinuation, AgentRun
    from test_agent_backlinks_drafts import ARGS as DRAFT_ARGS
    from test_agent_backlinks_send import ACCOUNT

    original = Core.respond

    def respond(core, request):
        if request.url.path.endswith("/automation-budget"):
            return httpx.Response(200, json={
                "draftModelReservationUsd": "0.1", "accounting": "conservative_reservations",
                "meta": {**META, "schemaVersion": "backlinks.automation-budget.v1"},
            })
        return original(core, request)

    monkeypatch.setattr(Core, "respond", respond)
    review = reviewer()
    monkeypatch.setattr(backlinks_quality, "model_review", review)
    repair = AsyncMock(return_value=(RepairedEmail(
        subject="Cooperation inquiry", body="Hello,\n\nWould you be open to discussing cooperation?",
    ), {}))
    install_repair(monkeypatch, repair)

    async def check(store, consent_id, core, request):
        async with store.sessions() as session, session.begin():
            consent = await session.get(AgentBacklinksConsent, consent_id)
            consent.policy_json = {
                **consent.policy_json, "policy_version": "backlinks-chat-campaign.v1",
                "draft_request": DRAFT_ARGS["request"], "recommendation_mode": "current",
                "send_authorized": True, "gmail_connection_id": str(ACCOUNT),
                "max_model_cost_usd": budget,
            }
            record = await session.scalar(select(AgentBacklinksContinuation).where(
                AgentBacklinksContinuation.consent_id == consent_id,
            ))
            run = await session.get(AgentRun, record.run_id)
            run.status = "completed"
            run_id = run.id
            state = initial_checkpoint()
            state.update(stage="done", send_batch={"state": "NO_PASSING_DRAFTS"},
                         results=[{"state": "VERIFIED_DRAFT", "draftId": identifier(0),
                                   "opportunityId": identifier(0)}])
            state["usage"].update(drafts=1, opportunities=1)
            record.checkpoint_json = state
        continuation = BacklinksContinuationStore(store.sessions)
        resumed = await continuation.start(CONTEXT, consent_id, DRAFT_ARGS["request"], {})
        assert resumed["run_id"] == run_id
        assert (await continuation.tick(run_id, store.settings, gateway=store.gateway))["done"]
        result = (await continuation.get(CONTEXT, consent_id))["checkpoint"]
        assert result["usage"]["drafts"] == result["usage"]["opportunities"] == 1
        assert Decimal(result["usage"]["model_usd"]) <= Decimal(budget)
        if budget == "2":
            assert result["send_batch"]["state"] == "queued"
            assert core.edits == [identifier(0)]
            assert repair.await_count == 1 and review.await_count == 2
            assert result["usage"]["model_usd"] == "0.3"
            batch = (await store.list(CONTEXT, consent_id))["items"][0]
            assert batch["items"][0]["target"]["approvedDraftVersionId"] == (
                core.versions[identifier(0)]["currentVersion"]["id"]
            )
        else:
            repair.assert_not_awaited()
            assert result["send_batch"]["state"] == "NO_PASSING_DRAFTS"
            assert result["results"][0]["quality"]["reasons"] == ["MODEL_BUDGET_LIMIT"]
            assert not core.edits and not core.approvals
        assert not core.sent
        again = await continuation.start(CONTEXT, consent_id, DRAFT_ARGS["request"], {})
        assert again["status"] == "completed"
    asyncio.run(harness(check))


def test_lost_save_response_recovers_without_second_edit_or_model_call(monkeypatch):
    monkeypatch.setattr(backlinks_quality, "model_review", reviewer())
    repair = AsyncMock(return_value=(RepairedEmail(subject="Cooperation", body="A factual inquiry."), {}))
    install_repair(monkeypatch, repair)

    async def check(store, consent, core, request):
        service, run_id = await service_for(store)
        core.lost_write = True
        args = {**ARGS, "items": ARGS["items"][:1]}
        first = await submit(service, run_id, args)
        assert first["batch"] is None and len(core.edits) == 1
        second = await submit(service, run_id, args)
        assert second["batch"]["state"] == "queued"
        assert len(core.edits) == 1 and repair.await_count == 1 and not core.sent
    asyncio.run(harness(check))


def test_concurrent_user_edit_is_not_overwritten_or_approved(monkeypatch):
    monkeypatch.setattr(backlinks_quality, "model_review", reviewer())

    async def check(store, consent, core, request):
        async def repair(*args):
            core.versions[identifier(0)] = {
                "draftVersion": 3, "currentVersion": {"id": identifier("user-edit"),
                                                    "subjectText": "User", "bodyText": "User edit"},
            }
            return RepairedEmail(subject="Cooperation", body="A factual inquiry."), {}
        install_repair(monkeypatch, repair)
        service, run_id = await service_for(store)
        result = await submit(service, run_id, {**ARGS, "items": ARGS["items"][:1]})
        assert result["batch"] is None and not core.edits and not core.approvals
        assert result["quality_review"]["items"][0]["state"] == "ERROR"
    asyncio.run(harness(check))


def test_model_failure_does_not_expose_error_or_approve(monkeypatch):
    monkeypatch.setattr(backlinks_quality, "model_review", reviewer())
    install_repair(monkeypatch, AsyncMock(side_effect=RuntimeError("provider secret")))

    async def check(store, consent, core, request):
        service, run_id = await service_for(store)
        result = await submit(service, run_id)
        assert result["batch"] is None and not core.edits and not core.approvals
        assert all(i["state"] == "ERROR" for i in result["quality_review"]["items"])
        assert "provider secret" not in str(result)
    asyncio.run(harness(check))


def test_batch_repair_uses_one_call_and_rejects_wrong_ids(monkeypatch):
    from types import SimpleNamespace
    from app.modules.agent import model_gateway
    response = {"choices": [{"message": {"content": json.dumps({"items": [
        {"draft_id": id, "subject": "Cooperation", "body": "Hello, may we discuss cooperation?"}
        for id in ("a", "b")
    ]})}}]}
    request = AsyncMock(return_value=response)
    monkeypatch.setattr(model_gateway.ModelGateway, "_effective_record", AsyncMock(
        return_value=SimpleNamespace(api_key="secret", model="fixture"),
    ))
    monkeypatch.setattr(model_gateway.ModelGateway, "_request_with_connection_retries", request)
    data = [{"evidence": {"draft_id": id}, "review_reasons": ["Unsupported"]} for id in ("a", "b")]
    result, _ = asyncio.run(backlinks_quality_repair.model_repair_batch(data, "org"))
    assert len(result.items) == 2 and request.await_count == 1
    prompt = request.call_args.args[1][0]["content"]
    assert "crawling failed" in prompt and "Preserve opt-out" in prompt
    with pytest.raises(ValueError, match="IDS_MISMATCH"):
        asyncio.run(backlinks_quality_repair.model_repair_batch(data[:1], "org"))


def test_explicit_retry_does_not_reset_two_attempt_budget(monkeypatch):
    review = reviewer()
    repair = AsyncMock(side_effect=RuntimeError("Unavailable"))
    install_repair(monkeypatch, repair)
    monkeypatch.setattr(backlinks_quality, "model_review", review)

    async def check(store, consent, core, request):
        quality = BacklinksQualityRepair(store)
        ids = [identifier(0)]
        await quality.evaluate(CONTEXT, consent, ids)
        await quality.evaluate(CONTEXT, consent, ids, retry=True)
        await quality.evaluate(CONTEXT, consent, ids, retry=True)
        assert repair.await_count == 2
        assert not core.edits and not core.sent
    asyncio.run(harness(check))
