"""Consent API and isolated PostgreSQL persistence; no provider operations."""

import asyncio
import os
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
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from test_agent_backlinks_drafts import CONTEXT

from app.api.routes.agent_backlinks_consent import consent_store
from app.api.routes.agents import router
from app.core.backlinks_gateway import PlatformContextResolutionError
from app.modules.agent.backlinks_consent import (
    CONSENT_TOOLS,
    BacklinksConsentStore,
    ConsentError,
    ConsentRequest,
    view,
)

NOW = datetime(2026, 9, 14, tzinfo=UTC)
BODY = {
    "request_id": str(uuid4()),
    "policy_version": "backlinks-drafts-only.v1",
    "confirmed": True,
    "expires_at": (NOW + timedelta(days=1)).isoformat(),
    "max_opportunities": 10,
    "max_drafts": 5,
    "max_model_cost_usd": "2",
    "max_paid_tool_cost_usd": "0",
}


@pytest.fixture(autouse=True)
def no_provider_network(monkeypatch):
    async def blocked(*args, **kwargs):
        raise AssertionError("Real HTTP is forbidden")
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", blocked)


@pytest.mark.parametrize("field,value", [
    ("confirmed", False), ("confirmed", 1), ("confirmed", "true"),
    ("organization_id", "forged"), ("workspace_id", "forged"),
    ("project_id", "forged"), ("user_id", "forged"),
    ("allowed_tools", ["submit_backlink_email"]), ("sending_allowed", True),
    ("policy_version", "send-all"), ("max_opportunities", 0),
    ("max_opportunities", 101), ("max_opportunities", True),
    ("max_drafts", 11), ("max_drafts", 0),
    ("max_model_cost_usd", 0), ("max_model_cost_usd", "NaN"),
    ("max_model_cost_usd", "100.01"), ("max_paid_tool_cost_usd", -1),
    ("expires_at", "2026-09-15T00:00:00"), ("request_id", "invalid"),
])
def test_request_rejects_unbounded_or_forged_authority(field, value):
    with pytest.raises(ValidationError):
        ConsentRequest.model_validate({**BODY, field: value})


def test_money_representation_does_not_change_policy():
    first = ConsentRequest.model_validate(BODY)
    second = ConsentRequest.model_validate({**BODY, "max_model_cost_usd": "2.00"})
    assert first.policy() == second.policy()


@pytest.mark.parametrize("offset,revoked,expected", [
    (0, None, "active"), (1, None, "expired"),
    (-1, None, "expired"), (0, NOW, "revoked"),
])
def test_status_is_time_bounded_and_never_enables_automation(offset, revoked, expected):
    record = SimpleNamespace(
        id=str(uuid4()), policy_json={}, created_at=NOW,
        expires_at=NOW + timedelta(days=1), revoked_at=revoked,
    )
    result = view(record, NOW + timedelta(days=offset))
    assert result["state"] == expected
    assert result["automation_enabled"] is False
    assert result["sending_allowed"] is False
    assert set(result["allowed_tools"]) == set(CONSENT_TOOLS)
    assert not any("send" in name or "approve" in name for name in CONSENT_TOOLS)


@pytest.mark.parametrize("action", ["create", "get", "revoke"])
def test_store_requires_current_permissions_before_database_access(action):
    async def run():
        store = BacklinksConsentStore(lambda: pytest.fail("DB must not be accessed"))
        context = replace(CONTEXT, permissions=())
        argument = ConsentRequest.model_validate(BODY) if action == "create" else str(uuid4())
        with pytest.raises(ConsentError, match="PERMISSION_DENIED"):
            await getattr(store, action)(context, argument, now=NOW)
    asyncio.run(run())


@pytest.mark.parametrize("action,method,suffix,permission", [
    ("list", "GET", "", "backlinks:read"),
    ("create", "POST", "", "backlinks:write"),
    ("get", "GET", "/00000000-0000-4000-8000-000000000001", "backlinks:read"),
    ("revoke", "POST", "/00000000-0000-4000-8000-000000000001/revoke", "backlinks:write"),
])
def test_routes_resolve_server_scope_and_do_not_issue_session_delegation(action, method, suffix, permission):
    async def run():
        app = FastAPI()
        app.include_router(router)
        resolver = SimpleNamespace(resolve=AsyncMock(return_value=CONTEXT))
        app.state.platform_context_resolver = resolver
        store = AsyncMock()
        getattr(store, action).return_value = {"automation_enabled": False, "sending_allowed": False}
        app.dependency_overrides[consent_store] = lambda: store
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.request(
                method, "/api/v1/projects/server-key/agent/automation/consents" + suffix,
                **({"json": BODY} if action == "create" else {}),
            )
        assert response.status_code == 200
        assert response.json()["automation_enabled"] is False
        assert resolver.resolve.await_args.kwargs["website_project_key"] == "server-key"
        assert resolver.resolve.await_args.kwargs["required_permission"] == permission
        assert getattr(store, action).await_args.args[0] is CONTEXT
    asyncio.run(run())


@pytest.mark.parametrize("code,status", [
    ("BACKLINKS_CONSENT_NOT_FOUND", 404),
    ("BACKLINKS_CONSENT_REQUEST_CONFLICT", 409),
    ("BACKLINKS_CONSENT_EXPIRY_INVALID", 422),
])
def test_api_preserves_consent_error(code, status):
    async def run():
        app = FastAPI()
        app.include_router(router)
        app.state.platform_context_resolver = SimpleNamespace(resolve=AsyncMock(return_value=CONTEXT))
        store = AsyncMock()
        store.create.side_effect = ConsentError(code, status)
        app.dependency_overrides[consent_store] = lambda: store
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v1/projects/key/agent/automation/consents", json=BODY)
        assert response.status_code == status
        assert response.json()["detail"] == code
    asyncio.run(run())


@pytest.mark.parametrize("method,suffix", [
    ("POST", ""), ("GET", "/00000000-0000-4000-8000-000000000001"),
    ("POST", "/00000000-0000-4000-8000-000000000001/revoke"),
])
def test_api_authentication_failure_never_accesses_store(method, suffix):
    async def run():
        app = FastAPI()
        app.include_router(router)
        error = PlatformContextResolutionError(
            status=403, code="PLATFORM_PERMISSION_DENIED",
            title="Denied", detail="Synthetic denial",
        )
        app.state.platform_context_resolver = SimpleNamespace(resolve=AsyncMock(side_effect=error))
        store = AsyncMock()
        app.dependency_overrides[consent_store] = lambda: store
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            result = await client.request(
                method, "/api/v1/projects/key/agent/automation/consents" + suffix,
                **({"json": BODY} if method == "POST" and not suffix else {}),
            )
        assert result.status_code == 403
        assert not store.mock_calls
    asyncio.run(run())


async def with_test_database(check):
    raw = os.environ.get("BACKLINKS_PROJECT_PROJECTION_TEST_DATABASE_URL")
    if not raw:
        pytest.skip("Dedicated seo_agent_v11_test URL required")
    url = make_url(raw)
    assert url.database == "seo_agent_v11_test"
    assert url.host in {"127.0.0.1", "localhost"}
    engine = create_async_engine(url.set(drivername="postgresql+asyncpg"))
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            try:
                assert await connection.scalar(text("SELECT current_database()")) == "seo_agent_v11_test"
                schema = "agent_consent_test_" + uuid4().hex
                await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
                await connection.execute(text(f'SET LOCAL search_path TO "{schema}"'))
                await connection.execute(text("CREATE TABLE projects (id text PRIMARY KEY)"))
                await connection.execute(text("INSERT INTO projects(id) VALUES (:id)"), {"id": CONTEXT.project.website_project_id})
                migration = runpy.run_path(str(
                    Path(__file__).resolve().parents[1] / "migrations" / "versions"
                    / "20260914_0067_agent_backlinks_consents.py"
                ))

                def create_consent_table(sync_connection):
                    with Operations.context(MigrationContext.configure(sync_connection)):
                        migration["upgrade"]()

                await connection.run_sync(create_consent_table)
                await connection.execute(text("CREATE TABLE agent_runs (id text PRIMARY KEY, status text)"))
                continuation_migration = runpy.run_path(str(
                    Path(__file__).resolve().parents[1] / "migrations" / "versions"
                    / "20260914_0068_agent_backlinks_continuations.py"
                ))

                def create_continuation_table(sync_connection):
                    with Operations.context(MigrationContext.configure(sync_connection)):
                        continuation_migration["upgrade"]()

                await connection.run_sync(create_continuation_table)
                sessions = async_sessionmaker(
                    bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint",
                )
                await check(BacklinksConsentStore(sessions))
            finally:
                # All test DDL and records disappear with this outer rollback.
                await transaction.rollback()
    finally:
        await engine.dispose()


def test_postgres_replay_conflict_revocation_and_expiry():
    async def check(store):
        request = ConsentRequest.model_validate(BODY)
        original = await store.create(CONTEXT, request, now=NOW)
        assert original == await store.get(CONTEXT, original["id"], now=NOW)
        assert original == await store.create(CONTEXT, request, now=NOW + timedelta(hours=1))
        changed = request.model_copy(update={"max_drafts": 4})
        with pytest.raises(ConsentError, match="REQUEST_CONFLICT"):
            await store.create(CONTEXT, changed, now=NOW)
        expired = await store.create(CONTEXT, request, now=NOW + timedelta(days=2))
        assert expired["id"] == original["id"]
        assert expired["state"] == "expired"
        revoked = await store.revoke(CONTEXT, original["id"], now=NOW + timedelta(hours=2))
        replay = await store.create(CONTEXT, request, now=NOW + timedelta(hours=3))
        assert replay["state"] == "revoked"
        assert replay["revoked_at"] == revoked["revoked_at"]
        assert await store.revoke(CONTEXT, original["id"], now=NOW + timedelta(hours=4)) == revoked
    asyncio.run(with_test_database(check))


@pytest.mark.parametrize("field", ["organization", "workspace", "project", "user"])
def test_postgres_read_and_revoke_cannot_cross_scope(field):
    async def check(store):
        original = await store.create(CONTEXT, ConsentRequest.model_validate(BODY), now=NOW)
        other = {
            "organization": replace(CONTEXT, tenant=replace(CONTEXT.tenant, organization_id="other")),
            "workspace": replace(CONTEXT, tenant=replace(CONTEXT.tenant, workspace_id="other")),
            "project": replace(CONTEXT, project=replace(CONTEXT.project, website_project_id="other")),
            "user": replace(CONTEXT, actor=replace(CONTEXT.actor, user_id="other")),
        }[field]
        for action in ("get", "revoke"):
            with pytest.raises(ConsentError, match="NOT_FOUND"):
                await getattr(store, action)(other, original["id"], now=NOW)
        assert (await store.list(other, now=NOW))["items"] == []
        assert [item["id"] for item in (await store.list(CONTEXT, now=NOW))["items"]] == [original["id"]]
        assert (await store.get(CONTEXT, original["id"], now=NOW))["state"] == "active"
    asyncio.run(with_test_database(check))


def test_list_requires_read_permission_before_accessing_database():
    async def run():
        store = BacklinksConsentStore(lambda: pytest.fail("DB must not be accessed"))
        with pytest.raises(ConsentError, match="PERMISSION_DENIED"):
            await store.list(replace(CONTEXT, permissions=()))
    asyncio.run(run())


def test_postgres_list_is_bounded_ordered_and_preserves_inactive_history():
    async def check(store):
        ids = []
        for index in range(22):
            request = ConsentRequest.model_validate({**BODY, "request_id": str(uuid4())})
            record = await store.create(CONTEXT, request, now=NOW + timedelta(seconds=index))
            ids.append(record["id"])
        await store.revoke(CONTEXT, ids[-1], now=NOW + timedelta(hours=1))
        records = (await store.list(CONTEXT, now=NOW + timedelta(days=2)))["items"]
        assert [record["id"] for record in records] == list(reversed(ids[-20:]))
        assert records[0]["state"] == "revoked"
        assert all(record["state"] == "expired" for record in records[1:])
        assert all(record["sending_allowed"] is False for record in records)
    asyncio.run(with_test_database(check))


@pytest.mark.parametrize("delta", [timedelta(0), timedelta(seconds=-1), timedelta(days=7, seconds=1)])
def test_postgres_new_grant_requires_bounded_future_expiry(delta):
    async def check(store):
        request = ConsentRequest.model_validate({**BODY, "expires_at": NOW + delta})
        with pytest.raises(ConsentError, match="EXPIRY_INVALID"):
            await store.create(CONTEXT, request, now=NOW)
    asyncio.run(with_test_database(check))
