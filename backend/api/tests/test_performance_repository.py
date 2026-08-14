import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from sqlalchemy.dialects import postgresql
from sqlalchemy.sql.dml import Delete, Insert, Update

from app.modules.performance.repository import PerformanceRepository


class ScalarResult:
    def __init__(self, rows: list[object]) -> None:
        self.rows = rows

    def all(self) -> list[object]:
        return self.rows


class FakeSession:
    def __init__(self, rows: list[object]) -> None:
        self.rows = rows
        self.added: list[object] = []
        self.added_many: list[object] = []
        self.deleted: list[object] = []
        self.executed: list[object] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args) -> None:
        return None

    async def scalars(self, _statement) -> ScalarResult:
        return ScalarResult(self.rows)

    async def delete(self, row: object) -> None:
        self.deleted.append(row)

    async def execute(self, statement):
        self.executed.append(statement)
        return SimpleNamespace(rowcount=1)

    def add(self, row: object) -> None:
        self.added.append(row)

    def add_all(self, rows: list[object]) -> None:
        self.added_many.extend(rows)

    async def commit(self) -> None:
        return None


def test_resolved_signal_is_suppressed_until_condition_disappears() -> None:
    async def scenario() -> None:
        resolved = SimpleNamespace(kind="visibility_decline", status="resolved", message="old")
        active_session = FakeSession([resolved])
        repository = PerformanceRepository(lambda: active_session)

        await repository.replace_open_signals(
            "org-1",
            "project-1",
            "article-1",
            (("visibility_decline", "still declining"),),
        )

        assert active_session.added == []
        assert active_session.deleted == []

        inactive_session = FakeSession([resolved])
        repository = PerformanceRepository(lambda: inactive_session)
        await repository.replace_open_signals("org-1", "project-1", "article-1", ())
        assert inactive_session.deleted == [resolved]

        recurring_session = FakeSession([])
        repository = PerformanceRepository(lambda: recurring_session)
        await repository.replace_open_signals(
            "org-1",
            "project-1",
            "article-1",
            (("visibility_decline", "declining again"),),
        )
        assert len(recurring_session.added) == 1
        assert recurring_session.added[0].kind == "visibility_decline"
        assert recurring_session.added[0].status == "open"

    asyncio.run(scenario())


def test_metric_replacement_removes_targets_that_are_no_longer_published() -> None:
    async def scenario() -> None:
        session = FakeSession([])
        repository = PerformanceRepository(lambda: session)

        await repository.replace_metrics(
            organization_id="org-1",
            project_id="project-1",
            start_date=datetime(2026, 8, 1, tzinfo=UTC).date(),
            end_date=datetime(2026, 8, 2, tzinfo=UTC).date(),
            targets=[],
            site_rows=[],
            article_rows={},
        )

        assert isinstance(session.executed[0], Delete)
        assert session.executed[0].table.name == "article_performance_targets"

    asyncio.run(scenario())


def test_metric_replacement_releases_existing_urls_before_target_upserts() -> None:
    async def scenario() -> None:
        session = FakeSession([])
        repository = PerformanceRepository(lambda: session)
        target = SimpleNamespace(
            article_id="article-1",
            publication_id="publication-1",
            url="https://example.com/new-path",
            published_at=datetime(2026, 8, 1, tzinfo=UTC),
            last_published_at=datetime(2026, 8, 2, tzinfo=UTC),
            publication_count=2,
        )

        await repository.replace_metrics(
            organization_id="org-1",
            project_id="project-1",
            start_date=datetime(2026, 8, 1, tzinfo=UTC).date(),
            end_date=datetime(2026, 8, 2, tzinfo=UTC).date(),
            targets=[(target, "https://example.com/new-path", [])],
            site_rows=[],
            article_rows={},
        )

        assert isinstance(session.executed[1], Update)
        release_sql = str(
            session.executed[1].compile(
                dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
            )
        )
        assert "performance-sync-pending:" in release_sql
        assert isinstance(session.executed[2], Insert)

    asyncio.run(scenario())


def test_sync_creation_expires_an_abandoned_running_lease() -> None:
    class SyncSession(FakeSession):
        async def scalar(self, statement):
            self.executed.append(statement)
            return SimpleNamespace(id="run-1")

    async def scenario() -> None:
        session = SyncSession([])
        repository = PerformanceRepository(lambda: session)

        result = await repository.create_sync_run("org-1", "project-1")

        assert result.id == "run-1"
        assert isinstance(session.executed[0], Update)
        params = session.executed[0].compile().params
        assert params["status"] == "failed"
        assert params["error"] == "performance_sync_lease_expired"
        assert params["started_at_1"] <= datetime.now(UTC) - timedelta(hours=5)

    asyncio.run(scenario())
