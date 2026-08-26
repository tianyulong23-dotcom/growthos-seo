import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

import app.main as main_module
from app.api.routes.health import get_keyword_health_service
from app.core.backlinks_runtime_status import BacklinksRuntimeStatus
from app.core.config import Settings
from app.main import app
from app.modules.keywords.schemas import KeywordOperationalHealthResponse


def _unavailable_task_health() -> dict[str, object]:
    return {
        "status": "unavailable",
        "active_jobs": 0,
        "recoverable_queued_project_analysis": 0,
        "unrecoverable_stale_queued_project_analysis": 0,
        "stale_running_jobs": 0,
        "waiting_provider_jobs": 0,
        "oldest_active_at": None,
        "reason_code": "task_health_unavailable",
        "recovery_action": "inspect_worker_task_health",
    }


def _unavailable_projection_delivery() -> dict[str, object]:
    return {
        "status": "unavailable",
        "due_pending": 0,
        "retryable_failed": 0,
        "permanent_failed": 0,
        "exhausted": 0,
        "oldest_waiting_at": None,
        "latest_failure_code": None,
        "latest_error": None,
        "reason_code": "projection_delivery_health_unavailable",
        "recovery_action": "inspect_projection_delivery",
    }


def test_health() -> None:
    async def request_health() -> tuple[int, dict[str, str]]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/health")
            return response.status_code, response.json()

    status_code, body = asyncio.run(request_health())

    assert status_code == 200
    assert body == {"status": "ok"}


def test_runtime_mode_defaults_to_fail_closed_maintenance() -> None:
    settings = Settings()

    assert settings.growthos_runtime_mode == "MAINTENANCE"
    assert settings.platform_background_dispatch_enabled is False
    assert settings.backlinks_project_projection_enabled is False


def test_product_runtime_requires_dispatch_and_project_projection() -> None:
    settings = Settings(
        growthos_runtime_mode="PRODUCT",
        platform_background_dispatch_enabled=True,
        backlinks_project_projection_enabled=True,
    )

    assert settings.platform_background_dispatch_enabled is True
    assert settings.backlinks_project_projection_enabled is True

    with pytest.raises(
        ValidationError,
        match="GROWTHOS_PRODUCT_RUNTIME_REQUIRES_BACKGROUND_DISPATCH",
    ):
        Settings(
            growthos_runtime_mode="PRODUCT",
            platform_background_dispatch_enabled=False,
            backlinks_project_projection_enabled=True,
        )

    with pytest.raises(
        ValidationError,
        match="GROWTHOS_PRODUCT_RUNTIME_REQUIRES_BACKLINKS_PROJECT_PROJECTION",
    ):
        Settings(
            growthos_runtime_mode="PRODUCT",
            platform_background_dispatch_enabled=True,
            backlinks_project_projection_enabled=False,
        )

    with pytest.raises(
        ValidationError,
        match="GROWTHOS_NON_PRODUCT_RUNTIME_REQUIRES_BACKGROUND_DISPATCH_DISABLED",
    ):
        Settings(
            growthos_runtime_mode="MAINTENANCE",
            platform_background_dispatch_enabled=True,
            backlinks_project_projection_enabled=False,
        )

    with pytest.raises(
        ValidationError,
        match="GROWTHOS_NON_PRODUCT_RUNTIME_REQUIRES_BACKLINKS_PROJECT_PROJECTION_DISABLED",
    ):
        Settings(
            growthos_runtime_mode="RECOVERY",
            platform_background_dispatch_enabled=False,
            backlinks_project_projection_enabled=True,
        )


def test_disabled_background_dispatch_does_not_start_projection_dispatcher(
    monkeypatch,
) -> None:
    class ProjectionDispatcherStub:
        calls = 0

        async def dispatch_pending(self) -> None:
            self.calls += 1

    dispatcher = ProjectionDispatcherStub()
    application = SimpleNamespace(
        state=SimpleNamespace(backlinks_project_context_dispatcher=dispatcher)
    )
    monkeypatch.setattr(
        main_module,
        "get_settings",
        lambda: Settings(platform_background_dispatch_enabled=False),
    )

    async def run_lifespan() -> None:
        async with main_module.lifespan(application):
            await asyncio.sleep(0)

    asyncio.run(run_lifespan())

    assert dispatcher.calls == 0


def test_runtime_status_reports_backlinks_worker_availability() -> None:
    class RuntimeStatusStub:
        async def snapshot(self) -> dict[str, object]:
            return {
                "status": "maintenance",
                "mode": "MAINTENANCE",
                "business_consumers_running": False,
                "core_api": {"running": True, "build_id": "build-api"},
                "build": {
                    "current": False,
                    "expected_build_id": "build-current",
                    "core_api_build_id": "build-api",
                    "worker_build_id": "build-worker",
                    "reason_code": "runtime_build_mismatch",
                    "recovery_action": "restart_product_runtime",
                },
                "worker": {
                    "process_running": True,
                    "build_id": "build-worker",
                    "execution_mode": "quiesced",
                    "postgres_ready": True,
                    "temporal_ready": True,
                    "reason_code": "worker_quiesced",
                    "recovery_action": "start_business_consumers",
                    "tasks": _unavailable_task_health(),
                },
                "platform": {
                    "background_dispatch_enabled": False,
                    "project_context_projection_enabled": False,
                    "project_context_dispatcher_running": False,
                    "reason_code": "runtime_maintenance",
                    "recovery_action": "switch_to_product_mode",
                    "projection_delivery": _unavailable_projection_delivery(),
                },
                "providers": {
                    "data_for_seo": {
                        "configured": False,
                        "external_availability": "disabled",
                        "reason_code": "provider_disabled",
                        "recovery_action": "enable_provider",
                    },
                    "browser": {
                        "configured": False,
                        "external_availability": "disabled",
                        "reason_code": "provider_disabled",
                        "recovery_action": "enable_provider",
                    },
                    "ai": {
                        "configured": False,
                        "external_availability": "disabled",
                        "reason_code": "provider_disabled",
                        "recovery_action": "enable_provider",
                    },
                    "gmail": {
                        "configured": False,
                        "external_availability": "disabled",
                        "reason_code": "provider_disabled",
                        "recovery_action": "enable_provider",
                    },
                },
            }

    original_status = app.state.backlinks_runtime_status
    app.state.backlinks_runtime_status = RuntimeStatusStub()

    async def request_status() -> tuple[int, dict[str, object]]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/v1/runtime-status")
            return response.status_code, response.json()

    try:
        status_code, body = asyncio.run(request_status())
    finally:
        app.state.backlinks_runtime_status = original_status

    assert status_code == 200
    assert body == {
        "status": "maintenance",
        "mode": "MAINTENANCE",
        "business_consumers_running": False,
        "core_api": {"running": True, "build_id": "build-api"},
        "build": {
            "current": False,
            "expected_build_id": "build-current",
            "core_api_build_id": "build-api",
            "worker_build_id": "build-worker",
            "reason_code": "runtime_build_mismatch",
            "recovery_action": "restart_product_runtime",
        },
        "worker": {
            "process_running": True,
            "build_id": "build-worker",
            "execution_mode": "quiesced",
            "postgres_ready": True,
            "temporal_ready": True,
            "reason_code": "worker_quiesced",
            "recovery_action": "start_business_consumers",
            "tasks": _unavailable_task_health(),
        },
        "platform": {
            "background_dispatch_enabled": False,
            "project_context_projection_enabled": False,
            "project_context_dispatcher_running": False,
            "reason_code": "runtime_maintenance",
            "recovery_action": "switch_to_product_mode",
            "projection_delivery": _unavailable_projection_delivery(),
        },
        "providers": {
            "data_for_seo": {
                "configured": False,
                "external_availability": "disabled",
                "reason_code": "provider_disabled",
                "recovery_action": "enable_provider",
            },
            "browser": {
                "configured": False,
                "external_availability": "disabled",
                "reason_code": "provider_disabled",
                "recovery_action": "enable_provider",
            },
            "ai": {
                "configured": False,
                "external_availability": "disabled",
                "reason_code": "provider_disabled",
                "recovery_action": "enable_provider",
            },
            "gmail": {
                "configured": False,
                "external_availability": "disabled",
                "reason_code": "provider_disabled",
                "recovery_action": "enable_provider",
            },
        },
    }


def test_backlinks_runtime_status_reuses_client_and_queries_workflow_pollers() -> None:
    connect_calls: list[tuple[str, str]] = []
    requests: list[object] = []

    class WorkflowServiceStub:
        async def describe_task_queue(self, request: object) -> object:
            requests.append(request)
            return SimpleNamespace(pollers=[SimpleNamespace(identity="backlinks-worker")])

    async def connect(address: str, *, namespace: str) -> object:
        connect_calls.append((address, namespace))
        return SimpleNamespace(
            service_client=SimpleNamespace(workflow_service=WorkflowServiceStub())
        )

    async def get_json(url: str) -> dict[str, object]:
        if url.endswith(":7301/health"):
            return {
                "status": "ok",
                "process": "api",
                "buildId": "build-runtime",
                "providers": {},
            }
        return {
            "status": "ok",
            "process": "worker",
            "buildId": "build-runtime",
            "workerExecutionMode": "normal",
            "businessConsumersRunning": True,
            "postgresReady": True,
            "temporalReady": True,
            "providers": {},
            "tasks": {
                "status": "ok",
                "activeJobs": 1,
                "recoverableQueuedProjectAnalysis": 0,
                "unrecoverableStaleQueuedProjectAnalysis": 0,
                "staleRunningJobs": 0,
                "waitingProviderJobs": 1,
                "oldestActiveAt": "2026-08-25T00:00:00.000Z",
            },
        }

    runtime_status = BacklinksRuntimeStatus(
        core_api_health_url="http://127.0.0.1:7301/health",
        worker_health_url="http://127.0.0.1:7302/health",
        address="temporal.test:7233",
        namespace="backlinks-test",
        task_queue="growthos.backlinks.v1",
        timeout_seconds=1,
        expected_build_id="build-runtime",
        runtime_mode="PRODUCT",
        background_dispatch_enabled=True,
        project_context_projection_enabled=True,
        project_context_dispatcher_running=lambda: True,
        project_context_dispatcher_health=lambda: asyncio.sleep(
            0,
            result={
                "due_pending": 0,
                "retryable_failed": 0,
                "permanent_failed": 2,
                "exhausted": 0,
                "oldest_waiting_at": None,
                "latest_failure_code": "upstream_rejected",
                "latest_error": "HTTP 400: rejected",
            },
        ),
        connect=connect,
        get_json=get_json,
    )

    async def probe_twice() -> tuple[dict[str, object], dict[str, object]]:
        return (
            await runtime_status.snapshot(),
            await runtime_status.snapshot(),
        )

    first, second = asyncio.run(probe_twice())
    assert first["status"] == "ok"
    assert first["mode"] == "PRODUCT"
    assert first["business_consumers_running"] is True
    assert first["build"] == {
        "current": True,
        "expected_build_id": "build-runtime",
        "core_api_build_id": "build-runtime",
        "worker_build_id": "build-runtime",
        "reason_code": None,
        "recovery_action": None,
    }
    assert first["platform"] == {
        "background_dispatch_enabled": True,
        "project_context_projection_enabled": True,
        "project_context_dispatcher_running": True,
        "reason_code": None,
        "recovery_action": None,
        "projection_delivery": {
            "status": "ok",
            "due_pending": 0,
            "retryable_failed": 0,
            "permanent_failed": 2,
            "exhausted": 0,
            "oldest_waiting_at": None,
            "latest_failure_code": "upstream_rejected",
            "latest_error": "HTTP 400: rejected",
            "reason_code": None,
            "recovery_action": None,
        },
    }
    assert first["worker"]["tasks"] == {
        "status": "ok",
        "active_jobs": 1,
        "recoverable_queued_project_analysis": 0,
        "unrecoverable_stale_queued_project_analysis": 0,
        "stale_running_jobs": 0,
        "waiting_provider_jobs": 1,
        "oldest_active_at": "2026-08-25T00:00:00.000Z",
        "reason_code": None,
        "recovery_action": None,
    }
    assert second["status"] == "ok"
    assert second["business_consumers_running"] is True
    assert connect_calls == [("temporal.test:7233", "backlinks-test")]
    assert len(requests) == 2
    assert all(request.namespace == "backlinks-test" for request in requests)
    assert all(
        request.task_queue.name == "growthos.backlinks.v1"
        for request in requests
    )


@pytest.mark.parametrize(
    ("api_build_id", "worker_build_id", "expected_build_id", "reason_code"),
    [
        ("build-old", "build-old", "build-current", "runtime_build_stale"),
        ("build-api", "build-worker", "build-current", "runtime_build_mismatch"),
    ],
)
def test_backlinks_runtime_status_blocks_noncurrent_builds(
    api_build_id: str,
    worker_build_id: str,
    expected_build_id: str,
    reason_code: str,
) -> None:
    async def connect(*args: object, **kwargs: object) -> object:
        async def describe_task_queue(request: object) -> object:
            return SimpleNamespace(pollers=[SimpleNamespace(identity="worker")])

        return SimpleNamespace(
            service_client=SimpleNamespace(
                workflow_service=SimpleNamespace(
                    describe_task_queue=describe_task_queue
                )
            )
        )

    async def get_json(url: str) -> dict[str, object]:
        if url.endswith(":7301/health"):
            return {
                "status": "ok",
                "process": "api",
                "buildId": api_build_id,
                "providers": {},
            }
        return {
            "status": "ok",
            "process": "worker",
            "buildId": worker_build_id,
            "workerExecutionMode": "normal",
            "businessConsumersRunning": True,
            "postgresReady": True,
            "temporalReady": True,
            "providers": {},
        }

    runtime_status = BacklinksRuntimeStatus(
        core_api_health_url="http://127.0.0.1:7301/health",
        worker_health_url="http://127.0.0.1:7302/health",
        address="temporal.test:7233",
        namespace="backlinks-test",
        task_queue="growthos.backlinks.v1",
        timeout_seconds=1,
        expected_build_id=expected_build_id,
        runtime_mode="PRODUCT",
        background_dispatch_enabled=True,
        project_context_projection_enabled=True,
        project_context_dispatcher_running=lambda: True,
        project_context_dispatcher_health=lambda: asyncio.sleep(
            0,
            result={"status": "ok"},
        ),
        connect=connect,
        get_json=get_json,
    )

    result = asyncio.run(runtime_status.snapshot())

    assert result["status"] == "maintenance"
    assert result["business_consumers_running"] is False
    assert result["build"] == {
        "current": False,
        "expected_build_id": expected_build_id,
        "core_api_build_id": api_build_id,
        "worker_build_id": worker_build_id,
        "reason_code": reason_code,
        "recovery_action": "restart_product_runtime",
    }


def test_backlinks_runtime_status_reports_quiesced_without_temporal_poll() -> None:
    async def connect(*args: object, **kwargs: object) -> object:
        raise AssertionError("quiesced status must not query Temporal pollers")

    async def get_json(url: str) -> dict[str, object]:
        if url.endswith(":7301/health"):
            return {
                "status": "ok",
                "process": "api",
                "buildId": "build-quiesced",
                "providers": {
                    "dataForSeo": {
                        "configured": True,
                        "externalAvailability": "unavailable",
                        "reasonCode": "insufficient_balance",
                        "recoveryAction": "fund_provider_account",
                    }
                },
            }
        return {
            "status": "ok",
            "process": "worker",
            "buildId": "build-quiesced",
            "workerExecutionMode": "quiesced",
            "businessConsumersRunning": False,
            "postgresReady": True,
            "temporalReady": True,
            "providers": {},
        }

    runtime_status = BacklinksRuntimeStatus(
        core_api_health_url="http://127.0.0.1:7301/health",
        worker_health_url="http://127.0.0.1:7302/health",
        address="temporal.test:7233",
        namespace="backlinks-test",
        task_queue="growthos.backlinks.v1",
        timeout_seconds=1,
        runtime_mode="MAINTENANCE",
        connect=connect,
        get_json=get_json,
    )

    snapshot = asyncio.run(runtime_status.snapshot())

    assert snapshot["status"] == "maintenance"
    assert snapshot["business_consumers_running"] is False
    assert snapshot["worker"] == {
        "process_running": True,
        "build_id": "build-quiesced",
        "execution_mode": "quiesced",
        "postgres_ready": True,
        "temporal_ready": True,
        "reason_code": "worker_quiesced",
        "recovery_action": "start_business_consumers",
        "tasks": _unavailable_task_health(),
    }
    assert snapshot["providers"]["data_for_seo"] == {
        "configured": True,
        "external_availability": "unavailable",
        "reason_code": "insufficient_balance",
        "recovery_action": "fund_provider_account",
    }


def test_product_runtime_reports_unavailable_project_dispatcher() -> None:
    class WorkflowServiceStub:
        async def describe_task_queue(self, request: object) -> object:
            del request
            return SimpleNamespace(pollers=[SimpleNamespace(identity="worker")])

    async def product_connect(address: str, *, namespace: str) -> object:
        del address, namespace
        return SimpleNamespace(
            service_client=SimpleNamespace(
                workflow_service=WorkflowServiceStub()
            )
        )

    async def get_json(url: str) -> dict[str, object]:
        if url.endswith(":7301/health"):
            return {
                "status": "ok",
                "process": "api",
                "buildId": "build-product",
                "providers": {},
            }
        return {
            "status": "ok",
            "process": "worker",
            "buildId": "build-product",
            "workerExecutionMode": "normal",
            "businessConsumersRunning": True,
            "postgresReady": True,
            "temporalReady": True,
            "providers": {},
        }

    runtime_status = BacklinksRuntimeStatus(
        core_api_health_url="http://127.0.0.1:7301/health",
        worker_health_url="http://127.0.0.1:7302/health",
        address="temporal.test:7233",
        namespace="backlinks-test",
        task_queue="growthos.backlinks.v1",
        timeout_seconds=1,
        runtime_mode="PRODUCT",
        background_dispatch_enabled=True,
        project_context_projection_enabled=True,
        project_context_dispatcher_running=lambda: False,
        connect=product_connect,
        get_json=get_json,
    )

    snapshot = asyncio.run(runtime_status.snapshot())

    assert snapshot["status"] == "maintenance"
    assert snapshot["business_consumers_running"] is False
    assert snapshot["platform"] == {
        "background_dispatch_enabled": True,
        "project_context_projection_enabled": True,
        "project_context_dispatcher_running": False,
        "reason_code": "project_dispatcher_unavailable",
        "recovery_action": "restart_platform_dispatcher",
        "projection_delivery": _unavailable_projection_delivery(),
    }


def test_backlinks_runtime_status_reports_recovery_without_temporal_poll() -> None:
    async def connect(*args: object, **kwargs: object) -> object:
        raise AssertionError("recovery status must not query business pollers")

    async def get_json(url: str) -> dict[str, object]:
        if url.endswith(":7301/health"):
            return {
                "status": "ok",
                "process": "api",
                "buildId": "build-recovery",
                "providers": {},
            }
        return {
            "status": "ok",
            "process": "worker",
            "buildId": "build-recovery",
            "workerExecutionMode": "recovery",
            "businessConsumersRunning": False,
            "postgresReady": True,
            "temporalReady": True,
            "providers": {},
        }

    runtime_status = BacklinksRuntimeStatus(
        core_api_health_url="http://127.0.0.1:7301/health",
        worker_health_url="http://127.0.0.1:7302/health",
        address="temporal.test:7233",
        namespace="backlinks-test",
        task_queue="growthos.backlinks.v1",
        timeout_seconds=1,
        runtime_mode="RECOVERY",
        connect=connect,
        get_json=get_json,
    )

    snapshot = asyncio.run(runtime_status.snapshot())

    assert snapshot["status"] == "maintenance"
    assert snapshot["business_consumers_running"] is False
    assert snapshot["worker"] == {
        "process_running": True,
        "build_id": "build-recovery",
        "execution_mode": "recovery",
        "postgres_ready": True,
        "temporal_ready": True,
        "reason_code": "worker_recovery",
        "recovery_action": "complete_recovery",
        "tasks": _unavailable_task_health(),
    }


def test_backlinks_runtime_status_preserves_available_provider_diagnostic() -> None:
    async def get_json(url: str) -> dict[str, object]:
        if url.endswith(":7301/health"):
            return {
                "status": "ok",
                "process": "api",
                "buildId": "build-available",
                "providers": {
                    "dataForSeo": {
                        "configured": True,
                        "externalAvailability": "available",
                        "reasonCode": None,
                        "recoveryAction": None,
                    }
                },
            }
        return {
            "status": "ok",
            "process": "worker",
            "buildId": "build-available",
            "workerExecutionMode": "quiesced",
            "businessConsumersRunning": False,
            "postgresReady": True,
            "temporalReady": True,
            "providers": {},
        }

    runtime_status = BacklinksRuntimeStatus(
        core_api_health_url="http://127.0.0.1:7301/health",
        worker_health_url="http://127.0.0.1:7302/health",
        address="temporal.test:7233",
        namespace="backlinks-test",
        task_queue="growthos.backlinks.v1",
        timeout_seconds=1,
        get_json=get_json,
    )

    snapshot = asyncio.run(runtime_status.snapshot())

    assert snapshot["providers"]["data_for_seo"] == {
        "configured": True,
        "external_availability": "available",
        "reason_code": None,
        "recovery_action": None,
    }


class FakeKeywordHealthService:
    def __init__(self, *, worker_healthy: bool, uncertain_requests: int = 0) -> None:
        self.worker_healthy = worker_healthy
        self.uncertain_requests = uncertain_requests

    async def operational_health(self) -> KeywordOperationalHealthResponse:
        degraded = not self.worker_healthy or self.uncertain_requests > 0
        return KeywordOperationalHealthResponse(
            status="degraded" if degraded else "ok",
            worker_healthy=self.worker_healthy,
            worker_last_seen_at=datetime.now(UTC) if self.worker_healthy else None,
            active_runs=0,
            waiting_runs=0,
            blocked_runs=4,
            stale_prepared_requests=0,
            uncertain_requests=self.uncertain_requests,
            charged_failed_requests=0,
            metric_refresh_waiting=0,
            metric_refresh_running=0,
            metric_refresh_exhausted=0,
            failed_metrics=0,
        )


def test_keyword_readiness_ignores_project_configuration_blocks() -> None:
    app.dependency_overrides[get_keyword_health_service] = lambda: FakeKeywordHealthService(
        worker_healthy=True
    )

    async def request_health() -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            return (await client.get("/health/keywords/readiness")).status_code

    try:
        assert asyncio.run(request_health()) == 200
    finally:
        app.dependency_overrides.clear()


def test_keyword_readiness_fails_for_unresolved_paid_requests() -> None:
    app.dependency_overrides[get_keyword_health_service] = lambda: FakeKeywordHealthService(
        worker_healthy=True,
        uncertain_requests=1,
    )

    async def request_health() -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            return (await client.get("/health/keywords/readiness")).status_code

    try:
        assert asyncio.run(request_health()) == 503
    finally:
        app.dependency_overrides.clear()
