import asyncio
import base64
import json
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient, MockTransport, Response

from app.api.routes.performance import get_performance_service, router
from app.core.backlinks_gateway import (
    BacklinksGateway,
    PlatformContextResolutionError,
)
from app.core.config import Settings
from app.core.platform_request_context import (
    PLATFORM_CONTEXT_HEADER,
    PlatformActor,
    PlatformProject,
    PlatformTenant,
    ResolvedPlatformRequestContext,
)
from app.modules.performance.repository import DailyMetric, PublishedArticle
from app.modules.performance.service import PerformanceService
from app.modules.settings.gsc import GSCPerformanceDataset


class FakePerformanceService:
    def __init__(self) -> None:
        self.days: list[int] = []
        self.article_calls: list[dict] = []

    async def overview(self, project_id: str, days: int) -> dict:
        self.days.append(days)
        return {
            "gsc_connected": False,
            "date_range": days,
            "range_start": date(2026, 7, 15),
            "range_end": date(2026, 8, 11),
            "previous_start": date(2026, 6, 17),
            "previous_end": date(2026, 7, 14),
            "metrics": {},
            "previous_metrics": {},
            "change": {},
            "sync": {},
        }

    async def articles(
        self,
        project_id: str,
        days: int,
        **options,
    ) -> dict:
        self.article_calls.append({"project_id": project_id, "days": days, **options})
        return {
            "items": [],
            "total": 0,
            "page": options["page"],
            "page_size": options["page_size"],
        }


def test_backlink_performance_bff_uses_project_scoped_core_read_contract() -> None:
    async def scenario() -> None:
        calls: list[httpx.Request] = []
        permissions: list[str | None] = []
        signing_key = b"test-only-performance-bff-key-32-bytes"
        resolved = ResolvedPlatformRequestContext(
            actor=PlatformActor(
                user_id="user-performance",
                session_id="session-performance",
                roles=("member",),
            ),
            tenant=PlatformTenant(
                organization_id="org-performance",
                workspace_id="workspace-performance",
            ),
            project=PlatformProject(
                website_project_id="project-performance",
                website_project_key="project-p1",
            ),
            permissions=("backlinks:read",),
            correlation_id="correlation-performance",
        )

        class Resolver:
            async def resolve(
                self,
                *,
                request: object,
                website_project_key: str,
                required_permission: str | None = None,
            ) -> ResolvedPlatformRequestContext:
                del request
                assert website_project_key == "project-p1"
                permissions.append(required_permission)
                return resolved

        def handler(request: httpx.Request) -> Response:
            calls.append(request)
            return Response(
                200,
                json={
                    "items": [],
                    "nextCursor": None,
                    "hasMore": False,
                    "summary": {
                        "placements": {
                            "total": 0,
                            "pendingVerification": 0,
                            "active": 0,
                            "suspectedChanged": 0,
                            "changed": 0,
                            "suspectedLost": 0,
                            "lost": 0,
                            "recovered": 0,
                        },
                        "candidates": {
                            "total": 2,
                            "countsTowardKpi": False,
                        },
                        "evidence": {
                            "source": "DIRECT_MONITOR",
                            "dataCutoff": None,
                            "freshness": "unknown",
                            "lastSuccessfulObservationAt": None,
                            "latestAttemptAt": None,
                            "latestAttemptStatus": "idle",
                            "latestFailure": {
                                "status": "none",
                                "code": None,
                            },
                        },
                    },
                    "meta": {
                        "organizationId": "org-performance",
                        "workspaceId": "workspace-performance",
                        "websiteProjectId": "project-performance",
                        "requestId": "correlation-performance",
                        "schemaVersion": "backlinks.v1",
                        "generatedAt": "2026-08-22T12:00:00.000Z",
                    },
                },
            )

        app = FastAPI()
        app.include_router(router)
        app.state.platform_context_resolver = Resolver()
        app.state.backlinks_gateway = BacklinksGateway(
            base_url="http://backlinks.internal",
            signing_key=signing_key,
            client=AsyncClient(transport=MockTransport(handler)),
        )

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://platform.test",
        ) as client:
            response = await client.get(
                "/api/v1/projects/project-p1/performance/backlinks"
                "?view=suspected_lost&limit=10&cursor=next-page",
                headers={
                    PLATFORM_CONTEXT_HEADER: "forged-browser-context",
                    "x-growthos-platform-context-signature": "v1=forged",
                },
            )

        assert response.status_code == 200
        assert response.json()["summary"]["candidates"] == {
            "total": 2,
            "countsTowardKpi": False,
        }
        assert permissions == ["backlinks:read"]
        assert len(calls) == 1
        forwarded = calls[0]
        assert forwarded.url.path == (
            "/api/v1/projects/project-p1/backlinks/links"
        )
        assert forwarded.url.query == (
            b"view=suspected_lost&limit=10&cursor=next-page"
        )
        encoded_context = forwarded.headers[PLATFORM_CONTEXT_HEADER]
        padding = "=" * (-len(encoded_context) % 4)
        signed_context = json.loads(
            base64.urlsafe_b64decode(f"{encoded_context}{padding}")
        )
        assert signed_context["tenant"] == {
            "organizationId": "org-performance",
            "workspaceId": "workspace-performance",
        }
        assert signed_context["project"] == {
            "websiteProjectId": "project-performance",
            "websiteProjectKey": "project-p1",
        }

    asyncio.run(scenario())


def test_backlink_performance_bff_rejects_cross_project_context() -> None:
    async def scenario() -> None:
        class RejectingResolver:
            async def resolve(self, **_: object) -> ResolvedPlatformRequestContext:
                raise PlatformContextResolutionError(
                    status=403,
                    code="PLATFORM_PROJECT_ACCESS_DENIED",
                    title="Platform project access denied",
                    detail="The project is outside the resolved tenant context.",
                )

        app = FastAPI()
        app.include_router(router)
        app.state.platform_context_resolver = RejectingResolver()
        app.state.backlinks_gateway = BacklinksGateway(
            base_url="http://backlinks.internal",
            signing_key=b"test-only-performance-bff-key-32-bytes",
            client=AsyncClient(
                transport=MockTransport(
                    lambda _: Response(500, json={"unexpected": True})
                )
            ),
        )
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://platform.test",
        ) as client:
            response = await client.get(
                "/api/v1/projects/foreign/performance/backlinks"
            )

        assert response.status_code == 403
        assert response.headers["content-type"].startswith(
            "application/problem+json"
        )
        assert response.json()["code"] == "PLATFORM_PROJECT_ACCESS_DENIED"

    asyncio.run(scenario())


def test_performance_range_query_parses_supported_integer_values() -> None:
    async def scenario() -> None:
        app = FastAPI()
        app.include_router(router)
        service = FakePerformanceService()
        app.dependency_overrides[get_performance_service] = lambda: service

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            supported = await client.get("/api/v1/projects/project-p1/performance/overview?days=28")
            unsupported = await client.get(
                "/api/v1/projects/project-p1/performance/overview?days=30"
            )

        assert supported.status_code == 200
        assert supported.json()["date_range"] == 28
        assert service.days == [28]
        assert unsupported.status_code == 422

    asyncio.run(scenario())


def test_article_list_query_validates_and_forwards_supported_options() -> None:
    async def scenario() -> None:
        app = FastAPI()
        app.include_router(router)
        service = FakePerformanceService()
        app.dependency_overrides[get_performance_service] = lambda: service

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            supported = await client.get(
                "/api/v1/projects/project-p1/performance/articles"
                "?days=90&page=2&page_size=10&status=declining"
                "&sort=position&order=asc"
            )
            invalid_responses = [
                await client.get("/api/v1/projects/project-p1/performance/articles?sort=title"),
                await client.get("/api/v1/projects/project-p1/performance/articles?order=newest"),
                await client.get("/api/v1/projects/project-p1/performance/articles?status=unknown"),
                await client.get("/api/v1/projects/project-p1/performance/articles?page_size=101"),
            ]

        assert supported.status_code == 200
        assert service.article_calls == [
            {
                "project_id": "project-p1",
                "days": 90,
                "page": 2,
                "page_size": 10,
                "status": "declining",
                "sort": "position",
                "order": "asc",
            }
        ]
        assert all(response.status_code == 422 for response in invalid_responses)

    asyncio.run(scenario())


class MemoryPerformanceRepository:
    def __init__(self, data_through: date) -> None:
        published_at = datetime.combine(
            data_through - timedelta(days=100), datetime.min.time(), tzinfo=UTC
        )
        updated_at = datetime.combine(
            data_through - timedelta(days=30), datetime.min.time(), tzinfo=UTC
        )
        self.data_through = data_through
        self.publication_targets = [
            PublishedArticle(
                article_id="article-opportunity",
                publication_id="publication-opportunity-2",
                title="Solar installation guide",
                primary_keyword="solar installation",
                url="https://example.com/guides/solar-installation",
                urls=(
                    "https://example.com/solar-guide",
                    "https://example.com/guides/solar-installation",
                ),
                published_at=published_at,
                last_published_at=updated_at,
                publication_count=2,
            ),
            PublishedArticle(
                article_id="article-declining",
                publication_id="publication-declining-1",
                title="Commercial solar costs",
                primary_keyword="commercial solar cost",
                url="https://example.com/commercial-solar-cost",
                urls=("https://example.com/commercial-solar-cost",),
                published_at=published_at,
                last_published_at=published_at,
                publication_count=1,
            ),
        ]
        self.targets: dict[str, object] = {}
        self.articles = {
            row.article_id: SimpleNamespace(
                id=row.article_id,
                title=row.title,
                primary_keyword=row.primary_keyword,
            )
            for row in self.publication_targets
        }
        self.site_rows: list[DailyMetric] = []
        self.article_rows: dict[str, list[DailyMetric]] = {}
        self.sync_runs: list[object] = []
        self.signal_rows: list[object] = []

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        return organization_id == "local" and project_id == "project-simulated"

    async def gsc_connection(self, organization_id: str, project_id: str):
        return SimpleNamespace(site_url="sc-domain:example.com")

    async def published_articles(self, organization_id: str, project_id: str):
        return self.publication_targets

    async def create_sync_run(self, organization_id: str, project_id: str):
        run = SimpleNamespace(
            id="sync-simulated",
            status="running",
            data_through=None,
            started_at=datetime.now(UTC),
            completed_at=None,
            error=None,
        )
        self.sync_runs.append(run)
        return run

    async def replace_metrics(
        self,
        *,
        organization_id: str,
        project_id: str,
        start_date: date,
        end_date: date,
        targets,
        site_rows,
        article_rows,
    ) -> None:
        self.targets = {
            row.article_id: SimpleNamespace(
                article_id=row.article_id,
                publication_id=row.publication_id,
                url=url,
                aliases_json=aliases,
                published_at=row.published_at,
                last_published_at=row.last_published_at,
                publication_count=row.publication_count,
            )
            for row, url, aliases in targets
        }
        self.site_rows = list(site_rows)
        self.article_rows = article_rows

    async def finish_sync(
        self,
        run_id: str,
        *,
        status: str,
        data_through: date | None,
        target_count: int,
        error: str | None = None,
    ) -> None:
        run = next(row for row in self.sync_runs if row.id == run_id)
        run.status = status
        run.data_through = data_through
        run.completed_at = datetime.now(UTC)
        run.error = error

    async def latest_sync(self, organization_id: str, project_id: str):
        return self.sync_runs[-1] if self.sync_runs else None

    async def latest_completed_sync(self, organization_id: str, project_id: str):
        return next(
            (row for row in reversed(self.sync_runs) if row.status == "completed"),
            None,
        )

    async def site_daily(self, project_id: str, start_date: date, end_date: date):
        return [row for row in self.site_rows if start_date <= row.date <= end_date]

    async def article_daily(self, project_id: str, start_date: date, end_date: date):
        return {
            article_id: [row for row in rows if start_date <= row.date <= end_date]
            for article_id, rows in self.article_rows.items()
        }

    async def targets_with_articles(self, organization_id: str, project_id: str):
        return [
            (self.targets[article_id], self.articles[article_id]) for article_id in self.targets
        ]

    async def publications(self, organization_id: str, project_id: str, article_id: str):
        target = next(row for row in self.publication_targets if row.article_id == article_id)
        rows = [
            SimpleNamespace(
                id=f"publication-{article_id}-1",
                parent_publication_id=None,
                version_number=1,
                published_at=target.published_at,
            )
        ]
        if target.publication_count > 1:
            rows.append(
                SimpleNamespace(
                    id=target.publication_id,
                    parent_publication_id=rows[0].id,
                    version_number=2,
                    published_at=target.last_published_at,
                )
            )
        return rows

    async def signals(self, project_id: str, article_id: str | None = None):
        return [
            row
            for row in self.signal_rows
            if row.status == "open" and (article_id is None or row.article_id == article_id)
        ]

    async def replace_open_signals(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        signals,
        preserve_kinds: set[str] | None = None,
    ) -> None:
        active_kinds = {kind for kind, _ in signals}
        preserved = preserve_kinds or set()
        self.signal_rows = [
            row
            for row in self.signal_rows
            if row.article_id != article_id or row.kind in active_kinds or row.kind in preserved
        ]
        for kind, message in signals:
            existing = next(
                (
                    row
                    for row in self.signal_rows
                    if row.article_id == article_id and row.kind == kind
                ),
                None,
            )
            if existing is None:
                self.signal_rows.append(
                    SimpleNamespace(
                        id=f"signal-{article_id}-{kind}",
                        article_id=article_id,
                        kind=kind,
                        message=message,
                        status="open",
                        detected_at=datetime.now(UTC),
                    )
                )

    async def resolve_signal(self, organization_id: str, project_id: str, signal_id: str) -> bool:
        signal = next(
            (row for row in self.signal_rows if row.id == signal_id and row.status == "open"),
            None,
        )
        if signal is None:
            return False
        signal.status = "resolved"
        return True


class SimulatedGSCService:
    def __init__(self, data_through: date) -> None:
        self.data_through = data_through

    async def performance_dataset(
        self, project_id: str, *, start_date: date, end_date: date
    ) -> GSCPerformanceDataset:
        site_rows = []
        page_rows = []
        day = start_date
        while day <= end_date:
            age = (end_date - day).days
            site_rows.append(
                {
                    "keys": [day.isoformat()],
                    "clicks": 20,
                    "impressions": 400,
                    "position": 6,
                }
            )
            if age < 56:
                opportunity_url = (
                    "https://example.com/guides/solar-installation"
                    if age < 28
                    else "https://example.com/solar-guide"
                )
                page_rows.append(
                    {
                        "keys": [day.isoformat(), opportunity_url],
                        "clicks": 1,
                        "impressions": 10,
                        "position": 9,
                    }
                )
                page_rows.append(
                    {
                        "keys": [
                            day.isoformat(),
                            "https://example.com/commercial-solar-cost",
                        ],
                        "clicks": 0.25 if age < 28 else 1,
                        "impressions": 5 if age < 28 else 10,
                        "position": 11 if age < 28 else 7,
                    }
                )
            day += timedelta(days=1)
        return GSCPerformanceDataset(site_rows=site_rows, page_rows=page_rows)

    async def page_queries(
        self,
        project_id: str,
        *,
        page_url: str,
        start_date: date,
        end_date: date,
        limit: int,
    ):
        if page_url == "https://example.com/guides/solar-installation":
            return [
                SimpleNamespace(
                    key="solar installation cost",
                    clicks=4,
                    impressions=60,
                    position=8,
                )
            ]
        if page_url == "https://example.com/solar-guide":
            return [
                SimpleNamespace(
                    key="solar installation cost",
                    clicks=2,
                    impressions=30,
                    position=10,
                )
            ]
        return []


def test_simulated_published_articles_complete_the_performance_loop() -> None:
    async def scenario() -> None:
        data_through = datetime.now(UTC).date() - timedelta(days=3)
        repository = MemoryPerformanceRepository(data_through)
        service = PerformanceService(Settings(), repository, SimulatedGSCService(data_through))
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_performance_service] = lambda: service

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            sync = await client.post("/api/v1/projects/project-simulated/performance/sync")
            overview = await client.get(
                "/api/v1/projects/project-simulated/performance/overview?days=28"
            )
            articles = await client.get(
                "/api/v1/projects/project-simulated/performance/articles?days=28"
            )
            opportunity = await client.get(
                "/api/v1/projects/project-simulated/performance/articles/"
                "article-opportunity?days=28"
            )
            declining = await client.get(
                "/api/v1/projects/project-simulated/performance/articles/article-declining?days=28"
            )

            assert sync.status_code == 200
            assert sync.json()["target_count"] == 2
            assert sync.json()["sync"]["status"] == "completed"

            assert overview.status_code == 200
            overview_data = overview.json()
            assert overview_data["site_url"] == "sc-domain:example.com"
            assert overview_data["article_count"] == 2
            assert overview_data["status_counts"] == {"stable": 1, "declining": 1}
            assert [row["article_id"] for row in overview_data["declining_articles"]] == [
                "article-declining"
            ]

            assert articles.status_code == 200
            article_data = {row["article_id"]: row for row in articles.json()["items"]}
            assert article_data["article-opportunity"]["url"] == (
                "https://example.com/guides/solar-installation"
            )
            assert article_data["article-opportunity"]["metrics"]["impressions"] == 280
            assert article_data["article-opportunity"]["signal_count"] == 1
            assert article_data["article-declining"]["status"] == "declining"

            assert opportunity.status_code == 200
            opportunity_data = opportunity.json()
            assert opportunity_data["query_status"] == "available"
            assert opportunity_data["queries"] == [
                {
                    "query": "solar installation cost",
                    "clicks": 6.0,
                    "impressions": 90.0,
                    "ctr": 6 / 90,
                    "position": 26 / 3,
                }
            ]
            assert [row["kind"] for row in opportunity_data["publications"]] == [
                "published",
                "updated",
            ]
            assert opportunity_data["update_comparison"]["observation_complete"] is True
            opportunity_signal = next(
                row for row in opportunity_data["signals"] if row["kind"] == "ranking_opportunity"
            )

            assert declining.status_code == 200
            assert "visibility_decline" in {row["kind"] for row in declining.json()["signals"]}

            resolved = await client.post(
                "/api/v1/projects/project-simulated/performance/signals/"
                f"{opportunity_signal['id']}/resolve"
            )
            refreshed = await client.get(
                "/api/v1/projects/project-simulated/performance/articles/"
                "article-opportunity?days=28"
            )

        assert resolved.status_code == 204
        assert refreshed.status_code == 200
        assert refreshed.json()["signals"] == []

    asyncio.run(scenario())
