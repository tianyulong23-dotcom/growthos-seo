"""Synthetic HTTP and rollback-only database checks. Never contact providers."""

import asyncio
import json
import os
import runpy
from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import NAMESPACE_URL, uuid4, uuid5

import httpx
import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import FastAPI
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from test_agent_backlinks_drafts import ARGS, CONTEXT, META, SETTINGS, Projects

from app.api.routes import agent_backlinks_consent as consent_routes
from app.core.backlinks_gateway import BacklinksGateway
from app.db.base import Base
from app.modules.agent.backlinks_consent import BacklinksConsentStore, ConsentError, ConsentRequest
from app.modules.agent.backlinks_continuation import ContinuationStep, initial_checkpoint
from app.modules.agent.backlinks_continuation_store import BacklinksContinuationStore
from app.modules.agent.backlinks_drafts import BacklinksDrafts
from app.modules.agent.backlinks_pipeline import BacklinksPipeline
from app.modules.agent.backlinks_read import BacklinksReader
from app.modules.agent.models import (
    AgentBacklinksContinuation,
    AgentConversation,
    AgentMessage,
    AgentRun,
    AgentSystemTrigger,
    AgentToolExecution,
    AgentWorkflowDispatch,
)
from app.modules.projects.models import Project

POLICY = {
    "policy_version": "backlinks-drafts-only.v1", "max_opportunities": 10, "max_drafts": 5,
    "max_model_cost_usd": "2", "max_paid_tool_cost_usd": "2",
}
GEN = str(uuid5(NAMESPACE_URL, "continuation:generation"))


def identifier(value):
    return str(uuid5(NAMESPACE_URL, str(value)))


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    async def blocked(*args, **kwargs):
        raise AssertionError("Real HTTP is forbidden")
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked)


class Core:
    def __init__(self):
        self.calls = []
        self.latest = None
        self.job_status = "QUEUED"
        self.job_details = {}
        self.fresh = True
        self.confirmed = True
        self.fail_post = None
        self.quote = "0.1"
        self.pages = None
        self.job_draft_mismatch = False
        self.next_batch_state = "RELEASED"
        self.generation = GEN
        self.batch_ordinal = 2
        self.existing_opportunity = False

    def respond(self, request):
        self.calls.append(request)
        path = request.url.path.split("/backlinks/")[1]
        assert not any(word in path for word in ("send", "approve", "gmail"))
        meta = dict(META)
        if request.method == "POST" and self.fail_post == path:
            return httpx.Response(503)
        if path == "recommendation-feed":
            meta["schemaVersion"] = "backlinks.recommendation-feed.v2"
            page = self.pages or {
                "items": [
                    {"itemId": identifier(i), "recommended": True,
                     "contact": {"email": "editor@example.test" if i < 2 else None}}
                    for i in range(3)
                ] if self.latest else [],
                "nextCursor": None,
            }
            if request.url.params.get("batchId") == identifier("new-batch"):
                page = {"items": [{"itemId": identifier("new-item"), "recommended": True,
                                   "contact": {"email": "editor@example.test"}}],
                        "nextCursor": None}
            elif request.url.params.get("batchId"):
                assert request.url.params["batchId"] == identifier("current-batch")
            batches = [{
                "batchId": identifier("new-batch"), "batchOrdinal": self.batch_ordinal,
                "visiblePoolGeneration": 3,
            }]
            if self.batch_ordinal != 1:
                batches.append({
                    "batchId": identifier("current-batch"), "batchOrdinal": 1,
                    "visiblePoolGeneration": 3,
                })
            data = {**page, "latestGeneration": self.latest,
                    "releasedPool": {"filterOptions": {"batches": batches}}, "totalCount": 3}
            data["items"] = data["items"][:int(request.url.params.get("limit", 20))]
        elif path == "automation-budget":
            meta["schemaVersion"] = "backlinks.automation-budget.v1"
            data = {"accounting": "conservative_reservations",
                    "draftModelReservationUsd": self.quote, "recommendationPaidReservationUsd": "2"}
        elif path == "recommendation-seeds/generate":
            meta["schemaVersion"] = "backlinks.recommendation-seeds.v2"
            data = {"state": "READY", "confirmation": {
                "generationContractId": self.generation, "seedSnapshotFingerprint": "a" * 64,
            }}
        elif path == "recommendation-seeds/launch":
            meta["schemaVersion"] = "backlinks.recommendation-seeds.v2"
            self.latest = {"generationContractId": self.generation, "jobState": "RUNNING", "releaseResult": "PENDING"}
            data = {"state": "STARTED", "generationContractId": self.generation, "jobId": identifier("generation-job")}
        elif path == "recommendation-user-release/publish-initial":
            meta["schemaVersion"] = "backlinks.recommendation-user-release.v2"
            data = {"state": "PUBLISHED", "currentBatchOrdinal": 1, "replayed": False}
        elif path == "recommendation-user-release/get-more":
            meta["schemaVersion"] = "backlinks.recommendation-user-release.v2"
            data = {"state": self.next_batch_state, "releasedBatchOrdinal": 2,
                    "currentBatchOrdinal": 2, "replayed": False}
        elif path == "recommendation-user-release/status":
            meta["schemaVersion"] = "backlinks.recommendation-user-release.v2"
            data = {"getMoreState": "RELEASE_NEXT" if self.next_batch_state == "RELEASED"
                    else self.next_batch_state}
        elif path == "opportunities":
            item = json.loads(request.content)["recommendationFeedItemId"]
            data = {"recommendationFeedItemId": item, "opportunityId": item,
                    "existingOpportunity": self.existing_opportunity, "contactReviewRequired": False}
            return httpx.Response(201, json={**data, "meta": meta})
        elif path.startswith("opportunities/"):
            opp = path.split("/")[1]
            if path.endswith("/contacts"):
                data = {
                    "items": [{"id": opp, "opportunityId": opp, "status": "active", "guessed": False,
                               "confirmedAt": META["generatedAt"], "version": 1,
                               "normalizedEmail": "editor@example.test"}],
                    "selection": {"state": "AUTO_SELECTED" if self.confirmed else "MANUAL_REQUIRED",
                                  "autoSelectedContactId": opp},
                }
            elif path.endswith("/draft-jobs"):
                data = {"jobId": opp, "draftId": opp, "contactId": opp,
                        "contactVersion": 1, "generationMode": "MODEL", "replayed": False}
            else:
                data = {"item": {"id": opp, "draftId": None, "managementStatus": "ACTIVE",
                                "primaryNextAction": {"kind": "CREATE_EMAIL_DRAFT", "enabled": True}}}
        elif path.startswith("draft-jobs/"):
            job = path.split("/")[1]
            data = {"job": {"id": job, "draftId": identifier("wrong") if self.job_draft_mismatch else job,
                            "status": self.job_status, **self.job_details}}
        elif path.startswith("drafts/"):
            draft = path.split("/")[1]
            data = {"draft": {
                "id": draft, "opportunityId": draft, "contactId": draft, "contactVersion": 1,
                "status": "draft", "approvedVersionId": None,
                "inputSnapshot": {"contactId": draft, "contactVersion": 1},
                "freshness": {"state": "FRESH" if self.fresh else "STALE", "regenerateRequired": False},
                "currentVersion": {"subjectText": "Subject", "bodyText": "Body",
                                   "source": "MODEL", "readiness": "AI_DRAFT_READY"},
            }}
        else:
            raise AssertionError(path)
        return httpx.Response(200, json={**data, "meta": meta})

    def release(self):
        self.latest = {"generationContractId": self.generation, "visiblePoolGeneration": 3,
                       "jobState": "SUCCESS", "releaseResult": "AVAILABLE"}
        self.job_status = "SUCCEEDED"


async def harness(check, *, policy=None):
    core, saved = Core(), []

    async def save(state):
        saved.append(deepcopy(state))

    async with httpx.AsyncClient(transport=httpx.MockTransport(core.respond)) as client:
        gateway = BacklinksGateway(base_url="http://core.test", signing_key="k" * 32, client=client)
        reader = BacklinksReader(SETTINGS, Projects(), gateway, authority=AsyncMock(return_value=CONTEXT))
        step = ContinuationStep(
            BacklinksPipeline(BacklinksDrafts(reader)), project_id="project", organization_id="org",
            run_id=identifier("run"), policy=policy or POLICY, request=ARGS["request"], save=save,
        )
        await check(core, step, saved)


async def drain(step, state, until=None):
    for _ in range(50):
        state = await step.advance(state)
        if state["stage"] in {"done", "paused", until}:
            return state
    raise AssertionError("Unbounded continuation")


@pytest.mark.parametrize("released", [False, True])
def test_existing_pool_authority_never_starts_paid_generation(released):
    async def check(core, step, saved):
        if released:
            core.release()
        state = await drain(step, initial_checkpoint())
        if released:
            assert state["stage"] == "done"
            assert len(state["results"]) == 2
        else:
            assert state["stage"] == "paused"
            assert state["reason"] == "EXISTING_RECOMMENDATIONS_UNAVAILABLE"
        assert state["usage"]["paid_usd"] == "0"
        assert not any("recommendation-seeds" in request.url.path for request in core.calls)
    asyncio.run(harness(check, policy={**POLICY, "existing_recommendations_only": True}))


@pytest.mark.parametrize("email_selection", [False, True])
def test_public_email_command_selects_unbadged_sites_and_records_skips(email_selection):
    async def check(core, step, saved):
        core.release()
        core.pages = {"items": [
            {"itemId": identifier(i), "recommended": False,
             "reasons": ["RELEVANCE_EVIDENCE_MISSING"],
             "contact": {"email": "public@example.test", "outcome": "PUBLIC_EMAIL_FOUND"},
             "metrics": {"targetMarketOrganicTraffic": 1, "dataForSeoRank": 2, "spamScore": 3},
             "opportunity": {"opportunityId": None}}
            for i in range(6)
        ], "nextCursor": None}
        core.pages["items"][1]["contact"] = {"email": None, "outcome": "CONTACT_FORM_ONLY"}
        core.pages["items"][2]["archived"] = True
        core.pages["items"][3]["opportunity"]["opportunityId"] = identifier("already-joined")
        core.pages["items"][4]["metrics"]["spamScore"] = None
        core.pages["items"][5]["contact"]["email"] = "invalid-address"
        state = await drain(step, initial_checkpoint())
        assert state["stage"] == "done"
        assert len(state["results"]) == int(email_selection)
        if email_selection:
            assert state["results"][0]["state"] == "VERIFIED_DRAFT"
            assert state["results"][0]["feedItemId"] == identifier(0)
        assert state["selection"] == {
            "scanned": 6, "eligible": int(email_selection),
            "skipped": {
                "NO_PUBLIC_EMAIL": 2, "ARCHIVED": 1, "ALREADY_JOINED": 1,
                "SEO_METRICS_MISSING": 1,
                **({} if email_selection else {"RECOMMENDATION_REQUIRED": 1}),
            },
        }
        assert state["usage"]["paid_usd"] == "0"
        assert not any("recommendation-seeds" in request.url.path for request in core.calls)
    asyncio.run(harness(check, policy={
        **POLICY, "existing_recommendations_only": True, "require_seo_metrics": True,
        "skip_existing_opportunities": True,
        **({"target_selection": "public_email"} if email_selection else {}),
    }))


def test_terminal_summary_distinguishes_no_targets_from_failed_reviews():
    from app.modules.agent.backlinks_continuation_store import continuation_summary

    state = initial_checkpoint()
    state.update(stage="done", selection={
        "scanned": 100, "eligible": 0,
        "skipped": {"NO_PUBLIC_EMAIL": 97, "RECOMMENDATION_REQUIRED": 3},
    }, send_batch={"state": "NO_ELIGIBLE_TARGETS"})
    summary = continuation_summary(state)
    assert "100" in summary and "97" in summary and "3" in summary
    assert "NO_ELIGIBLE_TARGETS" in summary
    assert "NO_PASSING_DRAFTS" not in summary


@pytest.mark.parametrize("outcome", [None, "CONTACT_FORM_ONLY", "MANUAL_REVIEW_REQUIRED"])
def test_public_email_selection_requires_observed_email_evidence(outcome):
    async def check(core, step, saved):
        core.release()
        core.pages = {"items": [{
            "itemId": identifier(0), "recommended": False,
            "contact": {"email": "public@example.test", "outcome": outcome},
        }], "nextCursor": None}
        state = await drain(step, initial_checkpoint())
        assert not state["results"] and state["usage"]["drafts"] == 0
        assert state["selection"]["skipped"] == {"NO_PUBLIC_EMAIL": 1}
    asyncio.run(harness(check, policy={**POLICY, "target_selection": "public_email"}))


def test_skip_existing_opportunity_even_if_joined_after_feed_was_read():
    async def check(core, step, saved):
        core.release()
        state = await drain(step, initial_checkpoint(), until="join")
        core.existing_opportunity = True
        state = await drain(step, state)
        assert state["usage"]["drafts"] == 0
        assert all(item["reason"] == "ALREADY_JOINED" for item in state["results"])
        assert not any("draft-jobs" in request.url.path for request in core.calls)
    asyncio.run(harness(check, policy={**POLICY, "skip_existing_opportunities": True}))

def test_complete_two_drafts_after_wait_without_sending_or_model_polling():
    async def check(core, step, saved):
        state = await step.advance(initial_checkpoint())
        assert state["generation"] == GEN and state["usage"]["paid_usd"] == "2"
        writes = len([r for r in core.calls if r.method == "POST"])
        state = await step.advance(state)
        assert len([r for r in core.calls if r.method == "POST"]) == writes
        core.release()
        state = await drain(step, state)
        assert state["stage"] == "done"
        assert [item["state"] for item in state["results"]] == ["VERIFIED_DRAFT"] * 2
        assert state["usage"] == {"opportunities": 2, "drafts": 2, "model_usd": "0.2", "paid_usd": "2"}
        assert all(record["pending"] for record in saved)
        assert await step.advance(state) == state
    asyncio.run(harness(check))


@pytest.mark.parametrize("stage", ["recommend", "wait_refill"])
def test_staged_generation_waits_without_restarting_or_spending(stage):
    async def check(core, step, saved):
        core.latest = {"generationContractId": GEN, "jobState": "PENDING_LAUNCH",
                       "releaseResult": "PENDING"}
        state = initial_checkpoint()
        state.update(stage=stage, generation=GEN)
        after = await step.advance(state)
        assert after["stage"] == stage
        assert after["usage"] == state["usage"]
        assert all(request.method == "GET" for request in core.calls)
    asyncio.run(harness(check))


@pytest.mark.parametrize("status", ["SUCCESS", "PARTIAL_SUCCESS", "SUCCEEDED"])
@pytest.mark.parametrize("release", ["AVAILABLE", "RELEASED"])
@pytest.mark.parametrize("stage, expected", [("recommend", "publish"), ("wait_refill", "publish_refill")])
def test_released_generation_accepts_core_success_states(status, release, stage, expected):
    async def check(core, step, saved):
        core.release()
        core.latest["jobState"] = status
        core.latest["releaseResult"] = release
        state = initial_checkpoint()
        state.update(stage=stage, generation=GEN)
        assert (await step.advance(state))["stage"] == expected
    asyncio.run(harness(check))


@pytest.mark.parametrize("release", ["PENDING", "NO_BATCH", "UNKNOWN"])
def test_unreleased_generation_cannot_join_or_send(release):
    async def check(core, step, saved):
        core.release()
        core.latest["releaseResult"] = release
        state = await step.advance(initial_checkpoint())
        assert state["stage"] == "paused"
        assert state["reason"] == "RECOMMENDATIONS_NOT_RELEASED"
        assert all(request.method == "GET" for request in core.calls)
    asyncio.run(harness(check))


def test_next_batch_joins_only_the_pinned_batch_and_never_historical_items():
    async def check(core, step, saved):
        core.release()
        state = await drain(step, initial_checkpoint("next_batch"))
        assert state["stage"] == "done"
        assert state["batch_id"] == identifier("new-batch")
        assert [r["feedItemId"] for r in state["results"]] == [identifier("new-item")]
        assert state["usage"]["paid_usd"] == "0"
        paths = [r.url.path for r in core.calls if r.method == "POST"]
        assert sum(p.endswith("/get-more") for p in paths) == 1
        assert not any("/recommendation-seeds/" in p for p in paths)
    asyncio.run(harness(check))


def test_current_pool_pins_publication_before_reading_candidates():
    async def check(core, step, saved):
        core.release()
        state = await drain(step, initial_checkpoint(), until="page")
        assert state["batch_id"] == identifier("current-batch")
        core.pages = {"items": [], "nextCursor": None}
        state = await step.advance(state)
        assert core.calls[-1].url.params["batchId"] == identifier("current-batch")
        assert state["stage"] == "done" and not state["results"]
    asyncio.run(harness(check))


@pytest.mark.parametrize("value", [None, True, -1, "10", float("inf"), float("nan")])
def test_required_seo_metrics_skip_unknown_or_invalid_values(value):
    async def check(core, step, saved):
        core.release()
        state = initial_checkpoint()
        state.update(stage="page", generation=GEN)
        # Inject the feed after the HTTP boundary so non-JSON numeric values can
        # exercise the same eligibility guard without invalid JSON fixtures.
        step.read = AsyncMock(return_value={
            "latestGeneration": core.latest, "nextCursor": None,
            "items": [{
                "itemId": identifier(0), "recommended": True,
                "contact": {"email": "editor@example.test"},
                "metrics": {"targetMarketOrganicTraffic": value, "dataForSeoRank": 12, "spamScore": 0},
            }],
        })
        state = await step.advance(state)
        assert state["stage"] == "done" and not state["queue"]
        assert not core.calls
    asyncio.run(harness(check, policy={**POLICY, "require_seo_metrics": True}))


def test_required_seo_metrics_accept_real_zero_and_do_not_relax_contact_requirement():
    async def check(core, step, saved):
        core.release()
        core.pages = {
            "items": [{
                "itemId": identifier(i), "recommended": True,
                "contact": {"email": "editor@example.test" if i == 0 else None},
                "metrics": {"targetMarketOrganicTraffic": 0, "dataForSeoRank": 0, "spamScore": 0},
            } for i in range(2)], "nextCursor": None,
        }
        state = initial_checkpoint()
        state.update(stage="page", generation=GEN)
        state = await step.advance(state)
        assert state["queue"] == [identifier(0)]
        assert state["stage"] == "join"
    asyncio.run(harness(check, policy={**POLICY, "require_seo_metrics": True}))


def test_next_batch_preparing_waits_then_releases_without_old_items():
    async def check(core, step, saved):
        core.release()
        core.next_batch_state = "NEXT_BATCH_PREPARING"
        state = await step.advance(initial_checkpoint("next_batch"))
        state = await step.advance(state)
        assert state["stage"] == "next_batch"
        assert not state["results"]
        assert not any(r.method == "POST" for r in core.calls)
        core.next_batch_state = "RELEASED"
        state = await drain(step, state)
        assert state["stage"] == "done"
        assert [r["feedItemId"] for r in state["results"]] == [identifier("new-item")]
    asyncio.run(harness(check))


def test_exhausted_pool_reserves_budget_and_starts_one_v2_refill():
    async def check(core, step, saved):
        core.release()
        core.next_batch_state = "POOL_EXHAUSTED"
        core.generation = identifier("refill-generation")
        core.batch_ordinal = 1
        state = await drain(step, initial_checkpoint("next_batch"), until="wait_refill")
        assert state["usage"]["paid_usd"] == "2"
        assert state["generation"] == core.generation
        for _ in range(3):
            state = await step.advance(state)
        assert state["stage"] == "wait_refill" and not state["results"]
        assert sum(r.url.path.endswith("/recommendation-seeds/launch") for r in core.calls) == 1
        core.release()
        state = await drain(step, state)
        assert state["stage"] == "done"
        assert state["batch_id"] == identifier("new-batch")
        assert [r["feedItemId"] for r in state["results"]] == [identifier("new-item")]
    asyncio.run(harness(check))


def test_new_project_campaign_generates_and_pins_its_first_batch():
    async def check(core, step, saved):
        core.batch_ordinal = 1
        state = await step.advance(initial_checkpoint("next_batch"))
        assert state["stage"] == "wait_refill"
        core.release()
        state = await drain(step, state)
        assert state["stage"] == "done"
        assert [r["feedItemId"] for r in state["results"]] == [identifier("new-item")]
    asyncio.run(harness(check))


@pytest.mark.parametrize("stage,change,reason", [
    ("wait_refill", "generation", "GENERATION_CHANGED"),
    ("wait_refill", "failed", "REFILL_REQUIRES_REVIEW"),
    ("wait_refill", "timeout", "REFILL_WAIT_TIMEOUT"),
    ("pin_refill", "missing_pool", "REFILL_BATCH_NOT_VERIFIED"),
])
def test_refill_bad_evidence_never_joins_or_sends(stage, change, reason):
    async def check(core, step, saved):
        core.release()
        state = initial_checkpoint("next_batch")
        state.update(stage=stage, generation=GEN, refill_started=True, refill_ordinal=1)
        if change == "generation":
            core.latest["generationContractId"] = identifier("other")
        elif change == "failed":
            core.latest["jobState"] = "FAILED"
        elif change == "timeout":
            core.latest["jobState"] = "RUNNING"
            state["refill_waits"] = 119
        else:
            core.latest["visiblePoolGeneration"] = None
        state = await step.advance(state)
        assert state["reason"] == reason
        assert not any(r.method == "POST" for r in core.calls)
    asyncio.run(harness(check))


@pytest.mark.parametrize("cause,expected", [
    ("stale", "DRAFT_REQUIRES_REVIEW"), ("contact", "SKIPPED"), ("failed", "JOB_FAILED"),
])
def test_per_item_problems_are_not_reported_as_verified(cause, expected):
    async def check(core, step, saved):
        core.release()
        core.fresh = cause != "stale"
        core.confirmed = cause != "contact"
        if cause == "failed":
            core.job_status = "FAILED"
            core.job_details = {
                "lastErrorCategory": "POLICY_VIOLATION",
                "diagnosticCode": "DRAFT_POLICY_OUTPUT_INVALID",
                "attemptCount": 2,
                "retryable": False,
            }
        state = await drain(step, initial_checkpoint())
        assert state["stage"] == "done"
        assert [item["state"] for item in state["results"]] == [expected] * 2
        if cause == "failed":
            assert state["results"][0] == {
                "feedItemId": identifier(0),
                "opportunityId": identifier(0),
                "state": "JOB_FAILED",
                "draftId": identifier(0),
                "jobStatus": "FAILED",
                "reason": "DRAFT_POLICY_OUTPUT_INVALID",
                "lastErrorCategory": "POLICY_VIOLATION",
                "diagnosticCode": "DRAFT_POLICY_OUTPUT_INVALID",
                "attemptCount": 2,
                "retryable": False,
            }
    asyncio.run(harness(check))


def test_unknown_write_is_not_reissued_after_resume():
    async def check(core, step, saved):
        core.release()
        core.fail_post = "opportunities"
        state = await drain(step, initial_checkpoint())
        assert state["reason"] == "WRITE_RECEIPT_UNVERIFIED"
        writes = len(core.calls)
        recovered = await step.advance(saved[-1])
        assert recovered["reason"] == "WRITE_RECEIPT_UNVERIFIED"
        assert len(core.calls) == writes
    asyncio.run(harness(check))


@pytest.mark.parametrize("quote", [None, "NaN", "-1", "0", "Infinity", "bad", "3"])
def test_unavailable_or_over_limit_cost_never_creates_a_job(quote):
    async def check(core, step, saved):
        core.release()
        core.quote = quote
        state = await drain(step, initial_checkpoint())
        assert state["stage"] == "paused"
        assert not any(r.method == "POST" and r.url.path.endswith("/draft-jobs") for r in core.calls)
    asyncio.run(harness(check))


def test_cumulative_model_reservation_stops_second_job():
    async def check(core, step, saved):
        core.release()
        state = await drain(step, initial_checkpoint())
        assert state["reason"] == "MODEL_BUDGET_LIMIT"
        assert len(state["results"]) == 1
        assert state["usage"]["model_usd"] == "0.1"
    asyncio.run(harness(check, policy={**POLICY, "max_model_cost_usd": "0.15"}))


def test_paid_budget_zero_allows_existing_generation_but_never_starts_one():
    async def check(core, step, saved):
        state = await step.advance(initial_checkpoint())
        assert state["reason"] == "PAID_BUDGET_LIMIT"
        assert not any(r.method == "POST" for r in core.calls)
        core.release()
        assert (await drain(step, initial_checkpoint()))["stage"] == "done"
    asyncio.run(harness(check, policy={**POLICY, "max_paid_tool_cost_usd": "0"}))


def test_generation_change_stops_without_joining():
    async def check(core, step, saved):
        state = await step.advance(initial_checkpoint())
        core.release()
        core.latest["generationContractId"] = identifier("changed")
        state = await step.advance(state)
        assert state["reason"] == "GENERATION_CHANGED"
        assert not any(r.url.path.endswith("/opportunities") for r in core.calls)
    asyncio.run(harness(check))


def test_polling_job_retains_checkpoint_and_does_not_create_again():
    async def check(core, step, saved):
        core.release()
        core.job_status = "QUEUED"
        state = await drain(step, initial_checkpoint(), until="job")
        writes = len([r for r in core.calls if r.method == "POST"])
        for _ in range(3):
            state = await step.advance(deepcopy(state))
        assert state["stage"] == "job"
        assert len([r for r in core.calls if r.method == "POST"]) == writes
        core.job_status = "SUCCEEDED"
        assert (await drain(step, state))["stage"] == "done"
    asyncio.run(harness(check))


@pytest.mark.parametrize("stage", ["quality", "page"])
@pytest.mark.parametrize("recovered", [True, False])
def test_quality_outage_retries_on_next_tick_with_persisted_limit(stage, recovered):
    async def check(core, step, saved):
        core.release()
        draft = identifier(0)
        state = initial_checkpoint()
        state.update(
            stage=stage, quality_pending=draft, quality_queue=[],
            results=[{"state": "VERIFIED_DRAFT", "draftId": draft}],
        )
        unavailable = {"state": "ERROR", "reasons": ["AI_REVIEW_UNAVAILABLE"]}
        step.review = AsyncMock(side_effect=[
            unavailable, {"state": "PASSED"} if recovered else unavailable,
        ])
        state = await step.advance(state)
        assert state["quality_pending"] == draft
        assert state["stage"] != "done"
        assert saved[0]["quality_review_attempts"][draft] == 1
        assert saved[0].get("quality_pending") == draft
        assert step.review.await_count == 1
        # Reconstruct the step to simulate worker recovery from the durable state.
        resumed = ContinuationStep(
            step.pipeline, project_id=step.project_id, organization_id=step.organization_id,
            run_id=step.run_id, policy=step.policy, request=step.request,
            save=step.save, review=step.review,
        )
        state = await resumed.advance(deepcopy(saved[-1]))
        assert "quality_pending" not in state
        assert state["quality_review_attempts"][draft] == 2
        assert state["results"][0]["quality"]["state"] == ("PASSED" if recovered else "ERROR")
        if stage == "quality":
            assert state["stage"] == "done"
        assert step.review.await_count == 2
        assert not any(r.method == "POST" for r in core.calls)
    asyncio.run(harness(check))


@pytest.mark.parametrize("report", [
    {"state": "BLOCKED", "reasons": ["MODEL_BUDGET_LIMIT"]},
    {"state": "BLOCKED", "reasons": ["recipient identity mismatch"]},
    {"state": "ERROR", "reasons": ["AI_REVIEW_UNAVAILABLE"], "retryable": False},
    {"state": "PASSED", "reasons": []},
])
def test_quality_business_decisions_are_not_automatically_retried(report):
    async def check(core, step, saved):
        draft = identifier(0)
        state = initial_checkpoint()
        state.update(stage="quality", quality_pending=draft, quality_queue=[],
                     results=[{"state": "VERIFIED_DRAFT", "draftId": draft}])
        step.review = AsyncMock(return_value=report)
        state = await drain(step, state)
        assert state["stage"] == "done"
        assert state["results"][0]["quality"] == report
        assert step.review.await_count == 1
    asyncio.run(harness(check))


def test_lost_quality_receipt_cannot_exceed_persisted_attempt_limit():
    async def check(core, step, saved):
        draft = identifier(0)
        state = initial_checkpoint()
        state.update(stage="quality", quality_pending=draft, quality_queue=[],
                     quality_review_attempts={draft: 2},
                     results=[{"state": "VERIFIED_DRAFT", "draftId": draft}])
        step.review = AsyncMock()
        state = await step.advance(state)
        assert state["stage"] == "done"
        assert state["results"][0]["quality"]["state"] == "ERROR"
        step.review.assert_not_awaited()
    asyncio.run(harness(check))


async def with_database(check):
    raw = os.getenv("BACKLINKS_PROJECT_PROJECTION_TEST_DATABASE_URL")
    if not raw:
        pytest.skip("Dedicated PostgreSQL URL required")
    url = make_url(raw)
    assert url.database == "seo_agent_v11_test" and url.host in {"localhost", "127.0.0.1"}
    engine = create_async_engine(url)
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                schema = "agent_continuation_test_" + uuid4().hex
                await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
                await connection.execute(text(f'SET LOCAL search_path TO "{schema}"'))

                def create_tables(conn):
                    tables = [model.__table__ for model in (
                        Project, AgentConversation, AgentMessage, AgentRun, AgentSystemTrigger,
                        AgentWorkflowDispatch, AgentToolExecution,
                    )]
                    Base.metadata.create_all(conn, tables=tables)
                    for version in ("20260914_0067_agent_backlinks_consents.py",
                                    "20260914_0068_agent_backlinks_continuations.py"):
                        migration = runpy.run_path(str(
                            Path(__file__).resolve().parents[1] / "migrations" / "versions" / version,
                        ))
                        with Operations.context(MigrationContext.configure(conn)):
                            migration["upgrade"]()

                await connection.run_sync(create_tables)
                sessions = async_sessionmaker(
                    bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint",
                )
                async with sessions() as session, session.begin():
                    session.add(Project(
                        id="project", organization_id="org", workspace_id="workspace", project_key="key",
                        status="ACTIVE", name="Test", domain="example.test", country="US",
                        target_market="US", language="en",
                    ))
                    await session.flush()
                    session.add(AgentSystemTrigger(
                        id=str(uuid4()), organization_id="org", project_id="project",
                        trigger="backlinks_project_ready", trigger_version="initial", content="Ready",
                    ))
                await check(sessions)
            finally:
                await transaction.rollback()
    finally:
        await engine.dispose()


async def start(sessions):
    grant = await BacklinksConsentStore(sessions).create(CONTEXT, ConsentRequest.model_validate({
        **POLICY, "request_id": str(uuid4()), "confirmed": True,
        "expires_at": datetime.now(UTC) + timedelta(hours=1),
    }))
    store = BacklinksContinuationStore(sessions)
    result = await store.start(CONTEXT, grant["id"], ARGS["request"], {
        "model_timeout_seconds": 120, "write_tool_timeout_seconds": 180,
    })
    return store, grant, result


def test_database_start_replay_conflict_and_scope():
    async def check(sessions):
        store, grant, first = await start(sessions)
        second = await store.start(CONTEXT, grant["id"], ARGS["request"], {})
        assert first["run_id"] == second["run_id"]
        assert (await BacklinksConsentStore(sessions).get(CONTEXT, grant["id"]))["automation_enabled"]
        with pytest.raises(ConsentError, match="REQUEST_CONFLICT"):
            await store.start(CONTEXT, grant["id"], {**ARGS["request"], "language": "zh"}, {})
        other = replace(CONTEXT, actor=replace(CONTEXT.actor, user_id="other"))
        with pytest.raises(ConsentError, match="NOT_FOUND"):
            await store.get(other, grant["id"])
        async with sessions() as session:
            dispatch = await session.get(AgentWorkflowDispatch, first["run_id"])
            assert dispatch.status == "pending"
            assert dispatch.task_payload["limits"]["backlinks_continuation"] is True
    asyncio.run(with_database(check))


@pytest.mark.parametrize("interrupted", [False, True])
@pytest.mark.parametrize("reason", ["RECOMMENDATIONS_REQUIRE_REVIEW", "RECOMMENDATIONS_NOT_RELEASED"])
def test_database_resume_generation_wait_preserves_original_authority(interrupted, reason):
    async def check(sessions):
        store, grant, first = await start(sessions)
        async with sessions() as session, session.begin():
            run = await session.get(AgentRun, first["run_id"])
            record = await session.get(AgentBacklinksContinuation, run.id)
            run.status = "failed"
            original_workflow = run.workflow_id
            state = deepcopy(record.checkpoint_json)
            state.update(stage="paused", reason=reason, generation=GEN)
            if interrupted:
                state["stage"] = "recommend"
                state["resumed_from"] = state.pop("reason")
                run.error_code = "agent_workflow_closed"
            state["usage"]["paid_usd"] = "2"
            record.checkpoint_json = state
        resumed = await store.start(CONTEXT, grant["id"], ARGS["request"], {})
        assert resumed["run_id"] == first["run_id"]
        assert resumed["status"] == "queued"
        assert resumed["checkpoint"]["generation"] == GEN
        assert resumed["checkpoint"]["usage"]["paid_usd"] == "2"
        assert resumed["checkpoint"]["stage"] == "recommend"
        async with sessions() as session:
            run = await session.get(AgentRun, first["run_id"])
            assert run.workflow_id != original_workflow
            dispatch = await session.get(AgentWorkflowDispatch, run.id)
            assert dispatch.workflow_id == run.workflow_id
            assert dispatch.status == "pending"
        again = await store.start(CONTEXT, grant["id"], ARGS["request"], {})
        assert again == resumed
    asyncio.run(with_database(check))


@pytest.mark.parametrize("change", [None, "request", "mode", "expired"])
def test_campaign_resume_adapter_preserves_database_authority(change):
    async def check(sessions):
        from types import SimpleNamespace
        from app.modules.agent.backlinks_campaign import BacklinksCampaign
        from app.modules.agent.models import AgentBacklinksConsent

        store, grant, first = await start(sessions)
        async with sessions() as session, session.begin():
            consent = await session.get(AgentBacklinksConsent, grant["id"])
            consent.policy_json = {
                **consent.policy_json, "policy_version": "backlinks-chat-campaign.v1",
                "draft_request": ARGS["request"], "recommendation_mode": "current",
                "send_authorized": True,
            }
            if change == "expired":
                consent.created_at = datetime.now(UTC) - timedelta(hours=1)
                consent.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        reader = SimpleNamespace(resolve_write_context=AsyncMock(return_value=CONTEXT))
        args = {"consent_id": grant["id"]}
        if change == "request":
            args["request"] = {**ARGS["request"], "additionalRequirements": "new text"}
        elif change == "mode":
            args["recommendation_mode"] = "next_batch"
        campaign = BacklinksCampaign(reader, sessions, {})
        if change:
            error = "INACTIVE" if change == "expired" else "AUTHORIZATION_CHANGED"
            with pytest.raises(ConsentError, match=error):
                await campaign.start("project", "org", None, args)
        else:
            result = await campaign.start("project", "org", None, args)
            assert result["run_id"] == first["run_id"]
            assert result["sending_allowed"] is True
        execution = await store.get(CONTEXT, grant["id"])
        assert execution["checkpoint"] == first["checkpoint"]
    asyncio.run(with_database(check))


@pytest.mark.parametrize("unsafe", ["pending", "results", "queue", "drafts", "opportunities"])
def test_database_generation_resume_does_not_replay_past_side_effects(unsafe):
    async def check(sessions):
        store, grant, first = await start(sessions)
        async with sessions() as session, session.begin():
            run = await session.get(AgentRun, first["run_id"])
            run.status = "failed"
            record = await session.get(AgentBacklinksContinuation, run.id)
            state = deepcopy(record.checkpoint_json)
            state.update(stage="paused", reason="RECOMMENDATIONS_REQUIRE_REVIEW", generation=GEN)
            if unsafe in {"drafts", "opportunities"}:
                state["usage"][unsafe] = 1
            else:
                state[unsafe] = [{"id": "already-started"}]
            record.checkpoint_json = state
        result = await store.start(CONTEXT, grant["id"], ARGS["request"], {})
        assert result["status"] == "failed"
        assert result["checkpoint"] == state
    asyncio.run(with_database(check))


@pytest.mark.parametrize("blocked", [None, "already_resumed", "pending", "has_batch", "drafts_only"])
def test_terminal_campaign_resumes_only_saved_quality_once(blocked):
    async def check(sessions):
        from app.modules.agent.models import AgentBacklinksConsent
        store, grant, first = await start(sessions)
        async with sessions() as session, session.begin():
            consent = await session.get(AgentBacklinksConsent, grant["id"])
            if blocked != "drafts_only":
                consent.policy_json = {
                    **consent.policy_json, "policy_version": "backlinks-chat-campaign.v1",
                    "draft_request": ARGS["request"], "recommendation_mode": "current",
                    "send_authorized": True,
                }
            run = await session.get(AgentRun, first["run_id"])
            run.status = "completed"
            record = await session.get(AgentBacklinksContinuation, run.id)
            state = deepcopy(record.checkpoint_json)
            state.update(stage="done", generation=GEN,
                         send_batch={"state": "NO_PASSING_DRAFTS"},
                         results=[{"state": "VERIFIED_DRAFT", "draftId": identifier(0)}])
            state["usage"].update(drafts=1, opportunities=1, model_usd="0.5", paid_usd="2")
            if blocked == "already_resumed":
                state["quality_resume_started"] = True
            elif blocked == "pending":
                state["pending"] = {"tool": "write"}
            elif blocked == "has_batch":
                state["send_batch"] = {"state": "queued", "id": identifier("batch")}
            record.checkpoint_json = state
        result = await store.start(CONTEXT, grant["id"], ARGS["request"], {})
        assert result["run_id"] == first["run_id"]
        assert result["checkpoint"]["usage"] == state["usage"]
        assert result["checkpoint"]["generation"] == GEN
        if blocked:
            assert result["status"] == "completed"
            assert result["checkpoint"] == state
        else:
            assert result["status"] == "queued"
            assert result["checkpoint"]["stage"] == "quality"
            assert result["checkpoint"]["quality_queue"] == [identifier(0)]
            assert await store.start(CONTEXT, grant["id"], ARGS["request"], {}) == result
    asyncio.run(with_database(check))


def test_quality_recovery_reviews_one_saved_draft_per_tick_without_new_pipeline_work():
    async def check():
        pipeline = SimpleNamespace(drafts=None, reader=None)
        review = AsyncMock(return_value={"state": "PASSED"})
        step = ContinuationStep(
            pipeline, project_id="project", organization_id="org", run_id="run",
            policy=POLICY, request=ARGS["request"], save=AsyncMock(), review=review,
        )
        state = initial_checkpoint()
        state.update(stage="quality", quality_queue=["one", "two"],
                     results=[{"draftId": "one"}, {"draftId": "two"}])
        state = await step.advance(state)
        assert state["stage"] == "quality"
        assert state["quality_queue"] == ["two"]
        assert review.await_count == 1
        state = await step.advance(state)
        assert state["stage"] == "done"
        assert review.await_count == 2
        assert all(item["quality"]["state"] == "PASSED" for item in state["results"])
        assert state["usage"]["drafts"] == state["usage"]["opportunities"] == 0
    asyncio.run(check())


@pytest.mark.parametrize("stop", ["cancel", "archive", "expire", "workspace", "lease"])
def test_database_current_authority_is_checked_before_next_request(stop):
    async def check(sessions):
        store, grant, first = await start(sessions)
        async with sessions() as session, session.begin():
            record = await session.get(AgentBacklinksContinuation, first["run_id"])
            record.lease_id = "lease"
            record.lease_expires_at = datetime.now(UTC) + timedelta(minutes=1)
        context = await store.authority(first["run_id"], "lease", "project", "org", write=True)
        assert context.actor.session_id.startswith("agent-consent:")
        assert context.permissions == ("backlinks:write",)
        async with sessions() as session, session.begin():
            if stop == "cancel":
                run = await session.get(AgentRun, first["run_id"])
                run.status = "cancelled"
            elif stop in {"archive", "workspace"}:
                project = await session.get(Project, "project")
                if stop == "archive":
                    project.status = "ARCHIVED"
                else:
                    project.workspace_id = "other"
            elif stop == "expire":
                from app.modules.agent.models import AgentBacklinksConsent
                consent = await session.get(AgentBacklinksConsent, grant["id"])
                consent.created_at = datetime.now(UTC) - timedelta(hours=2)
                consent.expires_at = datetime.now(UTC) - timedelta(hours=1)
            else:
                record = await session.get(AgentBacklinksContinuation, first["run_id"])
                record.lease_id = "replacement"
        with pytest.raises(ConsentError):
            await store.authority(first["run_id"], "lease", "project", "org", write=True)
    asyncio.run(with_database(check))


def test_cursor_cycle_and_empty_page_limit_stop_boundedly():
    async def check(core, step, saved):
        core.release()
        core.pages = {"items": [], "nextCursor": "same"}
        state = await drain(step, initial_checkpoint())
        assert state["reason"] == "PAGINATION_CYCLE"
        state = initial_checkpoint()
        state.update(stage="page", generation=GEN, cursors=[str(i) for i in range(50)])
        assert (await step.advance(state))["reason"] == "SCAN_LIMIT"
    asyncio.run(harness(check))


def test_next_page_keeps_sort_cursor_and_deduplicates_items():
    async def check(core, step, saved):
        core.release()
        core.pages = {"items": [{"itemId": identifier(0), "recommended": True,
                                "contact": {"email": "editor@example.test"}}], "nextCursor": "second"}
        state = await drain(step, initial_checkpoint(), until="page")
        state = await drain(step, state, until="page")
        assert len(state["results"]) == 1
        core.pages = {"items": [
            {"itemId": identifier(i), "recommended": True, "contact": {"email": "editor@example.test"}}
            for i in (0, 1)
        ], "nextCursor": None}
        state = await drain(step, state)
        assert len(state["results"]) == 2
        assert any(r.url.params.get("cursor") == "second"
                   and r.url.params.get("sort") == "released_asc" for r in core.calls)
    asyncio.run(harness(check))


@pytest.mark.parametrize("count", [1, 2])
def test_batch_count_limit_is_cumulative(count):
    async def check(core, step, saved):
        core.release()
        state = await drain(step, initial_checkpoint())
        assert state["stage"] == "done" and len(state["results"]) == count
        assert state["usage"]["drafts"] == count
    asyncio.run(harness(check, policy={**POLICY, "max_opportunities": count, "max_drafts": count}))


def test_workflow_reuses_registered_activity_and_waits(monkeypatch):
    from app.modules.agent import workflows
    execute = AsyncMock(side_effect=[
        {"done": False, "wait_seconds": 30}, {"done": False, "wait_seconds": 1}, {"done": True},
    ])
    sleep = AsyncMock()
    monkeypatch.setattr(workflows.workflow, "execute_activity", execute)
    monkeypatch.setattr(workflows.workflow, "sleep", sleep)
    asyncio.run(workflows.AgentWorkflow().run({
        "run_id": "run", "limits": {"backlinks_continuation": True},
    }))
    assert execute.await_count == 3
    assert all(call.args[0] == "agent_backlinks_continue" for call in execute.await_args_list)
    assert [call.args[0] for call in sleep.await_args_list] == [30, 1]


def test_workflow_bounds_history_with_continue_as_new(monkeypatch):
    from app.modules.agent import workflows
    execute = AsyncMock(return_value={"done": False, "wait_seconds": 30})
    monkeypatch.setattr(workflows.workflow, "execute_activity", execute)
    monkeypatch.setattr(workflows.workflow, "sleep", AsyncMock())
    continued = []
    monkeypatch.setattr(workflows.workflow, "continue_as_new", lambda payload: continued.append(payload))
    payload = {"run_id": "run", "limits": {"backlinks_continuation": True}}
    asyncio.run(workflows.AgentWorkflow().run(payload))
    assert execute.await_count == 100 and continued == [payload]


@pytest.mark.parametrize("body,status", [
    ({"confirmed": True, "request": ARGS["request"]}, 202),
    ({"confirmed": False, "request": ARGS["request"]}, 422),
    ({"confirmed": "true", "request": ARGS["request"]}, 422),
    ({"confirmed": True, "request": ARGS["request"], "sending_allowed": True}, 422),
])
def test_start_api_requires_explicit_separate_confirmation(monkeypatch, body, status):
    async def check():
        store = SimpleNamespace(start=AsyncMock(return_value={"run_id": "run"}))
        resolver = SimpleNamespace(resolve=AsyncMock(return_value=CONTEXT))
        app = FastAPI()
        app.state.platform_context_resolver = resolver
        app.include_router(consent_routes.router, prefix="/api/v1/projects/{project_id}/agent")
        app.dependency_overrides[consent_routes.continuation_store] = lambda: store
        monkeypatch.setattr(consent_routes, "build_agent_service", lambda: SimpleNamespace(limits={}))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
            response = await client.post(
                f"/api/v1/projects/key/agent/automation/consents/{uuid4()}/start", json=body,
            )
        assert response.status_code == status
        assert store.start.await_count == (1 if status == 202 else 0)
        assert resolver.resolve.await_args.kwargs["required_permission"] == "backlinks:write"
    asyncio.run(check())


def test_database_ticks_recover_and_revoke_blocks_new_writes():
    async def check(sessions):
        store, grant, first = await start(sessions)
        core = Core()
        core.release()
        async with httpx.AsyncClient(transport=httpx.MockTransport(core.respond)) as client:
            gateway = BacklinksGateway(base_url="http://core.test", signing_key="k" * 32, client=client)
            for _ in range(3):
                assert not (await store.tick(first["run_id"], SETTINGS, gateway=gateway))["done"]
            await BacklinksConsentStore(sessions).revoke(CONTEXT, grant["id"])
            count = len(core.calls)
            result = await BacklinksContinuationStore(sessions).tick(
                first["run_id"], SETTINGS, gateway=gateway,
            )
            assert result["done"] and len(core.calls) == count
            execution = await store.get(CONTEXT, grant["id"])
            assert execution["checkpoint"]["reason"] == "BACKLINKS_CONSENT_INACTIVE"
            assert execution["status"] == "failed"
    asyncio.run(with_database(check))


def test_database_completed_batch_and_busy_lease(monkeypatch):
    from app.modules.agent.backlinks_quality import BacklinksQuality
    monkeypatch.setattr(BacklinksQuality, "evaluate", AsyncMock(return_value={
        "items": [{"state": "BLOCKED", "reasons": ["PROJECT_EVIDENCE_MISSING"]}],
        "sent": False,
    }))
    async def check(sessions):
        store, grant, first = await start(sessions)
        async with sessions() as session, session.begin():
            record = await session.get(AgentBacklinksContinuation, first["run_id"])
            record.lease_id = "other-worker"
            record.lease_expires_at = datetime.now(UTC) + timedelta(minutes=1)
        core = Core()
        core.release()
        async with httpx.AsyncClient(transport=httpx.MockTransport(core.respond)) as client:
            gateway = BacklinksGateway(base_url="http://core.test", signing_key="k" * 32, client=client)
            assert not (await store.tick(first["run_id"], SETTINGS, gateway=gateway))["done"]
            assert not core.calls
            async with sessions() as session, session.begin():
                record = await session.get(AgentBacklinksContinuation, first["run_id"])
                record.lease_expires_at = datetime.now(UTC) - timedelta(seconds=1)
            for _ in range(30):
                if (await BacklinksContinuationStore(sessions).tick(
                    first["run_id"], SETTINGS, gateway=gateway,
                ))["done"]:
                    break
            else:
                raise AssertionError("Did not finish")
            execution = await store.get(CONTEXT, grant["id"])
            assert execution["status"] == "completed"
            assert len(execution["checkpoint"]["results"]) == 2
            async with sessions() as session:
                answers = (await session.scalars(select(AgentMessage).where(
                    AgentMessage.run_id == first["run_id"], AgentMessage.role == "assistant",
                ))).all()
                assert len(answers) == 1
    asyncio.run(with_database(check))


@pytest.mark.parametrize("revoke", [False, True])
def test_database_quality_retry_survives_new_store_and_revocation(monkeypatch, revoke):
    from app.modules.agent.backlinks_quality import BacklinksQuality
    evaluate = AsyncMock(side_effect=[
        {"items": [{"state": "ERROR", "reasons": ["AI_REVIEW_UNAVAILABLE"], "retryable": True}]},
        {"items": [{"state": "PASSED"}]},
    ])
    monkeypatch.setattr(BacklinksQuality, "evaluate", evaluate)
    async def check(sessions):
        store, grant, first = await start(sessions)
        draft = identifier(0)
        async with sessions() as session, session.begin():
            record = await session.get(AgentBacklinksContinuation, first["run_id"])
            record.checkpoint_json = {
                **record.checkpoint_json, "stage": "quality",
                "quality_pending": draft, "quality_queue": [],
                "results": [{"state": "VERIFIED_DRAFT", "draftId": draft}],
            }
        core = Core()
        async with httpx.AsyncClient(transport=httpx.MockTransport(core.respond)) as client:
            gateway = BacklinksGateway(base_url="http://core.test", signing_key="k" * 32, client=client)
            result = await store.tick(first["run_id"], SETTINGS, gateway=gateway)
            assert result == {"done": False, "wait_seconds": 30}
            assert evaluate.await_args.kwargs["retry"] is False
            execution = await store.get(CONTEXT, grant["id"])
            assert execution["checkpoint"]["quality_review_attempts"][draft] == 1
            if revoke:
                await BacklinksConsentStore(sessions).revoke(CONTEXT, grant["id"])
            result = await BacklinksContinuationStore(sessions).tick(
                first["run_id"], SETTINGS, gateway=gateway,
            )
            assert result["done"]
            execution = await store.get(CONTEXT, grant["id"])
            assert execution["status"] == ("failed" if revoke else "completed")
            assert evaluate.await_count == (1 if revoke else 2)
            if not revoke:
                assert evaluate.await_args.kwargs["retry"] is True
                assert execution["checkpoint"]["results"][0]["quality"]["state"] == "PASSED"
            assert not any(call.method == "POST" for call in core.calls)
    asyncio.run(with_database(check))


def test_terminal_summary_reports_zero_send_and_specific_failure_counts():
    from app.modules.agent.backlinks_continuation_store import continuation_summary
    summary = continuation_summary({
        "results": [
            {"state": "VERIFIED_DRAFT", "quality": {"state": "ERROR"}},
            {"state": "JOB_FAILED"}, {"state": "JOB_FAILED"},
        ],
        "send_batch": {"state": "NO_PASSING_DRAFTS"},
    })
    assert "生成失败 2 封" in summary
    assert "审核不可用 1 封" in summary
    assert "审核通过 0 封" in summary
    assert "本任务发送 0 封" in summary
