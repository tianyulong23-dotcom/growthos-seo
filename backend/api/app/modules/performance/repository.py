from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from uuid import uuid4

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.content.models import Article, ArticlePublication
from app.modules.performance.models import (
    ArticleGSCDaily,
    ArticlePerformanceTarget,
    GSCSiteDaily,
    PerformanceSignal,
    PerformanceSyncRun,
)
from app.modules.projects.models import Project
from app.modules.settings.models import GSCConnection


PERFORMANCE_SYNC_LEASE = timedelta(hours=6)


@dataclass(frozen=True)
class PublishedArticle:
    article_id: str
    publication_id: str
    title: str
    primary_keyword: str
    url: str
    urls: tuple[str, ...]
    published_at: datetime
    last_published_at: datetime
    publication_count: int


@dataclass(frozen=True)
class DailyMetric:
    date: date
    clicks: float
    impressions: float
    position: float


class PerformanceRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        async with self.sessions() as session:
            return bool(
                await session.scalar(
                    select(Project.id).where(
                        Project.organization_id == organization_id,
                        Project.id == project_id,
                    )
                )
            )

    async def gsc_connection(self, organization_id: str, project_id: str) -> GSCConnection | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(GSCConnection).where(
                    GSCConnection.organization_id == organization_id,
                    GSCConnection.project_id == project_id,
                    GSCConnection.site_url.is_not(None),
                    GSCConnection.requires_reconnect.is_(False),
                )
            )

    async def published_articles(
        self, organization_id: str, project_id: str
    ) -> list[PublishedArticle]:
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(Article, ArticlePublication)
                    .join(ArticlePublication, ArticlePublication.article_id == Article.id)
                    .where(
                        Article.organization_id == organization_id,
                        Article.project_id == project_id,
                        ArticlePublication.status == "published",
                        ArticlePublication.remote_url.is_not(None),
                        ArticlePublication.published_at.is_not(None),
                    )
                    .order_by(
                        ArticlePublication.article_id,
                        ArticlePublication.published_at,
                    )
                )
            ).all()

        grouped: dict[str, list[tuple[Article, ArticlePublication]]] = {}
        for article, publication in rows:
            grouped.setdefault(article.id, []).append((article, publication))
        output: list[PublishedArticle] = []
        for publications in grouped.values():
            article, first = publications[0]
            _, latest = publications[-1]
            output.append(
                PublishedArticle(
                    article_id=article.id,
                    publication_id=latest.id,
                    title=article.title or article.primary_keyword,
                    primary_keyword=article.primary_keyword,
                    url=str(latest.remote_url),
                    urls=tuple(
                        dict.fromkeys(
                            str(publication.remote_url)
                            for _, publication in publications
                            if publication.remote_url
                        )
                    ),
                    published_at=first.published_at,
                    last_published_at=latest.published_at,
                    publication_count=len(publications),
                )
            )
        return output

    async def create_sync_run(
        self, organization_id: str, project_id: str
    ) -> PerformanceSyncRun | None:
        async with self.sessions() as session:
            now = datetime.now(UTC)
            await session.execute(
                update(PerformanceSyncRun)
                .where(
                    PerformanceSyncRun.organization_id == organization_id,
                    PerformanceSyncRun.project_id == project_id,
                    PerformanceSyncRun.status == "running",
                    PerformanceSyncRun.started_at < now - PERFORMANCE_SYNC_LEASE,
                )
                .values(
                    status="failed",
                    error="performance_sync_lease_expired",
                    completed_at=now,
                )
            )
            statement = (
                insert(PerformanceSyncRun)
                .values(
                    id=str(uuid4()),
                    organization_id=organization_id,
                    project_id=project_id,
                    status="running",
                )
                .on_conflict_do_nothing(
                    index_elements=[
                        PerformanceSyncRun.organization_id,
                        PerformanceSyncRun.project_id,
                    ],
                    index_where=text("status = 'running'"),
                )
                .returning(PerformanceSyncRun)
            )
            row = await session.scalar(statement)
            await session.commit()
            return row

    async def due_project_ids(self, organization_id: str, data_through: date) -> list[str]:
        latest_completed = (
            select(
                PerformanceSyncRun.project_id.label("project_id"),
                func.max(PerformanceSyncRun.data_through).label("data_through"),
            )
            .where(
                PerformanceSyncRun.organization_id == organization_id,
                PerformanceSyncRun.status == "completed",
            )
            .group_by(PerformanceSyncRun.project_id)
            .subquery()
        )
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(GSCConnection.project_id)
                        .outerjoin(
                            latest_completed,
                            latest_completed.c.project_id == GSCConnection.project_id,
                        )
                        .where(
                            GSCConnection.organization_id == organization_id,
                            GSCConnection.site_url.is_not(None),
                            GSCConnection.requires_reconnect.is_(False),
                            (
                                latest_completed.c.data_through.is_(None)
                                | (latest_completed.c.data_through < data_through)
                            ),
                        )
                        .order_by(GSCConnection.project_id)
                    )
                ).all()
            )

    async def finish_sync(
        self,
        run_id: str,
        *,
        status: str,
        data_through: date | None,
        target_count: int,
        error: str | None = None,
    ) -> None:
        async with self.sessions() as session:
            await session.execute(
                update(PerformanceSyncRun)
                .where(PerformanceSyncRun.id == run_id)
                .values(
                    status=status,
                    data_through=data_through,
                    target_count=target_count,
                    error=error,
                    completed_at=datetime.now(UTC),
                )
            )
            await session.commit()

    async def replace_metrics(
        self,
        *,
        organization_id: str,
        project_id: str,
        start_date: date,
        end_date: date,
        targets: list[tuple[PublishedArticle, str, list[str]]],
        site_rows: list[DailyMetric],
        article_rows: dict[str, list[DailyMetric]],
    ) -> None:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            target_ids = [item.article_id for item, _, _ in targets]
            stale_targets = delete(ArticlePerformanceTarget).where(
                ArticlePerformanceTarget.organization_id == organization_id,
                ArticlePerformanceTarget.project_id == project_id,
            )
            if target_ids:
                stale_targets = stale_targets.where(
                    ArticlePerformanceTarget.article_id.not_in(target_ids)
                )
            await session.execute(stale_targets)
            if target_ids:
                await session.execute(
                    update(ArticlePerformanceTarget)
                    .where(
                        ArticlePerformanceTarget.organization_id == organization_id,
                        ArticlePerformanceTarget.project_id == project_id,
                        ArticlePerformanceTarget.article_id.in_(target_ids),
                    )
                    .values(
                        normalized_url=func.concat(
                            "performance-sync-pending:",
                            ArticlePerformanceTarget.article_id,
                        )
                    )
                )

            for item, normalized_url, aliases in targets:
                statement = insert(ArticlePerformanceTarget).values(
                    article_id=item.article_id,
                    organization_id=organization_id,
                    project_id=project_id,
                    publication_id=item.publication_id,
                    url=item.url,
                    normalized_url=normalized_url,
                    aliases_json=aliases,
                    published_at=item.published_at,
                    last_published_at=item.last_published_at,
                    publication_count=item.publication_count,
                    updated_at=now,
                )
                await session.execute(
                    statement.on_conflict_do_update(
                        index_elements=[ArticlePerformanceTarget.article_id],
                        set_={
                            "publication_id": statement.excluded.publication_id,
                            "url": statement.excluded.url,
                            "normalized_url": statement.excluded.normalized_url,
                            "aliases_json": statement.excluded.aliases_json,
                            "published_at": statement.excluded.published_at,
                            "last_published_at": statement.excluded.last_published_at,
                            "publication_count": statement.excluded.publication_count,
                            "updated_at": now,
                        },
                    )
                )

            await session.execute(
                delete(GSCSiteDaily).where(
                    GSCSiteDaily.project_id == project_id,
                    GSCSiteDaily.date.between(start_date, end_date),
                )
            )
            await session.execute(
                delete(ArticleGSCDaily).where(
                    ArticleGSCDaily.project_id == project_id,
                    ArticleGSCDaily.date.between(start_date, end_date),
                )
            )
            session.add_all(
                [
                    GSCSiteDaily(
                        project_id=project_id,
                        date=row.date,
                        clicks=row.clicks,
                        impressions=row.impressions,
                        position=row.position,
                        synced_at=now,
                    )
                    for row in site_rows
                ]
            )
            session.add_all(
                [
                    ArticleGSCDaily(
                        article_id=article_id,
                        project_id=project_id,
                        date=row.date,
                        clicks=row.clicks,
                        impressions=row.impressions,
                        position=row.position,
                        synced_at=now,
                    )
                    for article_id, rows in article_rows.items()
                    for row in rows
                ]
            )
            await session.commit()

    async def site_daily(
        self, project_id: str, start_date: date, end_date: date
    ) -> list[GSCSiteDaily]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(GSCSiteDaily)
                        .where(
                            GSCSiteDaily.project_id == project_id,
                            GSCSiteDaily.date.between(start_date, end_date),
                        )
                        .order_by(GSCSiteDaily.date)
                    )
                ).all()
            )

    async def article_daily(
        self, project_id: str, start_date: date, end_date: date
    ) -> dict[str, list[ArticleGSCDaily]]:
        async with self.sessions() as session:
            rows = (
                await session.scalars(
                    select(ArticleGSCDaily)
                    .where(
                        ArticleGSCDaily.project_id == project_id,
                        ArticleGSCDaily.date.between(start_date, end_date),
                    )
                    .order_by(ArticleGSCDaily.date)
                )
            ).all()
        output: dict[str, list[ArticleGSCDaily]] = {}
        for row in rows:
            output.setdefault(row.article_id, []).append(row)
        return output

    async def targets_with_articles(
        self, organization_id: str, project_id: str
    ) -> list[tuple[ArticlePerformanceTarget, Article]]:
        async with self.sessions() as session:
            return list(
                (
                    await session.execute(
                        select(ArticlePerformanceTarget, Article)
                        .join(Article, Article.id == ArticlePerformanceTarget.article_id)
                        .where(
                            ArticlePerformanceTarget.organization_id == organization_id,
                            ArticlePerformanceTarget.project_id == project_id,
                        )
                        .order_by(ArticlePerformanceTarget.last_published_at.desc())
                    )
                ).all()
            )

    async def publications(
        self, organization_id: str, project_id: str, article_id: str
    ) -> list[ArticlePublication]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(ArticlePublication)
                        .where(
                            ArticlePublication.organization_id == organization_id,
                            ArticlePublication.project_id == project_id,
                            ArticlePublication.article_id == article_id,
                            ArticlePublication.status == "published",
                        )
                        .order_by(ArticlePublication.published_at)
                    )
                ).all()
            )

    async def latest_sync(self, organization_id: str, project_id: str) -> PerformanceSyncRun | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(PerformanceSyncRun)
                .where(
                    PerformanceSyncRun.organization_id == organization_id,
                    PerformanceSyncRun.project_id == project_id,
                )
                .order_by(PerformanceSyncRun.started_at.desc())
                .limit(1)
            )

    async def latest_completed_sync(
        self, organization_id: str, project_id: str
    ) -> PerformanceSyncRun | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(PerformanceSyncRun)
                .where(
                    PerformanceSyncRun.organization_id == organization_id,
                    PerformanceSyncRun.project_id == project_id,
                    PerformanceSyncRun.status == "completed",
                )
                .order_by(PerformanceSyncRun.started_at.desc())
                .limit(1)
            )

    async def replace_open_signals(
        self,
        organization_id: str,
        project_id: str,
        article_id: str,
        signals: tuple[tuple[str, str], ...],
        preserve_kinds: set[str] | None = None,
    ) -> None:
        active_kinds = {kind for kind, _ in signals}
        preserved = preserve_kinds or set()
        async with self.sessions() as session:
            existing = list(
                (
                    await session.scalars(
                        select(PerformanceSignal).where(
                            PerformanceSignal.project_id == project_id,
                            PerformanceSignal.article_id == article_id,
                        )
                    )
                ).all()
            )
            existing_by_kind: dict[str, list[PerformanceSignal]] = {}
            for row in existing:
                existing_by_kind.setdefault(row.kind, []).append(row)
            for row in existing:
                if row.kind not in active_kinds and row.kind not in preserved:
                    await session.delete(row)
            for kind, message in signals:
                rows = existing_by_kind.get(kind, [])
                opened = next((row for row in rows if row.status == "open"), None)
                resolved = next((row for row in rows if row.status == "resolved"), None)
                if opened is not None:
                    opened.message = message
                elif resolved is not None:
                    continue
                else:
                    session.add(
                        PerformanceSignal(
                            id=str(uuid4()),
                            organization_id=organization_id,
                            project_id=project_id,
                            article_id=article_id,
                            kind=kind,
                            status="open",
                            message=message,
                        )
                    )
            await session.commit()

    async def signals(
        self, project_id: str, article_id: str | None = None
    ) -> list[PerformanceSignal]:
        conditions = [
            PerformanceSignal.project_id == project_id,
            PerformanceSignal.status == "open",
        ]
        if article_id:
            conditions.append(PerformanceSignal.article_id == article_id)
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(PerformanceSignal)
                        .where(*conditions)
                        .order_by(PerformanceSignal.detected_at.desc())
                    )
                ).all()
            )

    async def resolve_signal(self, organization_id: str, project_id: str, signal_id: str) -> bool:
        async with self.sessions() as session:
            result = await session.execute(
                update(PerformanceSignal)
                .where(
                    PerformanceSignal.organization_id == organization_id,
                    PerformanceSignal.project_id == project_id,
                    PerformanceSignal.id == signal_id,
                    PerformanceSignal.status == "open",
                )
                .values(status="resolved", resolved_at=datetime.now(UTC))
            )
            await session.commit()
            return bool(result.rowcount)
