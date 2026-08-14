import asyncio
from types import SimpleNamespace

from httpx import ASGITransport, AsyncClient

from app.core.config import Settings
from app.core.runtime import RuntimeDependencies
from app.main import app


def test_health() -> None:
    async def request_health() -> tuple[int, dict[str, str]]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/health")
            return response.status_code, response.json()

    status_code, body = asyncio.run(request_health())

    assert status_code == 200
    assert body == {"status": "ok"}


def test_runtime_status_reports_maintenance_without_business_consumers() -> None:
    class RuntimeStub:
        async def business_consumers_running(self) -> bool:
            return False

    original_runtime = app.state.runtime_dependencies
    app.state.runtime_dependencies = RuntimeStub()

    async def request_status() -> tuple[int, dict[str, object]]:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/v1/runtime-status")
            return response.status_code, response.json()

    try:
        status_code, body = asyncio.run(request_status())
    finally:
        app.state.runtime_dependencies = original_runtime

    assert status_code == 200
    assert body == {
        "status": "maintenance",
        "business_consumers_running": False,
    }


def test_runtime_dependencies_detect_temporal_worker_pollers() -> None:
    requests: list[object] = []

    class WorkflowServiceStub:
        async def describe_task_queue(self, request: object) -> object:
            requests.append(request)
            return SimpleNamespace(pollers=[SimpleNamespace(identity="worker-1")])

    runtime = RuntimeDependencies(
        settings=Settings(
            _env_file=None,
            backlinks_runtime_mode="LOCAL_PRODUCT",
            temporal_namespace="growthos-backlinks-canary",
            backlinks_task_queue="growthos.backlinks.v1",
        ),
        temporal=SimpleNamespace(workflow_service=WorkflowServiceStub()),
    )

    assert asyncio.run(runtime.business_consumers_running()) is True
    assert len(requests) == 1
    assert getattr(requests[0], "namespace") == "growthos-backlinks-canary"
    assert getattr(getattr(requests[0], "task_queue"), "name") == (
        "growthos.backlinks.v1"
    )
