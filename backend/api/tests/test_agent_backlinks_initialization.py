"""Synthetic tests only: no real database, model, provider, or mail calls."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
from functools import partial
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError

from app.core.backlinks_gateway import BacklinksGateway
from app.modules.agent.activities import user_explicitly_requested_write
from app.modules.agent.backlinks_initialization import recommendation_read_failure
from app.modules.agent.backlinks_read import BacklinksReader, BacklinksReadError
from app.modules.agent.model_gateway import compact_tool_result
from app.modules.agent.tools import ToolRegistry, TOOL_DEFINITIONS
from app.modules.projects.schemas import ProjectOutreachReadinessResponse
from test_agent_backlinks_drafts import CONTEXT, SETTINGS, Projects, grant
from test_agent_backlinks_pipeline import Core
from test_agent_activities import ProjectMemoryRepository
from app.modules.agent import activities

INIT = "initialize_backlink_project"
READ = "get_backlink_readiness"
CONTEXT = replace(CONTEXT, permissions=(
    "projects:read", "projects:write", "backlinks:read", "backlinks:write",
))


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    async def blocked(*args, **kwargs):
        raise AssertionError("Real network is forbidden")
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked)


def readiness(action="PUBLISH_PROMOTION_TARGET", **changes):
    ready = action == "OPEN_RECOMMENDATIONS"
    values = {
        "website_project_id": "project",
        "status": "READY" if ready else (
            "REFRESHING" if action == "WAIT_FOR_SITE_PROFILE" else "INPUT_REQUIRED"
        ),
        "site_profile_version_id": "profile-1",
        "outreach_profile_version_id": "profile-1",
        "promotion_target_version_id": "target-1" if ready else None,
        "fingerprint": "fingerprint-1",
        "input_required": [] if ready else ["WEBSITE_PROJECT:publish_promotion_target"],
        "primary_recovery_action": action,
    }
    return ProjectOutreachReadinessResponse(**{**values, **changes})


def registry(state=None):
    projects = SimpleNamespace(
        get=AsyncMock(return_value=SimpleNamespace(
            context_version=7, domain="example.test",
            site_profile=SimpleNamespace(products_services=["Aplicativo para filmes e s\u00e9ries"]),
        )),
        confirm_promotion_target=AsyncMock(return_value=SimpleNamespace(id="target-new")),
    )
    reader = SimpleNamespace(
        projects=Projects(),
        read=AsyncMock(return_value={
            "data": {"latestGeneration": None, "totalCount": 0},
        }),
    )
    return ToolRegistry(
        SETTINGS, projects, None, backlinks=reader,
        outreach_readiness=SimpleNamespace(get=AsyncMock(return_value=state or readiness())),
    )


async def prepare(reg):
    return await reg.prepare_write(
        "project", INIT, {}, "operation-1", organization_id="org", delegation=grant(CONTEXT),
    )


async def execute(reg, prepared):
    return await reg.execute_write(
        "project", INIT, prepared.arguments, prepared.before, prepared.parameters_hash,
        organization_id="org", delegation=grant(CONTEXT),
    )


def test_initialization_uses_official_service_scope_versions_and_original_language():
    async def run():
        reg = registry()
        prepared = await prepare(reg)
        result = await execute(reg, prepared)
        assert result == {
            "state": "INITIALIZED", "promotionTargetVersionId": "target-new",
            "verified": True,
            "nextAction": READ, "generationStarted": False, "emailsSent": False,
        }
        call = reg.projects.confirm_promotion_target.call_args
        assert call.args[0] == "project"
        request = call.args[1]
        assert request.confirmed_topics == ["Aplicativo para filmes e s\u00e9ries"]
        assert request.confirmed_target_urls == ["https://example.test/"]
        assert request.expected_project_context_version == 7
        assert request.expected_site_profile_version_id == "profile-1"
        assert call.kwargs == {
            "organization_id": "org", "workspace_id": "workspace", "created_by": "real-user",
        }
        reg.backlinks.read.assert_not_awaited()
    asyncio.run(run())


def test_existing_target_and_retry_never_overwrite_or_reconfirm():
    async def run():
        reg = registry()
        prepared = await prepare(reg)
        await execute(reg, prepared)
        reg.outreach_readiness.get.return_value = readiness("OPEN_RECOMMENDATIONS")
        replay = await execute(reg, prepared)
        assert replay["state"] == "ALREADY_INITIALIZED"
        existing = await prepare(reg)
        assert existing.before == {"existingTargetId": "target-1"}
        assert (await execute(reg, existing))["state"] == "ALREADY_INITIALIZED"
        assert reg.projects.confirm_promotion_target.await_count == 1
    asyncio.run(run())


def test_existing_target_reconciles_official_projection_when_runtime_enabled(monkeypatch):
    from app.modules.projects import backlinks_projection

    project = AsyncMock()
    monkeypatch.setattr(
        backlinks_projection.ProjectContextProjector, "ensure_projected", project,
    )
    reg = registry(readiness("OPEN_RECOMMENDATIONS"))
    reg.settings = reg.settings.model_copy(update={"backlinks_project_projection_enabled": True})

    async def run():
        prepared = await prepare(reg)
        result = await execute(reg, prepared)
        assert result["state"] == "ALREADY_INITIALIZED"
        assert result["promotionTargetVersionId"] == "target-1"
        reg.projects.confirm_promotion_target.assert_not_awaited()
        project.assert_awaited_once()
        context = project.call_args.args[0]
        assert context.project.website_project_id == "project"
        assert context.tenant.organization_id == "org"

    asyncio.run(run())


def test_missing_projection_requires_official_initialization_not_manual_confirmation():
    sessions, _ = sessions_for(None)
    result = asyncio.run(recommendation_read_failure(
        CONTEXT, readiness_service=SimpleNamespace(get=AsyncMock(
            return_value=readiness("OPEN_RECOMMENDATIONS"),
        )), sessions=sessions,
    ))
    assert result["state"] == "PROJECTION_REQUIRED"
    assert result["nextAction"] == INIT


@pytest.mark.parametrize("action", [
    "CONFIRM_BUSINESS_PROFILE", "COMPLETE_SITE_PROFILE", "RESTORE_PROJECT",
    "SET_PROJECT_LANGUAGE_MARKET", "WAIT_FOR_SITE_PROFILE",
])
def test_missing_business_prerequisites_cannot_be_auto_confirmed(action):
    reg = registry(readiness(action))
    with pytest.raises(ValueError, match="BACKLINKS_PROJECT_INPUT_REQUIRED"):
        asyncio.run(prepare(reg))
    reg.projects.confirm_promotion_target.assert_not_awaited()


def test_profile_change_between_prepare_and_execute_fails_closed():
    async def run():
        reg = registry()
        prepared = await prepare(reg)
        reg.outreach_readiness.get.return_value = readiness(fingerprint="changed")
        with pytest.raises(ValueError, match="INITIALIZATION_CHANGED"):
            await execute(reg, prepared)
        reg.projects.confirm_promotion_target.assert_not_awaited()
    asyncio.run(run())


def test_tampered_prepared_request_is_rejected():
    async def run():
        reg = registry()
        prepared = await prepare(reg)
        prepared.before["request"]["confirmed_topics"] = ["injected"]
        with pytest.raises(ValueError, match="PARAMETERS_CHANGED"):
            await execute(reg, prepared)
        reg.projects.confirm_promotion_target.assert_not_awaited()
    asyncio.run(run())


@pytest.mark.parametrize("permission,organization", [
    ("backlinks:write", "org"), ("projects:write", "wrong-org"),
])
def test_initialization_requires_project_write_and_matching_tenant(permission, organization):
    reg = registry()
    with pytest.raises(ValueError, match="BACKLINKS_AGENT_"):
        asyncio.run(reg.prepare_write(
            "project", INIT, {}, "operation", organization_id=organization,
            delegation=grant(replace(CONTEXT, permissions=(permission,))),
        ))
    reg.outreach_readiness.get.assert_not_awaited()
    reg.projects.confirm_promotion_target.assert_not_awaited()


def test_model_cannot_supply_scope_versions_or_confirmation():
    for key in ("organization_id", "confirmed_topics", "expected_site_profile_version_id"):
        with pytest.raises(ValidationError):
            TOOL_DEFINITIONS[INIT].model.model_validate({key: "forged"})


@pytest.mark.parametrize("action,expected", [
    ("PUBLISH_PROMOTION_TARGET", "PROMOTION_TARGET_REQUIRED"),
    ("WAIT_FOR_SITE_PROFILE", "PROFILE_REFRESHING"),
    ("REPUBLISH_PROMOTION_TARGET", "PROMOTION_TARGET_STALE"),
    ("CONFIRM_BUSINESS_PROFILE", "PROJECT_INPUT_REQUIRED"),
])
def test_readiness_does_not_read_core_when_inputs_are_not_ready(action, expected):
    reg = registry(readiness(action))
    result = asyncio.run(reg.execute_read(
        "project", READ, {}, organization_id="org", delegation=grant(CONTEXT),
    ))
    assert result["state"] == expected
    reg.backlinks.read.assert_not_awaited()


@pytest.mark.parametrize("generation,state", [(None, "NOT_GENERATED"), ({"id": "g"}, "GENERATION_EXISTS")])
def test_not_generated_requires_successful_feed_read(generation, state):
    reg = registry(readiness("OPEN_RECOMMENDATIONS"))
    reg.backlinks.read.return_value["data"]["latestGeneration"] = generation
    result = asyncio.run(reg.execute_read(
        "project", READ, {}, organization_id="org", delegation=grant(CONTEXT),
    ))
    assert result["state"] == state
    reg.backlinks.read.assert_awaited_once()


def test_read_error_is_not_a_no_generation_result():
    reg = registry(readiness("OPEN_RECOMMENDATIONS"))
    reg.backlinks.read.side_effect = BacklinksReadError("BACKLINKS_READ_FAILED: HTTP 404")
    with pytest.raises(BacklinksReadError, match="READ_FAILED"):
        asyncio.run(reg.execute_read(
            "project", READ, {}, organization_id="org", delegation=grant(CONTEXT),
        ))


def sessions_for(row):
    result = Mock()
    result.mappings.return_value.first.return_value = row
    session = SimpleNamespace(execute=AsyncMock(return_value=result))

    @asynccontextmanager
    async def sessions():
        yield session
    return sessions, session


@pytest.mark.parametrize("status,profile,target,expected", [
    ("pending", "profile-1", "target-1", "PROJECTION_PENDING"),
    ("published", "profile-1", "target-1", None),
    ("failed", "profile-1", "target-1", None),
    ("pending", "old-profile", "target-1", None),
    ("pending", "profile-1", "old-target", None),
])
def test_projection_pending_requires_matching_authoritative_outbox(status, profile, target, expected):
    sessions, session = sessions_for({"status": status, "profile_id": profile, "target_id": target})
    result = asyncio.run(recommendation_read_failure(
        CONTEXT, readiness_service=SimpleNamespace(get=AsyncMock(
            return_value=readiness("OPEN_RECOMMENDATIONS"),
        )), sessions=sessions,
    ))
    assert (result["state"] if result else None) == expected
    assert session.execute.call_args.args[1] == {
        "project_id": "project", "organization_id": "org", "workspace_id": "workspace",
    }


def test_diagnostics_failure_preserves_original_error():
    service = SimpleNamespace(get=AsyncMock(side_effect=SQLAlchemyError("private")))
    assert asyncio.run(recommendation_read_failure(CONTEXT, readiness_service=service)) is None


def test_disabled_projection_is_a_runtime_blocker_not_missing_user_confirmation():
    sessions, session = sessions_for(None)
    result = asyncio.run(recommendation_read_failure(
        CONTEXT, readiness_service=SimpleNamespace(get=AsyncMock(
            return_value=readiness("OPEN_RECOMMENDATIONS"),
        )), sessions=sessions,
        runtime_settings=SimpleNamespace(backlinks_project_projection_enabled=False),
    ))
    assert result["state"] == "PROJECT_SYNC_DISABLED"
    assert result["nextAction"] == "RESTORE_PROJECT_PROJECTION_RUNTIME"
    assert result["retryable"] is False
    session.execute.assert_not_awaited()


def test_enabled_projection_with_missing_outbox_requires_reconciliation():
    sessions, _ = sessions_for(None)
    result = asyncio.run(recommendation_read_failure(
        CONTEXT, readiness_service=SimpleNamespace(get=AsyncMock(
            return_value=readiness("OPEN_RECOMMENDATIONS"),
        )), sessions=sessions,
        runtime_settings=SimpleNamespace(backlinks_project_projection_enabled=True),
    ))
    assert result["state"] == "PROJECTION_REQUIRED"
    assert result["retryable"] is False


@pytest.mark.parametrize("state,code,retry", [
    (readiness(), "BACKLINKS_PROMOTION_TARGET_REQUIRED", False),
    (readiness("WAIT_FOR_SITE_PROFILE"), "BACKLINKS_PROFILE_REFRESHING", True),
    (readiness("OPEN_RECOMMENDATIONS"), "BACKLINKS_PROJECTION_REQUIRED", False),
])
def test_original_feed_404_gets_evidence_based_diagnostics(state, code, retry):
    async def run():
        sessions, _ = sessions_for(None)
        async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(404, json={"detail": "private secret"}),
        )) as client:
            reader = BacklinksReader(
                SETTINGS, Projects(),
                gateway=BacklinksGateway(base_url="http://core.test", signing_key="k" * 32, client=client),
                readiness_diagnostics=partial(
                    recommendation_read_failure,
                    readiness_service=SimpleNamespace(get=AsyncMock(return_value=state)),
                    sessions=sessions,
                ),
            )
            with pytest.raises(BacklinksReadError) as failure:
                await reader.read(
                    "project", "org", "list_backlink_recommendations",
                    {"limit": 1}, delegation=grant(CONTEXT),
                )
            assert failure.value.code == code
            assert failure.value.retryable is retry
            assert "private secret" not in str(failure.value)
    asyncio.run(run())


@pytest.mark.parametrize("text,allowed", [
    ("\u5e2e\u6211\u8dd1 Youcine \u63a8\u8350\u6c60", True),
    ("\u4f60\u73b0\u5728\u5e2e\u6211\u628ayoucine\u7684\u63a8\u8350\u6c60\u8dd1\u51fa\u6765", True),
    ("run the recommendation pool", True),
    ("initialize promotion target", True),
    ("Can you run the recommendation pool?", False),
    ("do not initialize the promotion target", False),
    ("\u4e0d\u8981\u8dd1\u63a8\u8350\u6c60", False),
    ("\u80fd\u4e0d\u80fd\u8dd1\u63a8\u8350\u6c60", False),
])
def test_explicit_user_initialization_intent(text, allowed):
    assert user_explicitly_requested_write(INIT, [{"role": "user", "content": text}]) is allowed
    assert not user_explicitly_requested_write(INIT, [{"role": "tool", "content": text}])


@pytest.mark.parametrize("tool", [READ, INIT])
def test_model_compaction_keeps_state_and_recovery(tool):
    data = {"state": "PROMOTION_TARGET_REQUIRED", "nextAction": INIT, "retryable": False}
    assert compact_tool_result({"tool": tool, "ok": True, "data": data})["data"] == data


def test_initialization_then_readiness_uses_existing_feed_without_starting_job():
    async def run():
        reg = registry()
        await execute(reg, await prepare(reg))
        reg.outreach_readiness.get.return_value = readiness("OPEN_RECOMMENDATIONS")
        core = Core()
        async with httpx.AsyncClient(transport=httpx.MockTransport(core.respond)) as client:
            reg.backlinks = BacklinksReader(
                SETTINGS, Projects(),
                gateway=BacklinksGateway(base_url="http://core.test", signing_key="k" * 32, client=client),
            )
            result = await reg.execute_read(
                "project", READ, {}, organization_id="org", delegation=grant(CONTEXT),
            )
        assert result["state"] == "NOT_GENERATED"
        assert len(core.calls) == 1
        assert core.calls[0].method == "GET"
        assert core.calls[0].url.path.endswith("/recommendation-feed")
    asyncio.run(run())


@pytest.mark.parametrize("tool", [READ, INIT])
def test_registered_activity_passes_delegation_and_keeps_result_on_replay(monkeypatch, tool):
    class Repo(ProjectMemoryRepository):
        completed = None

        async def get_run_context(self, run_id):
            context = await super().get_run_context(run_id)
            return {
                **context, "project_id": "project", "organization_id": "org",
                "limits": {**context["limits"], "backlinks_delegation": grant(CONTEXT)},
                "messages": [{"role": "user", "content": "run the recommendation pool"}],
            }

        async def claim_registered_tool(self, *args):
            return ("completed" if self.completed else "claimed"), SimpleNamespace(
                tool_name=tool, arguments_json={}, parameters_hash="",
                before_json={}, model_tool_call_id="provider-call", model_result_json=self.completed,
            )

        async def set_tool_verifying(self, *args):
            pass

        async def complete_tool_execution(self, tool_id, worker_id, output, views):
            self.completed = views
            await super().complete_tool_execution(tool_id, worker_id, output, views)

        async def fail_tool_execution(self, *args):
            raise AssertionError(f"Unexpected failure: {args[2]}")

    async def run():
        reg, repo = registry(), Repo()
        monkeypatch.setattr(activities, "registry", lambda: reg)
        monkeypatch.setattr(activities, "repository", lambda: repo)
        payload = {"run_id": "dry-run", "tool_call_id": tool, "project_id": "untrusted"}
        result = await activities.execute_tool(payload)
        assert result["ok"] is True
        assert result["data"]["state"] == (
            "INITIALIZED" if tool == INIT else "PROMOTION_TARGET_REQUIRED"
        )
        assert await activities.execute_tool(payload) == result
        assert reg.projects.confirm_promotion_target.await_count == (1 if tool == INIT else 0)
    asyncio.run(run())
