import asyncio
import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.content.models import (
    Article,
    ArticleRun,
    ArticleRunStep,
    ArticleSource,
    ArticleVersion,
)
from app.modules.content.repository import ContentRepository
from app.modules.projects.models import Project


def content_workflow_test_database_url() -> str:
    value = os.getenv("CONTENT_WORKFLOW_TEST_DATABASE_URL", "")
    if not value:
        pytest.skip("CONTENT_WORKFLOW_TEST_DATABASE_URL is not configured")
    if make_url(value).database != "seo_content_stage2_test":
        pytest.fail("Stage 2 tests may only use seo_content_stage2_test")
    return value


async def create_queued_run(
    sessions: async_sessionmaker[AsyncSession], project_id: str, run_id: str
) -> str:
    article_id = str(uuid4())
    async with sessions() as session:
        session.add(
            Article(
                id=article_id,
                organization_id="test-org",
                project_id=project_id,
                primary_keyword="solar battery payback",
                status="queued",
                current_run_id=run_id,
            )
        )
        await session.flush()
        session.add(
            ArticleRun(
                id=run_id,
                article_id=article_id,
                organization_id="test-org",
                project_id=project_id,
                workflow_id=f"article-generation:{run_id}",
                status="queued",
                stage="queued",
                progress=0,
            )
        )
        await session.commit()
    return article_id


def test_begin_run_sets_deadlines_once_and_completed_step_survives_restart() -> None:
    async def scenario() -> None:
        engine = create_async_engine(content_workflow_test_database_url(), pool_pre_ping=True)
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, run_id = str(uuid4()), str(uuid4())
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="test-org",
                        name="Content workflow test",
                        domain=f"{project_id}.example.com",
                        country="US",
                        language="en",
                    )
                )
                await session.commit()
            article_id = await create_queued_run(sessions, project_id, run_id)

            first = await repo.begin_run(run_id, target_seconds=600, hard_timeout_seconds=1200)
            restarted = await repo.begin_run(
                run_id, target_seconds=1, hard_timeout_seconds=2
            )
            assert first is not None and restarted is not None
            assert restarted.started_at == first.started_at
            assert restarted.soft_deadline_at == first.soft_deadline_at
            assert restarted.hard_deadline_at == first.hard_deadline_at
            assert first.soft_deadline_at == first.started_at + timedelta(seconds=600)
            assert first.hard_deadline_at == first.started_at + timedelta(seconds=1200)

            claim, step = await repo.claim_step(
                run_id, "preparing", "worker-1", lease_seconds=300
            )
            assert claim == "claimed" and step is not None
            await repo.complete_step(
                run_id,
                "preparing",
                "worker-1",
                summary={"snapshot": "stored"},
                output_ref="s3://bucket/run/preparing.json",
            )

            repeated, completed = await repo.claim_step(
                run_id, "preparing", "worker-after-restart", lease_seconds=300
            )
            assert repeated == "completed"
            assert completed is not None
            assert completed.summary_json == {"snapshot": "stored"}
            assert completed.attempts == 1

            await repo.finish_run(
                run_id,
                "completed",
                [],
                artifact={
                    "title": "Solar battery payback",
                    "slug": "solar-battery-payback",
                    "meta_title": "Solar battery payback",
                    "meta_description": "A practical guide.",
                    "plan": {"sections": []},
                    "quality": {"passed": True},
                    "markdown": "# Solar battery payback\n",
                },
                html="<h1>Solar battery payback</h1>",
                final_content_ref="s3://bucket/run/final/article.md",
            )
            async with sessions() as session:
                run = await session.get(ArticleRun, run_id)
                article = await session.get(Article, article_id)
                assert run is not None and article is not None
                assert run.status == "completed"
                assert run.stage == "completed"
                assert run.progress == 100
                assert article.status == "completed"
        finally:
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_active_lease_is_busy_and_expired_lease_can_be_taken_over() -> None:
    async def scenario() -> None:
        engine = create_async_engine(content_workflow_test_database_url(), pool_pre_ping=True)
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, run_id = str(uuid4()), str(uuid4())
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="test-org",
                        name="Content lease test",
                        domain=f"{project_id}.example.com",
                        country="US",
                        language="en",
                    )
                )
                await session.commit()
            await create_queued_run(sessions, project_id, run_id)
            await repo.begin_run(run_id, target_seconds=600, hard_timeout_seconds=1200)

            claimed, step = await repo.claim_step(
                run_id, "collecting", "worker-1", lease_seconds=300
            )
            assert step is not None and step.lease_expires_at is not None
            original_lease_expiry = step.lease_expires_at
            renewed = await repo.renew_step_lease(
                run_id, "collecting", "worker-1", lease_seconds=900
            )
            stale_renewal = await repo.renew_step_lease(
                run_id, "collecting", "worker-2", lease_seconds=900
            )
            busy, _ = await repo.claim_step(
                run_id, "collecting", "worker-2", lease_seconds=300
            )
            async with sessions() as session:
                renewed_step = await session.scalar(
                    select(ArticleRunStep).where(
                        ArticleRunStep.run_id == run_id,
                        ArticleRunStep.step_key == "collecting",
                    )
                )

            assert claimed == "claimed"
            assert renewed is True
            assert stale_renewal is False
            assert renewed_step is not None
            assert renewed_step.lease_expires_at is not None
            assert renewed_step.lease_expires_at > original_lease_expiry
            assert busy == "busy"

            async with sessions() as session:
                await session.execute(
                    update(ArticleRunStep)
                    .where(
                        ArticleRunStep.run_id == run_id,
                        ArticleRunStep.step_key == "collecting",
                    )
                    .values(lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
                )
                await session.commit()

            expired_renewal = await repo.renew_step_lease(
                run_id, "collecting", "worker-1", lease_seconds=900
            )
            recovery_takeover, recovery_step = await repo.force_claim_step(
                run_id, "collecting", "worker-2", lease_seconds=300
            )

            assert expired_renewal is False
            assert recovery_takeover == "claimed"
            assert recovery_step is not None
            assert recovery_step.worker_id == "worker-2"

            active_recovery, _ = await repo.force_claim_step(
                run_id, "collecting", "worker-3", lease_seconds=300
            )
            assert active_recovery == "busy"

            takeover, taken_step = await repo.claim_step(
                run_id, "collecting", "worker-2", lease_seconds=300
            )
            assert takeover == "claimed"
            assert taken_step is not None
            assert taken_step.worker_id == "worker-2"
            assert taken_step.attempts == 3

            with pytest.raises(RuntimeError, match="执行租约已失效"):
                await repo.complete_step(
                    run_id,
                    "collecting",
                    "worker-1",
                    summary={"worker": "stale"},
                )
            completed = await repo.complete_step(
                run_id,
                "collecting",
                "worker-2",
                summary={"worker": "current"},
            )
            assert completed.status == "completed"
            assert completed.summary_json == {"worker": "current"}
        finally:
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_finish_run_replay_does_not_duplicate_versions_usage_or_source_bindings() -> None:
    async def scenario() -> None:
        engine = create_async_engine(content_workflow_test_database_url(), pool_pre_ping=True)
        sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        repo = ContentRepository(sessions)
        project_id, run_id = str(uuid4()), str(uuid4())
        source_url = "https://authority.example/solar-payback"
        try:
            async with sessions() as session:
                session.add(
                    Project(
                        id=project_id,
                        organization_id="test-org",
                        name="Content finalization replay test",
                        domain=f"{project_id}.example.com",
                        country="US",
                        language="en",
                    )
                )
                await session.commit()
            article_id = await create_queued_run(sessions, project_id, run_id)
            await repo.begin_run(run_id, target_seconds=600, hard_timeout_seconds=1200)

            for step_key, usage in (
                (
                    "planning",
                    {
                        "input_tokens": 100,
                        "output_tokens": 20,
                        "reported_cost": 0.01,
                        "estimated_cost": None,
                        "cost_currency": "USD",
                        "estimation_basis": {},
                        "provider_request_ids": ["request-planning"],
                    },
                ),
                (
                    "writing",
                    {
                        "input_tokens": 200,
                        "output_tokens": 80,
                        "reported_cost": None,
                        "estimated_cost": 0.04,
                        "cost_currency": "USD",
                        "estimation_basis": {"method": "token_rate_v1"},
                        "provider_request_ids": ["request-writing"],
                    },
                ),
                (
                    "revising_3",
                    {
                        "input_tokens": 50,
                        "output_tokens": 25,
                        "reported_cost": 0.02,
                        "estimated_cost": None,
                        "cost_currency": "USD",
                        "estimation_basis": {},
                        "provider_request_ids": ["request-revising-3"],
                    },
                ),
                (
                    "checking_4",
                    {
                        "input_tokens": 60,
                        "output_tokens": 20,
                        "reported_cost": None,
                        "estimated_cost": 0.01,
                        "cost_currency": "USD",
                        "estimation_basis": {"method": "token_rate_v1"},
                        "provider_request_ids": ["request-checking-4"],
                    },
                ),
            ):
                claimed, _ = await repo.claim_step(
                    run_id, step_key, "worker-1", lease_seconds=300
                )
                assert claimed == "claimed"
                await repo.complete_step(
                    run_id,
                    step_key,
                    "worker-1",
                    summary={"usage": usage},
                    output_ref=f"s3://bucket/run/{step_key}.json",
                    duration_ms=100,
                    usage=usage,
                )

            await repo.upsert_source(
                run_id,
                source_type="authority",
                url=source_url,
                status="available",
                title="Solar payback facts",
            )
            plan = {
                "sections": [{"section_id": "section-1", "claim_ids": ["claim-1"]}],
                "claims": [
                    {
                        "claim_id": "claim-1",
                        "claim": "Supported fact",
                        "source_url": source_url,
                        "section_id": "section-1",
                    }
                ],
            }
            await repo.bind_plan_sources(run_id, plan)
            await repo.bind_plan_sources(run_id, plan)

            artifact = {
                "title": "Solar battery payback",
                "slug": "solar-battery-payback",
                "meta_title": "Solar battery payback",
                "meta_description": "A practical guide.",
                "plan": plan,
                "quality": {"passed": True},
                "markdown": "# Solar battery payback\n\nComplete article.\n",
            }
            finish_args = {
                "artifact": artifact,
                "html": "<h1>Solar battery payback</h1><p>Complete article.</p>",
                "final_content_ref": "s3://bucket/run/final/article.md",
            }
            await repo.finish_run(run_id, "completed", [], **finish_args)
            await repo.finish_run(
                run_id,
                "completed_with_warnings",
                [{"code": "replayed", "message": "Must not replace final state"}],
                **finish_args,
            )

            async with sessions() as session:
                run = await session.get(ArticleRun, run_id)
                versions = list(
                    (
                        await session.scalars(
                            select(ArticleVersion)
                            .where(ArticleVersion.run_id == run_id)
                            .order_by(ArticleVersion.version_number)
                        )
                    ).all()
                )
                source_count = await session.scalar(
                    select(func.count())
                    .select_from(ArticleSource)
                    .where(ArticleSource.run_id == run_id)
                )
                bound_source = await session.scalar(
                    select(ArticleSource).where(ArticleSource.run_id == run_id)
                )

            assert run is not None
            assert run.status == "completed"
            assert run.warnings_json == []
            assert run.metrics_json == {
                "stage_count": 4,
                "duration_ms": 400,
                "input_tokens": 410,
                "output_tokens": 145,
                "reported_cost": 0.03,
                "estimated_cost": 0.05,
                "reported_cost_currency": "USD",
                "estimated_cost_currency": "USD",
                "estimation_basis": [
                    {"step_key": "writing", "method": "token_rate_v1"},
                    {"step_key": "checking_4", "method": "token_rate_v1"},
                ],
                "provider_request_ids": [
                    "request-planning",
                    "request-writing",
                    "request-revising-3",
                    "request-checking-4",
                ],
            }
            assert [item.version_type for item in versions] == [
                "outline",
                "draft",
                "revised",
                "final",
            ]
            assert [item.version_number for item in versions] == [1, 2, 3, 4]
            assert versions[2].content_ref == "s3://bucket/run/checking_4.json"
            assert source_count == 1
            assert bound_source is not None
            assert bound_source.claims_json == plan["claims"]
            assert bound_source.section_ids_json == ["section-1"]
            assert article_id == versions[0].article_id
        finally:
            async with sessions() as session:
                await session.execute(delete(Project).where(Project.id == project_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())
