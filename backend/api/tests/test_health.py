import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

from httpx import ASGITransport, AsyncClient

from app.core.backlinks_runtime_status import BacklinksRuntimeStatus
from app.main import app
from app.api.routes.health import get_keyword_health_service
from app.modules.keywords.schemas import KeywordOperationalHealthResponse


def test_health() -> None:
    async def request_health() -> tuple[int, dict[str, str]]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/health")
            return response.status_code, response.json()

    status_code, body = asyncio.run(request_health())

    assert status_code == 200
    assert body == {"status": "ok"}


def test_runtime_status_reports_backlinks_worker_availability() -> None:
    class RuntimeStatusStub:
        async def business_consumers_running(self) -> bool:
            return False

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
        "business_consumers_running": False,
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

    runtime_status = BacklinksRuntimeStatus(
        address="temporal.test:7233",
        namespace="backlinks-test",
        task_queue="growthos.backlinks.v1",
        timeout_seconds=1,
        connect=connect,
    )

    async def probe_twice() -> tuple[bool, bool]:
        return (
            await runtime_status.business_consumers_running(),
            await runtime_status.business_consumers_running(),
        )

    assert asyncio.run(probe_twice()) == (True, True)
    assert connect_calls == [("temporal.test:7233", "backlinks-test")]
    assert len(requests) == 2
    assert all(getattr(request, "namespace") == "backlinks-test" for request in requests)
    assert all(
        getattr(getattr(request, "task_queue"), "name") == "growthos.backlinks.v1"
        for request in requests
    )


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
