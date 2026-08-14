from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.session import session_factory
from app.modules.agent.models import (
    AgentConversation,
    AgentSystemTrigger,
    AgentTimelineEvent,
)
from app.modules.content.models import Article, ArticleRun
from app.modules.content_plan.models import ContentPlanBatch, ContentPlanItem
from app.modules.content_plan.recovery import (
    USER_RETRYABLE_AUTOMATIC_BATCH_ERROR_CODES,
)
from app.modules.crawling.models import CrawlRun
from app.modules.keywords.models import KeywordBuildRun
from app.modules.onboarding.models import OnboardingRun, OnboardingStep
from app.modules.onboarding.schemas import OnboardingRunResponse, OnboardingStepResponse
from app.modules.projects.models import Project, SiteProfile

logger = logging.getLogger(__name__)

STEP_KEYS = (
    "aris_welcome",
    "site_understanding",
    "business_confirmation",
    "technical_audit",
    "keyword_library",
    "content_plan",
    "first_article",
    "second_article",
)
STEP_DEPENDENCIES = {
    "business_confirmation": ("site_understanding",),
    "technical_audit": ("business_confirmation",),
    "keyword_library": ("business_confirmation",),
    "content_plan": ("keyword_library",),
    "first_article": ("content_plan",),
    "second_article": ("content_plan",),
}
TERMINAL_STEP_STATUSES = {"completed", "skipped"}
ARIS_WELCOME = (
    "我是 Aris，你的 SEO 负责人。\n\n"
    "接下来几分钟，我会先理解这个网站在卖什么、服务谁，以及客户为什么选择它。\n\n"
    "完成后，我会把业务判断交给你确认。确认无误，我们再建立关键词库和 30 篇内容计划。"
)


class OnboardingNotFoundError(Exception):
    pass


class OnboardingStepConflictError(Exception):
    pass


def build_onboarding_records(
    organization_id: str,
    project_id: str,
    started_at: datetime,
    understanding_run_id: str | None,
    agent_conversation_id: str | None = None,
) -> tuple[OnboardingRun, list[OnboardingStep]]:
    run = OnboardingRun(
        id=str(uuid4()),
        organization_id=organization_id,
        project_id=project_id,
        agent_conversation_id=agent_conversation_id,
        status="running",
        started_at=started_at,
    )
    steps = [
        OnboardingStep(
            id=str(uuid4()),
            run_id=run.id,
            step_key=step_key,
            position=position,
            status=(
                "ready"
                if step_key == "aris_welcome"
                else "running"
                if step_key == "site_understanding" and understanding_run_id
                else "ready"
                if step_key == "site_understanding"
                else "blocked"
            ),
            attempts=1 if step_key == "site_understanding" and understanding_run_id else 0,
            external_run_id=(
                understanding_run_id if step_key == "site_understanding" else None
            ),
        )
        for position, step_key in enumerate(STEP_KEYS, start=1)
    ]
    return run, steps


class SQLAlchemyOnboardingRepository:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self.sessions = sessions

    async def ensure_started(
        self,
        organization_id: str,
        project_id: str,
    ) -> None:
        async with self.sessions() as session:
            project = await self._locked_project(session, organization_id, project_id)
            existing = await session.scalar(
                select(OnboardingRun.id).where(OnboardingRun.project_id == project_id)
            )
            if existing is not None:
                return
            run, steps = build_onboarding_records(
                organization_id,
                project_id,
                project.created_at,
                project.understanding_run_id,
            )
            session.add(run)
            session.add_all(steps)
            await session.commit()

    async def reconcile_project(
        self,
        organization_id: str,
        project_id: str,
    ) -> None:
        await self._reconcile_project_state(organization_id, project_id)

    async def _reconcile_project_state(
        self,
        organization_id: str,
        project_id: str,
    ) -> None:
        await self.ensure_started(organization_id, project_id)
        async with self.sessions() as session:
            run = await session.scalar(
                select(OnboardingRun)
                .where(
                    OnboardingRun.organization_id == organization_id,
                    OnboardingRun.project_id == project_id,
                )
                .with_for_update()
            )
            if run is None:
                raise OnboardingNotFoundError
            project = await session.scalar(
                select(Project).where(
                    Project.id == project_id,
                    Project.organization_id == organization_id,
                ).with_for_update()
            )
            if project is None:
                raise OnboardingNotFoundError
            rows = list(
                (
                    await session.scalars(
                        select(OnboardingStep)
                        .where(OnboardingStep.run_id == run.id)
                        .order_by(OnboardingStep.position)
                        .with_for_update()
                    )
                ).all()
            )
            steps = {row.step_key: row for row in rows}
            if set(steps) != set(STEP_KEYS):
                raise RuntimeError("onboarding_step_set_incomplete")

            understanding = steps["site_understanding"]
            crawl_run = (
                await session.get(CrawlRun, project.understanding_run_id)
                if project.understanding_run_id
                else None
            )
            profile = await session.get(SiteProfile, project_id)
            attempt_count = int(
                await session.scalar(
                    select(func.count())
                    .select_from(CrawlRun)
                    .where(
                        CrawlRun.organization_id == organization_id,
                        CrawlRun.project_id == project_id,
                        CrawlRun.task_type == "site_understanding",
                    )
                )
                or 0
            )
            self._sync_understanding_step(
                understanding,
                crawl_run,
                profile,
                attempt_count,
            )

            now = datetime.now(UTC)
            conversation = await self._ensure_agent_conversation(
                session,
                run,
                project,
                now,
            )
            if steps["aris_welcome"].status != "completed":
                _complete_step(steps["aris_welcome"], now)
            confirmed_at = _profile_confirmed_at(profile)
            advance_onboarding(run, steps, confirmed_at)
            if confirmed_at is not None:
                audit_run = await self._onboarding_audit_run(
                    session,
                    organization_id,
                    project_id,
                    run.started_at,
                    steps["technical_audit"].external_run_id,
                )
                if audit_run is not None:
                    self._sync_audit_step(steps["technical_audit"], audit_run)
                keyword_run = await self._onboarding_keyword_run(
                    session,
                    organization_id,
                    project_id,
                    steps["keyword_library"].external_run_id,
                )
                if keyword_run is not None:
                    self._sync_keyword_step(steps["keyword_library"], keyword_run)
                advance_onboarding(run, steps, confirmed_at)
            else:
                audit_run = None
                keyword_run = None

            content_plan_batch, content_plan_item_count = await self._content_plan_state(
                session,
                organization_id,
                project_id,
                steps["content_plan"],
            )
            if content_plan_batch is not None:
                self._sync_content_plan_step(
                    steps["content_plan"],
                    content_plan_batch,
                    content_plan_item_count,
                )
                advance_onboarding(run, steps, confirmed_at)

            article_items, article_runs = await self._article_states(
                session,
                project_id,
                content_plan_batch,
                steps,
            )
            for step_key, article_run in article_runs.items():
                if article_run is not None:
                    self._sync_article_step(steps[step_key], article_run)
            advance_onboarding(run, steps, confirmed_at)
            await self._enqueue_agent_system_triggers(
                session,
                run,
                steps,
                confirmed_at=confirmed_at,
                keyword_run=keyword_run,
                content_plan_batch=content_plan_batch,
                content_plan_item_count=content_plan_item_count,
            )
            await self._sync_agent_timeline(
                session,
                run,
                project,
                conversation,
                crawl_run,
                profile,
                confirmed_at,
                now,
                steps=steps,
                audit_run=audit_run,
                keyword_run=keyword_run,
                content_plan_batch=content_plan_batch,
                content_plan_item_count=content_plan_item_count,
                article_items=article_items,
                article_runs=article_runs,
            )
            run.updated_at = now
            await session.commit()

    @staticmethod
    async def _enqueue_agent_system_triggers(
        session: AsyncSession,
        run: OnboardingRun,
        steps: dict[str, OnboardingStep],
        *,
        confirmed_at: datetime | None,
        keyword_run: KeywordBuildRun | None,
        content_plan_batch: ContentPlanBatch | None,
        content_plan_item_count: int,
    ) -> None:
        triggers: list[dict[str, object]] = []
        if (
            confirmed_at is not None
            and steps["business_confirmation"].status == "completed"
        ):
            triggers.append(
                {
                    "trigger": "business_profile_confirmed",
                    "trigger_version": run.id,
                    "content": (
                        "The user has confirmed the business profile. Check the real "
                        "audit and keyword-library state first. If they have not already "
                        "started, start the first technical audit with exactly "
                        "max_pages=100 and start the initial keyword library. These are "
                        "independent long-running tasks: start both without waiting for "
                        "the audit to finish. Report only states returned by tools."
                    ),
                    "trusted_write_tools_json": [
                        "start_technical_audit",
                        "start_keyword_library",
                    ],
                }
            )
        if (
            keyword_run is not None
            and keyword_run.status in {"partial", "completed"}
            and steps["keyword_library"].status == "completed"
        ):
            triggers.append(
                {
                    "trigger": "keyword_library_completed",
                    "trigger_version": keyword_run.id,
                    "content": (
                        "The initial keyword-library run reached a usable terminal state. "
                        "Use get_keyword_library_status to verify the real state. Only if "
                        "the returned state is partial or completed, start the 30-item "
                        "content plan. Report only states returned by tools."
                    ),
                    "trusted_write_tools_json": ["start_content_plan"],
                }
            )
        if (
            content_plan_batch is not None
            and content_plan_batch.source == "automatic"
            and content_plan_batch.target_count == 30
            and content_plan_batch.status == "completed"
            and content_plan_item_count == 30
            and steps["content_plan"].status == "completed"
        ):
            triggers.append(
                {
                    "trigger": "content_plan_completed",
                    "trigger_version": content_plan_batch.id,
                    "content": (
                        "The automatic content-plan batch "
                        f"{content_plan_batch.id} has reached a terminal state. Use "
                        "get_content_plan_status with that batch_id and verify that the "
                        "real batch is completed with 30 saved plan items. Only then call "
                        f"start_articles with batch_id={content_plan_batch.id} and count=2. "
                        "If two eligible plans are not "
                        "available, report the real failure instead of claiming success."
                    ),
                    "trusted_write_tools_json": ["start_articles"],
                }
            )
        for trigger in triggers:
            await session.execute(
                pg_insert(AgentSystemTrigger)
                .values(
                    id=str(uuid4()),
                    organization_id=run.organization_id,
                    project_id=run.project_id,
                    status="pending",
                    **trigger,
                )
                .on_conflict_do_nothing(
                    constraint="uq_agent_system_triggers_identity"
                )
            )

    @staticmethod
    async def _onboarding_audit_run(
        session: AsyncSession,
        organization_id: str,
        project_id: str,
        _onboarding_started_at: datetime,
        external_run_id: str | None,
    ) -> CrawlRun | None:
        if not external_run_id:
            return None
        return await session.scalar(
            select(CrawlRun).where(
                CrawlRun.run_id == external_run_id,
                CrawlRun.organization_id == organization_id,
                CrawlRun.project_id == project_id,
                CrawlRun.task_type == "technical_audit",
            )
        )

    @staticmethod
    async def _onboarding_keyword_run(
        session: AsyncSession,
        organization_id: str,
        project_id: str,
        external_run_id: str | None,
    ) -> KeywordBuildRun | None:
        if not external_run_id:
            return None
        return await session.scalar(
            select(KeywordBuildRun).where(
                KeywordBuildRun.id == external_run_id,
                KeywordBuildRun.organization_id == organization_id,
                KeywordBuildRun.project_id == project_id,
            )
        )

    @staticmethod
    async def _content_plan_state(
        session: AsyncSession,
        organization_id: str,
        project_id: str,
        step: OnboardingStep,
    ) -> tuple[ContentPlanBatch | None, int]:
        batch = None
        if step.external_run_id:
            batch = await session.scalar(
                select(ContentPlanBatch).where(
                    ContentPlanBatch.id == step.external_run_id,
                    ContentPlanBatch.organization_id == organization_id,
                    ContentPlanBatch.project_id == project_id,
                )
            )
        if batch is None:
            return None, 0
        count = int(
            await session.scalar(
                select(func.count(ContentPlanItem.id)).where(
                    ContentPlanItem.batch_id == batch.id
                )
            )
            or 0
        )
        return batch, count

    @staticmethod
    async def _article_states(
        session: AsyncSession,
        project_id: str,
        batch: ContentPlanBatch | None,
        steps: dict[str, OnboardingStep],
    ) -> tuple[dict[str, ContentPlanItem | None], dict[str, ArticleRun | None]]:
        item_by_step: dict[str, ContentPlanItem | None] = {
            "first_article": None,
            "second_article": None,
        }
        run_by_step: dict[str, ArticleRun | None] = {
            "first_article": None,
            "second_article": None,
        }
        if batch is not None:
            items = list(
                (
                    await session.scalars(
                        select(ContentPlanItem)
                        .where(
                            ContentPlanItem.batch_id == batch.id,
                            ContentPlanItem.plan_order.in_((1, 2)),
                        )
                        .order_by(ContentPlanItem.plan_order)
                    )
                ).all()
            )
            for item in items:
                step_key = "first_article" if item.plan_order == 1 else "second_article"
                item_by_step[step_key] = item
        for step_key, step in (
            ("first_article", steps["first_article"]),
            ("second_article", steps["second_article"]),
        ):
            if step.external_run_id:
                run_by_step[step_key] = await session.get(
                    ArticleRun, step.external_run_id
                )
                continue
            item = item_by_step[step_key]
            if item is None or not item.article_id:
                continue
            article = await session.get(Article, item.article_id)
            if article is not None and article.current_run_id:
                run_by_step[step_key] = await session.get(
                    ArticleRun, article.current_run_id
                )
        return item_by_step, run_by_step

    @staticmethod
    async def _ensure_agent_conversation(
        session: AsyncSession,
        run: OnboardingRun,
        project: Project,
        now: datetime,
    ) -> AgentConversation:
        conversation = (
            await session.get(AgentConversation, run.agent_conversation_id)
            if run.agent_conversation_id
            else None
        )
        if conversation is None:
            conversation = await session.scalar(
                select(AgentConversation)
                .where(
                    AgentConversation.organization_id == project.organization_id,
                    AgentConversation.project_id == project.id,
                )
                .order_by(AgentConversation.created_at, AgentConversation.id)
                .limit(1)
            )
        if conversation is None:
            conversation = AgentConversation(
                id=str(uuid4()),
                organization_id=project.organization_id,
                project_id=project.id,
                created_by="system",
                title="网站初始化",
                created_at=now,
                updated_at=now,
            )
            session.add(conversation)
            await session.flush()
        run.agent_conversation_id = conversation.id
        return conversation

    @classmethod
    async def _sync_agent_timeline(
        cls,
        session: AsyncSession,
        run: OnboardingRun,
        project: Project,
        conversation: AgentConversation,
        crawl_run: CrawlRun | None,
        profile: SiteProfile | None,
        confirmed_at: datetime | None,
        now: datetime,
        *,
        steps: dict[str, OnboardingStep],
        audit_run: CrawlRun | None,
        keyword_run: KeywordBuildRun | None,
        content_plan_batch: ContentPlanBatch | None,
        content_plan_item_count: int,
        article_items: dict[str, ContentPlanItem | None],
        article_runs: dict[str, ArticleRun | None],
    ) -> None:
        projections = onboarding_timeline_projection(
            project.id,
            crawl_run,
            profile,
            confirmed_at,
            steps=steps,
            audit_run=audit_run,
            keyword_run=keyword_run,
            content_plan_batch=content_plan_batch,
            content_plan_item_count=content_plan_item_count,
            article_items=article_items,
            article_runs=article_runs,
        )
        changed = False
        for projection in projections:
            changed = await cls._upsert_agent_timeline_event(
                session,
                project.organization_id,
                project.id,
                conversation.id,
                projection,
                now,
            ) or changed
        if changed:
            conversation.updated_at = now

    @staticmethod
    async def _upsert_agent_timeline_event(
        session: AsyncSession,
        organization_id: str,
        project_id: str,
        conversation_id: str,
        projection: dict[str, object],
        now: datetime,
    ) -> bool:
        event_key = str(projection["event_key"])
        existing = await session.scalar(
            select(AgentTimelineEvent).where(
                AgentTimelineEvent.organization_id == organization_id,
                AgentTimelineEvent.project_id == project_id,
                AgentTimelineEvent.event_key == event_key,
            )
        )
        if existing is None:
            sequence = int(
                await session.scalar(
                    select(func.max(AgentTimelineEvent.sequence)).where(
                        AgentTimelineEvent.organization_id == organization_id,
                        AgentTimelineEvent.project_id == project_id,
                    )
                )
                or 0
            ) + 1
            session.add(
                AgentTimelineEvent(
                    id=str(uuid4()),
                    organization_id=organization_id,
                    project_id=project_id,
                    conversation_id=conversation_id,
                    event_key=event_key,
                    sequence=sequence,
                    kind=str(projection["kind"]),
                    status=str(projection["status"]),
                    title=str(projection["title"]),
                    content=str(projection["content"]),
                    action_json=dict(projection.get("action") or {}),
                    metadata_json=dict(projection.get("metadata") or {}),
                    created_at=now,
                    updated_at=now,
                )
            )
            await session.flush()
            return True

        expected_identity = (
            str(projection["kind"]),
            conversation_id,
        )
        if (existing.kind, existing.conversation_id) != expected_identity:
            raise RuntimeError("onboarding_timeline_identity_conflict")
        next_status = str(projection["status"])
        title = str(projection["title"])
        content = str(projection["content"])
        action = dict(projection.get("action") or {})
        metadata = dict(projection.get("metadata") or {})
        retrying_failed_step = existing.status == "failed" and next_status == "running"
        if (
            existing.status in {"completed", "failed", "cancelled"}
            and existing.status != next_status
        ):
            if not retrying_failed_step:
                return False
        if existing.status != next_status and (
            existing.status not in {"running", "waiting"}
            or next_status in {"running", "waiting"}
        ) and not retrying_failed_step:
            raise RuntimeError("onboarding_timeline_status_conflict")
        changed = (
            existing.status != next_status
            or existing.title != title
            or existing.content != content
            or existing.action_json != action
            or existing.metadata_json != metadata
        )
        if changed:
            existing.status = next_status
            existing.title = title
            existing.content = content
            existing.action_json = action
            existing.metadata_json = metadata
            existing.updated_at = now
        return changed

    async def list_reconcilable_projects(
        self,
        limit: int,
    ) -> list[tuple[str, str]]:
        async with self.sessions() as session:
            rows = (
                await session.execute(
                    select(Project.organization_id, Project.id)
                    .outerjoin(OnboardingRun, OnboardingRun.project_id == Project.id)
                    .where(
                        or_(
                            OnboardingRun.id.is_(None),
                            OnboardingRun.status != "completed",
                        )
                    )
                    .order_by(
                        OnboardingRun.updated_at.asc().nullsfirst(),
                        Project.created_at,
                        Project.id,
                    )
                    .limit(max(1, min(limit, 500)))
                )
            ).all()
        return [(row.organization_id, row.id) for row in rows]

    async def get(
        self,
        organization_id: str,
        project_id: str,
    ) -> tuple[OnboardingRun, list[OnboardingStep]] | None:
        async with self.sessions() as session:
            run = await session.scalar(
                select(OnboardingRun).where(
                    OnboardingRun.organization_id == organization_id,
                    OnboardingRun.project_id == project_id,
                )
            )
            if run is None:
                return None
            steps = list(
                (
                    await session.scalars(
                        select(OnboardingStep)
                        .where(OnboardingStep.run_id == run.id)
                        .order_by(OnboardingStep.position)
                    )
                ).all()
            )
            return run, steps

    async def article_ids_for_initial_generation(
        self,
        organization_id: str,
        project_id: str,
    ) -> list[str]:
        async with self.sessions() as session:
            rows = list(
                (
                    await session.execute(
                        select(OnboardingStep.step_key, ArticleRun.article_id)
                        .join(OnboardingRun, OnboardingRun.id == OnboardingStep.run_id)
                        .join(ArticleRun, ArticleRun.id == OnboardingStep.external_run_id)
                        .where(
                            OnboardingRun.organization_id == organization_id,
                            OnboardingRun.project_id == project_id,
                            OnboardingStep.step_key.in_((
                                "first_article",
                                "second_article",
                            )),
                            ArticleRun.organization_id == organization_id,
                            ArticleRun.project_id == project_id,
                        )
                        .order_by(OnboardingStep.position)
                    )
                ).all()
            )
        return [article_id for _step_key, article_id in rows]

    async def claim_step(
        self,
        organization_id: str,
        project_id: str,
        step_key: str,
        external_run_id: str | None,
    ) -> None:
        async with self.sessions() as session:
            step = await self._locked_step(session, organization_id, project_id, step_key)
            if step.status != "ready":
                raise OnboardingStepConflictError(f"step_not_ready:{step.status}")
            now = datetime.now(UTC)
            step.status = "running"
            step.attempts += 1
            step.external_run_id = external_run_id
            step.last_error_code = None
            step.last_error_message = None
            step.started_at = now
            step.finished_at = None
            step.updated_at = now
            await session.commit()

    async def observe_started_step(
        self,
        organization_id: str,
        project_id: str,
        step_key: str,
        external_run_id: str,
    ) -> None:
        _validate_step_key(step_key)
        if step_key not in {
            "technical_audit",
            "keyword_library",
            "content_plan",
            "first_article",
            "second_article",
        }:
            raise OnboardingStepConflictError("step_cannot_bind_external_run")
        if not external_run_id.strip():
            raise OnboardingStepConflictError("external_run_id_required")
        async with self.sessions() as session:
            step = await self._locked_step(
                session, organization_id, project_id, step_key
            )
            if step.status == "running" and step.external_run_id == external_run_id:
                await session.commit()
                return
            if step.status != "ready":
                raise OnboardingStepConflictError(f"step_not_ready:{step.status}")
            if step.external_run_id not in {None, external_run_id}:
                raise OnboardingStepConflictError("external_run_id_conflict")
            now = datetime.now(UTC)
            step.status = "running"
            step.attempts += 1
            step.external_run_id = external_run_id
            step.last_error_code = None
            step.last_error_message = None
            step.started_at = now
            step.finished_at = None
            step.updated_at = now
            await session.commit()

    async def complete_step(
        self,
        organization_id: str,
        project_id: str,
        step_key: str,
        external_run_id: str | None,
    ) -> None:
        async with self.sessions() as session:
            step = await self._locked_step(session, organization_id, project_id, step_key)
            if step.status in TERMINAL_STEP_STATUSES:
                if external_run_id and step.external_run_id not in {None, external_run_id}:
                    raise OnboardingStepConflictError("external_run_id_conflict")
                return
            if step.status not in {"ready", "running"}:
                raise OnboardingStepConflictError(f"step_not_active:{step.status}")
            if external_run_id:
                if step.external_run_id not in {None, external_run_id}:
                    raise OnboardingStepConflictError("external_run_id_conflict")
                step.external_run_id = external_run_id
            _complete_step(step, datetime.now(UTC))
            await session.commit()

    async def fail_step(
        self,
        organization_id: str,
        project_id: str,
        step_key: str,
        error_code: str,
        error_message: str,
    ) -> None:
        async with self.sessions() as session:
            step = await self._locked_step(session, organization_id, project_id, step_key)
            if step.status != "running":
                raise OnboardingStepConflictError(f"step_not_running:{step.status}")
            now = datetime.now(UTC)
            step.status = "failed"
            step.last_error_code = error_code[:200]
            step.last_error_message = error_message[:2_000]
            step.finished_at = now
            step.updated_at = now
            await session.commit()

    async def retry_step(
        self,
        organization_id: str,
        project_id: str,
        step_key: str,
        external_run_id: str | None = None,
    ) -> None:
        async with self.sessions() as session:
            step = await self._locked_step(session, organization_id, project_id, step_key)
            if step.status != "failed":
                raise OnboardingStepConflictError(f"step_not_failed:{step.status}")
            dependencies = STEP_DEPENDENCIES.get(step_key, ())
            if dependencies:
                dependency_statuses = list(
                    (
                        await session.scalars(
                            select(OnboardingStep.status).where(
                                OnboardingStep.run_id == step.run_id,
                                OnboardingStep.step_key.in_(dependencies),
                            )
                        )
                    ).all()
                )
                if len(dependency_statuses) != len(dependencies) or any(
                    status not in TERMINAL_STEP_STATUSES for status in dependency_statuses
                ):
                    raise OnboardingStepConflictError("step_dependencies_incomplete")
            _make_ready(step)
            if external_run_id:
                now = datetime.now(UTC)
                step.status = "running"
                step.attempts += 1
                step.external_run_id = external_run_id
                step.started_at = now
                step.updated_at = now
            await session.commit()

    async def failed_step_context(
        self,
        organization_id: str,
        project_id: str,
        step_key: str,
    ) -> tuple[OnboardingRun, OnboardingStep, ArticleRun | None]:
        async with self.sessions() as session:
            step = await self._locked_step(
                session, organization_id, project_id, step_key
            )
            if step.status != "failed":
                raise OnboardingStepConflictError(f"step_not_failed:{step.status}")
            run = await session.get(OnboardingRun, step.run_id)
            if run is None:
                raise OnboardingNotFoundError
            article_run = (
                await session.get(ArticleRun, step.external_run_id)
                if step_key in {"first_article", "second_article"}
                and step.external_run_id
                else None
            )
            return run, step, article_run

    @staticmethod
    async def _locked_project(
        session: AsyncSession,
        organization_id: str,
        project_id: str,
    ) -> Project:
        project = await session.scalar(
            select(Project)
            .where(
                Project.id == project_id,
                Project.organization_id == organization_id,
            )
            .with_for_update()
        )
        if project is None:
            raise OnboardingNotFoundError
        return project

    @staticmethod
    async def _locked_step(
        session: AsyncSession,
        organization_id: str,
        project_id: str,
        step_key: str,
    ) -> OnboardingStep:
        run = await session.scalar(
            select(OnboardingRun)
            .where(
                OnboardingRun.organization_id == organization_id,
                OnboardingRun.project_id == project_id,
            )
            .with_for_update()
        )
        if run is None:
            raise OnboardingNotFoundError
        step = await session.scalar(
            select(OnboardingStep)
            .where(
                OnboardingStep.run_id == run.id,
                OnboardingStep.step_key == step_key,
            )
            .with_for_update()
        )
        if step is None:
            raise OnboardingNotFoundError
        return step

    @staticmethod
    def _sync_understanding_step(
        step: OnboardingStep,
        crawl_run: CrawlRun | None,
        profile: SiteProfile | None,
        attempt_count: int,
    ) -> None:
        if crawl_run is None:
            if step.status not in TERMINAL_STEP_STATUSES:
                _make_ready(step)
            return
        run_changed = step.external_run_id != crawl_run.run_id
        if run_changed:
            step.external_run_id = crawl_run.run_id
            step.last_error_code = None
            step.last_error_message = None
            step.finished_at = None
        step.attempts = max(step.attempts, attempt_count, 1)
        step.started_at = crawl_run.started_at
        if crawl_run.status in {"queued", "running"}:
            step.status = "running"
            step.finished_at = None
        elif crawl_run.status in {"partial", "completed"} and profile is not None:
            _complete_step(step, crawl_run.finished_at or datetime.now(UTC))
        elif crawl_run.status in {"partial", "completed"}:
            step.status = "failed"
            step.last_error_code = "site_profile_missing"
            step.last_error_message = "网站扫描结束，但没有生成可确认的业务资料"
            step.finished_at = crawl_run.finished_at or datetime.now(UTC)
        elif crawl_run.status == "failed":
            step.status = "failed"
            step.last_error_code = "site_understanding_failed"
            step.last_error_message = (crawl_run.message or "网站理解失败")[:2_000]
            step.finished_at = crawl_run.finished_at or datetime.now(UTC)
            step.updated_at = datetime.now(UTC)

    @staticmethod
    def _sync_keyword_step(step: OnboardingStep, run: KeywordBuildRun) -> None:
        run_changed = step.external_run_id != run.id
        if run_changed:
            step.external_run_id = run.id
            step.attempts = (step.attempts or 0) + 1
        step.started_at = run.started_at or run.created_at
        step.updated_at = datetime.now(UTC)
        if run.status in {"partial", "completed"}:
            _complete_step(step, run.finished_at or step.updated_at)
            return
        if run.status in {"failed", "cancelled"}:
            step.status = "failed"
            step.last_error_code = run.error_code or run.status
            step.last_error_message = run.error_detail or run.message
            step.finished_at = run.finished_at or step.updated_at
            return
        step.status = "running"
        step.last_error_code = None
        step.last_error_message = None
        step.finished_at = None

    @staticmethod
    def _sync_audit_step(step: OnboardingStep, run: CrawlRun) -> None:
        run_changed = step.external_run_id != run.run_id
        if run_changed:
            step.external_run_id = run.run_id
            step.attempts = (step.attempts or 0) + 1
        step.started_at = run.started_at or run.created_at
        step.updated_at = datetime.now(UTC)
        if run.status in {"completed", "partial"}:
            _complete_step(step, run.finished_at or step.updated_at)
            return
        if run.status in {"failed", "cancelled", "stopped"}:
            step.status = "failed"
            step.last_error_code = run.status
            step.last_error_message = run.message
            step.finished_at = run.finished_at or step.updated_at
            return
        step.status = "running"
        step.last_error_code = None
        step.last_error_message = None
        step.finished_at = None

    @staticmethod
    def _sync_content_plan_step(
        step: OnboardingStep,
        batch: ContentPlanBatch,
        plan_item_count: int,
    ) -> None:
        run_changed = step.external_run_id != batch.id
        if run_changed:
            step.external_run_id = batch.id
            step.attempts = (step.attempts or 0) + 1
        step.started_at = batch.started_at or batch.created_at
        step.updated_at = datetime.now(UTC)
        if batch.status == "completed" and plan_item_count == 30:
            _complete_step(step, batch.finished_at or step.updated_at)
            return
        if batch.status == "completed":
            step.status = "failed"
            step.last_error_code = "content_plan_items_incomplete"
            step.last_error_message = (
                f"内容计划已结束，但只保存了 {plan_item_count}/30 条计划"
            )
            step.finished_at = batch.finished_at or step.updated_at
            return
        if batch.status in {"needs_attention", "cancelled"}:
            step.status = "failed"
            step.last_error_code = batch.error_code or batch.status
            step.last_error_message = batch.error_detail
            step.finished_at = batch.finished_at or step.updated_at
            return
        step.status = "running"
        step.last_error_code = None
        step.last_error_message = None
        step.finished_at = None

    @staticmethod
    def _sync_article_step(step: OnboardingStep, run: ArticleRun) -> None:
        run_changed = step.external_run_id != run.id
        if run_changed:
            step.external_run_id = run.id
            step.attempts = (step.attempts or 0) + 1
        step.started_at = run.started_at or run.created_at
        step.updated_at = datetime.now(UTC)
        if run.status in {"completed", "completed_with_warnings"}:
            _complete_step(step, run.finished_at or step.updated_at)
            return
        if run.status in {"failed", "cancelled"}:
            step.status = "failed"
            step.last_error_code = run.error_code or run.status
            step.last_error_message = run.error_detail
            step.finished_at = run.finished_at or step.updated_at
            return
        step.status = "running"
        step.last_error_code = None
        step.last_error_message = None
        step.finished_at = None


class OnboardingService:
    def __init__(
        self,
        organization_id: str,
        repository: SQLAlchemyOnboardingRepository,
    ) -> None:
        self.organization_id = organization_id
        self.repository = repository

    async def get(self, project_id: str) -> OnboardingRunResponse:
        await self.repository.reconcile_project(self.organization_id, project_id)
        result = await self.repository.get(self.organization_id, project_id)
        if result is None:
            raise OnboardingNotFoundError
        return onboarding_response(*result)

    async def reconcile_project(self, project_id: str) -> None:
        await self.repository.reconcile_project(self.organization_id, project_id)

    async def reconcile_all(self, limit: int = 100) -> None:
        projects = await self.repository.list_reconcilable_projects(limit)
        for organization_id, project_id in projects:
            try:
                await self.repository.reconcile_project(organization_id, project_id)
            except OnboardingNotFoundError:
                continue
            except Exception:
                logger.exception(
                    "Unable to reconcile onboarding project",
                    extra={"project_id": project_id},
                )

    async def claim_step(
        self,
        project_id: str,
        step_key: str,
        external_run_id: str | None = None,
    ) -> OnboardingRunResponse:
        _validate_step_key(step_key)
        await self.repository.reconcile_project(self.organization_id, project_id)
        await self.repository.claim_step(
            self.organization_id, project_id, step_key, external_run_id
        )
        return await self.get(project_id)

    async def complete_step(
        self,
        project_id: str,
        step_key: str,
        external_run_id: str | None = None,
    ) -> OnboardingRunResponse:
        _validate_step_key(step_key)
        await self.repository.complete_step(
            self.organization_id, project_id, step_key, external_run_id
        )
        return await self.get(project_id)

    async def fail_step(
        self,
        project_id: str,
        step_key: str,
        error_code: str,
        error_message: str,
    ) -> OnboardingRunResponse:
        _validate_step_key(step_key)
        await self.repository.fail_step(
            self.organization_id,
            project_id,
            step_key,
            error_code,
            error_message,
        )
        return await self.get(project_id)

    async def retry_step(
        self,
        project_id: str,
        step_key: str,
    ) -> OnboardingRunResponse:
        _validate_step_key(step_key)
        run, step, article_run = await self.repository.failed_step_context(
            self.organization_id,
            project_id,
            step_key,
        )
        if step_key == "keyword_library":
            from app.modules.keywords.service import build_keyword_service

            await build_keyword_service().retry_failed_initial_build(project_id)
        elif step_key == "content_plan":
            from app.modules.content_plan.batch_service import (
                build_content_plan_batch_service,
            )

            if not step.external_run_id:
                raise OnboardingStepConflictError("content_plan_run_missing")
            await build_content_plan_batch_service().retry_batch(
                self.organization_id,
                project_id,
                step.external_run_id,
            )
        elif step_key in {"first_article", "second_article"}:
            from app.modules.content.service import build_content_service

            if article_run is None:
                raise OnboardingStepConflictError("article_run_missing")
            response = await build_content_service().create_followup_run(
                project_id,
                article_run.article_id,
                "retry",
                (
                    f"onboarding:{run.id}:{step_key}:"
                    f"retry:{step.attempts + 1}"
                ),
                organization_id=self.organization_id,
            )
            if response.run is None:
                raise OnboardingStepConflictError("article_retry_run_missing")
            await self.repository.retry_step(
                self.organization_id,
                project_id,
                step_key,
                response.run.id,
            )
            return await self.get(project_id)
        elif step_key != "technical_audit":
            raise OnboardingStepConflictError("step_retry_not_supported")
        await self.repository.retry_step(self.organization_id, project_id, step_key)
        return await self.get(project_id)


def onboarding_response(
    run: OnboardingRun,
    steps: Sequence[OnboardingStep],
) -> OnboardingRunResponse:
    return OnboardingRunResponse(
        id=run.id,
        project_id=run.project_id,
        status=run.status,
        started_at=run.started_at,
        business_confirmed_at=run.business_confirmed_at,
        completed_at=run.completed_at,
        steps=[
            OnboardingStepResponse(
                key=step.step_key,
                position=step.position,
                status=step.status,
                attempts=step.attempts,
                external_run_id=step.external_run_id,
                last_error_code=step.last_error_code,
                last_error_message=step.last_error_message,
                started_at=step.started_at,
                finished_at=step.finished_at,
            )
            for step in steps
        ],
    )


def build_onboarding_service() -> OnboardingService:
    from app.core.config import get_settings

    settings = get_settings()
    return OnboardingService(
        settings.default_organization_id,
        SQLAlchemyOnboardingRepository(session_factory),
    )


def _profile_confirmed_at(profile: SiteProfile | None) -> datetime | None:
    if profile is None:
        return None
    value = profile.profile_json.get("confirmed_at")
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _compact_profile_text(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())


def _compact_profile_items(value: object, limit: int = 3) -> list[str]:
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for raw_item in value:
        item = _compact_profile_text(raw_item)
        if item and item not in items:
            items.append(item)
        if len(items) == limit:
            break
    return items


def _core_pages_content(profile: SiteProfile | None) -> str:
    if profile is None:
        return (
            "网站的核心业务页面已经读取完成。\n\n"
            "接下来我会根据这些内容判断它提供什么、服务谁，以及客户为什么选择它。"
        )
    business_name = _compact_profile_text(profile.profile_json.get("business_name"))
    subject = business_name or "这个网站"
    return (
        "网站的核心业务页面已经读取完成。\n\n"
        f"我确认这些页面代表 {subject} 的主要业务。接下来我会根据这些内容判断它提供什么、"
        "服务谁，以及客户为什么选择它。"
    )


def _business_profile_content(profile: SiteProfile) -> str:
    data = profile.profile_json
    business_name = _compact_profile_text(data.get("business_name"))
    business_type = _compact_profile_text(data.get("business_type"))
    business_summary = _compact_profile_text(data.get("business_summary"))
    products = _compact_profile_items(data.get("products_services"))
    audiences = _compact_profile_items(data.get("target_audiences"))
    values = _compact_profile_items(data.get("value_propositions"))

    subject = business_name or "这个网站"
    sections = [
        f"**它做什么**\n\n{business_summary or business_type or '还没有识别到'}",
        f"**主要产品**\n\n{'；'.join(products) if products else '还没有识别到'}",
        f"**主要客户**\n\n{'；'.join(audiences) if audiences else '还没有识别到'}",
        f"**客户为什么选择它**\n\n{'；'.join(values) if values else '还没有识别到'}",
    ]
    missing = [
        label
        for label, present in (
            ("品牌或企业名称", bool(business_name)),
            ("业务定位", bool(business_summary or business_type)),
            ("主要产品", bool(products)),
            ("主要客户", bool(audiences)),
            ("客户选择它的原因", bool(values)),
        )
        if not present
    ]
    footer = (
        f"还需要你补充或确认：{'、'.join(missing)}。"
        if missing
        else "这些判断来自网站公开页面。请重点确认主要客户和客户选择它的原因是否准确。"
    )
    return f"这是我目前对 {subject} 的理解。\n\n" + "\n\n".join(sections) + f"\n\n{footer}"


def _crawl_stage_index(crawl_run: CrawlRun) -> int:
    if crawl_run.stage in {"discovering_pages"}:
        return 1
    if crawl_run.stage in {"extracting_pages", "selecting_pages"}:
        return 2
    if crawl_run.stage in {"generating_profile", "completed"}:
        return 3
    return 0


def _crawl_failure_content(crawl_run: CrawlRun) -> str:
    message = _compact_profile_text(crawl_run.message)
    if message.startswith("网站业务识别失败："):
        return f"{message}\n\n已经完成的结果没有丢失，你可以只重新执行网站识别。"
    return "这一步没有完成。已经完成的结果没有丢失，你可以只重新执行网站识别。"


def _downstream_status(step: OnboardingStep) -> str:
    if step.status in {"ready", "running"}:
        return "running"
    return step.status


def _downstream_retryable(
    step_key: str,
    step: OnboardingStep,
    *,
    keyword_run: KeywordBuildRun | None,
    content_plan_batch: ContentPlanBatch | None,
    article_run: ArticleRun | None,
) -> bool:
    if step.status != "failed":
        return False
    if step_key == "technical_audit":
        return True
    if step_key == "keyword_library":
        return keyword_run is not None and keyword_run.status == "failed"
    if step_key == "content_plan":
        return bool(
            content_plan_batch is not None
            and content_plan_batch.source == "automatic"
            and content_plan_batch.status == "needs_attention"
            and content_plan_batch.error_code
            in USER_RETRYABLE_AUTOMATIC_BATCH_ERROR_CODES
        )
    return bool(
        article_run is not None
        and article_run.status == "failed"
        and article_run.retryable is True
    )


def _downstream_content(
    step_key: str,
    step: OnboardingStep,
    *,
    audit_run: CrawlRun | None,
    keyword_run: KeywordBuildRun | None,
    content_plan_batch: ContentPlanBatch | None,
    content_plan_item_count: int,
    article_item: ContentPlanItem | None,
    article_run: ArticleRun | None,
) -> str:
    if step.status == "failed":
        return (
            "这一步没有完成。已经完成的结果没有丢失，我只会重试失败的任务。"
        )
    if step_key == "technical_audit":
        if step.status == "completed":
            return "技术审核已经完成。你可以查看问题、证据和修复优先级。"
        if audit_run is None or audit_run.status == "queued":
            return "技术审核已经进入队列。我会检查网站结构、抓取和页面技术问题。"
        return "技术审核正在进行。我会在完成后给出问题和修复优先级。"
    if step_key == "keyword_library":
        count = int(keyword_run.keyword_count or 0) if keyword_run is not None else 0
        if step.status == "completed":
            if keyword_run is not None and keyword_run.status == "partial":
                return (
                    f"关键词库已部分完成，共保留 {count} 个可继续使用的关键词。"
                    "部分来源没有完成，但不会影响已经保存的结果和后续内容计划。"
                )
            return f"关键词库已经建立，共保留 {count} 个值得继续分析的关键词。"
        progress = int(keyword_run.progress or 0) if keyword_run is not None else 0
        if progress > 0:
            return f"正在筛选真实搜索机会，当前进度 {progress}%。"
        return "正在建立关键词库。我会结合业务资料筛选真正值得竞争的搜索机会。"
    if step_key == "content_plan":
        if step.status == "completed":
            return "30 篇内容计划已经建立，默认按每周 2-3 篇安排。"
        progress_count = content_plan_item_count
        if content_plan_batch is not None:
            progress_count = max(
                progress_count,
                int(content_plan_batch.valid_pack_count or 0),
            )
        if progress_count > 0:
            return f"正在生成内容计划，已经准备好 {min(progress_count, 30)}/30 篇。"
        return "正在把关键词机会整理成 30 篇内容计划，默认按每周 2-3 篇安排。"

    title = _compact_profile_text(article_item.title if article_item else "")
    article_label = "第一篇文章" if step_key == "first_article" else "第二篇文章"
    title_line = f"《{title}》" if title else article_label
    if step.status == "completed":
        return f"{title_line}已经生成，可以进入内容中心查看和编辑。"
    progress = int(article_run.progress or 0) if article_run is not None else 0
    if progress > 0:
        return f"正在生成{title_line}，当前进度 {progress}%。"
    return f"正在生成{title_line}。两篇文章会并行处理，不需要等待上一篇完成。"


def onboarding_timeline_projection(
    project_id: str,
    crawl_run: CrawlRun | None,
    profile: SiteProfile | None,
    confirmed_at: datetime | None,
    *,
    steps: dict[str, OnboardingStep] | None = None,
    audit_run: CrawlRun | None = None,
    keyword_run: KeywordBuildRun | None = None,
    content_plan_batch: ContentPlanBatch | None = None,
    content_plan_item_count: int = 0,
    article_items: dict[str, ContentPlanItem | None] | None = None,
    article_runs: dict[str, ArticleRun | None] | None = None,
) -> list[dict[str, object]]:
    events: list[dict[str, object]] = [
        {
            "event_key": "onboarding:welcome",
            "kind": "message",
            "status": "completed",
            "title": ARIS_WELCOME,
            "content": "",
            "metadata": {"source": "onboarding", "onboarding_order": 0},
        }
    ]
    if crawl_run is None:
        return events

    source_metadata = {
        "source": "site_understanding",
        "source_run_id": crawl_run.run_id,
    }
    profile_ready = profile is not None
    crawl_failed = crawl_run.status == "failed"
    active_index = _crawl_stage_index(crawl_run)
    if profile_ready:
        active_index = 4

    milestones = (
        (
            "site-entry",
            "检查网站入口",
            "我正在检查首页、Sitemap 和导航结构，先确定从哪里理解这个网站。",
            "网站入口已经确认。现在继续寻找最能代表业务的页面。",
        ),
        (
            "page-discovery",
            "寻找核心页面",
            "我正在从站内页面中寻找产品、服务、定价和关于页面。",
            "核心业务页面已经找到。现在开始读取和提取其中的业务信息。",
        ),
        (
            "core-pages",
            "读取核心页面",
            "我正在读取最能代表业务的页面，整理产品、服务和客户证据。",
            _core_pages_content(profile),
        ),
        (
            "business-understanding",
            "理解业务",
            "网站结构已经清楚了。现在我正在判断它提供什么、服务谁，以及客户为什么选择它。",
            _business_profile_content(profile) if profile_ready else "",
        ),
    )
    failure_index = min(active_index, len(milestones) - 1)
    for index, (event_name, title, running_content, completed_content) in enumerate(
        milestones
    ):
        if profile_ready or index < active_index:
            status = "completed"
            content = completed_content
        elif crawl_failed and index == failure_index:
            status = "failed"
            content = _crawl_failure_content(crawl_run)
        elif not crawl_failed and index == active_index:
            status = "running"
            content = running_content
        else:
            break
        events.append(
            {
                "event_key": f"onboarding:{event_name}:{crawl_run.run_id}",
                "kind": "task",
                "status": status,
                "title": title,
                "content": content,
                "metadata": {**source_metadata, "onboarding_order": index + 1},
            }
        )

    if not profile_ready:
        return events
    confirmation_completed = confirmed_at is not None
    events.append(
        {
            "event_key": "onboarding:business-confirmation",
            "kind": "action",
            "status": "completed" if confirmation_completed else "waiting",
            "title": "确认业务资料",
            "content": (
                "业务资料已经确认。\n\n"
                "后续关键词库和内容计划会以这份资料为准。下一步，我会找出真正值得竞争的搜索机会。"
                if confirmation_completed
                else (
                    "业务判断已经整理好。\n\n"
                    "请重点确认主要客户，以及客户选择你的原因是否准确。"
                    "确认后，我会以这份资料建立关键词库和内容计划。"
                )
            ),
            "action": (
                {}
                if confirmation_completed
                else {
                    "label": "确认业务资料",
                    "href": f"/projects/{project_id}/settings/business",
                }
            ),
            "metadata": {"source": "site_profile", "onboarding_order": 5},
        }
    )
    if not confirmation_completed or steps is None:
        return events

    article_items = article_items or {}
    article_runs = article_runs or {}
    downstream = (
        ("technical_audit", "技术审核", 6),
        ("keyword_library", "关键词库", 7),
        ("content_plan", "30 篇内容计划", 8),
        ("first_article", "第一篇文章", 9),
        ("second_article", "第二篇文章", 10),
    )
    for step_key, title, order in downstream:
        step = steps[step_key]
        if step.status == "blocked":
            continue
        source_run_id = step.external_run_id
        events.append(
            {
                "event_key": f"onboarding:{step_key}",
                "kind": "task",
                "status": _downstream_status(step),
                "title": title,
                "content": _downstream_content(
                    step_key,
                    step,
                    audit_run=audit_run,
                    keyword_run=keyword_run,
                    content_plan_batch=content_plan_batch,
                    content_plan_item_count=content_plan_item_count,
                    article_item=article_items.get(step_key),
                    article_run=article_runs.get(step_key),
                ),
                "metadata": {
                    "source": "onboarding",
                    "onboarding_step": step_key,
                    "source_run_id": source_run_id,
                    "source_status": (
                        keyword_run.status
                        if step_key == "keyword_library" and keyword_run is not None
                        else None
                    ),
                    "onboarding_order": order,
                    "retryable": _downstream_retryable(
                        step_key,
                        step,
                        keyword_run=keyword_run,
                        content_plan_batch=content_plan_batch,
                        article_run=article_runs.get(step_key),
                    ),
                },
            }
        )
    return events


def advance_onboarding(
    run: OnboardingRun,
    steps: dict[str, OnboardingStep],
    confirmed_at: datetime | None,
) -> None:
    confirmation = steps["business_confirmation"]
    if confirmed_at is not None:
        _complete_step(confirmation, confirmed_at)
        run.business_confirmed_at = confirmed_at
    elif steps["site_understanding"].status == "completed":
        if confirmation.status in {"blocked", "failed"}:
            _make_ready(confirmation)
    elif confirmation.status not in TERMINAL_STEP_STATUSES:
        confirmation.status = "blocked"

    for step_key, dependencies in STEP_DEPENDENCIES.items():
        if step_key == "business_confirmation":
            continue
        step = steps[step_key]
        if step.status != "blocked":
            continue
        if all(steps[key].status in TERMINAL_STEP_STATUSES for key in dependencies):
            _make_ready(step)

    if all(step.status in TERMINAL_STEP_STATUSES for step in steps.values()):
        run.status = "completed"
        run.completed_at = max(
            (step.finished_at for step in steps.values() if step.finished_at is not None),
            default=datetime.now(UTC),
        )
    elif confirmation.status == "ready" and run.business_confirmed_at is None:
        run.status = "waiting_for_confirmation"
        run.completed_at = None
    else:
        run.status = "running"
        run.completed_at = None


def _make_ready(step: OnboardingStep) -> None:
    step.status = "ready"
    step.external_run_id = None
    step.last_error_code = None
    step.last_error_message = None
    step.started_at = None
    step.finished_at = None
    step.updated_at = datetime.now(UTC)


def _complete_step(step: OnboardingStep, finished_at: datetime) -> None:
    step.status = "completed"
    step.last_error_code = None
    step.last_error_message = None
    step.finished_at = finished_at
    step.updated_at = datetime.now(UTC)


def _validate_step_key(step_key: str) -> None:
    if step_key not in STEP_KEYS:
        raise ValueError("unsupported onboarding step")
