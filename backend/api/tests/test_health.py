import asyncio
from datetime import UTC, datetime

from httpx import ASGITransport, AsyncClient

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
