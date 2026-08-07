from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.modules.content.models import Article
from app.modules.content_plan.domain import normalize_keyword
from app.modules.content_plan.models import (
    ContentPlanBatch,
    ContentPlanCandidate,
    ContentPlanExternalRequest,
    ContentPlanItem,
    ContentPlanItemKeyword,
    ContentPlanPreparation,
    ContentPlanPreparationKeyword,
    ContentPlanPreparationRelation,
    ContentPlanSerpSnapshot,
    ContentPlanSettings,
)
from app.modules.content_plan.scheduling import (
    CADENCES,
    allocate_slots,
    local_monday,
    make_slot,
    publication_blocked_reason,
)
from app.modules.content_plan.recovery import (
    MANUAL_RETRYABLE_BATCH_ERROR_CODES,
    RECOVERABLE_PREPARATION_ERROR_CODES,
)
from app.modules.keywords.models import Keyword
from app.modules.projects.models import Project, SiteProfile


@dataclass(frozen=True)
class PreparationBundle:
    preparation: ContentPlanPreparation
    keywords: list[ContentPlanPreparationKeyword]
    relations: list[ContentPlanPreparationRelation]
    serp_snapshots: list[ContentPlanSerpSnapshot]


@dataclass(frozen=True)
class PlanItemBundle:
    item: ContentPlanItem
    keywords: list[ContentPlanItemKeyword]
    serp_snapshot: ContentPlanSerpSnapshot | None = None
    pending_preparation: ContentPlanPreparation | None = None
    article: Article | None = None


@dataclass(frozen=True)
class CandidateWindow:
    candidates: list[ContentPlanCandidate]
    last_source_rank: int
    exhausted: bool


@dataclass(frozen=True)
class ProjectPlanContext:
    project: Project
    settings: ContentPlanSettings
    business_context: dict[str, Any]


@dataclass(frozen=True)
class PreparationDispatchTarget:
    preparation_id: str
    workflow_id: str
    organization_id: str
    project_id: str


@dataclass(frozen=True)
class BatchDispatchTarget:
    batch_id: str
    workflow_id: str
    organization_id: str
    project_id: str


@dataclass(frozen=True)
class BatchRetryTarget:
    batch: ContentPlanBatch
    preparation_id: str | None


@dataclass(frozen=True)
class BatchProgress:
    batch: ContentPlanBatch
    preparation_count: int
    preview_ready_count: int
    plan_item_count: int
    external_request_count: int
    total_cost_usd: float


class ActiveAutomaticBatchError(Exception):
    def __init__(self, batch_id: str) -> None:
        super().__init__("active_automatic_batch_exists")
        self.batch_id = batch_id


class PlanItemConflictError(Exception):
    def __init__(self, conflict_plan_id: str) -> None:
        super().__init__(f"active content plan seed conflicts with {conflict_plan_id}")
        self.conflict_plan_id = conflict_plan_id


class ContentPlanRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    async def project_exists(self, organization_id: str, project_id: str) -> bool:
        async with self.sessions() as session:
            return (
                await session.scalar(
                    select(Project.id).where(
                        Project.id == project_id,
                        Project.organization_id == organization_id,
                    )
                )
                is not None
            )

    async def get_project_plan_context(
        self, organization_id: str, project_id: str
    ) -> ProjectPlanContext | None:
        async with self.sessions() as session:
            project = await session.scalar(
                select(Project).where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                )
            )
            if project is None:
                return None
            settings = await session.get(ContentPlanSettings, project_id)
            if settings is None:
                return None
            profile = await session.get(SiteProfile, project_id)
            merged = dict(profile.profile_json or {}) if profile is not None else {}
            if profile is not None:
                merged.update(dict(profile.user_overrides or {}))
            return ProjectPlanContext(project, settings, merged)

    async def find_keyword_conflict(
        self,
        project_id: str,
        keyword: str,
        *,
        exclude_item_id: str | None = None,
    ) -> tuple[str, str] | None:
        normalized = normalize_keyword(keyword)
        async with self.sessions() as session:
            item_rows = list(
                (
                    await session.execute(
                        select(
                            ContentPlanItem.id,
                            ContentPlanItem.normalized_seed_keyword,
                            ContentPlanItem.primary_keyword,
                        ).where(
                            ContentPlanItem.project_id == project_id,
                            ContentPlanItem.status != "cancelled",
                            *(
                                (ContentPlanItem.id != exclude_item_id,)
                                if exclude_item_id is not None
                                else ()
                            ),
                        )
                    )
                ).all()
            )
            for item_id, seed, primary in item_rows:
                if normalized in {seed, normalize_keyword(primary)}:
                    return "plan", str(item_id)
            article_rows = list(
                (
                    await session.execute(
                        select(Article.id, Article.primary_keyword).where(
                            Article.project_id == project_id,
                            Article.status != "cancelled",
                        )
                    )
                ).all()
            )
            for article_id, primary in article_rows:
                if normalize_keyword(primary) == normalized:
                    return "article", str(article_id)
            return None

    async def create_manual_preparation(
        self,
        *,
        batch_id: str,
        preparation_id: str,
        organization_id: str,
        project_id: str,
        idempotency_key: str,
        request_hash: str,
        seed_keyword: str,
        normalized_seed_keyword: str,
        country: str,
        language: str,
        timezone: str,
        business_context: dict[str, Any],
    ) -> tuple[ContentPlanBatch, ContentPlanPreparation]:
        self._validate_timezone(timezone)
        async with self.sessions() as session:
            existing = await session.scalar(
                select(ContentPlanBatch)
                .where(
                    ContentPlanBatch.organization_id == organization_id,
                    ContentPlanBatch.project_id == project_id,
                    ContentPlanBatch.idempotency_key == idempotency_key,
                )
                .with_for_update()
            )
            if existing is not None:
                if existing.request_hash != request_hash:
                    raise ValueError("idempotency_key_conflict")
                preparation = await session.scalar(
                    select(ContentPlanPreparation).where(
                        ContentPlanPreparation.batch_id == existing.id,
                        ContentPlanPreparation.source_round == "manual",
                    )
                )
                if preparation is None:
                    raise ValueError("manual_preparation_missing")
                return existing, preparation

            batch = ContentPlanBatch(
                id=batch_id,
                organization_id=organization_id,
                project_id=project_id,
                source="manual",
                target_count=1,
                status="queued",
                stage="queued",
                country=country,
                language=language,
                timezone=timezone,
                workflow_id=f"content-plan:manual:{batch_id}",
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                config_snapshot_json={
                    "target_count": 1,
                    "country": country,
                    "language": language,
                    "timezone": timezone,
                    "business_context": dict(business_context),
                },
                decision_summary_json={},
            )
            preparation = ContentPlanPreparation(
                id=preparation_id,
                batch_id=batch_id,
                plan_order=1,
                seed_keyword=seed_keyword,
                normalized_seed_keyword=normalized_seed_keyword,
                source_round="manual",
                state="expanding",
                workflow_id=f"content-plan:{batch_id}:prepare:1:1",
            )
            session.add_all([batch, preparation])
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                existing = await session.scalar(
                    select(ContentPlanBatch).where(
                        ContentPlanBatch.organization_id == organization_id,
                        ContentPlanBatch.project_id == project_id,
                        ContentPlanBatch.idempotency_key == idempotency_key,
                    )
                )
                if existing is None:
                    raise
                if existing.request_hash != request_hash:
                    raise ValueError("idempotency_key_conflict")
                existing_preparation = await session.scalar(
                    select(ContentPlanPreparation).where(
                        ContentPlanPreparation.batch_id == existing.id,
                        ContentPlanPreparation.source_round == "manual",
                    )
                )
                if existing_preparation is None:
                    raise ValueError("manual_preparation_missing")
                return existing, existing_preparation
            return batch, preparation

    async def create_batch(
        self,
        *,
        batch_id: str,
        organization_id: str,
        project_id: str,
        source: str,
        workflow_id: str,
        idempotency_key: str,
        request_hash: str,
        country: str,
        language: str,
        timezone: str,
        config_snapshot: dict[str, Any] | None = None,
    ) -> ContentPlanBatch:
        self._validate_timezone(timezone)
        config = {
            "target_count": 30 if source == "automatic" else 1,
            "candidate_window_size": 50,
            "max_supplement_rounds": 2,
            "country": country,
            "language": language,
            "timezone": timezone,
            **dict(config_snapshot or {}),
        }
        batch = ContentPlanBatch(
            id=batch_id,
            organization_id=organization_id,
            project_id=project_id,
            source=source,
            target_count=30 if source == "automatic" else 1,
            status="queued",
            stage="queued",
            country=country,
            language=language,
            timezone=timezone,
            workflow_id=workflow_id,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            config_snapshot_json=config,
            decision_summary_json={},
        )
        async with self.sessions() as session:
            existing = await session.scalar(
                select(ContentPlanBatch).where(
                    ContentPlanBatch.organization_id == organization_id,
                    ContentPlanBatch.project_id == project_id,
                    ContentPlanBatch.idempotency_key == idempotency_key,
                )
            )
            if existing is not None:
                if existing.request_hash != request_hash:
                    raise ValueError("idempotency_key_conflict")
                return existing
            session.add(batch)
            await session.commit()
            await session.refresh(batch)
            return batch

    async def create_automatic_batch(
        self,
        *,
        batch_id: str,
        organization_id: str,
        project_id: str,
        workflow_id: str,
        idempotency_key: str,
        request_hash: str,
        country: str,
        language: str,
        timezone: str,
        business_context: dict[str, Any],
    ) -> ContentPlanBatch:
        self._validate_timezone(timezone)
        async with self.sessions() as session:
            existing = await session.scalar(
                select(ContentPlanBatch).where(
                    ContentPlanBatch.organization_id == organization_id,
                    ContentPlanBatch.project_id == project_id,
                    ContentPlanBatch.idempotency_key == idempotency_key,
                )
            )
            if existing is not None:
                if existing.request_hash != request_hash:
                    raise ValueError("idempotency_key_conflict")
                return existing
            active = await session.scalar(
                select(ContentPlanBatch).where(
                    ContentPlanBatch.project_id == project_id,
                    ContentPlanBatch.source == "automatic",
                    ContentPlanBatch.status.not_in(("completed", "cancelled")),
                )
            )
            if active is not None:
                raise ActiveAutomaticBatchError(active.id)
            batch = ContentPlanBatch(
                id=batch_id,
                organization_id=organization_id,
                project_id=project_id,
                source="automatic",
                target_count=30,
                status="queued",
                stage="queued",
                country=country,
                language=language,
                timezone=timezone,
                workflow_id=workflow_id,
                idempotency_key=idempotency_key,
                request_hash=request_hash,
                config_snapshot_json={
                    "target_count": 30,
                    "candidate_window_size": 50,
                    "max_supplement_rounds": 2,
                    "country": country,
                    "language": language,
                    "timezone": timezone,
                    "business_context": dict(business_context),
                },
                decision_summary_json={},
            )
            session.add(batch)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                existing = await session.scalar(
                    select(ContentPlanBatch).where(
                        ContentPlanBatch.organization_id == organization_id,
                        ContentPlanBatch.project_id == project_id,
                        ContentPlanBatch.idempotency_key == idempotency_key,
                    )
                )
                if existing is not None:
                    if existing.request_hash != request_hash:
                        raise ValueError("idempotency_key_conflict")
                    return existing
                active = await session.scalar(
                    select(ContentPlanBatch).where(
                        ContentPlanBatch.project_id == project_id,
                        ContentPlanBatch.source == "automatic",
                        ContentPlanBatch.status.not_in(("completed", "cancelled")),
                    )
                )
                if active is not None:
                    raise ActiveAutomaticBatchError(active.id)
                raise
            await session.refresh(batch)
            return batch

    async def get_batch(self, batch_id: str) -> ContentPlanBatch | None:
        async with self.sessions() as session:
            return await session.get(ContentPlanBatch, batch_id)

    async def get_batch_scoped(
        self, organization_id: str, project_id: str, batch_id: str
    ) -> ContentPlanBatch | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(ContentPlanBatch).where(
                    ContentPlanBatch.id == batch_id,
                    ContentPlanBatch.organization_id == organization_id,
                    ContentPlanBatch.project_id == project_id,
                )
            )

    async def get_batch_progress_scoped(
        self, organization_id: str, project_id: str, batch_id: str
    ) -> BatchProgress | None:
        async with self.sessions() as session:
            batch = await session.scalar(
                select(ContentPlanBatch).where(
                    ContentPlanBatch.id == batch_id,
                    ContentPlanBatch.organization_id == organization_id,
                    ContentPlanBatch.project_id == project_id,
                )
            )
            if batch is None:
                return None
            preparation_count = int(
                await session.scalar(
                    select(func.count(ContentPlanPreparation.id)).where(
                        ContentPlanPreparation.batch_id == batch_id,
                        ContentPlanPreparation.is_current.is_(True),
                    )
                )
                or 0
            )
            preview_ready_count = int(
                await session.scalar(
                    select(func.count(ContentPlanPreparation.id)).where(
                        ContentPlanPreparation.batch_id == batch_id,
                        ContentPlanPreparation.is_current.is_(True),
                        ContentPlanPreparation.state == "preview_ready",
                    )
                )
                or 0
            )
            plan_item_count = int(
                await session.scalar(
                    select(func.count(ContentPlanItem.id)).where(
                        ContentPlanItem.batch_id == batch_id
                    )
                )
                or 0
            )
            external_request_count = int(
                await session.scalar(
                    select(func.count(ContentPlanExternalRequest.id)).where(
                        ContentPlanExternalRequest.batch_id == batch_id
                    )
                )
                or 0
            )
            total_cost_usd = float(
                await session.scalar(
                    select(func.coalesce(func.sum(ContentPlanExternalRequest.cost_usd), 0)).where(
                        ContentPlanExternalRequest.batch_id == batch_id
                    )
                )
                or 0
            )
            return BatchProgress(
                batch=batch,
                preparation_count=preparation_count,
                preview_ready_count=preview_ready_count,
                plan_item_count=plan_item_count,
                external_request_count=external_request_count,
                total_cost_usd=total_cost_usd,
            )

    async def list_batch_progress_scoped(
        self,
        organization_id: str,
        project_id: str,
        *,
        limit: int = 20,
    ) -> list[BatchProgress]:
        if limit < 1:
            raise ValueError("batch list limit must be positive")
        async with self.sessions() as session:
            batches = list(
                (
                    await session.scalars(
                        select(ContentPlanBatch)
                        .where(
                            ContentPlanBatch.organization_id == organization_id,
                            ContentPlanBatch.project_id == project_id,
                        )
                        .order_by(
                            ContentPlanBatch.created_at.desc(),
                            ContentPlanBatch.id.desc(),
                        )
                        .limit(limit)
                    )
                ).all()
            )
            if not batches:
                return []
            batch_ids = [batch.id for batch in batches]
            preparation_rows = (
                await session.execute(
                    select(
                        ContentPlanPreparation.batch_id,
                        func.count(ContentPlanPreparation.id),
                        func.count(ContentPlanPreparation.id).filter(
                            ContentPlanPreparation.state == "preview_ready"
                        ),
                    )
                    .where(
                        ContentPlanPreparation.batch_id.in_(batch_ids),
                        ContentPlanPreparation.is_current.is_(True),
                    )
                    .group_by(ContentPlanPreparation.batch_id)
                )
            ).all()
            item_rows = (
                await session.execute(
                    select(ContentPlanItem.batch_id, func.count(ContentPlanItem.id))
                    .where(ContentPlanItem.batch_id.in_(batch_ids))
                    .group_by(ContentPlanItem.batch_id)
                )
            ).all()
            request_rows = (
                await session.execute(
                    select(
                        ContentPlanExternalRequest.batch_id,
                        func.count(ContentPlanExternalRequest.id),
                        func.coalesce(func.sum(ContentPlanExternalRequest.cost_usd), 0),
                    )
                    .where(ContentPlanExternalRequest.batch_id.in_(batch_ids))
                    .group_by(ContentPlanExternalRequest.batch_id)
                )
            ).all()
            preparation_counts = {
                str(row[0]): (int(row[1]), int(row[2])) for row in preparation_rows
            }
            item_counts = {str(row[0]): int(row[1]) for row in item_rows}
            request_counts = {
                str(row[0]): (int(row[1]), float(row[2])) for row in request_rows
            }
            return [
                BatchProgress(
                    batch=batch,
                    preparation_count=preparation_counts.get(batch.id, (0, 0))[0],
                    preview_ready_count=preparation_counts.get(batch.id, (0, 0))[1],
                    plan_item_count=item_counts.get(batch.id, 0),
                    external_request_count=request_counts.get(batch.id, (0, 0.0))[0],
                    total_cost_usd=request_counts.get(batch.id, (0, 0.0))[1],
                )
                for batch in batches
            ]

    async def get_batch_dispatch_target(
        self, batch_id: str
    ) -> BatchDispatchTarget | None:
        async with self.sessions() as session:
            row = await session.scalar(
                select(ContentPlanBatch).where(
                    ContentPlanBatch.id == batch_id,
                    ContentPlanBatch.source == "automatic",
                )
            )
            if row is None:
                return None
            return BatchDispatchTarget(
                batch_id=row.id,
                workflow_id=row.workflow_id,
                organization_id=row.organization_id,
                project_id=row.project_id,
            )

    async def list_recoverable_automatic_batches(
        self, *, limit: int = 100
    ) -> list[BatchDispatchTarget]:
        if limit < 1:
            raise ValueError("recovery limit must be positive")
        active_statuses = {
            "queued",
            "selecting_seeds",
            "expanding",
            "building_packs",
            "supplementing",
            "building_previews",
            "creating_items",
            "scheduling",
        }
        async with self.sessions() as session:
            rows = list(
                (
                    await session.scalars(
                        select(ContentPlanBatch)
                        .where(
                            ContentPlanBatch.source == "automatic",
                            (
                                ContentPlanBatch.status.in_(active_statuses)
                                | (
                                    (ContentPlanBatch.status == "needs_attention")
                                    & ContentPlanBatch.error_code.in_(
                                        RECOVERABLE_PREPARATION_ERROR_CODES
                                    )
                                )
                            ),
                        )
                        .order_by(ContentPlanBatch.updated_at, ContentPlanBatch.id)
                        .limit(limit)
                    )
                ).all()
            )
            return [
                BatchDispatchTarget(
                    batch_id=row.id,
                    workflow_id=row.workflow_id,
                    organization_id=row.organization_id,
                    project_id=row.project_id,
                )
                for row in rows
            ]

    async def get_preparation_dispatch_target(
        self, preparation_id: str
    ) -> PreparationDispatchTarget | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(
                        ContentPlanPreparation.id,
                        ContentPlanPreparation.workflow_id,
                        ContentPlanBatch.organization_id,
                        ContentPlanBatch.project_id,
                    )
                    .join(
                        ContentPlanBatch,
                        ContentPlanBatch.id == ContentPlanPreparation.batch_id,
                    )
                    .where(ContentPlanPreparation.id == preparation_id)
                )
            ).one_or_none()
            if row is None:
                return None
            return PreparationDispatchTarget(
                preparation_id=str(row.id),
                workflow_id=str(row.workflow_id),
                organization_id=str(row.organization_id),
                project_id=str(row.project_id),
            )

    async def list_recoverable_preparations(
        self, *, limit: int = 100
    ) -> list[PreparationDispatchTarget]:
        if limit < 1:
            raise ValueError("recovery limit must be positive")
        active_states = {
            "pending",
            "selected",
            "expanding",
            "expanded",
            "classifying",
            "coverage_check",
            "pack_ready",
            "serp_preview",
        }
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(
                        ContentPlanPreparation.id,
                        ContentPlanPreparation.workflow_id,
                        ContentPlanBatch.organization_id,
                        ContentPlanBatch.project_id,
                    )
                    .join(
                        ContentPlanBatch,
                        ContentPlanBatch.id == ContentPlanPreparation.batch_id,
                    )
                    .outerjoin(
                        ContentPlanItem,
                        ContentPlanItem.id == ContentPlanPreparation.plan_item_id,
                    )
                    .where(
                        ContentPlanBatch.source == "manual",
                        ContentPlanPreparation.state.not_in(
                            ("cancelled", "superseded", "preview_ready")
                        ),
                        (
                            ContentPlanPreparation.is_current.is_(True)
                            | (
                                ContentPlanItem.pending_preparation_id
                                == ContentPlanPreparation.id
                            )
                        ),
                        (
                            ContentPlanPreparation.state.in_(active_states)
                            | ContentPlanPreparation.error_code.in_(
                                RECOVERABLE_PREPARATION_ERROR_CODES
                            )
                        ),
                        ContentPlanBatch.status.not_in(("completed", "cancelled")),
                        (
                            ContentPlanItem.id.is_(None)
                            | (
                                (ContentPlanItem.status != "cancelled")
                                & (ContentPlanItem.edit_state == "repreparing")
                            )
                        ),
                    )
                    .order_by(ContentPlanPreparation.updated_at, ContentPlanPreparation.id)
                    .limit(limit)
                )
            ).all()
            return [
                PreparationDispatchTarget(
                    preparation_id=str(row.id),
                    workflow_id=str(row.workflow_id),
                    organization_id=str(row.organization_id),
                    project_id=str(row.project_id),
                )
                for row in rows
            ]

    async def create_candidate_snapshot(
        self,
        batch_id: str,
        *,
        coverage_by_keyword: dict[str, str],
    ) -> list[ContentPlanCandidate]:
        async with self.sessions() as session:
            batch = await session.scalar(
                select(ContentPlanBatch)
                .where(ContentPlanBatch.id == batch_id)
                .with_for_update()
            )
            if batch is None:
                raise ValueError("content plan batch does not exist")
            if batch.candidate_snapshot_status == "completed":
                return list(
                    (
                        await session.scalars(
                            select(ContentPlanCandidate)
                            .where(ContentPlanCandidate.batch_id == batch_id)
                            .order_by(ContentPlanCandidate.source_rank)
                        )
                    ).all()
                )

            occupied = await self._occupied_normalized_keywords(session, batch.project_id)
            keyword_rows = list(
                (
                    await session.scalars(
                        select(Keyword)
                        .where(
                            Keyword.organization_id == batch.organization_id,
                            Keyword.project_id == batch.project_id,
                            Keyword.country == batch.country,
                            Keyword.language == batch.language,
                            Keyword.status == "active",
                            Keyword.review_status == "approved",
                            Keyword.priority_score.is_not(None),
                        )
                        .order_by(
                            Keyword.priority_score.desc(),
                            Keyword.normalized_keyword,
                            Keyword.id,
                        )
                    )
                ).all()
            )
            eligible = [
                row
                for row in keyword_rows
                if row.normalized_keyword not in occupied
                and coverage_by_keyword.get(row.normalized_keyword, "unknown") != "covered"
            ]
            rows = [
                ContentPlanCandidate(
                    id=f"candidate-{uuid4().hex}",
                    batch_id=batch_id,
                    keyword_id=row.id,
                    keyword=row.keyword,
                    normalized_keyword=row.normalized_keyword,
                    source_rank=index,
                    priority_score_snapshot=float(row.priority_score),
                    coverage_status_snapshot=coverage_by_keyword.get(
                        row.normalized_keyword, "unknown"
                    ),
                )
                for index, row in enumerate(eligible, start=1)
            ]
            session.add_all(rows)
            await session.flush()
            batch.candidate_snapshot_count = len(rows)
            batch.candidate_snapshot_status = "completed"
            batch.status = "selecting_seeds"
            batch.stage = "candidate_snapshot_completed"
            await session.commit()
            return rows

    async def list_candidate_source_keywords(self, batch_id: str) -> list[Keyword]:
        async with self.sessions() as session:
            batch = await session.get(ContentPlanBatch, batch_id)
            if batch is None:
                raise ValueError("content plan batch does not exist")
            occupied = await self._occupied_normalized_keywords(session, batch.project_id)
            rows = list(
                (
                    await session.scalars(
                        select(Keyword)
                        .where(
                            Keyword.organization_id == batch.organization_id,
                            Keyword.project_id == batch.project_id,
                            Keyword.country == batch.country,
                            Keyword.language == batch.language,
                            Keyword.status == "active",
                            Keyword.review_status == "approved",
                            Keyword.priority_score.is_not(None),
                        )
                        .order_by(
                            Keyword.priority_score.desc(),
                            Keyword.normalized_keyword,
                            Keyword.id,
                        )
                    )
                ).all()
            )
            return [row for row in rows if row.normalized_keyword not in occupied]

    async def get_candidate_window(
        self,
        batch_id: str,
        *,
        after_source_rank: int,
        limit: int = 50,
    ) -> CandidateWindow:
        if limit < 1 or limit > 50:
            raise ValueError("candidate window size must be between 1 and 50")
        async with self.sessions() as session:
            candidates = list(
                (
                    await session.scalars(
                        select(ContentPlanCandidate)
                        .where(
                            ContentPlanCandidate.batch_id == batch_id,
                            ContentPlanCandidate.source_rank > after_source_rank,
                        )
                        .order_by(ContentPlanCandidate.source_rank)
                        .limit(limit)
                    )
                ).all()
            )
            last_source_rank = (
                candidates[-1].source_rank if candidates else after_source_rank
            )
            remaining = await session.scalar(
                select(ContentPlanCandidate.id)
                .where(
                    ContentPlanCandidate.batch_id == batch_id,
                    ContentPlanCandidate.source_rank > last_source_rank,
                )
                .limit(1)
            )
            return CandidateWindow(candidates, last_source_rank, remaining is None)

    async def get_retained_candidates(
        self, batch_id: str
    ) -> list[ContentPlanCandidate]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(ContentPlanCandidate)
                        .where(
                            ContentPlanCandidate.batch_id == batch_id,
                            ContentPlanCandidate.decision == "kept",
                        )
                        .order_by(ContentPlanCandidate.source_rank)
                    )
                ).all()
            )

    async def drop_unavailable_candidates(
        self, batch_id: str, reasons_by_candidate_id: dict[str, str]
    ) -> None:
        if not reasons_by_candidate_id:
            return
        async with self.sessions() as session:
            rows = list(
                (
                    await session.scalars(
                        select(ContentPlanCandidate)
                        .where(
                            ContentPlanCandidate.batch_id == batch_id,
                            ContentPlanCandidate.id.in_(reasons_by_candidate_id),
                            ContentPlanCandidate.selected_plan_order.is_(None),
                        )
                        .with_for_update()
                    )
                ).all()
            )
            for row in rows:
                row.decision = "dropped"
                row.decision_reason = reasons_by_candidate_id[row.id]
                row.representative_candidate_id = None
            await session.flush()
            batch = await session.get(ContentPlanBatch, batch_id)
            if batch is not None:
                batch.selected_count = await self._count_retained(session, batch_id)
            await session.commit()

    async def save_candidate_window_decisions(
        self,
        batch_id: str,
        *,
        window_number: int,
        last_source_rank: int,
        values: list[dict[str, Any]],
        ai_decision_version: str,
    ) -> list[ContentPlanCandidate]:
        candidate_ids = [str(value["candidate_id"]) for value in values]
        if len(set(candidate_ids)) != len(candidate_ids):
            raise ValueError("candidate decisions must have unique IDs")
        async with self.sessions() as session:
            batch = await session.scalar(
                select(ContentPlanBatch)
                .where(ContentPlanBatch.id == batch_id)
                .with_for_update()
            )
            if batch is None:
                raise ValueError("content plan batch does not exist")
            rows = list(
                (
                    await session.scalars(
                        select(ContentPlanCandidate)
                        .where(
                            ContentPlanCandidate.batch_id == batch_id,
                            ContentPlanCandidate.id.in_(candidate_ids),
                        )
                        .with_for_update()
                    )
                ).all()
            )
            if {row.id for row in rows} != set(candidate_ids):
                raise ValueError("candidate decision does not belong to batch")
            values_by_id = {str(value["candidate_id"]): value for value in values}
            for row in rows:
                value = values_by_id[row.id]
                row.candidate_window = window_number
                row.decision = str(value["decision"])
                row.decision_reason = value.get("decision_reason")
                row.representative_candidate_id = value.get(
                    "representative_candidate_id"
                )
                row.ai_decision_version = ai_decision_version
            batch.candidate_window_number = window_number
            batch.candidate_cursor_source_rank = last_source_rank
            await session.flush()
            batch.selected_count = await self._count_retained(session, batch_id)
            batch.decision_summary_json = {
                **batch.decision_summary_json,
                "candidate_cursor_source_rank": last_source_rank,
                "retained_seed_count": batch.selected_count,
            }
            await session.commit()
            return sorted(rows, key=lambda row: row.source_rank)

    async def assign_initial_seed_orders(self, batch_id: str, target_count: int) -> None:
        async with self.sessions() as session:
            rows = list(
                (
                    await session.scalars(
                        select(ContentPlanCandidate)
                        .where(
                            ContentPlanCandidate.batch_id == batch_id,
                            ContentPlanCandidate.decision == "kept",
                            ContentPlanCandidate.selected_plan_order.is_(None),
                        )
                        .order_by(ContentPlanCandidate.source_rank)
                        .limit(target_count)
                        .with_for_update()
                    )
                ).all()
            )
            if len(rows) != target_count:
                raise ValueError("candidate_pool_exhausted")
            for index, row in enumerate(rows, start=1):
                row.selected_plan_order = index
            await session.commit()

    async def replace_seed_for_plan_order(
        self,
        batch_id: str,
        *,
        plan_order: int,
        replacement_candidate_id: str,
    ) -> None:
        async with self.sessions() as session:
            old = await session.scalar(
                select(ContentPlanCandidate)
                .where(
                    ContentPlanCandidate.batch_id == batch_id,
                    ContentPlanCandidate.selected_plan_order == plan_order,
                )
                .with_for_update()
            )
            replacement = await session.scalar(
                select(ContentPlanCandidate)
                .where(
                    ContentPlanCandidate.batch_id == batch_id,
                    ContentPlanCandidate.id == replacement_candidate_id,
                    ContentPlanCandidate.decision == "kept",
                )
                .with_for_update()
            )
            if old is None or replacement is None:
                raise ValueError("replacement candidate is unavailable")
            old.selected_plan_order = None
            await session.flush()
            replacement.selected_plan_order = plan_order
            await session.commit()

    async def get_selected_candidates(
        self, batch_id: str
    ) -> list[ContentPlanCandidate]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(ContentPlanCandidate)
                        .where(
                            ContentPlanCandidate.batch_id == batch_id,
                            ContentPlanCandidate.selected_plan_order.is_not(None),
                        )
                        .order_by(ContentPlanCandidate.selected_plan_order)
                    )
                ).all()
            )

    async def finalize_current_preparation_orders(self, batch_id: str) -> None:
        async with self.sessions() as session:
            rows = list(
                (
                    await session.execute(
                        select(ContentPlanPreparation, ContentPlanCandidate)
                        .join(
                            ContentPlanCandidate,
                            ContentPlanCandidate.id == ContentPlanPreparation.candidate_id,
                        )
                        .where(
                            ContentPlanPreparation.batch_id == batch_id,
                            ContentPlanPreparation.is_current.is_(True),
                        )
                        .order_by(
                            ContentPlanCandidate.source_rank,
                            ContentPlanPreparation.id,
                        )
                        .with_for_update()
                    )
                ).all()
            )
            if len(rows) != 30:
                raise ValueError("automatic batch must have 30 current preparations")
            await session.execute(
                update(ContentPlanCandidate)
                .where(ContentPlanCandidate.batch_id == batch_id)
                .values(selected_plan_order=None)
            )
            await session.execute(
                update(ContentPlanPreparation)
                .where(
                    ContentPlanPreparation.batch_id == batch_id,
                    ContentPlanPreparation.is_current.is_(True),
                )
                .values(plan_order=ContentPlanPreparation.plan_order + 100)
            )
            await session.flush()
            for plan_order, (preparation, candidate) in enumerate(rows, start=1):
                await session.execute(
                    update(ContentPlanPreparation)
                    .where(ContentPlanPreparation.id == preparation.id)
                    .values(plan_order=plan_order)
                )
                candidate.selected_plan_order = plan_order
            await session.commit()

    async def occupied_normalized_keywords(
        self, project_id: str, *, exclude_item_id: str | None = None
    ) -> set[str]:
        async with self.sessions() as session:
            return await self._occupied_normalized_keywords(
                session, project_id, exclude_item_id=exclude_item_id
            )

    async def save_candidates(
        self, batch_id: str, values: list[dict[str, Any]]
    ) -> list[ContentPlanCandidate]:
        source_ranks = sorted(int(value["source_rank"]) for value in values)
        if source_ranks != list(range(1, len(values) + 1)):
            raise ValueError("candidate source_rank values must be contiguous from 1")
        rows = [ContentPlanCandidate(batch_id=batch_id, **value) for value in values]
        async with self.sessions() as session:
            batch = await session.scalar(
                select(ContentPlanBatch)
                .where(ContentPlanBatch.id == batch_id)
                .with_for_update()
            )
            if batch is None:
                raise ValueError("content plan batch does not exist")
            if batch.candidate_snapshot_status != "pending":
                raise ValueError("candidate snapshot is already completed")
            session.add_all(rows)
            await session.flush()
            batch.candidate_snapshot_count = len(rows)
            batch.candidate_snapshot_status = "completed"
            await session.commit()
            return sorted(rows, key=lambda row: row.source_rank)

    async def create_preparation(
        self,
        *,
        preparation_id: str,
        batch_id: str,
        candidate_id: str | None,
        plan_order: int,
        seed_keyword: str,
        normalized_seed_keyword: str,
        source_round: str,
        workflow_id: str,
        plan_item_id: str | None = None,
        preparation_version: int = 1,
        seed_keyword_id: str | None = None,
        state: str = "pending",
    ) -> ContentPlanPreparation:
        row = ContentPlanPreparation(
            id=preparation_id,
            batch_id=batch_id,
            plan_item_id=plan_item_id,
            candidate_id=candidate_id,
            plan_order=plan_order,
            seed_keyword=seed_keyword,
            normalized_seed_keyword=normalized_seed_keyword,
            seed_keyword_id=seed_keyword_id,
            source_round=source_round,
            preparation_version=preparation_version,
            package_version=1,
            state=state,
            workflow_id=workflow_id,
        )
        async with self.sessions() as session:
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return row

    async def supersede_preparation(
        self, old_preparation_id: str, new_preparation_id: str
    ) -> None:
        async with self.sessions() as session:
            old = await session.get(ContentPlanPreparation, old_preparation_id)
            if old is None:
                raise ValueError("content plan preparation does not exist")
            old.is_current = False
            old.state = "superseded"
            old.superseded_by_id = new_preparation_id
            await session.commit()

    async def create_replacement_preparation(
        self,
        *,
        preparation_id: str,
        old_preparation_id: str,
        candidate_id: str | None,
        seed_keyword_id: str | None,
        seed_keyword: str,
        normalized_seed_keyword: str,
        source_round: str,
        workflow_id: str,
        state: str = "expanding",
    ) -> ContentPlanPreparation:
        async with self.sessions() as session:
            old = await session.scalar(
                select(ContentPlanPreparation)
                .where(ContentPlanPreparation.id == old_preparation_id)
                .with_for_update()
            )
            if old is None or not old.is_current:
                raise ValueError("current content plan preparation does not exist")
            old.is_current = False
            old.state = "superseded"
            row = ContentPlanPreparation(
                id=preparation_id,
                batch_id=old.batch_id,
                candidate_id=candidate_id,
                plan_order=old.plan_order,
                seed_keyword_id=seed_keyword_id,
                seed_keyword=seed_keyword,
                normalized_seed_keyword=normalized_seed_keyword,
                source_round=source_round,
                preparation_version=old.preparation_version + 1,
                package_version=1,
                state=state,
                workflow_id=workflow_id,
            )
            session.add(row)
            await session.flush()
            old.superseded_by_id = preparation_id
            await session.commit()
            await session.refresh(row)
            return row

    async def set_preparation_state(
        self,
        preparation_id: str,
        *,
        state: str,
        error_code: str | None = None,
        error_detail: str | None = None,
    ) -> None:
        async with self.sessions() as session:
            row = await session.get(ContentPlanPreparation, preparation_id)
            if row is None:
                raise ValueError("content plan preparation does not exist")
            row.state = state
            row.error_code = error_code
            row.error_detail = error_detail
            await session.commit()

    async def get_current_preparations(
        self, batch_id: str
    ) -> list[ContentPlanPreparation]:
        async with self.sessions() as session:
            return list(
                (
                    await session.scalars(
                        select(ContentPlanPreparation)
                        .where(
                            ContentPlanPreparation.batch_id == batch_id,
                            ContentPlanPreparation.is_current.is_(True),
                        )
                        .order_by(ContentPlanPreparation.plan_order)
                    )
                ).all()
            )

    async def save_expansion_result(
        self,
        preparation_id: str,
        values: list[dict[str, Any]],
        *,
        request_round: int,
    ) -> list[ContentPlanPreparationKeyword]:
        async with self.sessions() as session:
            preparation = await session.scalar(
                select(ContentPlanPreparation)
                .where(ContentPlanPreparation.id == preparation_id)
                .with_for_update()
            )
            if preparation is None:
                raise ValueError("content plan preparation does not exist")
            existing = list(
                (
                    await session.scalars(
                        select(ContentPlanPreparationKeyword).where(
                            ContentPlanPreparationKeyword.preparation_id
                            == preparation_id
                        )
                    )
                ).all()
            )
            if existing and preparation.state in {
                "expanded",
                "classifying",
                "coverage_check",
                "pack_ready",
            }:
                return existing
            if not values:
                preparation.state = "invalid"
                preparation.error_code = "related_keywords_empty"
                preparation.error_detail = "Related Keywords returned no usable rows"
                preparation.last_completed_stage = "expansion"
                await session.commit()
                return []
            rows = [
                ContentPlanPreparationKeyword(
                    preparation_id=preparation_id,
                    request_round=request_round,
                    relevance="unrelated",
                    keyword_type="unknown",
                    primary_fit="ineligible",
                    reason_code="uncertain_relevance",
                    coverage_status="unknown",
                    selected_role="excluded",
                    **value,
                )
                for value in values
            ]
            session.add_all(rows)
            preparation.state = "expanded"
            preparation.error_code = None
            preparation.error_detail = None
            preparation.last_completed_stage = "expansion"
            await session.commit()
            return rows

    async def save_keyword_package(
        self,
        preparation_id: str,
        *,
        keyword_values: list[dict[str, Any]],
        relation_values: list[dict[str, Any]],
        selected_primary_keyword_id: str | None,
        state: str,
        error_code: str | None = None,
        error_detail: str | None = None,
    ) -> None:
        async with self.sessions() as session:
            preparation = await session.scalar(
                select(ContentPlanPreparation)
                .where(ContentPlanPreparation.id == preparation_id)
                .with_for_update()
            )
            if preparation is None:
                raise ValueError("content plan preparation does not exist")
            rows = list(
                (
                    await session.scalars(
                        select(ContentPlanPreparationKeyword)
                        .where(
                            ContentPlanPreparationKeyword.preparation_id
                            == preparation_id
                        )
                        .with_for_update()
                    )
                ).all()
            )
            values_by_id = {str(value["id"]): value for value in keyword_values}
            if set(values_by_id) != {row.id for row in rows}:
                raise ValueError("keyword package must classify every persisted candidate")
            await session.execute(
                delete(ContentPlanPreparationRelation).where(
                    ContentPlanPreparationRelation.preparation_id == preparation_id
                )
            )
            for row in rows:
                value = values_by_id[row.id]
                for field_name in (
                    "relevance",
                    "keyword_type",
                    "primary_fit",
                    "reason_code",
                    "classifier_version",
                    "coverage_status",
                    "coverage_relation_id",
                    "covered_url",
                    "coverage_checked_at",
                    "selected_role",
                    "exclusion_reason",
                    "package_position",
                ):
                    setattr(row, field_name, value.get(field_name))
            session.add_all(
                [
                    ContentPlanPreparationRelation(
                        preparation_id=preparation_id, **value
                    )
                    for value in relation_values
                ]
            )
            preparation.selected_primary_candidate_id = selected_primary_keyword_id
            preparation.state = state
            preparation.error_code = error_code
            preparation.error_detail = error_detail
            preparation.last_completed_stage = (
                "keyword_package" if state == "pack_ready" else "classification"
            )
            await session.commit()

    async def update_batch_progress(
        self,
        batch_id: str,
        *,
        status: str,
        stage: str,
        supplement_round: int | None = None,
        error_code: str | None = None,
        error_detail: str | None = None,
    ) -> ContentPlanBatch:
        async with self.sessions() as session:
            batch = await session.scalar(
                select(ContentPlanBatch)
                .where(ContentPlanBatch.id == batch_id)
                .with_for_update()
            )
            if batch is None:
                raise ValueError("content plan batch does not exist")
            batch.status = status
            batch.stage = stage
            batch.error_code = error_code
            batch.error_detail = error_detail
            if supplement_round is not None:
                batch.supplement_round = supplement_round
            batch.valid_pack_count = int(
                await session.scalar(
                    select(func.count(ContentPlanPreparation.id)).where(
                        ContentPlanPreparation.batch_id == batch_id,
                        ContentPlanPreparation.is_current.is_(True),
                        ContentPlanPreparation.state == "pack_ready",
                    )
                )
                or 0
            )
            await session.commit()
            await session.refresh(batch)
            return batch

    async def save_preparation_keywords(
        self, preparation_id: str, values: list[dict[str, Any]]
    ) -> list[ContentPlanPreparationKeyword]:
        rows = [
            ContentPlanPreparationKeyword(preparation_id=preparation_id, **value)
            for value in values
        ]
        async with self.sessions() as session:
            session.add_all(rows)
            await session.commit()
            return sorted(rows, key=lambda row: row.package_position or 2**31)

    async def add_preparation_relation(
        self,
        *,
        relation_id: str,
        preparation_id: str,
        primary_candidate_id: str,
        secondary_candidate_id: str,
        classifier_version: str,
    ) -> ContentPlanPreparationRelation:
        row = ContentPlanPreparationRelation(
            id=relation_id,
            preparation_id=preparation_id,
            primary_candidate_id=primary_candidate_id,
            secondary_candidate_id=secondary_candidate_id,
            classifier_version=classifier_version,
        )
        async with self.sessions() as session:
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return row

    async def add_serp_snapshot(
        self,
        *,
        snapshot_id: str,
        preparation_id: str,
        primary_keyword: str,
        country: str,
        language: str,
        provider: str,
        request_key: str,
        cache_hit: bool,
        cost_usd: float,
        provisional_title: str | None,
        provisional_direction: str | None,
        organic_summary: list[dict[str, Any]] | None = None,
        paa: list[dict[str, Any]] | None = None,
        related_searches: list[dict[str, Any]] | None = None,
        serp_features: list[str] | None = None,
        featured_snippet: dict[str, Any] | None = None,
        provider_request_id: str | None = None,
        error_code: str | None = None,
        error_detail: str | None = None,
    ) -> ContentPlanSerpSnapshot:
        async with self.sessions() as session:
            current = await session.scalar(
                select(ContentPlanSerpSnapshot)
                .where(
                    ContentPlanSerpSnapshot.preparation_id == preparation_id,
                    ContentPlanSerpSnapshot.is_current.is_(True),
                )
                .with_for_update()
            )
            snapshot_version = 1
            if current is not None:
                current.is_current = False
                snapshot_version = current.snapshot_version + 1
            row = ContentPlanSerpSnapshot(
                id=snapshot_id,
                preparation_id=preparation_id,
                snapshot_version=snapshot_version,
                primary_keyword=primary_keyword,
                country=country,
                language=language,
                provider=provider,
                provider_request_id=provider_request_id,
                request_key=request_key,
                cache_hit=cache_hit,
                cost_usd=cost_usd,
                organic_summary_json=organic_summary or [],
                paa_json=paa or [],
                related_searches_json=related_searches or [],
                serp_features_json=serp_features or [],
                featured_snippet_json=featured_snippet,
                provisional_title=provisional_title,
                provisional_direction=provisional_direction,
                generated_by="system",
                is_current=True,
                error_code=error_code,
                error_detail=error_detail,
            )
            session.add(row)
            preparation = await session.get(ContentPlanPreparation, preparation_id)
            if preparation is not None:
                preparation.current_serp_snapshot_id = snapshot_id
                preparation.state = "preview_failed" if error_code else "preview_ready"
                preparation.error_code = error_code
                preparation.error_detail = error_detail
                preparation.last_completed_stage = (
                    "serp_preview" if error_code else "preview"
                )
            await session.commit()
            await session.refresh(row)
            return row

    async def create_automatic_plan_items(
        self, batch_id: str
    ) -> list[ContentPlanItem]:
        normalized_seeds: list[str] = []
        project_id: str | None = None
        try:
            async with self.sessions() as session:
                batch = await session.scalar(
                    select(ContentPlanBatch)
                    .where(ContentPlanBatch.id == batch_id)
                    .with_for_update()
                )
                if batch is None:
                    raise ValueError("content plan batch does not exist")
                if batch.source != "automatic" or batch.target_count != 30:
                    raise ValueError("automatic item creation requires a 30-item batch")
                project_id = batch.project_id
                existing = list(
                    (
                        await session.scalars(
                            select(ContentPlanItem)
                            .where(ContentPlanItem.batch_id == batch_id)
                            .order_by(ContentPlanItem.plan_order)
                        )
                    ).all()
                )
                if existing:
                    if len(existing) != 30 or [row.plan_order for row in existing] != list(
                        range(1, 31)
                    ):
                        raise ValueError("batch has an incomplete formal plan item set")
                    batch.status = "scheduling"
                    batch.stage = "d4_items_created"
                    batch.error_code = None
                    batch.error_detail = None
                    await session.commit()
                    return existing

                batch.status = "creating_items"
                batch.stage = "d4_creating_items"
                preparations = list(
                    (
                        await session.scalars(
                            select(ContentPlanPreparation)
                            .where(
                                ContentPlanPreparation.batch_id == batch_id,
                                ContentPlanPreparation.is_current.is_(True),
                            )
                            .order_by(ContentPlanPreparation.plan_order)
                            .with_for_update()
                        )
                    ).all()
                )
                if len(preparations) != 30:
                    raise ValueError("automatic batch must have exactly 30 current preparations")
                if [row.plan_order for row in preparations] != list(range(1, 31)):
                    raise ValueError("preparation plan_order must be contiguous from 1 to 30")
                if any(row.state != "preview_ready" for row in preparations):
                    raise ValueError("all preparations must be preview_ready")
                if any(row.current_serp_snapshot_id is None for row in preparations):
                    raise ValueError("every preparation requires a current SERP snapshot")

                preparation_ids = [row.id for row in preparations]
                keyword_rows = list(
                    (
                        await session.scalars(
                            select(ContentPlanPreparationKeyword)
                            .where(
                                ContentPlanPreparationKeyword.preparation_id.in_(
                                    preparation_ids
                                ),
                                ContentPlanPreparationKeyword.selected_role.in_(
                                    ("primary", "secondary")
                                ),
                            )
                            .order_by(
                                ContentPlanPreparationKeyword.preparation_id,
                                ContentPlanPreparationKeyword.package_position,
                            )
                        )
                    ).all()
                )
                keywords_by_preparation: dict[
                    str, list[ContentPlanPreparationKeyword]
                ] = {row.id: [] for row in preparations}
                for keyword in keyword_rows:
                    keywords_by_preparation[keyword.preparation_id].append(keyword)
                snapshot_rows = list(
                    (
                        await session.scalars(
                            select(ContentPlanSerpSnapshot).where(
                                ContentPlanSerpSnapshot.id.in_(
                                    [str(row.current_serp_snapshot_id) for row in preparations]
                                )
                            )
                        )
                    ).all()
                )
                snapshots = {row.id: row for row in snapshot_rows}
                candidates = {
                    row.id: row
                    for row in (
                        await session.scalars(
                            select(ContentPlanCandidate).where(
                                ContentPlanCandidate.id.in_(
                                    [
                                        row.candidate_id
                                        for row in preparations
                                        if row.candidate_id is not None
                                    ]
                                )
                            )
                        )
                    ).all()
                }
                normalized_seeds = [row.normalized_seed_keyword for row in preparations]
                conflicts = list(
                    (
                        await session.scalars(
                            select(ContentPlanItem)
                            .where(
                                ContentPlanItem.project_id == batch.project_id,
                                ContentPlanItem.normalized_seed_keyword.in_(
                                    normalized_seeds
                                ),
                                ContentPlanItem.status != "cancelled",
                            )
                            .order_by(ContentPlanItem.created_at, ContentPlanItem.id)
                            .limit(1)
                        )
                    ).all()
                )
                if conflicts:
                    raise PlanItemConflictError(conflicts[0].id)

                items: list[ContentPlanItem] = []
                for preparation in preparations:
                    package = keywords_by_preparation[preparation.id]
                    primary = [row for row in package if row.selected_role == "primary"]
                    secondaries = [
                        row for row in package if row.selected_role == "secondary"
                    ]
                    if len(primary) != 1 or len(secondaries) > 5:
                        raise ValueError(
                            "automatic keyword package must contain one primary and up to five secondaries"
                        )
                    if [row.package_position for row in package] != list(
                        range(1, len(package) + 1)
                    ):
                        raise ValueError("keyword package positions must be contiguous")
                    snapshot = snapshots.get(str(preparation.current_serp_snapshot_id))
                    if (
                        snapshot is None
                        or snapshot.preparation_id != preparation.id
                        or not snapshot.is_current
                    ):
                        raise ValueError("every preparation requires its current SERP snapshot")
                    if (
                        not snapshot.provisional_title
                        or not snapshot.provisional_direction
                        or snapshot.error_code is not None
                        or snapshot.primary_keyword != primary[0].raw_keyword
                    ):
                        raise ValueError("current SERP snapshot is not preview_ready")
                    candidate = candidates.get(preparation.candidate_id or "")
                    item_id = f"plan-item-{uuid4().hex}"
                    item = ContentPlanItem(
                        id=item_id,
                        batch_id=batch.id,
                        project_id=batch.project_id,
                        source="automatic",
                        seed_keyword_id=preparation.seed_keyword_id,
                        seed_keyword=preparation.seed_keyword,
                        normalized_seed_keyword=preparation.normalized_seed_keyword,
                        source_priority_score=(
                            candidate.priority_score_snapshot if candidate else None
                        ),
                        source_rank=candidate.source_rank if candidate else None,
                        plan_order=preparation.plan_order,
                        primary_keyword=primary[0].raw_keyword,
                        title=snapshot.provisional_title,
                        writing_direction=snapshot.provisional_direction,
                        current_preparation_id=preparation.id,
                        current_serp_snapshot_id=snapshot.id,
                        preparation_version=preparation.preparation_version,
                    )
                    item_keywords = [
                        ContentPlanItemKeyword(
                            id=f"plan-item-keyword-{uuid4().hex}",
                            plan_item_id=item_id,
                            preparation_keyword_id=row.id,
                            keyword_id=None,
                            keyword=row.raw_keyword,
                            normalized_keyword=row.normalized_keyword,
                            role=str(row.selected_role),
                            keyword_type=row.keyword_type,
                            source=row.source,
                            search_volume=row.search_volume,
                            keyword_difficulty=row.keyword_difficulty,
                            position=int(row.package_position),
                        )
                        for row in package
                    ]
                    session.add(item)
                    session.add_all(item_keywords)
                    preparation.plan_item_id = item_id
                    items.append(item)
                batch.status = "scheduling"
                batch.stage = "d4_items_created"
                batch.error_code = None
                batch.error_detail = None
                await session.commit()
                return items
        except IntegrityError as exc:
            if project_id is not None and normalized_seeds:
                async with self.sessions() as session:
                    conflict = await session.scalar(
                        select(ContentPlanItem)
                        .where(
                            ContentPlanItem.project_id == project_id,
                            ContentPlanItem.normalized_seed_keyword.in_(normalized_seeds),
                            ContentPlanItem.status != "cancelled",
                        )
                        .order_by(ContentPlanItem.created_at, ContentPlanItem.id)
                        .limit(1)
                    )
                if conflict is not None:
                    raise PlanItemConflictError(conflict.id) from exc
            raise

    async def create_manual_plan_item(
        self, preparation_id: str
    ) -> ContentPlanItem:
        async with self.sessions() as session:
            preparation = await session.scalar(
                select(ContentPlanPreparation)
                .where(ContentPlanPreparation.id == preparation_id)
                .with_for_update()
            )
            if preparation is None:
                raise ValueError("content_plan_preparation_not_found")
            batch = await session.scalar(
                select(ContentPlanBatch)
                .where(ContentPlanBatch.id == preparation.batch_id)
                .with_for_update()
            )
            if batch is None or batch.source != "manual":
                raise ValueError("manual_batch_required")
            existing = await session.scalar(
                select(ContentPlanItem).where(
                    ContentPlanItem.current_preparation_id == preparation.id
                )
            )
            if existing is not None:
                return existing
            await session.scalar(
                select(Project)
                .where(Project.id == batch.project_id)
                .with_for_update()
            )
            package = list(
                (
                    await session.scalars(
                        select(ContentPlanPreparationKeyword)
                        .where(
                            ContentPlanPreparationKeyword.preparation_id
                            == preparation.id,
                            ContentPlanPreparationKeyword.selected_role.in_(
                                ("primary", "secondary")
                            ),
                        )
                        .order_by(ContentPlanPreparationKeyword.package_position)
                    )
                ).all()
            )
            primary = [row for row in package if row.selected_role == "primary"]
            secondaries = [row for row in package if row.selected_role == "secondary"]
            snapshot = (
                await session.get(
                    ContentPlanSerpSnapshot, preparation.current_serp_snapshot_id
                )
                if preparation.current_serp_snapshot_id
                else None
            )
            if (
                preparation.state != "preview_ready"
                or len(primary) != 1
                or len(secondaries) > 8
                or snapshot is None
                or not snapshot.is_current
                or snapshot.error_code is not None
                or not snapshot.provisional_title
                or not snapshot.provisional_direction
                or snapshot.primary_keyword != primary[0].raw_keyword
            ):
                raise ValueError("manual_preparation_incomplete")
            if [row.package_position for row in package] != list(
                range(1, len(package) + 1)
            ):
                raise ValueError("keyword_package_positions_invalid")

            conflict = await self._find_keyword_conflict_in_session(
                session,
                batch.project_id,
                {
                    preparation.normalized_seed_keyword,
                    primary[0].normalized_keyword,
                },
            )
            if conflict is not None:
                raise PlanItemConflictError(conflict)

            item_id = f"plan-item-{uuid4().hex}"
            item = ContentPlanItem(
                id=item_id,
                batch_id=batch.id,
                project_id=batch.project_id,
                source="manual",
                seed_keyword_id=preparation.seed_keyword_id,
                seed_keyword=preparation.seed_keyword,
                normalized_seed_keyword=preparation.normalized_seed_keyword,
                plan_order=1,
                primary_keyword=primary[0].raw_keyword,
                title=snapshot.provisional_title,
                writing_direction=snapshot.provisional_direction,
                current_preparation_id=preparation.id,
                current_serp_snapshot_id=snapshot.id,
                preparation_version=preparation.preparation_version,
            )
            session.add(item)
            session.add_all(
                [
                    ContentPlanItemKeyword(
                        id=f"plan-item-keyword-{uuid4().hex}",
                        plan_item_id=item_id,
                        preparation_keyword_id=row.id,
                        keyword=row.raw_keyword,
                        normalized_keyword=row.normalized_keyword,
                        role=str(row.selected_role),
                        keyword_type=row.keyword_type,
                        source=row.source,
                        search_volume=row.search_volume,
                        keyword_difficulty=row.keyword_difficulty,
                        position=int(row.package_position),
                    )
                    for row in package
                ]
            )
            preparation.plan_item_id = item_id
            batch.status = "scheduling"
            batch.stage = "d6_item_created"
            await session.commit()
            return item

    async def get_plan_item_bundle_scoped(
        self, organization_id: str, project_id: str, item_id: str
    ) -> PlanItemBundle | None:
        async with self.sessions() as session:
            item = await session.scalar(
                select(ContentPlanItem)
                .join(Project, Project.id == ContentPlanItem.project_id)
                .where(
                    ContentPlanItem.id == item_id,
                    ContentPlanItem.project_id == project_id,
                    Project.organization_id == organization_id,
                )
            )
            if item is None:
                return None
            keywords = list(
                (
                    await session.scalars(
                        select(ContentPlanItemKeyword)
                        .where(ContentPlanItemKeyword.plan_item_id == item_id)
                        .order_by(ContentPlanItemKeyword.position)
                    )
                ).all()
            )
            snapshot = await session.get(
                ContentPlanSerpSnapshot, item.current_serp_snapshot_id
            )
            pending = (
                await session.get(ContentPlanPreparation, item.pending_preparation_id)
                if item.pending_preparation_id is not None
                else None
            )
            article = (
                await session.get(Article, item.article_id)
                if item.article_id is not None
                else None
            )
            return PlanItemBundle(item, keywords, snapshot, pending, article)

    async def list_plan_item_bundles_scoped(
        self,
        organization_id: str,
        project_id: str,
        *,
        start_date: date | None = None,
        end_date: date | None = None,
        statuses: tuple[str, ...] = (),
    ) -> list[PlanItemBundle]:
        async with self.sessions() as session:
            filters = [
                ContentPlanItem.project_id == project_id,
                Project.organization_id == organization_id,
            ]
            if start_date is not None:
                filters.append(ContentPlanItem.publish_local_date >= start_date)
            if end_date is not None:
                filters.append(ContentPlanItem.publish_local_date <= end_date)
            if statuses:
                filters.append(ContentPlanItem.status.in_(statuses))
            items = list(
                (
                    await session.scalars(
                        select(ContentPlanItem)
                        .join(Project, Project.id == ContentPlanItem.project_id)
                        .where(*filters)
                        .order_by(
                            ContentPlanItem.publish_local_date.asc().nulls_last(),
                            ContentPlanItem.created_at,
                            ContentPlanItem.id,
                        )
                    )
                ).all()
            )
            if not items:
                return []

            item_ids = [item.id for item in items]
            keyword_rows = list(
                (
                    await session.scalars(
                        select(ContentPlanItemKeyword)
                        .where(ContentPlanItemKeyword.plan_item_id.in_(item_ids))
                        .order_by(
                            ContentPlanItemKeyword.plan_item_id,
                            ContentPlanItemKeyword.position,
                        )
                    )
                ).all()
            )
            keywords_by_item: dict[str, list[ContentPlanItemKeyword]] = {
                item_id: [] for item_id in item_ids
            }
            for row in keyword_rows:
                keywords_by_item[row.plan_item_id].append(row)

            snapshot_ids = {item.current_serp_snapshot_id for item in items}
            snapshots = {
                row.id: row
                for row in (
                    await session.scalars(
                        select(ContentPlanSerpSnapshot).where(
                            ContentPlanSerpSnapshot.id.in_(snapshot_ids)
                        )
                    )
                ).all()
            }
            pending_ids = {
                item.pending_preparation_id
                for item in items
                if item.pending_preparation_id is not None
            }
            pending = (
                {
                    row.id: row
                    for row in (
                        await session.scalars(
                            select(ContentPlanPreparation).where(
                                ContentPlanPreparation.id.in_(pending_ids)
                            )
                        )
                    ).all()
                }
                if pending_ids
                else {}
            )
            article_ids = {
                item.article_id for item in items if item.article_id is not None
            }
            articles = (
                {
                    row.id: row
                    for row in (
                        await session.scalars(
                            select(Article).where(Article.id.in_(article_ids))
                        )
                    ).all()
                }
                if article_ids
                else {}
            )
            return [
                PlanItemBundle(
                    item=item,
                    keywords=keywords_by_item[item.id],
                    serp_snapshot=snapshots.get(item.current_serp_snapshot_id),
                    pending_preparation=pending.get(item.pending_preparation_id),
                    article=articles.get(item.article_id),
                )
                for item in items
            ]

    async def prepare_batch_retry_scoped(
        self, organization_id: str, project_id: str, batch_id: str
    ) -> BatchRetryTarget | None:
        async with self.sessions() as session:
            batch = await session.scalar(
                select(ContentPlanBatch)
                .where(
                    ContentPlanBatch.id == batch_id,
                    ContentPlanBatch.organization_id == organization_id,
                    ContentPlanBatch.project_id == project_id,
                )
                .with_for_update()
            )
            if batch is None:
                return None
            if (
                batch.status != "needs_attention"
                or batch.error_code not in MANUAL_RETRYABLE_BATCH_ERROR_CODES
            ):
                raise ValueError("content_plan_batch_not_retryable")
            batch.status = "queued"
            batch.error_code = None
            batch.error_detail = None
            batch.finished_at = None
            preparation_id = None
            if batch.source == "manual":
                preparation = await session.scalar(
                    select(ContentPlanPreparation)
                    .where(
                        ContentPlanPreparation.batch_id == batch.id,
                        ContentPlanPreparation.source_round == "manual",
                        ContentPlanPreparation.is_current.is_(True),
                        ContentPlanPreparation.plan_item_id.is_(None),
                    )
                    .with_for_update()
                )
                if preparation is None:
                    raise ValueError("manual_preparation_missing")
                preparation.error_code = None
                preparation.error_detail = None
                preparation_id = preparation.id
            await session.commit()
            await session.refresh(batch)
            return BatchRetryTarget(batch=batch, preparation_id=preparation_id)

    async def get_plan_item_scope(self, item_id: str) -> tuple[str, str] | None:
        async with self.sessions() as session:
            row = (
                await session.execute(
                    select(Project.organization_id, ContentPlanItem.project_id)
                    .join(ContentPlanItem, ContentPlanItem.project_id == Project.id)
                    .where(ContentPlanItem.id == item_id)
                )
            ).one_or_none()
            return (str(row[0]), str(row[1])) if row is not None else None

    async def update_plan_item_fields(
        self,
        organization_id: str,
        project_id: str,
        item_id: str,
        *,
        expected_version: int,
        title: str | None,
        writing_direction: str | None,
        secondary_keywords: list[str] | None,
        publish_local_date: date | None,
        now: datetime,
        secondary_keyword_types: dict[str, str] | None = None,
    ) -> tuple[PlanItemBundle, bool]:
        async with self.sessions() as session:
            item = await self._locked_scoped_item(
                session, organization_id, project_id, item_id
            )
            self._validate_item_editable(item, expected_version)
            settings = await session.get(ContentPlanSettings, project_id)
            if settings is None:
                raise ValueError("timezone_required")
            if secondary_keywords is not None and len(secondary_keywords) > 8:
                raise ValueError("secondary_keyword_limit_exceeded")

            current_keywords = list(
                (
                    await session.scalars(
                        select(ContentPlanItemKeyword)
                        .where(ContentPlanItemKeyword.plan_item_id == item.id)
                        .order_by(ContentPlanItemKeyword.position)
                        .with_for_update()
                    )
                ).all()
            )
            primary = next(
                (row for row in current_keywords if row.role == "primary"), None
            )
            if primary is None:
                raise ValueError("plan_input_incomplete")
            if secondary_keywords is not None:
                normalized = [normalize_keyword(value) for value in secondary_keywords]
                if (
                    len(normalized) != len(set(normalized))
                    or primary.normalized_keyword in normalized
                ):
                    raise ValueError("secondary_keyword_duplicate")
                existing = {
                    row.normalized_keyword: row
                    for row in current_keywords
                    if row.role == "secondary"
                }
                await session.execute(
                    delete(ContentPlanItemKeyword).where(
                        ContentPlanItemKeyword.plan_item_id == item.id,
                        ContentPlanItemKeyword.role == "secondary",
                    )
                )
                session.add_all(
                    [
                        ContentPlanItemKeyword(
                            id=f"plan-item-keyword-{uuid4().hex}",
                            plan_item_id=item.id,
                            preparation_keyword_id=(
                                existing[value].preparation_keyword_id
                                if value in existing
                                else None
                            ),
                            keyword=keyword,
                            normalized_keyword=value,
                            role="secondary",
                            keyword_type=(
                                existing[value].keyword_type
                                if value in existing
                                else (secondary_keyword_types or {}).get(value, "unknown")
                            ),
                            source=(
                                existing[value].source if value in existing else "user"
                            ),
                            search_volume=(
                                existing[value].search_volume
                                if value in existing
                                else None
                            ),
                            keyword_difficulty=(
                                existing[value].keyword_difficulty
                                if value in existing
                                else None
                            ),
                            position=index,
                        )
                        for index, (keyword, value) in enumerate(
                            zip(secondary_keywords, normalized, strict=True), start=2
                        )
                    ]
                )
            if title is not None:
                item.title = title
                item.title_user_edited = True
            if writing_direction is not None:
                item.writing_direction = writing_direction
                item.direction_user_edited = True
            trigger_now = False
            if publish_local_date is not None:
                conflict_id = await session.scalar(
                    select(ContentPlanItem.id).where(
                        ContentPlanItem.project_id == project_id,
                        ContentPlanItem.id != item.id,
                        ContentPlanItem.status != "cancelled",
                        ContentPlanItem.publish_local_date == publish_local_date,
                    )
                )
                if conflict_id is not None:
                    raise ValueError(f"schedule_date_conflict:{conflict_id}")
                slot = make_slot(
                    publish_local_date,
                    item.publish_local_time or settings.default_publish_local_time,
                    settings.timezone,
                )
                self._apply_slot(item, slot)
                item.date_user_pinned = True
                local_today = now.astimezone(ZoneInfo(settings.timezone)).date()
                trigger_now = publish_local_date <= local_today + timedelta(days=1)
            item.version += 1
            await session.commit()
            keywords = list(
                (
                    await session.scalars(
                        select(ContentPlanItemKeyword)
                        .where(ContentPlanItemKeyword.plan_item_id == item.id)
                        .order_by(ContentPlanItemKeyword.position)
                    )
                ).all()
            )
            return PlanItemBundle(item, keywords), trigger_now

    async def begin_plan_item_repreparation(
        self,
        organization_id: str,
        project_id: str,
        item_id: str,
        *,
        expected_version: int,
        preparation_id: str,
        seed_keyword: str | None,
        primary_keyword: str | None,
    ) -> ContentPlanPreparation:
        async with self.sessions() as session:
            item = await self._locked_scoped_item(
                session, organization_id, project_id, item_id
            )
            self._validate_item_editable(item, expected_version)
            pending = (
                await session.get(ContentPlanPreparation, item.pending_preparation_id)
                if item.pending_preparation_id is not None
                else None
            )
            current_keywords = list(
                (
                    await session.scalars(
                        select(ContentPlanItemKeyword)
                        .where(ContentPlanItemKeyword.plan_item_id == item.id)
                        .order_by(ContentPlanItemKeyword.position)
                    )
                ).all()
            )
            next_version = item.preparation_version + 1
            preparation = ContentPlanPreparation(
                id=preparation_id,
                batch_id=item.batch_id,
                plan_item_id=item.id,
                plan_order=item.plan_order or 1,
                seed_keyword=seed_keyword or item.seed_keyword,
                normalized_seed_keyword=normalize_keyword(
                    seed_keyword or item.seed_keyword
                ),
                source_round="edit",
                preparation_version=next_version,
                is_current=False,
                state="expanding" if seed_keyword is not None else "expanded",
                workflow_id=(
                    f"content-plan:{item.batch_id}:edit:{item.id}:{next_version}"
                ),
            )
            session.add(preparation)
            await session.flush()
            if pending is not None:
                pending.state = "superseded"
                pending.is_current = False
                pending.superseded_by_id = preparation_id
            if primary_keyword is not None:
                normalized_primary = normalize_keyword(primary_keyword)
                values = [(primary_keyword, normalized_primary, "user")]
                values.extend(
                    (row.keyword, row.normalized_keyword, row.source)
                    for row in current_keywords
                    if row.role == "secondary"
                    and row.normalized_keyword != normalized_primary
                )
                session.add_all(
                    [
                        ContentPlanPreparationKeyword(
                            id=f"preparation-keyword-{uuid4().hex}",
                            preparation_id=preparation.id,
                            candidate_id=f"edit-candidate-{uuid4().hex}",
                            source=source,
                            raw_keyword=keyword,
                            normalized_keyword=normalized,
                            provider_position=index,
                            request_round=0,
                            relevance="unrelated",
                            keyword_type="unknown",
                            primary_fit="ineligible",
                            coverage_status="unknown",
                            selected_role="excluded",
                        )
                        for index, (keyword, normalized, source) in enumerate(
                            values
                        )
                    ]
                )
            item.pending_preparation_id = preparation.id
            item.preparation_version = next_version
            item.edit_state = "repreparing"
            item.version += 1
            await session.commit()
            await session.refresh(preparation)
            return preparation

    async def complete_plan_item_repreparation(
        self, preparation_id: str
    ) -> ContentPlanItem:
        async with self.sessions() as session:
            preparation = await session.scalar(
                select(ContentPlanPreparation)
                .where(ContentPlanPreparation.id == preparation_id)
                .with_for_update()
            )
            if preparation is None or preparation.plan_item_id is None:
                raise ValueError("content_plan_preparation_not_found")
            item = await session.scalar(
                select(ContentPlanItem)
                .where(ContentPlanItem.id == preparation.plan_item_id)
                .with_for_update()
            )
            if (
                item is None
                or item.status == "cancelled"
                or item.pending_preparation_id != preparation.id
                or item.preparation_version != preparation.preparation_version
            ):
                preparation.state = "superseded"
                preparation.is_current = False
                await session.commit()
                raise ValueError("preparation_superseded")
            package = list(
                (
                    await session.scalars(
                        select(ContentPlanPreparationKeyword)
                        .where(
                            ContentPlanPreparationKeyword.preparation_id
                            == preparation.id,
                            ContentPlanPreparationKeyword.selected_role.in_(
                                ("primary", "secondary")
                            ),
                        )
                        .order_by(ContentPlanPreparationKeyword.package_position)
                    )
                ).all()
            )
            primary = [row for row in package if row.selected_role == "primary"]
            snapshot = (
                await session.get(
                    ContentPlanSerpSnapshot, preparation.current_serp_snapshot_id
                )
                if preparation.current_serp_snapshot_id
                else None
            )
            if (
                preparation.state != "preview_ready"
                or len(primary) != 1
                or len(package) > 9
                or snapshot is None
                or snapshot.error_code is not None
                or not snapshot.provisional_title
                or not snapshot.provisional_direction
            ):
                raise ValueError("repreparation_incomplete")
            conflict = await self._find_keyword_conflict_in_session(
                session,
                item.project_id,
                {
                    preparation.normalized_seed_keyword,
                    primary[0].normalized_keyword,
                },
                exclude_item_id=item.id,
            )
            if conflict is not None:
                raise PlanItemConflictError(conflict)

            old = await session.get(
                ContentPlanPreparation, item.current_preparation_id
            )
            if old is not None:
                old.is_current = False
                old.state = "superseded"
                old.superseded_by_id = preparation.id
                await session.flush()
            preparation.is_current = True
            item.seed_keyword = preparation.seed_keyword
            item.normalized_seed_keyword = preparation.normalized_seed_keyword
            item.primary_keyword = primary[0].raw_keyword
            item.current_preparation_id = preparation.id
            item.current_serp_snapshot_id = snapshot.id
            if not item.title_user_edited:
                item.title = snapshot.provisional_title
            if not item.direction_user_edited:
                item.writing_direction = snapshot.provisional_direction
            await session.execute(
                delete(ContentPlanItemKeyword).where(
                    ContentPlanItemKeyword.plan_item_id == item.id
                )
            )
            session.add_all(
                [
                    ContentPlanItemKeyword(
                        id=f"plan-item-keyword-{uuid4().hex}",
                        plan_item_id=item.id,
                        preparation_keyword_id=row.id,
                        keyword=row.raw_keyword,
                        normalized_keyword=row.normalized_keyword,
                        role=str(row.selected_role),
                        keyword_type=row.keyword_type,
                        source=row.source,
                        search_volume=row.search_volume,
                        keyword_difficulty=row.keyword_difficulty,
                        position=int(row.package_position),
                    )
                    for row in package
                ]
            )
            item.pending_preparation_id = None
            item.edit_state = "idle"
            item.error_code = None
            item.error_detail = None
            item.version += 1
            await session.commit()
            return item

    async def fail_plan_item_repreparation(
        self, preparation_id: str, *, error_code: str, error_detail: str
    ) -> ContentPlanItem | None:
        async with self.sessions() as session:
            preparation = await session.scalar(
                select(ContentPlanPreparation)
                .where(ContentPlanPreparation.id == preparation_id)
                .with_for_update()
            )
            if preparation is None or preparation.plan_item_id is None:
                return None
            item = await session.scalar(
                select(ContentPlanItem)
                .where(ContentPlanItem.id == preparation.plan_item_id)
                .with_for_update()
            )
            if (
                item is None
                or item.status == "cancelled"
                or item.pending_preparation_id != preparation.id
                or item.preparation_version != preparation.preparation_version
            ):
                preparation.state = "superseded"
                preparation.is_current = False
                await session.commit()
                raise ValueError("preparation_superseded")
            item.edit_state = "reprepare_failed"
            item.error_code = error_code
            item.error_detail = error_detail
            item.version += 1
            await session.commit()
            return item

    async def fail_manual_preparation(
        self, preparation_id: str, *, error_code: str, error_detail: str
    ) -> None:
        async with self.sessions() as session:
            preparation = await session.scalar(
                select(ContentPlanPreparation)
                .where(ContentPlanPreparation.id == preparation_id)
                .with_for_update()
            )
            if preparation is None or preparation.plan_item_id is not None:
                raise ValueError("content_plan_preparation_not_found")
            if preparation.state in {"cancelled", "superseded"}:
                return
            batch = await session.scalar(
                select(ContentPlanBatch)
                .where(ContentPlanBatch.id == preparation.batch_id)
                .with_for_update()
            )
            if batch is None or batch.source != "manual":
                raise ValueError("manual_batch_required")
            if preparation.state in {"pack_ready", "serp_preview", "preview_failed"}:
                preparation.state = "preview_failed"
            elif preparation.state in {"classifying", "classification_failed"}:
                preparation.state = "classification_failed"
            elif preparation.state in {"coverage_check", "coverage_check_failed"}:
                preparation.state = "coverage_check_failed"
            else:
                preparation.state = "expansion_failed"
            preparation.error_code = error_code
            preparation.error_detail = error_detail
            batch.status = "needs_attention"
            batch.stage = "manual_preparation_failed"
            batch.error_code = error_code
            batch.error_detail = error_detail
            batch.finished_at = datetime.now(UTC)
            await session.commit()

    async def cancel_plan_item(
        self,
        organization_id: str,
        project_id: str,
        item_id: str,
        *,
        expected_version: int,
    ) -> ContentPlanItem:
        async with self.sessions() as session:
            item = await self._locked_scoped_item(
                session, organization_id, project_id, item_id
            )
            self._validate_item_editable(item, expected_version)
            if item.pending_preparation_id is not None:
                pending = await session.get(
                    ContentPlanPreparation, item.pending_preparation_id
                )
                if pending is not None:
                    pending.state = "cancelled"
                    pending.is_current = False
            item.status = "cancelled"
            item.pending_preparation_id = None
            item.edit_state = "idle"
            item.version += 1
            await session.commit()
            return item

    async def get_preparation_bundle(self, preparation_id: str) -> PreparationBundle | None:
        async with self.sessions() as session:
            preparation = await session.get(ContentPlanPreparation, preparation_id)
            if preparation is None:
                return None
            keywords = list(
                (
                    await session.scalars(
                        select(ContentPlanPreparationKeyword)
                        .where(
                            ContentPlanPreparationKeyword.preparation_id == preparation_id
                        )
                        .order_by(
                            ContentPlanPreparationKeyword.package_position.asc().nulls_last(),
                            ContentPlanPreparationKeyword.provider_position.asc().nulls_last(),
                            ContentPlanPreparationKeyword.id,
                        )
                    )
                ).all()
            )
            relations = list(
                (
                    await session.scalars(
                        select(ContentPlanPreparationRelation)
                        .where(ContentPlanPreparationRelation.preparation_id == preparation_id)
                        .order_by(ContentPlanPreparationRelation.created_at)
                    )
                ).all()
            )
            snapshots = list(
                (
                    await session.scalars(
                        select(ContentPlanSerpSnapshot)
                        .where(ContentPlanSerpSnapshot.preparation_id == preparation_id)
                        .order_by(ContentPlanSerpSnapshot.snapshot_version.desc())
                    )
                ).all()
            )
            return PreparationBundle(preparation, keywords, relations, snapshots)

    async def create_plan_item(
        self,
        *,
        item_id: str,
        batch_id: str,
        project_id: str,
        source: str,
        seed_keyword: str,
        normalized_seed_keyword: str,
        source_rank: int | None,
        plan_order: int | None,
        primary_keyword: str,
        title: str,
        writing_direction: str,
        current_preparation_id: str,
        current_serp_snapshot_id: str,
        keywords: list[dict[str, Any]],
    ) -> ContentPlanItem:
        primary_count = sum(value.get("role") == "primary" for value in keywords)
        secondary_count = sum(value.get("role") == "secondary" for value in keywords)
        if primary_count != 1:
            raise ValueError("关键词包必须且只能有一个主关键词")
        if secondary_count > 8:
            raise ValueError("每个计划项最多 8 个次关键词")
        if len(keywords) != primary_count + secondary_count:
            raise ValueError("关键词包包含不支持的角色")
        positions = [int(value["position"]) for value in keywords]
        if sorted(positions) != list(range(1, len(keywords) + 1)):
            raise ValueError("关键词包位置必须从 1 连续递增")
        normalized = [str(value["normalized_keyword"]) for value in keywords]
        if len(normalized) != len(set(normalized)):
            raise ValueError("关键词包不能包含重复关键词")

        item = ContentPlanItem(
            id=item_id,
            batch_id=batch_id,
            project_id=project_id,
            source=source,
            seed_keyword=seed_keyword,
            normalized_seed_keyword=normalized_seed_keyword,
            source_rank=source_rank,
            plan_order=plan_order,
            primary_keyword=primary_keyword,
            title=title,
            writing_direction=writing_direction,
            current_preparation_id=current_preparation_id,
            current_serp_snapshot_id=current_serp_snapshot_id,
        )
        package = [ContentPlanItemKeyword(plan_item_id=item_id, **value) for value in keywords]
        async with self.sessions() as session:
            session.add(item)
            session.add_all(package)
            preparation = await session.get(ContentPlanPreparation, current_preparation_id)
            if preparation is not None:
                preparation.plan_item_id = item_id
                preparation.state = "preview_ready"
            await session.commit()
            await session.refresh(item)
            return item

    async def get_plan_item_bundle(self, item_id: str) -> PlanItemBundle | None:
        async with self.sessions() as session:
            item = await session.get(ContentPlanItem, item_id)
            if item is None:
                return None
            keywords = list(
                (
                    await session.scalars(
                        select(ContentPlanItemKeyword)
                        .where(ContentPlanItemKeyword.plan_item_id == item_id)
                        .order_by(ContentPlanItemKeyword.position)
                    )
                ).all()
            )
            snapshot = await session.get(
                ContentPlanSerpSnapshot, item.current_serp_snapshot_id
            )
            pending = (
                await session.get(ContentPlanPreparation, item.pending_preparation_id)
                if item.pending_preparation_id is not None
                else None
            )
            article = (
                await session.get(Article, item.article_id)
                if item.article_id is not None
                else None
            )
            return PlanItemBundle(item, keywords, snapshot, pending, article)

    async def prepare_external_request(
        self,
        *,
        batch_id: str,
        preparation_id: str | None,
        plan_item_id: str | None,
        request_key: str,
        provider: str,
        endpoint: str,
        request_hash: str,
        round_number: int,
    ) -> ContentPlanExternalRequest:
        async with self.sessions() as session:
            existing = await session.scalar(
                select(ContentPlanExternalRequest).where(
                    ContentPlanExternalRequest.request_key == request_key
                )
            )
            if existing is not None:
                if existing.request_hash != request_hash:
                    raise ValueError("request_key 已绑定不同请求内容")
                return existing
            row = ContentPlanExternalRequest(
                batch_id=batch_id,
                preparation_id=preparation_id,
                plan_item_id=plan_item_id,
                request_key=request_key,
                provider=provider,
                endpoint=endpoint,
                request_hash=request_hash,
                round_number=round_number,
                status="prepared",
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return row

    async def claim_external_request(
        self,
        request_key: str,
        *,
        claim_token: str,
        lease_until: datetime,
        max_attempts: int = 3,
    ) -> ContentPlanExternalRequest | None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        now = datetime.now(UTC)
        async with self.sessions() as session:
            row = await session.scalar(
                update(ContentPlanExternalRequest)
                .where(
                    ContentPlanExternalRequest.request_key == request_key,
                    ContentPlanExternalRequest.status.in_(
                        ("prepared", "retryable_failed")
                    ),
                    ContentPlanExternalRequest.attempt_count < max_attempts,
                )
                .values(
                    status="submitted",
                    claim_token=claim_token,
                    lease_expires_at=lease_until,
                    submitted_at=now,
                    attempt_count=ContentPlanExternalRequest.attempt_count + 1,
                )
                .returning(ContentPlanExternalRequest)
            )
            await session.commit()
            return row

    async def get_external_request(
        self, request_key: str
    ) -> ContentPlanExternalRequest | None:
        async with self.sessions() as session:
            return await session.scalar(
                select(ContentPlanExternalRequest).where(
                    ContentPlanExternalRequest.request_key == request_key
                )
            )

    async def fail_external_request(
        self,
        request_key: str,
        *,
        claim_token: str,
        status: str,
        error_code: str,
        error_detail: str,
        cost_usd: float = 0,
        provider_request_ids: list[str] | None = None,
        response_metadata: dict[str, Any] | None = None,
    ) -> ContentPlanExternalRequest | None:
        if status not in {
            "retryable_failed",
            "charged_failed",
            "uncertain",
            "failed",
        }:
            raise ValueError("invalid external request failure status")
        async with self.sessions() as session:
            row = await session.scalar(
                update(ContentPlanExternalRequest)
                .where(
                    ContentPlanExternalRequest.request_key == request_key,
                    ContentPlanExternalRequest.status == "submitted",
                    ContentPlanExternalRequest.claim_token == claim_token,
                )
                .values(
                    status=status,
                    error_code=error_code,
                    error_detail=error_detail,
                    cost_usd=cost_usd,
                    provider_request_ids=provider_request_ids or [],
                    response_metadata_json=response_metadata or {},
                    claim_token=None,
                    lease_expires_at=None,
                    finished_at=datetime.now(UTC),
                )
                .returning(ContentPlanExternalRequest)
            )
            await session.commit()
            return row

    async def complete_external_request(
        self,
        request_key: str,
        *,
        claim_token: str,
        cost_usd: float,
        result_count: int,
        provider_request_ids: list[str],
        response_metadata: dict[str, Any] | None = None,
    ) -> ContentPlanExternalRequest | None:
        async with self.sessions() as session:
            row = await session.scalar(
                update(ContentPlanExternalRequest)
                .where(
                    ContentPlanExternalRequest.request_key == request_key,
                    ContentPlanExternalRequest.status == "submitted",
                    ContentPlanExternalRequest.claim_token == claim_token,
                )
                .values(
                    status="completed",
                    cost_usd=cost_usd,
                    result_count=result_count,
                    provider_request_ids=provider_request_ids,
                    response_metadata_json=response_metadata or {},
                    claim_token=None,
                    lease_expires_at=None,
                    finished_at=datetime.now(UTC),
                )
                .returning(ContentPlanExternalRequest)
            )
            await session.commit()
            return row

    async def mark_stale_submitted_request_uncertain(
        self, request_key: str
    ) -> ContentPlanExternalRequest | None:
        now = datetime.now(UTC)
        async with self.sessions() as session:
            row = await session.scalar(
                update(ContentPlanExternalRequest)
                .where(
                    ContentPlanExternalRequest.request_key == request_key,
                    ContentPlanExternalRequest.status == "submitted",
                    ContentPlanExternalRequest.lease_expires_at <= now,
                )
                .values(
                    status="uncertain",
                    error_code="external_request_outcome_unknown",
                    error_detail="Paid request lease expired before completion was recorded",
                    claim_token=None,
                    lease_expires_at=None,
                    finished_at=now,
                )
                .returning(ContentPlanExternalRequest)
            )
            await session.commit()
            return row

    async def upsert_settings(
        self,
        *,
        project_id: str,
        cadence: str,
        paused: bool,
        timezone: str,
        default_publish_local_time: time,
        cadence_anchor_week: date | None,
        expected_version: int,
    ) -> ContentPlanSettings:
        self._validate_timezone(timezone)
        if cadence == "weekly_2_3":
            if cadence_anchor_week is None or cadence_anchor_week.isoweekday() != 1:
                raise ValueError(
                    "cadence_anchor_week must be a Monday for weekly_2_3"
                )
        elif cadence_anchor_week is not None:
            raise ValueError("cadence_anchor_week is only valid for weekly_2_3")
        async with self.sessions() as session:
            row = await session.scalar(
                select(ContentPlanSettings)
                .where(ContentPlanSettings.project_id == project_id)
                .with_for_update()
            )
            if row is None:
                if expected_version != 0:
                    raise ValueError("内容计划设置版本已变化")
                row = ContentPlanSettings(
                    project_id=project_id,
                    cadence=cadence,
                    paused=paused,
                    timezone=timezone,
                    default_publish_local_time=default_publish_local_time,
                    cadence_anchor_week=cadence_anchor_week,
                    version=1,
                )
                session.add(row)
            else:
                if row.version != expected_version:
                    raise ValueError("内容计划设置版本已变化")
                row.cadence = cadence
                row.paused = paused
                row.timezone = timezone
                row.default_publish_local_time = default_publish_local_time
                row.cadence_anchor_week = cadence_anchor_week
                row.version += 1
            await session.commit()
            await session.refresh(row)
            return row

    async def get_settings(self, project_id: str) -> ContentPlanSettings | None:
        async with self.sessions() as session:
            return await session.get(ContentPlanSettings, project_id)

    async def schedule_batch(self, batch_id: str, *, now: datetime) -> list[ContentPlanItem]:
        try:
            return await self._schedule_batch_transaction(batch_id, now=now)
        except Exception as exc:
            async with self.sessions() as session:
                batch = await session.get(ContentPlanBatch, batch_id)
                if batch is not None:
                    batch.status = "needs_attention"
                    batch.stage = "d5_scheduling_failed"
                    batch.error_code = "content_plan_scheduling_failed"
                    batch.error_detail = str(exc)
                    await session.commit()
            raise

    async def _schedule_batch_transaction(
        self, batch_id: str, *, now: datetime
    ) -> list[ContentPlanItem]:
        async with self.sessions() as session:
            batch = await session.scalar(
                select(ContentPlanBatch).where(ContentPlanBatch.id == batch_id).with_for_update()
            )
            if batch is None:
                raise ValueError("content_plan_batch_not_found")
            settings = await session.scalar(
                select(ContentPlanSettings)
                .where(ContentPlanSettings.project_id == batch.project_id)
                .with_for_update()
            )
            if settings is None:
                raise ValueError("timezone_required")
            items = list(
                (
                    await session.scalars(
                        select(ContentPlanItem)
                        .where(
                            ContentPlanItem.batch_id == batch_id,
                            ContentPlanItem.status == "unscheduled",
                        )
                        .order_by(ContentPlanItem.plan_order)
                        .with_for_update()
                    )
                ).all()
            )
            if not items:
                return list(
                    (
                        await session.scalars(
                            select(ContentPlanItem)
                            .where(ContentPlanItem.batch_id == batch_id)
                            .order_by(ContentPlanItem.plan_order)
                        )
                    ).all()
                )
            item_ids = [item.id for item in items]
            occupied = set(
                await session.scalars(
                    select(ContentPlanItem.publish_local_date).where(
                        ContentPlanItem.project_id == batch.project_id,
                        ContentPlanItem.id.not_in(item_ids),
                        ContentPlanItem.status != "cancelled",
                        ContentPlanItem.publish_local_date.is_not(None),
                    )
                )
            )
            slots = allocate_slots(
                count=len(items),
                cadence=settings.cadence,
                timezone_name=settings.timezone,
                publish_time=settings.default_publish_local_time,
                anchor_week=settings.cadence_anchor_week,
                occupied_dates=occupied,
                now=now,
            )
            for item, slot in zip(items, slots, strict=True):
                self._apply_slot(item, slot)
            batch.status = "completed"
            batch.stage = "scheduled"
            batch.finished_at = now
            await session.commit()
            return items

    async def update_settings(
        self,
        project_id: str,
        *,
        expected_version: int,
        now: datetime,
        cadence: str | None = None,
        paused: bool | None = None,
        timezone_name: str | None = None,
    ) -> ContentPlanSettings:
        async with self.sessions() as session:
            settings = await session.scalar(
                select(ContentPlanSettings)
                .where(ContentPlanSettings.project_id == project_id)
                .with_for_update()
            )
            if settings is None or settings.version != expected_version:
                raise ValueError("stale_settings_version")
            old_paused = settings.paused
            cadence_changed = cadence is not None and cadence != settings.cadence
            timezone_changed = timezone_name is not None and timezone_name != settings.timezone
            if cadence is not None and cadence not in CADENCES:
                raise ValueError("invalid_cadence")
            if timezone_changed:
                self._validate_timezone(str(timezone_name))
            if cadence_changed:
                settings.cadence = str(cadence)
                settings.cadence_anchor_week = (
                    local_monday(now, str(timezone_name or settings.timezone))
                    if cadence == "weekly_2_3"
                    else None
                )
            if timezone_changed:
                settings.timezone = str(timezone_name)
            if paused is not None:
                settings.paused = paused

            paused_changed = settings.paused != old_paused
            if paused_changed:
                articles = list(
                    (
                        await session.scalars(
                            select(Article)
                            .where(
                                Article.project_id == project_id,
                                Article.review_status.is_not(None),
                            )
                            .with_for_update()
                        )
                    ).all()
                )
                for article in articles:
                    article.publication_blocked_reason = publication_blocked_reason(
                        review_status=article.review_status,
                        publication_status=article.publication_status,
                        paused=settings.paused,
                    )

            resuming = old_paused and paused is False
            if not cadence_changed and not timezone_changed and not resuming:
                settings.version += 1
                await session.commit()
                await session.refresh(settings)
                return settings

            rows = list(
                (
                    await session.scalars(
                        select(ContentPlanItem)
                        .where(
                            ContentPlanItem.project_id == project_id,
                            ContentPlanItem.status.in_(("scheduled", "unscheduled")),
                            ContentPlanItem.article_id.is_(None),
                        )
                        .order_by(ContentPlanItem.plan_order.asc().nulls_last(), ContentPlanItem.id)
                        .with_for_update()
                    )
                ).all()
            )
            fixed = [row for row in rows if row.date_user_pinned and row.publish_local_date]
            movable = [row for row in rows if not row.date_user_pinned]
            movable_ids = [row.id for row in movable]
            occupied = set(
                await session.scalars(
                    select(ContentPlanItem.publish_local_date).where(
                        ContentPlanItem.project_id == project_id,
                        ContentPlanItem.id.not_in(movable_ids),
                        ContentPlanItem.status != "cancelled",
                        ContentPlanItem.publish_local_date.is_not(None),
                    )
                )
            )
            if timezone_changed or resuming:
                for row in fixed:
                    slot = make_slot(
                        row.publish_local_date,
                        row.publish_local_time or settings.default_publish_local_time,
                        settings.timezone,
                    )
                    if timezone_changed:
                        row.schedule_timezone = settings.timezone
                        row.publish_at = slot.publish_at
                        row.generation_at = slot.generation_at
                    row.schedule_attention_reason = (
                        "expired_user_pinned_date" if slot.generation_at <= now else None
                    )
            if cadence_changed and movable:
                slots = allocate_slots(
                    count=len(movable), cadence=settings.cadence,
                    timezone_name=settings.timezone,
                    publish_time=settings.default_publish_local_time,
                    anchor_week=settings.cadence_anchor_week,
                    occupied_dates=occupied, now=now,
                )
                for row, slot in zip(movable, slots, strict=True):
                    self._apply_slot(row, slot)
            elif timezone_changed or resuming:
                expired = []
                for row in movable:
                    if row.publish_local_date is None:
                        expired.append(row)
                        continue
                    slot = make_slot(
                        row.publish_local_date,
                        row.publish_local_time or settings.default_publish_local_time,
                        settings.timezone,
                    )
                    if slot.generation_at <= now:
                        expired.append(row)
                    else:
                        self._apply_slot(row, slot)
                        occupied.add(slot.publish_local_date)
                if expired:
                    slots = allocate_slots(
                        count=len(expired), cadence=settings.cadence,
                        timezone_name=settings.timezone,
                        publish_time=settings.default_publish_local_time,
                        anchor_week=settings.cadence_anchor_week,
                        occupied_dates=occupied, now=now,
                    )
                    for row, slot in zip(expired, slots, strict=True):
                        self._apply_slot(row, slot)
            settings.version += 1
            await session.commit()
            await session.refresh(settings)
            return settings

    @staticmethod
    def _apply_slot(item: ContentPlanItem, slot: Any) -> None:
        item.publish_local_date = slot.publish_local_date
        item.publish_local_time = slot.publish_local_time
        item.schedule_timezone = slot.schedule_timezone
        item.publish_at = slot.publish_at
        item.generation_at = slot.generation_at
        item.schedule_attention_reason = None
        item.status = "scheduled"

    @staticmethod
    def _validate_timezone(value: str) -> None:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc

    @staticmethod
    async def _count_retained(session: AsyncSession, batch_id: str) -> int:
        return len(
            list(
                (
                    await session.scalars(
                        select(ContentPlanCandidate.id).where(
                            ContentPlanCandidate.batch_id == batch_id,
                            ContentPlanCandidate.decision == "kept",
                        )
                    )
                ).all()
            )
        )

    @staticmethod
    async def _occupied_normalized_keywords(
        session: AsyncSession,
        project_id: str,
        *,
        exclude_item_id: str | None = None,
    ) -> set[str]:
        plan_rows = (
            await session.execute(
                select(
                    ContentPlanItem.normalized_seed_keyword,
                    ContentPlanItem.primary_keyword,
                ).where(
                    ContentPlanItem.project_id == project_id,
                    ContentPlanItem.status != "cancelled",
                    *(
                        (ContentPlanItem.id != exclude_item_id,)
                        if exclude_item_id is not None
                        else ()
                    ),
                )
            )
        ).all()
        article_keywords = list(
            (
                await session.scalars(
                    select(Article.primary_keyword).where(
                        Article.project_id == project_id,
                        Article.status != "cancelled",
                    )
                )
            ).all()
        )
        values = [value for row in plan_rows for value in row if value]
        values.extend(article_keywords)
        return {normalize_keyword(value) for value in values}

    @staticmethod
    async def _find_keyword_conflict_in_session(
        session: AsyncSession,
        project_id: str,
        normalized_keywords: set[str],
        *,
        exclude_item_id: str | None = None,
    ) -> str | None:
        item_rows = list(
            (
                await session.execute(
                    select(
                        ContentPlanItem.id,
                        ContentPlanItem.normalized_seed_keyword,
                        ContentPlanItem.primary_keyword,
                    ).where(
                        ContentPlanItem.project_id == project_id,
                        ContentPlanItem.status != "cancelled",
                        *(
                            (ContentPlanItem.id != exclude_item_id,)
                            if exclude_item_id is not None
                            else ()
                        ),
                    )
                )
            ).all()
        )
        for item_id, seed, primary in item_rows:
            if normalized_keywords.intersection(
                {seed, normalize_keyword(primary)}
            ):
                return str(item_id)
        article_rows = list(
            (
                await session.execute(
                    select(Article.id, Article.primary_keyword).where(
                        Article.project_id == project_id,
                        Article.status != "cancelled",
                    )
                )
            ).all()
        )
        for article_id, primary in article_rows:
            if normalize_keyword(primary) in normalized_keywords:
                return str(article_id)
        return None

    @staticmethod
    async def _locked_scoped_item(
        session: AsyncSession,
        organization_id: str,
        project_id: str,
        item_id: str,
    ) -> ContentPlanItem:
        item = await session.scalar(
            select(ContentPlanItem)
            .join(Project, Project.id == ContentPlanItem.project_id)
            .where(
                ContentPlanItem.id == item_id,
                ContentPlanItem.project_id == project_id,
                Project.organization_id == organization_id,
            )
            .with_for_update(of=ContentPlanItem)
        )
        if item is None:
            raise LookupError("content_plan_item_not_found")
        return item

    @staticmethod
    def _validate_item_editable(
        item: ContentPlanItem, expected_version: int
    ) -> None:
        if item.version != expected_version:
            raise ValueError(f"stale_version:{item.version}")
        if item.status not in {"unscheduled", "scheduled", "failed"}:
            raise ValueError("plan_not_editable")
