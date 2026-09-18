import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.dialects import postgresql

from app.api.routes import tasks as routes
from app.core.backlinks_gateway import PlatformContextResolutionError
from app.modules import tasks


def test_projection_scopes_every_domain_and_hides_content_without_permission():
    sql = str(tasks.task_statement("project-a", "org-a", ("projects:read",)).compile(
        dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True},
    ))
    assert "article_runs" not in sql
    assert "agent_runs" not in sql
    assert sql.count("organization_id = 'org-a'") == 2
    assert sql.count("project_id = 'project-a'") == 2
    assert "ORDER BY CASE WHEN" in sql
    assert "LIMIT 101" in sql


def test_exact_lookup_filters_before_limit_and_keeps_tenant_scope():
    sql = str(tasks.task_statement(
        "project-b", "org-b", ("projects:read", "content:read", "backlinks:read"),
        kind="article", task_id="old-run",
    ).compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    assert "article_runs" in sql and "content_plan_batches" in sql and "agent_runs" in sql
    assert sql.count("organization_id = 'org-b'") == 7
    assert "kind = 'article'" in sql and "id = 'old-run'" in sql
    assert "onboarding_steps.run_id = onboarding_runs.id" in sql
    assert "onboarding_steps.status = 'failed'" in sql
    assert "onboarding_runs.status != 'completed'" in sql
    assert "onboarding_step_failed" in sql


def test_read_projects_actual_rows_and_bounds_history(monkeypatch):
    row = dict(id="r", kind="article", title="Article", status="queued", progress=0,
               stage="queued", updated_at=datetime.now(UTC), related_id="a", reason_code=None)
    result = SimpleNamespace(mappings=lambda: SimpleNamespace(all=lambda: [row] * 101))
    session = AsyncMock()
    session.execute.return_value = result
    session.__aenter__.return_value = session
    context = SimpleNamespace(project=SimpleNamespace(website_project_id="p"),
                              tenant=SimpleNamespace(organization_id="o"), permissions=("content:read",))
    monkeypatch.setattr(tasks, "get_settings", lambda: SimpleNamespace(
        platform_background_dispatch_enabled=False, agent_background_dispatch_enabled=True,
    ))
    page = asyncio.run(tasks.read_project_tasks(lambda: session, context))
    assert len(page.items) == 100 and page.has_more
    assert page.items[0].status == "queued"
    assert page.items[0].reason_code == "background_dispatch_disabled"
    session.commit.assert_not_called()


@pytest.mark.parametrize("status", [401, 403, 404])
def test_task_routes_fail_closed_without_reading_database(status, monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    app.state.platform_context_resolver = SimpleNamespace(resolve=AsyncMock(
        side_effect=PlatformContextResolutionError(status=status, code="DENIED", title="Denied", detail="Denied"),
    ))
    read = AsyncMock()
    monkeypatch.setattr(routes, "read_project_tasks", read)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            for path in ("/api/v1/projects/p/tasks", "/api/v1/projects/p/tasks/article/r"):
                response = await client.get(path)
                assert response.status_code == status
    asyncio.run(scenario())
    read.assert_not_called()


def test_task_route_returns_no_store_and_missing_is_not_completed(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    app.state.platform_context_resolver = SimpleNamespace(resolve=AsyncMock(return_value="context"))
    monkeypatch.setattr(routes, "read_project_tasks", AsyncMock(
        return_value=tasks.ProjectTasksResponse(items=[], has_more=False),
    ))

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/v1/projects/p/tasks")
            assert response.status_code == 200
            assert response.headers["cache-control"] == "no-store"
            missing = await client.get("/api/v1/projects/p/tasks/article/no-such-run")
            assert missing.status_code == 404
    asyncio.run(scenario())
