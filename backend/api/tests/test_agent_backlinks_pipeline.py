"""Synthetic existing-Core contract checks. No real business jobs or provider calls."""
import asyncio
import base64
import json
from contextlib import asynccontextmanager
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from fastapi.responses import Response
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql
from test_agent_activities import ProjectMemoryRepository
from test_agent_backlinks_drafts import (
    ARGS,
    CONTACT,
    CONTEXT,
    DRAFT,
    JOB,
    META,
    OPP,
    SETTINGS,
    Projects,
    grant,
)

from app.core.backlinks_gateway import BacklinksGateway
from app.core.platform_request_context import PLATFORM_CONTEXT_HEADER
from app.modules.agent import activities
from app.modules.agent.backlinks_automation import BACKLINKS_READY_TRIGGER, record_backlinks_ready
from app.modules.agent.backlinks_pipeline import PIPELINE_WRITE_MODELS, child_operation
from app.modules.agent.backlinks_read import BacklinksReader, BacklinksReadError
from app.modules.agent.model_gateway import compact_tool_result
from app.modules.agent.repository import AgentRepository
from app.modules.agent.tools import ToolRegistry, tool_catalog_payload
from app.modules.projects.backlinks_projection import (
    ProjectContextProjectionDispatcher,
    _serialize_context,
)

FEED = "11111111-1111-4111-8111-111111111111"
GENERATION = "22222222-2222-4222-8222-222222222222"
OPERATION = "33333333-3333-4333-8333-333333333333"
START = "start_backlink_recommendations"
JOIN = "join_backlink_recommendations"
BATCH = "create_backlink_drafts"
BATCH_ARGS = {"opportunityIds": [OPP], "request": ARGS["request"]}
SEED_META = {**META, "schemaVersion": "backlinks.recommendation-seeds.v2"}


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    async def blocked(*args, **kwargs):
        raise AssertionError("Real network is forbidden in pipeline tests")
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked)


class Core:
    def __init__(self):
        self.calls = []
        self.existing_generation = None
        self.next_batch_state = "RELEASED"
        self.batches = []
        self.seed_state = "READY"
        self.scope_override = {}
        self.fail_path = None
        self.saved = {}
        self.detail = {
            "id": OPP, "draftId": None, "managementStatus": "ACTIVE",
            "primaryNextAction": {"kind": "CREATE_EMAIL_DRAFT", "enabled": True},
        }
        self.contacts = {
            "items": [{
                "id": CONTACT, "opportunityId": OPP, "status": "active",
                "guessed": False, "normalizedEmail": "editor@example.test",
                "confirmedAt": META["generatedAt"], "version": 1,
            }],
            "selection": {"state": "AUTO_SELECTED", "autoSelectedContactId": CONTACT},
            "meta": META,
        }

    def respond(self, request):
        self.calls.append(request)
        path = request.url.path.split("/backlinks/")[1]
        assert "send" not in path and "gmail" not in path and "approve" not in path
        if path == self.fail_path:
            return httpx.Response(503, json={"error": "synthetic"})
        if request.method == "GET":
            if path == "recommendation-feed":
                data = {
                    "items": [], "releasedPool": {"filterOptions": {"batches": self.batches}},
                    "latestGeneration": self.existing_generation,
                    "totalCount": 0, "nextCursor": None,
                    "meta": {**META, "schemaVersion": "backlinks.recommendation-feed.v2"},
                }
            elif path == f"opportunities/{OPP}":
                data = {"item": self.detail, "meta": META}
            elif path == f"opportunities/{OPP}/contacts":
                data = self.contacts
            elif path == f"draft-jobs/{JOB}":
                data = {"job": {"id": JOB, "draftId": DRAFT, "status": "QUEUED"}, "meta": META}
            else:
                raise AssertionError(path)
            return httpx.Response(200, json=data)
        assert request.method == "POST"
        body = json.loads(request.content)
        key = request.headers["idempotency-key"]
        if key in self.saved:
            assert self.saved[key] == (path, body)
        self.saved[key] = (path, body)
        meta = {**META, **self.scope_override}
        status = 200
        if path == "recommendation-user-release/get-more":
            assert body == {}
            data = {
                "state": self.next_batch_state, "releasedBatchOrdinal": 2,
                "currentBatchOrdinal": 2, "replayed": False,
                "meta": {**meta, "schemaVersion": "backlinks.recommendation-user-release.v2"},
            }
        elif path == "recommendation-seeds/generate":
            assert body == {"seeds": []}
            data = {
                "state": self.seed_state, "reasonCodes": ["MISSING_INPUT"],
                "confirmation": {
                    "generationContractId": GENERATION, "seedSnapshotFingerprint": "a" * 64,
                },
                "meta": {**SEED_META, **self.scope_override},
            }
        elif path == "recommendation-seeds/launch":
            assert body == {
                "generationContractId": GENERATION, "seedSnapshotFingerprint": "a" * 64,
            }
            data = {
                "state": "STARTED", "generationContractId": GENERATION, "jobId": JOB,
                "meta": {**SEED_META, **self.scope_override},
            }
        elif path == "opportunities":
            assert body == {"recommendationFeedItemId": FEED}
            status = 201
            data = {
                "recommendationFeedItemId": FEED, "opportunityId": OPP,
                "existingOpportunity": False, "contactReviewRequired": False, "meta": meta,
            }
        elif path == f"opportunities/{OPP}/draft-jobs":
            assert body["contactId"] == CONTACT
            assert body["contactVersion"] == 1
            assert body["logicalDraftKey"] == f"agent-initial:{OPP}"
            status = 202
            data = {
                "contactId": CONTACT, "contactVersion": 1, "jobId": JOB, "draftId": DRAFT,
                "generationMode": "MODEL", "replayed": False, "meta": meta,
            }
        else:
            raise AssertionError(path)
        return httpx.Response(status, json=data)


async def with_registry(core, check):
    client = httpx.AsyncClient(transport=httpx.MockTransport(core.respond))
    gateway = BacklinksGateway(
        base_url="http://core.test", signing_key="k" * 32, client=client,
    )
    registry = ToolRegistry(
        SETTINGS, None, None, backlinks=BacklinksReader(SETTINGS, Projects(), gateway=gateway),
    )
    try:
        return await check(registry)
    finally:
        await client.aclose()


async def invoke(registry, name, args, operation=OPERATION):
    scope = {"organization_id": "org", "delegation": grant()}
    prepared = await registry.prepare_write("project", name, args, operation, **scope)
    return await registry.execute_write(
        "project", name, prepared.arguments, prepared.before, prepared.parameters_hash, **scope,
    )


def test_start_join_draft_reuses_existing_contracts_and_never_sends():
    core = Core()

    async def check(registry):
        started = await invoke(registry, START, {})
        assert started["verification"] == "job_acceptance_only"
        assert started["jobId"] == JOB
        joined = await invoke(registry, JOIN, {"recommendationFeedItemIds": [FEED]})
        assert joined["results"][0]["opportunityId"] == OPP
        drafted = await invoke(registry, BATCH, BATCH_ARGS)
        assert drafted["results"][0]["state"] == "JOB_ACCEPTED"
        assert drafted["results"][0]["status"] == "QUEUED"
        assert drafted["results"][0]["draftId"] == DRAFT
        assert drafted["sent"] is False
        assert drafted["remainingIds"] == []
        # Replaying the same operation keeps all downstream command keys/bodies.
        await invoke(registry, START, {})
        await invoke(registry, JOIN, {"recommendationFeedItemIds": [FEED]})
        await invoke(registry, BATCH, BATCH_ARGS)
        compacted = compact_tool_result({"tool": BATCH, "ok": True, "data": drafted})
        assert compacted["data"] == drafted

    asyncio.run(with_registry(core, check))
    assert len(core.saved) == 4
    for request in core.calls:
        encoded = request.headers[PLATFORM_CONTEXT_HEADER]
        envelope = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
        assert envelope["actor"]["userId"] == "real-user"
        assert envelope["tenant"]["organizationId"] == "org"
        assert envelope["project"]["websiteProjectId"] == "project"
        assert request.url.path.startswith("/api/v1/projects/key/backlinks/")


@pytest.mark.parametrize("existing", [{"jobState": "RUNNING"}, {"jobState": "FAILED"}, {}])
def test_existing_generation_blocks_new_generation(existing):
    core = Core()
    core.existing_generation = existing

    async def check(registry):
        with pytest.raises(ValueError, match="GENERATION_EXISTS"):
            await invoke(registry, START, {})
    asyncio.run(with_registry(core, check))
    assert not core.saved


def test_input_required_does_not_launch():
    core = Core()
    core.seed_state = "INPUT_REQUIRED"
    result = asyncio.run(with_registry(core, lambda r: invoke(r, START, {})))
    assert result["state"] == "INPUT_REQUIRED"
    assert len(core.saved) == 1


def test_next_batch_pins_pool_generation_and_reuses_get_more_without_new_provider_job():
    core = Core()
    core.existing_generation = {"generationContractId": GENERATION, "visiblePoolGeneration": 3}
    core.batches = [
        {"batchId": OPP, "batchOrdinal": 2, "visiblePoolGeneration": 2},
        {"batchId": FEED, "batchOrdinal": 2, "visiblePoolGeneration": 3},
    ]
    async def check(registry):
        result = await invoke(registry, START, {"mode": "next_batch"})
        assert result["state"] == "RELEASED" and result["batchId"] == FEED
        assert result["visiblePoolGeneration"] == 3
        await registry.backlinks.read("project", "org", "list_backlink_recommendations",
                                      {"batchId": FEED}, delegation=grant())
        assert core.calls[-1].url.params["batchId"] == FEED
    asyncio.run(with_registry(core, check))
    assert [path for path, _ in core.saved.values()] == ["recommendation-user-release/get-more"]


@pytest.mark.parametrize("state", ["POOL_EXHAUSTED", "NEXT_BATCH_PREPARING", "INITIAL_BATCH_NOT_READY"])
def test_next_batch_not_ready_never_substitutes_existing_items(state):
    core = Core()
    core.existing_generation = {"generationContractId": GENERATION, "visiblePoolGeneration": 3}
    core.next_batch_state = state
    result = asyncio.run(with_registry(core, lambda r: invoke(r, START, {"mode": "next_batch"})))
    assert result["state"] == state and "batchId" not in result and result["sent"] is False


def test_next_batch_rejects_ambiguous_readback():
    core = Core()
    core.existing_generation = {"generationContractId": GENERATION, "visiblePoolGeneration": 3}
    async def check(registry):
        with pytest.raises(BacklinksReadError, match="BATCH_READBACK_MISMATCH"):
            await invoke(registry, START, {"mode": "next_batch"})
    asyncio.run(with_registry(core, check))


@pytest.mark.parametrize("change", [
    {"draftId": DRAFT},
    {"managementStatus": "PAUSED"},
    {"managementStatus": "ARCHIVED"},
    {"primaryNextAction": {"kind": "CREATE_EMAIL_DRAFT", "enabled": False}},
    {"primaryNextAction": {"kind": "SEND_EMAIL", "enabled": True}},
])
def test_ineligible_opportunities_never_create_jobs(change):
    core = Core()
    core.detail.update(change)
    result = asyncio.run(with_registry(core, lambda r: invoke(r, BATCH, BATCH_ARGS)))
    assert result["results"][0]["state"] in {"EXISTING_DRAFT", "SKIPPED"}
    assert not core.saved


@pytest.mark.parametrize("failure", [
    "none", "ambiguous", "guessed", "inactive", "unconfirmed", "no_email", "wrong_opportunity",
    "selection_missing", "duplicate_selected",
])
def test_only_authoritative_confirmed_contact_is_used(failure):
    core = Core()
    contact = core.contacts["items"][0]
    if failure == "none":
        core.contacts["items"] = []
    elif failure == "ambiguous":
        core.contacts["selection"]["state"] = "USER_SELECTION_REQUIRED"
    elif failure == "guessed":
        contact["guessed"] = True
    elif failure == "inactive":
        contact["status"] = "inactive"
    elif failure == "unconfirmed":
        contact["confirmedAt"] = None
    elif failure == "no_email":
        contact["normalizedEmail"] = None
    elif failure == "wrong_opportunity":
        contact["opportunityId"] = FEED
    elif failure == "selection_missing":
        core.contacts["selection"]["autoSelectedContactId"] = None
    else:
        core.contacts["items"].append(dict(contact))
    result = asyncio.run(with_registry(core, lambda r: invoke(r, BATCH, BATCH_ARGS)))
    assert result["results"][0]["reason"] == "CONFIRMED_CONTACT_REQUIRED"
    assert not core.saved


@pytest.mark.parametrize("name,args", [
    (START, {"seeds": []}), (START, {"confirmation": {}}),
    (JOIN, {"recommendationFeedItemIds": [FEED, FEED]}),
    (JOIN, {"recommendationFeedItemIds": []}),
    (JOIN, {"recommendationFeedItemIds": [str(uuid4()) for _ in range(11)]}),
    (JOIN, {"recommendationFeedItemIds": [FEED], "organization_id": "other"}),
    (BATCH, {**BATCH_ARGS, "opportunityIds": [OPP, OPP]}),
    (BATCH, {**BATCH_ARGS, "opportunityIds": []}),
    (BATCH, {**BATCH_ARGS, "contactId": CONTACT}),
    (BATCH, {**BATCH_ARGS, "delegation": {}}),
    (BATCH, {**BATCH_ARGS, "operation_id": OPERATION}),
    (BATCH, {**BATCH_ARGS, "send": True}),
])
def test_models_reject_scope_injection_duplicates_and_unbounded_batches(name, args):
    with pytest.raises(ValidationError):
        PIPELINE_WRITE_MODELS[name].model_validate(args)


@pytest.mark.parametrize("name,args", [(START, {}), (JOIN, {"recommendationFeedItemIds": [FEED]}),
                                       (BATCH, BATCH_ARGS)])
@pytest.mark.parametrize("failure", ["missing", "readonly", "organization", "changed_arguments"])
def test_authorization_and_prepared_argument_binding(name, args, failure):
    core = Core()

    async def check(registry):
        scope = {"organization_id": "org", "delegation": grant()}
        prepared = await registry.prepare_write("project", name, args, OPERATION, **scope)
        if failure == "missing":
            scope["delegation"] = None
        elif failure == "readonly":
            scope["delegation"] = grant(replace(CONTEXT, permissions=("backlinks:read",)))
        elif failure == "organization":
            scope["organization_id"] = "other"
        else:
            prepared.arguments["operation_id"] = "changed"
        with pytest.raises(ValueError, match="BACKLINKS_"):
            await registry.execute_write(
                "project", name, prepared.arguments, prepared.before, prepared.parameters_hash, **scope,
            )
    asyncio.run(with_registry(core, check))
    assert not core.saved


def test_uncertain_batch_item_stops_and_retains_remaining_ids():
    core = Core()
    core.fail_path = f"opportunities/{OPP}/draft-jobs"
    other = str(uuid4())
    result = asyncio.run(with_registry(core, lambda r: invoke(
        r, BATCH, {**BATCH_ARGS, "opportunityIds": [OPP, other]},
    )))
    assert result["results"] == [{
        "id": OPP, "state": "UNVERIFIED", "next": "Read persisted state before retrying.",
    }]
    assert result["remainingIds"] == [other]
    assert len([r for r in core.calls if r.method == "POST"]) == 1


def test_successful_first_item_is_preserved_when_later_read_is_uncertain():
    core = Core()
    other, remaining = str(uuid4()), str(uuid4())
    core.fail_path = f"opportunities/{other}"
    result = asyncio.run(with_registry(core, lambda r: invoke(
        r, BATCH, {**BATCH_ARGS, "opportunityIds": [OPP, other, remaining]},
    )))
    assert result["results"][0]["state"] == "JOB_ACCEPTED"
    assert result["results"][0]["jobId"] == JOB
    assert result["results"][1]["state"] == "UNVERIFIED"
    assert result["remainingIds"] == [remaining]
    assert result["verified"] is False


def test_skip_does_not_prevent_a_later_eligible_item():
    core = Core()
    skipped = str(uuid4())
    respond = core.respond

    def with_skipped(request):
        if request.url.path.endswith(f"/opportunities/{skipped}"):
            return httpx.Response(200, json={
                "item": {**core.detail, "id": skipped, "managementStatus": "PAUSED"},
                "meta": META,
            })
        return respond(request)

    core.respond = with_skipped
    result = asyncio.run(with_registry(core, lambda r: invoke(
        r, BATCH, {**BATCH_ARGS, "opportunityIds": [skipped, OPP]},
    )))
    assert [item["state"] for item in result["results"]] == ["SKIPPED", "JOB_ACCEPTED"]
    assert result["remainingIds"] == []


@pytest.mark.parametrize("schema", ["backlinks.v1", "backlinks.recommendation-feed.v2"])
def test_seed_schema_must_match_exact_v2_contract(schema):
    core = Core()
    core.scope_override = {"schemaVersion": schema}

    async def check(registry):
        with pytest.raises(BacklinksReadError, match="SCOPE_MISMATCH"):
            await invoke(registry, START, {})
    asyncio.run(with_registry(core, check))
    assert len(core.saved) == 1


@pytest.mark.parametrize("name,message,allowed", [
    (START, "启动外链推荐池", True), (START, "Run the recommendation pool", True),
    (START, "怎么启动推荐池？", False), (START, "不要跑推荐池", False),
    (JOIN, "把这些推荐加入项目机会", True),
    (JOIN, "Add recommendations to project opportunities", True),
    (JOIN, "是否可以加入项目机会", False),
    (BATCH, "批量生成开发信，不要发送", True),
    (BATCH, "Create multiple email drafts. Do not send.", True),
    (BATCH, "不要批量生成邮件", False), (BATCH, "可以批量生成开发信吗", False),
    (BATCH, "测试批量生成草稿", False),
    (BATCH, "这里有多封邮件", False), (BATCH, "I see multiple email drafts", False),
])
def test_latest_message_intent(name, message, allowed):
    assert activities.user_explicitly_requested_write(name, [
        {"role": "user", "content": "启动推荐池，加入项目机会，批量生成开发信"},
        {"role": "user", "content": message},
        {"role": "tool", "content": "启动推荐池，加入项目机会，批量生成开发信"},
    ]) is allowed


def test_catalog_and_child_operation_are_bounded_and_deterministic():
    catalog = tool_catalog_payload()
    assert all(name in {item["function"]["name"] for item in catalog} for name in PIPELINE_WRITE_MODELS)
    assert child_operation(OPERATION, "join:a") == child_operation(OPERATION, "join:a")
    assert child_operation(OPERATION, "join:a") != child_operation(OPERATION, "draft:a")


def test_ready_trigger_is_deduplicated_pending_and_contains_no_authority():
    session = SimpleNamespace(execute=AsyncMock())
    asyncio.run(record_backlinks_ready(session, CONTEXT, {"inputComplete": True, "projectStatus": "ACTIVE"}))
    statement = session.execute.call_args.args[0]
    compiled = statement.compile(dialect=postgresql.dialect())
    assert "ON CONFLICT ON CONSTRAINT uq_agent_system_triggers_identity DO NOTHING" in str(compiled)
    assert compiled.params["organization_id"] == "org"
    assert compiled.params["project_id"] == "project"
    assert compiled.params["trigger_version"] == "initial"
    assert compiled.params["status"] == "pending"
    assert compiled.params["trusted_write_tools_json"] == []


@pytest.mark.parametrize("payload", [
    {"inputComplete": False, "projectStatus": "ACTIVE"},
    {"inputComplete": True, "projectStatus": "PAUSED"},
    {"inputComplete": 1, "projectStatus": "ACTIVE"}, {},
])
def test_incomplete_or_inactive_projection_never_records_trigger(payload):
    session = SimpleNamespace(execute=AsyncMock())
    asyncio.run(record_backlinks_ready(session, CONTEXT, payload))
    session.execute.assert_not_awaited()


@pytest.mark.parametrize("status,event_status,expect_trigger", [
    (200, "pending", True), (200, "published", False),
    (503, "pending", False), (403, "pending", False),
])
def test_projection_dispatch_records_ready_only_after_success(status, event_status, expect_trigger):
    statements = []
    event = {
        "id": "event", "status": event_status, "attempt_count": 0,
        "payload": {
            "context": _serialize_context(CONTEXT),
            "request": {"inputComplete": True, "projectStatus": "ACTIVE"},
        },
    }

    class Session:
        @asynccontextmanager
        async def begin(self):
            yield self

        async def scalar(self, *args):
            return True

        async def execute(self, statement, *args):
            statements.append(statement)
            return SimpleNamespace(mappings=lambda: SimpleNamespace(first=lambda: event))

    @asynccontextmanager
    async def sessions():
        yield Session()

    publisher = SimpleNamespace(publish_project_context=AsyncMock(return_value=Response(status_code=status)))
    dispatcher = ProjectContextProjectionDispatcher(sessions, publisher)
    result = asyncio.run(dispatcher.dispatch_event("event"))
    inserts = [
        stmt for stmt in statements
        if getattr(getattr(stmt, "table", None), "name", None) == "agent_system_triggers"
    ]
    assert bool(inserts) is expect_trigger
    if event_status == "published":
        publisher.publish_project_context.assert_not_awaited()
    else:
        publisher.publish_project_context.assert_awaited_once()
    assert result.status == ("published" if status == 200 else "failed")


def test_pending_backlinks_trigger_is_excluded_before_limit_without_starving_onboarding():
    statements = []

    class Session:
        async def scalars(self, statement):
            statements.append(statement)
            return SimpleNamespace(all=list)

        async def commit(self):
            pass

    @asynccontextmanager
    async def sessions():
        yield Session()

    repo = AgentRepository(sessions)
    assert asyncio.run(repo.materialize_pending_system_triggers({})) == []
    compiled = statements[0].compile(dialect=postgresql.dialect())
    sql = str(compiled)
    assert "trigger !=" in sql
    assert BACKLINKS_READY_TRIGGER in compiled.params.values()
    assert sql.index("trigger !=") < sql.index("LIMIT")


@pytest.mark.parametrize("tool,args,message", [
    (START, {}, "启动外链推荐池"),
    (JOIN, {"recommendationFeedItemIds": [FEED]}, "加入项目机会"),
    (BATCH, BATCH_ARGS, "批量生成邮件草稿"),
])
@pytest.mark.parametrize("blocked", [False, True])
def test_activity_uses_saved_scope_and_replays_completed_results(monkeypatch, tool, args, message, blocked):
    core = Core()
    if blocked:
        if tool == START:
            core.seed_state = "INPUT_REQUIRED"
        else:
            core.fail_path = "opportunities" if tool == JOIN else f"opportunities/{OPP}/draft-jobs"

    class Repo(ProjectMemoryRepository):
        completed = None

        async def get_run_context(self, run_id):
            context = await super().get_run_context(run_id)
            return {
                **context, "project_id": "project", "organization_id": "org",
                "limits": {**context["limits"], "backlinks_delegation": grant()},
                "messages": [{"role": "user", "content": message}],
            }

        async def claim_registered_tool(self, *_claim_args):
            return ("completed" if self.completed else "claimed"), SimpleNamespace(
                tool_name=tool, arguments_json=args, parameters_hash="",
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

    async def check(registry):
        monkeypatch.setattr(activities, "repository", lambda: repo)
        monkeypatch.setattr(activities, "registry", lambda: registry)
        payload = {"run_id": "dry-run", "tool_call_id": tool, "project_id": "untrusted"}
        result = await activities.execute_tool(payload)
        assert result["ok"] is True
        if blocked:
            if tool == START:
                assert result["data"]["state"] == "INPUT_REQUIRED"
            else:
                assert result["data"]["verified"] is False
                assert result["data"]["results"][0]["state"] == "UNVERIFIED"
        calls = len(core.calls)
        assert await activities.execute_tool(payload) == result
        assert len(core.calls) == calls

    asyncio.run(with_registry(core, check))
