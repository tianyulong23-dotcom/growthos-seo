from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.modules.performance.domain import (
    Metrics,
    assess_article_performance,
    normalize_published_url,
)
from app.core.config import Settings
from app.modules.performance.service import (
    PerformanceService,
    aggregate_query_rows,
    fill_daily_window,
    has_complete_daily_window,
    parse_article_rows,
    sync_schema,
    update_comparison_schema,
)
from app.modules.performance.schemas import (
    PerformanceArticleItem,
    PerformanceMetricChange,
    PerformanceMetrics,
)
from app.modules.settings.gsc import GSC_DATA_LAG_DAYS, GSCError


def test_normalize_published_url_preserves_page_identity() -> None:
    assert (
        normalize_published_url("HTTPS://Example.COM:443/path?q=1#top")
        == "https://example.com/path?q=1"
    )
    assert normalize_published_url("https://example.com") == "https://example.com/"
    assert normalize_published_url("https://www.example.com/path") != normalize_published_url(
        "https://example.com/path"
    )
    assert normalize_published_url("https://example.com/path/") != normalize_published_url(
        "https://example.com/path"
    )


@pytest.mark.parametrize(
    "value", ["example.com/page", "file:///page", "https://user@example.com/page"]
)
def test_normalize_published_url_rejects_non_public_http_url(value: str) -> None:
    with pytest.raises(ValueError, match="published_url_invalid"):
        normalize_published_url(value)


def test_recent_update_stays_in_observation() -> None:
    now = datetime(2026, 8, 13, tzinfo=UTC)
    assessment = assess_article_performance(
        current=Metrics(clicks=2, impressions=100, position=12),
        previous=Metrics(clicks=10, impressions=300, position=7),
        published_at=now - timedelta(days=100),
        last_published_at=now - timedelta(days=5),
        now=now,
        complete_comparison_window=True,
    )
    assert assessment.status == "observing_update"
    assert assessment.signals == ()


def test_small_sample_does_not_report_decline() -> None:
    now = datetime(2026, 8, 13, tzinfo=UTC)
    assessment = assess_article_performance(
        current=Metrics(clicks=0, impressions=12, position=22),
        previous=Metrics(clicks=3, impressions=40, position=8),
        published_at=now - timedelta(days=100),
        last_published_at=now - timedelta(days=100),
        now=now,
        complete_comparison_window=True,
    )
    assert assessment.status == "impressions"
    assert all(kind != "visibility_decline" for kind, _ in assessment.signals)


def test_current_window_reports_no_impressions_without_previous_window() -> None:
    now = datetime(2026, 8, 13, tzinfo=UTC)
    assessment = assess_article_performance(
        current=Metrics(),
        previous=Metrics(),
        published_at=now - timedelta(days=20),
        last_published_at=now - timedelta(days=20),
        now=now,
        complete_current_window=True,
        complete_comparison_window=False,
    )

    assert assessment.status == "insufficient_data"
    assert ("no_impressions", "发布一段时间后仍无搜索曝光") in assessment.signals


def test_current_window_reports_low_ctr_without_previous_window() -> None:
    now = datetime(2026, 8, 13, tzinfo=UTC)
    assessment = assess_article_performance(
        current=Metrics(clicks=1, impressions=250, position=12),
        previous=Metrics(),
        published_at=now - timedelta(days=20),
        last_published_at=now - timedelta(days=20),
        now=now,
        complete_current_window=True,
        complete_comparison_window=False,
    )

    assert assessment.status == "clicks"
    assert ("high_impressions_low_ctr", "曝光较高，但点击率低于 1%") in assessment.signals


def test_article_average_position_does_not_create_query_opportunity() -> None:
    now = datetime(2026, 8, 13, tzinfo=UTC)
    assessment = assess_article_performance(
        current=Metrics(clicks=5, impressions=120, position=12),
        previous=Metrics(clicks=5, impressions=120, position=12),
        published_at=now - timedelta(days=100),
        last_published_at=now - timedelta(days=100),
        now=now,
        complete_comparison_window=True,
    )

    assert all(kind != "ranking_opportunity" for kind, _ in assessment.signals)


def test_complete_sample_reports_visibility_decline_without_claiming_cause() -> None:
    now = datetime(2026, 8, 13, tzinfo=UTC)
    assessment = assess_article_performance(
        current=Metrics(clicks=5, impressions=120, position=14),
        previous=Metrics(clicks=20, impressions=300, position=8),
        published_at=now - timedelta(days=100),
        last_published_at=now - timedelta(days=100),
        now=now,
        complete_comparison_window=True,
    )
    assert assessment.status == "declining"
    assert ("visibility_decline", "曝光下降且平均排名或点击同步走弱") in assessment.signals


def test_failed_sync_keeps_last_completed_data_boundary() -> None:
    failed_at = datetime(2026, 8, 13, tzinfo=UTC)
    state = sync_schema(
        SimpleNamespace(
            status="failed",
            data_through=None,
            completed_at=failed_at,
            started_at=failed_at,
            error="upstream unavailable",
        ),
        SimpleNamespace(data_through=date(2026, 8, 10)),
    )

    assert state.status == "failed"
    assert state.data_through == date(2026, 8, 10)
    assert state.synced_at == failed_at


def test_article_rows_merge_url_aliases_for_the_same_article_and_day() -> None:
    rows = parse_article_rows(
        [
            {
                "keys": ["2026-08-10", "https://example.com/old-path"],
                "clicks": 1,
                "impressions": 10,
                "position": 8,
            },
            {
                "keys": ["2026-08-10", "https://example.com/new-path"],
                "clicks": 2,
                "impressions": 20,
                "position": 6,
            },
        ],
        [
            (
                SimpleNamespace(article_id="article-1"),
                "https://example.com/new-path",
                [
                    "https://example.com/old-path",
                    "https://example.com/new-path",
                ],
            )
        ],
    )

    assert len(rows["article-1"]) == 1
    metric = rows["article-1"][0]
    assert metric.date == date(2026, 8, 10)
    assert metric.clicks == 3
    assert metric.impressions == 30
    assert metric.position == pytest.approx(20 / 3)


def test_current_article_url_takes_priority_over_another_articles_alias() -> None:
    older = SimpleNamespace(
        article_id="article-old",
        url="https://example.com/new-path",
        urls=("https://example.com/shared-path", "https://example.com/new-path"),
        last_published_at=datetime(2026, 8, 1, tzinfo=UTC),
    )
    current = SimpleNamespace(
        article_id="article-current",
        url="https://example.com/shared-path",
        urls=("https://example.com/shared-path",),
        last_published_at=datetime(2026, 8, 2, tzinfo=UTC),
    )

    targets = PerformanceService._normalize_targets([older, current])
    rows = parse_article_rows(
        [
            {
                "keys": ["2026-08-10", "https://example.com/shared-path"],
                "clicks": 2,
                "impressions": 20,
                "position": 6,
            }
        ],
        targets,
    )

    assert "article-old" not in rows
    assert rows["article-current"][0].clicks == 2


def test_fill_daily_window_keeps_article_trends_continuous() -> None:
    rows = fill_daily_window(
        [SimpleNamespace(date=date(2026, 8, 2), clicks=2, impressions=20, position=6)],
        date(2026, 8, 1),
        date(2026, 8, 3),
    )

    assert [row.date for row in rows] == [
        date(2026, 8, 1),
        date(2026, 8, 2),
        date(2026, 8, 3),
    ]
    assert [row.clicks for row in rows] == [0, 2, 0]


def test_complete_daily_window_rejects_an_internal_gap() -> None:
    rows = [
        SimpleNamespace(date=date(2026, 8, 1)),
        SimpleNamespace(date=date(2026, 8, 3)),
    ]

    assert has_complete_daily_window(rows, date(2026, 8, 1), date(2026, 8, 3)) is False
    rows.append(SimpleNamespace(date=date(2026, 8, 2)))
    assert has_complete_daily_window(rows, date(2026, 8, 1), date(2026, 8, 3)) is True


def test_article_age_uses_gsc_data_boundary_for_current_window_signal() -> None:
    assessment = assess_article_performance(
        current=Metrics(),
        previous=Metrics(),
        published_at=datetime(2026, 7, 28, tzinfo=UTC),
        last_published_at=datetime(2026, 7, 28, tzinfo=UTC),
        now=datetime(2026, 8, 10, tzinfo=UTC),
        complete_current_window=True,
        complete_comparison_window=False,
    )

    assert assessment.status == "waiting_data"
    assert assessment.signals == ()


def test_article_items_use_gsc_data_boundary_for_article_age() -> None:
    async def scenario() -> None:
        range_end = date(2026, 8, 10)
        published_at = datetime(2026, 7, 28, tzinfo=UTC)
        target = SimpleNamespace(
            url="https://example.com/article",
            published_at=published_at,
            last_published_at=published_at,
        )
        article = SimpleNamespace(
            id="article-1",
            title="Article",
            primary_keyword="keyword",
        )
        repository = SimpleNamespace(
            article_daily=AsyncMock(return_value={}),
            site_daily=AsyncMock(
                return_value=[
                    SimpleNamespace(date=range_end - timedelta(days=offset)) for offset in range(56)
                ]
            ),
            signals=AsyncMock(return_value=[]),
            targets_with_articles=AsyncMock(return_value=[(target, article)]),
        )
        service = PerformanceService(Settings(), repository, SimpleNamespace())

        [item] = await service._article_items("org-1", "project-1", 28, range_end)

        assert item.status == "waiting_data"

    import asyncio

    asyncio.run(scenario())


def test_signal_refresh_persists_query_ranking_opportunity() -> None:
    async def scenario() -> None:
        range_end = date(2026, 8, 10)
        published_at = datetime(2026, 5, 1, tzinfo=UTC)
        target = SimpleNamespace(
            url="https://example.com/article",
            aliases_json=[],
            published_at=published_at,
            last_published_at=published_at,
        )
        article = SimpleNamespace(id="article-1")
        repository = SimpleNamespace(
            article_daily=AsyncMock(return_value={}),
            site_daily=AsyncMock(
                return_value=[
                    SimpleNamespace(date=range_end - timedelta(days=offset)) for offset in range(56)
                ]
            ),
            targets_with_articles=AsyncMock(return_value=[(target, article)]),
            replace_open_signals=AsyncMock(),
        )
        gsc = SimpleNamespace(
            page_queries=AsyncMock(
                return_value=[
                    SimpleNamespace(
                        key="search opportunity",
                        clicks=2,
                        impressions=50,
                        position=10,
                    )
                ]
            )
        )
        service = PerformanceService(Settings(), repository, gsc)
        service._article_items = AsyncMock(return_value=[SimpleNamespace(article_id="article-1")])

        await service._refresh_signals("org-1", "project-1", range_end)

        signals = repository.replace_open_signals.await_args.args[3]
        assert (
            "ranking_opportunity",
            "实际查询排名在 5 至 20 位且已有曝光",
        ) in signals

    import asyncio

    asyncio.run(scenario())


def test_query_rows_merge_url_aliases_by_query() -> None:
    rows = aggregate_query_rows(
        [
            SimpleNamespace(key="solar panels", clicks=1, impressions=10, position=8),
            SimpleNamespace(key="solar panels", clicks=2, impressions=20, position=5),
            SimpleNamespace(key="solar installation", clicks=1, impressions=5, position=12),
        ]
    )

    assert [row.query for row in rows] == ["solar panels", "solar installation"]
    assert rows[0].clicks == 3
    assert rows[0].impressions == 30
    assert rows[0].position == pytest.approx(6)


def test_daily_sync_continues_after_one_project_fails() -> None:
    async def scenario() -> None:
        repository = SimpleNamespace(
            due_project_ids=AsyncMock(return_value=["project-1", "project-2"])
        )
        service = PerformanceService(Settings(), repository, SimpleNamespace())
        service.sync = AsyncMock(side_effect=[RuntimeError("upstream"), SimpleNamespace()])

        completed = await service.sync_due_projects()

        assert completed == 1
        assert [call.args for call in service.sync.await_args_list] == [
            ("project-1",),
            ("project-2",),
        ]

    import asyncio

    asyncio.run(scenario())


def test_signal_refresh_failure_does_not_overwrite_successful_metric_sync() -> None:
    async def scenario() -> None:
        completed_at = datetime(2026, 8, 13, tzinfo=UTC)
        expected_data_through = datetime.now(UTC).date() - timedelta(
            days=GSC_DATA_LAG_DAYS
        )
        completed_sync = SimpleNamespace(
            status="completed",
            data_through=expected_data_through,
            completed_at=completed_at,
            started_at=completed_at,
            error=None,
        )
        repository = SimpleNamespace(
            project_exists=AsyncMock(return_value=True),
            gsc_connection=AsyncMock(return_value=SimpleNamespace(site_url="sc-domain:test")),
            latest_completed_sync=AsyncMock(return_value=None),
            create_sync_run=AsyncMock(return_value=SimpleNamespace(id="run-1")),
            published_articles=AsyncMock(return_value=[]),
            replace_metrics=AsyncMock(),
            finish_sync=AsyncMock(),
            latest_sync=AsyncMock(return_value=completed_sync),
        )
        gsc = SimpleNamespace(
            performance_dataset=AsyncMock(return_value=SimpleNamespace(site_rows=[], page_rows=[]))
        )
        service = PerformanceService(Settings(), repository, gsc)
        service._refresh_signals = AsyncMock(side_effect=RuntimeError("signal refresh failed"))

        response = await service.sync("project-1")

        assert response.sync.status == "completed"
        repository.finish_sync.assert_awaited_once_with(
            "run-1",
            status="completed",
            data_through=expected_data_through,
            target_count=0,
        )
        assert response.sync.data_through == expected_data_through

    import asyncio

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("sort", "order", "expected_ids"),
    [
        ("position", "asc", ["article-low", "article-high", "article-missing"]),
        ("position", "desc", ["article-high", "article-low", "article-missing"]),
        ("change", "asc", ["article-low", "article-high", "article-missing"]),
        ("change", "desc", ["article-high", "article-low", "article-missing"]),
    ],
)
def test_article_sort_keeps_missing_values_last(
    sort: str, order: str, expected_ids: list[str]
) -> None:
    async def scenario() -> None:
        published_at = datetime(2026, 6, 1, tzinfo=UTC)

        def item(article_id: str, *, position: float, clicks_change: float | None):
            return PerformanceArticleItem(
                article_id=article_id,
                title=article_id,
                url=f"https://example.com/{article_id}",
                primary_keyword=article_id,
                published_at=published_at,
                last_published_at=published_at,
                metrics=PerformanceMetrics(position=position),
                previous_metrics=PerformanceMetrics(),
                change=PerformanceMetricChange(clicks=clicks_change),
                status="stable",
            )

        service = PerformanceService(Settings(), SimpleNamespace(), SimpleNamespace())
        service._ensure_project = AsyncMock()
        service._sync_context = AsyncMock(return_value=(None, None))
        service._periods = Mock(
            return_value=(
                date(2026, 7, 14),
                date(2026, 8, 10),
                date(2026, 6, 16),
                date(2026, 7, 13),
            )
        )
        service._article_items = AsyncMock(
            return_value=[
                item("article-missing", position=0, clicks_change=None),
                item("article-high", position=10, clicks_change=10),
                item("article-low", position=2, clicks_change=-5),
            ]
        )

        result = await service.articles(
            "project-1", 28, page=1, page_size=25, sort=sort, order=order
        )

        assert [article.article_id for article in result.items] == expected_ids

    import asyncio

    asyncio.run(scenario())


def test_article_queries_merge_all_historical_urls_and_report_failures() -> None:
    async def scenario() -> None:
        gsc = SimpleNamespace(
            page_queries=AsyncMock(
                side_effect=[
                    [SimpleNamespace(key="solar", clicks=1, impressions=10, position=8)],
                    [SimpleNamespace(key="solar", clicks=2, impressions=20, position=5)],
                ]
            )
        )
        service = PerformanceService(Settings(), SimpleNamespace(), gsc)
        target = SimpleNamespace(
            url="https://example.com/new",
            aliases_json=["https://example.com/old", "https://example.com/new"],
        )

        rows, status = await service._article_queries(
            "project-1", target, date(2026, 8, 1), date(2026, 8, 10)
        )

        assert status == "available"
        assert len(rows) == 1
        assert rows[0].clicks == 3
        assert rows[0].position == pytest.approx(6)
        assert [call.kwargs["page_url"] for call in gsc.page_queries.await_args_list] == [
            "https://example.com/new",
            "https://example.com/old",
        ]

        gsc.page_queries.side_effect = GSCError("unavailable")
        rows, status = await service._article_queries(
            "project-1", target, date(2026, 8, 1), date(2026, 8, 10)
        )
        assert rows == []
        assert status == "unavailable"

    import asyncio

    asyncio.run(scenario())


def test_update_comparison_uses_fourteen_day_windows() -> None:
    target = SimpleNamespace(
        published_at=datetime(2026, 6, 1, tzinfo=UTC),
        last_published_at=datetime(2026, 7, 15, tzinfo=UTC),
    )
    rows = [
        SimpleNamespace(
            date=date(2026, 7, 1) + timedelta(days=index),
            clicks=1 if index < 14 else 2,
            impressions=10 if index < 14 else 20,
            position=8 if index < 14 else 6,
        )
        for index in range(28)
    ]

    comparison = update_comparison_schema(target, rows, date(2026, 7, 28))

    assert comparison is not None
    assert comparison.before_start == date(2026, 7, 1)
    assert comparison.after_end == date(2026, 7, 28)
    assert comparison.before_metrics.clicks == 14
    assert comparison.after_metrics.clicks == 28
    assert comparison.observation_complete is True
