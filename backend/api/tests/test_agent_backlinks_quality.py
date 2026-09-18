"""Real rollback-only review receipts with synthetic model and Core responses."""
import asyncio
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.modules.agent.backlinks_consent import ConsentError
from app.modules.agent.backlinks_quality import BacklinksQuality, QualityChecks, QualityOutput
from app.modules.agent.models import AgentBacklinksQualityReview
from test_agent_backlinks_drafts import CONTEXT
from test_agent_backlinks_send_batch import harness, identifier


@pytest.mark.parametrize("code,expected,retryable", [
    ("model_provider_timeout", "AI_REVIEW_PROVIDER_TIMEOUT", True),
    ("model_provider_unavailable", "AI_REVIEW_PROVIDER_UNAVAILABLE", True),
    ("model_provider_auth_failed", "AI_REVIEW_PROVIDER_AUTH_FAILED", False),
    ("model_provider_request_rejected", "AI_REVIEW_PROVIDER_REQUEST_REJECTED", False),
    ("model_context_overflow", "AI_REVIEW_INPUT_TOO_LARGE", False),
    ("secret_unknown_code", "AI_REVIEW_INTERNAL_ERROR", False),
])
def test_review_error_diagnostics_are_safe_and_retry_only_recoverable_errors(code, expected, retryable):
    from app.modules.agent.backlinks_quality import review_failure
    from app.modules.agent.model_gateway import AgentModelRequestError
    report = review_failure(AgentModelRequestError(
        "secret provider text", error_code=code, retryable=False,
    ))
    assert report["diagnosticCode"] == expected
    assert report["retryable"] is retryable
    assert "secret" not in str(report)


def test_timeout_retry_replaces_error_receipt_without_changing_draft(monkeypatch):
    monkeypatch.setattr(BacklinksQuality, "project_evidence", AsyncMock(return_value={
        "domain": "project.test", "profile": {"description": "Project"},
    }))
    async def check(store, consent, core, request):
        ids = [identifier(0)]
        reviewer = AsyncMock(side_effect=[TimeoutError("secret"), (verdicts(ids), {})])
        quality = BacklinksQuality(store, reviewer=reviewer)
        first = (await quality.evaluate(CONTEXT, consent, ids))["items"][0]
        assert first["state"] == "ERROR" and first["retryable"] is True
        assert (await quality.evaluate(CONTEXT, consent, ids))["items"][0] == first
        second = (await quality.evaluate(CONTEXT, consent, ids, retry=True))["items"][0]
        assert second["state"] == "PASSED"
        assert first["version_id"] == second["version_id"]
        assert first["fingerprint"] == second["fingerprint"]
        assert reviewer.await_count == 2
        assert not core.sent
    asyncio.run(harness(check))


def test_model_contract_is_factual_and_english_only(monkeypatch):
    from app.modules.agent import model_gateway
    from app.modules.agent.backlinks_quality import model_review

    response = {"choices": [{"message": {"content": verdicts(["draft"]).model_dump_json()}}]}
    request = AsyncMock(return_value=response)
    monkeypatch.setattr(model_gateway.ModelGateway, "_effective_record", AsyncMock(
        return_value=SimpleNamespace(api_key="secret", model="test"),
    ))
    monkeypatch.setattr(model_gateway.ModelGateway, "_request_with_connection_retries", request)
    asyncio.run(model_review([{"draft_id": "draft"}], "org"))
    prompt = request.call_args.args[1][0]["content"]
    assert "NOT partnership suitability" in prompt
    assert "missing website details alone are not a reason to fail" in prompt
    assert "entire subject and body" in prompt
    assert "non-English sentences even when written in Latin letters" in prompt
    assert "regardless of the drafting request's language" in prompt
    assert "An unsupported role or team description" in prompt
    assert "A wrong person, email address or website identity must fail" in prompt
    assert "website_relevance" not in QualityChecks.model_fields
    assert "language_and_tone" not in QualityChecks.model_fields
    assert {"website_accuracy", "english_only"} <= QualityChecks.model_fields.keys()


@pytest.mark.parametrize("failed_check", ["english_only", "website_accuracy"])
def test_language_or_incorrect_website_facts_block_approval(monkeypatch, failed_check):
    monkeypatch.setattr(BacklinksQuality, "project_evidence", AsyncMock(return_value={
        "domain": "project.test", "profile": {"description": "Project"},
    }))
    async def check(store, consent, core, request):
        ids = [identifier(0)]
        output = verdicts(ids)
        setattr(output.items[0].checks, failed_check, False)
        quality = BacklinksQuality(store, reviewer=AsyncMock(return_value=(output, {})))
        result = await quality.evaluate(CONTEXT, consent, ids)
        assert result["items"][0]["state"] == "BLOCKED"
        with pytest.raises(ConsentError, match="QUALITY_REVIEW_REQUIRED"):
            await quality.require_pass(CONTEXT, consent, ids[0])
        assert not core.sent
    asyncio.run(harness(check))


def test_policy_change_invalidates_old_receipts(monkeypatch):
    from app.modules.agent import backlinks_quality as module
    monkeypatch.setattr(BacklinksQuality, "project_evidence", AsyncMock(return_value={
        "domain": "project.test", "profile": {"description": "Project"},
    }))
    async def check(store, consent, core, request):
        ids = [identifier(0)]
        reviewer = AsyncMock(return_value=(verdicts(ids), {}))
        quality = BacklinksQuality(store, reviewer=reviewer)
        await quality.evaluate(CONTEXT, consent, ids)
        monkeypatch.setattr(module, "POLICY", "outreach-quality.next")
        assert (await quality.reports(CONTEXT, consent))[ids[0]]["state"] == "STALE"
        with pytest.raises(ConsentError, match="QUALITY_REVIEW_REQUIRED"):
            await quality.require_pass(CONTEXT, consent, ids[0])
        result = await quality.evaluate(CONTEXT, consent, ids)
        assert result["items"][0]["state"] == "PASSED"
        assert reviewer.await_count == 2
        assert not core.sent
    asyncio.run(harness(check))


def verdicts(ids, *, blocked=None):
    return QualityOutput.model_validate({"items": [{
        "draft_id": id, "reasons": ["Mismatch" if id == blocked else "Evidence matches"],
        "checks": {key: not (id == blocked and key == "project_accuracy")
                   for key in QualityChecks.model_fields},
    } for id in ids]})


@pytest.mark.parametrize("case", ["pass", "partial", "failure", "wrong_ids", "invalid_boolean"])
def test_review_is_persisted_fail_closed_and_cached(monkeypatch, case):
    monkeypatch.setattr(BacklinksQuality, "project_evidence", AsyncMock(return_value={
        "domain": "project.test", "profile": {"description": "Project"},
    }))
    async def check(store, consent, core, request):
        ids = [identifier(0), identifier(1)]
        reviewer = AsyncMock(return_value=(
            verdicts(ids, blocked=ids[1] if case == "partial" else None), {"model": "fake"},
        ))
        if case == "failure":
            reviewer.side_effect = RuntimeError("secret provider error")
        if case == "wrong_ids":
            reviewer.return_value = (verdicts([identifier("outside")]), {})
        if case == "invalid_boolean":
            result = verdicts(ids).model_dump()
            result["items"][0]["checks"]["project_accuracy"] = "true"
            reviewer.return_value = (result, {})
        quality = BacklinksQuality(store, reviewer=reviewer)
        result = await quality.evaluate(CONTEXT, consent, ids)
        assert not core.sent
        assert all("/approve" not in str(call.url) for call in core.calls)
        expected = ["PASSED", "BLOCKED"] if case == "partial" else (
            ["PASSED"] * 2 if case == "pass" else ["ERROR"] * 2
        )
        assert [item["state"] for item in result["items"]] == expected
        if case == "failure":
            assert all(item["retryable"] is False for item in result["items"])
            assert all(item["diagnosticCode"] == "AI_REVIEW_INTERNAL_ERROR" for item in result["items"])
        assert "secret" not in str(result)
        assert await quality.evaluate(CONTEXT, consent, ids) == result
        assert reviewer.await_count == 1
        if case in {"pass", "partial"}:
            await quality.require_pass(CONTEXT, consent, ids[0])
        else:
            with pytest.raises(ConsentError, match="QUALITY_REVIEW_REQUIRED"):
                await quality.require_pass(CONTEXT, consent, ids[0])
            reviewer.side_effect = None
            reviewer.return_value = (verdicts(ids), {})
            retried = await quality.evaluate(CONTEXT, consent, ids, retry=True)
            assert all(item["state"] == "PASSED" for item in retried["items"])
    asyncio.run(harness(check))


@pytest.mark.parametrize("change", ["recipient", "project", "expiry"])
def test_changed_evidence_and_expired_reviews_cannot_send(monkeypatch, change):
    evidence = AsyncMock(return_value={"domain": "project.test", "profile": {"description": "Original"}})
    monkeypatch.setattr(BacklinksQuality, "project_evidence", evidence)
    async def check(store, consent, core, request):
        ids = [identifier(0)]
        reviewer = AsyncMock(return_value=(verdicts(ids), {}))
        quality = BacklinksQuality(store, reviewer=reviewer)
        await quality.evaluate(CONTEXT, consent, ids)
        if change == "recipient":
            core.duplicate = True
        elif change == "project":
            evidence.return_value = {"domain": "other.test", "profile": {"description": "Changed"}}
        else:
            async with store.sessions() as session, session.begin():
                row = await session.scalar(select(AgentBacklinksQualityReview))
                row.created_at = datetime.now(UTC) - timedelta(hours=25)
            report = await quality.evaluate(CONTEXT, consent, ids)
            assert report["items"][0]["state"] == "STALE"
        with pytest.raises(ConsentError, match="QUALITY_REVIEW_REQUIRED"):
            await quality.require_pass(CONTEXT, consent, ids[0])
        assert not core.sent and reviewer.await_count == 1
    asyncio.run(harness(check))
