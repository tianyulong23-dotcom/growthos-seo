import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import app.main as main
from app.core.config import Settings
from app.modules.agent.service import AgentService


@pytest.mark.parametrize("enabled", [False, True])
def test_independent_lifespan_starts_only_agent_and_cancels_on_shutdown(monkeypatch, enabled):
    started, stopped = [], []

    async def dispatch(*, materialize_system_triggers):
        started.append(materialize_system_triggers)
        try:
            await asyncio.Event().wait()
        finally:
            stopped.append(True)

    def forbidden(*args, **kwargs):
        raise AssertionError("Unrelated background service started")

    worker = SimpleNamespace(ensure_started=AsyncMock(), stop=AsyncMock())
    settings = Settings(
        platform_background_dispatch_enabled=False,
        agent_background_dispatch_enabled=enabled,
        crawler_worker_start_on_boot=False,
    )
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "get_crawler_worker_launcher", lambda: worker)
    monkeypatch.setattr(main, "dispatch_agent_workflows", dispatch)
    for name in (
        "build_project_service", "build_audit_service", "build_content_service",
        "build_keyword_service", "build_onboarding_service", "build_asset_dispatcher",
        "build_publication_orchestrator", "build_performance_service",
        "dispatch_backlinks_project_contexts", "dispatch_content_plan_preparations",
    ):
        monkeypatch.setattr(main, name, forbidden)
    gateway = SimpleNamespace(aclose=AsyncMock())
    app = SimpleNamespace(state=SimpleNamespace(owned_backlinks_gateway=gateway))

    async def check():
        async with main.lifespan(app):
            await asyncio.sleep(0)
            assert started == ([False] if enabled else [])
            assert stopped == []
        assert stopped == ([True] if enabled else [])
    asyncio.run(check())
    worker.ensure_started.assert_not_awaited()
    worker.stop.assert_awaited_once()
    gateway.aclose.assert_awaited_once()


@pytest.mark.parametrize("materialize", [False, True])
def test_dispatch_preserves_queue_and_reconciliation_without_system_triggers(materialize):
    run = SimpleNamespace(id="existing-authorized-run")
    repository = SimpleNamespace(
        materialize_pending_system_triggers=AsyncMock(),
        list_pending_dispatches=AsyncMock(return_value=[run]),
    )
    service = SimpleNamespace(
        repository=repository, limits={},
        _start=AsyncMock(return_value=True), reconcile_active_runs=AsyncMock(),
    )
    count = asyncio.run(AgentService.dispatch_queued(
        service, materialize_system_triggers=materialize,
    ))
    assert count == 1
    service._start.assert_awaited_once_with(run)
    service.reconcile_active_runs.assert_awaited_once()
    assert repository.materialize_pending_system_triggers.await_count == int(materialize)


def test_independent_setting_is_opt_in_and_does_not_change_global_mode():
    assert not Settings(_env_file=None).agent_background_dispatch_enabled
    settings = Settings(
        _env_file=None, growthos_runtime_mode="MAINTENANCE",
        agent_background_dispatch_enabled=True,
        platform_background_dispatch_enabled=False,
    )
    assert settings.agent_background_dispatch_enabled
    assert not settings.platform_background_dispatch_enabled


@pytest.mark.parametrize("enabled,requested,expected", [
    (False, True, False), (True, False, False), (True, True, True),
])
def test_product_dispatch_can_hold_automatic_triggers(monkeypatch, enabled, requested, expected):
    service = SimpleNamespace(dispatch_queued=AsyncMock(side_effect=asyncio.CancelledError))
    monkeypatch.setattr(main, "build_agent_service", lambda: service)
    monkeypatch.setattr(main, "get_settings", lambda: Settings(
        _env_file=None, agent_system_trigger_dispatch_enabled=enabled,
    ))
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main.dispatch_agent_workflows(materialize_system_triggers=requested))
    service.dispatch_queued.assert_awaited_once_with(materialize_system_triggers=expected)
