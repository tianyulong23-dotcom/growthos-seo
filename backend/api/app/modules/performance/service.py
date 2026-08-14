from collections import Counter
from datetime import UTC, date, datetime, time, timedelta
import logging
from typing import Iterable

from app.core.config import Settings, get_settings
from app.db.session import session_factory
from app.modules.performance.domain import (
    Metrics,
    assess_article_performance,
    normalize_published_url,
    percentage_change,
)
from app.modules.performance.repository import DailyMetric, PerformanceRepository
from app.modules.performance.schemas import (
    DateRange,
    PerformanceArticleCollection,
    PerformanceArticleDetail,
    PerformanceArticleItem,
    PerformanceMetricChange,
    PerformanceMetrics,
    PerformanceOverview,
    PerformancePublicationEvent,
    PerformanceQueryRow,
    PerformanceSignalResponse,
    PerformanceSyncResponse,
    PerformanceSyncState,
    PerformanceTrendPoint,
    PerformanceUpdateComparison,
)
from app.modules.settings.gsc import GSC_DATA_LAG_DAYS, GSCError, GSCService, build_gsc_service


logger = logging.getLogger(__name__)


class PerformanceNotFoundError(Exception):
    pass


class PerformanceConflictError(Exception):
    pass


class PerformanceService:
    def __init__(
        self,
        settings: Settings,
        repository: PerformanceRepository,
        gsc: GSCService,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.gsc = gsc

    async def overview(self, project_id: str, days: DateRange) -> PerformanceOverview:
        organization_id = self.settings.default_organization_id
        await self._ensure_project(organization_id, project_id)
        connection = await self.repository.gsc_connection(organization_id, project_id)
        sync, data_sync = await self._sync_context(organization_id, project_id)
        range_start, range_end, previous_start, previous_end = self._periods(days, data_sync)
        rows = await self.repository.site_daily(project_id, previous_start, range_end)
        current = aggregate_metrics(row for row in rows if range_start <= row.date <= range_end)
        previous = aggregate_metrics(
            row for row in rows if previous_start <= row.date <= previous_end
        )
        article_items = await self._article_items(organization_id, project_id, days, range_end)
        status_counts = Counter(item.status for item in article_items)
        return PerformanceOverview(
            gsc_connected=connection is not None,
            site_url=connection.site_url if connection else None,
            date_range=days,
            range_start=range_start,
            range_end=range_end,
            previous_start=previous_start,
            previous_end=previous_end,
            metrics=metrics_schema(current),
            previous_metrics=metrics_schema(previous),
            change=metric_change(current, previous),
            trend=[trend_schema(row) for row in rows if range_start <= row.date <= range_end],
            article_count=len(article_items),
            status_counts=dict(status_counts),
            growing_articles=sorted(
                (item for item in article_items if item.status == "growing"),
                key=lambda item: (
                    item.change.clicks if item.change.clicks is not None else float("-inf")
                ),
                reverse=True,
            )[:5],
            declining_articles=sorted(
                (item for item in article_items if item.status == "declining"),
                key=lambda item: (
                    item.change.clicks if item.change.clicks is not None else float("inf")
                ),
            )[:5],
            sync=sync_schema(sync, data_sync),
        )

    async def articles(
        self,
        project_id: str,
        days: DateRange,
        *,
        page: int,
        page_size: int,
        status: str | None = None,
        sort: str = "clicks",
        order: str = "desc",
    ) -> PerformanceArticleCollection:
        organization_id = self.settings.default_organization_id
        await self._ensure_project(organization_id, project_id)
        _, data_sync = await self._sync_context(organization_id, project_id)
        _, range_end, _, _ = self._periods(days, data_sync)
        items = await self._article_items(organization_id, project_id, days, range_end)
        if status:
            items = [item for item in items if item.status == status]
        sort_keys = {
            "clicks": lambda item: item.metrics.clicks,
            "impressions": lambda item: item.metrics.impressions,
            "ctr": lambda item: item.metrics.ctr,
            "position": lambda item: item.metrics.position,
            "published_at": lambda item: item.published_at,
            "updated_at": lambda item: item.last_published_at,
            "change": lambda item: item.change.clicks,
        }
        missing = []
        sortable = []
        for item in items:
            if (sort == "position" and item.metrics.position <= 0) or (
                sort == "change" and item.change.clicks is None
            ):
                missing.append(item)
            else:
                sortable.append(item)
        sortable.sort(key=sort_keys[sort], reverse=order == "desc")
        items = sortable + missing
        total = len(items)
        offset = (page - 1) * page_size
        return PerformanceArticleCollection(
            items=items[offset : offset + page_size],
            total=total,
            page=page,
            page_size=page_size,
        )

    async def article_detail(
        self, project_id: str, article_id: str, days: DateRange
    ) -> PerformanceArticleDetail:
        organization_id = self.settings.default_organization_id
        await self._ensure_project(organization_id, project_id)
        sync, data_sync = await self._sync_context(organization_id, project_id)
        range_start, range_end, _, _ = self._periods(days, data_sync)
        items = await self._article_items(organization_id, project_id, days, range_end)
        item = next((candidate for candidate in items if candidate.article_id == article_id), None)
        if item is None:
            raise PerformanceNotFoundError("performance_article_not_found")
        targets = {
            article.id: target
            for target, article in await self.repository.targets_with_articles(
                organization_id, project_id
            )
        }
        target = targets[article_id]
        comparison_start = (
            target.last_published_at.date() - timedelta(days=14)
            if target.last_published_at > target.published_at
            else range_start
        )
        daily = await self.repository.article_daily(
            project_id, min(range_start, comparison_start), range_end
        )
        publications = await self.repository.publications(organization_id, project_id, article_id)
        signals = await self.repository.signals(project_id, article_id)
        queries, query_status = await self._article_queries(
            project_id, target, range_start, range_end
        )
        article_rows = daily.get(article_id, [])
        return PerformanceArticleDetail(
            article=item,
            trend=[
                trend_schema(row)
                for row in fill_daily_window(
                    [row for row in article_rows if range_start <= row.date <= range_end],
                    range_start,
                    range_end,
                )
            ],
            queries=queries,
            query_status=query_status,
            query_error=("gsc_query_unavailable" if query_status == "unavailable" else None),
            publications=[
                PerformancePublicationEvent(
                    publication_id=row.id,
                    kind="updated" if row.parent_publication_id else "published",
                    version_number=row.version_number,
                    occurred_at=row.published_at,
                )
                for row in publications
                if row.published_at is not None
            ],
            signals=[
                PerformanceSignalResponse(
                    id=row.id,
                    kind=row.kind,
                    message=row.message,
                    status=row.status,
                    detected_at=row.detected_at,
                )
                for row in signals
            ],
            update_comparison=update_comparison_schema(target, article_rows, range_end),
            data_through=data_sync.data_through if data_sync else None,
        )

    async def sync_due_projects(self) -> int:
        organization_id = self.settings.default_organization_id
        data_through = datetime.now(UTC).date() - timedelta(days=GSC_DATA_LAG_DAYS)
        project_ids = await self.repository.due_project_ids(organization_id, data_through)
        completed = 0
        for project_id in project_ids:
            try:
                await self.sync(project_id)
                completed += 1
            except PerformanceConflictError:
                continue
            except Exception:
                logger.exception(
                    "Unable to synchronize performance data for project %s",
                    project_id,
                )
        return completed

    async def sync(self, project_id: str) -> PerformanceSyncResponse:
        organization_id = self.settings.default_organization_id
        await self._ensure_project(organization_id, project_id)
        connection = await self.repository.gsc_connection(organization_id, project_id)
        if connection is None:
            raise PerformanceConflictError("gsc_not_connected")
        previous_sync = await self.repository.latest_completed_sync(organization_id, project_id)
        run = await self.repository.create_sync_run(organization_id, project_id)
        if run is None:
            raise PerformanceConflictError("performance_sync_running")

        target_count = 0
        data_through = datetime.now(UTC).date() - timedelta(days=GSC_DATA_LAG_DAYS)
        try:
            start_date = data_through - timedelta(days=6 if previous_sync else 179)
            publications = await self.repository.published_articles(organization_id, project_id)
            targets = self._normalize_targets(publications)
            target_count = len(targets)
            dataset = await self.gsc.performance_dataset(
                project_id, start_date=start_date, end_date=data_through
            )
            site_rows = fill_daily_window(
                parse_site_rows(dataset.site_rows), start_date, data_through
            )
            article_rows = parse_article_rows(dataset.page_rows, targets)
            await self.repository.replace_metrics(
                organization_id=organization_id,
                project_id=project_id,
                start_date=start_date,
                end_date=data_through,
                targets=targets,
                site_rows=site_rows,
                article_rows=article_rows,
            )
            try:
                await self._refresh_signals(organization_id, project_id, data_through)
            except Exception:
                logger.exception(
                    "Unable to refresh performance signals for project %s",
                    project_id,
                )
            await self.repository.finish_sync(
                run.id,
                status="completed",
                data_through=data_through,
                target_count=target_count,
            )
        except Exception as exc:
            await self.repository.finish_sync(
                run.id,
                status="failed",
                data_through=None,
                target_count=target_count,
                error=str(exc)[:1000],
            )
            raise
        completed = await self.repository.latest_sync(organization_id, project_id)
        return PerformanceSyncResponse(sync=sync_schema(completed), target_count=target_count)

    async def resolve_signal(self, project_id: str, signal_id: str) -> None:
        organization_id = self.settings.default_organization_id
        await self._ensure_project(organization_id, project_id)
        if not await self.repository.resolve_signal(organization_id, project_id, signal_id):
            raise PerformanceNotFoundError("performance_signal_not_found")

    async def _article_items(
        self,
        organization_id: str,
        project_id: str,
        days: int,
        range_end: date,
    ) -> list[PerformanceArticleItem]:
        current_start = range_end - timedelta(days=days - 1)
        previous_end = current_start - timedelta(days=1)
        previous_start = previous_end - timedelta(days=days - 1)
        status_current_start = range_end - timedelta(days=27)
        status_previous_end = status_current_start - timedelta(days=1)
        status_previous_start = status_previous_end - timedelta(days=27)
        daily = await self.repository.article_daily(
            project_id, min(previous_start, status_previous_start), range_end
        )
        site_rows = await self.repository.site_daily(project_id, status_previous_start, range_end)
        complete_status_window = has_complete_daily_window(
            site_rows, status_previous_start, range_end
        )
        signals = await self.repository.signals(project_id)
        signal_counts = Counter(row.article_id for row in signals)
        output: list[PerformanceArticleItem] = []
        for target, article in await self.repository.targets_with_articles(
            organization_id, project_id
        ):
            rows = daily.get(article.id, [])
            current = aggregate_metrics(
                row for row in rows if current_start <= row.date <= range_end
            )
            previous = aggregate_metrics(
                row for row in rows if previous_start <= row.date <= previous_end
            )
            status_current = aggregate_metrics(
                row for row in rows if status_current_start <= row.date <= range_end
            )
            status_previous = aggregate_metrics(
                row for row in rows if status_previous_start <= row.date <= status_previous_end
            )
            assessment = assess_article_performance(
                current=status_current,
                previous=status_previous,
                published_at=target.published_at,
                last_published_at=target.last_published_at,
                now=datetime.combine(range_end, time.min, tzinfo=UTC),
                complete_comparison_window=(
                    complete_status_window and target.published_at.date() <= status_previous_start
                ),
                complete_current_window=has_complete_daily_window(
                    site_rows,
                    max(status_current_start, target.published_at.date()),
                    range_end,
                ),
            )
            output.append(
                PerformanceArticleItem(
                    article_id=article.id,
                    title=article.title or article.primary_keyword,
                    url=target.url,
                    primary_keyword=article.primary_keyword,
                    published_at=target.published_at,
                    last_published_at=target.last_published_at,
                    metrics=metrics_schema(current),
                    previous_metrics=metrics_schema(previous),
                    change=metric_change(current, previous),
                    status=assessment.status,
                    signal_count=signal_counts[article.id],
                )
            )
        return output

    async def _refresh_signals(
        self, organization_id: str, project_id: str, range_end: date
    ) -> None:
        items = await self._article_items(organization_id, project_id, 28, range_end)
        daily = await self.repository.article_daily(
            project_id, range_end - timedelta(days=55), range_end
        )
        site_rows = await self.repository.site_daily(
            project_id, range_end - timedelta(days=55), range_end
        )
        complete = has_complete_daily_window(site_rows, range_end - timedelta(days=55), range_end)
        targets = {
            article.id: target
            for target, article in await self.repository.targets_with_articles(
                organization_id, project_id
            )
        }
        for item in items:
            rows = daily.get(item.article_id, [])
            current = aggregate_metrics(
                row for row in rows if row.date >= range_end - timedelta(days=27)
            )
            previous = aggregate_metrics(
                row
                for row in rows
                if range_end - timedelta(days=55) <= row.date <= range_end - timedelta(days=28)
            )
            target = targets[item.article_id]
            assessment = assess_article_performance(
                current=current,
                previous=previous,
                published_at=target.published_at,
                last_published_at=target.last_published_at,
                now=datetime.combine(range_end, time.min, tzinfo=UTC),
                complete_comparison_window=(
                    complete and target.published_at.date() <= range_end - timedelta(days=55)
                ),
                complete_current_window=has_complete_daily_window(
                    site_rows,
                    max(range_end - timedelta(days=27), target.published_at.date()),
                    range_end,
                ),
            )
            query_signals: tuple[tuple[str, str], ...] = ()
            queries, query_status = await self._article_queries(
                project_id,
                target,
                range_end - timedelta(days=27),
                range_end,
            )
            if any(5 <= row.position <= 20 and row.impressions >= 50 for row in queries):
                query_signals = (("ranking_opportunity", "实际查询排名在 5 至 20 位且已有曝光"),)
            await self.repository.replace_open_signals(
                organization_id,
                project_id,
                item.article_id,
                assessment.signals + query_signals,
                preserve_kinds=(
                    {"ranking_opportunity"} if query_status == "unavailable" else set()
                ),
            )

    async def _article_queries(
        self,
        project_id: str,
        target: object,
        start_date: date,
        end_date: date,
    ) -> tuple[list[PerformanceQueryRow], str]:
        page_urls = list(
            dict.fromkeys([str(target.url), *[str(value) for value in target.aliases_json]])
        )
        rows: list[object] = []
        try:
            for page_url in page_urls:
                rows.extend(
                    await self.gsc.page_queries(
                        project_id,
                        page_url=page_url,
                        start_date=start_date,
                        end_date=end_date,
                        limit=1000,
                    )
                )
        except GSCError:
            return [], "unavailable"
        queries = aggregate_query_rows(rows)
        return queries, "available" if queries else "empty"

    async def _ensure_project(self, organization_id: str, project_id: str) -> None:
        if not await self.repository.project_exists(organization_id, project_id):
            raise PerformanceNotFoundError("project_not_found")

    async def _sync_context(self, organization_id: str, project_id: str):
        latest = await self.repository.latest_sync(organization_id, project_id)
        if latest is None or latest.data_through is not None:
            return latest, latest
        completed = await self.repository.latest_completed_sync(organization_id, project_id)
        return latest, completed or latest

    @staticmethod
    def _periods(days: int, sync) -> tuple[date, date, date, date]:
        end = (
            sync.data_through
            if sync is not None and sync.data_through is not None
            else datetime.now(UTC).date() - timedelta(days=GSC_DATA_LAG_DAYS)
        )
        start = end - timedelta(days=days - 1)
        previous_end = start - timedelta(days=1)
        previous_start = previous_end - timedelta(days=days - 1)
        return start, end, previous_start, previous_end

    @staticmethod
    def _normalize_targets(publications) -> list[tuple[object, str, list[str]]]:
        output: list[tuple[object, str, list[str]]] = []
        normalized_publications: list[tuple[object, str]] = []
        current_urls: set[str] = set()
        for publication in publications:
            try:
                normalized = normalize_published_url(publication.url)
            except ValueError:
                continue
            normalized_publications.append((publication, normalized))
            current_urls.add(normalized)

        seen_urls: set[str] = set()
        claimed_aliases: set[str] = set()
        for publication, normalized in sorted(
            normalized_publications,
            key=lambda item: item[0].last_published_at,
            reverse=True,
        ):
            if normalized in seen_urls:
                continue
            seen_urls.add(normalized)
            aliases = [normalized]
            claimed_aliases.add(normalized)
            for value in publication.urls:
                try:
                    alias = normalize_published_url(value)
                except ValueError:
                    continue
                if alias != normalized and alias in current_urls:
                    continue
                if alias in claimed_aliases:
                    continue
                if alias not in aliases:
                    aliases.append(alias)
                    claimed_aliases.add(alias)
            output.append((publication, normalized, aliases))
        return output


def aggregate_metrics(rows: Iterable[object]) -> Metrics:
    clicks = 0.0
    impressions = 0.0
    weighted_position = 0.0
    for row in rows:
        clicks += float(row.clicks)
        impressions += float(row.impressions)
        weighted_position += float(row.position) * float(row.impressions)
    return Metrics(
        clicks=clicks,
        impressions=impressions,
        position=weighted_position / impressions if impressions else 0,
    )


def metrics_schema(value: Metrics) -> PerformanceMetrics:
    return PerformanceMetrics(
        clicks=value.clicks,
        impressions=value.impressions,
        ctr=value.ctr,
        position=value.position,
    )


def metric_change(current: Metrics, previous: Metrics) -> PerformanceMetricChange:
    position_change = current.position - previous.position if previous.impressions else None
    return PerformanceMetricChange(
        clicks=percentage_change(current.clicks, previous.clicks),
        impressions=percentage_change(current.impressions, previous.impressions),
        ctr=percentage_change(current.ctr, previous.ctr),
        position=position_change,
    )


def aggregate_query_rows(rows: Iterable[object]) -> list[PerformanceQueryRow]:
    grouped: dict[str, tuple[float, float, float]] = {}
    for row in rows:
        query = str(row.key).strip()
        if not query:
            continue
        clicks = float(row.clicks)
        impressions = float(row.impressions)
        position = float(row.position)
        previous_clicks, previous_impressions, previous_weight = grouped.get(query, (0, 0, 0))
        grouped[query] = (
            previous_clicks + clicks,
            previous_impressions + impressions,
            previous_weight + position * impressions,
        )
    output = [
        PerformanceQueryRow(
            query=query,
            clicks=clicks,
            impressions=impressions,
            ctr=clicks / impressions if impressions else 0,
            position=position_weight / impressions if impressions else 0,
        )
        for query, (clicks, impressions, position_weight) in grouped.items()
    ]
    output.sort(key=lambda row: (row.impressions, row.clicks), reverse=True)
    return output


def update_comparison_schema(
    target: object,
    rows: Iterable[object],
    data_through: date,
) -> PerformanceUpdateComparison | None:
    if target.last_published_at <= target.published_at:
        return None
    updated_at = target.last_published_at
    updated_date = updated_at.date()
    if data_through < updated_date:
        return None
    before_end = updated_date - timedelta(days=1)
    before_start = before_end - timedelta(days=13)
    after_start = updated_date
    expected_after_end = after_start + timedelta(days=13)
    after_end = min(data_through, expected_after_end)
    before = aggregate_metrics(row for row in rows if before_start <= row.date <= before_end)
    after = aggregate_metrics(row for row in rows if after_start <= row.date <= after_end)
    return PerformanceUpdateComparison(
        updated_at=updated_at,
        before_start=before_start,
        before_end=before_end,
        after_start=after_start,
        after_end=after_end,
        before_metrics=metrics_schema(before),
        after_metrics=metrics_schema(after),
        change=metric_change(after, before),
        observation_complete=data_through >= expected_after_end,
    )


def trend_schema(row: object) -> PerformanceTrendPoint:
    impressions = float(row.impressions)
    clicks = float(row.clicks)
    return PerformanceTrendPoint(
        date=row.date,
        clicks=clicks,
        impressions=impressions,
        ctr=clicks / impressions if impressions else 0,
        position=float(row.position),
    )


def sync_schema(row, data_sync=None) -> PerformanceSyncState:
    if row is None:
        return PerformanceSyncState()
    return PerformanceSyncState(
        status=row.status,
        data_through=row.data_through or (data_sync.data_through if data_sync else None),
        synced_at=row.completed_at or row.started_at,
        error=row.error,
    )


def parse_site_rows(rows: list[dict]) -> list[DailyMetric]:
    output: list[DailyMetric] = []
    for row in rows:
        keys = row.get("keys")
        if not isinstance(keys, list) or not keys:
            continue
        try:
            day = date.fromisoformat(str(keys[0]))
        except ValueError:
            continue
        output.append(
            DailyMetric(
                date=day,
                clicks=float(row.get("clicks") or 0),
                impressions=float(row.get("impressions") or 0),
                position=float(row.get("position") or 0),
            )
        )
    return output


def parse_article_rows(
    rows: list[dict], targets: list[tuple[object, str, list[str]]]
) -> dict[str, list[DailyMetric]]:
    by_url = {
        alias: item.article_id
        for item, normalized, aliases in reversed(targets)
        for alias in [normalized, *aliases]
    }
    grouped: dict[tuple[str, date], tuple[float, float, float]] = {}
    for row in rows:
        keys = row.get("keys")
        if not isinstance(keys, list) or len(keys) < 2:
            continue
        try:
            day = date.fromisoformat(str(keys[0]))
            normalized = normalize_published_url(str(keys[1]))
        except ValueError:
            continue
        article_id = by_url.get(normalized)
        if article_id is None:
            continue
        clicks = float(row.get("clicks") or 0)
        impressions = float(row.get("impressions") or 0)
        position = float(row.get("position") or 0)
        previous_clicks, previous_impressions, previous_weight = grouped.get(
            (article_id, day), (0, 0, 0)
        )
        grouped[(article_id, day)] = (
            previous_clicks + clicks,
            previous_impressions + impressions,
            previous_weight + position * impressions,
        )
    output: dict[str, list[DailyMetric]] = {}
    for (article_id, day), (clicks, impressions, position_weight) in sorted(
        grouped.items(), key=lambda item: item[0]
    ):
        output.setdefault(article_id, []).append(
            DailyMetric(
                date=day,
                clicks=clicks,
                impressions=impressions,
                position=position_weight / impressions if impressions else 0,
            )
        )
    return output


def fill_daily_window(
    rows: list[DailyMetric], start_date: date, end_date: date
) -> list[DailyMetric]:
    by_date = {row.date: row for row in rows}
    day = start_date
    output: list[DailyMetric] = []
    while day <= end_date:
        output.append(
            by_date.get(
                day,
                DailyMetric(date=day, clicks=0, impressions=0, position=0),
            )
        )
        day += timedelta(days=1)
    return output


def has_complete_daily_window(rows: Iterable[object], start_date: date, end_date: date) -> bool:
    if start_date > end_date:
        return False
    dates = {row.date for row in rows if start_date <= row.date <= end_date}
    return len(dates) == (end_date - start_date).days + 1


def build_performance_service() -> PerformanceService:
    return PerformanceService(
        get_settings(), PerformanceRepository(session_factory), build_gsc_service()
    )
