from __future__ import annotations

import json
import os
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.modules.keywords.service import SQLAlchemyKeywordRepository

pytestmark = pytest.mark.anyio


def _database_url() -> str:
    value = os.getenv("KEYWORD_API_TEST_DATABASE_URL", "").strip()
    if not value:
        pytest.skip("KEYWORD_API_TEST_DATABASE_URL is required for PostgreSQL tests")
    return value.replace("postgresql://", "postgresql+asyncpg://", 1)


async def test_initial_workflow_orphan_recovery_is_capped_atomically() -> None:
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyKeywordRepository(sessions)
    token = uuid4().hex
    organization_id = f"workflow-recovery-org-{token}"
    project_id = f"workflow-recovery-project-{token}"
    run_id = f"workflow-recovery-run-{token}"
    workflow_id = f"keywords:build:{run_id}:old"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (:project_id, :organization_id, 'Recovery cap test',
                            :domain, 'US', 'en')
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_build_runs (
                        id, organization_id, project_id, kind, round_number,
                        status, stage, gap_status, recovery_count
                    )
                    VALUES (:run_id, :organization_id, :project_id, 'initial', 1,
                            'running', 'selecting_seeds', 'not_requested', 3)
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_workflow_dispatches (
                        run_id, workflow_id, task_payload, status
                    )
                    VALUES (
                        :run_id, :workflow_id, CAST(:task_payload AS jsonb), 'dispatched'
                    )
                    """
                ),
                {
                    "run_id": run_id,
                    "workflow_id": workflow_id,
                    "task_payload": json.dumps(
                        {
                            "run_id": run_id,
                            "_recovery_count": 3,
                            "_orphan_recovery_count": 3,
                        }
                    ),
                },
            )
            await session.commit()

        recovered = await repository.requeue_orphaned_workflow(
            run_id,
            expected_workflow_id=workflow_id,
            max_recoveries=3,
        )

        assert recovered is False
        async with sessions() as session:
            row = (
                await session.execute(
                    text(
                        """
                        SELECT r.status, r.stage, r.error_code, r.next_retry_at,
                               d.workflow_id, d.status AS dispatch_status
                        FROM keyword_build_runs r
                        JOIN keyword_workflow_dispatches d ON d.run_id = r.id
                        WHERE r.id = :run_id
                        """
                    ),
                    {"run_id": run_id},
                )
            ).one()
        assert row.status == "blocked"
        assert row.stage == "waiting_for_recovery"
        assert row.error_code == "workflow_recovery_exhausted"
        assert row.next_retry_at is not None
        assert row.workflow_id == workflow_id
        assert row.dispatch_status == "dispatched"
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()


async def test_orphaned_metric_workflow_replays_without_spending_an_attempt() -> None:
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyKeywordRepository(sessions)
    token = uuid4().hex
    organization_id = f"metric-requeue-org-{token}"
    project_id = f"metric-requeue-project-{token}"
    run_id = f"metric-requeue-run-{token}"
    old_workflow_id = f"keyword-metrics:{run_id}:2:old"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (:project_id, :organization_id, 'Metric replay test',
                            :domain, 'US', 'en')
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_build_runs (
                        id, organization_id, project_id, kind, round_number,
                        status, stage, gap_status
                    )
                    VALUES (:run_id, :organization_id, :project_id, 'initial', 1,
                            'completed', 'completed', 'not_requested')
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_metric_refresh_jobs (
                        run_id, organization_id, project_id, workflow_id,
                        task_payload, status, attempt_count, next_attempt_at
                    )
                    VALUES (
                        :run_id, :organization_id, :project_id, :workflow_id,
                        CAST(:task_payload AS jsonb), 'running', 2, now()
                    )
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "workflow_id": old_workflow_id,
                    "task_payload": json.dumps(
                        {
                            "run_id": run_id,
                            "_metric_workflow_id": old_workflow_id,
                        }
                    ),
                },
            )
            await session.commit()

        assert await repository.requeue_orphaned_metric_workflow(
            run_id,
            expected_workflow_id=old_workflow_id,
        )

        async with sessions() as session:
            row = (
                await session.execute(
                    text(
                        """
                        SELECT workflow_id, task_payload, status, attempt_count,
                               orphan_replay_count
                        FROM keyword_metric_refresh_jobs
                        WHERE run_id = :run_id
                        """
                    ),
                    {"run_id": run_id},
                )
            ).one()
        assert row.status == "pending"
        assert row.attempt_count == 1
        assert row.orphan_replay_count == 1
        assert row.workflow_id.startswith(f"keyword-metrics:{run_id}:2:")
        assert row.task_payload["_metric_workflow_id"] == row.workflow_id
        health = await repository.operational_health(
            organization_id,
            task_queue="keyword-build",
            worker_stale_seconds=60,
        )
        assert health.metric_refresh_waiting == 1
        assert health.metric_refresh_running == 0
        assert health.metric_refresh_exhausted == 0
        assert health.failed_metrics == 0
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()


async def test_dispatched_metric_workflow_requeues_before_attempt_starts() -> None:
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyKeywordRepository(sessions)
    token = uuid4().hex
    organization_id = f"metric-dispatch-org-{token}"
    project_id = f"metric-dispatch-project-{token}"
    run_id = f"metric-dispatch-run-{token}"
    old_workflow_id = f"keyword-metrics:{run_id}:1:old"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (:project_id, :organization_id, 'Metric dispatch test',
                            :domain, 'US', 'en')
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_build_runs (
                        id, organization_id, project_id, kind, round_number,
                        status, stage, gap_status
                    )
                    VALUES (:run_id, :organization_id, :project_id, 'initial', 1,
                            'completed', 'completed', 'not_requested')
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_metric_refresh_jobs (
                        run_id, organization_id, project_id, workflow_id,
                        task_payload, status, attempt_count, next_attempt_at
                    )
                    VALUES (
                        :run_id, :organization_id, :project_id, :workflow_id,
                        CAST(:task_payload AS jsonb), 'dispatched', 0, now()
                    )
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "workflow_id": old_workflow_id,
                    "task_payload": json.dumps(
                        {
                            "run_id": run_id,
                            "_metric_workflow_id": old_workflow_id,
                        }
                    ),
                },
            )
            await session.commit()

        assert await repository.requeue_orphaned_metric_workflow(
            run_id,
            expected_workflow_id=old_workflow_id,
        )

        async with sessions() as session:
            row = (
                await session.execute(
                    text(
                        """
                        SELECT workflow_id, status, attempt_count,
                               orphan_replay_count
                        FROM keyword_metric_refresh_jobs
                        WHERE run_id = :run_id
                        """
                    ),
                    {"run_id": run_id},
                )
            ).one()
        assert row.status == "pending"
        assert row.attempt_count == 0
        assert row.orphan_replay_count == 1
        assert row.workflow_id.startswith(f"keyword-metrics:{run_id}:1:")
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()


async def test_third_orphaned_metric_workflow_is_settled_without_requeue() -> None:
    engine = create_async_engine(_database_url(), pool_pre_ping=True)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    repository = SQLAlchemyKeywordRepository(sessions)
    token = uuid4().hex
    organization_id = f"metric-exhaust-org-{token}"
    project_id = f"metric-exhaust-project-{token}"
    run_id = f"metric-exhaust-run-{token}"
    keyword_id = f"metric-exhaust-keyword-{token}"
    workflow_id = f"keyword-metrics:{run_id}:3:old"
    try:
        async with sessions() as session:
            await session.execute(
                text(
                    """
                    INSERT INTO projects (
                        id, organization_id, name, domain, country, language
                    )
                    VALUES (:project_id, :organization_id, 'Metric exhaust test',
                            :domain, 'US', 'en')
                    """
                ),
                {
                    "project_id": project_id,
                    "organization_id": organization_id,
                    "domain": f"{token}.example.test",
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_build_runs (
                        id, organization_id, project_id, kind, round_number,
                        status, stage, gap_status, result_version, finished_at
                    )
                    VALUES (:run_id, :organization_id, :project_id, 'initial', 1,
                            'partial', 'partial', 'not_requested', 1,
                            '2026-08-03T01:00:00Z')
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keywords (
                        id, organization_id, project_id, country, language,
                        keyword, normalized_keyword, metrics_status,
                        first_build_run_id, last_build_run_id
                    )
                    VALUES (
                        :keyword_id, :organization_id, :project_id, 'US', 'en',
                        'metric exhaust keyword', 'metric exhaust keyword', 'pending',
                        :run_id, :run_id
                    )
                    """
                ),
                {
                    "keyword_id": keyword_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "run_id": run_id,
                },
            )
            await session.execute(
                text(
                    """
                    INSERT INTO keyword_metric_refresh_jobs (
                        run_id, organization_id, project_id, workflow_id,
                        task_payload, status, attempt_count, orphan_replay_count,
                        next_attempt_at
                    )
                    VALUES (
                        :run_id, :organization_id, :project_id, :workflow_id,
                        CAST(:task_payload AS jsonb), 'running', 3, 2, now()
                    )
                    """
                ),
                {
                    "run_id": run_id,
                    "organization_id": organization_id,
                    "project_id": project_id,
                    "workflow_id": workflow_id,
                    "task_payload": json.dumps(
                        {
                            "run_id": run_id,
                            "_metric_workflow_id": workflow_id,
                        }
                    ),
                },
            )
            await session.commit()

        assert await repository.requeue_orphaned_metric_workflow(
            run_id,
            expected_workflow_id=workflow_id,
        )

        async with sessions() as session:
            row = (
                await session.execute(
                    text(
                        """
                        SELECT
                            job.status AS job_status,
                            job.orphan_replay_count,
                            keyword.metrics_status,
                            run.status AS run_status,
                            run.result_version,
                            run.finished_at
                        FROM keyword_metric_refresh_jobs AS job
                        JOIN keyword_build_runs AS run ON run.id = job.run_id
                        JOIN keywords AS keyword ON keyword.last_build_run_id = run.id
                        WHERE job.run_id = :run_id
                        """
                    ),
                    {"run_id": run_id},
                )
            ).one()
        assert row.job_status == "exhausted"
        assert row.orphan_replay_count == 3
        assert row.metrics_status == "failed"
        assert row.run_status == "partial"
        assert row.result_version == 2
        assert row.finished_at.isoformat() == "2026-08-03T01:00:00+00:00"
    finally:
        async with sessions() as session:
            await session.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": project_id},
            )
            await session.commit()
        await engine.dispose()
